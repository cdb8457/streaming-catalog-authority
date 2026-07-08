import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildUnraidFinalHumanApprovalRecordPreflight,
  formatUnraidFinalHumanApprovalRecordPreflightJson,
  parseUnraidFinalHumanApprovalRecordJson,
  type UnraidFinalHumanApprovalRecordPreflight,
} from '../src/ops/unraid-final-human-approval-record.js';

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

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    record: 'phase-128-unraid-final-human-production-approval-record',
    sourceTemplate: 'phase-128-unraid-final-human-approval-template',
    sourceProductionReadinessDecision: 'phase-127-unraid-production-readiness-decision',
    scope: 'unraid-foundation-final-human-production-approval-only',
    verdict: 'GO',
    redactionSafe: true,
    mustExcludeRawNotes: true,
    rawNotesIncluded: false,
    recordValuesEchoed: false,
    inputValuesEchoed: false,
    commandExecution: false,
    scriptGenerated: false,
    serviceInstallApproved: true,
    serviceInstalled: false,
    serviceStarted: false,
    mutatesUnraid: false,
    providerContactAllowed: false,
    providerModeEnabled: false,
    productionReady: false,
    launchApproved: false,
    fileCustodianStatus: 'reference-harness-not-production-kms',
    ...overrides,
  };
}

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/unraid-final-human-approval-record-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 129 final human approval record preflight suite:\n');

test('GO record is ready for separate operator switch but does not approve production', () => {
  const report = buildUnraidFinalHumanApprovalRecordPreflight(record());
  assert(report.report === 'phase-129-unraid-final-human-approval-record-preflight', 'report');
  assert(report.verdict === 'GO', 'GO verdict');
  assert(report.approvalRecordStatus === 'ready-for-operator-production-switch', 'ready for switch');
  assert(report.productionReady === false && report.launchApproved === false, 'preflight does not approve');
  assert(report.serviceInstalled === false && report.serviceStarted === false, 'service not installed/started');
  assert(report.providerContactAllowed === false && report.providerModeEnabled === false, 'no provider mode');
});

test('HOLD and malformed records block the operator production switch', () => {
  const hold = buildUnraidFinalHumanApprovalRecordPreflight(record({ verdict: 'HOLD' }));
  assert(hold.summary.fail === 0, 'HOLD is a valid record verdict');
  assert(hold.approvalRecordStatus === 'not-ready-for-operator-production-switch', 'HOLD blocks switch');
  const bad = buildUnraidFinalHumanApprovalRecordPreflight(record({ redactionSafe: false }));
  assert(bad.summary.fail > 0, 'bad redaction fails');
  assert(bad.approvalRecordStatus === 'not-ready-for-operator-production-switch', 'bad record blocks');
});

test('parser and CLI read one explicit record without path or hostile value leaks', () => {
  assert(parseUnraidFinalHumanApprovalRecordJson('{bad') === 'FINAL_APPROVAL_RECORD_JSON_MALFORMED', 'malformed');
  assert(parseUnraidFinalHumanApprovalRecordJson('[]') === 'FINAL_APPROVAL_RECORD_OBJECT_REQUIRED', 'array');
  const dir = mkdtempSync(join(tmpdir(), 'final-human-approval-'));
  try {
    const input = join(dir, 'approval.json');
    writeFileSync(input, JSON.stringify(record({ notes: 'PRIVATE_TITLE_SENTINEL SECRET_VALUE_SENTINEL KEK_SENTINEL' })), 'utf8');
    const result = runCli([input, '--json']);
    const stdout = String(result.stdout);
    assert(result.status === 0, 'CLI exits zero');
    const parsed = JSON.parse(stdout) as UnraidFinalHumanApprovalRecordPreflight;
    assert(parsed.approvalRecordStatus === 'ready-for-operator-production-switch', 'stdout ready');
    assert(!stdout.includes(input), 'stdout omits path');
    assert(!stdout.includes('PRIVATE_TITLE_SENTINEL'), 'stdout omits hostile title');
    assert(!stdout.includes('SECRET_VALUE_SENTINEL'), 'stdout omits hostile secret');
    assert(!stdout.includes('KEK_SENTINEL'), 'stdout omits hostile KEK');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source and docs preserve preflight-only boundary', () => {
  const source = `${read('src/ops/unraid-final-human-approval-record.ts')}\n${read('src/ops/unraid-final-human-approval-record-cli.ts')}`;
  const docs = `${read('docs/PHASE_129_UNRAID_FINAL_HUMAN_APPROVAL_RECORD.md')}\n${read('README.md')}\n${read('package.json')}`;
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assert(scripts['test:unraid-final-human-approval-record'] === 'tsx test/unraid-final-human-approval-record.ts', 'test script');
  assert(scripts['ops:unraid-final-human-approval-record'] === 'tsx src/ops/unraid-final-human-approval-record-cli.ts', 'ops script');
  assert((scripts.test ?? '').includes('test/unraid-final-human-approval-template.ts && tsx test/unraid-final-human-approval-record.ts'), 'aggregate order');
  assert(formatUnraidFinalHumanApprovalRecordPreflightJson(buildUnraidFinalHumanApprovalRecordPreflight(record())).includes('"productionReady": false'), 'json formatter false');
  for (const required of [
    'phase-129-unraid-final-human-approval-record-preflight',
    'phase-128-unraid-final-human-production-approval-record',
    'phase-128-unraid-final-human-approval-template',
    'phase-127-unraid-production-readiness-decision',
    'ready-for-operator-production-switch',
    'productionReady: false',
    'launchApproved: false',
    'recordValuesEchoed: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'serviceInstalled: false',
    'serviceStarted: false',
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
