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
import { JellyfinHttpClient } from '../src/core/adapters/jellyfin/http-client.js';
import { JellyfinOutboxTarget } from '../src/core/adapters/jellyfin/outbox-target.js';
import { buildCreateTaggedRequest, matchIdByToken, tokenMark, assertMarkerSafeToken } from '../src/core/adapters/jellyfin/mapping.js';
import type { FetchLike } from '../src/core/adapters/jellyfin/transport.js';
import { FakeJellyfin } from './jellyfin-fake-server.js';
import { getPool, migrate, adminUrl, closePool } from '../src/db/pool.js';
import { installCompletionSecret, testKek } from './crypto-setup.js';

/**
 * Phase 261 — adversarial coverage for RECOVERY BY TOKEN, the property the publish outbox exists to
 * provide and the one that was silently broken for eighteen phases.
 *
 * WHAT WENT WRONG. The outbox writes an opaque token into the external artifact at create time and finds
 * the artifact by that token afterwards, so a lost create response can be resolved by adoption instead of
 * by creating a second copy. Both halves of that round trip lived in `mapping.ts`, but nothing coupled
 * them and nothing ever checked that the marker written at one end could be read at the other. When the
 * create request was corrected to Jellyfin's OpenAPI parameter spelling, one test double kept speaking the
 * old one; every collection it stored was nameless, the marker was gone, and `findByToken` returned null
 * for an artifact that plainly existed. Reconcile read that null as PROOF OF ABSENCE and created a
 * duplicate — an untracked external copy plus a tracked one, which is precisely the outcome the outbox is
 * built to make impossible.
 *
 * WHAT IS COVERED HERE. Adoption; a create whose marker does not survive; a token that resolves to the
 * wrong artifact; duplicate tokens; bounded retry; two workers reconciling at once; restart; an intent
 * belonging to another target; tokens that are not safe to embed in a name; state that changes underneath
 * a reconciler; and the redaction boundary on everything the ledger and the transport carry.
 *
 * Every scenario is driven through fake in-process adapters. No Jellyfin, no provider, no media library,
 * no network.
 */

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
const freshKeystore = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'outbox-recovery-')); tmpDirs.push(d); return d; };

const TITLE = 'RECOVERY-SECRET-TITLE';
const REFVAL = 'RECOVERY-REF-77';

type CreateMode = 'ok' | 'throw-before-create' | 'create-then-throw';
/** How the artifact relates to its token AFTER a successful create. */
type MarkerMode = 'keeps-marker' | 'drops-marker' | 'points-elsewhere';

/**
 * An external "server" that survives our process, like a real Jellyfin does. `markerMode` models what the
 * server did with the recovery marker — the variable nothing in the product used to examine.
 */
class ProbeTarget implements OutboxTarget {
  readonly collections = new Map<string, string | null>(); // handle -> token it can be found by
  private counter = 0;
  createCalls = 0;
  findCalls = 0;
  createMode: CreateMode = 'ok';
  markerMode: MarkerMode = 'keeps-marker';
  findMode: 'ok' | 'throw' = 'ok';
  /** Runs before findByToken answers — used to change DB state underneath a reconciler. */
  beforeFind: (() => Promise<void>) | null = null;

  constructor(readonly name = 'jellyfin') {}

  async create(_identity: PublishableIdentity, token: string): Promise<string> {
    this.createCalls++;
    if (this.createMode === 'throw-before-create') throw new Error('failed before create (nothing created)');
    const handle = `col-${++this.counter}`;
    const findableBy = this.markerMode === 'keeps-marker' ? token
      : this.markerMode === 'points-elsewhere' ? `${token}-elsewhere`
        : null; // drops-marker: exists, but no token will ever find it
    this.collections.set(handle, findableBy);
    if (this.markerMode === 'points-elsewhere') this.collections.set(`decoy-${this.counter}`, token);
    if (this.createMode === 'create-then-throw') throw new Error('created server-side, then the response was lost');
    return handle;
  }

