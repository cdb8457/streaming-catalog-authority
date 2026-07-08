import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildUnraidInstallEvidenceCaptureReport,
  sampleUnraidInstallEvidenceCaptureRecord,
  sampleUnraidInstallEvidenceManifestForCapture,
} from '../src/ops/unraid-install-evidence-capture-gate.js';
import {
  buildUnraidPostInstallValidationReviewReport,
  sampleUnraidInstallEvidenceCaptureGateReport,
  sampleUnraidPostInstallValidationReviewRecord,
} from '../src/ops/unraid-post-install-validation-review.js';
import {
  buildUnraidProductionReadinessDecisionReport,
  sampleUnraidPostInstallValidationReviewReport,
  sampleUnraidProductionReadinessDecisionRecord,
} from '../src/ops/unraid-production-readiness-decision.js';

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

console.log('Running Phases 125-127 Unraid production gates suite:\n');

test('Phase 125 validates complete redacted install evidence without mutation', () => {
  const report = buildUnraidInstallEvidenceCaptureReport(sampleUnraidInstallEvidenceManifestForCapture(), sampleUnraidInstallEvidenceCaptureRecord());
  assert(report.installEvidenceStatus === 'complete-ready-for-post-install-review', 'ready for review');
  assert(report.operatorReportedServiceInstalled === true, 'operator reported install');
  assert(report.serviceInstalled === false && report.serviceStarted === false, 'tool did not install/start');
  assert(report.productionReady === false && report.commandExecution === false, 'not production/executing');
});

test('Phase 126 validates post-install review without production approval', () => {
  const report = buildUnraidPostInstallValidationReviewReport(sampleUnraidInstallEvidenceCaptureGateReport(), sampleUnraidPostInstallValidationReviewRecord());
  assert(report.postInstallValidationStatus === 'ready-for-production-readiness-decision', 'ready for decision');
  assert(report.serviceInstalled === false && report.serviceStarted === false, 'tool did not install/start');
  assert(report.productionReady === false && report.launchApproved === false, 'not production/launch approved');
});

test('Phase 127 reaches final human approval gate while productionReady remains false', () => {
  const report = buildUnraidProductionReadinessDecisionReport(sampleUnraidPostInstallValidationReviewReport(), sampleUnraidProductionReadinessDecisionRecord());
  assert(report.productionReadinessDecisionStatus === 'ready-for-final-human-production-approval', 'ready for final human approval');
  assert(report.productionReady === false && report.launchApproved === false, 'still not production ready');
  assert(report.commandExecution === false && report.providerModeEnabled === false, 'no execution/provider mode');
});

test('CLIs emit parseable redaction-safe JSON for the happy path', () => {
  const temp = mkdtempSync(join(tmpdir(), 'phase-125-127-'));
  const manifest = join(temp, 'manifest.json');
  const evidence = join(temp, 'evidence.json');
  const gate = join(temp, 'gate.json');
  const review = join(temp, 'review.json');
  const validation = join(temp, 'validation.json');
  const decision = join(temp, 'decision.json');
  writeFileSync(manifest, JSON.stringify(sampleUnraidInstallEvidenceManifestForCapture()), 'utf8');
  writeFileSync(evidence, JSON.stringify(sampleUnraidInstallEvidenceCaptureRecord()), 'utf8');
  const phase125 = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/unraid-install-evidence-capture-gate-cli.ts', '--manifest', manifest, '--evidence', evidence, '--json'], { cwd: root, encoding: 'utf8' });
  writeFileSync(gate, phase125, 'utf8');
  writeFileSync(review, JSON.stringify(sampleUnraidPostInstallValidationReviewRecord()), 'utf8');
  const phase126 = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/unraid-post-install-validation-review-cli.ts', '--evidence-gate', gate, '--review', review, '--json'], { cwd: root, encoding: 'utf8' });
  writeFileSync(validation, phase126, 'utf8');
  writeFileSync(decision, JSON.stringify(sampleUnraidProductionReadinessDecisionRecord()), 'utf8');
  const phase127 = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/unraid-production-readiness-decision-cli.ts', '--validation-review', validation, '--decision', decision, '--json'], { cwd: root, encoding: 'utf8' });
  for (const output of [phase125, phase126, phase127]) {
    assert(!output.includes('SECRET_VALUE_SENTINEL') && !output.includes('postgres://'), 'no hostile values');
    assert(!output.includes(temp), 'no temp path leak');
    JSON.parse(output);
  }
});

test('docs, scripts, and source preserve production gate boundaries', () => {
  const pkg = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assert(pkg['test:unraid-production-gates'] === 'tsx test/unraid-production-gates.ts', 'test script');
  assert(pkg['ops:unraid-install-evidence-capture-gate'] === 'tsx src/ops/unraid-install-evidence-capture-gate-cli.ts', 'phase125 script');
  assert(pkg['ops:unraid-post-install-validation-review'] === 'tsx src/ops/unraid-post-install-validation-review-cli.ts', 'phase126 script');
  assert(pkg['ops:unraid-production-readiness-decision'] === 'tsx src/ops/unraid-production-readiness-decision-cli.ts', 'phase127 script');
  assert((pkg.test ?? '').includes('test/unraid-install-evidence-manifest.ts && tsx test/unraid-production-gates.ts'), 'aggregate order');
  const docs = `${read('docs/PHASE_125_127_UNRAID_PRODUCTION_GATES.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const required of [
    'phase-125-unraid-install-evidence-capture-gate',
    'phase-126-unraid-post-install-validation-review',
    'phase-127-unraid-production-readiness-decision',
    'ready-for-final-human-production-approval',
    'productionReady: false',
    'launchApproved: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'providerModeEnabled: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(docs.includes(required), `docs include ${required}`);
  const source = [
    'src/ops/unraid-install-evidence-capture-gate.ts',
    'src/ops/unraid-post-install-validation-review.ts',
    'src/ops/unraid-production-readiness-decision.ts',
  ].map(read).join('\n');
  for (const forbidden of ['node:http', 'node:https', 'node:net', 'globalThis.fetch', 'fetch(', "from 'pg'", 'ProviderAdapter', 'TorBoxReadOnlyClient', 'JellyfinHttpClient']) {
    assert(!source.includes(forbidden), `source excludes ${forbidden}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
