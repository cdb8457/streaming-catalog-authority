import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';
// The one exact UTC timestamp rule for this chain -- shared, not restated, so it cannot drift per phase.
import { isExactUtcTimestamp } from './promotion-utc-timestamp.js';

// Phase 237: local, non-live SOURCE-RECORD PROVENANCE COMMITMENT validator, layered on the Phase 236 replay.
//
// WHY IT EXISTS. Phase 236 proves the chain is structurally and semantically consistent, but it deliberately
// does NOT pin WHICH human source records produced it. Its own locked non-uniqueness test says so: the
// operator/observer/reviewer/closer digests, every timestamp, and the observed AFTER state can all be swapped
// between two source record sets that re-derive byte-identical reports. (The observed BEFORE state is the one
// exception, pinned since the Phase 232<->233 witnessed-state binding.) So a VERIFIED_CLOSED replay never
// means "these people did these things at these times".
//
// This phase closes the gap the only way an offline validator honestly can: it validates a SEPARATELY SUPPLIED
// human provenance commitment manifest that binds the exact CONTENT DIGESTS of the four human source records
// -- the Phase 232 authorization decision, the Phase 233 observation, the Phase 234 disposition and the
// Phase 235 closure -- to one Phase 236 `replayDigest` and the five operation digests.
//
// WHAT THIS DOES AND DOES NOT PROVE. Self-digests and content digests are NOT signatures and do NOT establish
// authorship. This validator RECORDS a human commitment. It performs NO independent identity verification, and
// it never recomputes the content digests against the real source records -- it cannot, it is offline and is
// handed digests, not records. A committer who controls the records can commit to any digests they like, and
// nothing here would notice.
//
// What it DOES buy: it pins, at a point in time, exactly which record contents a human -- named only by digest
// -- claimed to have independently retained, content-digested, reviewed and bound to THIS replay. A later
// substitution of any of those four records is then detectable, because its content digest will no longer
// match the one committed here. That is a durable anchor against after-the-fact record swapping; it is not
// evidence of who wrote anything.
//
// NOT_ELIGIBLE takes PRECEDENCE over everything: if the Phase 236 replay is absent, not genuine, or anything
// other than a fully-verified closed chain, there is nothing to commit provenance FOR, and no manifest can
// override that. This is what locks the actual prepared P227-A chain, whose replay terminates VERIFIED_OPEN at
// Phase 232 because no human ever approved the run.
//
// ELIGIBILITY IS CHECKED ON THE WHOLE BODY, NOT THE HEADLINE. A self-digest is not a signature, so a forged
// replay can carry a green `overall` over a body that failed Phase 236's own checks and recompute its digest
// cleanly. This validator therefore also requires the replay's own success booleans, its per-phase states, its
// published digests and an empty blocker list -- the same hardening applied one layer down in Phases 234/235.
//
// It commits nothing itself: `committedByThisTool`, `verifiedIdentityByThisTool` and `selfAuthorized` are the
// constants false. It never runs the promotion launcher, reads or writes the real Movies library, contacts
// Jellyfin, or reads the secret approval file.
//
// The emitted report is redaction-safe: chain digests that were already public in the replay, per-record
// presence/match booleans, fixed value-free codes, closed enum states and counts only -- never an identity, a
// timestamp, a raw record, a path, a live identifier, or a committed content digest value.

const REPLAY_REPORT_ID = 'phase-236-promotion-chain-replay-verification';
const OPERATION = 'promote-observe-withdraw';
const VERIFIED_CLOSED = 'CHAIN_REPLAY_VERIFIED_CLOSED';

export const PROVENANCE_COMMITMENT_INPUT_ID = 'phase-237-promotion-source-record-provenance-commitment-input';

export type ProvenanceFieldState = 'PENDING' | 'AFFIRMED' | 'REFUSED';
export type RecordedCommitment = 'COMMITTED' | 'DECLINED' | 'PENDING';

const FIELD_STATES: readonly string[] = ['PENDING', 'AFFIRMED', 'REFUSED'];
// The same "sha256 or the literal PENDING" placeholder discipline used for operatorDigest / observerDigest /
// reviewerDigest / closerDigest across Phases 232-235.
const PLACEHOLDER = 'PENDING';

