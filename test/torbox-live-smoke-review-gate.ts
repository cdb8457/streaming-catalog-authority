import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTorBoxLiveSmokeReviewGateInputErrorReport,
  buildTorBoxLiveSmokeReviewGateReport,
  formatTorBoxLiveSmokeReviewGateJson,
  formatTorBoxLiveSmokeReviewGateText,
  parseTorBoxLiveSmokeReviewGateSummaryJson,
  type TorBoxLiveSmokeReviewGateReport,
} from '../src/ops/torbox-live-smoke-review-gate.js';
import { buildTorBoxLiveSmokeSummaryPack } from '../src/ops/torbox-live-smoke-summary-pack.js';
import type { TorBoxLiveSmokeReport } from '../src/ops/torbox-live-smoke-runner.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const root = fileURLToPath(new URL('..', import.meta.url));
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

function hosterReport(): TorBoxLiveSmokeReport {
  return phase43Report({
    probe: 'hoster-metadata',
    operation: 'hoster-list',
    evidence: {
      statuses: ['available'],
      counts: {
        serviceStatusChecks: 0,
        hosterMetadataChecks: 1,
        cacheAvailabilityChecks: 0,
        availabilityHits: 1,
        availabilityMisses: 0,
        availabilityUnknown: 0,
      },
      credentialFile: 'configured',
      scopedRef: 'not-recorded',
    },
  });
}

function cacheReport(): TorBoxLiveSmokeReport {
  return phase43Report({
    probe: 'cache-availability',
    operation: 'cache-availability',
    evidence: {
      statuses: ['available'],
      counts: {
        serviceStatusChecks: 0,
        hosterMetadataChecks: 0,
        cacheAvailabilityChecks: 1,
        availabilityHits: 1,
        availabilityMisses: 0,
        availabilityUnknown: 0,
      },
      credentialFile: 'configured',
      scopedRef: 'present',
    },
  });
}

function readySummary(): Record<string, unknown> {
  return buildTorBoxLiveSmokeSummaryPack([
    phase43Report() as unknown as Record<string, unknown>,
    hosterReport() as unknown as Record<string, unknown>,
  ]) as unknown as Record<string, unknown>;
}

function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return path;
}

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/torbox-live-smoke-review-gate-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function assertNoLeak(output: string, sentinels: readonly string[]): void {
  for (const sentinel of sentinels) assert(!output.includes(sentinel), `output leaked sentinel: ${sentinel}`);
}

console.log('Running Phase 51 TorBox live smoke review gate suite:\n');

test('ready Phase 49 service and hoster summary prepares redaction-safe review', () => {
  const report = buildTorBoxLiveSmokeReviewGateReport(readySummary());
  assert(report.report === 'phase-51-torbox-live-smoke-review-gate', 'report name');
  assert(report.reviewReadiness === 'ready-for-review', 'ready for review');
  assert(report.summary.fail === 0, 'no fail findings');
  assert(report.redactionSafe === true && report.summaryValuesEchoed === false, 'redaction-safe');
  assert(report.liveTorBoxContact === false && report.commandExecution === false, 'non-live');
  assert(report.closesLiveSmokeReview === false, 'does not close review');
  assert(report.o4Status === 'open/deferred' && report.o5Status === 'open/deferred', 'O4/O5 open');
  assert(report.findings.some((finding) => finding.code === 'SERVICE_STATUS_PROBE_READY'), 'service ready');
  assert(report.findings.some((finding) => finding.code === 'HOSTER_METADATA_PROBE_READY'), 'hoster ready');
  assert(report.findings.some((finding) => finding.code === 'OPTIONAL_CACHE_AVAILABILITY_ABSENT'), 'cache optional warning');
});

test('optional cache probe is accepted when ready', () => {
  const summary = buildTorBoxLiveSmokeSummaryPack([
    phase43Report() as unknown as Record<string, unknown>,
    hosterReport() as unknown as Record<string, unknown>,
    cacheReport() as unknown as Record<string, unknown>,
  ]) as unknown as Record<string, unknown>;
  const report = buildTorBoxLiveSmokeReviewGateReport(summary);
  assert(report.reviewReadiness === 'ready-for-review', 'cache summary remains ready');
  assert(report.findings.some((finding) => finding.code === 'CACHE_AVAILABILITY_PROBE_READY'), 'cache ready');
});

