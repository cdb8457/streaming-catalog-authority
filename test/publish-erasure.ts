import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { FakePublisherAdapter } from '../src/core/adapters/fake-publisher.js';
import { FakeRevoker } from '../src/core/adapters/fake-revoker.js';
import type { PublisherAdapter, PublishRequest, PublishResult } from '../src/core/adapters/publisher.js';
import { PublishService, PublishLedgerError } from '../src/core/publish/publish-service.js';
import { PublishConsentError } from '../src/core/publish/consent.js';
import { runRevocation } from '../src/core/publish/reconcile.js';
import { countRevokePending, reconcileForgotten } from '../src/core/publish/ledger.js';
import { runDoctor } from '../src/ops/doctor.js';
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
const freshKeystore = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'erasure-')); tmpDirs.push(d); return d; };

const TITLE = 'ERASURE-SECRET-TITLE';
const EXTID = 'tt-erasure-secret';
const META = 'ERASURE-META-secret';
const REFVAL = 'ERASURE-REF-77';

/** A malformed publisher: reports a LIVE 'published' but omits the handle (contract violation). */
class NoHandlePublisher implements PublisherAdapter {
  readonly requires = ['title'] as const;
  describe(): { name: string; kind: 'publisher' } { return { name: 'no-handle', kind: 'publisher' }; }
  async publish(req: PublishRequest): Promise<PublishResult> { return { status: 'published', dryRun: req.dryRun }; }
}

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) { console.log('Booting embedded PostgreSQL 16 ...'); server = await startEmbedded(); }
  await migrate();
  const pool = getPool(); // app-role connection
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  const secret = await installCompletionSecret(admin);
  const keystoreDir = freshKeystore();
  const custodian = new FileCustodian(keystoreDir, secret, testKek());
  const auth = new CatalogAuthority(pool, custodian);
  const publisher = () => new FakePublisherAdapter(['title', 'year', 'providerRefs']);
  const seed = async (): Promise<string> => {
    const id = mintItemId();
    await auth.addItem(id, { title: TITLE, year: 2024, externalIds: { imdb: EXTID }, metadata: { note: META }, providerRefs: [{ type: 'tmdb', value: REFVAL }] });
    return id;
  };
  const ledgerCount = async (): Promise<number> => Number((await pool.query('SELECT count(*) AS c FROM publish_ledger')).rows[0].c);
  const forbidden = async (sql: string, params: unknown[]): Promise<boolean> => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(sql, params); await client.query('ROLLBACK'); return false; }
    catch (e) { await client.query('ROLLBACK').catch(() => {}); return (e as { code?: string }).code === '42501'; }
    finally { client.release(); }
  };

  console.log('Running Phase 9 publish-erasure suite (Stage 9.4):\n');

  // 1. consent gate: a live publish is refused unless allow; dry-run always allowed -------------
  await test('consent — live publish refused under deny; NO ledger row; dry-run allowed', async () => {
    const id = await seed();
    const svc = new PublishService(pool, auth, 'deny');
    let threw = false;
    try { await svc.publish(id, publisher(), { dryRun: false }); } catch (e) { threw = e instanceof PublishConsentError; }
    assert(threw, 'live publish under deny throws PublishConsentError');
    assertEq(await ledgerCount(), 0, 'no ledger row written on refusal');
    const dry = await svc.publish(id, publisher(), { dryRun: true });
    assert(dry !== null && dry.status === 'skipped' && dry.dryRun === true, 'dry-run allowed under deny');
    assertEq(await ledgerCount(), 0, 'dry-run writes no ledger row');
  });

  // 2. a live publish under consent=allow records an IDENTITY-FREE ledger row ------------------
  await test('ledger — a live publish records an identity-free row (field names only)', async () => {
    const id = await seed();
    const svc = new PublishService(pool, auth, 'allow');
    const result = await svc.publish(id, publisher(), { dryRun: false });
    assert(result !== null && result.status === 'published' && typeof result.handle === 'string', 'live publish succeeded');
    const row = (await pool.query('SELECT * FROM publish_ledger WHERE item_id=$1', [id])).rows[0];
    assert(row, 'ledger row exists');
    assertEq(row.item_id, id, 'opaque item id'); assertEq(row.status, 'published', 'published');
    assertEq(row.external_handle, result!.handle, 'opaque external handle recorded');
    assertEq([...row.disclosed_fields].sort().join(','), 'providerRefs,title,year', 'disclosed FIELD NAMES only');
    // scan the WHOLE ledger — no identity value may appear anywhere
    const dump = JSON.stringify((await pool.query('SELECT * FROM publish_ledger')).rows);
    for (const secretVal of [TITLE, EXTID, META, REFVAL]) assert(!dump.includes(secretVal), `ledger contains no ${secretVal}`);
  });

  // 3. the ledger CHECK rejects a non-field-name (defence in depth) ----------------------------
  await test('ledger — the disclosed_fields CHECK rejects a value that is not a field name', async () => {
    const id = mintItemId();
    let threw = false;
    try { await pool.query('SELECT cat_publish_record($1,$2,$3,$4)', [id, 'fake', 'h', ['title', 'a-leaked-value']]); }
    catch (e) { threw = (e as { code?: string }).code === '23514'; } // check_violation
    assert(threw, 'a non-field-name in disclosed_fields is rejected by the CHECK');
  });

  // 4. least-privilege: app cannot write the ledger directly; only via the SD functions --------
  await test('privilege — app can SELECT the ledger but cannot INSERT/UPDATE it directly', async () => {
    const id = mintItemId();
    assert(await forbidden('INSERT INTO publish_ledger (item_id, target, external_handle) VALUES ($1,$2,$3)', [id, 't', 'h']), 'direct INSERT denied (42501)');
    assert(await forbidden(`UPDATE publish_ledger SET status='revoked' WHERE item_id=$1`, [id]), 'direct UPDATE denied (42501)');
    await pool.query('SELECT count(*) FROM publish_ledger'); // SELECT allowed (no throw)
  });

  // 5. forget -> reconcile -> revoke lifecycle; forget semantics unchanged ----------------------
  await test('lifecycle — forget queues the tombstone; revoke clears it; forget still shreds', async () => {
    const id = await seed();
    const svc = new PublishService(pool, auth, 'allow');
    const pub = await svc.publish(id, publisher(), { dryRun: false });
    const handle = pub!.handle!;

    await auth.forget(id);
    // forget is UNCHANGED: identity is unrecoverable (DEK destroyed), item forgotten...
    assertEq(await auth.readIdentity(id), null, 'forget still destroys the identity (DEK gone)');
    assert((await pool.query('SELECT forgotten FROM items WHERE id=$1', [id])).rows[0].forgotten === true, 'item forgotten');
    // ...but the identity-free tombstone SURVIVES to drive revocation
    const survivor = (await pool.query('SELECT status FROM publish_ledger WHERE item_id=$1', [id])).rows[0];
    assertEq(survivor.status, 'published', 'tombstone survived forget (still published, pre-reconcile)');

    const revoker = new FakeRevoker();
    const run = await runRevocation(pool, revoker);
    assertEq(run.queued, 1, 'one row queued for revocation'); assertEq(run.revoked, 1, 'one row revoked'); assertEq(run.pending, 0, 'none left pending');
    assertEq((await pool.query('SELECT status FROM publish_ledger WHERE item_id=$1', [id])).rows[0].status, 'revoked', 'row now revoked');
    assertEq(revoker.seen.length, 1, 'revoker called once'); assertEq(revoker.seen[0], handle, 'revoker saw ONLY the opaque handle');
    assert(!JSON.stringify(revoker.seen).includes(TITLE), 'revoker never saw identity');
  });

  // 6. failed revoke stays visible + retryable (never silently dropped) -------------------------
  await test('lifecycle — a failed revoke keeps the row visible + retryable, then succeeds', async () => {
    const id = await seed();
    const svc = new PublishService(pool, auth, 'allow');
    const pub = await svc.publish(id, publisher(), { dryRun: false });
    await auth.forget(id);

    const run1 = await runRevocation(pool, new FakeRevoker([pub!.handle!])); // this handle fails
    assert(run1.failed >= 1 && run1.pending >= 1, 'failed revoke leaves the row pending');
    const pendingRow = (await pool.query('SELECT status, attempt_count FROM publish_ledger WHERE item_id=$1', [id])).rows[0];
    assertEq(pendingRow.status, 'revoke_pending', 'still revoke_pending (not dropped)');
    assert(Number(pendingRow.attempt_count) >= 1, 'attempt_count bumped for visibility');
    assert((await countRevokePending(pool)) >= 1, 'unrevoked copies are surfaced');

    const run2 = await runRevocation(pool, new FakeRevoker()); // retry succeeds
    assert(run2.revoked >= 1, 'retry revokes');
    assertEq((await pool.query('SELECT status FROM publish_ledger WHERE item_id=$1', [id])).rows[0].status, 'revoked', 'now revoked');
  });

  // 7. a forgotten item is not disclosable: publish returns null, no ledger row -----------------
  await test('publish — a forgotten item is not disclosable (null; no ledger row)', async () => {
    const id = await seed();
    await auth.forget(id);
    const before = await ledgerCount();
    const svc = new PublishService(pool, auth, 'allow');
    const pub = new FakePublisherAdapter(['title']);
    assertEq(await svc.publish(id, pub, { dryRun: false }), null, 'forgotten item -> null');
    assertEq(pub.seen.length, 0, 'publisher never invoked');
    assertEq(await ledgerCount(), before, 'no ledger row for a forgotten item');
  });

  // 8. a live 'published' WITHOUT a handle fails closed (no untracked external copy) -----------
  await test('publish — a live published result with NO handle fails closed (no untracked copy)', async () => {
    const id = await seed();
    const before = await ledgerCount();
    const svc = new PublishService(pool, auth, 'allow');
    let threw = false;
    try { await svc.publish(id, new NoHandlePublisher(), { dryRun: false }); } catch (e) { threw = e instanceof PublishLedgerError; }
    assert(threw, 'a handle-less live publish throws PublishLedgerError');
    assertEq(await ledgerCount(), before, 'no ledger row written for the malformed publish');
  });

  // 9. the revoke_pending backlog is surfaced via ops:doctor (operator-facing) -----------------
  await test('doctor — surfaces the revoke_pending backlog as a warning (Phase 9)', async () => {
    const id = await seed();
    const svc = new PublishService(pool, auth, 'allow');
    await svc.publish(id, publisher(), { dryRun: false });
    await auth.forget(id);
    await reconcileForgotten(pool); // queue it as revoke_pending WITHOUT revoking
    assert((await countRevokePending(pool)) >= 1, 'there is a pending revocation to surface');
    const report = await runDoctor({ admin, pool, custodian, completionSecret: secret, custodianMode: 'file', appEnv: 'test', keystoreDir });
    const check = report.checks.find((c) => c.name === 'publish-revocations');
    assert(check !== undefined, 'doctor emits a publish-revocations check');
    assertEq(check!.state, 'warn', 'pending revocations surface as a warning');
    assert(/awaiting revocation/.test(check!.detail), 'the detail describes the backlog');
    assert(report.ok, 'a warn does not fail the overall doctor (operational state)');
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
