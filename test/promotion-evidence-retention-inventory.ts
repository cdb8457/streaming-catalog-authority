import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRetentionInventory,
  buildRetentionInventorySkeleton,
  RETENTION_INVENTORY_DISCLAIMERS,
  RETENTION_INVENTORY_INPUT_ID,
  RETENTION_INVENTORY_REMAINING_HUMAN_STEPS,
} from '../src/ops/promotion-evidence-retention-inventory.js';
import {
  buildCustodyLedger,
  computeCustodyEventDigest,
  CUSTODY_EVENT_INPUT_ID,
  CUSTODY_GENESIS_SENTINEL,
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
const OPERATOR_DIGEST = createHash('sha256').update('phase-240-operator-under-test').digest('hex');
const OBSERVER_DIGEST = createHash('sha256').update('phase-240-observer-under-test').digest('hex');
const REVIEWER_DIGEST = createHash('sha256').update('phase-240-reviewer-under-test').digest('hex');
const CLOSER_DIGEST = createHash('sha256').update('phase-240-closer-under-test').digest('hex');
const COMMITTER_DIGEST = createHash('sha256').update('phase-240-committer-under-test').digest('hex');
const VERIFIER_DIGEST = createHash('sha256').update('phase-240-verifier-under-test').digest('hex');
const CUSTODIAN_A = createHash('sha256').update('phase-240-custodian-a').digest('hex');
const CUSTODIAN_B = createHash('sha256').update('phase-240-custodian-b').digest('hex');
const INVENTORY_CUSTODIAN = createHash('sha256').update('phase-240-inventory-custodian').digest('hex');
const DECIDED_AT = '2026-07-21T00:00:00Z';
const OBSERVED_AT = '2026-07-21T01:00:00Z';
const REVIEWED_AT = '2026-07-21T02:00:00Z';
const CLOSED_AT = '2026-07-21T03:00:00Z';
const COMMITTED_AT = '2026-07-21T04:00:00Z';
const VERIFIED_AT = '2026-07-21T05:00:00Z';
const INVENTORIED_AT = '2026-07-22T09:00:00Z';
const STATE_BEFORE = createHash('sha256').update('synthetic-observed-state-before').digest('hex');
const STATE_AFTER = createHash('sha256').update('synthetic-observed-state-after').digest('hex');
function custodyTime(i: number): string { return `2026-07-21T${String(6 + i).padStart(2, '0')}:00:00Z`; }

const MINIMAL_MP4_FIXTURE = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isomcatalog-authority-inventory-fixture', 'ascii'),
]);

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-inventory-')); }

type Rec = Record<string, unknown>;
// `witnessedBefore` varies only the observed state the operator witnessed -- never the item, approval or
// bytes -- so a chain built with a different one is a genuine ALTERNATE chain for the SAME operation:
// identical operation digests throughout, different report digests at every phase.
//
// Note it has to be THIS field and not, say, the operator digest or a timestamp: the reports are deliberately
// redaction-minimal and echo neither, so two runs differing only in who acted or when are byte-identical and
// there is no alternate chain to tell apart. Phase 232 publishes the witnessed before-state in boundDigests,
// so changing it genuinely cascades a different digest down the whole chain.
interface ChainOpts { itemId?: string; approvalId?: string; body?: Buffer; release?: boolean; witnessedBefore?: string }

// phase -> that report's own self-digest field, for reading an artifact's real digest.
const DIGEST_FIELD: Readonly<Record<number, string>> = {
  231: 'authorizationDigest', 232: 'recordDigest', 233: 'observationDigest', 234: 'dispositionDigest',
  235: 'closureDigest', 236: 'replayDigest', 237: 'provenanceDigest', 238: 'verificationDigest', 239: 'ledgerDigest',
};
const PHASES: readonly number[] = [231, 232, 233, 234, 235, 236, 237, 238, 239];
function artifactDigestOf(phase: number, report: Rec): string { return report[DIGEST_FIELD[phase]!] as string; }

interface Stack { reports: Record<string, Rec>; ledger: Rec }

