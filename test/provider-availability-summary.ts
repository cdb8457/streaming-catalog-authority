import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { summarizeProviderAvailability } from '../src/core/adapters/provider-availability-summary.js';

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

console.log('Running Phase 57 provider availability summary suite:\n');

test('summary counts candidate, skip, and hold decisions without item rows', () => {
  const summary = summarizeProviderAvailability([
    { decision: { status: 'available', action: 'candidate' }, locator: 'secret-locator' },
    { decision: { status: 'unavailable', action: 'skip' }, detail: 'provider detail' },
    { decision: { status: 'unknown', action: 'hold' } },
    { decision: { status: 'stale', action: 'hold' } },
  ]);
  assertEq(summary.report, 'phase-57-provider-availability-summary', 'report name');
  assertEq(summary.readiness, 'held', 'hold dominates readiness');
  assertEq(summary.counts.total, 4, 'total');
  assertEq(summary.counts.candidate, 1, 'candidate count');
  assertEq(summary.counts.skip, 1, 'skip count');
  assertEq(summary.counts.hold, 2, 'hold count');
  assertEq(summary.itemRowsIncluded, false, 'no item rows');
  assertEq(summary.providerDetailsIncluded, false, 'no provider detail');
  assertEq(summary.rawRefsIncluded, false, 'no raw refs');
});

test('readiness distinguishes empty, all skipped, and candidates', () => {
  assertEq(summarizeProviderAvailability([]).readiness, 'empty', 'empty');
  assertEq(summarizeProviderAvailability([{ decision: { status: 'unavailable', action: 'skip' } }]).readiness, 'all-skipped', 'all skipped');
  assertEq(summarizeProviderAvailability([{ decision: { status: 'available', action: 'candidate' } }]).readiness, 'has-candidates', 'candidate');
});

test('malformed and hostile reports fail closed to invalid hold without echoing values', () => {
  const sentinels = [
    'RAW-INFOHASH-SECRET',
    'https://api.torbox.app/private',
    'Bearer secret-token',
    'Private Movie Title',
    'provider payload detail',
  ];
  const summary = summarizeProviderAvailability([
    null,
    [],
    { decision: { status: sentinels[0], action: sentinels[1] }, detail: sentinels.join(' ') },
  ]);
  assertEq(summary.counts.total, 3, 'total');
  assertEq(summary.counts.invalid, 3, 'invalid count');
  assertEq(summary.counts.hold, 3, 'hold count');
  assertEq(summary.readiness, 'held', 'held');
  const output = JSON.stringify(summary);
  for (const sentinel of sentinels) assert(!output.includes(sentinel), `summary excludes ${sentinel}`);
});

test('source stays pure with no provider, DB, env, network, filesystem, or UI behavior', () => {
  const source = read('src/core/adapters/provider-availability-summary.ts');
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

test('package, docs, README, and deploy guard are wired', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['test:provider-availability-summary'], 'tsx test/provider-availability-summary.ts', 'test script');
  assert((pkg.scripts.test ?? '').includes('test/provider-availability-summary.ts'), 'suite in npm test');
  assert(read('docs/PHASE_57_PROVIDER_AVAILABILITY_SUMMARY.md').includes('Phase 57'), 'phase doc exists');
  assert(read('README.md').includes('Provider availability summary (Phase 57)'), 'README mentions phase');
  assert(read('test/deploy.ts').includes('provider availability summary - Phase 57'), 'deploy guard mentions phase');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
