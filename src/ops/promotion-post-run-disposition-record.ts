import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';

// Phase 234: local, non-live POST-RUN DISPOSITION REVIEW RECORD validator. It consumes the Phase 233 post-run
// observation record (which must be a genuine, RECORDED observation) and validates a SEPARATELY SUPPLIED human
// REVIEW of that observation -- the disposition: accept the outcome, reject it, or leave it undecided.
//
// It is fail-closed and it REVIEWS NOTHING ITSELF. `reviewedByThisTool`, `performedByThisTool`,
// `capturedByThisTool` and `selfAuthorized` are the constants false: this validator forms no judgement, runs
// nothing, captures nothing, and remediates nothing. It only checks a record a human produced out-of-band.
//
// THE OUTCOME THAT MATTERS MOST HERE is POST_RUN_DISPOSITION_NOT_REVIEWABLE, which is deliberately distinct
// from INVALID:
//   * NOT_REVIEWABLE = the CHAIN has nothing to review. The upstream observation is absent, not genuine, or
//     not RECORDED, so no disposition over it can mean anything.
//   * INVALID = the chain is reviewable but the SUPPLIED DISPOSITION RECORD is broken.
// NOT_REVIEWABLE takes PRECEDENCE over everything: when the observation is not reviewable the overall verdict
// is NOT_REVIEWABLE no matter what the disposition claims. That is what locks the actual prepared P227-A
// chain, which remains unauthorized, unrun and unobserved -- it can never land anywhere else.
//
// THE HEADLINE COHERENCE INVARIANT is the unwithdrawn-failure rule: a FAILED run may only be ACCEPTED once its
// withdrawal is PROVEN upstream (Phase 233 `withdrawalProven`). Accepting a failed run that was never provably
// withdrawn would bless leftover residue in the real library, so it fails closed with
// DISPOSITION_ACCEPTS_UNWITHDRAWN_FAILURE.
//
// A self-digest is NOT a signature -- anyone can recompute one. So the semantic checks on the upstream
// observation are not redundant behind the digest check: a forged observation that rebuilds its own digest
// cleanly walks straight into them, and they are the only thing standing between a fabricated "already
// reviewed / already performed" observation and an accepted disposition.
//
// The emitted report is redaction-safe: chain digests, fixed codes, closed enum states and booleans only --
// never a raw path, raw item id, raw approval id, or reviewer identity.

const OBSERVATION_REPORT_ID = 'phase-233-promotion-post-run-observation-record';
const OPERATION = 'promote-observe-withdraw';

export const POST_RUN_DISPOSITION_INPUT_ID = 'phase-234-promotion-post-run-disposition-record-input';

export type ReviewedOutcome = 'COMPLETED' | 'FAILED';
export type ReviewedWithdrawal = 'NOT_REQUIRED' | 'PENDING' | 'PERFORMED' | 'REFUSED';
export type DispositionFieldState = 'PENDING' | 'AFFIRMED' | 'REFUSED';
export type RecordedDisposition = 'ACCEPTED' | 'REJECTED' | 'PENDING';

// A RECORDED Phase 233 observation is by construction COMPLETED or FAILED (NOT_RUN maps to PENDING there).
const REVIEWED_OUTCOMES: readonly string[] = ['COMPLETED', 'FAILED'];
const REVIEWED_WITHDRAWALS: readonly string[] = ['NOT_REQUIRED', 'PENDING', 'PERFORMED', 'REFUSED'];
const FIELD_STATES: readonly string[] = ['PENDING', 'AFFIRMED', 'REFUSED'];

// `outcomeAccepted` carries the decision itself: AFFIRMED -> ACCEPTED, REFUSED -> REJECTED, PENDING -> PENDING.
// One source of truth, so a record can never state a decision that contradicts its own fields.
const DECISION_FIELD = 'outcomeAccepted';
// The review a human must actually have done before accepting.
const REVIEW_FIELDS: readonly string[] = ['observedOutcomeReviewed', 'preexistingIntegrityConfirmed', 'evidenceRetainedOutOfBand'];
// This phase reviews records and performs NO remediation, so this must stay PENDING in every valid record.
const REMEDIATION_FIELD = 'remediationPerformed';
const DISPOSITION_FIELDS: readonly string[] = [DECISION_FIELD, ...REVIEW_FIELDS, REMEDIATION_FIELD];

