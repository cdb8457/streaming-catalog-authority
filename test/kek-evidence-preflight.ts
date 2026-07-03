import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildKekEvidencePreflightInputErrorReport,
  buildKekEvidencePreflightReport,
  formatKekEvidencePreflightJson,
  formatKekEvidencePreflightText,
  parseKekEvidenceDescriptorJson,
  type KekEvidenceDescriptor,
  type KekEvidencePreflightInputErrorCode,
  type KekEvidencePreflightReport,
} from '../src/ops/kek-evidence-preflight.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    failures.push([name, err]);
    console.log(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
}

function completeDescriptor(overrides: Partial<KekEvidenceDescriptor> = {}): KekEvidenceDescriptor {
  return {
    rewrapPlanEvidenceLabel: 'rewrap-plan-redacted',
    rotationRecordLabel: 'rotation-record-redacted',
    managedKekCustodyDocumented: true,
    rotationScheduleDocumented: true,
    operatorRunbookDocumented: true,
    alertTriageDocumented: true,
    independentSecretMediaDocumented: true,
    noRawSecretsInEvidence: true,
    residualRiskAccepted: true,
    redactionReviewStatus: 'passed',
    ...overrides,
  };
}

function codes(report: KekEvidencePreflightReport): Set<string> {
  return new Set(report.findings.map((finding) => finding.code));
}

function assertNoLeak(output: string, sentinels: readonly string[]): void {
  for (const sentinel of sentinels) assert(!output.includes(sentinel), `output leaked sentinel: ${sentinel}`);
}

function writeDescriptor(dir: string, name: string, descriptor: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof descriptor === 'string' ? descriptor : JSON.stringify(descriptor), 'utf8');
  return path;
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/kek-evidence-preflight-cli.ts', ...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
}

console.log('Running Phase 30 KEK evidence preflight suite:\n');

test('complete descriptor is ready for review but never closes O5', () => {
  const report = buildKekEvidencePreflightReport(completeDescriptor() as Record<string, unknown>);
  assert(report.summary.fail === 0, 'complete descriptor has no fail findings');
  assert(report.reviewReadiness === 'ready-for-review', 'complete descriptor is ready for review');
  assert(report.o5Status === 'open/deferred' && report.o4Status === 'open/deferred', 'O4/O5 remain open/deferred');
  assert(report.closesO5 === false, 'preflight never closes O5');
  assert(report.descriptorValuesEchoed === false, 'descriptor values are not echoed');
  assert(codes(report).has('O5_STILL_REQUIRES_REVIEW'), 'complete metadata still requires O5 review');
});

test('incomplete descriptor fails with fixed codes', () => {
  const report = buildKekEvidencePreflightReport({
    rewrapPlanEvidenceLabel: '',
    redactionReviewStatus: 'pending',
  });
  const got = codes(report);
  for (const code of [
    'MANAGED_KEK_CUSTODY_DOCUMENTED_REQUIRED',
    'ROTATION_SCHEDULE_DOCUMENTED_REQUIRED',
    'OPERATOR_RUNBOOK_DOCUMENTED_REQUIRED',
    'ALERT_TRIAGE_DOCUMENTED_REQUIRED',
    'INDEPENDENT_SECRET_MEDIA_DOCUMENTED_REQUIRED',
    'NO_RAW_SECRETS_IN_EVIDENCE_REQUIRED',
    'RESIDUAL_RISK_ACCEPTED_REQUIRED',
    'REWRAP_PLAN_EVIDENCE_LABEL_REQUIRED',
    'ROTATION_RECORD_LABEL_REQUIRED',
    'REDACTION_REVIEW_REQUIRED',
  ]) assert(got.has(code), `report includes ${code}`);
  assert(report.reviewReadiness === 'not-ready-for-review', 'fail findings block review readiness');
});

