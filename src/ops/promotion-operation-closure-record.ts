import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';

// Phase 235: local, non-live OPERATION CLOSURE / ARCHIVAL RECORD validator. It consumes the Phase 234 post-run
// disposition record (which must be a genuine ACCEPTED disposition) and validates a SEPARATELY SUPPLIED human
// CLOSURE record for that one promote -> observe -> withdraw operation: close it out, hold it open, or leave it
// undecided.
//
// It is fail-closed and it CLOSES, ARCHIVES, PURGES AND REVIEWS NOTHING ITSELF. `closedByThisTool`,
// `archivedByThisTool`, `purgedByThisTool` and `selfAuthorized` are the constants false: this validator moves
// no evidence, deletes nothing, forms no judgement, and only checks a record a human produced out-of-band.
//
// THE HEADLINE INVARIANT is that CLOSURE IS ARCHIVAL, NEVER ERASURE:
//   * `evidencePurged` may never be anything but PENDING in ANY valid record, whatever the decision
//     (CLOSURE_EVIDENCE_PURGE_CLAIMED). An operation must never be closed by destroying its own record.
//   * CLOSED additionally requires the evidence to have been archived out-of-band AND the chain digests to
//     have been recorded in that archive (CLOSURE_CLOSED_WITHOUT_ARCHIVAL), so what is closed stays findable
//     and re-verifiable against these exact digests.
//   * CLOSED requires no outstanding remediation (CLOSURE_CLOSED_WITH_OUTSTANDING_REMEDIATION): an operation
//     with work still owed to it is not finished.
// HELD_OPEN is the conservative verdict and is ALWAYS available, in every state and with no preconditions --
// holding an operation open is never something this validator can refuse.
//
// THE OUTCOME THAT MATTERS MOST HERE is OPERATION_CLOSURE_NOT_CLOSEABLE, deliberately distinct from INVALID:
//   * NOT_CLOSEABLE = the CHAIN has nothing to close. The upstream disposition is absent, not genuine, or not
//     ACCEPTED, so no closure over it can mean anything.
//   * INVALID = the chain is closeable but the SUPPLIED CLOSURE RECORD is broken.
// NOT_CLOSEABLE takes PRECEDENCE over everything: when the disposition is not closeable the overall verdict is
// NOT_CLOSEABLE no matter what the closure record claims. That is what locks the actual prepared P227-A chain,
// which terminates at Phase 234 NOT_REVIEWABLE because it remains unauthorized, unrun, unobserved and
// unreviewed -- it can never land anywhere else here.
//
// A self-digest is NOT a signature -- anyone can recompute one. So the semantic checks on the upstream
// disposition are not redundant behind the digest check: a forged disposition that rebuilds its own digest
// cleanly walks straight into them, and they are the only thing standing between a fabricated "already
// accepted" disposition and a closed-out operation.
//
// The emitted report is redaction-safe: chain digests, fixed codes, closed enum states and booleans only --
// never a raw path, raw item id, raw approval id, or closer identity.

const DISPOSITION_REPORT_ID = 'phase-234-promotion-post-run-disposition-record';
const OPERATION = 'promote-observe-withdraw';

export const OPERATION_CLOSURE_INPUT_ID = 'phase-235-promotion-operation-closure-record-input';

export type ClosedOutcome = 'COMPLETED' | 'FAILED';
export type ClosureFieldState = 'PENDING' | 'AFFIRMED' | 'REFUSED';
export type RecordedClosure = 'CLOSED' | 'HELD_OPEN' | 'PENDING';

// An ACCEPTED Phase 234 disposition is by construction reviewing a COMPLETED or FAILED run.
const CLOSED_OUTCOMES: readonly string[] = ['COMPLETED', 'FAILED'];
const FIELD_STATES: readonly string[] = ['PENDING', 'AFFIRMED', 'REFUSED'];

