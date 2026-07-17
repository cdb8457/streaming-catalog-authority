import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAcceptancePreflight, PREFLIGHT_HUMAN_GATES, PREFLIGHT_DISCLAIMERS } from '../src/ops/promotion-acceptance-preflight.js';
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
function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-preflight-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 21, 10, 0, i++)); }
const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const BASE = '1111111111111111111111111111111111111111';

const C1 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
// A two-commit range whose terminal (tip) sha equals head -- the reviewed commit.
function goodContext() {
  return { branch: 'work/phase-230', base: BASE, head: HEAD, commits: [{ sha: C1, subject: 'first' }, { sha: HEAD, subject: 'second (tip)' }], requiredTests: ['npm run test:phase230-local', 'npm run typecheck'] };
}
// Recompute a reviewer pack's self-digest over its (possibly-mutated) body, exactly as the verifier does,
// so a forged pack still passes the digest recompute and the specific component/binding blocker isolates.
function reseal(pack: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const k of Object.keys(pack)) if (k !== 'packDigest') body[k] = pack[k];
  return { ...body, packDigest: createHash('sha256').update(`phase-230-reviewer-pack:${JSON.stringify(body)}`).digest('hex') };
}

async function readyPack(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'preflight', now: makeNow() })));
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
  const context = goodContext();
  const mergeReadiness = buildMergeReadiness({ releaseChecklist, finalSummary, context });
  const provenanceDiff = buildProvenanceDiff({ context, transcript, finalSummary, reviewBundle });
  const gateCoverage = buildGateCoverage(projectRoot);
  const chainBundle = buildChainBundle({ finalSummary, releaseChecklist, mergeReadiness, negativeCorpus, provenanceDiff, gateCoverage });
  const redactionCorpus = buildRedactionCorpus();
  const boundaryPolicy = buildBoundaryPolicy(projectRoot);
  const reviewAutomation = buildReviewAutomation({ chainBundle, redactionCorpus, boundaryPolicy });
  return buildReviewerPack({ finalSummary, releaseChecklist, mergeReadiness, chainBundle, reviewAutomation, redactionCorpus, boundaryPolicy });
}

console.log('Running Phase 230 acceptance preflight suite:\n');

