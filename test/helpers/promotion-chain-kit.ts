import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildRetentionInventory, buildRetentionInventorySkeleton } from '../../src/ops/promotion-evidence-retention-inventory.js';
import {
  buildCustodyLedger,
  computeCustodyEventDigest,
  CUSTODY_EVENT_INPUT_ID,
  CUSTODY_GENESIS_SENTINEL,
} from '../../src/ops/promotion-chain-custody-ledger.js';
import {
  buildSuppliedSourceVerification,
  buildSuppliedSourceVerificationSkeleton,
  canonicalSourceRecordDigest,
} from '../../src/ops/promotion-supplied-source-record-verification.js';
import {
  buildProvenanceCommitment,
  buildProvenanceCommitmentSkeleton,
} from '../../src/ops/promotion-source-record-provenance.js';
import { verifyPromotionChainReplay } from '../../src/ops/promotion-chain-replay.js';
import { buildOperationClosureRecord, buildOperationClosureSkeleton } from '../../src/ops/promotion-operation-closure-record.js';
import { buildPostRunDispositionRecord, buildPostRunDispositionSkeleton } from '../../src/ops/promotion-post-run-disposition-record.js';
import { buildPostRunObservationRecord, buildPostRunObservationSkeleton } from '../../src/ops/promotion-post-run-observation-record.js';
import {
  buildExecutionAuthorizationRecord,
  buildExecutionAuthorizationRecordSkeleton,
} from '../../src/ops/promotion-execution-authorization-record.js';
import { buildExecutionAuthorization } from '../../src/ops/promotion-execution-authorization.js';
import { buildApprovalAttestation, validateApprovalAttestation } from '../../src/ops/promotion-approval.js';
import { buildLivePreflightPlan } from '../../src/ops/promotion-live-preflight-plan.js';
import { verifySelfDigests } from '../../src/ops/promotion-self-digest-verifier.js';

// Shared chain builders for suites that need a whole Phases 231-240 record chain to work over. Every artifact
// is produced by its own real producer module -- nothing is hand-rolled -- so a suite testing something ELSE
// (the Phase 242 console, for instance) is exercised against genuine artifacts rather than plausible-looking
// stand-ins.
//
// The synthetic chain is synthetic ON PURPOSE: no approved authorization, recorded observation, accepted
// disposition, closed closure, verified replay, committed manifest, verified submission, intact ledger or
// complete inventory exists for the real P227-A operation, and nothing here ever constructs one for it. The
// real chain builder below stops where the real one does -- at an undecided Phase 232.

export type Rec = Record<string, unknown>;
export type Reports = Record<string, Rec>;

function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(`chain kit precondition: ${msg}`); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`chain kit precondition: ${msg} (expected ${String(expected)}, got ${String(actual)})`);
}

const APPROVED_ROOT = '/mnt/user/media/Movies';
export const OPERATOR_DIGEST = createHash('sha256').update('chain-kit-operator').digest('hex');
export const OBSERVER_DIGEST = createHash('sha256').update('chain-kit-observer').digest('hex');
export const REVIEWER_DIGEST = createHash('sha256').update('chain-kit-reviewer').digest('hex');
export const CLOSER_DIGEST = createHash('sha256').update('chain-kit-closer').digest('hex');
export const COMMITTER_DIGEST = createHash('sha256').update('chain-kit-committer').digest('hex');
export const VERIFIER_DIGEST = createHash('sha256').update('chain-kit-verifier').digest('hex');
export const CUSTODIAN_A = createHash('sha256').update('chain-kit-custodian-a').digest('hex');
export const CUSTODIAN_B = createHash('sha256').update('chain-kit-custodian-b').digest('hex');
export const INVENTORY_CUSTODIAN = createHash('sha256').update('chain-kit-inventory-custodian').digest('hex');
export const PARTICIPANT_DIGESTS: readonly string[] = [
  OPERATOR_DIGEST, OBSERVER_DIGEST, REVIEWER_DIGEST, CLOSER_DIGEST, COMMITTER_DIGEST, VERIFIER_DIGEST,
  CUSTODIAN_A, CUSTODIAN_B, INVENTORY_CUSTODIAN,
];
const DECIDED_AT = '2026-07-21T00:00:00Z';
const OBSERVED_AT = '2026-07-21T01:00:00Z';
const REVIEWED_AT = '2026-07-21T02:00:00Z';
const CLOSED_AT = '2026-07-21T03:00:00Z';
const COMMITTED_AT = '2026-07-21T04:00:00Z';
const VERIFIED_AT = '2026-07-21T05:00:00Z';
const INVENTORIED_AT = '2026-07-22T09:00:00Z';
export const PARTICIPANT_TIMESTAMPS: readonly string[] = [
  DECIDED_AT, OBSERVED_AT, REVIEWED_AT, CLOSED_AT, COMMITTED_AT, VERIFIED_AT, INVENTORIED_AT,
];
const STATE_BEFORE = createHash('sha256').update('chain-kit-observed-state-before').digest('hex');
const STATE_AFTER = createHash('sha256').update('chain-kit-observed-state-after').digest('hex');
function custodyTime(i: number): string { return `2026-07-21T${String(6 + i).padStart(2, '0')}:00:00Z`; }