// `closureAffirmed` carries the decision itself: AFFIRMED -> CLOSED, REFUSED -> HELD_OPEN, PENDING -> PENDING.
// One source of truth, so a record can never state a verdict that contradicts its own fields.
const DECISION_FIELD = 'closureAffirmed';
// What must actually be true before an operation may be closed out.
const ARCHIVAL_FIELDS: readonly string[] = ['evidenceArchivedOutOfBand', 'chainDigestsRecordedInArchive'];
const REMEDIATION_FIELD = 'noOutstandingRemediation';
// Closure is archival, never erasure: this must stay PENDING in every valid record.
const PURGE_FIELD = 'evidencePurged';
const CLOSURE_FIELDS: readonly string[] = [DECISION_FIELD, ...ARCHIVAL_FIELDS, REMEDIATION_FIELD, PURGE_FIELD];

const OPERATION_DIGEST_FIELDS: readonly string[] = ['approvalIdDigest', 'itemDigest', 'sourceDigest', 'destinationDigest', 'planDigest'];
// closure field -> the Phase 234 boundDigests key it must equal.
const OPERATION_BINDING_KEYS: Readonly<Record<string, string>> = {
  approvalIdDigest: 'operation-approval-id',
  itemDigest: 'operation-item',
  sourceDigest: 'operation-source',
  destinationDigest: 'operation-destination',
  planDigest: 'operation-plan',
};
// Every binding the Phase 234 report must itself carry before it can be closed at all.
const DISPOSITION_BINDING_KEYS: readonly string[] = ['observation-record', ...Object.values(OPERATION_BINDING_KEYS)];

// Strict top-level allowlist: anything else is smuggled content and fails closed.
const CLOSURE_KEYS: readonly string[] = [
  'record', 'version', 'operation', 'sourceDispositionRecord', 'dispositionDigest',
  ...OPERATION_DIGEST_FIELDS, 'closedOutcome', 'fields', 'closerDigest', 'closedAtUtc',
];

export interface OperationClosureInput {
  readonly dispositionRecord?: unknown;  // phase-234-promotion-post-run-disposition-record report
  readonly closure?: unknown;            // the separately supplied human closure record
}

// The record a human completes when closing the operation out. Digest-only: no path, no id, no closer identity.
export interface OperationClosureSkeleton {
  readonly record: typeof OPERATION_CLOSURE_INPUT_ID;
  readonly version: 1;
  readonly operation: typeof OPERATION;
  readonly sourceDispositionRecord: typeof DISPOSITION_REPORT_ID;
  readonly dispositionDigest: string;
  readonly approvalIdDigest: string;
  readonly itemDigest: string;
  readonly sourceDigest: string;
  readonly destinationDigest: string;
  readonly planDigest: string;
  readonly closedOutcome: ClosedOutcome;
  readonly fields: Readonly<Record<string, ClosureFieldState>>;
  readonly closerDigest: string;
  readonly closedAtUtc: string;
}

export const OPERATION_CLOSURE_REMAINING_HUMAN_STEPS: readonly string[] = [
  'The archival itself -- moving the evidence somewhere durable and recording these chain digests alongside it -- which a human does, not this validator.',
  'Any remediation still owed to the operation; closing is refused while remediation is outstanding.',
  'Independent confirmation that the archived evidence still re-verifies against these exact chain digests.',
  'Retention and eventual disposal of the archived evidence, governed out-of-band -- never by this record, which can only ever say the evidence was archived.',
];

export const OPERATION_CLOSURE_BOUNDARY =
  'No promotion launcher run, no withdrawal run, no remediation, no archival, no evidence purge, no observed-state capture, no real Movies library read or write, no live Jellyfin call, no secret approval-file read, and no self-authorization: this validator only checks a separately supplied human closure record against the Phase 234 disposition record.';

export const OPERATION_CLOSURE_DISCLAIMERS: readonly string[] = [
  'This validator closes nothing: it archives no evidence, purges no evidence, forms no judgement, and performs no remediation; it only checks a record a human produced separately.',
  'OPERATION_CLOSURE_NOT_CLOSEABLE means the chain itself has nothing to close -- it is NOT a defect in the supplied closure record, and no closure record can override it.',
  'OPERATION_CLOSURE_CLOSED means only that a well-formed, chain-bound, coherent human closure exists -- it is not itself evidence that the evidence was archived.',
  'Closure is archival, never erasure: no valid record may claim the evidence was purged, and closing requires the evidence archived and these chain digests recorded alongside it.',
  'HELD_OPEN is always available: holding an operation open is never refused.',
  'It never runs the promotion launcher, reads or writes the real Movies library, contacts Jellyfin, or reads the secret approval file.',
];

