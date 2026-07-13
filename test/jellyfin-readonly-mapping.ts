import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { FakeJellyfinClient } from '../src/core/adapters/jellyfin/fake-client.js';
import { buildJellyfinReadOnlyMappingItem, runJellyfinReadOnlyMapping } from '../src/core/adapters/jellyfin/read-only-mapping.js';
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

const tmpDirs: string[] = [];
const freshKeystore = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jf-map-'));
  tmpDirs.push(dir);
  return dir;
};

const TITLE = 'PHASE205-SECRET-TITLE';
const EXTID = 'tt-phase205-secret';
const TMDB = '205603';
const IMDB = 'tt2050133';
const JF_ID = 'jellyfin-secret-item-id';

const publicText = (value: unknown): string => JSON.stringify(value);

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) { console.log('Booting embedded PostgreSQL 16 ...'); server = await startEmbedded(); }
  await migrate();
  const pool = getPool();
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  const secret = await installCompletionSecret(admin);
  const auth = new CatalogAuthority(pool, new FileCustodian(freshKeystore(), secret, testKek()));
  const count = async (table: 'events' | 'provider_refs'): Promise<number> => Number((await pool.query(`SELECT count(*) AS c FROM ${table}`)).rows[0].c);

  console.log('Running Phase 205 Jellyfin read-only mapping suite:\n');

  await test('read-only mapping - encrypted catalog refs map to counts-only Jellyfin evidence', async () => {
    const id = mintItemId();
    await auth.addItem(id, {
      title: TITLE,
      year: 2026,
      externalIds: { imdb: EXTID },
      metadata: { note: 'phase205-meta-secret' },
      providerRefs: [{ type: 'tmdb', value: TMDB }, { type: 'imdb', value: IMDB }],
    });
    const eventsBefore = await count('events');
    const refsBefore = await count('provider_refs');
    const client = new FakeJellyfinClient({ [`tmdb:${TMDB}`]: JF_ID });

    const report = await runJellyfinReadOnlyMapping(auth, client, [id]);

    assert(report.ok, 'report ok');
    assertEq(report.report, 'phase-205-jellyfin-readonly-mapping', 'report id');
    assertEq(report.totals.requested, 1, 'one requested');
    assertEq(report.totals.mapped, 1, 'one mapped');
    assertEq(report.totals.refsConsidered, 2, 'two refs considered');
    assertEq(report.totals.jellyfinMatches, 1, 'one Jellyfin match');
    assertEq(report.items[0]!.status, 'mapped', 'item mapped');
    assertEq(report.items[0]!.refCount, 2, 'item ref count');
    assertEq(report.items[0]!.matchCount, 1, 'item match count');
    assertEq(await count('events'), eventsBefore, 'mapping writes no events');
    assertEq(await count('provider_refs'), refsBefore, 'mapping writes no provider refs');
    assertEq(auth.secrets.size(), 0, 'scoped ref registrations cleared after mapping');

    const text = publicText(report);
    for (const forbidden of [id, TITLE, EXTID, TMDB, IMDB, JF_ID, 'phase205-meta-secret']) {
      assert(!text.includes(forbidden), `report excludes ${forbidden}`);
    }
    assert(client.seenRefs.length === 1, 'Jellyfin lookup happened once');
  });

  await test('read-only mapping - unmatched, no-ref, and forgotten items are explicit without leaking identity', async () => {
    const matched = mintItemId();
    const unmatched = mintItemId();
    const noRefs = mintItemId();
    const forgotten = mintItemId();
    await auth.addItem(matched, { title: 'phase205 matched', providerRefs: [{ type: 'tmdb', value: '1' }] });
    await auth.addItem(unmatched, { title: 'phase205 unmatched', providerRefs: [{ type: 'tmdb', value: '2' }] });
    await auth.addItem(noRefs, { title: 'phase205 no refs' });
    await auth.addItem(forgotten, { title: 'phase205 forgotten', providerRefs: [{ type: 'tmdb', value: '3' }] });
    await auth.forget(forgotten);

    const report = await runJellyfinReadOnlyMapping(auth, new FakeJellyfinClient({ 'tmdb:1': 'jf-1' }), [matched, unmatched, noRefs, forgotten]);

    assert(!report.ok, 'forgotten item makes the retained mapping incomplete');
    assertEq(report.totals.requested, 4, 'four requested');
    assertEq(report.totals.mapped, 1, 'one mapped');
    assertEq(report.totals.unmatched, 1, 'one unmatched');
    assertEq(report.totals.noRefs, 1, 'one no-ref');
    assertEq(report.totals.unavailable, 1, 'one unavailable');
    const statuses = report.items.map((item) => item.status).sort().join(',');
    assertEq(statuses, 'mapped,no_refs,unavailable,unmatched', 'all statuses represented');
    const text = publicText(report);
    for (const forbidden of [matched, unmatched, noRefs, forgotten, 'phase205 matched', 'phase205 unmatched', 'phase205 no refs', 'phase205 forgotten', 'tmdb:1', 'tmdb:2', 'tmdb:3', 'jf-1']) {
      assert(!text.includes(forbidden), `report excludes ${forbidden}`);
    }
  });

  await test('pure mapping item helper calls only findItemsByRefs and emits counts', async () => {
    let findCalls = 0;
    const item = await buildJellyfinReadOnlyMappingItem({
      async findItemsByRefs(refs) {
        findCalls++;
        assertEq(refs.length, 1, 'one ref passed to lookup');
        return ['opaque-jf-id'];
      },
    }, { itemId: '00000000-0000-0000-0000-000000000001', providerRefs: [{ type: 'tmdb', value: '42' }] });
    assertEq(findCalls, 1, 'one lookup');
    assertEq(item.status, 'mapped', 'mapped');
    assertEq(item.refCount, 1, 'one ref');
    assertEq(item.matchCount, 1, 'one match');
    assert(!publicText(item).includes('opaque-jf-id'), 'raw Jellyfin id excluded');
    assert(!publicText(item).includes('42'), 'raw provider ref value excluded');
  });

  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
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
