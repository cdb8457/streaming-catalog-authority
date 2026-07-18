import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTerminalReadinessV2, READINESS_V2_HUMAN_GATES, READINESS_V2_DISCLAIMERS } from '../src/ops/promotion-terminal-readiness-v2.js';
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
function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-readinessv2-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 25, 8, 0, i++)); }
const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const BASE = '1111111111111111111111111111111111111111';
const CMD = 'npm run test:phase230-local';
const RUN = 'run-2026-07-17';
const SAFE_CONFIG = { debounceMs: 500, idempotent: true, autoPromote: false, respectsLiveBoundary: true, deduplicateBy: 'content-digest' };

async function greenChain(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'readinessv2', now: makeNow() })));
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
  const context = { branch: 'work/phase-230', base: BASE, head: HEAD, commits: [{ sha: HEAD, subject: 'a commit (phase BT)' }], requiredTests: [CMD] };
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

  const terminalClosure = buildTerminalClosure({ transcriptVerification, evidenceMinimizer, commitRangeClosure, regressionOracle, coordinatorReadiness });
  const packComponentIntegrity = buildPackComponentIntegrity({ reviewerPack, finalSummary, releaseChecklist, mergeReadiness, chainBundle, reviewAutomation, redactionCorpus, boundaryPolicy });
  const aggregatorDigestAudit = buildAggregatorDigestAudit(projectRoot);
  const artifactExportManifest = buildArtifactExportManifest(projectRoot);
  const watchdogHygiene = buildWatchdogHygiene({ config: SAFE_CONFIG, queue: [{ itemDigest: 'a'.repeat(64), status: 'processed', run: RUN }], currentRun: RUN });
  return { terminalClosure, packComponentIntegrity, aggregatorDigestAudit, artifactExportManifest, negativeEvidenceCorpus: negativeCorpus, watchdogHygiene };
}

console.log('Running Phase 230 terminal readiness v2 suite:\n');

