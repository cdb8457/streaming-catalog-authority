import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCustodyLedger,
  buildCustodyLedgerGenesisSkeleton,
  computeCustodyEventDigest,
  CUSTODY_EVENT_INPUT_ID,
  CUSTODY_GENESIS_SENTINEL,
  CUSTODY_LEDGER_DISCLAIMERS,
  CUSTODY_LEDGER_REMAINING_HUMAN_STEPS,
} from '../src/ops/promotion-chain-custody-ledger.js';
import {
  buildSuppliedSourceVerification,
  buildSuppliedSourceVerificationSkeleton,
  canonicalSourceRecordDigest,
} from '../src/ops/promotion-supplied-source-record-verification.js';
import {
  buildProvenanceCommitment,
  buildProvenanceCommitmentSkeleton,
} from '../src/ops/promotion-source-record-provenance.js';
import { verifyPromotionChainReplay } from '../src/ops/promotion-chain-replay.js';
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
const OPERATOR_DIGEST = createHash('sha256').update('phase-239-operator-under-test').digest('hex');
const OBSERVER_DIGEST = createHash('sha256').update('phase-239-observer-under-test').digest('hex');
const REVIEWER_DIGEST = createHash('sha256').update('phase-239-reviewer-under-test').digest('hex');
const CLOSER_DIGEST = createHash('sha256').update('phase-239-closer-under-test').digest('hex');
const COMMITTER_DIGEST = createHash('sha256').update('phase-239-committer-under-test').digest('hex');
const VERIFIER_DIGEST = createHash('sha256').update('phase-239-verifier-under-test').digest('hex');
// Two custodians. A transfer moves custody BETWEEN them; a transfer to yourself is not a transfer.
const CUSTODIAN_A = createHash('sha256').update('phase-239-custodian-a').digest('hex');
const CUSTODIAN_B = createHash('sha256').update('phase-239-custodian-b').digest('hex');
const DECIDED_AT = '2026-07-21T00:00:00Z';
const OBSERVED_AT = '2026-07-21T01:00:00Z';
const REVIEWED_AT = '2026-07-21T02:00:00Z';
const CLOSED_AT = '2026-07-21T03:00:00Z';
const COMMITTED_AT = '2026-07-21T04:00:00Z';
const VERIFIED_AT = '2026-07-21T05:00:00Z';
const STATE_BEFORE = createHash('sha256').update('synthetic-observed-state-before').digest('hex');
const STATE_AFTER = createHash('sha256').update('synthetic-observed-state-after').digest('hex');
// Custody happens after verification: 06:00 onward, one hour per event.
function custodyTime(i: number): string { return `2026-07-21T${String(6 + i).padStart(2, '0')}:00:00Z`; }

const MINIMAL_MP4_FIXTURE = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isomcatalog-authority-custody-fixture', 'ascii'),
]);

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-custody-')); }

type Rec = Record<string, unknown>;
interface ChainOpts { itemId?: string; approvalId?: string; body?: Buffer }
interface Sources { gateEvidence: Rec; authorizationDecision: Rec; observation: Rec; disposition: Rec; closure: Rec }
interface Chain { reports: Rec; sources: Sources }

// A COMPLETE, genuine, five-phase SYNTHETIC chain plus the source records each phase consumed. Synthetic on
// purpose: no approved authorization, recorded observation, accepted disposition, closed closure, committed
// manifest or verified submission exists for the real P227-A bundle, and this suite never constructs one.
function fullChain(root: string, o: ChainOpts = {}): Chain {
  const itemId = o.itemId ?? '0a40074065d91a75ad41f33fc212e917';
  const approvalId = o.approvalId ?? 'phase-239-synthetic-test';
  const testRoot = join(root, `catalog-authority-test-library-${itemId.slice(0, 8)}`);
  const source = join(testRoot, 'Movies', 'Custody Proof (2026)', 'source.mp4');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, o.body ?? MINIMAL_MP4_FIXTURE);
  const input = { itemId, title: 'Custody Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot: APPROVED_ROOT, approvalId };
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

  const closureRecord: Rec = {
    ...JSON.parse(JSON.stringify(buildOperationClosureSkeleton(disposition)!)) as Rec,
    closerDigest: CLOSER_DIGEST, closedAtUtc: CLOSED_AT,
    fields: {
      closureAffirmed: 'AFFIRMED',
      evidenceArchivedOutOfBand: 'AFFIRMED', chainDigestsRecordedInArchive: 'AFFIRMED',
      noOutstandingRemediation: 'AFFIRMED', evidencePurged: 'PENDING',
    },
  };
  const closure = buildOperationClosureRecord({ dispositionRecord: disposition, closure: closureRecord });
  assertEq(closure.overall, 'OPERATION_CLOSURE_CLOSED', `precondition: closed (${closure.blockers.join(',')})`);

  return {
    reports: {
      gate: gate as unknown as Rec, authorization: authorization as unknown as Rec,
      observation: observation as unknown as Rec, disposition: disposition as unknown as Rec,
      closure: closure as unknown as Rec,
    },
    sources: {
      gateEvidence: gateEvidence as unknown as Rec, authorizationDecision,
      observation: observationRecord, disposition: dispositionRecord, closure: closureRecord,
    },
  };
}

