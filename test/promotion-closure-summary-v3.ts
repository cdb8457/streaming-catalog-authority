import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClosureSummaryV3, CLOSURE_SUMMARY_V3_HUMAN_GATES, CLOSURE_SUMMARY_V3_DISCLAIMERS } from '../src/ops/promotion-closure-summary-v3.js';
import { buildReviewAuthorization } from '../src/ops/promotion-review-authorization.js';
import { buildReviewMatrix } from '../src/ops/promotion-review-matrix.js';
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
function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-closv3-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 28, 8, 0, i++)); }
const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const C1 = 'b'.repeat(40);
const C2 = 'c'.repeat(40);
const BASE = '1111111111111111111111111111111111111111';
const CMD = 'npm run test:phase230-local';
const RUN = 'run-2026-07-18';
const SAFE_CONFIG = { debounceMs: 500, idempotent: true, autoPromote: false, respectsLiveBoundary: true, deduplicateBy: 'content-digest' };
const OBSERVED = { observed: true, source: 'local-fixture-observation', head: HEAD };
const OTHER = 'e'.repeat(40);

async function bounded(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'closv3', now: makeNow() })));
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
  // The FULL input mesh: RA/CR's anchors AND those anchors' own children, so the bundle audit fully resolves.
  const anchorReports = [readiness, terminalClosure, commitRangeClosure, transcriptVerification, reviewMatrix, acceptancePreflight, failureMatrix, reportSchema, boundaryAudit, cliErgonomics, coordinatorReadiness, evidenceMinimizer, regressionOracle, packComponentIntegrity, aggregatorDigestAudit, artifactExportManifest, negativeCorpus, watchdogHygiene];
  return { reviewAuthorization, coordinatorReadiness, anchorReports };
}

// Self-seal a body: recompute its self-digest with the correct scope so it is individually verifiable.
function seal(scope: string, body: Record<string, unknown>, field: string): Record<string, unknown> {
  return { ...body, [field]: createHash('sha256').update(`${scope}:${JSON.stringify(body)}`).digest('hex') };
}

// report id -> [self-digest scope, digest field], for building minimal self-sealed reports.
const SEAL: Record<string, [string, string]> = {
  'review-authorization': ['phase-230-review-authorization', 'authorizationDigest'],
  'coordinator-readiness-manifest': ['phase-230-coordinator-readiness', 'readinessDigest'],
  'terminal-readiness-v2': ['phase-230-terminal-readiness-v2', 'readinessV2Digest'],
  'terminal-closure-manifest': ['phase-230-terminal-closure', 'terminalDigest'],
  'commit-range-closure': ['phase-230-commit-range-closure', 'closureDigest'],
  'transcript-verification': ['phase-230-transcript-verifier', 'verificationDigest'],
  'review-matrix': ['phase-230-review-matrix', 'reviewMatrixDigest'],
  'pack-component-integrity': ['phase-230-pack-component-integrity', 'integrityDigest'],
  'aggregator-digest-audit': ['phase-230-aggregator-digest-audit', 'auditDigest'],
  'artifact-export-manifest': ['phase-230-artifact-export-manifest', 'exportDigest'],
  'negative-evidence-corpus': ['phase-230-negative-evidence-corpus', 'corpusDigest'],
  'watchdog-hygiene': ['phase-230-watchdog-hygiene', 'watchdogDigest'],
  'evidence-minimizer': ['phase-230-evidence-minimizer', 'minimizerDigest'],
  'regression-oracle': ['phase-230-regression-oracle', 'oracleDigest'],
  'acceptance-preflight': ['phase-230-acceptance-preflight', 'preflightDigest'],
  'failure-mode-matrix': ['phase-230-failure-matrix', 'failureMatrixDigest'],
  'report-schema': ['phase-230-report-schema', 'reportSchemaDigest'],
  'boundary-audit': ['phase-230-boundary-audit', 'auditDigest'],
  'cli-ergonomics': ['phase-230-cli-ergonomics', 'ergonomicsDigest'],
};
function minimal(short: string, overall: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const [scope, field] = SEAL[short]!;
  return seal(scope, { report: `phase-230-promotion-${short}`, version: 1, redactionSafe: true, authorization: 'NONE', overall, ...extra }, field);
}
const okComps = (keys: string[]) => keys.map((c) => ({ component: c, present: true, ok: true }));