test('missing required probe blocks review', () => {
  const summary = buildTorBoxLiveSmokeSummaryPack([phase43Report() as unknown as Record<string, unknown>]) as unknown as Record<string, unknown>;
  const report = buildTorBoxLiveSmokeReviewGateReport(summary);
  assert(report.reviewReadiness === 'not-ready-for-review', 'missing hoster blocks review');
  assert(report.findings.some((finding) => finding.code === 'HOSTER_METADATA_PROBE_REQUIRED'), 'hoster required code');
});

test('mismatched Phase 43 probe-operation pair makes review gate not ready', () => {
  const summary = buildTorBoxLiveSmokeSummaryPack([
    phase43Report({
      probe: 'service-status',
      operation: 'cache-availability',
      category: 'live-smoke-ok',
    }) as unknown as Record<string, unknown>,
    hosterReport() as unknown as Record<string, unknown>,
  ]) as unknown as Record<string, unknown>;
  const report = buildTorBoxLiveSmokeReviewGateReport(summary);
  assert(report.reviewReadiness === 'not-ready-for-review', 'mismatch blocks review gate');
  assert(report.findings.some((finding) => finding.code === 'SERVICE_STATUS_PROBE_NOT_READY'), 'service probe not ready');
});

test('unsafe summary metadata and hostile values do not leak', () => {
  const sentinels = [
    'TORBOX_TOKEN=secret-token',
    '/run/secrets/torbox-token',
    'RAW-INFOHASH-SECRET',
    'https://api.torbox.app/v1/api/torrents/checkcached?token=secret',
    'Private Movie Title 1999',
  ];
  const summary = {
    ...readySummary(),
    redactionSafe: false,
    evidenceValuesEchoed: true,
    credentialPathsIncluded: true,
    hostile: sentinels.join('|'),
  };
  const report = buildTorBoxLiveSmokeReviewGateReport(summary);
  assert(report.reviewReadiness === 'not-ready-for-review', 'unsafe metadata blocks readiness');
  assert(report.summary.fail > 0, 'failures counted');
  assertNoLeak(formatTorBoxLiveSmokeReviewGateJson(report), sentinels);
  assertNoLeak(formatTorBoxLiveSmokeReviewGateText(report), sentinels);
});

test('parser and fixed input errors fail closed without value echo', () => {
  const sentinels = ['SECRET_VALUE_SHOULD_NOT_APPEAR', 'C:/secret/path/summary.json'];
  assert(typeof parseTorBoxLiveSmokeReviewGateSummaryJson(`\uFEFF${JSON.stringify(readySummary())}`) === 'object', 'BOM JSON accepted');
  assert(parseTorBoxLiveSmokeReviewGateSummaryJson('{"bad"') === 'REVIEW_GATE_JSON_MALFORMED', 'malformed JSON rejected');
  assert(parseTorBoxLiveSmokeReviewGateSummaryJson(JSON.stringify(['not-object'])) === 'REVIEW_GATE_OBJECT_REQUIRED', 'array rejected');

  for (const code of [
    'REVIEW_GATE_FILE_READ_FAILED',
    'REVIEW_GATE_FILE_TOO_LARGE',
    'REVIEW_GATE_JSON_MALFORMED',
    'REVIEW_GATE_OBJECT_REQUIRED',
    'REVIEW_GATE_INPUT_REQUIRED',
  ] as const) {
    const report = buildTorBoxLiveSmokeReviewGateInputErrorReport(code);
    assert(report.reviewReadiness === 'not-ready-for-review', `${code} blocks review`);
    assertNoLeak(formatTorBoxLiveSmokeReviewGateJson(report), sentinels);
    assertNoLeak(formatTorBoxLiveSmokeReviewGateText(report), sentinels);
  }
});