// The full stack up to a genuine Phase 238 SOURCE_RECORDS_VERIFIED report -- the only thing custody can be OF.
function verifiedReport(root: string, o: ChainOpts = {}): Rec {
  const chain = fullChain(root, o);
  const replay = verifyPromotionChainReplay({ ...chain.reports, sources: chain.sources });
  assertEq(replay.overall, 'CHAIN_REPLAY_VERIFIED_CLOSED', `precondition: replay closed (${replay.blockers.join(',')})`);
  const contents: Record<number, unknown> = {
    232: chain.sources.authorizationDecision, 233: chain.sources.observation,
    234: chain.sources.disposition, 235: chain.sources.closure,
  };
  const skeleton = JSON.parse(JSON.stringify(buildProvenanceCommitmentSkeleton(replay)!)) as Rec;
  const manifest: Rec = {
    ...skeleton,
    sourceRecords: (skeleton.sourceRecords as Rec[]).map((e) => ({
      ...e, contentDigest: canonicalSourceRecordDigest(contents[e.phase as number]),
    })),
    committerDigest: COMMITTER_DIGEST, committedAtUtc: COMMITTED_AT,
    fields: {
      commitmentAffirmed: 'AFFIRMED', sourceRecordsRetainedIndependently: 'AFFIRMED',
      sourceRecordsContentDigested: 'AFFIRMED', sourceRecordsReviewed: 'AFFIRMED', sourceRecordsBoundToThisReplay: 'AFFIRMED',
    },
  };
  const commitment = buildProvenanceCommitment({ replay, manifest });
  assertEq(commitment.overall, 'PROVENANCE_COMMITTED', `precondition: committed (${commitment.blockers.join(',')})`);
  const verificationRecord: Rec = {
    ...JSON.parse(JSON.stringify(buildSuppliedSourceVerificationSkeleton(commitment)!)) as Rec,
    verifierDigest: VERIFIER_DIGEST, verifiedAtUtc: VERIFIED_AT,
    fields: {
      verificationAffirmed: 'AFFIRMED', sourceRecordsIndependentlyRetrieved: 'AFFIRMED', sourceRecordsByteCompared: 'AFFIRMED',
    },
  };
  const verified = buildSuppliedSourceVerification({
    commitment, manifest, reports: chain.reports,
    sources: {
      authorizationDecision: chain.sources.authorizationDecision, observation: chain.sources.observation,
      disposition: chain.sources.disposition, closure: chain.sources.closure,
    },
    verification: verificationRecord,
  });
  assertEq(verified.overall, 'SOURCE_RECORDS_VERIFIED', `precondition: source records verified (${verified.blockers.join(',')})`);
  return verified as unknown as Rec;
}

interface EventSpec { transition: string; custodian?: string; time?: string }

// Build a properly linked, properly sealed ledger from a list of transitions. Every event binds to the
// verification and to the one operation; each names the recomputed digest of the one before it.
function ledgerFor(verification: Rec, specs: readonly EventSpec[]): Rec[] {
  const bound = verification.boundDigests as Rec;
  const out: Rec[] = [];
  let previous: string = CUSTODY_GENESIS_SENTINEL;
  specs.forEach((spec, i) => {
    const body: Rec = {
      record: CUSTODY_EVENT_INPUT_ID, version: 1, operation: 'promote-observe-withdraw',
      sourceVerificationReport: 'phase-238-promotion-supplied-source-record-verification',
      verificationDigest: verification.verificationDigest,
      approvalIdDigest: bound.approvalIdDigest, itemDigest: bound.itemDigest,
      sourceDigest: bound.sourceDigest, destinationDigest: bound.destinationDigest, planDigest: bound.planDigest,
      sequence: i,
      previousEventDigest: previous,
      transition: spec.transition,
      custodianDigest: spec.custodian ?? CUSTODIAN_A,
      occurredAtUtc: spec.time ?? custodyTime(i),
    };
    const eventDigest = computeCustodyEventDigest(body);
    out.push({ ...body, eventDigest });
    previous = eventDigest;
  });
  return out;
}

// A full, honest custody narrative: opened, accepted by A, retained, transferred to B, accepted by B, released.
const FULL_NARRATIVE: readonly EventSpec[] = [
  { transition: 'GENESIS' },
  { transition: 'CUSTODY_ACCEPTED' },
  { transition: 'CUSTODY_RETAINED' },
  { transition: 'CUSTODY_TRANSFERRED' },
  { transition: 'CUSTODY_ACCEPTED', custodian: CUSTODIAN_B },
  { transition: 'CUSTODY_RELEASED', custodian: CUSTODIAN_B },
];

// Re-seal a mutated event so its OWN digest recomputes cleanly. This is what a careful editor does -- and the
// point is that it still does not help them, because every LATER link still points at the old digest.
function resealEvent(event: Rec, mutate: (e: Rec) => void): Rec {
  const forged = JSON.parse(JSON.stringify(event)) as Rec;
  mutate(forged);
  delete forged.eventDigest;
  return { ...forged, eventDigest: computeCustodyEventDigest(forged) };
}

// Re-seal a mutated REPORT so it recomputes its own self-digest cleanly.
function resealReport(report: Rec, field: string, scope: string, mutate: (r: Rec) => void): Rec {
  const forged = JSON.parse(JSON.stringify(report)) as Rec;
  mutate(forged);
  delete forged[field];
  const body: Rec = {};
  for (const k of Object.keys(forged)) body[k] = forged[k];
  forged[field] = createHash('sha256').update(`${scope}:${JSON.stringify(body)}`).digest('hex');
  return forged;
}

console.log('Running Phase 239 promotion-chain custody ledger suite:\n');

