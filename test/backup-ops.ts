import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { InMemoryCustodian, CustodianTransportError } from '../src/core/crypto/custodian.js';
import { runDump, runRestore, restorePreflight, parseBackupArgs, RestoreRefused } from '../src/ops/backup-ops.js';
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
async function assertRefused(fn: () => Promise<unknown>, msg: string, check?: (e: RestoreRefused) => void): Promise<void> {
  try { await fn(); } catch (e) {
    if (e instanceof RestoreRefused) { check?.(e); return; }
    throw new Error(`threw wrong error (${(e as Error).name}) for: ${msg}`);
  }
  throw new Error(`expected RestoreRefused: ${msg}`);
}
const tmpDirs: string[] = [];
const freshKeystore = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'opskeystore-')); tmpDirs.push(d); return d; };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

async function main(): Promise<void> {
  console.log('Running Phase 3 backup ops guardrails suite (Stage 3.3):\n');

  // --- pure arg parsing (no DB) ---------------------------------------------
  await test('parseBackupArgs — valid dump/restore; rejects unknown command + missing file', () => {
    assertEq(parseBackupArgs(['dump', 'a.json']).command, 'dump', 'dump parsed');
    assertEq(parseBackupArgs(['dump', 'a.json', 'lbl']).label, 'lbl', 'label parsed');
    assertEq(parseBackupArgs(['restore', 'a.json']).command, 'restore', 'restore parsed');
    try { parseBackupArgs(['frobnicate', 'a.json']); assert(false, 'should throw'); } catch (e) { assert(/unknown command/.test((e as Error).message), 'unknown command'); }
    try { parseBackupArgs(['dump']); assert(false, 'should throw'); } catch (e) { assert(/requires a file path/.test((e as Error).message), 'missing file'); }
  });

  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) { console.log('Booting embedded PostgreSQL 16 ...'); server = await startEmbedded(); }
  await migrate();
  const pool = getPool();
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  const secret = await installCompletionSecret(admin);
  const kek = testKek();

  async function reset(): Promise<void> {
    await admin.query("SET session_replication_role = 'replica'");
    await admin.query('TRUNCATE events, provider_refs, items, item_key_control, aborted_operations RESTART IDENTITY CASCADE');
    await admin.query("SET session_replication_role = 'origin'");
  }
  const count = async (sql: string, p: unknown[] = []): Promise<number> => Number((await pool.query(sql, p)).rows[0].c);

  // --- preflight ------------------------------------------------------------
  await test('preflight — passes with reachable DB + custodian and a matching completion secret', async () => {
    await reset();
    const custodian = new InMemoryCustodian(secret);
    const pf = await restorePreflight({ admin, custodian, completionSecret: secret });
    assert(pf.ok, `preflight ok (problems: ${pf.problems.join('; ')})`);
    assertEq(pf.checks.db, 'pass', 'db pass');
    assertEq(pf.checks.custodian, 'pass', 'custodian pass');
    assertEq(pf.checks.completionSecret, 'pass', 'secret pass');
  });

  await test('preflight — fails (no leak) when the completion secret does not match the DB', async () => {
    const wrong = 'WRONG-OPS-SECRET-SENTINEL';
    const pf = await restorePreflight({ admin, custodian: new InMemoryCustodian(wrong), completionSecret: wrong });
    assert(!pf.ok, 'not ok');
    assertEq(pf.checks.completionSecret, 'fail', 'secret fail');
    assert(pf.problems.some((p) => /does not match/.test(p)), 'reports mismatch');
    assert(!JSON.stringify(pf).includes(wrong) && !JSON.stringify(pf).includes(secret), 'neither secret value leaks');
  });

  await test('preflight — fails when the custodian is unreachable (status throws)', async () => {
    const custodian = new InMemoryCustodian(secret);
    custodian.setFault('status', new CustodianTransportError('status'));
    const pf = await restorePreflight({ admin, custodian, completionSecret: secret });
    assert(!pf.ok, 'not ok');
    assertEq(pf.checks.custodian, 'fail', 'custodian fail');
    assert(pf.problems.some((p) => /custodian is not reachable/.test(p)), 'reports unreachable');
  });

  // --- dump -----------------------------------------------------------------
  await test('runDump — produces a ciphertext-only artifact (no custodian needed)', async () => {
    await reset();
    const fc = new FileCustodian(freshKeystore(), secret, kek);
    const auth = new CatalogAuthority(pool, fc);
    const id = mintItemId();
    await auth.addItem(id, { title: 'Dump Me' });
    const art = await runDump({ admin, label: 'unit' });
    const blob = JSON.stringify(art);
    assert(blob.includes(id), 'item id present');
    assert(!blob.includes('Dump Me'), 'plaintext title NOT present (ciphertext only)');
  });

  // --- guarded restore ------------------------------------------------------
  await test('runRestore — success: preflight passes, restore round-trips (identity readable)', async () => {
    await reset();
    const fc = new FileCustodian(freshKeystore(), secret, kek);
    const auth = new CatalogAuthority(pool, fc);
    const id = mintItemId();
    await auth.addItem(id, { title: 'Survivor', providerRefs: [{ type: 'tmdb', value: '1' }] });
    const art = await runDump({ admin });
    await reset();                                           // simulate DB loss
    assert((await auth.readIdentity(id)) === null, 'gone after wipe');
    const { restored, preflight } = await runRestore({ admin, custodian: fc, completionSecret: secret, artifact: art });
    assert(restored && preflight.ok, 'restored after passing preflight');
    assertEq((await auth.readIdentity(id))?.title, 'Survivor', 'identity readable post-restore (key in keystore)');
  });

  await test('runRestore — REFUSES on a completion-secret mismatch; DB untouched', async () => {
    await reset();
    const fc = new FileCustodian(freshKeystore(), secret, kek);
    const auth = new CatalogAuthority(pool, fc);
    const id = mintItemId();
    await auth.addItem(id, { title: 'Keep' });
    const art = await runDump({ admin });
    const before = await count('SELECT count(*) AS c FROM items');
    const wrong = 'MISMATCH-SECRET';
    await assertRefused(
      () => runRestore({ admin, custodian: new InMemoryCustodian(wrong), completionSecret: wrong, artifact: art }),
      'secret mismatch refused',
      (e) => { assert(!e.integrity, 'not an integrity failure'); assert(/preflight failed/.test(e.message), 'preflight refusal'); assert(!e.message.includes(wrong) && !e.message.includes(secret), 'no secret leak'); },
    );
    assertEq(await count('SELECT count(*) AS c FROM items'), before, 'DB unchanged by the refused restore');
    assertEq((await auth.readIdentity(id))?.title, 'Keep', 'original data intact');
  });

  await test('runRestore — REFUSES on the integrity gate (tampered artifact) and rolls back', async () => {
    await reset();
    const fc = new FileCustodian(freshKeystore(), secret, kek);
    const auth = new CatalogAuthority(pool, fc);
    const id = mintItemId();
    await auth.addItem(id, { title: 'Original' });
    const art = await runDump({ admin });
    const torn = clone(art);
    torn.tables.find((t) => t.table === 'events')!.rows = []; // projection no longer derivable
    await assertRefused(
      () => runRestore({ admin, custodian: fc, completionSecret: secret, artifact: torn }),
      'integrity refusal',
      (e) => { assert(e.integrity, 'integrity flagged'); assert(/integrity gate/.test(e.message), 'integrity message'); },
    );
    assertEq((await auth.readIdentity(id))?.title, 'Original', 'pre-restore data intact (full rollback)');
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
