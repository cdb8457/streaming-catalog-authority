import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFinalBundleReplay } from '../src/ops/promotion-final-bundle-replay-verifier.js';
import { buildFinalCoordinatorReadinessBundle } from '../src/ops/promotion-final-coordinator-readiness-bundle.js';
import { buildOperatorAcceptanceTrace } from '../src/ops/promotion-operator-acceptance-trace.js';
import { buildApprovalRequestPacket } from '../src/ops/promotion-approval-request-packet.js';
import { buildLivePreflightPlan } from '../src/ops/promotion-live-preflight-plan.js';
import { buildNoLiveAuthorizationGuard } from '../src/ops/promotion-no-live-authorization-guard.js';
import { buildReviewChecklistV2 } from '../src/ops/promotion-review-checklist-v2.js';
import { verifySelfDigests } from '../src/ops/promotion-self-digest-verifier.js';
import { buildLaunchProofingEvidence, samplePreflightPlan, sampleCleanArtifacts, HEAD } from './_launch-proofing-evidence.js';

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

async function inputs(root: string) {
  const e = await buildLaunchProofingEvidence(root, projectRoot);
  const approvalRequest = buildApprovalRequestPacket({ reviewAuthorization: e.reviewAuthorization });
  const livePreflight = buildLivePreflightPlan({ plan: samplePreflightPlan() });
  const noLiveGuard = buildNoLiveAuthorizationGuard({ artifacts: sampleCleanArtifacts() });
  const reviewChecklistV2 = buildReviewChecklistV2(projectRoot, { closureSummary: e.closureSummary, bundleAudit: e.bundleAudit });
  const acceptanceTrace = buildOperatorAcceptanceTrace({ approvalRequest, livePreflight, noLiveGuard, reviewChecklistV2 });
  const selfDigest = verifySelfDigests([approvalRequest, livePreflight, noLiveGuard, reviewChecklistV2, acceptanceTrace]);
  const finalBundle = buildFinalCoordinatorReadinessBundle({ acceptanceTrace, noLiveGuard, livePreflight, approvalRequest, reviewChecklistV2, selfDigest });
  return { approvalRequest, livePreflight, noLiveGuard, reviewChecklistV2, acceptanceTrace, selfDigest, finalBundle };
}

console.log('Running Phase 230 final-bundle replay verifier suite:\n');

