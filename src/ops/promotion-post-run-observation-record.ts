import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';

// Phase 233: local, non-live POST-RUN OBSERVATION AND WITHDRAWAL RECORD validator. It consumes the Phase 232
// human execution-authorization record (which must be a valid, digest-bound APPROVED record) and validates a
// SEPARATELY SUPPLIED, human-produced observation of what actually happened for that one
// promote -> observe -> withdraw operation.
//
// It is fail-closed and it OBSERVES NOTHING ITSELF. `performedByThisTool` and `capturedByThisTool` are the
// constants false: this validator never runs the promotion, never captures observed state, never performs or
// triggers a withdrawal, and never reads the real Movies library, Jellyfin, or the secret approval file. It
// only checks a record a human produced out-of-band, and it creates or infers no claim of its own.
//
// An observation can only exist for a run that was PROVABLY AUTHORIZED for exactly this one operation: the
// Phase 232 record must self-verify, be EXECUTION_AUTHORIZATION_RECORD_APPROVED, have authorized nothing
// beyond the record itself (execution NOT_PERFORMED, capturedArtifacts NONE, selfAuthorized false), and carry
// all six chain bindings. The observation then binds to that record's own `recordDigest` AND to each of the
// five operation digests it carries -- the same record-transplantation defence as Phase 232, so an
// observation of one operation cannot be replayed against a different authorization.
//
// THE headline invariant is the withdrawal proof: `withdrawal: PERFORMED` requires
// `observedStateAfterWithdrawalDigest` to equal `observedStateBeforeDigest`. A withdrawal is only proven when
// the observed state returned to EXACTLY what it was before the run; anything else is
// WITHDRAWAL_DID_NOT_RESTORE_OBSERVED_STATE and fails closed. Preexisting content is protected in the same
// breath: the record must assert that preexisting content was preserved and that only run-created
// materialization was withdrawn.
//
// The emitted report is redaction-safe: digests of the authorization chain, fixed codes, closed enum states,
// booleans and presence markers only -- never a raw path, raw item id, raw approval id, observer identity, or
// the human's own observed-state digests.

const AUTHORIZATION_REPORT_ID = 'phase-232-promotion-execution-authorization-record';
const OPERATION = 'promote-observe-withdraw';

export const POST_RUN_OBSERVATION_INPUT_ID = 'phase-233-promotion-post-run-observation-record-input';

export type ObservedRunOutcome = 'NOT_RUN' | 'COMPLETED' | 'FAILED';
export type ObservedWithdrawal = 'NOT_REQUIRED' | 'PENDING' | 'PERFORMED' | 'REFUSED';
export type ObservedStatePresence = 'PENDING' | 'PRESENT';

const OUTCOMES: readonly string[] = ['NOT_RUN', 'COMPLETED', 'FAILED'];
const WITHDRAWALS: readonly string[] = ['NOT_REQUIRED', 'PENDING', 'PERFORMED', 'REFUSED'];

// Observed state is carried ONLY as digests: each is a sha256 or the literal PENDING placeholder.
const STATE_DIGEST_FIELDS: readonly string[] = ['observedStateBeforeDigest', 'observedStateAfterDigest', 'observedStateAfterWithdrawalDigest'];
// The human's ACTIVE assertions that the run/withdrawal stayed inside the approved blast radius: `true`,
// `false`, or the PENDING placeholder. They are never pre-affirmed by anything this module emits.
const ASSERTION_FIELDS: readonly string[] = ['preexistingPreserved', 'withdrewOnlyRunCreatedMaterialization'];
// The five operation digests, each equal to the Phase 232 record's corresponding binding.
const OPERATION_DIGEST_FIELDS: readonly string[] = ['approvalIdDigest', 'itemDigest', 'sourceDigest', 'destinationDigest', 'planDigest'];
// observation field -> the Phase 232 boundDigests key it must equal.
const OPERATION_BINDING_KEYS: Readonly<Record<string, string>> = {
  approvalIdDigest: 'operation-approval-id',
  itemDigest: 'operation-item',
  sourceDigest: 'operation-source',
  destinationDigest: 'operation-destination',
  planDigest: 'operation-plan',
};
const AUTHORIZATION_BINDING_KEYS: readonly string[] = ['gate-authorization', ...Object.values(OPERATION_BINDING_KEYS)];

