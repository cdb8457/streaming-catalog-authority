import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';

// Phase 232: local, non-live HUMAN EXECUTION-AUTHORIZATION RECORD validator. It consumes the Phase 231
// digest-bound P227-A execution-authorization template and validates a SEPARATELY SUPPLIED operator
// decision record for exactly one promote -> observe -> withdraw operation.
//
// It is fail-closed and it NEVER creates, infers, completes, or upgrades a decision. It only checks a
// record a human wrote out-of-band: well-formed, strictly-allowlisted, redaction-safe, bound by digest to
// the SAME one operation the Phase 231 gate template names, and internally coherent. A missing, unbound,
// or incoherent record yields EXECUTION_AUTHORIZATION_RECORD_INVALID and grants nothing.
//
// Building this mechanism is NOT granting authorization. Even the strongest outcome
// (EXECUTION_AUTHORIZATION_RECORD_APPROVED) means only that a valid, digest-bound human decision record
// exists: `execution` is the constant NOT_PERFORMED and `capturedArtifacts` is the constant NONE, because
// the promote-observe-withdraw run and its evidence capture remain separate human operator steps that this
// validator neither performs nor authorizes.
//
// The record transplantation defence is the point of the binding. A record is bound to its gate by the
// gate's own `authorizationDigest` AND by each of the five operation digests in the gate's template, so a
// genuine record approved for one operation cannot be replayed against a different gate, a different item,
// or a re-planned run.
//
// Post-run fields (`observedStateWitnessedAfter`, `runExecutedByHuman`) MUST stay PENDING in every valid
// record regardless of decision: this mechanism records an authorization decision, never an execution.
//
// Boundary: it reads parsed JSON only. It performs no promotion, never runs the real-library promotion
// launcher, never reads or writes the real Movies library, never contacts Jellyfin, and never reads the
// secret approval file. The emitted report is redaction-safe: digests, fixed codes, fixed enum states, and
// per-check booleans only -- never a raw path, raw item id, raw approval id, or operator identity.

const GATE_REPORT_ID = 'phase-231-promotion-execution-authorization';
const OPERATION = 'promote-observe-withdraw';

export const EXECUTION_AUTHORIZATION_RECORD_INPUT_ID = 'phase-232-promotion-execution-authorization-record-input';

export type RecordDecision = 'APPROVED' | 'DECLINED' | 'PENDING';
export type RecordFieldState = 'PENDING' | 'AFFIRMED' | 'REFUSED';

const DECISIONS: readonly string[] = ['APPROVED', 'DECLINED', 'PENDING'];
const FIELD_STATES: readonly string[] = ['PENDING', 'AFFIRMED', 'REFUSED'];

// Affirmed BEFORE any run may be authorized. An APPROVED record requires all three.
const PRE_RUN_FIELDS: readonly string[] = ['operatorAuthorized', 'observedStateWitnessedBefore', 'withdrawalPathRehearsed'];
// Only meaningful AFTER a run. This mechanism never records an execution, so they must always stay PENDING.
const POST_RUN_FIELDS: readonly string[] = ['observedStateWitnessedAfter', 'runExecutedByHuman'];
const RECORD_FIELDS: readonly string[] = [...PRE_RUN_FIELDS, ...POST_RUN_FIELDS];

// The five operation digests the record must carry, each equal to the gate template's.
const OPERATION_DIGEST_FIELDS: readonly string[] = ['approvalIdDigest', 'itemDigest', 'sourceDigest', 'destinationDigest', 'planDigest'];

// Strict top-level allowlist: anything else is smuggled content and fails closed.
const RECORD_KEYS: readonly string[] = [
  'record', 'version', 'operation', 'sourceGate', 'authorizationDigest',
  ...OPERATION_DIGEST_FIELDS, 'decision', 'operatorDigest', 'decidedAtUtc', 'observedStateBeforeDigest', 'fields',
];

