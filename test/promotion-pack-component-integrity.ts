import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackComponentIntegrity, COVERS_EXPECTED_PACK_COMPONENTS, PACK_INTEGRITY_DISCLAIMERS } from '../src/ops/promotion-pack-component-integrity.js';
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
function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-integrity-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 24, 8, 0, i++)); }
const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const BASE = '1111111111111111111111111111111111111111';
const CMD = 'npm run test:phase230-local';

// Reseal a reviewer pack after an in-place body mutation so a *specific* binding failure isolates without
// the pack's own digest recompute (PACK_DIGEST_MISMATCH) masking it.
function resealPack(pack: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(pack)) as Record<string, unknown>;
  delete clone.packDigest;
  const packDigest = createHash('sha256').update(`phase-230-reviewer-pack:${JSON.stringify(clone)}`).digest('hex');
  return { ...clone, packDigest };
}

async function greenChain(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'integrity', now: makeNow() })));
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
  const context = { branch: 'work/phase-230', base: BASE, head: HEAD, commits: [{ sha: HEAD, subject: 'a commit (phase BM)' }], requiredTests: [CMD] };
  const mergeReadiness = buildMergeReadiness({ releaseChecklist, finalSummary, context });
  const provenanceDiff = buildProvenanceDiff({ context, transcript, finalSummary, reviewBundle });
  const gateCoverage = buildGateCoverage(projectRoot);
  const chainBundle = buildChainBundle({ finalSummary, releaseChecklist, mergeReadiness, negativeCorpus, provenanceDiff, gateCoverage });
  const redactionCorpus = buildRedactionCorpus();
  const boundaryPolicy = buildBoundaryPolicy(projectRoot);
  const reviewAutomation = buildReviewAutomation({ chainBundle, redactionCorpus, boundaryPolicy });
  const reviewerPack = buildReviewerPack({ finalSummary, releaseChecklist, mergeReadiness, chainBundle, reviewAutomation, redactionCorpus, boundaryPolicy });
  return { reviewerPack, finalSummary, releaseChecklist, mergeReadiness, chainBundle, reviewAutomation, redactionCorpus, boundaryPolicy };
}

console.log('Running Phase 230 pack component-integrity suite:\n');

test('the verifier covers exactly the canonical pack component set', () => {
  assert(COVERS_EXPECTED_PACK_COMPONENTS, 'component set must equal EXPECTED_PACK_COMPONENTS');
});

