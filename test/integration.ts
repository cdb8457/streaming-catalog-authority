import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
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
async function assertThrows(fn: () => Promise<unknown> | unknown, msg: string): Promise<void> {
  try { await fn(); } catch { return; }
  throw new Error(`expected to throw: ${msg}`);
}

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) { console.log('Booting embedded PostgreSQL 16 ...'); server = await startEmbedded(); }
  await migrate();
  const pool = getPool();
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();

  const secret = await installCompletionSecret(admin);
  const kek = testKek();
  const keystore = path.join(process.cwd(), `.keystore-${process.argv[2] ?? '5437'}`);
  FileCustodian.wipe(keystore);
  const custodian = new FileCustodian(keystore, secret, kek);
  const auth = new CatalogAuthority(pool, custodian);

  async function reset(): Promise<void> {
    await admin.query("SET session_replication_role = 'replica'");
    await admin.query('TRUNCATE events, provider_refs, items, item_key_control, aborted_operations RESTART IDENTITY CASCADE');
    await admin.query("SET session_replication_role = 'origin'");
  }
  const keyOf = async (id: string): Promise<string> => (await pool.query('SELECT key_id FROM item_key_control WHERE item_id=$1', [id])).rows[0].key_id;
  const count = async (sql: string, p: unknown[] = []): Promise<number> => Number((await pool.query(sql, p)).rows[0].c);

  console.log('Running Phase 2 integration suite (FileCustodian — durable adapter):\n');

  // 1. end-to-end round trip against the durable custodian --------------------
  await test('integration — add/read round-trips through the file custodian', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'Durable Movie', year: 2024, providerRefs: [{ type: 'tmdb', value: '777' }] });
    const got = await auth.readIdentity(id);
    assertEq(got?.title, 'Durable Movie', 'title round-trips');
    assertEq(got?.providerRefs?.[0]?.value, '777', 'ref round-trips');
  });

  // 2. forget: irreversible delete + DB verifies the custodian's attestation --
  await test('integration — forget destroys the key, leaves a tombstone, DB verifies attestation', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'Erase Me' });
    const keyId = await keyOf(id);
    assertEq(await custodian.status(keyId), 'active', 'key active before forget');
    const state = await auth.forget(id);
    assertEq(state, 'shred_complete', 'forget completed (DB verified the file custodian attestation)');
    assertEq(await custodian.status(keyId), 'destroyed', 'status destroyed (tombstone-backed)');
    await assertThrows(() => custodian.get(keyId, 0), 'key material irreversibly gone (get fails)');
    assert((await auth.readIdentity(id)) === null, 'identity unreadable');
    assertEq(await count(`SELECT count(*) AS c FROM item_key_control WHERE item_id=$1 AND shred_state='shred_complete'`, [id]), 1, 'DB shred_complete');
  });

  // 3. durability across a custodian restart ---------------------------------
  await test('integration — keys + tombstones survive a custodian restart', async () => {
    await reset();
    const live = mintItemId();
    const gone = mintItemId();
    await auth.addItem(live, { title: 'Lives On' });
    await auth.addItem(gone, { title: 'Gets Shredded' });
    const goneKey = await keyOf(gone);
    await auth.forget(gone);
    // simulate a process restart: a brand-new custodian reading the same directory
    const custodian2 = new FileCustodian(keystore, secret, kek); // same secret + KEK, restarted
    const auth2 = new CatalogAuthority(pool, custodian2);
    assertEq((await auth2.readIdentity(live))?.title, 'Lives On', 'active key persisted; identity still readable');
    assertEq(await custodian2.status(goneKey), 'destroyed', 'tombstone persisted across restart');
  });

  // 4. reconcile self-heal works with the durable custodian ------------------
  await test('integration — reconcile self-heals an old-backup restore', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'Restore Victim' });
    await auth.forget(id);
    await admin.query(`UPDATE item_key_control SET shred_state='active', shred_op_id=NULL, shredded_at=NULL, shred_receipt=NULL WHERE item_id=$1`, [id]);
    await admin.query(`UPDATE items SET present=true, forgotten=false, identity_ct='\\x00'::bytea WHERE id=$1`, [id]);
    assert((await auth.readIdentity(id)) === null, 'fail-closed before heal');
    const r = await auth.reconcile();
    assert(r.healed >= 1, 'self-healed via the file custodian tombstone');
    assertEq(await count(`SELECT count(*) AS c FROM item_key_control WHERE item_id=$1 AND shred_state='shred_complete'`, [id]), 1, 'back to shred_complete');
  });

  // 5. the completion secret is not readable by the app role -----------------
  await test('integration — app role cannot read the completion secret', async () => {
    await assertThrows(() => pool.query('SELECT completion_secret FROM crypto_config'), 'app cannot read crypto_config');
  });

  // 6. P0: destroy refuses an unknown key (no fabricated tombstone) -----------
  await test('integration — destroy refuses an unknown key (no fabricated tombstone)', async () => {
    await assertThrows(() => custodian.destroy(mintItemId(), 'key_does-not-exist'), 'destroy(not_found) refused');
    assertEq(await custodian.status('key_does-not-exist'), 'not_found', 'no tombstone fabricated for a missing key');
  });

  // 7. P0: path-traversal operation ids are contained (hashed filenames) ------
  await test('integration — path-traversal ids cannot escape the keystore', async () => {
    await reset();
    const id = mintItemId();
    const evilOp = '../../escaped-op';
    const { keyId } = await custodian.provision(evilOp, id, 0); // hashed -> contained
    assertEq(await custodian.status(keyId), 'provisional', 'evil-op key provisioned, contained');
    assert(!existsSync(path.resolve(keystore, '..', '..', 'escaped-op.json')), 'no file written outside the keystore');
    await custodian.commitProvision(evilOp);
    assertEq(await custodian.status(keyId), 'active', 'evil-op key usable and contained');
  });

  // 8. P0: a custodian without the right secret cannot complete a shred -------
  await test('integration — wrong completion secret cannot complete a shred', async () => {
    await reset();
    const wrongStore = path.join(process.cwd(), `.keystore-wrong-${process.argv[2] ?? '5437'}`);
    FileCustodian.wipe(wrongStore);
    const rogue = new CatalogAuthority(pool, new FileCustodian(wrongStore, 'a-different-secret', kek));
    const id = mintItemId();
    await rogue.addItem(id, { title: 'q' }); // rogue owns the key, but not the DB's secret
    const state = await rogue.forget(id);
    assertEq(state, 'shred_pending', 'completion rejected: wrong-secret attestation does not verify');
    assertEq(await count(`SELECT count(*) AS c FROM item_key_control WHERE item_id=$1 AND shred_state='shred_pending'`, [id]), 1, 'row stuck pending, never falsely complete');
    FileCustodian.wipe(wrongStore);
  });

  // 9. custodian requires an explicit secret + valid KEK ---------------------
  await test('integration — custodian requires an explicit secret and a 32-byte KEK', async () => {
    await assertThrows(() => { void new FileCustodian(keystore, '', kek); }, 'empty secret rejected');
    await assertThrows(() => { void new FileCustodian(keystore, 's', Buffer.alloc(16)); }, 'short KEK rejected');
  });

  FileCustodian.wipe(keystore);
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