  async findByToken(token: string): Promise<string | null> {
    this.findCalls++;
    if (this.beforeFind) { const hook = this.beforeFind; this.beforeFind = null; await hook(); }
    if (this.findMode === 'throw') throw new Error('token lookup failed (network down)');
    for (const [handle, t] of this.collections) if (t === token) return handle;
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
  const auth = new CatalogAuthority(pool, new FileCustodian(freshKeystore(), secret, testKek()));
  const REQUIRES = ['title', 'providerRefs'] as const;
  const seed = async (): Promise<string> => { const id = mintItemId(); await auth.addItem(id, { title: TITLE, year: 2024, providerRefs: [{ type: 'tmdb', value: REFVAL }] }); return id; };
  const rowFor = async (id: string): Promise<{ status: string; handle: string | null; token: string | null; attempts: number }> => {
    const r = (await pool.query('SELECT status, external_handle, correlation_token, attempt_count FROM publish_ledger WHERE item_id=$1 ORDER BY id DESC LIMIT 1', [id])).rows[0];
    return { status: r?.status, handle: r?.external_handle ?? null, token: r?.correlation_token ?? null, attempts: Number(r?.attempt_count ?? 0) };
  };
  const svc = (t: OutboxTarget, newToken?: () => string): OutboxService =>
    new OutboxService(pool, auth, 'allow', t, REQUIRES, newToken);
  /** reconcile() acts on EVERY actionable intent for a target, so a scenario that counts its own effects
   *  must start from an empty ledger — otherwise it silently also reconciles the previous scenario's. */
  const resetLedger = async (): Promise<void> => { await admin.query('DELETE FROM publish_ledger'); };

  console.log('Running Phase 261 outbox recovery-by-token adversarial suite:\n');

  // --- the round trip itself: what is written must be what is matched ---------
  await test('marker round trip — the value the create request carries is the value find-by-token matches', () => {
    const token = 'round-trip-token-1';
    const spec = buildCreateTaggedRequest('Some Title', ['item-1'], token);
    // Deliberately key-agnostic: find whichever query value carries the marker, so this stays true if the
    // parameter is ever renamed again. What must NEVER change is that the marker travels and is findable.
    const carriers = Object.entries(spec.query ?? {}).filter(([, v]) => v.includes(tokenMark(token)));
    assertEq(carriers.length, 1, 'exactly one create parameter carries the token marker');
    const storedName = carriers[0]![1];
    assertEq(matchIdByToken(token, [{ Id: 'col-1', Name: storedName }]), 'col-1', 'a server echoing that value back as Name is findable by the same token');
    assertEq(matchIdByToken('some-other-token', [{ Id: 'col-1', Name: storedName }]), null, 'a different token does not match it');
  });

  await test('marker safety — a token that could forge or hide inside another marker is refused', () => {
    for (const bad of ['tok]en', '[cat:evil]', 'tok en', '', 'a'.repeat(129)]) {
      let threw = false;
      try { assertMarkerSafeToken(bad); } catch { threw = true; }
      assert(threw, `refused an unsafe token: ${JSON.stringify(bad)}`);
    }
    assertMarkerSafeToken('9f0c2c3e-0000-4000-8000-000000000001'); // a real minted token is fine
    // The bracket is what makes the check load-bearing: without it, a lookup for `a` would adopt this.
    assertEq(matchIdByToken('a', [{ Id: 'victim', Name: 'Other [cat:ab]' }]), null, 'a marker cannot match a prefix of another token');
  });

  // --- adoption (the property the whole outbox exists for) --------------------
  await test('adoption — a lost create response is resolved by adopting, never by creating a second copy', async () => {
    await resetLedger();
    const id = await seed(); const t = new ProbeTarget(); t.createMode = 'create-then-throw';
    assertEq((await svc(t).publish(id, { dryRun: false })).status, 'ambiguous', 'ambiguous (handle lost)');
    assertEq(t.count(), 1, 'the artifact WAS created server-side');
    const r = await svc(t).reconcile(); // a fresh service: nothing survives but the DB and the server
    assertEq(r.adopted, 1, 'adopted by token'); assertEq(r.created, 0, 'no duplicate created');
    assertEq(t.count(), 1, 'still exactly one external artifact');
    const row = await rowFor(id); assertEq(row.status, 'published', 'settled -> published (tracked, revocable)'); assert(row.handle, 'handle captured');
  });

  await test('adoption through the real Jellyfin client — the token marker survives create and is matched back', async () => {
    await resetLedger();
    const id = await seed();
    const fx = new FakeJellyfin({ library: { [`tmdb:${REFVAL}`]: 'lib-1' } });
    fx.createMode = 'create-then-throw';
    const target = new JellyfinOutboxTarget(new JellyfinHttpClient({ baseUrl: 'http://jf.local', apiKey: 'k', fetch: fx.fetch }));
    assertEq((await svc(target).publish(id, { dryRun: false })).status, 'ambiguous', 'ambiguous');
    assert(fx.names().some((n) => n.includes('[cat:')), 'the created collection actually carries a marker');
    const r = await svc(target).reconcile();
    assertEq(r.adopted, 1, 'adopted'); assertEq(r.created, 0, 'no duplicate'); assertEq(fx.count(), 1, 'one collection');
  });

  // --- THE DEFECT CLASS: a create whose marker does not survive ---------------
  await test('unrecoverable create — a marker that does not survive is REPORTED, not assumed away', async () => {
    await resetLedger();
    const id = await seed(); const t = new ProbeTarget(); t.markerMode = 'drops-marker';
    const s = svc(t);
    const res = await s.publish(id, { dryRun: false });
    assertEq(res.status, 'published', 'the artifact exists and its handle is captured (never discarded)');
    assertEq(res.recovery, 'unrecoverable', 'the create is reported as NOT findable by its own token');
    assert(s.isRecoveryBroken(), 'the service latches that token recovery is broken for this target');
    assertEq((await rowFor(id)).status, 'published', 'tracked and revocable despite the broken marker');
  });

  await test('unrecoverable create — reconcile then REFUSES to (re)create instead of duplicating', async () => {
    await resetLedger();
    const id = await seed(); const t = new ProbeTarget(); t.markerMode = 'drops-marker';
    const s = svc(t);
    await s.publish(id, { dryRun: false }); // proves recovery is broken for this target
    const id2 = await seed();
    t.createMode = 'create-then-throw';
    assertEq((await s.publish(id2, { dryRun: false })).status, 'ambiguous', 'second publish: response lost');
    const externalBefore = t.count();
    const r = await s.reconcile();
    assertEq(r.created, 0, 'did NOT create a duplicate of an artifact it can no longer see');
    assert(r.stuck >= 1, 'left stuck and surfaced for an operator');
    assertEq(t.count(), externalBefore, 'no new external artifact');
    assertEq((await rowFor(id2)).status, 'ambiguous', 'the intent stays actionable, not falsely settled');
  });

  await test('unrecoverable create — the refusal survives the process that learned it', async () => {
    await resetLedger();
    const t = new ProbeTarget(); t.markerMode = 'drops-marker';
    // Process 1 publishes and learns, from its own create, that recovery does not work here.
    await svc(t).publish(await seed(), { dryRun: false });
    t.createMode = 'create-then-throw';
    await svc(t).publish(await seed(), { dryRun: false }); // a lost response, left ambiguous
    const externalBefore = t.count();
    // Process 2 shares nothing with process 1 but the database and the server — which is the real
    // deployment: `ops:publish-reconcile` is a separate command from a publish.
    const fresh = svc(t);
    assertEq(fresh.isRecoveryBroken(), false, 'a new service starts with no in-memory knowledge');
    const r = await fresh.reconcile();
    assert(fresh.isRecoveryBroken(), 'it reads the durable proof left by the earlier process');
    assertEq(r.created, 0, 'and refuses to create');
    assertEq(t.count(), externalBefore, 'no duplicate external artifact across the restart');
  });

  await test('healing — once a create proves recoverable again, reconcile resumes creating', async () => {
    await resetLedger();
    const t = new ProbeTarget(); t.markerMode = 'drops-marker';
    await svc(t).publish(await seed(), { dryRun: false });        // proof: unrecoverable
    t.markerMode = 'keeps-marker';
    const healed = await svc(t).publish(await seed(), { dryRun: false }); // proof: verified
    assertEq(healed.recovery, 'verified', 'the later create proves recovery works again');
    const id = await seed();
    t.createMode = 'throw-before-create';
    await svc(t).publish(id, { dryRun: false });                  // ambiguous, nothing created
    t.createMode = 'ok';
    const r = await svc(t).reconcile();
    assertEq(r.created, 1, 'the newest proof governs — creating is allowed again');
    assertEq((await rowFor(id)).status, 'published', 'and the intent settles');
  });

  await test('recovery proof — the label is identity-free, bounded, and app-writable only through the fence', async () => {
    await resetLedger();
    const t = new ProbeTarget();
    await svc(t).publish(await seed(), { dryRun: false });
    const row = (await pool.query(`SELECT recovery_proof, recovery_proof_at FROM publish_ledger ORDER BY id DESC LIMIT 1`)).rows[0];
    assertEq(row.recovery_proof, 'verified', 'a working create records a verified proof');
    assert(row.recovery_proof_at !== null, 'and when it was proved');
    let rejected = false;
    try { await pool.query(`SELECT cat_publish_record_recovery($1, $2)`, ['1', 'definitely-not-a-proof']); } catch { rejected = true; }
    assert(rejected, 'an unknown proof label is rejected rather than stored');
    let denied = false;
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(`UPDATE publish_ledger SET recovery_proof='verified' WHERE false`); await client.query('ROLLBACK'); }
    catch (e) { await client.query('ROLLBACK').catch(() => {}); denied = (e as { code?: string }).code === '42501'; }
    finally { client.release(); }
    assert(denied, 'the app role cannot write the proof directly (42501)');
  });