export interface OperationClosureReport {
  readonly report: 'phase-235-promotion-operation-closure-record';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly closedByThisTool: false;
  readonly archivedByThisTool: false;
  readonly purgedByThisTool: false;
  readonly selfAuthorized: false;
  readonly overall:
    | 'OPERATION_CLOSURE_CLOSED'
    | 'OPERATION_CLOSURE_HELD_OPEN'
    | 'OPERATION_CLOSURE_PENDING'
    | 'OPERATION_CLOSURE_NOT_CLOSEABLE'
    | 'OPERATION_CLOSURE_INVALID';
  readonly recordedClosure: RecordedClosure | 'NONE';
  readonly operationClosed: boolean;
  readonly dispositionCloseable: boolean;
  readonly closureWellFormed: boolean;
  readonly closureRedactionSafe: boolean;
  readonly closureBound: boolean;
  readonly closureCoherent: boolean;
  readonly closedOutcome: ClosedOutcome | 'NONE';
  readonly archivalAffirmed: boolean;
  readonly boundDigests: Readonly<Record<string, string>>;
  readonly fieldStates: Readonly<Record<string, ClosureFieldState>>;
  readonly remainingHumanSteps: readonly string[];
  readonly boundary: string;
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly closureDigest: string;
}

export function buildOperationClosureRecord(input: OperationClosureInput): OperationClosureReport {
  const blockers: string[] = [];
  const boundDigests: Record<string, string> = {};

  // (1) The Phase 234 disposition: genuine, ACCEPTED, and having reviewed/performed/captured nothing itself.
  //     Anything wrong here means the CHAIN has nothing to close -- NOT_CLOSEABLE, never INVALID.
  const disp = validateDispositionRecord(input.dispositionRecord, blockers);
  const dispositionCloseable = disp.ok;
  if (dispositionCloseable) boundDigests['disposition-record'] = disp.dispositionDigest!;

  // (2) The human closure record: present, single, strictly allowlisted, closed enums.
  const clo = validateClosureShape(input.closure, blockers);
  const closureWellFormed = clo.ok;

  // (3) Redaction: scan the WHOLE supplied value, not just the allowlisted keys.
  const closureRedactionSafe = input.closure === undefined ? false : !deepLiveSurface(input.closure);
  if (input.closure !== undefined && !closureRedactionSafe) blockers.push('CLOSURE_LIVE_SURFACE');

  // (4) The chain binding: the closure names the disposition by its own dispositionDigest AND carries each of
  //     the five operation digests that record bound. Same transplantation defence as Phase 232/233/234: a
  //     closure of one operation cannot be replayed against a different disposition.
  let closureBound = false;
  if (dispositionCloseable && closureWellFormed) {
    const bindsDisposition = clo.obj.dispositionDigest === disp.dispositionDigest;
    if (!bindsDisposition) blockers.push('CLOSURE_NOT_BOUND_TO_DISPOSITION');
    let digestsMatch = true;
    for (const f of OPERATION_DIGEST_FIELDS) {
      if (asSha256(clo.obj[f]) !== undefined && clo.obj[f] === disp.bindings[OPERATION_BINDING_KEYS[f]!]) continue;
      digestsMatch = false;
      blockers.push(`CLOSURE_${screamingSnake(f)}_MISMATCH`);
    }
    closureBound = bindsDisposition && digestsMatch;
    if (closureBound) {
      for (const f of OPERATION_DIGEST_FIELDS) boundDigests[OPERATION_BINDING_KEYS[f]!] = asString(clo.obj[f])!;
    }
  }

  // (5) Coherence: the decision, the archival that must back a closure, and what was actually dispositioned.
  let closureCoherent = false;
  let decision: RecordedClosure | 'NONE' = 'NONE';
  let archivalAffirmed = false;
  const fieldStates: Record<string, ClosureFieldState> = {};
  if (closureWellFormed) {
    const fields = asObject(clo.obj.fields);
    for (const f of CLOSURE_FIELDS) fieldStates[f] = fields[f] as ClosureFieldState;

    // THE HEADLINE INVARIANT, independent of decision: closure is archival, never erasure. This phase purges
    // nothing and no record may claim an operation was closed by destroying its own evidence.
    let purgeClean = true;
    if (fieldStates[PURGE_FIELD] !== 'PENDING') { blockers.push('CLOSURE_EVIDENCE_PURGE_CLAIMED'); purgeClean = false; }

    // The decision IS `closureAffirmed`, so it can never contradict the record's own fields.
    const affirmed = fieldStates[DECISION_FIELD];
    decision = affirmed === 'AFFIRMED' ? 'CLOSED' : affirmed === 'REFUSED' ? 'HELD_OPEN' : 'PENDING';
    archivalAffirmed = ARCHIVAL_FIELDS.every((f) => fieldStates[f] === 'AFFIRMED');

    // Closing out requires the evidence to survive the closure, and nothing still owed to the operation.
    // HELD_OPEN is deliberately ungated: holding an operation open is never refused.
    let decisionBacked = true;
    if (decision === 'CLOSED') {
      if (!archivalAffirmed) { blockers.push('CLOSURE_CLOSED_WITHOUT_ARCHIVAL'); decisionBacked = false; }
      if (fieldStates[REMEDIATION_FIELD] !== 'AFFIRMED') {
        blockers.push('CLOSURE_CLOSED_WITH_OUTSTANDING_REMEDIATION'); decisionBacked = false;
      }
    }

    // A decided closure names WHO closed it (by digest) and WHEN; an undecided one claims neither.
    const decided = decision !== 'PENDING';
    const closerOk = decided ? asSha256(clo.obj.closerDigest) !== undefined : clo.obj.closerDigest === 'PENDING';
    if (!closerOk) blockers.push(decided ? 'CLOSURE_CLOSER_DIGEST_REQUIRED' : 'CLOSURE_CLOSER_DIGEST_NOT_PENDING');
    const closedAtOk = decided ? isUtcTimestamp(clo.obj.closedAtUtc) : clo.obj.closedAtUtc === 'PENDING';
    if (!closedAtOk) blockers.push(decided ? 'CLOSURE_CLOSED_AT_REQUIRED' : 'CLOSURE_CLOSED_AT_NOT_PENDING');

    // Cross-record coherence: you must be closing the outcome that was actually dispositioned.
    let matchesDisposition = true;
    if (dispositionCloseable && clo.obj.closedOutcome !== disp.reviewedOutcome) {
      blockers.push('CLOSURE_CLOSED_OUTCOME_MISMATCH'); matchesDisposition = false;
    }

    closureCoherent = purgeClean && decisionBacked && closerOk && closedAtOk && matchesDisposition;
  }

  const uniqueBlockers = [...new Set(blockers)];
  // When the disposition is closeable, every remaining blocker is closure-side by construction.
  const closureSound = uniqueBlockers.length === 0
    && closureWellFormed && closureRedactionSafe && closureBound && closureCoherent;

  // NOT_CLOSEABLE takes precedence over everything: an unclosed-out chain cannot be closed at all.
  const overall: OperationClosureReport['overall'] =
    !dispositionCloseable ? 'OPERATION_CLOSURE_NOT_CLOSEABLE'
      : !closureSound ? 'OPERATION_CLOSURE_INVALID'
        : decision === 'CLOSED' ? 'OPERATION_CLOSURE_CLOSED'
          : decision === 'HELD_OPEN' ? 'OPERATION_CLOSURE_HELD_OPEN'
            : 'OPERATION_CLOSURE_PENDING';
  const settled = overall === 'OPERATION_CLOSURE_CLOSED' || overall === 'OPERATION_CLOSURE_HELD_OPEN'
    || overall === 'OPERATION_CLOSURE_PENDING';

  const withoutDigest: Omit<OperationClosureReport, 'closureDigest'> = {
    report: 'phase-235-promotion-operation-closure-record',
    version: 1,
    redactionSafe: true,
    closedByThisTool: false,
    archivedByThisTool: false,
    purgedByThisTool: false,
    selfAuthorized: false,
    overall,
    recordedClosure: settled ? decision : 'NONE',
    operationClosed: overall === 'OPERATION_CLOSURE_CLOSED',
    dispositionCloseable,
    closureWellFormed,
    closureRedactionSafe,
    closureBound,
    closureCoherent,
    closedOutcome: settled ? clo.obj.closedOutcome as ClosedOutcome : 'NONE',
    archivalAffirmed: settled && archivalAffirmed,
    // NOTE: there is deliberately no `evidencePurged` field here. `purgedByThisTool: false` states what this
    // tool did; whether the evidence still exists is a fact about the world that this validator never touches
    // and must not attest to. What the supplied record CLAIMED is visible in `fieldStates.evidencePurged`.
    boundDigests,
    fieldStates,
    remainingHumanSteps: OPERATION_CLOSURE_REMAINING_HUMAN_STEPS,
    boundary: OPERATION_CLOSURE_BOUNDARY,
    blockers: uniqueBlockers,
    disclaimers: OPERATION_CLOSURE_DISCLAIMERS,
  };
  return { ...withoutDigest, closureDigest: digest('phase-235-operation-closure-record', JSON.stringify(withoutDigest)) };
}

