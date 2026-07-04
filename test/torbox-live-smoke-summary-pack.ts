import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTorBoxLiveSmokeSummaryInputErrorPack,
  buildTorBoxLiveSmokeSummaryPack,
  formatTorBoxLiveSmokeSummaryPackJson,
  formatTorBoxLiveSmokeSummaryPackText,
  parseTorBoxLiveSmokeSummaryEvidenceJson,
  type TorBoxLiveSmokeSummaryPack,
} from '../src/ops/torbox-live-smoke-summary-pack.js';
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

function assertNoLeak(output: string, sentinels: readonly string[]): void {
  for (const sentinel of sentinels) assert(!output.includes(sentinel), `output leaked sentinel: ${sentinel}`);
}

function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return path;
}

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/torbox-live-smoke-summary-pack-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 49 TorBox live smoke summary pack suite:\n');

test('valid service and hoster reports produce a redaction-safe review summary', () => {
  const report = buildTorBoxLiveSmokeSummaryPack([phase43Report(), hosterReport()] as unknown as Record<string, unknown>[]);
  assert(report.report === 'phase-49-torbox-live-smoke-summary-pack', 'report name');
  assert(report.reviewReadiness === 'ready-for-review', 'ready for review');
  assert(report.aggregate.totalReports === 2, 'two reports summarized');
  assert(report.aggregate.readyForReview === 2, 'both reports ready');
  assert(report.aggregate.failFindings === 0, 'no fail findings');
  assert(report.aggregate.warnFindings >= 8, 'gate warnings preserved');
  assert(report.probes.map((probe) => probe.probe).join(',') === 'service-status,hoster-metadata', 'probe labels only');
  assert(report.redactionSafe === true, 'redaction safe');
  assert(report.evidenceValuesEchoed === false, 'does not echo values');
  assert(report.credentialValuesIncluded === false && report.credentialPathsIncluded === false, 'no credentials');
  assert(report.rawRefsIncluded === false && report.providerPayloadsIncluded === false, 'no refs or payloads');
  assert(report.liveTorBoxContact === false && report.commandExecution === false, 'summary is non-live');
  assert(report.closesLiveSmokeReview === false, 'does not close review');
});

test('invalid report shape blocks review without leaking hostile values', () => {
  const sentinels = [
    'TORBOX_TOKEN=secret-token',
    'Bearer secret-token',
    'RAW-INFOHASH-SECRET',
    'SECRET-PROVIDER-PAYLOAD',
    'https://api.torbox.app/v1/api/torrents/checkcached?token=secret',
    'Private Movie Title 1999',
    '/run/secrets/torbox-token',
  ];
  const hostile = {
    ...phase43Report(),
    probe: 'RAW-INFOHASH-SECRET',
    operation: 'Private Movie Title 1999',
    category: 'https://api.torbox.app/v1/api/torrents/checkcached?token=secret',
    extraPayload: sentinels.join('|'),
    notes: sentinels,
    evidence: {
      statuses: ['available', 'SECRET-STATUS'],
      counts: { serviceStatusChecks: 1 },
      credentialFile: '/run/secrets/torbox-token',
      scopedRef: 'RAW-INFOHASH-SECRET',
      providerPayload: 'SECRET-PROVIDER-PAYLOAD',
    },
  };
  const report = buildTorBoxLiveSmokeSummaryPack([hostile] as Record<string, unknown>[]);
  assert(report.reviewReadiness === 'not-ready-for-review', 'invalid report blocks review');
  assert(report.aggregate.failFindings > 0, 'fail findings counted');
  assert(report.probes[0]?.probe === 'invalid-probe', 'hostile probe is canonicalized');
  assert(report.probes[0]?.operation === 'invalid-operation', 'hostile operation is canonicalized');
  assert(report.probes[0]?.category === 'invalid-category', 'hostile category is canonicalized');
  assertNoLeak(formatTorBoxLiveSmokeSummaryPackJson(report), sentinels);
  assertNoLeak(formatTorBoxLiveSmokeSummaryPackText(report), sentinels);
});

test('input errors fail closed with fixed codes and no path/value echo', () => {
  const sentinels = ['SECRET_VALUE_SHOULD_NOT_APPEAR', 'C:/secret/path/report.json'];
  for (const code of [
    'SUMMARY_FILE_READ_FAILED',
    'SUMMARY_FILE_TOO_LARGE',
    'SUMMARY_JSON_MALFORMED',
    'SUMMARY_OBJECT_REQUIRED',
    'SUMMARY_TOO_MANY_INPUTS',
    'SUMMARY_INPUT_REQUIRED',
  ] as const) {
    const report = buildTorBoxLiveSmokeSummaryInputErrorPack(code);
    assert(report.reviewReadiness === 'not-ready-for-review', `${code} blocks review`);
    assert(report.aggregate.failFindings === 1, `${code} has one fail`);
    assertNoLeak(formatTorBoxLiveSmokeSummaryPackJson(report), sentinels);
    assertNoLeak(formatTorBoxLiveSmokeSummaryPackText(report), sentinels);
  }
});

