import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildOperationClosureRecord,
  buildOperationClosureSkeleton,
  OPERATION_CLOSURE_INPUT_ID,
  OPERATION_CLOSURE_DISCLAIMERS,
  OPERATION_CLOSURE_REMAINING_HUMAN_STEPS,
} from '../src/ops/promotion-operation-closure-record.js';
import { buildPostRunDispositionRecord, buildPostRunDispositionSkeleton } from '../src/ops/promotion-post-run-disposition-record.js';
import { buildPostRunObservationRecord, buildPostRunObservationSkeleton } from '../src/ops/promotion-post-run-observation-record.js';
import {
  buildExecutionAuthorizationRecord,
  buildExecutionAuthorizationRecordSkeleton,
} from '../src/ops/promotion-execution-authorization-record.js';
import { buildExecutionAuthorization } from '../src/ops/promotion-execution-authorization.js';
import { buildApprovalAttestation, validateApprovalAttestation } from '../src/ops/promotion-approval.js';
import { buildLivePreflightPlan } from '../src/ops/promotion-live-preflight-plan.js';
import { verifySelfDigests } from '../src/ops/promotion-self-digest-verifier.js';

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
const APPROVED_ROOT = '/mnt/user/media/Movies';
const OPERATOR_DIGEST = createHash('sha256').update('phase-235-operator-under-test').digest('hex');
const OBSERVER_DIGEST = createHash('sha256').update('phase-235-observer-under-test').digest('hex');
const REVIEWER_DIGEST = createHash('sha256').update('phase-235-reviewer-under-test').digest('hex');
const CLOSER_DIGEST = createHash('sha256').update('phase-235-closer-under-test').digest('hex');
const DECIDED_AT = '2026-07-21T00:00:00Z';
const OBSERVED_AT = '2026-07-21T01:00:00Z';
const REVIEWED_AT = '2026-07-21T02:00:00Z';
const CLOSED_AT = '2026-07-21T03:00:00Z';
// Synthetic observed-state digests. This suite observes nothing real.
const STATE_BEFORE = createHash('sha256').update('synthetic-observed-state-before').digest('hex');
const STATE_AFTER = createHash('sha256').update('synthetic-observed-state-after').digest('hex');

const MINIMAL_MP4_FIXTURE = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isomcatalog-authority-closure-fixture', 'ascii'),
]);

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-closure-')); }

type Rec = Record<string, unknown>;
interface ChainOpts { itemId?: string; approvalId?: string; body?: Buffer; outcome?: 'COMPLETED' | 'FAILED'; withdrawn?: boolean }

// A genuine Phase 231 gate over a SYNTHETIC one-item bundle.
function gateFor(root: string, o: ChainOpts = {}): Rec {
  const itemId = o.itemId ?? '0a40074065d91a75ad41f33fc212e917';
  const approvalId = o.approvalId ?? 'phase-235-synthetic-test';
  const testRoot = join(root, `catalog-authority-test-library-${itemId.slice(0, 8)}`);
  const source = join(testRoot, 'Movies', 'Closure Proof (2026)', 'source.mp4');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, o.body ?? MINIMAL_MP4_FIXTURE);
  const input = { itemId, title: 'Closure Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot: APPROVED_ROOT, approvalId };
  const built = buildApprovalAttestation(input);
  assert(built.ok, 'precondition: approval built');
  const approvalEvidence = built.evidence;
  const approvalValidation = validateApprovalAttestation(built.approval!, input).evidence;
  const plan = {
    noClobber: true, sameChecksum: true, observedStateRequired: true,
    rollback: { strategy: 'withdraw-run-created-materialization', preservePreexisting: true },
    withdrawal: { allowed: true, byRunId: true, refusePreexisting: true },
    items: [{ itemId, approvalId, approvalStatus: 'PENDING', sourceDigest: approvalEvidence.sourceRealPathDigest, destinationDigest: approvalEvidence.destinationPathDigest }],
  };
  const preflightReport = buildLivePreflightPlan({ plan });
  const gate = buildExecutionAuthorization({
    approvalEvidence, approvalValidation, preflightPlan: plan, preflightReport,
    preflightSelfDigest: verifySelfDigests([preflightReport]),
  });
  assertEq(gate.overall, 'EXECUTION_AUTHORIZATION_TEMPLATE_READY', `precondition: gate ready (${gate.blockers.join(',')})`);
  return gate as unknown as Rec;
}

// A SYNTHETIC APPROVED Phase 232 authorization. Synthetic on purpose: no approved authorization -- and so no
// recorded observation and no accepted disposition -- exists for the real P227-A bundle.
function approvedAuthorizationFor(root: string, o: ChainOpts = {}): Rec {
  const gate = gateFor(root, o);
  const skeleton = buildExecutionAuthorizationRecordSkeleton(gate);
  assert(skeleton !== null, 'precondition: authorization skeleton emitted');
  const auth = buildExecutionAuthorizationRecord({
    gate,
    record: {
      ...JSON.parse(JSON.stringify(skeleton)) as Rec,
      decision: 'APPROVED', operatorDigest: OPERATOR_DIGEST, decidedAtUtc: DECIDED_AT,
      // The operator pins the state they witnessed; the observation below must report exactly this one.
      observedStateBeforeDigest: STATE_BEFORE,
      fields: { operatorAuthorized: 'AFFIRMED', observedStateWitnessedBefore: 'AFFIRMED', withdrawalPathRehearsed: 'AFFIRMED', observedStateWitnessedAfter: 'PENDING', runExecutedByHuman: 'PENDING' },
    },
  });
  assertEq(auth.overall, 'EXECUTION_AUTHORIZATION_RECORD_APPROVED', `precondition: authorization approved (${auth.blockers.join(',')})`);
  return auth as unknown as Rec;
}

// A SYNTHETIC RECORDED Phase 233 observation.
function recordedObservationFor(root: string, o: ChainOpts = {}): Rec {
  const auth = approvedAuthorizationFor(root, o);
  const skeleton = buildPostRunObservationSkeleton(auth);
  assert(skeleton !== null, 'precondition: observation skeleton emitted');
  const outcome = o.outcome ?? 'COMPLETED';
  const after = outcome === 'COMPLETED' ? STATE_AFTER : STATE_BEFORE;
  const report = buildPostRunObservationRecord({
    authorizationRecord: auth,
    observation: {
      ...JSON.parse(JSON.stringify(skeleton)) as Rec,
      observedRunOutcome: outcome,
      observedStateBeforeDigest: STATE_BEFORE,
      observedStateAfterDigest: after,
      preexistingPreserved: true,
      withdrewOnlyRunCreatedMaterialization: true,
      observerDigest: OBSERVER_DIGEST,
      observedAtUtc: OBSERVED_AT,
      ...(o.withdrawn ? { withdrawal: 'PERFORMED', observedStateAfterWithdrawalDigest: STATE_BEFORE } : {}),
    },
  });
  assertEq(report.overall, 'POST_RUN_OBSERVATION_RECORDED', `precondition: observation recorded (${report.blockers.join(',')})`);
  return report as unknown as Rec;
}

