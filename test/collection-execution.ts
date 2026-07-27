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
  LEGACY_DISCLOSED_FIELDS,
  checkCollectionWriteGates,
  createCollectionRuntime,
  readCollectionStatus,
  runCollectionReconcile,
  runCollectionRevocation,
} from '../src/ops/collection-execution.js';
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
import {
  createOperatorUiServiceServer,
  validateOperatorUiServiceConfig,
} from '../src/ops/operator-ui-service.js';
import { OPERATOR_UI_LOCAL_AUTH_HEADER, loadOperatorUiLocalAuthRuntime } from '../src/ops/operator-ui-local-auth-runtime.js';

// Phase 270 — ONE confirmed plan becomes ONE external collection, and stays in agreement with it.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - FOUR SWITCHES, EACH INDEPENDENT, EACH FAIL-CLOSED. Nothing is queued and nothing is sent while any one
//     of them is off, and the refusal names which one.
//   - EXECUTE QUEUES AND CONTACTS NOTHING. The durable collection and its membership exist before any side
//     effect.
//   - ONE PLAN, ONE COLLECTION, ON THE ACTUAL SERVER. Two records become ONE collection holding two library
//     items — the thing Phase 268 could not do — and its name is the operator's own label, never a title.
//   - A STALE PLAN, A REPLAYED CONFIRMATION AND A WRONG DIGEST ECHO ARE EACH REFUSED, and a replay cannot
//     record a second copy of anything.
//   - AN AMBIGUOUS OR LOST RESPONSE IS RECOVERED BY TOKEN, WITHOUT DUPLICATING.
//   - A LOOKUP FAILURE IS NEVER ABSENCE. Nothing is created while the token lookup is failing.
//   - MEMBERSHIP RECONCILES BY SET DIFFERENCE, AND NEVER REMOVES ON PARTIAL KNOWLEDGE.
//   - FORGETTING A MEMBER TAKES ITS LIBRARY ITEMS BACK OUT — partially, leaving the rest — and forgetting the
//     last member deletes the collection. A failed delete stays queued rather than being marked done.
//   - A RESTART LOSES AND DUPLICATES NOTHING.
//   - THE V8 PER-RECORD ROWS ARE STILL FINISHED AND STILL REVOKED, and never adopted into a group.
//   - THE WRITE ROUTES REFUSE A CROSS-ORIGIN, NON-JSON OR OVERSIZED REQUEST BEFORE PARSING.
//   - NOTHING DISCLOSES a provider reference, an api key, the operator token, a Jellyfin id or a token.

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
const SECRET_REF = 'tt-phase270-ref-value-must-never-be-disclosed';
const API_KEY = 'phase270-api-key-must-never-be-disclosed';
const KEY_FILE = join(WORK, 'jellyfin_api_key');
writeFileSync(KEY_FILE, `${API_KEY}\n`, 'utf8');
const TOKEN = 'phase270-operator-token-abcdefghij';
const TOKEN_FILE = join(WORK, 'operator_token');
writeFileSync(TOKEN_FILE, TOKEN, 'utf8');

const emitted: string[] = [];

// --- a fake Jellyfin that can lose a response, break a lookup, and hold collection MEMBERSHIP ---------------

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
  /** Make every collection-member listing fail, so no removal may be computed. */
  breakMemberList: boolean;
  /** Make the candidate listing fail, so the intended set cannot be resolved completely. */
  breakCandidates: boolean;
  readonly creates: string[];
  readonly adds: Array<{ id: string; ids: string[] }>;
  readonly removes: Array<{ id: string; ids: string[] }>;
  close(): Promise<void>;
}

