import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';
import { buildNoLiveAuthorizationGuard } from './promotion-no-live-authorization-guard.js';

// Local, non-live OPERATOR ACCEPTANCE TRACE. It aggregates the four launch-proofing guard artifacts -- the
// approval-request packet, the live-execution preflight plan, the no-live authorization guard, and the
// coordinator review checklist v2 -- into ONE redaction-safe trace for a human coordinator. It re-verifies
// each component (recompute its self-digest, confirm its report id and green status), re-runs the no-live
// guard over every component as defence in depth, and emits only report ids, component digests, counts,
// fixed statuses/labels, blockers, and a readiness DECISION. It reads parsed JSON only; it performs no
// promotion, never touches the real Movies root, never contacts Jellyfin, and `authorization` is the
// constant NONE with `status` PENDING. ACCEPTANCE_TRACE_READY means the machine-side evidence is assembled
// for human review -- it is NOT an approval and does not authorize Phase 231 or any live promotion.

export interface OperatorAcceptanceTraceInput {
  readonly approvalRequest?: unknown;    // phase-230-promotion-approval-request-packet (APPROVAL_REQUEST_READY)
  readonly livePreflight?: unknown;      // phase-230-promotion-live-preflight-plan (PREFLIGHT_PLAN_VALID)
  readonly noLiveGuard?: unknown;        // phase-230-promotion-no-live-authorization-guard (NO_LIVE_AUTHORIZATION_CLEAN)
  readonly reviewChecklistV2?: unknown;  // phase-230-promotion-coordinator-review-checklist-v2 (CHECKLIST_READY)
}

export const ACCEPTANCE_TRACE_DISCLAIMERS: readonly string[] = [
  'ACCEPTANCE_TRACE_READY means the machine-side evidence is assembled for human review; it is NOT an approval.',
  'status is PENDING and authorization is NONE.',
  'It does NOT authorize Phase 231, live promotion, or any merge/tag/master action.',
  'The only next step is a human, item-specific approval recorded later -- never live execution here.',
  'No live Jellyfin call, network call, or real Movies write is implied or performed by this trace.',
];

export interface TraceComponent {
  readonly key: string;
  readonly reportId: string;
  readonly ok: boolean;
  readonly digest: string | null;
}

export interface OperatorAcceptanceTraceReport {
  readonly report: 'phase-230-promotion-operator-acceptance-trace';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly status: 'PENDING';
  readonly overall: 'ACCEPTANCE_TRACE_READY' | 'ACCEPTANCE_TRACE_BLOCKED';
  readonly reviewedCommit: string | null;
  readonly componentCount: number;
  readonly components: readonly TraceComponent[];
  readonly reportIds: readonly string[];
  readonly selfDigestOverall: string;
  readonly decision: 'AWAITING_HUMAN_ITEM_APPROVAL' | 'BLOCKED_PENDING_REMEDIATION';
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly traceDigest: string;
}

const APPROVAL_ID = 'phase-230-promotion-approval-request-packet';
const PREFLIGHT_ID = 'phase-230-promotion-live-preflight-plan';
const NO_LIVE_ID = 'phase-230-promotion-no-live-authorization-guard';
const CHECKLIST_ID = 'phase-230-promotion-coordinator-review-checklist-v2';

