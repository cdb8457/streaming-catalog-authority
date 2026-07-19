import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClosureInputBundleAudit } from '../src/ops/promotion-closure-input-bundle-audit.js';
import { buildFixtureEvidenceBundle } from '../src/ops/promotion-fixture-bundle.js';
import { replayFixtureBundle } from '../src/ops/promotion-bundle-replay.js';
import { buildCoordinatorEvidencePacket } from '../src/ops/promotion-evidence-packet.js';
import { buildReviewTranscript } from '../src/ops/promotion-review-transcript.js';
import { buildProvenanceLedger } from '../src/ops/promotion-provenance-ledger.js';
import { verifyGateDag } from '../src/ops/promotion-gate-dag.js';
import { buildArchiveManifest } from '../src/ops/promotion-archive-manifest.js';
import { buildReviewBundle } from '../src/ops/promotion-review-bundle.js';
import { buildFinalSummary } from '../src/ops/promotion-final-summary.js';
import { verifySelfDigests } from '../src/ops/promotion-self-digest-verifier.js';
import { buildNegativeEvidenceCorpus } from '../src/ops/promotion-negative-evidence-corpus.js';
import { buildClosureHygiene } from '../src/ops/promotion-closure-hygiene.js';
import { buildReleaseChecklist } from '../src/ops/promotion-release-checklist.js';
import { buildMergeReadiness } from '../src/ops/promotion-merge-readiness.js';
import { buildProvenanceDiff } from '../src/ops/promotion-provenance-diff.js';
import { buildGateCoverage } from '../src/ops/promotion-gate-coverage.js';
import { buildChainBundle } from '../src/ops/promotion-chain-bundle.js';
import { buildRedactionCorpus } from '../src/ops/promotion-redaction-corpus.js';
import { buildBoundaryPolicy } from '../src/ops/promotion-boundary-policy.js';
import { buildReviewAutomation } from '../src/ops/promotion-review-automation.js';
import { buildReviewerPack } from '../src/ops/promotion-reviewer-pack.js';
import { buildAcceptancePreflight } from '../src/ops/promotion-acceptance-preflight.js';
import { buildFailureMatrix } from '../src/ops/promotion-failure-matrix.js';
import { buildCliErgonomics } from '../src/ops/promotion-cli-ergonomics.js';
import { buildReportSchema } from '../src/ops/promotion-report-schema.js';
import { buildBoundaryAudit } from '../src/ops/promotion-boundary-audit.js';
import { buildCoordinatorReadiness } from '../src/ops/promotion-coordinator-readiness.js';
import { buildTranscriptVerification } from '../src/ops/promotion-transcript-verifier.js';
import { buildEvidenceMinimizer } from '../src/ops/promotion-evidence-minimizer.js';
import { buildCommitRangeClosure } from '../src/ops/promotion-commit-range-closure.js';
import { buildRegressionOracle } from '../src/ops/promotion-regression-oracle.js';
import { buildTerminalClosure } from '../src/ops/promotion-terminal-closure.js';
import { buildPackComponentIntegrity } from '../src/ops/promotion-pack-component-integrity.js';
import { buildAggregatorDigestAudit } from '../src/ops/promotion-aggregator-digest-audit.js';
import { buildArtifactExportManifest } from '../src/ops/promotion-artifact-export-manifest.js';
import { buildWatchdogHygiene } from '../src/ops/promotion-watchdog-hygiene.js';
import { buildTerminalReadinessV2 } from '../src/ops/promotion-terminal-readiness-v2.js';
import { buildReviewAuthorization } from '../src/ops/promotion-review-authorization.js';
import { buildReviewMatrix } from '../src/ops/promotion-review-matrix.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-bundleaudit-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 29, 8, 0, i++)); }
const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const C1 = 'b'.repeat(40); const C2 = 'c'.repeat(40);
const BASE = '1111111111111111111111111111111111111111';
const CMD = 'npm run test:phase230-local';
const RUN = 'run-2026-07-19';
const SAFE_CONFIG = { debounceMs: 500, idempotent: true, autoPromote: false, respectsLiveBoundary: true, deduplicateBy: 'content-digest' };

function seal(scope: string, body: Record<string, unknown>, field: string): Record<string, unknown> {
  return { ...body, [field]: createHash('sha256').update(`${scope}:${JSON.stringify(body)}`).digest('hex') };
}

