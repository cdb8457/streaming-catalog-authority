import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';

// Phase 241: local, non-live FINAL AUDIT / CLOSURE PACKET for Phases 231-240. The capstone of the promotion
// record chain.
//
// WHY IT EXISTS. Every phase below validates its immediate parent and, since Phase 236, the operation identity
// running through the whole chain. Nothing until now took the chain AS A WHOLE and asked the two questions an
// auditor actually asks: is every artifact genuine, internally sound and mutually consistent -- and what does
// that actually let anyone conclude? This packet answers the first by re-deriving every digest, link and
// semantic success state independently, and answers the second by emitting a fixed PROOF-LIMIT MATRIX.
//
// IT CREATES NOTHING. `approvalCreatedByThisTool`, `executionPerformedByThisTool`,
// `observationCapturedByThisTool`, `custodyHeldByThisTool`, `archivedByThisTool`, `judgmentFormedByThisTool`
// and `selfAuthorized` are the constants false. There is no skeleton, no decision field and no human record in
// this phase at all: it is a pure read-only audit over reports. It forms no judgement about whether the
// promotion SHOULD have happened -- only whether the records describing it hang together.
//
// SEMANTIC VALIDATION IS ON THE WHOLE BODY, NOT THE HEADLINE -- standing practice in this stack since the
// Phase 234/235 hardening, applied here TEN TIMES. A self-digest is not a signature, so any report can carry a
// green `overall` over a body that failed its own checks and still recompute cleanly. Every phase is therefore
// checked against its OWN success booleans, its OWN did-nothing constants and an empty blocker list. No two
// phases name these alike; each set is taken from its producer module.
//
// ABSENCE IS NORMAL. The chain legitimately stops partway -- the prepared P227-A operation stops at Phase 232
// because no human approved it, so Phases 233-240 cannot exist. A clean prefix is AUDIT_OPEN with ZERO
// blockers, never a defect. Only a HOLE in an otherwise-longer chain is AUDIT_INVALID.
//
// NOT_ELIGIBLE takes PRECEDENCE over everything: without a genuine Phase 231 gate there is no operation
// identity to audit anything against, and no downstream report can supply one.
//
// THE PROOF-LIMIT MATRIX is the point of the phase. AUDIT_CLOSED is the strongest verdict this stack can
// reach, and it is much weaker than it sounds. The matrix travels INSIDE the report so the caveat cannot be
// separated from the artifact: each phase's green state is paired with what it does NOT establish, and the
// packet states its own limit last -- self-digests are not signatures, so a party controlling every artifact
// can fabricate a chain this packet audits as CLOSED. AUDIT_CLOSED means the records are mutually consistent.
// It does NOT mean the promotion happened, was correct, or was authorized by anyone in particular.
//
// The emitted report is redaction-safe: per-phase booleans, counts, fixed value-free codes, the closed
// proof-limit matrix and the already-public chain digests only -- never a raw path, raw item id, raw approval
// id, or any operator / observer / reviewer / closer / committer / verifier / custodian identity or timestamp.

const OPERATION_DIGEST_FIELDS: readonly string[] = ['approvalIdDigest', 'itemDigest', 'sourceDigest', 'destinationDigest', 'planDigest'];
// Phases 232-235 publish the operation digests under kebab-case keys; everything else uses the field names.
const OPERATION_BINDING_KEYS: Readonly<Record<string, string>> = {
  approvalIdDigest: 'operation-approval-id',
  itemDigest: 'operation-item',
  sourceDigest: 'operation-source',
  destinationDigest: 'operation-destination',
  planDigest: 'operation-plan',
};

export const AUDIT_PHASES: readonly number[] = [231, 232, 233, 234, 235, 236, 237, 238, 239, 240];

// Where each phase publishes the operation digests. THREE shapes, each taken from its producer module: the
// Phase 231 gate carries them inside its emitted template, Phases 232-235 under kebab-case `operation-*` keys
// in boundDigests, Phase 236 in its own `operationDigests` map, and Phases 237-240 under the plain field names
// in boundDigests. A wrong guess here would return undefined for every field and make identity checking
// silently vacuous, so it is spelled out per phase rather than inferred.
type OperationShape = 'TEMPLATE' | 'KEBAB_BOUND' | 'OPERATION_MAP' | 'FIELD_BOUND';

