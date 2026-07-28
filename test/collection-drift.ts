import { Client } from 'pg';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCollectionPlan, createLedgerReader, type CollectionPlan } from '../src/ops/collection-plan.js';
import { CollectionConfirmations } from '../src/ops/collection-confirmation.js';
import {
  collectionAuditResponse,
  collectionExecuteResponse,
  collectionRepairResponse,
} from '../src/ops/operator-ui-collections-endpoint.js';
import {
  createCollectionAuditRuntime,
  createCollectionRuntime,
  readOnlyCollectionTarget,
  runCollectionReconcile,
  runCollectionRevocation,
} from '../src/ops/collection-execution.js';
import {
  applyCollectionRepair,
  auditCollectionDrift,
  buildCollectionRepairPlan,
} from '../src/ops/collection-drift.js';
import { collectionKeyFor, createManagedCollectionReader } from '../src/core/publish/collection-model.js';
import { createCollectionHistoryStore } from '../src/ops/collection-history.js';
import {
  JELLYFIN_ALLOW_COLLECTION_WRITES_ENV,
  JELLYFIN_ENABLE_NETWORK_ENV,
} from '../src/ops/jellyfin-control-config.js';
import type { FetchLike } from '../src/core/adapters/jellyfin/transport.js';
import { migrateWith } from '../src/db/pool.js';
import { startEmbedded } from './embedded-pg.js';
import { installCompletionSecret } from './crypto-setup.js';

// Phase 271 — telling the truth about the difference between belief and reality, and gating every repair.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - AN AUDIT IS A READ, AND THE OBJECT GRAPH SAYS SO. The runtime it is given hands back a target whose
//     create/add/remove/delete methods THROW, and a whole audit session writes no row of any kind.
//   - IT DETECTS A COLLECTION DELETED DIRECTLY IN JELLYFIN, and membership drift in both directions.
//   - A LOOKUP FAILURE, A LISTING FAILURE AND AN INCOMPLETE RESOLUTION ARE `unknown` — never `ok` and never
//     `external-missing`. An unknown finding is never repairable.
//   - RECOVERY THAT IS NOT TRUSTED SUPPRESSES EVERY RECREATE. "The token found nothing" says nothing about
//     the world once the marker has been observed not to round-trip.
//   - A REPAIR PLAN IS DETERMINISTIC AND DIGEST-CONFIRMED, from a SEPARATE issuer: a plan confirmation must
//     not verify as a repair confirmation.
//   - A REPAIR NEEDS THE FOUR WRITE SWITCHES, while the audit needs only the network one — and that narrower
//     gate is only defensible because a whole audit TRANSMITS no provider reference, no title and no record
//     id, which is asserted against the request lines the server actually received.
//   - A REPAIR WRITES DURABLE STATE ONLY. It creates nothing and deletes nothing; the ordinary reconcile and
//     revoke passes do that, under their own gates — and a re-armed collection whose artifact turns out to
//     still exist is ADOPTED by token rather than duplicated.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepo = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8').split('\r\n').join('\n');

const WORK = mkdtempSync(join(tmpdir(), 'ca-collection-drift-'));
const SECRET_REF = 'tt-phase271-ref-value-must-never-be-disclosed';
const API_KEY = 'phase271-api-key-must-never-be-disclosed';
const KEY_FILE = join(WORK, 'jellyfin_api_key');
writeFileSync(KEY_FILE, `${API_KEY}\n`, 'utf8');

const emitted: string[] = [];

interface FakeCollection { id: string; name: string; ids: string[] }

interface FakeJellyfin {
  readonly baseUrl: string;
  readonly collections: Map<string, FakeCollection>;
  readonly library: Record<string, string>;
  /** Every request line the client sent. The audit's whole disclosure claim is asserted against this. */
  readonly requests: Array<{ method: string; url: string }>;
  breakLookup: boolean;
  breakMemberList: boolean;
  breakCandidates: boolean;
  close(): Promise<void>;
}

