import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';
import { meshValidReports } from './promotion-closure-input-bundle-audit.js';

// Local, non-live closure summary v3. It summarizes the Phase 230 local-only closure state from AUTHORITATIVE
// BOUNDED inputs -- the review-authorization scaffold (which itself chained the terminal readiness to the
// commit-range / transcript evidence and bound a review matrix to the authoritative context) and the
// coordinator readiness manifest -- plus a locally OBSERVED state record. It recomputes each report's
// self-digest, surfaces exact commit/test visibility (which commits and which test labels were reviewed),
// and fails closed on: a missing observed state, an unbound terminal or coordinator context, an unverified
// component digest, or any live-boundary escape (an input claiming authorization other than NONE/PENDING, or
// an observed-state source pointing at a live/network/media surface). Failure evidence is redaction-safe:
// per-check booleans and fixed codes only -- never a raw path, title, or payload. It reads parsed JSON only;
// it performs no promotion, never touches the real Movies root, never contacts Jellyfin, and its
// `authorization` field is the constant NONE with `status` PENDING. READY summarizes local closure for a
// human; it does NOT approve, merge, or authorize Phase 231 / any live promotion.

export interface ClosureSummaryV3Input {
  readonly reviewAuthorization?: unknown;  // phase-230-promotion-review-authorization (LOCAL_REVIEW_AUTHORIZED)
  readonly coordinatorReadiness?: unknown; // phase-230-promotion-coordinator-readiness-manifest (CONFIRMED)
  readonly observedState?: unknown;        // a locally observed-state record: { observed, head, source?, stateDigest? }
  readonly anchorReports?: unknown;        // the actual reports RA/CR claim to bind (an array), for exact-equality cross-check
}

const ALLOWED_AUTHORIZATION: readonly string[] = ['NONE', 'PENDING'];
// The bindings a genuine review-authorization records, and the components a genuine coordinator-readiness
// carries. A minimal self-sealed report (right id + recomputing self-digest + green overall) that lacks this
// authoritative internal structure is a forgery and must not be treated as a bound context.
const RA_REQUIRED_BINDINGS: readonly string[] = ['terminal-readiness-v2', 'terminal-closure', 'commit-range-closure', 'transcript-verification', 'review-matrix'];
const CR_REQUIRED_COMPONENTS: readonly string[] = ['acceptance-preflight', 'failure-matrix', 'report-schema', 'boundary-audit', 'cli-ergonomics'];

export const CLOSURE_SUMMARY_V3_HUMAN_GATES: readonly string[] = [
  'Human review of the exact reviewed commits and test set surfaced here.',
  'Human confirmation of the observed local state.',
  'Explicit coordinator sign-off recorded via the acceptance seal.',
  'The merge / tag / push-to-master action itself -- a human operator step NOT performed or authorized here.',
  'Phase 231 authorization, which is NOT granted by any tool, doc, or artifact here.',
];

export const CLOSURE_SUMMARY_V3_BOUNDARY =
  'No deploy launcher run, no real media-library write, no live Jellyfin call, no merge/tag/push/master, and no Phase 231 or live-promotion authorization is implied or performed by this summary.';

export const CLOSURE_SUMMARY_V3_DISCLAIMERS: readonly string[] = [
  'CLOSURE_SUMMARY_READY summarizes the local-only closure state for a human; status stays PENDING.',
  'It does NOT approve, merge, tag, push, or authorize Phase 231 or any live promotion.',
  'No live Jellyfin call or real media write is implied or performed by this summary.',
  'This is a redaction-safe, deterministic summary over offline records only.',
];

export interface ClosureCheck { readonly check: string; readonly ok: boolean; }

export interface ClosureSummaryV3Report {
  readonly report: 'phase-230-promotion-closure-summary-v3';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly status: 'PENDING';
  readonly overall: 'CLOSURE_SUMMARY_READY' | 'CLOSURE_SUMMARY_BLOCKED';
  readonly observedStatePresent: boolean;
  readonly commitVisibility: { readonly head: string | null; readonly commitCount: number; readonly commitShas: readonly string[] };
  readonly testVisibility: { readonly testCount: number; readonly tests: readonly string[] };
  readonly boundDigests: Readonly<Record<string, string>>;
  readonly failureEvidence: readonly ClosureCheck[];
  readonly humanGates: readonly string[];
  readonly boundary: string;
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly summaryV3Digest: string;
}