export const MINIMAL_MP4_FIXTURE = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isomcatalog-authority-chain-kit-fixture', 'ascii'),
]);

// phase -> (its own self-digest field, its hashing scope). Authoritative: taken from the self-digest registry.
export const SEAL: Readonly<Record<number, readonly [string, string]>> = {
  231: ['authorizationDigest', 'phase-231-execution-authorization'],
  232: ['recordDigest', 'phase-232-execution-authorization-record'],
  233: ['observationDigest', 'phase-233-post-run-observation-record'],
  234: ['dispositionDigest', 'phase-234-post-run-disposition-record'],
  235: ['closureDigest', 'phase-235-operation-closure-record'],
  236: ['replayDigest', 'phase-236-chain-replay'],
  237: ['provenanceDigest', 'phase-237-source-record-provenance'],
  238: ['verificationDigest', 'phase-238-supplied-source-record-verification'],
  239: ['ledgerDigest', 'phase-239-custody-ledger'],
  240: ['inventoryDigest', 'phase-240-evidence-retention-inventory'],
};

// Re-seal a mutated report so it recomputes its own self-digest cleanly. A self-digest is not a signature:
// anyone can rebuild one, which is exactly why every semantic check downstream has to stand on its own.
export function reseal(phase: number, report: Rec, mutate: (r: Rec) => void): Rec {
  const [field, scope] = SEAL[phase]!;
  const forged = JSON.parse(JSON.stringify(report)) as Rec;
  mutate(forged);
  delete forged[field];
  const body: Rec = {};
  for (const k of Object.keys(forged)) body[k] = forged[k];
  forged[field] = createHash('sha256').update(`${scope}:${JSON.stringify(body)}`).digest('hex');
  assertEq(verifySelfDigests([forged]).overall, 'ALL_VERIFIED', `the phase ${phase} re-seal recomputes`);
  return forged;
}

export interface ChainOpts {
  readonly itemId?: string;
  readonly approvalId?: string;
  readonly body?: Buffer;
  readonly inventoryReports?: boolean;  // false: a genuine but non-terminal Phase 240 (STRUCTURAL_ONLY)
}

