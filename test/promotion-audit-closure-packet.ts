import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDIT_PHASES,
  buildAuditClosurePacket,
  AUDIT_CLOSURE_DISCLAIMERS,
  PROOF_LIMIT_MATRIX,
} from '../src/ops/promotion-audit-closure-packet.js';
import { buildRetentionInventory, buildRetentionInventorySkeleton } from '../src/ops/promotion-evidence-retention-inventory.js';
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
const OPERATOR_DIGEST = createHash('sha256').update('phase-241-operator-under-test').digest('hex');
const OBSERVER_DIGEST = createHash('sha256').update('phase-241-observer-under-test').digest('hex');
const REVIEWER_DIGEST = createHash('sha256').update('phase-241-reviewer-under-test').digest('hex');
const CLOSER_DIGEST = createHash('sha256').update('phase-241-closer-under-test').digest('hex');
const COMMITTER_DIGEST = createHash('sha256').update('phase-241-committer-under-test').digest('hex');
const VERIFIER_DIGEST = createHash('sha256').update('phase-241-verifier-under-test').digest('hex');
const CUSTODIAN_A = createHash('sha256').update('phase-241-custodian-a').digest('hex');
const CUSTODIAN_B = createHash('sha256').update('phase-241-custodian-b').digest('hex');
const INVENTORY_CUSTODIAN = createHash('sha256').update('phase-241-inventory-custodian').digest('hex');
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
  Buffer.from('mp42isomcatalog-authority-audit-fixture', 'ascii'),
]);

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-audit-')); }

type Rec = Record<string, unknown>;
type Reports = Record<string, Rec>;
interface ChainOpts { itemId?: string; approvalId?: string; body?: Buffer; release?: boolean; inventoryReports?: boolean }

// phase -> (its own self-digest field, its hashing scope). Authoritative: taken from the self-digest registry.
// A genuine NON-terminal headline per phase, for the reverse contradiction: body says every check passed
// while the headline hides it. Producers compute `overall` FROM those booleans, so this cannot occur honestly.
const PHASE_NON_TERMINAL: Readonly<Record<number, string>> = {
  231: 'EXECUTION_AUTHORIZATION_BLOCKED',
  232: 'EXECUTION_AUTHORIZATION_RECORD_PENDING',
  233: 'POST_RUN_OBSERVATION_PENDING',
  234: 'POST_RUN_DISPOSITION_PENDING',
  235: 'OPERATION_CLOSURE_PENDING',
  236: 'CHAIN_REPLAY_VERIFIED_OPEN',
  237: 'PROVENANCE_PENDING',
  238: 'SOURCE_RECORDS_PENDING',
  239: 'CUSTODY_LEDGER_PENDING',
  240: 'INVENTORY_PENDING',
};

// Each phase's terminal success headline, for asserting a forgery KEEPS it while contradicting its own body.
const PHASE_TERMINAL: Readonly<Record<number, string>> = {
  231: 'EXECUTION_AUTHORIZATION_TEMPLATE_READY',
  232: 'EXECUTION_AUTHORIZATION_RECORD_APPROVED',
  233: 'POST_RUN_OBSERVATION_RECORDED',
  234: 'POST_RUN_DISPOSITION_ACCEPTED',
  235: 'OPERATION_CLOSURE_CLOSED',
  236: 'CHAIN_REPLAY_VERIFIED_CLOSED',
  237: 'PROVENANCE_COMMITTED',
  238: 'SOURCE_RECORDS_VERIFIED',
  239: 'CUSTODY_LEDGER_INTACT',
  240: 'INVENTORY_COMPLETE',
};

