import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';
import { buildLivePreflightPlan } from './promotion-live-preflight-plan.js';

// Phase 231: local, non-live ONE-SHOT execution-authorization gate for the single prepared P227-A
// promotion. It validates and CROSS-BINDS the prepared non-live evidence and, only when every piece
// is valid and binds to the SAME one item, emits a NOT-authorized, human-completable execution
// template bound by digest to exactly one promote -> observe -> withdraw operation.
//
// It is fail-closed and authorizes NOTHING: `authorization` is the constant NONE, `status` is PENDING,
// and every emitted template field stays PENDING. EXECUTION_AUTHORIZATION_TEMPLATE_READY means only
// that the offline evidence is valid, cross-bound, and safe to hand to a human -- NOT that the run is
// approved or may proceed. The promote-observe-withdraw run itself remains a separate human operator
// step that is not performed or authorized here.
//
// Boundary: it reads parsed JSON only. It performs no promotion, never runs the real-library promotion
// launcher, never reads or writes the real Movies library, never contacts Jellyfin, and never reads the
// secret approval file -- it operates purely on the redaction-safe evidence artifacts. The emitted
// report is redaction-safe: it echoes only digests, fixed codes, per-check booleans, and counts, never a
// raw path, raw item id, raw approval id, or checksum-bearing source string.
//
// The exact-operation binding is the point of the gate. The prepared live-preflight PLAN carries, for
// its one item, the raw approvalId + itemId and the source/destination sha256 digests. This gate
// recomputes the approval-scope digests of that raw approvalId/itemId under the SAME scopes the approval
// attestation uses (see promotion-approval.ts) and requires them -- plus the source/destination digests
// -- to equal the ones inside the independently-produced approval-attestation evidence. So the plan the
// operator would run and the approval that authorizes it are proven to describe the SAME one item, by
// digest, not by any self-echoed field.

export interface ExecutionAuthorizationInput {
  readonly approvalEvidence?: unknown;     // phase-230-promotion-approval-attestation, mode 'build'
  readonly approvalValidation?: unknown;   // phase-230-promotion-approval-attestation, mode 'validate'
  readonly preflightPlan?: unknown;        // the raw live-preflight plan (input to buildLivePreflightPlan)
  readonly preflightReport?: unknown;      // phase-230-promotion-live-preflight-plan
  readonly preflightSelfDigest?: unknown;  // phase-230-promotion-self-digest-verification over the report
}

// Approval-attestation digest scopes, authoritative from promotion-approval.ts. Used to recompute the
// approval/item digests of the plan's raw approvalId/itemId so they can be bound to the approval evidence.
const APPROVAL_ID_SCOPE = 'phase-230-approval';
const ITEM_SCOPE = 'phase-230-item';

// The single approved real Movies root, per the Phase 229 boundary. The approval evidence records this as
// a fixed enum; anything else fails closed here.
const APPROVED_TARGET_ROOT = '/mnt/user/media/Movies';

export const EXECUTION_AUTHORIZATION_PLACEHOLDER = 'PENDING' as const;

export const EXECUTION_AUTHORIZATION_HUMAN_GATES: readonly string[] = [
  'Human completion of every PENDING field in the emitted execution-authorization template.',
  'Explicit operator sign-off, recorded out-of-band and bound to these exact digests.',
  'Independent human confirmation of observed state before and after, and of a rehearsed withdrawal path.',
  'The promote-observe-withdraw run itself -- a human operator step on the server that is NOT performed or authorized here.',
];

export const EXECUTION_AUTHORIZATION_BOUNDARY =
  'No promotion launcher run, no real Movies library read or write, no live Jellyfin call, no secret approval-file read, and no self-authorization: this gate only validates prepared non-live evidence and emits a NOT-authorized, human-completable template bound by digest to one promote-observe-withdraw operation.';

export const EXECUTION_AUTHORIZATION_DISCLAIMERS: readonly string[] = [
  'EXECUTION_AUTHORIZATION_TEMPLATE_READY means only that the prepared non-live evidence is valid, cross-bound, and safe to hand to a human.',
  'It does NOT authorize, schedule, or perform the promotion; authorization is NONE and every template field stays PENDING.',
  'The promote-observe-withdraw run remains a separate human operator step not performed or authorized here.',
  'This is a redaction-safe, deterministic gate over offline records only; it never reads the secret approval file, the real Movies library, or Jellyfin.',
];