// The WHOLE synthetic chain, Phases 231-240, every phase in its terminal success state.
export function buildSyntheticChain(root: string, o: ChainOpts = {}): Reports {
  const itemId = o.itemId ?? '0a40074065d91a75ad41f33fc212e917';
  const approvalId = o.approvalId ?? 'chain-kit-synthetic';
  const testRoot = join(root, `catalog-authority-test-library-${itemId.slice(0, 8)}`);
  const source = join(testRoot, 'Movies', 'Chain Kit (2026)', 'source.mp4');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, o.body ?? MINIMAL_MP4_FIXTURE);
  const input = { itemId, title: 'Chain Kit', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot: APPROVED_ROOT, approvalId };
  const built = buildApprovalAttestation(input);
  assert(built.ok, 'approval built');
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
  assertEq(gate.overall, 'EXECUTION_AUTHORIZATION_TEMPLATE_READY', `gate ready (${gate.blockers.join(',')})`);

  const authorizationDecision: Rec = {
    ...JSON.parse(JSON.stringify(buildExecutionAuthorizationRecordSkeleton(gate)!)) as Rec,
    decision: 'APPROVED', operatorDigest: OPERATOR_DIGEST, decidedAtUtc: DECIDED_AT,
    observedStateBeforeDigest: STATE_BEFORE,
    fields: { operatorAuthorized: 'AFFIRMED', observedStateWitnessedBefore: 'AFFIRMED', withdrawalPathRehearsed: 'AFFIRMED', observedStateWitnessedAfter: 'PENDING', runExecutedByHuman: 'PENDING' },
  };
  const authorization = buildExecutionAuthorizationRecord({ gate, record: authorizationDecision });
  assertEq(authorization.overall, 'EXECUTION_AUTHORIZATION_RECORD_APPROVED', `approved (${authorization.blockers.join(',')})`);

  const observationRecord: Rec = {
    ...JSON.parse(JSON.stringify(buildPostRunObservationSkeleton(authorization)!)) as Rec,
    observedRunOutcome: 'COMPLETED',
    observedStateBeforeDigest: STATE_BEFORE, observedStateAfterDigest: STATE_AFTER,
    preexistingPreserved: true, withdrewOnlyRunCreatedMaterialization: true,
    observerDigest: OBSERVER_DIGEST, observedAtUtc: OBSERVED_AT,
  };
  const observation = buildPostRunObservationRecord({ authorizationRecord: authorization, observation: observationRecord });
  assertEq(observation.overall, 'POST_RUN_OBSERVATION_RECORDED', `recorded (${observation.blockers.join(',')})`);

  const dispositionRecord: Rec = {
    ...JSON.parse(JSON.stringify(buildPostRunDispositionSkeleton(observation)!)) as Rec,
    reviewerDigest: REVIEWER_DIGEST, reviewedAtUtc: REVIEWED_AT,
    fields: {
      outcomeAccepted: 'AFFIRMED', observedOutcomeReviewed: 'AFFIRMED',
      preexistingIntegrityConfirmed: 'AFFIRMED', evidenceRetainedOutOfBand: 'AFFIRMED', remediationPerformed: 'PENDING',
    },
  };
  const disposition = buildPostRunDispositionRecord({ observationRecord: observation, disposition: dispositionRecord });
  assertEq(disposition.overall, 'POST_RUN_DISPOSITION_ACCEPTED', `accepted (${disposition.blockers.join(',')})`);

  const closureRecord: Rec = {
    ...JSON.parse(JSON.stringify(buildOperationClosureSkeleton(disposition)!)) as Rec,
    closerDigest: CLOSER_DIGEST, closedAtUtc: CLOSED_AT,
    fields: {
      closureAffirmed: 'AFFIRMED', evidenceArchivedOutOfBand: 'AFFIRMED',
      chainDigestsRecordedInArchive: 'AFFIRMED', noOutstandingRemediation: 'AFFIRMED', evidencePurged: 'PENDING',
    },
  };
  const closure = buildOperationClosureRecord({ dispositionRecord: disposition, closure: closureRecord });
  assertEq(closure.overall, 'OPERATION_CLOSURE_CLOSED', `closed (${closure.blockers.join(',')})`);

  const chainReports = { gate, authorization, observation, disposition, closure } as unknown as Rec;
  const sources = { gateEvidence, authorizationDecision, observation: observationRecord, disposition: dispositionRecord, closure: closureRecord } as unknown as Rec;
  const replay = verifyPromotionChainReplay({ ...(chainReports as object), sources } as never);
  assertEq(replay.overall, 'CHAIN_REPLAY_VERIFIED_CLOSED', `replay closed (${replay.blockers.join(',')})`);

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
  assertEq(commitment.overall, 'PROVENANCE_COMMITTED', `committed (${commitment.blockers.join(',')})`);

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
  assertEq(verification.overall, 'SOURCE_RECORDS_VERIFIED', `source records verified (${verification.blockers.join(',')})`);

  const specs = [
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
  assertEq(ledger.overall, 'CUSTODY_LEDGER_INTACT', `ledger intact (${ledger.blockers.join(',')})`);

  const ledgerRec = ledger as unknown as Rec;
  const nine: Reports = {
    231: gate as unknown as Rec, 232: authorization as unknown as Rec, 233: observation as unknown as Rec,
    234: disposition as unknown as Rec, 235: closure as unknown as Rec, 236: replay as unknown as Rec,
    237: commitment as unknown as Rec, 238: verification as unknown as Rec, 239: ledgerRec,
  };

  const inventorySkeleton = JSON.parse(JSON.stringify(buildRetentionInventorySkeleton(ledgerRec)!)) as Rec;
  const inventoryRecord: Rec = {
    ...inventorySkeleton,
    entries: [231, 232, 233, 234, 235, 236, 237, 238, 239].map((phase) => ({
      phase, artifactDigest: nine[String(phase)]![SEAL[phase]![0]] as string, retention: 'RETAINED',
    })),
    custodianDigest: INVENTORY_CUSTODIAN, inventoriedAtUtc: INVENTORIED_AT,
    fields: {
      inventoryAffirmed: 'AFFIRMED', artifactsIndependentlyLocated: 'AFFIRMED',
      artifactsIndependentlyDigested: 'AFFIRMED', artifactsRetainedInFull: 'AFFIRMED',
    },
  };
  // `inventoryReports: false` withholds the artifacts, which is genuine but caps Phase 240 at
  // INVENTORY_STRUCTURAL_ONLY -- a real, non-defective, non-terminal state.
  const inventory = buildRetentionInventory(
    o.inventoryReports === false
      ? { ledger: ledgerRec, inventory: inventoryRecord }
      : { ledger: ledgerRec, inventory: inventoryRecord, reports: nine },
  );
  assertEq(inventory.overall, o.inventoryReports === false ? 'INVENTORY_STRUCTURAL_ONLY' : 'INVENTORY_COMPLETE',
    `inventory (${inventory.blockers.join(',')})`);

  return { ...nine, 240: inventory as unknown as Rec };
}