// Strict top-level allowlist: anything else is smuggled content and fails closed.
const OBSERVATION_KEYS: readonly string[] = [
  'record', 'version', 'operation', 'sourceAuthorizationRecord', 'recordDigest',
  ...OPERATION_DIGEST_FIELDS, 'observedRunOutcome', ...STATE_DIGEST_FIELDS, 'withdrawal',
  ...ASSERTION_FIELDS, 'observerDigest', 'observedAtUtc',
];

export interface PostRunObservationInput {
  readonly authorizationRecord?: unknown;  // phase-232-promotion-execution-authorization-record report
  readonly observation?: unknown;          // the separately supplied human observation record
}

// The record a human completes after the run. Digest-only: it names no path, no id, and no observer identity.
export interface PostRunObservationSkeleton {
  readonly record: typeof POST_RUN_OBSERVATION_INPUT_ID;
  readonly version: 1;
  readonly operation: typeof OPERATION;
  readonly sourceAuthorizationRecord: typeof AUTHORIZATION_REPORT_ID;
  readonly recordDigest: string;
  readonly approvalIdDigest: string;
  readonly itemDigest: string;
  readonly sourceDigest: string;
  readonly destinationDigest: string;
  readonly planDigest: string;
  readonly observedRunOutcome: ObservedRunOutcome;
  readonly observedStateBeforeDigest: string;
  readonly observedStateAfterDigest: string;
  readonly observedStateAfterWithdrawalDigest: string;
  readonly withdrawal: ObservedWithdrawal;
  readonly preexistingPreserved: boolean | 'PENDING';
  readonly withdrewOnlyRunCreatedMaterialization: boolean | 'PENDING';
  readonly observerDigest: string;
  readonly observedAtUtc: string;
}

export const POST_RUN_OBSERVATION_REMAINING_HUMAN_STEPS: readonly string[] = [
  'Independent human review of this observation against these exact chain digests.',
  'Any run, re-run, or withdrawal itself -- a human operator step on the server, NOT performed or triggered here.',
  'Capture of the observed-state digests this record cites; this validator captures none of them.',
  'The disposition of the promoted item after observation, recorded out-of-band under a separate record.',
];

export const POST_RUN_OBSERVATION_BOUNDARY =
  'No promotion launcher run, no withdrawal run, no observed-state capture, no real Movies library read or write, no live Jellyfin call, no secret approval-file read, and no self-authorization: this validator only checks a separately supplied human observation against the Phase 232 authorization record.';

export const POST_RUN_OBSERVATION_DISCLAIMERS: readonly string[] = [
  'This validator observes nothing: it performs no run, captures no state, and triggers no withdrawal; it only checks a record a human produced separately.',
  'POST_RUN_OBSERVATION_RECORDED means only that a well-formed, chain-bound, internally coherent human observation exists -- it is not itself evidence that the run occurred.',
  'A withdrawal counts as proven only when the observed state after withdrawal equals the observed state before the run; anything else fails closed.',
  'It never creates, infers, completes, or upgrades an observation, an outcome, or a withdrawal claim.',
  'It never runs the promotion launcher, reads or writes the real Movies library, contacts Jellyfin, or reads the secret approval file.',
];

export interface PostRunObservationReport {
  readonly report: 'phase-233-promotion-post-run-observation-record';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly performedByThisTool: false;
  readonly capturedByThisTool: false;
  readonly selfAuthorized: false;
  readonly overall:
    | 'POST_RUN_OBSERVATION_RECORDED'
    | 'POST_RUN_OBSERVATION_PENDING'
    | 'POST_RUN_OBSERVATION_INVALID';
  readonly recordedOutcome: ObservedRunOutcome | 'NONE';
  readonly recordedWithdrawal: ObservedWithdrawal | 'NONE';
  readonly observationRecorded: boolean;
  readonly withdrawalProven: boolean;
  readonly authorizationValid: boolean;
  readonly observationWellFormed: boolean;
  readonly observationRedactionSafe: boolean;
  readonly observationBound: boolean;
  readonly observationCoherent: boolean;
  readonly boundDigests: Readonly<Record<string, string>>;
  readonly observedStatePresence: Readonly<Record<string, ObservedStatePresence>>;
  readonly remainingHumanSteps: readonly string[];
  readonly boundary: string;
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly observationDigest: string;
}

