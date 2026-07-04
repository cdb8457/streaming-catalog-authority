import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { createAdapter } from '../src/core/adapters/adapter-factory.js';
import { resolveProviderAvailability } from '../src/core/adapters/provider-availability-bridge.js';
import type { TorBoxTransport, TorBoxTransportRequest, TorBoxTransportResponse } from '../src/core/adapters/torbox-real-client-gate.js';
import { getPool, migrate, adminUrl, closePool } from '../src/db/pool.js';
import { installCompletionSecret, testKek } from './crypto-setup.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }

class RecordingTorBoxTransport implements TorBoxTransport {
  readonly requests: TorBoxTransportRequest[] = [];
  constructor(private readonly response: TorBoxTransportResponse = { status: 200, body: { availability: 'available' } }) {}

  async request(request: TorBoxTransportRequest): Promise<TorBoxTransportResponse> {
    this.requests.push(request);
    return this.response;
  }
}

const tmpDirs: string[] = [];
const freshKeystore = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'torbox-catalog-bridge-'));
  tmpDirs.push(dir);
  return dir;
};

const TITLE = 'TORBOX-BRIDGE-TITLE-DO-NOT-LEAK';
const EXT_ID = 'tt-torbox-bridge-secret';
const HASH = '0123456789abcdef0123456789abcdef01234567';

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) { console.log('Booting embedded PostgreSQL 16 ...'); server = await startEmbedded(); }
  await migrate();
  const pool = getPool();
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  const secret = await installCompletionSecret(admin);
  const auth = new CatalogAuthority(pool, new FileCustodian(freshKeystore(), secret, testKek()));
  const count = async (table: 'events' | 'provider_refs'): Promise<number> => Number((await pool.query(`SELECT count(*) AS c FROM ${table}`)).rows[0].c);

  console.log('Running Phase 47 TorBox catalog bridge suite:\n');

  await test('withProviderRef drives TorBox adapter through encrypted scoped ref only', async () => {
    const id = mintItemId();
    await auth.addItem(id, {
      title: TITLE,
      year: 2026,
      externalIds: { imdb: EXT_ID },
      providerRefs: [{ type: 'infohash', value: HASH }],
    });
    const eventsBefore = await count('events');
    const refsBefore = await count('provider_refs');
    const transport = new RecordingTorBoxTransport();
    const adapter = createAdapter({ mode: 'torbox-readonly', transport, timeoutMs: 3000 });
    if (adapter === null) throw new Error('torbox adapter created');

    const logs: string[] = [];
    const result = await auth.withProviderRef(id, 'infohash', async (view) => {
      const log = auth.createLogger((line) => logs.push(line));
      log.info(`operator bridge resolving ${view.refValue}`);
      return resolveProviderAvailability(adapter, view, { log: (line) => log.info(line) });
    });

    if (result === null) throw new Error('bridge returned a policy report');
    assertEq(result.adapterStatus, 'available', 'available advisory result');
    assertEq(result.decision.action, 'candidate', 'available candidate decision');
    assertEq(result.decision.persisted, false, 'policy decision is not persisted');
    assertEq(result.echoesAdapterLocator, false, 'bridge does not echo locator');
    assertEq(result.echoesAdapterDetail, false, 'bridge does not echo detail');
    assertEq(transport.requests.length, 1, 'one TorBox transport request');
    assertEq(transport.requests[0]!.operation, 'torrent-cache-check', 'infohash mapped to torrent cache check');
    assertEq(transport.requests[0]!.method, 'GET', 'GET only');
    assertEq(transport.requests[0]!.scopedRef?.refType, 'infohash', 'transport receives scoped ref type');
    assertEq(transport.requests[0]!.scopedRef?.refValue, HASH, 'transport receives scoped ref value');
    assertEq(await count('events'), eventsBefore, 'advisory bridge writes no events');
    assertEq(await count('provider_refs'), refsBefore, 'advisory bridge writes no provider refs');
    assertEq(auth.secrets.size(), 0, 'scoped ref registration cleared after bridge');

    const publicText = JSON.stringify({ result, logs });
    for (const forbidden of [HASH, TITLE, EXT_ID, 'provider response', 'request-download-link', 'cdn-url', 'playback']) {
      assert(!publicText.includes(forbidden), `public bridge output excludes ${forbidden}`);
    }
  });

  await test('unsupported ref types and missing refs fail closed before TorBox transport', async () => {
    const id = mintItemId();
    await auth.addItem(id, { title: 'No TorBox Ref', providerRefs: [{ type: 'tmdb', value: '12345' }] });
    const transport = new RecordingTorBoxTransport();
    const adapter = createAdapter({ mode: 'torbox-readonly', transport });
    if (adapter === null) throw new Error('torbox adapter created');

    const missing = await auth.withProviderRef(id, 'infohash', (view) => adapter.resolveRef(view));
    const unsupported = await auth.withProviderRef(id, 'tmdb', (view) => resolveProviderAvailability(adapter, view));

    assertEq(missing, null, 'missing TorBox ref returns null before adapter call');
    assert(unsupported !== null && unsupported.adapterStatus === 'unknown', 'unsupported ref fails closed to unknown');
    assertEq(unsupported?.decision.action, 'hold', 'unsupported policy holds');
    assertEq(transport.requests.length, 0, 'no transport requests for missing or unsupported refs');
    assertEq(auth.secrets.size(), 0, 'no lingering registrations after fail-closed paths');
  });

  await test('TorBox bridge preserves future-gated download/playback boundaries', async () => {
    const id = mintItemId();
    await auth.addItem(id, { title: 'Future Gated', providerRefs: [{ type: 'infohash', value: HASH }] });
    const transport = new RecordingTorBoxTransport({ status: 200, body: { availability: 'unavailable' } });
    const adapter = createAdapter({ mode: 'torbox-readonly', transport });
    if (adapter === null) throw new Error('torbox adapter created');

    const result = await auth.withProviderRef(id, 'infohash', (view) => resolveProviderAvailability(adapter, view));

    if (result === null) throw new Error('bridge returned a policy report');
    assertEq(result.adapterStatus, 'unavailable', 'unavailable advisory result');
    assertEq(result.decision.action, 'skip', 'unavailable policy skips');
    assertEq(transport.requests[0]!.operation, 'torrent-cache-check', 'torrent cache check only');
    const publicText = JSON.stringify({ result, request: { operation: transport.requests[0]!.operation, method: transport.requests[0]!.method } });
    for (const forbidden of ['create-download', 'request-download-link', 'request-permalink', 'cdn-url', 'playback']) {
      assert(!publicText.includes(forbidden), `bridge output excludes ${forbidden}`);
    }
  });

  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  await admin.end();
  await closePool();
  if (server) await server.stop();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
