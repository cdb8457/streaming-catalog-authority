import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { runDoctor, type DoctorReport } from '../src/ops/doctor.js';
import { MIGRATION_VERSION } from '../src/db/schema-version.js';
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
async function assertThrows(fn: () => Promise<unknown>, msg: string, match?: RegExp): Promise<void> {
  try { await fn(); } catch (e) { if (match && !match.test((e as Error).message)) throw new Error(`threw ${JSON.stringify((e as Error).message)} != ${match}`); return; }
  throw new Error(`expected to throw: ${msg}`);
}
const state = (r: DoctorReport, n: string): string => r.checks.find((c) => c.name === n)?.state ?? 'absent';
const tmpDirs: string[] = [];
const freshKeystore = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'sv-')); tmpDirs.push(d); return d; };

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) { console.log('Booting embedded PostgreSQL 16 ...'); server = await startEmbedded(); }
  await migrate();
  const pool = getPool();
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  const secret = await installCompletionSecret(admin);
  const kek = testKek();
  const dbVersion = async (): Promise<number> => Number((await admin.query('SELECT version FROM schema_meta WHERE id=1')).rows[0].version);
  const doctor = async (): Promise<DoctorReport> => {
    const dir = freshKeystore();
    return runDoctor({ admin, pool, custodian: new FileCustodian(dir, secret, kek), completionSecret: secret, custodianMode: 'file', appEnv: 'production', keystoreDir: dir });
  };

  console.log('Running Phase 6 schema-version suite (Stage 6.1):\n');

  // 1. migrate records the current version ------------------------------------
  await test('migrate — schema_meta.version equals MIGRATION_VERSION', async () => {
    assertEq(await dbVersion(), MIGRATION_VERSION, 'db version matches the build constant');
  });

  // 2. doctor passes the version check ----------------------------------------
  await test('doctor — schema-version passes when db == expected', async () => {
    assertEq(state(await doctor(), 'schema-version'), 'pass', 'schema-version pass');
  });

  // 3. doctor FAILS on a version mismatch -------------------------------------
  await test('doctor — schema-version FAILS on a mismatch (run ops:migrate)', async () => {
    await admin.query('SELECT set_schema_version($1)', [MIGRATION_VERSION + 999]);
    const r = await doctor();
    assertEq(state(r, 'schema-version'), 'fail', 'mismatch fails');
    assert(!r.ok, 'overall fail on version mismatch');
    await admin.query('SELECT set_schema_version($1)', [MIGRATION_VERSION]); // restore
    assertEq(state(await doctor(), 'schema-version'), 'pass', 'pass again after re-migrate');
  });

  // 4. PRIVILEGE: app cannot set the version, nor read schema_meta ------------
  await test('set_schema_version — app EXECUTE denied; app cannot read schema_meta', async () => {
    await assertThrows(() => pool.query('SELECT set_schema_version($1)', [7]), 'app EXECUTE denied', /permission denied/i);
    await assertThrows(() => pool.query('SELECT version FROM schema_meta'), 'app read denied', /permission denied/i);
    assertEq(await dbVersion(), MIGRATION_VERSION, 'version unchanged by app');
    const r = (await admin.query(
      `SELECT has_function_privilege('app','public.set_schema_version(integer)','EXECUTE') AS exec,
              has_table_privilege('app','public.schema_meta','SELECT') AS read`,
    )).rows[0] as { exec: boolean; read: boolean };
    assert(!r.exec && !r.read, 'app has neither EXECUTE nor schema_meta SELECT');
  });

  // 5. non-negative validation -------------------------------------------------
  await test('set_schema_version — rejects a negative version', async () => {
    await assertThrows(() => admin.query('SELECT set_schema_version($1)', [-1]), 'negative rejected', /non-negative/i);
    assertEq(await dbVersion(), MIGRATION_VERSION, 'unchanged after rejected input');
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