const SEAL: Readonly<Record<number, readonly [string, string]>> = {
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
// The boundDigests key each phase names its parent under. Phase 236 names 231-235 in chainDigests instead.
const PARENT_KEY: Readonly<Record<number, string>> = {
  232: 'gate-authorization', 233: 'authorization-record', 234: 'observation-record', 235: 'disposition-record',
  237: 'replay-report', 238: 'commitment-report', 239: 'verification-report', 240: 'custody-ledger',
};
const OP_FIELDS: readonly string[] = ['approvalIdDigest', 'itemDigest', 'sourceDigest', 'destinationDigest', 'planDigest'];
const OP_KEBAB: Readonly<Record<string, string>> = {
  approvalIdDigest: 'operation-approval-id', itemDigest: 'operation-item', sourceDigest: 'operation-source',
  destinationDigest: 'operation-destination', planDigest: 'operation-plan',
};

// Re-seal a mutated report so it recomputes its own self-digest cleanly. A self-digest is not a signature:
// anyone can rebuild one, which is exactly why the semantic and linkage checks must stand on their own.
function reseal(phase: number, report: Rec, mutate: (r: Rec) => void): Rec {
  const [field, scope] = SEAL[phase]!;
  const forged = JSON.parse(JSON.stringify(report)) as Rec;
  mutate(forged);
  delete forged[field];
  const body: Rec = {};
  for (const k of Object.keys(forged)) body[k] = forged[k];
  forged[field] = createHash('sha256').update(`${scope}:${JSON.stringify(body)}`).digest('hex');
  assertEq(verifySelfDigests([forged]).overall, 'ALL_VERIFIED', `precondition: the phase ${phase} forgery recomputes cleanly`);
  return forged;
}

// The WHOLE synthetic chain, Phases 231-240, every phase in its terminal success state. Synthetic on purpose:
// no approved authorization, recorded observation, accepted disposition, closed closure, verified replay,
// committed manifest, verified submission, intact ledger or complete inventory exists for the real P227-A
// bundle, and this suite never constructs one.
function fullChain(root: string, o: ChainOpts = {}): Reports {
  const itemId = o.itemId ?? '0a40074065d91a75ad41f33fc212e917';
  const approvalId = o.approvalId ?? 'phase-241-synthetic-test';
  const testRoot = join(root, `catalog-authority-test-library-${itemId.slice(0, 8)}`);
  const source = join(testRoot, 'Movies', 'Audit Proof (2026)', 'source.mp4');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, o.body ?? MINIMAL_MP4_FIXTURE);
  const input = { itemId, title: 'Audit Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot: APPROVED_ROOT, approvalId };
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

  const ledgerRec = ledger as unknown as Rec;
  const nine: Reports = {
    231: gate as unknown as Rec, 232: authorization as unknown as Rec, 233: observation as unknown as Rec,
    234: disposition as unknown as Rec, 235: closure as unknown as Rec, 236: replay as unknown as Rec,
    237: commitment as unknown as Rec, 238: verification as unknown as Rec, 239: ledgerRec,
  };
  if (o.release === false) return nine;  // custody still open: no inventory can be taken of it

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
  // INVENTORY_STRUCTURAL_ONLY -- a non-terminal state used by the AUDIT_OPEN cases below.
  const inventory = buildRetentionInventory(
    o.inventoryReports === false
      ? { ledger: ledgerRec, inventory: inventoryRecord }
      : { ledger: ledgerRec, inventory: inventoryRecord, reports: nine },
  );
  assertEq(inventory.overall, o.inventoryReports === false ? 'INVENTORY_STRUCTURAL_ONLY' : 'INVENTORY_COMPLETE',
    `precondition: inventory (${inventory.blockers.join(',')})`);

  return { ...nine, 240: inventory as unknown as Rec };
}

function prefixOf(reports: Reports, upTo: number): Reports {
  const out: Reports = {};
  for (const p of AUDIT_PHASES) { if (p <= upTo && reports[String(p)] !== undefined) out[String(p)] = reports[String(p)]!; }
  return out;
}

console.log('Running Phase 241 audit closure packet suite:\n');

await test('a complete synthetic chain audits AUDIT_CLOSED -- and the packet still creates nothing', () => {
  const root = workspace();
  try {
    const reports = fullChain(root);
    const a = buildAuditClosurePacket({ reports });
    assertEq(a.overall, 'AUDIT_CLOSED', `closed (blockers: ${a.blockers.join(',')})`);
    assertEq(a.blockers.length, 0, 'no blockers');
    assertEq(a.auditClosed, true, 'audit closed');
    assertEq(a.chainComplete, true, 'chain complete');
    assertEq(a.identityAnchored, true, 'identity anchored');
    assertEq(a.terminalPhase, 240, 'terminal phase 240');
    assertEq(a.suppliedCount, 10, 'all ten supplied');
    assert(a.phases.every((p) => p.present && p.verified && p.semanticallySound && p.terminal), 'every phase present, verified, sound and terminal');
    assert(a.phases.every((p) => p.linkedToParent !== false && p.identityMatched !== false), 'every link and identity holds');
    // It audits records; it creates nothing at all.
    assertEq(a.approvalCreatedByThisTool, false, 'created no approval');
    assertEq(a.executionPerformedByThisTool, false, 'performed no execution');
    assertEq(a.observationCapturedByThisTool, false, 'captured no observation');
    assertEq(a.custodyHeldByThisTool, false, 'held no custody');
    assertEq(a.archivedByThisTool, false, 'archived nothing');
    assertEq(a.judgmentFormedByThisTool, false, 'formed no judgment');
    assertEq(a.selfAuthorized, false, 'never self-authorized');
    assertEq(verifySelfDigests([a]).overall, 'ALL_VERIFIED', 'the packet self-verifies');
    // Redaction: chain digests only, never a path, an id or an identity.
    const json = JSON.stringify(a);
    assert(!json.includes('/mnt/') && !json.includes('catalog-authority-test-library'), 'no raw path');
    assert(!json.includes('phase-241-synthetic-test') && !json.includes('0a40074065d91a75ad41f33fc212e917'), 'no raw ids');
    for (const d of [OPERATOR_DIGEST, OBSERVER_DIGEST, REVIEWER_DIGEST, CLOSER_DIGEST, COMMITTER_DIGEST, VERIFIER_DIGEST, CUSTODIAN_A, CUSTODIAN_B, INVENTORY_CUSTODIAN]) {
      assert(!json.includes(d), 'no participant identity');
    }
    for (const t of [DECIDED_AT, OBSERVED_AT, REVIEWED_AT, CLOSED_AT, COMMITTED_AT, VERIFIED_AT, INVENTORIED_AT]) {
      assert(!json.includes(t), 'no timestamp');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BLOCKED by default: with no reports at all there is nothing to audit', () => {
  const a = buildAuditClosurePacket({});
  assertEq(a.overall, 'NOT_ELIGIBLE', 'nothing to audit');
  assertEq(a.terminalPhase, null, 'no terminal phase');
  assertEq(a.auditClosed, false, 'nothing closed');
  assertEq(a.chainComplete, false, 'nothing complete');
  assertEq(a.suppliedCount, 0, 'nothing supplied');
  assert(a.blockers.includes('AUDIT_NO_REPORTS_SUPPLIED'), 'AUDIT_NO_REPORTS_SUPPLIED reported');
  assertEq(a.identityAnchored, false, 'nothing anchored');
  assert(a.redactionSafe === true && !JSON.stringify(a).includes('/mnt/'), 'redaction-safe');
});

// The Phase 231 gate is the ANCHOR: it names the one operation everything else must be about, and no
// downstream report can supply that identity.
await test('NOT_ELIGIBLE without a genuine Phase 231 anchor, and it takes precedence over everything', () => {
  const root = workspace();
  try {
    const reports = fullChain(root);
    // The whole rest of the chain, with the anchor withheld.
    const headless: Reports = { ...reports };
    delete headless['231'];
    const h = buildAuditClosurePacket({ reports: headless });
    assertEq(h.overall, 'NOT_ELIGIBLE', 'no anchor, nothing to audit against');
    assert(h.blockers.includes('AUDIT_ANCHOR_MISSING'), 'AUDIT_ANCHOR_MISSING reported');
    assertEq(h.auditClosed, false, 'nothing closed');
    assertEq(h.identityAnchored, false, 'nothing anchored');

    // An anchor that does not recompute is no anchor at all.
    const tampered = JSON.parse(JSON.stringify(reports['231']!)) as Rec;
    tampered.injectedClaim = 'not-the-gate-that-was-audited';
    const t = buildAuditClosurePacket({ reports: { ...reports, 231: tampered } });
    assertEq(t.overall, 'NOT_ELIGIBLE', 'a non-recomputing anchor is no anchor');
    assert(t.blockers.includes('AUDIT_PHASE_231_DIGEST_MISMATCH'), 'the digest mismatch is reported');
    assert(t.blockers.includes('AUDIT_ANCHOR_MISSING'), 'and the anchor is treated as missing');

    // A wrong report id in the anchor slot is likewise NOT_ELIGIBLE, even though other errors also exist.
    const w = buildAuditClosurePacket({ reports: { ...reports, 231: reports['236']! } });
    assertEq(w.overall, 'NOT_ELIGIBLE', 'a wrong report in the anchor slot');
    assert(w.blockers.includes('AUDIT_PHASE_231_REPORT_INVALID'), 'AUDIT_PHASE_231_REPORT_INVALID reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Absence is normal. The chain legitimately stops partway and that is NOT a defect.
await test('every clean prefix of a genuine chain audits AUDIT_OPEN with zero blockers', () => {
  const root = workspace();
  try {
    const reports = fullChain(root);
    for (const upTo of [231, 232, 233, 234, 235, 236, 237, 238, 239]) {
      const a = buildAuditClosurePacket({ reports: prefixOf(reports, upTo) });
      assertEq(a.overall, 'AUDIT_OPEN', `prefix to ${upTo} is open (${a.blockers.join(',')})`);
      assertEq(a.blockers.length, 0, `a chain that stops at ${upTo} is not a defect`);
      assertEq(a.terminalPhase, upTo, `terminal phase ${upTo}`);
      assertEq(a.chainComplete, false, 'not complete');
      assertEq(a.auditClosed, false, 'not closed');
      assertEq(a.identityAnchored, true, 'still anchored to the gate');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a HOLE in an otherwise-longer chain is AUDIT_INVALID', () => {
  const root = workspace();
  try {
    const reports = fullChain(root);
    for (const missing of [232, 233, 234, 235, 236, 237, 238, 239]) {
      const holed: Reports = { ...reports };
      delete holed[String(missing)];
      const a = buildAuditClosurePacket({ reports: holed });
      assertEq(a.overall, 'AUDIT_INVALID', `a hole at ${missing} is invalid`);
      assert(a.blockers.some((b) => b.endsWith('_PREDECESSOR_MISSING')), `hole at ${missing} -> predecessor missing`);
      assertEq(a.chainComplete, false, 'never complete');
      assertEq(a.auditClosed, false, 'never closed');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: every inter-phase link is re-derived, and each broken link is caught in turn', () => {
  const root = workspace();
  try {
    const reports = fullChain(root);
    const wrong = 'b'.repeat(64);
    for (const phase of [232, 233, 234, 235, 237, 238, 239, 240]) {
      const broken = reseal(phase, reports[String(phase)]!, (o) => { (o.boundDigests as Rec)[PARENT_KEY[phase]!] = wrong; });
      const a = buildAuditClosurePacket({ reports: { ...reports, [String(phase)]: broken } });
      assertEq(a.overall, 'AUDIT_INVALID', `a broken phase ${phase} link is caught`);
      assert(a.blockers.includes(`AUDIT_PHASE_${phase}_LINK_NOT_REDERIVED`), `phase ${phase} -> AUDIT_PHASE_${phase}_LINK_NOT_REDERIVED`);
      assert(!a.blockers.includes(`AUDIT_PHASE_${phase}_DIGEST_MISMATCH`), `phase ${phase}: the re-sealed forgery still recomputes`);
      assertEq(a.phases.find((p) => p.phase === phase)!.linkedToParent, false, 'the link is reported broken');
      assertEq(a.auditClosed, false, 'never closed');
    }
    // Phase 236 names Phases 231-235 in chainDigests rather than a single parent.
    const broken236 = reseal(236, reports['236']!, (o) => { (o.chainDigests as Rec)['phase-233'] = wrong; });
    const b = buildAuditClosurePacket({ reports: { ...reports, 236: broken236 } });
    assertEq(b.overall, 'AUDIT_INVALID', 'a broken Phase 236 chain digest is caught');
    assert(b.blockers.includes('AUDIT_PHASE_236_LINK_NOT_REDERIVED'), 'AUDIT_PHASE_236_LINK_NOT_REDERIVED reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Identity is checked INDEPENDENTLY of linkage, so a forgery that keeps a correct parent link while carrying
// another operation's digests still fails closed.
await test('adversarial: operation-identity drift is caught at every phase in turn', () => {
  const root = workspace();
  try {
    const mine = fullChain(root);
    const other = fullChain(root, { itemId: '99999999999999999999999999999999', approvalId: 'phase-241-other', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-other')]) });
    for (const phase of [232, 233, 234, 235, 236, 237, 238, 239, 240]) {
      const drifted = reseal(phase, mine[String(phase)]!, (o) => {
        if (phase === 236) {
          const ops = o.operationDigests as Rec;
          const theirs = other['236']!.operationDigests as Rec;
          for (const f of OP_FIELDS) ops[f] = theirs[f];
          return;
        }
        const bound = o.boundDigests as Rec;
        const theirs = other[String(phase)]!.boundDigests as Rec;
        for (const f of OP_FIELDS) {
          const key = phase >= 232 && phase <= 235 ? OP_KEBAB[f]! : f;
          bound[key] = theirs[key];
        }
      });
      const a = buildAuditClosurePacket({ reports: { ...mine, [String(phase)]: drifted } });
      assertEq(a.overall, 'AUDIT_INVALID', `phase ${phase} identity drift is caught`);
      assert(a.blockers.includes(`AUDIT_PHASE_${phase}_OPERATION_IDENTITY_MISMATCH`), `phase ${phase} -> AUDIT_PHASE_${phase}_OPERATION_IDENTITY_MISMATCH`);
      assert(!a.blockers.includes(`AUDIT_PHASE_${phase}_DIGEST_MISMATCH`), `phase ${phase}: the digest check does NOT catch this`);
      assertEq(a.phases.find((p) => p.phase === phase)!.identityMatched, false, 'identity reported as mismatched');
      assertEq(Object.keys(a.operationDigests).length, 0, 'no operation digests published for a drifting chain');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE CORE OF THIS PHASE. A self-digest is not a signature, so ANY report can carry a green `overall` over a
// body that failed its own checks and recompute cleanly. Each phase is therefore audited on its WHOLE body.
await test('THE semantic case: a forged green headline over a failed body is caught at every phase', () => {
  const root = workspace();
  try {
    const reports = fullChain(root);
    // One success boolean per phase, taken from that phase's own report shape -- no two are named alike.
    const successField: Readonly<Record<number, string>> = {
      231: 'operationBound', 232: 'recordBound', 233: 'observationCoherent', 234: 'dispositionCoherent',
      235: 'closureCoherent', 236: 'semanticallyRederived', 237: 'manifestCoherent',
      238: 'allContentDigestsMatched', 239: 'chainLinked', 240: 'allEntriesBound',
    };
    for (const phase of AUDIT_PHASES) {
      const forged = reseal(phase, reports[String(phase)]!, (o) => { o[successField[phase]!] = false; });
      assertEq((forged as Rec).overall, reports[String(phase)]!.overall, `precondition: phase ${phase} keeps its green headline`);
      const a = buildAuditClosurePacket({ reports: { ...reports, [String(phase)]: forged } });
      assert(a.overall === 'AUDIT_INVALID' || a.overall === 'AUDIT_OPEN', `phase ${phase} forgery is never CLOSED`);
      assertEq(a.auditClosed, false, `phase ${phase}: a failed body can never close the audit`);
      assertEq(a.phases.find((p) => p.phase === phase)!.terminal, false, `phase ${phase} is not terminal`);
      assert(!a.blockers.includes(`AUDIT_PHASE_${phase}_DIGEST_MISMATCH`), `phase ${phase}: the digest check does NOT catch this`);
    }
    // Findings recorded under a green headline are caught the same way, at every phase.
    for (const phase of AUDIT_PHASES) {
      const forged = reseal(phase, reports[String(phase)]!, (o) => { o.blockers = ['SOMETHING_FAILED']; });
      const a = buildAuditClosurePacket({ reports: { ...reports, [String(phase)]: forged } });
      assertEq(a.overall, 'AUDIT_INVALID', `phase ${phase} findings under a green headline are caught`);
      assert(a.blockers.includes(`AUDIT_PHASE_${phase}_FINDINGS_PRESENT`), `phase ${phase} -> AUDIT_PHASE_${phase}_FINDINGS_PRESENT`);
      assertEq(a.phases.find((p) => p.phase === phase)!.semanticallySound, false, 'not semantically sound');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Phase 238 keeps failed comparisons in `mismatches`, deliberately separate from `blockers`. Both must be
// empty for the audit to treat it as sound -- checking only `blockers` would miss a failed verification.
await test('adversarial: a Phase 238 report with non-empty mismatches is not sound', () => {
  const root = workspace();
  try {
    const reports = fullChain(root);
    const forged = reseal(238, reports['238']!, (o) => { o.mismatches = ['SOURCE_PHASE_233_CONTENT_DIGEST_MISMATCH']; });
    assertEq((forged as Rec).overall, 'SOURCE_RECORDS_VERIFIED', 'precondition: it keeps its green headline');
    assertEq((forged as Rec).blockers instanceof Array && ((forged as Rec).blockers as unknown[]).length, 0, 'precondition: blockers is still empty');
    const a = buildAuditClosurePacket({ reports: { ...reports, 238: forged } });
    assertEq(a.overall, 'AUDIT_INVALID', 'a verification with mismatches is not sound');
    assert(a.blockers.includes('AUDIT_PHASE_238_FINDINGS_PRESENT'), 'AUDIT_PHASE_238_FINDINGS_PRESENT reported');
    assertEq(a.auditClosed, false, 'never closed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a report claiming it acted is not sound, at every phase that disclaims action', () => {
  const root = workspace();
  try {
    const reports = fullChain(root);
    const actionField: Readonly<Record<number, string>> = {
      232: 'selfAuthorized', 233: 'performedByThisTool', 234: 'reviewedByThisTool', 235: 'purgedByThisTool',
      236: 'capturedByThisTool', 237: 'committedByThisTool', 238: 'retrievedByThisTool',
      239: 'custodyHeldByThisTool', 240: 'deletedByThisTool',
    };
    for (const phase of [232, 233, 234, 235, 236, 237, 238, 239, 240]) {
      const forged = reseal(phase, reports[String(phase)]!, (o) => { o[actionField[phase]!] = true; });
      const a = buildAuditClosurePacket({ reports: { ...reports, [String(phase)]: forged } });
      assertEq(a.overall, 'AUDIT_INVALID', `phase ${phase} claiming action is caught`);
      assert(a.blockers.includes(`AUDIT_PHASE_${phase}_ACTION_CLAIMED`), `phase ${phase} -> AUDIT_PHASE_${phase}_ACTION_CLAIMED`);
      assertEq(a.auditClosed, false, 'never closed');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A genuine but NON-TERMINAL report is not a defect. It is the honest state of a chain in progress, and it
// caps the audit at AUDIT_OPEN with no blockers at all.
await test('a genuine non-terminal report caps the audit at AUDIT_OPEN, never INVALID', () => {
  const root = workspace();
  try {
    const reports = fullChain(root);
    const gate = reports['231']!;

    // Phase 232 PENDING: the blank, undecided authorization skeleton -- exactly the real P227-A state.
    const pendingAuth = buildExecutionAuthorizationRecord({ gate, record: buildExecutionAuthorizationRecordSkeleton(gate)! });
    assertEq(pendingAuth.overall, 'EXECUTION_AUTHORIZATION_RECORD_PENDING', 'precondition: genuine but undecided');
    const a = buildAuditClosurePacket({ reports: { 231: gate, 232: pendingAuth as unknown as Rec } });
    assertEq(a.overall, 'AUDIT_OPEN', `a pending authorization is open, not invalid (${a.blockers.join(',')})`);
    assertEq(a.blockers.length, 0, 'an undecided record is not a defect');
    assertEq(a.terminalPhase, 232, 'terminal phase 232');
    assertEq(a.phases.find((p) => p.phase === 232)!.semanticallySound, true, 'it is genuinely sound');
    assertEq(a.phases.find((p) => p.phase === 232)!.terminal, false, 'but it is not terminal');
    assertEq(a.auditClosed, false, 'so the audit cannot close');

    // Phase 239 INTACT but custody NOT released: genuine, sound, and deliberately non-terminal.
    const open = fullChain(root, { itemId: '11111111111111111111111111111111', approvalId: 'phase-241-open', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-open')]), release: false });
    assertEq(open['239']!.terminalTransition, 'CUSTODY_RETAINED', 'precondition: custody is still held');
    const o = buildAuditClosurePacket({ reports: open });
    assertEq(o.overall, 'AUDIT_OPEN', `an unreleased ledger is open (${o.blockers.join(',')})`);
    assertEq(o.blockers.length, 0, 'still-held custody is not a defect');
    assertEq(o.phases.find((p) => p.phase === 239)!.semanticallySound, true, 'the ledger is sound');
    assertEq(o.phases.find((p) => p.phase === 239)!.terminal, false, 'but not terminal until released');
    assertEq(o.auditClosed, false, 'so the audit cannot close');

    // Phase 240 STRUCTURAL_ONLY: a genuine inventory whose artifacts were not handed over.
    const structural = fullChain(root, { itemId: '22222222222222222222222222222222', approvalId: 'phase-241-structural', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-structural')]), inventoryReports: false });
    assertEq(structural['240']!.overall, 'INVENTORY_STRUCTURAL_ONLY', 'precondition: structural only');
    const s = buildAuditClosurePacket({ reports: structural });
    assertEq(s.overall, 'AUDIT_OPEN', `a structural-only inventory is open (${s.blockers.join(',')})`);
    assertEq(s.blockers.length, 0, 'an unverified-but-genuine inventory is not a defect');
    assertEq(s.phases.find((p) => p.phase === 240)!.terminal, false, 'not terminal');
    assertEq(s.auditClosed, false, 'so the audit cannot close');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a report of the wrong kind in any slot is rejected', () => {
  const root = workspace();
  try {
    const reports = fullChain(root);
    for (const phase of [232, 233, 234, 235, 236, 237, 238, 239, 240]) {
      const wrongKind = phase === 236 ? reports['237']! : reports['236']!;
      const a = buildAuditClosurePacket({ reports: { ...reports, [String(phase)]: wrongKind } });
      assertEq(a.overall, 'AUDIT_INVALID', `a wrong report in slot ${phase} is rejected`);
      assert(a.blockers.includes(`AUDIT_PHASE_${phase}_REPORT_INVALID`), `phase ${phase} -> AUDIT_PHASE_${phase}_REPORT_INVALID`);
      assertEq(a.phases.find((p) => p.phase === phase)!.reportIdOk, false, 'the report id is reported wrong');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a tampered report at any layer fails on digest recompute', () => {
  const root = workspace();
  try {
    const reports = fullChain(root);
    for (const phase of [232, 233, 234, 235, 236, 237, 238, 239, 240]) {
      const tampered = JSON.parse(JSON.stringify(reports[String(phase)]!)) as Rec;
      tampered.injectedClaim = 'smuggled-through-a-green-report';
      const a = buildAuditClosurePacket({ reports: { ...reports, [String(phase)]: tampered } });
      assertEq(a.overall, 'AUDIT_INVALID', `a tampered phase ${phase} report is caught`);
      assert(a.blockers.includes(`AUDIT_PHASE_${phase}_DIGEST_MISMATCH`), `phase ${phase} -> AUDIT_PHASE_${phase}_DIGEST_MISMATCH`);
      assertEq(a.phases.find((p) => p.phase === phase)!.verified, false, 'it does not recompute');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE PROOF-LIMIT MATRIX is the point of this phase: the caveat must travel INSIDE the artifact.
await test('THE proof-limit matrix is emitted, complete, fixed and paired with what each phase does NOT prove', () => {
  const root = workspace();
  try {
    const reports = fullChain(root);
    const a = buildAuditClosurePacket({ reports });
    assertEq(a.overall, 'AUDIT_CLOSED', 'precondition: closed');
    // One entry per phase 231-240, plus the packet's own limit for 241.
    assertEq(a.proofLimits.length, 11, 'eleven entries: ten phases plus this packet');
    for (const phase of [...AUDIT_PHASES, 241]) {
      const entry = a.proofLimits.find((l) => l.phase === phase);
      assert(entry !== undefined, `phase ${phase} has a proof-limit entry`);
      assert(entry!.greenState.length > 0, `phase ${phase} names its green state`);
      assert(entry!.establishes.length > 0, `phase ${phase} says what it establishes`);
      assert(entry!.doesNotEstablish.length > 0, `phase ${phase} says what it does NOT establish`);
    }
    // The matrix is FIXED: identical on a closed audit and on an empty one.
    assertEq(JSON.stringify(a.proofLimits), JSON.stringify(PROOF_LIMIT_MATRIX), 'the emitted matrix is the fixed matrix');
    assertEq(JSON.stringify(buildAuditClosurePacket({}).proofLimits), JSON.stringify(PROOF_LIMIT_MATRIX), 'and it is the same when nothing is audited');
    // The packet's own limit must say the quiet part: consistency is not proof of anything happening.
    const own = a.proofLimits.find((l) => l.phase === 241)!;
    assert(/not signatures/i.test(own.doesNotEstablish), 'the packet states that self-digests are not signatures');
    assert(/fabricate/i.test(own.doesNotEstablish), 'and that a controlling party can fabricate a closed chain');
    assert(/mutually consistent/i.test(own.doesNotEstablish), 'and that AUDIT_CLOSED means only mutual consistency');
    assert(AUDIT_CLOSURE_DISCLAIMERS.some((d) => d.includes('mutually consistent')), 'the disclaimers say AUDIT_CLOSED means mutual consistency');
    assert(AUDIT_CLOSURE_DISCLAIMERS.some((d) => d.includes('creates nothing')), 'and that the packet creates nothing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('the audit is deterministic and self-verifying, and a different bundle never collides', () => {
  const root = workspace();
  try {
    const reports = fullChain(root);
    const first = buildAuditClosurePacket({ reports });
    const second = buildAuditClosurePacket({ reports: { ...reports } });
    assertEq(first.auditDigest, second.auditDigest, 'same bundle -> same digest');
    assertEq(JSON.stringify(first), JSON.stringify(second), 'same bundle -> byte-identical report');
    const partial = buildAuditClosurePacket({ reports: prefixOf(reports, 235) });
    assert(partial.auditDigest !== first.auditDigest, 'a different bundle yields a different digest');
    assertEq(verifySelfDigests([partial]).overall, 'ALL_VERIFIED', 'the partial packet self-verifies too');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a smuggled raw path anywhere in the bundle fails closed and is never echoed', () => {
  const root = workspace();
  try {
    const reports = fullChain(root);
    const leaky = reseal(237, reports['237']!, (o) => { o.blockers = ['/mnt/user/media/Movies/Audit Proof (2026)/source.mp4']; });
    const a = buildAuditClosurePacket({ reports: { ...reports, 237: leaky } });
    assertEq(a.overall, 'AUDIT_INVALID', 'a leaking bundle is not auditable');
    assert(a.blockers.includes('AUDIT_REDACTION_UNSAFE'), 'AUDIT_REDACTION_UNSAFE reported');
    const json = JSON.stringify(a);
    assert(!json.includes('/mnt/') && !json.includes('source.mp4'), 'the smuggled path is never echoed back');
    // A report that simply does not declare itself redaction-safe is caught the same way.
    const undeclared = reseal(235, reports['235']!, (o) => { o.redactionSafe = false; });
    const u = buildAuditClosurePacket({ reports: { ...reports, 235: undeclared } });
    assert(u.blockers.includes('AUDIT_REDACTION_UNSAFE'), 'undeclared redaction safety reported');
    assert(u.blockers.includes('AUDIT_PHASE_235_CONSTANT_INVALID'), 'and the constant itself is reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE LAUNDERING CASE. A forged report can claim the TERMINAL headline while its own success booleans say
// otherwise. Every producer in this chain computes `overall` FROM those booleans, so that combination cannot
// occur in a genuine report -- it is internally contradictory and can only be forged. Reporting it as merely
// "non-terminal" would launder the forgery into AUDIT_OPEN, making it indistinguishable from an honest chain
// still in progress -- which is exactly what the real P227-A chain looks like, and exactly the distinction an
// auditor must be able to draw.
await test('THE laundering case: a terminal headline contradicting its own success booleans is INVALID, not OPEN', () => {
  const root = workspace();
  try {
    const chain = fullChain(root);
    // One success boolean per phase, taken from that phase's own spec.
    const flip: Readonly<Record<number, string>> = {
      231: 'operationBound', 232: 'recordBound', 233: 'observationCoherent', 234: 'dispositionBound',
      235: 'closureCoherent', 236: 'semanticallyRederived', 237: 'manifestBound', 238: 'allReportsRederived',
      239: 'ledgerIntact', 240: 'allEntriesBound',
    };
    for (const phase of AUDIT_PHASES) {
      const field = flip[phase]!;
      const forged = reseal(phase, chain[String(phase)]!, (r) => { r[field] = false; });
      // The forgery is genuine on its face: right report id, recomputes cleanly, terminal headline intact.
      assertEq(verifySelfDigests([forged]).overall, 'ALL_VERIFIED', `precondition: phase ${phase} forgery recomputes`);
      assertEq((forged as Rec).overall, PHASE_TERMINAL[phase], `precondition: phase ${phase} keeps its terminal headline`);

      const a = buildAuditClosurePacket({ reports: { ...chain, [String(phase)]: forged } });
      assertEq(a.overall, 'AUDIT_INVALID', `a contradictory phase ${phase} report is INVALID, not OPEN`);
      assert(a.blockers.includes(`AUDIT_PHASE_${phase}_STATE_CONTRADICTS_HEADLINE`), `phase ${phase} -> AUDIT_PHASE_${phase}_STATE_CONTRADICTS_HEADLINE`);
      // The digest check cannot see this: the forgery re-seals cleanly.
      assert(!a.blockers.includes(`AUDIT_PHASE_${phase}_DIGEST_MISMATCH`), `phase ${phase}: the digest check does NOT catch this`);
      assertEq(a.auditClosed, false, `never closed: phase ${phase}`);
      assertEq(a.phases.find((x) => x.phase === phase)!.semanticallySound, false, `phase ${phase} is not sound`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE REVERSE LAUNDERING CASE. The contradiction rule has to run in BOTH directions. A forger can also keep
// every success boolean true while DOWNGRADING the headline -- a body saying every check passed, under an
// `overall` that hides it. Producers compute `overall` FROM those booleans, so this is just as impossible in a
// genuine report as the forward case, and treating it as honest work-in-progress would let a forged chain sit
// in AUDIT_OPEN looking exactly like the real P227-A.
await test('THE reverse laundering case: a non-terminal headline over all-passing booleans is INVALID, not OPEN', () => {
  const root = workspace();
  try {
    const chain = fullChain(root);
    for (const phase of AUDIT_PHASES) {
      const downgraded = reseal(phase, chain[String(phase)]!, (r) => { r.overall = PHASE_NON_TERMINAL[phase]!; });
      // Genuine on its face: recomputes cleanly, and every success boolean still says the checks passed.
      assertEq(verifySelfDigests([downgraded]).overall, 'ALL_VERIFIED', `precondition: phase ${phase} forgery recomputes`);
      assertEq((downgraded as Rec).overall, PHASE_NON_TERMINAL[phase], `precondition: phase ${phase} headline is non-terminal`);

      const a = buildAuditClosurePacket({ reports: { ...chain, [String(phase)]: downgraded } });
      assertEq(a.overall, 'AUDIT_INVALID', `a downgraded phase ${phase} headline is INVALID, not OPEN`);
      assert(a.blockers.includes(`AUDIT_PHASE_${phase}_STATE_CONTRADICTS_HEADLINE`), `phase ${phase} -> AUDIT_PHASE_${phase}_STATE_CONTRADICTS_HEADLINE`);
      assert(!a.blockers.includes(`AUDIT_PHASE_${phase}_DIGEST_MISMATCH`), `phase ${phase}: the digest check does NOT catch this`);
      assertEq(a.auditClosed, false, `never closed: phase ${phase}`);
      assertEq(a.phases.find((x) => x.phase === phase)!.semanticallySound, false, `phase ${phase} is not sound`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The mirror of the case above, and the reason the contradiction rule is headline-vs-booleans ONLY: a report
// that is genuinely NOT claiming its terminal headline is honest work in progress, not forgery.
await test('a genuinely non-terminal report is still OPEN, never confused with a contradiction', () => {
  const root = workspace();
  try {
    const chain = fullChain(root);
    // A Phase 239 ledger may legitimately be INTACT while custody is still open -- Phase 240 treats that as
    // premature, not defective -- so it must NOT trip the contradiction rule.
    const open239 = reseal(239, chain['239']!, (r) => { r.terminalTransition = 'CUSTODY_RETAINED'; });
    const a = buildAuditClosurePacket({ reports: { ...chain, 239: open239, 240: undefined } as Rec });
    assert(!a.blockers.includes('AUDIT_PHASE_239_STATE_CONTRADICTS_HEADLINE'), 'an intact-but-unreleased ledger is not a contradiction');
    assertEq(a.auditClosed, false, 'and it is certainly not closed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI audits a chain bundle and never echoes raw paths, ids or identities', () => {
  const root = workspace();
  try {
    const reports = fullChain(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const paths: Record<number, string> = {};
    for (const phase of AUDIT_PHASES) paths[phase] = w(`p${phase}.json`, reports[String(phase)]!);
    const outPath = join(root, 'AUDITMARKER-out', 'audit.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-audit-closure-packet-cli.ts', import.meta.url));
    const run = (args: readonly string[]) => spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], { cwd: projectRoot, encoding: 'utf8' });
    const allFlags = AUDIT_PHASES.flatMap((p) => [`--phase${p}`, paths[p]!]);

    const ok = run([...allFlags, '--out', outPath]);
    assert(ok.error === undefined, `spawn ok: ${ok.error?.message ?? ''}`);
    assertEq(ok.status, 0, `AUDIT_CLOSED exit 0 (stderr: ${ok.stderr ?? ''})`);
    assert(existsSync(outPath), 'report written');
    const parsed = JSON.parse(ok.stdout ?? '') as Rec;
    assertEq(parsed.overall, 'AUDIT_CLOSED', 'stdout overall');
    assertEq(parsed.auditClosed, true, 'stdout auditClosed');
    assertEq(parsed.judgmentFormedByThisTool, false, 'stdout formed no judgment');
    assertEq(parsed.proofLimitCount, 11, 'stdout reports the proof-limit matrix size');
    const stdout = ok.stdout ?? '';
    assert(!stdout.includes('AUDITMARKER') && !stdout.includes('catalog-authority-test-library') && !stdout.includes('/mnt/'), 'no path fragments in stdout');
    assert(!stdout.includes('phase-241-synthetic-test') && !stdout.includes('0a40074065d91a75ad41f33fc212e917'), 'no raw ids in stdout');
    assert(![OPERATOR_DIGEST, OBSERVER_DIGEST, REVIEWER_DIGEST, CLOSER_DIGEST, COMMITTER_DIGEST, VERIFIER_DIGEST, CUSTODIAN_A, INVENTORY_CUSTODIAN].some((d) => stdout.includes(d)), 'no participant identity in stdout');

    // A prefix exits 3, nothing supplied exits 5, an unreadable file exits 2, a headless bundle exits 5.
    assertEq(run(['--phase231', paths[231]!, '--phase232', paths[232]!]).status, 3, 'a prefix exits AUDIT_OPEN 3');
    assertEq(run([]).status, 5, 'nothing supplied exits NOT_ELIGIBLE 5');
    assertEq(run(['--phase231', join(dir, 'does-not-exist.json')]).status, 2, 'unreadable input exits 2');
    assertEq(run(['--phase232', paths[232]!, '--phase233', paths[233]!]).status, 5, 'a headless bundle exits NOT_ELIGIBLE 5');
    // And an invalid bundle exits 1.
    const holed = AUDIT_PHASES.filter((p) => p !== 236).flatMap((p) => [`--phase${p}`, paths[p]!]);
    assertEq(run(holed).status, 1, 'a holed bundle exits AUDIT_INVALID 1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The ACTUAL prepared, redaction-safe P227-A evidence, captured verbatim from the non-live artifacts. Locked
// here so the audit is exercised against the real chain offline and deterministically -- no SSH, no secret
// approval file, no live surface. The real chain stops at Phase 232 PENDING, so no approved authorization,
// recorded observation, accepted disposition, closed closure, verified replay, committed manifest, verified
// submission, intact ledger or complete inventory exists for it -- and this suite never constructs one.
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

// The real chain: a genuine Phase 231 gate and a genuine, undecided Phase 232 record. Phases 233-240 are
// ABSENT because they cannot exist -- no human approved the run. This builds nothing else.
function realChain(): Reports {
  const preflightReport = buildLivePreflightPlan({ plan: REAL_PREFLIGHT_PLAN });
  const gateEvidence = {
    approvalEvidence: REAL_APPROVAL_EVIDENCE, approvalValidation: REAL_APPROVAL_VALIDATION,
    preflightPlan: REAL_PREFLIGHT_PLAN, preflightReport, preflightSelfDigest: verifySelfDigests([preflightReport]),
  };
  const gate = buildExecutionAuthorization(gateEvidence);
  assertEq(gate.overall, 'EXECUTION_AUTHORIZATION_TEMPLATE_READY', `precondition: real gate ready (${gate.blockers.join(',')})`);
  const authorization = buildExecutionAuthorizationRecord({ gate, record: buildExecutionAuthorizationRecordSkeleton(gate)! });
  assertEq(authorization.overall, 'EXECUTION_AUTHORIZATION_RECORD_PENDING', 'the real run has no human approval');
  return { 231: gate as unknown as Rec, 232: authorization as unknown as Rec };
}

await test('the actual P227-A chain audits AUDIT_OPEN: consistent as far as it goes, never closed', () => {
  const reports = realChain();
  const a = buildAuditClosurePacket({ reports });
  assertEq(a.overall, 'AUDIT_OPEN', `the real chain is open (${a.blockers.join(',')})`);
  assertEq(a.blockers.length, 0, 'stopping at 232 is not a defect -- no human approved the run');
  assertEq(a.terminalPhase, 232, 'the real chain terminates at Phase 232');
  assertEq(a.chainComplete, false, 'the real chain is NOT complete');
  assertEq(a.auditClosed, false, 'the real audit is NOT closed');
  assertEq(a.suppliedCount, 2, 'only two reports exist for the real operation');
  assertEq(a.identityAnchored, true, 'the real operation identity is anchored');
  assertEq(a.phases.find((p) => p.phase === 231)!.terminal, true, 'the real gate IS terminal for its phase');
  assertEq(a.phases.find((p) => p.phase === 232)!.semanticallySound, true, 'the real authorization is genuinely sound');
  assertEq(a.phases.find((p) => p.phase === 232)!.terminal, false, 'but undecided, so not terminal');
  assert(a.phases.slice(2).every((p) => !p.present), 'no observation, disposition, closure, replay, commitment, verification, ledger or inventory exists');
  // The packet creates nothing for the real operation either.
  assertEq(a.approvalCreatedByThisTool, false, 'created no approval');
  assertEq(a.executionPerformedByThisTool, false, 'performed no execution');
  assertEq(a.judgmentFormedByThisTool, false, 'formed no judgment');
  assertEq(verifySelfDigests([a]).overall, 'ALL_VERIFIED', 'the real-chain packet self-verifies');
  const json = JSON.stringify(a);
  assert(!json.includes('/mnt/') && !json.includes('0a40074065d91a75ad41f33fc212e917') && !json.includes('phase-231-p227-a-20260720'), 'redaction-safe: no path, no raw ids');
});

// The lock cannot be talked out of by bolting a finished-looking tail onto the real head.
await test('the actual P227-A chain stays un-closed when handed a synthetic downstream tail', () => {
  const root = workspace();
  try {
    const real = realChain();
    const synthetic = fullChain(root, { itemId: '55555555555555555555555555555555', approvalId: 'phase-241-tail', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-tail')]) });
    const grafted: Reports = { ...real };
    for (const phase of [233, 234, 235, 236, 237, 238, 239, 240]) grafted[String(phase)] = synthetic[String(phase)]!;
    const a = buildAuditClosurePacket({ reports: grafted });
    assertEq(a.overall, 'AUDIT_INVALID', 'a grafted tail is not an auditable chain');
    assertEq(a.auditClosed, false, 'the real P227-A audit is NOT closed');
    assertEq(a.chainComplete, false, 'the real chain is NOT completed by a foreign tail');
    assert(a.blockers.includes('AUDIT_PHASE_233_OPERATION_IDENTITY_MISMATCH'), 'the tail is a different operation');
    assert(a.blockers.includes('AUDIT_PHASE_233_LINK_NOT_REDERIVED'), 'and it does not link to the real authorization');
    assertEq(Object.keys(a.operationDigests).length, 0, 'no operation digests published');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
