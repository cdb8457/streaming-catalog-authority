import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildUnraidServiceInstallAuthorizationReport,
  parseUnraidServiceInstallAuthorizationJson,
  sampleUnraidServiceInstallAuthorizationRecord,
  sampleUnraidServiceRunbookApprovalGateReport,
  type UnraidServiceInstallAuthorizationReport,
} from '../src/ops/unraid-service-install-authorization.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

function assertShape(report: UnraidServiceInstallAuthorizationReport, authorized: boolean): void {
  assert(report.report === 'phase-123-unraid-service-install-authorization', 'report');
  assert(report.sourceApprovalGate === 'phase-122-unraid-service-runbook-approval-gate', 'source');
  assert(report.redactionSafe === true && report.inputValuesEchoed === false, 'redaction boundary');
  assert(report.rawAuthorizationNotesIncluded === false, 'no raw authorization notes');
  assert(report.commandExecution === false && report.scriptGenerated === false, 'no execution/script');
  assert(report.serviceInstallApproved === authorized, 'install authorization flag');
  assert(report.serviceInstalled === false && report.serviceStarted === false, 'service not installed or started');
  assert(report.mutatesUnraid === false, 'no Unraid mutation');
  assert(report.liveServiceContact === false && report.providerContactAllowed === false, 'no live/provider contact');
  assert(report.providerModeEnabled === false, 'provider mode disabled');
  assert(report.productionReady === false && report.launchApproved === false, 'not production ready');
  assert(report.closesO4 === false && report.closesO5 === false, 'does not close gates');
  assert(report.o4Status === 'closed/authorized' && report.o5Status === 'closed/authorized', 'O4/O5 status');
  assert(report.installAuthorizationStatus === (authorized ? 'install-window-authorized' : 'not-authorized'), 'authorization status');
}

function assertNoSentinels(output: string): void {
  for (const sentinel of ['SECRET_VALUE_SENTINEL', 'PRIVATE_TITLE_SENTINEL', 'postgres://', 'Authorization: Bearer', 'Bearer SECRET', 'http://localhost', 'https://api']) {
    assert(!output.includes(sentinel), `output excludes ${sentinel}`);
  }
}

console.log('Running Phase 123 Unraid service install authorization suite:\n');

test('ready approval gate plus fixed authorization approves only future install window', () => {
  const report = buildUnraidServiceInstallAuthorizationReport(
    sampleUnraidServiceRunbookApprovalGateReport(),
    sampleUnraidServiceInstallAuthorizationRecord(),
  );
  assertShape(report, true);
  assert(report.summary.fail === 0, 'no failures');
  assert(report.nextRequiredEvidence.includes('operator-run-install-window-evidence-redacted'), 'next evidence recorded');
});

test('not-ready approval gate blocks install authorization', () => {
  const gate = { ...sampleUnraidServiceRunbookApprovalGateReport(), readyForInstallAuthorization: false };
  const report = buildUnraidServiceInstallAuthorizationReport(gate, sampleUnraidServiceInstallAuthorizationRecord());
  assertShape(report, false);
  assert(report.findings.some((finding) => finding.code === 'APPROVAL_GATE_READY_FLAG_REQUIRED'), 'ready flag failure');
});

test('parser and CLI read explicit files without path or value leaks', () => {
  assert(parseUnraidServiceInstallAuthorizationJson('[]', 'approvalGate') === 'APPROVAL_GATE_OBJECT_REQUIRED', 'array rejected');
  assert(parseUnraidServiceInstallAuthorizationJson('{', 'authorization') === 'AUTHORIZATION_JSON_MALFORMED', 'malformed rejected');

  const temp = mkdtempSync(join(tmpdir(), 'phase-123-'));
  const gatePath = join(temp, 'approval-gate.redacted.json');
  const authPath = join(temp, 'authorization.redacted.json');
  writeFileSync(gatePath, JSON.stringify(sampleUnraidServiceRunbookApprovalGateReport()), 'utf8');
  writeFileSync(authPath, JSON.stringify(sampleUnraidServiceInstallAuthorizationRecord()), 'utf8');

  const output = execFileSync(process.execPath, [
    '--import',
    'tsx',
    'src/ops/unraid-service-install-authorization-cli.ts',
    '--approval-gate',
    gatePath,
    '--authorization',
    authPath,
    '--json',
  ], {
    cwd: root,
    env: {
      ...process.env,
      SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL',
      PRIVATE_TITLE: 'PRIVATE_TITLE_SENTINEL',
      DATABASE_URL: 'postgres://secret',
    },
    encoding: 'utf8',
  });
  assertShape(JSON.parse(output) as UnraidServiceInstallAuthorizationReport, true);
  assertNoSentinels(output);
  assert(!output.includes(temp), 'output excludes temp path');
});

test('CLI rejects missing, directory, oversized, and malformed inputs without path leaks', () => {
  const temp = mkdtempSync(join(tmpdir(), 'phase-123-invalid-'));
  const dirPath = join(temp, 'dir');
  const largePath = join(temp, 'large.json');
  const badPath = join(temp, 'bad.json');
  mkdirSync(dirPath);
  writeFileSync(largePath, `"${'x'.repeat(70 * 1024)}"`, 'utf8');
  writeFileSync(badPath, '{', 'utf8');

  const cases: Array<[string[], string]> = [
    [['--authorization', badPath, '--json'], 'APPROVAL_GATE_INPUT_REQUIRED'],
    [['--approval-gate', dirPath, '--authorization', badPath, '--json'], 'APPROVAL_GATE_FILE_READ_FAILED'],
    [['--approval-gate', largePath, '--authorization', badPath, '--json'], 'APPROVAL_GATE_FILE_TOO_LARGE'],
    [['--approval-gate', badPath, '--authorization', badPath, '--json'], 'APPROVAL_GATE_JSON_MALFORMED'],
  ];

  for (const [args, code] of cases) {
    let output = '';
    try {
      execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/unraid-service-install-authorization-cli.ts', ...args], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert(false, `expected ${code}`);
    } catch (err) {
      output = String((err as { stdout?: Buffer | string }).stdout ?? '');
    }
    assert(output.includes(code), `output includes ${code}`);
    assert(!output.includes(temp), 'output excludes temp path');
    assertNoSentinels(output);
  }
});

test('source and docs preserve authorization-only boundary', () => {
  const source = `${read('src/ops/unraid-service-install-authorization.ts')}\n${read('src/ops/unraid-service-install-authorization-cli.ts')}`;
  const docs = `${read('docs/PHASE_123_UNRAID_SERVICE_INSTALL_AUTHORIZATION.md')}\n${read('README.md')}\n${read('package.json')}`;
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assert(scripts['ops:unraid-service-install-authorization'] === 'tsx src/ops/unraid-service-install-authorization-cli.ts', 'ops script');
  assert(scripts['test:unraid-service-install-authorization'] === 'tsx test/unraid-service-install-authorization.ts', 'test script');
  assert((scripts.test ?? '').includes('test/unraid-service-runbook-approval-gate.ts && tsx test/unraid-service-install-authorization.ts'), 'aggregate order');
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `source excludes ${forbidden}`);
  for (const required of [
    'Phase 123',
    'phase-123-unraid-service-install-authorization',
    'phase-123-unraid-service-install-authorization-record',
    'phase-122-unraid-service-runbook-approval-gate',
    'install-window-authorized',
    'serviceInstallApproved: true',
    'inputValuesEchoed: false',
    'rawAuthorizationNotesIncluded: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'productionReady: false',
    'launchApproved: false',
    'closesO4: false',
    'closesO5: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(docs.includes(required), `docs include ${required}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
