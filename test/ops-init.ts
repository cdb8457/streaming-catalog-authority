import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { runDoctor, type DoctorReport } from '../src/ops/doctor.js';
import { restorePreflight } from '../src/ops/backup-ops.js';
import { getPool, migrate, adminUrl, closePool } from '../src/db/pool.js';
import { testKek } from './crypto-setup.js';

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
  try { await fn(); } catch (e) { if (match && !match.test((e as Error).message)) throw new Error(`threw ${JSON.stringify((e as Error).message)} != ${match} (${msg})`); return; }
  throw new Error(`expected to throw: ${msg}`);
}
const state = (r: DoctorReport, name: string): string => r.checks.find((c) => c.name === name)?.state ?? 'absent';
const tmpDirs: string[] = [];
const freshKeystore = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'init-')); tmpDirs.push(d); return d; };

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) { console.log('Booting embedded PostgreSQL 16 ...'); server = await startEmbedded(); }
  await migrate();
  const pool = getPool(); // app (least-privileged) role
  const admin = new Client({ connectionString: adminUrl() }); // owner
  await admin.connect();
  const kek = testKek();
  const dbSecret = async (): Promise<string> => (await admin.query('SELECT completion_secret FROM crypto_config WHERE id=1')).rows[0].completion_secret as string;

  console.log('Running Phase 5 ops:init + set_completion_secret suite (Stage 5.2):\n');

  // 1. owner can set/rotate the secret -----------------------------------------
  await test('set_completion_secret — owner sets and rotates crypto_config (id=1 only)', async () => {
    await admin.query('SELECT set_completion_secret($1)', ['secret-one']);
    assertEq(await dbSecret(), 'secret-one', 'set to secret-one');
    await admin.query('SELECT set_completion_secret($1)', ['secret-two']);
    assertEq(await dbSecret(), 'secret-two', 'rotated to secret-two');
  });

  // 2. non-empty validation ----------------------------------------------------
  await test('set_completion_secret — rejects empty / whitespace-only input', async () => {
    await assertThrows(() => admin.query('SELECT set_completion_secret($1)', ['']), 'empty rejected', /non-empty/i);
    await assertThrows(() => admin.query('SELECT set_completion_secret($1)', ['   ']), 'whitespace rejected', /non-empty/i);
    assertEq(await dbSecret(), 'secret-two', 'value unchanged after rejected inputs');
  });

  // 3. PRIVILEGE: the app role cannot execute it, nor read crypto_config -------
  await test('set_completion_secret — app role EXECUTE denied; app cannot read crypto_config', async () => {
    await assertThrows(() => pool.query('SELECT set_completion_secret($1)', ['app-attempt']), 'app EXECUTE denied', /permission denied/i);
    await assertThrows(() => pool.query('SELECT completion_secret FROM crypto_config'), 'app read denied', /permission denied/i);
    assertEq(await dbSecret(), 'secret-two', 'app could not change the secret');
    // privilege introspection matches
    const r = (await admin.query(
      `SELECT has_function_privilege('app','public.set_completion_secret(text)','EXECUTE') AS exec,
              has_table_privilege('app','public.crypto_config','SELECT') AS read`,
    )).rows[0] as { exec: boolean; read: boolean };
    assert(!r.exec && !r.read, 'app has neither EXECUTE nor crypto_config SELECT');
  });

  // 4. doctor + restore preflight observe the updated value --------------------
  await test('set_completion_secret — doctor and restore-preflight observe the rotated value', async () => {
    await admin.query('SELECT set_completion_secret($1)', ['live-secret']);
    const dir = freshKeystore();
    const custodian = new FileCustodian(dir, 'live-secret', kek);

    const okReport = await runDoctor({ admin, pool, custodian, completionSecret: 'live-secret', custodianMode: 'file', appEnv: 'development', keystoreDir: dir });
    assertEq(state(okReport, 'completion-secret'), 'pass', 'doctor sees the matching rotated secret');
    assertEq(state(okReport, 'app-cannot-touch-secret'), 'pass', 'app cannot read/set the secret');
    assertEq(state(okReport, 'schema-migrated'), 'pass', 'set_completion_secret counted in schema check');

    const pf = await restorePreflight({ admin, custodian, completionSecret: 'live-secret' });
    assertEq(pf.checks.completionSecret, 'pass', 'restore preflight sees the rotated secret');

    const badReport = await runDoctor({ admin, pool, custodian, completionSecret: 'stale-secret', custodianMode: 'file', appEnv: 'development', keystoreDir: dir });
    assertEq(state(badReport, 'completion-secret'), 'fail', 'doctor fails on a stale configured secret');
    const badPf = await restorePreflight({ admin, custodian: new FileCustodian(freshKeystore(), 'stale-secret', kek), completionSecret: 'stale-secret' });
    assertEq(badPf.checks.completionSecret, 'fail', 'restore preflight fails on a stale secret');
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
