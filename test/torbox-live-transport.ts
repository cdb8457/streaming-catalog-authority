import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TorBoxTransportRequest } from '../src/core/adapters/torbox-real-client-gate.js';
import {
  TORBOX_LIVE_TRANSPORT_REVIEWED_ENDPOINTS,
  createTorBoxLiveTransport,
  type TorBoxFetchLike,
} from '../src/ops/torbox-live-transport.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`);
}

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const exists = (rel: string): boolean => existsSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)));
const repoRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/');

function walkTs(relDir: string): Array<[string, string]> {
  const abs = fileURLToPath(new URL(`../${relDir}`, import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
  return walk(abs).map((path) => [path.replace(/\\/g, '/').replace(repoRoot, ''), readFileSync(path, 'utf8')]);
}

function request(operation: TorBoxTransportRequest['operation'], refValue = 'SCOPED-REF-SECRET'): TorBoxTransportRequest {
  return {
    operation,
    method: 'GET',
    routeId: `test.${operation}`,
    timeoutMs: 1000,
    ...(operation.endsWith('-cache-check') ? { scopedRef: { refType: 'infohash', refValue } as const } : {}),
  };
}

console.log('Running Phase 42 TorBox live transport suite:\n');

const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

await test('Phase 42 live transport source, docs, and package wiring exist', () => {
  assert(exists('src/ops/torbox-live-transport.ts'), 'live transport source exists');
  assert(exists('docs/PHASE_42_TORBOX_LIVE_TRANSPORT.md'), 'Phase 42 doc exists');
  assertEq(pkg.scripts['test:torbox-live-transport'], 'tsx test/torbox-live-transport.ts', 'focused script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-transport.ts'), 'suite is in npm test');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');
  assert(!(pkg.scripts.ci ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm ci');
});

await test('reviewed endpoint table is GET-only and excludes token-query/download routes', () => {
  assertEq(TORBOX_LIVE_TRANSPORT_REVIEWED_ENDPOINTS.length, 5, 'five reviewed endpoints');
  for (const endpoint of TORBOX_LIVE_TRANSPORT_REVIEWED_ENDPOINTS) {
    assertEq(endpoint.method, 'GET', `${endpoint.operation} is GET`);
    assert(!endpoint.path.includes('requestdl'), `${endpoint.operation} is not request-download`);
    assert(!endpoint.queryKeys.includes('token'), `${endpoint.operation} has no token query`);
  }
  const paths = TORBOX_LIVE_TRANSPORT_REVIEWED_ENDPOINTS.map((item) => item.path);
  for (const path of ['/', '/v1/api/torrents/checkcached', '/v1/api/webdl/checkcached', '/v1/api/usenet/checkcached', '/v1/api/webdl/hosters']) {
    assert(paths.includes(path as never), `endpoint includes ${path}`);
  }
});

await test('cache checks use bearer header auth, GET, scoped hash query, and no token query', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl: TorBoxFetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { status: 200, json: async () => ({ data: { cached: true, providerPayload: 'SECRET-PROVIDER-PAYLOAD' } }) };
  };
  const transport = createTorBoxLiveTransport({ fetchImpl, bearerToken: 'SECRET-TOKEN', maxAttempts: 1 });
  const response = await transport.request(request('torrent-cache-check'));
  assertEq(response.status, 200, 'status');
  assertEq((response.body as { availability: string }).availability, 'available', 'availability normalized');
  assertEq(calls.length, 1, 'one request');
  const firstCall = calls[0];
  if (!firstCall) throw new Error('first fetch call captured');
  const called = new URL(firstCall.url);
  assertEq(called.origin, 'https://api.torbox.app', 'default origin');
  assertEq(called.pathname, '/v1/api/torrents/checkcached', 'cache path');
  assertEq(called.searchParams.get('hash'), 'SCOPED-REF-SECRET', 'hash query uses scoped ref');
  assertEq(called.searchParams.get('format'), 'object', 'object format');
  assertEq(called.searchParams.get('list_files'), 'false', 'no file listing');
  assertEq(called.searchParams.get('token'), null, 'no token query');
  assertEq(firstCall.headers.Authorization, 'Bearer SECRET-TOKEN', 'bearer header');
  assert(!JSON.stringify(response).includes('SECRET-PROVIDER-PAYLOAD'), 'provider payload is not retained');
  assert(!JSON.stringify(response).includes('SECRET-TOKEN'), 'token is not retained');
});

await test('status and hoster probes are unauthenticated GET requests', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl: TorBoxFetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { status: 200, json: async () => ({ ok: true }) };
  };
  const transport = createTorBoxLiveTransport({ fetchImpl, bearerToken: 'SECRET-TOKEN', maxAttempts: 1 });
  await transport.request(request('status-check'));
  await transport.request(request('hoster-list'));
  const statusCall = calls[0];
  const hosterCall = calls[1];
  if (!statusCall || !hosterCall) throw new Error('status and hoster fetch calls captured');
  assertEq(new URL(statusCall.url).pathname, '/', 'status path');
  assertEq(new URL(hosterCall.url).pathname, '/v1/api/webdl/hosters', 'hoster path');
  assert(!('Authorization' in statusCall.headers), 'status has no auth header');
  assert(!('Authorization' in hosterCall.headers), 'hoster has no auth header');
  assertEq(new URL(statusCall.url).search, '', 'status has no query');
  assertEq(new URL(hosterCall.url).search, '', 'hoster has no query');
});