test('CLI reads one explicit summary file and emits parseable JSON without path leaks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-51-review-'));
  try {
    const summaryPath = writeJson(tmp, 'summary.json', readySummary());
    const result = runCli(['--', summaryPath, '--json']);
    assert(result.status === 0, `CLI exits 0: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout) as TorBoxLiveSmokeReviewGateReport;
    assert(parsed.report === 'phase-51-torbox-live-smoke-review-gate', 'stdout is Phase 51 JSON');
    assert(parsed.reviewReadiness === 'ready-for-review', 'CLI JSON ready');
    assertNoLeak(`${result.stdout}\n${result.stderr}`, [tmp, summaryPath]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI rejects missing, directory, oversized, and multiple inputs without path leaks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-51-errors-'));
  try {
    const missing = join(tmp, 'missing-secret-summary.json');
    const directory = join(tmp, 'summary-dir');
    mkdirSync(directory);
    const oversized = writeJson(tmp, 'oversized.json', 'x'.repeat(70 * 1024));

    for (const [args, code] of [
      [['--', missing, '--json'], 'REVIEW_GATE_FILE_READ_FAILED'],
      [['--', directory, '--json'], 'REVIEW_GATE_FILE_READ_FAILED'],
      [['--', oversized, '--json'], 'REVIEW_GATE_FILE_TOO_LARGE'],
      [['--json'], 'REVIEW_GATE_INPUT_REQUIRED'],
    ] as const) {
      const result = runCli(args);
      assert(result.status === 1, `${code} exits 1`);
      const parsed = JSON.parse(result.stdout) as TorBoxLiveSmokeReviewGateReport;
      assert(parsed.findings.some((finding) => finding.code === code), `${code} fixed code present`);
      assertNoLeak(`${result.stdout}\n${result.stderr}`, [tmp, missing, directory, oversized]);
    }

    const result = runCli(['--', writeJson(tmp, 'one.json', readySummary()), writeJson(tmp, 'two.json', readySummary()), '--json']);
    assert(result.status === 2, 'multiple inputs usage error');
    assertNoLeak(`${result.stdout}\n${result.stderr}`, [tmp]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('npm package-script JSON invocation emits parseable redaction-safe JSON', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-51-npm-'));
  try {
    const summaryPath = writeJson(tmp, 'summary.json', readySummary());
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npm, ['run', '--silent', 'ops:torbox-live-smoke-review-gate', '--', '--', summaryPath, '--json'], {
      cwd: root,
      encoding: 'utf8',
      shell: true,
    });
    assert(result.status === 0, `npm script exits 0: ${result.stderr ?? result.error?.message}`);
    const parsed = JSON.parse(result.stdout) as TorBoxLiveSmokeReviewGateReport;
    assert(parsed.report === 'phase-51-torbox-live-smoke-review-gate', 'stdout is Phase 51 JSON');
    assert(parsed.liveTorBoxContact === false && parsed.commandExecution === false, 'npm JSON remains non-live');
    assertNoLeak(`${result.stdout}\n${result.stderr}`, [summaryPath, tmp]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('docs and source preserve static review-gate boundaries', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  assert(pkg.scripts['ops:torbox-live-smoke-review-gate'] === 'tsx src/ops/torbox-live-smoke-review-gate-cli.ts', 'ops script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-smoke-review-gate.ts'), 'suite in npm test');

  const source = `${read('src/ops/torbox-live-smoke-review-gate.ts')}\n${read('src/ops/torbox-live-smoke-review-gate-cli.ts')}`;
  const docs = `${read('docs/PHASE_51_TORBOX_LIVE_SMOKE_REVIEW_GATE.md')}\n${read('README.md')}`;
  for (const kw of [
    'no credential values',
    'no credential file paths',
    'no raw refs',
    'no live TorBox calls',
    'no env reads',
    'no database access',
    'no transport construction',
    'no downloads',
    'playback',
    'does not close live-smoke review',
  ]) assert(docs.includes(kw), `docs include ${kw}`);
  for (const forbidden of [
    '@torbox/torbox-api',
    "from 'pg'",
    'node:http',
    'node:https',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'execFileSync',
    'spawnSync',
    'docker compose',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'request-download-link',
    'request-permalink',
    'readFileSync',
    'readdirSync',
    'existsSync',
  ]) assert(!source.includes(forbidden), `source excludes ${forbidden}`);
  assert(source.includes("from 'node:fs'") && source.includes('openSync') && source.includes('readSync'), 'CLI has bounded explicit file reads');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
