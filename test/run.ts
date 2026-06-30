import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, type Pool } from 'pg';

import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { validateEventPayload } from '../src/core/redaction/noleak.js';
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
async function assertThrows(fn: () => Promise<unknown> | unknown, msg: string, match?: RegExp): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (match && !match.test((e as Error).message)) throw new Error(`threw, message ${JSON.stringify((e as Error).message)} != ${match} (${msg})`);
    return;
  }
  throw new Error(`expected to throw: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

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

async function count(pool: Pool | Client, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query(sql, params);
  return Number(rows[0].c);
}
async function reset(admin: Client): Promise<void> {
  await admin.query("SET session_replication_role = 'replica'");
  await admin.query('TRUNCATE events, provider_refs, items, item_key_control RESTART IDENTITY CASCADE');
  await admin.query("SET session_replication_role = 'origin'");
}
async function snapshot(pool: Pool): Promise<string> {
  const items = await pool.query(
    `SELECT id, present, forgotten, behavioral_score, last_seq, encode(identity_ct,'hex') AS identity_ct
       FROM items ORDER BY id`,
  );
  const refs = await pool.query(
    `SELECT item_id, ref_type, present, encode(ref_value_ct,'hex') AS ref_value_ct
       FROM provider_refs ORDER BY item_id, ref_type`,
  );
  return JSON.stringify({ items: items.rows, refs: refs.rows });
}

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) {
    console.log('Booting embedded PostgreSQL 16 ...');
    server = await startEmbedded();
  } else {
    console.log('Using external DATABASE_URL.');
  }
  await migrate();
  const pool = getPool();
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  const auth = new CatalogAuthority();
  const FUTURE = new Date(Date.now() + 3_600_000);

  console.log('Running Phase 1/2 authority suite (encrypted identity):\n');

  // 1-2. static boundary scans ----------------------------------------------
  await test('mutation boundary — no raw write SQL to the tables in TS', () => {
    const writeRe = /\b(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+(events|items|provider_refs|item_key_control)\b/i;
    const offenders = walkTs(SRC_DIR).filter((f) => writeRe.test(readFileSync(f, 'utf8'))).map((f) => path.basename(f));
    assert(offenders.length === 0, `TS files writing tables directly: ${offenders.join(', ')}`);
  });
  await test('core imports nothing about providers/HTTP/adapters/Hermes', () => {
    const importRe = /import[^'"]*['"]([^'"]+)['"]/g;
    const forbidden = /(provider(?!_ref)|adapter|hermes|plex|jellyfin|torbox|debrid|axios|node-fetch|undici|express|fastify|\bgot\b|^https?$)/i;
    const bad: string[] = [];
    for (const file of walkTs(CORE_DIR)) for (const m of readFileSync(file, 'utf8').matchAll(importRe)) if (forbidden.test(m[1]!)) bad.push(`${path.basename(file)} -> ${m[1]}`);
    assert(bad.length === 0, `forbidden imports: ${bad.join(', ')}`);
  });

  // 3. no-leak gate ----------------------------------------------------------
  await test('no-leak gate — typed payload validation (reject identity-as-reftype / accept labels)', async () => {
    await assertThrows(() => validateEventPayload('ItemAdded', { title: 'X' }), 'forbidden key');
    await assertThrows(() => validateEventPayload('ProviderRefAttached', { op: 'Top Secret Movie' }), 'title-as-reftype');
    // toJSON bypass: validating the parsed-serialized value still rejects
    const evil: Record<string, unknown> = { op: 'tmdb' };
    Object.defineProperty(evil, 'toJSON', { value: () => ({ op: 'Top Secret Movie' }), enumerable: false });
    await assertThrows(() => validateEventPayload('ProviderRefAttached', JSON.parse(JSON.stringify(evil))), 'toJSON bypass');
    validateEventPayload('ProviderRefAttached', { op: 'infohash' });
  });

  // 4. opaque id -------------------------------------------------------------
  await test('item id — non-opaque rejected in TS and by DB CHECK', async () => {
    await reset(admin);
    await assertThrows(() => auth.addItem('Top Secret Movie', { title: 't' }), 'TS reject');
    await assertThrows(() => admin.query(`INSERT INTO items (id, present) VALUES ('Top Secret Movie', true)`), 'DB CHECK reject');
  });

  // 5-7. same-item concurrency ----------------------------------------------
  for (const n of [2, 20, 100]) {
    await test(`same-item concurrency x${n} — distinct seq, no lost updates`, async () => {
      await reset(admin);
      const id = mintItemId();
      await auth.addItem(id);
      const seqs = await Promise.all(range(n).map(() => auth.recordSignal(id, 1, 60_000)));
      assertEq(new Set(seqs).size, n, 'distinct seqs');
      assertEq(await count(pool, 'SELECT behavioral_score AS c FROM items WHERE id=$1', [id]), n, 'no lost updates');
    });
  }

  // 8. first-add race / winner selection ------------------------------------
  await test('first-add race — 20 concurrent adds collapse to one lineage', async () => {
    await reset(admin);
    const id = mintItemId();
    await Promise.all(range(20).map(() => auth.addItem(id)));
    assertEq(await count(pool, `SELECT count(*) AS c FROM events WHERE item_id=$1 AND type='ItemAdded'`, [id]), 1, 'one ItemAdded');
    assertEq(await count(pool, `SELECT count(*) AS c FROM item_key_control WHERE item_id=$1`, [id]), 1, 'one key-control row');
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE id=$1 AND present`, [id]), 1, 'one present row');
  });

  // 9. different-item parallelism -------------------------------------------
  await test('different-item parallelism — 100 parallel adds, no deadlock', async () => {
    await reset(admin);
    const t0 = Date.now();
    await Promise.all(range(100).map(() => auth.addItem(mintItemId())));
    assertEq(await count(pool, 'SELECT count(*) AS c FROM items WHERE present', []), 100, '100 items');
    console.log(`         (100 parallel adds in ${Date.now() - t0}ms)`);
  });

  // 10. rollback atomicity (owner cat_apply on absent item) ------------------
  await test('atomicity — applying a ref to an absent item persists nothing', async () => {
    await reset(admin);
    const id = mintItemId();
    await assertThrows(() => admin.query(`SELECT cat_apply($1,'ProviderRefAttached','{"op":"tmdb"}'::jsonb,NULL)`, [id]), 'absent-item attach');
    assertEq(await count(pool, 'SELECT count(*) AS c FROM events', []), 0, 'no event');
  });

  // 11. deterministic rebuild ------------------------------------------------
  await test('rebuildProjection — deterministic; identity ciphertext cleared', async () => {
    await reset(admin);
    const a1 = mintItemId();
    await auth.addItem(a1, { title: 'T', providerRefs: [{ type: 'infohash', value: 'deadbeef' }] });
    await auth.rebuildProjection(FUTURE);
    const a = await snapshot(pool);
    await auth.rebuildProjection(FUTURE);
    assertEq(await snapshot(pool), a, 'two rebuilds identical');
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE identity_ct IS NOT NULL`, []), 0, 'identity_ct cleared');
    assertEq(await count(pool, `SELECT count(*) AS c FROM provider_refs WHERE ref_value_ct IS NOT NULL`, []), 0, 'ref ct cleared');
  });

  // 12. fresh-DB fold + sequence advance ------------------------------------
  await test('fresh-DB fold — replay into an empty DB, advance identity, append cleanly', async () => {
    await reset(admin);
    const f1 = mintItemId();
    const f2 = mintItemId();
    await auth.addItem(f1, { title: 'X' });
    await auth.recordSignal(f1, 5, 3_600_000);
    await auth.addItem(f2);
    await auth.forget(f2);
    await auth.rebuildProjection(FUTURE);
    const expected = await snapshot(pool);
    const log = (await admin.query('SELECT seq, item_id, kind, type, payload, expires_at FROM events ORDER BY seq')).rows;
    await reset(admin);
    for (const e of log) {
      await admin.query(`INSERT INTO events (seq,item_id,kind,type,payload,expires_at) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [e.seq, e.item_id, e.kind, e.type, JSON.stringify(e.payload), e.expires_at]);
    }
    await admin.query(`SELECT setval(pg_get_serial_sequence('events','seq'), (SELECT max(seq) FROM events))`);
    await auth.rebuildProjection(FUTURE);
    assertEq(await snapshot(pool), expected, 'fresh-DB fold matches');
    const maxSeq = await count(admin, 'SELECT max(seq) AS c FROM events', []);
    await auth.recordSignal(f1, 1, 60_000); // f1 is present after fold
    assertEq(await count(admin, 'SELECT max(seq) AS c FROM events', []), maxSeq + 1, 'sequence advanced');
  });

  // 13. forget — identity erased, opaque, terminal --------------------------
  await test('forget — clears ciphertext, denies reads, stays opaque, is terminal', async () => {
    await reset(admin);
    const id = mintItemId();
    await auth.addItem(id, { title: 'Top Secret Movie', providerRefs: [{ type: 'infohash', value: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }] });
    assert((await auth.readIdentity(id)) !== null, 'readable before forget');
    const state = await auth.forget(id);
    assertEq(state, 'shred_complete', 'shred completes');
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE id=$1 AND (identity_ct IS NOT NULL OR NOT forgotten OR present)`, [id]), 0, 'ciphertext cleared, forgotten');
    assert((await auth.readIdentity(id)) === null, 'unreadable after forget');
    for (const r of (await pool.query(`SELECT payload FROM events WHERE item_id=$1`, [id])).rows) {
      assert(!JSON.stringify(r.payload).includes('Top Secret'), 'no identity in payloads');
    }
    await assertThrows(() => auth.addItem(id, { title: 'Resurrected' }), 're-add blocked', /forgotten/i);
  });

  // 14. restore --------------------------------------------------------------
  await test('restore — only after forget; recovers identity under a fresh lineage', async () => {
    await reset(admin);
    const id = mintItemId();
    await auth.addItem(id, { title: 'Orig' });
    await assertThrows(() => auth.restore(id, { title: 'Nope' }), 'restore on active rejected', /completed shred/i);
    await auth.forget(id);
    await auth.restore(id, { title: 'Back', providerRefs: [{ type: 'tmdb', value: '7' }] });
    const got = await auth.readIdentity(id);
    assertEq(got?.title, 'Back', 'restored identity readable');
  });

  // 15. forget unknown id tombstone -----------------------------------------
  await test('forget — unknown id creates a tombstone that blocks resurrection', async () => {
    await reset(admin);
    const id = mintItemId();
    await auth.forget(id);
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE id=$1 AND forgotten AND NOT present`, [id]), 1, 'tombstone');
    await assertThrows(() => auth.addItem(id, { title: 'x' }), 'add blocked', /forgotten/i);
  });

  // 16. TTL prune + rebuild --------------------------------------------------
  await test('pruneAndRebuild — expired behavioral pruned; score corrected', async () => {
    await reset(admin);
    const id = mintItemId();
    await auth.addItem(id);
    await auth.recordSignal(id, 1, 80);
    await auth.recordSignal(id, 4, 3_600_000);
    const structuralBefore = await count(pool, `SELECT count(*) AS c FROM events WHERE kind='structural'`, []);
    await sleep(250);
    const pruned = await auth.pruneAndRebuild(new Date());
    assert(pruned >= 1, 'expired pruned');
    assertEq(await count(pool, `SELECT count(*) AS c FROM events WHERE kind='behavioral'`, []), 1, 'one signal remains');
    assertEq(await count(pool, `SELECT count(*) AS c FROM events WHERE kind='structural'`, []), structuralBefore, 'structural untouched');
    assertEq(await count(pool, `SELECT behavioral_score AS c FROM items WHERE id=$1`, [id]), 4, 'score reflects live signal');
  });

  // 17. authority boundary ---------------------------------------------------
  await test('authority boundary — app cannot bypass the command surface', async () => {
    await reset(admin);
    const id = mintItemId();
    await auth.addItem(id);
    await assertThrows(() => pool.query(`INSERT INTO events (item_id,kind,type,payload) VALUES ($1,'structural','ItemAdded','{}'::jsonb)`, [mintItemId()]), 'app INSERT events denied');
    await assertThrows(() => pool.query(`UPDATE items SET present=false WHERE id=$1`, [id]), 'app UPDATE items denied');
    await assertThrows(() => pool.query(`UPDATE item_key_control SET shred_state='active' WHERE item_id=$1`, [id]), 'app UPDATE key-control denied');
    await assertThrows(() => pool.query(`SELECT cat_apply($1,'ItemForgotten','{}'::jsonb,NULL)`, [id]), 'app cannot call raw cat_apply');
    await assertThrows(() => pool.query(`TRUNCATE events`), 'app TRUNCATE denied');
  });

  // 18. append-only triggers (owner) ----------------------------------------
  await test('append-only — triggers block owner UPDATE / structural DELETE / TRUNCATE', async () => {
    await reset(admin);
    await auth.addItem(mintItemId());
    await assertThrows(() => admin.query(`UPDATE events SET type='x' WHERE seq=(SELECT min(seq) FROM events)`), 'owner UPDATE blocked');
    await assertThrows(() => admin.query(`DELETE FROM events WHERE kind='structural'`), 'owner structural DELETE blocked');
    await assertThrows(() => admin.query(`TRUNCATE events`), 'owner TRUNCATE blocked');
  });

  // 19. no-leak in errors ----------------------------------------------------
  await test('no-leak — a rejected ref type never appears in the error message', async () => {
    await reset(admin);
    const id = mintItemId();
    let msg = '';
    try { await auth.addItem(id, { providerRefs: [{ type: 'Top Secret Movie', value: 'x' }] }); }
    catch (e) { msg = (e as Error).message; }
    assert(msg.length > 0 && !msg.includes('Top Secret Movie'), `ref-type rejection leaked value: ${msg}`);
  });

  // 20. pg_temp shadowing ----------------------------------------------------
  await test('SECURITY DEFINER — pg_temp shadowing cannot split the store', async () => {
    await reset(admin);
    await assertThrows(() => pool.query('CREATE TEMP TABLE events (x int)'), 'app cannot create temp tables');
    const shadower = new Client({ connectionString: adminUrl() });
    await shadower.connect();
    try {
      await shadower.query(`CREATE TEMP TABLE events (seq bigint, item_id text, kind text, type text, payload jsonb, created_at timestamptz, expires_at timestamptz)`);
      const id = mintItemId();
      await shadower.query('SELECT cat_add_item_ct($1,$2,$3,$4,$5,$6::jsonb)', [id, randomOp(), 'key_x', 0, Buffer.from([1, 2, 3]), '[]']);
      assertEq(Number((await shadower.query(`SELECT count(*) AS c FROM public.events WHERE item_id=$1`, [id])).rows[0].c), 1, 'event in public.events');
      assertEq(Number((await shadower.query(`SELECT count(*) AS c FROM pg_temp.events`)).rows[0].c), 0, 'nothing in pg_temp shadow');
    } finally {
      await shadower.end();
    }
  });

  // 21. upgrade path ---------------------------------------------------------
  await test('upgrade path — legacy schema then current migration closes bypasses', async () => {
    const legacySql = readFileSync(fileURLToPath(new URL('./fixtures/legacy-migrations.sql', import.meta.url)), 'utf8');
    const currentSql = readFileSync(fileURLToPath(new URL('../src/db/migrations.sql', import.meta.url)), 'utf8');
    await admin.query('DROP DATABASE IF EXISTS upgrade_test');
    await admin.query('CREATE DATABASE upgrade_test');
    const toUp = (u: string) => u.replace(/\/catalog(\?|$)/, '/upgrade_test$1');
    const ownerU = new Client({ connectionString: toUp(adminUrl()) });
    await ownerU.connect();
    let appU: Client | null = null;
    try {
      await ownerU.query(legacySql);
      await ownerU.query('SELECT prune_expired_behavioral(now())'); // legacy bypass exists pre-upgrade
      await ownerU.query(currentSql);
      appU = new Client({ connectionString: toUp(process.env.DATABASE_URL!) });
      await appU.connect();
      await assertThrows(() => appU!.query('SELECT prune_expired_behavioral(now())'), 'legacy prune dropped', /does not exist/i);
      await assertThrows(() => ownerU.query(`INSERT INTO items (id, present) VALUES ('Top Secret Movie', true)`), 'uuid check added');
      await assertThrows(() => appU!.query(`INSERT INTO events (item_id,kind,type,payload) VALUES ('x','structural','ItemAdded','{}'::jsonb)`), 'app INSERT revoked');
      const r = await appU!.query('SELECT cat_add_item_ct($1,$2,$3,$4,$5,$6::jsonb) AS committed', [mintItemId(), randomOp(), 'key_u', 0, Buffer.from([9]), '[]']);
      assert(r.rows[0].committed === true, 'authority works after upgrade');
    } finally {
      if (appU) await appU.end();
      await ownerU.end();
      await admin.query('DROP DATABASE IF EXISTS upgrade_test');
    }
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

function randomOp(): string {
  return 'op_' + randomUUID();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