await test('cache checks without scoped refs fail closed before fetch', async () => {
  let calls = 0;
  const transport = createTorBoxLiveTransport({
    bearerToken: 'SECRET-TOKEN',
    fetchImpl: async () => {
      calls++;
      return { status: 200 };
    },
  });
  const response = await transport.request({
    operation: 'torrent-cache-check',
    method: 'GET',
    routeId: 'test.missing-ref',
    timeoutMs: 1000,
  });
  assertEq(calls, 0, 'fetch is not called');
  assertEq(response.category, 'forbidden-operation', 'missing scoped ref blocks');
  assert(!JSON.stringify(response).includes('SECRET-TOKEN'), 'token is not retained');
});

await test('fixed error categories are returned without provider messages or response bodies', async () => {
  const statuses: Array<[number, string]> = [[401, 'auth'], [403, 'auth'], [429, 'quota'], [504, 'timeout'], [500, 'transport']];
  for (const [status, category] of statuses) {
    const transport = createTorBoxLiveTransport({
      bearerToken: 'SECRET-TOKEN',
      maxAttempts: 1,
      fetchImpl: async () => ({ status, text: async () => 'SECRET PROVIDER ERROR BODY' }),
    });
    const response = await transport.request(request('webdl-cache-check'));
    assertEq(response.category, category, `status ${status} category`);
    const publicOutput = JSON.stringify(response);
    assert(!publicOutput.includes('SECRET PROVIDER ERROR BODY'), 'provider body not retained');
    assert(!publicOutput.includes('SECRET-TOKEN'), 'token not retained');
  }
});

await test('2xx cache parse failures become fixed parse category without raw snippets', async () => {
  const transport = createTorBoxLiveTransport({
    bearerToken: 'SECRET-TOKEN',
    maxAttempts: 1,
    fetchImpl: async () => ({ status: 200, text: async () => 'SECRET INVALID JSON BODY' }),
  });
  const response = await transport.request(request('torrent-cache-check'));
  assertEq(response.status, 200, 'provider status preserved');
  assertEq(response.category, 'parse', 'parse failure category');
  const publicOutput = JSON.stringify(response);
  assert(!publicOutput.includes('SECRET INVALID JSON BODY'), 'parse snippet not retained');
  assert(!publicOutput.includes('SECRET-TOKEN'), 'token not retained');
});

