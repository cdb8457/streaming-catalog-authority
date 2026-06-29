import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, type Pool } from 'pg';

import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId, providerRefAttached, itemRestored, itemAdded, type CatalogEvent } from '../src/core/catalog/events.js';
import { assertNoLeak, validateEventPayload } from '../src/core/redaction/noleak.js';
import { getPool, migrate, adminUrl, closePool } from '../src/db/pool.js';

// --- tiny test harness ------------------------------------------------------

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
    if (match && !match.test((e as Error).message)) {
      throw new Error(`threw, but message ${JSON.stringify((e as Error).message)} did not match ${match} (${msg})`);
    }
    return;
  }
  throw new Error(`expected to throw: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

// --- source-scan helpers ----------------------------------------------------

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkTs(p));
    else if (ent.name.endsWith('.ts')) out.push(p);
  }
  return out;
}
const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));
const CORE_DIR = fileURLToPath(new URL('../src/core', import.meta.url));

// --- db helpers -------------------------------------------------------------

async function count(pool: Pool | Client, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query(sql, params);
  return Number(rows[0].c);
}
async function reset(admin: Client): Promise<void> {
  await admin.query("SET session_replication_role = 'replica'");
  await admin.query('TRUNCATE events, provider_refs, items RESTART IDENTITY CASCADE');
  await admin.query("SET session_replication_role = 'origin'");
}
async function snapshot(pool: Pool): Promise<string> {
  const items = await pool.query(
    `SELECT id, present, forgotten, behavioral_score, last_seq, title, year, external_ids, metadata
       FROM items ORDER BY id`,
  );
  const refs = await pool.query(
    `SELECT item_id, ref_type, present, ref_value FROM provider_refs ORDER BY item_id, ref_type`,
  );
  return JSON.stringify({ items: items.rows, refs: refs.rows });
}

// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) {
    console.log('Booting embedded PostgreSQL 16 ...');
    server = await startEmbedded();
  } else {
    console.log('Using external DATABASE_URL.');
  }
  await migrate();

  const pool = getPool(); // least-privileged app role
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  const auth = new CatalogAuthority();
  const FUTURE = new Date(Date.now() + 3_600_000);

  console.log('Running Phase 1 (DB-authority) suite:\n');

  // 1. Boundary: no TypeScript writes the tables — the DB owns mutation -------
  await test('mutation boundary — no raw write SQL to items|events|provider_refs in TS', () => {
    const writeRe = /\b(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+(events|items|provider_refs)\b/i;
    const offenders = walkTs(SRC_DIR).filter((f) => writeRe.test(readFileSync(f, 'utf8'))).map((f) => path.basename(f));
    assert(offenders.length === 0, `TS files writing tables directly: ${offenders.join(', ')}`);
  });

  // 2. Boundary: zero provider/HTTP imports in core --------------------------
  await test('catalog core imports nothing about providers/HTTP/adapters/Hermes', () => {
    const importRe = /import[^'"]*['"]([^'"]+)['"]/g;
    const forbidden = /(provider(?!_ref)|adapter|hermes|plex|jellyfin|torbox|debrid|axios|node-fetch|undici|express|fastify|\bgot\b|^https?$)/i;
    const bad: string[] = [];
    for (const file of walkTs(CORE_DIR)) {
      for (const m of readFileSync(file, 'utf8').matchAll(importRe)) if (forbidden.test(m[1]!)) bad.push(`${path.basename(file)} -> ${m[1]}`);
    }
    assert(bad.length === 0, `forbidden imports: ${bad.join(', ')}`);
  });

  // 3. No-leak gate: typed rejects + legitimate accepts ----------------------
  await test('no-leak gate — rejects forbidden key / identity-as-reftype / signatures; accepts labels', async () => {
    await assertThrows(() => validateEventPayload('ItemAdded', { title: 'X' }), 'forbidden key');
    await assertThrows(() => validateEventPayload('ProviderRefAttached', { op: 'Top Secret Movie' }), 'title-as-reftype');
    await assertThrows(() => validateEventPayload('ProviderRefAttached', { op: 'magnet:?xt=urn' }), 'magnet');
    await assertThrows(() => validateEventPayload('BehavioralSignal', { weight: 99999 }), 'weight range');
    await assertThrows(() => assertNoLeak('https://t/announce'), 'url signature');
    validateEventPayload('ProviderRefAttached', { op: 'infohash' });
    validateEventPayload('BehavioralSignal', { weight: 3 });
  });

  // 4. No-leak serialization bypass (Codex 2nd pass #1) ----------------------
  await test('no-leak gate — defeats a toJSON() serialization bypass', async () => {
    await reset(admin);
    const id = mintItemId();
    const evil: Record<string, unknown> = { op: 'tmdb' };
    Object.defineProperty(evil, 'toJSON', { value: () => ({ op: 'Top Secret Movie' }), enumerable: false });
    const event: CatalogEvent = { itemId: id, kind: 'structural', type: 'ProviderRefAttached', payload: evil, expiresAt: null };
    await assertThrows(() => auth.apply(event), 'toJSON bypass must be rejected');
    assertEq(await count(pool, `SELECT count(*) AS c FROM events WHERE item_id=$1`, [id]), 0, 'nothing persisted');
  });

  // 5. Opaque item id (Codex 2nd pass #2) ------------------------------------
  await test('item id — non-opaque ids rejected in TS and by DB CHECK', async () => {
    await reset(admin);
    await assertThrows(() => auth.addItem('Top Secret Movie', { title: 't' }), 'non-uuid id rejected (TS)');
    await assertThrows(
      () => admin.query(`INSERT INTO items (id, present) VALUES ('Top Secret Movie', true)`),
      'non-uuid id rejected (DB CHECK)',
    );
    assertEq(await count(pool, `SELECT count(*) AS c FROM items`, []), 0, 'nothing stored');
  });

  // 6. Envelope validation ----------------------------------------------------
  await test('apply — rejects unknown type / wrong kind / bad ttl, persisting nothing', async () => {
    await reset(admin);
    const id = mintItemId();
    const bad: CatalogEvent[] = [
      { itemId: id, kind: 'structural', type: '__nope__', payload: {}, expiresAt: null },
      { itemId: id, kind: 'behavioral', type: 'ItemAdded', payload: {}, expiresAt: null },
      { itemId: id, kind: 'structural', type: 'ItemAdded', payload: {}, expiresAt: new Date() },
      { itemId: id, kind: 'behavioral', type: 'BehavioralSignal', payload: { weight: 1 }, expiresAt: null },
    ];
    for (const e of bad) await assertThrows(() => auth.apply(e), `envelope: ${e.type}/${e.kind}`);
    assertEq(await count(pool, 'SELECT count(*) AS c FROM events', []), 0, 'no event persisted');
  });

  // 7-9. Same-item concurrency ------------------------------------------------
  for (const n of [2, 20, 100]) {
    await test(`same-item concurrency x${n} — serialized, distinct seq, no lost updates`, async () => {
      await reset(admin);
      const id = mintItemId();
      await auth.addItem(id);
      const seqs = await Promise.all(range(n).map(() => auth.recordSignal(id, 1, 60_000)));
      assert(seqs.every((s) => typeof s === 'string'), 'seq is a string');
      assertEq(new Set(seqs).size, n, 'all seqs distinct');
      assertEq(await count(pool, 'SELECT behavioral_score AS c FROM items WHERE id=$1', [id]), n, 'no lost updates');
    });
  }

  // 10. Idempotent first-add --------------------------------------------------
  await test('first-add race — 20 concurrent adds collapse to one ItemAdded', async () => {
    await reset(admin);
    const id = mintItemId();
    await Promise.all(range(20).map(() => auth.addItem(id)));
    assertEq(await count(pool, `SELECT count(*) AS c FROM events WHERE item_id=$1 AND type='ItemAdded'`, [id]), 1, 'one ItemAdded');
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE id=$1 AND present`, [id]), 1, 'one present row');
  });

  // 11. Different-item parallelism -------------------------------------------
  await test('different-item parallelism — 100 parallel adds, no deadlock', async () => {
    await reset(admin);
    const t0 = Date.now();
    await Promise.all(range(100).map(() => auth.addItem(mintItemId())));
    assertEq(await count(pool, 'SELECT count(*) AS c FROM items WHERE present', []), 100, '100 items');
    console.log(`         (100 parallel adds in ${Date.now() - t0}ms)`);
  });

  // 12. Invalid op persists nothing (atomic apply) ---------------------------
  await test('atomicity — attaching a ref to an absent item persists neither event nor projection', async () => {
    await reset(admin);
    const id = mintItemId();
    await assertThrows(() => auth.apply(providerRefAttached(id, 'tmdb')), 'attach to absent item');
    assertEq(await count(pool, 'SELECT count(*) AS c FROM events', []), 0, 'no event');
    assertEq(await count(pool, `SELECT count(*) AS c FROM provider_refs WHERE item_id=$1`, [id]), 0, 'no ref');
  });

  // 13. Deterministic rebuild -------------------------------------------------
  await test('rebuildProjection — deterministic (fixed cutoff) and identity-NULL', async () => {
    await reset(admin);
    const a1 = mintItemId();
    const a2 = mintItemId();
    await auth.addItem(a1, { title: 'T', year: 1999, externalIds: { tmdb: '603' }, metadata: { a: 1 }, providerRefs: [{ type: 'infohash', value: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }] });
    await auth.addItem(a2);
    await auth.forget(a2);
    await auth.rebuildProjection(FUTURE);
    const a = await snapshot(pool);
    await auth.rebuildProjection(FUTURE);
    assertEq(await snapshot(pool), a, 'two rebuilds byte-identical');
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE title IS NOT NULL OR year IS NOT NULL OR external_ids IS NOT NULL OR metadata IS NOT NULL`, []), 0, 'identity NULL');
    assertEq(await count(pool, `SELECT count(*) AS c FROM provider_refs WHERE ref_value IS NOT NULL`, []), 0, 'ref values NULL');
  });

  // 14. Genuine fresh-DB fold + sequence advance (Codex 2nd pass) ------------
  await test('fresh-DB fold — replays into an empty DB, advances identity, and appends cleanly after', async () => {
    await reset(admin);
    const f1 = mintItemId();
    const f2 = mintItemId();
    await auth.addItem(f1, { title: 'X', year: 2001, providerRefs: [{ type: 'tmdb', value: '11' }] });
    await auth.recordSignal(f1, 5, 3_600_000);
    await auth.addItem(f2);
    await auth.forget(f2);
    await auth.rebuildProjection(FUTURE);
    const expected = await snapshot(pool);

    const log = (await admin.query('SELECT seq, item_id, kind, type, payload, expires_at FROM events ORDER BY seq')).rows;
    await reset(admin);
    for (const e of log) {
      await admin.query(
        `INSERT INTO events (seq, item_id, kind, type, payload, expires_at) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [e.seq, e.item_id, e.kind, e.type, JSON.stringify(e.payload), e.expires_at],
      );
    }
    await admin.query(`SELECT setval(pg_get_serial_sequence('events','seq'), (SELECT max(seq) FROM events))`);
    await auth.rebuildProjection(FUTURE);
    assertEq(await snapshot(pool), expected, 'fresh-DB fold matches');

    // append-after-restore: a new mutation must get a fresh seq, no PK clash
    const maxSeq = await count(admin, 'SELECT max(seq) AS c FROM events', []);
    const f3 = mintItemId();
    const newSeq = Number(await auth.addItem(f3));
    assertEq(newSeq, maxSeq + 1, 'sequence advanced past restored max');
  });

  // 15. Forget total + terminal in the APPLY path (Codex 2nd pass #3) ---------
  await test('forget — terminal; cannot be cleared via apply(ItemRestored) or re-add', async () => {
    await reset(admin);
    const id = mintItemId();
    const title = 'Top Secret Movie';
    const hash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    await auth.addItem(id, { title, year: 2020, externalIds: { tmdb: 'x' }, providerRefs: [{ type: 'infohash', value: hash }] });
    await auth.forget(id);

    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE id=$1 AND (title IS NOT NULL OR NOT forgotten OR present)`, [id]), 0, 'identity gone, forgotten');
    for (const r of (await pool.query(`SELECT payload FROM events WHERE item_id=$1`, [id])).rows) {
      const blob = JSON.stringify(r.payload);
      assert(!blob.includes(title) && !blob.includes(hash), 'no identity in payloads');
    }
    await assertThrows(() => auth.addItem(id, { title: 'Resurrected' }), 're-add must fail', /forgotten/i);
    // apply(ItemAdded) on a forgotten item must also be blocked in the apply path:
    await reset(admin);
    const id2 = mintItemId();
    await auth.addItem(id2);
    await auth.forget(id2);
    await assertThrows(() => auth.apply(itemAdded(id2)), 'apply(ItemAdded) on forgotten blocked', /forgotten/i);
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE id=$1 AND forgotten`, [id2]), 1, 'still forgotten');
  });

  // 16. apply(ItemRestored) lifecycle guard ----------------------------------
  await test('apply path — ItemRestored on a non-forgotten item is rejected', async () => {
    await reset(admin);
    const id = mintItemId();
    await auth.addItem(id, { title: 'live' });
    await assertThrows(() => auth.apply(itemRestored(id)), 'restore non-forgotten', /restore requires a forgotten item/i);
  });

  // 17. Forget of an unknown id creates a tombstone (Codex 2nd pass #3) -------
  await test('forget — unknown id creates a tombstone that blocks later resurrection', async () => {
    await reset(admin);
    const id = mintItemId();
    await auth.forget(id); // item never existed
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE id=$1 AND forgotten AND NOT present`, [id]), 1, 'tombstone created');
    await assertThrows(() => auth.addItem(id, { title: 'Resurrected' }), 'add blocked by tombstone', /forgotten/i);
  });

  // 18. Explicit restore ------------------------------------------------------
  await test('restore — explicit, sanctioned reversal of forget', async () => {
    await reset(admin);
    const id = mintItemId();
    await auth.addItem(id, { title: 'Orig' });
    await auth.forget(id);
    await auth.restore(id, { title: 'Back', providerRefs: [{ type: 'tmdb', value: '7' }] });
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE id=$1 AND present AND NOT forgotten AND title='Back'`, [id]), 1, 'restored');
  });

  // 19. Coordinated TTL prune + rebuild --------------------------------------
  await test('pruneAndRebuild — expired behavioral pruned and projection corrected in one cutoff', async () => {
    await reset(admin);
    const id = mintItemId();
    await auth.addItem(id);
    await auth.recordSignal(id, 1, 80);
    await auth.recordSignal(id, 4, 3_600_000);
    const structuralBefore = await count(pool, `SELECT count(*) AS c FROM events WHERE kind='structural'`, []);
    await sleep(250);
    const pruned = await auth.pruneAndRebuild(new Date());
    assert(pruned >= 1, 'expired behavioral pruned');
    assertEq(await count(pool, `SELECT count(*) AS c FROM events WHERE kind='behavioral'`, []), 1, 'only live signal remains');
    assertEq(await count(pool, `SELECT count(*) AS c FROM events WHERE kind='structural'`, []), structuralBefore, 'structural untouched');
    assertEq(await count(pool, `SELECT behavioral_score AS c FROM items WHERE id=$1`, [id]), 4, 'score reflects only live signal');
  });

  // 20. DB authority boundary — app cannot bypass CatalogAuthority -----------
  await test('authority boundary — app role cannot raw-insert events, write the projection, or prune', async () => {
    await reset(admin);
    const id = mintItemId();
    await auth.addItem(id);
    await assertThrows(() => pool.query(`INSERT INTO events (item_id, kind, type, payload) VALUES ($1,'structural','ItemAdded','{"title":"Raw Secret"}'::jsonb)`, [mintItemId()]), 'app INSERT events denied');
    await assertThrows(() => pool.query(`UPDATE items SET title='Raw Secret' WHERE id=$1`, [id]), 'app UPDATE items denied');
    await assertThrows(() => pool.query(`UPDATE events SET type='x'`), 'app UPDATE events denied');
    await assertThrows(() => pool.query(`DELETE FROM events`), 'app DELETE events denied');
    await assertThrows(() => pool.query(`TRUNCATE events`), 'app TRUNCATE denied');
    // no bare prune is exposed at all
    await assertThrows(() => pool.query(`SELECT prune_expired_behavioral(now())`), 'no bare prune function');
  });

  // 21. Append-only trigger layer (even the owner is blocked) -----------------
  await test('append-only — triggers block the owner from UPDATE / structural DELETE / TRUNCATE', async () => {
    await reset(admin);
    await auth.addItem(mintItemId());
    await assertThrows(() => admin.query(`UPDATE events SET type='x' WHERE seq=(SELECT min(seq) FROM events)`), 'owner UPDATE blocked');
    await assertThrows(() => admin.query(`DELETE FROM events WHERE kind='structural'`), 'owner structural DELETE blocked');
    await assertThrows(() => admin.query(`TRUNCATE events`), 'owner TRUNCATE blocked');
  });

  // 22. Rejected values never reach an error message (Codex 3rd pass #2) ------
  await test('no-leak — rejected values never appear in error messages (DB + TS)', async () => {
    await reset(admin);
    const sensitive = 'Top Secret Movie';
    const id = mintItemId();
    let m1 = '';
    try { await pool.query('SELECT cat_apply($1,$2,$3::jsonb,$4)', [id, 'ProviderRefAttached', JSON.stringify({ op: sensitive }), null]); }
    catch (e) { m1 = (e as Error).message; }
    assert(m1.length > 0 && !m1.includes(sensitive), `ref-type rejection leaked the value: ${m1}`);

    let m2 = '';
    try { await pool.query('SELECT cat_apply($1,$2,$3::jsonb,$4)', [id, 'WeirdSecretType', '{}', null]); }
    catch (e) { m2 = (e as Error).message; }
    assert(m2.length > 0 && !m2.includes('WeirdSecretType'), `unknown-type rejection leaked the value: ${m2}`);

    let m3 = '';
    try { validateEventPayload('ProviderRefAttached', { op: sensitive }); } catch (e) { m3 = (e as Error).message; }
    assert(m3.length > 0 && !m3.includes(sensitive), `TS gate leaked the value: ${m3}`);
  });

  // 23. Upgrade path: legacy schema -> current migration (Codex 3rd pass #1,#3)
  await test('upgrade path — applying current migration over a legacy schema closes the bypasses', async () => {
    const legacySql = readFileSync(fileURLToPath(new URL('./fixtures/legacy-migrations.sql', import.meta.url)), 'utf8');
    const currentSql = readFileSync(fileURLToPath(new URL('../src/db/migrations.sql', import.meta.url)), 'utf8');
    await admin.query('DROP DATABASE IF EXISTS upgrade_test');
    await admin.query('CREATE DATABASE upgrade_test');

    const toUpgradeDb = (u: string) => u.replace(/\/catalog(\?|$)/, '/upgrade_test$1');
    const ownerU = new Client({ connectionString: toUpgradeDb(adminUrl()) });
    await ownerU.connect();
    let appU: Client | null = null;
    try {
      await ownerU.query(legacySql);  // simulate an existing legacy deployment
      // sanity: the legacy deployment HAS the bypass before upgrading
      await ownerU.query('SELECT prune_expired_behavioral(now())');
      await ownerU.query(currentSql); // apply the upgrade

      appU = new Client({ connectionString: toUpgradeDb(process.env.DATABASE_URL!) });
      await appU.connect();

      // 1. the prune bypass is gone (function dropped)
      await assertThrows(() => appU!.query('SELECT prune_expired_behavioral(now())'), 'legacy prune dropped', /does not exist/i);
      // 2. the opaque-id CHECK now exists on the upgraded table
      await assertThrows(() => ownerU.query(`INSERT INTO items (id, present) VALUES ('Top Secret Movie', true)`), 'uuid check added');
      // 3. legacy app DML grants are revoked
      await assertThrows(() => appU!.query(`INSERT INTO events (item_id,kind,type,payload) VALUES ('x','structural','ItemAdded','{}'::jsonb)`), 'app INSERT revoked');
      await assertThrows(() => appU!.query(`UPDATE items SET title='x'`), 'app UPDATE revoked');
      // 4. the upgraded DB is functional through the authority surface
      const r = await appU!.query('SELECT cat_add_item($1,NULL,NULL,NULL,NULL,$2::jsonb) AS seq', [mintItemId(), '[]']);
      assert(Number(r.rows[0].seq) > 0, 'authority works after upgrade');
    } finally {
      if (appU) await appU.end();
      await ownerU.end();
      await admin.query('DROP DATABASE IF EXISTS upgrade_test');
    }
  });

  // --- teardown -------------------------------------------------------------
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