interface PhaseSpec {
  readonly phase: number;
  readonly reportId: string;
  readonly digestField: string;
  readonly terminal: string;              // that phase's terminal success `overall`
  readonly parentBinding?: string;        // boundDigests key that must equal the parent's own digest
  readonly operationShape: OperationShape;
  readonly successBooleans: readonly string[];   // must all be true
  readonly falseConstants: readonly string[];    // must all be false
  readonly trueConstants: readonly string[];     // must all be true
  readonly emptyArrays: readonly string[];       // must be present and empty
}

// Authoritative: every field name below is read from the producer module, not assumed.
const PHASE_SPECS: Readonly<Record<number, PhaseSpec>> = {
  231: {
    phase: 231, reportId: 'phase-231-promotion-execution-authorization', digestField: 'authorizationDigest',
    terminal: 'EXECUTION_AUTHORIZATION_TEMPLATE_READY', operationShape: 'TEMPLATE',
    successBooleans: ['approvalEvidenceValid', 'approvalValidationBound', 'preflightValid', 'preflightRederived', 'selfDigestBound', 'operationBound'],
    falseConstants: [], trueConstants: ['redactionSafe'], emptyArrays: ['blockers'],
  },
  232: {
    phase: 232, reportId: 'phase-232-promotion-execution-authorization-record', digestField: 'recordDigest',
    terminal: 'EXECUTION_AUTHORIZATION_RECORD_APPROVED', parentBinding: 'gate-authorization', operationShape: 'KEBAB_BOUND',
    successBooleans: ['authorizationRecorded', 'gateValid', 'recordWellFormed', 'recordRedactionSafe', 'recordBound', 'decisionCoherent'],
    falseConstants: ['selfAuthorized'], trueConstants: ['redactionSafe'], emptyArrays: ['blockers'],
  },
  233: {
    phase: 233, reportId: 'phase-233-promotion-post-run-observation-record', digestField: 'observationDigest',
    terminal: 'POST_RUN_OBSERVATION_RECORDED', parentBinding: 'authorization-record', operationShape: 'KEBAB_BOUND',
    successBooleans: ['observationRecorded', 'authorizationValid', 'observationWellFormed', 'observationRedactionSafe', 'observationBound', 'observationCoherent'],
    falseConstants: ['performedByThisTool', 'capturedByThisTool', 'selfAuthorized'], trueConstants: ['redactionSafe'], emptyArrays: ['blockers'],
  },
  234: {
    phase: 234, reportId: 'phase-234-promotion-post-run-disposition-record', digestField: 'dispositionDigest',
    terminal: 'POST_RUN_DISPOSITION_ACCEPTED', parentBinding: 'observation-record', operationShape: 'KEBAB_BOUND',
    successBooleans: ['dispositionAccepted', 'observationReviewable', 'dispositionWellFormed', 'dispositionRedactionSafe', 'dispositionBound', 'dispositionCoherent'],
    falseConstants: ['reviewedByThisTool', 'performedByThisTool', 'capturedByThisTool', 'selfAuthorized'], trueConstants: ['redactionSafe'], emptyArrays: ['blockers'],
  },
  235: {
    phase: 235, reportId: 'phase-235-promotion-operation-closure-record', digestField: 'closureDigest',
    terminal: 'OPERATION_CLOSURE_CLOSED', parentBinding: 'disposition-record', operationShape: 'KEBAB_BOUND',
    successBooleans: ['operationClosed', 'dispositionCloseable', 'closureWellFormed', 'closureRedactionSafe', 'closureBound', 'closureCoherent', 'archivalAffirmed'],
    falseConstants: ['closedByThisTool', 'archivedByThisTool', 'purgedByThisTool', 'selfAuthorized'], trueConstants: ['redactionSafe'], emptyArrays: ['blockers'],
  },
  236: {
    phase: 236, reportId: 'phase-236-promotion-chain-replay-verification', digestField: 'replayDigest',
    terminal: 'CHAIN_REPLAY_VERIFIED_CLOSED', operationShape: 'OPERATION_MAP',
    successBooleans: ['chainComplete', 'operationClosed', 'semanticallyRederived', 'identityAnchored'],
    falseConstants: ['performedByThisTool', 'capturedByThisTool', 'selfAuthorized'],
    trueConstants: ['redactionSafe', 'replayedByThisTool'], emptyArrays: ['blockers'],
  },
  237: {
    phase: 237, reportId: 'phase-237-promotion-source-record-provenance-commitment', digestField: 'provenanceDigest',
    terminal: 'PROVENANCE_COMMITTED', parentBinding: 'replay-report', operationShape: 'FIELD_BOUND',
    successBooleans: ['provenanceCommitted', 'replayEligible', 'manifestWellFormed', 'manifestRedactionSafe', 'manifestBound', 'manifestCoherent'],
    falseConstants: ['committedByThisTool', 'verifiedIdentityByThisTool', 'selfAuthorized'], trueConstants: ['redactionSafe'], emptyArrays: ['blockers'],
  },
  238: {
    phase: 238, reportId: 'phase-238-promotion-supplied-source-record-verification', digestField: 'verificationDigest',
    terminal: 'SOURCE_RECORDS_VERIFIED', parentBinding: 'commitment-report', operationShape: 'FIELD_BOUND',
    successBooleans: ['sourceRecordsVerified', 'commitmentEligible', 'manifestBoundToCommitment', 'verificationWellFormed', 'verificationRedactionSafe', 'verificationBound', 'verificationCoherent', 'sourcesRedactionSafe', 'allContentDigestsMatched', 'allReportsRederived'],
    falseConstants: ['retrievedByThisTool', 'identityVerifiedByThisTool', 'selfAuthorized'],
    trueConstants: ['redactionSafe', 'verifiedByThisTool'],
    // Phase 238 keeps failed comparisons in `mismatches`, separate from `blockers`. Both must be empty.
    emptyArrays: ['blockers', 'mismatches'],
  },
  239: {
    phase: 239, reportId: 'phase-239-promotion-chain-custody-ledger', digestField: 'ledgerDigest',
    terminal: 'CUSTODY_LEDGER_INTACT', parentBinding: 'verification-report', operationShape: 'FIELD_BOUND',
    successBooleans: ['ledgerIntact', 'verificationEligible', 'eventsWellFormed', 'eventsRedactionSafe', 'chainLinked', 'transitionsValid'],
    falseConstants: ['custodyHeldByThisTool', 'eventsCreatedByThisTool', 'selfAuthorized'], trueConstants: ['redactionSafe'], emptyArrays: ['blockers'],
  },
  240: {
    phase: 240, reportId: 'phase-240-promotion-evidence-retention-inventory', digestField: 'inventoryDigest',
    terminal: 'INVENTORY_COMPLETE', parentBinding: 'custody-ledger', operationShape: 'FIELD_BOUND',
    successBooleans: ['inventoryComplete', 'ledgerEligible', 'inventoryWellFormed', 'inventoryRedactionSafe', 'inventoryBound', 'inventoryCoherent', 'coverageComplete', 'allEntriesBound', 'allEntriesRetained'],
    falseConstants: ['archivedByThisTool', 'deletedByThisTool', 'retrievedByThisTool', 'selfAuthorized', 'destructionClaimed'],
    trueConstants: ['redactionSafe'], emptyArrays: ['blockers'],
  },
};