// A SYNTHETIC ACCEPTED Phase 234 disposition -- the thing Phase 235 closes out.
function acceptedDispositionFor(root: string, o: ChainOpts = {}): Rec {
  const obs = recordedObservationFor(root, o);
  const skeleton = buildPostRunDispositionSkeleton(obs);
  assert(skeleton !== null, 'precondition: disposition skeleton emitted');
  const report = buildPostRunDispositionRecord({
    observationRecord: obs,
    disposition: {
      ...JSON.parse(JSON.stringify(skeleton)) as Rec,
      reviewerDigest: REVIEWER_DIGEST, reviewedAtUtc: REVIEWED_AT,
      fields: {
        outcomeAccepted: 'AFFIRMED', observedOutcomeReviewed: 'AFFIRMED',
        preexistingIntegrityConfirmed: 'AFFIRMED', evidenceRetainedOutOfBand: 'AFFIRMED', remediationPerformed: 'PENDING',
      },
    },
  });
  assertEq(report.overall, 'POST_RUN_DISPOSITION_ACCEPTED', `precondition: disposition accepted (${report.blockers.join(',')})`);
  return report as unknown as Rec;
}

// A genuine but REJECTED Phase 234 disposition: valid, and deliberately nothing Phase 235 may close.
function rejectedDispositionFor(root: string, o: ChainOpts = {}): Rec {
  const obs = recordedObservationFor(root, o);
  const skeleton = buildPostRunDispositionSkeleton(obs)!;
  const report = buildPostRunDispositionRecord({
    observationRecord: obs,
    disposition: {
      ...JSON.parse(JSON.stringify(skeleton)) as Rec,
      reviewerDigest: REVIEWER_DIGEST, reviewedAtUtc: REVIEWED_AT,
      fields: {
        outcomeAccepted: 'REFUSED', observedOutcomeReviewed: 'AFFIRMED',
        preexistingIntegrityConfirmed: 'PENDING', evidenceRetainedOutOfBand: 'PENDING', remediationPerformed: 'PENDING',
      },
    },
  });
  assertEq(report.overall, 'POST_RUN_DISPOSITION_REJECTED', `precondition: disposition rejected (${report.blockers.join(',')})`);
  return report as unknown as Rec;
}

function skeletonOf(disp: unknown): Rec {
  const skeleton = buildOperationClosureSkeleton(disp);
  assert(skeleton !== null, 'precondition: closure skeleton emitted for an accepted disposition');
  return JSON.parse(JSON.stringify(skeleton)) as Rec;
}
function closureFor(disp: unknown, over: Rec = {}): Rec {
  const skeleton = skeletonOf(disp);
  const fields = { ...(skeleton.fields as Rec), ...((over.fields as Rec) ?? {}) };
  return { ...skeleton, ...over, fields };
}
// A complete human CLOSURE: evidence archived, chain digests recorded alongside it, nothing outstanding.
function closedRecord(disp: unknown, over: Rec = {}): Rec {
  const { fields: overFields, ...rest } = over;
  return closureFor(disp, {
    closerDigest: CLOSER_DIGEST, closedAtUtc: CLOSED_AT,
    ...rest,
    fields: {
      closureAffirmed: 'AFFIRMED', evidenceArchivedOutOfBand: 'AFFIRMED',
      chainDigestsRecordedInArchive: 'AFFIRMED', noOutstandingRemediation: 'AFFIRMED',
      evidencePurged: 'PENDING', ...((overFields as Rec) ?? {}),
    },
  });
}

console.log('Running Phase 235 operation closure record suite:\n');