export interface ExecutionAuthorizationRecordInput {
  readonly gate?: unknown;    // phase-231-promotion-execution-authorization report
  readonly record?: unknown;  // the separately supplied human decision record
}

// The record a human completes out-of-band. Digest-only: it names no path, no id, and no operator identity.
export interface ExecutionAuthorizationRecordSkeleton {
  readonly record: typeof EXECUTION_AUTHORIZATION_RECORD_INPUT_ID;
  readonly version: 1;
  readonly operation: typeof OPERATION;
  readonly sourceGate: typeof GATE_REPORT_ID;
  readonly authorizationDigest: string;
  readonly approvalIdDigest: string;
  readonly itemDigest: string;
  readonly sourceDigest: string;
  readonly destinationDigest: string;
  readonly planDigest: string;
  readonly decision: RecordDecision;
  readonly operatorDigest: string;
  readonly decidedAtUtc: string;
  // The digest of the observed state the operator WITNESSED at authorization time: a sha256 when APPROVED,
  // the PENDING placeholder otherwise. Phase 233 binds its own before-state to this exact value.
  readonly observedStateBeforeDigest: string;
  readonly fields: Readonly<Record<string, RecordFieldState>>;
}

export const EXECUTION_AUTHORIZATION_RECORD_REMAINING_HUMAN_STEPS: readonly string[] = [
  'Independent human review of this record against these exact digests before anything is run.',
  'The promote -> observe -> withdraw run itself, on the server, by a human operator -- NOT performed or authorized here.',
  'Capture of the observed-state evidence before and after that run; this validator captures none and keeps captured artifacts NONE.',
  'The post-run withdrawal decision and its evidence, recorded out-of-band under a separate record.',
];

export const EXECUTION_AUTHORIZATION_RECORD_BOUNDARY =
  'No promotion launcher run, no real Movies library read or write, no live Jellyfin call, no secret approval-file read, no evidence capture, and no self-authorization: this validator only checks a separately supplied human decision record against the Phase 231 digest-bound template.';

export const EXECUTION_AUTHORIZATION_RECORD_DISCLAIMERS: readonly string[] = [
  'This validator never creates, infers, completes, or upgrades a decision; it only checks a record a human supplied separately.',
  'A valid record is a RECORD of a human decision -- it does not perform, schedule, or trigger the promotion.',
  'EXECUTION_AUTHORIZATION_RECORD_APPROVED means only that a well-formed, digest-bound operator decision record exists for this one operation; execution stays NOT_PERFORMED and captured artifacts stay NONE.',
  'Post-run fields stay PENDING in every valid record: this mechanism records an authorization decision, never an execution.',
  'It never runs the promotion launcher, reads or writes the real Movies library, contacts Jellyfin, or reads the secret approval file.',
];

export interface ExecutionAuthorizationRecordReport {
  readonly report: 'phase-232-promotion-execution-authorization-record';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly execution: 'NOT_PERFORMED';
  readonly capturedArtifacts: 'NONE';
  readonly selfAuthorized: false;
  readonly overall:
    | 'EXECUTION_AUTHORIZATION_RECORD_APPROVED'
    | 'EXECUTION_AUTHORIZATION_RECORD_DECLINED'
    | 'EXECUTION_AUTHORIZATION_RECORD_PENDING'
    | 'EXECUTION_AUTHORIZATION_RECORD_INVALID';
  readonly recordedDecision: RecordDecision | 'NONE';
  readonly authorizationRecorded: boolean;
  readonly gateValid: boolean;
  readonly recordWellFormed: boolean;
  readonly recordRedactionSafe: boolean;
  readonly recordBound: boolean;
  readonly decisionCoherent: boolean;
  readonly boundDigests: Readonly<Record<string, string>>;
  readonly fieldStates: Readonly<Record<string, RecordFieldState>>;
  readonly remainingHumanSteps: readonly string[];
  readonly boundary: string;
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly recordDigest: string;
}