// Phase 239 is additionally only terminal once custody has actually been RELEASED -- intact but still held is
// a genuine, non-terminal state, not a defect.
const CUSTODY_RELEASED = 'CUSTODY_RELEASED';

export const AUDIT_CLOSURE_BOUNDARY =
  'No promotion launcher run, no withdrawal run, no remediation, no archival, no deletion, no observed-state capture, no record retrieval, no identity verification, no custody, no real Movies library read or write, no live Jellyfin call, no secret approval-file read, and no self-authorization: this packet only re-derives and audits supplied chain reports.';

export interface ProofLimit {
  readonly phase: number;
  readonly greenState: string;
  readonly establishes: string;
  readonly doesNotEstablish: string;
}

// FIXED and value-free. Each entry is that phase's own honest limit, restated here so a reader of the audit
// packet alone cannot mistake a green chain for a proven one.
export const PROOF_LIMIT_MATRIX: readonly ProofLimit[] = [
  {
    phase: 231, greenState: 'EXECUTION_AUTHORIZATION_TEMPLATE_READY',
    establishes: 'The prepared non-live evidence is valid, cross-bound, and describes exactly one promote-observe-withdraw operation.',
    doesNotEstablish: 'It is NOT an authorization. Authorization is the constant NONE and every template field stays PENDING; the run remains a separate human step this gate neither performs nor approves.',
  },
  {
    phase: 232, greenState: 'EXECUTION_AUTHORIZATION_RECORD_APPROVED',
    establishes: 'A well-formed human decision record exists, bound by digest to that one operation, and its pre-run affirmations were made.',
    doesNotEstablish: 'It records a DECISION, never an execution. Execution stays NOT_PERFORMED and captured artifacts NONE; it does not show the run occurred, nor who really made the decision.',
  },
  {
    phase: 233, greenState: 'POST_RUN_OBSERVATION_RECORDED',
    establishes: 'A human reported an outcome for an authorized run, coherently, with a withdrawal proven only when the observed state returned to exactly the before state.',
    doesNotEstablish: 'It is a human REPORT, not evidence the run occurred or that any observed state was real. This validator captured nothing itself.',
  },
  {
    phase: 234, greenState: 'POST_RUN_DISPOSITION_ACCEPTED',
    establishes: 'A human reviewed the recorded outcome and accepted it, with a FAILED run acceptable only once its withdrawal was proven upstream.',
    doesNotEstablish: 'It is a review RECORD. It does not establish that the review was competent, that the outcome was sound, or who performed it.',
  },
  {
    phase: 235, greenState: 'OPERATION_CLOSURE_CLOSED',
    establishes: 'A human closed the operation out, having affirmed the evidence was archived and no remediation was outstanding. Closure is archival, never erasure.',
    doesNotEstablish: 'It does not prove the evidence was actually archived, is retrievable, or still exists. No valid record can express destruction, but destruction can still happen.',
  },
  {
    phase: 236, greenState: 'CHAIN_REPLAY_VERIFIED_CLOSED',
    establishes: 'Every supplied report re-derives from its source record, links to its parent, and the whole chain describes ONE operation. A spliced chain fails here.',
    doesNotEstablish: 'NOT authorship. It does not pin WHICH source records were used: identities, timestamps and the observed AFTER state are all swappable without changing any digest.',
  },
  {
    phase: 237, greenState: 'PROVENANCE_COMMITTED',
    establishes: 'A human committed, at a point in time, to the exact content digests of the four source records, bound to one replay.',
    doesNotEstablish: 'The digests are NEVER recomputed against real records here. A committer controlling the records can commit to any digests; this only makes a LATER substitution detectable.',
  },
  {
    phase: 238, greenState: 'SOURCE_RECORDS_VERIFIED',
    establishes: 'The supplied record bytes canonically digest to what was committed and re-derive their reports through each phase own validator.',
    doesNotEstablish: 'NOT authorship, and NOT that these were the records historically used. A party controlling both the records and the commitment satisfies every check.',
  },
  {
    phase: 239, greenState: 'CUSTODY_LEDGER_INTACT with terminalTransition CUSTODY_RELEASED',
    establishes: 'A hash-linked custody narrative with valid transitions, where editing any event that HAS SUCCESSORS is detectable because every later link breaks.',
    doesNotEstablish: 'Append-only-EVIDENT, never ENFORCED. Resealing the tail, appending to it, truncating it, or rebuilding from genesis is undetectable; only a gap or missing genesis is caught.',
  },
  {
    phase: 240, greenState: 'INVENTORY_COMPLETE',
    establishes: 'Every one of the nine chain artifacts is accounted for, claimed retained, and pinned to this exact chain instance by an unbroken expectation walk.',
    doesNotEstablish: 'An ACCOUNTING, not an existence. It cannot show the artifacts exist, are readable, are stored anywhere, or persist -- nor detect one destroyed and honestly re-listed as PENDING.',
  },
  {
    phase: 241, greenState: 'AUDIT_CLOSED',
    establishes: 'All ten reports are present, genuine, internally sound by their own success criteria, mutually linked, and describe one operation end to end.',
    doesNotEstablish: 'Self-digests are NOT signatures. A party controlling every artifact can fabricate a chain this packet audits as CLOSED. It means the RECORDS are mutually consistent -- not that the promotion happened, was correct, or was authorized by anyone in particular.',
  },
];

