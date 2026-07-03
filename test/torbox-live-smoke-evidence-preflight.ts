import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTorBoxLiveSmokeEvidencePreflightInputErrorReport,
  buildTorBoxLiveSmokeEvidencePreflightReport,
  formatTorBoxLiveSmokeEvidencePreflightJson,
  formatTorBoxLiveSmokeEvidencePreflightText,
  parseTorBoxLiveSmokeEvidenceJson,
  type TorBoxLiveSmokeEvidenceInputErrorCode,
  type TorBoxLiveSmokeEvidencePreflightReport,
} from '../src/ops/torbox-live-smoke-evidence-preflight.js';
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
    notes: [
      'Phase 43 live smoke is operator-run only and absent from CI.',
      'Evidence is limited to fixed statuses, counts, operation names, and categories.',
    ],
    ...overrides,
  };
}

function codes(report: TorBoxLiveSmokeEvidencePreflightReport): Set<string> {
  return new Set(report.findings.map((finding) => finding.code));
}

function assertNoLeak(output: string, sentinels: readonly string[]): void {
  for (const sentinel of sentinels) assert(!output.includes(sentinel), `output leaked sentinel: ${sentinel}`);
}

function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return path;
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/torbox-live-smoke-evidence-preflight-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 44 TorBox live smoke evidence preflight suite:\n');

test('valid Phase 43 evidence is ready for review without contacting TorBox', () => {
  const report = buildTorBoxLiveSmokeEvidencePreflightReport(phase43Report() as unknown as Record<string, unknown>);
  assert(report.report === 'phase-44-torbox-live-smoke-evidence-preflight', 'report name');
  assert(report.summary.fail === 0, 'valid evidence has no fail findings');
  assert(report.reviewReadiness === 'ready-for-review', 'valid evidence is ready for review');
  assert(report.liveTorBoxContact === false, 'preflight does not contact TorBox');
  assert(report.closesLiveSmokeReview === false, 'preflight does not close live smoke review');
  assert(report.evidenceValuesEchoed === false, 'preflight does not echo evidence values');
  assert(report.o4Status === 'open/deferred' && report.o5Status === 'open/deferred', 'O4/O5 remain open/deferred');
  assert(codes(report).has('EVIDENCE_BLOCK_VALID'), 'evidence block validated');
});

test('invalid evidence shape fails with fixed codes', () => {
  const bad = {
    ...phase43Report(),
    report: 'phase-43-torbox-live-smoke-cli',
    wouldContactTorBox: false,
    probe: 'download-link',
    providerPayload: 'SECRET-PROVIDER-PAYLOAD',
    evidence: {
      statuses: ['available', 'SECRET-STATUS'],
      counts: { serviceStatusChecks: 1 },
      credentialFile: 'C:/secret/path/token.txt',
      scopedRef: 'RAW-REF-SECRET',
      rawRef: 'RAW-REF-SECRET',
    },
  };
  const report = buildTorBoxLiveSmokeEvidencePreflightReport(bad as Record<string, unknown>);
  const got = codes(report);
  assert(got.has('WOULD_CONTACT_TORBOX_TRUE_REQUIRED'), 'would-contact mismatch fails');
  assert(got.has('PROBE_INVALID'), 'unsupported probe fails');
  assert(got.has('UNEXPECTED_FIELDS_PRESENT'), 'unexpected root field fails');
  assert(got.has('EVIDENCE_BLOCK_INVALID'), 'invalid evidence block fails');
  assert(report.reviewReadiness === 'not-ready-for-review', 'fail findings block review readiness');
});

test('hostile values are never echoed in JSON or text output', () => {
  const sentinels = [
    'TORBOX_TOKEN=secret-token',
    'Bearer secret-token',
    'https://api.torbox.app/v1/api/torrents/checkcached?token=secret',
    'RAW-INFOHASH-SECRET',
    'SECRET-PROVIDER-PAYLOAD',
    'provider response body',
    'cdn.example.invalid/file',
    'Private Movie Title 1999',
    '/run/secrets/torbox-token',
  ];
  const hostile = {
    ...phase43Report(),
    notes: sentinels,
    extraDebug: sentinels.join(' '),
    evidence: {
      ...phase43Report().evidence,
      providerPayload: sentinels.join('|'),
    },
  };
  const report = buildTorBoxLiveSmokeEvidencePreflightReport(hostile as Record<string, unknown>);
  assert(report.summary.fail > 0, 'hostile extra values fail');
  assertNoLeak(formatTorBoxLiveSmokeEvidencePreflightJson(report), sentinels);
  assertNoLeak(formatTorBoxLiveSmokeEvidencePreflightText(report), sentinels);
});

test('BOM-prefixed valid JSON is accepted', () => {
  const parsed = parseTorBoxLiveSmokeEvidenceJson(`\uFEFF${JSON.stringify(phase43Report())}`);
  assert(typeof parsed === 'object', 'BOM-prefixed JSON parses');
  const report = buildTorBoxLiveSmokeEvidencePreflightReport(parsed as Record<string, unknown>);
  assert(report.summary.fail === 0, 'BOM-prefixed valid report has no fail findings');
});