await test('PACK_INTEGRITY_VERIFIED when the pack and every authoritative component recompute and bind', async () => {
  const root = workspace();
  try {
    const g = await greenChain(root);
    const r = buildPackComponentIntegrity(g);
    assertEq(r.overall, 'PACK_INTEGRITY_VERIFIED', `verified (blockers: ${r.blockers.join(',')})`);
    assertEq(r.authorization, 'NONE', 'authorizes nothing');
    assert(r.packVerified, 'pack self-digest recomputes and is READY');
    assertEq(r.components.length, 7, 'seven components');
    assert(r.components.every((c) => c.present && c.recomputes && c.green && c.boundToPack), 'every component recomputes, is green, and binds to the pack');
    assertEq(r.verifiedCount, 7, 'all seven verified');
    assert(Object.keys(r.boundDigests).length === 7 && Object.values(r.boundDigests).every((d) => /^[0-9a-f]{64}$/.test(d)), 'seven authoritative digests bound');
    assertEq(r.disclaimers.length, PACK_INTEGRITY_DISCLAIMERS.length, 'disclaimers present');
    assertEq(verifySelfDigests([r]).overall, 'ALL_VERIFIED', 'report self-verifies');
    assert(!JSON.stringify(r).includes('/mnt/'), 'redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BROKEN when the pack is missing, forged, or not ready', async () => {
  const root = workspace();
  try {
    const g = await greenChain(root);
    const { reviewerPack, ...components } = g;
    void reviewerPack;

    const noPack = buildPackComponentIntegrity(components);
    assertEq(noPack.overall, 'PACK_INTEGRITY_BROKEN', 'missing pack broken');
    assert(noPack.blockers.includes('PACK_MISSING'), 'pack-missing blocker');
    assert(!noPack.packVerified, 'pack not verified when missing');

    // Forged pack self-digest: tamper the pack body WITHOUT resealing -> its own recompute fails.
    const forgedPack = JSON.parse(JSON.stringify(g.reviewerPack)) as Record<string, unknown>;
    forgedPack.injectedClaim = 'smuggled';
    const rForged = buildPackComponentIntegrity({ ...g, reviewerPack: forgedPack });
    assert(rForged.blockers.includes('PACK_DIGEST_MISMATCH'), 'forged pack digest blocks');

    // Genuinely-built BLOCKED pack (a component omitted) -> valid digest but PACK_NOT_READY.
    const blockedPack = buildReviewerPack({ finalSummary: g.finalSummary, releaseChecklist: g.releaseChecklist, mergeReadiness: g.mergeReadiness, chainBundle: g.chainBundle, reviewAutomation: g.reviewAutomation, redactionCorpus: g.redactionCorpus });
    assertEq((blockedPack as { overall: string }).overall, 'REVIEWER_PACK_BLOCKED', 'precondition: pack is blocked');
    const rNotReady = buildPackComponentIntegrity({ ...g, reviewerPack: blockedPack });
    assert(rNotReady.blockers.includes('PACK_NOT_READY'), 'not-ready pack blocks');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BROKEN when an authoritative component is missing or carries the wrong report id', async () => {
  const root = workspace();
  try {
    const g = await greenChain(root);
    const { finalSummary, ...rest } = g;
    void finalSummary;
    const missing = buildPackComponentIntegrity(rest);
    assert(missing.blockers.includes('COMPONENT_REPORT_MISSING'), 'component-report-missing blocker');

    const wrongId = JSON.parse(JSON.stringify(g.finalSummary)) as Record<string, unknown>;
    wrongId.report = 'phase-230-promotion-redaction-corpus';
    const rWrong = buildPackComponentIntegrity({ ...g, finalSummary: wrongId });
    assert(rWrong.blockers.includes('COMPONENT_REPORT_INVALID'), 'wrong report id blocks');
    assert(!('final-summary' in rWrong.boundDigests), 'wrong-id component not bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('THE security case: a green component with a tampered body fails its self-digest recompute', async () => {
  const root = workspace();
  try {
    const g = await greenChain(root);
    // The final summary keeps its green status and its well-formed stored digest, but its body was tampered.
    // reviewer-pack/AX presence-check only; this verifier recomputes -> COMPONENT_DIGEST_MISMATCH.
    const tampered = JSON.parse(JSON.stringify(g.finalSummary)) as Record<string, unknown>;
    assertEq(tampered.overall, 'FINAL_SUMMARY_READY', 'precondition: component is green');
    assert(/^[0-9a-f]{64}$/.test(String(tampered.summaryDigest)), 'precondition: well-formed digest');
    tampered.injectedClaim = 'smuggled-through-a-green-status';
    const r = buildPackComponentIntegrity({ ...g, finalSummary: tampered });
    assertEq(r.overall, 'PACK_INTEGRITY_BROKEN', 'tampered component broken');
    assert(r.blockers.includes('COMPONENT_DIGEST_MISMATCH'), 'green-body tamper -> digest mismatch');
    assert(!('final-summary' in r.boundDigests), 'tampered component not bound');
    assert(r.components.some((c) => c.component === 'final-summary' && !c.recomputes && c.green), 'green but non-recomputing recorded');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BROKEN when the pack carries a forged digest for a genuine component (binding failure)', async () => {
  const root = workspace();
  try {
    const g = await greenChain(root);
    // Genuine components, but the pack's redacted digest for final-summary is swapped and the pack resealed.
    // The pack recomputes and is READY, yet its digest no longer binds to the authoritative record.
    const pack = JSON.parse(JSON.stringify(g.reviewerPack)) as Record<string, unknown>;
    const comps = pack.components as Array<Record<string, unknown>>;
    const fsComp = comps.find((c) => c.component === 'final-summary');
    assert(fsComp !== undefined, 'precondition: pack carries final-summary');
    fsComp!.digest = 'b'.repeat(64);
    const resealed = resealPack(pack);
    const r = buildPackComponentIntegrity({ ...g, reviewerPack: resealed });
    assert(r.packVerified, 'pack still self-verifies after reseal');
    assert(r.blockers.includes('PACK_COMPONENT_DIGEST_MISMATCH'), 'pack digest does not bind to authoritative record');
    assert(!('final-summary' in r.boundDigests), 'unbound component not recorded');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BROKEN and redaction-safe on empty input', () => {
  const r = buildPackComponentIntegrity({});
  assertEq(r.overall, 'PACK_INTEGRITY_BROKEN', 'broken');
  assert(r.blockers.includes('PACK_MISSING') && r.blockers.includes('COMPONENT_REPORT_MISSING'), 'missing blockers');
  assert(r.redactionSafe === true && !JSON.stringify(r).includes('/mnt/'), 'redaction-safe');
});

await test('CLI verifies the pack and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const g = await greenChain(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const rp = w('rp.json', g.reviewerPack); const fs = w('fs.json', g.finalSummary); const rc = w('rc.json', g.releaseChecklist);
    const mr = w('mr.json', g.mergeReadiness); const cb = w('cb.json', g.chainBundle); const ra = w('ra.json', g.reviewAutomation);
    const rd = w('rd.json', g.redactionCorpus); const bp = w('bp.json', g.boundaryPolicy);
    const outPath = join(root, 'catalog-authority-test-library', 'PCIMARKER-out', 'integrity.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-pack-component-integrity-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--reviewerpack', rp, '--finalsummary', fs, '--releasechecklist', rc, '--mergereadiness', mr, '--chainbundle', cb, '--reviewautomation', ra, '--redactioncorpus', rd, '--boundarypolicy', bp, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `VERIFIED exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'integrity file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'PACK_INTEGRITY_VERIFIED', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('PCIMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
