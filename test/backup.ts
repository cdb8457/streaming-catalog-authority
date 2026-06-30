import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { BackupPolicy, BACKED_UP_TABLES, BackupIntegrityError } from '../src/core/backup/backup-policy.js';
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const clone = (a: unknown): { tables: Array<{ table: string; rows: unknown[] }> } => JSON.parse(JSON.stringify(a));
async function assertThrowsIntegrity(fn: () => Promise<unknown>, msg: string): Promise<void> {
  try { await fn(); } catch (e) {
    if (e instanceof BackupIntegrityError) return;
    throw new Error(`threw the wrong error (${(e as Error).name}: ${(e as Error).message}) for: ${msg}`);
  }
  throw new Error(`expected BackupIntegrityError: ${msg}`);
}
// Pure check on a dumped artifact: every item projection head (last_seq>0) must be backed by an
// event for THAT SAME item within the same artifact, and every ref/key-control row must reference
// an item present in the artifact. A torn (non-snapshot) dump violates this.
function assertArtifactConsistent(art: { tables: Array<{ table: string; rows: unknown[] }> }, msg: string): void {
  const rowsOf = (t: string): unknown[] => art.tables.find((x) => x.table === t)!.rows;
  const events = rowsOf('events') as Array<{ item_id: string; seq: number }>;
  const have = new Set(events.map((e) => `${e.item_id}#${e.seq}`));
  const itemIds = new Set((rowsOf('items') as Array<{ id: string }>).map((i) => i.id));
  for (const i of rowsOf('items') as Array<{ id: string; last_seq: number }>) {
    if (i.last_seq > 0 && !have.has(`${i.id}#${i.last_seq}`)) throw new Error(`${msg}: item ${i.id} head seq ${i.last_seq} missing from the artifact (torn)`);
  }
  for (const r of rowsOf('provider_refs') as Array<{ item_id: string }>) if (!itemIds.has(r.item_id)) throw new Error(`${msg}: provider_ref references missing item (torn)`);
  for (const k of rowsOf('item_key_control') as Array<{ item_id: string }>) if (!itemIds.has(k.item_id)) throw new Error(`${msg}: key-control references missing item (torn)`);
}
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) { console.log('Booting embedded PostgreSQL 16 ...'); server = await startEmbedded(); }
  await migrate();
  const pool = getPool();
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();

  const secret = await installCompletionSecret(admin);
  const kek = testKek();
  const keystore = path.join(process.cwd(), `.keystore-${process.argv[2] ?? '5438'}`);
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
  const score = async (id: string): Promise<number> => Number((await pool.query('SELECT behavioral_score AS c FROM items WHERE id=$1', [id])).rows[0]?.c ?? -1);
  // Read one wrapped DEK straight off the keystore, to prove it never appears in the artifact.
  const anyWrappedHex = (): string => {
    const keysDir = path.join(keystore, 'keys');
    for (const f of readdirSync(keysDir)) {
      if (!f.endsWith('.json')) continue;
      const kf = JSON.parse(readFileSync(path.join(keysDir, f), 'utf8')) as { wrappedHex?: string };
      if (kf.wrappedHex) return kf.wrappedHex;
    }
    throw new Error('no key file found in keystore');
  };

  console.log('Running Phase 2 Stage 3b suite (encrypted backup / restore policy):\n');

  // 1. the backup artifact excludes ALL key material -------------------------
  await test('backup — artifact carries ciphertext only; excludes keystore, KEK, completion secret', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'Backed-up Movie', providerRefs: [{ type: 'tmdb', value: '4242' }] });
    const wrapped = anyWrappedHex();

    const art = await BackupPolicy.dump(admin, 'unit-test');
    const dumpedTables = art.tables.map((t) => t.table).sort();
    assertEq(JSON.stringify(dumpedTables), JSON.stringify([...BACKED_UP_TABLES].sort()), 'exactly the allow-listed tables are dumped');
    assert(!dumpedTables.includes('crypto_config' as never), 'crypto_config (completion secret) is NOT dumped');

    const blob = JSON.stringify(art);
    assert(!blob.includes(secret), 'completion secret absent from the artifact');
    assert(!blob.includes(kek.toString('hex')), 'KEK absent from the artifact');
    assert(!blob.includes(wrapped), 'wrapped DEK (keystore material) absent from the artifact');
    // positive control: the ciphertext-bearing state IS captured
    assert(blob.includes(id), 'item id (ciphertext state) IS present in the artifact');
    const items = art.tables.find((t) => t.table === 'items')!.rows as Array<{ identity_ct: string | null }>;
    const ct = items[0]?.identity_ct;
    assert(items.length === 1 && typeof ct === 'string' && ct.startsWith('\\x'), 'identity is captured only as bytea hex (ciphertext)');
  });

  // 2. a faithful round-trip restore preserves readable identity --------------
  await test('backup — dump + restore round-trips ciphertext that is still readable with the key present', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'Round Trip', year: 2025, providerRefs: [{ type: 'tmdb', value: '9' }] });
    const art = await BackupPolicy.dump(admin);
    await reset();                                  // simulate catastrophic loss of the DB
    assert((await auth.readIdentity(id)) === null, 'gone after wipe');
    await BackupPolicy.restore(admin, art);         // restore the main-DB backup
    // key material never left the keystore, so identity is readable again
    const got = await auth.readIdentity(id);
    assertEq(got?.title, 'Round Trip', 'identity readable after restore (key still in keystore)');
    assertEq(got?.providerRefs?.[0]?.value, '9', 'provider ref ciphertext round-trips');
  });

  // 3. a restored backup CANNOT resurrect a shredded identity -----------------
  await test('backup — restoring a pre-forget backup cannot resurrect shredded identity', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'Erase Me Permanently' });
    const keyId = await keyOf(id);
    const preForget = await BackupPolicy.dump(admin, 'pre-forget');  // OLD backup: identity_ct present, state active

    assertEq(await auth.forget(id), 'shred_complete', 'forget completes (key destroyed, tombstone written)');
    assertEq(await custodian.status(keyId), 'destroyed', 'key destroyed');

    // disaster recovery: operator restores the OLD main-DB backup on top of the live keystore
    await BackupPolicy.restore(admin, preForget);
    assertEq(await count(`SELECT count(*) AS c FROM items WHERE id=$1 AND identity_ct IS NOT NULL`, [id]), 1, 'ciphertext is back in the DB');
    assertEq(await count(`SELECT count(*) AS c FROM item_key_control WHERE item_id=$1 AND shred_state='active'`, [id]), 1, 'key-control row shows stale active');

    // ...but identity stays gone: the destroyed key is not in the backup, the tombstone survived.
    assert((await auth.readIdentity(id)) === null, 'fail-closed: restored ciphertext is undecryptable');
    assertEq(await custodian.status(keyId), 'destroyed', 'tombstone (separate keystore) was never resurrected by the DB restore');
  });

  // 4. reconcile/self-heal runs after restoring old state ---------------------
  await test('backup — reconcile self-heals the restored old state back to shred_complete', async () => {
    // continues logically from test 3's restored stale-active row; re-establish it deterministically
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'Heal After Restore' });
    const keyId = await keyOf(id);
    const old = await BackupPolicy.dump(admin, 'pre-forget');
    await auth.forget(id);
    await BackupPolicy.restore(admin, old);                     // stale active row + ciphertext back
    assert((await auth.readIdentity(id)) === null, 'fail-closed before heal');

    const r = await auth.reconcile();                           // existing self-heal path
    assert(r.healed >= 1, 'reconcile self-healed the restored row via the keystore tombstone');
    assertEq(await count(`SELECT count(*) AS c FROM item_key_control WHERE item_id=$1 AND shred_state='shred_complete'`, [id]), 1, 'back to shred_complete');
    assertEq(await count(`SELECT count(*) AS c FROM items WHERE id=$1 AND identity_ct IS NULL AND forgotten`, [id]), 1, 'ciphertext re-cleared, forgotten');
    assertEq(await custodian.status(keyId), 'destroyed', 'key remains destroyed throughout');
  });

  // 5. expired behavioral events do not return after restore ------------------
  // NOTE: physical pruning is gated by the append-only trigger on REAL now() (a behavioral row
  // is deletable only once its expires_at has actually passed), so this uses a tiny TTL + a short
  // wait rather than a synthetic future cutoff — genuine expiry, not a simulated one.
  await test('backup — restoring an OLD backup does not resurrect an expired behavioral signal', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'Trending' });
    await auth.recordSignal(id, 5, 5);                          // weight 5, expires ~5ms from now
    assertEq(await score(id), 5, 'behavioral signal counts while live (scored at insert)');

    const oldBackup = await BackupPolicy.dump(admin, 'with-live-signal'); // OLD backup still holds the event
    await sleep(75);                                            // let it actually expire (wall clock passes expires_at)
    const cutoff = new Date();                                  // strictly after expires_at

    // live DB: operator prunes the now-expired signal away
    const prunedLive = await auth.pruneAndRebuild(cutoff);
    assert(prunedLive >= 1, 'live prune removed the expired behavioral event');
    assertEq(await score(id), 0, 'score drops to 0 once expired+pruned');

    // disaster recovery from the OLD backup (which still contains the expired event row)
    await BackupPolicy.restore(admin, oldBackup);
    assertEq(await count(`SELECT count(*) AS c FROM events WHERE item_id=$1 AND kind='behavioral'`, [id]), 1, 'old backup re-introduces the raw expired event row');

    // standard post-restore maintenance enforces expiry: cutoff-aware replay scores it at 0...
    await auth.rebuildProjection(cutoff);
    assertEq(await score(id), 0, 'expired signal does NOT return to the projection after restore');
    // ...and a prune physically purges the resurrected row again
    const prunedAfter = await auth.pruneAndRebuild(cutoff);
    assert(prunedAfter >= 1, 'prune removes the re-introduced expired event');
    assertEq(await count(`SELECT count(*) AS c FROM events WHERE item_id=$1 AND kind='behavioral'`, [id]), 0, 'no expired behavioral event survives');
    assertEq(await score(id), 0, 'score stays 0');
  });

  // 6. a backup taken AFTER pruning stays pruned on restore ------------------
  await test('backup — a post-prune backup carries no expired events to restore', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'Quiet' });
    await auth.recordSignal(id, 7, 5);
    await sleep(75);
    const cutoff = new Date();
    await auth.pruneAndRebuild(cutoff);                         // event gone before backup
    const cleanBackup = await BackupPolicy.dump(admin, 'post-prune');
    const evRows = cleanBackup.tables.find((t) => t.table === 'events')!.rows as Array<{ kind: string }>;
    assertEq(evRows.filter((e) => e.kind === 'behavioral').length, 0, 'post-prune backup contains no behavioral events');

    await reset();
    await BackupPolicy.restore(admin, cleanBackup);
    assertEq(await count(`SELECT count(*) AS c FROM events WHERE item_id=$1 AND kind='behavioral'`, [id]), 0, 'restore introduces no behavioral events');
    assertEq(await score(id), 0, 'no behavioral score after restoring a pruned backup');
  });

  // 7. the completion secret is an EXTERNAL restore prerequisite -------------
  await test('backup — restore does not carry the completion secret (external prerequisite)', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'Secret Stays Out' });
    const art = await BackupPolicy.dump(admin);

    // operator rotates the DB completion secret to a DIFFERENT value, then restores the backup.
    const rotated = `${mintItemId()}${mintItemId()}`;
    await admin.query('UPDATE crypto_config SET completion_secret=$1 WHERE id=1', [rotated]);
    await BackupPolicy.restore(admin, art);
    const live = (await admin.query('SELECT completion_secret AS s FROM crypto_config WHERE id=1')).rows[0].s;
    assertEq(live, rotated, 'restore did NOT overwrite crypto_config — the secret is provisioned out-of-band, not from the backup');
  });

  // 8. a torn artifact (projection ahead of the log) is refused and rolled back ---
  await test('backup — restore refuses a torn artifact (items ahead of events) and rolls back', async () => {
    await reset();
    const keep = mintItemId();
    await auth.addItem(keep, { title: 'Survivor' });
    const tear = mintItemId();
    await auth.addItem(tear, { title: 'Torn' });
    const art = await BackupPolicy.dump(admin);

    // simulate a NON-snapshot dump: items/key-control captured AFTER events — drop the events the
    // projection depends on, so items.last_seq references seqs absent from the log.
    const torn = clone(art);
    torn.tables.find((t) => t.table === 'events')!.rows = [];

    await assertThrowsIntegrity(() => BackupPolicy.restore(admin, torn as never), 'torn artifact must be refused');
    // rolled back: the live state the operator had before the bad restore is intact
    assertEq((await auth.readIdentity(keep))?.title, 'Survivor', 'pre-restore data intact after the refused restore (rollback)');
    assertEq(await count(`SELECT count(*) AS c FROM items WHERE id=$1`, [tear]), 1, 'no partial wipe from the aborted restore');
  });

  // 8b. the masking case: a missing EARLIER item's event hidden by a LATER event --
  // (Codex repro) items A@seq1, B@seq2; drop A@1, keep B@2 -> max(last_seq)=max(seq)=2, so a
  // GLOBAL-max check would WRONGLY accept. The per-item head check must still reject A.
  await test('backup — restore refuses a missing earlier-item event masked by a later event', async () => {
    await reset();                                             // RESTART IDENTITY -> seqs start at 1
    const a = mintItemId();
    const b = mintItemId();
    await auth.addItem(a, { title: 'Alpha' });                 // ItemAdded seq 1, items.a.last_seq=1
    await auth.addItem(b, { title: 'Beta' });                  // ItemAdded seq 2, items.b.last_seq=2
    const art = await BackupPolicy.dump(admin);

    const torn = clone(art);
    const ev = torn.tables.find((t) => t.table === 'events')!;
    ev.rows = (ev.rows as Array<{ item_id: string }>).filter((e) => e.item_id !== a); // drop A's event, keep B's
    // precondition: the global maxima are EQUAL, so the old global-max gate would have passed.
    const items = torn.tables.find((t) => t.table === 'items')!.rows as Array<{ last_seq: number }>;
    const maxLast = Math.max(...items.map((i) => i.last_seq));
    const maxSeq = Math.max(...(ev.rows as Array<{ seq: number }>).map((e) => e.seq), 0);
    assertEq(maxLast, maxSeq, 'precondition: global maxima equal (a global-max check would wrongly accept)');

    await assertThrowsIntegrity(() => BackupPolicy.restore(admin, torn as never), 'masked missing earlier-item event must be refused');
    // full rollback: both items intact, nothing wiped
    assertEq((await auth.readIdentity(a))?.title, 'Alpha', 'item A intact after rollback');
    assertEq((await auth.readIdentity(b))?.title, 'Beta', 'item B intact after rollback');
    assertEq(await count('SELECT count(*) AS c FROM events'), 2, 'no partial wipe (full rollback)');
    assertEq(await count('SELECT count(*) AS c FROM items'), 2, 'both items still present (full rollback)');
  });

  // 9. a torn artifact (key-control without its item) is refused -----------------
  await test('backup — restore refuses key-control that references a missing item', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'Orphaned KeyCtrl' });
    const art = await BackupPolicy.dump(admin);

    // simulate item_key_control captured ahead of items: keep the key-control row, drop the item.
    const torn = clone(art);
    torn.tables.find((t) => t.table === 'items')!.rows = [];

    await assertThrowsIntegrity(() => BackupPolicy.restore(admin, torn as never), 'dangling key-control must be refused');
    assertEq(await count(`SELECT count(*) AS c FROM item_key_control WHERE item_id=$1`, [id]), 1, 'aborted restore left key-control intact (rollback)');
  });

  // 9b. (Codex repro) a provider_refs row whose attach event was removed is refused -----------
  // item + provider ref, then a LATER same-item behavioral event. Drop ONLY the ProviderRefAttached
  // event, keep the provider_refs row and the later event: last_seq still matches a real event, so
  // head-only validation would WRONGLY accept. Replay-and-compare catches the non-derivable ref.
  await test('backup — restore refuses a provider ref not derivable from the log (attach event removed)', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'Refful', providerRefs: [{ type: 'tmdb', value: '9' }] }); // ItemAdded + ProviderRefAttached
    await auth.recordSignal(id, 3, 3_600_000);                 // later BehavioralSignal bumps last_seq past the attach
    const art = await BackupPolicy.dump(admin);

    const torn = clone(art);
    const ev = torn.tables.find((t) => t.table === 'events')!;
    const before = (ev.rows as unknown[]).length;
    ev.rows = (ev.rows as Array<{ type: string }>).filter((e) => e.type !== 'ProviderRefAttached'); // drop ONLY the attach
    assertEq((ev.rows as unknown[]).length, before - 1, 'exactly the attach event was removed (provider_refs row retained)');

    await assertThrowsIntegrity(() => BackupPolicy.restore(admin, torn as never), 'non-derivable provider ref must be refused');
    // full rollback: the provider_refs row and its attach event are both intact
    assertEq(await count(`SELECT count(*) AS c FROM provider_refs WHERE item_id=$1 AND present`, [id]), 1, 'provider_refs intact after rollback');
    assertEq(await count(`SELECT count(*) AS c FROM events WHERE item_id=$1 AND type='ProviderRefAttached'`, [id]), 1, 'attach event intact after rollback (full rollback)');
  });

  // 10. BackupPolicy.dump() itself yields a consistent artifact under concurrent writes --------
  // Drives the real API while a separate connection commits writes in a tight loop. The dump's
  // REPEATABLE READ snapshot must make every artifact internally consistent (each item's head
  // event present in the SAME artifact). Without the snapshot, a commit landing between dump's
  // per-table reads would tear it and trip assertArtifactConsistent. Deterministic on the pass
  // side; a strong probabilistic catch for any regression of the snapshot isolation.
  await test('backup — dump() yields an internally consistent artifact under concurrent writes', async () => {
    await reset();
    await auth.addItem(mintItemId(), { title: 'seed' });
    let stop = false;
    let wrote = 0;
    const writer = (async () => { while (!stop) { await auth.addItem(mintItemId(), { title: 'w' }); wrote++; } })();
    try {
      for (let i = 0; i < 25; i++) {
        const art = await BackupPolicy.dump(admin);
        assertArtifactConsistent(art, `dump #${i} torn under concurrency`);
      }
    } finally {
      stop = true;
      await writer;
    }
    assert(wrote > 0, 'the concurrent writer actually committed during the dump loop');
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