test('hostile descriptor values are not echoed in text or JSON output', () => {
  const sentinels = [
    'CUSTODIAN_KEK=base64secret',
    'DEK=wrapped-secret',
    'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
    'AGE-SECRET-KEY-1SECRETSECRETSECRETSECRETSECRETSECRET',
    '-----BEGIN PRIVATE KEY-----',
    '/run/secrets/completion-secret',
    'https://kms.example.invalid/key?token=SECRET_TOKEN',
    'postgres://user:pass@example.invalid/db',
    'JELLYFIN_TOKEN=abc123',
    'Private Movie Title 1999',
    'tmdb:603-provider-ref',
    'jellyfin-item-id-123',
    'jellyfin-handle-456',
  ];
  const report = buildKekEvidencePreflightReport(completeDescriptor({
    rewrapPlanEvidenceLabel: sentinels.join(' '),
    rotationRecordLabel: sentinels.join('|'),
  }) as Record<string, unknown>);
  assertNoLeak(formatKekEvidencePreflightJson(report), sentinels);
  assertNoLeak(formatKekEvidencePreflightText(report), sentinels);
});

test('BOM-prefixed valid descriptor is accepted', () => {
  const sentinel = 'BOM_SECRET_VALUE_SHOULD_NOT_ECHO';
  const parsed = parseKekEvidenceDescriptorJson(`\uFEFF${JSON.stringify(completeDescriptor({
    rewrapPlanEvidenceLabel: sentinel,
  }))}`);
  assert(typeof parsed === 'object', 'BOM-prefixed descriptor parses as an object');
  const report = buildKekEvidencePreflightReport(parsed as Record<string, unknown>);
  assert(report.summary.fail === 0, 'BOM-prefixed complete descriptor has no fail findings');
  assert(report.closesO5 === false && report.o5Status === 'open/deferred', 'BOM parse still leaves O5 open');
  assertNoLeak(formatKekEvidencePreflightJson(report), [sentinel]);
  assertNoLeak(formatKekEvidencePreflightText(report), [sentinel]);
});