// `commitmentAffirmed` carries the decision itself: AFFIRMED -> COMMITTED, REFUSED -> DECLINED,
// PENDING -> PENDING. One source of truth, as in Phases 234 and 235, so a manifest can never state a decision
// that contradicts its own fields.
const DECISION_FIELD = 'commitmentAffirmed';
// What a human must have actually done before committing provenance for all four source records.
const AFFIRMATION_FIELDS: readonly string[] = [
  'sourceRecordsRetainedIndependently',
  'sourceRecordsContentDigested',
  'sourceRecordsReviewed',
  'sourceRecordsBoundToThisReplay',
];
const MANIFEST_FIELDS: readonly string[] = [DECISION_FIELD, ...AFFIRMATION_FIELDS];

// The five operation digests, named as the Phase 236 report publishes them.
const OPERATION_DIGEST_FIELDS: readonly string[] = ['approvalIdDigest', 'itemDigest', 'sourceDigest', 'destinationDigest', 'planDigest'];
// The four phases whose HUMAN source records this manifest commits to. Phase 231 is excluded deliberately: its
// input is the prepared evidence bundle, not a record a human wrote.
const COMMITTED_PHASES: readonly number[] = [232, 233, 234, 235];
// Every chain digest the replay must publish before it can be committed against.
const CHAIN_DIGEST_KEYS: readonly string[] = ['phase-231', 'phase-232', 'phase-233', 'phase-234', 'phase-235'];

// Strict allowlists: anything else is smuggled content and fails closed.
const MANIFEST_KEYS: readonly string[] = [
  'record', 'version', 'operation', 'sourceReplayReport', 'replayDigest',
  ...OPERATION_DIGEST_FIELDS, 'sourceRecords', 'fields', 'committerDigest', 'committedAtUtc',
];
const SOURCE_RECORD_KEYS: readonly string[] = ['phase', 'reportDigest', 'contentDigest'];

export interface ProvenanceCommitmentInput {
  readonly replay?: unknown;    // phase-236-promotion-chain-replay-verification report
  readonly manifest?: unknown;  // the separately supplied human provenance commitment manifest
}

// One entry of the human's commitment: which phase, which report it produced, and the content digest of the
// source record that phase consumed.
export interface ProvenanceSourceRecordEntry {
  readonly phase: number;
  readonly reportDigest: string;
  readonly contentDigest: string;
}

// The manifest a human completes. Digest-only: it names no path, no id and no committer identity.
export interface ProvenanceCommitmentSkeleton {
  readonly record: typeof PROVENANCE_COMMITMENT_INPUT_ID;
  readonly version: 1;
  readonly operation: typeof OPERATION;
  readonly sourceReplayReport: typeof REPLAY_REPORT_ID;
  readonly replayDigest: string;
  readonly approvalIdDigest: string;
  readonly itemDigest: string;
  readonly sourceDigest: string;
  readonly destinationDigest: string;
  readonly planDigest: string;
  readonly sourceRecords: readonly ProvenanceSourceRecordEntry[];
  readonly fields: Readonly<Record<string, ProvenanceFieldState>>;
  readonly committerDigest: string;
  readonly committedAtUtc: string;
}

export const PROVENANCE_COMMITMENT_REMAINING_HUMAN_STEPS: readonly string[] = [
  'Independent retention of the four human source records themselves, out of band; this validator holds none of them.',
  'Computation of each content digest from the retained record -- a human step this validator never performs and cannot check.',
  'Independent human review that each committed content digest is the digest of the record that phase actually consumed.',
  'Any identity verification of the committer: this validator records a digest, never a person.',
];

export const PROVENANCE_COMMITMENT_BOUNDARY =
  'No promotion launcher run, no withdrawal run, no remediation, no archival, no observed-state capture, no real Movies library read or write, no live Jellyfin call, no secret approval-file read, no identity verification, and no self-authorization: this validator only checks a separately supplied human provenance manifest against the Phase 236 replay.';