export function buildExecutionAuthorizationRecord(input: ExecutionAuthorizationRecordInput): ExecutionAuthorizationRecordReport {
  const blockers: string[] = [];
  const boundDigests: Record<string, string> = {};

  // (1) The Phase 231 gate: present, right report id, self-digest recomputes, TEMPLATE_READY, authorization
  //     NONE / status PENDING, and carrying a NOT-authorized template whose every field is still PENDING.
  //     A record can only be bound to a gate that itself authorized nothing.
  const gate = validateGate(input.gate, blockers);
  const gateValid = gate.ok;
  if (gateValid) boundDigests['gate-authorization'] = gate.authorizationDigest!;

  // (2) The human record: present, single, strictly allowlisted, and every field a fixed allowed value.
  const rec = validateRecordShape(input.record, blockers);
  const recordWellFormed = rec.ok;

  // (3) Redaction: a human wrote this by hand, so it is the likeliest place for a raw path or live surface
  //     to leak in. Scan the WHOLE supplied value, not just the allowlisted keys.
  const recordRedactionSafe = input.record === undefined ? false : !deepLiveSurface(input.record);
  if (input.record !== undefined && !recordRedactionSafe) blockers.push('RECORD_LIVE_SURFACE');

  // (4) The binding: the record must name the gate by its own authorization digest AND carry each of the
  //     five operation digests from the gate's template. This is what stops a genuine record approved for
  //     one operation from being replayed against a different gate, item, or re-planned run.
  let recordBound = false;
  if (gateValid && recordWellFormed) {
    const bindsGate = rec.obj.authorizationDigest === gate.authorizationDigest;
    if (!bindsGate) blockers.push('RECORD_NOT_BOUND_TO_GATE');
    let digestsMatch = true;
    for (const f of OPERATION_DIGEST_FIELDS) {
      if (asSha256(rec.obj[f]) !== undefined && rec.obj[f] === gate.template[f]) continue;
      digestsMatch = false;
      blockers.push(`RECORD_${screamingSnake(f)}_MISMATCH`);
    }
    recordBound = bindsGate && digestsMatch;
    if (recordBound) {
      boundDigests['operation-approval-id'] = asString(rec.obj.approvalIdDigest)!;
      boundDigests['operation-item'] = asString(rec.obj.itemDigest)!;
      boundDigests['operation-source'] = asString(rec.obj.sourceDigest)!;
      boundDigests['operation-destination'] = asString(rec.obj.destinationDigest)!;
      boundDigests['operation-plan'] = asString(rec.obj.planDigest)!;
    }
  }

  // (5) Coherence between the stated decision and the recorded field states.
  let decisionCoherent = false;
  const fieldStates: Record<string, RecordFieldState> = {};
  if (recordWellFormed) {
    const fields = asObject(rec.obj.fields);
    for (const f of RECORD_FIELDS) fieldStates[f] = fields[f] as RecordFieldState;

    // Invariant, independent of decision: nothing has been run, so no post-run field may claim otherwise.
    let postRunPending = true;
    for (const f of POST_RUN_FIELDS) {
      if (fieldStates[f] === 'PENDING') continue;
      postRunPending = false;
      blockers.push('RECORD_POST_RUN_FIELD_NOT_PENDING');
    }

    const decision = rec.obj.decision as RecordDecision;
    let decisionMatchesFields: boolean;
    if (decision === 'APPROVED') {
      decisionMatchesFields = PRE_RUN_FIELDS.every((f) => fieldStates[f] === 'AFFIRMED');
      if (!decisionMatchesFields) blockers.push('RECORD_APPROVED_WITHOUT_PRE_RUN_AFFIRMATION');
    } else if (decision === 'DECLINED') {
      decisionMatchesFields = fieldStates.operatorAuthorized === 'REFUSED';
      if (!decisionMatchesFields) blockers.push('RECORD_DECLINED_WITHOUT_REFUSED_AUTHORIZATION');
    } else {
      decisionMatchesFields = fieldStates.operatorAuthorized === 'PENDING';
      if (!decisionMatchesFields) blockers.push('RECORD_PENDING_WITH_DECIDED_AUTHORIZATION');
    }

    // A decided record must identify its operator (by digest) and when; an undecided one must claim neither.
    const decided = decision !== 'PENDING';
    const operatorOk = decided
      ? asSha256(rec.obj.operatorDigest) !== undefined
      : rec.obj.operatorDigest === 'PENDING';
    if (!operatorOk) blockers.push(decided ? 'RECORD_OPERATOR_DIGEST_REQUIRED' : 'RECORD_OPERATOR_DIGEST_NOT_PENDING');
    const decidedAtOk = decided
      ? isUtcTimestamp(rec.obj.decidedAtUtc)
      : rec.obj.decidedAtUtc === 'PENDING';
    if (!decidedAtOk) blockers.push(decided ? 'RECORD_DECIDED_AT_REQUIRED' : 'RECORD_DECIDED_AT_NOT_PENDING');

    // An APPROVED record must PIN the observed state its operator witnessed, because approving requires
    // `observedStateWitnessedBefore: AFFIRMED` and an affirmation of nothing in particular binds nothing.
    // Phase 233 later requires its own before-state to equal this. A record that authorized nothing --
    // DECLINED or PENDING -- witnessed nothing it can pin, so it must claim no digest at all.
    const approved = decision === 'APPROVED';
    const witnessedOk = approved
      ? asSha256(rec.obj.observedStateBeforeDigest) !== undefined
      : rec.obj.observedStateBeforeDigest === 'PENDING';
    if (!witnessedOk) blockers.push(approved ? 'RECORD_OBSERVED_STATE_BEFORE_REQUIRED' : 'RECORD_OBSERVED_STATE_BEFORE_NOT_PENDING');

    decisionCoherent = postRunPending && decisionMatchesFields && operatorOk && decidedAtOk && witnessedOk;
  }

  const uniqueBlockers = [...new Set(blockers)];
  const valid = uniqueBlockers.length === 0 && gateValid && recordWellFormed && recordRedactionSafe && recordBound && decisionCoherent;
  const recordedDecision: ExecutionAuthorizationRecordReport['recordedDecision'] = valid ? rec.obj.decision as RecordDecision : 'NONE';
  // Published ONLY for a valid approval: this is the state the operator witnessed, and it is what Phase 233
  // must later bind its own before-state to. Nothing is published for a record that authorized nothing.
  if (valid && recordedDecision === 'APPROVED') {
    boundDigests['observed-state-before'] = asString(rec.obj.observedStateBeforeDigest)!;
  }
  const overall: ExecutionAuthorizationRecordReport['overall'] =
    !valid ? 'EXECUTION_AUTHORIZATION_RECORD_INVALID'
      : recordedDecision === 'APPROVED' ? 'EXECUTION_AUTHORIZATION_RECORD_APPROVED'
        : recordedDecision === 'DECLINED' ? 'EXECUTION_AUTHORIZATION_RECORD_DECLINED'
          : 'EXECUTION_AUTHORIZATION_RECORD_PENDING';

  const withoutDigest: Omit<ExecutionAuthorizationRecordReport, 'recordDigest'> = {
    report: 'phase-232-promotion-execution-authorization-record',
    version: 1,
    redactionSafe: true,
    execution: 'NOT_PERFORMED',
    capturedArtifacts: 'NONE',
    selfAuthorized: false,
    overall,
    recordedDecision,
    authorizationRecorded: overall === 'EXECUTION_AUTHORIZATION_RECORD_APPROVED',
    gateValid,
    recordWellFormed,
    recordRedactionSafe,
    recordBound,
    decisionCoherent,
    boundDigests,
    fieldStates,
    remainingHumanSteps: EXECUTION_AUTHORIZATION_RECORD_REMAINING_HUMAN_STEPS,
    boundary: EXECUTION_AUTHORIZATION_RECORD_BOUNDARY,
    blockers: uniqueBlockers,
    disclaimers: EXECUTION_AUTHORIZATION_RECORD_DISCLAIMERS,
  };
  return { ...withoutDigest, recordDigest: digest('phase-232-execution-authorization-record', JSON.stringify(withoutDigest)) };
}

