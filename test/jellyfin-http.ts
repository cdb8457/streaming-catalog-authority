import { JellyfinHttpClient, JellyfinHttpError, JellyfinPublishDisabledError } from '../src/core/adapters/jellyfin/http-client.js';
import { createRealJellyfinClient, isJellyfinNetworkEnabled, JellyfinNetworkDisabledError } from '../src/core/adapters/jellyfin/real-factory.js';
import { ConfigError, type Env } from '../src/config/env.js';
import type { FetchLike, HttpResponseLike, HttpRequestInit } from '../src/core/adapters/jellyfin/transport.js';
import { runJellyfinFindContract, type ContractHarness } from './jellyfin-contract-kit.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];
const h: ContractHarness = {
  async test(name, fn) { try { await fn(); passed++; console.log(`  PASS  ${name}`); } catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); } },
  assert(cond, msg) { if (!cond) throw new Error(msg); },
  assertEq(a, b, msg) { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); },
};
const test = h.test; const assert = h.assert; const assertEq = h.assertEq;

const ok = (body: unknown): HttpResponseLike => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const stat = (s: number): HttpResponseLike => ({ ok: s >= 200 && s < 300, status: s, json: async () => ({}), text: async () => '' });

/** A stateful fake Jellyfin over the injected transport — NO real network. Records every request.
 * Supports find (GET /Items candidates) + delete (DELETE /Items/{id}); collections may be pre-seeded
 * (real live create is disabled, so there is no POST create path). */
class FakeTransport {
  readonly requests: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  private readonly collections = new Set<string>();
  private counter = 0;
  constructor(private readonly items: Array<{ Id: string; ProviderIds: Record<string, string> }> = []) {}
  seed(): string { const id = `col-${++this.counter}`; this.collections.add(id); return id; }
  readonly fetch: FetchLike = async (url: string, init?: HttpRequestInit): Promise<HttpResponseLike> => {
    const method = init?.method ?? 'GET';
    this.requests.push({ method, url, headers: init?.headers ?? {} });
    const u = new URL(url);
    if (method === 'GET' && u.pathname === '/Items') return ok({ Items: this.items });
    if (method === 'DELETE' && u.pathname.startsWith('/Items/')) {
      const id = decodeURIComponent(u.pathname.slice('/Items/'.length));
      return stat(this.collections.delete(id) ? 204 : 404);
    }
    return stat(404);
  };
  postCount(): number { return this.requests.filter((r) => r.method === 'POST').length; }
}

const KEY = 'SUPER-SECRET-JELLYFIN-KEY';