export function buildOperatorAcceptanceTrace(input: OperatorAcceptanceTraceInput): OperatorAcceptanceTraceReport {
  const blockers: string[] = [];
  const components: TraceComponent[] = [];

  const approval = verifyComponent(input.approvalRequest, APPROVAL_ID, 'packetDigest',
    (o) => o.overall === 'APPROVAL_REQUEST_READY' && o.status === 'PENDING' && o.authorization === 'NONE',
    'approval-request', 'APPROVAL_REQUEST_MISSING', 'APPROVAL_REQUEST_INVALID', 'APPROVAL_REQUEST_NOT_READY', blockers, components);
  const preflight = verifyComponent(input.livePreflight, PREFLIGHT_ID, 'planDigest',
    (o) => o.overall === 'PREFLIGHT_PLAN_VALID' && o.authorization === 'NONE',
    'live-preflight', 'LIVE_PREFLIGHT_MISSING', 'LIVE_PREFLIGHT_INVALID', 'LIVE_PREFLIGHT_NOT_VALID', blockers, components);
  verifyComponent(input.noLiveGuard, NO_LIVE_ID, 'noLiveDigest',
    (o) => o.overall === 'NO_LIVE_AUTHORIZATION_CLEAN',
    'no-live-guard', 'NO_LIVE_GUARD_MISSING', 'NO_LIVE_GUARD_INVALID', 'NO_LIVE_GUARD_VIOLATED', blockers, components);
  verifyComponent(input.reviewChecklistV2, CHECKLIST_ID, 'checklistV2Digest',
    (o) => o.overall === 'CHECKLIST_READY' && o.status === 'PENDING' && o.authorization === 'NONE',
    'review-checklist-v2', 'CHECKLIST_MISSING', 'CHECKLIST_INVALID', 'CHECKLIST_NOT_READY', blockers, components);

  // Every live-preflight item must still be PENDING (never pre-approved), even when the plan is valid.
  if (preflight.ok) {
    const items = Array.isArray(asObject(input.livePreflight).items) ? asObject(input.livePreflight).items as unknown[] : [];
    if (!items.every((it) => asObject(it).approvalPending === true)) blockers.push('LIVE_PREFLIGHT_ITEM_NOT_PENDING');
  }

  // Defence in depth: no component may claim a live authorization anywhere in its body.
  const presentComponents = [input.approvalRequest, input.livePreflight, input.noLiveGuard, input.reviewChecklistV2].filter((c) => c !== undefined);
  if (presentComponents.length > 0 && buildNoLiveAuthorizationGuard({ artifacts: presentComponents }).overall !== 'NO_LIVE_AUTHORIZATION_CLEAN') {
    blockers.push('LIVE_AUTHORIZATION_CLAIMED');
  }

  const selfDigestOverall = presentComponents.length > 0 ? verifySelfDigests(presentComponents).overall : 'NO_REPORTS';

  const reviewedCommit = approval.ok ? asSha40(asObject(input.approvalRequest).reviewedCommit) ?? null : null;
  const reportIds = components.filter((c) => c.ok).map((c) => c.reportId);

  const uniqueBlockers = [...new Set(blockers)];
  const overall: OperatorAcceptanceTraceReport['overall'] = uniqueBlockers.length === 0 ? 'ACCEPTANCE_TRACE_READY' : 'ACCEPTANCE_TRACE_BLOCKED';
  const withoutDigest: Omit<OperatorAcceptanceTraceReport, 'traceDigest'> = {
    report: 'phase-230-promotion-operator-acceptance-trace',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    status: 'PENDING',
    overall,
    reviewedCommit: overall === 'ACCEPTANCE_TRACE_READY' ? reviewedCommit : null,
    componentCount: components.length,
    components,
    reportIds,
    selfDigestOverall,
    decision: overall === 'ACCEPTANCE_TRACE_READY' ? 'AWAITING_HUMAN_ITEM_APPROVAL' : 'BLOCKED_PENDING_REMEDIATION',
    blockers: uniqueBlockers,
    disclaimers: ACCEPTANCE_TRACE_DISCLAIMERS,
  };
  return { ...withoutDigest, traceDigest: digest('phase-230-operator-acceptance-trace', JSON.stringify(withoutDigest)) };
}

function verifyComponent(value: unknown, reportId: string, digestField: string, green: (o: Record<string, unknown>) => boolean,
  key: string, missing: string, invalid: string, notOk: string, blockers: string[], components: TraceComponent[]): { ok: boolean } {
  if (value === undefined) { blockers.push(missing); components.push({ key, reportId, ok: false, digest: null }); return { ok: false }; }
  const o = asObject(value);
  if (o.report !== reportId) { blockers.push(invalid); components.push({ key, reportId, ok: false, digest: null }); return { ok: false }; }
  const stated = asSha256(o[digestField]);
  const verified = stated !== undefined && verifySelfDigests([o]).results[0]?.verified === true;
  if (!verified) { blockers.push('COMPONENT_DIGEST_UNVERIFIED'); components.push({ key, reportId, ok: false, digest: null }); return { ok: false }; }
  if (!green(o)) { blockers.push(notOk); components.push({ key, reportId, ok: false, digest: stated }); return { ok: false }; }
  components.push({ key, reportId, ok: true, digest: stated });
  return { ok: true };
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asSha256(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}
function asSha40(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value : undefined;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