async function fullBundle(root: string): Promise<unknown[]> {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'bundleaudit', now: makeNow() })));
  const replay = replayFixtureBundle(bundle);
  const evidence = buildCoordinatorEvidencePacket({ bundle, replay });
  const transcript = buildReviewTranscript({ reviewedCommit: HEAD, testResults: [{ command: CMD, passed: 5, failed: 0 }] });
  const ledger = buildProvenanceLedger({ bundle, replay, evidence, transcript });
  const dag = verifyGateDag();
  const archive = buildArchiveManifest({ ledger, dag, evidence, transcript });
  const reviewBundle = buildReviewBundle({ evidence, transcript, ledger, dag, archive });
  const selfDigest = verifySelfDigests([evidence, transcript, ledger, dag, archive, reviewBundle]);
  const finalSummary = buildFinalSummary({ reviewBundle, transcript });
  const negativeCorpus = buildNegativeEvidenceCorpus();
  const closureHygiene = buildClosureHygiene(projectRoot);
  const releaseChecklist = buildReleaseChecklist({ reviewBundle, transcript, finalSummary, closureHygiene, negativeCorpus, selfDigest });
  const context = { branch: 'work/phase-230', base: BASE, head: HEAD, commits: [{ sha: C1, subject: 'c1 (phase BW)' }, { sha: C2, subject: 'c2 (phase BW)' }, { sha: HEAD, subject: 'c3 (phase BW)' }], requiredTests: [CMD] };
  const mergeReadiness = buildMergeReadiness({ releaseChecklist, finalSummary, context });
  const provenanceDiff = buildProvenanceDiff({ context, transcript, finalSummary, reviewBundle });
  const gateCoverage = buildGateCoverage(projectRoot);
  const chainBundle = buildChainBundle({ finalSummary, releaseChecklist, mergeReadiness, negativeCorpus, provenanceDiff, gateCoverage });
  const redactionCorpus = buildRedactionCorpus();
  const boundaryPolicy = buildBoundaryPolicy(projectRoot);
  const reviewAutomation = buildReviewAutomation({ chainBundle, redactionCorpus, boundaryPolicy });
  const reviewerPack = buildReviewerPack({ finalSummary, releaseChecklist, mergeReadiness, chainBundle, reviewAutomation, redactionCorpus, boundaryPolicy });
  const acceptancePreflight = buildAcceptancePreflight({ reviewerPack, context });
  const failureMatrix = buildFailureMatrix(projectRoot);
  const cliErgonomics = buildCliErgonomics(projectRoot);
  const reportSchema = buildReportSchema([provenanceDiff, gateCoverage, chainBundle, redactionCorpus, boundaryPolicy, reviewAutomation, reviewerPack, acceptancePreflight, failureMatrix, cliErgonomics]);
  const boundaryAudit = buildBoundaryAudit(projectRoot);
  const coordinatorReadiness = buildCoordinatorReadiness({ acceptancePreflight, failureMatrix, reportSchema, boundaryAudit, cliErgonomics });
  const transcriptVerification = buildTranscriptVerification({ transcript, head: HEAD, expectedCommands: [CMD] });
  const commitRangeClosure = buildCommitRangeClosure(context);
  const evidenceMinimizer = buildEvidenceMinimizer([finalSummary, reviewBundle, dag]);
  const regressionOracle = buildRegressionOracle(projectRoot);
  const terminalClosure = buildTerminalClosure({ transcriptVerification, evidenceMinimizer, commitRangeClosure, regressionOracle, coordinatorReadiness });
  const packComponentIntegrity = buildPackComponentIntegrity({ reviewerPack, finalSummary, releaseChecklist, mergeReadiness, chainBundle, reviewAutomation, redactionCorpus, boundaryPolicy });
  const aggregatorDigestAudit = buildAggregatorDigestAudit(projectRoot);
  const artifactExportManifest = buildArtifactExportManifest(projectRoot);
  const watchdogHygiene = buildWatchdogHygiene({ config: SAFE_CONFIG, queue: [{ itemDigest: 'a'.repeat(64), status: 'processed', run: RUN }], currentRun: RUN });
  const readiness = buildTerminalReadinessV2({ terminalClosure, packComponentIntegrity, aggregatorDigestAudit, artifactExportManifest, negativeEvidenceCorpus: negativeCorpus, watchdogHygiene });
  const reviewMatrix = buildReviewMatrix({ base: BASE, head: HEAD, commits: [{ sha: C1 }, { sha: C2 }, { sha: HEAD }], requiredTests: [CMD] });
  const reviewAuthorization = buildReviewAuthorization({ readiness, terminalClosure, commitRangeClosure, transcriptVerification, reviewMatrix });
  return [reviewAuthorization, coordinatorReadiness, readiness, terminalClosure, commitRangeClosure, transcriptVerification, reviewMatrix, acceptancePreflight, failureMatrix, reportSchema, boundaryAudit, cliErgonomics, evidenceMinimizer, regressionOracle, packComponentIntegrity, aggregatorDigestAudit, artifactExportManifest, negativeCorpus, watchdogHygiene];
}

console.log('Running Phase 230 closure input bundle audit suite:\n');

