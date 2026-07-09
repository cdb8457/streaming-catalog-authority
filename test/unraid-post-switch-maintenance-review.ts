import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildUnraidPostSwitchMaintenanceReview,
  parseUnraidPostSwitchMaintenanceReviewJson,
  type UnraidPostSwitchMaintenanceReview,
} from '../src/ops/unraid-post-switch-maintenance-review.js';

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

function evidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    record: 'phase-138-unraid-post-switch-maintenance-record',
    sourcePostSwitchEvidenceReview: 'phase-137-unraid-post-switch-evidence-review',
    phase137OperationalStatus: 'service-running-with-open-hardening-warnings',
    redactionSafe: true,
    evidenceValuesEchoed: false,
    inputValuesEchoed: false,
    commandExecution: false,
    scriptGenerated: false,
    mutatesUnraid: false,
    providerContactAllowed: false,
    providerModeEnabled: false,
    rawSecretsIncluded: false,
    rawLogsIncluded: false,
    identityValuesIncluded: false,
    userScriptsPreservePersistentPostgres: true,
    doctorScriptComplete: true,
    backupVerifyScriptComplete: true,
    kekRewrapPlanScriptComplete: true,
    plaintextBackupCandidates: 0,
    serviceName: 'repo-postgres-1',
    serviceStateAfterMaintenance: 'healthy',
    publishedPorts: false,
    serviceInstalled: true,
    serviceStarted: true,
    launchApproved: true,
    productionReady: false,
    fileCustodianStatus: 'reference-harness-not-production-kms',
    ...overrides,
  };
}

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/unraid-post-switch-maintenance-review-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 138 Unraid post-switch maintenance review suite:\n');

test('complete maintenance evidence is accepted and keeps service running', () => {
  const report = buildUnraidPostSwitchMaintenanceReview(evidence());
  assert(report.report === 'phase-138-unraid-post-switch-maintenance-review', 'report');
  assert(report.maintenanceStatus === 'post-switch-maintenance-evidence-accepted', 'accepted');
  assert(report.serviceInstalled === true && report.serviceStarted === true, 'service running');
  assert(report.launchApproved === true, 'launch approved carried forward');
  assert(report.productionReady === false, 'productionReady remains false');
});

test('unsafe or incomplete maintenance evidence blocks acceptance', () => {
  for (const bad of [
    { userScriptsPreservePersistentPostgres: false },
    { backupVerifyScriptComplete: false },
    { plaintextBackupCandidates: 1 },
    { serviceStateAfterMaintenance: 'stopped' },
  ]) {
    const report = buildUnraidPostSwitchMaintenanceReview(evidence(bad));
    assert(report.maintenanceStatus === 'not-ready', 'blocked');
    assert(report.summary.fail > 0, 'has failures');
  }
});

test('parser and CLI read one explicit maintenance file without value leaks', () => {
  assert(parseUnraidPostSwitchMaintenanceReviewJson('{bad') === 'POST_SWITCH_MAINTENANCE_JSON_MALFORMED', 'malformed');
  assert(parseUnraidPostSwitchMaintenanceReviewJson('[]') === 'POST_SWITCH_MAINTENANCE_OBJECT_REQUIRED', 'array');
  const dir = mkdtempSync(join(tmpdir(), 'post-switch-maintenance-'));
  try {
    const input = join(dir, 'evidence.json');
    writeFileSync(input, JSON.stringify(evidence({ notes: 'PRIVATE_TITLE_SENTINEL SECRET_VALUE_SENTINEL KEK_SENTINEL' })), 'utf8');
    const result = runCli([input, '--json']);
    const stdout = String(result.stdout);
    assert(result.status === 0, 'CLI exits zero');
    const parsed = JSON.parse(stdout) as UnraidPostSwitchMaintenanceReview;
    assert(parsed.maintenanceStatus === 'post-switch-maintenance-evidence-accepted', 'stdout ready');
    assert(!stdout.includes(input), 'stdout omits path');
    assert(!stdout.includes('PRIVATE_TITLE_SENTINEL'), 'stdout omits hostile title');
    assert(!stdout.includes('SECRET_VALUE_SENTINEL'), 'stdout omits hostile secret');
    assert(!stdout.includes('KEK_SENTINEL'), 'stdout omits hostile KEK');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source and docs preserve maintenance review boundary', () => {
  const source = `${read('src/ops/unraid-post-switch-maintenance-review.ts')}\n${read('src/ops/unraid-post-switch-maintenance-review-cli.ts')}`;
  const docs = `${read('docs/PHASE_138_UNRAID_POST_SWITCH_MAINTENANCE_REVIEW.md')}\n${read('README.md')}\n${read('package.json')}`;
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assert(scripts['test:unraid-post-switch-maintenance-review'] === 'tsx test/unraid-post-switch-maintenance-review.ts', 'test script');
  assert(scripts['ops:unraid-post-switch-maintenance-review'] === 'tsx src/ops/unraid-post-switch-maintenance-review-cli.ts', 'ops script');
  assert((scripts.test ?? '').includes('test/unraid-post-switch-evidence-review.ts && tsx test/unraid-post-switch-maintenance-review.ts'), 'aggregate order');
  for (const required of [
    'phase-138-unraid-post-switch-maintenance-review',
    'phase-137-unraid-post-switch-evidence-review',
    'post-switch-maintenance-evidence-accepted',
    'serviceInstalled: true',
    'serviceStarted: true',
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
