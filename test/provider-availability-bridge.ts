import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AdapterContext, AdapterRefView, AdapterResult, ProviderAdapter } from '../src/core/adapters/adapter.js';
import { resolveProviderAvailability } from '../src/core/adapters/provider-availability-bridge.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');
const view: AdapterRefView = {
  itemId: 'opaque-item-id',
  refType: 'infohash',
  refValue: 'RAW-INFOHASH-SECRET',
};

class FixtureAdapter implements ProviderAdapter {
  constructor(private readonly result: AdapterResult) {}

  describe(): { name: string; kind: 'ref-resolver' } {
    return { name: 'fixture', kind: 'ref-resolver' };
  }

  async resolveRef(_view: AdapterRefView, ctx?: AdapterContext): Promise<AdapterResult> {
    ctx?.log?.('fixture adapter lookup');
    return this.result;
  }
}

class HostileStatusAdapter implements ProviderAdapter {
  describe(): { name: string; kind: 'ref-resolver' } {
    return { name: 'hostile-status-fixture', kind: 'ref-resolver' };
  }

  async resolveRef(): Promise<AdapterResult> {
    return {
      status: 'RAW-INFOHASH-SECRET https://api.torbox.app/private Bearer secret' as AdapterResult['status'],
      detail: 'provider payload detail',
    };
  }
}

console.log('Running Phase 56 provider availability bridge suite:\n');

await test('bridge classifies available adapter results without echoing locator or detail', async () => {
  const report = await resolveProviderAvailability(new FixtureAdapter({
    status: 'available',
    locator: 'secret-provider-locator',
    detail: 'RAW-INFOHASH-SECRET https://api.torbox.app/private Bearer secret',
  }), view);
  assertEq(report.adapterStatus, 'available', 'adapter status');
  assertEq(report.decision.action, 'candidate', 'policy candidate');
  assertEq(report.advisoryOnly, true, 'advisory only');
  assertEq(report.persisted, false, 'not persisted');
  assertEq(report.echoesAdapterLocator, false, 'no locator echo');
  assertEq(report.echoesAdapterDetail, false, 'no detail echo');

  const output = JSON.stringify(report);
  for (const forbidden of ['secret-provider-locator', 'RAW-INFOHASH-SECRET', 'api.torbox.app', 'Bearer secret']) {
    assert(!output.includes(forbidden), `bridge output excludes ${forbidden}`);
  }
});

await test('bridge maps unavailable to skip and unknown or stale to hold', async () => {
  const miss = await resolveProviderAvailability(new FixtureAdapter({ status: 'unavailable', detail: 'miss' }), view);
  const unknown = await resolveProviderAvailability(new FixtureAdapter({ status: 'unknown', detail: 'auth' }), view);
  const stale = await resolveProviderAvailability(
    new FixtureAdapter({ status: 'available', locator: 'stale-locator' }),
    view,
    undefined,
    { observedAtMs: 1_000, nowMs: 5_000, maxAgeMs: 100 },
  );
  assertEq(miss.decision.action, 'skip', 'miss skips');
  assertEq(unknown.decision.action, 'hold', 'unknown holds');
  assertEq(stale.decision.status, 'stale', 'stale status');
  assertEq(stale.decision.action, 'hold', 'stale holds');
});

await test('bridge sanitizes hostile adapter status before returning report', async () => {
  const report = await resolveProviderAvailability(new HostileStatusAdapter(), view);
  assertEq(report.adapterStatus, 'unknown', 'hostile status is sanitized');
  assertEq(report.decision.status, 'invalid', 'policy sees invalid result');
  assertEq(report.decision.action, 'hold', 'invalid holds');
  const output = JSON.stringify(report);
  for (const forbidden of ['RAW-INFOHASH-SECRET', 'api.torbox.app', 'Bearer secret', 'provider payload detail']) {
    assert(!output.includes(forbidden), `bridge output excludes ${forbidden}`);
  }
});

await test('source stays pure with no provider construction, DB, env, network, or UI behavior', () => {
  const source = read('src/core/adapters/provider-availability-bridge.ts');
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

await test('package, docs, README, and deploy guard are wired', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['test:provider-availability-bridge'], 'tsx test/provider-availability-bridge.ts', 'test script');
  assert((pkg.scripts.test ?? '').includes('test/provider-availability-bridge.ts'), 'suite in npm test');
  assert(read('docs/PHASE_56_PROVIDER_AVAILABILITY_BRIDGE.md').includes('Phase 56'), 'phase doc exists');
  assert(read('README.md').includes('Provider availability bridge (Phase 56)'), 'README mentions phase');
  assert(read('test/deploy.ts').includes('provider availability bridge - Phase 56'), 'deploy guard mentions phase');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