// The bound, NOT-authorized template a human completes to authorize the one operation. Digest-only.
export interface ExecutionAuthorizationTemplate {
  readonly operation: 'promote-observe-withdraw';
  readonly authorization: 'NONE';
  readonly status: 'PENDING';
  readonly targetRootApproved: true;
  readonly approvalIdDigest: string;
  readonly itemDigest: string;
  readonly sourceDigest: string;
  readonly destinationDigest: string;
  readonly planDigest: string;
  readonly fields: {
    readonly operatorAuthorized: typeof EXECUTION_AUTHORIZATION_PLACEHOLDER;
    readonly observedStateWitnessedBefore: typeof EXECUTION_AUTHORIZATION_PLACEHOLDER;
    readonly withdrawalPathRehearsed: typeof EXECUTION_AUTHORIZATION_PLACEHOLDER;
    readonly observedStateWitnessedAfter: typeof EXECUTION_AUTHORIZATION_PLACEHOLDER;
    readonly runExecutedByHuman: typeof EXECUTION_AUTHORIZATION_PLACEHOLDER;
  };
}

export interface ExecutionAuthorizationReport {
  readonly report: 'phase-231-promotion-execution-authorization';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly status: 'PENDING';
  readonly overall: 'EXECUTION_AUTHORIZATION_TEMPLATE_READY' | 'EXECUTION_AUTHORIZATION_BLOCKED';
  readonly approvalEvidenceValid: boolean;
  readonly approvalValidationBound: boolean;
  readonly preflightValid: boolean;
  readonly preflightRederived: boolean;
  readonly selfDigestBound: boolean;
  readonly operationBound: boolean;
  readonly boundDigests: Readonly<Record<string, string>>;
  readonly template: ExecutionAuthorizationTemplate | null;
  readonly humanGates: readonly string[];
  readonly boundary: string;
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly authorizationDigest: string;
}

