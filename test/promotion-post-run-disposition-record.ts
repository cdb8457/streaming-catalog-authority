import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPostRunDispositionRecord,
  buildPostRunDispositionSkeleton,
  POST_RUN_DISPOSITION_INPUT_ID,
  POST_RUN_DISPOSITION_DISCLAIMERS,
  POST_RUN_DISPOSITION_REMAINING_HUMAN_STEPS,
} from '../src/ops/promotion-post-run-disposition-record.js';
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
const OPERATOR_DIGEST = createHash('sha256').update('phase-234-operator-under-test').digest('hex');
const OBSERVER_DIGEST = createHash('sha256').update('phase-234-observer-under-test').digest('hex');
const REVIEWER_DIGEST = createHash('sha256').update('phase-234-reviewer-under-test').digest('hex');
const DECIDED_AT = '2026-07-21T00:00:00Z';
const OBSERVED_AT = '2026-07-21T01:00:00Z';
const REVIEWED_AT = '2026-07-21T02:00:00Z';
// Synthetic observed-state digests. This suite observes nothing real; these stand for digests a human would
// have captured out-of-band.
const STATE_BEFORE = createHash('sha256').update('synthetic-observed-state-before').digest('hex');
const STATE_AFTER = createHash('sha256').update('synthetic-observed-state-after').digest('hex');

const MINIMAL_MP4_FIXTURE = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isomcatalog-authority-disposition-fixture', 'ascii'),
]);

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-disposition-')); }

type Rec = Record<string, unknown>;
interface ChainOpts { itemId?: string; approvalId?: string; body?: Buffer; outcome?: 'COMPLETED' | 'FAILED'; withdrawn?: boolean }