  await test('contradictory create — a token resolving to a DIFFERENT artifact fails closed', async () => {
    await resetLedger();
    const id = await seed(); const t = new ProbeTarget(); t.markerMode = 'points-elsewhere';
    const s = svc(t);
    const res = await s.publish(id, { dryRun: false });
    assertEq(res.recovery, 'contradictory', 'the token finds something other than what we created');
    assert(s.isRecoveryBroken(), 'contradictory state latches the same refusal as an unrecoverable one');
    assertEq((await rowFor(id)).handle, res.handle ?? null, 'the ledger holds OUR handle, not the one the token found');
  });

  // --- duplicate tokens ------------------------------------------------------
  await test('duplicate token — a second intent can never reuse a live token (the DB refuses it)', async () => {
    await resetLedger();
    const fixed = 'fixed-token-for-duplication-test';
    const t = new ProbeTarget();
    const id1 = await seed();
    assertEq((await svc(t, () => fixed).publish(id1, { dryRun: false })).status, 'published', 'first publish settles');
    const id2 = await seed();
    let threw = false;
    try { await svc(t, () => fixed).publish(id2, { dryRun: false }); } catch { threw = true; }
    assert(threw, 'planning a second intent with the same token is refused');
    assertEq(t.count(), 1, 'and nothing was created for the refused intent');
    assertEq(Number((await pool.query('SELECT count(*) AS c FROM publish_ledger WHERE correlation_token=$1', [fixed])).rows[0].c), 1, 'exactly one ledger row holds that token');
  });