// Emit the blank closure a human completes, bound to this disposition's one operation. EVERY field is PENDING
// -- nothing is pre-affirmed, so a human who signs it blind asserts nothing and closes nothing. Returns null
// when the disposition is not closeable (fail closed).
//
// `closedOutcome` IS pre-filled, and deliberately so: like the digests, it is a derived binding copied from the
// upstream record, naming WHAT is being closed, not a judgement about it. The judgement lives entirely in the
// all-PENDING `fields`.
export function buildOperationClosureSkeleton(dispositionValue: unknown): OperationClosureSkeleton | null {
  const disp = validateDispositionRecord(dispositionValue, []);
  if (!disp.ok) return null;
  const fields: Record<string, ClosureFieldState> = {};
  for (const f of CLOSURE_FIELDS) fields[f] = 'PENDING';
  return {
    record: OPERATION_CLOSURE_INPUT_ID,
    version: 1,
    operation: OPERATION,
    sourceDispositionRecord: DISPOSITION_REPORT_ID,
    dispositionDigest: disp.dispositionDigest!,
    approvalIdDigest: disp.bindings['operation-approval-id']!,
    itemDigest: disp.bindings['operation-item']!,
    sourceDigest: disp.bindings['operation-source']!,
    destinationDigest: disp.bindings['operation-destination']!,
    planDigest: disp.bindings['operation-plan']!,
    closedOutcome: disp.reviewedOutcome as ClosedOutcome,
    fields,
    closerDigest: 'PENDING',
    closedAtUtc: 'PENDING',
  };
}