await test('a genuine append-only ledger is INTACT -- and this tool held no custody and created no events', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const events = ledgerFor(verification, FULL_NARRATIVE);
    const l = buildCustodyLedger({ verification, events });
    assertEq(l.overall, 'CUSTODY_LEDGER_INTACT', `intact (blockers: ${l.blockers.join(',')})`);
    assertEq(l.ledgerIntact, true, 'ledger intact');
    assertEq(l.blockers.length, 0, 'no blockers');
    assertEq(l.eventCount, 6, 'six events');
    assertEq(l.terminalTransition, 'CUSTODY_RELEASED', 'terminal transition published');
    assert(typeof l.headEventDigest === 'string' && l.headEventDigest.length === 64, 'head event digest published');
    assert(l.chainLinked && l.transitionsValid && l.eventsWellFormed && l.eventsRedactionSafe, 'all structural checks green');
    assert(l.events.every((e) => e.digestRecomputed && e.boundToOperation && e.custodied), 'every event sealed, bound and custodied');
    assertEq(l.events[0]!.linkedToPrevious, null, 'genesis has no predecessor to link to');
    assert(l.events.slice(1).every((e) => e.linkedToPrevious === true), 'every later event links to its predecessor');
    // Recording a custody narrative is not holding custody.
    assertEq(l.custodyHeldByThisTool, false, 'this tool held no custody');
    assertEq(l.eventsCreatedByThisTool, false, 'this tool created no events');
    assertEq(l.selfAuthorized, false, 'never self-authorized');
    assertEq(l.remainingHumanSteps.length, CUSTODY_LEDGER_REMAINING_HUMAN_STEPS.length, 'remaining human steps stated');
    assertEq(l.disclaimers.length, CUSTODY_LEDGER_DISCLAIMERS.length, 'disclaimers stated');
    assertEq(verifySelfDigests([l]).overall, 'ALL_VERIFIED', 'the ledger report self-verifies');
    // Redaction: no custodian identity, no timestamp, no path.
    const json = JSON.stringify(l);
    assert(!json.includes(CUSTODIAN_A) && !json.includes(CUSTODIAN_B), 'no custodian identity echoed');
    assert(!json.includes('2026-07-21T06:00:00Z') && !json.includes('T11:00:00Z'), 'no timestamp echoed');
    assert(!json.includes('/mnt/') && !json.includes('catalog-authority-test-library'), 'no raw path echoed');
    assert(!json.includes('0a40074065d91a75ad41f33fc212e917'), 'no raw item id echoed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('the blank genesis skeleton claims nothing: it validates as PENDING and records no custody', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const genesis = JSON.parse(JSON.stringify(buildCustodyLedgerGenesisSkeleton(verification)!)) as Rec;
    assertEq(genesis.record, CUSTODY_EVENT_INPUT_ID, 'skeleton is a custody event');
    assertEq(genesis.sequence, 0, 'sequence 0');
    assertEq(genesis.transition, 'GENESIS', 'transition GENESIS');
    assertEq(genesis.previousEventDigest, CUSTODY_GENESIS_SENTINEL, 'no predecessor');
    assertEq(genesis.custodianDigest, 'PENDING', 'names no custodian');
    assertEq(genesis.occurredAtUtc, 'PENDING', 'records no time');
    assert(Object.values(genesis).every((v) => v !== true), 'the skeleton asserts nothing as true');
    const l = buildCustodyLedger({ verification, events: [genesis] });
    assertEq(l.overall, 'CUSTODY_LEDGER_PENDING', `blank genesis is the un-started state (${l.blockers.join(',')})`);
    assertEq(l.ledgerIntact, false, 'a blank genesis is not an intact custody narrative');
    assertEq(l.blockers.length, 0, 'an un-started ledger is not a defect');
    assertEq(l.eventCount, 1, 'one event');
    assertEq(l.headEventDigest, null, 'no head digest published for an un-started ledger');
    assertEq(l.events[0]!.custodied, false, 'nothing is in anyone custody yet');
    assert(!JSON.stringify(genesis).includes('/mnt/'), 'the skeleton is redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BLOCKED by default: with no verification and no events the ledger is NOT_ELIGIBLE', () => {
  const l = buildCustodyLedger({});
  assertEq(l.overall, 'NOT_ELIGIBLE', 'nothing to hold custody of');
  assertEq(l.ledgerIntact, false, 'nothing intact');
  assertEq(l.verificationEligible, false, 'not eligible');
  assertEq(l.eventCount, 0, 'no events');
  assertEq(l.terminalTransition, 'NONE', 'no terminal transition');
  assertEq(l.headEventDigest, null, 'no head digest');
  assert(l.blockers.includes('VERIFICATION_RECORD_MISSING') && l.blockers.includes('LEDGER_EVENTS_MISSING'), 'both inputs reported missing');
  assertEq(l.custodyHeldByThisTool, false, 'held nothing');
  assert(l.redactionSafe === true && !JSON.stringify(l).includes('/mnt/'), 'redaction-safe');
});

// THE structural case this phase exists for: an edit to any event WITH SUCCESSORS breaks every later link,
// even when the editor carefully re-seals the event they touched.
await test('THE mid-ledger edit: re-sealing an edited event does not save it, every later link breaks', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const events = ledgerFor(verification, FULL_NARRATIVE);
    // Rewrite who held custody at sequence 2, and re-seal that event properly.
    const edited = resealEvent(events[2]!, (e) => { e.custodianDigest = CUSTODIAN_B; });
    assertEq(computeCustodyEventDigest(edited), edited.eventDigest, 'precondition: the edited event re-seals cleanly');
    const tampered = [...events.slice(0, 2), edited, ...events.slice(3)];
    const l = buildCustodyLedger({ verification, events: tampered });
    assertEq(l.overall, 'CUSTODY_LEDGER_INVALID', 'a mid-ledger edit is caught');
    assert(l.blockers.includes('LEDGER_SPLICE_DETECTED'), 'the broken link is reported as a splice');
    assert(!l.blockers.includes('LEDGER_RESEAL_DETECTED'), 'the edited event itself re-seals cleanly -- reseal does NOT catch it');
    assertEq(l.events[3]!.linkedToPrevious, false, 'the event after the edit no longer links');
    assertEq(l.ledgerIntact, false, 'not intact');
    assertEq(l.headEventDigest, null, 'no head digest for a broken chain');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: RESEAL -- an event whose stated digest does not recompute from its body', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const events = ledgerFor(verification, FULL_NARRATIVE);
    // Edit the body and do NOT recompute: the stated digest no longer matches.
    const sloppy = { ...events[1]!, custodianDigest: CUSTODIAN_B };
    const l = buildCustodyLedger({ verification, events: [events[0]!, sloppy, ...events.slice(2)] });
    assertEq(l.overall, 'CUSTODY_LEDGER_INVALID', 'an unsealed edit is caught');
    assert(l.blockers.includes('LEDGER_RESEAL_DETECTED'), 'LEDGER_RESEAL_DETECTED reported');
    assertEq(l.events[1]!.digestRecomputed, false, 'the event does not recompute');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: SPLICE -- an event naming a parent that is not the event before it', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const events = ledgerFor(verification, FULL_NARRATIVE);
    const spliced = resealEvent(events[3]!, (e) => { e.previousEventDigest = events[0]!.eventDigest; });
    const l = buildCustodyLedger({ verification, events: [...events.slice(0, 3), spliced, ...events.slice(4)] });
    assertEq(l.overall, 'CUSTODY_LEDGER_INVALID', 'a spliced link is caught');
    assert(l.blockers.includes('LEDGER_SPLICE_DETECTED'), 'LEDGER_SPLICE_DETECTED reported');
    assertEq(l.chainLinked, false, 'chain not linked');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: FORK -- two events claiming the same parent', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const events = ledgerFor(verification, FULL_NARRATIVE);
    // Sequence 2 re-points at genesis, so genesis now has two children.
    const forked = resealEvent(events[2]!, (e) => { e.previousEventDigest = events[0]!.eventDigest; });
    const l = buildCustodyLedger({ verification, events: [...events.slice(0, 2), forked, ...events.slice(3)] });
    assertEq(l.overall, 'CUSTODY_LEDGER_INVALID', 'a fork is caught');
    assert(l.blockers.includes('LEDGER_FORK_DETECTED'), 'LEDGER_FORK_DETECTED reported');
    // Two genesis events are also a fork -- both claim to open the ledger.
    const twoGenesis = ledgerFor(verification, [{ transition: 'GENESIS' }, { transition: 'GENESIS' }]);
    const g = buildCustodyLedger({ verification, events: twoGenesis.map((e, i) => (i === 1 ? resealEvent(e, (x) => { x.previousEventDigest = CUSTODY_GENESIS_SENTINEL; }) : e)) });
    assert(g.blockers.includes('LEDGER_FORK_DETECTED'), 'two genesis events -> LEDGER_FORK_DETECTED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: TRUNCATION -- a gap in the sequence, and a ledger with no genesis', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const events = ledgerFor(verification, FULL_NARRATIVE);
    // Drop the middle event: sequences become 0,1,3,4,5.
    const gapped = [...events.slice(0, 2), ...events.slice(3)];
    const l = buildCustodyLedger({ verification, events: gapped });
    assertEq(l.overall, 'CUSTODY_LEDGER_INVALID', 'a gap is caught');
    assert(l.blockers.includes('LEDGER_TRUNCATION_DETECTED'), 'LEDGER_TRUNCATION_DETECTED reported');
    // A ledger that does not start at sequence 0 has lost its genesis.
    const headless = buildCustodyLedger({ verification, events: events.slice(1) });
    assert(headless.blockers.includes('LEDGER_GENESIS_MISSING'), 'LEDGER_GENESIS_MISSING reported');
    assertEq(headless.overall, 'CUSTODY_LEDGER_INVALID', 'a headless ledger is invalid');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// REORDER is judged on the SUPPLIED order alone, so a merely-shuffled ledger reports exactly that rather than
// an avalanche of link failures that would hide the real finding.
await test('adversarial: REORDER -- a shuffled ledger reports reordering and nothing else', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const events = ledgerFor(verification, FULL_NARRATIVE);
    const shuffled = [events[0]!, events[2]!, events[1]!, ...events.slice(3)];
    const l = buildCustodyLedger({ verification, events: shuffled });
    assertEq(l.overall, 'CUSTODY_LEDGER_INVALID', 'a reordered ledger is caught');
    assert(l.blockers.includes('LEDGER_REORDER_DETECTED'), 'LEDGER_REORDER_DETECTED reported');
    assertEq(l.blockers.length, 1, 'reordering alone is the ONLY finding: the sorted chain is otherwise sound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: DUPLICATE -- a repeated sequence and a repeated event digest', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const events = ledgerFor(verification, FULL_NARRATIVE);
    // The same event twice: same sequence AND same digest.
    const l = buildCustodyLedger({ verification, events: [events[0]!, events[1]!, events[1]!, ...events.slice(2)] });
    assertEq(l.overall, 'CUSTODY_LEDGER_INVALID', 'a duplicate is caught');
    assert(l.blockers.includes('LEDGER_DUPLICATE_SEQUENCE'), 'LEDGER_DUPLICATE_SEQUENCE reported');
    assert(l.blockers.includes('LEDGER_DUPLICATE_EVENT_DIGEST'), 'LEDGER_DUPLICATE_EVENT_DIGEST reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: INVALID_TRANSITION -- the matrix is enforced, and RELEASED is terminal', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    // GENESIS may only be followed by an acceptance.
    const badOpen = ledgerFor(verification, [{ transition: 'GENESIS' }, { transition: 'CUSTODY_RETAINED' }]);
    const a = buildCustodyLedger({ verification, events: badOpen });
    assertEq(a.overall, 'CUSTODY_LEDGER_INVALID', 'genesis -> retained rejected');
    assert(a.blockers.includes('LEDGER_INVALID_TRANSITION'), 'LEDGER_INVALID_TRANSITION reported');
    // A transfer may only be followed by the receiving custodian accepting.
    const badTransfer = ledgerFor(verification, [
      { transition: 'GENESIS' }, { transition: 'CUSTODY_ACCEPTED' }, { transition: 'CUSTODY_TRANSFERRED' }, { transition: 'CUSTODY_RETAINED', custodian: CUSTODIAN_B },
    ]);
    assert(buildCustodyLedger({ verification, events: badTransfer }).blockers.includes('LEDGER_INVALID_TRANSITION'), 'transfer -> retained rejected');
    // A release is terminal: nothing may follow it.
    const afterRelease = ledgerFor(verification, [
      { transition: 'GENESIS' }, { transition: 'CUSTODY_ACCEPTED' }, { transition: 'CUSTODY_RELEASED' }, { transition: 'CUSTODY_RETAINED' },
    ]);
    const t = buildCustodyLedger({ verification, events: afterRelease });
    assertEq(t.overall, 'CUSTODY_LEDGER_INVALID', 'appending after a release rejected');
    assert(t.blockers.includes('LEDGER_TERMINAL_CONTINUED'), 'LEDGER_TERMINAL_CONTINUED reported');
    // A genesis anywhere but the front is misplaced.
    const lateGenesis = ledgerFor(verification, [{ transition: 'GENESIS' }, { transition: 'GENESIS' }]);
    assert(buildCustodyLedger({ verification, events: lateGenesis }).blockers.includes('LEDGER_GENESIS_MISPLACED'), 'LEDGER_GENESIS_MISPLACED reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A transfer that does not move custody is not a transfer -- otherwise a ledger could grow arbitrarily long
// while recording no change of hands at all.
await test('adversarial: a transfer to the SAME custodian is not a transfer', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const selfTransfer = ledgerFor(verification, [
      { transition: 'GENESIS' }, { transition: 'CUSTODY_ACCEPTED' },
      { transition: 'CUSTODY_TRANSFERRED' }, { transition: 'CUSTODY_ACCEPTED' },
    ]);
    const l = buildCustodyLedger({ verification, events: selfTransfer });
    assertEq(l.overall, 'CUSTODY_LEDGER_INVALID', 'a transfer to yourself is rejected');
    assert(l.blockers.includes('LEDGER_TRANSFER_TO_SAME_CUSTODIAN'), 'LEDGER_TRANSFER_TO_SAME_CUSTODIAN reported');
    // The same shape with a genuine change of hands is fine.
    const real = ledgerFor(verification, [
      { transition: 'GENESIS' }, { transition: 'CUSTODY_ACCEPTED' },
      { transition: 'CUSTODY_TRANSFERRED' }, { transition: 'CUSTODY_ACCEPTED', custodian: CUSTODIAN_B },
    ]);
    assertEq(buildCustodyLedger({ verification, events: real }).overall, 'CUSTODY_LEDGER_INTACT', 'a real transfer is intact');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: time may not run backwards along the sequence', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const backwards = ledgerFor(verification, [
      { transition: 'GENESIS', time: custodyTime(3) },
      { transition: 'CUSTODY_ACCEPTED', time: custodyTime(1) },
    ]);
    const l = buildCustodyLedger({ verification, events: backwards });
    assertEq(l.overall, 'CUSTODY_LEDGER_INVALID', 'backwards time is caught');
    assert(l.blockers.includes('LEDGER_TIME_NOT_MONOTONIC'), 'LEDGER_TIME_NOT_MONOTONIC reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a custody event that names no custodian or no time is not a custody claim', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    for (const field of ['custodianDigest', 'occurredAtUtc']) {
      const events = ledgerFor(verification, FULL_NARRATIVE.slice(0, 2));
      const blanked = [events[0]!, resealEvent(events[1]!, (e) => { e[field] = 'PENDING'; })];
      const l = buildCustodyLedger({ verification, events: blanked });
      assertEq(l.overall, 'CUSTODY_LEDGER_INVALID', `a ${field}-less event outside a blank genesis is rejected`);
      assert(l.blockers.includes('LEDGER_EVENT_NOT_CUSTODIED'), `${field} PENDING -> LEDGER_EVENT_NOT_CUSTODIED`);
      assertEq(l.events[1]!.custodied, false, 'the event is not custodied');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('a verification that is not SOURCE_RECORDS_VERIFIED is NOT_ELIGIBLE, whatever the ledger says', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const events = ledgerFor(verification, FULL_NARRATIVE);
    // A genuine, self-verifying Phase 238 report that simply verified nothing.
    const pending = buildSuppliedSourceVerification({}) as unknown as Rec;
    assertEq(pending.overall, 'NOT_ELIGIBLE', 'precondition: a genuine but ineligible verification');
    assertEq(verifySelfDigests([pending]).overall, 'ALL_VERIFIED', 'precondition: it is genuine');
    assertEq(buildCustodyLedgerGenesisSkeleton(pending), null, 'no genesis skeleton for an unverified set');
    const l = buildCustodyLedger({ verification: pending, events });
    assertEq(l.overall, 'NOT_ELIGIBLE', 'nothing for custody to be of');
    assert(l.blockers.includes('VERIFICATION_RECORD_NOT_VERIFIED'), 'VERIFICATION_RECORD_NOT_VERIFIED reported');
    assertEq(l.ledgerIntact, false, 'nothing intact');
    assertEq(l.headEventDigest, null, 'no head digest');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('NOT_ELIGIBLE takes precedence over a broken ledger', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const pending = buildSuppliedSourceVerification({}) as unknown as Rec;
    for (const broken of [undefined, 'not-an-array', [], [{ record: 'wrong' }]]) {
      const l = buildCustodyLedger({ verification: pending, events: broken });
      assertEq(l.overall, 'NOT_ELIGIBLE', 'an ineligible verification wins over a broken ledger');
      assertEq(l.ledgerIntact, false, 'nothing intact');
    }
    // And a perfectly good ledger over no verification at all is still NOT_ELIGIBLE.
    const good = ledgerFor(verification, FULL_NARRATIVE);
    const l = buildCustodyLedger({ events: good });
    assertEq(l.overall, 'NOT_ELIGIBLE', 'a good ledger over nothing is still not eligible');
    assert(l.blockers.includes('VERIFICATION_RECORD_MISSING'), 'VERIFICATION_RECORD_MISSING reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a green-bodied but tampered Phase 238 verification fails on digest recompute', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const events = ledgerFor(verification, FULL_NARRATIVE);
    const tampered = JSON.parse(JSON.stringify(verification)) as Rec;
    tampered.injectedClaim = 'smuggled-through-a-green-verification';
    const l = buildCustodyLedger({ verification: tampered, events });
    assertEq(l.overall, 'NOT_ELIGIBLE', 'a tampered verification is not eligible');
    assert(l.blockers.includes('VERIFICATION_RECORD_DIGEST_MISMATCH'), 'VERIFICATION_RECORD_DIGEST_MISMATCH reported');
    assertEq(Object.keys(l.boundDigests).length, 0, 'no digests bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A self-digest is not a signature: a forger who rebuilds it walks straight into the semantic checks, which
// are the only thing between a fabricated verification and a custody ledger over it.
await test('adversarial: a FORGED Phase 238 verification that recomputes its own digest is caught by the eligibility checks', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const events = ledgerFor(verification, FULL_NARRATIVE);
    const SCOPE = 'phase-238-supplied-source-record-verification';
    const cases: Array<[string, (r: Rec) => void, string]> = [
      ['the verification is not redaction-safe', (r) => { r.redactionSafe = false; }, 'VERIFICATION_RECORD_NOT_REDACTION_SAFE'],
      ['its recorded decision is not VERIFIED', (r) => { r.recordedVerification = 'PENDING'; }, 'VERIFICATION_RECORD_DECISION_NOT_VERIFIED'],
      ['the verified flag is quietly false', (r) => { r.sourceRecordsVerified = false; }, 'VERIFICATION_RECORD_NOT_MARKED_VERIFIED'],
      ['the commitment beneath it was not eligible', (r) => { r.commitmentEligible = false; }, 'VERIFICATION_RECORD_COMMITMENT_NOT_ELIGIBLE'],
      ['content digests did not actually match', (r) => { r.allContentDigestsMatched = false; }, 'VERIFICATION_RECORD_CONTENT_DIGESTS_NOT_MATCHED'],
      ['reports did not actually re-derive', (r) => { r.allReportsRederived = false; }, 'VERIFICATION_RECORD_REPORTS_NOT_REDERIVED'],
      ['it claims to have retrieved records itself', (r) => { r.retrievedByThisTool = true; }, 'VERIFICATION_RECORD_RETRIEVED_CLAIMED'],
      ['blockers were recorded under a green headline', (r) => { r.blockers = ['SOMETHING_FAILED']; }, 'VERIFICATION_RECORD_BLOCKERS_PRESENT'],
      ['mismatches were recorded under a green headline', (r) => { r.mismatches = ['SOMETHING_MISMATCHED']; }, 'VERIFICATION_RECORD_MISMATCHES_PRESENT'],
      ['its chain bindings were stripped', (r) => { r.boundDigests = {}; }, 'VERIFICATION_RECORD_OPERATION_DIGESTS_INCOMPLETE'],
    ];
    for (const [what, mutate, code] of cases) {
      const forged = resealReport(verification, 'verificationDigest', SCOPE, mutate);
      assertEq(verifySelfDigests([forged]).overall, 'ALL_VERIFIED', `precondition: ${what} recomputes cleanly`);
      assertEq((forged as Rec).overall, 'SOURCE_RECORDS_VERIFIED', `precondition: ${what} keeps a green headline`);
      const l = buildCustodyLedger({ verification: forged, events });
      assertEq(l.overall, 'NOT_ELIGIBLE', `forged verification rejected: ${what}`);
      assert(!l.blockers.includes('VERIFICATION_RECORD_DIGEST_MISMATCH'), `${what}: the digest check does NOT catch this`);
      assert(l.blockers.includes(code), `${what} -> ${code}`);
      assertEq(buildCustodyLedgerGenesisSkeleton(forged), null, `no skeleton over a forged verification: ${what}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: malformed sequences, enums, digests and timestamps fail closed', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const base = ledgerFor(verification, FULL_NARRATIVE.slice(0, 2));
    const cases: Array<[string, Rec, string]> = [
      ['a fractional sequence', { sequence: 1.5 }, 'EVENT_SEQUENCE_INVALID'],
      ['a negative sequence', { sequence: -1 }, 'EVENT_SEQUENCE_INVALID'],
      ['an out-of-enum transition', { transition: 'CUSTODY_PROBABLY_FINE' }, 'EVENT_TRANSITION_INVALID'],
      ['a malformed previous digest', { previousEventDigest: 'not-a-digest' }, 'EVENT_PREVIOUS_DIGEST_INVALID'],
      ['a malformed custodian digest', { custodianDigest: 'somebody' }, 'EVENT_CUSTODIAN_DIGEST_INVALID'],
      ['a loose timestamp', { occurredAtUtc: '21 July 2026' }, 'EVENT_OCCURRED_AT_INVALID'],
      ['a malformed event digest', { eventDigest: 'nope' }, 'EVENT_DIGEST_INVALID'],
      ['a wrong version', { version: 2 }, 'EVENT_VERSION_UNSUPPORTED'],
      ['a wrong operation', { operation: 'something-else' }, 'EVENT_OPERATION_MISMATCH'],
      ['a wrong source report', { sourceVerificationReport: 'phase-999-nope' }, 'EVENT_SOURCE_REPORT_MISMATCH'],
    ];
    for (const [what, over, code] of cases) {
      const l = buildCustodyLedger({ verification, events: [base[0]!, { ...base[1]!, ...over }] });
      assertEq(l.overall, 'CUSTODY_LEDGER_INVALID', `rejected: ${what}`);
      assert(l.blockers.includes(code), `${what} -> ${code}`);
      assertEq(l.ledgerIntact, false, `nothing intact: ${what}`);
    }
    // An event bound to a different operation, and one bound to a different verification.
    const foreign = buildCustodyLedger({ verification, events: [base[0]!, { ...base[1]!, itemDigest: 'a'.repeat(64) }] });
    assert(foreign.blockers.includes('EVENT_ITEM_DIGEST_MISMATCH'), 'a foreign operation digest -> EVENT_ITEM_DIGEST_MISMATCH');
    const unbound = buildCustodyLedger({ verification, events: [base[0]!, { ...base[1]!, verificationDigest: 'b'.repeat(64) }] });
    assert(unbound.blockers.includes('EVENT_NOT_BOUND_TO_VERIFICATION'), 'a foreign verification digest -> EVENT_NOT_BOUND_TO_VERIFICATION');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// REGRESSION, from independent review. The old predicate was `regex && Number.isFinite(Date.parse(v))`, and
// for an ISO-SHAPED string V8 NORMALISES out-of-range components instead of rejecting them -- so a timestamp
// naming a day that never happened was ACCEPTED and silently meant a different day: 2026-02-30 became
// 2026-03-02, 2026-02-29 (not a leap year) became 2026-03-01, 2026-04-31 became 2026-05-01, and
// 2026-01-01T24:00:00Z became the NEXT DAY at 00:00:00. A custody event's time is pinned by this ledger and
// ordered by its monotonicity check, so an impossible moment must fail closed rather than be quietly moved.
// Each case is RESEALED so the event stays self-consistent: only the timestamp check can reject it.
await test('REGRESSION: an impossible calendar timestamp is rejected, never silently normalised', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const base = ledgerFor(verification, FULL_NARRATIVE.slice(0, 2));
    const impossible: ReadonlyArray<readonly [string, string]> = [
      ['30 February', '2026-02-30T12:00:00Z'],
      ['29 February in a non-leap year', '2026-02-29T12:00:00Z'],
      ['31 April', '2026-04-31T12:00:00Z'],
      ['31 June', '2026-06-31T12:00:00Z'],
      ['31 September', '2026-09-31T12:00:00Z'],
      ['31 November', '2026-11-31T12:00:00Z'],
      ['hour 24', '2026-01-01T24:00:00Z'],
      ['day 00', '2026-01-00T12:00:00Z'],
      ['month 00', '2026-00-10T12:00:00Z'],
      ['month 13', '2026-13-01T12:00:00Z'],
      ['minute 60', '2026-01-01T12:60:00Z'],
      ['second 60', '2026-01-01T12:00:60Z'],
    ];
    for (const [what, stamp] of impossible) {
      const event = resealEvent(base[1]!, (e) => { e.occurredAtUtc = stamp; });
      const l = buildCustodyLedger({ verification, events: [base[0]!, event] });
      assertEq(l.overall, 'CUSTODY_LEDGER_INVALID', `rejected: ${what}`);
      assert(l.blockers.includes('EVENT_OCCURRED_AT_INVALID'), `${what} -> EVENT_OCCURRED_AT_INVALID`);
      assert(!l.blockers.includes('LEDGER_RESEAL_DETECTED'), `${what}: the event is self-consistent, so ONLY the timestamp check rejects it`);
      assertEq(l.ledgerIntact, false, `nothing intact: ${what}`);
    }
    // Real moments must still be accepted -- including a genuine leap day, which a naive month/day table
    // would wrongly reject. These are only asserted not to trip the timestamp check: moving an event's time
    // can legitimately trip the separate monotonicity rule, which is not what this test is about.
    const real: ReadonlyArray<readonly [string, string]> = [
      ['a genuine leap day', '2024-02-29T12:00:00Z'],
      ['the last second of a year', '2026-12-31T23:59:59Z'],
      ['midnight', '2026-07-21T00:00:00Z'],
      ['31 December', '2026-12-31T00:00:00Z'],
    ];
    for (const [what, stamp] of real) {
      const event = resealEvent(base[1]!, (e) => { e.occurredAtUtc = stamp; });
      const l = buildCustodyLedger({ verification, events: [base[0]!, event] });
      assert(!l.blockers.includes('EVENT_OCCURRED_AT_INVALID'), `${what} is a real moment and must be accepted`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A custodian writes these by hand, so an off-allowlist field or a raw path is exactly the leak to expect.
await test('adversarial: an unknown field and a smuggled raw path fail closed and are never echoed', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const base = ledgerFor(verification, FULL_NARRATIVE.slice(0, 2));
    const noted = buildCustodyLedger({ verification, events: [base[0]!, { ...base[1]!, custodyNote: 'looked fine' }] });
    assertEq(noted.overall, 'CUSTODY_LEDGER_INVALID', 'an off-allowlist field is rejected on its own merits');
    assert(noted.blockers.includes('EVENT_UNKNOWN_FIELD'), 'EVENT_UNKNOWN_FIELD reported');
    assertEq(noted.eventsRedactionSafe, true, 'a benign unknown field is still redaction-safe');

    const leaky = buildCustodyLedger({
      verification,
      events: [base[0]!, { ...base[1]!, custodyNote: '/mnt/user/media/Movies/Custody Proof (2026)/source.mp4' }],
    });
    assertEq(leaky.overall, 'CUSTODY_LEDGER_INVALID', 'a smuggled path is rejected');
    assert(leaky.blockers.includes('LEDGER_EVENTS_LIVE_SURFACE'), 'LEDGER_EVENTS_LIVE_SURFACE reported');
    assertEq(leaky.eventsRedactionSafe, false, 'the ledger is not redaction-safe');
    const json = JSON.stringify(leaky);
    assert(!json.includes('/mnt/') && !json.includes('source.mp4'), 'the smuggled path is never echoed back');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('the event digest ignores key order but not content', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const [genesis] = ledgerFor(verification, [{ transition: 'GENESIS' }]);
    // The same event with its keys written in a different order digests identically.
    const reordered: Rec = {};
    for (const k of Object.keys(genesis as Rec).reverse()) reordered[k] = (genesis as Rec)[k];
    assertEq(computeCustodyEventDigest(reordered), computeCustodyEventDigest(genesis as Rec), 'key order does not change the digest');
    assertEq(reordered.eventDigest, (genesis as Rec).eventDigest, 'so the stated digest still recomputes');
    // This genesis names a real custodian and time, so it is a valid single-event ledger, not the blank state.
    assertEq(buildCustodyLedger({ verification, events: [reordered] }).overall, 'CUSTODY_LEDGER_INTACT', 'and it still validates');
    // The BLANK genesis, by contrast, is the un-started state whichever key order it is written in.
    const blank = JSON.parse(JSON.stringify(buildCustodyLedgerGenesisSkeleton(verification)!)) as Rec;
    const blankReordered: Rec = {};
    for (const k of Object.keys(blank).reverse()) blankReordered[k] = blank[k];
    assertEq(buildCustodyLedger({ verification, events: [blankReordered] }).overall, 'CUSTODY_LEDGER_PENDING', 'a blank genesis stays PENDING');
    // Changing content changes the digest.
    assert(computeCustodyEventDigest({ ...(genesis as Rec), custodianDigest: CUSTODIAN_B }) !== computeCustodyEventDigest(genesis as Rec), 'content changes the digest');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI validates a ledger, writes a blank genesis, and never echoes custodians or raw paths', () => {
  const root = workspace();
  try {
    const verification = verifiedReport(root);
    const events = ledgerFor(verification, FULL_NARRATIVE);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const verificationPath = w('verification.json', verification);
    const eventsPath = w('events.json', events);
    const outPath = join(root, 'CUSTODYMARKER-out', 'ledger.json');
    const genesisPath = join(root, 'CUSTODYMARKER-out', 'genesis.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-chain-custody-ledger-cli.ts', import.meta.url));
    const run = (args: readonly string[]) => spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], { cwd: projectRoot, encoding: 'utf8' });

    const ok = run(['--verification', verificationPath, '--events', eventsPath, '--out', outPath, '--skeletonout', genesisPath]);
    assert(ok.error === undefined, `spawn ok: ${ok.error?.message ?? ''}`);
    assertEq(ok.status, 0, `INTACT exit 0 (stderr: ${ok.stderr ?? ''})`);
    assert(existsSync(outPath) && existsSync(genesisPath), 'report and genesis written');
    const parsed = JSON.parse(ok.stdout ?? '') as Rec;
    assertEq(parsed.overall, 'CUSTODY_LEDGER_INTACT', 'stdout overall');
    assertEq(parsed.eventCount, 6, 'stdout event count');
    assertEq(parsed.custodyHeldByThisTool, false, 'stdout custodyHeldByThisTool false');
    assertEq(parsed.eventsCreatedByThisTool, false, 'stdout eventsCreatedByThisTool false');
    assertEq(parsed.skeletonWritten, true, 'stdout reports the genesis');
    // The written genesis is blank whatever ledger it was emitted alongside.
    const genesis = JSON.parse(readFileSync(genesisPath, 'utf8')) as Rec;
    assertEq(genesis.custodianDigest, 'PENDING', 'written genesis names no custodian');
    assertEq(genesis.occurredAtUtc, 'PENDING', 'written genesis records no time');
    const stdout = ok.stdout ?? '';
    assert(!stdout.includes('CUSTODYMARKER') && !stdout.includes('catalog-authority-test-library') && !stdout.includes('/mnt/'), 'no path fragments in stdout');
    assert(!stdout.includes(CUSTODIAN_A) && !stdout.includes(CUSTODIAN_B), 'no custodian identity in stdout');
    assert(!stdout.includes('T06:00:00Z'), 'no timestamp in stdout');

    // The blank genesis exits 3; a broken ledger exits 1; nothing to hold custody of exits 5; a bad file exits 2.
    const blankLedgerPath = w('blank-ledger.json', [genesis]);
    assertEq(run(['--verification', verificationPath, '--events', blankLedgerPath]).status, 3, 'blank genesis exits 3');
    // --events takes a JSON ARRAY: a bare event object is a malformed ledger, not a one-event one.
    assertEq(run(['--verification', verificationPath, '--events', genesisPath]).status, 1, 'a bare event object exits 1');
    const brokenPath = w('broken.json', [events[0]!, events[2]!]);
    assertEq(run(['--verification', verificationPath, '--events', brokenPath]).status, 1, 'a broken ledger exits 1');
    assertEq(run(['--events', eventsPath]).status, 5, 'no verification exits 5');
    assertEq(run(['--verification', join(dir, 'does-not-exist.json')]).status, 2, 'unreadable input exits 2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The ACTUAL prepared, redaction-safe P227-A evidence, captured verbatim from the non-live artifacts under
// evidence/phase-231. NOTE: no approved authorization, recorded observation, accepted disposition, closed
// closure, committed manifest, verified submission or custody ledger is constructed for it anywhere here.
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

// The real chain stops at Phase 232 PENDING because no human approved the run: its replay is VERIFIED_OPEN,
// its Phase 237 commitment is NOT_ELIGIBLE, and so is its Phase 238 verification. This builds no commitment,
// no verified submission, and no custody event.
function realVerification(): Rec {
  const preflightReport = buildLivePreflightPlan({ plan: REAL_PREFLIGHT_PLAN });
  const gateEvidence = {
    approvalEvidence: REAL_APPROVAL_EVIDENCE, approvalValidation: REAL_APPROVAL_VALIDATION,
    preflightPlan: REAL_PREFLIGHT_PLAN, preflightReport, preflightSelfDigest: verifySelfDigests([preflightReport]),
  };
  const gate = buildExecutionAuthorization(gateEvidence);
  assertEq(gate.overall, 'EXECUTION_AUTHORIZATION_TEMPLATE_READY', `precondition: real gate ready (${gate.blockers.join(',')})`);
  const authorizationDecision = buildExecutionAuthorizationRecordSkeleton(gate)! as unknown as Rec;
  const authorization = buildExecutionAuthorizationRecord({ gate, record: authorizationDecision });
  assertEq(authorization.overall, 'EXECUTION_AUTHORIZATION_RECORD_PENDING', 'the real run has no human approval');
  const replay = verifyPromotionChainReplay({ gate, authorization, sources: { gateEvidence, authorizationDecision } });
  assertEq(replay.overall, 'CHAIN_REPLAY_VERIFIED_OPEN', 'precondition: the real replay is open');
  const commitment = buildProvenanceCommitment({ replay });
  assertEq(commitment.overall, 'NOT_ELIGIBLE', 'the real chain has no provenance commitment');
  const verification = buildSuppliedSourceVerification({ commitment });
  assertEq(verification.overall, 'NOT_ELIGIBLE', 'the real chain has no verified source records');
  return verification as unknown as Rec;
}

await test('the actual P227-A chain is LOCKED as NOT_ELIGIBLE: nothing verified for custody to be of', () => {
  const verification = realVerification();
  assertEq(buildCustodyLedgerGenesisSkeleton(verification), null, 'no genesis exists for the real chain');
  const l = buildCustodyLedger({ verification });
  assertEq(l.overall, 'NOT_ELIGIBLE', 'the real chain can hold no custody ledger');
  assertEq(l.ledgerIntact, false, 'nothing intact');
  assertEq(l.verificationEligible, false, 'not eligible');
  assertEq(l.eventCount, 0, 'no custody events for the real run');
  assertEq(l.terminalTransition, 'NONE', 'no terminal transition');
  assertEq(l.headEventDigest, null, 'nothing pinned');
  assert(l.blockers.includes('VERIFICATION_RECORD_NOT_VERIFIED'), 'VERIFICATION_RECORD_NOT_VERIFIED reported');
  assert(l.blockers.includes('LEDGER_EVENTS_MISSING'), 'and no events exist either');
  assertEq(l.custodyHeldByThisTool, false, 'this tool held no custody');
  assertEq(l.eventsCreatedByThisTool, false, 'this tool created no events');
  assertEq(verifySelfDigests([l]).overall, 'ALL_VERIFIED', 'the real-chain report self-verifies');
  const json = JSON.stringify(l);
  assert(!json.includes('/mnt/') && !json.includes('0a40074065d91a75ad41f33fc212e917') && !json.includes('phase-231-p227-a-20260720'), 'redaction-safe: no path, no raw ids');
});

// The lock cannot be talked out of: a perfectly-formed custody narrative shaped for the real operation still
// cannot hold custody of a source-record set that was never verified.
await test('the actual P227-A chain stays NOT_ELIGIBLE even against a fully-formed INTACT ledger', () => {
  const verification = realVerification();
  const fabricated = [0, 1].map((i) => {
    const body: Rec = {
      record: CUSTODY_EVENT_INPUT_ID, version: 1, operation: 'promote-observe-withdraw',
      sourceVerificationReport: 'phase-238-promotion-supplied-source-record-verification',
      verificationDigest: verification.verificationDigest,
      approvalIdDigest: REAL_APPROVAL_EVIDENCE.approvalIdDigest, itemDigest: REAL_APPROVAL_EVIDENCE.itemDigest,
      sourceDigest: REAL_APPROVAL_EVIDENCE.sourceRealPathDigest,
      destinationDigest: REAL_APPROVAL_EVIDENCE.destinationPathDigest,
      planDigest: REAL_APPROVAL_EVIDENCE.sourceSha256,
      sequence: i,
      previousEventDigest: CUSTODY_GENESIS_SENTINEL,
      transition: i === 0 ? 'GENESIS' : 'CUSTODY_ACCEPTED',
      custodianDigest: CUSTODIAN_A, occurredAtUtc: custodyTime(i),
    };
    return { ...body, eventDigest: computeCustodyEventDigest(body) };
  });
  const l = buildCustodyLedger({ verification, events: fabricated });
  assertEq(l.overall, 'NOT_ELIGIBLE', 'still not eligible');
  assertEq(l.ledgerIntact, false, 'the real P227-A chain holds no custody');
  assertEq(l.headEventDigest, null, 'nothing pinned');
  assertEq(Object.keys(l.boundDigests).length, 0, 'no digests bound');
  assert(l.blockers.includes('VERIFICATION_RECORD_NOT_VERIFIED'), 'the unverified source records are the finding');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
