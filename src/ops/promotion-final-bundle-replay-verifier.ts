import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';
import { buildNoLiveAuthorizationGuard } from './promotion-no-live-authorization-guard.js';
import { buildOperatorAcceptanceTrace } from './promotion-operator-acceptance-trace.js';
import { buildFinalCoordinatorReadinessBundle } from './promotion-final-coordinator-readiness-bundle.js';

// Local, non-live FINAL-BUNDLE REPLAY VERIFIER. It is the independent replay check that sits on top of the
// final coordinator readiness bundle: given the SUPPLIED final bundle plus every input it was supposed to be
// derived from (the four launch-proofing leaves -- approval-request packet, live-execution preflight plan,
// no-live authorization guard, coordinator review checklist v2 -- plus the operator acceptance trace and the
// self-digest verification), it RE-DERIVES the operator acceptance trace and the final coordinator readiness
// bundle from those leaves and confirms the supplied artifacts are byte-authentic: the recomputed trace
// digest, the recomputed self-digest verifierDigest, and the recomputed final-bundle digest/status/reviewed
// commit must all EXACTLY equal the supplied ones, the component set must bind, no input may claim a live
// authorization, the observed-state requirement must be present, and redaction must be proven (no raw path).
// It reads parsed JSON only; it performs no promotion, never touches the real Movies root, never contacts
// Jellyfin, and `authorization` is the constant NONE with `status` PENDING. FINAL_BUNDLE_REPLAY_VERIFIED
// means the assembled final bundle reproduces exactly from its inputs -- it is NOT an approval and does not
// authorize Phase 231 or any live promotion.

export interface FinalBundleReplayVerifierInput {
  readonly approvalRequest?: unknown;    // phase-230-promotion-approval-request-packet
  readonly livePreflight?: unknown;      // phase-230-promotion-live-preflight-plan
  readonly noLiveGuard?: unknown;        // phase-230-promotion-no-live-authorization-guard
  readonly reviewChecklistV2?: unknown;  // phase-230-promotion-coordinator-review-checklist-v2
  readonly acceptanceTrace?: unknown;    // phase-230-promotion-operator-acceptance-trace
  readonly selfDigest?: unknown;         // phase-230-promotion-self-digest-verification
  readonly finalBundle?: unknown;        // phase-230-promotion-final-coordinator-readiness-bundle
}

export const REPLAY_VERIFIER_DISCLAIMERS: readonly string[] = [
  'FINAL_BUNDLE_REPLAY_VERIFIED means the supplied final bundle reproduces exactly from its inputs; it is NOT an approval.',
  'status is PENDING, authorization is NONE, and the live boundary is CLOSED.',
  'It does NOT authorize Phase 231, live promotion, or any merge/tag/master action.',
  'The only next action is a human, item-specific approval recorded later -- never live execution here.',
];

export interface ReplayCheck { readonly check: string; readonly ok: boolean; }

export interface FinalBundleReplayVerifierReport {
  readonly report: 'phase-230-promotion-final-bundle-replay-verifier';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly status: 'PENDING';
  readonly overall: 'FINAL_BUNDLE_REPLAY_VERIFIED' | 'FINAL_BUNDLE_REPLAY_BLOCKED';
  readonly reviewedCommit: string | null;
  readonly checks: readonly ReplayCheck[];
  readonly blockers: readonly string[];
  readonly liveBoundaryStatus: 'CLOSED';
  readonly phase231Authorization: 'NONE';
  readonly disclaimers: readonly string[];
  readonly replayVerifierDigest: string;
}

const FINAL_BUNDLE_ID = 'phase-230-promotion-final-coordinator-readiness-bundle';
const TRACE_ID = 'phase-230-promotion-operator-acceptance-trace';
const SELF_DIGEST_ID = 'phase-230-promotion-self-digest-verification';