async function main(): Promise<void> {
  console.log('Running Phase 11 Jellyfin HTTP client suite (Stage 11.5):\n');

  // --- find parity: the same shared FIND contract the fake passes ----------------
  await runJellyfinFindContract('JellyfinHttpClient(fixture)', h, (library) => {
    const items = Object.entries(library).map(([k, id]) => { const [type, value] = k.split(':'); return { Id: id, ProviderIds: { [type!]: value! } }; });
    return new JellyfinHttpClient({ baseUrl: 'http://jf.local:8096', apiKey: KEY, fetch: new FakeTransport(items).fetch });
  });

  // --- request shapes + api-key header-only (redaction) -----------------------
  await test('http — find + delete issue the expected requests; api key is header-only, never in the URL', async () => {
    const t = new FakeTransport([{ Id: 'item-a', ProviderIds: { tmdb: '603' } }]);
    const c = new JellyfinHttpClient({ baseUrl: 'http://jf.local:8096/', apiKey: KEY, fetch: t.fetch });
    await c.findItemsByRefs([{ type: 'tmdb', value: '603' }]);
    const handle = t.seed();
    await c.deleteCollection(handle);
    const [find, del] = t.requests;
    assert(find!.method === 'GET' && find!.url.includes('/Items?') && /Fields=ProviderIds/.test(find!.url), 'GET /Items candidates');
    assert(del!.method === 'DELETE' && new RegExp(`/Items/${handle}$`).test(del!.url), 'DELETE /Items/{id}');
    for (const r of t.requests) { assert(!r.url.includes(KEY), 'api key NEVER in the URL'); assertEq(r.headers['X-Emby-Token'], KEY, 'api key sent as header'); }
  });

  // --- live create is HARD-DISABLED (deferred to Phase 12): no POST path ------
  await test('http — createCollection is disabled: fails closed BEFORE any network call (no POST)', async () => {
    const t = new FakeTransport();
    const c = new JellyfinHttpClient({ baseUrl: 'http://jf.local', apiKey: KEY, fetch: t.fetch });
    let err: unknown; try { await c.createCollection('X', ['a']); } catch (e) { err = e; }
    assert(err instanceof JellyfinPublishDisabledError, 'createCollection -> JellyfinPublishDisabledError');
    assert(!String((err as Error).message).includes(KEY) && !String((err as Error).message).includes('X'), 'error is redaction-safe (no key/title)');
    assertEq(t.postCount(), 0, 'no POST was ever made (no orphan path)');
    assertEq(t.requests.length, 0, 'no network call at all');
  });

  // --- delete works over the injected transport (real revoke) -----------------
  await test('http — deleteCollection deletes a known handle, then reports not_found', async () => {
    const t = new FakeTransport();
    const c = new JellyfinHttpClient({ baseUrl: 'http://jf.local', apiKey: KEY, fetch: t.fetch });
    const handle = t.seed();
    assertEq(await c.deleteCollection(handle), 'deleted', 'deleted');
    assertEq(await c.deleteCollection(handle), 'not_found', 'already gone -> not_found');
  });

  // --- fail-closed + redaction-safe errors ------------------------------------
  await test('http — a non-2xx fails closed with a redaction-safe error (no api key)', async () => {
    const c = new JellyfinHttpClient({ baseUrl: 'http://jf.local', apiKey: KEY, fetch: async () => stat(500), maxRetries: 0 });
    let err: unknown;
    try { await c.deleteCollection('col-x'); } catch (e) { err = e; }
    assert(err instanceof JellyfinHttpError, 'throws JellyfinHttpError');
    assertEq((err as JellyfinHttpError).status, 500, 'carries the status');
    assert(!(err as Error).message.includes(KEY), 'error message never contains the api key');
  });

  // --- retry: idempotent search retries transient 5xx -------------------------
  await test('http — idempotent search retries transient 5xx up to maxRetries', async () => {
    let getCalls = 0;
    const flakyGet: FetchLike = async (url, init) => { if ((init?.method ?? 'GET') === 'GET') { getCalls++; return getCalls <= 2 ? stat(503) : ok({ Items: [] }); } return ok({}); };
    const c = new JellyfinHttpClient({ baseUrl: 'http://jf.local', apiKey: KEY, fetch: flakyGet, maxRetries: 2 });
    assertEq((await c.findItemsByRefs([{ type: 'tmdb', value: '1' }])).length, 0, 'search succeeds after retries');
    assertEq(getCalls, 3, 'search retried up to maxRetries (3 attempts)');
  });

  // --- timeout: a hanging request aborts and fails closed ---------------------
  await test('http — a hanging request times out (AbortController) and fails closed', async () => {
    const hanging: FetchLike = (url, init) => new Promise((_, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))); });
    const c = new JellyfinHttpClient({ baseUrl: 'http://jf.local', apiKey: KEY, fetch: hanging, timeoutMs: 15, maxRetries: 1 });
    let err: unknown; try { await c.findItemsByRefs([{ type: 'tmdb', value: '1' }]); } catch (e) { err = e; }
    assert(err instanceof JellyfinHttpError, 'timeout -> JellyfinHttpError (fail-closed)');
  });

  // --- find-by-token: LOCAL BoxSet-name filter (never trusts SearchTerm) ------
  await test('find-by-token — filters BoxSet names LOCALLY even when the server ignores SearchTerm', async () => {
    const TOKEN = 'tok-abc-123';
    const boxsets = [
      { Id: 'other-1', Name: 'Unrelated Collection' },
      { Id: 'target-1', Name: `My Movie [cat:${TOKEN}]` },
      { Id: 'other-2', Name: 'Another [cat:different-token]' },
    ];
    const reqs: string[] = [];
    const fx: FetchLike = async (url, init) => { reqs.push(url); if ((init?.method ?? 'GET') === 'GET' && new URL(url).pathname === '/Items') return ok({ Items: boxsets }); return stat(404); };
    const c = new JellyfinHttpClient({ baseUrl: 'http://jf.local', apiKey: KEY, fetch: fx });
    assertEq(await c.findCollectionByToken(TOKEN), 'target-1', 'matched the token-tagged BoxSet locally (not the others)');
    assertEq(await c.findCollectionByToken('absent-token'), null, 'no marker match -> null');
    assert(reqs.every((u) => !/SearchTerm/.test(u)), 'the request carries NO SearchTerm (local-filter only)');
  });

  // --- the network-enable gate (default off) ----------------------------------
  await test('gate — real client requires JELLYFIN_ENABLE_NETWORK=true AND full config (fail-closed)', () => {
    const fake: FetchLike = async () => ok({});
    assertEq(isJellyfinNetworkEnabled({} as Env), false, 'default OFF');
    let e1: unknown; try { createRealJellyfinClient(fake, {} as Env); } catch (e) { e1 = e; }
    assert(e1 instanceof JellyfinNetworkDisabledError, 'gate off -> JellyfinNetworkDisabledError');
    let e2: unknown; try { createRealJellyfinClient(fake, { JELLYFIN_ENABLE_NETWORK: 'true' } as Env); } catch (e) { e2 = e; }
    assert(e2 instanceof ConfigError, 'enabled but unconfigured -> ConfigError');
    const c = createRealJellyfinClient(fake, { JELLYFIN_ENABLE_NETWORK: 'true', JELLYFIN_BASE_URL: 'http://jf.local', JELLYFIN_API_KEY: 'k' } as Env);
    assert(c instanceof JellyfinHttpClient, 'enabled + configured -> constructs (over the injected transport; no network)');
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
