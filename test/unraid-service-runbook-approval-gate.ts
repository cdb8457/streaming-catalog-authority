import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildUnraidServiceRunbookApprovalGateReport,
  formatUnraidServiceRunbookApprovalGateJson,
  formatUnraidServiceRunbookApprovalGateText,
  parseUnraidServiceRunbookApprovalGateJson,
  sampleUnraidServiceInstallRunbookReport,
  sampleUnraidServiceRunbookApprovalRecord,
  type UnraidServiceRunbookApprovalGateReport,
} from '../src/ops/unraid-service-runbook-approval-gate.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const root = fileURLToPath(new URL('..', import.meta.url));

function assertShape(report: UnraidServiceRunbookApprovalGateReport, ready: boolean): void {
  assert(report.report === 'phase-122-unraid-service-runbook-approval-gate', 'report');
  assert(report.sourceRunbook === 'phase-121-unraid-service-install-runbook', 'source runbook');
  assert(report.redactionSafe === true && report.inputValuesEchoed === false, 'redaction boundary');
  assert(report.rawReviewerNotesIncluded === false, 'no raw reviewer notes');
  assert(report.commandExecution === false && report.scriptGenerated === false, 'no execution/script');
  assert(report.serviceInstallApproved === false, 'no service install approval');
  assert(report.serviceInstalled === false && report.serviceStarted === false, 'service not installed or started');
  assert(report.mutatesUnraid === false, 'no Unraid mutation');
  assert(report.liveServiceContact === false && report.providerContactAllowed === false, 'no live/provider contact');
  assert(report.providerModeEnabled === false, 'provider mode disabled');
  assert(report.productionReady === false && report.launchApproved === false, 'not production ready');
  assert(report.closesO4 === false && report.closesO5 === false, 'does not close gates');
  assert(report.o4Status === 'closed/authorized' && report.o5Status === 'closed/authorized', 'O4/O5 status');
  assert(report.fileCustodianStatus === 'reference-harness-not-production-kms', 'FileCustodian boundary');
  assert(report.readyForInstallAuthorization === ready, 'ready flag');
  assert(report.runbookApprovalStatus === (ready ? 'ready-for-future-install-authorization' : 'not-ready'), 'approval status');
}

function assertNoSentinels(output: string): void {
  for (const sentinel of ['SECRET_VALUE_SENTINEL', 'PRIVATE_TITLE_SENTINEL', 'postgres://', 'Authorization: Bearer', 'Bearer SECRET', 'http://localhost', 'https://api']) {
    assert(!output.includes(sentinel), `output excludes ${sentinel}`);
  }
}

console.log('Running Phase 122 Unraid service runbook approval gate suite:\n');

test('valid runbook plus GO review becomes ready only for future install authorization', () => {
  const report = buildUnraidServiceRunbookApprovalGateReport(
    sampleUnraidServiceInstallRunbookReport(),
    sampleUnraidServiceRunbookApprovalRecord(),
  );
  assertShape(report, true);
  assert(report.summary.fail === 0, 'no failures');
  assert(report.summary.warn === 3, 'three warnings preserve boundaries');
});

test('bad review verdict blocks readiness without approving install', () => {
  const review = { ...sampleUnraidServiceRunbookApprovalRecord(), verdict: 'HOLD' };
  const report = buildUnraidServiceRunbookApprovalGateReport(sampleUnraidServiceInstallRunbookReport(), review);
  assertShape(report, false);
  assert(report.summary.fail >= 1, 'has failure');
  assert(report.findings.some((finding) => finding.code === 'REVIEW_VERDICT_GO_REQUIRED'), 'verdict failure');
});

test('parser and CLI read explicit files without path or value leaks', () => {
  assert(parseUnraidServiceRunbookApprovalGateJson('[]', 'runbook') === 'RUNBOOK_OBJECT_REQUIRED', 'array rejected');
  assert(parseUnraidServiceRunbookApprovalGateJson('{', 'review') === 'REVIEW_JSON_MALFORMED', 'malformed rejected');

  const temp = mkdtempSync(join(tmpdir(), 'phase-122-'));
  const runbookPath = join(temp, 'runbook.redacted.json');
  const reviewPath = join(temp, 'review.redacted.json');
  writeFileSync(runbookPath, JSON.stringify(sampleUnraidServiceInstallRunbookReport()), 'utf8');
  writeFileSync(reviewPath, JSON.stringify(sampleUnraidServiceRunbookApprovalRecord()), 'utf8');

  const output = execFileSync(process.execPath, [
    '--import',
    'tsx',
    'src/ops/unraid-service-runbook-approval-gate-cli.ts',
    '--runbook',
    runbookPath,
    '--review',
    reviewPath,
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
  assertShape(JSON.parse(output) as UnraidServiceRunbookApprovalGateReport, true);
  assertNoSentinels(output);
  assert(!output.includes(temp), 'output excludes temp path');
});

test('CLI rejects missing, directory, oversized, and malformed inputs without path leaks', () => {
  const temp = mkdtempSync(join(tmpdir(), 'phase-122-invalid-'));
  const dirPath = join(temp, 'dir');
  const largePath = join(temp, 'large.json');
  const badPath = join(temp, 'bad.json');
  mkdirSync(dirPath);
  writeFileSync(largePath, `"${'x'.repeat(70 * 1024)}"`, 'utf8');
  writeFileSync(badPath, '{', 'utf8');

  const cases: Array<[string[], string]> = [
    [['--review', badPath, '--json'], 'RUNBOOK_INPUT_REQUIRED'],
    [['--runbook', dirPath, '--review', badPath, '--json'], 'RUNBOOK_FILE_READ_FAILED'],
    [['--runbook', largePath, '--review', badPath, '--json'], 'RUNBOOK_FILE_TOO_LARGE'],
    [['--runbook', badPath, '--review', badPath, '--json'], 'RUNBOOK_JSON_MALFORMED'],
  ];

  for (const [args, code] of cases) {
    let output = '';
    try {
      execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/unraid-service-runbook-approval-gate-cli.ts', ...args], {
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

test('source and docs preserve approval-gate-only boundary', () => {
  const read = (rel: string): string => execFileSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(root, rel))}, 'utf8'))`], { encoding: 'utf8' });
  const source = `${read('src/ops/unraid-service-runbook-approval-gate.ts')}\n${read('src/ops/unraid-service-runbook-approval-gate-cli.ts')}`;
  const docs = `${read('docs/PHASE_122_UNRAID_SERVICE_RUNBOOK_APPROVAL_GATE.md')}\n${read('README.md')}\n${read('package.json')}`;
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assert(scripts['ops:unraid-service-runbook-approval-gate'] === 'tsx src/ops/unraid-service-runbook-approval-gate-cli.ts', 'ops script');
  assert(scripts['test:unraid-service-runbook-approval-gate'] === 'tsx test/unraid-service-runbook-approval-gate.ts', 'test script');
  assert((scripts.test ?? '').includes('test/unraid-service-install-runbook.ts && tsx test/unraid-service-runbook-approval-gate.ts'), 'aggregate order');
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
    'Phase 122',
    'phase-122-unraid-service-runbook-approval-gate',
    'phase-122-unraid-service-runbook-approval-record',
    'phase-121-unraid-service-install-runbook',
    'ready-for-future-install-authorization',
    'readyForInstallAuthorization: true',
    'inputValuesEchoed: false',
    'rawReviewerNotesIncluded: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'serviceInstallApproved: false',
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
