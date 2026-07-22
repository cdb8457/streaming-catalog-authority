import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPromotionChainReplay, CHAIN_REPLAY_DISCLAIMERS } from '../src/ops/promotion-chain-replay.js';
import { buildOperationClosureRecord, buildOperationClosureSkeleton } from '../src/ops/promotion-operation-closure-record.js';
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
const OPERATOR_DIGEST = createHash('sha256').update('phase-236-operator-under-test').digest('hex');
const OBSERVER_DIGEST = createHash('sha256').update('phase-236-observer-under-test').digest('hex');
const REVIEWER_DIGEST = createHash('sha256').update('phase-236-reviewer-under-test').digest('hex');
const CLOSER_DIGEST = createHash('sha256').update('phase-236-closer-under-test').digest('hex');
const DECIDED_AT = '2026-07-21T00:00:00Z';
const OBSERVED_AT = '2026-07-21T01:00:00Z';
const REVIEWED_AT = '2026-07-21T02:00:00Z';
const CLOSED_AT = '2026-07-21T03:00:00Z';
const STATE_BEFORE = createHash('sha256').update('synthetic-observed-state-before').digest('hex');
const STATE_AFTER = createHash('sha256').update('synthetic-observed-state-after').digest('hex');

const MINIMAL_MP4_FIXTURE = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isomcatalog-authority-chainreplay-fixture', 'ascii'),
]);

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-chainreplay-')); }

type Rec = Record<string, unknown>;
interface ChainOpts { itemId?: string; approvalId?: string; body?: Buffer; closure?: 'CLOSED' | 'HELD_OPEN' | 'PENDING' }
interface ChainSources { gateEvidence: Rec; authorizationDecision: Rec; observation: Rec; disposition: Rec; closure: Rec }
// A chain carries the SOURCE records each phase consumed alongside the reports. Supplying them is what unlocks
// the non-resealable semantic path; a bundle of reports alone can only ever earn STRUCTURAL_ONLY.
interface Chain { gate: Rec; authorization: Rec; observation: Rec; disposition: Rec; closure: Rec; sources: ChainSources }

// Build a COMPLETE, genuine, five-phase SYNTHETIC chain. Synthetic on purpose: no approved authorization,
// recorded observation, accepted disposition or closed closure exists for the real P227-A bundle, and this
// suite never constructs one.
function fullChain(root: string, o: ChainOpts = {}): Chain {
  const itemId = o.itemId ?? '0a40074065d91a75ad41f33fc212e917';
  const approvalId = o.approvalId ?? 'phase-236-synthetic-test';
  const testRoot = join(root, `catalog-authority-test-library-${itemId.slice(0, 8)}`);
  const source = join(testRoot, 'Movies', 'Chainreplay Proof (2026)', 'source.mp4');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, o.body ?? MINIMAL_MP4_FIXTURE);
  const input = { itemId, title: 'Chainreplay Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot: APPROVED_ROOT, approvalId };
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
  const gateEvidence = {
    approvalEvidence, approvalValidation, preflightPlan: plan, preflightReport,
    preflightSelfDigest: verifySelfDigests([preflightReport]),
  };
  const gate = buildExecutionAuthorization(gateEvidence);
  assertEq(gate.overall, 'EXECUTION_AUTHORIZATION_TEMPLATE_READY', `precondition: gate ready (${gate.blockers.join(',')})`);

  const authorizationDecision: Rec = {
    ...JSON.parse(JSON.stringify(buildExecutionAuthorizationRecordSkeleton(gate)!)) as Rec,
    decision: 'APPROVED', operatorDigest: OPERATOR_DIGEST, decidedAtUtc: DECIDED_AT,
    // The operator pins the state they witnessed; the observation below must report exactly this one.
    observedStateBeforeDigest: STATE_BEFORE,
    fields: { operatorAuthorized: 'AFFIRMED', observedStateWitnessedBefore: 'AFFIRMED', withdrawalPathRehearsed: 'AFFIRMED', observedStateWitnessedAfter: 'PENDING', runExecutedByHuman: 'PENDING' },
  };
  const authorization = buildExecutionAuthorizationRecord({ gate, record: authorizationDecision });
  assertEq(authorization.overall, 'EXECUTION_AUTHORIZATION_RECORD_APPROVED', `precondition: approved (${authorization.blockers.join(',')})`);

  const observationRecord: Rec = {
    ...JSON.parse(JSON.stringify(buildPostRunObservationSkeleton(authorization)!)) as Rec,
    observedRunOutcome: 'COMPLETED',
    observedStateBeforeDigest: STATE_BEFORE, observedStateAfterDigest: STATE_AFTER,
    preexistingPreserved: true, withdrewOnlyRunCreatedMaterialization: true,
    observerDigest: OBSERVER_DIGEST, observedAtUtc: OBSERVED_AT,
  };
  const observation = buildPostRunObservationRecord({ authorizationRecord: authorization, observation: observationRecord });
  assertEq(observation.overall, 'POST_RUN_OBSERVATION_RECORDED', `precondition: recorded (${observation.blockers.join(',')})`);

  const dispositionRecord: Rec = {
    ...JSON.parse(JSON.stringify(buildPostRunDispositionSkeleton(observation)!)) as Rec,
    reviewerDigest: REVIEWER_DIGEST, reviewedAtUtc: REVIEWED_AT,
    fields: {
      outcomeAccepted: 'AFFIRMED', observedOutcomeReviewed: 'AFFIRMED',
      preexistingIntegrityConfirmed: 'AFFIRMED', evidenceRetainedOutOfBand: 'AFFIRMED', remediationPerformed: 'PENDING',
    },
  };
  const disposition = buildPostRunDispositionRecord({ observationRecord: observation, disposition: dispositionRecord });
  assertEq(disposition.overall, 'POST_RUN_DISPOSITION_ACCEPTED', `precondition: accepted (${disposition.blockers.join(',')})`);

  const want = o.closure ?? 'CLOSED';
  const affirmed = want === 'CLOSED' ? 'AFFIRMED' : want === 'HELD_OPEN' ? 'REFUSED' : 'PENDING';
  const decided = want !== 'PENDING';
  const closureRecord: Rec = {
    ...JSON.parse(JSON.stringify(buildOperationClosureSkeleton(disposition)!)) as Rec,
    closerDigest: decided ? CLOSER_DIGEST : 'PENDING', closedAtUtc: decided ? CLOSED_AT : 'PENDING',
    fields: {
      closureAffirmed: affirmed,
      evidenceArchivedOutOfBand: 'AFFIRMED', chainDigestsRecordedInArchive: 'AFFIRMED',
      noOutstandingRemediation: 'AFFIRMED', evidencePurged: 'PENDING',
    },
  };
  const closure = buildOperationClosureRecord({ dispositionRecord: disposition, closure: closureRecord });
  assertEq(closure.overall, `OPERATION_CLOSURE_${want}`, `precondition: closure ${want} (${closure.blockers.join(',')})`);

  return {
    gate: gate as unknown as Rec, authorization: authorization as unknown as Rec,
    observation: observation as unknown as Rec, disposition: disposition as unknown as Rec,
    closure: closure as unknown as Rec,
    sources: {
      gateEvidence: gateEvidence as unknown as Rec, authorizationDecision,
      observation: observationRecord, disposition: dispositionRecord, closure: closureRecord,
    },
  };
}

