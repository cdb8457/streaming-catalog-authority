import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewerPack, REVIEWER_PACK_DISCLAIMERS, EXPECTED_PACK_COMPONENTS, EXPECTED_PACK_BINDINGS } from '../src/ops/promotion-reviewer-pack.js';
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
function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-revpack-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 21, 8, 0, i++)); }
const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const BASE = '1111111111111111111111111111111111111111';

async function greenInputs(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'revpack', now: makeNow() })));
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
  return { finalSummary, releaseChecklist, mergeReadiness, chainBundle, reviewAutomation, redactionCorpus, boundaryPolicy };
}

console.log('Running Phase 230 merge-review evidence pack suite:\n');

await test('REVIEWER_PACK_READY when all seven components are green and the mesh binds to one run', async () => {
  const root = workspace();
  try {
    const g = await greenInputs(root);
    const p = buildReviewerPack(g);
    assertEq(p.overall, 'REVIEWER_PACK_READY', `ready (blockers: ${p.blockers.join(',')})`);
    assertEq(p.authorization, 'NONE', 'authorizes nothing');
    assertEq(p.components.length, 7, 'seven components');
    assert(p.components.every((c) => c.present && c.ok && /^[0-9a-f]{64}$/.test(c.digest ?? '')), 'all components green with digests');
    assertEq(p.bindings.length, 7, 'the full binding mesh evaluated');
    assert(p.bindings.every((b) => b.ok), 'every binding holds');
    // the pack carries the exact canonical component + binding names, for a consumer to fail closed on
    assertEq([...new Set(p.components.map((c) => c.component))].sort().join(','), [...EXPECTED_PACK_COMPONENTS].sort().join(','), 'exact expected component set');
    assertEq([...new Set(p.bindings.map((b) => b.binding))].sort().join(','), [...EXPECTED_PACK_BINDINGS].sort().join(','), 'exact expected binding mesh');
    // redaction-safe provenance carried from the packed merge-readiness
    assertEq(p.provenance.branch, 'work/phase-230', 'branch provenance');
    assertEq(p.provenance.base, BASE, 'base provenance');
    assertEq(p.provenance.head, HEAD, 'head provenance');
    assertEq(p.provenance.commitCount, 1, 'commit count provenance');
    assert(p.provenance.commitShas.length === 1 && p.provenance.commitShas[0] === HEAD, 'ordered commit shas provenance');
    assert(p.provenance.requiredTests.includes('npm run test:phase230-local'), 'required tests provenance');
    assertEq(p.disclaimers.length, REVIEWER_PACK_DISCLAIMERS.length, 'disclaimers present');
    assertEq(verifySelfDigests([p]).overall, 'ALL_VERIFIED', 'pack self-verifies');
    assert(/^[0-9a-f]{64}$/.test(p.packDigest), 'pack digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when a component is missing or a digest is stripped', async () => {
  const root = workspace();
  try {
    const g = await greenInputs(root);
    const { boundaryPolicy, ...rest } = g;
    void boundaryPolicy;
    const missing = buildReviewerPack(rest);
    assertEq(missing.overall, 'REVIEWER_PACK_BLOCKED', 'missing component blocked');
    assert(missing.blockers.includes('BOUNDARY_POLICY_MISSING'), 'boundary-policy-missing blocker');

    const stripped = JSON.parse(JSON.stringify(g.redactionCorpus)) as Record<string, unknown>;
    delete stripped.redactionDigest;
    const digestless = buildReviewerPack({ ...g, redactionCorpus: stripped });
    assert(digestless.blockers.includes('COMPONENT_DIGEST_MISSING'), 'component-digest-missing blocker');

    // Green status (REDACTION_CORPUS_HELD) + a well-formed but wrong digest: only a real recompute catches
    // the tampered body -> COMPONENT_DIGEST_MISMATCH, and the forged-but-green record is not packed as ok.
    const tampered = JSON.parse(JSON.stringify(g.redactionCorpus)) as Record<string, unknown>;
    assertEq(tampered.overall, 'REDACTION_CORPUS_HELD', 'precondition: component is green');
    assert(/^[0-9a-f]{64}$/.test(String(tampered.redactionDigest)), 'precondition: well-formed digest');
    tampered.injectedClaim = 'smuggled-through-a-green-status';
    const t = buildReviewerPack({ ...g, redactionCorpus: tampered });
    assertEq(t.overall, 'REVIEWER_PACK_BLOCKED', 'green-body tamper blocked');
    assert(t.blockers.includes('COMPONENT_DIGEST_MISMATCH'), 'green-body tamper -> digest mismatch');
    assert(t.components.some((c) => c.component === 'redaction-corpus' && !c.ok && c.digest === undefined), 'tampered component not packed as ok/digest-bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the mesh does not bind to one run (stitched final summary)', async () => {
  const root = workspace();
  try {
    const g = await greenInputs(root);
    const other = JSON.parse(JSON.stringify(g.finalSummary)) as Record<string, unknown>;
    other.summaryDigest = 'b'.repeat(64); // well-formed but from a different run
    const p = buildReviewerPack({ ...g, finalSummary: other });
    assertEq(p.overall, 'REVIEWER_PACK_BLOCKED', 'blocked');
    assert(p.blockers.includes('PACK_BINDING_MISMATCH'), 'pack-binding-mismatch blocker');
    assert(p.bindings.filter((b) => !b.ok).length >= 2, 'both final-summary bindings fail');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BLOCKED and redaction-safe on empty input', () => {
  const p = buildReviewerPack({});
  assertEq(p.overall, 'REVIEWER_PACK_BLOCKED', 'blocked');
  assert(p.blockers.includes('FINAL_SUMMARY_MISSING') && p.blockers.includes('REVIEW_AUTOMATION_MISSING'), 'missing blockers');
  assert(p.redactionSafe === true && !JSON.stringify(p).includes('/mnt/'), 'redaction-safe');
});

await test('CLI assembles the pack and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const g = await greenInputs(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const fs = w('fs.json', g.finalSummary); const rc = w('rc.json', g.releaseChecklist); const mr = w('mr.json', g.mergeReadiness);
    const cb = w('cb.json', g.chainBundle); const ra = w('ra.json', g.reviewAutomation); const rd = w('rd.json', g.redactionCorpus); const bp = w('bp.json', g.boundaryPolicy);
    const outPath = join(root, 'catalog-authority-test-library', 'RPMARKER-out', 'pack.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-reviewer-pack-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--finalsummary', fs, '--releasechecklist', rc, '--mergereadiness', mr, '--chainbundle', cb, '--reviewautomation', ra, '--redactioncorpus', rd, '--boundarypolicy', bp, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `READY exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'pack file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'REVIEWER_PACK_READY', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('RPMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
