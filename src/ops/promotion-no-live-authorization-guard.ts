import { createHash } from 'node:crypto';

// Local, non-live FINAL no-live-authorization guard. Any Phase 230/231-ish artifact that CLAIMS a live
// authorization -- an `authorization` / `status` / `overall` of APPROVED, EXECUTE, LIVE_READY,
// PHASE_231_AUTHORIZED or GRANTED (or a case/separator/affix variant such as approved_for_live,
// phase-231-authorized or live-ready), a truthy approved / execute / liveReady / phase231Authorized flag, or
// one of those tokens anywhere in its body -- fails closed.
//
// The ONLY exemption is a PENDING human gate doc (`humanGate: true`, `status: 'PENDING'`, `authorization`
// NONE/PENDING), and it is DELIBERATELY NARROW: it may LIST the forbidden tokens ONLY as ARRAY ELEMENTS (a
// list of pending step names, e.g. `pendingGates: ['PHASE_231_AUTHORIZED']`) or inside multi-word PROSE. It
// may NEVER exempt a HARD claim -- a forbidden token that is the scalar VALUE of any field (e.g.
// `decision: 'APPROVED'`), a token in a claim-field subtree, a truthy claim flag, or a truthy token-named key
// -- anywhere in the artifact tree (top-level OR nested). A hard claim inside a human-gate artifact always
// fails closed, so a pending gate cannot smuggle an actual live-authorization claim past the guard.
//
// It reads parsed JSON only; it performs no promotion, never touches the real Movies root, never contacts
// Jellyfin, and `authorization` is the constant NONE. It echoes only report short-names and booleans --
// never the offending value.
//
// TOKEN-MATCHING POLICY (normalization-aware, false-positive-safe):
//  * A string is normalized to a WORD-BOUNDARY form -- camelCase / digit boundaries split (LiveReady ->
//    live_ready, phase231Authorized -> phase_231_authorized), lower-cased, every run of non-alphanumerics
//    collapsed to a single `_`, trimmed -- and to a COMPACT form (all non-alphanumerics stripped). So
//    APPROVED, approved, Approved, live_ready, live-ready, LIVE READY, LiveReady, phase_231_authorized and
//    phase-231-authorized all reduce onto the canonical tokens.
//  * A canonical token matches a string when: the whole boundary form equals it, OR the whole compact form
//    equals its compact form (catches separator-free camelCase like LIVEREADY), OR -- for IDENTIFIER-like
//    strings (no interior whitespace: enum values, flags, OBJECT KEYS, standalone list tokens) -- the token
//    appears at a `_`-delimited WORD boundary, so affixed variants like APPROVED_FOR_LIVE also fail closed.
//    The `_`-delimited boundary means `unapproved` / `local_review_authorized` do NOT match `approved`.
//  * PROSE strings (any interior whitespace -- sentences) only ever match on the two WHOLE-string forms; the
//    word-boundary affix rule is identifier-only. This is what keeps LOCAL_REVIEW_AUTHORIZED and negative
//    prose such as "Phase 231 authorization is NOT granted" from false-positiving -- a sentence never equals a
//    token, and 'granted' inside "NOT granted" is not matched as a word because prose is whole-string-only.
//  * The canonical set is deliberately NOT bare 'AUTHORIZED' -- only PHASE_231_AUTHORIZED as a whole token --
//    so LOCAL_REVIEW_AUTHORIZED and "authorization" prose are never flagged.
//  * OBJECT KEYS are matched too: a key that reduces to a forbidden token with a truthy value is a HARD claim
//    ({ live_ready: true }, { approved_for_live: {...} }, { LiveReady: 1 }). Scoped by the same boundary rule,
//    so unrelated review fields (reviewAuthorization, localReviewAuthorized, ...) are not flagged.

export interface NoLiveAuthorizationGuardInput { readonly artifacts?: unknown; }

// The canonical live-authorization claim tokens (word-boundary form). Variants/casings/separators/camelCase of
// these are matched via `matchesForbidden`. Deliberately NOT bare 'authorized' alone (see policy above).
const FORBIDDEN_TOKENS: readonly string[] = ['approved', 'execute', 'live_ready', 'phase_231_authorized', 'granted'];
const CLAIM_FLAGS: readonly string[] = ['approved', 'execute', 'liveReady', 'phase231Authorized', 'liveAuthorized'];
const ALLOWED_AUTHORIZATION: readonly string[] = ['NONE', 'PENDING'];

