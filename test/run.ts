import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, type Pool } from 'pg';

import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority, ForgottenItemError } from '../src/core/catalog/authority.js';
import type { CatalogEvent } from '../src/core/catalog/events.js';
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
async function assertThrows(fn: () => Promise<unknown>, msg: string): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`expected to throw: ${msg}`);
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

async function count(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query(sql, params);
  return Number(rows[0].c);
}

/** Owner-only reset: disable triggers so the (otherwise append-only) log can be wiped. */
async function reset(admin: Client): Promise<void> {
  await admin.query("SET session_replication_role = 'replica'");
  await admin.query('TRUNCATE events, provider_refs, items RESTART IDENTITY CASCADE');
  await admin.query("SET session_replication_role = 'origin'");
}

async function snapshot(pool: Pool): Promise<string> {
  const items = await pool.query(
    `SELECT id, present, forgotten, behavioral_score, last_seq,
            title, year, external_ids, metadata
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

  const pool = getPool(); // app role (least privilege)
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  const auth = new CatalogAuthority();
  const FUTURE = new Date(Date.now() + 3_600_000); // fixed cutoff for rebuild determinism

  console.log('Running Phase 1 (hardened) suite:\n');

  // 1. Static: mutation boundary -------------------------------------------
  await test('mutation boundary — only reducer.ts/authority.ts write items|provider_refs', () => {
    const writeRe = /\b(INSERT INTO|UPDATE|DELETE FROM)\s+(items|provider_refs)\b/i;
    const offenders = walkTs(SRC_DIR)
      .filter((f) => writeRe.test(readFileSync(f, 'utf8')))
      .map((f) => path.basename(f));
    const illegal = offenders.filter((f) => !['reducer.ts', 'authority.ts'].includes(f));
    assert(illegal.length === 0, `unexpected writers: ${illegal.join(', ')}`);
  });

  // 2. Static: zero provider/HTTP imports in the catalog core --------------
  await test('catalog core imports nothing about providers/HTTP/adapters/Hermes', () => {
    const importRe = /import[^'"]*['"]([^'"]+)['"]/g;
    const forbidden = /(provider(?!_ref)|adapter|hermes|plex|jellyfin|torbox|debrid|axios|node-fetch|undici|express|fastify|\bgot\b|^https?$)/i;
    const bad: string[] = [];
    for (const file of walkTs(CORE_DIR)) {
      for (const m of readFileSync(file, 'utf8').matchAll(importRe)) {
        if (forbidden.test(m[1]!)) bad.push(`${path.basename(file)} -> ${m[1]}`);
      }
    }
    assert(bad.length === 0, `forbidden imports: ${bad.join(', ')}`);
  });

  // 3. No-leak gate: forbidden key -----------------------------------------
  await test('no-leak gate — rejects a forbidden identity key', () => {
    assertThrows(async () => validateEventPayload('ItemAdded', { title: 'The Matrix' }), 'title key');
  });

  // 4. No-leak gate: the exact Codex bypass + signatures -------------------
  await test('no-leak gate — rejects identity smuggled as a ref type (Codex bypass) + signatures', () => {
    // {op: "Top Secret Movie"} must NOT pass ProviderRefAttached anymore.
    assertThrows(async () => validateEventPayload('ProviderRefAttached', { op: 'Top Secret Movie' }), 'title-as-reftype');
    assertThrows(async () => validateEventPayload('ProviderRefAttached', { op: 'magnet:?xt=urn:btih:x' }), 'magnet');
    assertThrows(async () => validateEventPayload('ProviderRefAttached', { op: 'INFOHASH' }), 'uppercase/charset');
    assertThrows(async () => validateEventPayload('BehavioralSignal', { weight: 99999 }), 'weight range');
    assertThrows(async () => assertNoLeak('https://tracker/announce'), 'url signature');
  });

  // 5. No-leak gate: legitimate label + weight pass ------------------------
  await test('no-leak gate — accepts the operational label "infohash" and a bounded weight', () => {
    validateEventPayload('ProviderRefAttached', { op: 'infohash' });
    validateEventPayload('ProviderRefAttached', { op: 'tmdb' });
    validateEventPayload('BehavioralSignal', { weight: 3 });
    validateEventPayload('ItemForgotten', {});
  });

  // 6. Envelope validation --------------------------------------------------
  await test('apply — rejects unknown type / wrong kind / bad ttl, persisting nothing', async () => {
    await reset(admin);
    const before = await count(pool, 'SELECT count(*) AS c FROM events', []);
    const bad: CatalogEvent[] = [
      { itemId: 'x', kind: 'structural', type: '__nope__', payload: {}, expiresAt: null },
      { itemId: 'x', kind: 'behavioral', type: 'ItemAdded', payload: {}, expiresAt: null }, // wrong kind
      { itemId: 'x', kind: 'structural', type: 'ItemAdded', payload: {}, expiresAt: new Date() }, // ttl on structural
      { itemId: 'x', kind: 'behavioral', type: 'BehavioralSignal', payload: { weight: 1 }, expiresAt: null }, // missing ttl
    ];
    for (const e of bad) await assertThrows(() => auth.apply(e), `envelope: ${e.type}/${e.kind}`);
    assertEq(await count(pool, 'SELECT count(*) AS c FROM events', []), before, 'no event persisted');
  });

  // 7-9. Same-item concurrency: serialize, distinct seq, no lost updates ----
  for (const n of [2, 20, 100]) {
    await test(`same-item concurrency x${n} — serialized, distinct seq, no lost updates`, async () => {
      await reset(admin);
      const id = `conc-${n}`;
      await auth.addItem(id);
      const seqs = await Promise.all(range(n).map(() => auth.recordSignal(id, 1, 60_000)));
      assert(seqs.every((s) => typeof s === 'string'), 'seq is a string (no unsafe Number)');
      assertEq(new Set(seqs).size, n, 'all returned seqs distinct');
      assertEq(await count(pool, 'SELECT behavioral_score AS c FROM items WHERE id=$1', [id]), n, 'no lost updates');
      assertEq(await count(pool, `SELECT count(*) AS c FROM events WHERE item_id=$1 AND kind='behavioral'`, [id]), n, 'one event per signal');
    });
  }

  // 10. First-add race is now idempotent -----------------------------------
  await test('first-add race — 20 concurrent adds collapse to one ItemAdded', async () => {
    await reset(admin);
    const id = 'race-new';
    await Promise.all(range(20).map(() => auth.addItem(id))); // must not throw
    assertEq(await count(pool, `SELECT count(*) AS c FROM events WHERE item_id=$1 AND type='ItemAdded'`, [id]), 1, 'exactly one ItemAdded');
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE id=$1 AND present`, [id]), 1, 'one present row');
  });

  // 11. Different-item parallelism, no deadlock ----------------------------
  await test('different-item parallelism — 100 parallel adds, no deadlock', async () => {
    await reset(admin);
    const t0 = Date.now();
    await Promise.all(range(100).map((i) => auth.addItem(`par-${i}`)));
    assertEq(await count(pool, 'SELECT count(*) AS c FROM items WHERE present', []), 100, '100 items created');
    console.log(`         (100 parallel adds in ${Date.now() - t0}ms)`);
  });

  // 12. Rollback atomicity — failure AFTER the event insert -----------------
  await test('rollback atomicity — reduce failure after insert persists neither event nor projection', async () => {
    await reset(admin);
    const before = await count(pool, 'SELECT count(*) AS c FROM events', []);
    // ProviderRefAttached for a non-existent item: event inserts, then the
    // provider_refs FK fails inside reduce -> whole txn rolls back.
    await assertThrows(
      () => auth.apply({ itemId: 'ghost', kind: 'structural', type: 'ProviderRefAttached', payload: { op: 'tmdb' }, expiresAt: null }),
      'reduce FK failure',
    );
    assertEq(await count(pool, 'SELECT count(*) AS c FROM events', []), before, 'no event persisted');
    assertEq(await count(pool, `SELECT count(*) AS c FROM provider_refs WHERE item_id='ghost'`, []), 0, 'no projection row');
  });

  // 13. Deterministic rebuild ----------------------------------------------
  await test('rebuildProjection — deterministic (fixed cutoff) and identity-NULL', async () => {
    await reset(admin);
    await auth.addItem('m1', {
      title: 'Title One', year: 1999, externalIds: { tmdb: '603' }, metadata: { a: 1 },
      providerRefs: [{ type: 'infohash', value: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }],
    });
    await auth.addItem('m2');
    await auth.forget('m2');

    await auth.rebuildProjection(FUTURE);
    const a = await snapshot(pool);
    await auth.rebuildProjection(FUTURE);
    const b = await snapshot(pool);
    assertEq(a, b, 'two rebuilds byte-identical');
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE title IS NOT NULL OR year IS NOT NULL OR external_ids IS NOT NULL OR metadata IS NOT NULL`, []), 0, 'identity NULL after rebuild');
    assertEq(await count(pool, `SELECT count(*) AS c FROM provider_refs WHERE ref_value IS NOT NULL`, []), 0, 'ref values NULL after rebuild');
  });

  // 14. Genuine fresh-DB refold --------------------------------------------
  await test('fresh-DB fold — replaying the log into an empty database reproduces the projection', async () => {
    await reset(admin);
    await auth.addItem('f1', { title: 'X', year: 2001, providerRefs: [{ type: 'tmdb', value: '11' }] });
    await auth.recordSignal('f1', 5, 3_600_000);
    await auth.addItem('f2');
    await auth.forget('f2');

    await auth.rebuildProjection(FUTURE);
    const expected = await snapshot(pool);

    // capture the log, wipe EVERYTHING, re-insert events with their original seq
    const log = (await admin.query('SELECT seq, item_id, kind, type, payload, expires_at FROM events ORDER BY seq')).rows;
    await reset(admin);
    for (const e of log) {
      await admin.query(
        `INSERT INTO events (seq, item_id, kind, type, payload, expires_at)
         OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [e.seq, e.item_id, e.kind, e.type, JSON.stringify(e.payload), e.expires_at],
      );
    }
    await auth.rebuildProjection(FUTURE);
    assertEq(await snapshot(pool), expected, 'fresh-DB fold matches');
  });

  // 15. Forget is total and TERMINAL ---------------------------------------
  await test('forget — erases identity from projection, stays opaque, and is terminal', async () => {
    await reset(admin);
    const title = 'Top Secret Movie';
    const hash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    await auth.addItem('s1', { title, year: 2020, externalIds: { tmdb: 'x' }, metadata: { n: 'p' }, providerRefs: [{ type: 'infohash', value: hash }] });
    await auth.forget('s1');

    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE id='s1' AND (title IS NOT NULL OR year IS NOT NULL OR external_ids IS NOT NULL OR metadata IS NOT NULL OR NOT forgotten OR present)`, []), 0, 'identity nulled, forgotten/absent');
    assertEq(await count(pool, `SELECT count(*) AS c FROM provider_refs WHERE item_id='s1' AND (ref_value IS NOT NULL OR present)`, []), 0, 'ref value cleared');

    for (const r of (await pool.query(`SELECT payload FROM events WHERE item_id='s1'`)).rows) {
      validateEventPayload('ItemForgotten', {}); // sanity
      const blob = JSON.stringify(r.payload);
      assert(!blob.includes(title) && !blob.includes(hash), 'no identity in event payloads');
    }

    // terminal: a plain re-add must be rejected, not silently resurrect
    let forgottenErr = false;
    try {
      await auth.addItem('s1', { title: 'Resurrected' });
    } catch (e) {
      forgottenErr = e instanceof ForgottenItemError;
    }
    assert(forgottenErr, 'addItem after forget must throw ForgottenItemError');
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE id='s1' AND title IS NOT NULL`, []), 0, 'identity stayed gone');
  });

  // 16. Explicit restore ----------------------------------------------------
  await test('restore — explicit, sanctioned reversal of forget', async () => {
    await reset(admin);
    await auth.addItem('r1', { title: 'Orig' });
    await auth.forget('r1');
    await assertThrows(() => auth.restore('nope'), 'restore non-existent');
    await auth.restore('r1', { title: 'Back', providerRefs: [{ type: 'tmdb', value: '7' }] });
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE id='r1' AND present AND NOT forgotten AND title='Back'`, []), 1, 'restored present + identity');
  });

  // 17. Coordinated TTL prune + rebuild ------------------------------------
  await test('pruneAndRebuild — expired behavioral pruned and projection corrected in one cutoff', async () => {
    await reset(admin);
    await auth.addItem('t1');
    await auth.recordSignal('t1', 1, 80); // expires quickly
    await auth.recordSignal('t1', 4, 3_600_000); // long-lived
    const structuralBefore = await count(pool, `SELECT count(*) AS c FROM events WHERE kind='structural'`, []);
    await sleep(250);

    const cutoff = new Date();
    const pruned = await auth.pruneAndRebuild(cutoff);
    assert(pruned >= 1, 'at least one expired behavioral pruned');
    assertEq(await count(pool, `SELECT count(*) AS c FROM events WHERE kind='behavioral'`, []), 1, 'only the live signal remains');
    assertEq(await count(pool, `SELECT count(*) AS c FROM events WHERE kind='structural'`, []), structuralBefore, 'structural untouched');
    assertEq(await count(pool, `SELECT behavioral_score AS c FROM items WHERE id='t1'`, []), 4, 'score reflects only the live signal');
  });

  // 18. Append-only — privilege layer (app role) ---------------------------
  await test('append-only — app role is denied UPDATE/DELETE/TRUNCATE on events', async () => {
    await reset(admin);
    await auth.addItem('p1');
    await assertThrows(() => pool.query(`UPDATE events SET type='x'`), 'app UPDATE denied');
    await assertThrows(() => pool.query(`DELETE FROM events`), 'app DELETE denied');
    await assertThrows(() => pool.query(`TRUNCATE events`), 'app TRUNCATE denied');
  });

  // 19. Append-only — trigger layer (even the owner is blocked) -------------
  await test('append-only — triggers block the owner from UPDATE / structural DELETE / TRUNCATE', async () => {
    await reset(admin);
    await auth.addItem('o1');
    await assertThrows(() => admin.query(`UPDATE events SET type='x' WHERE seq=(SELECT min(seq) FROM events)`), 'owner UPDATE blocked');
    await assertThrows(() => admin.query(`DELETE FROM events WHERE kind='structural'`), 'owner structural DELETE blocked');
    await assertThrows(() => admin.query(`TRUNCATE events`), 'owner TRUNCATE blocked');
  });

  // --- teardown -----------------------------------------------------------
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