await test('retry is bounded and only uses fixed categories', async () => {
  let attempts = 0;
  const transport = createTorBoxLiveTransport({
    bearerToken: 'SECRET-TOKEN',
    maxAttempts: 3,
    fetchImpl: async () => {
      attempts++;
      return attempts < 3
        ? { status: 429, json: async () => ({ error: 'quota secret' }) }
        : { status: 200, json: async () => ({ cached: false }) };
    },
  });
  const response = await transport.request(request('usenet-cache-check'));
  assertEq(attempts, 3, 'bounded retry attempts');
  assertEq(response.category, undefined, 'eventual success has no category');
  assertEq((response.body as { availability: string }).availability, 'unavailable', 'final body normalized');
});

await test('configuration rejects unsafe defaults and source avoids SDK/env/DB/factory wiring', () => {
  for (const bad of ['', '  ', 'abc\n123']) {
    try {
      createTorBoxLiveTransport({ bearerToken: bad, fetchImpl: async () => ({ status: 200 }) });
      throw new Error('expected token rejection');
    } catch (err) {
      assert((err as Error).message.includes('bearer token'), 'bad token rejected');
    }
  }
  try {
    createTorBoxLiveTransport({ bearerToken: 'ok', baseUrl: 'http://api.torbox.app', fetchImpl: async () => ({ status: 200 }) });
    throw new Error('expected http rejection');
  } catch (err) {
    assert((err as Error).message.includes('HTTPS'), 'non-HTTPS base URL rejected');
  }

  const source = read('src/ops/torbox-live-transport.ts');
  for (const forbidden of [
    '@torbox/torbox-api',
    "from 'pg'",
    'from "pg"',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'window.fetch',
    'process.env',
    'readFileSync',
    'readdirSync',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'requestdl',
    'requestDownloadLink',
    'create-download',
    'cdn-url',
  ]) assert(!source.includes(forbidden), `live transport source excludes ${forbidden}`);
});

await test('adapter factory remains injected-only and TorBox source allowlist is explicit', () => {
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  const factory = read('src/core/adapters/adapter-factory.ts');
  assert(factory.includes("'torbox-readonly'"), 'adapter factory exposes only the read-only TorBox mode');
  assert(/requires explicit injected transport/i.test(factory), 'env-only TorBox mode fails closed');
  assert(!factory.includes('createTorBoxLiveTransport'), 'adapter factory does not construct live transport');
  assert(!factory.includes('globalThis.fetch'), 'adapter factory has no global fetch');
  const allowed = new Set([
    'src/core/adapters/torbox-boundary.ts',
    'src/core/adapters/fake-torbox-adapter.ts',
    'src/core/adapters/torbox-real-client-gate.ts',
    'src/core/adapters/torbox-readonly-client.ts',
    'src/core/adapters/torbox-provider-adapter.ts',
    'src/core/adapters/adapter-factory.ts',
    'src/ops/torbox-smoke-shell.ts',
    'src/ops/torbox-smoke-cli.ts',
    'src/ops/torbox-transport-acceptance.ts',
    'src/ops/torbox-smoke-readiness-preflight.ts',
    'src/ops/torbox-smoke-readiness-preflight-cli.ts',
    'src/ops/torbox-live-smoke-labels.ts',
    'src/ops/torbox-live-transport.ts',
    'src/ops/torbox-live-smoke-runner.ts',
    'src/ops/torbox-live-smoke-evidence-preflight.ts',
    'src/ops/torbox-live-smoke-evidence-preflight-cli.ts',
    'src/ops/torbox-live-smoke-summary-pack.ts',
    'src/ops/torbox-live-smoke-summary-pack-cli.ts',
    'src/ops/torbox-live-smoke-review-gate.ts',
    'src/ops/torbox-live-smoke-review-gate-cli.ts',
    'src/ops/torbox-live-smoke-operator-packet.ts',
    'src/ops/torbox-live-smoke-operator-packet-cli.ts',
    'src/ops/torbox-live-smoke-plan.ts',
    'src/ops/torbox-live-smoke-plan-cli.ts',
  ]);
  for (const [path, source] of walkTs('src')) {
    if (allowed.has(path)) continue;
    assert(!/torbox/i.test(source), `${path} does not name TorBox`);
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