export function buildExecutionAuthorization(input: ExecutionAuthorizationInput): ExecutionAuthorizationReport {
  const blockers: string[] = [];
  const boundDigests: Record<string, string> = {};

  // (1) Approval-attestation BUILD evidence: present, right report id, mode 'build', self-digest recomputes,
  //     status READY, and target root is the one approved real Movies root.
  const buildEv = validateAttestation(input.approvalEvidence, 'build',
    'APPROVAL_EVIDENCE_MISSING', 'APPROVAL_EVIDENCE_INVALID', 'APPROVAL_EVIDENCE_DIGEST_MISMATCH', 'APPROVAL_EVIDENCE_NOT_READY', blockers);
  if (buildEv.ok) {
    boundDigests['approval-evidence'] = buildEv.digest!;
    if (asString(buildEv.obj.targetRoot) !== APPROVED_TARGET_ROOT) blockers.push('TARGET_ROOT_NOT_APPROVED');
  }
  const approvalEvidenceValid = buildEv.ok && asString(buildEv.obj.targetRoot) === APPROVED_TARGET_ROOT;

  // (2) Approval-attestation VALIDATE evidence: independently re-validated the same secret approval against
  //     the real source. It must recompute, be READY, and carry the SAME binding digests as the build
  //     evidence -- proving both describe the identical one item.
  const valEv = validateAttestation(input.approvalValidation, 'validate',
    'APPROVAL_VALIDATION_MISSING', 'APPROVAL_VALIDATION_INVALID', 'APPROVAL_VALIDATION_DIGEST_MISMATCH', 'APPROVAL_VALIDATION_NOT_READY', blockers);
  if (valEv.ok) boundDigests['approval-validation'] = valEv.digest!;
  let approvalValidationBound = false;
  if (buildEv.ok && valEv.ok) {
    const BIND_FIELDS = ['approvalIdDigest', 'itemDigest', 'sourceRealPathDigest', 'sourceSha256', 'destinationPathDigest'] as const;
    approvalValidationBound = BIND_FIELDS.every((f) => sameString(buildEv.obj[f], valEv.obj[f]));
    if (!approvalValidationBound) blockers.push('APPROVAL_VALIDATION_NOT_BOUND');
  }

  // (3) Live-preflight REPORT: present, right report id, self-digest recomputes, PREFLIGHT_PLAN_VALID,
  //     status PENDING, authorization NONE.
  const report = validatePreflightReport(input.preflightReport, blockers);
  if (report.verified) boundDigests['preflight-report'] = report.digest!;
  const preflightValid = report.ok;

  // (4) Re-derive the report from the raw plan: buildLivePreflightPlan(plan).planDigest must equal the
  //     supplied report's planDigest AND itself be PREFLIGHT_PLAN_VALID. This proves the report is the
  //     honest verification of THIS plan, not a report pasted next to an unrelated plan.
  let preflightRederived = false;
  let rederivedPlanDigest: string | undefined;
  if (input.preflightPlan === undefined) {
    blockers.push('PREFLIGHT_PLAN_MISSING');
  } else {
    const rebuilt = buildLivePreflightPlan({ plan: input.preflightPlan });
    rederivedPlanDigest = rebuilt.planDigest;
    if (rebuilt.overall !== 'PREFLIGHT_PLAN_VALID') blockers.push('PREFLIGHT_PLAN_NOT_VALID');
    else if (report.verified && rebuilt.planDigest !== asString(report.obj.planDigest)) blockers.push('PREFLIGHT_PLAN_NOT_REDERIVED');
    else if (report.ok && rebuilt.planDigest === asString(report.obj.planDigest)) preflightRederived = true;
  }
  if (preflightRederived && rederivedPlanDigest) boundDigests['preflight-plan'] = rederivedPlanDigest;

  // (5) Preflight self-digest: present, right report id, ALL_VERIFIED, and it must be the genuine
  //     self-digest verification of THIS preflight report (re-run verifySelfDigests and compare digest).
  let selfDigestBound = false;
  const sd = asObject(input.preflightSelfDigest);
  if (input.preflightSelfDigest === undefined) {
    blockers.push('PREFLIGHT_SELF_DIGEST_MISSING');
  } else if (sd.report !== 'phase-230-promotion-self-digest-verification') {
    blockers.push('PREFLIGHT_SELF_DIGEST_INVALID');
  } else if (sd.overall !== 'ALL_VERIFIED') {
    blockers.push('PREFLIGHT_SELF_DIGEST_NOT_ALL_VERIFIED');
  } else if (verifySelfDigests([sd]).results[0]?.verified !== true) {
    blockers.push('PREFLIGHT_SELF_DIGEST_DIGEST_MISMATCH');
  } else if (report.verified) {
    const expected = verifySelfDigests([report.obj]);
    if (asSha256(sd.verifierDigest) === expected.verifierDigest && expected.overall === 'ALL_VERIFIED') {
      selfDigestBound = true;
      boundDigests['preflight-self-digest'] = expected.verifierDigest;
    } else {
      blockers.push('PREFLIGHT_SELF_DIGEST_NOT_BOUND');
    }
  }

  // (6) The one-shot exact-operation binding: the plan must describe exactly ONE item whose approval/item/
  //     source/destination digests equal the approval-evidence bindings. This is what makes the promotion
  //     the operator would run provably the SAME one item the approval authorizes.
  let operationBound = false;
  let templateDigests: { approvalIdDigest: string; itemDigest: string; sourceDigest: string; destinationDigest: string } | undefined;
  const items = Array.isArray(asObject(input.preflightPlan).items) ? (asObject(input.preflightPlan).items as unknown[]) : null;
  if (items === null || items.length !== 1) {
    blockers.push('ITEM_COUNT_NOT_ONE');
  } else if (approvalEvidenceValid) {
    const it = asObject(items[0]);
    const planApprovalIdDigest = digest(APPROVAL_ID_SCOPE, asString(it.approvalId) ?? ' ');
    const planItemDigest = digest(ITEM_SCOPE, asString(it.itemId) ?? ' ');
    const planSourceDigest = asSha256(it.sourceDigest);
    const planDestinationDigest = asSha256(it.destinationDigest);
    const approvalMatch = planApprovalIdDigest === asSha256(buildEv.obj.approvalIdDigest);
    const itemMatch = planItemDigest === asSha256(buildEv.obj.itemDigest);
    const sourceMatch = planSourceDigest !== undefined && planSourceDigest === asSha256(buildEv.obj.sourceRealPathDigest);
    const destinationMatch = planDestinationDigest !== undefined && planDestinationDigest === asSha256(buildEv.obj.destinationPathDigest);
    if (!approvalMatch) blockers.push('OPERATION_APPROVAL_ID_MISMATCH');
    if (!itemMatch) blockers.push('OPERATION_ITEM_ID_MISMATCH');
    if (!sourceMatch) blockers.push('OPERATION_SOURCE_DIGEST_MISMATCH');
    if (!destinationMatch) blockers.push('OPERATION_DESTINATION_DIGEST_MISMATCH');
    operationBound = approvalMatch && itemMatch && sourceMatch && destinationMatch;
    if (operationBound) {
      templateDigests = {
        approvalIdDigest: planApprovalIdDigest,
        itemDigest: planItemDigest,
        sourceDigest: planSourceDigest!,
        destinationDigest: planDestinationDigest!,
      };
    }
  }

  const uniqueBlockers = [...new Set(blockers)];
  const ready = uniqueBlockers.length === 0
    && approvalEvidenceValid && approvalValidationBound && preflightValid
    && preflightRederived && selfDigestBound && operationBound;
  const overall: ExecutionAuthorizationReport['overall'] = ready ? 'EXECUTION_AUTHORIZATION_TEMPLATE_READY' : 'EXECUTION_AUTHORIZATION_BLOCKED';

  // Fail closed: only emit the bound template when every gate is green. When blocked, template is null.
  const template: ExecutionAuthorizationTemplate | null = (ready && templateDigests && rederivedPlanDigest)
    ? {
        operation: 'promote-observe-withdraw',
        authorization: 'NONE',
        status: 'PENDING',
        targetRootApproved: true,
        approvalIdDigest: templateDigests.approvalIdDigest,
        itemDigest: templateDigests.itemDigest,
        sourceDigest: templateDigests.sourceDigest,
        destinationDigest: templateDigests.destinationDigest,
        planDigest: rederivedPlanDigest,
        fields: {
          operatorAuthorized: EXECUTION_AUTHORIZATION_PLACEHOLDER,
          observedStateWitnessedBefore: EXECUTION_AUTHORIZATION_PLACEHOLDER,
          withdrawalPathRehearsed: EXECUTION_AUTHORIZATION_PLACEHOLDER,
          observedStateWitnessedAfter: EXECUTION_AUTHORIZATION_PLACEHOLDER,
          runExecutedByHuman: EXECUTION_AUTHORIZATION_PLACEHOLDER,
        },
      }
    : null;

  const withoutDigest: Omit<ExecutionAuthorizationReport, 'authorizationDigest'> = {
    report: 'phase-231-promotion-execution-authorization',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    status: 'PENDING',
    overall,
    approvalEvidenceValid,
    approvalValidationBound,
    preflightValid,
    preflightRederived,
    selfDigestBound,
    operationBound,
    boundDigests,
    template,
    humanGates: EXECUTION_AUTHORIZATION_HUMAN_GATES,
    boundary: EXECUTION_AUTHORIZATION_BOUNDARY,
    blockers: uniqueBlockers,
    disclaimers: EXECUTION_AUTHORIZATION_DISCLAIMERS,
  };
  return { ...withoutDigest, authorizationDigest: digest('phase-231-execution-authorization', JSON.stringify(withoutDigest)) };
}

