import { createHash } from 'node:crypto';

// Local, non-live FINAL no-live-authorization guard. Any Phase 230/231-ish artifact that CLAIMS a live
// authorization -- an `authorization` / `status` / `overall` of APPROVED, EXECUTE, LIVE_READY,
// PHASE_231_AUTHORIZED or GRANTED, a truthy approved / execute / liveReady / phase231Authorized flag, or one
// of those exact tokens anywhere in its body -- fails closed, UNLESS it is explicitly a PENDING human gate
// doc (`humanGate: true`, `status: 'PENDING'`, `authorization` NONE/PENDING), which may LIST those tokens as
// pending steps. It reads parsed JSON only; it performs no promotion, never touches the real Movies root,
// never contacts Jellyfin, and `authorization` is the constant NONE. It echoes only report short-names and
// booleans -- never the offending value.

export interface NoLiveAuthorizationGuardInput { readonly artifacts?: unknown; }

// The exact live-authorization claim tokens. (Deliberately NOT 'AUTHORIZED' alone, so LOCAL_REVIEW_AUTHORIZED
// and prose like "Phase 231 authorization is NOT granted" are not flagged.)
const FORBIDDEN_TOKENS: readonly string[] = ['APPROVED', 'EXECUTE', 'LIVE_READY', 'PHASE_231_AUTHORIZED', 'GRANTED'];
const CLAIM_FLAGS: readonly string[] = ['approved', 'execute', 'liveReady', 'phase231Authorized', 'liveAuthorized'];
const ALLOWED_AUTHORIZATION: readonly string[] = ['NONE', 'PENDING'];

export interface ArtifactVerdict { readonly artifact: string; readonly claimsLiveAuthorization: boolean; readonly pendingGateExempt: boolean; }

export interface NoLiveAuthorizationGuardReport {
  readonly report: 'phase-230-promotion-no-live-authorization-guard';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'NO_LIVE_AUTHORIZATION_CLEAN' | 'NO_LIVE_AUTHORIZATION_VIOLATED';
  readonly artifactCount: number;
  readonly verdicts: readonly ArtifactVerdict[];
  readonly blockers: readonly string[];
  readonly noLiveDigest: string;
}

export function buildNoLiveAuthorizationGuard(input: NoLiveAuthorizationGuardInput): NoLiveAuthorizationGuardReport {
  const blockers: string[] = [];
  const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
  if (artifacts.length === 0) blockers.push('NO_ARTIFACTS');

  const verdicts: ArtifactVerdict[] = artifacts.map((a, i) => {
    const o = asObject(a);
    const id = typeof o.report === 'string' ? o.report.replace(/^phase-230-promotion-/, '') : `artifact-${i}`;
    const pendingGateExempt = o.humanGate === true && o.status === 'PENDING'
      && typeof o.authorization === 'string' && ALLOWED_AUTHORIZATION.includes(o.authorization);
    const claim = hasClaim(o);
    const claimsLiveAuthorization = claim && !pendingGateExempt;
    if (claimsLiveAuthorization) blockers.push('LIVE_AUTHORIZATION_CLAIMED');
    return { artifact: id, claimsLiveAuthorization, pendingGateExempt };
  });

  const uniqueBlockers = [...new Set(blockers)];
  const overall: NoLiveAuthorizationGuardReport['overall'] = uniqueBlockers.length === 0 ? 'NO_LIVE_AUTHORIZATION_CLEAN' : 'NO_LIVE_AUTHORIZATION_VIOLATED';
  const withoutDigest: Omit<NoLiveAuthorizationGuardReport, 'noLiveDigest'> = {
    report: 'phase-230-promotion-no-live-authorization-guard',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    artifactCount: verdicts.length,
    verdicts,
    blockers: uniqueBlockers,
  };
  return { ...withoutDigest, noLiveDigest: digest('phase-230-no-live-authorization-guard', JSON.stringify(withoutDigest)) };
}

// A live-authorization CLAIM: a forbidden token as authorization/status/overall, a truthy claim flag, or one
// of the exact tokens present anywhere in the body.
function hasClaim(o: Record<string, unknown>): boolean {
  for (const field of ['authorization', 'status', 'overall']) {
    if (typeof o[field] === 'string' && FORBIDDEN_TOKENS.includes(o[field] as string)) return true;
  }
  for (const flag of CLAIM_FLAGS) if (o[flag] === true) return true;
  return deepHasToken(o, 0);
}
function deepHasToken(value: unknown, depth: number): boolean {
  if (depth > 8) return false;
  if (typeof value === 'string') return FORBIDDEN_TOKENS.includes(value);
  if (Array.isArray(value)) return value.some((v) => deepHasToken(v, depth + 1));
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some((v) => deepHasToken(v, depth + 1));
  return false;
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