const OPERATION_DIGEST_FIELDS: readonly string[] = ['approvalIdDigest', 'itemDigest', 'sourceDigest', 'destinationDigest', 'planDigest'];
// disposition field -> the Phase 233 boundDigests key it must equal.
const OPERATION_BINDING_KEYS: Readonly<Record<string, string>> = {
  approvalIdDigest: 'operation-approval-id',
  itemDigest: 'operation-item',
  sourceDigest: 'operation-source',
  destinationDigest: 'operation-destination',
  planDigest: 'operation-plan',
};
// Every binding the Phase 233 report must itself carry before it can be reviewed at all.
const OBSERVATION_BINDING_KEYS: readonly string[] = ['authorization-record', ...Object.values(OPERATION_BINDING_KEYS)];

// Strict top-level allowlist: anything else is smuggled content and fails closed.
const DISPOSITION_KEYS: readonly string[] = [
  'record', 'version', 'operation', 'sourceObservationRecord', 'observationDigest',
  ...OPERATION_DIGEST_FIELDS, 'reviewedOutcome', 'reviewedWithdrawal', 'fields', 'reviewerDigest', 'reviewedAtUtc',
];

export interface PostRunDispositionInput {
  readonly observationRecord?: unknown;  // phase-233-promotion-post-run-observation-record report
  readonly disposition?: unknown;        // the separately supplied human review record
}

// The record a human completes when reviewing the run. Digest-only: no path, no id, no reviewer identity.
export interface PostRunDispositionSkeleton {
  readonly record: typeof POST_RUN_DISPOSITION_INPUT_ID;
  readonly version: 1;
  readonly operation: typeof OPERATION;
  readonly sourceObservationRecord: typeof OBSERVATION_REPORT_ID;
  readonly observationDigest: string;
  readonly approvalIdDigest: string;
  readonly itemDigest: string;
  readonly sourceDigest: string;
  readonly destinationDigest: string;
  readonly planDigest: string;
  readonly reviewedOutcome: ReviewedOutcome;
  readonly reviewedWithdrawal: ReviewedWithdrawal;
  readonly fields: Readonly<Record<string, DispositionFieldState>>;
  readonly reviewerDigest: string;
  readonly reviewedAtUtc: string;
}

export const POST_RUN_DISPOSITION_REMAINING_HUMAN_STEPS: readonly string[] = [
  'The review itself -- reading the observation and the out-of-band evidence -- which a human does, not this validator.',
  'Any remediation, re-run, or withdrawal arising from a rejected disposition: a human operator step, NOT performed or triggered here.',
  'Independent confirmation that the retained out-of-band evidence matches these exact chain digests.',
  'Closure of the operation after disposition, recorded out-of-band under a separate record.',
];

export const POST_RUN_DISPOSITION_BOUNDARY =
  'No promotion launcher run, no withdrawal run, no remediation, no observed-state capture, no real Movies library read or write, no live Jellyfin call, no secret approval-file read, and no self-authorization: this validator only checks a separately supplied human disposition against the Phase 233 observation record.';

export const POST_RUN_DISPOSITION_DISCLAIMERS: readonly string[] = [
  'This validator reviews nothing: it forms no judgement, performs no run or remediation, and captures no state; it only checks a record a human produced separately.',
  'POST_RUN_DISPOSITION_NOT_REVIEWABLE means the chain itself has nothing to review -- it is NOT a defect in the supplied disposition, and no disposition can override it.',
  'POST_RUN_DISPOSITION_ACCEPTED means only that a well-formed, chain-bound, coherent human acceptance exists -- it is not itself evidence that the run was sound.',
  'A FAILED run may only be accepted once its withdrawal is proven upstream; accepting an unwithdrawn failure fails closed.',
  'It never creates, infers, completes, or upgrades a disposition, and it never remediates anything.',
  'It never runs the promotion launcher, reads or writes the real Movies library, contacts Jellyfin, or reads the secret approval file.',
];