// A FULLY-fabricated deep green bundle: every LEAF is minimal { report,version,redactionSafe,authorization,
// overall,<digest> } with a valid self-digest and NO authoritative content; aggregators carry consistent
// boundDigests pointing at those minimal leaves so the mesh would resolve if only green were checked.
function fabricatedDeepBundle() {
  const crc = minimal('commit-range-closure', 'RANGE_CLOSED');
  const tv = minimal('transcript-verification', 'TRANSCRIPT_VERIFIED');
  const rm = minimal('review-matrix', 'REVIEW_MATRIX_READY');
  const em = minimal('evidence-minimizer', 'MINIMIZED_CLEAN');
  const ro = minimal('regression-oracle', 'ORACLE_COMPLETE');
  const pci = minimal('pack-component-integrity', 'PACK_INTEGRITY_VERIFIED');
  const ada = minimal('aggregator-digest-audit', 'AGGREGATOR_AUDIT_CLEAN');
  const aem = minimal('artifact-export-manifest', 'ARTIFACT_EXPORT_MANIFEST_COMPLETE');
  const nec = minimal('negative-evidence-corpus', 'CORPUS_HELD');
  const wh = minimal('watchdog-hygiene', 'WATCHDOG_HYGIENE_CLEAN');
  const ap = minimal('acceptance-preflight', 'PREFLIGHT_READY');
  const fm = minimal('failure-mode-matrix', 'FAILURE_MATRIX_COMPLETE');
  const rs = minimal('report-schema', 'REPORT_SCHEMA_OK');
  const ba = minimal('boundary-audit', 'BOUNDARY_AUDIT_CLEAN');
  const ce = minimal('cli-ergonomics', 'CLI_ERGONOMICS_OK');
  const cr = minimal('coordinator-readiness-manifest', 'COORDINATOR_READINESS_CONFIRMED', { components: okComps(['acceptance-preflight', 'failure-matrix', 'report-schema', 'boundary-audit', 'cli-ergonomics']), boundDigests: { 'acceptance-preflight': ap.preflightDigest, 'failure-matrix': fm.failureMatrixDigest, 'report-schema': rs.reportSchemaDigest, 'boundary-audit': ba.auditDigest, 'cli-ergonomics': ce.ergonomicsDigest } });
  const tc = minimal('terminal-closure-manifest', 'TERMINAL_CLOSURE_CONFIRMED', { components: okComps(['transcript-verification', 'evidence-minimizer', 'commit-range-closure', 'regression-oracle', 'coordinator-readiness']), boundDigests: { 'transcript-verification': tv.verificationDigest, 'evidence-minimizer': em.minimizerDigest, 'commit-range-closure': crc.closureDigest, 'regression-oracle': ro.oracleDigest, 'coordinator-readiness': cr.readinessDigest } });
  const bt = minimal('terminal-readiness-v2', 'TERMINAL_READINESS_V2_CONFIRMED', { components: okComps(['terminal-closure', 'pack-component-integrity', 'aggregator-digest-audit', 'artifact-export-manifest', 'negative-evidence-corpus', 'watchdog-hygiene']), boundDigests: { 'terminal-closure': tc.terminalDigest, 'pack-component-integrity': pci.integrityDigest, 'aggregator-digest-audit': ada.auditDigest, 'artifact-export-manifest': aem.exportDigest, 'negative-evidence-corpus': nec.corpusDigest, 'watchdog-hygiene': wh.watchdogDigest } });
  const ra = minimal('review-authorization', 'LOCAL_REVIEW_AUTHORIZED', { evidenceValid: true, matrixValid: true, contextBound: true, reviewedCommitCount: 1, reviewedTestCount: 1, placeholders: [{ sha: 'a'.repeat(40), humanReviewed: 'PENDING', signedOff: 'PENDING', tests: [{ test: CMD, result: 'PENDING' }] }], boundDigests: { 'terminal-readiness-v2': bt.readinessV2Digest, 'terminal-closure': tc.terminalDigest, 'commit-range-closure': crc.closureDigest, 'transcript-verification': tv.verificationDigest, 'review-matrix': rm.reviewMatrixDigest } });
  return { ra, cr, anchors: [bt, tc, crc, tv, rm, em, ro, pci, ada, aem, nec, wh, ap, fm, rs, ba, ce] };
}