  await test('unusable token — a token that cannot be embedded is refused BEFORE any intent or side effect', async () => {
    await resetLedger();
    const id = await seed(); const t = new ProbeTarget();
    const before = Number((await pool.query('SELECT count(*) AS c FROM publish_ledger')).rows[0].c);
    for (const bad of ['', ' leading', 'a'.repeat(200)]) {
      let threw = false;
      try { await svc(t, () => bad).publish(id, { dryRun: false }); } catch { threw = true; }
      assert(threw, `refused token ${JSON.stringify(bad.slice(0, 12))}`);
    }
    assertEq(Number((await pool.query('SELECT count(*) AS c FROM publish_ledger')).rows[0].c), before, 'no intent row was written');
    assertEq(t.createCalls, 0, 'and no create was attempted');
  });

  // --- retry, restart, concurrency -------------------------------------------
  await test('bounded retry — a persistently failing create is failed, and the budget is not exceeded', async () => {
    await resetLedger();
    const id = await seed(); const t = new ProbeTarget(); t.createMode = 'throw-before-create';
    await svc(t).publish(id, { dryRun: false });
    let status = (await rowFor(id)).status;
    for (let i = 0; i < 20 && status !== 'failed'; i++) { await svc(t).reconcile(); status = (await rowFor(id)).status; }
    assertEq(status, 'failed', 'ends failed (surfaced), never loops');
    assertEq(t.count(), 0, 'nothing was ever created');
    assert(t.createCalls <= 6, `create attempts stayed within the budget (was ${t.createCalls})`);
  });