export const PROVENANCE_COMMITMENT_DISCLAIMERS: readonly string[] = [
  'This validator records a human commitment and does nothing else: it retains no source record, computes no content digest, and verifies no identity.',
  'Self-digests and content digests are NOT signatures and do NOT establish authorship. A committer who controls the source records can commit to any digests they like, and nothing here would notice.',
  'PROVENANCE_COMMITTED means only that a well-formed, replay-bound human commitment exists over four content digests -- it is not evidence that those digests are the digests of the records that were actually used.',
  'What it does buy: it pins at a point in time which exact record contents a human, named only by digest, claimed to have retained and reviewed, so a LATER substitution of any of those four records becomes detectable.',
  'NOT_ELIGIBLE means the chain itself has nothing to commit provenance for -- it is not a defect in the supplied manifest, and no manifest can override it.',
  'It never runs the promotion launcher, reads or writes the real Movies library, contacts Jellyfin, or reads the secret approval file.',
];

export interface ProvenanceSourceRecordState {
  readonly phase: number;
  readonly present: boolean;
  readonly reportDigestMatched: boolean;
  readonly contentDigestPresent: boolean;
}

export interface ProvenanceCommitmentReport {
  readonly report: 'phase-237-promotion-source-record-provenance-commitment';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly committedByThisTool: false;
  readonly verifiedIdentityByThisTool: false;
  readonly selfAuthorized: false;
  readonly overall:
    | 'PROVENANCE_COMMITTED'
    | 'PROVENANCE_DECLINED'
    | 'PROVENANCE_PENDING'
    | 'PROVENANCE_INVALID'
    | 'NOT_ELIGIBLE';
  readonly recordedCommitment: RecordedCommitment | 'NONE';
  readonly provenanceCommitted: boolean;
  readonly replayEligible: boolean;
  readonly manifestWellFormed: boolean;
  readonly manifestRedactionSafe: boolean;
  readonly manifestBound: boolean;
  readonly manifestCoherent: boolean;
  readonly sourceRecordCount: number;
  readonly sourceRecords: readonly ProvenanceSourceRecordState[];
  // A digest OVER the ordered (phase, reportDigest, contentDigest) triples. Redaction-safe and durable: a later
  // verifier recomputes it from the manifest to detect substitution, without this report ever echoing a
  // committed content digest. Null unless the commitment is valid and bound.
  readonly sourceCommitmentDigest: string | null;
  readonly boundDigests: Readonly<Record<string, string>>;
  readonly fieldStates: Readonly<Record<string, ProvenanceFieldState>>;
  readonly remainingHumanSteps: readonly string[];
  readonly boundary: string;
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly provenanceDigest: string;
}

