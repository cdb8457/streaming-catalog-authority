import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { FakeProviderAdapter } from '../src/core/adapters/fake-adapter.js';
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
const tmpDirs: string[] = [];
const freshKeystore = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'adapter-')); tmpDirs.push(d); return d; };

const TITLE = 'SECRET-TITLE-do-not-leak';
const HASH = 'HASHVALUE-123-scoped';

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) { console.log('Booting embedded PostgreSQL 16 ...'); server = await startEmbedded(); }
  await migrate();
  const pool = getPool();
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  const secret = await installCompletionSecret(admin);
  const kek = testKek();
  const auth = new CatalogAuthority(pool, new FileCustodian(freshKeystore(), secret, kek));
  const count = async (sql: string): Promise<number> => Number((await pool.query(sql)).rows[0].c);

  const id = mintItemId();
  await auth.addItem(id, { title: TITLE, year: 2024, externalIds: { imdb: 'tt-secret' }, providerRefs: [{ type: 'infohash', value: HASH }] });

  console.log('Running Phase 7 adapter privacy suite (Stage 7.4):\n');

  // 1. the view carries ONLY { itemId, refType, refValue } — never identity ----
  await test('withProviderRef — yields exactly { itemId, refType, refValue }; no identity', async () => {
    const v = await auth.withProviderRef(id, 'infohash', (view) => view);
    assert(v !== null, 'ref disclosed');
    assertEq(Object.keys(v!).sort().join(','), 'itemId,refType,refValue', 'exactly the three keys');
    assertEq(v!.itemId, id, 'opaque item id'); assertEq(v!.refType, 'infohash', 'ref type'); assertEq(v!.refValue, HASH, 'scoped ref value');
    assert(!JSON.stringify(v).includes(TITLE), 'no identity title in the view');
    assert(!JSON.stringify(v).includes('tt-secret'), 'no external id in the view');
  });

  // 2. the disclosed value is registered for redaction during the scope, cleared after
  await test('withProviderRef — scoped value is registered in SecretStore during the scope + cleared', async () => {
    assertEq(auth.secrets.size(), 0, 'no registrations before');
    let inside = -1;
    await auth.withProviderRef(id, 'infohash', () => { inside = auth.secrets.size(); });
    assert(inside >= 1, 'the ref value is registered during the scope');
    assertEq(auth.secrets.size(), 0, 'registrations cleared after the scope');
  });

  // 3. logging the ref value inside the scope is redacted -----------------------
  await test('withProviderRef — the scoped ref value is redacted in logs', async () => {
    await auth.withProviderRef(id, 'infohash', (view) => {
      const lines: string[] = [];
      const log = auth.createLogger((l) => lines.push(l));
      log.info(`resolving ${view.refValue}`);
      log.info(JSON.stringify({ ref: view.refValue }));
      const blob = lines.join('\n');
      assert(!blob.includes(HASH), 'raw ref value masked in logs');
    });
  });

  // 4. a curious adapter sees no identity; output is advisory; nothing persisted
  await test('withProviderRef — adapter sees only the scoped view; output advisory; no DB write', async () => {
    const adapter = new FakeProviderAdapter(new Set([HASH]));
    const evBefore = await count('SELECT count(*) AS c FROM events');
    const refBefore = await count('SELECT count(*) AS c FROM provider_refs');
    const result = await auth.withProviderRef(id, 'infohash', (view) => adapter.resolveRef(view));
    assert(result !== null && result.status === 'available', 'advisory result: available');
    assertEq(adapter.seen.length, 1, 'adapter invoked once');
    assertEq(Object.keys(adapter.seen[0]!).sort().join(','), 'itemId,refType,refValue', 'adapter saw only the three keys');
    assert(!JSON.stringify(adapter.seen).includes(TITLE) && !JSON.stringify(adapter.seen).includes('tt-secret'), 'adapter never saw identity');
    assertEq(adapter.observed[0], JSON.stringify({ viewKeys: ['itemId', 'refType', 'refValue'], ctxKeys: [] }), 'adapter observed only the view keys');
    assertEq(await count('SELECT count(*) AS c FROM events'), evBefore, 'adapter path wrote no events (advisory)');
    assertEq(await count('SELECT count(*) AS c FROM provider_refs'), refBefore, 'adapter path wrote no provider_refs');
  });

  // 5. fail-closed: forgotten item + missing ref both return null --------------
  await test('withProviderRef — fail-closed on a forgotten item and on a missing ref', async () => {
    const gone = mintItemId();
    await auth.addItem(gone, { title: 't', providerRefs: [{ type: 'infohash', value: 'z' }] });
    await auth.forget(gone);
    assertEq(await auth.withProviderRef(gone, 'infohash', () => 'called'), null, 'forgotten item -> null');
    assertEq(await auth.withProviderRef(id, 'tmdb', () => 'called'), null, 'missing ref type -> null');
    assertEq(auth.secrets.size(), 0, 'no lingering registrations after fail-closed paths');
  });

  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
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