// The ACTUAL prepared, redaction-safe P227-A evidence, captured verbatim from the non-live artifacts. Locked
// here so suites are exercised against the real chain offline and deterministically -- no SSH, no secret
// approval file, no live surface.
export const REAL_ITEM_ID = '0a40074065d91a75ad41f33fc212e917';
export const REAL_APPROVAL_ID = 'phase-231-p227-a-20260720';
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
    itemId: REAL_ITEM_ID, approvalId: REAL_APPROVAL_ID, approvalStatus: 'PENDING',
    sourceDigest: '08505b269e54350636ebdf6969bcffcbc61f60a27de52449cf7b6c9871d5227f',
    destinationDigest: '099ec7872ddad5654f56aeb86ab3bde7a459d0864533169a70bacab6ef14b924',
  }],
};

// The real chain: a genuine Phase 231 gate and a genuine, UNDECIDED Phase 232 record. Phases 233-240 are
// ABSENT because they cannot exist -- no human approved the run. This builds nothing else, ever.
export function buildRealP227AChain(): Reports {
  const preflightReport = buildLivePreflightPlan({ plan: REAL_PREFLIGHT_PLAN });
  const gateEvidence = {
    approvalEvidence: REAL_APPROVAL_EVIDENCE, approvalValidation: REAL_APPROVAL_VALIDATION,
    preflightPlan: REAL_PREFLIGHT_PLAN, preflightReport, preflightSelfDigest: verifySelfDigests([preflightReport]),
  };
  const gate = buildExecutionAuthorization(gateEvidence);
  assertEq(gate.overall, 'EXECUTION_AUTHORIZATION_TEMPLATE_READY', `real gate ready (${gate.blockers.join(',')})`);
  const authorization = buildExecutionAuthorizationRecord({ gate, record: buildExecutionAuthorizationRecordSkeleton(gate)! });
  assertEq(authorization.overall, 'EXECUTION_AUTHORIZATION_RECORD_PENDING', 'the real run has no human approval');
  return { 231: gate as unknown as Rec, 232: authorization as unknown as Rec };
}