  await test('restart — reconcile after a discarded process is idempotent across repeated runs', async () => {
    await resetLedger();
    const id = await seed(); const t = new ProbeTarget(); t.createMode = 'create-then-throw';
    await svc(t).publish(id, { dryRun: false });
    const first = await svc(t).reconcile();
    assertEq(first.adopted, 1, 'first restart adopts');
    const createsAfterAdopt = t.createCalls;
    for (let i = 0; i < 3; i++) {
      const again = await svc(t).reconcile(); // each iteration is a fresh "process"
      assertEq(again.adopted + again.created, 0, 'a settled intent is not actionable again');
    }
    assertEq(t.createCalls, createsAfterAdopt, 'no further creates'); assertEq(t.count(), 1, 'still one artifact');
  });

  await test('concurrent workers — two reconcilers on one intent produce exactly one effect', async () => {
    await resetLedger();
    const id = await seed(); const t = new ProbeTarget(); t.createMode = 'throw-before-create';
    await svc(t).publish(id, { dryRun: false }); // ambiguous, nothing created
    t.createMode = 'ok';
    const [a, b] = await Promise.all([svc(t).reconcile(), svc(t).reconcile()]);
    assertEq(a.created + b.created, 1, 'exactly one worker created');
    assertEq(a.adopted + b.adopted, 0, 'no adoption (nothing existed to adopt)');
    assertEq(t.count(), 1, 'exactly one external artifact');
    assertEq((await rowFor(id)).status, 'published', 'settled once');
  });

  await test('concurrent workers — two reconcilers adopting one existing artifact settle it once', async () => {
    await resetLedger();
    const id = await seed(); const t = new ProbeTarget(); t.createMode = 'create-then-throw';
    await svc(t).publish(id, { dryRun: false });
    const [a, b] = await Promise.all([svc(t).reconcile(), svc(t).reconcile()]);
    assertEq(a.adopted + b.adopted, 1, 'exactly one adoption is reported');
    assertEq(a.created + b.created, 0, 'neither created');
    assertEq(t.count(), 1, 'one artifact');
  });

  // --- wrong target / stale state --------------------------------------------
  await test('wrong target — an intent for another target is never acted on', async () => {
    await resetLedger();
    const id = await seed(); const jf = new ProbeTarget('jellyfin'); const other = new ProbeTarget('other-target');
    await svc(jf).publish(id, { dryRun: false }); // settles on jellyfin
    const idOther = await seed();
    other.createMode = 'throw-before-create';
    await svc(other).publish(idOther, { dryRun: false }); // an ambiguous intent on 'other-target'
    const before = other.createCalls;
    const r = await svc(jf).reconcile(); // the jellyfin reconciler must not see it
    assertEq(r.adopted + r.created + r.failed, 0, 'the jellyfin reconciler acted on nothing');
    assertEq(other.createCalls, before, "and never touched the other target's artifact");
    assertEq((await rowFor(idOther)).status, 'ambiguous', "the other target's intent is untouched");
  });