async function startFakeJellyfin(initialLibrary: Record<string, string>): Promise<FakeJellyfin> {
  const library = { ...initialLibrary };
  const collections = new Map<string, FakeCollection>();
  const requests: Array<{ method: string; url: string }> = [];
  let counter = 0;
  const state = { breakLookup: false, breakMemberList: false, breakCandidates: false };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '/' });
    const json = (value: unknown, status = 200): void => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(value));
    };
    const idsParam = (): string[] => (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);

    if (url.pathname === '/System/Info') { json({ Version: '10.9.11' }); return; }
    if (req.method === 'POST' && url.pathname === '/Collections') {
      const id = `jf-col-${++counter}`;
      collections.set(id, { id, name: url.searchParams.get('name') ?? '', ids: idsParam() });
      json({ Id: id });
      return;
    }
    const collectionItems = /^\/Collections\/([^/]+)\/Items$/.exec(url.pathname);
    if (collectionItems !== null) {
      const collection = collections.get(decodeURIComponent(collectionItems[1]!));
      if (collection === undefined) { json({}, 404); return; }
      const wanted = idsParam();
      if (req.method === 'POST') { for (const item of wanted) if (!collection.ids.includes(item)) collection.ids.push(item); json({}); return; }
      if (req.method === 'DELETE') { collection.ids = collection.ids.filter((i) => !wanted.includes(i)); json({}); return; }
      json({}, 405);
      return;
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/Items/')) {
      const id = decodeURIComponent(url.pathname.slice('/Items/'.length));
      if (!collections.has(id)) { json({}, 404); return; }
      collections.delete(id);
      json({});
      return;
    }
    if (url.pathname === '/Items') {
      const parentId = url.searchParams.get('parentId');
      if (parentId !== null) {
        if (state.breakMemberList) { json({ error: 'no' }, 500); return; }
        json({ Items: (collections.get(parentId)?.ids ?? []).map((id) => ({ Id: id })) });
        return;
      }
      const types = (url.searchParams.get('IncludeItemTypes') ?? '').split(',');
      if (types.includes('BoxSet')) {
        if (state.breakLookup) { json({ error: 'no' }, 500); return; }
        json({ Items: [...collections.values()].map((c) => ({ Id: c.id, Name: c.name })) });
        return;
      }
      if (state.breakCandidates) { json({ error: 'no' }, 500); return; }
      json({
        Items: Object.entries(library).map(([ref, id]) => {
          const [type, value] = ref.split(':');
          return { Id: id, ProviderIds: { [type!]: value } };
        }),
      });
      return;
    }
    json({}, 404);
  });

  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    collections,
    library,
    requests,
    get breakLookup() { return state.breakLookup; },
    set breakLookup(value: boolean) { state.breakLookup = value; },
    get breakMemberList() { return state.breakMemberList; },
    set breakMemberList(value: boolean) { state.breakMemberList = value; },
    get breakCandidates() { return state.breakCandidates; },
    set breakCandidates(value: boolean) { state.breakCandidates = value; },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function main(): Promise<void> {
  console.log('Running Phase 271 collection drift audit suite:\n');

  await test('a read-only target refuses every write, so an audit cannot change a media server', async () => {
    const calls: string[] = [];
    const wrapped = readOnlyCollectionTarget({
      name: 'jellyfin',
      resolve: async () => { calls.push('resolve'); return { ids: ['x'], truncated: false }; },
      findByToken: async () => { calls.push('findByToken'); return null; },
      listMembers: async () => { calls.push('listMembers'); return { ids: [], truncated: false }; },
      create: async () => { calls.push('create'); return 'nope'; },
      addMembers: async () => { calls.push('addMembers'); },
      removeMembers: async () => { calls.push('removeMembers'); },
      remove: async () => { calls.push('remove'); return 'deleted'; },
    });
    assertEq((await wrapped.resolve([])).ids.join(','), 'x', 'a read passes through');
    assertEq(await wrapped.findByToken('t'), null, 'and so does the token lookup');
    for (const [name, call] of [
      ['create', () => wrapped.create('n', ['a'], 't')],
      ['addMembers', () => wrapped.addMembers('h', ['a'])],
      ['removeMembers', () => wrapped.removeMembers('h', ['a'])],
      ['remove', () => wrapped.remove('h')],
    ] as Array<[string, () => Promise<unknown>]>) {
      let threw = false;
      try { await call(); } catch { threw = true; }
      assert(threw, `${name} must throw on a read-only target`);
    }
    assertEq(calls.filter((c) => ['create', 'addMembers', 'removeMembers', 'remove'].includes(c)).length, 0,
      'and not one write ever reached the underlying target');
  });

  await test('the audit module reaches for no writer of the durable model', () => {
    const source = readRepo('src/ops/collection-drift.ts');
    const imports = source.split('\n').filter((line) => line.startsWith('import ') || /^\s{2}\w+,$/.test(line));
    const auditFn = /export async function auditCollectionDrift[\s\S]*?\nasync function auditOne/.exec(source);
    assert(auditFn !== null, 'the audit function exists');
    for (const forbidden of ['upsertManagedCollection', 'setManagedMembers', 'markManagedInFlight',
      'settleManagedCollection', 'markManagedRevoked', 'dropManagedMembers']) {
      assert(!source.includes(forbidden), `the drift module must not import or call ${forbidden}`);
      assert(!imports.some((line) => line.includes(forbidden)), `and must not import ${forbidden}`);
    }
  });

  let pg: Awaited<ReturnType<typeof startEmbedded>> | undefined;
  const external = process.env.DATABASE_URL !== undefined;
  if (!external) {
    try { pg = await startEmbedded(); }
    catch (err) { console.log(`  SKIP  embedded PostgreSQL unavailable: ${(err as Error).message}`); }
  }

  if (external || pg !== undefined) {
    await migrateWith(process.env.ADMIN_DATABASE_URL!);
    const admin = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
    await admin.connect();
    const completionSecret = await installCompletionSecret(admin);

    const keystore = join(WORK, 'keystore');
    mkdirSync(keystore, { recursive: true });
    process.env.CUSTODIAN_MODE = 'file';
    process.env.CUSTODIAN_KEYSTORE_DIR = keystore;
    process.env.CUSTODIAN_KEK = Buffer.alloc(32, 41).toString('base64');
    process.env.COMPLETION_SECRET = completionSecret;

    const { getPool, closePool } = await import('../src/db/pool.js');
    const { CatalogAuthority } = await import('../src/core/catalog/authority.js');
    const { createCustodian, loadCustodianConfig } = await import('../src/core/crypto/custodian-factory.js');
    const { createExistingStateLookup } = await import('../src/ops/catalog-import.js');
    const { applyImport } = await import('../src/ops/catalog-import-service.js');
    const { createCatalogReader } = await import('../src/ops/operator-ui-catalog-browse.js');

    const pool = getPool();
    const authority = new CatalogAuthority(pool, createCustodian(loadCustodianConfig()));
    const text = `${JSON.stringify({
      format: 'catalog-authority.snapshot', version: 1, source: 'drift-library',
      items: [
        { externalId: 'd-1', title: 'Drift Alpha', providerRefs: [{ type: 'imdb', value: `${SECRET_REF}-1` }] },
        { externalId: 'd-2', title: 'Drift Bravo', providerRefs: [{ type: 'imdb', value: `${SECRET_REF}-2` }] },
      ],
    }, null, 2)}\n`;
    const applied = await applyImport({ text, lookup: createExistingStateLookup(pool), authority, actor: 'cli', fileName: 'drift.json' });
    assertEq(applied.result.created, 2, 'the fixture did not import');

    const reader = createCatalogReader(pool, authority);
    const ledger = createLedgerReader(pool);
    const managed = createManagedCollectionReader(pool);
    const history = createCollectionHistoryStore(pool);
    const ids = [...await reader.listActiveIds(10, 0)];

    const fake = await startFakeJellyfin({
      [`imdb:${SECRET_REF}-1`]: 'jf-item-1',
      [`imdb:${SECRET_REF}-2`]: 'jf-item-2',
    });
    const env: NodeJS.ProcessEnv = {
      [JELLYFIN_ENABLE_NETWORK_ENV]: 'true',
      JELLYFIN_ALLOW_LIVE_PUBLISH: 'true',
      [JELLYFIN_ALLOW_COLLECTION_WRITES_ENV]: 'true',
      PUBLISH_EXTERNAL_IDENTITY: 'allow',
      JELLYFIN_BASE_URL: fake.baseUrl,
      JELLYFIN_API_KEY_FILE: KEY_FILE,
    };
    const realFetch = globalThis.fetch as unknown as FetchLike;

    const auditRuntime = () => {
      const built = createCollectionAuditRuntime({ pool, authority, fetch: realFetch, env });
      assert(built.ok, `the audit runtime refused: ${built.ok ? '' : built.refusal}`);
      return built.runtime;
    };
    const writeRuntime = () => {
      const built = createCollectionRuntime({ pool, authority, fetch: realFetch, env });
      assert(built.ok, `the runtime refused: ${built.ok ? '' : built.refusal}`);
      return built.runtime;
    };
    const planFor = async (name: string, selection: readonly string[]): Promise<CollectionPlan> => {
      const result = await buildCollectionPlan({ reader, ledger, managed }, { name, itemIds: [...selection] });
      assert(result.ok, `the plan was refused: ${result.ok ? '' : result.rejection}`);
      return result.plan;
    };
    const queue = async (name: string, selection: readonly string[]): Promise<void> => {
      const confirmations = new CollectionConfirmations();
      const plan = await planFor(name, selection);
      const result = await collectionExecuteResponse({
        confirmation: confirmations.issue({
          name: plan.name, planDigest: plan.planDigest, basisDigest: plan.basisDigest,
          create: plan.counts.add, update: plan.counts.keep, revoke: plan.counts.remove,
        }),
        confirmDigest: plan.planDigest,
        itemIds: [...selection],
      }, { reader, ledger, managed, confirmations, history, pool, env });
      assert(result.status < 300, `queuing ${name} answered ${result.status}: ${JSON.stringify(result.body)}`);
    };
    const rowCounts = async (): Promise<string> => JSON.stringify({
      items: (await admin.query('SELECT count(*)::int AS n FROM items')).rows[0].n,
      events: (await admin.query('SELECT count(*)::int AS n FROM events')).rows[0].n,
      ledger: (await admin.query('SELECT count(*)::int AS n FROM publish_ledger')).rows[0].n,
      collections: (await admin.query('SELECT count(*)::int AS n FROM managed_collections')).rows[0].n,
      members: (await admin.query('SELECT count(*)::int AS n FROM managed_collection_members')).rows[0].n,
      updated: (await admin.query('SELECT COALESCE(max(updated_at)::text, \'\') AS t FROM managed_collections')).rows[0].t,
    });
    const named = (prefix: string): FakeCollection | undefined =>
      [...fake.collections.values()].find((c) => c.name.startsWith(`${prefix} `));

    // Two managed collections, both settled and in agreement.
    await queue('In agreement', ids);
    await queue('Deleted outside', [ids[0]!]);
    await runCollectionReconcile(writeRuntime());
    assertEq(fake.collections.size, 2, 'the fixture created two collections');

    await test('an audit of a healthy installation reports agreement and writes NOTHING', async () => {
      const before = await rowCounts();
      const report = await auditCollectionDrift(auditRuntime());
      assertEq(report.counts.scanned, 2, 'both collections were examined');
      assertEq(report.counts.ok, 2, 'and both agree');
      assertEq(report.counts.repairable, 0, 'so nothing is repairable');
      const repair = buildCollectionRepairPlan(report);
      assertEq(repair.noop, true, 'and the repair plan is empty');
      assertEq(await rowCounts(), before, 'an audit wrote a row, or touched a timestamp');
      const text = JSON.stringify(report);
      for (const forbidden of [SECRET_REF, 'jf-col-', 'jf-item-', 'Drift Alpha', API_KEY, fake.baseUrl]) {
        assert(!text.includes(forbidden), `the audit disclosed ${forbidden}`);
      }
    });

    await test('an audit is DETERMINISTIC: the same world twice is the same digests', async () => {
      const first = buildCollectionRepairPlan(await auditCollectionDrift(auditRuntime()));
      const second = buildCollectionRepairPlan(await auditCollectionDrift(auditRuntime()));
      assertEq(second.planDigest, first.planDigest, 'the same repair plan');
      assertEq(second.basisDigest, first.basisDigest, 'from the same basis');
      assert(/^[0-9a-f]{64}$/.test(first.planDigest), 'and the digest is a full sha256');
    });

    await test('a collection deleted directly in Jellyfin is detected as externally missing', async () => {
      const target = named('Deleted outside')!;
      fake.collections.delete(target.id); // somebody deleted it in the Jellyfin UI
      const report = await auditCollectionDrift(auditRuntime());
      const finding = report.findings.find((f) => f.name === 'Deleted outside')!;
      assertEq(finding.verdict, 'external-missing', 'the audit noticed it is gone');
      assertEq(finding.reason, 'DELETED_EXTERNALLY', 'and says how it knows');
      assertEq(finding.complete, true, 'the lookup was authoritative');
      assertEq(finding.repair, 'recreate', 'so a repair is available');
      // The row still SAYS published — the audit changed nothing.
      const status = (await admin.query('SELECT status FROM managed_collections WHERE collection_key = $1',
        [collectionKeyFor('jellyfin', 'Deleted outside')])).rows[0].status as string;
      assertEq(status, 'published', 'and the durable row is untouched by the audit');
    });

    await test('membership drift is detected in both directions, with counts and no ids', async () => {
      const target = named('In agreement')!;
      target.ids = ['jf-item-1', 'jf-item-99']; // one member removed by hand, one stranger added by hand
      const report = await auditCollectionDrift(auditRuntime());
      const finding = report.findings.find((f) => f.name === 'In agreement')!;
      assertEq(finding.verdict, 'membership-drift', 'the audit noticed');
      assertEq(finding.reason, 'MEMBERS_BOTH', 'in both directions');
      assertEq(finding.missing, 1, 'one intended item is not there');
      assertEq(finding.extra, 1, 'and one item is there that should not be');
      assertEq(finding.repair, 'sync', 'and a membership comparison is the repair');
      assert(!JSON.stringify(finding).includes('jf-item-'), 'and no Jellyfin id appears in the finding');
    });

    await test('a lookup that FAILS is `unknown` — never `ok`, never `external-missing`, never repairable', async () => {
      fake.breakLookup = true;
      try {
        const report = await auditCollectionDrift(auditRuntime());
        assertEq(report.counts.unknown, 2, 'both collections could not be judged');
        assertEq(report.counts.missing, 0, 'and NOT ONE was called deleted');
        assertEq(report.counts.ok, 0, 'nor called healthy');
        for (const finding of report.findings) {
          assertEq(finding.reason, 'LOOKUP_FAILED', 'the reason is exact');
          assertEq(finding.complete, false, 'and the finding knows it is incomplete');
          assertEq(finding.repair, 'none', 'so nothing may be repaired from it');
        }
        assertEq(buildCollectionRepairPlan(report).actions.length, 0, 'and the repair plan is empty');
      } finally {
        fake.breakLookup = false;
      }
    });

    await test('a member listing that FAILS, and a resolution that cannot complete, are `unknown` too', async () => {
      fake.breakMemberList = true;
      try {
        const report = await auditCollectionDrift(auditRuntime());
        const finding = report.findings.find((f) => f.name === 'In agreement')!;
        assertEq(finding.verdict, 'unknown', 'a listing that failed cannot be judged');
        assertEq(finding.reason, 'LISTING_FAILED', 'and says so');
        assertEq(finding.repair, 'none', 'and is not repairable');
      } finally {
        fake.breakMemberList = false;
      }

      fake.breakCandidates = true;
      try {
        const report = await auditCollectionDrift(auditRuntime());
        const finding = report.findings.find((f) => f.name === 'In agreement')!;
        assertEq(finding.verdict, 'unknown', 'a resolution that failed cannot be judged either');
        assertEq(finding.reason, 'RESOLUTION_INCOMPLETE', 'and says so');
        assertEq(finding.repair, 'none', 'and is not repairable');
      } finally {
        fake.breakCandidates = false;
      }
    });

    await test('recovery that is not trusted suppresses every recreate', async () => {
      // A durable proof that the marker did not round-trip. From this moment "not found" proves nothing.
      const row = (await admin.query('SELECT id FROM managed_collections WHERE collection_key = $1',
        [collectionKeyFor('jellyfin', 'In agreement')])).rows[0].id as string;
      await admin.query('SELECT cat_collection_record_recovery($1, $2)', [row, 'unrecoverable']);
      try {
        const report = await auditCollectionDrift(auditRuntime());
        assertEq(report.recoveryProof, 'unrecoverable', 'the audit reads the durable evidence');
        const finding = report.findings.find((f) => f.name === 'Deleted outside')!;
        assertEq(finding.verdict, 'unknown', 'the deleted collection can no longer be judged absent');
        assertEq(finding.reason, 'RECOVERY_UNTRUSTED', 'and the audit says exactly why');
        assertEq(finding.repair, 'none', 'so no recreate is proposed at all');
      } finally {
        // Prove it working again; the LATEST proof is what governs.
        await admin.query('SELECT cat_collection_record_recovery($1, $2)', [row, 'verified']);
      }
      const healed = await auditCollectionDrift(auditRuntime());
      assertEq(healed.recoveryProof, 'verified', 'a target proved working again is trusted again');
      assertEq(healed.findings.find((f) => f.name === 'Deleted outside')?.repair, 'recreate',
        'and the recreate becomes available once more');
    });

    await test('a repair applies durable state ONLY, and contacts nothing to do it', async () => {
      const report = await auditCollectionDrift(auditRuntime());
      const repair = buildCollectionRepairPlan(report);
      assertEq(repair.counts.recreate, 1, 'one collection would be re-armed');
      assertEq(repair.counts.sync, 1, 'and one scheduled for a membership comparison');

      const externalBefore = JSON.stringify([...fake.collections.values()]);
      const result = await applyCollectionRepair(pool, repair);
      assertEq(result.rearmed, 1, 'the missing collection was re-armed');
      assertEq(result.scheduled, 1, 'and the drifted one flagged');
      assertEq(result.failed, 0, 'with nothing failing');
      assertEq(JSON.stringify([...fake.collections.values()]), externalBefore,
        'and NOTHING on the media server changed: a repair writes durable state only');

      const rearmed = (await admin.query('SELECT status, external_handle FROM managed_collections WHERE collection_key = $1',
        [collectionKeyFor('jellyfin', 'Deleted outside')])).rows[0];
      assertEq(rearmed.status, 'planned', 'the re-armed collection is back on the ordinary create path');
      assertEq(rearmed.external_handle, null, 'with the handle that named nothing dropped');
      const token = (await admin.query('SELECT correlation_token FROM managed_collections WHERE collection_key = $1',
        [collectionKeyFor('jellyfin', 'Deleted outside')])).rows[0].correlation_token as string;
      assert(token.length > 0, 'but the recovery token KEPT — that is what makes a wrong audit end in an adoption');
    });

    await test('the repair is carried out only by the ordinary passes, and it heals both problems', async () => {
      const result = await runCollectionReconcile(writeRuntime());
      assertEq(result.grouped.created, 1, `the re-armed collection was recreated (got ${JSON.stringify(result.grouped)})`);
      assertEq(result.grouped.updated, 1, 'and the drifted one was brought back into agreement');
      assertEq([...named('In agreement')!.ids].sort().join(','), 'jf-item-1,jf-item-2', 'holding exactly what it should');
      assert(named('Deleted outside') !== undefined, 'and the missing collection is back');

      const after = await auditCollectionDrift(auditRuntime());
      assertEq(after.counts.repairable, 0, 'and a fresh audit finds nothing left to repair');
      assertEq(after.counts.ok, 2, 'with both collections in agreement');
    });

    await test('a re-arm whose artifact still EXISTS ends in an adoption, never a duplicate', async () => {
      const target = named('In agreement')!;
      const before = fake.collections.size;
      // Re-arm by hand, as a repair would, WITHOUT deleting the artifact: the audit was wrong.
      const row = (await admin.query('SELECT id FROM managed_collections WHERE collection_key = $1',
        [collectionKeyFor('jellyfin', 'In agreement')])).rows[0].id as string;
      assertEq((await pool.query('SELECT cat_collection_rearm($1) AS ok', [row])).rows[0].ok, true, 'the row was re-armed');

      const result = await runCollectionReconcile(writeRuntime());
      assertEq(result.grouped.created, 0, 'nothing was created');
      assertEq(result.grouped.adopted, 1, 'the existing artifact was adopted by its own token');
      assertEq(fake.collections.size, before, 'and the server holds no duplicate');
      assert(fake.collections.has(target.id), 'the original artifact is the one that was adopted');
    });

    // -----------------------------------------------------------------------------------------------------
    // The routes.
    // -----------------------------------------------------------------------------------------------------

    await test('the audit route needs only the NETWORK switch; the repair route needs all four', async () => {
      const repairConfirmations = new CollectionConfirmations();
      const readOnly: NodeJS.ProcessEnv = {
        [JELLYFIN_ENABLE_NETWORK_ENV]: 'true',
        JELLYFIN_BASE_URL: fake.baseUrl,
        JELLYFIN_API_KEY_FILE: KEY_FILE,
      };
      const audited = await collectionAuditResponse({ pool, authority, fetch: realFetch, env: readOnly, history, repairConfirmations });
      assertEq(audited.status, 200, 'an audit runs with writing switched off — investigating must not require it');
      assertEq(audited.body.wrote, 'nothing', 'and says it wrote nothing');
      emitted.push(JSON.stringify(audited.body));

      const repaired = await collectionRepairResponse(
        { confirmation: audited.body.confirmation, confirmDigest: (audited.body.repair as { planDigest: string }).planDigest },
        { pool, authority, fetch: realFetch, env: readOnly, history, repairConfirmations },
      );
      assertEq(repaired.status, 409, 'but a repair is refused with the write switches off');
      assertEq(repaired.body.code, 'OPERATOR_UI_COLLECTION_WRITES_DISABLED', 'and names the switch');
      emitted.push(JSON.stringify(repaired.body));

      const noNetwork = await collectionAuditResponse({ pool, authority, fetch: realFetch, env: {}, history, repairConfirmations });
      assertEq(noNetwork.status, 409, 'and an audit with networking off refuses');
      assertEq(noNetwork.body.code, 'OPERATOR_UI_COLLECTION_NETWORK_DISABLED', 'naming that switch');
      emitted.push(JSON.stringify(noNetwork.body));
    });

    await test('a repair confirmation comes from a SEPARATE issuer, and a plan confirmation cannot stand in', async () => {
      const planConfirmations = new CollectionConfirmations();
      const repairConfirmations = new CollectionConfirmations();
      const audited = await collectionAuditResponse({ pool, authority, fetch: realFetch, env, history, repairConfirmations });
      assertEq(audited.status, 200, 'the audit answered');
      const digest = (audited.body.repair as { planDigest: string }).planDigest;

      // A confirmation issued by the PLAN issuer, carrying the very same claims, must not verify here.
      const forged = planConfirmations.issue({
        name: 'repair', planDigest: digest, basisDigest: (audited.body.repair as { basisDigest: string }).basisDigest,
        create: 0, update: 0, revoke: 0,
      });
      const refused = await collectionRepairResponse({ confirmation: forged, confirmDigest: digest },
        { pool, authority, fetch: realFetch, env, history, repairConfirmations });
      assertEq(refused.status, 409, 'a plan confirmation is not a repair confirmation');
      assertEq(refused.body.code, 'OPERATOR_UI_COLLECTION_CONFIRMATION_BAD_SIGNATURE', 'and the signature is what refuses it');

      // The wrong digest echo is refused too, and the right one is accepted exactly once.
      const wrong = await collectionRepairResponse(
        { confirmation: audited.body.confirmation, confirmDigest: 'f'.repeat(64) },
        { pool, authority, fetch: realFetch, env, history, repairConfirmations });
      assertEq(wrong.body.code, 'OPERATOR_UI_COLLECTION_CONFIRMATION_DIGEST_MISMATCH', 'a wrong echo is refused');

      const second = await collectionAuditResponse({ pool, authority, fetch: realFetch, env, history, repairConfirmations });
      const secondDigest = (second.body.repair as { planDigest: string }).planDigest;
      const ok = await collectionRepairResponse({ confirmation: second.body.confirmation, confirmDigest: secondDigest },
        { pool, authority, fetch: realFetch, env, history, repairConfirmations });
      assertEq(ok.status, 200, `a matching repair is applied (got ${JSON.stringify(ok.body)})`);
      assertEq(ok.body.wrote, 'durable collection state only', 'and says exactly what it wrote');
      const replay = await collectionRepairResponse({ confirmation: second.body.confirmation, confirmDigest: secondDigest },
        { pool, authority, fetch: realFetch, env, history, repairConfirmations });
      assertEq(replay.body.code, 'OPERATOR_UI_COLLECTION_CONFIRMATION_ALREADY_USED', 'and it cannot be replayed');
      for (const result of [refused, wrong, ok, replay]) emitted.push(JSON.stringify(result.body));
    });

    await test('a repair whose world moved between the audit and the confirmation is refused as stale', async () => {
      const repairConfirmations = new CollectionConfirmations();
      const audited = await collectionAuditResponse({ pool, authority, fetch: realFetch, env, history, repairConfirmations });
      const digest = (audited.body.repair as { planDigest: string }).planDigest;
      // The world moves: a collection is deleted on the server after the audit was read.
      const victim = named('In agreement')!;
      fake.collections.delete(victim.id);

      const result = await collectionRepairResponse({ confirmation: audited.body.confirmation, confirmDigest: digest },
        { pool, authority, fetch: realFetch, env, history, repairConfirmations });
      assertEq(result.status, 409, 'a stale repair is refused');
      assertEq(result.body.code, 'OPERATOR_UI_COLLECTION_REPAIR_STALE', 'and says exactly that');
      assertEq(result.body.wrote, 'nothing', 'and wrote nothing');
      emitted.push(JSON.stringify(result.body));
    });

    await test('the durable history records an audit and a repair, identity-free', async () => {
      const rows = (await admin.query(
        "SELECT action, name, outcome FROM collection_control_history WHERE action IN ('audited','repaired') ORDER BY id")).rows;
      assert(rows.some((r) => r.action === 'audited'), 'an audit is recorded');
      assert(rows.some((r) => r.action === 'repaired'), 'and so is a repair');
      const text = JSON.stringify(rows);
      for (const forbidden of [SECRET_REF, 'jf-col-', 'jf-item-', 'Drift Alpha']) {
        assert(!text.includes(forbidden), `the history disclosed ${forbidden}`);
      }
    });

    await test('a whole drift audit TRANSMITS no provider reference, no title and no record id', async () => {
      // THIS IS WHAT MAKES THE AUDIT'S NARROWER GATE DEFENSIBLE. It runs on the network switch alone, without
      // PUBLISH_EXTERNAL_IDENTITY — and that is only sound because it decrypts identity IN PROCESS and sends
      // none of it. Reference matching is local: the candidate listing is fetched and compared here, so a
      // reference value never becomes a query parameter. Asserting on the RESPONSES this suite collected would
      // not show that; only the request lines the server actually received do.
      fake.requests.length = 0;
      const report = await auditCollectionDrift(auditRuntime());
      assert(report.counts.scanned > 0, 'the audit examined something, so the scan below is not vacuous');
      assert(fake.requests.length > 0, 'and it really did contact the server');
      const sent = fake.requests.map((r) => `${r.method} ${decodeURIComponent(r.url)}`).join(' | ');
      for (const forbidden of [SECRET_REF, 'Drift Alpha', 'Drift Bravo', 'd-1', 'd-2', API_KEY]) {
        assert(!sent.includes(forbidden), `the audit put ${forbidden} in a request`);
      }
      for (const id of ids) {
        assert(!sent.includes(id), 'the audit put a catalog record id in a request');
      }
      // And it asked for nothing it does not need: no create, no membership mutation, no delete.
      for (const request of fake.requests) {
        assert(!(request.method === 'POST' && request.url.startsWith('/Collections')),
          'a read-only audit sent a create');
        assert(request.method !== 'DELETE', 'a read-only audit sent a delete');
      }
    });

    await test('nothing this suite emitted carries a reference value, an api key, a Jellyfin id or an address', () => {
      const all = emitted.join('\n');
      for (const forbidden of [SECRET_REF, API_KEY, KEY_FILE, 'jf-col-', 'jf-item-', fake.baseUrl]) {
        assert(!all.includes(forbidden), `a response disclosed ${forbidden}`);
      }
      assert(emitted.length > 5, 'and the scan saw a meaningful number of responses');
    });

    // Leave the fixture in a state a later reader can describe.
    await runCollectionRevocation(pool, writeRuntime());

    await fake.close();
    await closePool();
    await admin.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (pg !== undefined) await pg.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
  try { rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(failed === 0 ? 0 : 1);
}

void main();
