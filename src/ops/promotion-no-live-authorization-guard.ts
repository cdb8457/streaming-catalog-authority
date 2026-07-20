import { createHash } from 'node:crypto';

// Local, non-live FINAL no-live-authorization guard. Any Phase 230/231-ish artifact that CLAIMS a live
// authorization -- an `authorization` / `status` / `overall` of APPROVED, EXECUTE, LIVE_READY,
// PHASE_231_AUTHORIZED or GRANTED (or a case/separator/affix variant such as approved_for_live,
// phase-231-authorized or live-ready), a truthy approved / execute / liveReady / phase231Authorized flag, or
// one of those tokens anywhere in its body -- fails closed.
//
// The ONLY exemption is a PENDING human gate doc (`humanGate: true`, `status: 'PENDING'`, `authorization`
// NONE/PENDING), and it is DELIBERATELY NARROW: it may LIST the forbidden tokens as textual pending steps
// (a token appearing as prose somewhere in the body), but it may NEVER exempt a HARD claim -- a forbidden
// token used as the value of the `authorization` / `status` / `overall` claim fields, or a truthy claim
// flag, anywhere in the artifact tree (top-level OR nested in a sub-object/array). A hard claim inside a
// human-gate artifact (e.g. `approved: true`, or `gate: { status: 'LIVE_READY' }`) always fails closed, so a
// pending gate cannot smuggle an actual live-authorization claim past the guard.
//
// It reads parsed JSON only; it performs no promotion, never touches the real Movies root, never contacts
// Jellyfin, and `authorization` is the constant NONE. It echoes only report short-names and booleans --
// never the offending value.
//
// TOKEN-MATCHING POLICY (normalization-aware, false-positive-safe):
//  * Tokens are normalized before comparison -- lower-cased, every run of non-alphanumerics collapsed to a
//    single `_`, leading/trailing `_` trimmed. So APPROVED, approved, Approved, live_ready, live-ready,
//    LIVE READY, phase_231_authorized and phase-231-authorized all normalize onto the canonical tokens.
//  * IDENTIFIER-like strings (no interior whitespace -- enum values, flags, standalone list tokens) match on
//    a WORD-BOUNDARY substring, so affixed variants like APPROVED_FOR_LIVE / live-ready-now also fail closed.
//  * PROSE strings (any interior whitespace -- sentences) match ONLY when the WHOLE normalized string equals
//    a canonical token. This is the deliberate exact-token policy for prose: it is what keeps
//    LOCAL_REVIEW_AUTHORIZED (no 'approved'/'granted'... token as a word) and negative prose such as
//    "Phase 231 authorization is NOT granted" from false-positiving -- the sentence never equals a token, and
//    'granted' inside "NOT granted" is not matched as a word because prose is whole-string-only.
//  * The canonical set is deliberately NOT bare 'AUTHORIZED' -- only PHASE_231_AUTHORIZED as a whole token --
//    so LOCAL_REVIEW_AUTHORIZED and "authorization" prose are never flagged.

export interface NoLiveAuthorizationGuardInput { readonly artifacts?: unknown; }

// The canonical live-authorization claim tokens (normalized form). Variants/casings/separators of these are
// matched via `matchesForbidden`. Deliberately NOT bare 'authorized' alone (see policy above).
const FORBIDDEN_TOKENS: readonly string[] = ['approved', 'execute', 'live_ready', 'phase_231_authorized', 'granted'];
const CLAIM_FLAGS: readonly string[] = ['approved', 'execute', 'liveReady', 'phase231Authorized', 'liveAuthorized'];
const ALLOWED_AUTHORIZATION: readonly string[] = ['NONE', 'PENDING'];

// Normalize a token for comparison: lower-case, collapse non-alphanumerics to single `_`, trim `_`.
function normToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
// Does a string value carry a forbidden live-authorization token, per the policy above?
function matchesForbidden(s: string): boolean {
  const norm = normToken(s);
  if (norm === '') return false;
  const identifierLike = !/\s/.test(s.trim());
  const wrapped = `_${norm}_`;
  for (const t of FORBIDDEN_TOKENS) {
    if (norm === t) return true;                                 // whole-string match (prose + identifiers)
    if (identifierLike && wrapped.includes(`_${t}_`)) return true; // word-boundary variant match (identifiers only)
  }
  return false;
}

export interface ArtifactVerdict {
  readonly artifact: string;
  readonly claimsLiveAuthorization: boolean;
  readonly pendingGateExempt: boolean;
  // A hard claim (claim field with a forbidden token, or a truthy claim flag) that fails closed even inside a
  // human gate. When true and the artifact is a human gate, the gate exemption was refused.
  readonly hardClaim: boolean;
}

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
    const isPendingGate = o.humanGate === true && o.status === 'PENDING'
      && typeof o.authorization === 'string' && ALLOWED_AUTHORIZATION.includes(o.authorization);
    // A HARD claim -- claim field with a forbidden token, or a truthy claim flag -- is NEVER exempt.
    const hardClaim = hasHardClaim(o);
    // A TEXTUAL claim -- a forbidden token appearing as prose anywhere in the body -- may be a listed pending
    // step, so the pending human gate may exempt it (but never the hard claim above).
    const textualClaim = deepHasToken(o, 0);
    const pendingGateExempt = isPendingGate && !hardClaim;
    const claimsLiveAuthorization = hardClaim || (textualClaim && !pendingGateExempt);
    if (claimsLiveAuthorization) blockers.push('LIVE_AUTHORIZATION_CLAIMED');
    return { artifact: id, claimsLiveAuthorization, pendingGateExempt, hardClaim };
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

// A HARD live-authorization claim: a forbidden token used as the value of a claim field
// (authorization / status / overall), or a truthy claim flag. Checked RECURSIVELY over the whole artifact
// tree so a claim nested inside a sub-object (e.g. { gate: { approved: true } } or { step: { status:
// 'LIVE_READY' } }) still fails closed. This is never exempt by the human gate. (A forbidden token appearing
// merely as a prose string -- not as a claim-field value or truthy flag -- remains a TEXTUAL claim that a
// pending gate may list.)
const CLAIM_FIELDS: readonly string[] = ['authorization', 'status', 'overall'];
function hasHardClaim(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (Array.isArray(value)) return value.some((v) => hasHardClaim(v, depth + 1));
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  for (const field of CLAIM_FIELDS) {
    if (typeof o[field] === 'string' && matchesForbidden(o[field] as string)) return true;
  }
  for (const flag of CLAIM_FLAGS) if (o[flag] === true) return true;
  return Object.values(o).some((v) => hasHardClaim(v, depth + 1));
}
function deepHasToken(value: unknown, depth: number): boolean {
  if (depth > 8) return false;
  if (typeof value === 'string') return matchesForbidden(value);
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