export function buildProvenanceCommitment(input: ProvenanceCommitmentInput): ProvenanceCommitmentReport {
  const blockers: string[] = [];
  const boundDigests: Record<string, string> = {};

  // (1) The Phase 236 replay: genuine, fully VERIFIED_CLOSED, and sound on its whole body -- not just its
  //     headline. Anything wrong here means there is nothing to commit provenance FOR: NOT_ELIGIBLE, never
  //     INVALID.
  const replay = validateReplayReport(input.replay, blockers);
  const replayEligible = replay.ok;
  if (replayEligible) boundDigests['replay-report'] = replay.replayDigest!;

  // (2) The human manifest: present, single, strictly allowlisted, closed enums, well-formed record list.
  const man = validateManifestShape(input.manifest, blockers);
  const manifestWellFormed = man.ok;

  // (3) Redaction. The manifest is hand-written like the Phase 232-235 records, so it gets the STRICT
  //     predicate -- a raw path or live surface anywhere in it fails closed. (The replay report is scanned
  //     separately, with raw-path markers only: its own boundary prose legitimately names the live surfaces it
  //     avoids, so the strict predicate would reject every genuine report.)
  const manifestRedactionSafe = input.manifest === undefined ? false : !deepLiveSurface(input.manifest);
  if (input.manifest !== undefined && !manifestRedactionSafe) blockers.push('MANIFEST_LIVE_SURFACE');

  // (4) The binding: the manifest names this replay by its own digest, carries the same five operation
  //     digests, and pairs each source record with the report digest that phase actually produced. This is the
  //     substitution / transplantation / mismatched-pairing defence.
  let manifestBound = false;
  const sourceRecords: ProvenanceSourceRecordState[] = [];
  if (replayEligible && manifestWellFormed) {
    const bindsReplay = man.obj.replayDigest === replay.replayDigest;
    if (!bindsReplay) blockers.push('MANIFEST_NOT_BOUND_TO_REPLAY');

    let operationMatch = true;
    for (const f of OPERATION_DIGEST_FIELDS) {
      if (asSha256(man.obj[f]) !== undefined && man.obj[f] === replay.operationDigests[f]) continue;
      operationMatch = false;
      blockers.push(`MANIFEST_${screamingSnake(f)}_MISMATCH`);
    }

    // Each entry must pair its phase with the digest of the report that phase produced in THIS replay.
    let pairingMatch = true;
    for (const phase of COMMITTED_PHASES) {
      const entry = man.entries.find((e) => e.phase === phase);
      const expected = replay.chainDigests[`phase-${phase}`];
      const matched = entry !== undefined && expected !== undefined && entry.reportDigest === expected;
      if (entry !== undefined && !matched) { pairingMatch = false; blockers.push('MANIFEST_SOURCE_RECORD_REPORT_DIGEST_MISMATCH'); }
      sourceRecords.push({
        phase,
        present: entry !== undefined,
        reportDigestMatched: matched,
        contentDigestPresent: entry !== undefined && asSha256(entry.contentDigest) !== undefined,
      });
    }

    manifestBound = bindsReplay && operationMatch && pairingMatch && man.entriesOk;
    if (manifestBound) {
      for (const f of OPERATION_DIGEST_FIELDS) boundDigests[f] = asString(man.obj[f])!;
      for (const phase of COMMITTED_PHASES) boundDigests[`phase-${phase}`] = replay.chainDigests[`phase-${phase}`]!;
    }
  }

  // (5) Coherence between the decision, the affirmations that must back it, and what the entries actually pin.
  let manifestCoherent = false;
  let decision: RecordedCommitment | 'NONE' = 'NONE';
  const fieldStates: Record<string, ProvenanceFieldState> = {};
  if (manifestWellFormed) {
    const fields = asObject(man.obj.fields);
    for (const f of MANIFEST_FIELDS) fieldStates[f] = fields[f] as ProvenanceFieldState;

    const affirmed = fieldStates[DECISION_FIELD];
    decision = affirmed === 'AFFIRMED' ? 'COMMITTED' : affirmed === 'REFUSED' ? 'DECLINED' : 'PENDING';

    // Committing means every part of the commitment was actually done. DECLINED is deliberately ungated --
    // refusing to commit is never refused, as with Phase 234 REJECTED and Phase 235 HELD_OPEN.
    let decisionBacked = true;
    if (decision === 'COMMITTED' && !AFFIRMATION_FIELDS.every((f) => fieldStates[f] === 'AFFIRMED')) {
      blockers.push('MANIFEST_COMMITTED_WITHOUT_FULL_AFFIRMATION'); decisionBacked = false;
    }

    // A commitment with no content digest commits to nothing; an undecided manifest pins nothing at all.
    // DECLINED is unconstrained: a human may refuse before or after digesting anything.
    let contentOk = true;
    if (decision === 'COMMITTED' && !man.entries.every((e) => asSha256(e.contentDigest) !== undefined)) {
      blockers.push('MANIFEST_CONTENT_DIGEST_REQUIRED'); contentOk = false;
    }
    if (decision === 'PENDING' && !man.entries.every((e) => e.contentDigest === PLACEHOLDER)) {
      blockers.push('MANIFEST_CONTENT_DIGEST_NOT_PENDING'); contentOk = false;
    }

    // A decided manifest names WHO committed (by digest) and WHEN; an undecided one claims neither.
    const decided = decision !== 'PENDING';
    const committerOk = decided ? asSha256(man.obj.committerDigest) !== undefined : man.obj.committerDigest === PLACEHOLDER;
    if (!committerOk) blockers.push(decided ? 'MANIFEST_COMMITTER_DIGEST_REQUIRED' : 'MANIFEST_COMMITTER_DIGEST_NOT_PENDING');
    const committedAtOk = decided ? isExactUtcTimestamp(man.obj.committedAtUtc) : man.obj.committedAtUtc === PLACEHOLDER;
    if (!committedAtOk) blockers.push(decided ? 'MANIFEST_COMMITTED_AT_REQUIRED' : 'MANIFEST_COMMITTED_AT_NOT_PENDING');

    manifestCoherent = decisionBacked && contentOk && committerOk && committedAtOk;
  }

  const uniqueBlockers = [...new Set(blockers)];
  // When the replay is eligible, every remaining blocker is manifest-side by construction.
  const manifestSound = uniqueBlockers.length === 0
    && manifestWellFormed && manifestRedactionSafe && manifestBound && manifestCoherent;

  // NOT_ELIGIBLE takes precedence over everything: an ineligible chain cannot be committed against at all.
  const overall: ProvenanceCommitmentReport['overall'] =
    !replayEligible ? 'NOT_ELIGIBLE'
      : !manifestSound ? 'PROVENANCE_INVALID'
        : decision === 'COMMITTED' ? 'PROVENANCE_COMMITTED'
          : decision === 'DECLINED' ? 'PROVENANCE_DECLINED'
            : 'PROVENANCE_PENDING';
  const settled = overall === 'PROVENANCE_COMMITTED' || overall === 'PROVENANCE_DECLINED' || overall === 'PROVENANCE_PENDING';

  const withoutDigest: Omit<ProvenanceCommitmentReport, 'provenanceDigest'> = {
    report: 'phase-237-promotion-source-record-provenance-commitment',
    version: 1,
    redactionSafe: true,
    committedByThisTool: false,
    verifiedIdentityByThisTool: false,
    selfAuthorized: false,
    overall,
    recordedCommitment: settled ? decision : 'NONE',
    provenanceCommitted: overall === 'PROVENANCE_COMMITTED',
    replayEligible,
    manifestWellFormed,
    manifestRedactionSafe,
    manifestBound,
    manifestCoherent,
    sourceRecordCount: man.entries.length,
    sourceRecords,
    // Published only for a valid COMMITTED manifest: a durable, redaction-safe anchor over exactly what was
    // committed, so a later substitution is detectable without this report echoing any content digest.
    sourceCommitmentDigest: overall === 'PROVENANCE_COMMITTED' ? computeSourceCommitmentDigest(man.entries) : null,
    boundDigests,
    fieldStates,
    remainingHumanSteps: PROVENANCE_COMMITMENT_REMAINING_HUMAN_STEPS,
    boundary: PROVENANCE_COMMITMENT_BOUNDARY,
    blockers: uniqueBlockers,
    disclaimers: PROVENANCE_COMMITMENT_DISCLAIMERS,
  };
  return { ...withoutDigest, provenanceDigest: digest('phase-237-source-record-provenance', JSON.stringify(withoutDigest)) };
}

