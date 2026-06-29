import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import type { CatalogEvent } from '../src/core/catalog/events.js';
import { assertNoLeak } from '../src/core/redaction/noleak.js';
import { getPool, migrate, closePool } from '../src/db/pool.js';

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

async function reset(pool: Pool): Promise<void> {
  // TRUNCATE does not fire the row-level append-only trigger, so it is the
  // only sanctioned way to reset the log between isolated tests.
  await pool.query('TRUNCATE events, provider_refs, items RESTART IDENTITY CASCADE');
}

async function count(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query(sql, params);
  return Number(rows[0].c);
}

async function snapshot(pool: Pool): Promise<string> {
  // updated_at is excluded — it is now()-stamped and not part of derived state.
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
  console.log('Booting embedded PostgreSQL 16 ...');
  const server = await startEmbedded();
  await migrate();
  const pool = getPool();
  const auth = new CatalogAuthority();
  console.log('Running Phase 1 suite:\n');

  // 1. Static: mutation boundary -------------------------------------------
  await test('mutation boundary — only reducer.ts/authority.ts write items|provider_refs', () => {
    const writeRe = /\b(INSERT INTO|UPDATE|DELETE FROM)\s+(items|provider_refs)\b/i;
    const offenders = walkTs(SRC_DIR)
      .filter((f) => writeRe.test(readFileSync(f, 'utf8')))
      .map((f) => path.basename(f))
      .sort();
    const allowed = new Set(['reducer.ts', 'authority.ts']);
    const illegal = offenders.filter((f) => !allowed.has(f));
    assert(illegal.length === 0, `unexpected writers: ${illegal.join(', ')}`);
    assert(offenders.includes('reducer.ts'), 'expected reducer.ts to be a writer');
  });

  // 2. Static: zero provider/HTTP imports in the catalog core --------------
  await test('catalog core imports nothing about providers/HTTP/adapters/Hermes', () => {
    const importRe = /import[^'"]*['"]([^'"]+)['"]/g;
    const forbidden = /(provider(?!_ref)|adapter|hermes|plex|jellyfin|torbox|debrid|axios|node-fetch|undici|express|fastify|\bgot\b|^https?$)/i;
    const bad: string[] = [];
    for (const file of walkTs(CORE_DIR)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(importRe)) {
        const spec = m[1]!;
        if (forbidden.test(spec)) bad.push(`${path.basename(file)} -> ${spec}`);
      }
    }
    assert(bad.length === 0, `forbidden imports: ${bad.join(', ')}`);
  });

  // 3-6. No-leak gate -------------------------------------------------------
  await test('no-leak gate — rejects a forbidden identity key', () => {
    let threw = false;
    try {
      assertNoLeak({ title: 'The Matrix' });
    } catch {
      threw = true;
    }
    assert(threw, 'expected forbidden key "title" to be rejected');
  });

  await test('no-leak gate — rejects secret/identity signatures in values', () => {
    const leaks = [
      { op: 'magnet:?xt=urn:btih:deadbeef' },
      { op: 'https://tracker.example/announce' },
      { op: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }, // 40-hex infohash value
      { op: 'Bearer abcdef0123456789abcdef' },
    ];
    for (const p of leaks) {
      let threw = false;
      try {
        assertNoLeak(p);
      } catch {
        threw = true;
      }
      assert(threw, `expected signature leak to be rejected: ${JSON.stringify(p)}`);
    }
  });

  await test('no-leak gate — regression: accepts operational label "infohash"', () => {
    // The early gate false-positived on the legitimate label. It must pass now.
    assertNoLeak({ op: 'infohash' });
    assertNoLeak({ op: 'tmdb' });
    assertNoLeak({ weight: 3 });
  });

  // 7-9. Same-item concurrency: serialize, strict seq, no lost updates ------
  for (const n of [2, 20, 100]) {
    await test(`same-item concurrency x${n} — serialized, distinct seq, no lost updates`, async () => {
      await reset(pool);
      const id = `conc-${n}`;
      await auth.addItem(id);
      const seqs = await Promise.all(range(n).map(() => auth.recordSignal(id, 1, 60_000)));

      assertEq(new Set(seqs).size, n, 'all returned seqs must be distinct');
      const score = await count(pool, 'SELECT behavioral_score AS c FROM items WHERE id = $1', [id]);
      assertEq(score, n, 'behavioral_score must equal number of signals (no lost updates)');
      const behav = await count(
        pool,
        `SELECT count(*) AS c FROM events WHERE item_id = $1 AND kind = 'behavioral'`,
        [id],
      );
      assertEq(behav, n, 'one behavioral event appended per signal');
    });
  }

  // 10. First ItemAdded race on a brand-new id -----------------------------
  await test('first-add race — 20 concurrent adds on a new id serialize cleanly', async () => {
    await reset(pool);
    const id = 'race-new';
    const seqs = await Promise.all(range(20).map(() => auth.addItem(id)));
    assertEq(new Set(seqs).size, 20, 'distinct seqs');
    const added = await count(
      pool,
      `SELECT count(*) AS c FROM events WHERE item_id = $1 AND type = 'ItemAdded'`,
      [id],
    );
    assertEq(added, 20, '20 ItemAdded events appended');
    const present = await count(pool, `SELECT count(*) AS c FROM items WHERE id = $1 AND present`, [id]);
    assertEq(present, 1, 'exactly one present row exists');
  });

  // 11. Different-item parallelism, no deadlock ----------------------------
  await test('different-item parallelism — 100 parallel adds, no deadlock', async () => {
    await reset(pool);
    const t0 = Date.now();
    await Promise.all(range(100).map((i) => auth.addItem(`par-${i}`)));
    const ms = Date.now() - t0;
    const rows = await count(pool, 'SELECT count(*) AS c FROM items WHERE present', []);
    assertEq(rows, 100, '100 distinct items created');
    console.log(`         (100 parallel adds in ${ms}ms)`);
  });

  // 12. Rollback atomicity --------------------------------------------------
  await test('rollback atomicity — reducer throw persists neither event nor projection', async () => {
    await reset(pool);
    const before = await count(pool, 'SELECT count(*) AS c FROM events', []);
    const bogus: CatalogEvent = {
      itemId: 'rb',
      kind: 'structural',
      type: '__unknown__',
      payload: {},
      expiresAt: null,
    };
    let threw = false;
    try {
      await auth.apply(bogus);
    } catch {
      threw = true;
    }
    assert(threw, 'apply of unknown event type must throw');
    assertEq(await count(pool, 'SELECT count(*) AS c FROM events', []), before, 'no event persisted');
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE id = 'rb'`, []), 0, 'no projection row');
  });

  // 13. Deterministic rebuild ----------------------------------------------
  await test('rebuildProjection — deterministic and restores operational state only', async () => {
    await reset(pool);
    await auth.addItem('m1', {
      title: 'Title One',
      year: 1999,
      externalIds: { tmdb: '603' },
      metadata: { a: 1 },
      providerRefs: [{ type: 'infohash', value: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }],
    });
    await auth.addItem('m2');
    await auth.forget('m2');

    await auth.rebuildProjection();
    const snapA = await snapshot(pool);
    await auth.rebuildProjection();
    const snapB = await snapshot(pool);
    assertEq(snapA, snapB, 'two rebuilds must be byte-identical');

    const idNulls = await count(
      pool,
      `SELECT count(*) AS c FROM items
        WHERE title IS NOT NULL OR year IS NOT NULL OR external_ids IS NOT NULL OR metadata IS NOT NULL`,
      [],
    );
    assertEq(idNulls, 0, 'all identity columns NULL after rebuild');
    const refVals = await count(
      pool,
      `SELECT count(*) AS c FROM provider_refs WHERE ref_value IS NOT NULL`,
      [],
    );
    assertEq(refVals, 0, 'all provider ref values NULL after rebuild');
    // operational state survives:
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE id='m1' AND present`, []), 1, 'm1 present');
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE id='m2' AND forgotten`, []), 1, 'm2 forgotten');
  });

  // 14. Forget removes all content identity --------------------------------
  await test('forget — removes all content identity; events stay opaque', async () => {
    await reset(pool);
    const secretTitle = 'Top Secret Movie';
    const secretHash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    await auth.addItem('f1', {
      title: secretTitle,
      year: 2020,
      externalIds: { tmdb: 'x' },
      metadata: { note: 'private' },
      providerRefs: [{ type: 'infohash', value: secretHash }],
    });
    // sanity: identity is present before forget
    assertEq(await count(pool, `SELECT count(*) AS c FROM items WHERE id='f1' AND title IS NOT NULL`, []), 1, 'title set pre-forget');
    assertEq(await count(pool, `SELECT count(*) AS c FROM provider_refs WHERE item_id='f1' AND ref_value IS NOT NULL`, []), 1, 'ref value set pre-forget');

    await auth.forget('f1');

    const dirty = await count(
      pool,
      `SELECT count(*) AS c FROM items
        WHERE id='f1' AND (title IS NOT NULL OR year IS NOT NULL OR external_ids IS NOT NULL OR metadata IS NOT NULL OR NOT forgotten OR present)`,
      [],
    );
    assertEq(dirty, 0, 'all identity NULL and item marked forgotten/absent');
    assertEq(
      await count(pool, `SELECT count(*) AS c FROM provider_refs WHERE item_id='f1' AND (ref_value IS NOT NULL OR present)`, []),
      0,
      'provider ref value cleared and marked absent',
    );

    // events for f1 carry no trace of the secret identity, and pass the gate
    const { rows } = await pool.query(`SELECT payload FROM events WHERE item_id='f1'`);
    for (const r of rows) {
      assertNoLeak(r.payload);
      const blob = JSON.stringify(r.payload);
      assert(!blob.includes(secretTitle), 'event payload must not contain the title');
      assert(!blob.includes(secretHash), 'event payload must not contain the infohash value');
    }
  });

  // 15. Behavioral TTL prune + append-only guards --------------------------
  await test('behavioral TTL prune — expired pruned, structural untouched, log append-only', async () => {
    await reset(pool);
    await auth.addItem('ttl1'); // structural
    await auth.recordSignal('ttl1', 1, 100); // behavioral, expires in 100ms

    const structuralBefore = await count(pool, `SELECT count(*) AS c FROM events WHERE kind='structural'`, []);
    await sleep(250);
    const pruned = await auth.pruneExpiredBehavioral();
    assert(pruned >= 1, 'at least one expired behavioral event pruned');
    assertEq(await count(pool, `SELECT count(*) AS c FROM events WHERE kind='behavioral'`, []), 0, 'no behavioral events remain');
    assertEq(await count(pool, `SELECT count(*) AS c FROM events WHERE kind='structural'`, []), structuralBefore, 'structural events untouched');

    // append-only trigger: UPDATE always forbidden
    let updThrew = false;
    try {
      await pool.query(`UPDATE events SET type='x' WHERE seq = (SELECT min(seq) FROM events)`);
    } catch {
      updThrew = true;
    }
    assert(updThrew, 'UPDATE on events must be rejected');

    // append-only trigger: deleting a structural event forbidden
    let delThrew = false;
    try {
      await pool.query(`DELETE FROM events WHERE kind='structural'`);
    } catch {
      delThrew = true;
    }
    assert(delThrew, 'DELETE of structural events must be rejected');
  });

  // --- teardown -----------------------------------------------------------
  await closePool();
  await server.stop();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) {
      console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
