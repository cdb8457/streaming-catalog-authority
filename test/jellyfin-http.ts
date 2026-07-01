import { JellyfinHttpClient, JellyfinHttpError, JellyfinPublishDisabledError, JellyfinAmbiguousCreateError, JellyfinOrphanError } from '../src/core/adapters/jellyfin/http-client.js';
import { createRealJellyfinClient, isJellyfinNetworkEnabled, JellyfinNetworkDisabledError } from '../src/core/adapters/jellyfin/real-factory.js';
import { ConfigError, type Env } from '../src/config/env.js';
import type { FetchLike, HttpResponseLike, HttpRequestInit } from '../src/core/adapters/jellyfin/transport.js';
import { runJellyfinClientContract, type ContractHarness } from './jellyfin-contract-kit.js';

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

type PostBehavior = 'ok' | 'no-id' | 'throw-after-create';

/** A stateful fake Jellyfin over the injected transport — NO real network. Records every request.
 * `postBehavior` simulates create outcomes: 'no-id' = created server-side but the response omits Id;
 * 'throw-after-create' = created server-side then the connection drops (ambiguous). */
class FakeTransport {
  readonly requests: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  private readonly collections = new Map<string, { name: string; ids: string[] }>();
  private counter = 0;
  constructor(private readonly items: Array<{ Id: string; ProviderIds: Record<string, string> }> = [], private readonly postBehavior: PostBehavior = 'ok') {}
  readonly fetch: FetchLike = async (url: string, init?: HttpRequestInit): Promise<HttpResponseLike> => {
    const method = init?.method ?? 'GET';
    this.requests.push({ method, url, headers: init?.headers ?? {} });
    const u = new URL(url);
    if (method === 'GET' && u.pathname === '/Items') {
      if (u.searchParams.get('IncludeItemTypes') === 'BoxSet') { // collection lookup by name (cleanup)
        const term = u.searchParams.get('SearchTerm');
        const matches = [...this.collections.entries()].filter(([, c]) => c.name === term).map(([id, c]) => ({ Id: id, Name: c.name }));
        return ok({ Items: matches });
      }
      return ok({ Items: this.items });
    }
    if (method === 'POST' && u.pathname === '/Collections') {
      const id = `col-${++this.counter}`;
      this.collections.set(id, { name: u.searchParams.get('Name') ?? '', ids: (u.searchParams.get('Ids') ?? '').split(',').filter(Boolean) });
      if (this.postBehavior === 'throw-after-create') throw new Error('connection dropped after create');
      if (this.postBehavior === 'no-id') return ok({}); // created but response omits Id
      return ok({ Id: id });
    }
    if (method === 'DELETE' && u.pathname.startsWith('/Items/')) {
      const id = decodeURIComponent(u.pathname.slice('/Items/'.length));
      return stat(this.collections.delete(id) ? 204 : 404);
    }
    return stat(404);
  };
  collectionCount(): number { return this.collections.size; }
  postCount(): number { return this.requests.filter((r) => r.method === 'POST').length; }
}

const KEY = 'SUPER-SECRET-JELLYFIN-KEY';

