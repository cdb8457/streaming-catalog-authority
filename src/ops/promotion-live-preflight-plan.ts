import { createHash } from 'node:crypto';

// Local, non-live LIVE-EXECUTION preflight plan validator. It validates a PROPOSED future live run plan as
// DATA ONLY -- it never executes, schedules, or authorizes anything. A valid plan must: carry per-item
// approval placeholders that are still PENDING (never pre-approved); bind each item to exact source AND
// destination sha256 digests; declare a no-clobber + same-checksum policy; require an observed-state check;
// and declare rollback + withdrawal constraints. It fails closed on any raw path / Jellyfin / network / media
// surface anywhere in the plan. It reads parsed JSON only; it performs no promotion, never touches the real
// Movies root, never contacts Jellyfin, and `authorization` is the constant NONE. PLAN_VALID means the plan
// is well-formed and safe to hand to a human -- NOT that it is approved or may run. It echoes only item
// counts, per-item booleans, and fixed codes -- never a raw path.

export interface LivePreflightPlanInput { readonly plan?: unknown; }

const ALLOWED_ITEM_STATUS: readonly string[] = ['PENDING'];

export const LIVE_PREFLIGHT_DISCLAIMERS: readonly string[] = [
  'PLAN_VALID validates a proposed plan as data only; it does NOT execute, schedule, approve, or authorize it.',
  'Every item approval stays PENDING; authorization is NONE.',
  'It does NOT authorize Phase 231, live promotion, or any merge/tag/master action.',
  'No live Jellyfin call, network call, or real Movies write is implied or performed by this validator.',
];

export interface ItemCheck {
  readonly index: number;
  readonly approvalPending: boolean;
  readonly sourceBound: boolean;
  readonly destinationBound: boolean;
}

export interface LivePreflightPlanReport {
  readonly report: 'phase-230-promotion-live-preflight-plan';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly status: 'PENDING';
  readonly overall: 'PREFLIGHT_PLAN_VALID' | 'PREFLIGHT_PLAN_INVALID';
  readonly itemCount: number;
  readonly items: readonly ItemCheck[];
  readonly policyChecks: readonly { readonly policy: string; readonly ok: boolean }[];
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly planDigest: string;
}

export function buildLivePreflightPlan(input: LivePreflightPlanInput): LivePreflightPlanReport {
  const blockers: string[] = [];
  const plan = asObject(input.plan);

  if (input.plan === undefined || typeof input.plan !== 'object' || Array.isArray(input.plan)) blockers.push('PLAN_MISSING');

  // Live-surface escape: ANY string anywhere in the plan that names a live / network / media surface or raw path.
  if (deepLiveSurface(input.plan)) blockers.push('LIVE_SURFACE_IN_PLAN');

  // Plan-level policy requirements.
  const policyChecks: { policy: string; ok: boolean }[] = [];
  const req = (policy: string, ok: boolean, code: string): void => { policyChecks.push({ policy, ok }); if (!ok) blockers.push(code); };
  req('no-clobber', plan.noClobber === true, 'NO_CLOBBER_POLICY_MISSING');
  req('same-checksum', plan.sameChecksum === true, 'SAME_CHECKSUM_POLICY_MISSING');
  req('observed-state-required', plan.observedStateRequired === true, 'OBSERVED_STATE_NOT_REQUIRED');
  req('rollback-constraint', isConstraint(plan.rollback), 'ROLLBACK_CONSTRAINT_MISSING');
  req('withdrawal-constraint', isConstraint(plan.withdrawal), 'WITHDRAWAL_CONSTRAINT_MISSING');

  // Per-item requirements: PENDING approval field + exact source/destination sha256 digest bindings.
  const rawItems = Array.isArray(plan.items) ? plan.items : null;
  if (rawItems === null || rawItems.length === 0) blockers.push('NO_ITEMS');
  const items: ItemCheck[] = (rawItems ?? []).map((it, index) => {
    const o = asObject(it);
    const approvalStatus = typeof o.approvalStatus === 'string' ? o.approvalStatus : null;
    const hasApprovalField = o.approvalId !== undefined && approvalStatus !== null;
    const approvalPending = hasApprovalField && ALLOWED_ITEM_STATUS.includes(approvalStatus!);
    const sourceBound = asSha256(o.sourceDigest) !== undefined;
    const destinationBound = asSha256(o.destinationDigest) !== undefined;
    if (!hasApprovalField) blockers.push('ITEM_APPROVAL_FIELD_MISSING');
    else if (!approvalPending) blockers.push('ITEM_NOT_PENDING');
    if (!sourceBound) blockers.push('SOURCE_DIGEST_MISSING');
    if (!destinationBound) blockers.push('DESTINATION_DIGEST_MISSING');
    return { index, approvalPending, sourceBound, destinationBound };
  });

  const uniqueBlockers = [...new Set(blockers)];
  const overall: LivePreflightPlanReport['overall'] = uniqueBlockers.length === 0 ? 'PREFLIGHT_PLAN_VALID' : 'PREFLIGHT_PLAN_INVALID';
  const withoutDigest: Omit<LivePreflightPlanReport, 'planDigest'> = {
    report: 'phase-230-promotion-live-preflight-plan',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    status: 'PENDING',
    overall,
    itemCount: items.length,
    items,
    policyChecks,
    blockers: uniqueBlockers,
    disclaimers: LIVE_PREFLIGHT_DISCLAIMERS,
  };
  return { ...withoutDigest, planDigest: digest('phase-230-live-preflight-plan', JSON.stringify(withoutDigest)) };
}

function isConstraint(value: unknown): boolean {
  const o = asObject(value);
  return value !== undefined && typeof value === 'object' && !Array.isArray(value) && Object.keys(o).length > 0;
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
// The plan is a parsed-JSON / built object (acyclic finite tree), so this scan has NO depth cutoff -- a live
// surface or raw path buried at any depth fails closed.
function deepLiveSurface(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0 && (isLiveSurface(value) || pathBearing(value));
  if (Array.isArray(value)) return value.some((v) => deepLiveSurface(v));
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some((v) => deepLiveSurface(v));
  return false;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
