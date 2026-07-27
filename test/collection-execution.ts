import { Client } from 'pg';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCollectionPlan, createLedgerReader, type CollectionPlan } from '../src/ops/collection-plan.js';
import { CollectionConfirmations } from '../src/ops/collection-confirmation.js';
import {
  COLLECTIONS_EXECUTE_ROUTE,
  COLLECTIONS_PLAN_ROUTE,
  COLLECTIONS_RECONCILE_ROUTE,
  COLLECTIONS_REQUEST_MAX_BYTES,
  COLLECTIONS_REVOKE_ROUTE,
  COLLECTIONS_STATUS_ROUTE,
  COLLECTIONS_WRITE_ROUTES,
  collectionExecuteResponse,
  collectionReconcileResponse,
  collectionRevokeResponse,
  collectionStatusResponse,
} from '../src/ops/operator-ui-collections-endpoint.js';
import {
  COLLECTION_DISCLOSED_FIELDS,
  checkCollectionWriteGates,
  createCollectionRuntime,
  queueCollectionPlan,
  readCollectionStatus,
  runCollectionReconcile,
  runCollectionRevocation,
} from '../src/ops/collection-execution.js';
import { createCollectionHistoryStore } from '../src/ops/collection-history.js';
import {
  JELLYFIN_ALLOW_COLLECTION_WRITES_ENV,
  JELLYFIN_ENABLE_NETWORK_ENV,
} from '../src/ops/jellyfin-control-config.js';
import type { FetchLike } from '../src/core/adapters/jellyfin/transport.js';
import { migrateWith } from '../src/db/pool.js';
import { startEmbedded } from './embedded-pg.js';
import { installCompletionSecret } from './crypto-setup.js';
import {
  createOperatorUiServiceServer,
  validateOperatorUiServiceConfig,
} from '../src/ops/operator-ui-service.js';
import { OPERATOR_UI_LOCAL_AUTH_HEADER, loadOperatorUiLocalAuthRuntime } from '../src/ops/operator-ui-local-auth-runtime.js';

// Phase 268 — the explicit, digest-confirmed execution workflow.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - FOUR SWITCHES, EACH INDEPENDENT, EACH FAIL-CLOSED. Nothing is queued and nothing is sent while any one
//     of them is off, and the refusal names which one.
//   - EXECUTE QUEUES AND CONTACTS NOTHING. Durable intents exist before any side effect.
//   - A STALE PLAN IS REFUSED. A catalog or ledger that moved after the preview invalidates the confirmation
//     even though the signature is valid and the digest was echoed correctly.
//   - A REPLAY IS REFUSED, and a replayed execute cannot queue a second copy of anything.
//   - AN AMBIGUOUS OR LOST RESPONSE IS RECOVERED BY TOKEN, WITHOUT DUPLICATING. The one property the whole
//     outbox exists for, exercised end-to-end through a real fake Jellyfin over real HTTP.
//   - RECONCILE IS IDEMPOTENT, and a restart does not lose or duplicate work.
//   - A FORGOTTEN RECORD'S EXTERNAL COPY IS REVOKED, and a failed revoke stays queued rather than marked done.
//   - THE WRITE ROUTES REFUSE A CROSS-ORIGIN REQUEST, A NON-JSON BODY AND AN OVERSIZED ONE, before parsing.
//   - NOTHING DISCLOSES a provider reference, an api key, the operator token or a Jellyfin id.

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

const WORK = mkdtempSync(join(tmpdir(), 'ca-collection-exec-'));
const SECRET_REF = 'tt-phase268-ref-value-must-never-be-disclosed';
const API_KEY = 'phase268-api-key-must-never-be-disclosed';
const KEY_FILE = join(WORK, 'jellyfin_api_key');
writeFileSync(KEY_FILE, `${API_KEY}\n`, 'utf8');
const TOKEN = 'phase268-operator-token-abcdefghij';
const TOKEN_FILE = join(WORK, 'operator_token');
writeFileSync(TOKEN_FILE, TOKEN, 'utf8');

const emitted: string[] = [];

// --- a fake Jellyfin that can lose a response, exactly as a real one can ------------------------------------

interface FakeCollection { id: string; name: string; ids: string[] }

interface FakeJellyfin {
  readonly baseUrl: string;
  readonly collections: Map<string, FakeCollection>;
  /** The refs this server "has", as `type:value` -> opaque item id. Mutable so a leg can add a record. */
  readonly library: Record<string, string>;
  /** Make the NEXT create succeed server-side and lose its response. The ambiguous case, precisely. */
  loseNextCreateResponse: boolean;
  /** Make every findByToken lookup fail. "I could not see it" is not "it is not there". */
  breakLookup: boolean;
  /** Make every delete fail, so a revoke stays queued rather than being marked done. */
  breakDelete: boolean;
  readonly creates: string[];
  close(): Promise<void>;
}