async function main(): Promise<void> {
  console.log('Running Phase 11 Jellyfin HTTP client suite (Stage 11.5):\n');

  // --- behavioral parity: the SAME shared contract the fake passes -------------
  await runJellyfinClientContract('JellyfinHttpClient(fixture)', h, (library) => {
    const items = Object.entries(library).map(([k, id]) => { const [type, value] = k.split(':'); return { Id: id, ProviderIds: { [type!]: value! } }; });
    return new JellyfinHttpClient({ baseUrl: 'http://jf.local:8096', apiKey: KEY, fetch: new FakeTransport(items).fetch, allowLivePublish: true });
  });

  // --- request shapes + api-key header-only (redaction) -----------------------
  await test('http — issues the expected requests; api key is header-only, never in the URL', async () => {
    const t = new FakeTransport([{ Id: 'item-a', ProviderIds: { tmdb: '603' } }]);
    const c = new JellyfinHttpClient({ baseUrl: 'http://jf.local:8096/', apiKey: KEY, fetch: t.fetch, allowLivePublish: true });
    const ids = await c.findItemsByRefs([{ type: 'tmdb', value: '603' }]);
    const handle = await c.createCollection('Matrix', ids);
    await c.deleteCollection(handle);
    const [find, create, del] = t.requests;
    assert(find!.url.includes('/Items?') && /Fields=ProviderIds/.test(find!.url) && find!.method === 'GET', 'GET /Items candidates');
    assert(create!.method === 'POST' && /\/Collections\?/.test(create!.url) && /Name=Matrix/.test(create!.url), 'POST /Collections?Name&Ids');
    assert(del!.method === 'DELETE' && /\/Items\/col-1$/.test(del!.url), 'DELETE /Items/{id}');
    for (const r of t.requests) { assert(!r.url.includes(KEY), 'api key NEVER in the URL'); assertEq(r.headers['X-Emby-Token'], KEY, 'api key sent as header'); }
  });

  // --- fail-closed + redaction-safe errors ------------------------------------
  await test('http — a non-2xx fails closed with a redaction-safe error (no api key)', async () => {
    const c = new JellyfinHttpClient({ baseUrl: 'http://jf.local', apiKey: KEY, fetch: async () => stat(500), maxRetries: 0 });
    let err: unknown;
    try { await c.deleteCollection('col-x'); } catch (e) { err = e; } // delete surfaces the HTTP error directly
    assert(err instanceof JellyfinHttpError, 'throws JellyfinHttpError');
    assertEq((err as JellyfinHttpError).status, 500, 'carries the status');
    assert(!(err as Error).message.includes(KEY), 'error message never contains the api key');
  });

  // --- retry: idempotent only; create NEVER retried ---------------------------
  await test('http — idempotent search retries transient 5xx; create is never retried', async () => {
    let getCalls = 0;
    const flakyGet: FetchLike = async (url, init) => { if ((init?.method ?? 'GET') === 'GET') { getCalls++; return getCalls <= 2 ? stat(503) : ok({ Items: [] }); } return ok({}); };
    const c1 = new JellyfinHttpClient({ baseUrl: 'http://jf.local', apiKey: KEY, fetch: flakyGet, maxRetries: 2 });
    assertEq((await c1.findItemsByRefs([{ type: 'tmdb', value: '1' }])).length, 0, 'search succeeds after retries');
    assertEq(getCalls, 3, 'search retried up to maxRetries (3 attempts)');

    let postCalls = 0;
    const failPost: FetchLike = async (url, init) => { if (init?.method === 'POST') { postCalls++; return stat(500); } return ok({ Items: [] }); };
    const c2 = new JellyfinHttpClient({ baseUrl: 'http://jf.local', apiKey: KEY, fetch: failPost, maxRetries: 2, allowLivePublish: true });
    let threw = false; try { await c2.createCollection('x', ['a']); } catch { threw = true; }
    assert(threw, 'create fails closed'); assertEq(postCalls, 1, 'create is NEVER retried (single attempt)');
  });

  // --- timeout: a hanging request aborts and fails closed ---------------------
  await test('http — a hanging request times out (AbortController) and fails closed', async () => {
    const hanging: FetchLike = (url, init) => new Promise((_, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))); });
    const c = new JellyfinHttpClient({ baseUrl: 'http://jf.local', apiKey: KEY, fetch: hanging, timeoutMs: 15, maxRetries: 1 });
    let err: unknown; try { await c.findItemsByRefs([{ type: 'tmdb', value: '1' }]); } catch (e) { err = e; }
    assert(err instanceof JellyfinHttpError, 'timeout -> JellyfinHttpError (fail-closed)');
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
    assert(c instanceof JellyfinHttpClient, 'enabled + configured -> constructs (over the injected fetch; no network)');
  });

  // --- orphan-guard: a live create can NEVER leave an untracked external collection (Codex regression)
  await test('orphan — live create is GATED off by default: no POST, no collection', async () => {
    const t = new FakeTransport();
    const c = new JellyfinHttpClient({ baseUrl: 'http://jf.local', apiKey: KEY, fetch: t.fetch }); // allowLivePublish defaults false
    let err: unknown; try { await c.createCollection('X', ['a']); } catch (e) { err = e; }
    assert(err instanceof JellyfinPublishDisabledError, 'gated off -> JellyfinPublishDisabledError');
    assertEq(t.postCount(), 0, 'no POST was made'); assertEq(t.collectionCount(), 0, 'no external collection created');
  });

  await test('orphan — create returning a MISSING id is cleaned up + VERIFIED gone (fail closed)', async () => {
    const t = new FakeTransport([], 'no-id'); // server creates the boxset but omits Id in the response
    const c = new JellyfinHttpClient({ baseUrl: 'http://jf.local', apiKey: KEY, fetch: t.fetch, allowLivePublish: true });
    let err: unknown; try { await c.createCollection('Orphan Me', ['a']); } catch (e) { err = e; }
    assert(err instanceof JellyfinAmbiguousCreateError, 'cleanup confirmed -> JellyfinAmbiguousCreateError');
    assertEq(t.collectionCount(), 0, 'the ambiguously-created collection was verified gone (no untracked copy)');
  });

  await test('orphan — connection DROPS after server-create; cleanup verifies removal (fail closed)', async () => {
    const t = new FakeTransport([], 'throw-after-create'); // created server-side, then the connection dies
    const c = new JellyfinHttpClient({ baseUrl: 'http://jf.local', apiKey: KEY, fetch: t.fetch, allowLivePublish: true, maxRetries: 0 });
    let err: unknown; try { await c.createCollection('Orphan Me', ['a']); } catch (e) { err = e; }
    assert(err instanceof JellyfinAmbiguousCreateError, 'cleanup confirmed -> fail closed');
    assertEq(t.collectionCount(), 0, 'the collection created before the drop was verified gone');
  });

  await test('orphan — when cleanup CANNOT be confirmed, fail LOUDLY (distinct, redaction-safe) — never swallowed', async () => {
    // POST creates the collection then drops; the cleanup lookup ALSO fails (network still down).
    const TITLE = 'Orphan Me';
    const dropThenFailCleanup: FetchLike = async (url, init) => {
      const u = new URL(url);
      if (init?.method === 'POST' && u.pathname === '/Collections') throw new Error('dropped after create');
      if ((init?.method ?? 'GET') === 'GET' && u.searchParams.get('IncludeItemTypes') === 'BoxSet') throw new Error('cleanup lookup failed');
      return stat(404);
    };
    const c = new JellyfinHttpClient({ baseUrl: 'http://jf.local', apiKey: KEY, fetch: dropThenFailCleanup, allowLivePublish: true, maxRetries: 0 });
    let err: unknown; try { await c.createCollection(TITLE, ['a']); } catch (e) { err = e; }
    assert(err instanceof JellyfinOrphanError, 'unconfirmed cleanup -> JellyfinOrphanError (loud, not swallowed)');
    assert(!String((err as Error).message).includes(TITLE), 'the orphan error does NOT leak the collection name/title');
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