// Re-seal a genuine review-authorization with replaced placeholders (keeping its genuine boundDigests, so
// its digest-mesh children still resolve -- only its own placeholder content is tampered).
function resealRA(ra: Record<string, unknown>, placeholders: unknown[]): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(ra)) as Record<string, unknown>;
  clone.placeholders = placeholders;
  delete clone.authorizationDigest;
  return seal('phase-230-review-authorization', clone, 'authorizationDigest');
}
function ph(sha: string): Record<string, unknown> { return { sha, humanReviewed: 'PENDING', signedOff: 'PENDING', tests: [{ test: CMD, result: 'PENDING' }] }; }

console.log('Running Phase 230 closure summary v3 suite:\n');

await test('BLOCKED: otherwise-green mesh with invalid RA placeholder shas / mismatched ordered commit list', async () => {
  const root = workspace();
  try {
    const b = await bounded(root);

    // (1) invalid RA placeholder shas + an arbitrary/stale observed head: RA is not authoritative -> unbound.
    const genuineRA = b.reviewAuthorization as unknown as Record<string, unknown>;
    const invalidRA = resealRA(genuineRA, [ph('z'.repeat(40)), ph('z'.repeat(40)), ph('z'.repeat(40))]);
    const s1 = buildClosureSummaryV3({ reviewAuthorization: invalidRA, coordinatorReadiness: b.coordinatorReadiness, observedState: { observed: true, source: 'local', head: 'e'.repeat(40) }, anchorReports: b.anchorReports });
    assertEq(s1.overall, 'CLOSURE_SUMMARY_BLOCKED', 'invalid RA placeholder shas must block');
    assert(s1.blockers.includes('UNBOUND_TERMINAL_CONTEXT'), 'invalid placeholder shas -> UNBOUND_TERMINAL_CONTEXT');

    // (2) valid-looking but mismatched RA ordered commit list against CRC/RM/TV (reordered middle commits).
    const mismatchRA = resealRA(genuineRA, [ph(C2), ph(C1), ph(HEAD)]);
    const s2 = buildClosureSummaryV3({ reviewAuthorization: mismatchRA, coordinatorReadiness: b.coordinatorReadiness, observedState: OBSERVED, anchorReports: b.anchorReports });
    assertEq(s2.overall, 'CLOSURE_SUMMARY_BLOCKED', 'mismatched RA ordered commit list must block');
    assert(s2.blockers.includes('UNBOUND_TERMINAL_CONTEXT'), 'RA commit list != CRC/RM ordered shas -> UNBOUND_TERMINAL_CONTEXT');
    assert(!s2.blockers.includes('OBSERVED_STATE_MISSING'), 'observed state itself is well-formed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BLOCKED on a forged minimal self-sealed RA/CR even when observedState.head matches the forged RA head', () => {
  const fsha = 'a'.repeat(40);
  // A minimal review-authorization: right id, LOCAL_REVIEW_AUTHORIZED, a valid self-digest -- but none of the
  // authoritative internal structure (evidenceValid/matrixValid/contextBound, boundDigests, counts).
  const ra = seal('phase-230-review-authorization', { report: 'phase-230-promotion-review-authorization', version: 1, redactionSafe: true, authorization: 'NONE', overall: 'LOCAL_REVIEW_AUTHORIZED', placeholders: [{ sha: fsha, tests: [{ test: CMD }] }] }, 'authorizationDigest');
  const cr = seal('phase-230-coordinator-readiness', { report: 'phase-230-promotion-coordinator-readiness-manifest', version: 1, redactionSafe: true, authorization: 'NONE', overall: 'COORDINATOR_READINESS_CONFIRMED' }, 'readinessDigest');
  const s = buildClosureSummaryV3({ reviewAuthorization: ra, coordinatorReadiness: cr, observedState: { observed: true, source: 'local-forged-observation', head: fsha } });
  assertEq(s.overall, 'CLOSURE_SUMMARY_BLOCKED', 'forged minimal self-sealed RA/CR must block');
  assert(s.blockers.includes('UNBOUND_TERMINAL_CONTEXT'), 'forged RA -> UNBOUND_TERMINAL_CONTEXT');
  assert(s.blockers.includes('UNBOUND_COORDINATOR_CONTEXT'), 'forged CR -> UNBOUND_COORDINATOR_CONTEXT');
  assert(s.failureEvidence.some((c) => c.check === 'terminal-context-bound' && !c.ok), 'terminal-context-bound false');
  assert(s.failureEvidence.some((c) => c.check === 'coordinator-context-bound' && !c.ok), 'coordinator-context-bound false');
  assert(!('review-authorization' in s.boundDigests), 'forged RA digest not recorded');
});

test('BLOCKED on a fully-fabricated DEEP green bundle of minimal leaves (content shape unvalidated)', () => {
  // Distinct from the shallow "deep children absent" case: here every child IS supplied and the mesh would
  // resolve on green-only, but the minimal leaves carry no authoritative CONTENT (no base/head/results/rows/
  // commandResults/...), so shape validation fails and RA/CR are not context-bound.
  const f = fabricatedDeepBundle();
  const s = buildClosureSummaryV3({ reviewAuthorization: f.ra, coordinatorReadiness: f.cr, observedState: { observed: true, source: 'local-forged', head: 'a'.repeat(40) }, anchorReports: f.anchors });
  assertEq(s.overall, 'CLOSURE_SUMMARY_BLOCKED', 'fully-fabricated deep green minimal-leaf bundle must block');
  assert(s.blockers.includes('UNBOUND_TERMINAL_CONTEXT'), 'minimal leaves fail content shape -> UNBOUND_TERMINAL_CONTEXT');
  assert(s.blockers.includes('UNBOUND_COORDINATOR_CONTEXT'), 'minimal leaves fail content shape -> UNBOUND_COORDINATOR_CONTEXT');
  assert(!('review-authorization' in s.boundDigests), 'fabricated RA digest not recorded');
});

test('BLOCKED on a FULL-SHAPE forged self-sealed RA/CR (fabricated boundDigests, no real anchors)', () => {
  const fsha = 'a'.repeat(40);
  const F = (c: string) => c.repeat(64);
  // A FULL-SHAPE review-authorization: authoritative shape (evidenceValid/matrixValid/contextBound, counts,
  // placeholders) AND five sha256-shaped boundDigests -- but the bindings are fabricated, matching no real
  // report. It self-seals cleanly.
  const ra = seal('phase-230-review-authorization', {
    report: 'phase-230-promotion-review-authorization', version: 1, redactionSafe: true, authorization: 'NONE',
    overall: 'LOCAL_REVIEW_AUTHORIZED', evidenceValid: true, matrixValid: true, contextBound: true,
    reviewedCommitCount: 1, reviewedTestCount: 1,
    placeholders: [{ sha: fsha, humanReviewed: 'PENDING', signedOff: 'PENDING', tests: [{ test: CMD, result: 'PENDING' }] }],
    boundDigests: { 'terminal-readiness-v2': F('1'), 'terminal-closure': F('2'), 'commit-range-closure': F('3'), 'transcript-verification': F('4'), 'review-matrix': F('5') },
  }, 'authorizationDigest');
  const cr = seal('phase-230-coordinator-readiness', {
    report: 'phase-230-promotion-coordinator-readiness-manifest', version: 1, redactionSafe: true, authorization: 'NONE',
    overall: 'COORDINATOR_READINESS_CONFIRMED',
    components: ['acceptance-preflight', 'failure-matrix', 'report-schema', 'boundary-audit', 'cli-ergonomics'].map((c) => ({ component: c, present: true, ok: true })),
    boundDigests: { 'acceptance-preflight': F('6'), 'failure-matrix': F('7'), 'report-schema': F('8'), 'boundary-audit': F('9'), 'cli-ergonomics': F('b') },
  }, 'readinessDigest');
  const s = buildClosureSummaryV3({ reviewAuthorization: ra, coordinatorReadiness: cr, observedState: { observed: true, source: 'local-forged-observation', head: fsha } });
  assertEq(s.overall, 'CLOSURE_SUMMARY_BLOCKED', 'full-shape forged self-sealed RA/CR must block');
  assert(s.blockers.includes('UNBOUND_TERMINAL_CONTEXT'), 'fabricated RA bindings -> UNBOUND_TERMINAL_CONTEXT');
  assert(s.blockers.includes('UNBOUND_COORDINATOR_CONTEXT'), 'fabricated CR bindings -> UNBOUND_COORDINATOR_CONTEXT');
  assert(!('review-authorization' in s.boundDigests) && !('coordinator-readiness' in s.boundDigests), 'no forged digest recorded');
});

test('BLOCKED on forged full RA/CR + forged green self-sealed anchors whose deep children are absent', () => {
  const fsha = 'a'.repeat(40); const F = (c: string) => c.repeat(64);
  // Forged green self-sealed DIRECT anchors of RA -- but their own deep children (pack-component-integrity,
  // evidence-minimizer, ...) are NOT supplied, so the bundle mesh cannot resolve.
  const bt = seal('phase-230-terminal-readiness-v2', { report: 'phase-230-promotion-terminal-readiness-v2', version: 1, redactionSafe: true, authorization: 'NONE', overall: 'TERMINAL_READINESS_V2_CONFIRMED', boundDigests: { 'terminal-closure': F('1'), 'pack-component-integrity': F('2'), 'aggregator-digest-audit': F('3'), 'artifact-export-manifest': F('4'), 'negative-evidence-corpus': F('5'), 'watchdog-hygiene': F('6') } }, 'readinessV2Digest');
  const tc = seal('phase-230-terminal-closure', { report: 'phase-230-promotion-terminal-closure-manifest', version: 1, redactionSafe: true, authorization: 'NONE', overall: 'TERMINAL_CLOSURE_CONFIRMED', boundDigests: { 'transcript-verification': F('7'), 'evidence-minimizer': F('8'), 'commit-range-closure': F('9'), 'regression-oracle': F('c'), 'coordinator-readiness': F('d') } }, 'terminalDigest');
  const crc = seal('phase-230-commit-range-closure', { report: 'phase-230-promotion-commit-range-closure', version: 1, redactionSafe: true, authorization: 'NONE', overall: 'RANGE_CLOSED', base: BASE, head: fsha, results: [{ sha: fsha, category: 'phase-op' }] }, 'closureDigest');
  const tv = seal('phase-230-transcript-verifier', { report: 'phase-230-promotion-transcript-verification', version: 1, redactionSafe: true, authorization: 'NONE', overall: 'TRANSCRIPT_VERIFIED', head: fsha }, 'verificationDigest');
  const rm = seal('phase-230-review-matrix', { report: 'phase-230-promotion-review-matrix', version: 1, redactionSafe: true, authorization: 'NONE', overall: 'REVIEW_MATRIX_READY', base: BASE, head: fsha, rows: [{ sha: fsha, humanReviewed: 'PENDING', signedOff: 'PENDING', tests: [{ test: CMD, result: 'PENDING' }] }] }, 'reviewMatrixDigest');
  const ra = seal('phase-230-review-authorization', { report: 'phase-230-promotion-review-authorization', version: 1, redactionSafe: true, authorization: 'NONE', overall: 'LOCAL_REVIEW_AUTHORIZED', evidenceValid: true, matrixValid: true, contextBound: true, reviewedCommitCount: 1, reviewedTestCount: 1, placeholders: [{ sha: fsha, humanReviewed: 'PENDING', signedOff: 'PENDING', tests: [{ test: CMD, result: 'PENDING' }] }], boundDigests: { 'terminal-readiness-v2': bt.readinessV2Digest, 'terminal-closure': tc.terminalDigest, 'commit-range-closure': crc.closureDigest, 'transcript-verification': tv.verificationDigest, 'review-matrix': rm.reviewMatrixDigest } }, 'authorizationDigest');
  const cr = seal('phase-230-coordinator-readiness', { report: 'phase-230-promotion-coordinator-readiness-manifest', version: 1, redactionSafe: true, authorization: 'NONE', overall: 'COORDINATOR_READINESS_CONFIRMED', components: ['acceptance-preflight', 'failure-matrix', 'report-schema', 'boundary-audit', 'cli-ergonomics'].map((c) => ({ component: c, present: true, ok: true })), boundDigests: { 'acceptance-preflight': F('e'), 'failure-matrix': F('f'), 'report-schema': F('0'), 'boundary-audit': F('1'), 'cli-ergonomics': F('2') } }, 'readinessDigest');
  const s = buildClosureSummaryV3({ reviewAuthorization: ra, coordinatorReadiness: cr, observedState: { observed: true, source: 'local-forged', head: fsha }, anchorReports: [bt, tc, crc, tv, rm] });
  assertEq(s.overall, 'CLOSURE_SUMMARY_BLOCKED', 'forged green self-sealed anchors (deep children absent) must block');
  assert(s.blockers.includes('UNBOUND_TERMINAL_CONTEXT'), 'forged-anchor mesh does not resolve -> UNBOUND_TERMINAL_CONTEXT');
});

await test('BLOCKED: forged/stale top-level RA/CR shadowed by genuine same-id anchors (duplicate-id)', async () => {
  const root = workspace();
  try {
    const b = await bounded(root);
    const stale = 'e'.repeat(40); const F = (c: string) => c.repeat(64);
    // Forged FULL-SHAPE top-level RA with a stale head -- it passes shape + self-digest + green on its own,
    // but its digest differs from the genuine RA. The genuine RA is ALSO supplied as a same-id anchor.
    const forgedRA = seal('phase-230-review-authorization', { report: 'phase-230-promotion-review-authorization', version: 1, redactionSafe: true, authorization: 'NONE', overall: 'LOCAL_REVIEW_AUTHORIZED', evidenceValid: true, matrixValid: true, contextBound: true, reviewedCommitCount: 1, reviewedTestCount: 1, placeholders: [{ sha: stale, humanReviewed: 'PENDING', signedOff: 'PENDING', tests: [{ test: CMD, result: 'PENDING' }] }], boundDigests: { 'terminal-readiness-v2': F('1'), 'terminal-closure': F('2'), 'commit-range-closure': F('3'), 'transcript-verification': F('4'), 'review-matrix': F('5') } }, 'authorizationDigest');
    const forgedCR = seal('phase-230-coordinator-readiness', { report: 'phase-230-promotion-coordinator-readiness-manifest', version: 1, redactionSafe: true, authorization: 'NONE', overall: 'COORDINATOR_READINESS_CONFIRMED', components: ['acceptance-preflight', 'failure-matrix', 'report-schema', 'boundary-audit', 'cli-ergonomics'].map((c) => ({ component: c, present: true, ok: true })), boundDigests: { 'acceptance-preflight': F('6'), 'failure-matrix': F('7'), 'report-schema': F('8'), 'boundary-audit': F('9'), 'cli-ergonomics': F('a') } }, 'readinessDigest');
    // The bundle carries BOTH the forged top-level RA/CR and the genuine RA/CR (same ids) as anchors.
    const s = buildClosureSummaryV3({ reviewAuthorization: forgedRA, coordinatorReadiness: forgedCR, observedState: { observed: true, source: 'local', head: stale }, anchorReports: [...b.anchorReports, b.reviewAuthorization, b.coordinatorReadiness] });
    assertEq(s.overall, 'CLOSURE_SUMMARY_BLOCKED', 'forged top-level shadowed by genuine same-id anchor must block');
    assert(s.blockers.includes('UNBOUND_TERMINAL_CONTEXT'), 'forged RA digest not mesh-valid -> UNBOUND_TERMINAL_CONTEXT');
    assert(s.blockers.includes('UNBOUND_COORDINATOR_CONTEXT'), 'forged CR digest not mesh-valid -> UNBOUND_COORDINATOR_CONTEXT');
    assert(!('review-authorization' in s.boundDigests) && !('coordinator-readiness' in s.boundDigests), 'forged digests not recorded');
    // the stale/forged head must never be surfaced as bound commit visibility
    assert(!JSON.stringify(s.commitVisibility).includes(stale), 'forged head not surfaced');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLOSURE_SUMMARY_READY with bounded contexts + observed state; exact commit/test visibility; PENDING', async () => {
  const root = workspace();
  try {
    const b = await bounded(root);
    assertEq((b.reviewAuthorization as { overall: string }).overall, 'LOCAL_REVIEW_AUTHORIZED', 'precondition: authorized');
    const s = buildClosureSummaryV3({ ...b, observedState: OBSERVED });
    assertEq(s.overall, 'CLOSURE_SUMMARY_READY', `ready (blockers: ${s.blockers.join(',')})`);
    assertEq(s.authorization, 'NONE', 'authorization NONE');
    assertEq(s.status, 'PENDING', 'status PENDING');
    assert(s.observedStatePresent, 'observed state present');
    assertEq(s.commitVisibility.commitCount, 3, 'three reviewed commits visible');
    assertEq(s.commitVisibility.head, HEAD, 'head is the terminal commit');
    assert(s.commitVisibility.commitShas.every((x) => /^[0-9a-f]{40}$/.test(x)), 'commit shas are hex');
    assertEq(s.testVisibility.testCount, 1, 'one reviewed test visible');
    assert(s.failureEvidence.every((c) => c.ok), 'every closure check ok');
    assert(Object.keys(s.boundDigests).length === 2, 'both bounded contexts digest-bound');
    assertEq(s.humanGates.length, CLOSURE_SUMMARY_V3_HUMAN_GATES.length, 'human gates enumerated');
    assertEq(s.disclaimers.length, CLOSURE_SUMMARY_V3_DISCLAIMERS.length, 'disclaimers present');
    assertEq(verifySelfDigests([s]).overall, 'ALL_VERIFIED', 'summary self-verifies');
    assert(!JSON.stringify(s).includes('/mnt/'), 'redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED (fail closed) on a missing observed state', async () => {
  const root = workspace();
  try {
    const b = await bounded(root);
    const s = buildClosureSummaryV3({ ...b });
    assertEq(s.overall, 'CLOSURE_SUMMARY_BLOCKED', 'missing observed state blocked');
    assert(s.blockers.includes('OBSERVED_STATE_MISSING'), 'OBSERVED_STATE_MISSING');
    assert(s.failureEvidence.some((c) => c.check === 'observed-state-present' && !c.ok), 'redaction-safe failure evidence');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the observed state is not bound to the authoritative reviewed head', async () => {
  const root = workspace();
  try {
    const b = await bounded(root);
    // A well-formed observation of a DIFFERENT head must not pass (stale/unrelated observation).
    const staleHead = buildClosureSummaryV3({ ...b, observedState: { observed: true, source: 'local', head: OTHER } });
    assertEq(staleHead.overall, 'CLOSURE_SUMMARY_BLOCKED', 'stale observed head blocked');
    assert(staleHead.blockers.includes('OBSERVED_STATE_UNBOUND'), 'OBSERVED_STATE_UNBOUND on head mismatch');
    // An observation that declares no head at all cannot bind -> unbound.
    const noHead = buildClosureSummaryV3({ ...b, observedState: { observed: true, source: 'local' } });
    assert(noHead.blockers.includes('OBSERVED_STATE_UNBOUND'), 'OBSERVED_STATE_UNBOUND when no head declared');
    assert(noHead.failureEvidence.some((c) => c.check === 'observed-state-bound-to-head' && !c.ok), 'redaction-safe bound-check evidence');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED on an unbound terminal or coordinator context', async () => {
  const root = workspace();
  try {
    const b = await bounded(root);
    // review-authorization genuinely NOT_AUTHORIZED (valid self-digest) -> unbound terminal context.
    const unauth = buildReviewAuthorization({});
    const t = buildClosureSummaryV3({ reviewAuthorization: unauth, coordinatorReadiness: b.coordinatorReadiness, observedState: OBSERVED, anchorReports: b.anchorReports });
    assert(t.blockers.includes('UNBOUND_TERMINAL_CONTEXT'), 'UNBOUND_TERMINAL_CONTEXT');

    // coordinator-readiness genuinely NOT_CONFIRMED (valid self-digest) -> unbound coordinator context.
    const notConf = buildCoordinatorReadiness({});
    const c = buildClosureSummaryV3({ reviewAuthorization: b.reviewAuthorization, coordinatorReadiness: notConf, observedState: OBSERVED, anchorReports: b.anchorReports });
    assert(c.blockers.includes('UNBOUND_COORDINATOR_CONTEXT'), 'UNBOUND_COORDINATOR_CONTEXT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED on an unverified component digest', async () => {
  const root = workspace();
  try {
    const b = await bounded(root);
    const tampered = JSON.parse(JSON.stringify(b.reviewAuthorization)) as Record<string, unknown>;
    tampered.injectedClaim = 'smuggled'; // body changed, digest not resealed -> recompute fails
    const s = buildClosureSummaryV3({ reviewAuthorization: tampered, coordinatorReadiness: b.coordinatorReadiness, observedState: OBSERVED, anchorReports: b.anchorReports });
    assertEq(s.overall, 'CLOSURE_SUMMARY_BLOCKED', 'unverified digest blocked');
    assert(s.blockers.includes('COMPONENT_DIGEST_UNVERIFIED'), 'COMPONENT_DIGEST_UNVERIFIED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED on a live-boundary escape (observed-state source points at a live surface)', async () => {
  const root = workspace();
  try {
    const b = await bounded(root);
    const s = buildClosureSummaryV3({ ...b, observedState: { observed: true, source: 'jellyfin://live-refresh' } });
    assertEq(s.overall, 'CLOSURE_SUMMARY_BLOCKED', 'live escape blocked');
    assert(s.blockers.includes('LIVE_BOUNDARY_ESCAPE'), 'LIVE_BOUNDARY_ESCAPE');
    assert(s.failureEvidence.some((c) => c.check === 'live-boundary-closed' && !c.ok), 'live-boundary-closed evidence false');
    assert(!s.blockers.some((x) => x.includes('/')), 'blockers are codes, not raw');

    // A live/media indicator smuggled into a NON-source field (a deep scan, not just `source`) still fails.
    const deep = buildClosureSummaryV3({ ...b, observedState: { observed: true, source: 'local-observation', target: '/mnt/user/media/Movies/x.mkv' } });
    assert(deep.blockers.includes('LIVE_BOUNDARY_ESCAPE'), 'deep live-boundary escape caught in a non-source field');
    assert(!JSON.stringify(deep).includes('/mnt/') && !JSON.stringify(deep).includes('.mkv'), 'the raw escape value is never echoed');
    const nested = buildClosureSummaryV3({ ...b, observedState: { observed: true, source: 'local', meta: { probe: 'http://192.168.1.10/library/Refresh' } } });
    assert(nested.blockers.includes('LIVE_BOUNDARY_ESCAPE'), 'deep live-boundary escape caught in a nested field');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BLOCKED and redaction-safe on empty input (human gates + boundary still stated)', () => {
  const s = buildClosureSummaryV3({});
  assertEq(s.overall, 'CLOSURE_SUMMARY_BLOCKED', 'blocked');
  for (const code of ['UNBOUND_TERMINAL_CONTEXT', 'UNBOUND_COORDINATOR_CONTEXT', 'OBSERVED_STATE_MISSING']) {
    assert(s.blockers.includes(code), `${code}`);
  }
  assertEq(s.authorization, 'NONE', 'authorization NONE');
  assertEq(s.status, 'PENDING', 'status PENDING');
  assert(s.boundary.length > 0 && s.redactionSafe === true && !JSON.stringify(s).includes('/mnt/'), 'boundary + redaction-safe');
});

await test('CLI builds the closure summary and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const b = await bounded(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const ra = w('ra.json', b.reviewAuthorization); const cr = w('cr.json', b.coordinatorReadiness); const os = w('os.json', OBSERVED); const an = w('an.json', b.anchorReports);
    const outPath = join(root, 'catalog-authority-test-library', 'CS3MARKER-out', 'summary.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-closure-summary-v3-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--reviewauthorization', ra, '--coordinatorreadiness', cr, '--observedstate', os, '--anchors', an, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `READY exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'summary file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'CLOSURE_SUMMARY_READY', 'stdout overall');
    assertEq(parsed.status, 'PENDING', 'stdout status PENDING');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('CS3MARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