export function buildPostRunObservationRecord(input: PostRunObservationInput): PostRunObservationReport {
  const blockers: string[] = [];
  const boundDigests: Record<string, string> = {};

  // (1) The Phase 232 authorization record: genuine, APPROVED, and itself having performed nothing. An
  //     observation of a run may only exist where that run was provably authorized for this one operation.
  const auth = validateAuthorizationRecord(input.authorizationRecord, blockers);
  const authorizationValid = auth.ok;
  if (authorizationValid) boundDigests['authorization-record'] = auth.recordDigest!;

  // (2) The human observation: present, single, strictly allowlisted, closed enums, digests-or-PENDING only.
  const obs = validateObservationShape(input.observation, blockers);
  const observationWellFormed = obs.ok;

  // (3) Redaction: a human wrote this after standing in front of the real library, so it is the likeliest
  //     place of all for a raw path to leak in. Scan the WHOLE supplied value, not just allowlisted keys.
  const observationRedactionSafe = input.observation === undefined ? false : !deepLiveSurface(input.observation);
  if (input.observation !== undefined && !observationRedactionSafe) blockers.push('OBSERVATION_LIVE_SURFACE');

  // (4) The chain binding: the observation names the authorization record by its own recordDigest AND carries
  //     each of the five operation digests that record bound. This stops an observation of one operation from
  //     being replayed against a different authorization, item, or re-planned run.
  let observationBound = false;
  if (authorizationValid && observationWellFormed) {
    const bindsRecord = obs.obj.recordDigest === auth.recordDigest;
    if (!bindsRecord) blockers.push('OBSERVATION_NOT_BOUND_TO_AUTHORIZATION');
    let digestsMatch = true;
    for (const f of OPERATION_DIGEST_FIELDS) {
      if (asSha256(obs.obj[f]) !== undefined && obs.obj[f] === auth.bindings[OPERATION_BINDING_KEYS[f]!]) continue;
      digestsMatch = false;
      blockers.push(`OBSERVATION_${screamingSnake(f)}_MISMATCH`);
    }
    observationBound = bindsRecord && digestsMatch;
    if (observationBound) {
      for (const f of OPERATION_DIGEST_FIELDS) boundDigests[OPERATION_BINDING_KEYS[f]!] = asString(obs.obj[f])!;
    }
  }

  // (5) Coherence between the observed outcome, the observed-state digests, and the withdrawal claim.
  let observationCoherent = false;
  let withdrawalRestored = false;
  const observedStatePresence: Record<string, ObservedStatePresence> = {};
  if (observationWellFormed) {
    const before = asSha256(obs.obj.observedStateBeforeDigest);
    const after = asSha256(obs.obj.observedStateAfterDigest);
    const afterWithdrawal = asSha256(obs.obj.observedStateAfterWithdrawalDigest);
    for (const f of STATE_DIGEST_FIELDS) observedStatePresence[f] = asSha256(obs.obj[f]) === undefined ? 'PENDING' : 'PRESENT';

    const outcome = obs.obj.observedRunOutcome as ObservedRunOutcome;
    const withdrawal = obs.obj.withdrawal as ObservedWithdrawal;
    let outcomeCoherent = true;

    if (outcome === 'NOT_RUN') {
      // NOT_RUN is total: nothing was run, so nothing was observed and nothing can have been withdrawn.
      if (before !== undefined || after !== undefined || afterWithdrawal !== undefined) {
        blockers.push('OBSERVATION_NOT_RUN_CLAIMS_OBSERVED_STATE'); outcomeCoherent = false;
      }
      if (withdrawal !== 'NOT_REQUIRED') { blockers.push('OBSERVATION_NOT_RUN_WITHDRAWAL_NOT_NOT_REQUIRED'); outcomeCoherent = false; }
    } else if (outcome === 'COMPLETED') {
      if (before === undefined || after === undefined) { blockers.push('OBSERVATION_COMPLETED_WITHOUT_OBSERVED_STATE'); outcomeCoherent = false; }
      // A promotion that changed nothing observable is not a completed promotion.
      else if (after === before) { blockers.push('OBSERVATION_COMPLETED_WITHOUT_OBSERVED_CHANGE'); outcomeCoherent = false; }
    } else if (before === undefined || after === undefined) {
      // FAILED still requires both observations: what the state was, and what the failed run left behind.
      blockers.push('OBSERVATION_FAILED_WITHOUT_OBSERVED_STATE'); outcomeCoherent = false;
    }

    // The withdrawal proof. PERFORMED is the only claim that may cite an after-withdrawal state, and it holds
    // only when that state is EXACTLY the state observed before the run.
    let withdrawalCoherent = true;
    if (withdrawal === 'PERFORMED') {
      if (outcome === 'NOT_RUN') { withdrawalCoherent = false; }
      else if (afterWithdrawal === undefined || before === undefined || afterWithdrawal !== before) {
        blockers.push('WITHDRAWAL_DID_NOT_RESTORE_OBSERVED_STATE'); withdrawalCoherent = false;
      } else withdrawalRestored = true;
    } else if (afterWithdrawal !== undefined) {
      blockers.push('OBSERVATION_WITHDRAWAL_STATE_WITHOUT_PERFORMED_WITHDRAWAL'); withdrawalCoherent = false;
    }

    const observed = outcome !== 'NOT_RUN';

    // Preexisting content is never in the blast radius, whatever happened. These are ACTIVE assertions a human
    // makes about a run that happened: an observed run requires both affirmed true, and NOT_RUN requires both
    // to stay PENDING. Nothing ran, so there is nothing to assert -- and, crucially, a blank skeleton must
    // never pre-affirm the safety of the real library on a human's behalf.
    let assertionsHeld = true;
    if (observed) {
      if (obs.obj.preexistingPreserved !== true) { blockers.push('OBSERVATION_PREEXISTING_NOT_PRESERVED'); assertionsHeld = false; }
      if (obs.obj.withdrewOnlyRunCreatedMaterialization !== true) { blockers.push('OBSERVATION_WITHDREW_BEYOND_RUN_CREATED_MATERIALIZATION'); assertionsHeld = false; }
    } else if (ASSERTION_FIELDS.some((f) => obs.obj[f] !== 'PENDING')) {
      blockers.push('OBSERVATION_NOT_RUN_ASSERTION_NOT_PENDING'); assertionsHeld = false;
    }

    // An observation of a real run must name WHO observed it (by digest) and WHEN; NOT_RUN claims neither.
    const observerOk = observed ? asSha256(obs.obj.observerDigest) !== undefined : obs.obj.observerDigest === 'PENDING';
    if (!observerOk) blockers.push(observed ? 'OBSERVATION_OBSERVER_DIGEST_REQUIRED' : 'OBSERVATION_OBSERVER_DIGEST_NOT_PENDING');
    const observedAtOk = observed ? isUtcTimestamp(obs.obj.observedAtUtc) : obs.obj.observedAtUtc === 'PENDING';
    if (!observedAtOk) blockers.push(observed ? 'OBSERVATION_OBSERVED_AT_REQUIRED' : 'OBSERVATION_OBSERVED_AT_NOT_PENDING');

    observationCoherent = outcomeCoherent && withdrawalCoherent && assertionsHeld && observerOk && observedAtOk;
  }

  const uniqueBlockers = [...new Set(blockers)];
  const valid = uniqueBlockers.length === 0
    && authorizationValid && observationWellFormed && observationRedactionSafe && observationBound && observationCoherent;
  const recordedOutcome: PostRunObservationReport['recordedOutcome'] = valid ? obs.obj.observedRunOutcome as ObservedRunOutcome : 'NONE';
  const recordedWithdrawal: PostRunObservationReport['recordedWithdrawal'] = valid ? obs.obj.withdrawal as ObservedWithdrawal : 'NONE';
  const overall: PostRunObservationReport['overall'] =
    !valid ? 'POST_RUN_OBSERVATION_INVALID'
      : recordedOutcome === 'NOT_RUN' ? 'POST_RUN_OBSERVATION_PENDING'
        : 'POST_RUN_OBSERVATION_RECORDED';

  const withoutDigest: Omit<PostRunObservationReport, 'observationDigest'> = {
    report: 'phase-233-promotion-post-run-observation-record',
    version: 1,
    redactionSafe: true,
    performedByThisTool: false,
    capturedByThisTool: false,
    selfAuthorized: false,
    overall,
    recordedOutcome,
    recordedWithdrawal,
    observationRecorded: overall === 'POST_RUN_OBSERVATION_RECORDED',
    withdrawalProven: valid && withdrawalRestored,
    authorizationValid,
    observationWellFormed,
    observationRedactionSafe,
    observationBound,
    observationCoherent,
    boundDigests,
    observedStatePresence,
    remainingHumanSteps: POST_RUN_OBSERVATION_REMAINING_HUMAN_STEPS,
    boundary: POST_RUN_OBSERVATION_BOUNDARY,
    blockers: uniqueBlockers,
    disclaimers: POST_RUN_OBSERVATION_DISCLAIMERS,
  };
  return { ...withoutDigest, observationDigest: digest('phase-233-post-run-observation-record', JSON.stringify(withoutDigest)) };
}

