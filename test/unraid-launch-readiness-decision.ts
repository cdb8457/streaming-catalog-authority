import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildUnraidLaunchReadinessDecision,
  parseUnraidLaunchReadinessDecisionJson,
  type UnraidLaunchReadinessDecision,
} from '../src/ops/unraid-launch-readiness-decision.js';

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

function disposition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    report: 'phase-133-unraid-production-disposition',
    verdict: 'GO',
    dispositionStatus: 'ready-for-launch-readiness-decision',
    redactionSafe: true,
    dispositionValuesEchoed: false,
    inputValuesEchoed: false,
    commandExecution: false,
    scriptGenerated: false,
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
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/unraid-launch-readiness-decision-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 134 Unraid launch readiness decision suite:\n');

test('GO Phase 133 disposition becomes ready for final launch approval record', () => {
  const report = buildUnraidLaunchReadinessDecision(disposition());
  assert(report.report === 'phase-134-unraid-launch-readiness-decision', 'report');
  assert(report.launchReadinessStatus === 'ready-for-final-launch-approval-record', 'ready');
  assert(report.productionReady === false && report.launchApproved === false, 'does not approve');
  assert(report.commandExecution === false && report.mutatesUnraid === false, 'does not execute');
});

test('HOLD or unsafe disposition blocks final launch approval readiness', () => {
  for (const bad of [
    { verdict: 'HOLD' },
    { dispositionStatus: 'not-ready-for-launch-readiness-decision' },
    { redactionSafe: false },
  ]) {
    const report = buildUnraidLaunchReadinessDecision(disposition(bad));
    assert(report.launchReadinessStatus === 'not-ready-for-final-launch-approval-record', 'blocked');
    assert(report.summary.fail > 0, 'has failures');
  }
});

test('parser and CLI read one explicit disposition file without value leaks', () => {
  assert(parseUnraidLaunchReadinessDecisionJson('{bad') === 'LAUNCH_READINESS_JSON_MALFORMED', 'malformed');
  assert(parseUnraidLaunchReadinessDecisionJson('[]') === 'LAUNCH_READINESS_OBJECT_REQUIRED', 'array');
  const dir = mkdtempSync(join(tmpdir(), 'launch-readiness-'));
  try {
    const input = join(dir, 'disposition.json');
    writeFileSync(input, JSON.stringify(disposition({ notes: 'PRIVATE_TITLE_SENTINEL SECRET_VALUE_SENTINEL KEK_SENTINEL' })), 'utf8');
    const result = runCli([input, '--json']);
    const stdout = String(result.stdout);
    assert(result.status === 0, 'CLI exits zero');
    const parsed = JSON.parse(stdout) as UnraidLaunchReadinessDecision;
    assert(parsed.launchReadinessStatus === 'ready-for-final-launch-approval-record', 'stdout ready');
    assert(!stdout.includes(input), 'stdout omits path');
    assert(!stdout.includes('PRIVATE_TITLE_SENTINEL'), 'stdout omits hostile title');
    assert(!stdout.includes('SECRET_VALUE_SENTINEL'), 'stdout omits hostile secret');
    assert(!stdout.includes('KEK_SENTINEL'), 'stdout omits hostile KEK');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source and docs preserve launch-readiness-only boundary', () => {
  const source = `${read('src/ops/unraid-launch-readiness-decision.ts')}\n${read('src/ops/unraid-launch-readiness-decision-cli.ts')}`;
  const docs = `${read('docs/PHASE_134_UNRAID_LAUNCH_READINESS_DECISION.md')}\n${read('README.md')}\n${read('package.json')}`;
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assert(scripts['test:unraid-launch-readiness-decision'] === 'tsx test/unraid-launch-readiness-decision.ts', 'test script');
  assert(scripts['ops:unraid-launch-readiness-decision'] === 'tsx src/ops/unraid-launch-readiness-decision-cli.ts', 'ops script');
  assert((scripts.test ?? '').includes('test/unraid-production-disposition.ts && tsx test/unraid-launch-readiness-decision.ts'), 'aggregate order');
  for (const required of [
    'phase-134-unraid-launch-readiness-decision',
    'phase-133-unraid-production-disposition',
    'ready-for-launch-readiness-decision',
    'ready-for-final-launch-approval-record',
    'productionReady: false',
    'launchApproved: false',
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