interface ValidatedAttestation { readonly obj: Record<string, unknown>; readonly verified: boolean; readonly ok: boolean; readonly digest: string | undefined; }

// Present + right report id + expected mode + self-digest recomputes + status READY. `verified` means the
// self-digest recomputes (so its bindings may be trusted); `ok` also requires READY.
function validateAttestation(value: unknown, expectMode: 'build' | 'validate',
  missing: string, invalid: string, mismatch: string, notReady: string, blockers: string[]): ValidatedAttestation {
  if (value === undefined) { blockers.push(missing); return { obj: {}, verified: false, ok: false, digest: undefined }; }
  const obj = asObject(value);
  if (obj.report !== 'phase-230-promotion-approval-attestation' || obj.mode !== expectMode) {
    blockers.push(invalid); return { obj, verified: false, ok: false, digest: undefined };
  }
  const stated = asSha256(obj.evidenceDigest);
  const verified = stated !== undefined && verifySelfDigests([obj]).results[0]?.verified === true;
  if (!verified) blockers.push(mismatch);
  const ready = obj.status === 'APPROVAL_ATTESTATION_READY' && obj.ok === true;
  if (!ready) blockers.push(notReady);
  return { obj, verified, ok: verified && ready, digest: verified ? stated : undefined };
}

function validatePreflightReport(value: unknown, blockers: string[]): ValidatedAttestation {
  if (value === undefined) { blockers.push('PREFLIGHT_REPORT_MISSING'); return { obj: {}, verified: false, ok: false, digest: undefined }; }
  const obj = asObject(value);
  if (obj.report !== 'phase-230-promotion-live-preflight-plan') {
    blockers.push('PREFLIGHT_REPORT_INVALID'); return { obj, verified: false, ok: false, digest: undefined };
  }
  const stated = asSha256(obj.planDigest);
  const verified = stated !== undefined && verifySelfDigests([obj]).results[0]?.verified === true;
  if (!verified) blockers.push('PREFLIGHT_REPORT_DIGEST_MISMATCH');
  const green = obj.overall === 'PREFLIGHT_PLAN_VALID';
  if (!green) blockers.push('PREFLIGHT_REPORT_NOT_VALID');
  if (obj.status !== 'PENDING') blockers.push('PREFLIGHT_REPORT_NOT_PENDING');
  if (obj.authorization !== 'NONE') blockers.push('PREFLIGHT_REPORT_AUTHORIZATION_NOT_NONE');
  const ok = verified && green && obj.status === 'PENDING' && obj.authorization === 'NONE';
  return { obj, verified, ok, digest: verified ? stated : undefined };
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
function sameString(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a === b;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
