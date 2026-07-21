import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPostRunObservationRecord,
  buildPostRunObservationSkeleton,
  POST_RUN_OBSERVATION_INPUT_ID,
  POST_RUN_OBSERVATION_DISCLAIMERS,
  POST_RUN_OBSERVATION_REMAINING_HUMAN_STEPS,
} from '../src/ops/promotion-post-run-observation-record.js';
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
const OPERATOR_DIGEST = createHash('sha256').update('phase-233-operator-under-test').digest('hex');
const OBSERVER_DIGEST = createHash('sha256').update('phase-233-observer-under-test').digest('hex');
const DECIDED_AT = '2026-07-21T00:00:00Z';
const OBSERVED_AT = '2026-07-21T01:00:00Z';
// Synthetic observed-state digests. This suite never observes anything real; these stand for digests a human
// would have captured out-of-band.
const STATE_BEFORE = createHash('sha256').update('synthetic-observed-state-before').digest('hex');
const STATE_AFTER = createHash('sha256').update('synthetic-observed-state-after').digest('hex');

const MINIMAL_MP4_FIXTURE = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isomcatalog-authority-postrun-fixture', 'ascii'),
]);

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-postrun-')); }

type Rec = Record<string, unknown>;

// Build a genuine Phase 231 gate over a SYNTHETIC one-item bundle.
function gateFor(root: string, over: { itemId?: string; approvalId?: string; body?: Buffer } = {}): Rec {
  const itemId = over.itemId ?? '0a40074065d91a75ad41f33fc212e917';
  const approvalId = over.approvalId ?? 'phase-233-synthetic-test';
  const testRoot = join(root, `catalog-authority-test-library-${itemId.slice(0, 8)}`);
  const source = join(testRoot, 'Movies', 'Postrun Proof (2026)', 'source.mp4');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, over.body ?? MINIMAL_MP4_FIXTURE);
  const input = { itemId, title: 'Postrun Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot: APPROVED_ROOT, approvalId };
  const built = buildApprovalAttestation(input);
  assert(built.ok, 'precondition: approval built');
  const approvalEvidence = built.evidence;
  const approvalValidation = validateApprovalAttestation(built.approval!, input).evidence;
  const plan = {
    noClobber: true,
    sameChecksum: true,
    observedStateRequired: true,
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

// A SYNTHETIC approved Phase 232 authorization record. Synthetic on purpose: an observation may only exist
// over an APPROVED authorization, and no approved authorization exists for the real P227-A bundle.
function approvedAuthorizationFor(root: string, over: { itemId?: string; approvalId?: string; body?: Buffer } = {}): Rec {
  const gate = gateFor(root, over);
  const skeleton = buildExecutionAuthorizationRecordSkeleton(gate);
  assert(skeleton !== null, 'precondition: authorization skeleton emitted');
  const record = {
    ...JSON.parse(JSON.stringify(skeleton)) as Rec,
    decision: 'APPROVED', operatorDigest: OPERATOR_DIGEST, decidedAtUtc: DECIDED_AT,
    fields: { operatorAuthorized: 'AFFIRMED', observedStateWitnessedBefore: 'AFFIRMED', withdrawalPathRehearsed: 'AFFIRMED', observedStateWitnessedAfter: 'PENDING', runExecutedByHuman: 'PENDING' },
  };
  const auth = buildExecutionAuthorizationRecord({ gate, record });
  assertEq(auth.overall, 'EXECUTION_AUTHORIZATION_RECORD_APPROVED', `precondition: authorization approved (${auth.blockers.join(',')})`);
  return auth as unknown as Rec;
}

function skeletonOf(auth: unknown): Rec {
  const skeleton = buildPostRunObservationSkeleton(auth);
  assert(skeleton !== null, 'precondition: observation skeleton emitted for an approved authorization');
  return JSON.parse(JSON.stringify(skeleton)) as Rec;
}
function observationFor(auth: unknown, over: Rec = {}): Rec {
  return { ...skeletonOf(auth), ...over };
}
// A coherent observation of a COMPLETED run: state observed before and after, the state actually changed, and
// the human actively affirms the blast-radius assertions (the skeleton leaves them PENDING).
function completedObservation(auth: unknown, over: Rec = {}): Rec {
  return observationFor(auth, {
    observedRunOutcome: 'COMPLETED',
    observedStateBeforeDigest: STATE_BEFORE,
    observedStateAfterDigest: STATE_AFTER,
    preexistingPreserved: true,
    withdrewOnlyRunCreatedMaterialization: true,
    observerDigest: OBSERVER_DIGEST,
    observedAtUtc: OBSERVED_AT,
    ...over,
  });
}

console.log('Running Phase 233 post-run observation record suite:\n');

await test('a coherent human observation of a COMPLETED run is recorded -- and this tool still observed nothing', () => {
  const root = workspace();
  try {
    const auth = approvedAuthorizationFor(root);
    const o = buildPostRunObservationRecord({ authorizationRecord: auth, observation: completedObservation(auth) });
    assertEq(o.overall, 'POST_RUN_OBSERVATION_RECORDED', `recorded (blockers: ${o.blockers.join(',')})`);
    assertEq(o.recordedOutcome, 'COMPLETED', 'outcome echoed');
    assertEq(o.recordedWithdrawal, 'NOT_REQUIRED', 'withdrawal echoed');
    assertEq(o.observationRecorded, true, 'an observation exists');
    assertEq(o.withdrawalProven, false, 'no withdrawal was performed, so none is proven');
    assert(o.authorizationValid && o.observationWellFormed && o.observationRedactionSafe && o.observationBound && o.observationCoherent, 'all five checks green');
    assertEq(o.blockers.length, 0, 'no blockers');
    // Recording an observation is not making one.
    assertEq(o.performedByThisTool, false, 'this tool performed nothing');
    assertEq(o.capturedByThisTool, false, 'this tool captured nothing');
    assertEq(o.selfAuthorized, false, 'never self-authorized');
    assertEq(o.observedStatePresence.observedStateBeforeDigest, 'PRESENT', 'before state present');
    assertEq(o.observedStatePresence.observedStateAfterWithdrawalDigest, 'PENDING', 'no withdrawal state');
    assertEq(o.remainingHumanSteps.length, POST_RUN_OBSERVATION_REMAINING_HUMAN_STEPS.length, 'remaining human steps stated');
    assertEq(o.disclaimers.length, POST_RUN_OBSERVATION_DISCLAIMERS.length, 'disclaimers stated');
    assertEq(verifySelfDigests([o]).overall, 'ALL_VERIFIED', 'observation report self-verifies');
    for (const k of ['authorization-record', 'operation-approval-id', 'operation-item', 'operation-source', 'operation-destination', 'operation-plan']) {
      assert(k in o.boundDigests, `${k} bound`);
    }
    const json = JSON.stringify(o);
    assert(!json.includes('/mnt/') && !json.includes('catalog-authority-test-library'), 'no raw path in report');
    assert(!json.includes('phase-233-synthetic-test') && !json.includes('0a40074065d91a75ad41f33fc212e917'), 'no raw approval or item id in report');
    assert(!json.includes(OBSERVER_DIGEST) && !json.includes('phase-233-observer-under-test'), 'no observer identity in report');
    assert(!json.includes(STATE_BEFORE) && !json.includes(STATE_AFTER), "the human's observed-state digests are not echoed back");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BLOCKED by default: with no authorization and no observation nothing is recorded', () => {
  const o = buildPostRunObservationRecord({});
  assertEq(o.overall, 'POST_RUN_OBSERVATION_INVALID', 'invalid without inputs');
  assertEq(o.recordedOutcome, 'NONE', 'no outcome');
  assertEq(o.recordedWithdrawal, 'NONE', 'no withdrawal');
  assertEq(o.observationRecorded, false, 'nothing recorded');
  assertEq(o.withdrawalProven, false, 'nothing proven');
  assert(o.blockers.includes('AUTHORIZATION_RECORD_MISSING') && o.blockers.includes('OBSERVATION_MISSING'), 'both inputs reported missing');
  assert(!o.authorizationValid && !o.observationWellFormed && !o.observationBound && !o.observationCoherent, 'nothing valid or bound');
  assertEq(o.capturedByThisTool, false, 'captured nothing');
  assert(o.redactionSafe === true && !JSON.stringify(o).includes('/mnt/'), 'redaction-safe');
});

await test('the emitted skeleton claims no run: it validates as PENDING and records nothing', () => {
  const root = workspace();
  try {
    const auth = approvedAuthorizationFor(root);
    const skeleton = skeletonOf(auth);
    assertEq(skeleton.record, POST_RUN_OBSERVATION_INPUT_ID, 'skeleton is an observation input');
    assertEq(skeleton.observedRunOutcome, 'NOT_RUN', 'skeleton claims no run');
    assertEq(skeleton.withdrawal, 'NOT_REQUIRED', 'skeleton claims no withdrawal');
    assertEq(skeleton.observerDigest, 'PENDING', 'skeleton names no observer');
    assertEq(skeleton.observedAtUtc, 'PENDING', 'skeleton records no time');
    for (const f of ['observedStateBeforeDigest', 'observedStateAfterDigest', 'observedStateAfterWithdrawalDigest']) {
      assertEq(skeleton[f], 'PENDING', `${f} PENDING in skeleton`);
    }
    // Nothing in the skeleton pre-affirms the safety of the real library on the human's behalf.
    assertEq(skeleton.preexistingPreserved, 'PENDING', 'skeleton does not pre-affirm preexisting preservation');
    assertEq(skeleton.withdrewOnlyRunCreatedMaterialization, 'PENDING', 'skeleton does not pre-affirm withdrawal scope');
    assert(Object.values(skeleton).every((v) => v !== true), 'the skeleton asserts nothing as true');
    const o = buildPostRunObservationRecord({ authorizationRecord: auth, observation: skeleton });
    assertEq(o.overall, 'POST_RUN_OBSERVATION_PENDING', `skeleton is valid but observes nothing (${o.blockers.join(',')})`);
    assertEq(o.recordedOutcome, 'NOT_RUN', 'outcome NOT_RUN');
    assertEq(o.observationRecorded, false, 'a blank skeleton records no observation');
    assert(o.observationBound && o.observationCoherent, 'skeleton is bound and coherent');
    assert(!JSON.stringify(skeleton).includes('/mnt/'), 'skeleton is redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// An observation may only exist where the run was provably authorized. A PENDING authorization record is a
// genuine, valid Phase 232 report -- it just never granted anything.
await test('no observation can exist over a non-APPROVED authorization record', () => {
  const root = workspace();
  try {
    const approved = approvedAuthorizationFor(root);
    const gate = gateFor(root, { itemId: '11111111111111111111111111111111', approvalId: 'phase-233-pending', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-pending')]) });
    const pendingAuth = buildExecutionAuthorizationRecord({ gate, record: buildExecutionAuthorizationRecordSkeleton(gate)! });
    assertEq(pendingAuth.overall, 'EXECUTION_AUTHORIZATION_RECORD_PENDING', 'precondition: a genuine but undecided authorization');
    assertEq(verifySelfDigests([pendingAuth]).overall, 'ALL_VERIFIED', 'precondition: it is genuine');
    assertEq(buildPostRunObservationSkeleton(pendingAuth), null, 'no observation skeleton for an unapproved authorization');
    const o = buildPostRunObservationRecord({ authorizationRecord: pendingAuth, observation: completedObservation(approved) });
    assertEq(o.overall, 'POST_RUN_OBSERVATION_INVALID', 'unapproved authorization rejected');
    assert(o.blockers.includes('AUTHORIZATION_RECORD_NOT_APPROVED'), 'AUTHORIZATION_RECORD_NOT_APPROVED reported');
    assert(o.blockers.includes('AUTHORIZATION_RECORD_NOT_RECORDED'), 'AUTHORIZATION_RECORD_NOT_RECORDED reported');
    assert(!o.authorizationValid && !o.observationBound, 'nothing bound to an unapproved authorization');
    assertEq(o.recordedOutcome, 'NONE', 'no outcome recorded');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE security case, inherited from Phase 232: an observation of ONE operation must not be replayable.
await test('THE security case: an observation cannot be transplanted onto a different authorization', () => {
  const root = workspace();
  try {
    const authA = approvedAuthorizationFor(root);
    const authB = approvedAuthorizationFor(root, { itemId: '99999999999999999999999999999999', approvalId: 'phase-233-other', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-other')]) });
    const observationA = completedObservation(authA);
    assertEq(buildPostRunObservationRecord({ authorizationRecord: authA, observation: observationA }).overall, 'POST_RUN_OBSERVATION_RECORDED', 'precondition: genuine observation of A');
    const o = buildPostRunObservationRecord({ authorizationRecord: authB, observation: observationA });
    assertEq(o.overall, 'POST_RUN_OBSERVATION_INVALID', 'transplanted observation rejected');
    assertEq(o.observationRecorded, false, 'nothing carried over');
    assert(o.blockers.includes('OBSERVATION_NOT_BOUND_TO_AUTHORIZATION'), 'authorization digest mismatch reported');
    assert(o.blockers.includes('OBSERVATION_ITEM_DIGEST_MISMATCH') && o.blockers.includes('OBSERVATION_SOURCE_DIGEST_MISMATCH'), 'operation digest mismatches reported');
    assertEq(Object.keys(o.boundDigests).length, 1, 'only the valid authorization itself is bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a green-bodied but tampered Phase 232 record fails on digest recompute', () => {
  const root = workspace();
  try {
    const auth = approvedAuthorizationFor(root);
    const observation = completedObservation(auth);
    const tampered = JSON.parse(JSON.stringify(auth)) as Rec;
    assertEq(tampered.overall, 'EXECUTION_AUTHORIZATION_RECORD_APPROVED', 'precondition: green');
    tampered.injectedClaim = 'smuggled-through-a-green-authorization';
    const o = buildPostRunObservationRecord({ authorizationRecord: tampered, observation });
    assertEq(o.overall, 'POST_RUN_OBSERVATION_INVALID', 'tampered authorization rejected');
    assert(o.blockers.includes('AUTHORIZATION_RECORD_DIGEST_MISMATCH'), 'green-body tamper -> AUTHORIZATION_RECORD_DIGEST_MISMATCH');
    assert(!o.authorizationValid && !o.observationBound, 'nothing bound to a tampered authorization');
    assertEq(Object.keys(o.boundDigests).length, 0, 'no digests bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A self-digest is not a signature: anyone can recompute one. So the semantic checks on the authorization
// record are NOT unreachable behind the digest check -- a forger who rebuilds the digest walks straight into
// them, and they are the only thing standing between a fabricated "already executed" authorization and a
// recorded observation.
await test('adversarial: a FORGED authorization that recomputes its own digest is still caught by the semantic checks', () => {
  const root = workspace();
  try {
    const auth = approvedAuthorizationFor(root);
    const forge = (mutate: (r: Rec) => void): Rec => {
      const forged = JSON.parse(JSON.stringify(auth)) as Rec;
      mutate(forged);
      delete forged.recordDigest;
      const body: Rec = {};
      for (const k of Object.keys(forged)) body[k] = forged[k];
      forged.recordDigest = createHash('sha256').update(`phase-232-execution-authorization-record:${JSON.stringify(body)}`).digest('hex');
      return forged;
    };
    const cases: Array<[string, (r: Rec) => void, string]> = [
      ['a claim the authorization itself executed the run', (r) => { r.execution = 'PERFORMED'; }, 'AUTHORIZATION_RECORD_EXECUTION_CLAIMED'],
      ['a claim the authorization captured artifacts', (r) => { r.capturedArtifacts = 'CAPTURED'; }, 'AUTHORIZATION_RECORD_ARTIFACTS_CLAIMED'],
      ['a self-authorized authorization', (r) => { r.selfAuthorized = true; }, 'AUTHORIZATION_RECORD_SELF_AUTHORIZED'],
      ['an approval with its chain bindings stripped', (r) => { r.boundDigests = {}; }, 'AUTHORIZATION_RECORD_BINDINGS_INCOMPLETE'],
    ];
    for (const [what, mutate, code] of cases) {
      const forged = forge(mutate);
      // The forgery is internally consistent -- the digest check alone would wave it through.
      assertEq(verifySelfDigests([forged]).overall, 'ALL_VERIFIED', `precondition: ${what} recomputes cleanly`);
      const o = buildPostRunObservationRecord({ authorizationRecord: forged, observation: completedObservation(auth) });
      assertEq(o.overall, 'POST_RUN_OBSERVATION_INVALID', `forged authorization rejected: ${what}`);
      assert(!o.blockers.includes('AUTHORIZATION_RECORD_DIGEST_MISMATCH'), `${what}: the digest check does NOT catch this -- the semantic check must`);
      assert(o.blockers.includes(code), `${what} -> ${code}`);
      assertEq(o.observationRecorded, false, `nothing recorded over a forged authorization: ${what}`);
      assertEq(o.authorizationValid, false, `forged authorization not valid: ${what}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A promotion that changed nothing observable is not a completed promotion.
await test('adversarial: COMPLETED with an unchanged observed state fails closed', () => {
  const root = workspace();
  try {
    const auth = approvedAuthorizationFor(root);
    const unchanged = completedObservation(auth, { observedStateAfterDigest: STATE_BEFORE });
    const o = buildPostRunObservationRecord({ authorizationRecord: auth, observation: unchanged });
    assertEq(o.overall, 'POST_RUN_OBSERVATION_INVALID', 'unchanged state rejected');
    assert(o.blockers.includes('OBSERVATION_COMPLETED_WITHOUT_OBSERVED_CHANGE'), 'unchanged -> OBSERVATION_COMPLETED_WITHOUT_OBSERVED_CHANGE');
    assertEq(o.observationRecorded, false, 'nothing recorded');
    // A COMPLETED claim with no observed state at all is equally invalid.
    const unobserved = completedObservation(auth, { observedStateAfterDigest: 'PENDING' });
    const u = buildPostRunObservationRecord({ authorizationRecord: auth, observation: unobserved });
    assert(u.blockers.includes('OBSERVATION_COMPLETED_WITHOUT_OBSERVED_STATE'), 'unobserved -> OBSERVATION_COMPLETED_WITHOUT_OBSERVED_STATE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE headline invariant of this phase.
await test('THE withdrawal proof: PERFORMED holds only when the observed state returned to exactly the before state', () => {
  const root = workspace();
  try {
    const auth = approvedAuthorizationFor(root);
    // A withdrawal that left the library in some other state is NOT a withdrawal.
    const notRestored = completedObservation(auth, { withdrawal: 'PERFORMED', observedStateAfterWithdrawalDigest: STATE_AFTER });
    const bad = buildPostRunObservationRecord({ authorizationRecord: auth, observation: notRestored });
    assertEq(bad.overall, 'POST_RUN_OBSERVATION_INVALID', 'unrestored withdrawal rejected');
    assert(bad.blockers.includes('WITHDRAWAL_DID_NOT_RESTORE_OBSERVED_STATE'), 'unrestored -> WITHDRAWAL_DID_NOT_RESTORE_OBSERVED_STATE');
    assertEq(bad.withdrawalProven, false, 'no withdrawal proven');
    // A withdrawal claimed with no after-withdrawal observation at all is equally unproven.
    const unobserved = completedObservation(auth, { withdrawal: 'PERFORMED' });
    assert(buildPostRunObservationRecord({ authorizationRecord: auth, observation: unobserved }).blockers.includes('WITHDRAWAL_DID_NOT_RESTORE_OBSERVED_STATE'), 'unobserved withdrawal -> same blocker');
    // Restored to exactly the before state: the withdrawal is proven.
    const restored = completedObservation(auth, { withdrawal: 'PERFORMED', observedStateAfterWithdrawalDigest: STATE_BEFORE });
    const good = buildPostRunObservationRecord({ authorizationRecord: auth, observation: restored });
    assertEq(good.overall, 'POST_RUN_OBSERVATION_RECORDED', `restored withdrawal recorded (${good.blockers.join(',')})`);
    assertEq(good.withdrawalProven, true, 'withdrawal proven by the restored observed state');
    assertEq(good.recordedWithdrawal, 'PERFORMED', 'withdrawal echoed');
    assertEq(good.observedStatePresence.observedStateAfterWithdrawalDigest, 'PRESENT', 'after-withdrawal state present');
    // An after-withdrawal state cited without a PERFORMED withdrawal is incoherent.
    const stray = completedObservation(auth, { withdrawal: 'REFUSED', observedStateAfterWithdrawalDigest: STATE_BEFORE });
    assert(buildPostRunObservationRecord({ authorizationRecord: auth, observation: stray }).blockers.includes('OBSERVATION_WITHDRAWAL_STATE_WITHOUT_PERFORMED_WITHDRAWAL'), 'stray withdrawal state reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a withdrawal that touched preexisting content fails closed', () => {
  const root = workspace();
  try {
    const auth = approvedAuthorizationFor(root);
    const restored = { withdrawal: 'PERFORMED', observedStateAfterWithdrawalDigest: STATE_BEFORE };
    const clobbered = completedObservation(auth, { ...restored, preexistingPreserved: false });
    const c = buildPostRunObservationRecord({ authorizationRecord: auth, observation: clobbered });
    assertEq(c.overall, 'POST_RUN_OBSERVATION_INVALID', 'unpreserved preexisting content rejected');
    assert(c.blockers.includes('OBSERVATION_PREEXISTING_NOT_PRESERVED'), 'OBSERVATION_PREEXISTING_NOT_PRESERVED reported');
    assertEq(c.withdrawalProven, false, 'a withdrawal that ate preexisting content is not proven');
    const overreach = completedObservation(auth, { ...restored, withdrewOnlyRunCreatedMaterialization: false });
    const w = buildPostRunObservationRecord({ authorizationRecord: auth, observation: overreach });
    assertEq(w.overall, 'POST_RUN_OBSERVATION_INVALID', 'over-broad withdrawal rejected');
    assert(w.blockers.includes('OBSERVATION_WITHDREW_BEYOND_RUN_CREATED_MATERIALIZATION'), 'over-broad withdrawal reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: NOT_RUN may not claim any observed state or withdrawal', () => {
  const root = workspace();
  try {
    const auth = approvedAuthorizationFor(root);
    for (const f of ['observedStateBeforeDigest', 'observedStateAfterDigest', 'observedStateAfterWithdrawalDigest']) {
      const o = buildPostRunObservationRecord({ authorizationRecord: auth, observation: observationFor(auth, { [f]: STATE_AFTER }) });
      assertEq(o.overall, 'POST_RUN_OBSERVATION_INVALID', `NOT_RUN with ${f} rejected`);
      assert(o.blockers.includes('OBSERVATION_NOT_RUN_CLAIMS_OBSERVED_STATE'), `${f} -> OBSERVATION_NOT_RUN_CLAIMS_OBSERVED_STATE`);
      assertEq(o.recordedOutcome, 'NONE', 'nothing recorded');
    }
    const withdrawn = buildPostRunObservationRecord({ authorizationRecord: auth, observation: observationFor(auth, { withdrawal: 'PERFORMED' }) });
    assert(withdrawn.blockers.includes('OBSERVATION_NOT_RUN_WITHDRAWAL_NOT_NOT_REQUIRED'), 'NOT_RUN with a withdrawal claim reported');
    assertEq(withdrawn.withdrawalProven, false, 'nothing proven');
    // Nor may a run that never happened assert anything about what it left the real library looking like.
    for (const f of ['preexistingPreserved', 'withdrewOnlyRunCreatedMaterialization']) {
      const a = buildPostRunObservationRecord({ authorizationRecord: auth, observation: observationFor(auth, { [f]: true }) });
      assertEq(a.overall, 'POST_RUN_OBSERVATION_INVALID', `NOT_RUN asserting ${f} rejected`);
      assert(a.blockers.includes('OBSERVATION_NOT_RUN_ASSERTION_NOT_PENDING'), `${f} -> OBSERVATION_NOT_RUN_ASSERTION_NOT_PENDING`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('a FAILED run is recordable, but only with both observed states', () => {
  const root = workspace();
  try {
    const auth = approvedAuthorizationFor(root);
    // A failed run that changed nothing observable is a legitimate, clean failure.
    const clean = completedObservation(auth, { observedRunOutcome: 'FAILED', observedStateAfterDigest: STATE_BEFORE });
    const c = buildPostRunObservationRecord({ authorizationRecord: auth, observation: clean });
    assertEq(c.overall, 'POST_RUN_OBSERVATION_RECORDED', `clean failure recorded (${c.blockers.join(',')})`);
    assertEq(c.recordedOutcome, 'FAILED', 'FAILED echoed');
    // But a failure that never observed what it left behind is not an observation.
    const unobserved = completedObservation(auth, { observedRunOutcome: 'FAILED', observedStateAfterDigest: 'PENDING' });
    const u = buildPostRunObservationRecord({ authorizationRecord: auth, observation: unobserved });
    assertEq(u.overall, 'POST_RUN_OBSERVATION_INVALID', 'unobserved failure rejected');
    assert(u.blockers.includes('OBSERVATION_FAILED_WITHOUT_OBSERVED_STATE'), 'OBSERVATION_FAILED_WITHOUT_OBSERVED_STATE reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: observer digest and observation time must match the claimed outcome', () => {
  const root = workspace();
  try {
    const auth = approvedAuthorizationFor(root);
    const anonymous = buildPostRunObservationRecord({ authorizationRecord: auth, observation: completedObservation(auth, { observerDigest: 'PENDING' }) });
    assert(anonymous.blockers.includes('OBSERVATION_OBSERVER_DIGEST_REQUIRED'), 'an observation must name its observer by digest');
    assertEq(anonymous.observationRecorded, false, 'anonymous observation rejected');
    const undated = buildPostRunObservationRecord({ authorizationRecord: auth, observation: completedObservation(auth, { observedAtUtc: '21 July 2026' }) });
    assert(undated.blockers.includes('OBSERVATION_OBSERVED_AT_REQUIRED'), 'an observation must carry a strict UTC timestamp');
    const predated = buildPostRunObservationRecord({ authorizationRecord: auth, observation: observationFor(auth, { observerDigest: OBSERVER_DIGEST }) });
    assert(predated.blockers.includes('OBSERVATION_OBSERVER_DIGEST_NOT_PENDING'), 'a NOT_RUN observation may not name an observer');
    const pretimed = buildPostRunObservationRecord({ authorizationRecord: auth, observation: observationFor(auth, { observedAtUtc: OBSERVED_AT }) });
    assert(pretimed.blockers.includes('OBSERVATION_OBSERVED_AT_NOT_PENDING'), 'a NOT_RUN observation may not carry a time');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A human writes this record right after standing in front of the real library -- the likeliest leak of all.
await test('adversarial: a smuggled raw path in the observation fails closed and is never echoed', () => {
  const root = workspace();
  try {
    const auth = approvedAuthorizationFor(root);
    const smuggled = { ...completedObservation(auth), observerNote: '/mnt/user/media/Movies/Postrun Proof (2026)/source.mp4' };
    const o = buildPostRunObservationRecord({ authorizationRecord: auth, observation: smuggled });
    assertEq(o.overall, 'POST_RUN_OBSERVATION_INVALID', 'smuggled path rejected');
    assert(o.blockers.includes('OBSERVATION_LIVE_SURFACE'), 'raw path -> OBSERVATION_LIVE_SURFACE');
    assert(o.blockers.includes('OBSERVATION_UNKNOWN_FIELD'), 'off-allowlist field -> OBSERVATION_UNKNOWN_FIELD');
    assert(!o.observationRedactionSafe, 'observation not redaction-safe');
    const json = JSON.stringify(o);
    assert(!json.includes('/mnt/') && !json.includes('source.mp4'), 'the smuggled path is never echoed back');
    // An off-allowlist field is rejected even when it carries nothing sensitive at all.
    const benign = buildPostRunObservationRecord({ authorizationRecord: auth, observation: { ...completedObservation(auth), notes: 'looked fine' } });
    assertEq(benign.overall, 'POST_RUN_OBSERVATION_INVALID', 'unknown field rejected on its own');
    assert(benign.blockers.includes('OBSERVATION_UNKNOWN_FIELD') && benign.observationRedactionSafe, 'unknown but redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: malformed enums and non-digest observed state fail closed', () => {
  const root = workspace();
  try {
    const auth = approvedAuthorizationFor(root);
    const badOutcome = buildPostRunObservationRecord({ authorizationRecord: auth, observation: observationFor(auth, { observedRunOutcome: 'PROBABLY_FINE' }) });
    assert(badOutcome.blockers.includes('OBSERVATION_OUTCOME_INVALID'), 'OBSERVATION_OUTCOME_INVALID reported');
    const badWithdrawal = buildPostRunObservationRecord({ authorizationRecord: auth, observation: observationFor(auth, { withdrawal: 'SORT_OF' }) });
    assert(badWithdrawal.blockers.includes('OBSERVATION_WITHDRAWAL_INVALID'), 'OBSERVATION_WITHDRAWAL_INVALID reported');
    const badState = buildPostRunObservationRecord({ authorizationRecord: auth, observation: completedObservation(auth, { observedStateAfterDigest: 'looked-bigger' }) });
    assert(badState.blockers.includes('OBSERVATION_STATE_DIGEST_INVALID'), 'OBSERVATION_STATE_DIGEST_INVALID reported');
    const badAssertion = buildPostRunObservationRecord({ authorizationRecord: auth, observation: completedObservation(auth, { preexistingPreserved: 'yes' }) });
    assert(badAssertion.blockers.includes('OBSERVATION_ASSERTION_INVALID'), 'OBSERVATION_ASSERTION_INVALID reported');
    const notSingle = buildPostRunObservationRecord({ authorizationRecord: auth, observation: [completedObservation(auth)] });
    assert(notSingle.blockers.includes('OBSERVATION_NOT_SINGLE'), 'OBSERVATION_NOT_SINGLE reported');
    for (const r of [badOutcome, badWithdrawal, badState, badAssertion, notSingle]) {
      assertEq(r.overall, 'POST_RUN_OBSERVATION_INVALID', 'malformed input rejected');
      assertEq(r.observationRecorded, false, 'nothing recorded');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI records a bound observation, writes a blank skeleton, and never echoes raw paths or ids', () => {
  const root = workspace();
  try {
    const auth = approvedAuthorizationFor(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const authPath = w('auth.json', auth);
    const observationPath = w('observation.json', completedObservation(auth, { withdrawal: 'PERFORMED', observedStateAfterWithdrawalDigest: STATE_BEFORE }));
    const outPath = join(root, 'POSTRUNMARKER-out', 'observation-report.json');
    const skeletonPath = join(root, 'POSTRUNMARKER-out', 'skeleton.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-post-run-observation-record-cli.ts', import.meta.url));
    const run = (args: readonly string[]) => spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], { cwd: projectRoot, encoding: 'utf8' });

    const ok = run(['--authorizationrecord', authPath, '--observation', observationPath, '--out', outPath, '--skeletonout', skeletonPath]);
    assert(ok.error === undefined, `spawn ok: ${ok.error?.message ?? ''}`);
    assertEq(ok.status, 0, `RECORDED exit 0 (stderr: ${ok.stderr ?? ''})`);
    assert(existsSync(outPath) && existsSync(skeletonPath), 'report and skeleton written');
    const parsed = JSON.parse(ok.stdout ?? '') as Rec;
    assertEq(parsed.overall, 'POST_RUN_OBSERVATION_RECORDED', 'stdout overall');
    assertEq(parsed.withdrawalProven, true, 'stdout reports the proven withdrawal');
    assertEq(parsed.performedByThisTool, false, 'stdout performedByThisTool false');
    assertEq(parsed.capturedByThisTool, false, 'stdout capturedByThisTool false');
    assertEq(parsed.skeletonWritten, true, 'stdout reports the skeleton');
    // The written skeleton claims no run, regardless of the observation it was emitted alongside.
    const skeleton = JSON.parse(readFileSync(skeletonPath, 'utf8')) as Rec;
    assertEq(skeleton.observedRunOutcome, 'NOT_RUN', 'written skeleton claims no run');
    assertEq(skeleton.observedStateAfterDigest, 'PENDING', 'written skeleton observes nothing');
    const stdout = ok.stdout ?? '';
    assert(!stdout.includes('POSTRUNMARKER') && !stdout.includes('catalog-authority-test-library') && !stdout.includes('/mnt/'), 'no path fragments in stdout');
    assert(!stdout.includes('phase-233-synthetic-test') && !stdout.includes('0a40074065d91a75ad41f33fc212e917'), 'no raw ids in stdout');
    assert(!stdout.includes(STATE_BEFORE) && !stdout.includes(OBSERVER_DIGEST), 'no observed-state digests or observer identity in stdout');

    // The skeleton path exits 3 (valid, nothing observed); a missing observation exits 1; a bad file exits 2.
    const pending = run(['--authorizationrecord', authPath, '--observation', skeletonPath]);
    assertEq(pending.status, 3, `blank observation exits 3 (stderr: ${pending.stderr ?? ''})`);
    assertEq((JSON.parse(pending.stdout ?? '') as Rec).observationRecorded, false, 'nothing recorded for a blank observation');
    assertEq(run(['--authorizationrecord', authPath]).status, 1, 'missing observation exits 1');
    assertEq(run(['--authorizationrecord', join(dir, 'does-not-exist.json')]).status, 2, 'unreadable input exits 2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The ACTUAL prepared, redaction-safe P227-A evidence (captured verbatim from the non-live artifacts under
// evidence/phase-231). Locked here so the validator is exercised against the real chain offline and
// deterministically -- no SSH, no secret approval file, no live surface. NOTE: no approved authorization and
// no observation of a run is constructed for this bundle anywhere in this suite; the real run never happened.
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

// The real chain, end to end and offline: gate -> Phase 232 record. It stops at PENDING, because no human has
// approved the real run. This function never builds an approved authorization for the real bundle.
function realAuthorizationRecord(): Rec {
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
  return auth as unknown as Rec;
}

await test('the real prepared P227-A run cannot have an observation: it was never authorized', () => {
  const auth = realAuthorizationRecord();
  assertEq(auth.authorizationRecorded, false, 'precondition: the real run is NOT authorized');
  assertEq(buildPostRunObservationSkeleton(auth), null, 'no observation skeleton exists for the real run');
  const o = buildPostRunObservationRecord({ authorizationRecord: auth });
  assertEq(o.overall, 'POST_RUN_OBSERVATION_INVALID', 'the real chain cannot produce an observation');
  assert(o.blockers.includes('AUTHORIZATION_RECORD_NOT_APPROVED'), 'AUTHORIZATION_RECORD_NOT_APPROVED reported');
  assert(o.blockers.includes('OBSERVATION_MISSING'), 'and no observation exists either');
  assertEq(o.recordedOutcome, 'NONE', 'no outcome recorded for the real run');
  assertEq(o.recordedWithdrawal, 'NONE', 'no withdrawal recorded for the real run');
  assertEq(o.observationRecorded, false, 'nothing observed');
  assertEq(o.withdrawalProven, false, 'nothing withdrawn');
  assertEq(o.capturedByThisTool, false, 'this tool captured nothing');
  assertEq(o.performedByThisTool, false, 'this tool performed nothing');
  assertEq(verifySelfDigests([o]).overall, 'ALL_VERIFIED', 'real-chain report self-verifies');
  const json = JSON.stringify(o);
  assert(!json.includes('/mnt/') && !json.includes('0a40074065d91a75ad41f33fc212e917') && !json.includes('phase-231-p227-a-20260720'), 'redaction-safe: no path, no raw ids');
});

// Even handed a well-formed observation, the real bundle stays unobservable: authorization gates everything.
await test('the real prepared P227-A run stays unobservable even against a fully-formed observation', () => {
  const auth = realAuthorizationRecord();
  // Shaped like a real observation but bound to nothing that exists: the real chain has no record digest to
  // bind to, because it was never approved.
  const shaped = {
    record: POST_RUN_OBSERVATION_INPUT_ID, version: 1, operation: 'promote-observe-withdraw',
    sourceAuthorizationRecord: 'phase-232-promotion-execution-authorization-record',
    recordDigest: (auth.recordDigest as string),
    approvalIdDigest: REAL_APPROVAL_EVIDENCE.approvalIdDigest, itemDigest: REAL_APPROVAL_EVIDENCE.itemDigest,
    sourceDigest: REAL_APPROVAL_EVIDENCE.sourceRealPathDigest, destinationDigest: REAL_APPROVAL_EVIDENCE.destinationPathDigest,
    planDigest: REAL_APPROVAL_EVIDENCE.sourceSha256,
    observedRunOutcome: 'NOT_RUN', observedStateBeforeDigest: 'PENDING', observedStateAfterDigest: 'PENDING',
    observedStateAfterWithdrawalDigest: 'PENDING', withdrawal: 'NOT_REQUIRED',
    preexistingPreserved: 'PENDING', withdrewOnlyRunCreatedMaterialization: 'PENDING',
    observerDigest: 'PENDING', observedAtUtc: 'PENDING',
  };
  const o = buildPostRunObservationRecord({ authorizationRecord: auth, observation: shaped });
  assertEq(o.overall, 'POST_RUN_OBSERVATION_INVALID', 'still invalid');
  assert(o.blockers.includes('AUTHORIZATION_RECORD_NOT_APPROVED'), 'the unapproved authorization is the blocker');
  assert(!o.observationBound, 'nothing binds to an unapproved authorization');
  assertEq(o.observationRecorded, false, 'the real P227-A run remains unobserved and unauthorized');
  assertEq(Object.keys(o.boundDigests).length, 0, 'no digests bound');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
