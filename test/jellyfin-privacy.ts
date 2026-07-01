import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { FakeJellyfinClient } from '../src/core/adapters/jellyfin/fake-client.js';
import { createJellyfinAdapters } from '../src/core/adapters/jellyfin/factory.js';
import { PublishService } from '../src/core/publish/publish-service.js';
import { runRevocation } from '../src/core/publish/reconcile.js';
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
const freshKeystore = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'jf-priv-')); tmpDirs.push(d); return d; };

const TITLE = 'JELLYFIN-SECRET-TITLE';
const EXTID = 'tt-jellyfin-secret';
const META = 'JELLYFIN-META-secret';
const TMDB = '603';
const IMDB = 'tt0133093';

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) { console.log('Booting embedded PostgreSQL 16 ...'); server = await startEmbedded(); }
  await migrate();
  const pool = getPool();
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  const secret = await installCompletionSecret(admin);
  const auth = new CatalogAuthority(pool, new FileCustodian(freshKeystore(), secret, testKek()));
  const ledgerCount = async (): Promise<number> => Number((await pool.query('SELECT count(*) AS c FROM publish_ledger')).rows[0].c);
  const seed = async (): Promise<string> => {
    const id = mintItemId();
    await auth.addItem(id, { title: TITLE, year: 2024, externalIds: { imdb: EXTID }, metadata: { note: META }, providerRefs: [{ type: 'tmdb', value: TMDB }, { type: 'imdb', value: IMDB }] });
    return id;
  };

  console.log('Running Phase 10 Jellyfin privacy suite (Stage 10.4):\n');

  // 1. live publish through the boundary: only title+refs reach the client; ledger is identity-free
  await test('publish — client sees only title + provider refs; ledger records the opaque handle', async () => {
    const id = await seed();
    const client = new FakeJellyfinClient({ [`tmdb:${TMDB}`]: 'jf-item-1' }); // only tmdb matches
    const { publisher } = createJellyfinAdapters(client);
    const result = await new PublishService(pool, auth, 'allow').publish(id, publisher, { dryRun: false });
    assert(result !== null && result.status === 'published' && typeof result.handle === 'string', 'published with a handle');

    // the client only ever received provider refs — never identity
    const refsDump = JSON.stringify(client.seenRefs);
    for (const s of [TITLE, EXTID, META, '2024']) assert(!refsDump.includes(s), `client refs carry no ${s}`);
    // the collection name is the title (allowed field), items are the MATCHED ids only
    const col = client.getCollection(result!.handle!);
    assertEq(col?.name, TITLE, 'collection named by title'); assertEq(col?.itemIds.join(','), 'jf-item-1', 'matched items only');

    // the ledger row is identity-free: opaque handle + field NAMES
    const row = (await pool.query('SELECT * FROM publish_ledger WHERE item_id=$1', [id])).rows[0];
    assertEq(row.target, 'jellyfin', 'target'); assertEq(row.external_handle, result!.handle, 'opaque handle');
    assertEq([...row.disclosed_fields].sort().join(','), 'providerRefs,title', 'field names only');
    const dump = JSON.stringify((await pool.query('SELECT * FROM publish_ledger')).rows);
    for (const s of [TITLE, EXTID, META, IMDB]) assert(!dump.includes(s), `ledger contains no ${s}`);
  });

  // 2. all-unmatched -> skipped, NO ledger row -------------------------------------------------
  await test('publish — all provider refs unmatched -> skipped, no ledger row', async () => {
    const id = await seed();
    const before = await ledgerCount();
    const { publisher } = createJellyfinAdapters(new FakeJellyfinClient()); // empty library
    const r = await new PublishService(pool, auth, 'allow').publish(id, publisher, { dryRun: false });
    assert(r !== null && r.status === 'skipped', 'skipped'); assertEq(r!.handle, undefined, 'no handle');
    assertEq(await ledgerCount(), before, 'no ledger row for an all-unmatched publish');
  });

  // 3. dry-run -> no ledger row, no collection --------------------------------------------------
  await test('publish — dry-run creates no ledger row and no collection', async () => {
    const id = await seed();
    const before = await ledgerCount();
    const client = new FakeJellyfinClient({ [`tmdb:${TMDB}`]: 'jf-item-1' });
    const { publisher } = createJellyfinAdapters(client);
    const r = await new PublishService(pool, auth, 'allow').publish(id, publisher, { dryRun: true });
    assertEq(r!.status, 'skipped', 'dry-run skipped'); assertEq(client.collectionCount(), 0, 'no collection');
    assertEq(await ledgerCount(), before, 'no ledger row on dry-run');
  });

  // 4. forget -> reconcile -> Jellyfin revoke deletes the collection by opaque handle ----------
  await test('revoke — forget then reconciliation deletes the Jellyfin collection by handle only', async () => {
    const id = await seed();
    const client = new FakeJellyfinClient({ [`tmdb:${TMDB}`]: 'jf-item-1' });
    const { publisher, revoker } = createJellyfinAdapters(client);
    const pub = await new PublishService(pool, auth, 'allow').publish(id, publisher, { dryRun: false });
    const handle = pub!.handle!;
    assert(client.hasCollection(handle), 'collection exists after publish');

    await auth.forget(id);
    assertEq(await auth.readIdentity(id), null, 'forget still destroys identity');
    const run = await runRevocation(pool, revoker);
    assert(run.revoked >= 1, 'revoked'); assert(!client.hasCollection(handle), 'Jellyfin collection deleted');
    assertEq((await pool.query('SELECT status FROM publish_ledger WHERE item_id=$1', [id])).rows[0].status, 'revoked', 'ledger revoked');
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
