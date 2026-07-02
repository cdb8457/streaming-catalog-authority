import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import type { PublishableIdentity } from '../src/core/adapters/publisher.js';
import { OutboxService, type OutboxTarget } from '../src/core/publish/outbox.js';
import { PublishConsentError } from '../src/core/publish/consent.js';
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
const freshKeystore = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'outbox-')); tmpDirs.push(d); return d; };

const TITLE = 'OUTBOX-SECRET-TITLE';
const REFVAL = 'OUTBOX-REF-42';

type Mode = 'ok' | 'throw-before-create' | 'create-then-throw';

/** In-memory external "server" (survives our process crash, like a real Jellyfin). Records tags. */
class FakeTarget implements OutboxTarget {
  readonly name = 'jellyfin';
  private readonly collections = new Map<string, string>(); // handle -> token
  private counter = 0;
  createCalls = 0;
  seenIdentities: PublishableIdentity[] = [];
  mode: Mode = 'ok';
  findMode: 'ok' | 'throw' = 'ok';
  async create(identity: PublishableIdentity, token: string): Promise<string> {
    this.createCalls++;
    this.seenIdentities.push(identity);
    if (this.mode === 'throw-before-create') throw new Error('failed before create (nothing created)');
    const handle = `jf-col-${++this.counter}`;
    this.collections.set(handle, token); // the artifact is created + tagged BEFORE we (maybe) throw
    if (this.mode === 'create-then-throw') throw new Error('created server-side, then the response was lost');
    return handle;
  }
  async findByToken(token: string): Promise<string | null> {
    if (this.findMode === 'throw') throw new Error('token lookup failed (network down)');
    for (const [h, t] of this.collections) if (t === token) return h;
    return null;
  }
  count(): number { return this.collections.size; }
}

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) { console.log('Booting embedded PostgreSQL 16 ...'); server = await startEmbedded(); }
  await migrate();
  const pool = getPool();
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  const secret = await installCompletionSecret(admin);
  const keystoreDir = freshKeystore();
  const custodian = new FileCustodian(keystoreDir, secret, testKek());
  const auth = new CatalogAuthority(pool, custodian);
  const REQUIRES = ['title', 'providerRefs'] as const;
  const seed = async (): Promise<string> => { const id = mintItemId(); await auth.addItem(id, { title: TITLE, year: 2024, providerRefs: [{ type: 'tmdb', value: REFVAL }] }); return id; };
  const rowFor = async (id: string): Promise<{ status: string; handle: string | null; token: string | null }> => {
    const r = (await pool.query('SELECT status, external_handle, correlation_token FROM publish_ledger WHERE item_id=$1 ORDER BY id DESC LIMIT 1', [id])).rows[0];
    return { status: r?.status, handle: r?.external_handle ?? null, token: r?.correlation_token ?? null };
  };
  const svc = (t: FakeTarget, consent: 'allow' | 'deny' = 'allow'): OutboxService => new OutboxService(pool, auth, consent, t, REQUIRES);

  console.log('Running Phase 12 publish-outbox crash-matrix suite (Stage 12.2):\n');

  await test('happy path — publish plans a durable intent and settles to published', async () => {
    const id = await seed(); const t = new FakeTarget();
    const res = await svc(t).publish(id, { dryRun: false });
    assertEq(res.status, 'published', 'published'); assert(typeof res.handle === 'string', 'handle');
    const row = await rowFor(id); assertEq(row.status, 'published', 'ledger published'); assert(row.handle && row.token, 'handle + token recorded');
    assertEq(t.count(), 1, 'one external collection');
  });

  await test('consent — dry-run plans nothing; a live publish under deny throws (no intent)', async () => {
    const id = await seed(); const t = new FakeTarget();
    const before = Number((await pool.query('SELECT count(*) AS c FROM publish_ledger')).rows[0].c);
    assertEq((await svc(t).publish(id, { dryRun: true })).status, 'skipped', 'dry-run skipped');
    let threw = false; try { await svc(t, 'deny').publish(id, { dryRun: false }); } catch (e) { threw = e instanceof PublishConsentError; }
    assert(threw, 'live under deny throws PublishConsentError');
    assertEq(Number((await pool.query('SELECT count(*) AS c FROM publish_ledger')).rows[0].c), before, 'no intent row written');
  });

  await test('crash BEFORE create — ambiguous, nothing created; reconcile (re)creates -> tracked', async () => {
    const id = await seed(); const t = new FakeTarget(); t.mode = 'throw-before-create';
    const res = await svc(t).publish(id, { dryRun: false });
    assertEq(res.status, 'ambiguous', 'ambiguous'); assertEq(t.count(), 0, 'nothing created'); assertEq((await rowFor(id)).status, 'ambiguous', 'intent ambiguous');
    t.mode = 'ok';
    const r = await new OutboxService(pool, auth, 'allow', t, REQUIRES).reconcile(); // fresh service = crashed+restarted
    assertEq(r.created, 1, 'recreated'); assertEq((await rowFor(id)).status, 'published', 'now published'); assertEq(t.count(), 1, 'exactly one collection');
  });

  await test('HARD CASE — server creates, response lost, state discarded; reconcile ADOPTS by token', async () => {
    const id = await seed(); const t = new FakeTarget(); t.mode = 'create-then-throw';
    const res = await svc(t).publish(id, { dryRun: false });
    assertEq(res.status, 'ambiguous', 'ambiguous (handle lost)'); assertEq(t.count(), 1, 'collection WAS created server-side');
    const token = (await rowFor(id)).token; assert(token, 'durable token persisted');
    // discard all in-memory service state; the DB intent + the external collection survive:
    const fresh = new OutboxService(pool, auth, 'allow', t, REQUIRES);
    const r = await fresh.reconcile();
    assertEq(r.adopted, 1, 'adopted by token (no recreate)'); assertEq(r.created, 0, 'did NOT create a duplicate');
    assertEq(t.count(), 1, 'still exactly one collection (no duplicate orphan)');
    const row = await rowFor(id); assertEq(row.status, 'published', 'intent settled -> published (tracked/revocable)'); assert(row.handle, 'handle adopted');
  });

  await test('idempotency — reconcile is a no-op once published; no extra creates', async () => {
    const id = await seed(); const t = new FakeTarget();
    await svc(t).publish(id, { dryRun: false });
    const before = t.createCalls;
    const r = await new OutboxService(pool, auth, 'allow', t, REQUIRES).reconcile();
    assertEq(r.adopted + r.created, 0, 'published intents are not actionable'); assertEq(t.createCalls, before, 'no extra create calls');
  });

  await test('bounded retry — a persistently-failing create is marked failed (surfaced, not looping)', async () => {
    const id = await seed(); const t = new FakeTarget(); t.mode = 'throw-before-create';
    await svc(t).publish(id, { dryRun: false }); // -> ambiguous (attempt 1)
    const fresh = new OutboxService(pool, auth, 'allow', t, REQUIRES);
    let status = (await rowFor(id)).status;
    for (let i = 0; i < 10 && status !== 'failed'; i++) { await fresh.reconcile(); status = (await rowFor(id)).status; }
    assertEq(status, 'failed', 'eventually failed (bounded retry)'); assertEq(t.count(), 0, 'nothing was ever created');
  });

  await test('privacy — outbox rows are identity-free (opaque token/item id + field names only)', async () => {
    const dump = JSON.stringify((await pool.query('SELECT * FROM publish_ledger')).rows);
    for (const s of [TITLE, REFVAL, '2024']) assert(!dump.includes(s), `outbox contains no ${s}`);
  });

  await test('privilege — app cannot write publish_ledger directly (only via SECURITY DEFINER)', async () => {
    const client = await pool.connect();
    let denied = false;
    try { await client.query('BEGIN'); await client.query(`UPDATE publish_ledger SET status='published' WHERE false`); await client.query('ROLLBACK'); }
    catch (e) { await client.query('ROLLBACK').catch(() => {}); denied = (e as { code?: string }).code === '42501'; }
    finally { client.release(); }
    assert(denied, 'direct UPDATE denied (42501)');
  });

  await test('reconcile — a findByToken ERROR is NOT treated as not-found: never creates a duplicate', async () => {
    const id = await seed(); const t = new FakeTarget(); t.mode = 'create-then-throw';
    await svc(t).publish(id, { dryRun: false }); // collection created + tagged, response lost -> ambiguous
    assertEq(t.count(), 1, 'one collection exists');
    t.mode = 'ok'; t.findMode = 'throw'; // the recovery lookup now fails (network still down)
    const r1 = await new OutboxService(pool, auth, 'allow', t, REQUIRES).reconcile();
    assertEq(r1.created, 0, 'did NOT create while the lookup was failing'); assertEq(t.count(), 1, 'NO duplicate collection'); assert(r1.stuck >= 1, 'left stuck for retry');
    t.findMode = 'ok'; // lookup recovers
    const r2 = await new OutboxService(pool, auth, 'allow', t, REQUIRES).reconcile();
    assertEq(r2.adopted, 1, 'adopts by token once the lookup works'); assertEq(t.count(), 1, 'still exactly one collection');
    assertEq((await rowFor(id)).status, 'published', 'settled -> published');
  });

  await test('migration — v2 status CHECK is upgraded to the v3 intent states (planned insert works)', async () => {
    // simulate a v2-shaped DB: clear intent-state rows (so the 3-value check can be added), swap in the
    // old auto-named constraint, then re-run the migration (the upgrade path).
    await admin.query('DELETE FROM publish_ledger');
    await admin.query('ALTER TABLE publish_ledger DROP CONSTRAINT publish_ledger_status_chk');
    await admin.query(`ALTER TABLE publish_ledger ADD CONSTRAINT publish_ledger_status_check CHECK (status IN ('published','revoke_pending','revoked'))`);
    await migrate(); // upgrade: must drop the old 3-value check and install the 7-state one
    const id = mintItemId();
    const intentId = (await pool.query('SELECT cat_publish_plan($1,$2,$3,$4) AS id', [id, 'jellyfin', 'tok-upgrade-' + id.slice(0, 8), ['title']])).rows[0].id;
    assertEq((await pool.query('SELECT status FROM publish_ledger WHERE id=$1', [intentId])).rows[0].status, 'planned', 'a planned intent inserts on the upgraded DB');
    // the old auto-named check must be gone
    const leftover = Number((await admin.query(`SELECT count(*) AS c FROM pg_constraint WHERE conrelid='public.publish_ledger'::regclass AND contype='c' AND conname='publish_ledger_status_check'`)).rows[0].c);
    assertEq(leftover, 0, 'the v2 status check was dropped');
  });

  await test('doctor — surfaces a stuck (ambiguous) publish intent (Phase 12)', async () => {
    const id = await seed(); const t = new FakeTarget(); t.mode = 'throw-before-create';
    await svc(t).publish(id, { dryRun: false }); // leaves an 'ambiguous' intent
    const report = await runDoctor({ admin, pool, custodian, completionSecret: secret, custodianMode: 'file', appEnv: 'test', keystoreDir });
    const check = report.checks.find((c) => c.name === 'publish-intents');
    assert(check !== undefined && check.state === 'warn', 'publish-intents surfaces as warn');
    assert(/stuck publish intent/.test(check!.detail), 'detail describes stuck intents');
    assert(report.ok, 'a warn does not fail the overall doctor (operational state)');
  });

  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  await admin.end();
  await closePool();
  if (server) await server.stop();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('\nFailures:'); for (const [n, e] of failures) console.log(`  - ${n}: ${(e as Error).stack ?? e}`); process.exit(1); }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
