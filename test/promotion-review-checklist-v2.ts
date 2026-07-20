import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewChecklistV2, REVIEW_CHECKLIST_V2_HUMAN_STEPS } from '../src/ops/promotion-review-checklist-v2.js';
import { buildClosureSummaryV3 } from '../src/ops/promotion-closure-summary-v3.js';
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
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 31, 8, 0, i++)); }
const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const C1 = 'b'.repeat(40); const C2 = 'c'.repeat(40);
const BASE = '1111111111111111111111111111111111111111';
const CMD = 'npm run test:phase230-local';
const RUN = 'run-2026-07-20';
const SAFE_CONFIG = { debounceMs: 500, idempotent: true, autoPromote: false, respectsLiveBoundary: true, deduplicateBy: 'content-digest' };

async function evidence(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'checkv2', now: makeNow() })));
  const replay = replayFixtureBundle(bundle);
  const evidencePacket = buildCoordinatorEvidencePacket({ bundle, replay });
  const transcript = buildReviewTranscript({ reviewedCommit: HEAD, testResults: [{ command: CMD, passed: 5, failed: 0 }] });
  const ledger = buildProvenanceLedger({ bundle, replay, evidence: evidencePacket, transcript });
  const dag = verifyGateDag();
  const archive = buildArchiveManifest({ ledger, dag, evidence: evidencePacket, transcript });
  const reviewBundle = buildReviewBundle({ evidence: evidencePacket, transcript, ledger, dag, archive });
  const selfDigest = verifySelfDigests([evidencePacket, transcript, ledger, dag, archive, reviewBundle]);
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
  const anchors = [readiness, terminalClosure, commitRangeClosure, transcriptVerification, reviewMatrix, acceptancePreflight, failureMatrix, reportSchema, boundaryAudit, cliErgonomics, coordinatorReadiness, evidenceMinimizer, regressionOracle, packComponentIntegrity, aggregatorDigestAudit, artifactExportManifest, negativeCorpus, watchdogHygiene];
  const closureSummary = buildClosureSummaryV3({ reviewAuthorization, coordinatorReadiness, observedState: { observed: true, source: 'local-observation', head: HEAD }, anchorReports: anchors });
  const bundleAudit = buildClosureInputBundleAudit({ reports: [reviewAuthorization, coordinatorReadiness, ...anchors] });
  return { closureSummary, bundleAudit };
}

console.log('Running Phase 230 coordinator review checklist v2 suite:\n');

await test('CHECKLIST_READY aggregates closure summary, bundle audit, live-boundary + test labels; PENDING/NONE', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-checkv2-'));
  try {
    const e = await evidence(root);
    assertEq(e.closureSummary.overall, 'CLOSURE_SUMMARY_READY', 'precondition: closure summary ready');
    assertEq(e.bundleAudit.overall, 'CLOSURE_BUNDLE_VERIFIED', 'precondition: bundle audit verified');
    const c = buildReviewChecklistV2(projectRoot, { closureSummary: e.closureSummary, bundleAudit: e.bundleAudit });
    assertEq(c.overall, 'CHECKLIST_READY', `ready (blockers: ${c.blockers.join(',')})`);
    assertEq(c.authorization, 'NONE', 'authorization NONE');
    assertEq(c.status, 'PENDING', 'status PENDING');
    assert(c.closureSummaryReady && c.bundleAuditVerified && c.liveBoundaryInLocalSuite, 'machine checks green');
    assert(c.localTestCommands.includes('promotion-live-boundary-guard') && c.localTestCommands.length > 10, 'test command labels listed');
    assert(c.humanSteps.length === REVIEW_CHECKLIST_V2_HUMAN_STEPS.length, 'human steps enumerated');
    assert(c.machineChecks.every((m) => m.ok), 'every machine check ok');
    assertEq(verifySelfDigests([c]).overall, 'ALL_VERIFIED', 'checklist self-verifies');
    assert(!JSON.stringify(c).includes('/mnt/'), 'redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CHECKLIST_BLOCKED when closure summary or bundle audit is missing / not green', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-checkv2-'));
  try {
    const e = await evidence(root);
    assert(buildReviewChecklistV2(projectRoot, { bundleAudit: e.bundleAudit }).blockers.includes('CLOSURE_SUMMARY_MISSING'), 'CLOSURE_SUMMARY_MISSING');
    assert(buildReviewChecklistV2(projectRoot, { closureSummary: e.closureSummary }).blockers.includes('BUNDLE_AUDIT_MISSING'), 'BUNDLE_AUDIT_MISSING');
    const notReady = buildReviewChecklistV2(projectRoot, { closureSummary: { report: 'phase-230-promotion-closure-summary-v3', overall: 'CLOSURE_SUMMARY_BLOCKED', summaryV3Digest: 'a'.repeat(64) }, bundleAudit: e.bundleAudit });
    assert(notReady.blockers.includes('COMPONENT_DIGEST_UNVERIFIED') || notReady.blockers.includes('CLOSURE_SUMMARY_NOT_READY'), 'not-ready closure summary blocked');
    assertEq(notReady.overall, 'CHECKLIST_BLOCKED', 'blocked');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI builds the checklist and never echoes raw paths to stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-checkv2-'));
  try {
    const e = await evidence(root);
    const cs = join(root, 'cs.json'); writeFileSync(cs, JSON.stringify(e.closureSummary));
    const ba = join(root, 'ba.json'); writeFileSync(ba, JSON.stringify(e.bundleAudit));
    const outPath = join(root, 'catalog-authority-test-library', 'CKMARKER-out', 'checklist.json');
    mkdirSync(join(root, 'x'), { recursive: true });
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-review-checklist-v2-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--closuresummary', cs, '--bundleaudit', ba, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `READY exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'checklist written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'CHECKLIST_READY', 'stdout overall');
    assert(!(res.stdout ?? '').includes('CKMARKER') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