test('malformed, array, primitive, missing, directory, and oversized inputs fail closed without leaks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-30-preflight-'));
  const missingPath = join(tmp, 'missing-secret-path.json');
  const directoryPath = join(tmp, 'descriptor-dir');
  const sentinel = 'SECRET_VALUE_SHOULD_NOT_APPEAR';
  try {
    mkdirSync(directoryPath);
    const malformed = parseKekEvidenceDescriptorJson(`{"rewrapPlanEvidenceLabel":"${sentinel}"`);
    assert(malformed === 'DESCRIPTOR_JSON_MALFORMED', 'malformed JSON rejected');
    const array = parseKekEvidenceDescriptorJson(JSON.stringify([{ rewrapPlanEvidenceLabel: sentinel }]));
    assert(array === 'DESCRIPTOR_OBJECT_REQUIRED', 'array JSON rejected');
    const primitive = parseKekEvidenceDescriptorJson(JSON.stringify(sentinel));
    assert(primitive === 'DESCRIPTOR_OBJECT_REQUIRED', 'primitive JSON rejected');

    const errorCodes: KekEvidencePreflightInputErrorCode[] = [
      'DESCRIPTOR_JSON_MALFORMED',
      'DESCRIPTOR_OBJECT_REQUIRED',
      'DESCRIPTOR_OBJECT_REQUIRED',
      'DESCRIPTOR_FILE_READ_FAILED',
      'DESCRIPTOR_FILE_TOO_LARGE',
    ];
    for (const report of errorCodes.map(buildKekEvidencePreflightInputErrorReport)) {
      assert(report.summary.fail === 1, 'input errors fail closed');
      const output = `${formatKekEvidencePreflightJson(report)}\n${formatKekEvidencePreflightText(report)}`;
      assertNoLeak(output, [sentinel, missingPath, directoryPath, tmp]);
    }

    const directoryRun = runCli(['--', directoryPath, '--json']);
    assert(directoryRun.status === 1, 'directory CLI input exits with failure');
    const directoryJson = JSON.parse(directoryRun.stdout) as KekEvidencePreflightReport;
    assert(codes(directoryJson).has('DESCRIPTOR_FILE_READ_FAILED'), 'directory report uses fixed code');
    assertNoLeak(`${directoryRun.stdout}\n${directoryRun.stderr}`, [directoryPath, tmp]);

    const oversized = writeDescriptor(tmp, 'oversized.json', 'x'.repeat(70 * 1024));
    const oversizedRun = runCli(['--', oversized, '--json']);
    assert(oversizedRun.status === 1, 'oversized CLI input exits with failure');
    const oversizedJson = JSON.parse(oversizedRun.stdout) as KekEvidencePreflightReport;
    assert(codes(oversizedJson).has('DESCRIPTOR_FILE_TOO_LARGE'), 'oversized report uses fixed code');
    assertNoLeak(`${oversizedRun.stdout}\n${oversizedRun.stderr}`, [oversized, tmp]);

    const missingRun = runCli(['--', missingPath, '--json']);
    assert(missingRun.status === 1, 'missing CLI input exits with failure');
    const missingJson = JSON.parse(missingRun.stdout) as KekEvidencePreflightReport;
    assert(codes(missingJson).has('DESCRIPTOR_FILE_READ_FAILED'), 'missing report uses fixed code');
    assertNoLeak(`${missingRun.stdout}\n${missingRun.stderr}`, [missingPath, tmp]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('npm package-script JSON invocation emits parseable JSON', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-30-npm-'));
  try {
    const descriptorPath = writeDescriptor(tmp, 'descriptor.json', completeDescriptor());
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npm, ['run', '--silent', 'ops:kek-evidence-preflight', '--', '--', descriptorPath, '--json'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      shell: true,
    });
    assert(result.status === 0, `npm script exits 0: ${result.stderr ?? result.error?.message}`);
    const parsed = JSON.parse(result.stdout) as KekEvidencePreflightReport;
    assert(parsed.report === 'phase-30-kek-evidence-preflight', 'stdout is Phase 30 JSON report');
    assert(parsed.closesO5 === false && parsed.o5Status === 'open/deferred', 'npm JSON keeps O5 open');
    assertNoLeak(`${result.stdout}\n${result.stderr}`, [descriptorPath, tmp]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('source has no DB/network/Docker/live-service/cloud/vendor/env/scheduler/age/key-file scope creep', () => {
  const preflight = read('src/ops/kek-evidence-preflight.ts');
  const cli = read('src/ops/kek-evidence-preflight-cli.ts');
  const combined = `${preflight}\n${cli}`;
  for (const forbidden of [
    "from 'pg'",
    'from "pg"',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'loadDbConfig',
    'loadCustodianConfig',
    'createCustodian',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'execFileSync',
    'spawnSync',
    'docker compose',
    'aws-sdk',
    '@aws-sdk',
    '@google-cloud',
    '@azure',
    'node-vault',
    'openbao',
    'node:child_process',
    'node:crypto',
    'node:readline',
    'readdirSync',
    'readFileSync',
    'existsSync',
    'watch(',
    'setInterval',
    'setTimeout',
    'cron',
    'scheduleJob',
    'node-schedule',
    'age.exe',
    'CUSTODIAN_KEK_FILE',
    'CUSTODIAN_KEYSTORE_DIR',
  ]) assert(!combined.includes(forbidden), `Phase 30 source does not include ${forbidden}`);
  assert(cli.includes("from 'node:fs'") && cli.includes('openSync') && cli.includes('readSync'), 'CLI has explicit bounded descriptor file read');
  assert(!preflight.includes("node:fs"), 'pure formatter module has no fs import');
  assert(preflight.includes('descriptorValuesEchoed: false'), 'report is explicitly descriptor-value silent');
  assert(preflight.includes('closesO5: false'), 'report explicitly does not close O5');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