await test('CLOSURE_BUNDLE_VERIFIED on the genuine full mesh (all roots resolve)', async () => {
  const root = workspace();
  try {
    const a = buildClosureInputBundleAudit({ reports: await fullBundle(root) });
    assertEq(a.overall, 'CLOSURE_BUNDLE_VERIFIED', `verified (blockers: ${a.blockers.join(',')})`);
    assertEq(a.authorization, 'NONE', 'authorizes nothing');
    assert(a.results.some((r) => r.report === 'review-authorization' && r.meshValid), 'RA mesh-valid');
    assert(a.results.some((r) => r.report === 'coordinator-readiness-manifest' && r.meshValid), 'CR mesh-valid');
    assert(a.results.some((r) => r.report === 'terminal-readiness-v2' && r.meshValid), 'terminal-readiness-v2 mesh-valid');
    assertEq(verifySelfDigests([a]).overall, 'ALL_VERIFIED', 'audit self-verifies');
    assert(!JSON.stringify(a).includes('/mnt/'), 'redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLOSURE_BUNDLE_BROKEN when an aggregator\'s deep children are missing (forged shallow anchors)', async () => {
  const root = workspace();
  try {
    const all = await fullBundle(root);
    // Keep RA + CR + the direct RA/CR anchors, but DROP the deep children (evidence-minimizer, regression-
    // oracle, pack-component-integrity, aggregator-digest-audit, artifact-export-manifest, negative corpus,
    // watchdog) -- so terminal-readiness-v2 / terminal-closure can no longer resolve.
    const keep = new Set(['phase-230-promotion-review-authorization', 'phase-230-promotion-coordinator-readiness-manifest', 'phase-230-promotion-terminal-readiness-v2', 'phase-230-promotion-terminal-closure-manifest', 'phase-230-promotion-commit-range-closure', 'phase-230-promotion-transcript-verification', 'phase-230-promotion-review-matrix', 'phase-230-promotion-acceptance-preflight', 'phase-230-promotion-failure-mode-matrix', 'phase-230-promotion-report-schema', 'phase-230-promotion-boundary-audit', 'phase-230-promotion-cli-ergonomics']);
    const shallow = all.filter((r) => keep.has((r as { report: string }).report));
    const a = buildClosureInputBundleAudit({ reports: shallow });
    assertEq(a.overall, 'CLOSURE_BUNDLE_BROKEN', 'shallow bundle broken');
    assert(a.blockers.includes('BUNDLE_ROOT_UNRESOLVED'), 'BUNDLE_ROOT_UNRESOLVED');
    assert(!a.results.some((r) => r.report === 'terminal-readiness-v2' && r.meshValid), 'terminal-readiness-v2 not mesh-valid');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLOSURE_BUNDLE_BROKEN + DUPLICATE_REPORT_ID on a conflicting duplicate report id', async () => {
  const root = workspace();
  try {
    const all = await fullBundle(root);
    const F = (c: string) => c.repeat(64);
    // A second review-authorization with the same id but different content/digest (a forged shadow).
    const forgedRA = seal('phase-230-review-authorization', { report: 'phase-230-promotion-review-authorization', version: 1, redactionSafe: true, authorization: 'NONE', overall: 'LOCAL_REVIEW_AUTHORIZED', evidenceValid: true, matrixValid: true, contextBound: true, reviewedCommitCount: 1, reviewedTestCount: 1, placeholders: [{ sha: 'e'.repeat(40), humanReviewed: 'PENDING', signedOff: 'PENDING', tests: [{ test: CMD, result: 'PENDING' }] }], boundDigests: { 'terminal-readiness-v2': F('1'), 'terminal-closure': F('2'), 'commit-range-closure': F('3'), 'transcript-verification': F('4'), 'review-matrix': F('5') } }, 'authorizationDigest');
    const a = buildClosureInputBundleAudit({ reports: [...all, forgedRA] });
    assertEq(a.overall, 'CLOSURE_BUNDLE_BROKEN', 'conflicting duplicate id broken');
    assert(a.blockers.includes('DUPLICATE_REPORT_ID'), 'DUPLICATE_REPORT_ID');
    assert(a.blockers.includes('BUNDLE_ROOT_UNRESOLVED'), 'the duplicated root is no longer mesh-valid');
    assert(a.results.some((r) => r.report === 'review-authorization' && r.duplicate && !r.meshValid), 'RA flagged duplicate + not mesh-valid');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLOSURE_BUNDLE_BROKEN and redaction-safe on empty input', () => {
  const a = buildClosureInputBundleAudit({ reports: [] });
  assertEq(a.overall, 'CLOSURE_BUNDLE_BROKEN', 'empty broken');
  assert(a.blockers.includes('NO_REPORTS') && a.blockers.includes('BUNDLE_ROOT_UNRESOLVED'), 'no-reports + root-unresolved');
  assert(a.redactionSafe === true && !JSON.stringify(a).includes('/mnt/'), 'redaction-safe');
});

await test('CLI runs the bundle audit and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const bundlePath = join(root, 'bundle.json'); writeFileSync(bundlePath, JSON.stringify(await fullBundle(root)));
    const outPath = join(root, 'catalog-authority-test-library', 'CIBMARKER-out', 'audit.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-closure-input-bundle-audit-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--reports', bundlePath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `VERIFIED exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'audit file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'CLOSURE_BUNDLE_VERIFIED', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('CIBMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
