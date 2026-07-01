import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { BackupPolicy } from '../src/core/backup/backup-policy.js';
import { runRehearsal, RehearsalRefused, dbKey } from '../src/ops/rehearse.js';
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
async function assertRefused(fn: () => Promise<unknown>, msg: string): Promise<void> {
  try { await fn(); } catch (e) { if (e instanceof RehearsalRefused) return; throw new Error(`threw wrong error (${(e as Error).name}) for: ${msg}`); }
  throw new Error(`expected RehearsalRefused: ${msg}`);
}
const tmpDirs: string[] = [];
const freshKeystore = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'rehearse-')); tmpDirs.push(d); return d; };

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) { console.log('Booting embedded PostgreSQL 16 ...'); server = await startEmbedded(); }
  await migrate();
  const pool = getPool();
  const admin = new Client({ connectionString: adminUrl() }); // production owner
  await admin.connect();
  const secret = await installCompletionSecret(admin);
  const kek = testKek();

  // a SEPARATE throwaway database on the same server
  await admin.query('CREATE DATABASE catalog_rehearsal');
  const prodAdminUrl = adminUrl();
  const prodDbUrl = process.env.DATABASE_URL!;
  const rehearsalAdminUrl = prodAdminUrl.replace(/\/catalog$/, '/catalog_rehearsal');

  const prodItemCount = async (): Promise<number> => Number((await pool.query('SELECT count(*) AS c FROM items')).rows[0].c);

  console.log('Running Phase 6 restore-rehearsal suite (Stage 6.4):\n');

  // seed production + take a backup
  const keystore = freshKeystore();
  const custodian = new FileCustodian(keystore, secret, kek);
  const auth = new CatalogAuthority(pool, custodian);
  const idA = mintItemId();
  await auth.addItem(idA, { title: 'Rehearsal A', providerRefs: [{ type: 'tmdb', value: '1' }] });
  await auth.addItem(mintItemId(), { title: 'Rehearsal B' });
  const artifact = await BackupPolicy.dump(admin);

  // 1. rehearsal into the throwaway DB succeeds; production untouched ----------
  await test('rehearse — restores + reads in the throwaway DB; production untouched', async () => {
    const before = await prodItemCount();
    const report = await runRehearsal({ artifact, rehearsalAdminUrl, productionUrls: [prodAdminUrl, prodDbUrl], completionSecret: secret, custodian });
    assert(report.ok, `rehearsal ok (${report.steps.filter((s) => !s.ok).map((s) => s.step).join(',') || 'all ok'})`);
    for (const step of ['migrate', 'provision-secret', 'restore', 'sample-read']) {
      assert(report.steps.some((s) => s.step === step && s.ok), `${step} ok`);
    }
    assertEq(await prodItemCount(), before, 'production items unchanged by the rehearsal');
    // the rehearsal DB actually has the restored rows
    const rc = new Client({ connectionString: rehearsalAdminUrl });
    await rc.connect();
    try { assertEq(Number((await rc.query('SELECT count(*) AS c FROM items')).rows[0].c), 2, 'rehearsal DB has the restored items'); }
    finally { await rc.end(); }
  });

  // 2. HARD refusal when the rehearsal DB resolves to the production admin DB --
  await test('rehearse — HARD refuses when rehearsal URL is the production admin DB', async () => {
    const before = await prodItemCount();
    await assertRefused(() => runRehearsal({ artifact, rehearsalAdminUrl: prodAdminUrl, productionUrls: [prodAdminUrl, prodDbUrl], completionSecret: secret, custodian }), 'prod admin refused');
    assertEq(await prodItemCount(), before, 'production untouched by the refused rehearsal');
  });

  // 3. HARD refusal when the rehearsal DB resolves to the production app DB ----
  await test('rehearse — HARD refuses when rehearsal URL resolves to the production app DB (same dbname)', async () => {
    await assertRefused(() => runRehearsal({ artifact, rehearsalAdminUrl: prodDbUrl, productionUrls: [prodAdminUrl, prodDbUrl], completionSecret: secret, custodian }), 'prod app db refused');
    // dbKey equivalence: admin and app URLs share host:port/dbname even though the user differs
    assertEq(dbKey(prodAdminUrl), dbKey(prodDbUrl), 'admin + app URLs map to the same database identity');
    assert(dbKey(rehearsalAdminUrl) !== dbKey(prodAdminUrl), 'the throwaway DB has a distinct identity');
  });

  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  await admin.query('DROP DATABASE IF EXISTS catalog_rehearsal');
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
