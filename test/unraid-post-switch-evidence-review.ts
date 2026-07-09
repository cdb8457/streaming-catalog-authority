import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildUnraidPostSwitchEvidenceReview,
  parseUnraidPostSwitchEvidenceReviewJson,
  type UnraidPostSwitchEvidenceReview,
} from '../src/ops/unraid-post-switch-evidence-review.js';

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
    record: 'phase-137-unraid-post-switch-evidence-record',
    sourceExecutionPacket: 'phase-136-unraid-production-switch-execution-packet',
    executionPacketStatus: 'ready-for-real-unraid-production-switch',
    deployedCommit: '7e2db7c8b6b9ac68272e01ee51e6c63399fc0ef3',
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
    appEnv: 'production',
    custodianMode: 'file',
    serviceName: 'repo-postgres-1',
    serviceState: 'healthy',
    publishedPorts: false,
    postSwitchDoctorOk: true,
    postSwitchDoctorPassCount: 12,
    postSwitchDoctorWarnCount: 2,
    postSwitchDoctorFailCount: 0,
    o4Status: 'open-warning',
    o5Status: 'open-warning',
    serviceInstalled: true,
    serviceStarted: true,
    launchApproved: true,
    productionReady: false,
    fileCustodianStatus: 'reference-harness-not-production-kms',
    ...overrides,
  };
}

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/unraid-post-switch-evidence-review-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 137 Unraid post-switch evidence review suite:\n');

test('complete post-switch evidence records running service with open warnings', () => {
  const report = buildUnraidPostSwitchEvidenceReview(evidence());
  assert(report.report === 'phase-137-unraid-post-switch-evidence-review', 'report');
  assert(report.operationalStatus === 'service-running-with-open-hardening-warnings', 'operational');
  assert(report.serviceInstalled === true && report.serviceStarted === true, 'service running');
  assert(report.launchApproved === true, 'launch approved carried forward');
  assert(report.productionReady === false, 'productionReady remains false');
  assert(report.o4Status === 'open-warning' && report.o5Status === 'open-warning', 'warnings preserved');
});

test('missing or unsafe post-switch evidence blocks operational status', () => {
  for (const bad of [
    { serviceState: 'stopped' },
    { postSwitchDoctorFailCount: 1 },
    { rawSecretsIncluded: true },
    { appEnv: 'development' },
  ]) {
    const report = buildUnraidPostSwitchEvidenceReview(evidence(bad));
    assert(report.operationalStatus === 'not-ready', 'blocked');
    assert(report.summary.fail > 0, 'has failures');
  }
});

test('parser and CLI read one explicit evidence file without value leaks', () => {
  assert(parseUnraidPostSwitchEvidenceReviewJson('{bad') === 'POST_SWITCH_EVIDENCE_JSON_MALFORMED', 'malformed');
  assert(parseUnraidPostSwitchEvidenceReviewJson('[]') === 'POST_SWITCH_EVIDENCE_OBJECT_REQUIRED', 'array');
  const dir = mkdtempSync(join(tmpdir(), 'post-switch-evidence-'));
  try {
    const input = join(dir, 'evidence.json');
    writeFileSync(input, JSON.stringify(evidence({ notes: 'PRIVATE_TITLE_SENTINEL SECRET_VALUE_SENTINEL KEK_SENTINEL' })), 'utf8');
    const result = runCli([input, '--json']);
    const stdout = String(result.stdout);
    assert(result.status === 0, 'CLI exits zero');
    const parsed = JSON.parse(stdout) as UnraidPostSwitchEvidenceReview;
    assert(parsed.operationalStatus === 'service-running-with-open-hardening-warnings', 'stdout ready');
    assert(!stdout.includes(input), 'stdout omits path');
    assert(!stdout.includes('PRIVATE_TITLE_SENTINEL'), 'stdout omits hostile title');
    assert(!stdout.includes('SECRET_VALUE_SENTINEL'), 'stdout omits hostile secret');
    assert(!stdout.includes('KEK_SENTINEL'), 'stdout omits hostile KEK');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source and docs preserve post-switch review boundary', () => {
  const source = `${read('src/ops/unraid-post-switch-evidence-review.ts')}\n${read('src/ops/unraid-post-switch-evidence-review-cli.ts')}`;
  const docs = `${read('docs/PHASE_137_UNRAID_POST_SWITCH_EVIDENCE_REVIEW.md')}\n${read('README.md')}\n${read('package.json')}`;
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assert(scripts['test:unraid-post-switch-evidence-review'] === 'tsx test/unraid-post-switch-evidence-review.ts', 'test script');
  assert(scripts['ops:unraid-post-switch-evidence-review'] === 'tsx src/ops/unraid-post-switch-evidence-review-cli.ts', 'ops script');
  assert((scripts.test ?? '').includes('test/unraid-production-switch-execution-packet.ts && tsx test/unraid-post-switch-evidence-review.ts'), 'aggregate order');
  for (const required of [
    'phase-137-unraid-post-switch-evidence-review',
    'phase-136-unraid-production-switch-execution-packet',
    'service-running-with-open-hardening-warnings',
    'serviceInstalled: true',
    'serviceStarted: true',
    'launchApproved: true',
    'productionReady: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'providerModeEnabled: false',
    'o4Status: open-warning',
    'o5Status: open-warning',
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