// The reports of a chain WITHOUT their source records: structurally perfect, semantically unproven.
function reportsOnly(c: Chain): Rec {
  return { gate: c.gate, authorization: c.authorization, observation: c.observation, disposition: c.disposition, closure: c.closure };
}

// Re-seal a mutated report so it recomputes its own self-digest cleanly. A self-digest is not a signature:
// anyone can rebuild one, which is exactly why the link and identity checks must stand on their own.
const SEAL: Readonly<Record<string, [string, string]>> = {
  gate: ['authorizationDigest', 'phase-231-execution-authorization'],
  authorization: ['recordDigest', 'phase-232-execution-authorization-record'],
  observation: ['observationDigest', 'phase-233-post-run-observation-record'],
  disposition: ['dispositionDigest', 'phase-234-post-run-disposition-record'],
  closure: ['closureDigest', 'phase-235-operation-closure-record'],
};
function forge(report: Rec, slot: keyof typeof SEAL, mutate: (r: Rec) => void): Rec {
  const [field, scope] = SEAL[slot]!;
  const forged = JSON.parse(JSON.stringify(report)) as Rec;
  mutate(forged);
  delete forged[field];
  const body: Rec = {};
  for (const k of Object.keys(forged)) body[k] = forged[k];
  forged[field] = createHash('sha256').update(`${scope}:${JSON.stringify(body)}`).digest('hex');
  assertEq(verifySelfDigests([forged]).overall, 'ALL_VERIFIED', 'precondition: the forgery recomputes cleanly');
  return forged;
}

console.log('Running Phase 236 promotion chain replay suite:\n');

