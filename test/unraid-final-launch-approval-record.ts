import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildUnraidFinalLaunchApprovalRecord,
  parseUnraidFinalLaunchApprovalRecordJson,
  type UnraidFinalLaunchApprovalRecord,
} from '../src/ops/unraid-final-launch-approval-record.js';

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

function approval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    record: 'phase-135-unraid-final-launch-approval-record',
    sourceLaunchReadinessDecision: 'phase-134-unraid-launch-readiness-decision',
    launchReadinessStatus: 'ready-for-final-launch-approval-record',
    verdict: 'GO',
    operatorFinalLaunchApproval: 'APPROVE_UNRAID_PRODUCTION_SWITCH',
    approvedByHuman: true,
    redactionSafe: true,
    approvalValuesEchoed: false,
    inputValuesEchoed: false,
    commandExecution: false,
    scriptGenerated: false,
    mutatesUnraid: false,
    providerContactAllowed: false,
    providerModeEnabled: false,
    serviceInstalled: false,
    serviceStarted: false,
    productionReady: false,
    fileCustodianStatus: 'reference-harness-not-production-kms',
    ...overrides,
  };
}

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/unraid-final-launch-approval-record-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 135 Unraid final launch approval record suite:\n');

test('explicit human GO approval becomes ready for execution packet', () => {
  const report = buildUnraidFinalLaunchApprovalRecord(approval());
  assert(report.report === 'phase-135-unraid-final-launch-approval-record', 'report');
  assert(report.finalLaunchApprovalStatus === 'ready-for-production-switch-execution-packet', 'ready');
  assert(report.launchApproved === true, 'launch approved');
  assert(report.productionReady === false, 'not production ready');
  assert(report.commandExecution === false && report.mutatesUnraid === false, 'does not execute');
});

test('missing approval token or unsafe fields block execution packet readiness', () => {
  for (const bad of [
    { operatorFinalLaunchApproval: 'HOLD' },
    { approvedByHuman: false },
    { launchReadinessStatus: 'not-ready-for-final-launch-approval-record' },
    { redactionSafe: false },
  ]) {
    const report = buildUnraidFinalLaunchApprovalRecord(approval(bad));
    assert(report.finalLaunchApprovalStatus === 'not-ready-for-production-switch-execution-packet', 'blocked');
    assert(report.launchApproved === false, 'not approved');
    assert(report.summary.fail > 0, 'has failures');
  }
});

test('parser and CLI read one explicit approval file without value leaks', () => {
  assert(parseUnraidFinalLaunchApprovalRecordJson('{bad') === 'FINAL_LAUNCH_APPROVAL_JSON_MALFORMED', 'malformed');
  assert(parseUnraidFinalLaunchApprovalRecordJson('[]') === 'FINAL_LAUNCH_APPROVAL_OBJECT_REQUIRED', 'array');
  const dir = mkdtempSync(join(tmpdir(), 'final-launch-approval-'));
  try {
    const input = join(dir, 'approval.json');
    writeFileSync(input, JSON.stringify(approval({ notes: 'PRIVATE_TITLE_SENTINEL SECRET_VALUE_SENTINEL KEK_SENTINEL' })), 'utf8');
    const result = runCli([input, '--json']);
    const stdout = String(result.stdout);
    assert(result.status === 0, 'CLI exits zero');
    const parsed = JSON.parse(stdout) as UnraidFinalLaunchApprovalRecord;
    assert(parsed.finalLaunchApprovalStatus === 'ready-for-production-switch-execution-packet', 'stdout ready');
    assert(!stdout.includes(input), 'stdout omits path');
    assert(!stdout.includes('PRIVATE_TITLE_SENTINEL'), 'stdout omits hostile title');
    assert(!stdout.includes('SECRET_VALUE_SENTINEL'), 'stdout omits hostile secret');
    assert(!stdout.includes('KEK_SENTINEL'), 'stdout omits hostile KEK');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source and docs preserve approval-only boundary', () => {
  const source = `${read('src/ops/unraid-final-launch-approval-record.ts')}\n${read('src/ops/unraid-final-launch-approval-record-cli.ts')}`;
  const docs = `${read('docs/PHASE_135_UNRAID_FINAL_LAUNCH_APPROVAL_RECORD.md')}\n${read('README.md')}\n${read('package.json')}`;
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assert(scripts['test:unraid-final-launch-approval-record'] === 'tsx test/unraid-final-launch-approval-record.ts', 'test script');
  assert(scripts['ops:unraid-final-launch-approval-record'] === 'tsx src/ops/unraid-final-launch-approval-record-cli.ts', 'ops script');
  assert((scripts.test ?? '').includes('test/unraid-launch-readiness-decision.ts && tsx test/unraid-final-launch-approval-record.ts'), 'aggregate order');
  for (const required of [
    'phase-135-unraid-final-launch-approval-record',
    'phase-134-unraid-launch-readiness-decision',
    'APPROVE_UNRAID_PRODUCTION_SWITCH',
    'ready-for-final-launch-approval-record',
    'ready-for-production-switch-execution-packet',
    'launchApproved: true',
    'productionReady: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'providerModeEnabled: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(docs.includes(required), `docs include ${required}`);
  for (const forbidden of ['node:http', 'node:https', 'node:net', 'globalThis.fetch', 'fetch(', "from 'pg'", 'docker compose', 'execSync', 'ProviderAdapter', 'TorBoxReadOnlyClient', 'JellyfinHttpClient']) {
    assert(!source.includes(forbidden), `source excludes ${forbidden}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