// Emit the blank record a human completes, bound to this gate's one operation. Every field is PENDING and
// the decision is PENDING: this NEVER produces a decided -- let alone approved -- record. Returns null when
// the gate is not a valid, TEMPLATE_READY, authorized-nothing gate (fail closed).
export function buildExecutionAuthorizationRecordSkeleton(gateValue: unknown): ExecutionAuthorizationRecordSkeleton | null {
  const gate = validateGate(gateValue, []);
  if (!gate.ok) return null;
  const fields: Record<string, RecordFieldState> = {};
  for (const f of RECORD_FIELDS) fields[f] = 'PENDING';
  return {
    record: EXECUTION_AUTHORIZATION_RECORD_INPUT_ID,
    version: 1,
    operation: OPERATION,
    sourceGate: GATE_REPORT_ID,
    authorizationDigest: gate.authorizationDigest!,
    approvalIdDigest: gate.template.approvalIdDigest!,
    itemDigest: gate.template.itemDigest!,
    sourceDigest: gate.template.sourceDigest!,
    destinationDigest: gate.template.destinationDigest!,
    planDigest: gate.template.planDigest!,
    decision: 'PENDING',
    operatorDigest: 'PENDING',
    decidedAtUtc: 'PENDING',
    // PENDING, never pre-filled: only the human who actually witnessed the state may pin its digest.
    observedStateBeforeDigest: 'PENDING',
    fields,
  };
}