export const AUDIT_CLOSURE_DISCLAIMERS: readonly string[] = [
  'This packet creates nothing: no approval, no execution, no observation, no custody, no archive, and no judgment about whether the promotion should have happened.',
  'AUDIT_OPEN is a normal state, not a defect: the chain is consistent as far as it goes but has not reached a closed terminal state.',
  'AUDIT_CLOSED means the ten reports are mutually consistent and each is sound by its own criteria. It does NOT mean the promotion happened, was correct, or was authorized by anyone in particular.',
  'Self-digests are not signatures. A party controlling every artifact in the chain can fabricate a bundle this packet audits as CLOSED; every check here is recomputable by anyone.',
  'Each phase green state is paired in the proof-limit matrix with what it does NOT establish. The matrix travels inside this report so the caveat cannot be separated from the verdict.',
];

export interface AuditPhaseState {
  readonly phase: number;
  readonly present: boolean;
  readonly reportIdOk: boolean;
  readonly verified: boolean;           // its own self-digest recomputes
  readonly semanticallySound: boolean;  // its OWN success booleans, constants and empty blockers hold
  readonly terminal: boolean;           // it is in ITS terminal success state
  readonly linkedToParent: boolean | null;
  readonly identityMatched: boolean | null;
}

export interface AuditClosurePacketReport {
  readonly report: 'phase-241-promotion-audit-closure-packet';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly approvalCreatedByThisTool: false;
  readonly executionPerformedByThisTool: false;
  readonly observationCapturedByThisTool: false;
  readonly custodyHeldByThisTool: false;
  readonly archivedByThisTool: false;
  readonly judgmentFormedByThisTool: false;
  readonly selfAuthorized: false;
  readonly overall: 'AUDIT_CLOSED' | 'AUDIT_OPEN' | 'AUDIT_INVALID' | 'NOT_ELIGIBLE';
  readonly terminalPhase: number | null;
  readonly chainComplete: boolean;
  readonly auditClosed: boolean;
  readonly identityAnchored: boolean;
  readonly suppliedCount: number;
  readonly phases: readonly AuditPhaseState[];
  readonly operationDigests: Readonly<Record<string, string>>;
  readonly chainDigests: Readonly<Record<string, string>>;
  readonly proofLimits: readonly ProofLimit[];
  readonly boundary: string;
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly auditDigest: string;
}

