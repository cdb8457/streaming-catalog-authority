import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TORBOX_REAL_CLIENT_ALLOWED_OPERATIONS,
  TORBOX_REAL_CLIENT_FUTURE_GATED_OPERATIONS,
  TORBOX_REAL_CLIENT_TIMEOUT_BACKOFF_POLICY,
  TorBoxRealClientGateError,
  assertTorBoxOperationAllowed,
  assertTorBoxRealClientGateClosed,
  createDisabledTorBoxRealClientPlan,
  createTorBoxGateError,
  isTorBoxFutureGatedOperation,
  isTorBoxReadOnlyOperation,
  type TorBoxTransport,
} from '../src/core/adapters/torbox-real-client-gate.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`);
}
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/');

function walkTs(relDir: string): Array<[string, string]> {
  const abs = fileURLToPath(new URL(`../${relDir}`, import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
  return walk(abs).map((path) => [path.replace(/\\/g, '/').replace(root, ''), readFileSync(path, 'utf8')]);
}

function assertNoLeak(blob: string, label: string): void {
  for (const forbidden of [
    'credential-leak-marker',
    'token-leak-marker',
    'raw-ref-leak-marker',
    'private-title-leak-marker',
    '2026',
    'metadata-leak-marker',
    'raw-response-body-leak-marker',
    'cdn-leak-marker',
    'permalink-leak-marker',
    'https://api.example.invalid/raw-leak-path',
  ]) assert(!blob.includes(forbidden), `${label} excludes ${forbidden}`);
}

console.log('Running Phase 33 TorBox real-client gate suite:\n');

test('package and source have no TorBox SDK dependency or import', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'no TorBox SDK dependency installed');
  assertEq(pkg.scripts['test:torbox-real-client-gate'], 'tsx test/torbox-real-client-gate.ts', 'focused script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-real-client-gate.ts'), 'suite is in npm test chain');

  for (const [path, source] of walkTs('src')) {
    assert(!/from\s+['"]@torbox\/torbox-api['"]/.test(source), `${path} does not import SDK`);
    assert(!/require\(['"]@torbox\/torbox-api['"]\)/.test(source), `${path} does not require SDK`);
  }
});

test('TorBox modules have no network, global transport, env, DB, Docker, or secret-file reads', () => {
  const torboxSources = walkTs('src/core/adapters').filter(([path]) => /torbox/i.test(path));
  assert(torboxSources.some(([path]) => path.endsWith('torbox-real-client-gate.ts')), 'Phase 33 source included in scan');
  for (const [path, source] of torboxSources) {
    for (const forbidden of [
      "from 'pg'",
      'from "pg"',
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dns',
      'node:child_process',
      'globalThis.fetch',
      'window.fetch',
      'fetch(',
      'process.env',
      'readFileSync',
      'readdirSync',
      'openSync',
      'readSync',
      'docker compose',
      'secret-file',
      'DATABASE_URL',
    ]) assert(!source.includes(forbidden), `${path} excludes ${forbidden}`);
  }
});

test('transport is injected-only and no TorBox transport implementation exists', () => {
  const source = read('src/core/adapters/torbox-real-client-gate.ts');
  assert(source.includes('export interface TorBoxTransport'), 'transport interface exported');
  assert(source.includes('readonly transport?: TorBoxTransport'), 'config accepts injected transport');
  assert(!/class\s+\w*Transport\b/.test(source), 'no transport class');
  assert(!/implements\s+TorBoxTransport/.test(source), 'no implementation of TorBoxTransport');
  assert(!/new\s+\w*Transport\b/.test(source), 'no transport constructed');

  const injected: TorBoxTransport = {
    request: async () => ({ status: 200, body: { ignored: true } }),
  };
  const plan = createDisabledTorBoxRealClientPlan({ transport: injected });
  assertEq(plan.enabled, false, 'injected transport still cannot enable a client');
  assertEq(plan.transport, 'injected-contract-only', 'transport is a contract note only');
});

test('gate is disabled by default and cannot be enabled from pure config', () => {
  const defaultPlan = createDisabledTorBoxRealClientPlan();
  assertEq(defaultPlan.enabled, false, 'default disabled');
  assertEq(defaultPlan.reason, 'future-phase-required', 'future phase required');
  assertEq(assertTorBoxRealClientGateClosed({ enableRealClient: false }).enabled, false, 'explicit false stays disabled');
  assertEq(createDisabledTorBoxRealClientPlan({ credentialRef: 'operator-secret-ref' }).enabled, false, 'credential ref alone cannot enable');

  let threw = false;
  try {
    createDisabledTorBoxRealClientPlan({ enableRealClient: true, credentialRef: 'operator-secret-ref' });
  } catch (err) {
    threw = true;
    assert(err instanceof TorBoxRealClientGateError, 'enable throws gate error');
    assertEq((err as TorBoxRealClientGateError).operation, 'client-construction', 'operation is client construction');
    assertEq((err as TorBoxRealClientGateError).category, 'real-client-disabled', 'category is disabled');
    assertNoLeak(`${(err as Error).message}\n${JSON.stringify(err)}`, 'enable error');
  }
  assert(threw, 'enableRealClient true throws');
});

test('redaction-safe errors expose only operation, status, and category', () => {
  const hostile = {
    operation: 'torrent-cache-check',
    status: 429,
    category: 'quota',
    credential: 'credential-leak-marker',
    endpoint: 'https://api.example.invalid/raw-leak-path',
    rawRef: 'raw-ref-leak-marker',
    title: 'private-title-leak-marker',
    year: 2026,
    metadata: 'metadata-leak-marker',
    response: 'raw-response-body-leak-marker',
    cdn: 'cdn-leak-marker',
    permalink: 'permalink-leak-marker',
  } as unknown as Parameters<typeof createTorBoxGateError>[0];

  const err = createTorBoxGateError(hostile);
  const serialized = JSON.stringify(err);
  assertEq(err.message, 'TorBox real client gate closed: quota', 'fixed category-only message');
  assertEq(serialized, '{"operation":"torrent-cache-check","status":429,"category":"quota"}', 'JSON shape is minimal');
  assertNoLeak(`${err.name}\n${err.message}\n${serialized}\n${String(err)}`, 'gate error');
});

test('redaction-safe errors clamp hostile runtime operation and category values', () => {
  const hostileInput = {
    operation: 'raw-ref-leak-marker',
    status: 'raw-response-body-leak-marker',
    category: 'token-leak-marker',
  } as any;

  for (const [label, err] of [
    ['helper', createTorBoxGateError(hostileInput)],
    ['class', new TorBoxRealClientGateError(hostileInput)],
  ] as const) {
    const serialized = JSON.stringify(err);
    assertEq(err.message, 'TorBox real client gate closed: invalid-error-category', `${label} message is clamped`);
    assertEq(serialized, '{"operation":"invalid-operation","category":"invalid-error-category"}', `${label} JSON is clamped`);
    assertEq(err.operation, 'invalid-operation', `${label} operation is clamped`);
    assertEq(err.category, 'invalid-error-category', `${label} category is clamped`);
    assertEq(err.status, undefined, `${label} invalid status is omitted`);
    assertNoLeak(`${err.name}\n${err.message}\n${serialized}\n${String(err)}`, `${label} hostile error`);
  }
});

test('allowed operations are cache/status/hoster only', () => {
  assertEq(
    TORBOX_REAL_CLIENT_ALLOWED_OPERATIONS.slice().sort().join(','),
    ['hoster-list', 'status-check', 'torrent-cache-check', 'usenet-cache-check', 'webdl-cache-check'].sort().join(','),
    'allowed operation set',
  );
  for (const operation of TORBOX_REAL_CLIENT_ALLOWED_OPERATIONS) {
    assert(isTorBoxReadOnlyOperation(operation), `${operation} recognized as read-only`);
    assertTorBoxOperationAllowed(operation);
  }
});

test('create, download-link, user, control, export, CDN, and permalink flows are future-gated', () => {
  for (const operation of [
    'create-download',
    'request-download-link',
    'request-permalink',
    'user-list',
    'user-data',
    'control-item',
    'delete-item',
    'export-provider-data',
    'cdn-url',
  ]) {
    assert(TORBOX_REAL_CLIENT_FUTURE_GATED_OPERATIONS.includes(operation as never), `${operation} listed as future-gated`);
    assert(isTorBoxFutureGatedOperation(operation), `${operation} recognized as future-gated`);
    let threw = false;
    try { assertTorBoxOperationAllowed(operation as never); }
    catch (err) {
      threw = true;
      assert(err instanceof TorBoxRealClientGateError, `${operation} throws gate error`);
      assertEq((err as TorBoxRealClientGateError).category, 'forbidden-operation', `${operation} forbidden`);
      assertNoLeak(`${(err as Error).message}\n${JSON.stringify(err)}`, `${operation} error`);
    }
    assert(threw, `${operation} must fail closed`);
  }
});

test('timeout and backoff policy is bounded data only', () => {
  assertEq(TORBOX_REAL_CLIENT_TIMEOUT_BACKOFF_POLICY.perRequestTimeoutMs.min, 1_000, 'timeout min');
  assertEq(TORBOX_REAL_CLIENT_TIMEOUT_BACKOFF_POLICY.perRequestTimeoutMs.default, 5_000, 'timeout default');
  assertEq(TORBOX_REAL_CLIENT_TIMEOUT_BACKOFF_POLICY.perRequestTimeoutMs.max, 10_000, 'timeout max');
  assertEq(TORBOX_REAL_CLIENT_TIMEOUT_BACKOFF_POLICY.retry.maxAttempts.max, 3, 'retry max');
  assertEq(TORBOX_REAL_CLIENT_TIMEOUT_BACKOFF_POLICY.retry.jitter, 'required', 'jitter required');
  assertEq(TORBOX_REAL_CLIENT_TIMEOUT_BACKOFF_POLICY.retry.mutatingRetry, 'forbidden-without-durable-outbox', 'mutating retry gated');
});

test('adapter factory remains closed to TorBox modes', () => {
  const factory = read('src/core/adapters/adapter-factory.ts');
  assert(!/torbox/i.test(factory), 'adapter factory does not mention TorBox');
  assert(!/TorBox/.test(factory), 'adapter factory has no TorBox import or constructor');
});

test('Phase 33 docs preserve closed gate, O4/O5, and FileCustodian boundary', () => {
  const doc = read('docs/PHASE_33_TORBOX_REAL_CLIENT_GATE.md');
  const phase31 = read('docs/PHASE_31_TORBOX_BOUNDARY.md');
  const phase32 = read('docs/PHASE_32_FAKE_TORBOX_ADAPTER.md');
  const readme = read('README.md');
  const combined = `${doc}\n${phase31}\n${phase32}\n${readme}`;
  for (const kw of [
    'design gate, not a live client',
    'injected transport only',
    'no SDK dependency',
    'future real client must be separately authorized/reviewed',
    'live smoke must be operator-run outside CI',
    'no ADAPTER_MODE wiring',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(kw), `docs include ${kw}`);
  assert(/request-download-link[\s\S]*token-query[\s\S]*permalink[\s\S]*CDN[\s\S]*durable outbox\/idempotency\/revocation review/i.test(doc), 'high-risk link flows remain out of phase');
});

test('TorBox source allowlist remains explicit', () => {
  const allowed = new Set([
    'src/core/adapters/torbox-boundary.ts',
    'src/core/adapters/fake-torbox-adapter.ts',
    'src/core/adapters/torbox-real-client-gate.ts',
    'src/core/adapters/torbox-readonly-client.ts',
    'src/ops/torbox-smoke-shell.ts',
    'src/ops/torbox-smoke-cli.ts',
    'src/ops/torbox-transport-acceptance.ts',
    'src/ops/torbox-smoke-readiness-preflight.ts',
    'src/ops/torbox-smoke-readiness-preflight-cli.ts',
    'src/ops/torbox-live-transport.ts',
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
