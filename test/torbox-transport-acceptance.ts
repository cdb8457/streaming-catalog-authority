import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runTorBoxTransportAcceptanceHarness } from '../src/ops/torbox-transport-acceptance.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';

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
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

function walkTs(relDir: string): Array<[string, string]> {
  const abs = fileURLToPath(new URL(`../${relDir}`, import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
  return walk(abs).map((path) => [path.replace(/\\/g, '/').replace(repoRoot, ''), readFileSync(path, 'utf8')]);
}

console.log('Running Phase 39 TorBox transport acceptance suite:\n');

await test('Phase 39 docs, source, and package wiring exist', () => {
  assert(exists('src/ops/torbox-transport-acceptance.ts'), 'Phase 39 acceptance source exists');
  assert(exists('docs/PHASE_39_TORBOX_TRANSPORT_ACCEPTANCE.md'), 'Phase 39 doc exists');
  assertEq(pkg.scripts['test:torbox-transport-acceptance'], 'tsx test/torbox-transport-acceptance.ts', 'focused script present');
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/torbox-transport-acceptance.ts'), 'acceptance suite is in npm test');
  assert(!(AGGREGATE_SUITE_COMMAND ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');
  assert(!(pkg.scripts.ci ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm ci');
});

await test('acceptance matrix runs through injected local fixtures only', async () => {
  const report = await runTorBoxTransportAcceptanceHarness();
  assertEq(report.report, 'phase-39-torbox-transport-acceptance', 'report name');
  assertEq(report.phase, 39, 'phase number');
  assertEq(report.ok, true, 'expected acceptance matrix passes');
  assertEq(report.liveNetwork, false, 'no live network');
  assertEq(report.wouldContactTorBox, false, 'no TorBox contact');
  assertEq(report.transport, 'injected-local-fixture-only', 'transport mode');
  assert(report.gates.every((gate) => gate.ok), 'all acceptance gates pass');
  assertEq(report.evidence.counts.total, 10, 'eight cache scenarios plus two operation probes');
  assertEq(report.evidence.counts.available, 3, 'cache, status, and hoster available probes');
  assertEq(report.evidence.counts.unavailable, 1, 'unavailable cache probe counted');
  assertEq(report.evidence.counts.unknown, 6, 'unknown and fixed failure probes counted');
  assertEq(report.evidence.counts.blocked, 5, 'fixed failure categories counted');
});

await test('fixed categories and read-only operations are covered', async () => {
  const report = await runTorBoxTransportAcceptanceHarness();
  for (const category of ['fixture-ok', 'auth', 'quota', 'timeout', 'parse', 'ambiguous-response']) {
    assert(report.evidence.categories.includes(category as never), `category ${category} covered`);
  }
  for (const operation of ['torrent-cache-check', 'status-check', 'hoster-list']) {
    assert(report.evidence.operations.includes(operation as never), `operation ${operation} covered`);
  }
  for (const forbidden of ['create-download', 'request-download-link', 'request-permalink', 'user-list', 'delete-item', 'cdn-url']) {
    assert(!JSON.stringify(report).includes(forbidden), `report excludes future-gated operation ${forbidden}`);
  }
});

await test('public report redacts raw refs, provider payloads, URLs, and secrets', async () => {
  const report = await runTorBoxTransportAcceptanceHarness();
  const publicOutput = JSON.stringify(report);
  for (const forbidden of [
    'RAW-INFOHASH-SECRET',
    'SECRET-PROVIDER-PAYLOAD',
    'providerPayload',
    'TOKEN=',
    'API_KEY=',
    'Bearer ',
    'https://',
    'http://',
    'cdn.example',
    'permalink.example',
  ]) assert(!publicOutput.includes(forbidden), `public report excludes ${forbidden}`);
});

await test('docs preserve no-live boundaries and open production gates', () => {
  const combined = [
    read('docs/PHASE_39_TORBOX_TRANSPORT_ACCEPTANCE.md'),
    read('docs/PHASE_38_TORBOX_SMOKE_FIXTURE_HARNESS.md'),
    read('README.md'),
  ].join('\n');
  for (const term of [
    'deterministic transport acceptance harness',
    'does not add a live TorBox transport',
    'no live TorBox calls',
    'no real TorBox transport implementation',
    'no `@torbox/torbox-api` dependency or import',
    'no global fetch',
    'no environment-variable reads',
    'no ADAPTER_MODE wiring',
    'no adapter-factory mode for TorBox',
    'request-download-link',
    'request-permalink',
    'CDN',
    'permalink URL',
    'playback',
    'downloading',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian` remains a hardened reference',
  ]) assert(combined.includes(term), `docs include ${term}`);
});

await test('Phase 39 source has no SDK, network, env, DB, Docker, or adapter-mode creep', () => {
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  const source = read('src/ops/torbox-transport-acceptance.ts');
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
    'fetch(',
    'process.env',
    'readFileSync',
    'readdirSync',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'createTorBoxTransport',
    'TorBoxLiveTransport',
    'requestDownloadLink',
    'create-download',
  ]) assert(!source.includes(forbidden), `Phase 39 source excludes ${forbidden}`);
});

await test('TorBox source allowlist includes Phase 39 explicitly and nothing accidental', () => {
  const allowed = new Set([
    // Phase 250. NOT an implementation: this file names TorBox only inside a REDACTION pattern that
    // REFUSES a readiness packet mentioning a live provider. The allowlists predate it; excluding it would
    // mean the guard that forbids the word cannot itself contain the word.
    'src/ops/release-readiness.ts',
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
    // PHASE 50 - THE READ-ONLY requestdl RESOLVER. Phase 41 future-gated the three
    // requestdl endpoints and said they require a later explicit phase;
    // docs/PHASE_50_TORBOX_RESOLVER.md is that phase and these are the files it
    // authorises. This list is what stops TorBox knowledge leaking into the rest of
    // the codebase by accident, so a file joins it deliberately or not at all.
    // The Phase 33 smoke client is UNTOUCHED: request-download-link remains
    // future-gated there and torbox-live-transport.ts stays cache-and-status only.
    'src/core/adapters/torbox-resolver.ts',
    'src/ops/torbox-resolver-service.ts',
    'src/ops/torbox-resolver-cli.ts',
    'src/ops/torbox-fixture-service.ts',
    'src/ops/torbox-fixture-cli.ts',
    'test/torbox-resolver.ts',
    // PROJECTION PHASE 9 - TORBOX PLUS USENET. docs/PROJECTION_PHASE_9_TORBOX_USENET.md is the phase that
    // authorises these eight. NONE of them contacts TorBox, implements a TorBox operation, holds a TorBox
    // credential or resolves a TorBox link. They name it because §4's sixth hard refusal is "let a Usenet
    // outage alter the TorBox namespace", and keeping that promise means comparing the TorBox half of the
    // namespace before and after every Usenet publish. A guard that may not name the thing it guards
    // cannot guard it, which is the same argument src/ops/release-readiness.ts is on this list for.
    'src/core/usenet/sab-contract.ts',
    'src/core/usenet/manifest-bridge.ts',
    // admission.ts and status-report.ts joined this list when the drift guard
    // moved INTO the publish path: `admit()` compares the namespace around every
    // publish and refuses `torbox-namespace-drifted`, and status-report.ts is where
    // that refusal is explained to an operator. Neither contacts TorBox, resolves a
    // link or holds a credential; both name it because the guard and its diagnostic
    // have to say what they are guarding.
    'src/core/usenet/admission.ts',
    'src/core/usenet/status-report.ts',
    'src/core/projection/phase9.ts',
    'src/ops/usenet-command.ts',
    'src/ops/usenet-rehearsal.ts',
    'src/ops/usenet-rehearsal-cli.ts',
    // PROJECTION PHASE 10 - THE OPERATOR CONTENT PLANE. docs/PROJECTION_PHASE_10_OPERATOR_CONTENT_PLANE.md
    // is the phase that authorises these four, and §2.1 is why they exist at all: the TorBox drift guard
    // `torBoxDrift` had TWO implementors of `namespaceSnapshot` -- the rehearsal's in-memory publisher and a
    // unit-test fake -- so on a real appliance `before` was always null, the comparison was always skipped,
    // and every real admission was recorded `admittedWithoutDriftCheck`. D10.1 is the repair.
    //
    // NONE OF THE FOUR CONTACTS TORBOX, implements a TorBox operation, holds a TorBox credential or resolves
    // a TorBox link. Phase 10 is PROVIDER-FREE BY CONSTRUCTION and its §4 third hard refusal says endpoint.json
    // is not read, written or touched at any point.
    //
    //   namespace-snapshot.ts  reads the live namespace so the guard has a `before` and an `after` to compare;
    //                          it names TorBox because a guard that may not name what it guards cannot guard it,
    //                          which is the same argument src/ops/release-readiness.ts is on this list for.
    //   phase10.ts             states the claim P10-3 measures, in the words the contract uses.
    //   projection-content.ts  ships the `add-torbox` verb: it REGISTERS an opaque object reference through the
    //   projection-content-cli.ts   existing `http-range` boundary and resolves nothing. Registering a reference is
    //                          not contacting a provider, which is exactly why Phase 10 can close without a window.
    'src/core/projection/namespace-snapshot.ts',
    'src/core/projection/phase10.ts',
    'src/ops/projection-content.ts',
    'src/ops/projection-content-cli.ts',
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