export interface AuditClosurePacketInput {
  readonly reports?: unknown;  // bundle keyed 231..240
}

export function buildAuditClosurePacket(input: AuditClosurePacketInput): AuditClosurePacketReport {
  const blockers: string[] = [];
  const chainDigests: Record<string, string> = {};
  const supplied = asObject(input.reports);

  // (1) Recompute every supplied report independently. A report that cannot reproduce its own digest is not
  //     evidence of anything, so nothing downstream of it may be trusted either.
  const present: boolean[] = [];
  const reportIdOk: boolean[] = [];
  const verified: boolean[] = [];
  const selfDigests: Array<string | undefined> = [];
  AUDIT_PHASES.forEach((phase, i) => {
    const spec = PHASE_SPECS[phase]!;
    const value = supplied[String(phase)];
    if (value === undefined) { present.push(false); reportIdOk.push(false); verified.push(false); selfDigests.push(undefined); return; }
    present.push(true);
    const obj = asObject(value);
    const idOk = obj.report === spec.reportId;
    if (!idOk) blockers.push(`AUDIT_PHASE_${phase}_REPORT_INVALID`);
    const stated = asSha256(obj[spec.digestField]);
    const recomputes = idOk && stated !== undefined && verifySelfDigests([obj]).results[0]?.verified === true;
    if (idOk && !recomputes) blockers.push(`AUDIT_PHASE_${phase}_DIGEST_MISMATCH`);
    reportIdOk.push(idOk);
    verified.push(recomputes);
    selfDigests.push(recomputes ? stated : undefined);
    if (recomputes) chainDigests[`phase-${phase}`] = stated!;
    void i;
  });

  const suppliedCount = present.filter(Boolean).length;

  // (2) ELIGIBILITY. The Phase 231 gate is the anchor: it names the one operation everything else must be
  //     about, and nothing downstream can supply that identity. Without it there is nothing to audit against.
  const anchorOk = present[0] === true && verified[0] === true;
  if (!anchorOk) {
    blockers.push(suppliedCount === 0 ? 'AUDIT_NO_REPORTS_SUPPLIED' : 'AUDIT_ANCHOR_MISSING');
  }

  // (3) Contiguity. The supplied set must be a PREFIX starting at Phase 231: a report whose parent is absent
  //     is a hole, and a chain with a hole cannot be audited as one chain.
  AUDIT_PHASES.forEach((phase, i) => {
    if (i === 0 || !present[i]) return;
    if (!present[i - 1]) blockers.push(`AUDIT_PHASE_${phase}_PREDECESSOR_MISSING`);
  });
  let prefix = 0;
  while (prefix < AUDIT_PHASES.length && present[prefix]) prefix++;
  const terminalPhaseNumber = prefix === 0 ? null : AUDIT_PHASES[prefix - 1]!;

  // (4) The identity ANCHOR: the Phase 231 template names the one operation the whole chain must describe.
  const gateTemplate = asObject(asObject(supplied['231']).template);
  const anchor: Record<string, string> = {};
  let identityAnchored = false;
  if (anchorOk) {
    const digests = OPERATION_DIGEST_FIELDS.map((f) => asSha256(gateTemplate[f]));
    if (digests.every((d) => d !== undefined)) {
      OPERATION_DIGEST_FIELDS.forEach((f, i) => { anchor[f] = digests[i]!; });
      identityAnchored = true;
    } else {
      blockers.push('AUDIT_PHASE_231_OPERATION_IDENTITY_UNAVAILABLE');
    }
  }

  // (5) Per-phase semantic soundness, (6) linkage and (7) identity -- checked INDEPENDENTLY of one another so
  //     a report that is sound but unlinked, or linked but foreign, still fails on the right thing.
  const semanticallySound: boolean[] = [];
  const terminalOk: boolean[] = [];
  const linked: Array<boolean | null> = [];
  const identityMatched: Array<boolean | null> = [];

  AUDIT_PHASES.forEach((phase, i) => {
    const spec = PHASE_SPECS[phase]!;
    if (!present[i]) { semanticallySound.push(false); terminalOk.push(false); linked.push(null); identityMatched.push(null); return; }
    const obj = asObject(supplied[String(phase)]);

    // (5) SEMANTIC SOUNDNESS on the whole body. A green headline over a failed body is caught here.
    let sound = verified[i]!;
    if (verified[i]) {
      for (const f of spec.trueConstants) {
        if (obj[f] !== true) { blockers.push(`AUDIT_PHASE_${phase}_CONSTANT_INVALID`); sound = false; }
      }
      for (const f of spec.falseConstants) {
        if (obj[f] !== false) { blockers.push(`AUDIT_PHASE_${phase}_ACTION_CLAIMED`); sound = false; }
      }
      for (const f of spec.emptyArrays) {
        const list = obj[f];
        if (!Array.isArray(list) || list.length !== 0) { blockers.push(`AUDIT_PHASE_${phase}_FINDINGS_PRESENT`); sound = false; }
      }
    }
    // (5b) TERMINAL STATE. A genuine but non-terminal report is NOT a defect -- it caps the audit at OPEN.
    //
    //      But a report whose HEADLINE claims the terminal success state while its own success booleans (or,
    //      for Phase 239, its terminal transition) say otherwise is NOT "in progress" -- it is internally
    //      CONTRADICTORY. Every producer in this chain computes `overall` FROM those booleans, so the
    //      combination cannot arise in a genuine report and can only be forged. Treating it as merely
    //      non-terminal would launder a forgery into the honest in-progress state and make it indistinguishable
    //      from the real P227-A chain -- which is precisely the thing an auditor must be able to tell apart.
    let isTerminal = false;
    if (sound) {
      const headline = obj.overall === spec.terminal;
      const successes = spec.successBooleans.every((f) => obj[f] === true);
      const released = phase !== 239 || obj.terminalTransition === CUSTODY_RELEASED;
      isTerminal = headline && successes && released;
      // The contradiction is headline-vs-OWN-booleans ONLY. `released` is an ADDITIONAL requirement this audit
      // imposes for a closed chain, not something Phase 239's `overall` implies: a ledger is legitimately
      // CUSTODY_LEDGER_INTACT while custody is still open, which Phase 240 already treats as premature rather
      // than defective. So an unreleased-but-intact ledger stays a genuine non-terminal report and caps the
      // audit at OPEN; only a headline contradicting the report's own success booleans is forgery.
      if (headline && !successes) {
        blockers.push(`AUDIT_PHASE_${phase}_STATE_CONTRADICTS_HEADLINE`);
        sound = false;
      }
    }
    semanticallySound.push(sound);
    terminalOk.push(isTerminal);

    // (6) LINKAGE against the parent's OWN recomputed self-digest. Phase 236 has no single parent: it names
    //     Phases 231-235 in chainDigests, so it is linked when every one of those matches.
    let link: boolean | null = null;
    if (phase === 236) {
      if (verified[i]) {
        const chain = asObject(obj.chainDigests);
        const named: number[] = [231, 232, 233, 234, 235];
        const allKnown = named.every((p) => selfDigests[AUDIT_PHASES.indexOf(p)] !== undefined);
        link = allKnown && named.every((p) => asSha256(chain[`phase-${p}`]) === selfDigests[AUDIT_PHASES.indexOf(p)]);
        if (!link) blockers.push(`AUDIT_PHASE_236_LINK_NOT_REDERIVED`);
      }
    } else if (spec.parentBinding !== undefined) {
      const parentDigest = selfDigests[i - 1];
      const bound = asObject(obj.boundDigests);
      link = parentDigest !== undefined && asSha256(bound[spec.parentBinding]) === parentDigest;
      if (!link && verified[i] && verified[i - 1]) blockers.push(`AUDIT_PHASE_${phase}_LINK_NOT_REDERIVED`);
    }
    linked.push(link);

    // (7) OPERATION IDENTITY against the Phase 231 anchor.
    if (!identityAnchored || !verified[i]) { identityMatched.push(null); return; }
    if (i === 0) { identityMatched.push(true); return; }
    const ops = phaseOperationDigests(spec.operationShape, obj);
    const matches = OPERATION_DIGEST_FIELDS.every((f) => ops[f] !== undefined && ops[f] === anchor[f]);
    if (!matches) blockers.push(`AUDIT_PHASE_${phase}_OPERATION_IDENTITY_MISMATCH`);
    identityMatched.push(matches);
  });

  // (8) Redaction, defence in depth. These are GENERATED reports whose own boundary prose legitimately names
  //     the live surfaces they avoid ("no live Jellyfin call"), so the raw-path-marker scanner applies here
  //     rather than the strict hand-written-record predicate -- the Phase 236 precedent, for the same reason.
  const suppliedReports = AUDIT_PHASES.map((p) => supplied[String(p)]).filter((v) => v !== undefined);
  if (suppliedReports.length > 0) {
    const declared = suppliedReports.every((v) => asObject(v).redactionSafe === true);
    if (!declared || deepRawPath(suppliedReports)) blockers.push('AUDIT_REDACTION_UNSAFE');
  }

  const uniqueBlockers = [...new Set(blockers)];
  const phases: AuditPhaseState[] = AUDIT_PHASES.map((phase, i) => ({
    phase,
    present: present[i]!,
    reportIdOk: reportIdOk[i]!,
    verified: verified[i]!,
    semanticallySound: semanticallySound[i]!,
    terminal: terminalOk[i]!,
    linkedToParent: linked[i]!,
    identityMatched: identityMatched[i]!,
  }));

  const chainComplete = uniqueBlockers.length === 0
    && prefix === AUDIT_PHASES.length
    && identityAnchored
    && phases.every((p) => p.present && p.verified && p.semanticallySound
      && p.linkedToParent !== false && p.identityMatched !== false);
  const auditClosed = chainComplete && phases.every((p) => p.terminal);

  const overall: AuditClosurePacketReport['overall'] =
    !anchorOk ? 'NOT_ELIGIBLE'
      : uniqueBlockers.length > 0 ? 'AUDIT_INVALID'
        : auditClosed ? 'AUDIT_CLOSED'
          : 'AUDIT_OPEN';

  const withoutDigest: Omit<AuditClosurePacketReport, 'auditDigest'> = {
    report: 'phase-241-promotion-audit-closure-packet',
    version: 1,
    redactionSafe: true,
    approvalCreatedByThisTool: false,
    executionPerformedByThisTool: false,
    observationCapturedByThisTool: false,
    custodyHeldByThisTool: false,
    archivedByThisTool: false,
    judgmentFormedByThisTool: false,
    selfAuthorized: false,
    overall,
    terminalPhase: overall === 'NOT_ELIGIBLE' ? null : terminalPhaseNumber,
    chainComplete,
    auditClosed,
    identityAnchored,
    suppliedCount,
    phases,
    // Published only once identity holds across everything supplied -- never a partial or drifting set.
    operationDigests: uniqueBlockers.length === 0 && identityAnchored ? anchor : {},
    chainDigests,
    proofLimits: PROOF_LIMIT_MATRIX,
    boundary: AUDIT_CLOSURE_BOUNDARY,
    blockers: uniqueBlockers,
    disclaimers: AUDIT_CLOSURE_DISCLAIMERS,
  };
  return { ...withoutDigest, auditDigest: digest('phase-241-audit-closure-packet', JSON.stringify(withoutDigest)) };
}