export interface PostRunDispositionReport {
  readonly report: 'phase-234-promotion-post-run-disposition-record';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly reviewedByThisTool: false;
  readonly performedByThisTool: false;
  readonly capturedByThisTool: false;
  readonly selfAuthorized: false;
  readonly overall:
    | 'POST_RUN_DISPOSITION_ACCEPTED'
    | 'POST_RUN_DISPOSITION_REJECTED'
    | 'POST_RUN_DISPOSITION_PENDING'
    | 'POST_RUN_DISPOSITION_NOT_REVIEWABLE'
    | 'POST_RUN_DISPOSITION_INVALID';
  readonly recordedDisposition: RecordedDisposition | 'NONE';
  readonly dispositionAccepted: boolean;
  readonly observationReviewable: boolean;
  readonly dispositionWellFormed: boolean;
  readonly dispositionRedactionSafe: boolean;
  readonly dispositionBound: boolean;
  readonly dispositionCoherent: boolean;
  readonly reviewedOutcome: ReviewedOutcome | 'NONE';
  readonly reviewedWithdrawal: ReviewedWithdrawal | 'NONE';
  readonly withdrawalProvenUpstream: boolean;
  readonly boundDigests: Readonly<Record<string, string>>;
  readonly fieldStates: Readonly<Record<string, DispositionFieldState>>;
  readonly remainingHumanSteps: readonly string[];
  readonly boundary: string;
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly dispositionDigest: string;
}

