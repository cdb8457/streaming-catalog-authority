import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTorBoxSmokeReadinessPreflightInputErrorReport,
  buildTorBoxSmokeReadinessPreflightReport,
  formatTorBoxSmokeReadinessPreflightJson,
  formatTorBoxSmokeReadinessPreflightText,
  parseTorBoxSmokeReadinessDescriptorJson,
  type TorBoxSmokeReadinessDescriptor,
  type TorBoxSmokeReadinessPreflightInputErrorCode,
  type TorBoxSmokeReadinessPreflightReport,
} from '../src/ops/torbox-smoke-readiness-preflight.js';

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

function completeDescriptor(overrides: Partial<TorBoxSmokeReadinessDescriptor> = {}): TorBoxSmokeReadinessDescriptor {
  return {
    credentialReferenceLabel: 'torbox-credential-ref-redacted',
    transportAcceptanceEvidenceLabel: 'phase-39-acceptance-redacted',
    operatorAuthorizationDocumented: true,
    liveNetworkOptInDocumented: true,
    readOnlyIntentDocumented: true,
    scopedRefPolicyDocumented: true,
    redactionPolicyDocumented: true,
    evidenceRetentionPolicyDocumented: true,
    boundedTimeoutPolicyDocumented: true,
    noProviderPayloadRetention: true,
    noAdapterModeWiring: true,
    noDownloadOrPlaybackIntent: true,
    redactionReviewStatus: 'passed',
    ...overrides,
  };
}

function codes(report: TorBoxSmokeReadinessPreflightReport): Set<string> {
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
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/torbox-smoke-readiness-preflight-cli.ts', ...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
}

console.log('Running Phase 40 TorBox smoke readiness preflight suite:\n');

test('complete descriptor is ready for review but never contacts TorBox or closes live readiness', () => {
  const report = buildTorBoxSmokeReadinessPreflightReport(completeDescriptor() as Record<string, unknown>);
  assert(report.report === 'phase-40-torbox-smoke-readiness-preflight', 'report name');
  assert(report.summary.fail === 0, 'complete descriptor has no fail findings');
  assert(report.reviewReadiness === 'ready-for-review', 'complete descriptor is ready for review');
  assert(report.liveTorBoxContact === false, 'preflight never contacts TorBox');
  assert(report.closesLiveSmokeReadiness === false, 'preflight never closes live-smoke readiness');
  assert(report.o4Status === 'open/deferred' && report.o5Status === 'open/deferred', 'O4/O5 remain open/deferred');
  assert(report.descriptorValuesEchoed === false, 'descriptor values are not echoed');
  assert(codes(report).has('LIVE_SMOKE_STILL_REQUIRES_SEPARATE_AUTHORIZATION'), 'complete metadata still requires separate live authorization');
});

test('incomplete descriptor fails with fixed codes', () => {
  const report = buildTorBoxSmokeReadinessPreflightReport({
    credentialReferenceLabel: '',
    redactionReviewStatus: 'pending',
  });
  const got = codes(report);
  for (const code of [
    'OPERATOR_AUTHORIZATION_DOCUMENTED_REQUIRED',
    'LIVE_NETWORK_OPT_IN_DOCUMENTED_REQUIRED',
    'READ_ONLY_INTENT_DOCUMENTED_REQUIRED',
    'SCOPED_REF_POLICY_DOCUMENTED_REQUIRED',
    'REDACTION_POLICY_DOCUMENTED_REQUIRED',
    'EVIDENCE_RETENTION_POLICY_DOCUMENTED_REQUIRED',
    'BOUNDED_TIMEOUT_POLICY_DOCUMENTED_REQUIRED',
    'NO_PROVIDER_PAYLOAD_RETENTION_REQUIRED',
    'NO_ADAPTER_MODE_WIRING_REQUIRED',
    'NO_DOWNLOAD_OR_PLAYBACK_INTENT_REQUIRED',
    'CREDENTIAL_REFERENCE_LABEL_REQUIRED',
    'TRANSPORT_ACCEPTANCE_EVIDENCE_LABEL_REQUIRED',
    'REDACTION_REVIEW_REQUIRED',
  ]) assert(got.has(code), `report includes ${code}`);
  assert(report.reviewReadiness === 'not-ready-for-review', 'fail findings block review readiness');
});