// Emit the blank manifest a human completes, bound to this replay. EVERY field is PENDING and every content
// digest is the PENDING placeholder -- this NEVER creates or infers a COMMITTED manifest and never invents a
// content digest. Returns null when the replay is not eligible (fail closed).
//
// Only DERIVED bindings are pre-filled: the replay digest, the five operation digests, and each entry's phase
// and reportDigest, all copied from the replay. `contentDigest` uses the same "sha256 or the literal PENDING"
// discipline already established for operatorDigest / observerDigest / reviewerDigest / closerDigest across
// Phases 232-235, so no new representation is introduced and the shape validator accepts the blank.
export function buildProvenanceCommitmentSkeleton(replayValue: unknown): ProvenanceCommitmentSkeleton | null {
  const replay = validateReplayReport(replayValue, []);
  if (!replay.ok) return null;
  const fields: Record<string, ProvenanceFieldState> = {};
  for (const f of MANIFEST_FIELDS) fields[f] = 'PENDING';
  return {
    record: PROVENANCE_COMMITMENT_INPUT_ID,
    version: 1,
    operation: OPERATION,
    sourceReplayReport: REPLAY_REPORT_ID,
    replayDigest: replay.replayDigest!,
    approvalIdDigest: replay.operationDigests.approvalIdDigest!,
    itemDigest: replay.operationDigests.itemDigest!,
    sourceDigest: replay.operationDigests.sourceDigest!,
    destinationDigest: replay.operationDigests.destinationDigest!,
    planDigest: replay.operationDigests.planDigest!,
    sourceRecords: COMMITTED_PHASES.map((phase) => ({
      phase,
      reportDigest: replay.chainDigests[`phase-${phase}`]!,
      contentDigest: PLACEHOLDER,
    })),
    fields,
    committerDigest: PLACEHOLDER,
    committedAtUtc: PLACEHOLDER,
  };
}