await test('PREFLIGHT_READY with a READY pack + valid context; machine vs human gates stated exactly', async () => {
  const root = workspace();
  try {
    const pack = await readyPack(root);
    const p = buildAcceptancePreflight({ reviewerPack: pack, context: goodContext() });
    assertEq(p.overall, 'PREFLIGHT_READY', `ready (blockers: ${p.blockers.join(',')})`);
    assertEq(p.authorization, 'NONE', 'authorizes nothing');
    assertEq(p.approvalsGranted.length, 0, 'approves NOTHING');
    assert(p.machineGates.length >= 11 && p.machineGates.every((g) => g.passed), 'every machine gate passed');
    const gateNames = new Set(p.machineGates.map((g) => g.gate));
    assert(gateNames.has('reviewer-pack') && gateNames.has('pack-binding-mesh') && gateNames.has('context') && gateNames.has('component:final-summary') && gateNames.has('component:boundary-policy') && gateNames.has('context-bound-to-evidence'), 'machine gates enumerated per component + context binding');
    assertEq(p.humanGatesRemaining.length, PREFLIGHT_HUMAN_GATES.length, 'human gates enumerated');
    assert(p.humanGatesRemaining.some((h) => /Phase 231/.test(h)) && p.humanGatesRemaining.some((h) => /push-to-master/.test(h)), 'merge + Phase 231 stay human');
    assertEq(p.base, BASE, 'base echoed');
    assertEq(p.head, HEAD, 'head echoed');
    assertEq(p.commitCount, 2, 'commit count echoed');
    assert(gateNames.has('commits-bound-to-evidence'), 'commit range bound to evidence');
    assertEq(p.disclaimers.length, PREFLIGHT_DISCLAIMERS.length, 'disclaimers present');
    assertEq(verifySelfDigests([p]).overall, 'ALL_VERIFIED', 'preflight self-verifies');
    assert(/^[0-9a-f]{64}$/.test(p.preflightDigest), 'preflight digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deterministic: identical inputs produce identical digests', () => {
  const pack = { report: 'phase-230-promotion-merge-review-evidence-pack', overall: 'REVIEWER_PACK_BLOCKED', packDigest: 'a'.repeat(64), components: [], bindings: [], blockers: ['X'] };
  const a = buildAcceptancePreflight({ reviewerPack: pack, context: goodContext() });
  const b = buildAcceptancePreflight({ reviewerPack: pack, context: goodContext() });
  assertEq(a.preflightDigest, b.preflightDigest, 'same inputs -> same digest');
});

await test('NOT_READY when the pack is blocked or its digest is stripped', async () => {
  const root = workspace();
  try {
    const blocked = { report: 'phase-230-promotion-merge-review-evidence-pack', overall: 'REVIEWER_PACK_BLOCKED', packDigest: 'a'.repeat(64), components: [{ component: 'final-summary', present: true, ok: false }], bindings: [], blockers: ['FINAL_SUMMARY_NOT_READY'] };
    const p = buildAcceptancePreflight({ reviewerPack: blocked, context: goodContext() });
    assertEq(p.overall, 'PREFLIGHT_NOT_READY', 'not ready');
    assert(p.blockers.includes('REVIEWER_PACK_NOT_READY') && p.blockers.includes('MACHINE_GATE_FAILED'), 'pack + machine-gate blockers');
    assert(p.machineGates.some((g) => g.gate === 'component:final-summary' && !g.passed), 'failing component surfaced as a machine gate');

    const pack = await readyPack(root);
    const stripped = JSON.parse(JSON.stringify(pack)) as Record<string, unknown>;
    delete stripped.packDigest;
    const digestless = buildAcceptancePreflight({ reviewerPack: stripped, context: goodContext() });
    assert(digestless.blockers.includes('REVIEWER_PACK_DIGEST_MISMATCH'), 'stripped pack digest fails the recompute');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('NOT_READY on a forged minimal ready pack (self-digest does not recompute)', async () => {
  const forged = { report: 'phase-230-promotion-merge-review-evidence-pack', version: 1, redactionSafe: true, authorization: 'NONE', overall: 'REVIEWER_PACK_READY', components: [], bindings: [], provenance: { branch: 'work/phase-230', base: BASE, head: HEAD, commitCount: 1, requiredTests: ['npm run test:phase230-local', 'npm run typecheck'] }, blockers: [], disclaimers: [], packDigest: 'a'.repeat(64) };
  const p = buildAcceptancePreflight({ reviewerPack: forged, context: goodContext() });
  assertEq(p.overall, 'PREFLIGHT_NOT_READY', 'not ready');
  assert(p.blockers.includes('REVIEWER_PACK_DIGEST_MISMATCH'), 'forged digest rejected');
  assert(p.blockers.includes('PACK_COMPONENT_INCOMPLETE') && p.blockers.includes('PACK_BINDING_MISSING'), 'empty component/binding sets rejected');
});

await test('NOT_READY on incomplete/failing/missing/unknown components and bindings (resealed)', async () => {
  const root = workspace();
  try {
    const pack = JSON.parse(JSON.stringify(await readyPack(root))) as Record<string, unknown>;
    const comps = pack.components as Array<Record<string, unknown>>;
    const binds = pack.bindings as Array<Record<string, unknown>>;

    // incomplete component: a genuine component flipped to not-ok, then resealed
    const incomplete = reseal({ ...pack, components: comps.map((c) => c.component === 'final-summary' ? { ...c, ok: false } : c) });
    assert(buildAcceptancePreflight({ reviewerPack: incomplete, context: goodContext() }).blockers.includes('PACK_COMPONENT_INCOMPLETE'), 'incomplete component rejected');

    // unknown component name
    const unknownComp = reseal({ ...pack, components: [...comps, { component: 'bogus-component', present: true, ok: true, digest: 'a'.repeat(64) }] });
    assert(buildAcceptancePreflight({ reviewerPack: unknownComp, context: goodContext() }).blockers.includes('PACK_COMPONENT_UNKNOWN'), 'unknown component rejected');

    // missing binding name
    const missingBind = reseal({ ...pack, bindings: binds.filter((b) => b.binding !== 'chain-bundle=merge-readiness') });
    assert(buildAcceptancePreflight({ reviewerPack: missingBind, context: goodContext() }).blockers.includes('PACK_BINDING_MISSING'), 'missing binding rejected');

    // unknown binding name
    const unknownBind = reseal({ ...pack, bindings: [...binds, { binding: 'bogus=binding', ok: true }] });
    assert(buildAcceptancePreflight({ reviewerPack: unknownBind, context: goodContext() }).blockers.includes('PACK_BINDING_UNKNOWN'), 'unknown binding rejected');

    // failing binding
    const failingBind = reseal({ ...pack, bindings: binds.map((b) => b.binding === 'review-automation=chain-bundle' ? { ...b, ok: false } : b) });
    assert(buildAcceptancePreflight({ reviewerPack: failingBind, context: goodContext() }).blockers.includes('PACK_BINDING_FAILED'), 'failing binding rejected');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('NOT_READY when the context does not bind to the packed provenance', async () => {
  const root = workspace();
  try {
    const pack = await readyPack(root);
    const otherSha = 'a1b2c3d4e5f6071829304152637485960a1b2c3d';
    assert(buildAcceptancePreflight({ reviewerPack: pack, context: { ...goodContext(), branch: 'work/other-branch' } }).blockers.includes('CONTEXT_BRANCH_MISMATCH'), 'branch mismatch rejected');
    assert(buildAcceptancePreflight({ reviewerPack: pack, context: { ...goodContext(), base: otherSha } }).blockers.includes('CONTEXT_BASE_MISMATCH'), 'base mismatch rejected');
    assert(buildAcceptancePreflight({ reviewerPack: pack, context: { ...goodContext(), head: otherSha, commits: [{ sha: otherSha, subject: 'x' }] } }).blockers.includes('CONTEXT_HEAD_MISMATCH'), 'head mismatch rejected');
    assert(buildAcceptancePreflight({ reviewerPack: pack, context: { ...goodContext(), requiredTests: ['npm run something-else'] } }).blockers.includes('CONTEXT_REQUIRED_TESTS_MISMATCH'), 'required-tests mismatch rejected');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('commit range binds by ordered sha + count + terminal head (subject is cosmetic)', async () => {
  const root = workspace();
  const otherSha = 'a1b2c3d4e5f6071829304152637485960a1b2c3d';
  try {
    const pack = await readyPack(root);
    // same branch/base/head/tests + same ordered shas but an altered commit subject -> still READY (cosmetic)
    const alteredSubject = buildAcceptancePreflight({ reviewerPack: pack, context: { ...goodContext(), commits: [{ sha: C1, subject: 'reworded' }, { sha: HEAD, subject: 'also reworded' }] } });
    assertEq(alteredSubject.overall, 'PREFLIGHT_READY', `altered subject stays ready (blockers: ${alteredSubject.blockers.join(',')})`);
    assert(!alteredSubject.blockers.includes('CONTEXT_COMMITS_MISMATCH'), 'subject change is not a commit mismatch');

    // extra commit -> count + list mismatch
    const extra = buildAcceptancePreflight({ reviewerPack: pack, context: { ...goodContext(), commits: [{ sha: C1, subject: 'first' }, { sha: otherSha, subject: 'extra' }, { sha: HEAD, subject: 'tip' }] } });
    assertEq(extra.overall, 'PREFLIGHT_NOT_READY', 'extra commit blocked');
    assert(extra.blockers.includes('CONTEXT_COMMIT_COUNT_MISMATCH'), 'extra commit -> count mismatch');

    // missing commit -> count + list mismatch
    const missing = buildAcceptancePreflight({ reviewerPack: pack, context: { ...goodContext(), commits: [{ sha: HEAD, subject: 'tip only' }] } });
    assert(missing.blockers.includes('CONTEXT_COMMIT_COUNT_MISMATCH'), 'missing commit -> count mismatch');

    // reordered shas (same count) -> list mismatch
    const reordered = buildAcceptancePreflight({ reviewerPack: pack, context: { ...goodContext(), commits: [{ sha: HEAD, subject: 'first' }, { sha: C1, subject: 'second' }] } });
    assert(reordered.blockers.includes('CONTEXT_COMMITS_MISMATCH'), 'reordered shas -> list mismatch');

    // different sha in the range (same count) -> list mismatch
    const different = buildAcceptancePreflight({ reviewerPack: pack, context: { ...goodContext(), commits: [{ sha: otherSha, subject: 'first' }, { sha: HEAD, subject: 'tip' }] } });
    assert(different.blockers.includes('CONTEXT_COMMITS_MISMATCH'), 'different sha -> list mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('NOT_READY when the context is missing or malformed', async () => {
  const root = workspace();
  try {
    const pack = await readyPack(root);
    const missing = buildAcceptancePreflight({ reviewerPack: pack });
    assert(missing.blockers.includes('PREFLIGHT_CONTEXT_MISSING'), 'context-missing blocker');
    const badHead = buildAcceptancePreflight({ reviewerPack: pack, context: { ...goodContext(), head: 'not-a-sha' } });
    assert(badHead.blockers.includes('PREFLIGHT_CONTEXT_INVALID'), 'bad head -> context-invalid');
    assertEq(badHead.overall, 'PREFLIGHT_NOT_READY', 'not ready');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('NOT_READY and redaction-safe on empty input (human gates still enumerated)', () => {
  const p = buildAcceptancePreflight({});
  assertEq(p.overall, 'PREFLIGHT_NOT_READY', 'not ready');
  assert(p.blockers.includes('REVIEWER_PACK_MISSING') && p.blockers.includes('PREFLIGHT_CONTEXT_MISSING'), 'missing blockers');
  assertEq(p.approvalsGranted.length, 0, 'still approves nothing');
  assertEq(p.humanGatesRemaining.length, PREFLIGHT_HUMAN_GATES.length, 'human gates still enumerated');
  assert(p.redactionSafe === true && !JSON.stringify(p).includes('/mnt/'), 'redaction-safe');
});

await test('CLI runs the preflight and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const pack = await readyPack(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const rp = w('rp.json', pack); const ctx = w('ctx.json', goodContext());
    const outPath = join(root, 'catalog-authority-test-library', 'PFMARKER-out', 'preflight.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-acceptance-preflight-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--reviewerpack', rp, '--context', ctx, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `READY exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'preflight file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'PREFLIGHT_READY', 'stdout overall');
    assertEq((parsed.approvalsGranted as unknown[]).length, 0, 'stdout shows no approvals granted');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('PFMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