interface ValidatedDisposition {
  readonly ok: boolean;
  readonly dispositionDigest: string | undefined;
  readonly reviewedOutcome: string | undefined;
  readonly bindings: Readonly<Record<string, string | undefined>>;
}

// The disposition must be the genuine Phase 234 report: it recomputes, it is ACCEPTED, it still claims to have
// reviewed/performed/captured/authorized nothing itself, its reviewed outcome is a closed-enum value, and it
// carries all six chain bindings. EVERY failure here is a NOT_CLOSEABLE chain, not an INVALID closure record.
//
// These semantic checks are NOT unreachable behind the digest check: a self-digest is not a signature, so a
// forger who rebuilds it reaches them, and they are the only thing that stops a fabricated disposition.
function validateDispositionRecord(value: unknown, blockers: string[]): ValidatedDisposition {
  const none: ValidatedDisposition = { ok: false, dispositionDigest: undefined, reviewedOutcome: undefined, bindings: {} };
  if (value === undefined) { blockers.push('DISPOSITION_RECORD_MISSING'); return none; }
  const obj = asObject(value);
  if (obj.report !== DISPOSITION_REPORT_ID) { blockers.push('DISPOSITION_RECORD_INVALID'); return none; }

  const stated = asSha256(obj.dispositionDigest);
  if (stated === undefined || verifySelfDigests([obj]).results[0]?.verified !== true) {
    blockers.push('DISPOSITION_RECORD_DIGEST_MISMATCH'); return none;
  }
  let ok = true;
  if (obj.overall !== 'POST_RUN_DISPOSITION_ACCEPTED') { blockers.push('DISPOSITION_RECORD_NOT_ACCEPTED'); ok = false; }
  if (obj.dispositionAccepted !== true) { blockers.push('DISPOSITION_RECORD_NOT_MARKED_ACCEPTED'); ok = false; }
  // The disposition record must itself still be a record only -- it may never claim to have acted.
  if (obj.reviewedByThisTool !== false) { blockers.push('DISPOSITION_RECORD_REVIEWED_CLAIMED'); ok = false; }
  if (obj.performedByThisTool !== false) { blockers.push('DISPOSITION_RECORD_PERFORMED_CLAIMED'); ok = false; }
  if (obj.capturedByThisTool !== false) { blockers.push('DISPOSITION_RECORD_CAPTURED_CLAIMED'); ok = false; }
  if (obj.selfAuthorized !== false) { blockers.push('DISPOSITION_RECORD_SELF_AUTHORIZED'); ok = false; }

  const outcome = typeof obj.reviewedOutcome === 'string' ? obj.reviewedOutcome : undefined;
  if (outcome === undefined || !CLOSED_OUTCOMES.includes(outcome)) { blockers.push('DISPOSITION_RECORD_OUTCOME_INVALID'); ok = false; }

  const bound = asObject(obj.boundDigests);
  const bindings: Record<string, string | undefined> = {};
  for (const k of DISPOSITION_BINDING_KEYS) {
    bindings[k] = asSha256(bound[k]);
    if (bindings[k] === undefined) { blockers.push('DISPOSITION_RECORD_BINDINGS_INCOMPLETE'); ok = false; }
  }
  return ok ? { ok: true, dispositionDigest: stated, reviewedOutcome: outcome, bindings } : none;
}