interface ValidatedReplay {
  readonly ok: boolean;
  readonly replayDigest: string | undefined;
  readonly operationDigests: Readonly<Record<string, string | undefined>>;
  readonly chainDigests: Readonly<Record<string, string | undefined>>;
}

// The replay must be the genuine Phase 236 report AND sound on its whole body. The headline is not enough: a
// self-digest is not a signature, so a forged report can carry a green `overall` over a body that failed Phase
// 236's own checks and still recompute cleanly. Every failure here is an INELIGIBLE CHAIN, not an invalid
// manifest.
function validateReplayReport(value: unknown, blockers: string[]): ValidatedReplay {
  const none: ValidatedReplay = { ok: false, replayDigest: undefined, operationDigests: {}, chainDigests: {} };
  if (value === undefined) { blockers.push('REPLAY_RECORD_MISSING'); return none; }
  const obj = asObject(value);
  if (obj.report !== REPLAY_REPORT_ID) { blockers.push('REPLAY_RECORD_INVALID'); return none; }

  const stated = asSha256(obj.replayDigest);
  if (stated === undefined || verifySelfDigests([obj]).results[0]?.verified !== true) {
    blockers.push('REPLAY_RECORD_DIGEST_MISMATCH'); return none;
  }
  let ok = true;
  if (obj.overall !== VERIFIED_CLOSED) { blockers.push('REPLAY_RECORD_NOT_VERIFIED_CLOSED'); ok = false; }

  // The replay's OWN success booleans -- the Phase 234/235 hardening, applied one layer up.
  if (obj.redactionSafe !== true) { blockers.push('REPLAY_RECORD_NOT_REDACTION_SAFE'); ok = false; }
  if (obj.chainComplete !== true) { blockers.push('REPLAY_RECORD_CHAIN_NOT_COMPLETE'); ok = false; }
  if (obj.operationClosed !== true) { blockers.push('REPLAY_RECORD_OPERATION_NOT_CLOSED'); ok = false; }
  if (obj.semanticallyRederived !== true) { blockers.push('REPLAY_RECORD_NOT_SEMANTICALLY_REDERIVED'); ok = false; }
  if (obj.identityAnchored !== true) { blockers.push('REPLAY_RECORD_IDENTITY_NOT_ANCHORED'); ok = false; }
  if (obj.replayedByThisTool !== true) { blockers.push('REPLAY_RECORD_NOT_REPLAYED_BY_TOOL'); ok = false; }
  // The replay must itself still be a replay only -- it may never claim to have acted.
  if (obj.performedByThisTool !== false) { blockers.push('REPLAY_RECORD_PERFORMED_CLAIMED'); ok = false; }
  if (obj.capturedByThisTool !== false) { blockers.push('REPLAY_RECORD_CAPTURED_CLAIMED'); ok = false; }
  if (obj.selfAuthorized !== false) { blockers.push('REPLAY_RECORD_SELF_AUTHORIZED'); ok = false; }
  if (!Array.isArray(obj.blockers) || obj.blockers.length !== 0) { blockers.push('REPLAY_RECORD_BLOCKERS_PRESENT'); ok = false; }
  // Defence in depth, with the RAW-PATH-MARKER scanner rather than the strict predicate: a genuine replay
  // report's own boundary prose legitimately names the live surfaces it avoids ("no live Jellyfin call"), so
  // the strict predicate would reject every real report. Phase 236 set this precedent for the same reason.
  if (deepRawPath(obj)) { blockers.push('REPLAY_RECORD_RAW_PATH_PRESENT'); ok = false; }

  // Every one of the five phases must be present, recomputed, linked, identity-matched and re-derived.
  const phases = Array.isArray(obj.phases) ? obj.phases : null;
  const phasesOk = phases !== null && phases.length === 5 && phases.every((p) => {
    const s = asObject(p);
    return s.present === true && s.reportIdOk === true && s.verified === true
      && s.linkedToParent !== false && s.identityMatched === true && s.rederivedFromSource === true;
  });
  if (!phasesOk) { blockers.push('REPLAY_RECORD_PHASES_INCOMPLETE'); ok = false; }

  const operationDigests: Record<string, string | undefined> = {};
  const publishedOps = asObject(obj.operationDigests);
  for (const f of OPERATION_DIGEST_FIELDS) {
    operationDigests[f] = asSha256(publishedOps[f]);
    if (operationDigests[f] === undefined) { blockers.push('REPLAY_RECORD_OPERATION_DIGESTS_INCOMPLETE'); ok = false; }
  }
  const chainDigests: Record<string, string | undefined> = {};
  const publishedChain = asObject(obj.chainDigests);
  for (const k of CHAIN_DIGEST_KEYS) {
    chainDigests[k] = asSha256(publishedChain[k]);
    if (chainDigests[k] === undefined) { blockers.push('REPLAY_RECORD_CHAIN_DIGESTS_INCOMPLETE'); ok = false; }
  }

  return ok ? { ok: true, replayDigest: stated, operationDigests, chainDigests } : none;
}

