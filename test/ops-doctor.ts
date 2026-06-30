import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { InMemoryCustodian, CustodianTransportError } from '../src/core/crypto/custodian.js';
import { runDoctor, formatDoctorReport, type DoctorReport } from '../src/ops/doctor.js';
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
const state = (r: DoctorReport, name: string): string => r.checks.find((c) => c.name === name)?.state ?? 'absent';
const tmpDirs: string[] = [];
const freshKeystore = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'doctor-')); tmpDirs.push(d); return d; };

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) { console.log('Booting embedded PostgreSQL 16 ...'); server = await startEmbedded(); }
  await migrate();
  const pool = getPool();
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  const secret = await installCompletionSecret(admin);
  const kek = testKek();
  const count = async (sql: string): Promise<number> => Number((await pool.query(sql)).rows[0].c);

  console.log('Running Phase 5 ops:doctor suite (Stage 5.1):\n');

  // 1. healthy deployment -> all green ----------------------------------------
  await test('doctor — healthy deployment passes every check', async () => {
    const dir = freshKeystore();
    const r = await runDoctor({ admin, pool, custodian: new FileCustodian(dir, secret, kek), completionSecret: secret, custodianMode: 'file', appEnv: 'production', keystoreDir: dir });
    assert(r.ok, `doctor ok (states: ${r.checks.map((c) => `${c.name}=${c.state}`).join(', ')})`);
    assertEq(state(r, 'db-owner-reachable'), 'pass', 'owner ok');
    assertEq(state(r, 'db-app-reachable'), 'pass', 'app ok');
    assertEq(state(r, 'schema-migrated'), 'pass', 'schema ok');
    assertEq(state(r, 'app-least-privileged'), 'pass', 'app least-priv');
    assertEq(state(r, 'app-cannot-read-secret'), 'pass', 'secret not app-readable');
    assertEq(state(r, 'completion-secret'), 'pass', 'secret matches');
    assertEq(state(r, 'custodian-reachable'), 'pass', 'custodian ok');
    assertEq(state(r, 'keystore'), 'pass', 'keystore ok');
  });

  // 2. completion-secret mismatch -> fail, redaction-safe ---------------------
  await test('doctor — secret mismatch fails; report never leaks the secret', async () => {
    const dir = freshKeystore();
    const wrong = 'DOCTOR-WRONG-SECRET';
    const r = await runDoctor({ admin, pool, custodian: new FileCustodian(dir, wrong, kek), completionSecret: wrong, custodianMode: 'file', appEnv: 'production', keystoreDir: dir });
    assert(!r.ok, 'not ok');
    assertEq(state(r, 'completion-secret'), 'fail', 'secret mismatch fail');
    const text = formatDoctorReport(r);
    assert(!text.includes(wrong) && !text.includes(secret), 'no secret value in the report');
  });

  // 3. custodian unreachable -> fail ------------------------------------------
  await test('doctor — unreachable custodian fails', async () => {
    const c = new InMemoryCustodian(secret);
    c.setFault('status', new CustodianTransportError('status'));
    const r = await runDoctor({ admin, pool, custodian: c, completionSecret: secret, custodianMode: 'memory', appEnv: 'development' });
    assert(!r.ok, 'not ok');
    assertEq(state(r, 'custodian-reachable'), 'fail', 'custodian unreachable fail');
  });

  // 4. memory custodian in production -> fail ---------------------------------
  await test('doctor — memory custodian in production fails the durability check', async () => {
    const r = await runDoctor({ admin, pool, custodian: new InMemoryCustodian(secret), completionSecret: secret, custodianMode: 'memory', appEnv: 'production' });
    assertEq(state(r, 'custodian-durability'), 'fail', 'memory-in-prod fail');
    assert(!r.ok, 'overall fail');
  });

  // 5. doctor is READ-ONLY -----------------------------------------------------
  await test('doctor — is read-only (no DB mutation)', async () => {
    await admin.query("SET session_replication_role = 'replica'");
    await admin.query('TRUNCATE events, provider_refs, items, item_key_control, aborted_operations RESTART IDENTITY CASCADE');
    await admin.query("SET session_replication_role = 'origin'");
    const dir = freshKeystore();
    const auth = new CatalogAuthority(pool, new FileCustodian(dir, secret, kek));
    await auth.addItem(mintItemId(), { title: 'doctor-readonly' });
    const evBefore = await count('SELECT count(*) AS c FROM events');
    const itBefore = await count('SELECT count(*) AS c FROM items');
    await runDoctor({ admin, pool, custodian: new FileCustodian(dir, secret, kek), completionSecret: secret, custodianMode: 'file', appEnv: 'production', keystoreDir: dir });
    assertEq(await count('SELECT count(*) AS c FROM events'), evBefore, 'events unchanged');
    assertEq(await count('SELECT count(*) AS c FROM items'), itBefore, 'items unchanged');
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
