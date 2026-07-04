import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decideProviderAvailability } from '../src/core/adapters/provider-availability-policy.js';

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

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

console.log('Running Phase 55 provider availability policy suite:\n');

test('available advisory result becomes a candidate without becoming authoritative', () => {
  const decision = decideProviderAvailability({
    result: { status: 'available', locator: 'secret-provider-locator', detail: 'provider payload detail' },
  });
  assertEq(decision.status, 'available', 'status');
  assertEq(decision.action, 'candidate', 'action');
  assertEq(decision.advisoryOnly, true, 'advisory only');
  assertEq(decision.persisted, false, 'not persisted');
  assertEq(decision.echoesProviderDetail, false, 'does not echo detail');
});

test('unavailable skips and unknown holds', () => {
  const unavailable = decideProviderAvailability({ result: { status: 'unavailable', detail: 'miss' } });
  const unknown = decideProviderAvailability({ result: { status: 'unknown', detail: 'auth' } });
  assertEq(unavailable.status, 'unavailable', 'unavailable status');
  assertEq(unavailable.action, 'skip', 'unavailable skip');
  assertEq(unknown.status, 'unknown', 'unknown status');
  assertEq(unknown.action, 'hold', 'unknown hold');
});

test('stale, missing, malformed, and hostile statuses fail closed', () => {
  const stale = decideProviderAvailability({
    result: { status: 'available', locator: 'would-not-be-echoed' },
    observedAtMs: 1_000,
    nowMs: 2_000,
    maxAgeMs: 500,
  });
  assertEq(stale.status, 'stale', 'stale status');
  assertEq(stale.action, 'hold', 'stale hold');

  for (const result of [
    null,
    undefined,
    [],
    { status: 'cached' },
    { status: 'available', locator: 'x', detail: 'y', extra: 'z' },
  ] as unknown[]) {
    const decision = decideProviderAvailability({
      result: result as never,
      observedAtMs: Number.NaN,
      nowMs: 2_000,
    });
    assert(decision.action === 'hold' || decision.status === 'available', 'malformed timing or status is not promoted');
  }
});

test('decisions never echo provider locators, raw refs, URLs, credentials, or identity', () => {
  const sentinels = [
    'secret-provider-locator',
    'RAW-INFOHASH-SECRET',
    'https://api.torbox.app/private',
    'Bearer secret-token',
    'Private Movie Title',
  ];
  const decision = decideProviderAvailability({
    result: { status: 'available', locator: sentinels[0], detail: sentinels.join(' ') },
  });
  const output = JSON.stringify(decision);
  for (const sentinel of sentinels) assert(!output.includes(sentinel), `output excludes ${sentinel}`);
});

test('source is a pure policy layer with no provider, DB, env, network, or UI behavior', () => {
  const source = read('src/core/adapters/provider-availability-policy.ts');
  for (const forbidden of [
    '@torbox/torbox-api',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'readFileSync',
    "from 'node:fs'",
    "from 'pg'",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'request-download-link',
    'request-permalink',
    'document.',
    'window.',
  ]) assert(!source.includes(forbidden), `source excludes ${forbidden}`);
});

test('package, README, deploy test, and source allowlist are wired', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['test:provider-availability-policy'], 'tsx test/provider-availability-policy.ts', 'test script');
  assert((pkg.scripts.test ?? '').includes('test/provider-availability-policy.ts'), 'suite in npm test');
  assert(read('README.md').includes('Provider availability policy (Phase 55)'), 'README mentions phase');
  assert(read('test/deploy.ts').includes('provider availability policy - Phase 55'), 'deploy test mentions phase');

  const rootSrc = fileURLToPath(new URL('../src', import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
  assert(walk(rootSrc).some((path) => path.endsWith('/provider-availability-policy.ts')), 'source is present');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
