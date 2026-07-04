import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TORBOX_BOUNDARY_CONTRACT } from '../src/core/adapters/torbox-boundary.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const srcFiles = (): Array<[string, string]> => {
  const root = fileURLToPath(new URL('../src', import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(p) : e.name.endsWith('.ts') ? [p] : [];
  });
  return walk(root).map((p) => [p.replace(/\\/g, '/'), readFileSync(p, 'utf8')]);
};

console.log('Running Phase 31 TorBox boundary suite:\n');

test('contract names official TorBox capability groups from docs/SDK', () => {
  assertEq(TORBOX_BOUNDARY_CONTRACT.name, 'torbox-adapter-boundary-research', 'contract name');
  assert(TORBOX_BOUNDARY_CONTRACT.officialSources.includes('https://api-docs.torbox.app/'), 'official API docs linked');
  assert(TORBOX_BOUNDARY_CONTRACT.sdk.packageName === '@torbox/torbox-api', 'official SDK package named but not installed');
  for (const group of ['torrents', 'web-downloads-debrid', 'usenet', 'general-status', 'hosters']) {
    assert(TORBOX_BOUNDARY_CONTRACT.capabilities.some((c) => c.officialGroup === group), `group ${group} present`);
  }
  for (const surface of ['TorrentsService', 'WebDownloadsDebridService', 'UsenetService', 'GeneralService']) {
    assert(TORBOX_BOUNDARY_CONTRACT.capabilities.some((c) => c.officialSurface.includes(surface)), `surface ${surface} present`);
  }
});

test('Phase 31 permits only advisory cache/status/hoster capabilities', () => {
  const allowed = TORBOX_BOUNDARY_CONTRACT.capabilities.filter((c) => c.status === 'phase-31-allowed').map((c) => c.id).sort();
  assertEq(allowed.join(','), ['hoster-list', 'status-check', 'torrent-cache-check', 'usenet-cache-check', 'webdl-cache-check'].sort().join(','), 'allowed capability set');
  for (const forbidden of [
    'create torrent',
    'create web download',
    'create usenet download',
    'request download link',
    'retrieve user list',
    'control item',
    'delete item',
    'export torrent data',
  ]) assert((TORBOX_BOUNDARY_CONTRACT.forbiddenPhase31Operations as readonly string[]).includes(forbidden), `forbids ${forbidden}`);
  assert(TORBOX_BOUNDARY_CONTRACT.capabilities.some((c) => c.id === 'create-download' && c.status === 'future-gated'), 'create-download future gated');
  assert(TORBOX_BOUNDARY_CONTRACT.capabilities.some((c) => c.id === 'request-download-link' && c.status === 'future-gated'), 'download links future gated');
});

test('privacy boundary allows opaque item id plus exactly one scoped provider ref only', () => {
  assert(TORBOX_BOUNDARY_CONTRACT.allowedDataCrossing.inbound.includes('opaque itemId'), 'opaque item id allowed');
  assert(TORBOX_BOUNDARY_CONTRACT.allowedDataCrossing.inbound.includes('exactly one scoped provider ref'), 'one scoped ref allowed');
  assertEq(TORBOX_BOUNDARY_CONTRACT.allowedDataCrossing.maxProviderRefsPerCall, 1, 'one ref per call');
  for (const forbidden of ['title', 'year', 'metadata', 'raw catalog identity', 'raw provider ref fanout', 'media titles', 'Jellyfin ids', 'Plex ids']) {
    assert((TORBOX_BOUNDARY_CONTRACT.forbiddenDataCrossing as readonly string[]).includes(forbidden), `forbids ${forbidden}`);
  }
});

test('credential and redaction rules forbid tokens in URLs/logs/evidence and require secret indirection', () => {
  const rules = TORBOX_BOUNDARY_CONTRACT.credentialRules.join('\n');
  assert(/secret indirection/i.test(rules), 'future token uses secret indirection');
  assert(/must not read environment variables/i.test(rules), 'no Phase 31 env reads');
  assert(/must not appear in URLs, logs, evidence/i.test(rules), 'no token URL/log/evidence leakage');
  assert(/Authorization Bearer\/header auth/i.test(rules), 'header auth preferred');
  assert(TORBOX_BOUNDARY_CONTRACT.forbiddenPhase31Operations.includes('put token in URL'), 'token in URL forbidden');
});

test('Phase 31 source has no runtime dependency, network, DB, Docker, env read, or provider behavior', () => {
  const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts: Record<string, string> };
  const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!deps.includes('@torbox/torbox-api'), 'no TorBox SDK dependency');
  assert(typeof pkg.scripts['test:torbox-boundary'] === 'string', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-boundary.ts'), 'suite wired into npm test');

  const source = read('src/core/adapters/torbox-boundary.ts');
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
    'fetch(',
    'process.env',
    'readFileSync',
    'readdirSync',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
  ]) assert(!source.includes(forbidden), `torbox boundary source excludes ${forbidden}`);
  assert(!/import\s+.*@torbox\/torbox-api/.test(source), 'does not import SDK');
});

test('docs preserve no live TorBox, no downloads/playback/provider mode, and no SDK dep', () => {
  const doc = read('docs/PHASE_31_TORBOX_BOUNDARY.md');
  const readme = read('README.md');
  const adapterDoc = read('docs/PHASE_7_ADAPTER_BOUNDARY.md');
  const combined = `${doc}\n${readme}\n${adapterDoc}`;
  for (const kw of ['no live TorBox', 'no downloading', 'no playback', 'no provider mode', 'no SDK dependency', '@torbox/torbox-api']) {
    assert(combined.includes(kw), `docs include ${kw}`);
  }
  assert(/local fake TorBox adapter contract[\s\S]*gated real client/i.test(doc), 'future sequence is explicit');
  assert(/O4 remains open\/deferred/i.test(doc) && /O5 remains open\/deferred/i.test(doc), 'production gates preserved');
  assert(/`?FileCustodian`? remains a hardened reference\s+harness, not production KMS/i.test(doc), 'FileCustodian boundary preserved');
});

test('no accidental TorBox implementation appears outside the static boundary and local fake contract files', () => {
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
    'src/ops/torbox-live-smoke-packet-manifest.ts',
    'src/ops/torbox-live-smoke-packet-manifest-cli.ts',
    'src/ops/torbox-live-smoke-acceptance-record.ts',
    'src/ops/torbox-live-smoke-acceptance-record-cli.ts',
    'src/ops/torbox-live-smoke-plan.ts',
    'src/ops/torbox-live-smoke-plan-cli.ts',
    'test/torbox-boundary.ts',
  ]);
  const phase50Labels = read('src/ops/torbox-live-smoke-labels.ts');
  const phase49Summary = read('src/ops/torbox-live-smoke-summary-pack.ts');
  const phase49Cli = read('src/ops/torbox-live-smoke-summary-pack-cli.ts');
  for (const forbidden of [
    '@torbox/torbox-api',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'request-download-link',
    'request-permalink',
  ]) assert(!`${phase50Labels}\n${phase49Summary}\n${phase49Cli}`.includes(forbidden), `Phase 49/50 summary source excludes ${forbidden}`);
  for (const [path, source] of srcFiles()) {
    const rel = path.replace(fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/'), '');
    if (allowed.has(rel)) continue;
    assert(!/torbox/i.test(source), `${rel} does not name TorBox`);
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