async function startFakeJellyfin(initialLibrary: Record<string, string>): Promise<FakeJellyfin> {
  const library = { ...initialLibrary };
  const collections = new Map<string, FakeCollection>();
  const creates: string[] = [];
  const adds: Array<{ id: string; ids: string[] }> = [];
  const removes: Array<{ id: string; ids: string[] }> = [];
  let counter = 0;
  const state = {
    loseNextCreateResponse: false, breakLookup: false, breakDelete: false,
    breakMemberList: false, breakCandidates: false,
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const json = (value: unknown, status = 200): void => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(value));
    };
    const idsParam = (): string[] => (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);

    if (url.pathname === '/System/Info') { json({ Version: '10.9.11' }); return; }

    if (req.method === 'POST' && url.pathname === '/Collections') {
      const name = url.searchParams.get('name') ?? '';
      const id = `jf-col-${++counter}`;
      collections.set(id, { id, name, ids: idsParam() });
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

    const collectionItems = /^\/Collections\/([^/]+)\/Items$/.exec(url.pathname);
    if (collectionItems !== null) {
      const id = decodeURIComponent(collectionItems[1]!);
      const collection = collections.get(id);
      if (collection === undefined) { json({}, 404); return; }
      if (req.method === 'POST') {
        const wanted = idsParam();
        adds.push({ id, ids: wanted });
        for (const item of wanted) if (!collection.ids.includes(item)) collection.ids.push(item);
        json({});
        return;
      }
      if (req.method === 'DELETE') {
        const wanted = idsParam();
        removes.push({ id, ids: wanted });
        collection.ids = collection.ids.filter((item) => !wanted.includes(item));
        json({});
        return;
      }
      json({}, 405);
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
      // The MEMBER listing is a `/Items?parentId=` read (lowercase, as the mapping pins it).
      const parentId = url.searchParams.get('parentId');
      if (parentId !== null) {
        if (state.breakMemberList) { json({ error: 'no' }, 500); return; }
        const start = Number(url.searchParams.get('startIndex') ?? '0');
        const limit = Number(url.searchParams.get('limit') ?? '500');
        const collection = collections.get(parentId);
        const rows = (collection?.ids ?? []).map((id) => ({ Id: id }));
        json({ Items: rows.slice(start, start + limit) });
        return;
      }
      const types = (url.searchParams.get('IncludeItemTypes') ?? '').split(',');
      const start = Number(url.searchParams.get('StartIndex') ?? '0');
      const limit = Number(url.searchParams.get('Limit') ?? '500');
      if (types.includes('BoxSet')) {
        if (state.breakLookup) { json({ error: 'no' }, 500); return; }
        const rows = [...collections.values()].map((c) => ({ Id: c.id, Name: c.name }));
        json({ Items: rows.slice(start, start + limit) });
        return;
      }
      if (state.breakCandidates) { json({ error: 'no' }, 500); return; }
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
    adds,
    removes,
    get loseNextCreateResponse() { return state.loseNextCreateResponse; },
    set loseNextCreateResponse(value: boolean) { state.loseNextCreateResponse = value; },
    get breakLookup() { return state.breakLookup; },
    set breakLookup(value: boolean) { state.breakLookup = value; },
    get breakDelete() { return state.breakDelete; },
    set breakDelete(value: boolean) { state.breakDelete = value; },
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
  console.log('Running Phase 270 grouped collection execution suite:\n');

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
        assert(!checkCollectionWriteGates({ ...base, [key]: near }).ok, `${key}=${near} must not turn it on`);
      }
    }
    const bad = { ...base, JELLYFIN_BASE_URL: 'http://jellyfin.example.com' };
    const result = checkCollectionWriteGates(bad);
    assert(!result.ok && result.refusal === 'NOT_CONFIGURED', 'a public address is not a usable configuration');
  });

  await test('the runtime cannot be built while any gate is closed, and the grouped disclosure is NARROWER', () => {
    const fakeFetch: FetchLike = () => { throw new Error('a transport must never be reached here'); };
    const built = createCollectionRuntime({
      pool: null as never, authority: null as never, fetch: fakeFetch, env: { PUBLISH_EXTERNAL_IDENTITY: 'allow' },
    });
    assert(!built.ok, 'a closed gate produces no runtime');
    assertEq(built.refusal, 'NETWORK_DISABLED', 'and says which gate');

    // A GROUPED collection is named after the operator's own label, so the create no longer needs a title.
    // That is a disclosure this phase REMOVED, and it is asserted so it cannot creep back.
    assertEq([...COLLECTION_DISCLOSED_FIELDS].sort().join(','), 'providerRefs',
      'a grouped create discloses exactly the provider references and nothing else');
    assertEq([...LEGACY_DISCLOSED_FIELDS].sort().join(','), 'providerRefs,title',
      'while the legacy per-record engine keeps what it always disclosed, unchanged');
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

    let pool = getPool();
    let authority = new CatalogAuthority(pool, createCustodian(loadCustodianConfig()));
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

    // Resolved once against the initial pool; the ids and the fixture titles do not change with a restart.
    const idOf = async (title: string): Promise<string> => {
      for (const id of await createCatalogReader(pool, authority).listActiveIds(50, 0)) {
        if ((await authority.readIdentity(id))?.title === title) return id;
      }
      throw new Error(`the fixture record ${title} was not found`);
    };
    const alpha = await idOf('Executed Alpha');
    const bravo = await idOf('Executed Bravo');

    const fake = await startFakeJellyfin({
      [`imdb:${SECRET_REF}-1`]: 'jf-item-1',
      [`imdb:${SECRET_REF}-2`]: 'jf-item-2',
    });
    const env = fullGateEnv(fake.baseUrl);
    const realFetch = globalThis.fetch as unknown as FetchLike;

    // Everything below reads its collaborators through these, so a leg that restarts the pool is not followed
    // by legs holding a closed one.
    const reader = () => createCatalogReader(pool, authority);
    const ledger = () => createLedgerReader(pool);
    const managed = () => createManagedCollectionReader(pool);
    const history = () => createCollectionHistoryStore(pool);
    const deps = () => ({
      reader: reader(), ledger: ledger(), managed: managed(), history: history(), pool, env,
    });
    const ids = [...await reader().listActiveIds(10, 0)];

    const collectionCount = async (): Promise<number> =>
      (await admin.query('SELECT count(*)::int AS n FROM managed_collections')).rows[0].n as number;
    const memberCount = async (): Promise<number> =>
      (await admin.query('SELECT count(*)::int AS n FROM managed_collection_members')).rows[0].n as number;
    const statusOf = async (name: string): Promise<{ status: string; handle: string | null; needsSync: boolean } | null> => {
      const { rows } = await admin.query(
        'SELECT status, external_handle, needs_sync FROM managed_collections WHERE collection_key = $1 ORDER BY id DESC LIMIT 1',
        [collectionKeyFor('jellyfin', name)]);
      return rows.length === 0 ? null : { status: rows[0].status, handle: rows[0].external_handle, needsSync: rows[0].needs_sync };
    };
    const named = (prefix: string): FakeCollection | undefined =>
      [...fake.collections.values()].find((c) => c.name.startsWith(`${prefix} `));

    const planFor = async (name: string, selection: readonly string[] | null): Promise<CollectionPlan> => {
      const result = await buildCollectionPlan(
        { reader: reader(), ledger: ledger(), managed: managed() },
        selection === null ? { name, mode: 'revoke' } : { name, itemIds: [...selection] },
      );
      assert(result.ok, `the plan was refused: ${result.ok ? '' : result.rejection}`);
      return result.plan;
    };

    const bodyFor = (confirmations: CollectionConfirmations, plan: CollectionPlan, selection: readonly string[] | null) => ({
      confirmation: confirmations.issue({
        name: plan.name, planDigest: plan.planDigest, basisDigest: plan.basisDigest,
        create: plan.counts.add, update: plan.counts.keep, revoke: plan.counts.remove,
      }),
      confirmDigest: plan.planDigest,
      ...(selection === null ? { mode: 'revoke' } : { itemIds: [...selection] }),
    });

    const executeWith = async (
      confirmations: CollectionConfirmations,
      plan: CollectionPlan,
      selection: readonly string[] | null,
    ) => collectionExecuteResponse(bodyFor(confirmations, plan, selection), { ...deps(), confirmations });

    /** Queue a plan through the real route, with a fresh confirmation. The whole gate chain, every time. */
    const queue = async (name: string, selection: readonly string[] | null): Promise<void> => {
      const confirmations = new CollectionConfirmations();
      const plan = await planFor(name, selection);
      const result = await executeWith(confirmations, plan, selection);
      assert(result.status < 300, `queuing ${name} answered ${result.status}: ${JSON.stringify(result.body)}`);
    };

    const runtime = () => {
      const built = createCollectionRuntime({ pool, authority, fetch: realFetch, env });
      assert(built.ok, `the runtime refused: ${built.ok ? '' : built.refusal}`);
      return built.runtime;
    };
    const reconcile = async () => runCollectionReconcile(runtime());
    const revokePass = async () => runCollectionRevocation(pool, runtime());

    // -----------------------------------------------------------------------------------------------------

    await test('an execute with a closed gate queues nothing and contacts nothing', async () => {
      const before = await collectionCount();
      const confirmations = new CollectionConfirmations();
      const plan = await planFor('Gated', ids);
      const closed = { ...env };
      delete closed[JELLYFIN_ALLOW_COLLECTION_WRITES_ENV];
      const result = await collectionExecuteResponse(bodyFor(confirmations, plan, ids),
        { ...deps(), confirmations, env: closed });
      assertEq(result.status, 409, 'a closed gate is a 409');
      assertEq(result.body.code, 'OPERATOR_UI_COLLECTION_WRITES_DISABLED', 'and names the switch');
      assertEq(result.body.wrote, 'nothing', 'and says it wrote nothing');
      assertEq(result.body.contacted, 'nothing', 'and says it contacted nothing');
      assertEq(await collectionCount(), before, 'and no collection was recorded');
      assertEq(fake.creates.length, 0, 'and no collection was created');
    });

    await test('ONE execute records ONE collection holding the selected records, and contacts nothing', async () => {
      const confirmations = new CollectionConfirmations();
      const plan = await planFor('Weekend picks', ids);
      assertEq(plan.collection.action, 'create', 'the plan would create one collection');
      assertEq(plan.counts.add, 2, 'holding the two records that carry a reference');
      assertEq(plan.counts.blocked, 1, 'and one record has no reference to match on');

      const result = await executeWith(confirmations, plan, ids);
      assertEq(result.status, 200, `the execute answered ${result.status}: ${JSON.stringify(result.body)}`);
      assertEq(result.body.contacted, 'nothing', 'a queue contacts nothing');
      assertEq(result.body.wrote, 'durable collection state only', 'and says exactly what it wrote');
      const queued = result.body.queued as Record<string, unknown>;
      assertEq(queued.action, 'created', 'one collection was recorded as created');
      assertEq(queued.members, 2, 'holding two records');
      assertEq(queued.blocked, 1, 'and the blocked record is still counted');
      assertEq(fake.creates.length, 0, 'and nothing was sent to the media server');

      assertEq(await collectionCount(), 1, 'exactly ONE durable collection exists — not one per record');
      assertEq(await memberCount(), 2, 'with two membership rows');
      const row = await statusOf('Weekend picks');
      assertEq(row?.status, 'planned', 'the collection is queued, not published');
      assertEq(row?.handle, null, 'and has no external handle yet');

      // The durable rows are IDENTITY-FREE: an opaque catalog id, a state, and nothing else.
      for (const member of (await admin.query('SELECT item_id, state, synced FROM managed_collection_members ORDER BY item_id')).rows) {
        assert(/^[0-9a-f-]{36}$/.test(member.item_id), 'a member is an opaque record id');
        assertEq(member.state, 'intended', 'and is intended');
        assertEq(member.synced, false, 'and not yet observed out there');
      }
    });

    await test('a replayed confirmation, and a re-execution of the same plan, record nothing further', async () => {
      const confirmations = new CollectionConfirmations();
      const plan = await planFor('Weekend picks', ids);
      const body = bodyFor(confirmations, plan, ids);
      const executeDeps = { ...deps(), confirmations };

      const before = await collectionCount();
      const first = await collectionExecuteResponse(body, executeDeps);
      assertEq(first.status, 200, `the first execute answered ${first.status}`);
      assertEq(await collectionCount(), before, 'a re-execution adopts the same collection rather than making another');

      const replay = await collectionExecuteResponse(body, executeDeps);
      assertEq(replay.status, 409, 'a replayed confirmation is refused');
      assertEq(replay.body.code, 'OPERATOR_UI_COLLECTION_CONFIRMATION_ALREADY_USED', 'and says why');
      assertEq(replay.body.wrote, 'nothing', 'and wrote nothing');
      assertEq(await collectionCount(), before, 'and no collection was added');
    });

    await test('an execute whose world moved after the preview is refused as stale, and records the refusal', async () => {
      const confirmations = new CollectionConfirmations();
      const plan = await planFor('Stale plan', ids);
      const confirmation = confirmations.issue({
        name: plan.name, planDigest: plan.planDigest, basisDigest: plan.basisDigest,
        create: plan.counts.add, update: plan.counts.keep, revoke: plan.counts.remove,
      });
      // The catalog moves: one record's title is corrected. The membership does not change; the BASIS does.
      const identity = await authority.readIdentity(alpha);
      assert(identity !== null, 'the record is readable');
      await authority.updateIdentity(alpha, { ...identity, title: `${String(identity.title)} (restored)` });

      const before = await collectionCount();
      const result = await collectionExecuteResponse(
        { confirmation, confirmDigest: plan.planDigest, itemIds: ids },
        { ...deps(), confirmations },
      );
      assertEq(result.status, 409, 'a stale plan is refused');
      assertEq(result.body.code, 'OPERATOR_UI_COLLECTION_PLAN_STALE', 'and says exactly that');
      assertEq(result.body.wrote, 'nothing', 'and wrote nothing');
      assertEq(result.body.contacted, 'nothing', 'and contacted nothing');
      assertEq(await collectionCount(), before, 'and no collection was recorded');
      const refusals = (await admin.query(
        "SELECT count(*)::int AS n FROM collection_control_history WHERE outcome = 'refused'")).rows[0].n as number;
      assert(refusals >= 1, 'a refused execute is recorded, so it can be reviewed later');
    });

    await test('an execute whose digest echo is wrong is refused before anything is recomputed', async () => {
      const confirmations = new CollectionConfirmations();
      const plan = await planFor('Echo', ids);
      const before = await collectionCount();
      const result = await collectionExecuteResponse({
        confirmation: confirmations.issue({
          name: plan.name, planDigest: plan.planDigest, basisDigest: plan.basisDigest,
          create: plan.counts.add, update: plan.counts.keep, revoke: plan.counts.remove,
        }),
        confirmDigest: 'f'.repeat(64),
        itemIds: ids,
      }, { ...deps(), confirmations });
      assertEq(result.status, 409, 'a wrong echo is refused');
      assertEq(result.body.code, 'OPERATOR_UI_COLLECTION_CONFIRMATION_DIGEST_MISMATCH', 'and says why');
      assertEq(await collectionCount(), before, 'and nothing was recorded');
    });

    await test('a reconcile creates ONE collection holding BOTH library items, named by the operator', async () => {
      const result = await reconcile();
      assertEq(result.grouped.created, 1, `one collection was created (got ${JSON.stringify(result.grouped)})`);
      assertEq(result.grouped.failed, 0, 'and nothing failed');
      assertEq(fake.collections.size, 1, 'and the server holds exactly ONE collection — not one per record');
      const collection = named('Weekend picks')!;
      assert(collection !== undefined, 'the collection carries the operator\'s own label');
      assertEq([...collection.ids].sort().join(','), 'jf-item-1,jf-item-2', 'holding both matched library items');

      assert(collection.name.includes('[cat:'), 'and its recovery marker');
      for (const forbidden of ['Executed Alpha', 'Executed Bravo', SECRET_REF]) {
        assert(!collection.name.includes(forbidden), `the collection name disclosed ${forbidden}`);
      }

      const row = await statusOf('Weekend picks');
      assertEq(row?.status, 'published', 'the durable collection is settled');
      assert(row?.handle !== null, 'and holds the handle that makes it revocable');
      assertEq(row?.needsSync, false, 'and is in agreement with its plan');

      // IDEMPOTENT: a second pass over a settled, synced model does nothing at all.
      const again = await reconcile();
      assertEq(again.grouped.created, 0, 'a second reconcile creates nothing');
      assertEq(again.grouped.updated, 0, 'and changes nothing');
      assertEq(fake.collections.size, 1, 'and there is still exactly one collection');
    });

    // A fourth record, whose reference the fake library also holds. Used by the membership legs below.
    const extra = `${JSON.stringify({
      format: 'catalog-authority.snapshot', version: 1, source: 'exec-library',
      items: [{ externalId: 'e-4', title: 'Executed Delta', year: 2010, providerRefs: [{ type: 'imdb', value: `${SECRET_REF}-4` }] }],
    }, null, 2)}\n`;
    await applyImport({ text: extra, lookup: createExistingStateLookup(pool), authority, actor: 'cli', fileName: 'extra.json' });
    fake.library[`imdb:${SECRET_REF}-4`] = 'jf-item-4';
    const delta = await idOf('Executed Delta');

    await test('adding a record to the SAME collection adds only the missing library item', async () => {
      const plan = await planFor('Weekend picks', [alpha, bravo, delta]);
      assertEq(plan.collection.action, 'update', 'the SAME collection is updated');
      assertEq(plan.counts.add, 1, 'with one record going in');
      assertEq(plan.counts.keep, 2, 'and two already there');
      await queue('Weekend picks', [alpha, bravo, delta]);

      const addsBefore = fake.adds.length;
      const result = await reconcile();
      assertEq(result.grouped.updated, 1, `the collection was updated (got ${JSON.stringify(result.grouped)})`);
      assertEq(result.grouped.created, 0, 'and no second collection was created');
      assertEq(fake.collections.size, 1, 'the server still holds exactly one collection');
      assertEq(fake.adds.length, addsBefore + 1, 'exactly one add request was sent');
      assertEq(fake.adds[fake.adds.length - 1]!.ids.join(','), 'jf-item-4',
        'carrying ONLY the item that was missing — a set difference, not a rewrite');
      assertEq([...named('Weekend picks')!.ids].sort().join(','), 'jf-item-1,jf-item-2,jf-item-4', 'and the collection now holds three');
    });

    await test('removing a record from the selection takes ONLY its library item back out', async () => {
      const plan = await planFor('Weekend picks', [alpha, bravo]);
      assertEq(plan.counts.remove, 1, 'the deselected record comes out');
      await queue('Weekend picks', [alpha, bravo]);

      const removesBefore = fake.removes.length;
      const result = await reconcile();
      assertEq(result.grouped.updated, 1, `the collection was updated (got ${JSON.stringify(result.grouped)})`);
      assertEq(fake.removes.length, removesBefore + 1, 'exactly one remove request was sent');
      assertEq(fake.removes[fake.removes.length - 1]!.ids.join(','), 'jf-item-4', 'carrying only the deselected record\'s item');
      assertEq([...named('Weekend picks')!.ids].sort().join(','), 'jf-item-1,jf-item-2', 'and the other two are untouched');
      const rows = (await admin.query('SELECT count(*)::int AS n FROM managed_collection_members WHERE item_id = $1', [delta])).rows[0].n as number;
      assertEq(rows, 0, 'and the row that drove the removal is dropped only after the removal actually happened');
    });

    await test('a member listing that FAILS removes nothing at all', async () => {
      await queue('Weekend picks', [alpha, bravo, delta]);
      await reconcile();
      assertEq(named('Weekend picks')!.ids.length, 3, 'the collection holds three again');

      await queue('Weekend picks', [alpha, bravo]);
      const removesBefore = fake.removes.length;
      fake.breakMemberList = true;
      try {
        const result = await reconcile();
        assertEq(result.grouped.removed, 0, 'a pass that could not see the collection removes nothing');
        assertEq(result.grouped.deferred, 1, 'and defers rather than guessing');
        assertEq(fake.removes.length, removesBefore, 'no remove request was sent at all');
        assertEq(named('Weekend picks')!.ids.length, 3, 'and the collection is untouched');
      } finally {
        fake.breakMemberList = false;
      }
      const recovered = await reconcile();
      assertEq(recovered.grouped.removed, 1, 'a later pass completes the removal it refused to guess at');
      assertEq([...named('Weekend picks')!.ids].sort().join(','), 'jf-item-1,jf-item-2', 'leaving the right two');
    });

    await test('a resolution that FAILS adds what it knows and removes nothing', async () => {
      await queue('Weekend picks', [alpha]);
      const removesBefore = fake.removes.length;
      fake.breakCandidates = true;
      try {
        const result = await reconcile();
        assertEq(result.grouped.removed, 0, 'a pass that could not resolve the intended set removes nothing');
        assertEq(fake.removes.length, removesBefore, 'and sends no remove request');
      } finally {
        fake.breakCandidates = false;
      }
      const recovered = await reconcile();
      assertEq(recovered.grouped.removed, 1, 'and a working pass completes it');
      assertEq(named('Weekend picks')!.ids.join(','), 'jf-item-1', 'leaving only what was selected');

      // Put it back for the legs that follow.
      await queue('Weekend picks', [alpha, bravo]);
      await reconcile();
      assertEq([...named('Weekend picks')!.ids].sort().join(','), 'jf-item-1,jf-item-2', 'restored');
    });

    await test('a create whose response is LOST is adopted by token, without creating a duplicate', async () => {
      await queue('Lost response', [alpha]);

      fake.loseNextCreateResponse = true;
      const before = fake.collections.size;
      const first = await reconcile();
      assertEq(first.grouped.created, 0, 'the create returned nothing this process could settle');
      assertEq(fake.collections.size, before + 1, 'but the artifact EXISTS on the server');
      assertEq((await statusOf('Lost response'))?.handle, null, 'and this installation does not hold its handle');

      const second = await reconcile();
      assertEq(second.grouped.adopted, 1, `the second pass adopted it by its token (got ${JSON.stringify(second.grouped)})`);
      assertEq(second.grouped.created, 0, 'rather than creating a duplicate');
      assertEq(fake.collections.size, before + 1, 'and the server holds no second copy');
      const row = await statusOf('Lost response');
      assertEq(row?.status, 'published', 'the collection is settled');
      assert(row?.handle !== null, 'and this installation now holds its handle, so it is revocable');
    });

    await test('a lookup that FAILS creates nothing — "I could not see it" is not "it is not there"', async () => {
      await queue('Unreachable', [bravo]);
      const before = fake.collections.size;
      fake.breakLookup = true;
      try {
        const result = await reconcile();
        assertEq(result.grouped.created, 0, 'nothing was created while the lookup was failing');
        assert(result.grouped.deferred >= 1, 'the collection was deferred');
        assertEq(fake.collections.size, before, 'and the server is unchanged');
      } finally {
        fake.breakLookup = false;
      }
      const recovered = await reconcile();
      assertEq(recovered.grouped.created, 1, 'and a working pass creates it exactly once');
      assertEq(fake.collections.size, before + 1, 'adding exactly one collection');
    });

    await test('a restart resumes what did not finish, and duplicates nothing', async () => {
      await queue('Survives restart', [alpha]);
      const before = fake.collections.size;

      // The container dies before a reconcile ever runs.
      await closePool();
      pool = getPool();
      authority = new CatalogAuthority(pool, createCustodian(loadCustodianConfig()));

      const result = await reconcile();
      assertEq(result.grouped.created, 1, 'the durable collection survived and was carried out');
      assertEq(fake.collections.size, before + 1, 'creating exactly one collection');

      const again = await reconcile();
      assertEq(again.grouped.created, 0, 'and a further pass creates nothing');
      assertEq(fake.collections.size, before + 1, 'so a restart cannot duplicate');
    });

    await test('forgetting ONE member takes its library items out and leaves the collection standing', async () => {
      const target = named('Weekend picks')!;
      assertEq([...target.ids].sort().join(','), 'jf-item-1,jf-item-2', 'the collection holds both to begin with');

      // Bravo is forgotten. Its identity is unrecoverable from this moment on — so nothing in this product can
      // say WHICH library items came from it. The set difference is what takes them out.
      await authority.forget(bravo);
      assertEq(await authority.readIdentity(bravo), null, 'the record is no longer readable');

      const result = await revokePass();
      assert(result.grouped.forgotten >= 1, `the forgotten member was queued (got ${JSON.stringify(result.grouped)})`);
      assertEq(result.grouped.removed, 1, 'and exactly one library item came back out');
      assertEq(target.ids.join(','), 'jf-item-1', 'leaving the collection standing with the member that remains');
      assert(fake.collections.has(target.id), 'and the collection itself is still there');

      const rows = (await admin.query('SELECT count(*)::int AS n FROM managed_collection_members WHERE item_id = $1', [bravo])).rows[0].n as number;
      assertEq(rows, 0, 'and no durable row still associates the forgotten record with anything');
    });

    await test('forgetting the LAST member deletes the collection rather than leaving it empty', async () => {
      const target = named('Weekend picks')!;
      await authority.forget(alpha);

      const first = await revokePass();
      assert(first.grouped.queued >= 1 || first.grouped.revoked >= 1,
        `the emptied collection was queued or removed (got ${JSON.stringify(first.grouped)})`);
      // A second pass settles anything the first only queued.
      await revokePass();
      assert(!fake.collections.has(target.id), 'the emptied collection is gone from the server');
      assertEq((await statusOf('Weekend picks'))?.status, 'revoked', 'and its durable row records that');
    });

    await test('a delete that FAILS leaves the collection queued and retryable, never marked done', async () => {
      const fresh = `${JSON.stringify({
        format: 'catalog-authority.snapshot', version: 1, source: 'exec-library',
        items: [{ externalId: 'e-5', title: 'Executed Echo', providerRefs: [{ type: 'imdb', value: `${SECRET_REF}-5` }] }],
      }, null, 2)}\n`;
      await applyImport({ text: fresh, lookup: createExistingStateLookup(pool), authority, actor: 'cli', fileName: 'fresh.json' });
      fake.library[`imdb:${SECRET_REF}-5`] = 'jf-item-5';
      const echo = await idOf('Executed Echo');

      await queue('Doomed', [echo]);
      await reconcile();
      const created = named('Doomed');
      assert(created !== undefined, 'the collection was created');

      await queue('Doomed', null); // the operator asks for it to go
      fake.breakDelete = true;
      try {
        const result = await revokePass();
        assertEq(result.grouped.revoked, 0, 'nothing was reported as revoked');
        assert(result.grouped.failed >= 1, 'and the failure is reported');
        assert(fake.collections.has(created!.id), 'the external copy is still out there');
        assertEq((await statusOf('Doomed'))?.status, 'revoke_pending', 'and the row stays queued and retryable');
      } finally {
        fake.breakDelete = false;
      }
      const recovered = await revokePass();
      assertEq(recovered.grouped.revoked, 1, 'a working pass completes it');
      assert(!fake.collections.has(created!.id), 'and the external copy is gone');
      assertEq((await statusOf('Doomed'))?.status, 'revoked', 'and only then is it marked revoked');
    });

    await test('a v8 per-record row is still finished and still revoked, and never adopted into a group', async () => {
      const legacyRecord = `${JSON.stringify({
        format: 'catalog-authority.snapshot', version: 1, source: 'exec-library',
        items: [{ externalId: 'e-9', title: 'Legacy Record', providerRefs: [{ type: 'imdb', value: `${SECRET_REF}-9` }] }],
      }, null, 2)}\n`;
      await applyImport({ text: legacyRecord, lookup: createExistingStateLookup(pool), authority, actor: 'cli', fileName: 'legacy.json' });
      fake.library[`imdb:${SECRET_REF}-9`] = 'jf-item-9';
      const legacyItem = await idOf('Legacy Record');

      // Exactly what a pre-upgrade installation holds: an UNFINISHED per-item intent.
      await admin.query('SELECT cat_publish_plan($1, $2, $3, $4)',
        [legacyItem, 'jellyfin', 'legacy-token-9', ['title', 'providerRefs']]);

      const collectionsBefore = await collectionCount();
      const result = await reconcile();
      assertEq(result.legacy.created, 1, `the legacy intent was finished by the Phase 12 engine (got ${JSON.stringify(result.legacy)})`);
      assertEq(await collectionCount(), collectionsBefore, 'and no managed collection was invented for it');
      const legacyRow = (await admin.query("SELECT status, external_handle FROM publish_ledger WHERE correlation_token = 'legacy-token-9'")).rows[0];
      assertEq(legacyRow.status, 'published', 'the per-record row is settled');
      assert(String(legacyRow.external_handle).length > 0, 'and holds its own handle, so it is revocable on its own terms');
      // Its collection is named after the RECORD, as the legacy model always did — this phase did not change it.
      const legacyCollection = named('Legacy Record');
      assert(legacyCollection !== undefined, 'the legacy engine created its own per-record collection');

      // And forgetting that record still revokes it.
      await authority.forget(legacyItem);
      const revoked = await revokePass();
      assert(revoked.legacy.revoked >= 1, `the legacy copy was revoked (got ${JSON.stringify(revoked.legacy)})`);
      assert(!fake.collections.has(legacyCollection!.id), 'and it is gone from the server');
    });

    await test('the status surface reports the managed model and the legacy rows separately', async () => {
      const status = await readCollectionStatus(pool);
      assertEq(status.target, 'jellyfin', 'the target is named');
      assert(typeof status.counts.published === 'number', 'managed collections are counted by state');
      assert(typeof status.legacy.counts.published === 'number', 'and so are the legacy per-record rows');
      assert(Array.isArray(status.collections), 'the active collections are listed');
      const text = JSON.stringify(status);
      for (const forbidden of [SECRET_REF, 'jf-col-', 'jf-item-', 'Executed Alpha', 'legacy-token-9']) {
        assert(!text.includes(forbidden), `the status disclosed ${forbidden}`);
      }
      const served = await collectionStatusResponse(pool, env);
      assertEq(served.status, 200, 'the status route answers');
      assertEq(served.body.writesEnabled, true, 'and reports the gate verdict alongside the state');
    });

    await test('a reconcile or revoke with a closed gate refuses, having built no client', async () => {
      const closed = { ...env };
      delete closed.PUBLISH_EXTERNAL_IDENTITY;
      const before = fake.creates.length;
      for (const handler of [collectionReconcileResponse, collectionRevokeResponse]) {
        const result = await handler({ pool, authority, fetch: realFetch, env: closed, history: history() });
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
        const before = await collectionCount();
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
          assertEq(huge.body.code, 'OPERATOR_UI_COLLECTION_TOO_LARGE', `${route} says the body was too large`);
        }
        for (const route of [COLLECTIONS_STATUS_ROUTE, '/api/collections/history']) {
          assertEq((await live(route)).status, 401, `${route} refuses an unauthenticated read`);
          assertEq((await live(route, { token: TOKEN, method: 'POST', body: '{}' })).status, 405, `${route} refuses a POST`);
        }
        assertEq(await collectionCount(), before, 'and not one refusal recorded a collection');
      } finally {
        await new Promise<void>((resolve) => { server.close(() => resolve()); });
      }
    });

    await test('a browsing session over the real routes writes no row, no event and no collection', async () => {
      const config = validateOperatorUiServiceConfig({ port: 8099, operatorSecretFile: TOKEN_FILE, promotionRecordsDir: WORK });
      const port = await freePort();
      const server = createOperatorUiServiceServer(config, loadOperatorUiLocalAuthRuntime(TOKEN_FILE));
      await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', resolve); });
      const live = caller(port);
      const snapshot = async (): Promise<string> => JSON.stringify({
        items: (await admin.query('SELECT count(*)::int AS n FROM items')).rows[0].n,
        events: (await admin.query('SELECT count(*)::int AS n FROM events')).rows[0].n,
        ledger: (await admin.query('SELECT count(*)::int AS n FROM publish_ledger')).rows[0].n,
        collections: (await admin.query('SELECT count(*)::int AS n FROM managed_collections')).rows[0].n,
        members: (await admin.query('SELECT count(*)::int AS n FROM managed_collection_members')).rows[0].n,
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
      for (const forbidden of [SECRET_REF, API_KEY, TOKEN, KEY_FILE, 'jf-col-', 'jf-item-', fake.baseUrl, 'legacy-token-9']) {
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
      for (const file of ['jellyfin-control-plane.ts', 'collection-plan-preview.ts', 'collection-execution.ts',
        'collection-drift.ts', 'collection-cli.ts']) {
        assert(inventory.suites.some((s) => s.file === file), `${file} is in the aggregate inventory`);
      }
      const doc = readRepo('docs/PHASE_269_272_COLLECTION_LIFECYCLE.md');
      assert(doc.includes('one collection'), 'the document explains the grouped model');
      assert(doc.includes('set difference'), 'and how membership is reconciled');
      assert(doc.includes('schema v9'), 'and the migration it introduced');
    });

    await fake.close();
    await closePool();
    await admin.end();
    // Let pg deliver the socket-close events caused by Pool.end() before the embedded server is stopped.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (pg !== undefined) await pg.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
  try { rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(failed === 0 ? 0 : 1);
}

void main();
