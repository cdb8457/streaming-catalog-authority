import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';
import { buildNoLiveAuthorizationGuard } from './promotion-no-live-authorization-guard.js';

// Local, non-live FINAL coordinator readiness bundle. It consumes the operator acceptance trace, the no-live
// authorization guard, the live-execution preflight plan, the approval-request packet, the coordinator review
// checklist v2, and the self-digest verification output, re-verifies each (recompute self-digest + green
// status), and produces ONE compact coordinator-facing artifact: the reviewed commit, the component report
// ids / digests / counts, the open blockers + required human decisions, an explicit CLOSED live-boundary
// status, Phase 231 authorization NONE, and a next action limited to a human item-specific approval later --
// never live execution. It reads parsed JSON only; it performs no promotion, never touches the real Movies
// root, never contacts Jellyfin, and `authorization` is the constant NONE with `status` PENDING.
// FINAL_READINESS_BUNDLE_READY means the machine-side evidence is assembled for human review -- it is NOT an
// approval and does not authorize Phase 231 or any live promotion.

export interface FinalReadinessBundleInput {
  readonly acceptanceTrace?: unknown;    // phase-230-promotion-operator-acceptance-trace (ACCEPTANCE_TRACE_READY)
  readonly noLiveGuard?: unknown;        // phase-230-promotion-no-live-authorization-guard (NO_LIVE_AUTHORIZATION_CLEAN)
  readonly livePreflight?: unknown;      // phase-230-promotion-live-preflight-plan (PREFLIGHT_PLAN_VALID)
  readonly approvalRequest?: unknown;    // phase-230-promotion-approval-request-packet (APPROVAL_REQUEST_READY)
  readonly reviewChecklistV2?: unknown;  // phase-230-promotion-coordinator-review-checklist-v2 (CHECKLIST_READY)
  readonly selfDigest?: unknown;         // phase-230-promotion-self-digest-verification (ALL_VERIFIED)
}

export const FINAL_READINESS_HUMAN_DECISIONS: readonly string[] = [
  'Human review of the reviewed commit range and diff.',
  'Human confirmation of the observed local state.',
  'Human, item-specific approval for each proposed source-to-destination binding (still PENDING).',
  'Explicit coordinator ACCEPT recorded via the acceptance seal.',
  'The merge / tag / push-to-master action itself -- a human operator step NOT performed here.',
  'Phase 231 authorization, which is NOT granted by any tool, doc, or artifact here.',
];

export const FINAL_READINESS_DISCLAIMERS: readonly string[] = [
  'FINAL_READINESS_BUNDLE_READY means the machine-side evidence is assembled for human review; it is NOT an approval.',
  'status is PENDING, authorization is NONE, and the live boundary is CLOSED.',
  'It does NOT authorize Phase 231, live promotion, or any merge/tag/master action.',
  'The only next action is a human, item-specific approval recorded later -- never live execution here.',
];

export interface BundleComponent { readonly key: string; readonly reportId: string; readonly ok: boolean; readonly digest: string | null; }

export interface FinalReadinessBundleReport {
  readonly report: 'phase-230-promotion-final-coordinator-readiness-bundle';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly status: 'PENDING';
  readonly overall: 'FINAL_READINESS_BUNDLE_READY' | 'FINAL_READINESS_BUNDLE_BLOCKED';
  readonly reviewedCommit: string | null;
  readonly componentCount: number;
  readonly components: readonly BundleComponent[];
  readonly reportIds: readonly string[];
  readonly openBlockers: readonly string[];
  readonly requiredHumanDecisions: readonly string[];
  readonly liveBoundaryStatus: 'CLOSED';
  readonly phase231Authorization: 'NONE';
  readonly nextAction: 'AWAIT_HUMAN_ITEM_SPECIFIC_APPROVAL' | 'REMEDIATE_BLOCKERS';
  readonly disclaimers: readonly string[];
  readonly readinessBundleDigest: string;
}

const TRACE_ID = 'phase-230-promotion-operator-acceptance-trace';
const NO_LIVE_ID = 'phase-230-promotion-no-live-authorization-guard';
const PREFLIGHT_ID = 'phase-230-promotion-live-preflight-plan';
const APPROVAL_ID = 'phase-230-promotion-approval-request-packet';
const CHECKLIST_ID = 'phase-230-promotion-coordinator-review-checklist-v2';
const SELF_DIGEST_ID = 'phase-230-promotion-self-digest-verification';

