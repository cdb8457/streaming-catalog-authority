import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewAuthorization, REVIEW_AUTHORIZATION_HUMAN_GATES, REVIEW_AUTHORIZATION_DISCLAIMERS } from '../src/ops/promotion-review-authorization.js';
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
function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-reviewauth-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 26, 8, 0, i++)); }
const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const BASE = '1111111111111111111111111111111111111111';
const CMD = 'npm run test:phase230-local';
const RUN = 'run-2026-07-18';
const SAFE_CONFIG = { debounceMs: 500, idempotent: true, autoPromote: false, respectsLiveBoundary: true, deduplicateBy: 'content-digest' };

async function readinessReport(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'reviewauth', now: makeNow() })));
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
  const context = { branch: 'work/phase-230', base: BASE, head: HEAD, commits: [{ sha: HEAD, subject: 'a commit (phase BU)' }], requiredTests: [CMD] };
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
  const terminalClosure = buildTerminalClosure({ transcriptVerification: buildTranscriptVerification({ transcript, head: HEAD, expectedCommands: [CMD] }), evidenceMinimizer: buildEvidenceMinimizer([finalSummary, reviewBundle, dag]), commitRangeClosure: buildCommitRangeClosure(context), regressionOracle: buildRegressionOracle(projectRoot), coordinatorReadiness });
  const packComponentIntegrity = buildPackComponentIntegrity({ reviewerPack, finalSummary, releaseChecklist, mergeReadiness, chainBundle, reviewAutomation, redactionCorpus, boundaryPolicy });
  const watchdogHygiene = buildWatchdogHygiene({ config: SAFE_CONFIG, queue: [{ itemDigest: 'a'.repeat(64), status: 'processed', run: RUN }], currentRun: RUN });
  return buildTerminalReadinessV2({ terminalClosure, packComponentIntegrity, aggregatorDigestAudit: buildAggregatorDigestAudit(projectRoot), artifactExportManifest: buildArtifactExportManifest(projectRoot), negativeEvidenceCorpus: negativeCorpus, watchdogHygiene });
}

function matrixReport() {
  return buildReviewMatrix({ base: BASE, head: HEAD, commits: [{ sha: '2'.repeat(40) }, { sha: HEAD }], requiredTests: [CMD, 'npm run typecheck'] });
}

console.log('Running Phase 230 review authorization suite:\n');

await test('LOCAL_REVIEW_AUTHORIZED only with valid readiness + matrix, and includes the exact PENDING placeholders', async () => {
  const root = workspace();
  try {
    const readiness = await readinessReport(root);
    assertEq(readiness.overall, 'TERMINAL_READINESS_V2_CONFIRMED', 'precondition: readiness confirmed');
    const a = buildReviewAuthorization({ readiness, reviewMatrix: matrixReport() });
    assertEq(a.overall, 'LOCAL_REVIEW_AUTHORIZED', `authorized (blockers: ${a.blockers.join(',')})`);
    assertEq(a.authorization, 'NONE', 'live authorization is NONE');
    assert(a.evidenceValid && a.matrixValid, 'both evidence and matrix valid');
    assertEq(a.reviewedCommitCount, 2, 'two reviewed commits');
    assertEq(a.reviewedTestCount, 2, 'two reviewed tests');
    assertEq(a.placeholders.length, 2, 'placeholders for both commits');
    assert(a.placeholders.every((r) => r.humanReviewed === 'PENDING' && r.signedOff === 'PENDING' && r.tests.every((t) => t.result === 'PENDING')), 'every included cell is PENDING');
    assert(!JSON.stringify(a).includes('APPROVED') && !JSON.stringify(a.placeholders).includes('PASS'), 'no completed outcome emitted');
    assert(Object.keys(a.boundDigests).length === 2, 'both evidence digests bound');
    assert(a.humanGates.some((h) => /Phase 231/.test(h)) && /no Phase 231|no live-promotion|no live Jellyfin/i.test(a.boundary), 'human gates + closed boundary');
    assertEq(a.disclaimers.length, REVIEW_AUTHORIZATION_DISCLAIMERS.length, 'disclaimers present');
    assertEq(verifySelfDigests([a]).overall, 'ALL_VERIFIED', 'scaffold self-verifies');
    assert(!JSON.stringify(a).includes('/mnt/'), 'redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('NOT_AUTHORIZED by default: no authorization unless valid offline evidence is supplied', () => {
  const a = buildReviewAuthorization({});
  assertEq(a.overall, 'LOCAL_REVIEW_NOT_AUTHORIZED', 'not authorized without evidence');
  assert(a.blockers.includes('READINESS_MISSING') && a.blockers.includes('REVIEW_MATRIX_MISSING'), 'missing evidence blockers');
  assert(!a.evidenceValid && !a.matrixValid, 'nothing valid');
  assertEq(a.placeholders.length, 0, 'no placeholders without a matrix');
  assertEq(a.humanGates.length, REVIEW_AUTHORIZATION_HUMAN_GATES.length, 'human gates still stated');
  assert(a.redactionSafe === true && !JSON.stringify(a).includes('/mnt/'), 'redaction-safe');
});

await test('NOT_AUTHORIZED when the readiness evidence is not CONFIRMED', async () => {
  const notConfirmed = buildTerminalReadinessV2({}); // genuinely NOT_CONFIRMED, valid self-digest
  const a = buildReviewAuthorization({ readiness: notConfirmed, reviewMatrix: matrixReport() });
  assertEq(a.overall, 'LOCAL_REVIEW_NOT_AUTHORIZED', 'not authorized on unconfirmed evidence');
  assert(a.blockers.includes('READINESS_NOT_CONFIRMED'), 'readiness-not-confirmed blocker');
  assert(!a.evidenceValid, 'evidence not valid');
});

await test('THE security case: a green readiness with a tampered body fails on digest recompute', async () => {
  const root = workspace();
  try {
    const readiness = await readinessReport(root);
    const tampered = JSON.parse(JSON.stringify(readiness)) as Record<string, unknown>;
    assertEq(tampered.overall, 'TERMINAL_READINESS_V2_CONFIRMED', 'precondition: green');
    assert(/^[0-9a-f]{64}$/.test(String(tampered.readinessV2Digest)), 'precondition: well-formed digest');
    tampered.injectedClaim = 'smuggled-through-a-green-status';
    const a = buildReviewAuthorization({ readiness: tampered, reviewMatrix: matrixReport() });
    assertEq(a.overall, 'LOCAL_REVIEW_NOT_AUTHORIZED', 'tampered evidence not authorized');
    assert(a.blockers.includes('COMPONENT_DIGEST_MISMATCH'), 'green-body tamper -> digest mismatch');
    assert(!('terminal-readiness-v2' in a.boundDigests), 'tampered evidence not bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI builds the authorization scaffold and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const readiness = await readinessReport(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const rd = w('rd.json', readiness); const rm = w('rm.json', matrixReport());
    const outPath = join(root, 'catalog-authority-test-library', 'RAUMARKER-out', 'auth.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-review-authorization-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--readiness', rd, '--reviewmatrix', rm, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `AUTHORIZED exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'scaffold file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'LOCAL_REVIEW_AUTHORIZED', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('RAUMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