export function buildPostRunDispositionRecord(input: PostRunDispositionInput): PostRunDispositionReport {
  const blockers: string[] = [];
  const boundDigests: Record<string, string> = {};

  // (1) The Phase 233 observation: genuine, RECORDED, and having performed/captured nothing itself. Anything
  //     wrong here means the CHAIN has nothing to review -- NOT_REVIEWABLE, never INVALID.
  const obs = validateObservationRecord(input.observationRecord, blockers);
  const observationReviewable = obs.ok;
  if (observationReviewable) boundDigests['observation-record'] = obs.observationDigest!;

  // (2) The human disposition: present, single, strictly allowlisted, closed enums.
  const disp = validateDispositionShape(input.disposition, blockers);
  const dispositionWellFormed = disp.ok;

  // (3) Redaction: scan the WHOLE supplied value, not just the allowlisted keys.
  const dispositionRedactionSafe = input.disposition === undefined ? false : !deepLiveSurface(input.disposition);
  if (input.disposition !== undefined && !dispositionRedactionSafe) blockers.push('DISPOSITION_LIVE_SURFACE');

  // (4) The chain binding: the disposition names the observation by its own observationDigest AND carries each
  //     of the five operation digests that record bound. Same transplantation defence as Phase 232/233: a
  //     review of one operation cannot be replayed against a different observation.
  let dispositionBound = false;
  if (observationReviewable && dispositionWellFormed) {
    const bindsObservation = disp.obj.observationDigest === obs.observationDigest;
    if (!bindsObservation) blockers.push('DISPOSITION_NOT_BOUND_TO_OBSERVATION');
    let digestsMatch = true;
    for (const f of OPERATION_DIGEST_FIELDS) {
      if (asSha256(disp.obj[f]) !== undefined && disp.obj[f] === obs.bindings[OPERATION_BINDING_KEYS[f]!]) continue;
      digestsMatch = false;
      blockers.push(`DISPOSITION_${screamingSnake(f)}_MISMATCH`);
    }
    dispositionBound = bindsObservation && digestsMatch;
    if (dispositionBound) {
      for (const f of OPERATION_DIGEST_FIELDS) boundDigests[OPERATION_BINDING_KEYS[f]!] = asString(disp.obj[f])!;
    }
  }

  // (5) Coherence: the decision, the review that backs it, and what was actually observed upstream.
  let dispositionCoherent = false;
  let decision: RecordedDisposition | 'NONE' = 'NONE';
  const fieldStates: Record<string, DispositionFieldState> = {};
  if (dispositionWellFormed) {
    const fields = asObject(disp.obj.fields);
    for (const f of DISPOSITION_FIELDS) fieldStates[f] = fields[f] as DispositionFieldState;

    // Invariant, independent of decision: this phase remediates nothing, so no record may claim it did.
    let remediationClean = true;
    if (fieldStates[REMEDIATION_FIELD] !== 'PENDING') { blockers.push('DISPOSITION_REMEDIATION_CLAIMED'); remediationClean = false; }

    // The decision IS `outcomeAccepted`, so it can never contradict the record's own fields.
    const accepted = fieldStates[DECISION_FIELD];
    decision = accepted === 'AFFIRMED' ? 'ACCEPTED' : accepted === 'REFUSED' ? 'REJECTED' : 'PENDING';

    let decisionBacked = true;
    if (decision === 'ACCEPTED') {
      // Accepting means every part of the review was actually done.
      if (!REVIEW_FIELDS.every((f) => fieldStates[f] === 'AFFIRMED')) {
        blockers.push('DISPOSITION_ACCEPTED_WITHOUT_FULL_REVIEW'); decisionBacked = false;
      }
    } else if (decision === 'REJECTED') {
      // You must have reviewed the outcome to reject it; a blind rejection is not a review.
      if (fieldStates.observedOutcomeReviewed !== 'AFFIRMED') {
        blockers.push('DISPOSITION_REJECTED_WITHOUT_REVIEW'); decisionBacked = false;
      }
    }

    // A decided disposition names WHO reviewed (by digest) and WHEN; an undecided one claims neither.
    const decided = decision !== 'PENDING';
    const reviewerOk = decided ? asSha256(disp.obj.reviewerDigest) !== undefined : disp.obj.reviewerDigest === 'PENDING';
    if (!reviewerOk) blockers.push(decided ? 'DISPOSITION_REVIEWER_DIGEST_REQUIRED' : 'DISPOSITION_REVIEWER_DIGEST_NOT_PENDING');
    const reviewedAtOk = decided ? isUtcTimestamp(disp.obj.reviewedAtUtc) : disp.obj.reviewedAtUtc === 'PENDING';
    if (!reviewedAtOk) blockers.push(decided ? 'DISPOSITION_REVIEWED_AT_REQUIRED' : 'DISPOSITION_REVIEWED_AT_NOT_PENDING');

    // Cross-record coherence: you must be reviewing the outcome that was actually observed, and -- THE
    // HEADLINE INVARIANT -- a FAILED run may only be accepted once its withdrawal is proven upstream.
    let matchesObservation = true;
    if (observationReviewable) {
      if (disp.obj.reviewedOutcome !== obs.recordedOutcome) { blockers.push('DISPOSITION_REVIEWED_OUTCOME_MISMATCH'); matchesObservation = false; }
      if (disp.obj.reviewedWithdrawal !== obs.recordedWithdrawal) { blockers.push('DISPOSITION_REVIEWED_WITHDRAWAL_MISMATCH'); matchesObservation = false; }
      if (decision === 'ACCEPTED' && obs.recordedOutcome === 'FAILED' && obs.withdrawalProven !== true) {
        blockers.push('DISPOSITION_ACCEPTS_UNWITHDRAWN_FAILURE'); matchesObservation = false;
      }
    }

    dispositionCoherent = remediationClean && decisionBacked && reviewerOk && reviewedAtOk && matchesObservation;
  }

  const uniqueBlockers = [...new Set(blockers)];
  // When the observation is reviewable, every remaining blocker is disposition-side by construction.
  const dispositionSound = uniqueBlockers.length === 0
    && dispositionWellFormed && dispositionRedactionSafe && dispositionBound && dispositionCoherent;

  // NOT_REVIEWABLE takes precedence over everything: an unreviewable chain cannot be dispositioned at all.
  const overall: PostRunDispositionReport['overall'] =
    !observationReviewable ? 'POST_RUN_DISPOSITION_NOT_REVIEWABLE'
      : !dispositionSound ? 'POST_RUN_DISPOSITION_INVALID'
        : decision === 'ACCEPTED' ? 'POST_RUN_DISPOSITION_ACCEPTED'
          : decision === 'REJECTED' ? 'POST_RUN_DISPOSITION_REJECTED'
            : 'POST_RUN_DISPOSITION_PENDING';
  const settled = overall === 'POST_RUN_DISPOSITION_ACCEPTED' || overall === 'POST_RUN_DISPOSITION_REJECTED'
    || overall === 'POST_RUN_DISPOSITION_PENDING';

  const withoutDigest: Omit<PostRunDispositionReport, 'dispositionDigest'> = {
    report: 'phase-234-promotion-post-run-disposition-record',
    version: 1,
    redactionSafe: true,
    reviewedByThisTool: false,
    performedByThisTool: false,
    capturedByThisTool: false,
    selfAuthorized: false,
    overall,
    recordedDisposition: settled ? decision : 'NONE',
    dispositionAccepted: overall === 'POST_RUN_DISPOSITION_ACCEPTED',
    observationReviewable,
    dispositionWellFormed,
    dispositionRedactionSafe,
    dispositionBound,
    dispositionCoherent,
    reviewedOutcome: settled ? disp.obj.reviewedOutcome as ReviewedOutcome : 'NONE',
    reviewedWithdrawal: settled ? disp.obj.reviewedWithdrawal as ReviewedWithdrawal : 'NONE',
    withdrawalProvenUpstream: observationReviewable && obs.withdrawalProven === true,
    boundDigests,
    fieldStates,
    remainingHumanSteps: POST_RUN_DISPOSITION_REMAINING_HUMAN_STEPS,
    boundary: POST_RUN_DISPOSITION_BOUNDARY,
    blockers: uniqueBlockers,
    disclaimers: POST_RUN_DISPOSITION_DISCLAIMERS,
  };
  return { ...withoutDigest, dispositionDigest: digest('phase-234-post-run-disposition-record', JSON.stringify(withoutDigest)) };
}

