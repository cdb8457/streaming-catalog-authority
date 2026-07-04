import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildTorBoxLiveSmokeEvidencePreflightReport,
} from '../src/ops/torbox-live-smoke-evidence-preflight.js';
import {
  buildTorBoxLiveSmokeSummaryPack,
  formatTorBoxLiveSmokeSummaryPackJson,
  formatTorBoxLiveSmokeSummaryPackText,
} from '../src/ops/torbox-live-smoke-summary-pack.js';
import {
  fixedTorBoxLiveSmokeCategory,
  fixedTorBoxLiveSmokeOperation,
  fixedTorBoxLiveSmokeProbe,
  TORBOX_LIVE_SMOKE_CATEGORIES,
  TORBOX_LIVE_SMOKE_OPERATIONS,
  TORBOX_LIVE_SMOKE_PROBES,
  torBoxLiveSmokeOperationForProbe,
} from '../src/ops/torbox-live-smoke-labels.js';
import type { TorBoxLiveSmokeReport } from '../src/ops/torbox-live-smoke-runner.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

function phase43Report(overrides: Partial<TorBoxLiveSmokeReport> = {}): TorBoxLiveSmokeReport {
  return {
    report: 'phase-43-torbox-live-smoke-cli',
    phase: 43,
    ok: true,
    liveSmokeAttempted: true,
    wouldContactTorBox: true,
    command: 'smoke:torbox-readonly',
    mode: 'live-transport-smoke',
    probe: 'service-status',
    operation: 'status-check',
    category: 'live-smoke-ok',
    evidence: {
      statuses: ['available'],
      counts: {
        serviceStatusChecks: 1,
        hosterMetadataChecks: 0,
        cacheAvailabilityChecks: 0,
        availabilityHits: 1,
        availabilityMisses: 0,
        availabilityUnknown: 0,
      },
      credentialFile: 'configured',
      scopedRef: 'not-recorded',
    },
    notes: ['redaction-safe fixed note'],
    ...overrides,
  };
}

console.log('Running Phase 50 TorBox live smoke label contract suite:\n');

test('shared label contract enumerates the Phase 43/44/49 fixed live-smoke labels', () => {
  assert(TORBOX_LIVE_SMOKE_PROBES.join(',') === 'service-status,hoster-metadata,cache-availability', 'probe labels');
  assert(TORBOX_LIVE_SMOKE_OPERATIONS.join(',') === 'status-check,hoster-list,cache-availability', 'operation labels');
  for (const category of [
    'live-smoke-ok',
    'not-authorized',
    'not-read-only',
    'redaction-block',
    'unsupported-ref',
    'empty-ref',
    'auth',
    'quota',
    'timeout',
    'transport',
    'parse',
    'ambiguous-availability',
    'unknown',
  ]) assert(TORBOX_LIVE_SMOKE_CATEGORIES.includes(category as never), `category ${category}`);
});

test('operation mapping is shared and deterministic', () => {
  assert(torBoxLiveSmokeOperationForProbe('service-status') === 'status-check', 'service-status mapping');
  assert(torBoxLiveSmokeOperationForProbe('hoster-metadata') === 'hoster-list', 'hoster-metadata mapping');
  assert(torBoxLiveSmokeOperationForProbe('cache-availability') === 'cache-availability', 'cache mapping');
});

test('Phase 44 preflight and Phase 49 summary accept the same valid labels', () => {
  for (const probe of TORBOX_LIVE_SMOKE_PROBES) {
    const report = phase43Report({
      probe,
      operation: torBoxLiveSmokeOperationForProbe(probe),
      category: 'live-smoke-ok',
    });
    const preflight = buildTorBoxLiveSmokeEvidencePreflightReport(report as unknown as Record<string, unknown>);
    const summary = buildTorBoxLiveSmokeSummaryPack([report as unknown as Record<string, unknown>]);
    assert(preflight.summary.fail === 0, `${probe} preflight ready`);
    assert(summary.aggregate.failFindings === 0, `${probe} summary ready`);
    assert(summary.probes[0]?.probe === probe, `${probe} emitted unchanged`);
  }
});

test('invalid labels canonicalize without echoing hostile input', () => {
  const sentinels = [
    'RAW-INFOHASH-SECRET',
    'Private Movie Title 1999',
    'https://api.torbox.app/v1/api/torrents/checkcached?token=secret',
  ];
  assert(fixedTorBoxLiveSmokeProbe(sentinels[0]) === 'invalid-probe', 'invalid probe fixed');
  assert(fixedTorBoxLiveSmokeOperation(sentinels[1]) === 'invalid-operation', 'invalid operation fixed');
  assert(fixedTorBoxLiveSmokeCategory(sentinels[2]) === 'invalid-category', 'invalid category fixed');

  const summary = buildTorBoxLiveSmokeSummaryPack([
    phase43Report({
      probe: sentinels[0] as TorBoxLiveSmokeReport['probe'],
      operation: sentinels[1] as TorBoxLiveSmokeReport['operation'],
      category: sentinels[2] as TorBoxLiveSmokeReport['category'],
    }) as unknown as Record<string, unknown>,
  ]);
  assert(summary.probes[0]?.probe === 'invalid-probe', 'summary probe fixed');
  assert(summary.probes[0]?.operation === 'invalid-operation', 'summary operation fixed');
  assert(summary.probes[0]?.category === 'invalid-category', 'summary category fixed');
  const output = `${formatTorBoxLiveSmokeSummaryPackJson(summary)}\n${formatTorBoxLiveSmokeSummaryPackText(summary)}`;
  for (const sentinel of sentinels) assert(!output.includes(sentinel), `output excludes ${sentinel}`);
});

test('source uses one label contract instead of local Phase 44/49 duplicates', () => {
  const labels = read('src/ops/torbox-live-smoke-labels.ts');
  const preflight = read('src/ops/torbox-live-smoke-evidence-preflight.ts');
  const summary = read('src/ops/torbox-live-smoke-summary-pack.ts');
  const runner = read('src/ops/torbox-live-smoke-runner.ts');
  const shell = read('src/ops/torbox-smoke-shell.ts');
  assert(preflight.includes('TORBOX_LIVE_SMOKE_PROBES'), 'preflight imports shared probes');
  assert(summary.includes('fixedTorBoxLiveSmokeProbe'), 'summary imports fixed probe helper');
  assert(runner.includes('torBoxLiveSmokeOperationForProbe'), 'runner imports operation helper');
  assert(shell.includes('isTorBoxLiveSmokeProbe'), 'shell imports probe guard');
  assert(!preflight.includes("const PROBES = ['service-status'"), 'preflight local probes removed');
  assert(!summary.includes("const PROBES = ['service-status'"), 'summary local probes removed');
  for (const forbidden of [
    '@torbox/torbox-api',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'node:fs',
    'node:http',
    'node:https',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
  ]) assert(!labels.includes(forbidden), `label contract excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
