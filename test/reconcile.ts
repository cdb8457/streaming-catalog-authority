import { Client, type Pool } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { InMemoryCustodian } from '../src/core/crypto/custodian.js';
import { getPool, migrate, adminUrl, closePool } from '../src/db/pool.js';

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
function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg} (expected ${String(expected)}, got ${String(actual)})`);
}
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) {
    console.log('Booting embedded PostgreSQL 16 ...');
    server = await startEmbedded();
  }
  await migrate();
  const pool = getPool();
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();

  async function reset(): Promise<void> {
    await admin.query("SET session_replication_role = 'replica'");
    await admin.query('TRUNCATE events, provider_refs, items, item_key_control RESTART IDENTITY CASCADE');
    await admin.query("SET session_replication_role = 'origin'");
  }
  async function count(sql: string, params: unknown[] = []): Promise<number> {
    return Number((await pool.query(sql, params)).rows[0].c);
  }
  async function keyOf(id: string): Promise<string> {
    return (await pool.query('SELECT key_id FROM item_key_control WHERE item_id=$1', [id])).rows[0].key_id;
  }
  // fresh custodian per test so the shared pool can be reset without cross-test key state
  const makeAuth = () => {
    const custodian = new InMemoryCustodian();
    return { custodian, auth: new CatalogAuthority(pool, custodian) };
  };

  console.log('Running Phase 2 Stage 2b suite (reconciler + self-heal):\n');

  // 1. pending shred is retried to completion --------------------------------
  await test('reconcile — completes a shred left pending by a custodian outage', async () => {
    await reset();
    const { custodian, auth } = makeAuth();
    const id = mintItemId();
    await auth.addItem(id, { title: 'x' });
    const keyId = await keyOf(id);
    custodian.setFault('destroy', new Error('custodian down'));
    assertEq(await auth.forget(id), 'shred_pending', 'forget left pending');
    assertEq(await custodian.status(keyId), 'active', 'key not yet destroyed');
    custodian.setFault('destroy', null);
    const r = await auth.reconcile();
    assert(r.completed >= 1, 'reconcile completed the pending shred');
    assertEq(await custodian.status(keyId), 'destroyed', 'key destroyed after reconcile');
    assertEq(await count(`SELECT count(*) AS c FROM item_key_control WHERE item_id=$1 AND shred_state='shred_complete'`, [id]), 1, 'shred_complete');
  });

  // 2. lost commit ack is promoted, not destroyed ----------------------------
  await test('reconcile — promotes a key whose commit ack was lost (read works after)', async () => {
    await reset();
    const { custodian, auth } = makeAuth();
    const id = mintItemId();
    custodian.setFault('commit', new Error('ack lost'));
    await auth.addItem(id, { title: 'y' });
    custodian.setFault('commit', null);
    const keyId = await keyOf(id);
    assertEq(await custodian.status(keyId), 'provisional', 'provisional after lost ack');
    assert((await auth.readIdentity(id)) === null, 'read denied while provisional');
    const r = await auth.reconcile();
    assert(r.promoted >= 1, 'reconcile promoted the committed key');
    assertEq(await custodian.status(keyId), 'active', 'active after reconcile');
    assertEq((await auth.readIdentity(id))?.title, 'y', 'readable after promotion');
  });

  // 3. confirmed-orphan provisional key is destroyed -------------------------
  await test('reconcile — destroys a provisional key with no committed DB row', async () => {
    await reset();
    const { custodian, auth } = makeAuth();
    const id = mintItemId();
    const { keyId } = await custodian.provision('op-orphan', id, 0); // never written to the DB
    assertEq(await custodian.status(keyId), 'provisional', 'orphan provisional');
    const r = await auth.reconcile();
    assert(r.destroyed >= 1, 'orphan destroyed');
    assertEq(await custodian.status(keyId), 'destroyed', 'orphan destroyed');
  });

  // 4. DB unavailable -> reconcile destroys nothing --------------------------
  await test('reconcile — does NOTHING under DB unavailability (never destroys on uncertainty)', async () => {
    await reset();
    const custodian = new InMemoryCustodian();
    const id = mintItemId();
    const { keyId } = await custodian.provision('op-x', id, 0); // provisional orphan
    const failingPool = { query: async () => { throw new Error('DB unavailable'); } } as unknown as Pool;
    const authFailing = new CatalogAuthority(failingPool, custodian);
    const r = await authFailing.reconcile();
    assertEq(r.destroyed, 0, 'nothing destroyed when the DB cannot be queried');
    assertEq(await custodian.status(keyId), 'provisional', 'orphan left intact (cannot confirm non-commit)');
  });

  // 5. old-backup self-heal --------------------------------------------------
  await test('reconcile — self-heals an old-backup restore (active row, destroyed key)', async () => {
    await reset();
    const { custodian, auth } = makeAuth();
    const id = mintItemId();
    await auth.addItem(id, { title: 'z' });
    await auth.forget(id); // key destroyed, shred_complete
    // simulate restoring a pre-forget backup: row back to active+present with ciphertext
    await admin.query(`UPDATE item_key_control SET shred_state='active', shred_op_id=NULL, shredded_at=NULL, shred_receipt=NULL WHERE item_id=$1`, [id]);
    await admin.query(`UPDATE items SET present=true, forgotten=false, identity_ct='\\x00'::bytea WHERE id=$1`, [id]);
    assert((await auth.readIdentity(id)) === null, 'read fails closed before heal (custodian destroyed)');
    const r = await auth.reconcile();
    assert(r.healed >= 1, 'reconcile self-healed the restored row');
    assertEq(await count(`SELECT count(*) AS c FROM item_key_control WHERE item_id=$1 AND shred_state='shred_complete'`, [id]), 1, 'row back to shred_complete');
    assertEq(await count(`SELECT count(*) AS c FROM items WHERE id=$1 AND identity_ct IS NULL AND forgotten`, [id]), 1, 'ciphertext re-cleared, forgotten');
  });

  // 6. concurrent winner selection leaves no stale provisional keys ----------
  await test('winner selection — 20 concurrent adds: one lineage, losers leave no provisional keys', async () => {
    await reset();
    const { custodian, auth } = makeAuth();
    const id = mintItemId();
    await Promise.all(range(20).map(() => auth.addItem(id)));
    assertEq(await count(`SELECT count(*) AS c FROM item_key_control WHERE item_id=$1`, [id]), 1, 'exactly one lineage');
    assertEq((await custodian.listStaleProvisioning()).length, 0, 'no leftover provisional keys (losers destroyed theirs)');
    assertEq((await auth.readIdentity(id)) !== null, true, 'winner identity readable');
  });

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

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