await test('TERMINAL_READINESS_V2_CONFIRMED when the full final evidence set is green and digest-bound', async () => {
  const root = workspace();
  try {
    const g = await greenChain(root);
    const m = buildTerminalReadinessV2(g);
    assertEq(m.overall, 'TERMINAL_READINESS_V2_CONFIRMED', `confirmed (blockers: ${m.blockers.join(',')})`);
    assertEq(m.authorization, 'NONE', 'authorizes nothing');
    assertEq(m.components.length, 6, 'six final components');
    assert(m.components.every((c) => c.present && c.ok), 'all components green + digest-bound');
    assert(Object.keys(m.boundDigests).length === 6 && Object.values(m.boundDigests).every((d) => /^[0-9a-f]{64}$/.test(d)), 'all six digest-bound');
    assertEq(m.humanGates.length, READINESS_V2_HUMAN_GATES.length, 'human gates enumerated');
    assert(m.humanGates.some((h) => /Phase 231/.test(h)), 'Phase 231 stays a human, unauthorized step');
    assert(/no Phase 231|no live-promotion|no live Jellyfin/i.test(m.boundary) && /merge\/tag\/push\/master/i.test(m.boundary), 'closed live-boundary restated');
    assertEq(m.disclaimers.length, READINESS_V2_DISCLAIMERS.length, 'disclaimers present');
    assertEq(verifySelfDigests([m]).overall, 'ALL_VERIFIED', 'manifest self-verifies');
    assert(!JSON.stringify(m).includes('/mnt/'), 'redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('NOT_CONFIRMED when a component is missing or not green', async () => {
  const root = workspace();
  try {
    const g = await greenChain(root);
    const { watchdogHygiene, ...rest } = g;
    void watchdogHygiene;
    const missing = buildTerminalReadinessV2(rest);
    assertEq(missing.overall, 'TERMINAL_READINESS_V2_NOT_CONFIRMED', 'missing input not confirmed');
    assert(missing.blockers.includes('WATCHDOG_HYGIENE_MISSING'), 'watchdog-hygiene-missing blocker');

    const violatedWatchdog = buildWatchdogHygiene({}); // genuinely VIOLATED, valid self-digest
    const notGreen = buildTerminalReadinessV2({ ...g, watchdogHygiene: violatedWatchdog });
    assert(notGreen.blockers.includes('WATCHDOG_HYGIENE_VIOLATED'), 'not-green watchdog blocker');

    // A self-digested watchdog report built from a config that smuggles a dangerous directive is VIOLATED
    // (not CLEAN), so readiness v2 recomputes its valid digest, sees it is not green, and refuses to confirm.
    const dangerousWatchdog = buildWatchdogHygiene({ config: { debounceMs: 500, idempotent: true, autoPromote: false, respectsLiveBoundary: true, deduplicateBy: 'content-digest', autoPromoteOverride: true }, queue: [{ itemDigest: 'a'.repeat(64), status: 'queued', run: RUN }], currentRun: RUN });
    assertEq((dangerousWatchdog as { overall: string }).overall, 'WATCHDOG_HYGIENE_VIOLATED', 'dangerous config -> violated watchdog');
    const dangerous = buildTerminalReadinessV2({ ...g, watchdogHygiene: dangerousWatchdog });
    assertEq(dangerous.overall, 'TERMINAL_READINESS_V2_NOT_CONFIRMED', 'dangerous-config watchdog is not confirmed');
    assert(dangerous.blockers.includes('WATCHDOG_HYGIENE_VIOLATED'), 'dangerous-config watchdog rejected');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('THE security case: a green component with a tampered body fails on digest recompute', async () => {
  const root = workspace();
  try {
    const g = await greenChain(root);
    const tampered = JSON.parse(JSON.stringify(g.terminalClosure)) as Record<string, unknown>;
    assertEq(tampered.overall, 'TERMINAL_CLOSURE_CONFIRMED', 'precondition: component is green');
    assert(/^[0-9a-f]{64}$/.test(String(tampered.terminalDigest)), 'precondition: well-formed digest');
    tampered.injectedClaim = 'smuggled-through-a-green-status';
    const m = buildTerminalReadinessV2({ ...g, terminalClosure: tampered });
    assertEq(m.overall, 'TERMINAL_READINESS_V2_NOT_CONFIRMED', 'tampered component not confirmed');
    assert(m.blockers.includes('COMPONENT_DIGEST_MISMATCH'), 'green-body tamper -> digest mismatch');
    assert(!('terminal-closure' in m.boundDigests), 'tampered component not digest-bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('NOT_CONFIRMED and redaction-safe on empty input (human gates + boundary still stated)', () => {
  const m = buildTerminalReadinessV2({});
  assertEq(m.overall, 'TERMINAL_READINESS_V2_NOT_CONFIRMED', 'not confirmed');
  assert(m.blockers.includes('TERMINAL_CLOSURE_MISSING') && m.blockers.includes('WATCHDOG_HYGIENE_MISSING'), 'missing blockers');
  assertEq(m.humanGates.length, READINESS_V2_HUMAN_GATES.length, 'human gates still enumerated');
  assert(m.boundary.length > 0 && m.redactionSafe === true && !JSON.stringify(m).includes('/mnt/'), 'boundary stated + redaction-safe');
});

await test('CLI builds the readiness v2 manifest and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const g = await greenChain(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const tc = w('tc.json', g.terminalClosure); const pci = w('pci.json', g.packComponentIntegrity); const ada = w('ada.json', g.aggregatorDigestAudit);
    const aem = w('aem.json', g.artifactExportManifest); const nec = w('nec.json', g.negativeEvidenceCorpus); const wh = w('wh.json', g.watchdogHygiene);
    const outPath = join(root, 'catalog-authority-test-library', 'RV2MARKER-out', 'readiness.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-terminal-readiness-v2-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--terminalclosure', tc, '--packcomponentintegrity', pci, '--aggregatordigestaudit', ada, '--artifactexportmanifest', aem, '--negativeevidencecorpus', nec, '--watchdoghygiene', wh, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `CONFIRMED exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'readiness file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'TERMINAL_READINESS_V2_CONFIRMED', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('RV2MARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