test('hostile descriptor values are not echoed in text or JSON output', () => {
  const sentinels = [
    'TORBOX_TOKEN=secret-token',
    'Bearer secret-token',
    'https://api.torbox.example.invalid?token=secret',
    'RAW-INFOHASH-SECRET',
    'SECRET-PROVIDER-PAYLOAD',
    'provider response body',
    'cdn.example.invalid/file',
    'permalink.example.invalid/item',
    'Private Movie Title 1999',
    'tmdb:603-provider-ref',
    '/run/secrets/torbox-token',
    'postgres://user:pass@example.invalid/db',
  ];
  const report = buildTorBoxSmokeReadinessPreflightReport(completeDescriptor({
    credentialReferenceLabel: sentinels.join(' '),
    transportAcceptanceEvidenceLabel: sentinels.join('|'),
  }) as Record<string, unknown>);
  assertNoLeak(formatTorBoxSmokeReadinessPreflightJson(report), sentinels);
  assertNoLeak(formatTorBoxSmokeReadinessPreflightText(report), sentinels);
});

test('BOM-prefixed valid descriptor is accepted', () => {
  const sentinel = 'BOM_SECRET_VALUE_SHOULD_NOT_ECHO';
  const parsed = parseTorBoxSmokeReadinessDescriptorJson(`\uFEFF${JSON.stringify(completeDescriptor({
    credentialReferenceLabel: sentinel,
  }))}`);
  assert(typeof parsed === 'object', 'BOM-prefixed descriptor parses as an object');
  const report = buildTorBoxSmokeReadinessPreflightReport(parsed as Record<string, unknown>);
  assert(report.summary.fail === 0, 'BOM-prefixed complete descriptor has no fail findings');
  assert(report.liveTorBoxContact === false && report.closesLiveSmokeReadiness === false, 'BOM parse remains non-live');
  assertNoLeak(formatTorBoxSmokeReadinessPreflightJson(report), [sentinel]);
  assertNoLeak(formatTorBoxSmokeReadinessPreflightText(report), [sentinel]);
});