  await test('stale state — an intent that leaves the actionable states mid-reconcile is NOT reported as adopted', async () => {
    await resetLedger();
    const id = await seed(); const t = new ProbeTarget(); t.createMode = 'create-then-throw';
    await svc(t).publish(id, { dryRun: false });
    const intentId = (await pool.query('SELECT id FROM publish_ledger WHERE item_id=$1 ORDER BY id DESC LIMIT 1', [id])).rows[0].id;
    // Another actor terminalises the row between the lock and the settle.
    t.beforeFind = async () => { await admin.query(`UPDATE publish_ledger SET status='revoked' WHERE id=$1`, [intentId]); };
    const r = await svc(t).reconcile();
    assertEq(r.adopted, 0, 'no adoption is claimed for a row that did not transition');
    assert(r.stuck >= 1, 'reported stuck instead');
    assertEq((await pool.query('SELECT status FROM publish_ledger WHERE id=$1', [intentId])).rows[0].status, 'revoked', 'the other actor\'s state stands');
  });

  await test('stale state — a token that no longer parses leaves the intent stuck, never recreated', async () => {
    await resetLedger();
    const id = await seed(); const t = new ProbeTarget(); t.createMode = 'throw-before-create';
    await svc(t).publish(id, { dryRun: false });
    const intentId = (await pool.query('SELECT id FROM publish_ledger WHERE item_id=$1 ORDER BY id DESC LIMIT 1', [id])).rows[0].id;
    await admin.query(`UPDATE publish_ledger SET correlation_token=$2 WHERE id=$1`, [intentId, ' not-a-usable-token ']);
    t.createMode = 'ok';
    const before = t.createCalls;
    const r = await svc(t).reconcile();
    assertEq(r.created, 0, 'never creates against an unusable recovery key');
    assertEq(t.createCalls, before, 'no create attempted');
    assert(r.stuck >= 1, 'surfaced as stuck');
    await admin.query(`UPDATE publish_ledger SET status='failed' WHERE id=$1`, [intentId]); // leave the ledger tidy
  });

  // --- redaction --------------------------------------------------------------
  await test('redaction — nothing the outbox persists or sends carries identity', async () => {
    await resetLedger();
    const id = await seed();
    const fx = new FakeJellyfin({ library: { [`tmdb:${REFVAL}`]: 'lib-1' } });
    const target = new JellyfinOutboxTarget(new JellyfinHttpClient({ baseUrl: 'http://jf.local', apiKey: 'SECRET-API-KEY', fetch: fx.fetch }));
    await svc(target).publish(id, { dryRun: false });

    const ledger = JSON.stringify((await pool.query('SELECT * FROM publish_ledger')).rows);
    for (const s of [TITLE, REFVAL, 'SECRET-API-KEY']) assert(!ledger.includes(s), `the ledger contains no ${s}`);

    const urls = fx.requests.map((r) => r.url).join('\n');
    assert(!urls.includes('SECRET-API-KEY'), 'the api key is never placed in a URL');
    assert(!urls.includes(REFVAL), 'provider ref values are never placed in a URL');
    // The title IS disclosed to the target — that is the whole point of a publish — but only there.
    assert(urls.includes(TITLE), 'the title reaches the target it was consented to (and nowhere else)');
  });

  await test('redaction — a transport failure surfaces the operation and status, never the key or url', async () => {
    await resetLedger();
    const failing: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'internal error' });
    const client = new JellyfinHttpClient({ baseUrl: 'http://jf.local', apiKey: 'SECRET-API-KEY', fetch: failing, maxRetries: 0 });
    let message = '';
    try { await client.createTaggedCollection('T', [], 'tok-redaction-1'); } catch (e) { message = (e as Error).message; }
    assert(message.includes('500'), `the failed create threw a status-bearing error (was ${JSON.stringify(message)})`);
    assert(!message.includes('SECRET-API-KEY') && !message.includes('jf.local'), 'the error carries neither the api key nor the url');
  });

  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  await admin.end();
  await closePool();
  if (server) await server.stop();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('\nFailures:'); for (const [n, e] of failures) console.log(`  - ${n}: ${(e as Error).stack ?? e}`); process.exit(1); }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
