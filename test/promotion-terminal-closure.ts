import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTerminalClosure, TERMINAL_HUMAN_GATES, TERMINAL_DISCLAIMERS } from '../src/ops/promotion-terminal-closure.js';
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
function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-terminal-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 23, 8, 0, i++)); }
const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const BASE = '1111111111111111111111111111111111111111';
const CMD = 'npm run test:phase230-local';

async function greenInputs(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'terminal', now: makeNow() })));
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
  const context = { branch: 'work/phase-230', base: BASE, head: HEAD, commits: [{ sha: HEAD, subject: 'a commit (phase BL)' }], requiredTests: [CMD] };
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
  const evidenceMinimizer = buildEvidenceMinimizer([finalSummary, reviewBundle, dag]);
  const commitRangeClosure = buildCommitRangeClosure(context);
  const regressionOracle = buildRegressionOracle(projectRoot);
  return { transcriptVerification, evidenceMinimizer, commitRangeClosure, regressionOracle, coordinatorReadiness };
}

console.log('Running Phase 230 terminal closure manifest suite:\n');

await test('TERMINAL_CLOSURE_CONFIRMED when every local-evidence component is green and digest-bound', async () => {
  const root = workspace();
  try {
    const g = await greenInputs(root);
    const m = buildTerminalClosure(g);
    assertEq(m.overall, 'TERMINAL_CLOSURE_CONFIRMED', `confirmed (blockers: ${m.blockers.join(',')})`);
    assertEq(m.authorization, 'NONE', 'authorizes nothing');
    assertEq(m.components.length, 5, 'five closing components');
    assert(m.components.every((c) => c.present && c.ok), 'all components green');
    assert(Object.keys(m.boundDigests).length === 5 && Object.values(m.boundDigests).every((d) => /^[0-9a-f]{64}$/.test(d)), 'all inputs digest-bound');
    assertEq(m.humanGates.length, TERMINAL_HUMAN_GATES.length, 'human gates enumerated');
    assert(m.humanGates.some((h) => /Phase 231/.test(h)), 'Phase 231 stays a human, unauthorized step');
    assert(/no Phase 231|no live-promotion|no live Jellyfin/i.test(m.boundary) && /merge\/tag\/push\/master/i.test(m.boundary), 'closed live-boundary restated');
    assertEq(m.disclaimers.length, TERMINAL_DISCLAIMERS.length, 'disclaimers present');
    assertEq(verifySelfDigests([m]).overall, 'ALL_VERIFIED', 'manifest self-verifies');
    assert(/^[0-9a-f]{64}$/.test(m.terminalDigest), 'terminal digest present');
    assert(!JSON.stringify(m).includes('/mnt/'), 'redaction-safe boundary');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('NOT_CONFIRMED when a component is missing, not green, or digestless', async () => {
  const root = workspace();
  try {
    const g = await greenInputs(root);
    const { regressionOracle, ...rest } = g;
    void regressionOracle;
    const missing = buildTerminalClosure(rest);
    assertEq(missing.overall, 'TERMINAL_CLOSURE_NOT_CONFIRMED', 'missing input not confirmed');
    assert(missing.blockers.includes('REGRESSION_ORACLE_MISSING'), 'regression-oracle-missing blocker');

    const notReady = buildTerminalClosure({ ...g, commitRangeClosure: { report: 'phase-230-promotion-commit-range-closure', overall: 'RANGE_OPEN', closureDigest: 'a'.repeat(64) } });
    assert(notReady.blockers.includes('COMMIT_RANGE_NOT_CLOSED'), 'not-closed range blocker');

    const stripped = JSON.parse(JSON.stringify(g.evidenceMinimizer)) as Record<string, unknown>;
    delete stripped.minimizerDigest;
    const digestless = buildTerminalClosure({ ...g, evidenceMinimizer: stripped });
    assert(digestless.blockers.includes('COMPONENT_DIGEST_MISSING'), 'component-digest-missing blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('NOT_CONFIRMED and redaction-safe on empty input (human gates + boundary still stated)', () => {
  const m = buildTerminalClosure({});
  assertEq(m.overall, 'TERMINAL_CLOSURE_NOT_CONFIRMED', 'not confirmed');
  assert(m.blockers.includes('TRANSCRIPT_VERIFICATION_MISSING') && m.blockers.includes('COORDINATOR_READINESS_MISSING'), 'missing blockers');
  assertEq(m.humanGates.length, TERMINAL_HUMAN_GATES.length, 'human gates still enumerated');
  assert(m.boundary.length > 0, 'boundary still stated');
  assert(m.redactionSafe === true && !JSON.stringify(m).includes('/mnt/'), 'redaction-safe');
});

await test('CLI builds the terminal manifest and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const g = await greenInputs(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const tv = w('tv.json', g.transcriptVerification); const em = w('em.json', g.evidenceMinimizer); const cr = w('cr.json', g.commitRangeClosure);
    const ro = w('ro.json', g.regressionOracle); const cd = w('cd.json', g.coordinatorReadiness);
    const outPath = join(root, 'catalog-authority-test-library', 'TCMARKER-out', 'terminal.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-terminal-closure-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--transcriptverification', tv, '--evidenceminimizer', em, '--commitrangeclosure', cr, '--regressionoracle', ro, '--coordinatorreadiness', cd, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `CONFIRMED exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'terminal file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'TERMINAL_CLOSURE_CONFIRMED', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('TCMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