export function buildClosureSummaryV3(input: ClosureSummaryV3Input): ClosureSummaryV3Report {
  const blockers: string[] = [];
  const boundDigests: Record<string, string> = {};

  // Validate the FULL input mesh once (RA + CR + every supplied anchor). A report is mesh-valid only when it
  // recomputes, is green, and -- for each aggregator -- every declared child binding exactly equals the
  // recomputed digest of a SUPPLIED child that is itself mesh-valid. Validity is keyed by the EXACT self-
  // digest (not report id): the specific top-level RA/CR object must itself be mesh-valid, so a genuine
  // same-id anchor cannot shadow a different forged top-level object, and conflicting duplicate ids fail closed.
  const mesh = meshValidReports([input.reviewAuthorization, input.coordinatorReadiness, ...(Array.isArray(input.anchorReports) ? input.anchorReports : [])]);

  // Authoritative bounded input #1: the review-authorization scaffold. Right id + recomputing self-digest +
  // LOCAL_REVIEW_AUTHORIZED + authoritative shape, AND this exact object's digest is mesh-valid in the bundle.
  const ra = bound(input.reviewAuthorization, 'phase-230-promotion-review-authorization', 'authorizationDigest',
    (o) => o.overall === 'LOCAL_REVIEW_AUTHORIZED' && reviewAuthorizationAuthoritative(o));
  const raContextBound = ra.ok && ra.digest !== undefined && mesh.validDigests.has(ra.digest);
  if (raContextBound && ra.digest) boundDigests['review-authorization'] = ra.digest;
  if (!ra.digestVerified && ra.present && ra.rightId) blockers.push('COMPONENT_DIGEST_UNVERIFIED');
  if (!raContextBound) blockers.push('UNBOUND_TERMINAL_CONTEXT');

  // Authoritative bounded input #2: the coordinator readiness manifest -- likewise authoritative in shape and
  // this exact object's digest mesh-valid in the bundle.
  const cr = bound(input.coordinatorReadiness, 'phase-230-promotion-coordinator-readiness-manifest', 'readinessDigest',
    (o) => o.overall === 'COORDINATOR_READINESS_CONFIRMED' && coordinatorReadinessAuthoritative(o));
  const crContextBound = cr.ok && cr.digest !== undefined && mesh.validDigests.has(cr.digest);
  if (crContextBound && cr.digest) boundDigests['coordinator-readiness'] = cr.digest;
  if (!cr.digestVerified && cr.present && cr.rightId) blockers.push('COMPONENT_DIGEST_UNVERIFIED');
  if (!crContextBound) blockers.push('UNBOUND_COORDINATOR_CONTEXT');

  // Exact commit/test visibility from the (truly context-bound) review-authorization placeholders.
  let commitShas: string[] = [];
  let tests: string[] = [];
  if (raContextBound) {
    const rows = Array.isArray(ra.obj.placeholders) ? ra.obj.placeholders : [];
    commitShas = rows.map((r) => sha40(asObject(r).sha)).filter((s): s is string => s !== undefined);
    const seen = new Set<string>();
    for (const r of rows) for (const t of (Array.isArray(asObject(r).tests) ? asObject(r).tests as unknown[] : [])) {
      const label = pathFree(asObject(t).test);
      if (label !== null && !seen.has(label)) { seen.add(label); tests.push(label); }
    }
  }
  const head = commitShas.length > 0 ? commitShas[commitShas.length - 1]! : null;

  // Observed-state requirement: a locally observed state must be supplied, be a local observation, AND be
  // BOUND to the authoritative reviewed head (the terminal reviewed commit). A stale observation of a
  // different head -- individually well-formed -- must not pass.
  const os = asObject(input.observedState);
  const observedStatePresent = input.observedState !== undefined && os.observed === true;
  if (!observedStatePresent) blockers.push('OBSERVED_STATE_MISSING');
  const osHead = sha40(os.head);
  const observedStateBound = observedStatePresent && osHead !== undefined && (head === null || osHead === head);
  if (observedStatePresent && !observedStateBound) blockers.push('OBSERVED_STATE_UNBOUND');

  // Live-boundary escape: any input claiming authorization other than NONE/PENDING, or ANY string anywhere
  // in the (untrusted, coordinator-supplied) observed-state record that names a live / network / media
  // surface or a raw path -- not merely the `source` field.
  let liveEscape = false;
  for (const value of [input.reviewAuthorization, input.coordinatorReadiness, input.observedState]) {
    const a = asObject(value).authorization;
    if (typeof a === 'string' && !ALLOWED_AUTHORIZATION.includes(a)) liveEscape = true;
  }
  if (deepLiveEscape(input.observedState)) liveEscape = true;
  if (liveEscape) blockers.push('LIVE_BOUNDARY_ESCAPE');

  const failureEvidence: ClosureCheck[] = [
    { check: 'terminal-context-bound', ok: raContextBound },
    { check: 'coordinator-context-bound', ok: crContextBound },
    { check: 'observed-state-present', ok: observedStatePresent },
    { check: 'observed-state-bound-to-head', ok: observedStateBound },
    { check: 'component-digests-verified', ok: (!ra.present || ra.digestVerified) && (!cr.present || cr.digestVerified) },
    { check: 'live-boundary-closed', ok: !liveEscape },
  ];

  const uniqueBlockers = [...new Set(blockers)];
  const overall: ClosureSummaryV3Report['overall'] = uniqueBlockers.length === 0 ? 'CLOSURE_SUMMARY_READY' : 'CLOSURE_SUMMARY_BLOCKED';
  const withoutDigest: Omit<ClosureSummaryV3Report, 'summaryV3Digest'> = {
    report: 'phase-230-promotion-closure-summary-v3',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    status: 'PENDING',
    overall,
    observedStatePresent,
    commitVisibility: { head, commitCount: commitShas.length, commitShas },
    testVisibility: { testCount: tests.length, tests },
    boundDigests,
    failureEvidence,
    humanGates: CLOSURE_SUMMARY_V3_HUMAN_GATES,
    boundary: CLOSURE_SUMMARY_V3_BOUNDARY,
    blockers: uniqueBlockers,
    disclaimers: CLOSURE_SUMMARY_V3_DISCLAIMERS,
  };
  return { ...withoutDigest, summaryV3Digest: digest('phase-230-closure-summary-v3', JSON.stringify(withoutDigest)) };
}

