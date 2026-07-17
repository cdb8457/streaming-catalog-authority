import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewAutomation, MANUAL_REVIEW_STEPS, AUTOMATION_DISCLAIMERS } from '../src/ops/promotion-review-automation.js';
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
function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-automation-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 20, 8, 0, i++)); }
const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const BASE = '1111111111111111111111111111111111111111';

async function greenInputs(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'automation', now: makeNow() })));
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
  return { chainBundle, redactionCorpus, boundaryPolicy };
}

console.log('Running Phase 230 coordinator review automation suite:\n');

await test('REVIEW_AUTOMATION_PASSED when chain bundle, redaction corpus, and boundary policy are green', async () => {
  const root = workspace();
  try {
    const g = await greenInputs(root);
    const a = buildReviewAutomation(g);
    assertEq(a.overall, 'REVIEW_AUTOMATION_PASSED', `passed (blockers: ${a.blockers.join(',')})`);
    assertEq(a.authorization, 'NONE', 'authorizes nothing');
    assert(a.automatedChecks.length === 3 && a.automatedChecks.every((c) => c.present && c.pass), 'all automated checks pass');
    assert(Object.keys(a.boundDigests).length === 3 && Object.values(a.boundDigests).every((d) => /^[0-9a-f]{64}$/.test(d)), 'all inputs digest-bound');
    assertEq(a.manualSteps.length, MANUAL_REVIEW_STEPS.length, 'manual steps enumerated');
    assert(a.manualSteps.some((s) => /Phase 231/.test(s)), 'Phase 231 stays a human, unauthorized step');
    assertEq(a.disclaimers.length, AUTOMATION_DISCLAIMERS.length, 'disclaimers present');
    assertEq(verifySelfDigests([a]).overall, 'ALL_VERIFIED', 'report self-verifies');
    assert(/^[0-9a-f]{64}$/.test(a.automationDigest), 'automation digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when a required input is missing or not green', async () => {
  const root = workspace();
  try {
    const { redactionCorpus, boundaryPolicy } = await greenInputs(root);
    const missing = buildReviewAutomation({ redactionCorpus, boundaryPolicy });
    assertEq(missing.overall, 'REVIEW_AUTOMATION_BLOCKED', 'missing chain bundle blocked');
    assert(missing.blockers.includes('CHAIN_BUNDLE_MISSING'), 'chain-bundle-missing blocker');

    const notReady = buildReviewAutomation({
      chainBundle: { report: 'phase-230-promotion-artifact-chain-bundle', overall: 'CHAIN_BUNDLE_BLOCKED', chainDigest: 'a'.repeat(64) },
      redactionCorpus, boundaryPolicy,
    });
    assert(notReady.blockers.includes('CHAIN_BUNDLE_NOT_READY'), 'chain-bundle-not-ready blocker');

    const violated = buildReviewAutomation({
      chainBundle: { report: 'phase-230-promotion-artifact-chain-bundle', overall: 'CHAIN_BUNDLE_READY', chainDigest: 'a'.repeat(64) },
      redactionCorpus,
      boundaryPolicy: { report: 'phase-230-promotion-boundary-policy', overall: 'BOUNDARY_POLICY_VIOLATED', policyDigest: 'b'.repeat(64) },
    });
    assert(violated.blockers.includes('BOUNDARY_POLICY_VIOLATED'), 'boundary-policy-violated blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when an input carries no/malformed binding digest', async () => {
  const root = workspace();
  try {
    const g = await greenInputs(root);
    const stripped = JSON.parse(JSON.stringify(g.redactionCorpus)) as Record<string, unknown>;
    delete stripped.redactionDigest;
    const a = buildReviewAutomation({ ...g, redactionCorpus: stripped });
    assertEq(a.overall, 'REVIEW_AUTOMATION_BLOCKED', 'blocked');
    assert(a.blockers.includes('COMPONENT_DIGEST_MISSING'), 'component-digest-missing blocker');

    // Green status (REDACTION_CORPUS_HELD) + a well-formed but wrong digest: only a real recompute catches
    // the tampered body -> COMPONENT_DIGEST_MISMATCH, and the forged digest is not bound.
    const tampered = JSON.parse(JSON.stringify(g.redactionCorpus)) as Record<string, unknown>;
    assertEq(tampered.overall, 'REDACTION_CORPUS_HELD', 'precondition: component is green');
    assert(/^[0-9a-f]{64}$/.test(String(tampered.redactionDigest)), 'precondition: well-formed digest');
    tampered.injectedClaim = 'smuggled-through-a-green-status';
    const t = buildReviewAutomation({ ...g, redactionCorpus: tampered });
    assertEq(t.overall, 'REVIEW_AUTOMATION_BLOCKED', 'green-body tamper blocked');
    assert(t.blockers.includes('COMPONENT_DIGEST_MISMATCH'), 'green-body tamper -> digest mismatch');
    assert(!('redaction-corpus' in t.boundDigests), 'tampered component not digest-bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BLOCKED and redaction-safe on empty input (manual steps still enumerated)', () => {
  const a = buildReviewAutomation({});
  assertEq(a.overall, 'REVIEW_AUTOMATION_BLOCKED', 'blocked');
  assert(a.blockers.includes('CHAIN_BUNDLE_MISSING') && a.blockers.includes('BOUNDARY_POLICY_MISSING'), 'missing blockers');
  assertEq(a.manualSteps.length, MANUAL_REVIEW_STEPS.length, 'manual steps still enumerated');
  assert(a.redactionSafe === true && !JSON.stringify(a).includes('/mnt/'), 'redaction-safe');
});

await test('CLI builds the checklist and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const g = await greenInputs(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const cb = w('cb.json', g.chainBundle); const rc = w('rc.json', g.redactionCorpus); const bp = w('bp.json', g.boundaryPolicy);
    const outPath = join(root, 'catalog-authority-test-library', 'RAMARKER-out', 'automation.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-review-automation-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--chainbundle', cb, '--redactioncorpus', rc, '--boundarypolicy', bp, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `PASSED exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'automation file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'REVIEW_AUTOMATION_PASSED', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('RAMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