// Emit the blank observation a human completes, bound to this authorization record's one operation. The
// outcome is NOT_RUN and every observed-state digest is PENDING: this NEVER produces an observation that a
// run happened. Returns null when the authorization record is not a valid APPROVED record (fail closed).
export function buildPostRunObservationSkeleton(authorizationValue: unknown): PostRunObservationSkeleton | null {
  const auth = validateAuthorizationRecord(authorizationValue, []);
  if (!auth.ok) return null;
  return {
    record: POST_RUN_OBSERVATION_INPUT_ID,
    version: 1,
    operation: OPERATION,
    sourceAuthorizationRecord: AUTHORIZATION_REPORT_ID,
    recordDigest: auth.recordDigest!,
    approvalIdDigest: auth.bindings['operation-approval-id']!,
    itemDigest: auth.bindings['operation-item']!,
    sourceDigest: auth.bindings['operation-source']!,
    destinationDigest: auth.bindings['operation-destination']!,
    planDigest: auth.bindings['operation-plan']!,
    observedRunOutcome: 'NOT_RUN',
    observedStateBeforeDigest: 'PENDING',
    observedStateAfterDigest: 'PENDING',
    observedStateAfterWithdrawalDigest: 'PENDING',
    withdrawal: 'NOT_REQUIRED',
    // PENDING, never pre-affirmed: these assert the real library survived a run intact, and only the human who
    // watched that run may make them. A skeleton that shipped them as `true` would be pre-filled consent.
    preexistingPreserved: 'PENDING',
    withdrewOnlyRunCreatedMaterialization: 'PENDING',
    observerDigest: 'PENDING',
    observedAtUtc: 'PENDING',
  };
}