await test('FINAL_BUNDLE_REPLAY_VERIFIED: the genuine bundle replays exactly, boundary CLOSED, Phase 231 NONE', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-replayverify-'));
  try {
    const i = await inputs(root);
    assertEq(i.finalBundle.overall, 'FINAL_READINESS_BUNDLE_READY', 'precondition: final bundle ready');
    const r = verifyFinalBundleReplay(i);
    assertEq(r.overall, 'FINAL_BUNDLE_REPLAY_VERIFIED', `verified (blockers: ${r.blockers.join(',')})`);
    assertEq(r.authorization, 'NONE', 'authorization NONE');
    assertEq(r.status, 'PENDING', 'status PENDING');
    assertEq(r.liveBoundaryStatus, 'CLOSED', 'live boundary CLOSED');
    assertEq(r.phase231Authorization, 'NONE', 'Phase 231 authorization NONE');
    assertEq(r.reviewedCommit, HEAD, 'exact reviewed commit');
    assert(r.checks.length === 8 && r.checks.every((c) => c.ok), 'all replay checks green');
    assert(!JSON.stringify(r).includes('APPROVED') && !JSON.stringify(r).includes('LIVE_READY'), 'never claims approval / live-ready');
    assertEq(verifySelfDigests([r]).overall, 'ALL_VERIFIED', 'report self-verifies');
    assert(!JSON.stringify(r).includes('/mnt/'), 'redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the supplied final bundle is missing or not READY', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-replayverify-'));
  try {
    const i = await inputs(root);
    assert(verifyFinalBundleReplay({ ...i, finalBundle: undefined }).blockers.includes('REPLAY_FINAL_BUNDLE_NOT_READY'), 'missing final bundle');
    // A final bundle that is itself BLOCKED (built without the self-digest) is not READY.
    const blockedBundle = buildFinalCoordinatorReadinessBundle({ ...i, selfDigest: undefined });
    assertEq(blockedBundle.overall, 'FINAL_READINESS_BUNDLE_BLOCKED', 'precondition: blocked bundle');
    const r = verifyFinalBundleReplay({ ...i, finalBundle: blockedBundle });
    assert(r.blockers.includes('REPLAY_FINAL_BUNDLE_NOT_READY'), 'not-ready final bundle blocked');
    assertEq(r.overall, 'FINAL_BUNDLE_REPLAY_BLOCKED', 'overall blocked');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED on a reviewed-commit mismatch between the approval packet and the bundle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-replayverify-'));
  try {
    const i = await inputs(root);
    // Swap in an approval packet re-sealed over a different reviewed commit; the trace/self-digest/bundle
    // replays against the genuine components no longer reproduce, and the reviewed commit no longer binds.
    const otherApproval = JSON.parse(JSON.stringify(i.approvalRequest)) as Record<string, unknown>;
    otherApproval.reviewedCommit = 'f'.repeat(40);
    // reseal so it self-verifies in isolation
    delete otherApproval.packetDigest;
    otherApproval.packetDigest = createHash('sha256').update(`phase-230-approval-request-packet:${JSON.stringify(otherApproval)}`).digest('hex');
    assertEq(verifySelfDigests([otherApproval]).overall, 'ALL_VERIFIED', 'the swapped approval self-verifies');
    const r = verifyFinalBundleReplay({ ...i, approvalRequest: otherApproval });
    assertEq(r.overall, 'FINAL_BUNDLE_REPLAY_BLOCKED', 'commit mismatch blocks');
    assert(r.blockers.includes('REPLAY_REVIEWED_COMMIT_MISMATCH') || r.blockers.includes('REPLAY_ACCEPTANCE_TRACE_MISMATCH'), 'reviewed-commit / trace binding fails');
    assert(r.blockers.includes('REPLAY_COMPONENT_SET_MISMATCH'), 'component set no longer reproduces');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED on a tampered-but-resealed acceptance trace (recompute > self-report)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-replayverify-'));
  try {
    const i = await inputs(root);
    const scope = 'phase-230-operator-acceptance-trace';
    const tampered = { ...JSON.parse(JSON.stringify(i.acceptanceTrace)), disclaimers: [...i.acceptanceTrace.disclaimers, 'smuggled disclaimer'] } as Record<string, unknown>;
    delete tampered.traceDigest;
    tampered.traceDigest = createHash('sha256').update(`${scope}:${JSON.stringify(tampered)}`).digest('hex');
    assertEq(verifySelfDigests([tampered]).overall, 'ALL_VERIFIED', 'the forged trace self-verifies');
    const r = verifyFinalBundleReplay({ ...i, acceptanceTrace: tampered });
    assertEq(r.overall, 'FINAL_BUNDLE_REPLAY_BLOCKED', 'forged trace blocks');
    assert(r.blockers.includes('REPLAY_ACCEPTANCE_TRACE_MISMATCH'), 'REPLAY_ACCEPTANCE_TRACE_MISMATCH');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED on a stale self-digest that does not cover exactly the supplied components', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-replayverify-'));
  try {
    const i = await inputs(root);
    // ALL_VERIFIED, but over a different set (omitting the acceptance trace) -> its verifierDigest is stale.
    const staleSelfDigest = verifySelfDigests([i.approvalRequest, i.livePreflight, i.noLiveGuard, i.reviewChecklistV2]);
    assertEq(staleSelfDigest.overall, 'ALL_VERIFIED', 'the stale self-digest is itself ALL_VERIFIED');
    const r = verifyFinalBundleReplay({ ...i, selfDigest: staleSelfDigest });
    assertEq(r.overall, 'FINAL_BUNDLE_REPLAY_BLOCKED', 'stale self-digest blocks');
    assert(r.blockers.includes('REPLAY_SELF_DIGEST_MISMATCH'), 'REPLAY_SELF_DIGEST_MISMATCH');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED on a live-authorization claim in any supplied input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-replayverify-'));
  try {
    const i = await inputs(root);
    // A leaf that hard-claims a live authorization must fail closed regardless of anything else.
    const claiming = JSON.parse(JSON.stringify(i.reviewChecklistV2)) as Record<string, unknown>;
    claiming.decision = 'APPROVED';
    const r = verifyFinalBundleReplay({ ...i, reviewChecklistV2: claiming });
    assertEq(r.overall, 'FINAL_BUNDLE_REPLAY_BLOCKED', 'live-authorization claim blocks');
    assert(r.blockers.includes('REPLAY_LIVE_AUTHORIZATION_CLAIMED'), 'REPLAY_LIVE_AUTHORIZATION_CLAIMED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED on a raw path / redaction-unsafe input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-replayverify-'));
  try {
    const i = await inputs(root);
    // A raw path leaked into an otherwise well-formed input fails closed via redaction.
    const leaky = JSON.parse(JSON.stringify(i.noLiveGuard)) as Record<string, unknown>;
    leaky.note = '/mnt/user/media/Movies leaked';
    assert(verifyFinalBundleReplay({ ...i, noLiveGuard: leaky }).blockers.includes('REPLAY_REDACTION_UNSAFE'), 'raw path blocked');
    // redactionSafe=false also fails closed
    const unsafe = JSON.parse(JSON.stringify(i.selfDigest)) as Record<string, unknown>;
    unsafe.redactionSafe = false;
    assert(verifyFinalBundleReplay({ ...i, selfDigest: unsafe }).blockers.includes('REPLAY_REDACTION_UNSAFE'), 'redactionSafe=false blocked');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED on a raw path nested deeper than the old depth cutoff (full-tree scan)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-replayverify-'));
  try {
    const i = await inputs(root);
    // Bury a raw path 12 levels deep -- past the removed depth-8 cutoff. The redaction scan must still catch it.
    let nested: Record<string, unknown> = { leaf: '/mnt/user/media/Movies buried deep' };
    for (let d = 0; d < 12; d++) nested = { child: nested };
    const leaky = JSON.parse(JSON.stringify(i.noLiveGuard)) as Record<string, unknown>;
    leaky.deep = nested;
    const r = verifyFinalBundleReplay({ ...i, noLiveGuard: leaky });
    assertEq(r.overall, 'FINAL_BUNDLE_REPLAY_BLOCKED', 'deeply-nested raw path blocks');
    assert(r.blockers.includes('REPLAY_REDACTION_UNSAFE'), 'REPLAY_REDACTION_UNSAFE on deep nesting');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the preflight plan drops the observed-state requirement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-replayverify-'));
  try {
    const i = await inputs(root);
    const noObserved = buildLivePreflightPlan({ plan: { ...samplePreflightPlan(), observedStateRequired: false } });
    const r = verifyFinalBundleReplay({ ...i, livePreflight: noObserved });
    assertEq(r.overall, 'FINAL_BUNDLE_REPLAY_BLOCKED', 'missing observed state blocks');
    assert(r.blockers.includes('REPLAY_OBSERVED_STATE_MISSING'), 'REPLAY_OBSERVED_STATE_MISSING');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI verifies the replay and never echoes raw paths to stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-replayverify-'));
  try {
    const i = await inputs(root);
    const ar = join(root, 'ar.json'); writeFileSync(ar, JSON.stringify(i.approvalRequest));
    const lp = join(root, 'lp.json'); writeFileSync(lp, JSON.stringify(i.livePreflight));
    const ng = join(root, 'ng.json'); writeFileSync(ng, JSON.stringify(i.noLiveGuard));
    const cv = join(root, 'cv.json'); writeFileSync(cv, JSON.stringify(i.reviewChecklistV2));
    const at = join(root, 'at.json'); writeFileSync(at, JSON.stringify(i.acceptanceTrace));
    const sd = join(root, 'sd.json'); writeFileSync(sd, JSON.stringify(i.selfDigest));
    const fb = join(root, 'fb.json'); writeFileSync(fb, JSON.stringify(i.finalBundle));
    const outPath = join(root, 'catalog-authority-test-library', 'RVMARKER-out', 'replay.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-final-bundle-replay-verifier-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--approvalrequest', ar, '--livepreflight', lp, '--noliveguard', ng, '--checklistv2', cv, '--acceptancetrace', at, '--selfdigest', sd, '--finalbundle', fb, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `VERIFIED exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'replay written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'FINAL_BUNDLE_REPLAY_VERIFIED', 'stdout overall');
    assertEq(parsed.liveBoundaryStatus, 'CLOSED', 'stdout live boundary CLOSED');
    assert(!(res.stdout ?? '').includes('RVMARKER') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
