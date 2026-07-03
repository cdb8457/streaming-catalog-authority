import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildCustodianEvidencePreflightInputErrorReport,
  buildCustodianEvidencePreflightReport,
  formatCustodianEvidencePreflightJson,
  formatCustodianEvidencePreflightText,
  parseCustodianEvidenceDescriptorJson,
  type CustodianEvidencePreflightInputErrorCode,
  type CustodianEvidencePreflightReport,
} from '../src/ops/custodian-evidence-preflight.js';
import type { ProductionCustodianDescriptor } from '../src/core/crypto/production-custodian-contract.js';

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

function completeDescriptor(overrides: Partial<ProductionCustodianDescriptor> = {}): ProductionCustodianDescriptor {
  return {
    adapterName: 'ManagedCustodianAdapter',
    adapterVersion: 'phase-29-static-preflight',
    custodyBoundary: 'external-managed',
    implementsKeyCustodian: true,
    attestationFormatDocumented: true,
    durableTombstones: true,
    appCannotForgeAttestation: true,
    failClosedSemanticsDocumented: true,
    liveValidationEvidenceLabel: 'operator-live-validation-redacted',
    contractKitCommandLabel: 'contract-kit-redacted',
    redactionReviewStatus: 'passed',
    noRawSecretsInEvidence: true,
    backupRestoreFailClosedEvidence: true,
    ...overrides,
  };
}

function codes(report: CustodianEvidencePreflightReport): Set<string> {
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
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/custodian-evidence-preflight-cli.ts', ...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
}

console.log('Running Phase 29 custodian evidence preflight suite:\n');

test('valid complete descriptor produces review report without fail findings but never closes O4', () => {
  const report = buildCustodianEvidencePreflightReport(completeDescriptor() as Record<string, unknown>);
  assert(report.summary.fail === 0, 'complete descriptor has no fail findings');
  assert(report.reviewReadiness === 'ready-for-review', 'complete descriptor is ready for review');
  assert(report.o4Status === 'open/deferred' && report.o5Status === 'open/deferred', 'O4/O5 remain open/deferred');
  assert(report.closesO4 === false, 'preflight never closes O4');
  assert(codes(report).has('O4_STILL_REQUIRES_REVIEW'), 'Phase 28 validator still requires separate review');
});

test('BOM-prefixed valid descriptor is accepted and remains redaction-safe', () => {
  const sentinel = 'POWER_SHELL_BOM_SECRET_VALUE';
  const parsed = parseCustodianEvidenceDescriptorJson(`\uFEFF${JSON.stringify(completeDescriptor({
    adapterName: sentinel,
  }))}`);
  assert(typeof parsed === 'object', 'BOM-prefixed descriptor parses as an object');
  const report = buildCustodianEvidencePreflightReport(parsed as Record<string, unknown>);
  assert(report.summary.fail === 0, 'BOM-prefixed complete descriptor has no fail findings');
  assert(report.closesO4 === false && report.o4Status === 'open/deferred', 'BOM parse still leaves O4 open');
  assertNoLeak(formatCustodianEvidencePreflightJson(report), [sentinel]);
  assertNoLeak(formatCustodianEvidencePreflightText(report), [sentinel]);
});

test('incomplete reference-harness descriptor fails with fixed codes and no descriptor value echo', () => {
  const descriptor = completeDescriptor({
    adapterName: 'FileCustodian production KMS',
    custodyBoundary: 'in-app-reference',
    implementsKeyCustodian: false,
    liveValidationEvidenceLabel: '',
    redactionReviewStatus: 'pending',
  });
  const report = buildCustodianEvidencePreflightReport(descriptor as Record<string, unknown>);
  const got = codes(report);
  for (const code of [
    'REFERENCE_HARNESS_NOT_PRODUCTION_KMS',
    'EXTERNAL_BOUNDARY_REQUIRED',
    'IMPLEMENTS_KEY_CUSTODIAN_REQUIRED',
    'LIVE_VALIDATION_LABEL_REQUIRED',
    'REDACTION_REVIEW_REQUIRED',
  ]) assert(got.has(code), `report includes ${code}`);
  assert(report.reviewReadiness === 'not-ready-for-review', 'fail findings block review readiness');
  assertNoLeak(formatCustodianEvidencePreflightJson(report), ['FileCustodian production KMS']);
  assertNoLeak(formatCustodianEvidencePreflightText(report), ['FileCustodian production KMS']);
});

test('hostile descriptor values are not echoed in text or JSON output', () => {
  const sentinels = [
    'postgres://user:pass@example.invalid/db',
    'https://kms.example.invalid/key?token=SECRET_TOKEN',
    'TOKEN=abc123',
    'CUSTODIAN_KEK=base64secret',
    '-----BEGIN PRIVATE KEY-----',
    '/run/secrets/completion-secret',
    'Private Movie Title 1999',
    'tmdb:603-provider-ref',
    'jellyfin-item-id-123',
    'jellyfin-token-456',
  ];
  const report = buildCustodianEvidencePreflightReport(completeDescriptor({
    adapterName: sentinels.join(' '),
    adapterVersion: sentinels.join('|'),
    liveValidationEvidenceLabel: sentinels[0],
    contractKitCommandLabel: sentinels[1],
  }) as Record<string, unknown>);
  assertNoLeak(formatCustodianEvidencePreflightJson(report), sentinels);
  assertNoLeak(formatCustodianEvidencePreflightText(report), sentinels);
});