// Word-boundary normal form: split camelCase + letter/digit boundaries, lower-case, collapse non-alphanumerics
// to single `_`, trim. e.g. 'LiveReady' -> 'live_ready', 'phase231Authorized' -> 'phase_231_authorized'.
function normBoundary(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([a-zA-Z])([0-9])/g, '$1_$2')
    .replace(/([0-9])([a-zA-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
// Compact normal form: strip every non-alphanumeric. e.g. 'LIVEREADY' / 'live-ready' -> 'liveready'.
function compact(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, ''); }

// Does a string (value OR object key) carry a forbidden live-authorization token, per the policy above?
function matchesForbidden(s: string): boolean {
  const boundary = normBoundary(s);
  if (boundary === '') return false;
  const comp = compact(s);
  const identifierLike = !/\s/.test(s.trim());
  const wrapped = `_${boundary}_`;
  for (const t of FORBIDDEN_TOKENS) {
    if (boundary === t) return true;                               // whole boundary match (prose + identifiers)
    if (comp === t.replace(/_/g, '')) return true;                 // whole compact match (separator-free variants)
    if (identifierLike && wrapped.includes(`_${t}_`)) return true; // word-boundary affix match (identifiers only)
  }
  return false;
}
function isTruthy(v: unknown): boolean { return v !== undefined && v !== null && v !== false && v !== 0 && v !== ''; }

// STRUCTURAL matcher for CLAIM-FIELD values (authorization / status / overall). Unlike `matchesForbidden`,
// it performs word-boundary/affix matching REGARDLESS of whitespace -- a claim field is structured data, not
// prose, so 'APPROVED FOR LIVE' -> approved, 'LIVE READY NOW' -> live_ready, 'PHASE 231 AUTHORIZED' ->
// phase_231_authorized all fail closed. Deliberately used ONLY for claim fields (never for note/description/
// evidence prose, where the affix rule would make negative prose fragile).
function matchesForbiddenClaimFieldValue(s: string): boolean {
  const boundary = normBoundary(s);
  if (boundary === '') return false;
  const comp = compact(s);
  const wrapped = `_${boundary}_`;
  for (const t of FORBIDDEN_TOKENS) {
    if (boundary === t) return true;                 // whole boundary match
    if (comp === t.replace(/_/g, '')) return true;   // whole compact match
    if (wrapped.includes(`_${t}_`)) return true;     // word-boundary affix match (whitespace allowed)
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

// A HARD live-authorization claim -- never exempt by the human gate -- is any of:
//   * a forbidden token that is the scalar STRING VALUE of ANY object field (not just authorization / status /
//     overall) -- e.g. { decision: 'APPROVED' }, { result: 'PHASE_231_AUTHORIZED' }. A field whose whole
//     value is a live-authorization token is a structural claim, whatever the field is named;
//   * a forbidden token in the SUBTREE of a claim field (authorization / status / overall) wrapped in an
//     array/object -- e.g. { overall: ['LIVE_READY'] }, { status: { v: 'PHASE_231_AUTHORIZED' } };
//   * a truthy claim flag (approved / execute / liveReady / phase231Authorized / liveAuthorized);
//   * an object KEY that reduces to a forbidden token with a truthy value -- e.g. { live_ready: true }.
// Checked RECURSIVELY over the whole artifact tree so a nested claim still fails closed.
//
// The ONLY thing a pending human gate may exempt is a forbidden token that appears as an ARRAY ELEMENT (a
// list of pending step names, e.g. pendingGates: ['PHASE_231_AUTHORIZED']) or inside multi-word PROSE. A
// bare token as an array element is NOT a hard claim; a bare token as a scalar field value IS.
const CLAIM_FIELDS: readonly string[] = ['authorization', 'status', 'overall'];
function hasHardClaim(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  // Arrays: recurse into element objects only. A string element is a listable step, never a hard claim here.
  if (Array.isArray(value)) return value.some((v) => hasHardClaim(v, depth + 1));
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    // A forbidden token as the scalar value of a NON-claim field is a structural claim, using the prose-safe
    // matcher (whole-string for sentences). Claim fields (authorization/status/overall) are handled below by
    // the whitespace-affix structural matcher.
    if (!CLAIM_FIELDS.includes(k) && typeof v === 'string' && matchesForbidden(v)) return true;
    // An object KEY that reduces to a forbidden token with a truthy value is a claim (scoped by the same
    // word-boundary rule, so unrelated review fields such as reviewAuthorization are not flagged).
    if (isTruthy(v) && matchesForbidden(k)) return true;
  }
  for (const flag of CLAIM_FLAGS) if (o[flag] === true) return true;
  // A claim field's value (scalar, or array/object-wrapped) is matched STRUCTURALLY -- whitespace-affixed
  // tokens like 'APPROVED FOR LIVE' fail closed because a claim field is structured data, not prose.
  for (const field of CLAIM_FIELDS) {
    if (field in o && subtreeHasForbidden(o[field], depth)) return true;
  }
  return Object.values(o).some((v) => hasHardClaim(v, depth + 1));
}
// Deep scan of a claim-field subtree: a forbidden token as any string value (matched STRUCTURALLY, so
// whitespace-affixed variants fail closed), or a truthy forbidden-token key.
function subtreeHasForbidden(value: unknown, depth: number): boolean {
  if (depth > 8) return false;
  if (typeof value === 'string') return matchesForbiddenClaimFieldValue(value);
  if (Array.isArray(value)) return value.some((v) => subtreeHasForbidden(v, depth + 1));
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isTruthy(v) && matchesForbidden(k)) return true;
      if (subtreeHasForbidden(v, depth + 1)) return true;
    }
  }
  return false;
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