// Emit the blank disposition a human completes, bound to this observation's one operation. EVERY field is
// PENDING -- nothing is pre-affirmed, so a human who signs it blind asserts nothing. Returns null when the
// observation is not reviewable (fail closed).
//
// `reviewedOutcome` / `reviewedWithdrawal` ARE pre-filled, and deliberately so: they are derived bindings
// copied from the upstream record (exactly like the digests), naming WHAT is under review, not a judgement
// about it. The judgement lives entirely in the all-PENDING `fields`.
export function buildPostRunDispositionSkeleton(observationValue: unknown): PostRunDispositionSkeleton | null {
  const obs = validateObservationRecord(observationValue, []);
  if (!obs.ok) return null;
  const fields: Record<string, DispositionFieldState> = {};
  for (const f of DISPOSITION_FIELDS) fields[f] = 'PENDING';
  return {
    record: POST_RUN_DISPOSITION_INPUT_ID,
    version: 1,
    operation: OPERATION,
    sourceObservationRecord: OBSERVATION_REPORT_ID,
    observationDigest: obs.observationDigest!,
    approvalIdDigest: obs.bindings['operation-approval-id']!,
    itemDigest: obs.bindings['operation-item']!,
    sourceDigest: obs.bindings['operation-source']!,
    destinationDigest: obs.bindings['operation-destination']!,
    planDigest: obs.bindings['operation-plan']!,
    reviewedOutcome: obs.recordedOutcome as ReviewedOutcome,
    reviewedWithdrawal: obs.recordedWithdrawal as ReviewedWithdrawal,
    fields,
    reviewerDigest: 'PENDING',
    reviewedAtUtc: 'PENDING',
  };
}