async function startFakeJellyfin(initialLibrary: Record<string, string>): Promise<FakeJellyfin> {
  const library = { ...initialLibrary };
  const collections = new Map<string, FakeCollection>();
  const creates: string[] = [];
  let counter = 0;
  const state = { loseNextCreateResponse: false, breakLookup: false, breakDelete: false };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const json = (value: unknown, status = 200): void => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/System/Info') { json({ Version: '10.9.11' }); return; }

    if (req.method === 'POST' && url.pathname === '/Collections') {
      const name = url.searchParams.get('name') ?? '';
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      const id = `jf-col-${++counter}`;
      collections.set(id, { id, name, ids });
      creates.push(name);
      if (state.loseNextCreateResponse) {
        // The artifact EXISTS on the server and the caller never learns its handle. This is the whole reason
        // the outbox tags the artifact with a durable token.
        state.loseNextCreateResponse = false;
        req.socket.destroy();
        return;
      }
      json({ Id: id });
      return;
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/Items/')) {
      if (state.breakDelete) { json({ error: 'no' }, 500); return; }
      const id = decodeURIComponent(url.pathname.slice('/Items/'.length));
      if (!collections.has(id)) { json({}, 404); return; }
      collections.delete(id);
      json({});
      return;
    }

    if (url.pathname === '/Items') {
      const types = (url.searchParams.get('IncludeItemTypes') ?? '').split(',');
      const start = Number(url.searchParams.get('StartIndex') ?? '0');
      const limit = Number(url.searchParams.get('Limit') ?? '500');
      if (types.includes('BoxSet')) {
        if (state.breakLookup) { json({ error: 'no' }, 500); return; }
        const rows = [...collections.values()].map((c) => ({ Id: c.id, Name: c.name }));
        json({ Items: rows.slice(start, start + limit) });
        return;
      }
      const rows = Object.entries(library).map(([ref, id]) => {
        const [type, value] = ref.split(':');
        return { Id: id, ProviderIds: { [type!]: value } };
      });
      json({ Items: rows.slice(start, start + limit) });
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
    creates,
    get loseNextCreateResponse() { return state.loseNextCreateResponse; },
    set loseNextCreateResponse(value: boolean) { state.loseNextCreateResponse = value; },
    get breakLookup() { return state.breakLookup; },
    set breakLookup(value: boolean) { state.breakLookup = value; },
    get breakDelete() { return state.breakDelete; },
    set breakDelete(value: boolean) { state.breakDelete = value; },
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

interface HttpResult { status: number; body: any; raw: string; headers: Record<string, string | string[] | undefined> }

function caller(port: number) {
  return (path: string, opts: { token?: string; method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<HttpResult> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (opts.token !== undefined) headers[OPERATOR_UI_LOCAL_AUTH_HEADER] = opts.token;
      if (opts.body !== undefined && headers['content-type'] === undefined) headers['content-type'] = 'application/json';
      if (opts.body !== undefined) headers['content-length'] = String(Buffer.byteLength(opts.body));
      const req = httpRequest({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += String(chunk); });
        res.on('end', () => {
          emitted.push(raw);
          let body: unknown = raw;
          try { body = JSON.parse(raw); } catch { /* a plain-text refusal is a valid answer */ }
          resolve({ status: res.statusCode ?? 0, body, raw, headers: res.headers });
        });
      });
      req.on('error', reject);
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });
}