export function buildFinalCoordinatorReadinessBundle(input: FinalReadinessBundleInput): FinalReadinessBundleReport {
  const blockers: string[] = [];
  const components: BundleComponent[] = [];

  const trace = verifyComponent(input.acceptanceTrace, TRACE_ID, 'traceDigest',
    (o) => o.overall === 'ACCEPTANCE_TRACE_READY' && o.status === 'PENDING' && o.authorization === 'NONE',
    'acceptance-trace', 'ACCEPTANCE_TRACE_MISSING', 'ACCEPTANCE_TRACE_INVALID', 'ACCEPTANCE_TRACE_NOT_READY', blockers, components);
  const noLive = verifyComponent(input.noLiveGuard, NO_LIVE_ID, 'noLiveDigest',
    (o) => o.overall === 'NO_LIVE_AUTHORIZATION_CLEAN',
    'no-live-guard', 'NO_LIVE_GUARD_MISSING', 'NO_LIVE_GUARD_INVALID', 'NO_LIVE_GUARD_VIOLATED', blockers, components);
  const preflight = verifyComponent(input.livePreflight, PREFLIGHT_ID, 'planDigest',
    (o) => o.overall === 'PREFLIGHT_PLAN_VALID' && o.authorization === 'NONE',
    'live-preflight', 'LIVE_PREFLIGHT_MISSING', 'LIVE_PREFLIGHT_INVALID', 'LIVE_PREFLIGHT_NOT_VALID', blockers, components);
  const approval = verifyComponent(input.approvalRequest, APPROVAL_ID, 'packetDigest',
    (o) => o.overall === 'APPROVAL_REQUEST_READY' && o.status === 'PENDING' && o.authorization === 'NONE',
    'approval-request', 'APPROVAL_REQUEST_MISSING', 'APPROVAL_REQUEST_INVALID', 'APPROVAL_REQUEST_NOT_READY', blockers, components);
  const checklist = verifyComponent(input.reviewChecklistV2, CHECKLIST_ID, 'checklistV2Digest',
    (o) => o.overall === 'CHECKLIST_READY' && o.status === 'PENDING' && o.authorization === 'NONE',
    'review-checklist-v2', 'CHECKLIST_MISSING', 'CHECKLIST_INVALID', 'CHECKLIST_NOT_READY', blockers, components);
  const selfD = verifyComponent(input.selfDigest, SELF_DIGEST_ID, 'verifierDigest',
    (o) => o.overall === 'ALL_VERIFIED',
    'self-digest', 'SELF_DIGEST_MISSING', 'SELF_DIGEST_INVALID', 'SELF_DIGEST_NOT_VERIFIED', blockers, components);

  // Observed-state requirement must be present in the preflight plan policy checks.
  if (preflight.ok) {
    const checks = Array.isArray(asObject(input.livePreflight).policyChecks) ? asObject(input.livePreflight).policyChecks as unknown[] : [];
    const observed = checks.some((c) => asObject(c).policy === 'observed-state-required' && asObject(c).ok === true);
    if (!observed) blockers.push('OBSERVED_STATE_REQUIREMENT_MISSING');
  }

  // COORDINATOR BINDING: individually-green components are not enough -- they must be the SAME evidence. The
  // acceptance trace's recorded per-component self-digests must EXACTLY equal the directly-supplied component
  // digests (so a genuine READY trace cannot be paired with a mismatched-but-green guard/preflight/approval/
  // checklist), and the reviewed commit the trace carries must equal the approval packet's.
  if (trace.ok && approval.ok && preflight.ok && noLive.ok && checklist.ok) {
    const traceDigests = new Map<string, string | null>();
    for (const c of (Array.isArray(asObject(input.acceptanceTrace).components) ? asObject(input.acceptanceTrace).components as unknown[] : [])) {
      const co = asObject(c);
      if (typeof co.key === 'string') traceDigests.set(co.key, typeof co.digest === 'string' ? co.digest : null);
    }
    const bindings: Array<[string, string | undefined]> = [
      ['approval-request', asSha256(asObject(input.approvalRequest).packetDigest)],
      ['live-preflight', asSha256(asObject(input.livePreflight).planDigest)],
      ['no-live-guard', asSha256(asObject(input.noLiveGuard).noLiveDigest)],
      ['review-checklist-v2', asSha256(asObject(input.reviewChecklistV2).checklistV2Digest)],
    ];
    if (!bindings.every(([key, d]) => d !== undefined && traceDigests.get(key) === d)) blockers.push('ACCEPTANCE_TRACE_COMPONENT_MISMATCH');
    if (asSha40(asObject(input.acceptanceTrace).reviewedCommit) !== asSha40(asObject(input.approvalRequest).reviewedCommit)) blockers.push('REVIEWED_COMMIT_MISMATCH');
  }

  // COORDINATOR BINDING: the supplied self-digest verification must cover EXACTLY the supplied guard
  // components (in canonical order) -- an ALL_VERIFIED report over an unrelated green set does not bind these
  // ones. Recompute over the supplied components and require an exact self-digest match.
  if (selfD.ok && trace.ok && approval.ok && preflight.ok && noLive.ok && checklist.ok) {
    const recomputed = verifySelfDigests([input.approvalRequest, input.livePreflight, input.noLiveGuard, input.reviewChecklistV2, input.acceptanceTrace]);
    if (recomputed.overall !== 'ALL_VERIFIED' || recomputed.verifierDigest !== asSha256(asObject(input.selfDigest).verifierDigest)) blockers.push('SELF_DIGEST_BINDING_MISMATCH');
  }

  const present = [input.acceptanceTrace, input.noLiveGuard, input.livePreflight, input.approvalRequest, input.reviewChecklistV2, input.selfDigest].filter((c) => c !== undefined);

  // Redaction safety must be proven for every supplied component.
  if (present.length > 0 && !present.every((c) => asObject(c).redactionSafe === true)) blockers.push('REDACTION_NOT_PROVEN');

  // No input may claim an approval / live-ready / execution / Phase 231 authorization anywhere.
  if (present.length > 0 && buildNoLiveAuthorizationGuard({ artifacts: present }).overall !== 'NO_LIVE_AUTHORIZATION_CLEAN') {
    blockers.push('LIVE_AUTHORIZATION_CLAIMED');
  }

  const reviewedCommit = approval.ok ? asSha40(asObject(input.approvalRequest).reviewedCommit) ?? null
    : trace.ok ? asSha40(asObject(input.acceptanceTrace).reviewedCommit) ?? null : null;
  const reportIds = components.filter((c) => c.ok).map((c) => c.reportId);

  const uniqueBlockers = [...new Set(blockers)];
  const overall: FinalReadinessBundleReport['overall'] = uniqueBlockers.length === 0 ? 'FINAL_READINESS_BUNDLE_READY' : 'FINAL_READINESS_BUNDLE_BLOCKED';
  const withoutDigest: Omit<FinalReadinessBundleReport, 'readinessBundleDigest'> = {
    report: 'phase-230-promotion-final-coordinator-readiness-bundle',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    status: 'PENDING',
    overall,
    reviewedCommit: overall === 'FINAL_READINESS_BUNDLE_READY' ? reviewedCommit : null,
    componentCount: components.length,
    components,
    reportIds,
    openBlockers: uniqueBlockers,
    requiredHumanDecisions: FINAL_READINESS_HUMAN_DECISIONS,
    liveBoundaryStatus: 'CLOSED',
    phase231Authorization: 'NONE',
    nextAction: overall === 'FINAL_READINESS_BUNDLE_READY' ? 'AWAIT_HUMAN_ITEM_SPECIFIC_APPROVAL' : 'REMEDIATE_BLOCKERS',
    disclaimers: FINAL_READINESS_DISCLAIMERS,
  };
  return { ...withoutDigest, readinessBundleDigest: digest('phase-230-final-coordinator-readiness-bundle', JSON.stringify(withoutDigest)) };
}

function verifyComponent(value: unknown, reportId: string, digestField: string, green: (o: Record<string, unknown>) => boolean,
  key: string, missing: string, invalid: string, notOk: string, blockers: string[], components: BundleComponent[]): { ok: boolean } {
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