interface ValidatedObservation {
  readonly ok: boolean;
  readonly observationDigest: string | undefined;
  readonly recordedOutcome: string | undefined;
  readonly recordedWithdrawal: string | undefined;
  readonly withdrawalProven: boolean | undefined;
  readonly bindings: Readonly<Record<string, string | undefined>>;
}

// The observation must be the genuine Phase 233 report: it recomputes, it is RECORDED, it still claims to have
// performed/captured/authorized nothing itself, its outcome and withdrawal are closed-enum values, and it
// carries all six chain bindings. EVERY failure here is a NOT_REVIEWABLE chain, not an INVALID disposition.
//
// These semantic checks are NOT unreachable behind the digest check: a self-digest is not a signature, so a
// forger who rebuilds it reaches them, and they are the only thing that stops a fabricated observation.
function validateObservationRecord(value: unknown, blockers: string[]): ValidatedObservation {
  const none: ValidatedObservation = {
    ok: false, observationDigest: undefined, recordedOutcome: undefined,
    recordedWithdrawal: undefined, withdrawalProven: undefined, bindings: {},
  };
  if (value === undefined) { blockers.push('OBSERVATION_RECORD_MISSING'); return none; }
  const obj = asObject(value);
  if (obj.report !== OBSERVATION_REPORT_ID) { blockers.push('OBSERVATION_RECORD_INVALID'); return none; }

  const stated = asSha256(obj.observationDigest);
  if (stated === undefined || verifySelfDigests([obj]).results[0]?.verified !== true) {
    blockers.push('OBSERVATION_RECORD_DIGEST_MISMATCH'); return none;
  }
  let ok = true;
  if (obj.overall !== 'POST_RUN_OBSERVATION_RECORDED') { blockers.push('OBSERVATION_RECORD_NOT_RECORDED'); ok = false; }
  if (obj.observationRecorded !== true) { blockers.push('OBSERVATION_RECORD_NOT_MARKED_RECORDED'); ok = false; }
  // The observation record must itself still be a record only -- it may never claim to have acted.
  if (obj.performedByThisTool !== false) { blockers.push('OBSERVATION_RECORD_PERFORMED_CLAIMED'); ok = false; }
  if (obj.capturedByThisTool !== false) { blockers.push('OBSERVATION_RECORD_CAPTURED_CLAIMED'); ok = false; }
  if (obj.selfAuthorized !== false) { blockers.push('OBSERVATION_RECORD_SELF_AUTHORIZED'); ok = false; }

  const outcome = typeof obj.recordedOutcome === 'string' ? obj.recordedOutcome : undefined;
  if (outcome === undefined || !REVIEWED_OUTCOMES.includes(outcome)) { blockers.push('OBSERVATION_RECORD_OUTCOME_INVALID'); ok = false; }
  const withdrawal = typeof obj.recordedWithdrawal === 'string' ? obj.recordedWithdrawal : undefined;
  if (withdrawal === undefined || !REVIEWED_WITHDRAWALS.includes(withdrawal)) { blockers.push('OBSERVATION_RECORD_WITHDRAWAL_INVALID'); ok = false; }
  if (typeof obj.withdrawalProven !== 'boolean') { blockers.push('OBSERVATION_RECORD_WITHDRAWAL_PROVEN_INVALID'); ok = false; }

  const bound = asObject(obj.boundDigests);
  const bindings: Record<string, string | undefined> = {};
  for (const k of OBSERVATION_BINDING_KEYS) {
    bindings[k] = asSha256(bound[k]);
    if (bindings[k] === undefined) { blockers.push('OBSERVATION_RECORD_BINDINGS_INCOMPLETE'); ok = false; }
  }
  return ok
    ? { ok: true, observationDigest: stated, recordedOutcome: outcome, recordedWithdrawal: withdrawal, withdrawalProven: obj.withdrawalProven as boolean, bindings }
    : none;
}

interface ValidatedDisposition { readonly ok: boolean; readonly obj: Record<string, unknown>; }