async function main(): Promise<void> {
  console.log('Running Phase 268 collection execution suite:\n');

  // -------------------------------------------------------------------------------------------------------
  // The gates, before any database is needed.
  // -------------------------------------------------------------------------------------------------------

  const fullGateEnv = (baseUrl: string): NodeJS.ProcessEnv => ({
    [JELLYFIN_ENABLE_NETWORK_ENV]: 'true',
    JELLYFIN_ALLOW_LIVE_PUBLISH: 'true',
    [JELLYFIN_ALLOW_COLLECTION_WRITES_ENV]: 'true',
    PUBLISH_EXTERNAL_IDENTITY: 'allow',
    JELLYFIN_BASE_URL: baseUrl,
    JELLYFIN_API_KEY_FILE: KEY_FILE,
  });

  await test('every one of the four switches is required, independently, and names itself when it refuses', () => {
    const base = fullGateEnv('http://127.0.0.1:8096');
    assert(checkCollectionWriteGates(base).ok, 'all four switches on is allowed');
    for (const [key, refusal] of [
      [JELLYFIN_ENABLE_NETWORK_ENV, 'NETWORK_DISABLED'],
      [JELLYFIN_ALLOW_COLLECTION_WRITES_ENV, 'WRITES_DISABLED'],
      ['JELLYFIN_ALLOW_LIVE_PUBLISH', 'LIVE_PUBLISH_DISABLED'],
      ['PUBLISH_EXTERNAL_IDENTITY', 'CONSENT_DENIED'],
    ] as const) {
      const env = { ...base };
      delete env[key];
      const result = checkCollectionWriteGates(env);
      assert(!result.ok, `${key} missing must refuse`);
      assertEq(result.refusal, refusal as never, `${key} refusal`);
      assert(result.message.includes(key), 'and the refusal names the setting to change');
      // A near-miss value is still off. `TRUE`, `1` and `yes` are not `true`.
      for (const near of ['TRUE', '1', 'yes', 'allow ']) {
        const nearEnv = { ...base, [key]: key === 'PUBLISH_EXTERNAL_IDENTITY' ? near : near };
        assert(!checkCollectionWriteGates(nearEnv).ok, `${key}=${near} must not turn it on`);
      }
    }
    // A configuration that does not pass the address policy refuses too, with its own code.
    const bad = { ...base, JELLYFIN_BASE_URL: 'http://jellyfin.example.com' };
    const result = checkCollectionWriteGates(bad);
    assert(!result.ok && result.refusal === 'NOT_CONFIGURED', 'a public address is not a usable configuration');
  });

  await test('the runtime cannot be built while any gate is closed, so no client exists to misuse', () => {
    const fakeFetch: FetchLike = () => { throw new Error('a transport must never be reached here'); };
    const built = createCollectionRuntime({
      pool: null as never, authority: null as never, fetch: fakeFetch, env: { PUBLISH_EXTERNAL_IDENTITY: 'allow' },
    });
    assert(!built.ok, 'a closed gate produces no runtime');
    assertEq(built.refusal, 'NETWORK_DISABLED', 'and says which gate');
    // The disclosed field set is the minimum a Jellyfin create needs, and is asserted so it cannot widen.
    assertEq([...COLLECTION_DISCLOSED_FIELDS].sort().join(','), 'providerRefs,title',
      'a create discloses exactly title and providerRefs');
  });

  // -------------------------------------------------------------------------------------------------------
  // Everything else needs a real database.
  // -------------------------------------------------------------------------------------------------------

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
    process.env.CUSTODIAN_KEK = Buffer.alloc(32, 31).toString('base64');
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
      format: 'catalog-authority.snapshot',
      version: 1,
      source: 'exec-library',
      items: [
        { externalId: 'e-1', title: 'Executed Alpha', year: 1994, providerRefs: [{ type: 'imdb', value: `${SECRET_REF}-1` }] },
        { externalId: 'e-2', title: 'Executed Bravo', year: 2001, providerRefs: [{ type: 'imdb', value: `${SECRET_REF}-2` }] },
        { externalId: 'e-3', title: 'Executed Charlie (no reference)' },
      ],
    }, null, 2)}\n`;
    const applied = await applyImport({
      text, lookup: createExistingStateLookup(pool), authority, actor: 'cli', fileName: 'exec.json',
    });
    assertEq(applied.result.created, 3, 'the fixture did not import');

    const reader = createCatalogReader(pool, authority);
    const ledger = createLedgerReader(pool);
    const history = createCollectionHistoryStore(pool);
    const ids = [...await reader.listActiveIds(10, 0)];

    const fake = await startFakeJellyfin({
      [`imdb:${SECRET_REF}-1`]: 'jf-item-1',
      [`imdb:${SECRET_REF}-2`]: 'jf-item-2',
    });
    const env = fullGateEnv(fake.baseUrl);
    const realFetch = globalThis.fetch as unknown as FetchLike;

    const ledgerCount = async (): Promise<number> =>
      (await admin.query('SELECT count(*)::int AS n FROM publish_ledger')).rows[0].n as number;
    const statusCounts = async (): Promise<Record<string, number>> => {
      const rows = (await admin.query('SELECT status, count(*)::int AS n FROM publish_ledger GROUP BY status')).rows;
      const out: Record<string, number> = {};
      for (const row of rows) out[String(row.status)] = Number(row.n);
      return out;
    };

    const planFor = async (name: string, selection: readonly string[]): Promise<CollectionPlan> => {
      const result = await buildCollectionPlan(reader, ledger, { name, itemIds: [...selection] });
      assert(result.ok, `the plan was refused: ${result.ok ? '' : result.rejection}`);
      return result.plan;
    };

    const executeWith = async (
      confirmations: CollectionConfirmations,
      plan: CollectionPlan,
      selection: readonly string[],
      overrides: Record<string, unknown> = {},
    ) => collectionExecuteResponse({
      confirmation: confirmations.issue({
        name: plan.name, planDigest: plan.planDigest, basisDigest: plan.basisDigest,
        create: plan.counts.create, update: plan.counts.update, revoke: plan.counts.revoke,
      }),
      confirmDigest: plan.planDigest,
      itemIds: [...selection],
      ...overrides,
    }, { reader, ledger, confirmations, history, pool, env });

    // -----------------------------------------------------------------------------------------------------

    await test('an execute with a closed gate queues nothing and contacts nothing', async () => {
      const before = await ledgerCount();
      const confirmations = new CollectionConfirmations();
      const plan = await planFor('Gated', ids);
      const closed = { ...env };
      delete closed[JELLYFIN_ALLOW_COLLECTION_WRITES_ENV];
      const result = await collectionExecuteResponse({
        confirmation: confirmations.issue({
          name: plan.name, planDigest: plan.planDigest, basisDigest: plan.basisDigest,
          create: plan.counts.create, update: plan.counts.update, revoke: plan.counts.revoke,
        }),
        confirmDigest: plan.planDigest,
        itemIds: ids,
      }, { reader, ledger, confirmations, history, pool, env: closed });
      assertEq(result.status, 409, 'a closed gate is a 409');
      assertEq(result.body.code, 'OPERATOR_UI_COLLECTION_WRITES_DISABLED', 'and names the switch');
      assertEq(result.body.wrote, 'nothing', 'and says it wrote nothing');
      assertEq(result.body.contacted, 'nothing', 'and says it contacted nothing');
      assertEq(await ledgerCount(), before, 'and the ledger is unchanged');
      assertEq(fake.creates.length, 0, 'and no collection was created');
    });

    await test('an execute queues durable intents, contacts nothing, and says so honestly', async () => {
      const confirmations = new CollectionConfirmations();
      const plan = await planFor('Weekend picks', ids);
      assertEq(plan.counts.create, 2, 'the plan would create two');
      assertEq(plan.counts.blocked, 1, 'and one record has no reference to match on');

      const result = await executeWith(confirmations, plan, ids);
      assertEq(result.status, 200, `the execute answered ${result.status}: ${JSON.stringify(result.body)}`);
      assertEq(result.body.contacted, 'nothing', 'a queue contacts nothing');
      assertEq(result.body.wrote, 'durable intents only', 'and says exactly what it wrote');
      const queued = result.body.queued as Record<string, number>;
      assertEq(queued.queued, 2, 'two intents were written');
      assertEq(queued.blocked, 1, 'and the blocked record is still counted');
      assertEq(fake.creates.length, 0, 'and nothing was sent to the media server');

      const counts = await statusCounts();
      assertEq(counts.planned, 2, 'the ledger holds two planned intents');
      // The intents are IDENTITY-FREE and disclose only the two declared field names.
      const rows = (await admin.query('SELECT item_id, target, correlation_token, disclosed_fields, external_handle FROM publish_ledger ORDER BY id')).rows;
      for (const row of rows) {
        assertEq(row.target, 'jellyfin', 'the intent names this target');
        assert(typeof row.correlation_token === 'string' && row.correlation_token.length > 0, 'and carries a durable token');
        assertEq(row.external_handle, null, 'and no handle yet');
        assertEq([...row.disclosed_fields].sort().join(','), 'providerRefs,title', 'and discloses only the declared fields');
      }
    });

    await test('a replayed confirmation, and a re-execution of the same plan, queue nothing further', async () => {
      const confirmations = new CollectionConfirmations();
      const plan = await planFor('Weekend picks', ids);
      const confirmation = confirmations.issue({
        name: plan.name, planDigest: plan.planDigest, basisDigest: plan.basisDigest,
        create: plan.counts.create, update: plan.counts.update, revoke: plan.counts.revoke,
      });
      const body = { confirmation, confirmDigest: plan.planDigest, itemIds: ids };
      const deps = { reader, ledger, confirmations, history, pool, env };

      const before = await ledgerCount();
      const first = await collectionExecuteResponse(body, deps);
      // The plan now says "update" for both records, because both already have unfinished intents. Queuing it
      // writes NOTHING new and reports them as resumed.
      assertEq(first.status, 200, `the first execute answered ${first.status}`);
      const queued = first.body.queued as Record<string, number>;
      assertEq(queued.queued, 0, 'nothing new was queued for records that already have an intent');
      assertEq(queued.resumed, 2, 'and both are reported as resumed');
      assertEq(await ledgerCount(), before, 'so the ledger did not grow');

      const replay = await collectionExecuteResponse(body, deps);
      assertEq(replay.status, 409, 'a replayed confirmation is refused');
      assertEq(replay.body.code, 'OPERATOR_UI_COLLECTION_CONFIRMATION_ALREADY_USED', 'and says why');
      assertEq(replay.body.wrote, 'nothing', 'and wrote nothing');
      assertEq(await ledgerCount(), before, 'and the ledger is still unchanged');
    });

    await test('an execute whose world moved after the preview is refused as stale, and records the refusal', async () => {
      const confirmations = new CollectionConfirmations();
      const plan = await planFor('Stale plan', ids);
      const confirmation = confirmations.issue({
        name: plan.name, planDigest: plan.planDigest, basisDigest: plan.basisDigest,
        create: plan.counts.create, update: plan.counts.update, revoke: plan.counts.revoke,
      });
      // The catalog moves: one record's title is corrected. The ACTIONS do not change; the BASIS does.
      const target = ids[0]!;
      const identity = await authority.readIdentity(target);
      assert(identity !== null, 'the record is readable');
      await authority.updateIdentity(target, { ...identity, title: `${String(identity.title)} (restored)` });

      const before = await ledgerCount();
      const result = await collectionExecuteResponse(
        { confirmation, confirmDigest: plan.planDigest, itemIds: ids },
        { reader, ledger, confirmations, history, pool, env },
      );
      assertEq(result.status, 409, 'a stale plan is refused');
      assertEq(result.body.code, 'OPERATOR_UI_COLLECTION_PLAN_STALE', 'and says exactly that');
      assertEq(result.body.wrote, 'nothing', 'and wrote nothing');
      assertEq(result.body.contacted, 'nothing', 'and contacted nothing');
      assertEq(await ledgerCount(), before, 'and the ledger is unchanged');
      const refusals = (await admin.query(
        "SELECT count(*)::int AS n FROM collection_control_history WHERE outcome = 'refused'")).rows[0].n as number;
      assert(refusals >= 1, 'a refused execute is recorded, so it can be reviewed later');
    });

    await test('an execute whose digest echo is wrong is refused before anything is recomputed', async () => {
      const confirmations = new CollectionConfirmations();
      const plan = await planFor('Echo', ids);
      const before = await ledgerCount();
      const result = await collectionExecuteResponse({
        confirmation: confirmations.issue({
          name: plan.name, planDigest: plan.planDigest, basisDigest: plan.basisDigest,
          create: plan.counts.create, update: plan.counts.update, revoke: plan.counts.revoke,
        }),
        confirmDigest: 'f'.repeat(64),
        itemIds: ids,
      }, { reader, ledger, confirmations, history, pool, env });
      assertEq(result.status, 409, 'a wrong echo is refused');
      assertEq(result.body.code, 'OPERATOR_UI_COLLECTION_CONFIRMATION_DIGEST_MISMATCH', 'and says why');
      assertEq(await ledgerCount(), before, 'and nothing was queued');
    });

    await test('a reconcile carries out the queued work, exactly once, against a real server', async () => {
      const built = createCollectionRuntime({ pool, authority, fetch: realFetch, env });
      assert(built.ok, `the runtime refused: ${built.ok ? '' : built.refusal}`);
      const result = await runCollectionReconcile(built.runtime);
      assertEq(result.created, 2, `the reconcile created two collections (got ${JSON.stringify(result)})`);
      assertEq(result.failed, 0, 'and nothing failed');
      assertEq(fake.collections.size, 2, 'and the server holds exactly two');
      const counts = await statusCounts();
      assertEq(counts.published, 2, 'and both intents are settled as published');
      assertEq(counts.planned ?? 0, 0, 'with nothing left planned');

      // The created names carry the operator's own label AND the opaque recovery marker.
      for (const name of fake.creates) {
        assert(name.includes('[cat:'), `a created collection carries its recovery marker: ${name}`);
        assert(!name.includes(SECRET_REF), 'and never a provider reference value');
      }

      // IDEMPOTENT: a second pass over a settled ledger does nothing at all.
      const again = await runCollectionReconcile(built.runtime);
      assertEq(JSON.stringify(again), JSON.stringify({ adopted: 0, created: 0, failed: 0, stuck: 0 }),
        'a second reconcile over a settled ledger does nothing');
      assertEq(fake.collections.size, 2, 'and creates no second copy');
    });

    await test('a create whose response is LOST is recovered by token, without creating a duplicate', async () => {
      // A fresh record, so this leg owns its own intent.
      const extra = `${JSON.stringify({
        format: 'catalog-authority.snapshot', version: 1, source: 'exec-library',
        items: [{ externalId: 'e-4', title: 'Ambiguous Delta', providerRefs: [{ type: 'imdb', value: `${SECRET_REF}-4` }] }],
      }, null, 2)}\n`;
      await applyImport({ text: extra, lookup: createExistingStateLookup(pool), authority, actor: 'cli', fileName: 'exec2.json' });
      const allIds = [...await reader.listActiveIds(20, 0)];
      const newId = allIds.find((id) => !ids.includes(id))!;
      assert(newId !== undefined, 'the extra record imported');
      // The fake server has to HOLD a library item matching the new record's reference, or the create would
      // fail at the boundary for an unrelated reason and this leg would prove nothing about ambiguity.
      fake.library[`imdb:${SECRET_REF}-4`] = 'jf-item-4';
      const confirmations = new CollectionConfirmations();
      const plan = await planFor('Ambiguous', [newId]);
      assertEq(plan.counts.create, 1, 'the new record would be created');
      const queued = await executeWith(confirmations, plan, [newId]);
      assertEq(queued.status, 200, 'the intent was queued');

      const built = createCollectionRuntime({ pool, authority, fetch: realFetch, env });
      assert(built.ok, 'the runtime built');
      // The server will CREATE and then lose the response. The outbox must not create a second one.
      fake.loseNextCreateResponse = true;
      const before = fake.collections.size;
      const first = await runCollectionReconcile(built.runtime);
      assertEq(fake.collections.size, before + 1, 'the server created the artifact even though the response was lost');
      assert(first.created === 0, 'and the outbox did not claim to have created it');

      // The recovery pass finds it BY ITS DURABLE TOKEN and adopts the handle. No second create.
      const second = await runCollectionReconcile(built.runtime);
      assertEq(second.adopted, 1, `the second pass adopted the existing artifact (got ${JSON.stringify(second)})`);
      assertEq(fake.collections.size, before + 1, 'and created no duplicate');
      const counts = await statusCounts();
      assertEq(counts.ambiguous ?? 0, 0, 'and nothing is left ambiguous');
      assertEq(counts.published, 3, 'and all three intents are published');
    });

    await test('a lookup that FAILS is never read as absence, so nothing is created on top of it', async () => {
      const extra = `${JSON.stringify({
        format: 'catalog-authority.snapshot', version: 1, source: 'exec-library',
        items: [{ externalId: 'e-5', title: 'Blind Echo', providerRefs: [{ type: 'imdb', value: `${SECRET_REF}-5` }] }],
      }, null, 2)}\n`;
      await applyImport({ text: extra, lookup: createExistingStateLookup(pool), authority, actor: 'cli', fileName: 'exec3.json' });
      const allIds = [...await reader.listActiveIds(20, 0)];
      const rows = (await admin.query('SELECT item_id FROM publish_ledger')).rows.map((r) => String(r.item_id));
      const newId = allIds.find((id) => !rows.includes(id) && id !== ids[2])!;
      fake.library[`imdb:${SECRET_REF}-5`] = 'jf-item-5';
      const confirmations = new CollectionConfirmations();
      const plan = await planFor('Blind', [newId]);
      await executeWith(confirmations, plan, [newId]);

      const built = createCollectionRuntime({ pool, authority, fetch: realFetch, env });
      assert(built.ok, 'the runtime built');
      const before = fake.collections.size;
      fake.breakLookup = true;
      const blind = await runCollectionReconcile(built.runtime);
      fake.breakLookup = false;
      assertEq(fake.collections.size, before, 'a failing lookup created nothing');
      assert(blind.created === 0, 'and reported no create');
      assert(blind.stuck >= 1, 'and left the intent for a later pass rather than guessing');

      // With the lookup working again, the intent completes normally.
      const recovered = await runCollectionReconcile(built.runtime);
      assertEq(recovered.created, 1, 'and it completes once the server can be seen again');
    });

    await test('the queued work, and everything settled, survive a restart of the process', async () => {
      // A "restart" is a new pool, a new authority, a new runtime and a NEW confirmation issuer — which is
      // exactly what a container replacement is. The ledger is the only thing that carries across.
      const beforeCounts = await statusCounts();
      await closePool();
      const { getPool: getPoolAgain } = await import('../src/db/pool.js');
      const restartedPool = getPoolAgain();
      const restartedAuthority = new CatalogAuthority(restartedPool, createCustodian(loadCustodianConfig()));
      const afterCounts = await statusCounts();
      assertEq(JSON.stringify(afterCounts), JSON.stringify(beforeCounts), 'the ledger survived the restart unchanged');

      // A confirmation issued before the restart no longer verifies: it is a statement about a preview THAT
      // process performed, and this is a different process.
      const oldIssuer = new CollectionConfirmations();
      const plan = await buildCollectionPlan(createCatalogReader(restartedPool, restartedAuthority), createLedgerReader(restartedPool), { name: 'Restarted', itemIds: [ids[0]] });
      assert(plan.ok, 'the plan built after the restart');
      const stale = oldIssuer.issue({
        name: plan.plan.name, planDigest: plan.plan.planDigest, basisDigest: plan.plan.basisDigest,
        create: plan.plan.counts.create, update: plan.plan.counts.update, revoke: plan.plan.counts.revoke,
      });
      const newIssuer = new CollectionConfirmations();
      const verdict = newIssuer.verify(stale, plan.plan.planDigest);
      assert(!verdict.ok && verdict.rejection === 'BAD_SIGNATURE', 'a pre-restart confirmation does not verify');

      // And a reconcile after the restart still does nothing to settled work.
      const built = createCollectionRuntime({ pool: restartedPool, authority: restartedAuthority, fetch: realFetch, env });
      assert(built.ok, 'the runtime built after the restart');
      const result = await runCollectionReconcile(built.runtime);
      assertEq(result.created, 0, 'a reconcile after a restart creates nothing that was already done');
      assertEq(result.adopted, 0, 'and adopts nothing');
    });

    await test('forgetting a published record revokes its external copy, and a failed revoke stays queued', async () => {
      const pool2 = (await import('../src/db/pool.js')).getPool();
      const authority2 = new CatalogAuthority(pool2, createCustodian(loadCustodianConfig()));
      const published = (await admin.query("SELECT item_id, external_handle FROM publish_ledger WHERE status = 'published' ORDER BY id LIMIT 1")).rows[0];
      assert(published !== undefined, 'there is a published row to work with');
      const handle = String(published.external_handle);
      assert(fake.collections.has(handle), 'and the server holds its collection');

      await authority2.forget(String(published.item_id));

      // The plan now proposes exactly one revoke, derived independently of the ledger's own sweep.
      const plan = await buildCollectionPlan(createCatalogReader(pool2, authority2), createLedgerReader(pool2), {
        name: 'After erasure', itemIds: [ids[1]],
      });
      assert(plan.ok, 'the plan built');
      assert(plan.plan.counts.revoke >= 1, 'the plan proposes a revoke for the forgotten record');

      const built = createCollectionRuntime({ pool: pool2, authority: authority2, fetch: realFetch, env });
      assert(built.ok, 'the runtime built');

      // A DELETE that fails leaves the row queued and retryable — never marked revoked.
      fake.breakDelete = true;
      const attempted = await runCollectionRevocation(pool2, built.runtime);
      fake.breakDelete = false;
      assert(attempted.queued >= 1, 'the forgotten row was queued for revocation');
      assertEq(attempted.revoked, 0, 'a failed delete revokes nothing');
      assert(attempted.pending >= 1, 'and the external copy is still reported as out there');
      assert(fake.collections.has(handle), 'and it really is still there');

      const succeeded = await runCollectionRevocation(pool2, built.runtime);
      assert(succeeded.revoked >= 1, 'a retry revokes it');
      assert(!fake.collections.has(handle), 'and the collection is gone from the server');
      const counts = await statusCounts();
      assert((counts.revoke_pending ?? 0) === 0, 'and nothing is left waiting to be revoked');
    });

    await test('the status route reports every state, and whether this installation may act on it', async () => {
      const pool3 = (await import('../src/db/pool.js')).getPool();
      const status = await readCollectionStatus(pool3);
      assertEq(status.target, 'jellyfin', 'the status is about this target');
      assert(Object.keys(status.counts).includes('published'), 'and reports every state including the boring ones');
      const served = await collectionStatusResponse(pool3, env);
      assertEq(served.status, 200, 'the status route answers');
      assertEq(served.body.writesEnabled, true, 'and says writes are enabled when they are');
      const closed = { ...env };
      delete closed[JELLYFIN_ALLOW_COLLECTION_WRITES_ENV];
      const gated = await collectionStatusResponse(pool3, closed);
      assertEq(gated.body.writesEnabled, false, 'and says they are not when they are not');
      assertEq(gated.body.writesRefusal, 'WRITES_DISABLED', 'and names the switch');
    });

    await test('a reconcile or revoke with a closed gate refuses, having built no client', async () => {
      const pool4 = (await import('../src/db/pool.js')).getPool();
      const authority4 = new CatalogAuthority(pool4, createCustodian(loadCustodianConfig()));
      const closed = { ...env };
      delete closed.PUBLISH_EXTERNAL_IDENTITY;
      const before = fake.creates.length;
      for (const handler of [collectionReconcileResponse, collectionRevokeResponse]) {
        const result = await handler({ pool: pool4, authority: authority4, fetch: realFetch, env: closed, history });
        assertEq(result.status, 409, 'a closed gate is a 409');
        assertEq(result.body.code, 'OPERATOR_UI_COLLECTION_CONSENT_DENIED', 'and names the switch');
        assertEq(result.body.contacted, 'nothing', 'and it contacted nothing');
      }
      assertEq(fake.creates.length, before, 'and no create was attempted');
    });

    // -----------------------------------------------------------------------------------------------------
    // The routes, over real HTTP.
    // -----------------------------------------------------------------------------------------------------

    await test('the write routes refuse a cross-origin, non-JSON or oversized request before parsing', async () => {
      const config = validateOperatorUiServiceConfig({ port: 8099, operatorSecretFile: TOKEN_FILE, promotionRecordsDir: WORK });
      const port = await freePort();
      const server = createOperatorUiServiceServer(config, loadOperatorUiLocalAuthRuntime(TOKEN_FILE));
      await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', resolve); });
      const live = caller(port);
      try {
        const before = await ledgerCount();
        for (const route of COLLECTIONS_WRITE_ROUTES) {
          assertEq((await live(route, { method: 'POST', body: '{}' })).status, 401, `${route} refuses an unauthenticated write`);
          assertEq((await live(route, { token: TOKEN })).status, 405, `${route} refuses a GET`);
          assertEq((await live(route, { token: TOKEN, method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } })).status, 400,
            `${route} refuses a body that is not declared JSON`);
          assertEq((await live(route, { token: TOKEN, method: 'POST', body: '{}', headers: { origin: 'http://evil.example' } })).status, 403,
            `${route} refuses a cross-origin request`);
          assertEq((await live(route, { token: TOKEN, method: 'POST', body: '{}', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403,
            `${route} refuses a cross-site fetch`);
          const huge = await live(route, { token: TOKEN, method: 'POST', body: JSON.stringify({ pad: 'x'.repeat(COLLECTIONS_REQUEST_MAX_BYTES) }) });
          assertEq(huge.status, 413, `${route} refuses an oversized body`);
          assertEq(huge.body.code, `OPERATOR_UI_COLLECTION_TOO_LARGE`, `${route} says the body was too large`);
        }
        for (const route of [COLLECTIONS_STATUS_ROUTE, '/api/collections/history']) {
          assertEq((await live(route)).status, 401, `${route} refuses an unauthenticated read`);
          assertEq((await live(route, { token: TOKEN, method: 'POST', body: '{}' })).status, 405, `${route} refuses a POST`);
        }
        assertEq(await ledgerCount(), before, 'and not one refusal wrote a ledger row');
      } finally {
        await new Promise<void>((resolve) => { server.close(() => resolve()); });
      }
    });

    await test('a browsing session over the real routes writes no row, no event and no ledger entry', async () => {
      const config = validateOperatorUiServiceConfig({ port: 8099, operatorSecretFile: TOKEN_FILE, promotionRecordsDir: WORK });
      const port = await freePort();
      const server = createOperatorUiServiceServer(config, loadOperatorUiLocalAuthRuntime(TOKEN_FILE));
      await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', resolve); });
      const live = caller(port);
      const snapshot = async (): Promise<string> => JSON.stringify({
        items: (await admin.query('SELECT count(*)::int AS n FROM items')).rows[0].n,
        events: (await admin.query('SELECT count(*)::int AS n FROM events')).rows[0].n,
        ledger: (await admin.query('SELECT count(*)::int AS n FROM publish_ledger')).rows[0].n,
        collectionHistory: (await admin.query('SELECT count(*)::int AS n FROM collection_control_history')).rows[0].n,
      });
      try {
        const before = await snapshot();
        for (const path of ['/', '/api/jellyfin/status', '/api/jellyfin/discovery', COLLECTIONS_STATUS_ROUTE,
          '/api/collections/history', '/api/catalog', '/api/logs']) {
          const result = await live(path, { token: TOKEN });
          assert(result.status < 500 || result.status === 503, `${path} answered ${result.status}`);
        }
        assertEq(await snapshot(), before, 'a browsing session wrote something');
      } finally {
        await new Promise<void>((resolve) => { server.close(() => resolve()); });
      }
    });

    await test('nothing this suite emitted carries a reference value, an api key, the token or a Jellyfin id', () => {
      const all = emitted.join('\n');
      for (const forbidden of [SECRET_REF, API_KEY, TOKEN, KEY_FILE, 'jf-col-', 'jf-item-', fake.baseUrl]) {
        assert(!all.includes(forbidden), `a response disclosed ${forbidden}`);
      }
      assert(emitted.length > 10, 'and the scan saw a meaningful number of responses');
    });

    await test('the repository keeps this phase wired and described', () => {
      const service = readRepo('src/ops/operator-ui-service.ts');
      for (const route of [COLLECTIONS_PLAN_ROUTE, COLLECTIONS_EXECUTE_ROUTE, COLLECTIONS_RECONCILE_ROUTE, COLLECTIONS_REVOKE_ROUTE]) {
        assert(service.includes(route.split('/').pop()!.toUpperCase().replace('-', '_')) || service.includes(route),
          `the service knows ${route}`);
      }
      const inventory = JSON.parse(readRepo('test/suite-inventory.json')) as { suites: Array<{ file: string }> };
      for (const file of ['jellyfin-control-plane.ts', 'collection-plan-preview.ts', 'collection-execution.ts']) {
        assert(inventory.suites.some((s) => s.file === file), `${file} is in the aggregate inventory`);
      }
      const doc = readRepo('docs/PHASE_266_268_JELLYFIN_CONTROL_PLANE.md');
      assert(doc.includes('Execute = queue'), 'the document explains the two halves');
      assert(doc.includes('recovery proof'), 'and the recovery proof that governs a create');
    });

    await fake.close();
    await admin.end();
    await closePool();
    if (pg !== undefined) await pg.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
  try { rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(failed === 0 ? 0 : 1);
}

void main();