test('malformed, array, primitive, missing, and oversized descriptor inputs fail closed without path or value leaks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-29-preflight-'));
  const missingPath = join(tmp, 'missing-secret-path.json');
  const sentinel = 'SECRET_VALUE_SHOULD_NOT_APPEAR';
  try {
    const malformed = parseCustodianEvidenceDescriptorJson(`{"adapterName":"${sentinel}"`);
    assert(malformed === 'DESCRIPTOR_JSON_MALFORMED', 'malformed JSON rejected');
    const array = parseCustodianEvidenceDescriptorJson(JSON.stringify([{ adapterName: sentinel }]));
    assert(array === 'DESCRIPTOR_OBJECT_REQUIRED', 'array JSON rejected');
    const primitive = parseCustodianEvidenceDescriptorJson(JSON.stringify(sentinel));
    assert(primitive === 'DESCRIPTOR_OBJECT_REQUIRED', 'primitive JSON rejected');

    const errorCodes: CustodianEvidencePreflightInputErrorCode[] = [
      'DESCRIPTOR_JSON_MALFORMED',
      'DESCRIPTOR_OBJECT_REQUIRED',
      'DESCRIPTOR_OBJECT_REQUIRED',
      'DESCRIPTOR_FILE_READ_FAILED',
      'DESCRIPTOR_FILE_TOO_LARGE',
    ];
    const reports = errorCodes.map(buildCustodianEvidencePreflightInputErrorReport);
    for (const report of reports) {
      assert(report.summary.fail === 1, 'input errors fail closed');
      const output = `${formatCustodianEvidencePreflightJson(report)}\n${formatCustodianEvidencePreflightText(report)}`;
      assertNoLeak(output, [sentinel, missingPath, tmp]);
    }

    const oversized = writeDescriptor(tmp, 'oversized.json', 'x'.repeat(70 * 1024));
    const oversizedRun = runCli(['--', oversized, '--json']);
    assert(oversizedRun.status === 1, 'oversized CLI input exits with failure');
    const oversizedJson = JSON.parse(oversizedRun.stdout) as CustodianEvidencePreflightReport;
    assert(codes(oversizedJson).has('DESCRIPTOR_FILE_TOO_LARGE'), 'oversized report uses fixed code');
    assertNoLeak(`${oversizedRun.stdout}\n${oversizedRun.stderr}`, [oversized, tmp]);

    const missingRun = runCli(['--', missingPath, '--json']);
    assert(missingRun.status === 1, 'missing CLI input exits with failure');
    const missingJson = JSON.parse(missingRun.stdout) as CustodianEvidencePreflightReport;
    assert(codes(missingJson).has('DESCRIPTOR_FILE_READ_FAILED'), 'missing report uses fixed code');
    assertNoLeak(`${missingRun.stdout}\n${missingRun.stderr}`, [missingPath, tmp]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('npm package-script JSON invocation emits parseable JSON', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-29-npm-'));
  try {
    const descriptorPath = writeDescriptor(tmp, 'descriptor.json', completeDescriptor());
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npm, ['run', '--silent', 'ops:custodian-evidence-preflight', '--', '--', descriptorPath, '--json'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      shell: true,
    });
    assert(result.status === 0, `npm script exits 0: ${result.stderr ?? result.error?.message}`);
    const parsed = JSON.parse(result.stdout) as CustodianEvidencePreflightReport;
    assert(parsed.report === 'phase-29-custodian-evidence-preflight', 'stdout is Phase 29 JSON report');
    assert(parsed.closesO4 === false && parsed.o4Status === 'open/deferred', 'npm JSON keeps O4 open');
    assertNoLeak(`${result.stdout}\n${result.stderr}`, [descriptorPath, tmp]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('source has no DB/network/live-service/cloud/vendor/env scope creep beyond descriptor file read', () => {
  const preflight = read('src/ops/custodian-evidence-preflight.ts');
  const cli = read('src/ops/custodian-evidence-preflight-cli.ts');
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
    'readdirSync',
    'readFileSync',
    'existsSync',
  ]) assert(!combined.includes(forbidden), `Phase 29 source does not include ${forbidden}`);
  assert(preflight.includes('validateProductionCustodianDescriptor'), 'preflight wraps the Phase 28 validator');
  assert(cli.includes("from 'node:fs'"), 'CLI is the only module with explicit descriptor file read capability');
  assert(!preflight.includes("node:fs"), 'pure formatter module has no fs import');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