await test('a complete synthetic chain replays end to end and reports the operation closed', () => {
  const root = workspace();
  try {
    const c = fullChain(root);
    const r = verifyPromotionChainReplay(c);
    assertEq(r.overall, 'CHAIN_REPLAY_VERIFIED_CLOSED', `verified closed (blockers: ${r.blockers.join(',')})`);
    assertEq(r.chainComplete, true, 'chain complete');
    assertEq(r.operationClosed, true, 'operation closed');
    assertEq(r.terminalPhase, 235, 'terminal phase 235');
    assertEq(r.identityAnchored, true, 'identity anchored to the Phase 231 template');
    assertEq(r.suppliedCount, 5, 'five reports supplied');
    assertEq(r.blockers.length, 0, 'no blockers');
    // It replays; it does nothing else.
    assertEq(r.replayedByThisTool, true, 'this tool did replay');
    assertEq(r.performedByThisTool, false, 'this tool performed nothing');
    assertEq(r.capturedByThisTool, false, 'this tool captured nothing');
    assertEq(r.selfAuthorized, false, 'never self-authorized');
    // Every phase present, verified, linked and identity-matched.
    assertEq(r.phases.length, 5, 'five phase states');
    assert(r.phases.every((p) => p.present && p.reportIdOk && p.verified), 'all present and verified');
    assertEq(r.phases[0]!.linkedToParent, null, 'the gate is the anchor and has no parent link');
    assert(r.phases.slice(1).every((p) => p.linkedToParent === true), 'every downstream link re-derived');
    assert(r.phases.every((p) => p.identityMatched === true), 'operation identity holds across all five');
    assertEq(Object.keys(r.operationDigests).length, 5, 'the five shared operation digests are published');
    assertEq(Object.keys(r.chainDigests).length, 5, 'each phase self-digest recorded');
    assertEq(verifySelfDigests([r]).overall, 'ALL_VERIFIED', 'the replay report self-verifies');
    const json = JSON.stringify(r);
    assert(!json.includes('/mnt/') && !json.includes('catalog-authority-test-library'), 'no raw path in report');
    assert(!json.includes('phase-236-synthetic-test') && !json.includes('0a40074065d91a75ad41f33fc212e917'), 'no raw approval or item id');
    assert(![OPERATOR_DIGEST, OBSERVER_DIGEST, REVIEWER_DIGEST, CLOSER_DIGEST].some((d) => json.includes(d)), 'no operator/observer/reviewer/closer identity');
    assertEq(r.disclaimers.length, CHAIN_REPLAY_DISCLAIMERS.length, 'disclaimers stated');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an empty bundle is NO_INPUT: nothing to replay is not a failure to replay', () => {
  const r = verifyPromotionChainReplay({});
  assertEq(r.overall, 'CHAIN_REPLAY_NO_INPUT', 'no input');
  assertEq(r.terminalPhase, null, 'no terminal phase');
  assertEq(r.chainComplete, false, 'not complete');
  assertEq(r.operationClosed, false, 'nothing closed');
  assertEq(r.suppliedCount, 0, 'nothing supplied');
  assertEq(r.blockers.length, 0, 'an empty bundle is not itself a defect');
  assert(r.phases.every((p) => !p.present && p.identityMatched === null), 'every phase absent');
  assertEq(Object.keys(r.operationDigests).length, 0, 'no operation digests published');
  assert(r.redactionSafe === true && !JSON.stringify(r).includes('/mnt/'), 'redaction-safe');
});

// THE HEADLINE CASE. Two complete chains over DIFFERENT items. Every report in each is individually valid and
// self-verifying; each chain replays cleanly on its own. Spliced together they are caught here -- and nowhere
// else, because no single phase can see past its immediate parent.
await test('THE splice: a chain assembled from two operations is caught, though every report is individually valid', () => {
  const root = workspace();
  try {
    const a = fullChain(root);
    const b = fullChain(root, { itemId: '99999999999999999999999999999999', approvalId: 'phase-236-other', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-other')]) });
    // Each chain is genuine on its own.
    assertEq(verifyPromotionChainReplay(a).overall, 'CHAIN_REPLAY_VERIFIED_CLOSED', 'precondition: chain A replays');
    assertEq(verifyPromotionChainReplay(b).overall, 'CHAIN_REPLAY_VERIFIED_CLOSED', 'precondition: chain B replays');
    // Every individual report still recomputes its own digest -- individually, nothing is wrong with any of them.
    for (const rep of [a.gate, a.authorization, b.observation, b.disposition, b.closure]) {
      assertEq(verifySelfDigests([rep]).overall, 'ALL_VERIFIED', 'precondition: each spliced report is individually valid');
    }
    const spliced = { gate: a.gate, authorization: a.authorization, observation: b.observation, disposition: b.disposition, closure: b.closure };
    const r = verifyPromotionChainReplay(spliced);
    assertEq(r.overall, 'CHAIN_NOT_REPLAYABLE', 'the spliced chain is caught');
    assertEq(r.chainComplete, false, 'not a complete chain');
    assertEq(r.operationClosed, false, 'nothing closed by a spliced chain');
    // Caught two independent ways: the 232->233 link does not re-derive, AND the operation identity drifts.
    assert(r.blockers.includes('CHAIN_PHASE_233_LINK_NOT_REDERIVED'), 'the broken link is reported');
    for (const p of [233, 234, 235]) {
      assert(r.blockers.includes(`CHAIN_PHASE_${p}_OPERATION_IDENTITY_MISMATCH`), `phase ${p} identity drift reported`);
    }
    assert(r.phases.slice(2).every((p) => p.identityMatched === false), 'the grafted phases do not match the anchor');
    assert(r.phases[0]!.identityMatched === true && r.phases[1]!.identityMatched === true, 'the original head still matches itself');
    assertEq(Object.keys(r.operationDigests).length, 0, 'no operation digests published for a drifting chain');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The sharpest form of the same threat: a forgery that keeps the parent link INTACT and recomputes its own
// digest, so only the independent identity check can see it.
await test('adversarial: a forged report with a valid parent link but another operation\'s digests fails identity alone', () => {
  const root = workspace();
  try {
    const a = fullChain(root);
    const b = fullChain(root, { itemId: '88888888888888888888888888888888', approvalId: 'phase-236-graft', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-graft')]) });
    // Graft B's operation digests onto A's observation while KEEPING A's authorization-record link, then re-seal.
    const grafted = forge(a.observation, 'observation', (o) => {
      const bound = o.boundDigests as Rec;
      const bBound = b.observation.boundDigests as Rec;
      for (const k of ['operation-approval-id', 'operation-item', 'operation-source', 'operation-destination', 'operation-plan']) {
        bound[k] = bBound[k];
      }
    });
    const r = verifyPromotionChainReplay({ gate: a.gate, authorization: a.authorization, observation: grafted });
    assertEq(r.overall, 'CHAIN_NOT_REPLAYABLE', 'the graft is caught');
    // Neither the digest check nor the link check fires -- identity is the only thing that sees this.
    assert(!r.blockers.includes('CHAIN_PHASE_233_DIGEST_MISMATCH'), 'the digest check does NOT catch this');
    assert(!r.blockers.includes('CHAIN_PHASE_233_LINK_NOT_REDERIVED'), 'the link check does NOT catch this');
    assert(r.blockers.includes('CHAIN_PHASE_233_OPERATION_IDENTITY_MISMATCH'), 'the identity check does');
    assertEq(r.phases[2]!.verified, true, 'the forgery genuinely recomputes');
    assertEq(r.phases[2]!.linkedToParent, true, 'and genuinely links to its parent');
    assertEq(r.phases[2]!.identityMatched, false, 'but it is not the same operation');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: every inter-phase link is re-derived, and each broken link is caught in turn', () => {
  const root = workspace();
  try {
    const c = fullChain(root);
    const wrong = 'b'.repeat(64);
    const cases: Array<[keyof typeof SEAL, string, number, Rec]> = [
      ['authorization', 'gate-authorization', 232, { gate: c.gate }],
      ['observation', 'authorization-record', 233, { gate: c.gate, authorization: c.authorization }],
      ['disposition', 'observation-record', 234, { gate: c.gate, authorization: c.authorization, observation: c.observation }],
      ['closure', 'disposition-record', 235, { gate: c.gate, authorization: c.authorization, observation: c.observation, disposition: c.disposition }],
    ];
    for (const [slot, bindingKey, phase, prefix] of cases) {
      const broken = forge((c as unknown as Rec)[slot] as Rec, slot, (o) => { (o.boundDigests as Rec)[bindingKey] = wrong; });
      const r = verifyPromotionChainReplay({ ...prefix, [slot]: broken });
      assertEq(r.overall, 'CHAIN_NOT_REPLAYABLE', `broken ${bindingKey} link caught`);
      assert(r.blockers.includes(`CHAIN_PHASE_${phase}_LINK_NOT_REDERIVED`), `${bindingKey} -> CHAIN_PHASE_${phase}_LINK_NOT_REDERIVED`);
      assert(!r.blockers.includes(`CHAIN_PHASE_${phase}_DIGEST_MISMATCH`), 'the re-sealed forgery still recomputes cleanly');
      assertEq(r.chainComplete, false, 'a broken link is never a complete chain');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a skipped link is not a chain -- the supplied set must be a contiguous prefix', () => {
  const root = workspace();
  try {
    const c = fullChain(root);
    // A disposition handed over with no observation beneath it.
    const gap = verifyPromotionChainReplay({ gate: c.gate, authorization: c.authorization, disposition: c.disposition });
    assertEq(gap.overall, 'CHAIN_NOT_REPLAYABLE', 'a hole in the chain is not replayable');
    assert(gap.blockers.includes('CHAIN_PHASE_234_PARENT_MISSING'), 'CHAIN_PHASE_234_PARENT_MISSING reported');
    assertEq(gap.terminalPhase, 232, 'the contiguous prefix still ends at 232');
    // A whole chain with no gate under it anchors nothing and skips the very first link.
    const headless = verifyPromotionChainReplay({ authorization: c.authorization, observation: c.observation });
    assertEq(headless.overall, 'CHAIN_NOT_REPLAYABLE', 'a headless chain is not replayable');
    assert(headless.blockers.includes('CHAIN_PHASE_232_PARENT_MISSING'), 'CHAIN_PHASE_232_PARENT_MISSING reported');
    assertEq(headless.identityAnchored, false, 'nothing anchors identity without the gate');
    assertEq(headless.terminalPhase, null, 'no contiguous prefix at all');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a tampered report at any layer fails on digest recompute', () => {
  const root = workspace();
  try {
    const c = fullChain(root);
    const layers: Array<[keyof Chain, number]> = [['gate', 231], ['authorization', 232], ['observation', 233], ['disposition', 234], ['closure', 235]];
    for (const [slot, phase] of layers) {
      const tampered = JSON.parse(JSON.stringify(c[slot])) as Rec;
      tampered.injectedClaim = 'smuggled-through-a-green-chain';
      const r = verifyPromotionChainReplay({ ...c, [slot]: tampered });
      assertEq(r.overall, 'CHAIN_NOT_REPLAYABLE', `tampered phase ${phase} caught`);
      assert(r.blockers.includes(`CHAIN_PHASE_${phase}_DIGEST_MISMATCH`), `phase ${phase} -> CHAIN_PHASE_${phase}_DIGEST_MISMATCH`);
      assertEq(r.chainComplete, false, 'never a complete chain');
      assertEq(r.operationClosed, false, 'never a closed operation');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a report of the wrong kind in a chain slot is rejected', () => {
  const root = workspace();
  try {
    const c = fullChain(root);
    // The closure report handed in where the observation belongs: individually valid, structurally wrong.
    const r = verifyPromotionChainReplay({ gate: c.gate, authorization: c.authorization, observation: c.closure });
    assertEq(r.overall, 'CHAIN_NOT_REPLAYABLE', 'wrong report kind rejected');
    assert(r.blockers.includes('CHAIN_PHASE_233_REPORT_INVALID'), 'CHAIN_PHASE_233_REPORT_INVALID reported');
    assertEq(r.phases[2]!.reportIdOk, false, 'slot report id does not match');
    assertEq(r.phases[2]!.verified, false, 'and it is not treated as verified');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a gate that never emitted a template anchors nothing', () => {
  const blocked = buildExecutionAuthorization({});
  assertEq(blocked.overall, 'EXECUTION_AUTHORIZATION_BLOCKED', 'precondition: a genuine blocked gate');
  assertEq(verifySelfDigests([blocked]).overall, 'ALL_VERIFIED', 'precondition: it self-verifies');
  const r = verifyPromotionChainReplay({ gate: blocked as unknown as Rec });
  assertEq(r.overall, 'CHAIN_NOT_REPLAYABLE', 'an unanchored chain is not replayable');
  assert(r.blockers.includes('CHAIN_PHASE_231_OPERATION_IDENTITY_UNAVAILABLE'), 'CHAIN_PHASE_231_OPERATION_IDENTITY_UNAVAILABLE reported');
  assertEq(r.identityAnchored, false, 'identity not anchored');
  assertEq(Object.keys(r.operationDigests).length, 0, 'no operation digests published');
});

await test('a chain whose closure is HELD_OPEN or PENDING is verified but OPEN, never closed', () => {
  const root = workspace();
  try {
    for (const [want, item] of [['HELD_OPEN', '77777777777777777777777777777777'], ['PENDING', '66666666666666666666666666666666']] as const) {
      const c = fullChain(root, { closure: want, itemId: item, approvalId: `phase-236-${want}`, body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from(`-${want}`)]) });
      const r = verifyPromotionChainReplay(c);
      assertEq(r.overall, 'CHAIN_REPLAY_VERIFIED_OPEN', `${want} chain re-derives but is open (${r.blockers.join(',')})`);
      assertEq(r.semanticallyRederived, true, 'every phase re-derived from its source record');
      assertEq(r.blockers.length, 0, 'an unclosed operation is not a defect');
      assertEq(r.terminalPhase, 235, 'all five phases supplied');
      assertEq(r.chainComplete, true, 'the chain itself is structurally complete');
      assertEq(r.operationClosed, false, `${want} is not closed`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('every partial prefix of a genuine chain replays as VERIFIED_OPEN', () => {
  const root = workspace();
  try {
    const c = fullChain(root);
    const s = c.sources;
    const prefixes: Array<[Rec, number]> = [
      [{ gate: c.gate, sources: { gateEvidence: s.gateEvidence } }, 231],
      [{ gate: c.gate, authorization: c.authorization, sources: { gateEvidence: s.gateEvidence, authorizationDecision: s.authorizationDecision } }, 232],
      [{ gate: c.gate, authorization: c.authorization, observation: c.observation, sources: { gateEvidence: s.gateEvidence, authorizationDecision: s.authorizationDecision, observation: s.observation } }, 233],
      [{ gate: c.gate, authorization: c.authorization, observation: c.observation, disposition: c.disposition, sources: { gateEvidence: s.gateEvidence, authorizationDecision: s.authorizationDecision, observation: s.observation, disposition: s.disposition } }, 234],
    ];
    for (const [bundle, terminal] of prefixes) {
      const r = verifyPromotionChainReplay(bundle);
      assertEq(r.overall, 'CHAIN_REPLAY_VERIFIED_OPEN', `prefix to ${terminal} is open (${r.blockers.join(',')})`);
      assertEq(r.terminalPhase, terminal, `terminal phase ${terminal}`);
      assertEq(r.blockers.length, 0, 'a chain that stops partway is not a defect');
      assertEq(r.chainComplete, false, 'not complete');
      assertEq(r.operationClosed, false, 'not closed');
      assertEq(r.identityAnchored, true, 'still anchored to the gate');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Identity is checked at EVERY phase, not just where the chain happens to be spliced. Each case below keeps
// the parent link intact and re-seals, so only the identity check can see the drift.
await test('adversarial: operation-identity drift is caught at every phase in turn', () => {
  const root = workspace();
  try {
    const a = fullChain(root);
    const b = fullChain(root, { itemId: '44444444444444444444444444444444', approvalId: 'phase-236-drift', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-drift')]) });
    const OP_KEYS = ['operation-approval-id', 'operation-item', 'operation-source', 'operation-destination', 'operation-plan'];
    const cases: Array<[keyof typeof SEAL, number, Rec]> = [
      ['authorization', 232, { gate: a.gate }],
      ['observation', 233, { gate: a.gate, authorization: a.authorization }],
      ['disposition', 234, { gate: a.gate, authorization: a.authorization, observation: a.observation }],
      ['closure', 235, { gate: a.gate, authorization: a.authorization, observation: a.observation, disposition: a.disposition }],
    ];
    for (const [slot, phase, prefix] of cases) {
      const drifted = forge((a as unknown as Rec)[slot] as Rec, slot, (o) => {
        const bound = o.boundDigests as Rec;
        const other = ((b as unknown as Rec)[slot] as Rec).boundDigests as Rec;
        for (const k of OP_KEYS) bound[k] = other[k];
      });
      const r = verifyPromotionChainReplay({ ...prefix, [slot]: drifted });
      assertEq(r.overall, 'CHAIN_NOT_REPLAYABLE', `phase ${phase} identity drift caught`);
      assert(r.blockers.includes(`CHAIN_PHASE_${phase}_OPERATION_IDENTITY_MISMATCH`), `phase ${phase} -> CHAIN_PHASE_${phase}_OPERATION_IDENTITY_MISMATCH`);
      assert(!r.blockers.includes(`CHAIN_PHASE_${phase}_DIGEST_MISMATCH`), `phase ${phase}: the digest check does NOT catch this`);
      assert(!r.blockers.includes(`CHAIN_PHASE_${phase}_LINK_NOT_REDERIVED`), `phase ${phase}: the link check does NOT catch this`);
      assertEq(r.chainComplete, false, 'drift is never a complete chain');
      assertEq(r.operationClosed, false, 'drift never closes an operation');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The replay report carries its own digest, so it must be a pure function of the bundle.
await test('the replay is deterministic: the same bundle always yields the same replay digest', () => {
  const root = workspace();
  try {
    const c = fullChain(root);
    const first = verifyPromotionChainReplay(c);
    const second = verifyPromotionChainReplay({ ...c });
    assertEq(first.replayDigest, second.replayDigest, 'same bundle -> same replay digest');
    assertEq(JSON.stringify(first), JSON.stringify(second), 'same bundle -> byte-identical report');
    // A different bundle must not collide with it.
    const partial = verifyPromotionChainReplay({ gate: c.gate, authorization: c.authorization });
    assert(partial.replayDigest !== first.replayDigest, 'a different bundle yields a different digest');
    assertEq(verifySelfDigests([partial]).overall, 'ALL_VERIFIED', 'the partial replay report self-verifies too');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a smuggled raw path anywhere in the bundle fails closed and is never echoed', () => {
  const root = workspace();
  try {
    const c = fullChain(root);
    const leaky = forge(c.disposition, 'disposition', (o) => { o.blockers = ['/mnt/user/media/Movies/Chainreplay Proof (2026)/source.mp4']; });
    const r = verifyPromotionChainReplay({ ...reportsOnly(c), disposition: leaky });
    assertEq(r.overall, 'CHAIN_NOT_REPLAYABLE', 'a leaking bundle is not replayable');
    assert(r.blockers.includes('CHAIN_REDACTION_UNSAFE'), 'CHAIN_REDACTION_UNSAFE reported');
    const json = JSON.stringify(r);
    assert(!json.includes('/mnt/') && !json.includes('source.mp4'), 'the smuggled path is never echoed back');
    // A report that simply does not declare itself redaction-safe is caught the same way.
    const undeclared = forge(c.closure, 'closure', (o) => { o.redactionSafe = false; });
    assert(verifyPromotionChainReplay({ ...reportsOnly(c), closure: undeclared }).blockers.includes('CHAIN_REDACTION_UNSAFE'), 'undeclared redaction safety reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI replays a chain bundle and never echoes raw paths or ids', () => {
  const root = workspace();
  try {
    const c = fullChain(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const paths = {
      gate: w('gate.json', c.gate), authorization: w('auth.json', c.authorization),
      observation: w('obs.json', c.observation), disposition: w('disp.json', c.disposition),
      closure: w('closure.json', c.closure),
      srcGate: w('src-gate.json', c.sources.gateEvidence),
      srcAuth: w('src-auth.json', c.sources.authorizationDecision),
      srcObs: w('src-obs.json', c.sources.observation),
      srcDisp: w('src-disp.json', c.sources.disposition),
      srcClosure: w('src-closure.json', c.sources.closure),
    };
    const outPath = join(root, 'CHAINMARKER-out', 'replay.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-chain-replay-cli.ts', import.meta.url));
    const run = (args: readonly string[]) => spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], { cwd: projectRoot, encoding: 'utf8' });

    const reportFlags = ['--gate', paths.gate, '--authorization', paths.authorization, '--observation', paths.observation,
      '--disposition', paths.disposition, '--closure', paths.closure];
    const sourceFlags = ['--sourcegateevidence', paths.srcGate, '--sourceauthorizationdecision', paths.srcAuth,
      '--sourceobservation', paths.srcObs, '--sourcedisposition', paths.srcDisp, '--sourceclosure', paths.srcClosure];
    // Reports alone are resealable, so the CLI refuses a VERIFIED verdict for them: exit 5, not exit 0.
    const structural = run(reportFlags);
    assertEq(structural.status, 5, `reports-only exits STRUCTURAL_ONLY (stderr: ${structural.stderr ?? ''})`);
    assertEq((JSON.parse(structural.stdout ?? '') as Rec).overall, 'CHAIN_REPLAY_STRUCTURAL_ONLY', 'stdout structural-only');
    assertEq((JSON.parse(structural.stdout ?? '') as Rec).semanticallyRederived, false, 'nothing re-derived without sources');
    const ok = run([...reportFlags, ...sourceFlags, '--out', outPath]);
    assert(ok.error === undefined, `spawn ok: ${ok.error?.message ?? ''}`);
    assertEq(ok.status, 0, `VERIFIED_CLOSED exit 0 (stderr: ${ok.stderr ?? ''})`);
    assert(existsSync(outPath), 'report written');
    const parsed = JSON.parse(ok.stdout ?? '') as Rec;
    assertEq(parsed.overall, 'CHAIN_REPLAY_VERIFIED_CLOSED', 'stdout overall');
    assertEq(parsed.operationClosed, true, 'stdout operationClosed');
    assertEq(parsed.replayedByThisTool, true, 'stdout replayedByThisTool');
    assertEq(parsed.performedByThisTool, false, 'stdout performedByThisTool false');
    const stdout = ok.stdout ?? '';
    assert(!stdout.includes('CHAINMARKER') && !stdout.includes('catalog-authority-test-library') && !stdout.includes('/mnt/'), 'no path fragments in stdout');
    assert(!stdout.includes('phase-236-synthetic-test') && !stdout.includes('0a40074065d91a75ad41f33fc212e917'), 'no raw ids in stdout');
    assert(![OPERATOR_DIGEST, OBSERVER_DIGEST, REVIEWER_DIGEST, CLOSER_DIGEST].some((d) => stdout.includes(d)), 'no participant identity in stdout');

    // A partial chain WITH its sources re-derives and exits 3; without them it is only structural, exit 5.
    assertEq(run(['--gate', paths.gate, '--authorization', paths.authorization,
      '--sourcegateevidence', paths.srcGate, '--sourceauthorizationdecision', paths.srcAuth]).status, 3, 're-derived partial chain exits 3');
    assertEq(run(['--gate', paths.gate, '--authorization', paths.authorization]).status, 5, 'partial chain without sources exits 5');
    assertEq(run([]).status, 4, 'empty bundle exits 4');
    assertEq(run(['--gate', join(dir, 'does-not-exist.json')]).status, 2, 'unreadable input exits 2');
    // And a spliced/dis-anchored bundle exits 1.
    assertEq(run(['--authorization', paths.authorization, '--observation', paths.observation]).status, 1, 'headless chain exits 1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE POINT OF THE SEMANTIC PATH. Every structural check in this verifier is RESEALABLE: a party holding the
// bundle can rewrite a report body, recompute its self-digest, and leave every link and identity digest
// untouched. Such a forgery is structurally perfect. It must therefore NEVER earn a VERIFIED verdict on
// structure alone, and must be caught outright the moment the source records are supplied.
await test('THE reseal: a forged closure that passes every structural check is refused VERIFIED_CLOSED', () => {
  const root = workspace();
  try {
    // A genuine chain a human deliberately did NOT close out.
    const c = fullChain(root, { closure: 'HELD_OPEN' });
    assertEq((c.closure as Rec).overall, 'OPERATION_CLOSURE_HELD_OPEN', 'precondition: the operation was held open');

    // Rewrite it to claim closure, then re-seal. Links and identity digests are untouched, so every structural
    // check still passes -- this is exactly the forgery a purely structural replay would have blessed.
    const resealed = forge(c.closure, 'closure', (o) => {
      o.overall = 'OPERATION_CLOSURE_CLOSED';
      o.recordedClosure = 'CLOSED';
      o.operationClosed = true;
    });

    const structural = verifyPromotionChainReplay({ ...reportsOnly(c), closure: resealed });
    // Structure alone cannot see it: nothing recomputes wrong, nothing is unlinked, identity holds.
    assertEq(structural.blockers.length, 0, 'the forgery passes every structural check');
    assert(structural.phases.every((p) => p.verified && p.linkedToParent !== false && p.identityMatched !== false), 'structurally perfect');
    assertEq(structural.chainComplete, true, 'and looks like a complete chain');
    assertEq(structural.operationClosed, true, 'and even claims the operation is closed');
    // ...and is still refused a VERIFIED verdict, because it was never re-derived from a source record.
    assertEq(structural.overall, 'CHAIN_REPLAY_STRUCTURAL_ONLY', 'a resealed forgery earns no VERIFIED verdict');
    assertEq(structural.semanticallyRederived, false, 'nothing was re-derived');

    // With the source records supplied, the forgery is caught outright: Phase 235's own validator, re-run over
    // the closure record the human actually wrote, produces HELD_OPEN -- which cannot reproduce this digest.
    const caught = verifyPromotionChainReplay({ ...reportsOnly(c), closure: resealed, sources: c.sources });
    assertEq(caught.overall, 'CHAIN_NOT_REPLAYABLE', 'the semantic path catches the reseal');
    assert(caught.blockers.includes('CHAIN_PHASE_235_NOT_REDERIVED_FROM_SOURCE'), 'CHAIN_PHASE_235_NOT_REDERIVED_FROM_SOURCE reported');
    assert(!caught.blockers.includes('CHAIN_PHASE_235_DIGEST_MISMATCH'), 'the digest check still does NOT catch it');
    assertEq(caught.phases[4]!.rederivedFromSource, false, 'the closure did not come from its source record');
    assertEq(caught.operationClosed, false, 'nothing is closed by a forgery');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('a source record from a different operation does not re-derive its report', () => {
  const root = workspace();
  try {
    const a = fullChain(root);
    const b = fullChain(root, { itemId: '12121212121212121212121212121212', approvalId: 'phase-236-othersrc', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-othersrc')]) });
    // Chain A's reports, but B's human observation record offered as A's source.
    const r = verifyPromotionChainReplay({ ...reportsOnly(a), sources: { ...a.sources, observation: b.sources.observation } });
    assertEq(r.overall, 'CHAIN_NOT_REPLAYABLE', 'a foreign source record is caught');
    assert(r.blockers.includes('CHAIN_PHASE_233_NOT_REDERIVED_FROM_SOURCE'), 'CHAIN_PHASE_233_NOT_REDERIVED_FROM_SOURCE reported');
    assertEq(r.phases[2]!.rederivedFromSource, false, 'phase 233 not re-derived');
    assertEq(r.semanticallyRederived, false, 'the chain as a whole is unproven');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Unproven is not disproven -- but it still caps the verdict. One missing source is enough.
// THE LIMIT OF THE SEMANTIC PATH, locked so it cannot be quietly re-overclaimed. Re-derivation proves a report
// is the honest output of its validator over SOME accepted record -- it does NOT pin WHICH record. The phase
// reports are deliberately redaction-minimal, so a whole cast of different people, at different times,
// collapses to byte-identical reports and still VERIFIES.
//
// The observed BEFORE state is the ONE exception, and only since the Phase 232<->233 witnessed-state binding:
// Phase 232 now records the state its operator witnessed and Phase 233 must match it, so that value alone is
// pinned through the chain. The AFTER state is not. If this test ever starts failing, the reports began
// carrying more detail and the doc's claims must be widened to match.
await test('the semantic path does NOT pin which record: identities and times are swappable, the before-state is not', () => {
  const root = workspace();
  try {
    const c = fullChain(root);
    const OTHER = createHash('sha256').update('a-different-person-entirely').digest('hex');
    const OTHER_BEFORE = createHash('sha256').update('some-other-before-state').digest('hex');
    const OTHER_AFTER = createHash('sha256').update('some-other-after-state').digest('hex');
    const s = c.sources;

    // A wholly different operator, observer, reviewer and closer, at wholly different times.
    const swapped = {
      ...s,
      authorizationDecision: { ...(s.authorizationDecision as Rec), operatorDigest: OTHER, decidedAtUtc: '2027-01-01T00:00:00Z' },
      observation: { ...(s.observation as Rec), observerDigest: OTHER, observedAtUtc: '2027-01-01T01:00:00Z' },
      disposition: { ...(s.disposition as Rec), reviewerDigest: OTHER, reviewedAtUtc: '2027-01-01T02:00:00Z' },
      closure: { ...(s.closure as Rec), closerDigest: OTHER, closedAtUtc: '2027-01-01T03:00:00Z' },
    };
    const cast = verifyPromotionChainReplay({ ...reportsOnly(c), sources: swapped });
    assertEq(cast.overall, 'CHAIN_REPLAY_VERIFIED_CLOSED', 'a different cast of people still verifies');
    assertEq(cast.blockers.length, 0, 'and raises no blocker');
    assertEq(cast.semanticallyRederived, true, 'because the reports do not carry identity or time');

    // And the observed states themselves: Phase 233 carries only PRESENT/PENDING, never the values.
    // The AFTER state is still swappable: nothing upstream pins it, and Phase 233 carries it only as
    // PRESENT/PENDING. (Any distinct value works -- COMPLETED only requires after !== before.)
    const restated = verifyPromotionChainReplay({
      ...reportsOnly(c),
      sources: { ...s, observation: { ...(s.observation as Rec), observedStateAfterDigest: OTHER_AFTER } },
    });
    assertEq(restated.overall, 'CHAIN_REPLAY_VERIFIED_CLOSED', 'a different observed AFTER state still verifies');
    assertEq(restated.blockers.length, 0, 'the after-state is not pinned by the chain');

    // The BEFORE state, by contrast, IS pinned -- Phase 232 records the state its operator witnessed and
    // Phase 233 binds to it, so swapping it is caught. This half of the non-uniqueness is closed.
    const rewritten = verifyPromotionChainReplay({
      ...reportsOnly(c),
      sources: { ...s, observation: { ...(s.observation as Rec), observedStateBeforeDigest: OTHER_BEFORE } },
    });
    assertEq(rewritten.overall, 'CHAIN_NOT_REPLAYABLE', 'a different observed BEFORE state does NOT verify');
    assert(rewritten.blockers.includes('CHAIN_PHASE_233_NOT_REDERIVED_FROM_SOURCE'), 'the rewritten before-state breaks re-derivation');

    // The verdict must therefore disclaim exactly this, in the artifact itself.
    assert(CHAIN_REPLAY_DISCLAIMERS.some((d) => d.includes('does NOT pin WHICH source record')),
      'the emitted report disclaims that it pins which record');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('a single missing source record caps the whole verdict at STRUCTURAL_ONLY', () => {
  const root = workspace();
  try {
    const c = fullChain(root);
    assertEq(verifyPromotionChainReplay(c).overall, 'CHAIN_REPLAY_VERIFIED_CLOSED', 'precondition: the full chain verifies with every source');
    const { closure: _dropped, ...missingOne } = c.sources;
    const r = verifyPromotionChainReplay({ ...reportsOnly(c), sources: missingOne });
    assertEq(r.overall, 'CHAIN_REPLAY_STRUCTURAL_ONLY', 'one unproven phase caps the verdict');
    assertEq(r.blockers.length, 0, 'an unproven phase is not a defect -- it is simply unproven');
    assertEq(r.semanticallyRederived, false, 'the chain is not fully re-derived');
    assertEq(r.phases[4]!.rederivedFromSource, null, 'unproven is null, never false');
    assert(r.phases.slice(0, 4).every((p) => p.rederivedFromSource === true), 'the phases that did have sources re-derived');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The ACTUAL prepared, redaction-safe P227-A evidence, captured verbatim from the non-live artifacts under
// evidence/phase-231. Locked here so the verifier is exercised against the real chain offline and
// deterministically -- no SSH, no secret approval file, no live surface. NOTE: the real chain stops at Phase 232
// because no human ever approved the run; 233/234/235 CANNOT exist and none is constructed anywhere here.
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

// The real chain, offline and end to end: gate -> Phase 232, where it stops at PENDING. This function never
// builds an approved authorization, and therefore no observation, disposition or closure can follow it.
function realChain(): { gate: Rec; authorization: Rec; sources: Rec } {
  const preflightReport = buildLivePreflightPlan({ plan: REAL_PREFLIGHT_PLAN });
  const gateEvidence = {
    approvalEvidence: REAL_APPROVAL_EVIDENCE,
    approvalValidation: REAL_APPROVAL_VALIDATION,
    preflightPlan: REAL_PREFLIGHT_PLAN,
    preflightReport,
    preflightSelfDigest: verifySelfDigests([preflightReport]),
  };
  const gate = buildExecutionAuthorization(gateEvidence);
  assertEq(gate.overall, 'EXECUTION_AUTHORIZATION_TEMPLATE_READY', `precondition: real gate ready (${gate.blockers.join(',')})`);
  // The ONLY authorization record that exists for the real operation: the blank, undecided skeleton.
  const authorizationDecision = buildExecutionAuthorizationRecordSkeleton(gate)! as unknown as Rec;
  const authorization = buildExecutionAuthorizationRecord({ gate, record: authorizationDecision });
  assertEq(authorization.overall, 'EXECUTION_AUTHORIZATION_RECORD_PENDING', 'the real run has no human approval');
  return {
    gate: gate as unknown as Rec,
    authorization: authorization as unknown as Rec,
    sources: { gateEvidence: gateEvidence as unknown as Rec, authorizationDecision },
  };
}

await test('the actual P227-A chain replays consistently but LOCKS as open, terminating at Phase 232', () => {
  const { gate, authorization, sources } = realChain();
  // Reports alone are resealable, so the real bundle earns no VERIFIED verdict on its own.
  const structural = verifyPromotionChainReplay({ gate, authorization });
  assertEq(structural.overall, 'CHAIN_REPLAY_STRUCTURAL_ONLY', 'reports alone are unverified, however consistent');
  assertEq(structural.semanticallyRederived, false, 'nothing re-derived without the source records');
  assertEq(structural.operationClosed, false, 'the real operation is NOT closed');
  // With the real source records it genuinely re-derives -- and still terminates at Phase 232.
  const r = verifyPromotionChainReplay({ gate, authorization, sources });
  assertEq(r.overall, 'CHAIN_REPLAY_VERIFIED_OPEN', `the real chain re-derives as far as it goes (${r.blockers.join(',')})`);
  assertEq(r.semanticallyRederived, true, 'both real phases re-derive from their own source records');
  assertEq(r.terminalPhase, 232, 'the real chain terminates at Phase 232');
  assertEq(r.chainComplete, false, 'the real chain is NOT complete');
  assertEq(r.operationClosed, false, 'the real operation is NOT closed');
  assertEq(r.blockers.length, 0, 'stopping at 232 is not a defect -- no human approved the run');
  assertEq(r.suppliedCount, 2, 'only two reports exist for the real operation');
  assert(r.phases[2]!.present === false && r.phases[3]!.present === false && r.phases[4]!.present === false, 'no observation, disposition or closure exists');
  assertEq(r.identityAnchored, true, 'the real operation identity is anchored');
  assertEq(verifySelfDigests([r]).overall, 'ALL_VERIFIED', 'the real-chain replay report self-verifies');
  const json = JSON.stringify(r);
  assert(!json.includes('/mnt/') && !json.includes('0a40074065d91a75ad41f33fc212e917') && !json.includes('phase-231-p227-a-20260720'), 'redaction-safe: no path, no raw ids');
});

// The lock cannot be talked out of by bolting a finished-looking tail onto the real head.
await test('the actual P227-A chain stays open when handed a synthetic downstream tail', () => {
  const root = workspace();
  try {
    const real = realChain();
    const synthetic = fullChain(root, { itemId: '55555555555555555555555555555555', approvalId: 'phase-236-tail', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-tail')]) });
    const r = verifyPromotionChainReplay({
      gate: real.gate, authorization: real.authorization,
      observation: synthetic.observation, disposition: synthetic.disposition, closure: synthetic.closure,
    });
    assertEq(r.overall, 'CHAIN_NOT_REPLAYABLE', 'a grafted tail is not a replayable chain');
    assertEq(r.operationClosed, false, 'the real P227-A operation is NOT closed');
    assertEq(r.chainComplete, false, 'the real chain is NOT completed by a foreign tail');
    assert(r.blockers.includes('CHAIN_PHASE_233_OPERATION_IDENTITY_MISMATCH'), 'the tail is a different operation');
    assert(r.blockers.includes('CHAIN_PHASE_233_LINK_NOT_REDERIVED'), 'and it does not link to the real authorization');
    assertEq(Object.keys(r.operationDigests).length, 0, 'no operation digests published');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
