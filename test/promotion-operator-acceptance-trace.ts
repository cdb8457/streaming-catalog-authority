import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOperatorAcceptanceTrace, ACCEPTANCE_TRACE_DISCLAIMERS } from '../src/ops/promotion-operator-acceptance-trace.js';
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

async function components(root: string) {
  const e = await buildLaunchProofingEvidence(root, projectRoot);
  const approvalRequest = buildApprovalRequestPacket({ reviewAuthorization: e.reviewAuthorization });
  const livePreflight = buildLivePreflightPlan({ plan: samplePreflightPlan() });
  const noLiveGuard = buildNoLiveAuthorizationGuard({ artifacts: sampleCleanArtifacts() });
  const reviewChecklistV2 = buildReviewChecklistV2(projectRoot, { closureSummary: e.closureSummary, bundleAudit: e.bundleAudit });
  return { approvalRequest, livePreflight, noLiveGuard, reviewChecklistV2 };
}

console.log('Running Phase 230 operator acceptance trace suite:\n');

await test('ACCEPTANCE_TRACE_READY aggregates the four guard artifacts; PENDING/NONE, grants nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-acctrace-'));
  try {
    const c = await components(root);
    assertEq(c.approvalRequest.overall, 'APPROVAL_REQUEST_READY', 'precondition: approval request ready');
    assertEq(c.livePreflight.overall, 'PREFLIGHT_PLAN_VALID', 'precondition: preflight valid');
    assertEq(c.noLiveGuard.overall, 'NO_LIVE_AUTHORIZATION_CLEAN', 'precondition: no-live clean');
    assertEq(c.reviewChecklistV2.overall, 'CHECKLIST_READY', 'precondition: checklist ready');
    const t = buildOperatorAcceptanceTrace(c);
    assertEq(t.overall, 'ACCEPTANCE_TRACE_READY', `ready (blockers: ${t.blockers.join(',')})`);
    assertEq(t.authorization, 'NONE', 'authorization NONE');
    assertEq(t.status, 'PENDING', 'status PENDING');
    assertEq(t.decision, 'AWAITING_HUMAN_ITEM_APPROVAL', 'decision awaits human approval');
    assertEq(t.reviewedCommit, HEAD, 'exact reviewed commit');
    assertEq(t.selfDigestOverall, 'ALL_VERIFIED', 'components self-verify');
    assert(t.components.length === 4 && t.components.every((x) => x.ok), 'all four components ok');
    assert(t.reportIds.length === 4, 'four report ids');
    assert(t.disclaimers.length === ACCEPTANCE_TRACE_DISCLAIMERS.length, 'disclaimers enumerated');
    assert(!JSON.stringify(t).includes('APPROVED') && !JSON.stringify(t).includes('GRANTED'), 'never claims approval');
    assertEq(verifySelfDigests([t]).overall, 'ALL_VERIFIED', 'trace self-verifies');
    assert(!JSON.stringify(t).includes('/mnt/'), 'redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED on a missing, forged, or claiming component', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-acctrace-'));
  try {
    const c = await components(root);
    assert(buildOperatorAcceptanceTrace({ ...c, approvalRequest: undefined }).blockers.includes('APPROVAL_REQUEST_MISSING'), 'missing approval');
    // a forged (non-recomputing) approval-request component fails closed
    const forged = { ...JSON.parse(JSON.stringify(c.approvalRequest)), packetDigest: 'a'.repeat(64) };
    assert(buildOperatorAcceptanceTrace({ ...c, approvalRequest: forged }).blockers.includes('COMPONENT_DIGEST_UNVERIFIED'), 'forged digest');
    // a component smuggling a live authorization claim fails closed via defence-in-depth
    const claiming = { report: 'phase-230-promotion-approval-request-packet', overall: 'APPROVED', packetDigest: 'a'.repeat(64) };
    const t = buildOperatorAcceptanceTrace({ ...c, approvalRequest: claiming });
    assertEq(t.overall, 'ACCEPTANCE_TRACE_BLOCKED', 'blocked on claim');
    assert(t.decision === 'BLOCKED_PENDING_REMEDIATION', 'decision blocked');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI builds the trace and never echoes raw paths to stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-acctrace-'));
  try {
    const c = await components(root);
    const ar = join(root, 'ar.json'); writeFileSync(ar, JSON.stringify(c.approvalRequest));
    const lp = join(root, 'lp.json'); writeFileSync(lp, JSON.stringify(c.livePreflight));
    const ng = join(root, 'ng.json'); writeFileSync(ng, JSON.stringify(c.noLiveGuard));
    const cv = join(root, 'cv.json'); writeFileSync(cv, JSON.stringify(c.reviewChecklistV2));
    const outPath = join(root, 'catalog-authority-test-library', 'ATMARKER-out', 'trace.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-operator-acceptance-trace-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--approvalrequest', ar, '--livepreflight', lp, '--noliveguard', ng, '--checklistv2', cv, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `READY exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'trace written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'ACCEPTANCE_TRACE_READY', 'stdout overall');
    assertEq(parsed.status, 'PENDING', 'stdout status PENDING');
    assert(!(res.stdout ?? '').includes('ATMARKER') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