test('malformed, array, primitive, missing, directory, and oversized inputs fail closed without leaks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-40-preflight-'));
  const missingPath = join(tmp, 'missing-secret-path.json');
  const directoryPath = join(tmp, 'descriptor-dir');
  const sentinel = 'SECRET_VALUE_SHOULD_NOT_APPEAR';
  try {
    mkdirSync(directoryPath);
    const malformed = parseTorBoxSmokeReadinessDescriptorJson(`{"credentialReferenceLabel":"${sentinel}"`);
    assert(malformed === 'DESCRIPTOR_JSON_MALFORMED', 'malformed JSON rejected');
    const array = parseTorBoxSmokeReadinessDescriptorJson(JSON.stringify([{ credentialReferenceLabel: sentinel }]));
    assert(array === 'DESCRIPTOR_OBJECT_REQUIRED', 'array JSON rejected');
    const primitive = parseTorBoxSmokeReadinessDescriptorJson(JSON.stringify(sentinel));
    assert(primitive === 'DESCRIPTOR_OBJECT_REQUIRED', 'primitive JSON rejected');

    const errorCodes: TorBoxSmokeReadinessPreflightInputErrorCode[] = [
      'DESCRIPTOR_JSON_MALFORMED',
      'DESCRIPTOR_OBJECT_REQUIRED',
      'DESCRIPTOR_OBJECT_REQUIRED',
      'DESCRIPTOR_FILE_READ_FAILED',
      'DESCRIPTOR_FILE_TOO_LARGE',
    ];
    for (const report of errorCodes.map(buildTorBoxSmokeReadinessPreflightInputErrorReport)) {
      assert(report.summary.fail === 1, 'input errors fail closed');
      const output = `${formatTorBoxSmokeReadinessPreflightJson(report)}\n${formatTorBoxSmokeReadinessPreflightText(report)}`;
      assertNoLeak(output, [sentinel, missingPath, directoryPath, tmp]);
    }

    const directoryRun = runCli(['--', directoryPath, '--json']);
    assert(directoryRun.status === 1, 'directory CLI input exits with failure');
    const directoryJson = JSON.parse(directoryRun.stdout) as TorBoxSmokeReadinessPreflightReport;
    assert(codes(directoryJson).has('DESCRIPTOR_FILE_READ_FAILED'), 'directory report uses fixed code');
    assertNoLeak(`${directoryRun.stdout}\n${directoryRun.stderr}`, [directoryPath, tmp]);

    const oversized = writeDescriptor(tmp, 'oversized.json', 'x'.repeat(70 * 1024));
    const oversizedRun = runCli(['--', oversized, '--json']);
    assert(oversizedRun.status === 1, 'oversized CLI input exits with failure');
    const oversizedJson = JSON.parse(oversizedRun.stdout) as TorBoxSmokeReadinessPreflightReport;
    assert(codes(oversizedJson).has('DESCRIPTOR_FILE_TOO_LARGE'), 'oversized report uses fixed code');
    assertNoLeak(`${oversizedRun.stdout}\n${oversizedRun.stderr}`, [oversized, tmp]);

    const missingRun = runCli(['--', missingPath, '--json']);
    assert(missingRun.status === 1, 'missing CLI input exits with failure');
    const missingJson = JSON.parse(missingRun.stdout) as TorBoxSmokeReadinessPreflightReport;
    assert(codes(missingJson).has('DESCRIPTOR_FILE_READ_FAILED'), 'missing report uses fixed code');
    assertNoLeak(`${missingRun.stdout}\n${missingRun.stderr}`, [missingPath, tmp]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('npm package-script JSON invocation emits parseable JSON', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-40-npm-'));
  try {
    const descriptorPath = writeDescriptor(tmp, 'descriptor.json', completeDescriptor());
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npm, ['run', '--silent', 'ops:torbox-smoke-readiness-preflight', '--', '--', descriptorPath, '--json'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      shell: true,
    });
    assert(result.status === 0, `npm script exits 0: ${result.stderr ?? result.error?.message}`);
    const parsed = JSON.parse(result.stdout) as TorBoxSmokeReadinessPreflightReport;
    assert(parsed.report === 'phase-40-torbox-smoke-readiness-preflight', 'stdout is Phase 40 JSON report');
    assert(parsed.liveTorBoxContact === false && parsed.closesLiveSmokeReadiness === false, 'npm JSON remains non-live');
    assertNoLeak(`${result.stdout}\n${result.stderr}`, [descriptorPath, tmp]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('source has no SDK, network, env, DB, Docker, adapter-mode, transport, or provider-write creep', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  assert(pkg.scripts['ops:torbox-smoke-readiness-preflight'] === 'tsx src/ops/torbox-smoke-readiness-preflight-cli.ts', 'ops script is present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-smoke-readiness-preflight.ts'), 'suite is in npm test');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');
  assert(!(pkg.scripts.ci ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm ci');

  const preflight = read('src/ops/torbox-smoke-readiness-preflight.ts');
  const cli = read('src/ops/torbox-smoke-readiness-preflight-cli.ts');
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
    'createTorBoxTransport',
    'TorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'requestDownloadLink',
    'create-download',
    'request-download-link',
    'request-permalink',
    'readdirSync',
    'readFileSync',
    'existsSync',
  ]) assert(!combined.includes(forbidden), `Phase 40 source excludes ${forbidden}`);
  assert(cli.includes("from 'node:fs'") && cli.includes('openSync') && cli.includes('readSync'), 'CLI has explicit bounded descriptor file read');
  assert(!preflight.includes("node:fs"), 'pure formatter module has no fs import');
  assert(preflight.includes('descriptorValuesEchoed: false'), 'report is explicitly descriptor-value silent');
  assert(preflight.includes('liveTorBoxContact: false'), 'report explicitly has no TorBox contact');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
