import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildUnraidProductionSwitchExecutionPacket,
  parseUnraidProductionSwitchExecutionPacketJson,
  type UnraidProductionSwitchExecutionPacket,
} from '../src/ops/unraid-production-switch-execution-packet.js';

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

function approvalRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    report: 'phase-135-unraid-final-launch-approval-record',
    finalLaunchApprovalStatus: 'ready-for-production-switch-execution-packet',
    sourceLaunchReadinessDecision: 'phase-134-unraid-launch-readiness-decision',
    redactionSafe: true,
    approvalValuesEchoed: false,
    inputValuesEchoed: false,
    commandExecution: false,
    scriptGenerated: false,
    mutatesUnraid: false,
    providerContactAllowed: false,
    providerModeEnabled: false,
    serviceInstallApproved: true,
    serviceInstalled: false,
    serviceStarted: false,
    productionReady: false,
    launchApproved: true,
    fileCustodianStatus: 'reference-harness-not-production-kms',
    ...overrides,
  };
}

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/unraid-production-switch-execution-packet-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 136 Unraid production switch execution packet suite:\n');

test('approved Phase 135 record becomes ready for real Unraid production switch', () => {
  const report = buildUnraidProductionSwitchExecutionPacket(approvalRecord());
  assert(report.report === 'phase-136-unraid-production-switch-execution-packet', 'report');
  assert(report.executionPacketStatus === 'ready-for-real-unraid-production-switch', 'ready');
  assert(report.launchApproved === true, 'launch approved carried forward');
  assert(report.productionReady === false, 'not production ready until switch evidence');
  assert(report.commandExecution === false && report.mutatesUnraid === false, 'does not execute');
  assert(report.commandPlan.preflightDoctor.includes('docker compose'), 'command plan present');
});

test('unapproved or unsafe Phase 135 record blocks real switch readiness', () => {
  for (const bad of [
    { finalLaunchApprovalStatus: 'not-ready-for-production-switch-execution-packet' },
    { launchApproved: false },
    { commandExecution: true },
    { redactionSafe: false },
  ]) {
    const report = buildUnraidProductionSwitchExecutionPacket(approvalRecord(bad));
    assert(report.executionPacketStatus === 'not-ready-for-real-unraid-production-switch', 'blocked');
    assert(report.summary.fail > 0, 'has failures');
  }
});

test('parser and CLI read one explicit Phase 135 file without value leaks', () => {
  assert(parseUnraidProductionSwitchExecutionPacketJson('{bad') === 'PRODUCTION_SWITCH_EXECUTION_JSON_MALFORMED', 'malformed');
  assert(parseUnraidProductionSwitchExecutionPacketJson('[]') === 'PRODUCTION_SWITCH_EXECUTION_OBJECT_REQUIRED', 'array');
  const dir = mkdtempSync(join(tmpdir(), 'switch-execution-'));
  try {
    const input = join(dir, 'approval.json');
    writeFileSync(input, JSON.stringify(approvalRecord({ notes: 'PRIVATE_TITLE_SENTINEL SECRET_VALUE_SENTINEL KEK_SENTINEL' })), 'utf8');
    const result = runCli([input, '--json']);
    const stdout = String(result.stdout);
    assert(result.status === 0, 'CLI exits zero');
    const parsed = JSON.parse(stdout) as UnraidProductionSwitchExecutionPacket;
    assert(parsed.executionPacketStatus === 'ready-for-real-unraid-production-switch', 'stdout ready');
    assert(!stdout.includes(input), 'stdout omits path');
    assert(!stdout.includes('PRIVATE_TITLE_SENTINEL'), 'stdout omits hostile title');
    assert(!stdout.includes('SECRET_VALUE_SENTINEL'), 'stdout omits hostile secret');
    assert(!stdout.includes('KEK_SENTINEL'), 'stdout omits hostile KEK');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source and docs preserve execution-packet-only boundary', () => {
  const source = `${read('src/ops/unraid-production-switch-execution-packet.ts')}\n${read('src/ops/unraid-production-switch-execution-packet-cli.ts')}`;
  const docs = `${read('docs/PHASE_136_UNRAID_PRODUCTION_SWITCH_EXECUTION_PACKET.md')}\n${read('README.md')}\n${read('package.json')}`;
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assert(scripts['test:unraid-production-switch-execution-packet'] === 'tsx test/unraid-production-switch-execution-packet.ts', 'test script');
  assert(scripts['ops:unraid-production-switch-execution-packet'] === 'tsx src/ops/unraid-production-switch-execution-packet-cli.ts', 'ops script');
  assert((scripts.test ?? '').includes('test/unraid-final-launch-approval-record.ts && tsx test/unraid-production-switch-execution-packet.ts'), 'aggregate order');
  for (const required of [
    'phase-136-unraid-production-switch-execution-packet',
    'phase-135-unraid-final-launch-approval-record',
    'ready-for-production-switch-execution-packet',
    'ready-for-real-unraid-production-switch',
    'launchApproved: true',
    'productionReady: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'mutatesUnraid: false',
    'providerModeEnabled: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(docs.includes(required), `docs include ${required}`);
  for (const forbidden of ['node:http', 'node:https', 'node:net', 'globalThis.fetch', 'fetch(', "from 'pg'", 'execSync', 'ProviderAdapter', 'TorBoxReadOnlyClient', 'JellyfinHttpClient']) {
    assert(!source.includes(forbidden), `source excludes ${forbidden}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