interface Bound { readonly obj: Record<string, unknown>; readonly present: boolean; readonly rightId: boolean; readonly digestVerified: boolean; readonly ok: boolean; readonly digest: string | undefined; }

function bound(value: unknown, reportId: string, digestField: string, green: (o: Record<string, unknown>) => boolean): Bound {
  const present = value !== undefined;
  const obj = asObject(value);
  const rightId = obj.report === reportId;
  const d = sha256(obj[digestField]);
  const digestVerified = d !== undefined && verifySelfDigests([obj]).results[0]?.verified === true;
  const ok = present && rightId && digestVerified && green(obj);
  return { obj, present, rightId, digestVerified, ok, digest: digestVerified ? d : undefined };
}
// A genuine review-authorization: evidence + matrix + context bound, a non-empty reviewed commit/test range,
// the full binding mesh, and placeholders whose counts are consistent with the reported visibility.
function reviewAuthorizationAuthoritative(o: Record<string, unknown>): boolean {
  if (o.evidenceValid !== true || o.matrixValid !== true || o.contextBound !== true) return false;
  const cc = o.reviewedCommitCount;
  const tc = o.reviewedTestCount;
  if (typeof cc !== 'number' || cc <= 0 || typeof tc !== 'number' || tc <= 0) return false;
  const bd = asObject(o.boundDigests);
  if (!RA_REQUIRED_BINDINGS.every((k) => sha256(bd[k]) !== undefined)) return false;
  const rows = Array.isArray(o.placeholders) ? o.placeholders : [];
  if (rows.length !== cc) return false;
  return rows.every((r) => { const ro = asObject(r); const t = ro.tests; return sha40(ro.sha) !== undefined && Array.isArray(t) && t.length === tc; });
}
// A genuine coordinator-readiness: every expected component present + ok, with a matching non-empty binding.
function coordinatorReadinessAuthoritative(o: Record<string, unknown>): boolean {
  const comps = Array.isArray(o.components) ? o.components : [];
  const okByName = new Map<string, boolean>();
  for (const c of comps) { const co = asObject(c); if (typeof co.component === 'string') okByName.set(co.component, co.ok === true); }
  const bd = asObject(o.boundDigests);
  return CR_REQUIRED_COMPONENTS.every((k) => okByName.get(k) === true && sha256(bd[k]) !== undefined);
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function sha256(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}
function sha40(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value : undefined;
}
function isLiveSurface(value: string): boolean {
  return /jellyfin|https?:\/\/|x-emby|library\/refresh|\/mnt\//i.test(value);
}
// Flag any string anywhere in the (untrusted, coordinator-supplied) observed-state record that names a
// live/network/media surface or a raw path, so a live indicator smuggled into a field other than `source`
// still fails closed. Traverses ITERATIVELY (explicit stack) with a visited set, so it terminates on any
// input -- a pathologically deep tree can't overflow the stack and a cyclic/shared-reference record can't
// loop forever. Skipping an already-visited node is safe (its subtree was fully evaluated on first visit);
// the result is deterministic and a live surface buried at any depth still fails closed.
function deepLiveEscape(root: unknown): boolean {
  const stack: unknown[] = [root];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') { if (value.length > 0 && (isLiveSurface(value) || pathFree(value) === null)) return true; continue; }
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) { for (const v of value) stack.push(v); continue; }
    for (const v of Object.values(value as Record<string, unknown>)) stack.push(v);
  }
  return false;
}
function pathFree(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (/^\//.test(value) || /[A-Za-z]:[\\/]/.test(value) || /\/mnt\//.test(value) || /\\mnt\\/.test(value)
    || value.includes('catalog-authority-test-library') || /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i.test(value)) return null;
  return value;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