function phaseOperationDigests(shape: OperationShape, obj: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (shape === 'TEMPLATE') {
    const template = asObject(obj.template);
    for (const f of OPERATION_DIGEST_FIELDS) out[f] = asSha256(template[f]);
    return out;
  }
  if (shape === 'KEBAB_BOUND') {
    const bound = asObject(obj.boundDigests);
    for (const f of OPERATION_DIGEST_FIELDS) out[f] = asSha256(bound[OPERATION_BINDING_KEYS[f]!]);
    return out;
  }
  if (shape === 'OPERATION_MAP') {
    const ops = asObject(obj.operationDigests);
    for (const f of OPERATION_DIGEST_FIELDS) out[f] = asSha256(ops[f]);
    return out;
  }
  const bound = asObject(obj.boundDigests);
  for (const f of OPERATION_DIGEST_FIELDS) out[f] = asSha256(bound[f]);
  return out;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asSha256(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}
const RAW_PATH_MARKERS: readonly string[] = ['/mnt/', '\\mnt\\', '/media/Movies', 'user/media', 'catalog-authority-test-library'];
function hasRawPathMarker(value: string): boolean {
  return RAW_PATH_MARKERS.some((m) => value.includes(m));
}
// Flag any string ANYWHERE in the supplied bundle -- keys included -- that carries a raw-path marker.
// Traverses ITERATIVELY with a visited set, so it terminates on any input: a pathologically deep bundle cannot
// overflow the stack and a cyclic bundle cannot loop forever. Skipping an already-visited node is safe (its
// subtree was fully evaluated on first visit); a raw path buried at any depth still fails closed.
function deepRawPath(root: unknown): boolean {
  const stack: unknown[] = [root];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') { if (hasRawPathMarker(value)) return true; continue; }
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) { for (const v of value) stack.push(v); continue; }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (hasRawPathMarker(k)) return true;
      stack.push(v);
    }
  }
  return false;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