interface ValidatedClosure { readonly ok: boolean; readonly obj: Record<string, unknown>; }

// Strict shape: one object, only the allowlisted keys, all fixed literals correct, the closed-outcome echo and
// every field state from the closed enums.
function validateClosureShape(value: unknown, blockers: string[]): ValidatedClosure {
  const none: ValidatedClosure = { ok: false, obj: {} };
  if (value === undefined) { blockers.push('CLOSURE_MISSING'); return none; }
  if (Array.isArray(value)) { blockers.push('CLOSURE_NOT_SINGLE'); return none; }
  if (!value || typeof value !== 'object') { blockers.push('CLOSURE_INVALID'); return none; }
  const obj = value as Record<string, unknown>;

  let ok = true;
  for (const k of Object.keys(obj)) {
    if (!CLOSURE_KEYS.includes(k)) { blockers.push('CLOSURE_UNKNOWN_FIELD'); ok = false; break; }
  }
  if (obj.record !== OPERATION_CLOSURE_INPUT_ID) { blockers.push('CLOSURE_INVALID'); return none; }
  if (obj.version !== 1) { blockers.push('CLOSURE_VERSION_UNSUPPORTED'); ok = false; }
  if (obj.operation !== OPERATION) { blockers.push('CLOSURE_OPERATION_MISMATCH'); ok = false; }
  if (obj.sourceDispositionRecord !== DISPOSITION_REPORT_ID) { blockers.push('CLOSURE_SOURCE_RECORD_MISMATCH'); ok = false; }
  if (asSha256(obj.dispositionDigest) === undefined) { blockers.push('CLOSURE_DISPOSITION_DIGEST_INVALID'); ok = false; }
  if (typeof obj.closedOutcome !== 'string' || !CLOSED_OUTCOMES.includes(obj.closedOutcome)) { blockers.push('CLOSURE_CLOSED_OUTCOME_INVALID'); return none; }
  if (typeof obj.closerDigest !== 'string') { blockers.push('CLOSURE_CLOSER_DIGEST_INVALID'); ok = false; }
  if (typeof obj.closedAtUtc !== 'string') { blockers.push('CLOSURE_CLOSED_AT_INVALID'); ok = false; }

  const fields = asObject(obj.fields);
  const fieldKeys = Object.keys(fields);
  if (fieldKeys.length !== CLOSURE_FIELDS.length || !CLOSURE_FIELDS.every((f) => fieldKeys.includes(f))) {
    blockers.push('CLOSURE_FIELDS_INVALID'); return none;
  }
  for (const f of CLOSURE_FIELDS) {
    if (typeof fields[f] === 'string' && FIELD_STATES.includes(fields[f] as string)) continue;
    blockers.push('CLOSURE_FIELD_STATE_INVALID'); ok = false;
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
// Flag any string anywhere in the supplied closure record that names a live/network/media surface or a raw path.
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