interface ValidatedManifest {
  readonly ok: boolean;
  readonly obj: Record<string, unknown>;
  readonly entries: readonly ProvenanceSourceRecordEntry[];
  readonly entriesOk: boolean;
}

// Strict shape: one object, only allowlisted keys, fixed literals correct, closed enums, and a source-record
// LIST of exactly four well-formed entries in ascending phase order with no duplicates. The list is an array
// on purpose: omission, duplication and reordering are all distinct, detectable failures.
function validateManifestShape(value: unknown, blockers: string[]): ValidatedManifest {
  const none: ValidatedManifest = { ok: false, obj: {}, entries: [], entriesOk: false };
  if (value === undefined) { blockers.push('MANIFEST_MISSING'); return none; }
  if (Array.isArray(value)) { blockers.push('MANIFEST_NOT_SINGLE'); return none; }
  if (!value || typeof value !== 'object') { blockers.push('MANIFEST_INVALID'); return none; }
  const obj = value as Record<string, unknown>;

  let ok = true;
  for (const k of Object.keys(obj)) {
    if (!MANIFEST_KEYS.includes(k)) { blockers.push('MANIFEST_UNKNOWN_FIELD'); ok = false; break; }
  }
  if (obj.record !== PROVENANCE_COMMITMENT_INPUT_ID) { blockers.push('MANIFEST_INVALID'); return none; }
  if (obj.version !== 1) { blockers.push('MANIFEST_VERSION_UNSUPPORTED'); ok = false; }
  if (obj.operation !== OPERATION) { blockers.push('MANIFEST_OPERATION_MISMATCH'); ok = false; }
  if (obj.sourceReplayReport !== REPLAY_REPORT_ID) { blockers.push('MANIFEST_SOURCE_REPORT_MISMATCH'); ok = false; }
  if (asSha256(obj.replayDigest) === undefined) { blockers.push('MANIFEST_REPLAY_DIGEST_INVALID'); ok = false; }
  if (typeof obj.committerDigest !== 'string') { blockers.push('MANIFEST_COMMITTER_DIGEST_INVALID'); ok = false; }
  if (typeof obj.committedAtUtc !== 'string') { blockers.push('MANIFEST_COMMITTED_AT_INVALID'); ok = false; }

  const fields = asObject(obj.fields);
  const fieldKeys = Object.keys(fields);
  if (fieldKeys.length !== MANIFEST_FIELDS.length || !MANIFEST_FIELDS.every((f) => fieldKeys.includes(f))) {
    blockers.push('MANIFEST_FIELDS_INVALID'); return none;
  }
  for (const f of MANIFEST_FIELDS) {
    if (typeof fields[f] === 'string' && FIELD_STATES.includes(fields[f] as string)) continue;
    blockers.push('MANIFEST_FIELD_STATE_INVALID'); ok = false;
  }

  // The source-record list.
  const raw = obj.sourceRecords;
  if (!Array.isArray(raw)) { blockers.push('MANIFEST_SOURCE_RECORDS_INVALID'); return { ok: false, obj, entries: [], entriesOk: false }; }
  let entriesOk = true;
  if (raw.length !== COMMITTED_PHASES.length) { blockers.push('MANIFEST_SOURCE_RECORD_COUNT_INVALID'); entriesOk = false; ok = false; }

  const entries: ProvenanceSourceRecordEntry[] = [];
  for (const item of raw) {
    const e = asObject(item);
    const keysOk = item !== null && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(e).every((k) => SOURCE_RECORD_KEYS.includes(k))
      && SOURCE_RECORD_KEYS.every((k) => k in e);
    const phaseOk = typeof e.phase === 'number' && Number.isInteger(e.phase);
    const reportOk = asSha256(e.reportDigest) !== undefined;
    if (!keysOk || !phaseOk || !reportOk) { blockers.push('MANIFEST_SOURCE_RECORD_ENTRY_INVALID'); entriesOk = false; ok = false; continue; }
    const contentOk = asSha256(e.contentDigest) !== undefined || e.contentDigest === PLACEHOLDER;
    if (!contentOk) { blockers.push('MANIFEST_SOURCE_RECORD_CONTENT_DIGEST_INVALID'); entriesOk = false; ok = false; continue; }
    entries.push({ phase: e.phase as number, reportDigest: e.reportDigest as string, contentDigest: e.contentDigest as string });
  }

  // Duplication, ordering and phase-set membership are separate, separately-reported failures.
  const seen = new Set<number>();
  let duplicated = false;
  for (const e of entries) { if (seen.has(e.phase)) duplicated = true; seen.add(e.phase); }
  if (duplicated) { blockers.push('MANIFEST_SOURCE_RECORD_DUPLICATED'); entriesOk = false; ok = false; }

  let ascending = true;
  for (let i = 1; i < entries.length; i++) if (entries[i]!.phase <= entries[i - 1]!.phase) ascending = false;
  if (!ascending && !duplicated) { blockers.push('MANIFEST_SOURCE_RECORD_OUT_OF_ORDER'); entriesOk = false; ok = false; }

  if (!COMMITTED_PHASES.every((p) => seen.has(p)) || ![...seen].every((p) => COMMITTED_PHASES.includes(p))) {
    blockers.push('MANIFEST_SOURCE_RECORD_PHASE_INVALID'); entriesOk = false; ok = false;
  }

  return { ok, obj, entries, entriesOk };
}

