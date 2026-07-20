import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApprovalRequestPacket, APPROVAL_REQUEST_HUMAN_GATES } from '../src/ops/promotion-approval-request-packet.js';
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
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 30, 8, 0, i++)); }
const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const C1 = 'b'.repeat(40); const C2 = 'c'.repeat(40);
const BASE = '1111111111111111111111111111111111111111';
const CMD = 'npm run test:phase230-local';
const RUN = 'run-2026-07-20';
const SAFE_CONFIG = { debounceMs: 500, idempotent: true, autoPromote: false, respectsLiveBoundary: true, deduplicateBy: 'content-digest' };

async function reviewAuthorization(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'approvalreq', now: makeNow() })));
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
  const terminalClosure = buildTerminalClosure({ transcriptVerification, evidenceMinimizer: buildEvidenceMinimizer([finalSummary, reviewBundle, dag]), commitRangeClosure, regressionOracle: buildRegressionOracle(projectRoot), coordinatorReadiness });
  const packComponentIntegrity = buildPackComponentIntegrity({ reviewerPack, finalSummary, releaseChecklist, mergeReadiness, chainBundle, reviewAutomation, redactionCorpus, boundaryPolicy });
  const readiness = buildTerminalReadinessV2({ terminalClosure, packComponentIntegrity, aggregatorDigestAudit: buildAggregatorDigestAudit(projectRoot), artifactExportManifest: buildArtifactExportManifest(projectRoot), negativeEvidenceCorpus: negativeCorpus, watchdogHygiene: buildWatchdogHygiene({ config: SAFE_CONFIG, queue: [{ itemDigest: 'a'.repeat(64), status: 'processed', run: RUN }], currentRun: RUN }) });
  const reviewMatrix = buildReviewMatrix({ base: BASE, head: HEAD, commits: [{ sha: C1 }, { sha: C2 }, { sha: HEAD }], requiredTests: [CMD] });
  return buildReviewAuthorization({ readiness, terminalClosure, commitRangeClosure, transcriptVerification, reviewMatrix });
}

console.log('Running Phase 230 approval request packet suite:\n');

await test('APPROVAL_REQUEST_READY lists the reviewed commit + tests + PENDING bindings; grants nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-approvalreq-'));
  try {
    const ra = await reviewAuthorization(root);
    assertEq(ra.overall, 'LOCAL_REVIEW_AUTHORIZED', 'precondition: authorized');
    const p = buildApprovalRequestPacket({ reviewAuthorization: ra });
    assertEq(p.overall, 'APPROVAL_REQUEST_READY', `ready (blockers: ${p.blockers.join(',')})`);
    assertEq(p.authorization, 'NONE', 'authorization NONE');
    assertEq(p.status, 'PENDING', 'status PENDING');
    assertEq(p.reviewedCommit, HEAD, 'exact reviewed commit');
    assert(p.requiredTests.includes(CMD), 'required tests listed');
    assertEq(p.bindings.item, 'PENDING', 'item binding PENDING');
    assertEq(p.bindings.source, 'PENDING', 'source binding PENDING');
    assertEq(p.bindings.destination, 'PENDING', 'destination binding PENDING');
    assert(p.pendingHumanGates.length === APPROVAL_REQUEST_HUMAN_GATES.length, 'human gates listed');
    assert(!JSON.stringify(p).includes('APPROVED') && !JSON.stringify(p).includes('GRANTED'), 'never claims approval');
    assertEq(verifySelfDigests([p]).overall, 'ALL_VERIFIED', 'packet self-verifies');
    assert(!JSON.stringify(p).includes('/mnt/'), 'redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED: not authoritative, or any input claiming an approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-approvalreq-'));
  try {
    const ra = await reviewAuthorization(root) as unknown as Record<string, unknown>;
    // an input that already claims an approval must be refused
    const claimed = JSON.parse(JSON.stringify(ra)) as Record<string, unknown>;
    claimed.authorization = 'APPROVED';
    const c = buildApprovalRequestPacket({ reviewAuthorization: claimed });
    assert(c.blockers.includes('APPROVAL_CLAIM_PRESENT'), 'APPROVAL_CLAIM_PRESENT');
    assertEq(c.overall, 'APPROVAL_REQUEST_BLOCKED', 'blocked on approval claim');
    // not authoritative (tampered body -> digest recompute fails)
    const tampered = JSON.parse(JSON.stringify(ra)) as Record<string, unknown>;
    tampered.injectedClaim = 'smuggled';
    assert(buildApprovalRequestPacket({ reviewAuthorization: tampered }).blockers.includes('REVIEW_AUTHORIZATION_NOT_AUTHORITATIVE'), 'not authoritative');
    // missing
    assert(buildApprovalRequestPacket({}).blockers.includes('REVIEW_AUTHORIZATION_MISSING'), 'missing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI builds the request packet and never echoes raw paths to stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-approvalreq-'));
  try {
    const ra = await reviewAuthorization(root);
    const raPath = join(root, 'ra.json'); writeFileSync(raPath, JSON.stringify(ra));
    const outPath = join(root, 'catalog-authority-test-library', 'ARMARKER-out', 'packet.json');
    mkdirSync(join(root, 'x'), { recursive: true });
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-approval-request-packet-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--reviewauthorization', raPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `READY exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'packet written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'APPROVAL_REQUEST_READY', 'stdout overall');
    assertEq(parsed.status, 'PENDING', 'stdout status PENDING');
    assert(!(res.stdout ?? '').includes('ARMARKER') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
