import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContextConsistencyAudit } from '../src/ops/promotion-context-consistency-audit.js';
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
import { buildCommitRangeClosure } from '../src/ops/promotion-commit-range-closure.js';
import { buildTranscriptVerification } from '../src/ops/promotion-transcript-verifier.js';
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
function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-ctxaudit-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 27, 8, 0, i++)); }
const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const C1 = 'b'.repeat(40);
const C2 = 'c'.repeat(40);
const OTHER = 'e'.repeat(40);
const BASE = '1111111111111111111111111111111111111111';
const CMD = 'npm run test:phase230-local';
const BRANCH = 'work/phase-230';

// Reseal a report after mutating its body (recomputes its self-digest with the correct scope), so a partial
// re-stitch stays individually self-digest-VALID -- the audit must catch it on the context VALUES.
function reseal(report: unknown, digestField: string, scope: string, mutate: (o: Record<string, unknown>) => void): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
  mutate(clone);
  delete clone[digestField];
  const d = createHash('sha256').update(`${scope}:${JSON.stringify(clone)}`).digest('hex');
  return { ...clone, [digestField]: d };
}

async function chain(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'ctxaudit', now: makeNow() })));
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
  const context = { branch: BRANCH, base: BASE, head: HEAD, commits: [{ sha: C1, subject: 'c1 (phase BV)' }, { sha: C2, subject: 'c2 (phase BV)' }, { sha: HEAD, subject: 'c3 (phase BV)' }], requiredTests: [CMD] };
  const mergeReadiness = buildMergeReadiness({ releaseChecklist, finalSummary, context });
  const provenanceDiff = buildProvenanceDiff({ context, transcript, finalSummary, reviewBundle });
  const gateCoverage = buildGateCoverage(projectRoot);
  const chainBundle = buildChainBundle({ finalSummary, releaseChecklist, mergeReadiness, negativeCorpus, provenanceDiff, gateCoverage });
  const redactionCorpus = buildRedactionCorpus();
  const boundaryPolicy = buildBoundaryPolicy(projectRoot);
  const reviewAutomation = buildReviewAutomation({ chainBundle, redactionCorpus, boundaryPolicy });
  const reviewerPack = buildReviewerPack({ finalSummary, releaseChecklist, mergeReadiness, chainBundle, reviewAutomation, redactionCorpus, boundaryPolicy });
  const acceptancePreflight = buildAcceptancePreflight({ reviewerPack, context });
  const commitRangeClosure = buildCommitRangeClosure(context);
  const transcriptVerification = buildTranscriptVerification({ transcript, head: HEAD, expectedCommands: [CMD] });
  const reviewMatrix = buildReviewMatrix({ base: BASE, head: HEAD, commits: [{ sha: C1 }, { sha: C2 }, { sha: HEAD }], requiredTests: [CMD] });
  return { mergeReadiness, reviewerPack, acceptancePreflight, commitRangeClosure, transcriptVerification, reviewTranscript: transcript, finalSummary, provenanceDiff, reviewMatrix };
}
function allReports(c: Record<string, unknown>): unknown[] {
  return [c.mergeReadiness, c.reviewerPack, c.acceptancePreflight, c.commitRangeClosure, c.transcriptVerification, c.reviewTranscript, c.finalSummary, c.provenanceDiff, c.reviewMatrix];
}

console.log('Running Phase 230 context-consistency audit suite:\n');