// A digest over exactly what was committed, in phase order. Redaction-safe by construction: it publishes a
// hash, never the content digests themselves, and a later verifier can recompute it from the manifest.
//
// EXPORTED because Phase 238 recomputes it from the supplied manifest to prove the manifest it was handed is
// the one this report committed to. Exporting rather than reimplementing keeps a single rule: there is no
// second copy of the triple-hashing convention that could drift from this one.
export function computeSourceCommitmentDigest(entries: readonly ProvenanceSourceRecordEntry[]): string {
  const ordered = [...entries].sort((a, b) => a.phase - b.phase)
    .map((e) => `${e.phase}:${e.reportDigest}:${e.contentDigest}`).join('|');
  return digest('phase-237-source-record-commitment', ordered);
}

function screamingSnake(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function asSha256(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}
function isLiveSurface(value: string): boolean {
  return /jellyfin|https?:\/\/|wss?:\/\/|x-emby|library\/refresh|\/mnt\//i.test(value);
}
function pathBearing(value: string): boolean {
  return /^\//.test(value) || /[A-Za-z]:[\\/]/.test(value) || /\/mnt\//.test(value) || /\\mnt\\/.test(value)
    || value.includes('catalog-authority-test-library') || /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i.test(value);
}
// Flag any string anywhere in the supplied manifest that names a live/network/media surface or a raw path.
// Traverses ITERATIVELY (explicit stack) with a visited set, so it terminates on any input: a pathologically
// deep manifest cannot overflow the stack and a cyclic/shared-reference manifest cannot loop forever. Skipping
// an already-visited node is safe (its subtree was fully evaluated on first visit); the result is deterministic
// and a live surface buried at any depth still fails closed.
function deepLiveSurface(root: unknown): boolean {
  const stack: unknown[] = [root];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') { if (value.length > 0 && (isLiveSurface(value) || pathBearing(value))) return true; continue; }
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) { for (const v of value) stack.push(v); continue; }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isLiveSurface(k) || pathBearing(k)) return true;
      stack.push(v);
    }
  }
  return false;
}
// Raw-path markers only, for scanning GENERATED reports. See the note in validateReplayReport.
const RAW_PATH_MARKERS: readonly string[] = ['/mnt/', '\\mnt\\', '/media/Movies', 'user/media', 'catalog-authority-test-library'];
function hasRawPathMarker(value: string): boolean {
  return RAW_PATH_MARKERS.some((m) => value.includes(m));
}
// Same iterative, cycle-safe traversal as deepLiveSurface, with the narrower predicate. Keys are scanned too.
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
