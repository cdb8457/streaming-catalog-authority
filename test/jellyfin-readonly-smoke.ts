import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JellyfinHttpClient, JellyfinPublishDisabledError } from '../src/core/adapters/jellyfin/http-client.js';
import { createRealJellyfinClient, createRealJellyfinOutboxTarget, isJellyfinNetworkEnabled, isJellyfinLivePublishAllowed, JellyfinNetworkDisabledError, JellyfinLivePublishDisabledError } from '../src/core/adapters/jellyfin/real-factory.js';
import { runReadOnlySmoke } from '../src/core/adapters/jellyfin/smoke.js';
import type { Env } from '../src/config/env.js';
import type { FetchLike, HttpRequestInit, HttpResponseLike } from '../src/core/adapters/jellyfin/transport.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');
const ok = (body: unknown): HttpResponseLike => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const status = (code: number): HttpResponseLike => ({ ok: code >= 200 && code < 300, status: code, json: async () => ({}), text: async () => '' });
const SECRET = 'PHASE204-SUPER-SECRET-JELLYFIN-KEY';

class RecordingTransport {
  readonly requests: Array<{ method: string; path: string; url: string; headers: Record<string, string> }> = [];
  constructor(private readonly opts: { failSystemInfo?: boolean } = {}) {}
  readonly fetch: FetchLike = async (url: string, init?: HttpRequestInit): Promise<HttpResponseLike> => {
    const method = init?.method ?? 'GET';
    const u = new URL(url);
    this.requests.push({ method, path: u.pathname, url, headers: init?.headers ?? {} });
    if (method === 'GET' && u.pathname === '/System/Info') return this.opts.failSystemInfo ? status(401) : ok({ ServerName: 'fixture', Version: '10.fixture' });
    if (method === 'GET' && u.pathname === '/Items') return ok({ Items: [{ Id: 'item-1', ProviderIds: { Tmdb: '603' } }] });
    return status(405);
  };
}

const noSecret = (value: unknown): boolean => !JSON.stringify(value).includes(SECRET);

console.log('Running Phase 204 Jellyfin read-only smoke suite:\n');

await test('phase record defines the read-only endpoint boundary', () => {
  const doc = read('docs/PHASE_204_JELLYFIN_READ_ONLY_SMOKE.md');
  for (const required of [
    'phase-204-jellyfin-read-only-smoke',
    'JELLYFIN_READ_ONLY_SMOKE_READY',
    'd5c5b13',
    'phase-203',
    'GET /System/Info',
    'GET /Items?Recursive=true&Fields=ProviderIds&IncludeItemTypes=Movie,Series&StartIndex=<n>&Limit=<n>',
    'Forbidden operations in Phase 204',
    'JELLYFIN_API_KEY_FILE',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

await test('read-only smoke uses only GET /System/Info and GET /Items', async () => {
  const transport = new RecordingTransport();
  const client = new JellyfinHttpClient({ baseUrl: 'http://jellyfin.invalid', apiKey: SECRET, fetch: transport.fetch });
  const report = await runReadOnlySmoke(client, { type: 'tmdb', value: '603' });
  assert(report.ok, 'smoke ok');
  assert(report.steps.some((s) => s.step === 'server-info' && s.ok), 'server-info step ok');
  assert(report.steps.some((s) => s.step === 'find' && s.ok), 'find step ok');
  assertEq(transport.requests.length, 2, 'exactly server-info plus one item lookup in fixture');
  assertEq(transport.requests[0]!.method, 'GET', 'server info method');
  assertEq(transport.requests[0]!.path, '/System/Info', 'server info path');
  assertEq(transport.requests[1]!.method, 'GET', 'items method');
  assertEq(transport.requests[1]!.path, '/Items', 'items path');
  assert(transport.requests.every((r) => r.method === 'GET'), 'no write methods');
  assert(transport.requests.every((r) => !r.url.includes(SECRET)), 'secret never in URL');
  assert(transport.requests.every((r) => r.headers['X-Emby-Token'] === SECRET), 'secret sent only as auth header');
  assert(noSecret(report), 'report redacts secret');
});

await test('server-info failure stops before item lookup and remains redaction-safe', async () => {
  const transport = new RecordingTransport({ failSystemInfo: true });
  const client = new JellyfinHttpClient({ baseUrl: 'http://jellyfin.invalid', apiKey: SECRET, fetch: transport.fetch, maxRetries: 0 });
  const report = await runReadOnlySmoke(client, { type: 'tmdb', value: '603' });
  assert(!report.ok, 'smoke failed');
  assert(report.steps.length === 1 && report.steps[0]!.step === 'server-info', 'stopped after server-info');
  assertEq(transport.requests.length, 1, 'no item lookup after failed auth/base-url proof');
  assert(noSecret(report), 'failure report redacts secret');
});

await test('write-capable Jellyfin paths remain unreachable by current read-only config', async () => {
  assertEq(isJellyfinNetworkEnabled({} as Env), false, 'network default off');
  assertEq(isJellyfinLivePublishAllowed({} as Env), false, 'live publish default off');
  let networkErr: unknown;
  try { createRealJellyfinClient(async () => ok({}), {} as Env); } catch (err) { networkErr = err; }
  assert(networkErr instanceof JellyfinNetworkDisabledError, 'real client requires network gate');

  let outboxErr: unknown;
  try {
    createRealJellyfinOutboxTarget(async () => ok({}), {
      JELLYFIN_ENABLE_NETWORK: 'true',
      JELLYFIN_BASE_URL: 'http://jellyfin.invalid',
      JELLYFIN_API_KEY: SECRET,
    } as Env);
  } catch (err) { outboxErr = err; }
  assert(outboxErr instanceof JellyfinLivePublishDisabledError, 'outbox write target still requires live publish gate');

  const client = new JellyfinHttpClient({ baseUrl: 'http://jellyfin.invalid', apiKey: SECRET, fetch: async () => ok({}) });
  let createErr: unknown;
  try { await client.createCollection('phase204', ['item-1']); } catch (err) { createErr = err; }
  assert(createErr instanceof JellyfinPublishDisabledError, 'bare create remains disabled');
});

await test('package, deploy guard, and docs wire the Phase 204 gate', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const deploy = read('test/deploy.ts');
  const readme = read('README.md');
  assert(pkg.scripts['test:jellyfin-readonly-smoke'] === 'tsx test/jellyfin-readonly-smoke.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/media-player-boundary.ts && tsx test/jellyfin-readonly-smoke.ts && tsx test/jellyfin-readonly-mapping.ts && tsx test/jellyfin-disposable-write.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order present');
  assert(deploy.includes('Phase 204 Jellyfin read-only smoke'), 'deploy guard entry');
  assert(deploy.includes('JELLYFIN_READ_ONLY_SMOKE_READY'), 'deploy guard status');
  assert(readme.includes('Phase 204 adds `docs/PHASE_204_JELLYFIN_READ_ONLY_SMOKE.md`'), 'README ledger entry');
});

await test('phase record is redaction-safe and artifact-bounded', () => {
  const doc = read('docs/PHASE_204_JELLYFIN_READ_ONLY_SMOKE.md');
  for (const forbidden of [
    SECRET,
    'postgres://',
    'postgresql://',
    '-----BEGIN',
    'ssh-ed25519',
    'password:',
    'secret:',
    'kek:',
    'dek:',
    'wrappedHex',
    'dekBase64',
    '192.168.',
    'O5_CLOSED',
  ]) assert(!doc.includes(forbidden), `doc excludes ${forbidden}`);
  assert(doc.includes('No live Jellyfin server evidence is committed in this phase'), 'no live evidence claim');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