// The WHOLE synthetic chain, Phases 231-239, ending in a released custody ledger -- the only thing an
// inventory can be taken of. Synthetic on purpose: no approved authorization, recorded observation, accepted
// disposition, closed closure, committed manifest, verified submission or intact ledger exists for the real
// P227-A bundle, and this suite never constructs one.
function fullStack(root: string, o: ChainOpts = {}): Stack {
  const itemId = o.itemId ?? '0a40074065d91a75ad41f33fc212e917';
  const approvalId = o.approvalId ?? 'phase-240-synthetic-test';
  const testRoot = join(root, `catalog-authority-test-library-${itemId.slice(0, 8)}`);
  const source = join(testRoot, 'Movies', 'Inventory Proof (2026)', 'source.mp4');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, o.body ?? MINIMAL_MP4_FIXTURE);
  const input = { itemId, title: 'Inventory Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot: APPROVED_ROOT, approvalId };
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
    observedStateBeforeDigest: o.witnessedBefore ?? STATE_BEFORE,
    fields: { operatorAuthorized: 'AFFIRMED', observedStateWitnessedBefore: 'AFFIRMED', withdrawalPathRehearsed: 'AFFIRMED', observedStateWitnessedAfter: 'PENDING', runExecutedByHuman: 'PENDING' },
  };
  const authorization = buildExecutionAuthorizationRecord({ gate, record: authorizationDecision });
  assertEq(authorization.overall, 'EXECUTION_AUTHORIZATION_RECORD_APPROVED', `precondition: approved (${authorization.blockers.join(',')})`);

  const observationRecord: Rec = {
    ...JSON.parse(JSON.stringify(buildPostRunObservationSkeleton(authorization)!)) as Rec,
    observedRunOutcome: 'COMPLETED',
    observedStateBeforeDigest: o.witnessedBefore ?? STATE_BEFORE, observedStateAfterDigest: STATE_AFTER,
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
      closureAffirmed: 'AFFIRMED', evidenceArchivedOutOfBand: 'AFFIRMED',
      chainDigestsRecordedInArchive: 'AFFIRMED', noOutstandingRemediation: 'AFFIRMED', evidencePurged: 'PENDING',
    },
  };
  const closure = buildOperationClosureRecord({ dispositionRecord: disposition, closure: closureRecord });
  assertEq(closure.overall, 'OPERATION_CLOSURE_CLOSED', `precondition: closed (${closure.blockers.join(',')})`);

  const chainReports = { gate, authorization, observation, disposition, closure } as unknown as Rec;
  const sources = { gateEvidence, authorizationDecision, observation: observationRecord, disposition: dispositionRecord, closure: closureRecord } as unknown as Rec;
  const replay = verifyPromotionChainReplay({ ...(chainReports as object), sources } as never);
  assertEq(replay.overall, 'CHAIN_REPLAY_VERIFIED_CLOSED', `precondition: replay closed (${replay.blockers.join(',')})`);

  const contents: Record<number, unknown> = {
    232: authorizationDecision, 233: observationRecord, 234: dispositionRecord, 235: closureRecord,
  };
  const manifestSkeleton = JSON.parse(JSON.stringify(buildProvenanceCommitmentSkeleton(replay)!)) as Rec;
  const manifest: Rec = {
    ...manifestSkeleton,
    sourceRecords: (manifestSkeleton.sourceRecords as Rec[]).map((e) => ({
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
    fields: { verificationAffirmed: 'AFFIRMED', sourceRecordsIndependentlyRetrieved: 'AFFIRMED', sourceRecordsByteCompared: 'AFFIRMED' },
  };
  const verification = buildSuppliedSourceVerification({
    commitment, manifest, reports: chainReports as never,
    sources: { authorizationDecision, observation: observationRecord, disposition: dispositionRecord, closure: closureRecord } as never,
    verification: verificationRecord,
  } as never);
  assertEq(verification.overall, 'SOURCE_RECORDS_VERIFIED', `precondition: source records verified (${verification.blockers.join(',')})`);

  // A full, honest custody narrative. `release: false` stops at RETAINED -- intact, but custody still open.
  const specs = o.release === false
    ? [{ transition: 'GENESIS' }, { transition: 'CUSTODY_ACCEPTED' }, { transition: 'CUSTODY_RETAINED' }]
    : [
        { transition: 'GENESIS' }, { transition: 'CUSTODY_ACCEPTED' }, { transition: 'CUSTODY_RETAINED' },
        { transition: 'CUSTODY_TRANSFERRED' }, { transition: 'CUSTODY_ACCEPTED', custodian: CUSTODIAN_B },
        { transition: 'CUSTODY_RELEASED', custodian: CUSTODIAN_B },
      ];
  const bound = (verification as unknown as Rec).boundDigests as Rec;
  const events: Rec[] = [];
  let previous: string = CUSTODY_GENESIS_SENTINEL;
  specs.forEach((spec, i) => {
    const body: Rec = {
      record: CUSTODY_EVENT_INPUT_ID, version: 1, operation: 'promote-observe-withdraw',
      sourceVerificationReport: 'phase-238-promotion-supplied-source-record-verification',
      verificationDigest: (verification as unknown as Rec).verificationDigest,
      approvalIdDigest: bound.approvalIdDigest, itemDigest: bound.itemDigest,
      sourceDigest: bound.sourceDigest, destinationDigest: bound.destinationDigest, planDigest: bound.planDigest,
      sequence: i, previousEventDigest: previous, transition: spec.transition,
      custodianDigest: (spec as { custodian?: string }).custodian ?? CUSTODIAN_A,
      occurredAtUtc: custodyTime(i),
    };
    const eventDigest = computeCustodyEventDigest(body);
    events.push({ ...body, eventDigest });
    previous = eventDigest;
  });
  const ledger = buildCustodyLedger({ verification, events });
  assertEq(ledger.overall, 'CUSTODY_LEDGER_INTACT', `precondition: ledger intact (${ledger.blockers.join(',')})`);

  return {
    reports: {
      231: gate as unknown as Rec, 232: authorization as unknown as Rec, 233: observation as unknown as Rec,
      234: disposition as unknown as Rec, 235: closure as unknown as Rec, 236: replay as unknown as Rec,
      237: commitment as unknown as Rec, 238: verification as unknown as Rec, 239: ledger as unknown as Rec,
    },
    ledger: ledger as unknown as Rec,
  };
}

// A COMPLETE inventory: every one of the nine artifacts accounted for, each claimed RETAINED with its real
// digest, and the custodian affirming they did the work.
function completeInventory(s: Stack, over: Rec = {}): Rec {
  const skeleton = JSON.parse(JSON.stringify(buildRetentionInventorySkeleton(s.ledger)!)) as Rec;
  const { fields: overFields, entries: overEntries, ...rest } = over;
  return {
    ...skeleton,
    entries: (overEntries as Rec[]) ?? PHASES.map((phase) => ({
      phase, artifactDigest: artifactDigestOf(phase, s.reports[String(phase)]!), retention: 'RETAINED',
    })),
    custodianDigest: INVENTORY_CUSTODIAN,
    inventoriedAtUtc: INVENTORIED_AT,
    fields: {
      inventoryAffirmed: 'AFFIRMED', artifactsIndependentlyLocated: 'AFFIRMED',
      artifactsIndependentlyDigested: 'AFFIRMED', artifactsRetainedInFull: 'AFFIRMED',
      ...((overFields as Rec) ?? {}),
    },
    ...rest,
  };
}

// Re-seal a mutated REPORT so it recomputes its own self-digest cleanly. A self-digest is not a signature.
function resealReport(report: Rec, field: string, scope: string, mutate: (r: Rec) => void): Rec {
  const forged = JSON.parse(JSON.stringify(report)) as Rec;
  mutate(forged);
  delete forged[field];
  const body: Rec = {};
  for (const k of Object.keys(forged)) body[k] = forged[k];
  forged[field] = createHash('sha256').update(`${scope}:${JSON.stringify(body)}`).digest('hex');
  return forged;
}

console.log('Running Phase 240 evidence retention inventory suite:\n');

await test('a genuine inventory of all nine artifacts is COMPLETE -- and this tool still archived and deleted nothing', () => {
  const root = workspace();
  try {
    const s = fullStack(root);
    const r = buildRetentionInventory({ ledger: s.ledger, inventory: completeInventory(s), reports: s.reports });
    assertEq(r.overall, 'INVENTORY_COMPLETE', `complete (blockers: ${r.blockers.join(',')})`);
    assertEq(r.recordedInventory, 'AFFIRMED', 'the custodian affirmed it');
    assertEq(r.inventoryComplete, true, 'inventory complete');
    assert(r.ledgerEligible && r.inventoryWellFormed && r.inventoryRedactionSafe && r.inventoryBound && r.inventoryCoherent, 'all five checks green');
    assertEq(r.coverageComplete, true, 'all nine phases covered');
    assertEq(r.allEntriesBound, true, 'every entry bound against a real artifact');
    assertEq(r.allEntriesRetained, true, 'every artifact claimed retained');
    assertEq(r.entryCount, 9, 'nine entries');
    assertEq(r.blockers.length, 0, 'no blockers');
    // It accounts for evidence; it never touches it.
    assertEq(r.archivedByThisTool, false, 'archived nothing');
    assertEq(r.deletedByThisTool, false, 'deleted nothing');
    assertEq(r.retrievedByThisTool, false, 'retrieved nothing');
    assertEq(r.destructionClaimed, false, 'no destruction claimed');
    assertEq(r.entries.length, 9, 'nine entry states');
    assert(r.entries.every((e) => e.covered && e.retention === 'RETAINED'), 'every entry covered and retained');
    // Phases 238 and 239 bind from the ledger itself; the rest need the supplied artifacts.
    assertEq(r.entries.find((e) => e.phase === 239)!.boundVia, 'REPORT', 'the ledger artifact binds');
    assert(r.entries.every((e) => e.boundVia !== 'UNBOUND'), 'nothing left unbound');
    assertEq(r.remainingHumanSteps.length, RETENTION_INVENTORY_REMAINING_HUMAN_STEPS.length, 'remaining human steps stated');
    assertEq(r.disclaimers.length, RETENTION_INVENTORY_DISCLAIMERS.length, 'disclaimers stated');
    assertEq(verifySelfDigests([r]).overall, 'ALL_VERIFIED', 'the report self-verifies');
    const json = JSON.stringify(r);
    assert(!json.includes('/mnt/') && !json.includes('catalog-authority-test-library'), 'no raw path in report');
    assert(!json.includes(INVENTORY_CUSTODIAN) && !json.includes(INVENTORIED_AT), 'no custodian identity or timestamp echoed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('without the artifacts the claimed digests were checked against nothing: STRUCTURAL_ONLY, never COMPLETE', () => {
  const root = workspace();
  try {
    const s = fullStack(root);
    const r = buildRetentionInventory({ ledger: s.ledger, inventory: completeInventory(s) });
    assertEq(r.overall, 'INVENTORY_STRUCTURAL_ONLY', `structural only (${r.blockers.join(',')})`);
    assertEq(r.inventoryComplete, false, 'not complete without the artifacts');
    assertEq(r.blockers.length, 0, 'an unbound inventory is not a defect -- it is simply unverified');
    assertEq(r.coverageComplete, true, 'coverage is still complete');
    assertEq(r.allEntriesBound, false, 'but nothing was bound against a real artifact');
    // The ledger still reaches two of the nine on its own: itself, and the verification it was built over.
    const bound = r.entries.filter((e) => e.boundVia === 'LEDGER').map((e) => e.phase);
    assertEq(bound.length, 2, 'the ledger reaches exactly two artifacts unaided');
    assert(bound.includes(238) && bound.includes(239), 'those two are the verification and the ledger itself');
    assert(r.entries.filter((e) => e.phase < 238).every((e) => e.boundVia === 'UNBOUND'), 'the rest are honestly unbound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('the blank skeleton accounts for nothing: it validates as PENDING and claims no retention', () => {
  const root = workspace();
  try {
    const s = fullStack(root);
    const skeleton = JSON.parse(JSON.stringify(buildRetentionInventorySkeleton(s.ledger)!)) as Rec;
    assertEq(skeleton.record, RETENTION_INVENTORY_INPUT_ID, 'skeleton is an inventory input');
    assertEq(skeleton.custodianDigest, 'PENDING', 'skeleton names no custodian');
    assertEq(skeleton.inventoriedAtUtc, 'PENDING', 'skeleton records no time');
    assertEq((skeleton.entries as Rec[]).length, 9, 'nine blank entries');
    assert((skeleton.entries as Rec[]).every((e) => e.artifactDigest === 'PENDING' && e.retention === 'PENDING'), 'every entry blank');
    assert(Object.values(skeleton.fields as Rec).every((v) => v === 'PENDING'), 'every field PENDING');
    assert(!JSON.stringify(skeleton).includes('RETAINED'), 'the skeleton claims no retention at all');
    const r = buildRetentionInventory({ ledger: s.ledger, inventory: skeleton, reports: s.reports });
    assertEq(r.overall, 'INVENTORY_PENDING', `blank is valid but accounts for nothing (${r.blockers.join(',')})`);
    assertEq(r.recordedInventory, 'PENDING', 'nothing affirmed');
    assertEq(r.inventoryComplete, false, 'nothing complete');
    assertEq(r.allEntriesRetained, false, 'nothing claimed retained');
    assertEq(r.blockers.length, 0, 'a blank inventory is not a defect');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE HEADLINE INVARIANT. An evidence inventory that can express deletion IS a deletion instrument.
await test('THE destruction rule: purge/deletion vocabulary anywhere fails closed, in a value or a key', () => {
  const root = workspace();
  try {
    const s = fullStack(root);
    const words = ['purge', 'purged', 'delete', 'deleted', 'destroy', 'destroyed', 'shred', 'shredded',
      'erase', 'erased', 'wipe', 'wiped', 'remove', 'removed', 'discard', 'discarded'];
    for (const word of words) {
      // In a VALUE: an entry that says the artifact was destroyed rather than kept.
      // A unique marker, because the report's OWN disclaimers legitimately contain this vocabulary -- they are
      // what explains the rule. What must never be echoed is the SUPPLIED value.
      const marker = `${word.toUpperCase()}_SMUGGLED240`;
      const inValue = completeInventory(s, {
        entries: PHASES.map((phase) => ({
          phase, artifactDigest: artifactDigestOf(phase, s.reports[String(phase)]!),
          retention: phase === 235 ? marker : 'RETAINED',
        })),
      });
      const a = buildRetentionInventory({ ledger: s.ledger, inventory: inValue, reports: s.reports });
      assertEq(a.overall, 'INVENTORY_INVALID', `destruction in a value rejected: ${word}`);
      assert(a.blockers.includes('INVENTORY_DESTRUCTION_CLAIMED'), `${word} -> INVENTORY_DESTRUCTION_CLAIMED`);
      assertEq(a.inventoryComplete, false, `nothing complete: ${word}`);
      assertEq(a.destructionClaimed, false, `the report never records a destruction: ${word}`);
      assert(!JSON.stringify(a).includes(marker), `the smuggled destruction value is never echoed: ${word}`);

      // In a KEY: an off-allowlist field naming the act.
      const keyMarker = `${word}Smuggled240`;
      const inKey = { ...completeInventory(s), [keyMarker]: 'x' } as Rec;
      const b = buildRetentionInventory({ ledger: s.ledger, inventory: inKey, reports: s.reports });
      assertEq(b.overall, 'INVENTORY_INVALID', `destruction in a key rejected: ${word}`);
      assert(b.blockers.includes('INVENTORY_DESTRUCTION_CLAIMED'), `${word} key -> INVENTORY_DESTRUCTION_CLAIMED`);
      assert(b.blockers.includes('INVENTORY_UNKNOWN_FIELD'), `${word} key -> INVENTORY_UNKNOWN_FIELD too`);
      assert(!JSON.stringify(b).includes(keyMarker), `the smuggled destruction key is never echoed: ${word}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a retention state outside the closed retention-only enum fails closed', () => {
  const root = workspace();
  try {
    const s = fullStack(root);
    for (const bad of ['ARCHIVED_ELSEWHERE', 'UNKNOWN', 'RETAINED_PARTIALLY', '', 'retained', 42, null]) {
      const inv = completeInventory(s, {
        entries: PHASES.map((phase) => ({
          phase, artifactDigest: artifactDigestOf(phase, s.reports[String(phase)]!),
          retention: phase === 233 ? bad : 'RETAINED',
        })),
      });
      const r = buildRetentionInventory({ ledger: s.ledger, inventory: inv, reports: s.reports });
      assertEq(r.overall, 'INVENTORY_INVALID', `rejected: ${String(bad)}`);
      assert(r.blockers.includes('INVENTORY_RETENTION_INVALID'), `${String(bad)} -> INVENTORY_RETENTION_INVALID`);
      assertEq(r.inventoryComplete, false, `nothing complete: ${String(bad)}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE SECOND INVARIANT. This is the record where a human would naturally write where the evidence went.
await test('THE location rule: any path, location or network endpoint fails closed and is never echoed', () => {
  const root = workspace();
  try {
    const s = fullStack(root);
    const leaks: ReadonlyArray<readonly [string, string]> = [
      ['a raw unix path', '/mnt/backup/evidence/phase-231.json'],
      ['a drive letter', 'D:\\archive\\evidence'],
      ['a UNC share', '\\\\vault01\\evidence$'],
      ['an IPv4 endpoint', '10.0.0.5'],
      ['an IPv6 literal', 'fe80::1ff:fe23:4567:890a'],
      ['a host and port', 'vault.internal:8443'],
      ['an https URL', 'https://vault.example.com/evidence'],
      ['an s3 URI', 's3://evidence-archive/phase-231'],
      ['an smb URI', 'smb://fileserver/evidence'],
      ['a bare hostname', 'nas.local'],
      ['a bucket name', 'bucket-evidence-archive'],
    ];
    for (const [what, leak] of leaks) {
      // Smuggled into an off-allowlist field, which is where such a value would actually be written.
      const inv = { ...completeInventory(s), archiveNote: leak } as Rec;
      const r = buildRetentionInventory({ ledger: s.ledger, inventory: inv, reports: s.reports });
      assertEq(r.overall, 'INVENTORY_INVALID', `rejected: ${what}`);
      assert(r.blockers.includes('INVENTORY_LOCATION_DISCLOSED'), `${what} -> INVENTORY_LOCATION_DISCLOSED`);
      assertEq(r.inventoryRedactionSafe, false, `not redaction-safe: ${what}`);
      const json = JSON.stringify(r);
      assert(!json.includes(leak), `the leaked value is never echoed: ${what}`);
    }
    // And a genuine inventory contains none of these shapes, so the scan does not false-positive.
    const clean = buildRetentionInventory({ ledger: s.ledger, inventory: completeInventory(s), reports: s.reports });
    assertEq(clean.inventoryRedactionSafe, true, 'a genuine inventory is redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: omission, duplication, reordering and a wrong phase set each fail closed distinctly', () => {
  const root = workspace();
  try {
    const s = fullStack(root);
    const full = PHASES.map((phase) => ({ phase, artifactDigest: artifactDigestOf(phase, s.reports[String(phase)]!), retention: 'RETAINED' }));

    const omitted = buildRetentionInventory({ ledger: s.ledger, inventory: completeInventory(s, { entries: full.slice(0, 8) }), reports: s.reports });
    assertEq(omitted.overall, 'INVENTORY_INVALID', 'an omitted artifact is rejected');
    assert(omitted.blockers.includes('INVENTORY_ENTRY_COUNT_INVALID'), 'omission -> INVENTORY_ENTRY_COUNT_INVALID');
    assertEq(omitted.coverageComplete, false, 'coverage incomplete');
    assertEq(omitted.entryCount, 8, 'the short count is reported');
    // Per-entry states are published only for a WELL-FORMED inventory: a malformed one gets no partial read.
    assertEq(omitted.entries.length, 0, 'no partial per-entry read from a malformed inventory');

    const duplicated = buildRetentionInventory({ ledger: s.ledger, inventory: completeInventory(s, { entries: [...full.slice(0, 8), full[7]!] }), reports: s.reports });
    assertEq(duplicated.overall, 'INVENTORY_INVALID', 'a duplicated artifact is rejected');
    assert(duplicated.blockers.includes('INVENTORY_ENTRY_DUPLICATED'), 'duplication -> INVENTORY_ENTRY_DUPLICATED');

    const reordered = [...full];
    [reordered[2], reordered[5]] = [reordered[5]!, reordered[2]!];
    const outOfOrder = buildRetentionInventory({ ledger: s.ledger, inventory: completeInventory(s, { entries: reordered }), reports: s.reports });
    assertEq(outOfOrder.overall, 'INVENTORY_INVALID', 'a reordered inventory is rejected');
    assert(outOfOrder.blockers.includes('INVENTORY_ENTRY_OUT_OF_ORDER'), 'reordering -> INVENTORY_ENTRY_OUT_OF_ORDER');
    assert(!outOfOrder.blockers.includes('INVENTORY_ENTRY_DUPLICATED'), 'reordering is not duplication');

    const wrongSet = full.map((e, i) => (i === 0 ? { ...e, phase: 230 } : e));
    const badPhase = buildRetentionInventory({ ledger: s.ledger, inventory: completeInventory(s, { entries: wrongSet }), reports: s.reports });
    assertEq(badPhase.overall, 'INVENTORY_INVALID', 'a foreign phase is rejected');
    assert(badPhase.blockers.includes('INVENTORY_ENTRY_PHASE_INVALID'), 'wrong phase set -> INVENTORY_ENTRY_PHASE_INVALID');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('THE transplantation case: an inventory cannot be replayed against a different ledger', () => {
  const root = workspace();
  try {
    const a = fullStack(root);
    const b = fullStack(root, { itemId: '99999999999999999999999999999999', approvalId: 'phase-240-other', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-other')]) });
    const inventoryA = completeInventory(a);
    assertEq(buildRetentionInventory({ ledger: a.ledger, inventory: inventoryA, reports: a.reports }).overall, 'INVENTORY_COMPLETE', 'precondition: genuine inventory of A');
    const r = buildRetentionInventory({ ledger: b.ledger, inventory: inventoryA, reports: b.reports });
    assertEq(r.overall, 'INVENTORY_INVALID', 'transplanted inventory rejected');
    assert(r.blockers.includes('INVENTORY_NOT_BOUND_TO_LEDGER'), 'ledger digest mismatch reported');
    assert(r.blockers.includes('INVENTORY_HEAD_EVENT_MISMATCH'), 'head event mismatch reported');
    assert(r.blockers.includes('INVENTORY_ITEM_DIGEST_MISMATCH'), 'operation digest mismatch reported');
    assertEq(r.inventoryBound, false, 'nothing bound');
    assertEq(r.inventoryComplete, false, 'nothing complete');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: an entry whose claimed digest is not the real artifact fails closed', () => {
  const root = workspace();
  try {
    const s = fullStack(root);
    for (const phase of [231, 235, 238, 239]) {
      const entries = PHASES.map((p) => ({
        phase: p,
        artifactDigest: p === phase ? createHash('sha256').update(`wrong-${p}`).digest('hex') : artifactDigestOf(p, s.reports[String(p)]!),
        retention: 'RETAINED',
      }));
      const r = buildRetentionInventory({ ledger: s.ledger, inventory: completeInventory(s, { entries }), reports: s.reports });
      assertEq(r.overall, 'INVENTORY_INVALID', `a wrong digest for phase ${phase} is rejected`);
      assert(r.blockers.includes('INVENTORY_ENTRY_DIGEST_MISMATCH'), `phase ${phase} -> INVENTORY_ENTRY_DIGEST_MISMATCH`);
      assertEq(r.allEntriesBound, false, `phase ${phase} did not bind`);
      assert(r.entries.find((e) => e.phase === phase)!.boundVia === 'UNBOUND', `phase ${phase} reported unbound`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// An inventory of evidence still in open custody is premature: the holder may still append events.
await test('a ledger that is INTACT but whose custody is still OPEN is NOT_ELIGIBLE', () => {
  const root = workspace();
  try {
    const closed = fullStack(root);
    const open = fullStack(root, { release: false, itemId: '11111111111111111111111111111111', approvalId: 'phase-240-open', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-open')]) });
    assertEq(open.ledger.overall, 'CUSTODY_LEDGER_INTACT', 'precondition: the open ledger is genuinely intact');
    assertEq(open.ledger.terminalTransition, 'CUSTODY_RETAINED', 'precondition: custody was never released');
    assertEq(verifySelfDigests([open.ledger]).overall, 'ALL_VERIFIED', 'precondition: it is genuine');
    assertEq(buildRetentionInventorySkeleton(open.ledger), null, 'no blank inventory for an open custody');
    const r = buildRetentionInventory({ ledger: open.ledger, inventory: completeInventory(closed), reports: open.reports });
    assertEq(r.overall, 'NOT_ELIGIBLE', 'an open custody has nothing to inventory yet');
    assert(r.blockers.includes('LEDGER_RECORD_CUSTODY_NOT_RELEASED'), 'LEDGER_RECORD_CUSTODY_NOT_RELEASED reported');
    assertEq(r.ledgerEligible, false, 'not eligible');
    assertEq(r.inventoryComplete, false, 'nothing complete');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('NOT_ELIGIBLE over a non-INTACT ledger, and it takes precedence over a broken inventory', () => {
  const root = workspace();
  try {
    const s = fullStack(root);
    // A genuine but PENDING ledger: a blank genesis claims nothing.
    const pendingLedger = buildCustodyLedger({ verification: s.reports['238']!, events: undefined });
    assertEq(pendingLedger.overall, 'CUSTODY_LEDGER_INVALID', 'precondition: a genuine ledger with no events');
    assertEq(verifySelfDigests([pendingLedger]).overall, 'ALL_VERIFIED', 'precondition: it is genuine');
    assertEq(buildRetentionInventorySkeleton(pendingLedger), null, 'no blank inventory for an ineligible ledger');
    for (const broken of [undefined, 'not-an-object', { record: 'wrong' }, [] as unknown, { ...completeInventory(s), junk: 1 }]) {
      const r = buildRetentionInventory({ ledger: pendingLedger, inventory: broken, reports: s.reports });
      assertEq(r.overall, 'NOT_ELIGIBLE', 'an ineligible ledger wins over a broken inventory');
      assertEq(r.inventoryComplete, false, 'nothing complete');
      assertEq(r.recordedInventory, 'NONE', 'nothing recorded');
    }
    // A good inventory over no ledger at all is still NOT_ELIGIBLE.
    const none = buildRetentionInventory({ inventory: completeInventory(s), reports: s.reports });
    assertEq(none.overall, 'NOT_ELIGIBLE', 'absent ledger -> NOT_ELIGIBLE');
    assert(none.blockers.includes('LEDGER_RECORD_MISSING'), 'LEDGER_RECORD_MISSING reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED by default: with no ledger and no inventory nothing is eligible or accounted for', () => {
  const r = buildRetentionInventory({});
  assertEq(r.overall, 'NOT_ELIGIBLE', 'nothing to inventory');
  assertEq(r.recordedInventory, 'NONE', 'nothing recorded');
  assertEq(r.inventoryComplete, false, 'nothing complete');
  assertEq(r.entryCount, 0, 'no entries');
  assert(r.blockers.includes('LEDGER_RECORD_MISSING') && r.blockers.includes('INVENTORY_MISSING'), 'both inputs reported missing');
  assertEq(r.archivedByThisTool, false, 'archived nothing');
  assertEq(r.deletedByThisTool, false, 'deleted nothing');
  assert(r.redactionSafe === true && !JSON.stringify(r).includes('/mnt/'), 'redaction-safe');
});

await test('adversarial: a green-bodied but tampered Phase 239 ledger fails on digest recompute', () => {
  const root = workspace();
  try {
    const s = fullStack(root);
    const tampered = JSON.parse(JSON.stringify(s.ledger)) as Rec;
    assertEq(tampered.overall, 'CUSTODY_LEDGER_INTACT', 'precondition: green');
    tampered.injectedClaim = 'smuggled-through-a-green-ledger';
    const r = buildRetentionInventory({ ledger: tampered, inventory: completeInventory(s), reports: s.reports });
    assertEq(r.overall, 'NOT_ELIGIBLE', 'a tampered ledger is not eligible');
    assert(r.blockers.includes('LEDGER_RECORD_DIGEST_MISMATCH'), 'green-body tamper -> LEDGER_RECORD_DIGEST_MISMATCH');
    assertEq(r.ledgerEligible, false, 'not eligible');
    assertEq(Object.keys(r.boundDigests).length, 0, 'no digests bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A self-digest is not a signature: a forger who rebuilds it walks straight into the semantic checks, and they
// are the only thing standing between a fabricated closed ledger and an inventory over it.
await test('adversarial: a FORGED Phase 239 ledger that recomputes its own digest is caught by the eligibility checks', () => {
  const root = workspace();
  try {
    const s = fullStack(root);
    const inventory = completeInventory(s);
    const cases: Array<[string, (r: Rec) => void, string]> = [
      ['a claim it held custody itself', (r) => { r.custodyHeldByThisTool = true; }, 'LEDGER_RECORD_CUSTODY_HELD_CLAIMED'],
      ['a claim it created the events', (r) => { r.eventsCreatedByThisTool = true; }, 'LEDGER_RECORD_EVENTS_CREATED_CLAIMED'],
      ['a self-authorized ledger', (r) => { r.selfAuthorized = true; }, 'LEDGER_RECORD_SELF_AUTHORIZED'],
      ['an INTACT overall with the flag quietly false', (r) => { r.ledgerIntact = false; }, 'LEDGER_RECORD_NOT_MARKED_INTACT'],
      ['a body that is not redaction-safe', (r) => { r.redactionSafe = false; }, 'LEDGER_RECORD_NOT_REDACTION_SAFE'],
      ['an ineligible upstream verification', (r) => { r.verificationEligible = false; }, 'LEDGER_RECORD_VERIFICATION_NOT_ELIGIBLE'],
      ['events that were never well-formed', (r) => { r.eventsWellFormed = false; }, 'LEDGER_RECORD_EVENTS_NOT_WELL_FORMED'],
      ['events that leaked', (r) => { r.eventsRedactionSafe = false; }, 'LEDGER_RECORD_EVENTS_NOT_REDACTION_SAFE'],
      ['a chain that never linked', (r) => { r.chainLinked = false; }, 'LEDGER_RECORD_CHAIN_NOT_LINKED'],
      ['transitions that never validated', (r) => { r.transitionsValid = false; }, 'LEDGER_RECORD_TRANSITIONS_NOT_VALID'],
      ['blockers under a green headline', (r) => { r.blockers = ['SOMETHING_FAILED']; }, 'LEDGER_RECORD_BLOCKERS_PRESENT'],
      ['a stripped head event', (r) => { r.headEventDigest = null; }, 'LEDGER_RECORD_HEAD_EVENT_MISSING'],
      ['stripped bindings', (r) => { r.boundDigests = {}; }, 'LEDGER_RECORD_BINDINGS_INCOMPLETE'],
      ['custody that was never released', (r) => { r.terminalTransition = 'CUSTODY_RETAINED'; }, 'LEDGER_RECORD_CUSTODY_NOT_RELEASED'],
    ];
    for (const [what, mutate, code] of cases) {
      const forged = resealReport(s.ledger, 'ledgerDigest', 'phase-239-custody-ledger', mutate);
      assertEq(verifySelfDigests([forged]).overall, 'ALL_VERIFIED', `precondition: ${what} recomputes cleanly`);
      assertEq((forged as Rec).overall, 'CUSTODY_LEDGER_INTACT', `precondition: ${what} keeps a green headline`);
      const r = buildRetentionInventory({ ledger: forged, inventory, reports: s.reports });
      assertEq(r.overall, 'NOT_ELIGIBLE', `forged ledger rejected: ${what}`);
      assert(!r.blockers.includes('LEDGER_RECORD_DIGEST_MISMATCH'), `${what}: the digest check does NOT catch this`);
      assert(r.blockers.includes(code), `${what} -> ${code}`);
      assertEq(r.inventoryComplete, false, `nothing complete: ${what}`);
      assertEq(buildRetentionInventorySkeleton(forged), null, `no skeleton for a forged ledger: ${what}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: an affirmed inventory that does not account for everything fails closed', () => {
  const root = workspace();
  try {
    const s = fullStack(root);
    // Affirmed, but one artifact is still PENDING rather than retained.
    const partial = completeInventory(s, {
      entries: PHASES.map((phase) => (phase === 236
        ? { phase, artifactDigest: 'PENDING', retention: 'PENDING' }
        : { phase, artifactDigest: artifactDigestOf(phase, s.reports[String(phase)]!), retention: 'RETAINED' })),
    });
    const a = buildRetentionInventory({ ledger: s.ledger, inventory: partial, reports: s.reports });
    assertEq(a.overall, 'INVENTORY_INVALID', 'an affirmation over a partial inventory is rejected');
    assert(a.blockers.includes('INVENTORY_AFFIRMED_WITHOUT_FULL_RETENTION'), 'partial retention -> INVENTORY_AFFIRMED_WITHOUT_FULL_RETENTION');
    assertEq(a.allEntriesRetained, false, 'not everything retained');

    // Affirmed, but the custodian did not affirm doing the work.
    const unbacked = completeInventory(s, { fields: { artifactsIndependentlyDigested: 'PENDING' } });
    const b = buildRetentionInventory({ ledger: s.ledger, inventory: unbacked, reports: s.reports });
    assertEq(b.overall, 'INVENTORY_INVALID', 'an unbacked affirmation is rejected');
    assert(b.blockers.includes('INVENTORY_AFFIRMED_WITHOUT_FULL_AFFIRMATION'), 'unbacked -> INVENTORY_AFFIRMED_WITHOUT_FULL_AFFIRMATION');

    // A refusal accounts for nothing, and may name no custodian or time.
    const refused = completeInventory(s, { fields: { inventoryAffirmed: 'REFUSED' }, custodianDigest: 'PENDING', inventoriedAtUtc: 'PENDING' });
    const c = buildRetentionInventory({ ledger: s.ledger, inventory: refused, reports: s.reports });
    assertEq(c.overall, 'INVENTORY_PENDING', `a refusal inventories nothing (${c.blockers.join(',')})`);
    assertEq(c.recordedInventory, 'REFUSED', 'the refusal is visible in the report');
    assertEq(c.inventoryComplete, false, 'nothing complete');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: custodian digest and inventory time must match the decision state', () => {
  const root = workspace();
  try {
    const s = fullStack(root);
    const anonymous = buildRetentionInventory({ ledger: s.ledger, inventory: completeInventory(s, { custodianDigest: 'PENDING' }), reports: s.reports });
    assert(anonymous.blockers.includes('INVENTORY_CUSTODIAN_DIGEST_REQUIRED'), 'an affirmed inventory must name its custodian by digest');
    assertEq(anonymous.inventoryComplete, false, 'anonymous inventory rejected');
    const undated = buildRetentionInventory({ ledger: s.ledger, inventory: completeInventory(s, { inventoriedAtUtc: '22 July 2026' }), reports: s.reports });
    assert(undated.blockers.includes('INVENTORY_INVENTORIED_AT_REQUIRED'), 'an affirmed inventory must carry a strict UTC time');
    const predated = buildRetentionInventory({
      ledger: s.ledger,
      inventory: completeInventory(s, { fields: { inventoryAffirmed: 'PENDING' }, custodianDigest: INVENTORY_CUSTODIAN, inventoriedAtUtc: 'PENDING' }),
      reports: s.reports,
    });
    assert(predated.blockers.includes('INVENTORY_CUSTODIAN_DIGEST_NOT_PENDING'), 'an un-affirmed inventory may not name a custodian');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// REGRESSION-adjacent: this phase uses the shared exact UTC rule, so impossible calendar dates fail here too.
await test('an impossible calendar inventory time is rejected, never silently normalised', () => {
  const root = workspace();
  try {
    const s = fullStack(root);
    for (const stamp of ['2026-02-30T12:00:00Z', '2026-02-29T12:00:00Z', '2026-04-31T12:00:00Z', '2026-01-01T24:00:00Z']) {
      const r = buildRetentionInventory({ ledger: s.ledger, inventory: completeInventory(s, { inventoriedAtUtc: stamp }), reports: s.reports });
      assertEq(r.overall, 'INVENTORY_INVALID', `rejected: ${stamp}`);
      assert(r.blockers.includes('INVENTORY_INVENTORIED_AT_REQUIRED'), `${stamp} -> INVENTORY_INVENTORIED_AT_REQUIRED`);
    }
    const leap = buildRetentionInventory({ ledger: s.ledger, inventory: completeInventory(s, { inventoriedAtUtc: '2024-02-29T12:00:00Z' }), reports: s.reports });
    assert(!leap.blockers.includes('INVENTORY_INVENTORIED_AT_REQUIRED'), 'a genuine leap day is still accepted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: malformed literals, enums and structures fail closed', () => {
  const root = workspace();
  try {
    const s = fullStack(root);
    const cases: Array<[string, Rec, string]> = [
      ['a wrong version', { version: 2 }, 'INVENTORY_VERSION_UNSUPPORTED'],
      ['a wrong operation', { operation: 'something-else' }, 'INVENTORY_OPERATION_MISMATCH'],
      ['a wrong source ledger id', { sourceCustodyLedger: 'phase-999-nope' }, 'INVENTORY_SOURCE_LEDGER_MISMATCH'],
      ['a malformed ledger digest', { ledgerDigest: 'not-a-digest' }, 'INVENTORY_LEDGER_DIGEST_INVALID'],
      ['a malformed head event digest', { headEventDigest: 'nope' }, 'INVENTORY_HEAD_EVENT_DIGEST_INVALID'],
      ['a bad field state', { fields: { inventoryAffirmed: 'PROBABLY', artifactsIndependentlyLocated: 'AFFIRMED', artifactsIndependentlyDigested: 'AFFIRMED', artifactsRetainedInFull: 'AFFIRMED' } }, 'INVENTORY_FIELD_STATE_INVALID'],
      ['a fields object missing keys', { fields: { inventoryAffirmed: 'AFFIRMED' } }, 'INVENTORY_FIELDS_INVALID'],
      ['entries that are not a list', { entries: {} }, 'INVENTORY_ENTRIES_INVALID'],
      ['an unknown field', { somethingElse: 1 }, 'INVENTORY_UNKNOWN_FIELD'],
    ];
    for (const [what, over, code] of cases) {
      const r = buildRetentionInventory({ ledger: s.ledger, inventory: { ...completeInventory(s), ...over }, reports: s.reports });
      assertEq(r.overall, 'INVENTORY_INVALID', `rejected: ${what}`);
      assert(r.blockers.includes(code), `${what} -> ${code}`);
      assertEq(r.inventoryComplete, false, `nothing complete: ${what}`);
    }
    const notSingle = buildRetentionInventory({ ledger: s.ledger, inventory: [completeInventory(s)], reports: s.reports });
    assert(notSingle.blockers.includes('INVENTORY_NOT_SINGLE'), 'a list of inventories -> INVENTORY_NOT_SINGLE');
    const badEntry = buildRetentionInventory({ ledger: s.ledger, inventory: completeInventory(s, { entries: PHASES.map((p) => ({ phase: p })) }), reports: s.reports });
    assert(badEntry.blockers.includes('INVENTORY_ENTRY_INVALID'), 'an entry missing keys -> INVENTORY_ENTRY_INVALID');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A HANDED-OVER artifact is validated on its own terms. Absence is merely unproven, but a supplied artifact
// that is broken is a defect in the submission -- the same distinction Phase 236 draws between a source that
// was never supplied (null, no blocker) and one supplied that fails to re-derive (a blocker).
await test('adversarial: a supplied artifact that does not itself verify binds nothing and fails closed', () => {
  const root = workspace();
  try {
    const s = fullStack(root);
    // The Phase 236 artifact is handed over tampered: it no longer recomputes, so it cannot bind its entry.
    const tampered = JSON.parse(JSON.stringify(s.reports['236']!)) as Rec;
    tampered.injectedClaim = 'not-the-artifact-that-was-inventoried';
    const r = buildRetentionInventory({ ledger: s.ledger, inventory: completeInventory(s), reports: { ...s.reports, 236: tampered } });
    assertEq(r.overall, 'INVENTORY_INVALID', `a broken supplied artifact fails closed (${r.blockers.join(',')})`);
    assert(r.blockers.includes('INVENTORY_SUPPLIED_REPORT_INVALID'), 'INVENTORY_SUPPLIED_REPORT_INVALID reported');
    assertEq(r.entries.find((e) => e.phase === 236)!.boundVia, 'UNBOUND', 'the tampered artifact bound nothing');
    assertEq(r.allEntriesBound, false, 'not everything bound');
    assertEq(r.inventoryComplete, false, 'and therefore never COMPLETE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE TRANSPLANTATION CASE, from independent review. Validating a handed-over artifact by report id plus
// self-digest ALONE was a hole: a perfectly genuine, self-consistent report belonging to a DIFFERENT promotion
// satisfies both, so it could bind an inventory entry and count toward INVENTORY_COMPLETE while the inventory
// itself stayed bound to THIS ledger -- an inventory accounting for nine artifacts that were never part of the
// operation it claims to inventory. Every supplied report must carry this ledger's five operation digests.
await test('THE transplantation case: a genuine artifact from ANOTHER operation can never bind an entry', () => {
  const root = workspace();
  try {
    const mine = fullStack(root);
    const foreign = fullStack(root, { itemId: '99999999999999999999999999999999', approvalId: 'phase-240-other-operation', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-other')]) });
    // Sanity: the foreign chain is entirely genuine on its own terms.
    assertEq(buildRetentionInventory({ ledger: foreign.ledger, inventory: completeInventory(foreign), reports: foreign.reports }).overall,
      'INVENTORY_COMPLETE', 'precondition: the other operation inventories COMPLETE on its own ledger');

    for (const phase of [231, 232, 233, 234, 235, 236, 237, 238, 239]) {
      const swapped = foreign.reports[String(phase)]!;
      // Prove the swapped-in artifact is genuine: right report id, and its own self-digest recomputes cleanly.
      assertEq(verifySelfDigests([swapped]).overall, 'ALL_VERIFIED', `precondition: the foreign phase ${phase} artifact is genuine`);
      const r = buildRetentionInventory({
        ledger: mine.ledger,
        inventory: completeInventory(mine),
        reports: { ...mine.reports, [String(phase)]: swapped },
      });
      assertEq(r.overall, 'INVENTORY_INVALID', `a foreign phase ${phase} artifact is rejected`);
      assert(r.blockers.includes('INVENTORY_SUPPLIED_REPORT_FOREIGN_OPERATION'), `phase ${phase} -> INVENTORY_SUPPLIED_REPORT_FOREIGN_OPERATION`);
      // The identity check is what catches this -- NOT the report-id or self-digest checks.
      assert(!r.blockers.includes('INVENTORY_SUPPLIED_REPORT_INVALID'), `phase ${phase}: the report-id/self-digest check does NOT catch this`);
      assertEq(r.entries.find((e) => e.phase === phase)!.boundVia, 'UNBOUND', `the foreign phase ${phase} artifact bound nothing`);
      assertEq(r.allEntriesBound, false, `not everything bound: phase ${phase}`);
      assertEq(r.inventoryComplete, false, `INVENTORY_COMPLETE is impossible: phase ${phase}`);
      // And nothing of the foreign operation is echoed back.
      assert(!JSON.stringify(r).includes('phase-240-other-operation') && !JSON.stringify(r).includes('99999999999999999999999999999999'),
        `phase ${phase}: the foreign operation is never echoed`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE SAME-OPERATION ALTERNATE-CHAIN CASE, from independent review. Matching the ledger's operation digests
// is NOT enough: two genuine chains for the SAME operation -- a re-run by a different operator -- carry
// identical operation digests at every phase, so an artifact lifted from the alternate run passes the identity
// check. What pins ONE chain is that each report names the exact instance beneath it: Phase 238 names its
// Phase 237 commitment and the phase-232..235 reports it verified, Phase 237 names its Phase 236 replay and
// its own phase-232..235, and Phase 236 names phase-231..235 in chainDigests.
await test('THE alternate-chain case: a genuine artifact from another RUN of the SAME operation cannot bind', () => {
  const root = workspace();
  try {
    const mine = fullStack(root);
    // Same item, same approval, same bytes -- only the witnessed before-state differs, so the OPERATION is
    // identical while every report instance differs.
    const alternate = fullStack(root, { witnessedBefore: createHash('sha256').update('a-different-observed-before-state').digest('hex') });

    // Precondition 1: the alternate chain is entirely genuine and inventories COMPLETE on its own ledger.
    assertEq(buildRetentionInventory({ ledger: alternate.ledger, inventory: completeInventory(alternate), reports: alternate.reports }).overall,
      'INVENTORY_COMPLETE', 'precondition: the alternate run inventories COMPLETE on its own ledger');
    // Precondition 2: it really is the SAME operation -- the operation digests are identical, so the
    // foreign-operation check from the previous fix cannot be what catches this.
    const mineOps = (mine.ledger.boundDigests as Rec);
    const altOps = (alternate.ledger.boundDigests as Rec);
    for (const f of ['approvalIdDigest', 'itemDigest', 'sourceDigest', 'destinationDigest', 'planDigest']) {
      assertEq(altOps[f], mineOps[f], `precondition: ${f} is identical across the two runs`);
    }
    // Precondition 3: it is genuinely a DIFFERENT chain -- every artifact digest differs.
    for (const phase of [232, 233, 234, 235, 236, 237, 238, 239]) {
      assert(alternate.reports[String(phase)]![DIGEST_FIELD[phase]!] !== mine.reports[String(phase)]![DIGEST_FIELD[phase]!],
        `precondition: the phase ${phase} artifact differs between runs`);
    }

    for (const phase of [232, 233, 234, 235, 236, 237, 238]) {
      const swapped = alternate.reports[String(phase)]!;
      assertEq(verifySelfDigests([swapped]).overall, 'ALL_VERIFIED', `precondition: the alternate phase ${phase} artifact is genuine`);
      const r = buildRetentionInventory({
        ledger: mine.ledger,
        inventory: completeInventory(mine),
        reports: { ...mine.reports, [String(phase)]: swapped },
      });
      assertEq(r.overall, 'INVENTORY_INVALID', `an alternate-chain phase ${phase} artifact is rejected`);
      assert(r.blockers.includes('INVENTORY_SUPPLIED_REPORT_CHAIN_MISMATCH'), `phase ${phase} -> INVENTORY_SUPPLIED_REPORT_CHAIN_MISMATCH`);
      // Neither the operation-identity check nor the self-digest check can see this one.
      assert(!r.blockers.includes('INVENTORY_SUPPLIED_REPORT_FOREIGN_OPERATION'), `phase ${phase}: it IS the same operation`);
      assert(!r.blockers.includes('INVENTORY_SUPPLIED_REPORT_INVALID'), `phase ${phase}: the artifact is genuine and recomputes`);
      assertEq(r.entries.find((e) => e.phase === phase)!.boundVia, 'UNBOUND', `the alternate phase ${phase} artifact bound nothing`);
      assertEq(r.allEntriesBound, false, `not everything bound: phase ${phase}`);
      assertEq(r.inventoryComplete, false, `INVENTORY_COMPLETE is impossible: phase ${phase}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE MISSING-BRIDGE CASE, from independent review. The expectation walk is top-down: Phase 238 names Phase
// 237 and phase-232..235, Phase 237 names Phase 236, Phase 236 names phase-231..235. OMIT one of those
// bridging reports and every phase beneath the break has no expected digest -- at which point binding on
// same-operation alone would hand back the alternate-chain hole, and would let a custodian UNLOCK it simply by
// withholding a report. It fails closed instead: no expected digest means no REPORT binding, ever.
await test('THE missing-bridge case: withholding Phase 238 or 237 unanchors everything beneath it', () => {
  const root = workspace();
  try {
    const mine = fullStack(root);
    const alternate = fullStack(root, { witnessedBefore: createHash('sha256').update('a-different-observed-before-state').digest('hex') });

    // Withhold the bridging report, and hand over an ALTERNATE-chain artifact beneath the break. Same
    // operation, genuine, self-consistent -- and with the bridge gone there is nothing left to pin it to.
    const cases: ReadonlyArray<readonly [string, number, number]> = [
      ['Phase 238 withheld, alternate Phase 233 supplied', 238, 233],
      ['Phase 238 withheld, alternate Phase 235 supplied', 238, 235],
      ['Phase 237 withheld, alternate Phase 231 supplied', 237, 231],
      ['Phase 237 withheld, alternate Phase 236 supplied', 237, 236],
      ['Phase 236 withheld, alternate Phase 231 supplied', 236, 231],
    ];
    for (const [what, withheld, swapped] of cases) {
      const reports: Rec = { ...mine.reports, [String(swapped)]: alternate.reports[String(swapped)]! };
      delete reports[String(withheld)];
      const r = buildRetentionInventory({ ledger: mine.ledger, inventory: completeInventory(mine), reports });
      assertEq(r.overall, 'INVENTORY_INVALID', `rejected: ${what}`);
      assert(r.blockers.includes('INVENTORY_SUPPLIED_REPORT_CHAIN_UNANCHORED'), `${what} -> INVENTORY_SUPPLIED_REPORT_CHAIN_UNANCHORED`);
      assertEq(r.chainContinuity, 'BROKEN', `continuity is reported BROKEN: ${what}`);
      assertEq(r.entries.find((e) => e.phase === swapped)!.boundVia, 'UNBOUND', `the unanchored artifact bound nothing: ${what}`);
      assertEq(r.allEntriesBound, false, `not everything bound: ${what}`);
      assertEq(r.inventoryComplete, false, `INVENTORY_COMPLETE is impossible: ${what}`);
    }

    // The same withholding, with the GENUINE artifact beneath the break, is refused identically: the fix is
    // not "detect the alternate chain", it is "never bind what nothing pins". No fallback laundering.
    const honest: Rec = { ...mine.reports };
    delete honest['238'];
    const h = buildRetentionInventory({ ledger: mine.ledger, inventory: completeInventory(mine), reports: honest });
    assertEq(h.overall, 'INVENTORY_INVALID', 'a withheld bridge is refused even with genuine artifacts beneath it');
    assert(h.blockers.includes('INVENTORY_SUPPLIED_REPORT_CHAIN_UNANCHORED'), 'the unanchored blocker fires on genuine artifacts too');
    assertEq(h.inventoryComplete, false, 'and COMPLETE remains impossible');

    // Supplying NO artifacts at all is still the honest unproven state, not a continuity failure.
    const none = buildRetentionInventory({ ledger: mine.ledger, inventory: completeInventory(mine) });
    assertEq(none.chainContinuity, 'NOT_SUPPLIED', 'no artifacts handed over is NOT_SUPPLIED, not BROKEN');
    assert(!none.blockers.includes('INVENTORY_SUPPLIED_REPORT_CHAIN_UNANCHORED'), 'absence raises no continuity blocker');
    assertEq(none.overall, 'INVENTORY_STRUCTURAL_ONLY', 'and it stays the honest structural-only verdict');

    // A complete, genuine submission reports ANCHORED.
    const full = buildRetentionInventory({ ledger: mine.ledger, inventory: completeInventory(mine), reports: mine.reports });
    assertEq(full.chainContinuity, 'ANCHORED', 'a full genuine submission is ANCHORED');
    assertEq(full.overall, 'INVENTORY_COMPLETE', 'and still COMPLETE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI validates an inventory, writes a blank one, and never echoes paths, ids or identities', () => {
  const root = workspace();
  try {
    const s = fullStack(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const ledgerPath = w('ledger.json', s.ledger);
    const inventoryPath = w('inventory.json', completeInventory(s));
    const reportsPath = w('reports.json', s.reports);
    const outPath = join(root, 'INVMARKER-out', 'inventory-report.json');
    const skeletonPath = join(root, 'INVMARKER-out', 'blank-inventory.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-evidence-retention-inventory-cli.ts', import.meta.url));
    const run = (args: readonly string[]) => spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], { cwd: projectRoot, encoding: 'utf8' });

    const ok = run(['--ledger', ledgerPath, '--inventory', inventoryPath, '--reports', reportsPath, '--out', outPath, '--skeletonout', skeletonPath]);
    assert(ok.error === undefined, `spawn ok: ${ok.error?.message ?? ''}`);
    assertEq(ok.status, 0, `COMPLETE exit 0 (stderr: ${ok.stderr ?? ''})`);
    assert(existsSync(outPath) && existsSync(skeletonPath), 'report and blank inventory written');
    const parsed = JSON.parse(ok.stdout ?? '') as Rec;
    assertEq(parsed.overall, 'INVENTORY_COMPLETE', 'stdout overall');
    assertEq(parsed.archivedByThisTool, false, 'stdout archived nothing');
    assertEq(parsed.deletedByThisTool, false, 'stdout deleted nothing');
    assertEq(parsed.skeletonWritten, true, 'stdout reports the blank inventory');
    const blank = JSON.parse(readFileSync(skeletonPath, 'utf8')) as Rec;
    assert((blank.entries as Rec[]).every((e) => e.retention === 'PENDING'), 'the written blank claims no retention');
    const stdout = ok.stdout ?? '';
    assert(!stdout.includes('INVMARKER') && !stdout.includes('catalog-authority-test-library') && !stdout.includes('/mnt/'), 'no path fragments in stdout');
    assert(!stdout.includes('phase-240-synthetic-test') && !stdout.includes('0a40074065d91a75ad41f33fc212e917'), 'no raw ids in stdout');
    assert(!stdout.includes(INVENTORY_CUSTODIAN) && !stdout.includes(INVENTORIED_AT), 'no custodian identity or time in stdout');

    // Without the artifacts: STRUCTURAL_ONLY, exit 4. Blank: PENDING, exit 3. Missing inventory: exit 1.
    assertEq(run(['--ledger', ledgerPath, '--inventory', inventoryPath]).status, 4, 'no artifacts -> exit 4');
    assertEq(run(['--ledger', ledgerPath, '--inventory', skeletonPath]).status, 3, 'blank inventory -> exit 3');
    assertEq(run(['--ledger', ledgerPath]).status, 1, 'missing inventory -> exit 1');
    assertEq(run(['--ledger', join(dir, 'does-not-exist.json')]).status, 2, 'unreadable input -> exit 2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The ACTUAL prepared, redaction-safe P227-A evidence, captured verbatim from the non-live artifacts. Locked
// here so the validator is exercised against the real chain offline and deterministically -- no SSH, no secret
// approval file, no live surface. No committed manifest, verified submission, intact ledger or completed
// inventory exists for the real bundle, and this suite never constructs one.
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

// The real chain, end to end and offline. It stops at Phase 232 PENDING, so every phase above it is
// NOT_ELIGIBLE in turn -- including the custody ledger an inventory would have to be taken of.
function realLedger(): Rec {
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
  assertEq(replay.overall, 'CHAIN_REPLAY_VERIFIED_OPEN', 'precondition: the real replay is open, never closed');
  const commitment = buildProvenanceCommitment({ replay });
  assertEq(commitment.overall, 'NOT_ELIGIBLE', 'the real chain has no provenance commitment');
  const verification = buildSuppliedSourceVerification({ commitment } as never);
  assertEq(verification.overall, 'NOT_ELIGIBLE', 'the real chain has no verified source records');
  const ledger = buildCustodyLedger({ verification });
  assertEq(ledger.overall, 'NOT_ELIGIBLE', 'the real chain has no custody ledger');
  return ledger as unknown as Rec;
}

await test('the actual P227-A chain is LOCKED as NOT_ELIGIBLE: nothing closed for an inventory to be of', () => {
  const ledger = realLedger();
  assertEq(ledger.ledgerIntact, false, 'precondition: the real chain holds no custody');
  assertEq(buildRetentionInventorySkeleton(ledger), null, 'no blank inventory exists for the real chain');
  const r = buildRetentionInventory({ ledger });
  assertEq(r.overall, 'NOT_ELIGIBLE', 'the real chain has nothing to inventory');
  assertEq(r.recordedInventory, 'NONE', 'no inventory for the real run');
  assertEq(r.inventoryComplete, false, 'the real P227-A evidence has NO completed inventory');
  assertEq(r.ledgerEligible, false, 'not eligible');
  assertEq(r.coverageComplete, false, 'nothing covered');
  assertEq(r.entryCount, 0, 'no entries');
  assert(r.blockers.includes('LEDGER_RECORD_NOT_INTACT'), 'LEDGER_RECORD_NOT_INTACT reported');
  assert(r.blockers.includes('LEDGER_RECORD_CUSTODY_NOT_RELEASED'), 'custody was never released');
  assert(r.blockers.includes('INVENTORY_MISSING'), 'and no inventory exists either');
  assertEq(r.archivedByThisTool, false, 'archived nothing');
  assertEq(r.deletedByThisTool, false, 'deleted nothing');
  assertEq(verifySelfDigests([r]).overall, 'ALL_VERIFIED', 'the real-chain report self-verifies');
  const json = JSON.stringify(r);
  assert(!json.includes('/mnt/') && !json.includes('0a40074065d91a75ad41f33fc212e917') && !json.includes('phase-231-p227-a-20260720'), 'redaction-safe: no path, no raw ids');
});

// The lock cannot be talked out of: a perfectly-formed inventory shaped for the real operation still cannot
// account for a chain whose custody never closed.
await test('the actual P227-A chain stays NOT_ELIGIBLE even against a fully-formed COMPLETE inventory', () => {
  const ledger = realLedger();
  const shaped = {
    record: RETENTION_INVENTORY_INPUT_ID, version: 1, operation: 'promote-observe-withdraw',
    sourceCustodyLedger: 'phase-239-promotion-chain-custody-ledger',
    ledgerDigest: ledger.ledgerDigest as string,
    headEventDigest: createHash('sha256').update('fabricated-head').digest('hex'),
    approvalIdDigest: REAL_APPROVAL_EVIDENCE.approvalIdDigest, itemDigest: REAL_APPROVAL_EVIDENCE.itemDigest,
    sourceDigest: REAL_APPROVAL_EVIDENCE.sourceRealPathDigest, destinationDigest: REAL_APPROVAL_EVIDENCE.destinationPathDigest,
    planDigest: REAL_APPROVAL_EVIDENCE.sourceSha256,
    entries: PHASES.map((phase) => ({
      phase, artifactDigest: createHash('sha256').update(`fabricated-artifact-${phase}`).digest('hex'), retention: 'RETAINED',
    })),
    fields: {
      inventoryAffirmed: 'AFFIRMED', artifactsIndependentlyLocated: 'AFFIRMED',
      artifactsIndependentlyDigested: 'AFFIRMED', artifactsRetainedInFull: 'AFFIRMED',
    },
    custodianDigest: INVENTORY_CUSTODIAN, inventoriedAtUtc: INVENTORIED_AT,
  };
  const r = buildRetentionInventory({ ledger, inventory: shaped });
  assertEq(r.overall, 'NOT_ELIGIBLE', 'still not eligible');
  assertEq(r.inventoryComplete, false, 'the real P227-A evidence remains without a completed inventory');
  assertEq(r.recordedInventory, 'NONE', 'no inventory recorded');
  assert(!r.inventoryBound, 'nothing binds to an ineligible ledger');
  assertEq(Object.keys(r.boundDigests).length, 0, 'no digests bound');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
