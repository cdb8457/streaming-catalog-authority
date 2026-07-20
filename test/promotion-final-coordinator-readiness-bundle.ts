import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFinalCoordinatorReadinessBundle, FINAL_READINESS_HUMAN_DECISIONS } from '../src/ops/promotion-final-coordinator-readiness-bundle.js';
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
  return { acceptanceTrace, noLiveGuard, livePreflight, approvalRequest, reviewChecklistV2, selfDigest };
}

console.log('Running Phase 230 final coordinator readiness bundle suite:\n');

await test('FINAL_READINESS_BUNDLE_READY: boundary CLOSED, Phase 231 NONE, human item-approval next', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-finalbundle-'));
  try {
    const i = await inputs(root);
    assertEq(i.acceptanceTrace.overall, 'ACCEPTANCE_TRACE_READY', 'precondition: acceptance trace ready');
    assertEq(i.selfDigest.overall, 'ALL_VERIFIED', 'precondition: self-digest all verified');
    const b = buildFinalCoordinatorReadinessBundle(i);
    assertEq(b.overall, 'FINAL_READINESS_BUNDLE_READY', `ready (blockers: ${b.openBlockers.join(',')})`);
    assertEq(b.authorization, 'NONE', 'authorization NONE');
    assertEq(b.status, 'PENDING', 'status PENDING');
    assertEq(b.liveBoundaryStatus, 'CLOSED', 'live boundary CLOSED');
    assertEq(b.phase231Authorization, 'NONE', 'Phase 231 authorization NONE');
    assertEq(b.nextAction, 'AWAIT_HUMAN_ITEM_SPECIFIC_APPROVAL', 'next action is human item approval');
    assertEq(b.reviewedCommit, HEAD, 'exact reviewed commit');
    assert(b.components.length === 6 && b.components.every((x) => x.ok), 'all six components ok');
    assert(b.requiredHumanDecisions.length === FINAL_READINESS_HUMAN_DECISIONS.length, 'human decisions enumerated');
    assert(!JSON.stringify(b).includes('APPROVED') && !JSON.stringify(b).includes('LIVE_READY'), 'never claims approval / live-ready');
    assertEq(verifySelfDigests([b]).overall, 'ALL_VERIFIED', 'bundle self-verifies');
    assert(!JSON.stringify(b).includes('/mnt/'), 'redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED on missing input, forged component, claim, redaction-unsafe input, or missing observed state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-finalbundle-'));
  try {
    const i = await inputs(root);
    assert(buildFinalCoordinatorReadinessBundle({ ...i, selfDigest: undefined }).openBlockers.includes('SELF_DIGEST_MISSING'), 'missing self-digest');
    const forged = { ...JSON.parse(JSON.stringify(i.acceptanceTrace)), traceDigest: 'a'.repeat(64) };
    assert(buildFinalCoordinatorReadinessBundle({ ...i, acceptanceTrace: forged }).openBlockers.includes('COMPONENT_DIGEST_UNVERIFIED'), 'forged acceptance trace');
    // a redaction-unsafe (but otherwise well-formed) input fails closed
    const unsafe = JSON.parse(JSON.stringify(i.noLiveGuard)) as Record<string, unknown>;
    unsafe.redactionSafe = false;
    assert(buildFinalCoordinatorReadinessBundle({ ...i, noLiveGuard: unsafe }).openBlockers.some((x) => x === 'REDACTION_NOT_PROVEN' || x === 'COMPONENT_DIGEST_UNVERIFIED'), 'redaction-unsafe input blocked');
    // a preflight plan without the observed-state requirement fails closed
    const noObserved = buildLivePreflightPlan({ plan: { ...samplePreflightPlan(), observedStateRequired: false } });
    const b = buildFinalCoordinatorReadinessBundle({ ...i, livePreflight: noObserved });
    assert(b.openBlockers.includes('LIVE_PREFLIGHT_NOT_VALID') || b.openBlockers.includes('OBSERVED_STATE_REQUIREMENT_MISSING'), 'observed-state requirement enforced');
    assertEq(b.overall, 'FINAL_READINESS_BUNDLE_BLOCKED', 'blocked');
    assertEq(b.nextAction, 'REMEDIATE_BLOCKERS', 'blocked next action');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI builds the bundle and never echoes raw paths to stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-finalbundle-'));
  try {
    const i = await inputs(root);
    const at = join(root, 'at.json'); writeFileSync(at, JSON.stringify(i.acceptanceTrace));
    const ng = join(root, 'ng.json'); writeFileSync(ng, JSON.stringify(i.noLiveGuard));
    const lp = join(root, 'lp.json'); writeFileSync(lp, JSON.stringify(i.livePreflight));
    const ar = join(root, 'ar.json'); writeFileSync(ar, JSON.stringify(i.approvalRequest));
    const cv = join(root, 'cv.json'); writeFileSync(cv, JSON.stringify(i.reviewChecklistV2));
    const sd = join(root, 'sd.json'); writeFileSync(sd, JSON.stringify(i.selfDigest));
    const outPath = join(root, 'catalog-authority-test-library', 'FBMARKER-out', 'bundle.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-final-coordinator-readiness-bundle-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--acceptancetrace', at, '--noliveguard', ng, '--livepreflight', lp, '--approvalrequest', ar, '--checklistv2', cv, '--selfdigest', sd, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `READY exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'bundle written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'FINAL_READINESS_BUNDLE_READY', 'stdout overall');
    assertEq(parsed.liveBoundaryStatus, 'CLOSED', 'stdout live boundary CLOSED');
    assert(!(res.stdout ?? '').includes('FBMARKER') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
