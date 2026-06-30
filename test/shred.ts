import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { InMemoryCustodian, CustodianTransportError } from '../src/core/crypto/custodian.js';
import { getPool, migrate, adminUrl, closePool } from '../src/db/pool.js';
import { installCompletionSecret } from './crypto-setup.js';

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
async function assertThrows(fn: () => Promise<unknown> | unknown, msg: string, match?: RegExp): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (match && !match.test((e as Error).message)) throw new Error(`threw, message ${JSON.stringify((e as Error).message)} != ${match} (${msg})`);
    return;
  }
  throw new Error(`expected to throw: ${msg}`);
}

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

  const secret = await installCompletionSecret(admin);
  // shared custodian so tests can inspect/fault-inject it
  const custodian = new InMemoryCustodian(secret);
  const auth = new CatalogAuthority(pool, custodian);

  async function reset(): Promise<void> {
    await admin.query("SET session_replication_role = 'replica'");
    await admin.query('TRUNCATE events, provider_refs, items, item_key_control RESTART IDENTITY CASCADE');
    await admin.query("SET session_replication_role = 'origin'");
  }

  console.log('Running Phase 2 crypto-shred suite (Stage 2a):\n');

  // 1. round-trip: identity is encrypted at rest, readable via the authority ---
  await test('add/read — identity is encrypted at rest and round-trips', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'The Matrix', year: 1999, providerRefs: [{ type: 'tmdb', value: '603' }] });
    const got = await auth.readIdentity(id);
    assertEq(got?.title, 'The Matrix', 'title round-trips');
    assertEq(got?.year, 1999, 'year round-trips');
    assertEq(got?.providerRefs?.[0]?.value, '603', 'ref value round-trips');
  });

  // 2. the DB stores only ciphertext (no plaintext identity) -------------------
  await test('storage — the DB holds only ciphertext, never plaintext identity', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'Plaintext Marker 12345', providerRefs: [{ type: 'tmdb', value: 'refmarker999' }] });
    const hit = await pool.query(
      `SELECT count(*)::int AS c FROM items
        WHERE coalesce(encode(identity_ct,'escape'),'') LIKE '%Plaintext Marker%'`,
    );
    assertEq(hit.rows[0].c, 0, 'no plaintext identity in items');
    const ev = await pool.query(`SELECT count(*)::int AS c FROM events WHERE payload::text LIKE '%Plaintext%' OR payload::text LIKE '%refmarker%'`);
    assertEq(ev.rows[0].c, 0, 'no plaintext in events');
    assert((await pool.query(`SELECT identity_ct FROM items WHERE id=$1`, [id])).rows[0].identity_ct instanceof Buffer, 'identity stored as bytea');
  });

  // 3. shred irrecoverability: forget destroys the key, read fails closed ------
  await test('shred — forget destroys the key lineage; identity is irrecoverable', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'Secret' });
    const keyId = (await pool.query(`SELECT key_id FROM item_key_control WHERE item_id=$1`, [id])).rows[0].key_id;
    await auth.forget(id);
    assertEq(await custodian.status(keyId), 'destroyed', 'custodian key destroyed');
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE id=$1 AND identity_ct IS NOT NULL`, [id]), 0, 'ciphertext cleared');
    assertEq(await count(pool, `SELECT count(*) AS c FROM item_key_control WHERE item_id=$1 AND shred_state='shred_complete'`, [id]), 1, 'shred_complete recorded');
    assert((await auth.readIdentity(id)) === null, 'identity unreadable');
  });

  // 4. backup cannot resurrect: re-inserting old ciphertext stays unreadable ----
  await test('backup — restoring pre-forget ciphertext cannot resurrect identity', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'Backup Victim' });
    const ct = (await pool.query(`SELECT identity_ct FROM items WHERE id=$1`, [id])).rows[0].identity_ct as Buffer;
    await auth.forget(id); // key destroyed
    // simulate an old-backup restore of the ciphertext into the (now forgotten) row
    await admin.query(`UPDATE items SET identity_ct=$2, present=true, forgotten=false WHERE id=$1`, [id, ct]);
    await admin.query(`UPDATE item_key_control SET shred_state='active' WHERE item_id=$1`, [id]); // stale "active"
    // fail-closed: custodian says destroyed, so the read must deny regardless of DB state
    assert((await auth.readIdentity(id)) === null, 'restored ciphertext is undecryptable / denied');
  });

  // 5. key lineage: an update reuses the key; forget destroys the whole lineage --
  await test('lineage — update reuses the key_id; forget destroys the whole lineage', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'v1' });
    const key1 = (await pool.query(`SELECT key_id FROM item_key_control WHERE item_id=$1`, [id])).rows[0].key_id;
    await auth.updateIdentity(id, { title: 'v2' });
    const key2 = (await pool.query(`SELECT key_id FROM item_key_control WHERE item_id=$1`, [id])).rows[0].key_id;
    assertEq(key1, key2, 'update reuses the same key_id (no lineage swap)');
    assertEq((await auth.readIdentity(id))?.title, 'v2', 'updated identity readable');
    await auth.forget(id);
    assertEq(await custodian.status(key1), 'destroyed', 'the single lineage key is destroyed');
  });

  // 6. recheck-before-return fails closed on custodian failure ------------------
  await test('read — fails closed when the custodian status check throws', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'guarded' });
    custodian.setFault('status', new CustodianTransportError('status'));
    assert((await auth.readIdentity(id)) === null, 'read denied on transport failure');
    custodian.setFault('status', null);
    assert((await auth.readIdentity(id)) !== null, 'readable again once custodian recovers');
  });

  // 7. rebuild preserves key-control ------------------------------------------
  await test('rebuild — clears identity ciphertext but preserves key-control', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'keep-key' });
    await auth.rebuildProjection(new Date(Date.now() + 3_600_000));
    assertEq(await count(pool, `SELECT count(*) AS c FROM item_key_control WHERE item_id=$1`, [id]), 1, 'key-control survives rebuild');
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE id=$1 AND identity_ct IS NOT NULL`, [id]), 0, 'ciphertext cleared by rebuild');
    assert((await auth.readIdentity(id)) === null, 'identity not readable until re-hydrated');
  });

  // 8. per-item isolation ------------------------------------------------------
  await test('isolation — shredding one item leaves another readable', async () => {
    await reset();
    const a = mintItemId();
    const b = mintItemId();
    await auth.addItem(a, { title: 'A' });
    await auth.addItem(b, { title: 'B' });
    await auth.forget(a);
    assert((await auth.readIdentity(a)) === null, 'A shredded');
    assertEq((await auth.readIdentity(b))?.title, 'B', 'B still readable');
  });

  // 9. P0 — shred completion cannot be fabricated by the app -------------------
  await test('forget — app cannot fabricate shred completion (attestation required)', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'attested' });
    const keyId = (await pool.query(`SELECT key_id FROM item_key_control WHERE item_id=$1`, [id])).rows[0].key_id;
    // begin the shred (marks pending, clears ciphertext) but do NOT actually destroy the key
    const begin = (await pool.query('SELECT key_id, shred_op_id, needs_destroy FROM cat_forget_begin($1)', [id])).rows[0];
    await assertThrows(
      () => pool.query('SELECT cat_forget_complete($1,$2,$3,$4,$5)', [id, begin.shred_op_id, 'fabricated-receipt', '2026-01-01T00:00:00.000Z', 'deadbeefdeadbeef']),
      'fabricated attestation rejected', /invalid destruction attestation/i,
    );
    assertEq(await count(pool, `SELECT count(*) AS c FROM item_key_control WHERE item_id=$1 AND shred_state='shred_pending'`, [id]), 1, 'still pending, not completed');
    assertEq(await custodian.status(keyId), 'active', 'custodian key was never destroyed');
  });

  // 10. P0 — a lost commit ack must NOT destroy the committed key ---------------
  await test('addItem — lost commit ack leaves the committed key intact (not destroyed)', async () => {
    await reset();
    const c2 = new InMemoryCustodian(secret);
    const a2 = new CatalogAuthority(pool, c2);
    const id = mintItemId();
    c2.setFault('commit', new CustodianTransportError('commit'));
    await a2.addItem(id, { title: 'survivor' }); // commitProvision throws internally; must be swallowed
    c2.setFault('commit', null);
    const keyId = (await pool.query(`SELECT key_id FROM item_key_control WHERE item_id=$1`, [id])).rows[0].key_id;
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE id=$1 AND present`, [id]), 1, 'DB committed/active');
    assert((await c2.status(keyId)) !== 'destroyed', 'committed key was NOT destroyed by the lost ack');
  });

  // 11. P1 — upgraded Phase 1 item can be hydrated -----------------------------
  await test('hydrateLegacy — an upgraded present item with no lineage gets encrypted identity', async () => {
    await reset();
    const id = mintItemId();
    await admin.query(`INSERT INTO items (id, present, forgotten, last_seq) VALUES ($1, true, false, 1)`, [id]); // legacy row, no key-control
    await assertThrows(() => auth.addItem(id, { title: 'x' }), 'plain add fails on a present legacy item', /already present/i);
    await auth.hydrateLegacy(id, { title: 'Hydrated', providerRefs: [{ type: 'tmdb', value: '99' }] });
    const got = await auth.readIdentity(id);
    assertEq(got?.title, 'Hydrated', 'hydrated identity is readable');
    assertEq(got?.providerRefs?.[0]?.value, '99', 'hydrated ref readable');
  });

  // 12. gap — updateIdentity replacement removes omitted refs ------------------
  await test('updateIdentity — replacement semantics remove omitted provider refs', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'v1', providerRefs: [{ type: 'tmdb', value: '1' }, { type: 'infohash', value: 'abc' }] });
    await auth.updateIdentity(id, { title: 'v2', providerRefs: [{ type: 'tmdb', value: '2' }] });
    assertEq(await count(pool, `SELECT count(*) AS c FROM provider_refs WHERE item_id=$1 AND present`, [id]), 1, 'one ref remains present');
    assertEq(await count(pool, `SELECT count(*) AS c FROM provider_refs WHERE item_id=$1 AND ref_type='infohash' AND (present OR ref_value_ct IS NOT NULL)`, [id]), 0, 'omitted ref removed + cleared');
    const got = await auth.readIdentity(id);
    assertEq(got?.providerRefs?.length, 1, 'only the retained ref is read back');
  });

  // 13. gap — withIdentity redaction survives JSON escaping + covers object keys
  await test('withIdentity — redaction survives JSON escaping and covers object keys', async () => {
    await reset();
    const id = mintItemId();
    const trickyTitle = 'Secret"Quote\\back\nline'; // contains quote, backslash, newline
    await auth.addItem(id, {
      title: trickyTitle,
      externalIds: { secretKey: 'plain-val' }, // key is identifying too
      metadata: { note: 'm\nval' },
      providerRefs: [{ type: 'imdb', value: 'tt-secret-1' }],
    });
    const lines: string[] = [];
    const log = auth.createLogger((l) => lines.push(l));
    await auth.withIdentity(id, (identity) => {
      log.info(`raw=${identity!.title} ref=${identity!.providerRefs?.[0]?.value}`); // raw interpolation
      log.info(`json=${JSON.stringify(identity)}`);                                  // JSON-escaped in message
      log.info('structured', { identity });                                          // structured (redact-before-serialize)
    });
    const blob = lines.join('\n');
    assert(!blob.includes('Secret"Quote'), 'raw title masked');
    assert(!blob.includes('Secret\\"Quote'), 'JSON-escaped title masked');
    assert(!blob.includes('plain-val'), 'external id value masked');
    assert(!blob.includes('secretKey'), 'object key masked');
    assert(!blob.includes('tt-secret-1'), 'ref value masked');
    assert(!blob.includes('m\nval') && !blob.includes('m\\nval'), 'metadata value (raw + escaped) masked');
    assertEq(auth.secrets.size(), 0, 'no identity registrations linger after the scope');
  });

  // 14. ref removal is event-sourced (survives rebuild) ----------------------
  await test('updateIdentity — ref removal is event-sourced and survives rebuild', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'v1', providerRefs: [{ type: 'tmdb', value: '1' }, { type: 'infohash', value: 'a' }] });
    await auth.updateIdentity(id, { title: 'v2', providerRefs: [{ type: 'tmdb', value: '2' }] });
    const refsBefore = async () => JSON.stringify((await pool.query(
      `SELECT ref_type, present FROM provider_refs WHERE item_id=$1 ORDER BY ref_type`, [id])).rows);
    const before = await refsBefore();
    await auth.rebuildProjection(new Date(Date.now() + 3_600_000));
    assertEq(await refsBefore(), before, 'ref presence identical after rebuild');
    assertEq(await count(pool, `SELECT count(*) AS c FROM provider_refs WHERE item_id=$1 AND ref_type='infohash' AND present`, [id]), 0, 'detached ref stays absent after rebuild');
  });

  // 15. attestation verifies for a NEW shred op on an already-destroyed key ----
  await test('attestation — stable receipt verifies for a new shred op (unblocks self-heal)', async () => {
    await reset();
    const id = mintItemId();
    await auth.addItem(id, { title: 'x' });
    const keyId = (await pool.query(`SELECT key_id FROM item_key_control WHERE item_id=$1`, [id])).rows[0].key_id;
    await auth.forget(id); // key destroyed, shred_complete
    // simulate an old-backup restore: row back to active, then a NEW shred op begins
    await admin.query(`UPDATE item_key_control SET shred_state='active', shred_op_id=NULL, shredded_at=NULL, shred_receipt=NULL WHERE item_id=$1`, [id]);
    await admin.query(`UPDATE items SET present=true, forgotten=false WHERE id=$1`, [id]);
    const begin = (await pool.query('SELECT key_id, shred_op_id, needs_destroy FROM cat_forget_begin($1)', [id])).rows[0];
    const receipt = await custodian.destroy(begin.shred_op_id, keyId); // idempotent -> stable receipt
    const done = (await pool.query('SELECT cat_forget_complete($1,$2,$3,$4,$5) AS done',
      [id, begin.shred_op_id, receipt.receiptId, receipt.destroyedAt, receipt.attestation])).rows[0].done;
    assertEq(done, true, 'completion succeeds with the stable attestation under a new operation');
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

async function count(c: Client | ReturnType<typeof getPool>, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await c.query(sql, params);
  return Number(rows[0].c);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