interface ValidatedAuthorization {
  readonly ok: boolean;
  readonly recordDigest: string | undefined;
  readonly bindings: Readonly<Record<string, string | undefined>>;
}

// The authorization record must be the genuine Phase 232 report: it recomputes, it is APPROVED, it recorded a
// human authorization, it performed and captured nothing itself, and it carries all six chain bindings.
function validateAuthorizationRecord(value: unknown, blockers: string[]): ValidatedAuthorization {
  const none: ValidatedAuthorization = { ok: false, recordDigest: undefined, bindings: {} };
  if (value === undefined) { blockers.push('AUTHORIZATION_RECORD_MISSING'); return none; }
  const obj = asObject(value);
  if (obj.report !== AUTHORIZATION_REPORT_ID) { blockers.push('AUTHORIZATION_RECORD_INVALID'); return none; }

  const stated = asSha256(obj.recordDigest);
  if (stated === undefined || verifySelfDigests([obj]).results[0]?.verified !== true) {
    blockers.push('AUTHORIZATION_RECORD_DIGEST_MISMATCH'); return none;
  }
  let ok = true;
  if (obj.overall !== 'EXECUTION_AUTHORIZATION_RECORD_APPROVED' || obj.recordedDecision !== 'APPROVED') {
    blockers.push('AUTHORIZATION_RECORD_NOT_APPROVED'); ok = false;
  }
  if (obj.authorizationRecorded !== true) { blockers.push('AUTHORIZATION_RECORD_NOT_RECORDED'); ok = false; }
  // The authorization record must itself still be a record only -- it may never claim to have run or captured.
  if (obj.execution !== 'NOT_PERFORMED') { blockers.push('AUTHORIZATION_RECORD_EXECUTION_CLAIMED'); ok = false; }
  if (obj.capturedArtifacts !== 'NONE') { blockers.push('AUTHORIZATION_RECORD_ARTIFACTS_CLAIMED'); ok = false; }
  if (obj.selfAuthorized !== false) { blockers.push('AUTHORIZATION_RECORD_SELF_AUTHORIZED'); ok = false; }

  const bound = asObject(obj.boundDigests);
  const bindings: Record<string, string | undefined> = {};
  for (const k of AUTHORIZATION_BINDING_KEYS) {
    bindings[k] = asSha256(bound[k]);
    if (bindings[k] === undefined) { blockers.push('AUTHORIZATION_RECORD_BINDINGS_INCOMPLETE'); ok = false; }
  }
  return ok ? { ok: true, recordDigest: stated, bindings } : none;
}

