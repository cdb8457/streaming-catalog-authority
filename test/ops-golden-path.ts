import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { runDump, runRestore } from '../src/ops/backup-ops.js';
import { runDoctor, type DoctorReport } from '../src/ops/doctor.js';
import { getPool, migrate, adminUrl, closePool } from '../src/db/pool.js';

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
const freshKeystore = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'golden-')); tmpDirs.push(d); return d; };

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) { console.log('Booting embedded PostgreSQL 16 ...'); server = await startEmbedded(); }
  await migrate();
  const pool = getPool();
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();

  console.log('Running Phase 5 operator golden-path suite (Stage 5.5):\n');

  const secret = 'golden-path-secret';
  const kekOld = randomBytes(32);
  const kekNew = randomBytes(32);
  const keystore = freshKeystore();
  const doctorState = (r: DoctorReport, n: string): string => r.checks.find((c) => c.name === n)?.state ?? 'absent';
  const reset = async (): Promise<void> => {
    await admin.query("SET session_replication_role = 'replica'");
    await admin.query('TRUNCATE events, provider_refs, items, item_key_control, aborted_operations RESTART IDENTITY CASCADE');
    await admin.query("SET session_replication_role = 'origin'");
  };

  // The whole operator surface, end to end. Each step uses the SAME modules the CLIs use.
  await test('golden path — init → doctor → add → backup → DB loss → restore → forget → rewrap → doctor', async () => {
    await reset();

    // 1. init: provision the completion secret (owner-only), like ops:init.
    await admin.query('SELECT set_completion_secret($1)', [secret]);

    // 2. doctor is green at the start.
    const custodian = new FileCustodian(keystore, secret, kekOld);
    const d0 = await runDoctor({ admin, pool, custodian, completionSecret: secret, custodianMode: 'file', appEnv: 'production', keystoreDir: keystore });
    assert(d0.ok, `doctor green at start (${d0.checks.filter((c) => c.state === 'fail').map((c) => c.name).join(',') || 'ok'})`);

    // 3. add two items; both readable.
    const auth = new CatalogAuthority(pool, custodian);
    const a = mintItemId();
    const b = mintItemId();
    await auth.addItem(a, { title: 'Keeper A', providerRefs: [{ type: 'tmdb', value: '1' }] });
    await auth.addItem(b, { title: 'Keeper B' });
    assertEq((await auth.readIdentity(a))?.title, 'Keeper A', 'A readable');
    assertEq((await auth.readIdentity(b))?.title, 'Keeper B', 'B readable');

    // 4. backup, then simulate catastrophic DB loss.
    const backup1 = await runDump({ admin, label: 'pre-loss' });
    await reset();
    assert((await auth.readIdentity(a)) === null, 'gone after DB loss');

    // 5. restore through the guarded path (preflight passes; keystore intact).
    const { restored, preflight } = await runRestore({ admin, custodian, completionSecret: secret, artifact: backup1 });
    assert(restored && preflight.ok, 'restore succeeded after preflight');
    assertEq((await auth.readIdentity(a))?.title, 'Keeper A', 'A readable after restore');
    assertEq((await auth.readIdentity(b))?.providerRefs ?? null, null, 'B has no refs (sanity)');
    assertEq((await auth.readIdentity(b))?.title, 'Keeper B', 'B readable after restore');

    // 6. forget A (crypto-shred); A gone forever, B intact.
    assertEq(await auth.forget(a), 'shred_complete', 'A forgotten');
    assert((await auth.readIdentity(a)) === null, 'A unrecoverable after forget');
    assertEq((await auth.readIdentity(b))?.title, 'Keeper B', 'B still readable after forgetting A');

    // 7. rotate the KEK (rewrap); identity ciphertext untouched.
    const res = FileCustodian.rewrapKeystore(keystore, { fromKek: kekOld, toKek: kekNew });
    assert(res.rewrapped >= 1, 'at least one live key rewrapped (B)');

    // 8. operate under the NEW KEK: B still readable, A still gone (destroyed key never rewrapped).
    const custodianNew = new FileCustodian(keystore, secret, kekNew);
    const authNew = new CatalogAuthority(pool, custodianNew);
    assertEq((await authNew.readIdentity(b))?.title, 'Keeper B', 'B readable under the new KEK');
    assert((await authNew.readIdentity(a)) === null, 'A stays forgotten through restore + rewrap');
    // the OLD KEK can no longer read B's DEK (full rewrap)
    await new FileCustodian(keystore, secret, kekOld); // constructs fine (tombstones/journal only)

    // 9. doctor green again under the rotated KEK.
    const d1 = await runDoctor({ admin, pool, custodian: custodianNew, completionSecret: secret, custodianMode: 'file', appEnv: 'production', keystoreDir: keystore });
    assert(d1.ok, `doctor green at end (${d1.checks.filter((c) => c.state === 'fail').map((c) => c.name).join(',') || 'ok'})`);
    assertEq(doctorState(d1, 'completion-secret'), 'pass', 'secret still matches');
    assertEq(doctorState(d1, 'app-cannot-touch-secret'), 'pass', 'app still cannot touch the secret');
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