// Strict shape: one object, only the allowlisted keys, all fixed literals correct, echo fields and every field
// state from the closed enums.
function validateDispositionShape(value: unknown, blockers: string[]): ValidatedDisposition {
  const none: ValidatedDisposition = { ok: false, obj: {} };
  if (value === undefined) { blockers.push('DISPOSITION_MISSING'); return none; }
  if (Array.isArray(value)) { blockers.push('DISPOSITION_NOT_SINGLE'); return none; }
  if (!value || typeof value !== 'object') { blockers.push('DISPOSITION_INVALID'); return none; }
  const obj = value as Record<string, unknown>;

  let ok = true;
  for (const k of Object.keys(obj)) {
    if (!DISPOSITION_KEYS.includes(k)) { blockers.push('DISPOSITION_UNKNOWN_FIELD'); ok = false; break; }
  }
  if (obj.record !== POST_RUN_DISPOSITION_INPUT_ID) { blockers.push('DISPOSITION_INVALID'); return none; }
  if (obj.version !== 1) { blockers.push('DISPOSITION_VERSION_UNSUPPORTED'); ok = false; }
  if (obj.operation !== OPERATION) { blockers.push('DISPOSITION_OPERATION_MISMATCH'); ok = false; }
  if (obj.sourceObservationRecord !== OBSERVATION_REPORT_ID) { blockers.push('DISPOSITION_SOURCE_RECORD_MISMATCH'); ok = false; }
  if (asSha256(obj.observationDigest) === undefined) { blockers.push('DISPOSITION_OBSERVATION_DIGEST_INVALID'); ok = false; }
  if (typeof obj.reviewedOutcome !== 'string' || !REVIEWED_OUTCOMES.includes(obj.reviewedOutcome)) { blockers.push('DISPOSITION_REVIEWED_OUTCOME_INVALID'); return none; }
  if (typeof obj.reviewedWithdrawal !== 'string' || !REVIEWED_WITHDRAWALS.includes(obj.reviewedWithdrawal)) { blockers.push('DISPOSITION_REVIEWED_WITHDRAWAL_INVALID'); return none; }
  if (typeof obj.reviewerDigest !== 'string') { blockers.push('DISPOSITION_REVIEWER_DIGEST_INVALID'); ok = false; }
  if (typeof obj.reviewedAtUtc !== 'string') { blockers.push('DISPOSITION_REVIEWED_AT_INVALID'); ok = false; }

  const fields = asObject(obj.fields);
  const fieldKeys = Object.keys(fields);
  if (fieldKeys.length !== DISPOSITION_FIELDS.length || !DISPOSITION_FIELDS.every((f) => fieldKeys.includes(f))) {
    blockers.push('DISPOSITION_FIELDS_INVALID'); return none;
  }
  for (const f of DISPOSITION_FIELDS) {
    if (typeof fields[f] === 'string' && FIELD_STATES.includes(fields[f] as string)) continue;
    blockers.push('DISPOSITION_FIELD_STATE_INVALID'); ok = false;
  }
  return ok ? { ok: true, obj } : none;
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
function isUtcTimestamp(value: unknown): boolean {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}
function isLiveSurface(value: string): boolean {
  return /jellyfin|https?:\/\/|wss?:\/\/|x-emby|library\/refresh|\/mnt\//i.test(value);
}
function pathBearing(value: string): boolean {
  return /^\//.test(value) || /[A-Za-z]:[\\/]/.test(value) || /\/mnt\//.test(value) || /\\mnt\\/.test(value)
    || value.includes('catalog-authority-test-library') || /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i.test(value);
}
// Flag any string anywhere in the supplied disposition that names a live/network/media surface or a raw path.
// Traverses ITERATIVELY (explicit stack) with a visited set, so it terminates on any input: a pathologically
// deep record cannot overflow the stack and a cyclic/shared-reference record cannot loop forever. Skipping an
// already-visited node is safe (its subtree was fully evaluated on first visit); the result is deterministic
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
    for (const v of Object.values(value as Record<string, unknown>)) stack.push(v);
  }
  return false;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