test('parser accepts BOM JSON and rejects malformed/non-object evidence', () => {
  assert(typeof parseTorBoxLiveSmokeSummaryEvidenceJson(`\uFEFF${JSON.stringify(phase43Report())}`) === 'object', 'BOM JSON accepted');
  assert(parseTorBoxLiveSmokeSummaryEvidenceJson('{"bad"') === 'SUMMARY_JSON_MALFORMED', 'malformed JSON rejected');
  assert(parseTorBoxLiveSmokeSummaryEvidenceJson(JSON.stringify(['not-object'])) === 'SUMMARY_OBJECT_REQUIRED', 'array rejected');
  assert(parseTorBoxLiveSmokeSummaryEvidenceJson(JSON.stringify('not-object')) === 'SUMMARY_OBJECT_REQUIRED', 'primitive rejected');
});

test('CLI reads explicit files only and emits parseable JSON without path leaks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-49-summary-'));
  try {
    const service = writeJson(tmp, 'service.json', phase43Report());
    const hoster = writeJson(tmp, 'hoster.json', hosterReport());
    const result = runCli(['--', service, hoster, '--json']);
    assert(result.status === 0, `CLI exits 0: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout) as TorBoxLiveSmokeSummaryPack;
    assert(parsed.report === 'phase-49-torbox-live-smoke-summary-pack', 'stdout summary report');
    assert(parsed.aggregate.totalReports === 2, 'two files summarized');
    assertNoLeak(`${result.stdout}\n${result.stderr}`, [tmp, service, hoster]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI rejects missing, directory, oversized, and too many inputs without path leaks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-49-errors-'));
  try {
    const missing = join(tmp, 'missing-secret-report.json');
    const directory = join(tmp, 'evidence-dir');
    mkdirSync(directory);
    const oversized = writeJson(tmp, 'oversized.json', 'x'.repeat(70 * 1024));

    for (const [args, code] of [
      [['--', missing, '--json'], 'SUMMARY_FILE_READ_FAILED'],
      [['--', directory, '--json'], 'SUMMARY_FILE_READ_FAILED'],
      [['--', oversized, '--json'], 'SUMMARY_FILE_TOO_LARGE'],
      [['--json'], 'SUMMARY_INPUT_REQUIRED'],
      [['--', ...Array.from({ length: 9 }, (_, i) => writeJson(tmp, `r${i}.json`, phase43Report())), '--json'], 'SUMMARY_TOO_MANY_INPUTS'],
    ] as const) {
      const result = runCli(args);
      assert(result.status === 1, `${code} exits 1`);
      const parsed = JSON.parse(result.stdout) as TorBoxLiveSmokeSummaryPack;
      assert(parsed.findings.some((finding) => finding.code === code), `${code} fixed code present`);
      assertNoLeak(`${result.stdout}\n${result.stderr}`, [tmp, missing, directory, oversized]);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('npm package-script JSON invocation emits parseable redaction-safe JSON', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-49-npm-'));
  try {
    const service = writeJson(tmp, 'service.json', phase43Report());
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npm, ['run', '--silent', 'ops:torbox-live-smoke-summary-pack', '--', '--', service, '--json'], {
      cwd: root,
      encoding: 'utf8',
      shell: true,
    });
    assert(result.status === 0, `npm script exits 0: ${result.stderr ?? result.error?.message}`);
    const parsed = JSON.parse(result.stdout) as TorBoxLiveSmokeSummaryPack;
    assert(parsed.report === 'phase-49-torbox-live-smoke-summary-pack', 'stdout is Phase 49 JSON');
    assert(parsed.liveTorBoxContact === false && parsed.commandExecution === false, 'npm JSON remains non-live');
    assertNoLeak(`${result.stdout}\n${result.stderr}`, [service, tmp]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('docs and source preserve no-live/no-secret/no-provider-write boundaries', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  assert(pkg.scripts['ops:torbox-live-smoke-summary-pack'] === 'tsx src/ops/torbox-live-smoke-summary-pack-cli.ts', 'ops script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-smoke-summary-pack.ts'), 'suite in npm test');

  const source = `${read('src/ops/torbox-live-smoke-summary-pack.ts')}\n${read('src/ops/torbox-live-smoke-summary-pack-cli.ts')}`;
  const docs = `${read('docs/PHASE_49_TORBOX_LIVE_SMOKE_SUMMARY_PACK.md')}\n${read('README.md')}`;
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