test('malformed, array, primitive, missing, directory, and oversized inputs fail closed without leaks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-44-preflight-'));
  const missingPath = join(tmp, 'missing-secret-path.json');
  const directoryPath = join(tmp, 'evidence-dir');
  const sentinel = 'SECRET_VALUE_SHOULD_NOT_APPEAR';
  try {
    mkdirSync(directoryPath);
    assert(parseTorBoxLiveSmokeEvidenceJson(`{"notes":"${sentinel}"`) === 'EVIDENCE_JSON_MALFORMED', 'malformed JSON rejected');
    assert(parseTorBoxLiveSmokeEvidenceJson(JSON.stringify([{ notes: sentinel }])) === 'EVIDENCE_OBJECT_REQUIRED', 'array rejected');
    assert(parseTorBoxLiveSmokeEvidenceJson(JSON.stringify(sentinel)) === 'EVIDENCE_OBJECT_REQUIRED', 'primitive rejected');

    const errorCodes: TorBoxLiveSmokeEvidenceInputErrorCode[] = [
      'EVIDENCE_JSON_MALFORMED',
      'EVIDENCE_OBJECT_REQUIRED',
      'EVIDENCE_FILE_READ_FAILED',
      'EVIDENCE_FILE_TOO_LARGE',
    ];
    for (const report of errorCodes.map(buildTorBoxLiveSmokeEvidencePreflightInputErrorReport)) {
      const output = `${formatTorBoxLiveSmokeEvidencePreflightJson(report)}\n${formatTorBoxLiveSmokeEvidencePreflightText(report)}`;
      assert(report.summary.fail === 1, 'input errors fail closed');
      assertNoLeak(output, [sentinel, missingPath, directoryPath, tmp]);
    }

    const directoryRun = runCli(['--', directoryPath, '--json']);
    assert(directoryRun.status === 1, 'directory input exits with failure');
    assert(codes(JSON.parse(directoryRun.stdout) as TorBoxLiveSmokeEvidencePreflightReport).has('EVIDENCE_FILE_READ_FAILED'), 'directory uses fixed code');
    assertNoLeak(`${directoryRun.stdout}\n${directoryRun.stderr}`, [directoryPath, tmp]);

    const oversized = writeJson(tmp, 'oversized.json', 'x'.repeat(70 * 1024));
    const oversizedRun = runCli(['--', oversized, '--json']);
    assert(oversizedRun.status === 1, 'oversized input exits with failure');
    assert(codes(JSON.parse(oversizedRun.stdout) as TorBoxLiveSmokeEvidencePreflightReport).has('EVIDENCE_FILE_TOO_LARGE'), 'oversized uses fixed code');
    assertNoLeak(`${oversizedRun.stdout}\n${oversizedRun.stderr}`, [oversized, tmp]);

    const missingRun = runCli(['--', missingPath, '--json']);
    assert(missingRun.status === 1, 'missing input exits with failure');
    assert(codes(JSON.parse(missingRun.stdout) as TorBoxLiveSmokeEvidencePreflightReport).has('EVIDENCE_FILE_READ_FAILED'), 'missing uses fixed code');
    assertNoLeak(`${missingRun.stdout}\n${missingRun.stderr}`, [missingPath, tmp]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('npm package-script JSON invocation emits parseable redaction-safe JSON', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-44-npm-'));
  try {
    const evidencePath = writeJson(tmp, 'phase43.json', phase43Report());
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npm, ['run', '--silent', 'ops:torbox-live-smoke-evidence-preflight', '--', '--', evidencePath, '--json'], {
      cwd: root,
      encoding: 'utf8',
      shell: true,
    });
    assert(result.status === 0, `npm script exits 0: ${result.stderr ?? result.error?.message}`);
    const parsed = JSON.parse(result.stdout) as TorBoxLiveSmokeEvidencePreflightReport;
    assert(parsed.report === 'phase-44-torbox-live-smoke-evidence-preflight', 'stdout is Phase 44 JSON report');
    assert(parsed.liveTorBoxContact === false && parsed.closesLiveSmokeReview === false, 'npm JSON remains non-live');
    assertNoLeak(`${result.stdout}\n${result.stderr}`, [evidencePath, tmp]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('source has no SDK, network, env, DB, Docker, adapter-mode, credential-file, or transport creep', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  assert(pkg.scripts['ops:torbox-live-smoke-evidence-preflight'] === 'tsx src/ops/torbox-live-smoke-evidence-preflight-cli.ts', 'ops script is present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-smoke-evidence-preflight.ts'), 'suite is in npm test');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');
  assert(!(pkg.scripts.ci ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm ci');

  const preflight = read('src/ops/torbox-live-smoke-evidence-preflight.ts');
  const cli = read('src/ops/torbox-live-smoke-evidence-preflight-cli.ts');
  const combined = `${preflight}\n${cli}`;
  for (const forbidden of [
    '@torbox/torbox-api',
    "from 'pg'",
    'from "pg"',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'loadDbConfig',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'execFileSync',
    'spawnSync',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'requestDownloadLink',
    'create-download',
    'request-download-link',
    'request-permalink',
    'readFileSync',
    'readdirSync',
    'existsSync',
  ]) assert(!combined.includes(forbidden), `Phase 44 source excludes ${forbidden}`);
  assert(cli.includes("from 'node:fs'") && cli.includes('openSync') && cli.includes('readSync'), 'CLI has explicit bounded evidence file read');
  assert(!preflight.includes("node:fs"), 'pure preflight module has no fs import');
  assert(preflight.includes('evidenceValuesEchoed: false'), 'report is explicitly evidence-value silent');
  assert(preflight.includes('liveTorBoxContact: false'), 'report explicitly has no TorBox contact');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