// Raw-path fragments that must never leak into a redaction-safe artifact tree.
const RAW_PATH_MARKERS: readonly string[] = ['/mnt/', '\\mnt\\', '/media/Movies', 'user/media'];

export function verifyFinalBundleReplay(input: FinalBundleReplayVerifierInput): FinalBundleReplayVerifierReport {
  const blockers: string[] = [];
  const checks: ReplayCheck[] = [];
  const record = (check: string, ok: boolean, blocker: string): boolean => {
    checks.push({ check, ok });
    if (!ok) blockers.push(blocker);
    return ok;
  };

  const finalObj = asObject(input.finalBundle);
  // 1. The SUPPLIED final bundle must be present, well-formed, self-consistent, and genuinely READY.
  const finalReady = input.finalBundle !== undefined
    && finalObj.report === FINAL_BUNDLE_ID
    && asSha256(finalObj.readinessBundleDigest) !== undefined
    && verifySelfDigests([finalObj]).results[0]?.verified === true
    && finalObj.overall === 'FINAL_READINESS_BUNDLE_READY'
    && finalObj.status === 'PENDING'
    && finalObj.authorization === 'NONE'
    && finalObj.liveBoundaryStatus === 'CLOSED'
    && finalObj.phase231Authorization === 'NONE';
  record('final-bundle-ready', finalReady, 'REPLAY_FINAL_BUNDLE_NOT_READY');

  // 2. Re-derive the operator acceptance trace from the supplied leaves; its self-digest must EXACTLY equal
  // the supplied trace's (authenticity, not just integrity). Any missing leaf makes the recompute non-READY.
  const rebuiltTrace = buildOperatorAcceptanceTrace({
    approvalRequest: input.approvalRequest, livePreflight: input.livePreflight,
    noLiveGuard: input.noLiveGuard, reviewChecklistV2: input.reviewChecklistV2,
  });
  const suppliedTrace = asObject(input.acceptanceTrace);
  const traceOk = input.acceptanceTrace !== undefined
    && suppliedTrace.report === TRACE_ID
    && rebuiltTrace.overall === 'ACCEPTANCE_TRACE_READY'
    && rebuiltTrace.traceDigest === asSha256(suppliedTrace.traceDigest);
  record('acceptance-trace-replay', traceOk, 'REPLAY_ACCEPTANCE_TRACE_MISMATCH');

  // 3. Re-derive the self-digest verification over exactly the supplied guard components (canonical order);
  // its verifierDigest must EXACTLY equal the supplied self-digest's, and it must be ALL_VERIFIED.
  const rebuiltSelfDigest = verifySelfDigests([input.approvalRequest, input.livePreflight, input.noLiveGuard, input.reviewChecklistV2, input.acceptanceTrace]);
  const suppliedSelfDigest = asObject(input.selfDigest);
  const selfDigestOk = input.selfDigest !== undefined
    && suppliedSelfDigest.report === SELF_DIGEST_ID
    && rebuiltSelfDigest.overall === 'ALL_VERIFIED'
    && rebuiltSelfDigest.verifierDigest === asSha256(suppliedSelfDigest.verifierDigest);
  record('self-digest-replay', selfDigestOk, 'REPLAY_SELF_DIGEST_MISMATCH');

  // 4. The reviewed commit must be the SAME 40-hex across the supplied final bundle, the acceptance trace, and
  // the approval-request packet.
  const finalCommit = asSha40(finalObj.reviewedCommit);
  const traceCommit = asSha40(suppliedTrace.reviewedCommit);
  const approvalCommit = asSha40(asObject(input.approvalRequest).reviewedCommit);
  const commitOk = finalCommit !== undefined && finalCommit === traceCommit && finalCommit === approvalCommit;
  record('reviewed-commit-binding', commitOk, 'REPLAY_REVIEWED_COMMIT_MISMATCH');

  // 5. Re-derive the FINAL coordinator readiness bundle from all supplied components; its readinessBundleDigest
  // must EXACTLY equal the supplied final bundle's, and the recompute must itself be READY. This binds the
  // supplied bundle to the exact component set -- a swapped-but-green component or a resealed bundle fails.
  const rebuiltBundle = buildFinalCoordinatorReadinessBundle({
    acceptanceTrace: input.acceptanceTrace, noLiveGuard: input.noLiveGuard, livePreflight: input.livePreflight,
    approvalRequest: input.approvalRequest, reviewChecklistV2: input.reviewChecklistV2, selfDigest: input.selfDigest,
  });
  const componentSetOk = rebuiltBundle.overall === 'FINAL_READINESS_BUNDLE_READY'
    && rebuiltBundle.readinessBundleDigest === asSha256(finalObj.readinessBundleDigest);
  record('final-bundle-component-set', componentSetOk, 'REPLAY_COMPONENT_SET_MISMATCH');

  const present = [input.approvalRequest, input.livePreflight, input.noLiveGuard, input.reviewChecklistV2, input.acceptanceTrace, input.selfDigest, input.finalBundle].filter((c) => c !== undefined);

  // 6. Defence in depth: no supplied artifact (leaves, trace, self-digest, OR the final bundle) may claim a
  // live authorization anywhere in its body.
  const noLiveClean = present.length > 0 && buildNoLiveAuthorizationGuard({ artifacts: present }).overall === 'NO_LIVE_AUTHORIZATION_CLEAN';
  record('no-live-authorization', noLiveClean, 'REPLAY_LIVE_AUTHORIZATION_CLAIMED');

  // 7. The observed-state requirement must be present and green in the preflight plan's policy checks.
  const policyChecks = Array.isArray(asObject(input.livePreflight).policyChecks) ? asObject(input.livePreflight).policyChecks as unknown[] : [];
  const observedOk = policyChecks.some((c) => asObject(c).policy === 'observed-state-required' && asObject(c).ok === true);
  record('observed-state-required', observedOk, 'REPLAY_OBSERVED_STATE_MISSING');

  // 8. Redaction must be proven for every supplied artifact and no raw path may leak into any artifact tree.
  const allRedactionSafe = present.length > 0 && present.every((c) => asObject(c).redactionSafe === true);
  const noRawPath = present.length > 0 && present.every((c) => !hasRawPath(c));
  record('redaction-safe', allRedactionSafe && noRawPath, 'REPLAY_REDACTION_UNSAFE');

  const uniqueBlockers = [...new Set(blockers)];
  const overall: FinalBundleReplayVerifierReport['overall'] = uniqueBlockers.length === 0 ? 'FINAL_BUNDLE_REPLAY_VERIFIED' : 'FINAL_BUNDLE_REPLAY_BLOCKED';
  const withoutDigest: Omit<FinalBundleReplayVerifierReport, 'replayVerifierDigest'> = {
    report: 'phase-230-promotion-final-bundle-replay-verifier',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    status: 'PENDING',
    overall,
    reviewedCommit: overall === 'FINAL_BUNDLE_REPLAY_VERIFIED' ? finalCommit ?? null : null,
    checks,
    blockers: uniqueBlockers,
    liveBoundaryStatus: 'CLOSED',
    phase231Authorization: 'NONE',
    disclaimers: REPLAY_VERIFIER_DISCLAIMERS,
  };
  return { ...withoutDigest, replayVerifierDigest: digest('phase-230-final-bundle-replay-verifier', JSON.stringify(withoutDigest)) };
}

// Recursively scan an artifact tree for a raw-path marker in any string value (keys or values).
function hasRawPath(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof value === 'string') return RAW_PATH_MARKERS.some((m) => value.includes(m));
  if (Array.isArray(value)) return value.some((v) => hasRawPath(v, depth + 1));
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (RAW_PATH_MARKERS.some((m) => k.includes(m))) return true;
      if (hasRawPath(v, depth + 1)) return true;
    }
  }
  return false;
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