await test('CONTEXT_CONSISTENT when every context-bearing component agrees on the shared context', async () => {
  const root = workspace();
  try {
    const c = await chain(root);
    const a = buildContextConsistencyAudit({ reports: allReports(c) });
    assertEq(a.overall, 'CONTEXT_CONSISTENT', `consistent (blockers: ${a.blockers.join(',')})`);
    assertEq(a.authorization, 'NONE', 'authorizes nothing');
    assertEq(a.componentCount, 9, 'all nine context components verified');
    assert(a.components.every((x) => x.verified), 'every component self-verifies');
    assert(a.fieldConsistency.every((f) => f.consistent), 'every context field consistent');
    assertEq(a.reconciled.head, HEAD, 'reconciled head');
    assertEq(a.reconciled.base, BASE, 'reconciled base');
    assertEq(a.reconciled.branch, BRANCH, 'reconciled branch');
    assertEq(verifySelfDigests([a]).overall, 'ALL_VERIFIED', 'audit self-verifies');
    assert(!JSON.stringify(a).includes('/mnt/'), 'redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a freshly-resealed final-summary reviewing a different head fails closed', async () => {
  const root = workspace();
  try {
    const c = await chain(root);
    // final-summary is resealed to reviewedCommit OTHER: individually self-digest VALID, but its head now
    // disagrees with the rest of the (genuine) chain -> CONTEXT_HEAD_INCONSISTENT.
    const staleSummary = reseal(c.finalSummary, 'summaryDigest', 'phase-230-final-summary', (o) => { o.reviewedCommit = OTHER; });
    assertEq(verifySelfDigests([staleSummary]).overall, 'ALL_VERIFIED', 'resealed summary is individually valid');
    const a = buildContextConsistencyAudit({ reports: [...allReports(c).filter((r) => r !== c.finalSummary), staleSummary] });
    assertEq(a.overall, 'CONTEXT_INCONSISTENT', 'head disagreement not consistent');
    assert(a.blockers.includes('CONTEXT_HEAD_INCONSISTENT'), 'CONTEXT_HEAD_INCONSISTENT');
    assert(!a.blockers.includes('COMPONENT_UNVERIFIED'), 'the resealed component still self-verifies');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a resealed pack with altered tests, and a resealed matrix with altered commits, both fail closed', async () => {
  const root = workspace();
  try {
    const c = await chain(root);
    const altTests = reseal(c.reviewerPack, 'packDigest', 'phase-230-reviewer-pack', (o) => {
      (o.provenance as Record<string, unknown>).requiredTests = ['npm run something-stale'];
    });
    const aTests = buildContextConsistencyAudit({ reports: [...allReports(c).filter((r) => r !== c.reviewerPack), altTests] });
    assert(aTests.blockers.includes('CONTEXT_TESTS_INCONSISTENT'), 'CONTEXT_TESTS_INCONSISTENT');

    const altCommits = reseal(c.reviewMatrix, 'reviewMatrixDigest', 'phase-230-review-matrix', (o) => {
      const rows = o.rows as Array<Record<string, unknown>>;
      rows[0]!.sha = OTHER;
    });
    const aCommits = buildContextConsistencyAudit({ reports: [...allReports(c).filter((r) => r !== c.reviewMatrix), altCommits] });
    assert(aCommits.blockers.includes('CONTEXT_COMMITS_INCONSISTENT'), 'CONTEXT_COMMITS_INCONSISTENT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a consistent head that is NOT the terminal of the consistent commit list fails closed', async () => {
  const root = workspace();
  try {
    const c = await chain(root);
    // Reseal commit-range-closure so its ordered commits end in OTHER while it (and everything else) still
    // reports head HEAD: head stays consistent, the commit list stays internally consistent, but HEAD is no
    // longer the terminal commit -> CONTEXT_HEAD_NOT_TERMINAL. (transcript-verification supplies head HEAD.)
    const skewed = reseal(c.commitRangeClosure, 'closureDigest', 'phase-230-commit-range-closure', (o) => {
      const results = o.results as Array<Record<string, unknown>>;
      results[results.length - 1]!.sha = OTHER; // head stays HEAD, terminal commit becomes OTHER
    });
    assertEq(verifySelfDigests([skewed]).overall, 'ALL_VERIFIED', 'resealed range is individually valid');
    const a = buildContextConsistencyAudit({ reports: [skewed, c.transcriptVerification] });
    assertEq(a.overall, 'CONTEXT_INCONSISTENT', 'head-not-terminal fails closed');
    assert(a.blockers.includes('CONTEXT_HEAD_NOT_TERMINAL'), 'CONTEXT_HEAD_NOT_TERMINAL');
    assert(!a.blockers.includes('CONTEXT_HEAD_INCONSISTENT') && !a.blockers.includes('CONTEXT_COMMITS_INCONSISTENT'), 'head + commits each internally consistent');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('a supplied context report that does NOT recompute fails closed as unverified', async () => {
  const root = workspace();
  try {
    const c = await chain(root);
    const tampered = JSON.parse(JSON.stringify(c.commitRangeClosure)) as Record<string, unknown>;
    tampered.injectedClaim = 'smuggled'; // body changed, digest NOT resealed -> recompute fails
    const a = buildContextConsistencyAudit({ reports: [...allReports(c).filter((r) => r !== c.commitRangeClosure), tampered] });
    assertEq(a.overall, 'CONTEXT_INCONSISTENT', 'unverified component fails closed');
    assert(a.blockers.includes('COMPONENT_UNVERIFIED'), 'COMPONENT_UNVERIFIED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('INCONSISTENT and fails closed on fewer than two context components (no vacuous pass)', () => {
  const a = buildContextConsistencyAudit({ reports: [] });
  assertEq(a.overall, 'CONTEXT_INCONSISTENT', 'no components fails closed');
  assert(a.blockers.includes('INSUFFICIENT_CONTEXT_COMPONENTS'), 'INSUFFICIENT_CONTEXT_COMPONENTS');
  assert(a.redactionSafe === true && !JSON.stringify(a).includes('/mnt/'), 'redaction-safe');
});

await test('CLI runs the audit and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const c = await chain(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const bundlePath = join(dir, 'bundle.json'); writeFileSync(bundlePath, JSON.stringify(allReports(c)));
    const outPath = join(root, 'catalog-authority-test-library', 'CCAMARKER-out', 'audit.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-context-consistency-audit-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--reports', bundlePath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `CONSISTENT exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'audit file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'CONTEXT_CONSISTENT', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('CCAMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
