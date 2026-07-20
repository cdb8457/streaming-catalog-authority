// Shared, local-only test evidence-chain helper for the Phase 230 launch-proofing suites. It assembles a
// genuine review-authorization + closure-summary-v3 + closure-input-bundle-audit from the full bounded
// builder chain (the same chain the approval-request-packet and review-checklist-v2 suites build inline),
// so the launch-proofing suites can build genuine approval-request / preflight / no-live / checklist inputs
// without duplicating ~40 builders in every file. It is TEST-ONLY: not a suite, not wired into the gate; it
// performs no promotion, never touches the real Movies root, and never contacts Jellyfin.

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
import { buildClosureSummaryV3 } from '../src/ops/promotion-closure-summary-v3.js';
import { buildClosureInputBundleAudit } from '../src/ops/promotion-closure-input-bundle-audit.js';

export const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
export const CMD = 'npm run test:phase230-local';
const C1 = 'b'.repeat(40); const C2 = 'c'.repeat(40);
const BASE = '1111111111111111111111111111111111111111';
const RUN = 'run-2026-07-20';
const SAFE_CONFIG = { debounceMs: 500, idempotent: true, autoPromote: false, respectsLiveBoundary: true, deduplicateBy: 'content-digest' };
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 31, 8, 0, i++)); }

export interface LaunchProofingEvidence {
  readonly reviewAuthorization: ReturnType<typeof buildReviewAuthorization>;
  readonly closureSummary: ReturnType<typeof buildClosureSummaryV3>;
  readonly bundleAudit: ReturnType<typeof buildClosureInputBundleAudit>;
}

// Build the full local evidence chain rooted at a fixture bundle in `root`, using `projectRoot` for the
// file-reading meta-ops. Returns the three authoritative artifacts the launch-proofing inputs derive from.
export async function buildLaunchProofingEvidence(root: string, projectRoot: string): Promise<LaunchProofingEvidence> {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'launchproof', now: makeNow() })));
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
  const anchors = [readiness, terminalClosure, commitRangeClosure, transcriptVerification, reviewMatrix, acceptancePreflight, failureMatrix, reportSchema, boundaryAudit, cliErgonomics, coordinatorReadiness, evidenceMinimizer, regressionOracle, packComponentIntegrity, aggregatorDigestAudit, artifactExportManifest, negativeCorpus, watchdogHygiene];
  const closureSummary = buildClosureSummaryV3({ reviewAuthorization, coordinatorReadiness, observedState: { observed: true, source: 'local-observation', head: HEAD }, anchorReports: anchors });
  const bundleAudit = buildClosureInputBundleAudit({ reports: [reviewAuthorization, coordinatorReadiness, ...anchors] });
  return { reviewAuthorization, closureSummary, bundleAudit };
}

// A well-formed local live-preflight plan fixture (data only) whose bindings are all PENDING and which
// carries only digests + policy flags -- no raw path, no live surface.
export function samplePreflightPlan(): Record<string, unknown> {
  return {
    noClobber: true,
    sameChecksum: true,
    observedStateRequired: true,
    rollback: { strategy: 'restore-prior-digest' },
    withdrawal: { strategy: 'remove-added-only' },
    items: [
      { approvalId: 'item-1', approvalStatus: 'PENDING', sourceDigest: 'a'.repeat(64), destinationDigest: 'b'.repeat(64) },
      { approvalId: 'item-2', approvalStatus: 'PENDING', sourceDigest: 'c'.repeat(64), destinationDigest: 'd'.repeat(64) },
    ],
  };
}

// A set of genuinely-clean local artifacts (report id + PENDING/NONE) for the no-live guard.
export function sampleCleanArtifacts(): Array<Record<string, unknown>> {
  return [
    { report: 'phase-230-promotion-closure-summary-v3', version: 1, redactionSafe: true, authorization: 'NONE', status: 'PENDING', overall: 'CLOSURE_SUMMARY_READY' },
    { report: 'phase-230-promotion-review-authorization', version: 1, redactionSafe: true, authorization: 'NONE', status: 'PENDING', overall: 'LOCAL_REVIEW_AUTHORIZED' },
  ];
}