await test('a complete human CLOSURE is recorded -- and this tool still archived and purged nothing', () => {
  const root = workspace();
  try {
    const disp = acceptedDispositionFor(root);
    const c = buildOperationClosureRecord({ dispositionRecord: disp, closure: closedRecord(disp) });
    assertEq(c.overall, 'OPERATION_CLOSURE_CLOSED', `closed (blockers: ${c.blockers.join(',')})`);
    assertEq(c.recordedClosure, 'CLOSED', 'closure echoed');
    assertEq(c.operationClosed, true, 'the operation is closed out');
    assertEq(c.closedOutcome, 'COMPLETED', 'closed outcome echoed');
    assertEq(c.archivalAffirmed, true, 'archival affirmed');
    assert(c.dispositionCloseable && c.closureWellFormed && c.closureRedactionSafe && c.closureBound && c.closureCoherent, 'all five checks green');
    assertEq(c.blockers.length, 0, 'no blockers');
    // Recording a closure is not performing one.
    assertEq(c.closedByThisTool, false, 'this tool closed nothing');
    assertEq(c.archivedByThisTool, false, 'this tool archived nothing');
    assertEq(c.purgedByThisTool, false, 'this tool purged nothing');
    assertEq(c.purgedByThisTool, false, 'this tool purged nothing');
    assert(!('evidencePurged' in (c as unknown as Rec)), 'the report never attests to whether evidence still exists');
    assertEq(c.selfAuthorized, false, 'never self-authorized');
    assertEq(c.fieldStates.evidencePurged, 'PENDING', 'purge field still PENDING');
    assertEq(c.remainingHumanSteps.length, OPERATION_CLOSURE_REMAINING_HUMAN_STEPS.length, 'remaining human steps stated');
    assertEq(c.disclaimers.length, OPERATION_CLOSURE_DISCLAIMERS.length, 'disclaimers stated');
    assertEq(verifySelfDigests([c]).overall, 'ALL_VERIFIED', 'closure report self-verifies');
    for (const k of ['disposition-record', 'operation-approval-id', 'operation-item', 'operation-source', 'operation-destination', 'operation-plan']) {
      assert(k in c.boundDigests, `${k} bound`);
    }
    const json = JSON.stringify(c);
    assert(!json.includes('/mnt/') && !json.includes('catalog-authority-test-library'), 'no raw path in report');
    assert(!json.includes('phase-235-synthetic-test') && !json.includes('0a40074065d91a75ad41f33fc212e917'), 'no raw approval or item id in report');
    assert(!json.includes(CLOSER_DIGEST) && !json.includes('phase-235-closer-under-test'), 'no closer identity in report');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BLOCKED by default: with no disposition and no closure the chain is NOT_CLOSEABLE', () => {
  const c = buildOperationClosureRecord({});
  assertEq(c.overall, 'OPERATION_CLOSURE_NOT_CLOSEABLE', 'not closeable without inputs');
  assertEq(c.recordedClosure, 'NONE', 'no closure');
  assertEq(c.operationClosed, false, 'nothing closed');
  assertEq(c.closedOutcome, 'NONE', 'no outcome');
  assertEq(c.archivalAffirmed, false, 'nothing archived');
  assert(c.blockers.includes('DISPOSITION_RECORD_MISSING') && c.blockers.includes('CLOSURE_MISSING'), 'both inputs reported missing');
  assert(!c.dispositionCloseable && !c.closureWellFormed && !c.closureBound && !c.closureCoherent, 'nothing valid or bound');
  assertEq(c.purgedByThisTool, false, 'nothing purged by this tool');
  assert(c.redactionSafe === true && !JSON.stringify(c).includes('/mnt/'), 'redaction-safe');
});

await test('the emitted skeleton pre-affirms nothing: it validates as PENDING and closes nothing', () => {
  const root = workspace();
  try {
    const disp = acceptedDispositionFor(root);
    const skeleton = skeletonOf(disp);
    assertEq(skeleton.record, OPERATION_CLOSURE_INPUT_ID, 'skeleton is a closure input');
    assertEq(skeleton.closerDigest, 'PENDING', 'skeleton names no closer');
    assertEq(skeleton.closedAtUtc, 'PENDING', 'skeleton records no time');
    assert(Object.values(skeleton.fields as Rec).every((v) => v === 'PENDING'), 'every skeleton field PENDING');
    // Only derived bindings are pre-filled: the digests and the outcome under closure, never a judgement.
    assertEq(skeleton.closedOutcome, 'COMPLETED', 'the outcome under closure is a derived binding');
    assert(Object.values(skeleton).every((v) => v !== true && v !== 'AFFIRMED'), 'the skeleton affirms nothing');
    const c = buildOperationClosureRecord({ dispositionRecord: disp, closure: skeleton });
    assertEq(c.overall, 'OPERATION_CLOSURE_PENDING', `skeleton is valid but undecided (${c.blockers.join(',')})`);
    assertEq(c.recordedClosure, 'PENDING', 'closure PENDING');
    assertEq(c.operationClosed, false, 'a blank skeleton closes nothing');
    assertEq(c.archivalAffirmed, false, 'a blank skeleton archives nothing');
    assert(c.closureBound && c.closureCoherent, 'skeleton is bound and coherent');
    assert(!JSON.stringify(skeleton).includes('/mnt/'), 'skeleton is redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// An operation may only be closed where it was actually accepted. A PENDING or REJECTED disposition is a
// genuine, valid Phase 234 report -- it just never accepted anything.
await test('a PENDING or REJECTED disposition is NOT_CLOSEABLE, not INVALID', () => {
  const root = workspace();
  try {
    const accepted = acceptedDispositionFor(root);
    // An undecided review.
    const obs = recordedObservationFor(root, { itemId: '11111111111111111111111111111111', approvalId: 'phase-235-pending', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-pending')]) });
    const pendingDisp = buildPostRunDispositionRecord({ observationRecord: obs, disposition: buildPostRunDispositionSkeleton(obs)! });
    assertEq(pendingDisp.overall, 'POST_RUN_DISPOSITION_PENDING', 'precondition: a genuine but undecided disposition');
    assertEq(verifySelfDigests([pendingDisp]).overall, 'ALL_VERIFIED', 'precondition: it is genuine');
    assertEq(buildOperationClosureSkeleton(pendingDisp), null, 'no closure skeleton for an unaccepted disposition');
    const p = buildOperationClosureRecord({ dispositionRecord: pendingDisp, closure: closedRecord(accepted) });
    assertEq(p.overall, 'OPERATION_CLOSURE_NOT_CLOSEABLE', 'nothing to close over an undecided review');
    assert(p.blockers.includes('DISPOSITION_RECORD_NOT_ACCEPTED'), 'DISPOSITION_RECORD_NOT_ACCEPTED reported');
    assert(p.blockers.includes('DISPOSITION_RECORD_NOT_MARKED_ACCEPTED'), 'DISPOSITION_RECORD_NOT_MARKED_ACCEPTED reported');
    assertEq(p.operationClosed, false, 'nothing closed');

    // A review that explicitly refused the outcome is likewise nothing to close.
    const rejectedDisp = rejectedDispositionFor(root, { itemId: '22222222222222222222222222222222', approvalId: 'phase-235-rejected', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-rejected')]) });
    assertEq(buildOperationClosureSkeleton(rejectedDisp), null, 'no closure skeleton for a rejected disposition');
    const r = buildOperationClosureRecord({ dispositionRecord: rejectedDisp, closure: closedRecord(accepted) });
    assertEq(r.overall, 'OPERATION_CLOSURE_NOT_CLOSEABLE', 'a rejected run cannot be closed out');
    assert(r.blockers.includes('DISPOSITION_RECORD_NOT_ACCEPTED'), 'rejection -> DISPOSITION_RECORD_NOT_ACCEPTED');
    assertEq(r.recordedClosure, 'NONE', 'no closure recorded');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The precedence rule: an unclosable chain stays NOT_CLOSEABLE even when the closure record is ALSO broken.
await test('NOT_CLOSEABLE takes precedence over a broken closure record', () => {
  const root = workspace();
  try {
    const obs = recordedObservationFor(root);
    const pendingDisp = buildPostRunDispositionRecord({ observationRecord: obs, disposition: buildPostRunDispositionSkeleton(obs)! });
    for (const broken of [undefined, 'not-an-object', { record: 'wrong' }, [] as unknown]) {
      const c = buildOperationClosureRecord({ dispositionRecord: pendingDisp, closure: broken });
      assertEq(c.overall, 'OPERATION_CLOSURE_NOT_CLOSEABLE', 'unclosable chain wins over a broken closure');
      assertEq(c.operationClosed, false, 'nothing closed');
    }
    // And an entirely absent disposition with a perfectly good closure is still NOT_CLOSEABLE.
    const accepted = acceptedDispositionFor(root, { itemId: '33333333333333333333333333333333', approvalId: 'phase-235-absent', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-absent')]) });
    const c = buildOperationClosureRecord({ closure: closedRecord(accepted) });
    assertEq(c.overall, 'OPERATION_CLOSURE_NOT_CLOSEABLE', 'absent disposition -> NOT_CLOSEABLE');
    assert(c.blockers.includes('DISPOSITION_RECORD_MISSING'), 'DISPOSITION_RECORD_MISSING reported');
    assertEq(c.operationClosed, false, 'a good closure over nothing closes nothing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE security case, inherited down the chain: a closure of ONE operation must not be replayable.
await test('THE security case: a closure cannot be transplanted onto a different disposition', () => {
  const root = workspace();
  try {
    const dispA = acceptedDispositionFor(root);
    const dispB = acceptedDispositionFor(root, { itemId: '99999999999999999999999999999999', approvalId: 'phase-235-other', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-other')]) });
    const closureA = closedRecord(dispA);
    assertEq(buildOperationClosureRecord({ dispositionRecord: dispA, closure: closureA }).overall, 'OPERATION_CLOSURE_CLOSED', 'precondition: genuine closure of A');
    const c = buildOperationClosureRecord({ dispositionRecord: dispB, closure: closureA });
    assertEq(c.overall, 'OPERATION_CLOSURE_INVALID', 'transplanted closure rejected');
    assertEq(c.operationClosed, false, 'no closure carried over');
    assert(c.blockers.includes('CLOSURE_NOT_BOUND_TO_DISPOSITION'), 'disposition digest mismatch reported');
    assert(c.blockers.includes('CLOSURE_ITEM_DIGEST_MISMATCH') && c.blockers.includes('CLOSURE_SOURCE_DIGEST_MISMATCH'), 'operation digest mismatches reported');
    assertEq(Object.keys(c.boundDigests).length, 1, 'only the valid disposition itself is bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a green-bodied but tampered Phase 234 record fails on digest recompute', () => {
  const root = workspace();
  try {
    const disp = acceptedDispositionFor(root);
    const closure = closedRecord(disp);
    const tampered = JSON.parse(JSON.stringify(disp)) as Rec;
    assertEq(tampered.overall, 'POST_RUN_DISPOSITION_ACCEPTED', 'precondition: green');
    tampered.injectedClaim = 'smuggled-through-a-green-disposition';
    const c = buildOperationClosureRecord({ dispositionRecord: tampered, closure });
    assertEq(c.overall, 'OPERATION_CLOSURE_NOT_CLOSEABLE', 'a tampered disposition is not closeable');
    assert(c.blockers.includes('DISPOSITION_RECORD_DIGEST_MISMATCH'), 'green-body tamper -> DISPOSITION_RECORD_DIGEST_MISMATCH');
    assert(!c.dispositionCloseable && !c.closureBound, 'nothing bound to a tampered disposition');
    assertEq(Object.keys(c.boundDigests).length, 0, 'no digests bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A self-digest is not a signature: anyone can recompute one. So the semantic checks on the disposition are NOT
// unreachable behind the digest check -- a forger who rebuilds the digest walks straight into them.
await test('adversarial: a FORGED Phase 234 record that recomputes its own digest is still caught by the semantic checks', () => {
  const root = workspace();
  try {
    const disp = acceptedDispositionFor(root);
    const closure = closedRecord(disp);
    const forge = (mutate: (r: Rec) => void): Rec => {
      const forged = JSON.parse(JSON.stringify(disp)) as Rec;
      mutate(forged);
      delete forged.dispositionDigest;
      const body: Rec = {};
      for (const k of Object.keys(forged)) body[k] = forged[k];
      forged.dispositionDigest = createHash('sha256').update(`phase-234-post-run-disposition-record:${JSON.stringify(body)}`).digest('hex');
      return forged;
    };
    const cases: Array<[string, (r: Rec) => void, string]> = [
      ['a claim the disposition itself reviewed the run', (r) => { r.reviewedByThisTool = true; }, 'DISPOSITION_RECORD_REVIEWED_CLAIMED'],
      ['a claim the disposition performed the run', (r) => { r.performedByThisTool = true; }, 'DISPOSITION_RECORD_PERFORMED_CLAIMED'],
      ['a claim the disposition captured the state', (r) => { r.capturedByThisTool = true; }, 'DISPOSITION_RECORD_CAPTURED_CLAIMED'],
      ['a self-authorized disposition', (r) => { r.selfAuthorized = true; }, 'DISPOSITION_RECORD_SELF_AUTHORIZED'],
      ['an ACCEPTED overall with the accepted flag quietly false', (r) => { r.dispositionAccepted = false; }, 'DISPOSITION_RECORD_NOT_MARKED_ACCEPTED'],
      ['a disposition with its chain bindings stripped', (r) => { r.boundDigests = {}; }, 'DISPOSITION_RECORD_BINDINGS_INCOMPLETE'],
      ['an out-of-enum reviewed outcome', (r) => { r.reviewedOutcome = 'PROBABLY_FINE'; }, 'DISPOSITION_RECORD_OUTCOME_INVALID'],
    ];
    for (const [what, mutate, code] of cases) {
      const forged = forge(mutate);
      // The forgery is internally consistent -- the digest check alone would wave it through.
      assertEq(verifySelfDigests([forged]).overall, 'ALL_VERIFIED', `precondition: ${what} recomputes cleanly`);
      const c = buildOperationClosureRecord({ dispositionRecord: forged, closure });
      assertEq(c.overall, 'OPERATION_CLOSURE_NOT_CLOSEABLE', `forged disposition is not closeable: ${what}`);
      assert(!c.blockers.includes('DISPOSITION_RECORD_DIGEST_MISMATCH'), `${what}: the digest check does NOT catch this -- the semantic check must`);
      assert(c.blockers.includes(code), `${what} -> ${code}`);
      assertEq(c.operationClosed, false, `nothing closed over a forged disposition: ${what}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE HEADLINE INVARIANT: closure is archival, never erasure.
await test('THE archival rule: no valid record may EVER claim the evidence was purged', () => {
  const root = workspace();
  try {
    const disp = acceptedDispositionFor(root);
    // The purge claim is refused whatever the decision -- closing, holding open, or undecided.
    const decisions: Array<[string, string]> = [['AFFIRMED', 'a closure'], ['REFUSED', 'a hold-open'], ['PENDING', 'an undecided record']];
    for (const [state, what] of decisions) {
      const purged = closedRecord(disp, {
        ...(state === 'PENDING' ? { closerDigest: 'PENDING', closedAtUtc: 'PENDING' } : {}),
        fields: { closureAffirmed: state, evidencePurged: 'AFFIRMED' },
      });
      const c = buildOperationClosureRecord({ dispositionRecord: disp, closure: purged });
      assertEq(c.overall, 'OPERATION_CLOSURE_INVALID', `${what} claiming a purge is rejected`);
      assert(c.blockers.includes('CLOSURE_EVIDENCE_PURGE_CLAIMED'), `${what} -> CLOSURE_EVIDENCE_PURGE_CLAIMED`);
      assertEq(c.operationClosed, false, 'nothing closed by destroying its own record');
      assertEq(c.purgedByThisTool, false, 'the report never reports a purge of its own');
    }
    // Even REFUSING the purge explicitly is not PENDING: the field is untouchable.
    const refused = closedRecord(disp, { fields: { evidencePurged: 'REFUSED' } });
    assert(buildOperationClosureRecord({ dispositionRecord: disp, closure: refused }).blockers.includes('CLOSURE_EVIDENCE_PURGE_CLAIMED'), 'even a REFUSED purge field is a claim');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: closing without archival, or with remediation outstanding, fails closed', () => {
  const root = workspace();
  try {
    const disp = acceptedDispositionFor(root);
    for (const missing of ['evidenceArchivedOutOfBand', 'chainDigestsRecordedInArchive']) {
      const c = buildOperationClosureRecord({ dispositionRecord: disp, closure: closedRecord(disp, { fields: { [missing]: 'PENDING' } }) });
      assertEq(c.overall, 'OPERATION_CLOSURE_INVALID', `closing without ${missing} rejected`);
      assert(c.blockers.includes('CLOSURE_CLOSED_WITHOUT_ARCHIVAL'), `${missing} -> CLOSURE_CLOSED_WITHOUT_ARCHIVAL`);
      assertEq(c.archivalAffirmed, false, 'archival not affirmed');
      assertEq(c.operationClosed, false, 'nothing closed');
    }
    // An operation with work still owed to it is not finished.
    const outstanding = buildOperationClosureRecord({ dispositionRecord: disp, closure: closedRecord(disp, { fields: { noOutstandingRemediation: 'PENDING' } }) });
    assertEq(outstanding.overall, 'OPERATION_CLOSURE_INVALID', 'closing with remediation outstanding rejected');
    assert(outstanding.blockers.includes('CLOSURE_CLOSED_WITH_OUTSTANDING_REMEDIATION'), 'outstanding remediation -> CLOSURE_CLOSED_WITH_OUTSTANDING_REMEDIATION');
    const refusedRemediation = buildOperationClosureRecord({ dispositionRecord: disp, closure: closedRecord(disp, { fields: { noOutstandingRemediation: 'REFUSED' } }) });
    assert(refusedRemediation.blockers.includes('CLOSURE_CLOSED_WITH_OUTSTANDING_REMEDIATION'), 'explicitly outstanding remediation blocks closure too');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// HELD_OPEN is the conservative verdict and is never refused.
await test('HELD_OPEN is always available, even where CLOSED would be refused', () => {
  const root = workspace();
  try {
    const disp = acceptedDispositionFor(root);
    // Nothing archived, remediation outstanding -- a state in which CLOSED is impossible.
    const held = closureFor(disp, {
      closerDigest: CLOSER_DIGEST, closedAtUtc: CLOSED_AT,
      fields: { closureAffirmed: 'REFUSED' },
    });
    const c = buildOperationClosureRecord({ dispositionRecord: disp, closure: held });
    assertEq(c.overall, 'OPERATION_CLOSURE_HELD_OPEN', `hold-open recorded (${c.blockers.join(',')})`);
    assertEq(c.recordedClosure, 'HELD_OPEN', 'hold-open echoed');
    assertEq(c.operationClosed, false, 'holding open closes nothing');
    assertEq(c.archivalAffirmed, false, 'nothing archived');
    assert(c.closureBound && c.closureCoherent, 'a hold-open is still a bound, coherent record');
    // Confirm the same state genuinely cannot be CLOSED -- so the hold-open was not merely the easy path.
    const wouldBeClosed = { ...held, fields: { ...(held.fields as Rec), closureAffirmed: 'AFFIRMED' } };
    assertEq(buildOperationClosureRecord({ dispositionRecord: disp, closure: wouldBeClosed }).overall, 'OPERATION_CLOSURE_INVALID', 'the same unarchived state cannot be CLOSED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: closing a different outcome than was dispositioned fails closed', () => {
  const root = workspace();
  try {
    const disp = acceptedDispositionFor(root);
    const c = buildOperationClosureRecord({ dispositionRecord: disp, closure: closedRecord(disp, { closedOutcome: 'FAILED' }) });
    assertEq(c.overall, 'OPERATION_CLOSURE_INVALID', 'wrong outcome rejected');
    assert(c.blockers.includes('CLOSURE_CLOSED_OUTCOME_MISMATCH'), 'wrong outcome -> CLOSURE_CLOSED_OUTCOME_MISMATCH');
    assertEq(c.operationClosed, false, 'nothing closed');
    // A withdrawn FAILED run is closeable on its own terms, and its closure must say FAILED.
    const failed = acceptedDispositionFor(root, { outcome: 'FAILED', withdrawn: true, itemId: '44444444444444444444444444444444', approvalId: 'phase-235-failed', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-failed')]) });
    const good = buildOperationClosureRecord({ dispositionRecord: failed, closure: closedRecord(failed) });
    assertEq(good.overall, 'OPERATION_CLOSURE_CLOSED', `withdrawn failure closeable (${good.blockers.join(',')})`);
    assertEq(good.closedOutcome, 'FAILED', 'FAILED echoed');
    const wrong = buildOperationClosureRecord({ dispositionRecord: failed, closure: closedRecord(failed, { closedOutcome: 'COMPLETED' }) });
    assert(wrong.blockers.includes('CLOSURE_CLOSED_OUTCOME_MISMATCH'), 'a failure closed as a completion is rejected');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: closer digest and closing time must match the decision state', () => {
  const root = workspace();
  try {
    const disp = acceptedDispositionFor(root);
    const anonymous = buildOperationClosureRecord({ dispositionRecord: disp, closure: closedRecord(disp, { closerDigest: 'PENDING' }) });
    assert(anonymous.blockers.includes('CLOSURE_CLOSER_DIGEST_REQUIRED'), 'a closure must name its closer by digest');
    assertEq(anonymous.operationClosed, false, 'anonymous closure rejected');
    const undated = buildOperationClosureRecord({ dispositionRecord: disp, closure: closedRecord(disp, { closedAtUtc: '21 July 2026' }) });
    assert(undated.blockers.includes('CLOSURE_CLOSED_AT_REQUIRED'), 'a closure must carry a strict UTC timestamp');
    // An undecided record that quietly names a closer is not undecided.
    const predated = buildOperationClosureRecord({ dispositionRecord: disp, closure: closureFor(disp, { closerDigest: CLOSER_DIGEST }) });
    assert(predated.blockers.includes('CLOSURE_CLOSER_DIGEST_NOT_PENDING'), 'an undecided closure may not name a closer');
    const pretimed = buildOperationClosureRecord({ dispositionRecord: disp, closure: closureFor(disp, { closedAtUtc: CLOSED_AT }) });
    assert(pretimed.blockers.includes('CLOSURE_CLOSED_AT_NOT_PENDING'), 'an undecided closure may not carry a time');
    // Partial affirmation mid-close is legitimate and stays PENDING, closing nothing.
    const midReview = buildOperationClosureRecord({ dispositionRecord: disp, closure: closureFor(disp, { fields: { evidenceArchivedOutOfBand: 'AFFIRMED' } }) });
    assertEq(midReview.overall, 'OPERATION_CLOSURE_PENDING', `a part-done close is still PENDING (${midReview.blockers.join(',')})`);
    assertEq(midReview.operationClosed, false, 'a part-done close closes nothing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A human writes this record while archiving the evidence -- a likely place for a real path to leak in.
await test('adversarial: a smuggled raw path in the closure fails closed and is never echoed', () => {
  const root = workspace();
  try {
    const disp = acceptedDispositionFor(root);
    const smuggled = { ...closedRecord(disp), archiveNote: '/mnt/user/media/Movies/Closure Proof (2026)/source.mp4' };
    const c = buildOperationClosureRecord({ dispositionRecord: disp, closure: smuggled });
    assertEq(c.overall, 'OPERATION_CLOSURE_INVALID', 'smuggled path rejected');
    assert(c.blockers.includes('CLOSURE_LIVE_SURFACE'), 'raw path -> CLOSURE_LIVE_SURFACE');
    assert(c.blockers.includes('CLOSURE_UNKNOWN_FIELD'), 'off-allowlist field -> CLOSURE_UNKNOWN_FIELD');
    assert(!c.closureRedactionSafe, 'closure not redaction-safe');
    const json = JSON.stringify(c);
    assert(!json.includes('/mnt/') && !json.includes('source.mp4'), 'the smuggled path is never echoed back');
    // An off-allowlist field is rejected even when it carries nothing sensitive at all.
    const benign = buildOperationClosureRecord({ dispositionRecord: disp, closure: { ...closedRecord(disp), notes: 'archived to the usual place' } });
    assertEq(benign.overall, 'OPERATION_CLOSURE_INVALID', 'unknown field rejected on its own');
    assert(benign.blockers.includes('CLOSURE_UNKNOWN_FIELD') && benign.closureRedactionSafe, 'unknown but redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: malformed enums, fields and non-single records fail closed', () => {
  const root = workspace();
  try {
    const disp = acceptedDispositionFor(root);
    const badOutcome = buildOperationClosureRecord({ dispositionRecord: disp, closure: closedRecord(disp, { closedOutcome: 'MOSTLY_FINE' }) });
    assert(badOutcome.blockers.includes('CLOSURE_CLOSED_OUTCOME_INVALID'), 'CLOSURE_CLOSED_OUTCOME_INVALID reported');
    const badState = buildOperationClosureRecord({ dispositionRecord: disp, closure: closedRecord(disp, { fields: { closureAffirmed: 'PROBABLY' } }) });
    assert(badState.blockers.includes('CLOSURE_FIELD_STATE_INVALID'), 'CLOSURE_FIELD_STATE_INVALID reported');
    const missingField = closedRecord(disp);
    delete (missingField.fields as Rec).evidencePurged;
    const short = buildOperationClosureRecord({ dispositionRecord: disp, closure: missingField });
    assert(short.blockers.includes('CLOSURE_FIELDS_INVALID'), 'a record missing the purge field is malformed');
    const badVersion = buildOperationClosureRecord({ dispositionRecord: disp, closure: closedRecord(disp, { version: 2 }) });
    assert(badVersion.blockers.includes('CLOSURE_VERSION_UNSUPPORTED'), 'CLOSURE_VERSION_UNSUPPORTED reported');
    const notSingle = buildOperationClosureRecord({ dispositionRecord: disp, closure: [closedRecord(disp)] });
    assert(notSingle.blockers.includes('CLOSURE_NOT_SINGLE'), 'CLOSURE_NOT_SINGLE reported');
    for (const r of [badOutcome, badState, short, badVersion, notSingle]) {
      assertEq(r.overall, 'OPERATION_CLOSURE_INVALID', 'malformed input rejected');
      assertEq(r.operationClosed, false, 'nothing closed');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI records a bound closure, writes a blank skeleton, and never echoes raw paths or ids', () => {
  const root = workspace();
  try {
    const disp = acceptedDispositionFor(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const dispPath = w('disp.json', disp);
    const closurePath = w('closure.json', closedRecord(disp));
    const heldPath = w('held.json', closureFor(disp, { closerDigest: CLOSER_DIGEST, closedAtUtc: CLOSED_AT, fields: { closureAffirmed: 'REFUSED' } }));
    const outPath = join(root, 'CLOSUREMARKER-out', 'closure-report.json');
    const skeletonPath = join(root, 'CLOSUREMARKER-out', 'skeleton.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-operation-closure-record-cli.ts', import.meta.url));
    const run = (args: readonly string[]) => spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], { cwd: projectRoot, encoding: 'utf8' });

    const ok = run(['--dispositionrecord', dispPath, '--closure', closurePath, '--out', outPath, '--skeletonout', skeletonPath]);
    assert(ok.error === undefined, `spawn ok: ${ok.error?.message ?? ''}`);
    assertEq(ok.status, 0, `CLOSED exit 0 (stderr: ${ok.stderr ?? ''})`);
    assert(existsSync(outPath) && existsSync(skeletonPath), 'report and skeleton written');
    const parsed = JSON.parse(ok.stdout ?? '') as Rec;
    assertEq(parsed.overall, 'OPERATION_CLOSURE_CLOSED', 'stdout overall');
    assertEq(parsed.operationClosed, true, 'stdout reports the closure');
    assertEq(parsed.purgedByThisTool, false, 'stdout purgedByThisTool false');
    assertEq(parsed.purgedByThisTool, false, 'stdout purgedByThisTool false');
    assertEq(parsed.skeletonWritten, true, 'stdout reports the skeleton');
    // The written skeleton is blank regardless of the closure it was emitted alongside.
    const skeleton = JSON.parse(readFileSync(skeletonPath, 'utf8')) as Rec;
    assert(Object.values(skeleton.fields as Rec).every((v) => v === 'PENDING'), 'written skeleton is blank');
    assertEq(skeleton.closerDigest, 'PENDING', 'written skeleton names no closer');
    const stdout = ok.stdout ?? '';
    assert(!stdout.includes('CLOSUREMARKER') && !stdout.includes('catalog-authority-test-library') && !stdout.includes('/mnt/'), 'no path fragments in stdout');
    assert(!stdout.includes('phase-235-synthetic-test') && !stdout.includes('0a40074065d91a75ad41f33fc212e917'), 'no raw ids in stdout');
    assert(!stdout.includes(CLOSER_DIGEST), 'no closer identity in stdout');

    // Every other exit path.
    assertEq(run(['--dispositionrecord', dispPath, '--closure', skeletonPath]).status, 3, 'blank closure exits 3');
    assertEq(run(['--dispositionrecord', dispPath, '--closure', heldPath]).status, 4, 'hold-open exits 4');
    assertEq(run(['--dispositionrecord', dispPath]).status, 1, 'missing closure over a closeable chain exits 1');
    const notCloseable = run(['--closure', closurePath]);
    assertEq(notCloseable.status, 5, 'absent disposition exits 5');
    assertEq((JSON.parse(notCloseable.stdout ?? '') as Rec).operationClosed, false, 'nothing closed');
    assertEq(run(['--dispositionrecord', join(dir, 'does-not-exist.json')]).status, 2, 'unreadable input exits 2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// UPSTREAM SEMANTIC VALIDATION, the same hardening one layer up. A green `overall` on a Phase 234 report is
// not evidence: a forger can rewrite the body, keep the headline green, and recompute the digest. These
// forgeries all recompute CLEANLY -- proven explicitly -- and are caught only because Phase 235 now requires
// every upstream success boolean, a decision consistent with that headline, redaction-safety, and no blockers.
function forgeDisposition(report: Rec, mutate: (r: Rec) => void): Rec {
  const forged = JSON.parse(JSON.stringify(report)) as Rec;
  mutate(forged);
  delete forged.dispositionDigest;
  const body: Rec = {};
  for (const k of Object.keys(forged)) body[k] = forged[k];
  forged.dispositionDigest = createHash('sha256').update(`phase-234-post-run-disposition-record:${JSON.stringify(body)}`).digest('hex');
  return forged;
}

await test('adversarial: a self-digest-valid Phase 234 report whose own success booleans are false is NOT_CLOSEABLE', () => {
  const root = workspace();
  try {
    const disp = acceptedDispositionFor(root);
    const cases: Array<[string, (r: Rec) => void, string]> = [
      ['the report is not redaction-safe', (r) => { r.redactionSafe = false; }, 'DISPOSITION_RECORD_NOT_REDACTION_SAFE'],
      ['the recorded decision is not ACCEPTED', (r) => { r.recordedDisposition = 'PENDING'; }, 'DISPOSITION_RECORD_DECISION_NOT_ACCEPTED'],
      ['nothing reviewable sat beneath it', (r) => { r.observationReviewable = false; }, 'DISPOSITION_RECORD_UPSTREAM_NOT_REVIEWABLE'],
      ['the disposition was not well-formed', (r) => { r.dispositionWellFormed = false; }, 'DISPOSITION_RECORD_NOT_WELL_FORMED'],
      ['the disposition input was not redaction-safe', (r) => { r.dispositionRedactionSafe = false; }, 'DISPOSITION_RECORD_INPUT_NOT_REDACTION_SAFE'],
      ['the disposition was not bound', (r) => { r.dispositionBound = false; }, 'DISPOSITION_RECORD_NOT_BOUND'],
      ['the disposition was not coherent', (r) => { r.dispositionCoherent = false; }, 'DISPOSITION_RECORD_NOT_COHERENT'],
      ['blockers were recorded under a green headline', (r) => { r.blockers = ['SOMETHING_FAILED']; }, 'DISPOSITION_RECORD_BLOCKERS_PRESENT'],
      ['blockers is not even a list', (r) => { r.blockers = 'none'; }, 'DISPOSITION_RECORD_BLOCKERS_PRESENT'],
    ];
    for (const [what, mutate, code] of cases) {
      const forged = forgeDisposition(disp, mutate);
      // Prove the forgery is self-digest valid: the digest check cannot see any of this.
      assertEq(verifySelfDigests([forged]).overall, 'ALL_VERIFIED', `precondition: ${what} recomputes cleanly`);
      assertEq((forged as Rec).overall, 'POST_RUN_DISPOSITION_ACCEPTED', `precondition: ${what} keeps a green headline`);
      const c = buildOperationClosureRecord({ dispositionRecord: forged, closure: closedRecord(disp) });
      assertEq(c.overall, 'OPERATION_CLOSURE_NOT_CLOSEABLE', `forged upstream rejected: ${what}`);
      assert(c.blockers.includes(code), `${what} -> ${code}`);
      assert(!c.blockers.includes('DISPOSITION_RECORD_DIGEST_MISMATCH'), `${what}: the digest check does NOT catch this`);
      assertEq(c.dispositionCloseable, false, `not closeable: ${what}`);
      assertEq(c.operationClosed, false, `nothing closed: ${what}`);
      assertEq(c.recordedClosure, 'NONE', `no closure recorded: ${what}`);
      assertEq(buildOperationClosureSkeleton(forged), null, `no skeleton for a forged upstream: ${what}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The ACTUAL prepared, redaction-safe P227-A evidence (captured verbatim from the non-live artifacts under
// evidence/phase-231). Locked here so the validator is exercised against the real chain offline and
// deterministically -- no SSH, no secret approval file, no live surface. NOTE: no approved authorization, no
// recorded observation, no accepted disposition and no closure is constructed for this bundle anywhere in this
// suite; the real run never happened.
const REAL_APPROVAL_EVIDENCE = {
  report: 'phase-230-promotion-approval-attestation', version: 1, mode: 'build', ok: true, redactionSafe: true,
  status: 'APPROVAL_ATTESTATION_READY',
  approvalIdDigest: '8f43ff3cd966c368b277a069560978fbcd2e1f15063d420058d5b7b3e0def477',
  itemDigest: 'c23dcefc87e63e8b10fb4c7dd67aac99a0fe512318c0c07c1323e889ffac9431',
  targetRoot: '/mnt/user/media/Movies',
  sourceRealPathDigest: '08505b269e54350636ebdf6969bcffcbc61f60a27de52449cf7b6c9871d5227f',
  sourceSha256: 'f61646264e3f8806ec43742abf75ed142731c57b4346327429dd62ab55afb7cb',
  destinationPathDigest: '099ec7872ddad5654f56aeb86ab3bde7a459d0864533169a70bacab6ef14b924',
  destinationNameDigest: '7383f885db60eaf9c3b18212c12caeaa121b13a362d956c7d4572025dd2b51cd',
  extension: '.mp4', sourceSizeBytes: 1636, titleEchoed: false, sourcePathEchoed: false, destinationPathEchoed: false,
  problems: [], evidenceDigest: '65c6f28e70a572ec99912f5f6140e41daa0f6eb27dcf9228b565ccd11c1e85c8',
};
const REAL_APPROVAL_VALIDATION = {
  ...REAL_APPROVAL_EVIDENCE, mode: 'validate',
  evidenceDigest: '4590bc443da55ad4b6354869c490015491723b533b13a49505fe9967035a8622',
};
const REAL_PREFLIGHT_PLAN = {
  noClobber: true, sameChecksum: true, observedStateRequired: true,
  rollback: { strategy: 'withdraw-run-created-materialization', preservePreexisting: true },
  withdrawal: { allowed: true, byRunId: true, refusePreexisting: true },
  items: [{
    itemId: '0a40074065d91a75ad41f33fc212e917', approvalId: 'phase-231-p227-a-20260720', approvalStatus: 'PENDING',
    sourceDigest: '08505b269e54350636ebdf6969bcffcbc61f60a27de52449cf7b6c9871d5227f',
    destinationDigest: '099ec7872ddad5654f56aeb86ab3bde7a459d0864533169a70bacab6ef14b924',
  }],
};

// The real chain, end to end and offline: gate -> 232 PENDING -> 233 INVALID -> 234 NOT_REVIEWABLE. It never
// reaches an approved authorization, a recorded observation, or an accepted disposition, because no human
// approved the run and no run happened. This function constructs none of them.
function realDispositionRecord(): Rec {
  const preflightReport = buildLivePreflightPlan({ plan: REAL_PREFLIGHT_PLAN });
  const gate = buildExecutionAuthorization({
    approvalEvidence: REAL_APPROVAL_EVIDENCE,
    approvalValidation: REAL_APPROVAL_VALIDATION,
    preflightPlan: REAL_PREFLIGHT_PLAN,
    preflightReport,
    preflightSelfDigest: verifySelfDigests([preflightReport]),
  });
  assertEq(gate.overall, 'EXECUTION_AUTHORIZATION_TEMPLATE_READY', `precondition: real gate ready (${gate.blockers.join(',')})`);
  const auth = buildExecutionAuthorizationRecord({ gate, record: buildExecutionAuthorizationRecordSkeleton(gate)! });
  assertEq(auth.overall, 'EXECUTION_AUTHORIZATION_RECORD_PENDING', 'the real run has no human approval');
  const obs = buildPostRunObservationRecord({ authorizationRecord: auth });
  assertEq(obs.overall, 'POST_RUN_OBSERVATION_INVALID', 'the real run has no observation');
  const disp = buildPostRunDispositionRecord({ observationRecord: obs });
  assertEq(disp.overall, 'POST_RUN_DISPOSITION_NOT_REVIEWABLE', 'the real run has nothing to review');
  return disp as unknown as Rec;
}

await test('the actual P227-A chain is LOCKED as NOT_CLOSEABLE: unauthorized, unrun, unobserved, unreviewed', () => {
  const disp = realDispositionRecord();
  assertEq(disp.dispositionAccepted, false, 'precondition: the real run was never accepted');
  assertEq(buildOperationClosureSkeleton(disp), null, 'no closure skeleton exists for the real chain');
  const c = buildOperationClosureRecord({ dispositionRecord: disp });
  assertEq(c.overall, 'OPERATION_CLOSURE_NOT_CLOSEABLE', 'the real chain has nothing to close');
  assertEq(c.recordedClosure, 'NONE', 'no closure for the real run');
  assertEq(c.operationClosed, false, 'the real run is NOT closed');
  assertEq(c.closedOutcome, 'NONE', 'no closed outcome');
  assertEq(c.archivalAffirmed, false, 'nothing archived');
  assertEq(c.purgedByThisTool, false, 'nothing purged by this tool');
  assertEq(c.dispositionCloseable, false, 'not closeable');
  assert(c.blockers.includes('DISPOSITION_RECORD_NOT_ACCEPTED'), 'DISPOSITION_RECORD_NOT_ACCEPTED reported');
  assertEq(c.closedByThisTool, false, 'this tool closed nothing');
  assertEq(c.archivedByThisTool, false, 'this tool archived nothing');
  assertEq(verifySelfDigests([c]).overall, 'ALL_VERIFIED', 'real-chain report self-verifies');
  const json = JSON.stringify(c);
  assert(!json.includes('/mnt/') && !json.includes('0a40074065d91a75ad41f33fc212e917') && !json.includes('phase-231-p227-a-20260720'), 'redaction-safe: no path, no raw ids');
});

// The lock cannot be talked out of: a perfectly-formed closure shaped for the real operation still cannot close
// a chain that was never authorized, never run, never observed and never reviewed.
await test('the actual P227-A chain stays NOT_CLOSEABLE even against a fully-formed CLOSED record', () => {
  const disp = realDispositionRecord();
  const shaped = {
    record: OPERATION_CLOSURE_INPUT_ID, version: 1, operation: 'promote-observe-withdraw',
    sourceDispositionRecord: 'phase-234-promotion-post-run-disposition-record',
    dispositionDigest: disp.dispositionDigest as string,
    approvalIdDigest: REAL_APPROVAL_EVIDENCE.approvalIdDigest, itemDigest: REAL_APPROVAL_EVIDENCE.itemDigest,
    sourceDigest: REAL_APPROVAL_EVIDENCE.sourceRealPathDigest, destinationDigest: REAL_APPROVAL_EVIDENCE.destinationPathDigest,
    planDigest: REAL_APPROVAL_EVIDENCE.sourceSha256,
    closedOutcome: 'COMPLETED',
    fields: {
      closureAffirmed: 'AFFIRMED', evidenceArchivedOutOfBand: 'AFFIRMED',
      chainDigestsRecordedInArchive: 'AFFIRMED', noOutstandingRemediation: 'AFFIRMED', evidencePurged: 'PENDING',
    },
    closerDigest: CLOSER_DIGEST, closedAtUtc: CLOSED_AT,
  };
  const c = buildOperationClosureRecord({ dispositionRecord: disp, closure: shaped });
  assertEq(c.overall, 'OPERATION_CLOSURE_NOT_CLOSEABLE', 'still not closeable');
  assertEq(c.operationClosed, false, 'the real P227-A run remains unclosed');
  assertEq(c.recordedClosure, 'NONE', 'no closure recorded');
  assert(!c.closureBound, 'nothing binds to an unclosable disposition');
  assertEq(Object.keys(c.boundDigests).length, 0, 'no digests bound');
  assert(c.blockers.includes('DISPOSITION_RECORD_NOT_ACCEPTED'), 'the unclosable chain is the finding');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
