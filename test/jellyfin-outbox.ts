import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { JellyfinHttpClient } from '../src/core/adapters/jellyfin/http-client.js';
import { JellyfinOutboxTarget } from '../src/core/adapters/jellyfin/outbox-target.js';
import { createRealJellyfinOutboxTarget, isJellyfinLivePublishAllowed, JellyfinLivePublishDisabledError, JellyfinNetworkDisabledError } from '../src/core/adapters/jellyfin/real-factory.js';
import { FakeJellyfin } from './jellyfin-fake-server.js';
import { OutboxService } from '../src/core/publish/outbox.js';
import { getPool, migrate, adminUrl, closePool } from '../src/db/pool.js';
import { installCompletionSecret, testKek } from './crypto-setup.js';
import type { Env } from '../src/config/env.js';

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
const freshKeystore = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'jf-outbox-')); tmpDirs.push(d); return d; };

const TITLE = 'JF-OUTBOX-TITLE';
const REF = 'jf-outbox-ref-7';

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
  const seed = async (): Promise<string> => { const id = mintItemId(); await auth.addItem(id, { title: TITLE, providerRefs: [{ type: 'tmdb', value: REF }] }); return id; };
  const statusOf = async (id: string): Promise<string> => (await pool.query('SELECT status FROM publish_ledger WHERE item_id=$1 ORDER BY id DESC LIMIT 1', [id])).rows[0]?.status;

  console.log('Running Phase 12 Jellyfin outbox integration suite (Stage 12.3, fixture transport):\n');

  await test('real client + outbox — happy publish creates a token-tagged collection -> published', async () => {
    const fx = new FakeJellyfin({ library: { [`tmdb:${REF}`]: 'item-1' } });
    const target = new JellyfinOutboxTarget(new JellyfinHttpClient({ baseUrl: 'http://jf.local', apiKey: 'k', fetch: fx.fetch }));
    const id = await seed();
    const res = await new OutboxService(pool, auth, 'allow', target, REQUIRES).publish(id, { dryRun: false });
    assertEq(res.status, 'published', 'published'); assertEq(fx.count(), 1, 'one tagged collection'); assertEq(await statusOf(id), 'published', 'ledger published');
  });

  await test('real client + outbox — HARD CASE: create tagged, response lost, state discarded -> reconcile ADOPTS by token', async () => {
    const fx = new FakeJellyfin({ library: { [`tmdb:${REF}`]: 'item-1' } });
    fx.createMode = 'create-then-throw';
    const target = new JellyfinOutboxTarget(new JellyfinHttpClient({ baseUrl: 'http://jf.local', apiKey: 'k', fetch: fx.fetch }));
    const id = await seed();
    const res = await new OutboxService(pool, auth, 'allow', target, REQUIRES).publish(id, { dryRun: false });
    assertEq(res.status, 'ambiguous', 'ambiguous (handle lost)'); assertEq(fx.count(), 1, 'collection WAS created + tagged');
    // discard in-memory state; DB intent + external collection survive:
    const r = await new OutboxService(pool, auth, 'allow', target, REQUIRES).reconcile();
    assertEq(r.adopted, 1, 'adopted by token (found the tagged collection)'); assertEq(r.created, 0, 'no duplicate created');
    assertEq(fx.count(), 1, 'still exactly one collection'); assertEq(await statusOf(id), 'published', 'settled -> published (tracked/revocable)');
  });

  await test('gate — real outbox target needs ENABLE_NETWORK + ALLOW_LIVE_PUBLISH + config (fail-closed)', () => {
    const fx = new FakeJellyfin();
    assertEq(isJellyfinLivePublishAllowed({} as Env), false, 'default OFF');
    let e1: unknown; try { createRealJellyfinOutboxTarget(fx.fetch, { JELLYFIN_ENABLE_NETWORK: 'true', JELLYFIN_BASE_URL: 'http://jf.local', JELLYFIN_API_KEY: 'k' } as Env); } catch (e) { e1 = e; }
    assert(e1 instanceof JellyfinLivePublishDisabledError, 'no ALLOW_LIVE_PUBLISH -> JellyfinLivePublishDisabledError');
    let e2: unknown; try { createRealJellyfinOutboxTarget(fx.fetch, { JELLYFIN_ALLOW_LIVE_PUBLISH: 'true' } as Env); } catch (e) { e2 = e; }
    assert(e2 instanceof JellyfinNetworkDisabledError, 'no ENABLE_NETWORK -> JellyfinNetworkDisabledError');
    const t = createRealJellyfinOutboxTarget(fx.fetch, { JELLYFIN_ENABLE_NETWORK: 'true', JELLYFIN_ALLOW_LIVE_PUBLISH: 'true', JELLYFIN_BASE_URL: 'http://jf.local', JELLYFIN_API_KEY: 'k' } as Env);
    assertEq(t.name, 'jellyfin', 'all gates + config -> constructs the outbox target');
  });

  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  await admin.end();
  await closePool();
  if (server) await server.stop();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('\nFailures:'); for (const [n, e] of failures) console.log(`  - ${n}: ${(e as Error).stack ?? e}`); process.exit(1); }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