interface ValidatedObservation { readonly ok: boolean; readonly obj: Record<string, unknown>; }

// Strict shape: one object, only the allowlisted keys, all fixed literals correct, outcome and withdrawal from
// the closed enums, every observed state a sha256 or the PENDING placeholder, assertions boolean.
function validateObservationShape(value: unknown, blockers: string[]): ValidatedObservation {
  const none: ValidatedObservation = { ok: false, obj: {} };
  if (value === undefined) { blockers.push('OBSERVATION_MISSING'); return none; }
  if (Array.isArray(value)) { blockers.push('OBSERVATION_NOT_SINGLE'); return none; }
  if (!value || typeof value !== 'object') { blockers.push('OBSERVATION_INVALID'); return none; }
  const obj = value as Record<string, unknown>;

  let ok = true;
  for (const k of Object.keys(obj)) {
    if (!OBSERVATION_KEYS.includes(k)) { blockers.push('OBSERVATION_UNKNOWN_FIELD'); ok = false; break; }
  }
  if (obj.record !== POST_RUN_OBSERVATION_INPUT_ID) { blockers.push('OBSERVATION_INVALID'); return none; }
  if (obj.version !== 1) { blockers.push('OBSERVATION_VERSION_UNSUPPORTED'); ok = false; }
  if (obj.operation !== OPERATION) { blockers.push('OBSERVATION_OPERATION_MISMATCH'); ok = false; }
  if (obj.sourceAuthorizationRecord !== AUTHORIZATION_REPORT_ID) { blockers.push('OBSERVATION_SOURCE_RECORD_MISMATCH'); ok = false; }
  if (asSha256(obj.recordDigest) === undefined) { blockers.push('OBSERVATION_RECORD_DIGEST_INVALID'); ok = false; }
  if (typeof obj.observedRunOutcome !== 'string' || !OUTCOMES.includes(obj.observedRunOutcome)) { blockers.push('OBSERVATION_OUTCOME_INVALID'); return none; }
  if (typeof obj.withdrawal !== 'string' || !WITHDRAWALS.includes(obj.withdrawal)) { blockers.push('OBSERVATION_WITHDRAWAL_INVALID'); return none; }
  for (const f of STATE_DIGEST_FIELDS) {
    if (obj[f] === 'PENDING' || asSha256(obj[f]) !== undefined) continue;
    blockers.push('OBSERVATION_STATE_DIGEST_INVALID'); ok = false;
  }
  for (const f of ASSERTION_FIELDS) {
    if (typeof obj[f] === 'boolean' || obj[f] === 'PENDING') continue;
    blockers.push('OBSERVATION_ASSERTION_INVALID'); ok = false;
  }
  if (typeof obj.observerDigest !== 'string') { blockers.push('OBSERVATION_OBSERVER_DIGEST_INVALID'); ok = false; }
  if (typeof obj.observedAtUtc !== 'string') { blockers.push('OBSERVATION_OBSERVED_AT_INVALID'); ok = false; }
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
// Flag any string anywhere in the supplied observation that names a live/network/media surface or a raw path.
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