// A genuine Phase 231 gate over a SYNTHETIC one-item bundle.
function gateFor(root: string, o: ChainOpts = {}): Rec {
  const itemId = o.itemId ?? '0a40074065d91a75ad41f33fc212e917';
  const approvalId = o.approvalId ?? 'phase-234-synthetic-test';
  const testRoot = join(root, `catalog-authority-test-library-${itemId.slice(0, 8)}`);
  const source = join(testRoot, 'Movies', 'Disposition Proof (2026)', 'source.mp4');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, o.body ?? MINIMAL_MP4_FIXTURE);
  const input = { itemId, title: 'Disposition Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot: APPROVED_ROOT, approvalId };
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

// A SYNTHETIC APPROVED Phase 232 authorization. Synthetic on purpose: no approved authorization, and therefore
// no reviewable observation, exists for the real P227-A bundle.
function approvedAuthorizationFor(root: string, o: ChainOpts = {}): Rec {
  const gate = gateFor(root, o);
  const skeleton = buildExecutionAuthorizationRecordSkeleton(gate);
  assert(skeleton !== null, 'precondition: authorization skeleton emitted');
  const auth = buildExecutionAuthorizationRecord({
    gate,
    record: {
      ...JSON.parse(JSON.stringify(skeleton)) as Rec,
      decision: 'APPROVED', operatorDigest: OPERATOR_DIGEST, decidedAtUtc: DECIDED_AT,
      fields: { operatorAuthorized: 'AFFIRMED', observedStateWitnessedBefore: 'AFFIRMED', withdrawalPathRehearsed: 'AFFIRMED', observedStateWitnessedAfter: 'PENDING', runExecutedByHuman: 'PENDING' },
    },
  });
  assertEq(auth.overall, 'EXECUTION_AUTHORIZATION_RECORD_APPROVED', `precondition: authorization approved (${auth.blockers.join(',')})`);
  return auth as unknown as Rec;
}

// A SYNTHETIC RECORDED Phase 233 observation -- the thing Phase 234 reviews.
function recordedObservationFor(root: string, o: ChainOpts = {}): Rec {
  const auth = approvedAuthorizationFor(root, o);
  const skeleton = buildPostRunObservationSkeleton(auth);
  assert(skeleton !== null, 'precondition: observation skeleton emitted');
  const outcome = o.outcome ?? 'COMPLETED';
  // COMPLETED must show an observed change; FAILED need not. A withdrawn run must return to the before state.
  const after = outcome === 'COMPLETED' ? STATE_AFTER : STATE_BEFORE;
  const observation: Rec = {
    ...JSON.parse(JSON.stringify(skeleton)) as Rec,
    observedRunOutcome: outcome,
    observedStateBeforeDigest: STATE_BEFORE,
    observedStateAfterDigest: after,
    preexistingPreserved: true,
    withdrewOnlyRunCreatedMaterialization: true,
    observerDigest: OBSERVER_DIGEST,
    observedAtUtc: OBSERVED_AT,
    ...(o.withdrawn ? { withdrawal: 'PERFORMED', observedStateAfterWithdrawalDigest: STATE_BEFORE } : {}),
  };
  const report = buildPostRunObservationRecord({ authorizationRecord: auth, observation });
  assertEq(report.overall, 'POST_RUN_OBSERVATION_RECORDED', `precondition: observation recorded (${report.blockers.join(',')})`);
  assertEq(report.withdrawalProven, o.withdrawn === true, 'precondition: withdrawal proof as requested');
  return report as unknown as Rec;
}

function skeletonOf(obs: unknown): Rec {
  const skeleton = buildPostRunDispositionSkeleton(obs);
  assert(skeleton !== null, 'precondition: disposition skeleton emitted for a recorded observation');
  return JSON.parse(JSON.stringify(skeleton)) as Rec;
}
function dispositionFor(obs: unknown, over: Rec = {}): Rec {
  const skeleton = skeletonOf(obs);
  const fields = { ...(skeleton.fields as Rec), ...((over.fields as Rec) ?? {}) };
  return { ...skeleton, ...over, fields };
}
// A complete human ACCEPTANCE: every part of the review affirmed, reviewer and time named.
function acceptedDisposition(obs: unknown, over: Rec = {}): Rec {
  const { fields: overFields, ...rest } = over;
  return dispositionFor(obs, {
    reviewerDigest: REVIEWER_DIGEST, reviewedAtUtc: REVIEWED_AT,
    ...rest,
    fields: {
      outcomeAccepted: 'AFFIRMED', observedOutcomeReviewed: 'AFFIRMED',
      preexistingIntegrityConfirmed: 'AFFIRMED', evidenceRetainedOutOfBand: 'AFFIRMED',
      remediationPerformed: 'PENDING', ...((overFields as Rec) ?? {}),
    },
  });
}

console.log('Running Phase 234 post-run disposition record suite:\n');

await test('a complete human ACCEPTANCE is recorded -- and this tool still reviewed nothing', () => {
  const root = workspace();
  try {
    const obs = recordedObservationFor(root);
    const d = buildPostRunDispositionRecord({ observationRecord: obs, disposition: acceptedDisposition(obs) });
    assertEq(d.overall, 'POST_RUN_DISPOSITION_ACCEPTED', `accepted (blockers: ${d.blockers.join(',')})`);
    assertEq(d.recordedDisposition, 'ACCEPTED', 'decision echoed');
    assertEq(d.dispositionAccepted, true, 'an acceptance exists');
    assert(d.observationReviewable && d.dispositionWellFormed && d.dispositionRedactionSafe && d.dispositionBound && d.dispositionCoherent, 'all five checks green');
    assertEq(d.blockers.length, 0, 'no blockers');
    // Recording a review is not performing one.
    assertEq(d.reviewedByThisTool, false, 'this tool reviewed nothing');
    assertEq(d.performedByThisTool, false, 'this tool performed nothing');
    assertEq(d.capturedByThisTool, false, 'this tool captured nothing');
    assertEq(d.selfAuthorized, false, 'never self-authorized');
    assertEq(d.fieldStates.remediationPerformed, 'PENDING', 'no remediation claimed');
    assertEq(d.reviewedOutcome, 'COMPLETED', 'reviewed outcome echoed');
    assertEq(d.remainingHumanSteps.length, POST_RUN_DISPOSITION_REMAINING_HUMAN_STEPS.length, 'remaining human steps stated');
    assertEq(d.disclaimers.length, POST_RUN_DISPOSITION_DISCLAIMERS.length, 'disclaimers stated');
    assertEq(verifySelfDigests([d]).overall, 'ALL_VERIFIED', 'disposition report self-verifies');
    for (const k of ['observation-record', 'operation-approval-id', 'operation-item', 'operation-source', 'operation-destination', 'operation-plan']) {
      assert(k in d.boundDigests, `${k} bound`);
    }
    const json = JSON.stringify(d);
    assert(!json.includes('/mnt/') && !json.includes('catalog-authority-test-library'), 'no raw path in report');
    assert(!json.includes('phase-234-synthetic-test') && !json.includes('0a40074065d91a75ad41f33fc212e917'), 'no raw approval or item id in report');
    assert(!json.includes(REVIEWER_DIGEST) && !json.includes('phase-234-reviewer-under-test'), 'no reviewer identity in report');
    assert(!json.includes(STATE_BEFORE) && !json.includes(STATE_AFTER), 'no observed-state digests echoed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BLOCKED by default: with no observation and no disposition the chain is NOT_REVIEWABLE', () => {
  const d = buildPostRunDispositionRecord({});
  assertEq(d.overall, 'POST_RUN_DISPOSITION_NOT_REVIEWABLE', 'an absent chain is not reviewable');
  assertEq(d.recordedDisposition, 'NONE', 'no disposition');
  assertEq(d.dispositionAccepted, false, 'nothing accepted');
  assertEq(d.reviewedOutcome, 'NONE', 'no reviewed outcome');
  assertEq(d.withdrawalProvenUpstream, false, 'nothing proven upstream');
  assert(d.blockers.includes('OBSERVATION_RECORD_MISSING') && d.blockers.includes('DISPOSITION_MISSING'), 'both inputs reported missing');
  assert(!d.observationReviewable && !d.dispositionWellFormed && !d.dispositionBound, 'nothing valid or bound');
  assert(d.redactionSafe === true && !JSON.stringify(d).includes('/mnt/'), 'redaction-safe');
});

await test('the emitted skeleton pre-affirms nothing: it validates as PENDING and accepts nothing', () => {
  const root = workspace();
  try {
    const obs = recordedObservationFor(root);
    const skeleton = skeletonOf(obs);
    assertEq(skeleton.record, POST_RUN_DISPOSITION_INPUT_ID, 'skeleton is a disposition input');
    assertEq(skeleton.reviewerDigest, 'PENDING', 'skeleton names no reviewer');
    assertEq(skeleton.reviewedAtUtc, 'PENDING', 'skeleton records no time');
    assert(Object.values(skeleton.fields as Rec).every((v) => v === 'PENDING'), 'every skeleton field PENDING');
    assert(Object.values(skeleton).every((v) => v !== true && v !== 'AFFIRMED'), 'the skeleton affirms nothing');
    // The echo fields ARE pre-filled: they name WHAT is under review (a derived binding), not a judgement.
    assertEq(skeleton.reviewedOutcome, 'COMPLETED', 'skeleton names the outcome under review');
    const d = buildPostRunDispositionRecord({ observationRecord: obs, disposition: skeleton });
    assertEq(d.overall, 'POST_RUN_DISPOSITION_PENDING', `skeleton is valid but undecided (${d.blockers.join(',')})`);
    assertEq(d.recordedDisposition, 'PENDING', 'decision PENDING');
    assertEq(d.dispositionAccepted, false, 'a blank skeleton accepts nothing');
    assert(d.dispositionBound && d.dispositionCoherent, 'skeleton is bound and coherent');
    assert(!JSON.stringify(skeleton).includes('/mnt/'), 'skeleton is redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// NOT_REVIEWABLE is about the CHAIN, not the disposition: an observation that is genuine but merely PENDING
// (nothing was run) has nothing to review.
await test('a PENDING observation is NOT_REVIEWABLE, not INVALID', () => {
  const root = workspace();
  try {
    const recorded = recordedObservationFor(root);
    const auth = approvedAuthorizationFor(root, { itemId: '11111111111111111111111111111111', approvalId: 'phase-234-pending', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-pending')]) });
    const pendingObs = buildPostRunObservationRecord({ authorizationRecord: auth, observation: buildPostRunObservationSkeleton(auth)! });
    assertEq(pendingObs.overall, 'POST_RUN_OBSERVATION_PENDING', 'precondition: a genuine but empty observation');
    assertEq(verifySelfDigests([pendingObs]).overall, 'ALL_VERIFIED', 'precondition: it is genuine');
    assertEq(buildPostRunDispositionSkeleton(pendingObs), null, 'no disposition skeleton for an unreviewable observation');
    const d = buildPostRunDispositionRecord({ observationRecord: pendingObs, disposition: acceptedDisposition(recorded) });
    assertEq(d.overall, 'POST_RUN_DISPOSITION_NOT_REVIEWABLE', 'nothing to review');
    assert(d.blockers.includes('OBSERVATION_RECORD_NOT_RECORDED'), 'OBSERVATION_RECORD_NOT_RECORDED reported');
    assert(d.blockers.includes('OBSERVATION_RECORD_NOT_MARKED_RECORDED'), 'OBSERVATION_RECORD_NOT_MARKED_RECORDED reported');
    assertEq(d.dispositionAccepted, false, 'nothing accepted');
    assertEq(d.recordedDisposition, 'NONE', 'no disposition recorded');
    assert(!d.dispositionBound, 'nothing binds to an unreviewable observation');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The precedence rule: an unreviewable chain stays NOT_REVIEWABLE even when the disposition is ALSO broken.
// The chain's emptiness is the finding; a defect in a disposition over nothing is not.
await test('NOT_REVIEWABLE takes precedence over a broken disposition', () => {
  const root = workspace();
  try {
    const auth = approvedAuthorizationFor(root);
    const pendingObs = buildPostRunObservationRecord({ authorizationRecord: auth, observation: buildPostRunObservationSkeleton(auth)! });
    for (const broken of [undefined, 'not-an-object', { record: 'wrong' }, [] as unknown]) {
      const d = buildPostRunDispositionRecord({ observationRecord: pendingObs, disposition: broken });
      assertEq(d.overall, 'POST_RUN_DISPOSITION_NOT_REVIEWABLE', 'unreviewable chain wins over a broken disposition');
      assertEq(d.dispositionAccepted, false, 'nothing accepted');
    }
    // And an entirely absent observation with a perfectly good disposition is still NOT_REVIEWABLE.
    const recorded = recordedObservationFor(root, { itemId: '22222222222222222222222222222222', approvalId: 'phase-234-absent', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-absent')]) });
    const d = buildPostRunDispositionRecord({ disposition: acceptedDisposition(recorded) });
    assertEq(d.overall, 'POST_RUN_DISPOSITION_NOT_REVIEWABLE', 'absent observation -> NOT_REVIEWABLE');
    assert(d.blockers.includes('OBSERVATION_RECORD_MISSING'), 'OBSERVATION_RECORD_MISSING reported');
    assertEq(d.dispositionAccepted, false, 'a good disposition over nothing accepts nothing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE security case, inherited down the chain: a review of ONE operation must not be replayable.
await test('THE security case: a disposition cannot be transplanted onto a different observation', () => {
  const root = workspace();
  try {
    const obsA = recordedObservationFor(root);
    const obsB = recordedObservationFor(root, { itemId: '99999999999999999999999999999999', approvalId: 'phase-234-other', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-other')]) });
    const dispositionA = acceptedDisposition(obsA);
    assertEq(buildPostRunDispositionRecord({ observationRecord: obsA, disposition: dispositionA }).overall, 'POST_RUN_DISPOSITION_ACCEPTED', 'precondition: genuine acceptance of A');
    const d = buildPostRunDispositionRecord({ observationRecord: obsB, disposition: dispositionA });
    assertEq(d.overall, 'POST_RUN_DISPOSITION_INVALID', 'transplanted disposition rejected');
    assertEq(d.dispositionAccepted, false, 'no acceptance carried over');
    assert(d.blockers.includes('DISPOSITION_NOT_BOUND_TO_OBSERVATION'), 'observation digest mismatch reported');
    assert(d.blockers.includes('DISPOSITION_ITEM_DIGEST_MISMATCH') && d.blockers.includes('DISPOSITION_SOURCE_DIGEST_MISMATCH'), 'operation digest mismatches reported');
    assertEq(Object.keys(d.boundDigests).length, 1, 'only the valid observation itself is bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a green-bodied but tampered Phase 233 record fails on digest recompute', () => {
  const root = workspace();
  try {
    const obs = recordedObservationFor(root);
    const disposition = acceptedDisposition(obs);
    const tampered = JSON.parse(JSON.stringify(obs)) as Rec;
    assertEq(tampered.overall, 'POST_RUN_OBSERVATION_RECORDED', 'precondition: green');
    tampered.injectedClaim = 'smuggled-through-a-green-observation';
    const d = buildPostRunDispositionRecord({ observationRecord: tampered, disposition });
    assertEq(d.overall, 'POST_RUN_DISPOSITION_NOT_REVIEWABLE', 'a tampered observation is not reviewable');
    assert(d.blockers.includes('OBSERVATION_RECORD_DIGEST_MISMATCH'), 'green-body tamper -> OBSERVATION_RECORD_DIGEST_MISMATCH');
    assert(!d.observationReviewable && !d.dispositionBound, 'nothing bound to a tampered observation');
    assertEq(Object.keys(d.boundDigests).length, 0, 'no digests bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A self-digest is not a signature: anyone can recompute one. So the semantic checks on the observation are
// NOT unreachable behind the digest check -- a forger who rebuilds the digest walks straight into them.
await test('adversarial: a FORGED Phase 233 record that recomputes its own digest is still caught by the semantic checks', () => {
  const root = workspace();
  try {
    const obs = recordedObservationFor(root);
    const disposition = acceptedDisposition(obs);
    const forge = (mutate: (r: Rec) => void): Rec => {
      const forged = JSON.parse(JSON.stringify(obs)) as Rec;
      mutate(forged);
      delete forged.observationDigest;
      const body: Rec = {};
      for (const k of Object.keys(forged)) body[k] = forged[k];
      forged.observationDigest = createHash('sha256').update(`phase-233-post-run-observation-record:${JSON.stringify(body)}`).digest('hex');
      return forged;
    };
    const cases: Array<[string, (r: Rec) => void, string]> = [
      ['a claim the observation itself performed the run', (r) => { r.performedByThisTool = true; }, 'OBSERVATION_RECORD_PERFORMED_CLAIMED'],
      ['a claim the observation captured the state itself', (r) => { r.capturedByThisTool = true; }, 'OBSERVATION_RECORD_CAPTURED_CLAIMED'],
      ['a self-authorized observation', (r) => { r.selfAuthorized = true; }, 'OBSERVATION_RECORD_SELF_AUTHORIZED'],
      ['a RECORDED overall with the recorded flag quietly false', (r) => { r.observationRecorded = false; }, 'OBSERVATION_RECORD_NOT_MARKED_RECORDED'],
      ['an observation with its chain bindings stripped', (r) => { r.boundDigests = {}; }, 'OBSERVATION_RECORD_BINDINGS_INCOMPLETE'],
      ['an out-of-enum recorded outcome', (r) => { r.recordedOutcome = 'PROBABLY_FINE'; }, 'OBSERVATION_RECORD_OUTCOME_INVALID'],
    ];
    for (const [what, mutate, code] of cases) {
      const forged = forge(mutate);
      // The forgery is internally consistent -- the digest check alone would wave it through.
      assertEq(verifySelfDigests([forged]).overall, 'ALL_VERIFIED', `precondition: ${what} recomputes cleanly`);
      const d = buildPostRunDispositionRecord({ observationRecord: forged, disposition });
      assertEq(d.overall, 'POST_RUN_DISPOSITION_NOT_REVIEWABLE', `forged observation is not reviewable: ${what}`);
      assert(!d.blockers.includes('OBSERVATION_RECORD_DIGEST_MISMATCH'), `${what}: the digest check does NOT catch this -- the semantic check must`);
      assert(d.blockers.includes(code), `${what} -> ${code}`);
      assertEq(d.dispositionAccepted, false, `nothing accepted over a forged observation: ${what}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE HEADLINE INVARIANT of this phase.
await test('THE unwithdrawn-failure rule: a FAILED run may only be ACCEPTED once its withdrawal is proven', () => {
  const root = workspace();
  try {
    // A failed run whose withdrawal was never performed: residue may still be sitting in the real library.
    const unwithdrawn = recordedObservationFor(root, { outcome: 'FAILED' });
    assertEq((unwithdrawn as unknown as { withdrawalProven: boolean }).withdrawalProven, false, 'precondition: withdrawal unproven');
    const bad = buildPostRunDispositionRecord({ observationRecord: unwithdrawn, disposition: acceptedDisposition(unwithdrawn) });
    assertEq(bad.overall, 'POST_RUN_DISPOSITION_INVALID', 'accepting an unwithdrawn failure rejected');
    assert(bad.blockers.includes('DISPOSITION_ACCEPTS_UNWITHDRAWN_FAILURE'), 'unwithdrawn failure -> DISPOSITION_ACCEPTS_UNWITHDRAWN_FAILURE');
    assertEq(bad.dispositionAccepted, false, 'no acceptance');
    assertEq(bad.withdrawalProvenUpstream, false, 'withdrawal not proven upstream');
    // The same failure may still be REJECTED -- rejection is always available.
    const rejected = buildPostRunDispositionRecord({
      observationRecord: unwithdrawn,
      disposition: acceptedDisposition(unwithdrawn, { fields: { outcomeAccepted: 'REFUSED' } }),
    });
    assertEq(rejected.overall, 'POST_RUN_DISPOSITION_REJECTED', `an unwithdrawn failure is rejectable (${rejected.blockers.join(',')})`);
    // And once the withdrawal IS proven, the same failed run becomes acceptable.
    const withdrawn = recordedObservationFor(root, { outcome: 'FAILED', withdrawn: true, itemId: '33333333333333333333333333333333', approvalId: 'phase-234-withdrawn', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-withdrawn')]) });
    assertEq((withdrawn as unknown as { withdrawalProven: boolean }).withdrawalProven, true, 'precondition: withdrawal proven');
    const good = buildPostRunDispositionRecord({ observationRecord: withdrawn, disposition: acceptedDisposition(withdrawn) });
    assertEq(good.overall, 'POST_RUN_DISPOSITION_ACCEPTED', `withdrawn failure acceptable (${good.blockers.join(',')})`);
    assertEq(good.withdrawalProvenUpstream, true, 'withdrawal proven upstream');
    assertEq(good.reviewedOutcome, 'FAILED', 'FAILED echoed');
    // A COMPLETED run needs no withdrawal proof to be accepted.
    const completed = recordedObservationFor(root, { itemId: '44444444444444444444444444444444', approvalId: 'phase-234-completed', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-completed')]) });
    assertEq(buildPostRunDispositionRecord({ observationRecord: completed, disposition: acceptedDisposition(completed) }).overall, 'POST_RUN_DISPOSITION_ACCEPTED', 'completed run acceptable without a withdrawal');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: reviewing a different outcome or withdrawal than was observed fails closed', () => {
  const root = workspace();
  try {
    const obs = recordedObservationFor(root);
    const wrongOutcome = buildPostRunDispositionRecord({ observationRecord: obs, disposition: acceptedDisposition(obs, { reviewedOutcome: 'FAILED' }) });
    assertEq(wrongOutcome.overall, 'POST_RUN_DISPOSITION_INVALID', 'wrong reviewed outcome rejected');
    assert(wrongOutcome.blockers.includes('DISPOSITION_REVIEWED_OUTCOME_MISMATCH'), 'DISPOSITION_REVIEWED_OUTCOME_MISMATCH reported');
    const wrongWithdrawal = buildPostRunDispositionRecord({ observationRecord: obs, disposition: acceptedDisposition(obs, { reviewedWithdrawal: 'PERFORMED' }) });
    assertEq(wrongWithdrawal.overall, 'POST_RUN_DISPOSITION_INVALID', 'wrong reviewed withdrawal rejected');
    assert(wrongWithdrawal.blockers.includes('DISPOSITION_REVIEWED_WITHDRAWAL_MISMATCH'), 'DISPOSITION_REVIEWED_WITHDRAWAL_MISMATCH reported');
    for (const r of [wrongOutcome, wrongWithdrawal]) assertEq(r.dispositionAccepted, false, 'nothing accepted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: an ACCEPTED disposition without every part of the review affirmed fails closed', () => {
  const root = workspace();
  try {
    const obs = recordedObservationFor(root);
    for (const missing of ['observedOutcomeReviewed', 'preexistingIntegrityConfirmed', 'evidenceRetainedOutOfBand']) {
      const d = buildPostRunDispositionRecord({ observationRecord: obs, disposition: acceptedDisposition(obs, { fields: { [missing]: 'PENDING' } }) });
      assertEq(d.overall, 'POST_RUN_DISPOSITION_INVALID', `un-affirmed ${missing} rejected`);
      assert(d.blockers.includes('DISPOSITION_ACCEPTED_WITHOUT_FULL_REVIEW'), `${missing} -> DISPOSITION_ACCEPTED_WITHOUT_FULL_REVIEW`);
      assert(!d.dispositionCoherent && !d.dispositionAccepted, 'incoherent disposition accepts nothing');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('a REJECTED disposition is valid, records the refusal, and accepts nothing', () => {
  const root = workspace();
  try {
    const obs = recordedObservationFor(root);
    const rejected = acceptedDisposition(obs, { fields: { outcomeAccepted: 'REFUSED', preexistingIntegrityConfirmed: 'REFUSED', evidenceRetainedOutOfBand: 'PENDING' } });
    const d = buildPostRunDispositionRecord({ observationRecord: obs, disposition: rejected });
    assertEq(d.overall, 'POST_RUN_DISPOSITION_REJECTED', `rejected (${d.blockers.join(',')})`);
    assertEq(d.recordedDisposition, 'REJECTED', 'refusal recorded');
    assertEq(d.dispositionAccepted, false, 'a refusal accepts nothing');
    assert(d.dispositionBound && d.dispositionCoherent, 'a refusal is still a bound, coherent record');
    // But you must have reviewed the outcome to reject it -- a blind rejection is not a review.
    const blind = buildPostRunDispositionRecord({ observationRecord: obs, disposition: acceptedDisposition(obs, { fields: { outcomeAccepted: 'REFUSED', observedOutcomeReviewed: 'PENDING' } }) });
    assertEq(blind.overall, 'POST_RUN_DISPOSITION_INVALID', 'blind rejection rejected');
    assert(blind.blockers.includes('DISPOSITION_REJECTED_WITHOUT_REVIEW'), 'DISPOSITION_REJECTED_WITHOUT_REVIEW reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// This phase reviews records; it never remediates. No valid record may claim otherwise.
await test('adversarial: a disposition claiming remediation was performed is rejected', () => {
  const root = workspace();
  try {
    const obs = recordedObservationFor(root);
    for (const claimed of ['AFFIRMED', 'REFUSED']) {
      const d = buildPostRunDispositionRecord({ observationRecord: obs, disposition: acceptedDisposition(obs, { fields: { remediationPerformed: claimed } }) });
      assertEq(d.overall, 'POST_RUN_DISPOSITION_INVALID', `remediation ${claimed} rejected`);
      assert(d.blockers.includes('DISPOSITION_REMEDIATION_CLAIMED'), `remediation ${claimed} -> DISPOSITION_REMEDIATION_CLAIMED`);
      assertEq(d.dispositionAccepted, false, 'nothing accepted');
    }
    // It stays PENDING in the valid record too.
    const ok = buildPostRunDispositionRecord({ observationRecord: obs, disposition: acceptedDisposition(obs) });
    assertEq(ok.fieldStates.remediationPerformed, 'PENDING', 'remediation stays PENDING in a valid acceptance');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: reviewer digest and review time must match the decision state', () => {
  const root = workspace();
  try {
    const obs = recordedObservationFor(root);
    const anonymous = buildPostRunDispositionRecord({ observationRecord: obs, disposition: acceptedDisposition(obs, { reviewerDigest: 'PENDING' }) });
    assert(anonymous.blockers.includes('DISPOSITION_REVIEWER_DIGEST_REQUIRED'), 'an acceptance must name its reviewer by digest');
    assertEq(anonymous.dispositionAccepted, false, 'anonymous acceptance rejected');
    const undated = buildPostRunDispositionRecord({ observationRecord: obs, disposition: acceptedDisposition(obs, { reviewedAtUtc: '21 July 2026' }) });
    assert(undated.blockers.includes('DISPOSITION_REVIEWED_AT_REQUIRED'), 'an acceptance must carry a strict UTC timestamp');
    // An undecided disposition that quietly names a reviewer is a review that never decided anything.
    const predated = buildPostRunDispositionRecord({ observationRecord: obs, disposition: dispositionFor(obs, { reviewerDigest: REVIEWER_DIGEST }) });
    assertEq(predated.overall, 'POST_RUN_DISPOSITION_INVALID', 'undecided but signed disposition rejected');
    assert(predated.blockers.includes('DISPOSITION_REVIEWER_DIGEST_NOT_PENDING'), 'a PENDING disposition may not name a reviewer');
    const pretimed = buildPostRunDispositionRecord({ observationRecord: obs, disposition: dispositionFor(obs, { reviewedAtUtc: REVIEWED_AT }) });
    assert(pretimed.blockers.includes('DISPOSITION_REVIEWED_AT_NOT_PENDING'), 'a PENDING disposition may not carry a time');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a smuggled raw path in the disposition fails closed and is never echoed', () => {
  const root = workspace();
  try {
    const obs = recordedObservationFor(root);
    const smuggled = { ...acceptedDisposition(obs), reviewerNote: '/mnt/user/media/Movies/Disposition Proof (2026)/source.mp4' };
    const d = buildPostRunDispositionRecord({ observationRecord: obs, disposition: smuggled });
    assertEq(d.overall, 'POST_RUN_DISPOSITION_INVALID', 'smuggled path rejected');
    assert(d.blockers.includes('DISPOSITION_LIVE_SURFACE'), 'raw path -> DISPOSITION_LIVE_SURFACE');
    assert(d.blockers.includes('DISPOSITION_UNKNOWN_FIELD'), 'off-allowlist field -> DISPOSITION_UNKNOWN_FIELD');
    assert(!d.dispositionRedactionSafe, 'disposition not redaction-safe');
    const json = JSON.stringify(d);
    assert(!json.includes('/mnt/') && !json.includes('source.mp4'), 'the smuggled path is never echoed back');
    // An off-allowlist field is rejected even when it carries nothing sensitive at all.
    const benign = buildPostRunDispositionRecord({ observationRecord: obs, disposition: { ...acceptedDisposition(obs), notes: 'looked fine' } });
    assertEq(benign.overall, 'POST_RUN_DISPOSITION_INVALID', 'unknown field rejected on its own');
    assert(benign.blockers.includes('DISPOSITION_UNKNOWN_FIELD') && benign.dispositionRedactionSafe, 'unknown but redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: malformed enums, fields and non-single records fail closed', () => {
  const root = workspace();
  try {
    const obs = recordedObservationFor(root);
    const badOutcome = buildPostRunDispositionRecord({ observationRecord: obs, disposition: acceptedDisposition(obs, { reviewedOutcome: 'NOT_RUN' }) });
    assert(badOutcome.blockers.includes('DISPOSITION_REVIEWED_OUTCOME_INVALID'), 'DISPOSITION_REVIEWED_OUTCOME_INVALID reported');
    const badWithdrawal = buildPostRunDispositionRecord({ observationRecord: obs, disposition: acceptedDisposition(obs, { reviewedWithdrawal: 'SORT_OF' }) });
    assert(badWithdrawal.blockers.includes('DISPOSITION_REVIEWED_WITHDRAWAL_INVALID'), 'DISPOSITION_REVIEWED_WITHDRAWAL_INVALID reported');
    const badField = buildPostRunDispositionRecord({ observationRecord: obs, disposition: acceptedDisposition(obs, { fields: { outcomeAccepted: 'PROBABLY' } }) });
    assert(badField.blockers.includes('DISPOSITION_FIELD_STATE_INVALID'), 'DISPOSITION_FIELD_STATE_INVALID reported');
    const missingField = acceptedDisposition(obs);
    delete (missingField.fields as Rec).evidenceRetainedOutOfBand;
    const shortFields = buildPostRunDispositionRecord({ observationRecord: obs, disposition: missingField });
    assert(shortFields.blockers.includes('DISPOSITION_FIELDS_INVALID'), 'DISPOSITION_FIELDS_INVALID reported');
    const notSingle = buildPostRunDispositionRecord({ observationRecord: obs, disposition: [acceptedDisposition(obs)] });
    assert(notSingle.blockers.includes('DISPOSITION_NOT_SINGLE'), 'DISPOSITION_NOT_SINGLE reported');
    const badVersion = buildPostRunDispositionRecord({ observationRecord: obs, disposition: acceptedDisposition(obs, { version: 2 }) });
    assert(badVersion.blockers.includes('DISPOSITION_VERSION_UNSUPPORTED'), 'DISPOSITION_VERSION_UNSUPPORTED reported');
    for (const r of [badOutcome, badWithdrawal, badField, shortFields, notSingle, badVersion]) {
      assertEq(r.overall, 'POST_RUN_DISPOSITION_INVALID', 'malformed input rejected');
      assertEq(r.dispositionAccepted, false, 'nothing accepted');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI records a bound disposition, writes a blank skeleton, and never echoes raw paths or ids', () => {
  const root = workspace();
  try {
    const obs = recordedObservationFor(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const obsPath = w('obs.json', obs);
    const acceptedPath = w('accepted.json', acceptedDisposition(obs));
    const rejectedPath = w('rejected.json', acceptedDisposition(obs, { fields: { outcomeAccepted: 'REFUSED' } }));
    const outPath = join(root, 'DISPMARKER-out', 'disposition-report.json');
    const skeletonPath = join(root, 'DISPMARKER-out', 'skeleton.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-post-run-disposition-record-cli.ts', import.meta.url));
    const run = (args: readonly string[]) => spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], { cwd: projectRoot, encoding: 'utf8' });

    const ok = run(['--observationrecord', obsPath, '--disposition', acceptedPath, '--out', outPath, '--skeletonout', skeletonPath]);
    assert(ok.error === undefined, `spawn ok: ${ok.error?.message ?? ''}`);
    assertEq(ok.status, 0, `ACCEPTED exit 0 (stderr: ${ok.stderr ?? ''})`);
    assert(existsSync(outPath) && existsSync(skeletonPath), 'report and skeleton written');
    const parsed = JSON.parse(ok.stdout ?? '') as Rec;
    assertEq(parsed.overall, 'POST_RUN_DISPOSITION_ACCEPTED', 'stdout overall');
    assertEq(parsed.dispositionAccepted, true, 'stdout reports the acceptance');
    assertEq(parsed.reviewedByThisTool, false, 'stdout reviewedByThisTool false');
    assertEq(parsed.performedByThisTool, false, 'stdout performedByThisTool false');
    assertEq(parsed.skeletonWritten, true, 'stdout reports the skeleton');
    // The written skeleton is blank regardless of the acceptance it was emitted alongside.
    const skeleton = JSON.parse(readFileSync(skeletonPath, 'utf8')) as Rec;
    assert(Object.values(skeleton.fields as Rec).every((v) => v === 'PENDING'), 'written skeleton is blank');
    assertEq(skeleton.reviewerDigest, 'PENDING', 'written skeleton names no reviewer');
    const stdout = ok.stdout ?? '';
    assert(!stdout.includes('DISPMARKER') && !stdout.includes('catalog-authority-test-library') && !stdout.includes('/mnt/'), 'no path fragments in stdout');
    assert(!stdout.includes('phase-234-synthetic-test') && !stdout.includes('0a40074065d91a75ad41f33fc212e917'), 'no raw ids in stdout');
    assert(!stdout.includes(REVIEWER_DIGEST) && !stdout.includes(STATE_BEFORE), 'no reviewer identity or observed-state digests in stdout');

    // Every exit path, including the one that matters most: NOT_REVIEWABLE is 5, distinct from INVALID's 1.
    assertEq(run(['--observationrecord', obsPath, '--disposition', skeletonPath]).status, 3, 'blank disposition exits 3');
    assertEq(run(['--observationrecord', obsPath, '--disposition', rejectedPath]).status, 4, 'rejection exits 4');
    assertEq(run(['--observationrecord', obsPath]).status, 1, 'missing disposition over a reviewable chain exits 1');
    const notReviewable = run(['--disposition', acceptedPath]);
    assertEq(notReviewable.status, 5, 'absent observation exits 5 (NOT_REVIEWABLE)');
    assertEq((JSON.parse(notReviewable.stdout ?? '') as Rec).dispositionAccepted, false, 'nothing accepted when not reviewable');
    assertEq(run(['--observationrecord', join(dir, 'does-not-exist.json')]).status, 2, 'unreadable input exits 2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The ACTUAL prepared, redaction-safe P227-A evidence (captured verbatim from the non-live artifacts under
// evidence/phase-231). Locked here so the validator is exercised against the real chain offline and
// deterministically -- no SSH, no secret approval file, no live surface. NOTE: no approved authorization, no
// recorded observation, and no accepted disposition is constructed for this bundle anywhere in this suite.
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

// The real chain, end to end and offline: gate -> Phase 232 (PENDING) -> Phase 233 (INVALID). It never
// reaches an approved authorization or a recorded observation, because no human approved the run and no run
// happened. This function constructs neither.
function realObservationRecord(): Rec {
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
  return obs as unknown as Rec;
}

await test('the actual P227-A chain is LOCKED as NOT_REVIEWABLE: unauthorized, unrun, unobserved', () => {
  const obs = realObservationRecord();
  assertEq(obs.observationRecorded, false, 'precondition: the real run was never observed');
  assertEq(buildPostRunDispositionSkeleton(obs), null, 'no disposition skeleton exists for the real chain');
  const d = buildPostRunDispositionRecord({ observationRecord: obs });
  assertEq(d.overall, 'POST_RUN_DISPOSITION_NOT_REVIEWABLE', 'the real chain has nothing to review');
  assertEq(d.recordedDisposition, 'NONE', 'no disposition for the real run');
  assertEq(d.dispositionAccepted, false, 'the real run is NOT accepted');
  assertEq(d.reviewedOutcome, 'NONE', 'no reviewed outcome');
  assertEq(d.reviewedWithdrawal, 'NONE', 'no reviewed withdrawal');
  assertEq(d.withdrawalProvenUpstream, false, 'nothing withdrawn');
  assertEq(d.observationReviewable, false, 'not reviewable');
  assert(d.blockers.includes('OBSERVATION_RECORD_NOT_RECORDED'), 'OBSERVATION_RECORD_NOT_RECORDED reported');
  assertEq(d.reviewedByThisTool, false, 'this tool reviewed nothing');
  assertEq(d.performedByThisTool, false, 'this tool performed nothing');
  assertEq(verifySelfDigests([d]).overall, 'ALL_VERIFIED', 'real-chain report self-verifies');
  const json = JSON.stringify(d);
  assert(!json.includes('/mnt/') && !json.includes('0a40074065d91a75ad41f33fc212e917') && !json.includes('phase-231-p227-a-20260720'), 'redaction-safe: no path, no raw ids');
});

// The lock cannot be talked out of: a perfectly-formed acceptance shaped for the real operation still cannot
// dispose of a chain that never ran.
await test('the actual P227-A chain stays NOT_REVIEWABLE even against a fully-formed ACCEPTED disposition', () => {
  const obs = realObservationRecord();
  const shaped = {
    record: POST_RUN_DISPOSITION_INPUT_ID, version: 1, operation: 'promote-observe-withdraw',
    sourceObservationRecord: 'phase-233-promotion-post-run-observation-record',
    observationDigest: obs.observationDigest as string,
    approvalIdDigest: REAL_APPROVAL_EVIDENCE.approvalIdDigest, itemDigest: REAL_APPROVAL_EVIDENCE.itemDigest,
    sourceDigest: REAL_APPROVAL_EVIDENCE.sourceRealPathDigest, destinationDigest: REAL_APPROVAL_EVIDENCE.destinationPathDigest,
    planDigest: REAL_APPROVAL_EVIDENCE.sourceSha256,
    reviewedOutcome: 'COMPLETED', reviewedWithdrawal: 'NOT_REQUIRED',
    fields: {
      outcomeAccepted: 'AFFIRMED', observedOutcomeReviewed: 'AFFIRMED',
      preexistingIntegrityConfirmed: 'AFFIRMED', evidenceRetainedOutOfBand: 'AFFIRMED', remediationPerformed: 'PENDING',
    },
    reviewerDigest: REVIEWER_DIGEST, reviewedAtUtc: REVIEWED_AT,
  };
  const d = buildPostRunDispositionRecord({ observationRecord: obs, disposition: shaped });
  assertEq(d.overall, 'POST_RUN_DISPOSITION_NOT_REVIEWABLE', 'still not reviewable');
  assertEq(d.dispositionAccepted, false, 'the real P227-A run remains unaccepted');
  assertEq(d.recordedDisposition, 'NONE', 'no disposition recorded');
  assert(!d.dispositionBound, 'nothing binds to an unreviewable observation');
  assertEq(Object.keys(d.boundDigests).length, 0, 'no digests bound');
  assert(d.blockers.includes('OBSERVATION_RECORD_NOT_RECORDED'), 'the unreviewable chain is the finding');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
