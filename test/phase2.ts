import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { SecretStore } from '../src/core/secrets/secret-store.js';
import { createRedactingLogger } from '../src/core/redaction/logger.js';
import { getPool, migrate, closePool } from '../src/db/pool.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    failures.push([name, err]);
    console.log(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) {
    console.log('Booting embedded PostgreSQL 16 ...');
    server = await startEmbedded();
  } else {
    console.log('Using external DATABASE_URL.');
  }
  await migrate();
  const pool = getPool();
  const auth = new CatalogAuthority();

  console.log('Running Phase 2 (SecretStore + log redaction) suite:\n');

  // 1. SecretStore round-trips a secret, but redact() masks it -----------------
  await test('SecretStore — secret round-trips for runtime use but redact() masks it', () => {
    const store = new SecretStore();
    const secret = 'rd_live_2f7c9a1b8e4d6f30c5a2'; // api-key shaped
    store.set('rd_api_key', secret);
    assert(store.get('rd_api_key') === secret, 'get() returns the secret for runtime use');
    const red = store.redact(`calling provider with key ${secret}`);
    assert(!red.includes(secret), 'redact() must mask the secret');
    assert(/\[redacted/.test(red), 'redact() leaves a marker');
  });

  // 2. Redacting logger scrubs signature-shaped secrets ------------------------
  await test('logger — redacts URLs / magnets / hashes / tokens by signature', () => {
    const lines: string[] = [];
    const log = createRedactingLogger(new SecretStore(), (l) => lines.push(l));
    log.info('fetch https://tracker.example/announce?passkey=abc');
    log.warn('magnet:?xt=urn:btih:deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    log.error('Authorization: Bearer abcdef0123456789abcdef');
    const blob = lines.join('\n');
    assert(!/https:\/\//.test(blob), 'url masked');
    assert(!/magnet:\?/.test(blob), 'magnet masked');
    assert(!/deadbeef/.test(blob), 'infohash value masked'); // the value, not the "btih" label
    assert(!/Bearer abcdef/.test(blob), 'bearer masked');
    assert(/\[redacted/.test(blob), 'markers present');
  });

  // 3. Registered signature-free secret is still masked ------------------------
  await test('logger — masks a registered secret literal even with no signature', () => {
    const store = new SecretStore();
    const secret = 'plainishtokenwithnosignature';
    store.set('opaque', secret);
    const lines: string[] = [];
    const log = createRedactingLogger(store, (l) => lines.push(l));
    log.info(`used token ${secret} for request`);
    assert(!lines.join('\n').includes(secret), 'registered secret literal masked');
  });

  // 4. A secret never reaches the durable store (no DB row holds it) -----------
  await test('SecretStore — a held secret never appears in events or the projection', async () => {
    const store = new SecretStore();
    const secret = 'sk_live_888marker_neverpersist';
    store.set('provider', secret);
    // normal catalog activity that does NOT involve the secret
    const id = mintItemId();
    await auth.addItem(id, { title: 'A Movie', year: 2024, providerRefs: [{ type: 'tmdb', value: '42' }] });
    await auth.recordSignal(id, 3, 60_000);
    // scan the entire durable store for the secret literal
    const evt = await pool.query(`SELECT count(*)::int AS c FROM events WHERE payload::text LIKE '%' || $1 || '%'`, [secret]);
    const itm = await pool.query(
      `SELECT count(*)::int AS c FROM items WHERE coalesce(title,'')||coalesce(external_ids::text,'')||coalesce(metadata::text,'') LIKE '%' || $1 || '%'`,
      [secret],
    );
    assert(evt.rows[0].c === 0, 'secret not in any event payload');
    assert(itm.rows[0].c === 0, 'secret not in any item row');
  });

  await closePool();
  if (server) await server.stop();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
