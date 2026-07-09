import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildUnraidProductionSwitchRunbook,
  formatUnraidProductionSwitchRunbookJson,
  parseUnraidProductionSwitchRunbookJson,
  type UnraidProductionSwitchRunbook,
} from '../src/ops/unraid-production-switch-runbook.js';

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

function phase129(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    report: 'phase-129-unraid-final-human-approval-record-preflight',
    approvalRecordStatus: 'ready-for-operator-production-switch',
    verdict: 'GO',
    redactionSafe: true,
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
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/unraid-production-switch-runbook-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 130 Unraid production switch runbook suite:\n');

test('GO Phase 129 preflight yields an operator-window runbook without mutation', () => {
  const packet = buildUnraidProductionSwitchRunbook(phase129());
  assert(packet.report === 'phase-130-unraid-production-switch-runbook', 'report');
  assert(packet.switchReadiness === 'ready-for-explicit-operator-window', 'ready');
  assert(packet.composeFile === 'docker-compose.unraid.yml', 'compose file');
  assert(packet.commandExecution === false && packet.mutatesUnraid === false, 'no execution/mutation');
  assert(packet.serviceInstalled === false && packet.serviceStarted === false, 'no service install/start');
  assert(packet.productionReady === false && packet.launchApproved === false, 'no approval flip');
  assert(packet.commandPlan.preflightDoctor.includes('ops:doctor -- --json'), 'doctor command');
});

test('bad or HOLD Phase 129 preflight blocks the operator window', () => {
  const hold = buildUnraidProductionSwitchRunbook(phase129({
    approvalRecordStatus: 'not-ready-for-operator-production-switch',
    verdict: 'HOLD',
  }));
  assert(hold.switchReadiness === 'not-ready-for-explicit-operator-window', 'HOLD blocks');
  assert(hold.summary.fail > 0, 'HOLD has failures');
  const bad = buildUnraidProductionSwitchRunbook(phase129({ redactionSafe: false }));
  assert(bad.switchReadiness === 'not-ready-for-explicit-operator-window', 'bad redaction blocks');
});

test('parser and CLI read one explicit Phase 129 file without path or hostile value leaks', () => {
  assert(parseUnraidProductionSwitchRunbookJson('{bad') === 'PRODUCTION_SWITCH_JSON_MALFORMED', 'malformed');
  assert(parseUnraidProductionSwitchRunbookJson('[]') === 'PRODUCTION_SWITCH_OBJECT_REQUIRED', 'array');
  const dir = mkdtempSync(join(tmpdir(), 'production-switch-'));
  try {
    const input = join(dir, 'phase129.json');
    writeFileSync(input, JSON.stringify(phase129({ notes: 'PRIVATE_TITLE_SENTINEL SECRET_VALUE_SENTINEL KEK_SENTINEL' })), 'utf8');
    const result = runCli([input, '--json']);
    const stdout = String(result.stdout);
    assert(result.status === 0, 'CLI exits zero');
    const parsed = JSON.parse(stdout) as UnraidProductionSwitchRunbook;
    assert(parsed.switchReadiness === 'ready-for-explicit-operator-window', 'stdout ready');
    assert(!stdout.includes(input), 'stdout omits path');
    assert(!stdout.includes('PRIVATE_TITLE_SENTINEL'), 'stdout omits hostile title');
    assert(!stdout.includes('SECRET_VALUE_SENTINEL'), 'stdout omits hostile secret');
    assert(!stdout.includes('KEK_SENTINEL'), 'stdout omits hostile KEK');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source and docs preserve runbook-only boundary', () => {
  const source = `${read('src/ops/unraid-production-switch-runbook.ts')}\n${read('src/ops/unraid-production-switch-runbook-cli.ts')}`;
  const docs = `${read('docs/PHASE_130_UNRAID_PRODUCTION_SWITCH_RUNBOOK.md')}\n${read('README.md')}\n${read('package.json')}`;
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assert(scripts['test:unraid-production-switch-runbook'] === 'tsx test/unraid-production-switch-runbook.ts', 'test script');
  assert(scripts['ops:unraid-production-switch-runbook'] === 'tsx src/ops/unraid-production-switch-runbook-cli.ts', 'ops script');
  assert((scripts.test ?? '').includes('test/unraid-final-human-approval-record.ts && tsx test/unraid-production-switch-runbook.ts'), 'aggregate order');
  assert(formatUnraidProductionSwitchRunbookJson(buildUnraidProductionSwitchRunbook(phase129())).includes('"productionReady": false'), 'json formatter false');
  for (const required of [
    'phase-130-unraid-production-switch-runbook',
    'phase-129-unraid-final-human-approval-record-preflight',
    'ready-for-explicit-operator-window',
    'unraid-live-operating-test-2026-07-08.redacted.md',
    'docker-compose.unraid.yml',
    'productionReady: false',
    'launchApproved: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'serviceInstalled: false',
    'serviceStarted: false',
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
