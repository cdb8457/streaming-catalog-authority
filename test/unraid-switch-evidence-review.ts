import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildUnraidSwitchEvidenceReview,
  parseUnraidSwitchEvidenceReviewJson,
  type UnraidSwitchEvidenceReview,
} from '../src/ops/unraid-switch-evidence-review.js';

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
    record: 'phase-132-unraid-switch-evidence-record',
    sourceCapturePacket: 'phase-131-unraid-switch-evidence-capture',
    sourceRunbook: 'phase-130-unraid-production-switch-runbook',
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
    rawBackupContentsIncluded: false,
    identityValuesIncluded: false,
    preSwitchDoctorRedacted: true,
    operatorSwitchCommandLabelCaptured: true,
    serviceStatusAfterSwitchLabelCaptured: true,
    postSwitchDoctorRedacted: true,
    composePsAfterSwitchLabelCaptured: true,
    productionReady: false,
    launchApproved: false,
    fileCustodianStatus: 'reference-harness-not-production-kms',
    ...overrides,
  };
}

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/unraid-switch-evidence-review-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 132 Unraid switch evidence review suite:\n');

test('complete redacted evidence is ready for final disposition but approves nothing', () => {
  const report = buildUnraidSwitchEvidenceReview(evidence());
  assert(report.report === 'phase-132-unraid-switch-evidence-review', 'report');
  assert(report.serviceEvidenceStatus === 'service-evidence-present', 'service evidence present');
  assert(report.reviewStatus === 'ready-for-final-production-disposition', 'ready');
  assert(report.productionReady === false && report.launchApproved === false, 'does not approve');
  assert(report.commandExecution === false && report.mutatesUnraid === false, 'does not execute');
});

test('missing or unsafe evidence blocks final disposition', () => {
  for (const bad of [
    { postSwitchDoctorRedacted: false },
    { rawSecretsIncluded: true },
    { identityValuesIncluded: true },
  ]) {
    const report = buildUnraidSwitchEvidenceReview(evidence(bad));
    assert(report.reviewStatus === 'not-ready-for-final-production-disposition', 'blocked');
    assert(report.summary.fail > 0, 'has failures');
  }
});

test('parser and CLI read one explicit evidence file without value leaks', () => {
  assert(parseUnraidSwitchEvidenceReviewJson('{bad') === 'SWITCH_EVIDENCE_JSON_MALFORMED', 'malformed');
  assert(parseUnraidSwitchEvidenceReviewJson('[]') === 'SWITCH_EVIDENCE_OBJECT_REQUIRED', 'array');
  const dir = mkdtempSync(join(tmpdir(), 'switch-evidence-review-'));
  try {
    const input = join(dir, 'evidence.json');
    writeFileSync(input, JSON.stringify(evidence({ notes: 'PRIVATE_TITLE_SENTINEL SECRET_VALUE_SENTINEL KEK_SENTINEL' })), 'utf8');
    const result = runCli([input, '--json']);
    const stdout = String(result.stdout);
    assert(result.status === 0, 'CLI exits zero');
    const parsed = JSON.parse(stdout) as UnraidSwitchEvidenceReview;
    assert(parsed.reviewStatus === 'ready-for-final-production-disposition', 'stdout ready');
    assert(!stdout.includes(input), 'stdout omits path');
    assert(!stdout.includes('PRIVATE_TITLE_SENTINEL'), 'stdout omits hostile title');
    assert(!stdout.includes('SECRET_VALUE_SENTINEL'), 'stdout omits hostile secret');
    assert(!stdout.includes('KEK_SENTINEL'), 'stdout omits hostile KEK');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source and docs preserve review-only boundary', () => {
  const source = `${read('src/ops/unraid-switch-evidence-review.ts')}\n${read('src/ops/unraid-switch-evidence-review-cli.ts')}`;
  const docs = `${read('docs/PHASE_132_UNRAID_SWITCH_EVIDENCE_REVIEW.md')}\n${read('README.md')}\n${read('package.json')}`;
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assert(scripts['test:unraid-switch-evidence-review'] === 'tsx test/unraid-switch-evidence-review.ts', 'test script');
  assert(scripts['ops:unraid-switch-evidence-review'] === 'tsx src/ops/unraid-switch-evidence-review-cli.ts', 'ops script');
  assert((scripts.test ?? '').includes('test/unraid-switch-evidence-capture.ts && tsx test/unraid-switch-evidence-review.ts'), 'aggregate order');
  for (const required of [
    'phase-132-unraid-switch-evidence-review',
    'phase-132-unraid-switch-evidence-record',
    'phase-131-unraid-switch-evidence-capture',
    'phase-130-unraid-production-switch-runbook',
    'service-evidence-present',
    'ready-for-final-production-disposition',
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
