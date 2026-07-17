import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCoordinatorReadiness, READINESS_HUMAN_GATES, READINESS_DISCLAIMERS } from '../src/ops/promotion-coordinator-readiness.js';
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
function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-readiness-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 22, 12, 0, i++)); }
const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const BASE = '1111111111111111111111111111111111111111';

async function greenInputs(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'readiness', now: makeNow() })));
  const replay = replayFixtureBundle(bundle);
  const evidence = buildCoordinatorEvidencePacket({ bundle, replay });
  const transcript = buildReviewTranscript({ reviewedCommit: HEAD, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }] });
  const ledger = buildProvenanceLedger({ bundle, replay, evidence, transcript });
  const dag = verifyGateDag();
  const archive = buildArchiveManifest({ ledger, dag, evidence, transcript });
  const reviewBundle = buildReviewBundle({ evidence, transcript, ledger, dag, archive });
  const selfDigest = verifySelfDigests([evidence, transcript, ledger, dag, archive, reviewBundle]);
  const finalSummary = buildFinalSummary({ reviewBundle, transcript });
  const negativeCorpus = buildNegativeEvidenceCorpus();
  const closureHygiene = buildClosureHygiene(projectRoot);
  const releaseChecklist = buildReleaseChecklist({ reviewBundle, transcript, finalSummary, closureHygiene, negativeCorpus, selfDigest });
  const context = { branch: 'work/phase-230', base: BASE, head: HEAD, commits: [{ sha: HEAD, subject: 'a commit' }], requiredTests: ['npm run test:phase230-local'] };
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
  return { acceptancePreflight, failureMatrix, reportSchema, boundaryAudit, cliErgonomics };
}

console.log('Running Phase 230 coordinator readiness manifest suite:\n');

await test('COORDINATOR_READINESS_CONFIRMED when every hardening input is green and digest-bound', async () => {
  const root = workspace();
  try {
    const g = await greenInputs(root);
    const r = buildCoordinatorReadiness(g);
    assertEq(r.overall, 'COORDINATOR_READINESS_CONFIRMED', `confirmed (blockers: ${r.blockers.join(',')})`);
    assertEq(r.authorization, 'NONE', 'authorizes nothing');
    assertEq(r.components.length, 5, 'five hardening components');
    assert(r.components.every((c) => c.present && c.ok), 'all components green');
    assert(Object.keys(r.boundDigests).length === 5 && Object.values(r.boundDigests).every((d) => /^[0-9a-f]{64}$/.test(d)), 'all inputs digest-bound');
    assertEq(r.humanGates.length, READINESS_HUMAN_GATES.length, 'human gates enumerated');
    assert(r.humanGates.some((h) => /Phase 231/.test(h)), 'Phase 231 stays a human, unauthorized step');
    assertEq(r.disclaimers.length, READINESS_DISCLAIMERS.length, 'disclaimers present');
    assert(r.disclaimers.some((d) => /NOT an approval/.test(d)), 'confirmed-is-not-approval disclaimer');
    assertEq(verifySelfDigests([r]).overall, 'ALL_VERIFIED', 'manifest self-verifies');
    assert(/^[0-9a-f]{64}$/.test(r.readinessDigest), 'readiness digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('NOT_CONFIRMED when an input is missing, not green, or digestless', async () => {
  const root = workspace();
  try {
    const g = await greenInputs(root);
    const { boundaryAudit, ...rest } = g;
    void boundaryAudit;
    const missing = buildCoordinatorReadiness(rest);
    assertEq(missing.overall, 'COORDINATOR_READINESS_NOT_CONFIRMED', 'missing input blocked');
    assert(missing.blockers.includes('BOUNDARY_AUDIT_MISSING'), 'boundary-audit-missing blocker');

    const failedAudit = buildCoordinatorReadiness({ ...g, boundaryAudit: { report: 'phase-230-promotion-boundary-audit', overall: 'BOUNDARY_AUDIT_FAILED', auditDigest: 'a'.repeat(64) } });
    assert(failedAudit.blockers.includes('BOUNDARY_AUDIT_FAILED'), 'failed-audit blocker');

    const stripped = JSON.parse(JSON.stringify(g.failureMatrix)) as Record<string, unknown>;
    delete stripped.failureMatrixDigest;
    const digestless = buildCoordinatorReadiness({ ...g, failureMatrix: stripped });
    assert(digestless.blockers.includes('COMPONENT_DIGEST_MISSING'), 'component-digest-missing blocker');

    // Green status (FAILURE_MATRIX_COMPLETE) + a well-formed but wrong digest: a real recompute catches the
    // tampered body -> COMPONENT_DIGEST_MISMATCH, and the forged digest is not bound.
    const tampered = JSON.parse(JSON.stringify(g.failureMatrix)) as Record<string, unknown>;
    assertEq(tampered.overall, 'FAILURE_MATRIX_COMPLETE', 'precondition: component is green');
    assert(/^[0-9a-f]{64}$/.test(String(tampered.failureMatrixDigest)), 'precondition: well-formed digest');
    tampered.injectedClaim = 'smuggled-through-a-green-status';
    const t = buildCoordinatorReadiness({ ...g, failureMatrix: tampered });
    assertEq(t.overall, 'COORDINATOR_READINESS_NOT_CONFIRMED', 'green-body tamper not confirmed');
    assert(t.blockers.includes('COMPONENT_DIGEST_MISMATCH'), 'green-body tamper -> digest mismatch');
    assert(!('failure-matrix' in t.boundDigests), 'tampered component not digest-bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('NOT_CONFIRMED and redaction-safe on empty input (human gates still enumerated)', () => {
  const r = buildCoordinatorReadiness({});
  assertEq(r.overall, 'COORDINATOR_READINESS_NOT_CONFIRMED', 'not confirmed');
  assert(r.blockers.includes('ACCEPTANCE_PREFLIGHT_MISSING') && r.blockers.includes('CLI_ERGONOMICS_MISSING'), 'missing blockers');
  assertEq(r.humanGates.length, READINESS_HUMAN_GATES.length, 'human gates still enumerated');
  assert(r.redactionSafe === true && !JSON.stringify(r).includes('/mnt/'), 'redaction-safe');
});

await test('CLI builds the manifest and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const g = await greenInputs(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const pf = w('pf.json', g.acceptancePreflight); const fm = w('fm.json', g.failureMatrix); const rs = w('rs.json', g.reportSchema);
    const ba = w('ba.json', g.boundaryAudit); const ce = w('ce.json', g.cliErgonomics);
    const outPath = join(root, 'catalog-authority-test-library', 'CRMARKER-out', 'readiness.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-coordinator-readiness-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--preflight', pf, '--failurematrix', fm, '--reportschema', rs, '--boundaryaudit', ba, '--cliergonomics', ce, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `CONFIRMED exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'readiness file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'COORDINATOR_READINESS_CONFIRMED', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('CRMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