interface ValidatedGate {
  readonly ok: boolean;
  readonly authorizationDigest: string | undefined;
  readonly template: Readonly<Record<string, string | undefined>>;
}

// The gate must be the genuine Phase 231 report: it recomputes, it is TEMPLATE_READY, it authorized nothing
// (authorization NONE / status PENDING), and it carries a template whose every field is still PENDING.
function validateGate(value: unknown, blockers: string[]): ValidatedGate {
  const none: ValidatedGate = { ok: false, authorizationDigest: undefined, template: {} };
  if (value === undefined) { blockers.push('GATE_MISSING'); return none; }
  const obj = asObject(value);
  if (obj.report !== GATE_REPORT_ID) { blockers.push('GATE_INVALID'); return none; }

  const stated = asSha256(obj.authorizationDigest);
  if (stated === undefined || verifySelfDigests([obj]).results[0]?.verified !== true) {
    blockers.push('GATE_DIGEST_MISMATCH'); return none;
  }
  let ok = true;
  if (obj.overall !== 'EXECUTION_AUTHORIZATION_TEMPLATE_READY') { blockers.push('GATE_NOT_TEMPLATE_READY'); ok = false; }
  if (obj.authorization !== 'NONE') { blockers.push('GATE_AUTHORIZATION_NOT_NONE'); ok = false; }
  if (obj.status !== 'PENDING') { blockers.push('GATE_STATUS_NOT_PENDING'); ok = false; }

  const t = asObject(obj.template);
  if (obj.template === null || obj.template === undefined || Object.keys(t).length === 0) {
    blockers.push('GATE_TEMPLATE_MISSING'); return none;
  }
  if (t.operation !== OPERATION) { blockers.push('GATE_TEMPLATE_OPERATION_MISMATCH'); ok = false; }
  if (t.authorization !== 'NONE' || t.status !== 'PENDING') { blockers.push('GATE_TEMPLATE_NOT_PENDING'); ok = false; }
  if (t.targetRootApproved !== true) { blockers.push('GATE_TEMPLATE_ROOT_NOT_APPROVED'); ok = false; }
  const tFields = asObject(t.fields);
  if (!RECORD_FIELDS.every((f) => tFields[f] === 'PENDING')) { blockers.push('GATE_TEMPLATE_FIELDS_NOT_PENDING'); ok = false; }

  const template: Record<string, string | undefined> = {};
  for (const f of OPERATION_DIGEST_FIELDS) {
    template[f] = asSha256(t[f]);
    if (template[f] === undefined) { blockers.push('GATE_TEMPLATE_DIGEST_INVALID'); ok = false; }
  }
  return ok ? { ok: true, authorizationDigest: stated, template } : none;
}

interface ValidatedRecord { readonly ok: boolean; readonly obj: Record<string, unknown>; }

// Strict shape: one object, only the allowlisted keys, all fixed literals correct, decision and every field
// state from the closed enums. Anything else is smuggled content or an unreviewable record -- fail closed.
function validateRecordShape(value: unknown, blockers: string[]): ValidatedRecord {
  const none: ValidatedRecord = { ok: false, obj: {} };
  if (value === undefined) { blockers.push('RECORD_MISSING'); return none; }
  if (Array.isArray(value)) { blockers.push('RECORD_NOT_SINGLE'); return none; }
  if (!value || typeof value !== 'object') { blockers.push('RECORD_INVALID'); return none; }
  const obj = value as Record<string, unknown>;

  let ok = true;
  for (const k of Object.keys(obj)) {
    if (!RECORD_KEYS.includes(k)) { blockers.push('RECORD_UNKNOWN_FIELD'); ok = false; break; }
  }
  if (obj.record !== EXECUTION_AUTHORIZATION_RECORD_INPUT_ID) { blockers.push('RECORD_INVALID'); return none; }
  if (obj.version !== 1) { blockers.push('RECORD_VERSION_UNSUPPORTED'); ok = false; }
  if (obj.operation !== OPERATION) { blockers.push('RECORD_OPERATION_MISMATCH'); ok = false; }
  if (obj.sourceGate !== GATE_REPORT_ID) { blockers.push('RECORD_SOURCE_GATE_MISMATCH'); ok = false; }
  if (asSha256(obj.authorizationDigest) === undefined) { blockers.push('RECORD_AUTHORIZATION_DIGEST_INVALID'); ok = false; }
  if (typeof obj.decision !== 'string' || !DECISIONS.includes(obj.decision)) { blockers.push('RECORD_DECISION_INVALID'); return none; }
  if (typeof obj.operatorDigest !== 'string') { blockers.push('RECORD_OPERATOR_DIGEST_INVALID'); ok = false; }
  if (typeof obj.decidedAtUtc !== 'string') { blockers.push('RECORD_DECIDED_AT_INVALID'); ok = false; }
  // A sha256 or the PENDING placeholder and nothing else -- anything else is unreviewable.
  if (asSha256(obj.observedStateBeforeDigest) === undefined && obj.observedStateBeforeDigest !== 'PENDING') {
    blockers.push('RECORD_OBSERVED_STATE_BEFORE_INVALID'); ok = false;
  }

  const fields = asObject(obj.fields);
  const fieldKeys = Object.keys(fields);
  if (fieldKeys.length !== RECORD_FIELDS.length || !RECORD_FIELDS.every((f) => fieldKeys.includes(f))) {
    blockers.push('RECORD_FIELDS_INVALID'); return none;
  }
  for (const f of RECORD_FIELDS) {
    if (typeof fields[f] === 'string' && FIELD_STATES.includes(fields[f] as string)) continue;
    blockers.push('RECORD_FIELD_STATE_INVALID'); ok = false;
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
// Flag any string anywhere in the supplied record that names a live/network/media surface or a raw path.
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
