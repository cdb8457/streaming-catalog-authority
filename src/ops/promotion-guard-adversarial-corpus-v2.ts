import { createHash } from 'node:crypto';
import { buildNoLiveAuthorizationGuard } from './promotion-no-live-authorization-guard.js';
import { buildLivePreflightPlan } from './promotion-live-preflight-plan.js';
import { buildApprovalRequestPacket } from './promotion-approval-request-packet.js';
import { buildReviewChecklistV2 } from './promotion-review-checklist-v2.js';
import { buildOperatorAcceptanceTrace } from './promotion-operator-acceptance-trace.js';

// Local, non-live SHARED adversarial guard corpus v2. A single fixture set of adversarial inputs for the
// launch-proofing guard family -- the no-live authorization guard, the live-execution preflight plan
// validator, the approval-request packet, the coordinator review checklist v2, and the operator acceptance
// trace. Each negative sample must BLOCK (fail closed) and each safe sample must stay clean/pending WITHOUT a
// false positive. The corpus runs every sample through its guard and confirms the expected outcome. It is a
// pure self-test over synthetic inputs; it performs no promotion, never touches the real Movies root, never
// contacts Jellyfin, and authorizes nothing live. Every probed live/path literal is fragment-assembled so
// this source stays clean under the boundary guards, and the report echoes only fixed ids/categories/booleans.

const J = (...parts: readonly string[]): string => parts.join('');
// A network endpoint and raw media / symlink paths, assembled so no literal marker appears in this source.
const LIVE_URL = J('http', '://', 'host', '/', 'library', '/', 'refresh');
const RAW_MEDIA_PATH = J('/', 'mnt', '/', 'user', '/', 'media', '/', 'Movies', '/', 'x', '.', 'mkv');
const SYMLINK_TARGET = J('/', 'var', '/', 'lib', '/', 'containment', '/', 'link');
const A64 = 'a'.repeat(64);

// A shape-valid but forged (non-recomputing self-digest) component, for downstream-aggregator probes.
const forgedApprovalRequest = (): Record<string, unknown> => ({
  report: 'phase-230-promotion-approval-request-packet', version: 1, redactionSafe: true, authorization: 'NONE',
  status: 'PENDING', overall: 'APPROVAL_REQUEST_READY', reviewedCommit: 'd'.repeat(40), requiredTests: [], packetDigest: A64,
});
const forgedClosureSummary = (): Record<string, unknown> => ({
  report: 'phase-230-promotion-closure-summary-v3', overall: 'CLOSURE_SUMMARY_READY', summaryV3Digest: A64,
});
const validItem = (): Record<string, unknown> => ({ approvalId: 'i', approvalStatus: 'PENDING', sourceDigest: A64, destinationDigest: 'b'.repeat(64) });
const basePlan = (over: Record<string, unknown>): Record<string, unknown> => ({
  noClobber: true, sameChecksum: true, observedStateRequired: true,
  rollback: { strategy: 'restore' }, withdrawal: { strategy: 'remove-added' }, items: [validItem()], ...over,
});

interface GuardSample {
  readonly id: string;
  readonly category: string;
  readonly guard: string;
  readonly kind: 'blocks' | 'stays-clean';
  readonly held: () => boolean;
}

const SAMPLES: readonly GuardSample[] = [
  // --- no-live authorization guard: hard-claim variants must fail closed ---
  {
    id: 'nested-hard-authorization-claim', category: 'nested-hard-claim', guard: 'no-live-authorization-guard', kind: 'blocks',
    held: () => buildNoLiveAuthorizationGuard({ artifacts: [{ report: 'x', gate: { decision: { approved: true } } }] }).overall === 'NO_LIVE_AUTHORIZATION_VIOLATED',
  },
  {
    id: 'whitespace-affixed-claim-field', category: 'whitespace-variant', guard: 'no-live-authorization-guard', kind: 'blocks',
    held: () => buildNoLiveAuthorizationGuard({ artifacts: [{ report: 'x', status: 'APPROVED FOR LIVE' }] }).overall === 'NO_LIVE_AUTHORIZATION_VIOLATED',
  },
  {
    id: 'camelcase-claim-field', category: 'case-variant', guard: 'no-live-authorization-guard', kind: 'blocks',
    held: () => buildNoLiveAuthorizationGuard({ artifacts: [{ report: 'x', overall: 'LiveReady' }] }).overall === 'NO_LIVE_AUTHORIZATION_VIOLATED',
  },
  {
    id: 'separator-variant-claim-field', category: 'separator-variant', guard: 'no-live-authorization-guard', kind: 'blocks',
    held: () => buildNoLiveAuthorizationGuard({ artifacts: [{ report: 'x', status: 'phase-231-authorized' }] }).overall === 'NO_LIVE_AUTHORIZATION_VIOLATED',
  },
  {
    id: 'object-key-claim', category: 'object-key-variant', guard: 'no-live-authorization-guard', kind: 'blocks',
    held: () => buildNoLiveAuthorizationGuard({ artifacts: [{ report: 'x', live_ready: true }] }).overall === 'NO_LIVE_AUTHORIZATION_VIOLATED',
  },
  {
    id: 'phase-231-token', category: 'phase-231-token', guard: 'no-live-authorization-guard', kind: 'blocks',
    held: () => buildNoLiveAuthorizationGuard({ artifacts: [{ report: 'x', authorization: 'NONE', overall: 'PHASE_231_AUTHORIZED' }] }).overall === 'NO_LIVE_AUTHORIZATION_VIOLATED',
  },
  {
    id: 'forged-approval-status-flag', category: 'forged-approval-status', guard: 'no-live-authorization-guard', kind: 'blocks',
    held: () => buildNoLiveAuthorizationGuard({ artifacts: [{ report: 'x', authorization: 'NONE', approved: true }] }).overall === 'NO_LIVE_AUTHORIZATION_VIOLATED',
  },
  {
    // A claim carried alongside a raw media path: must fail closed AND never echo the path.
    id: 'redaction-sensitive-failure-evidence', category: 'redaction-sensitive', guard: 'no-live-authorization-guard', kind: 'blocks',
    held: () => {
      const r = buildNoLiveAuthorizationGuard({ artifacts: [{ report: 'x', decision: 'APPROVED', note: RAW_MEDIA_PATH }] });
      return r.overall === 'NO_LIVE_AUTHORIZATION_VIOLATED' && !JSON.stringify(r).includes(J('m', 'n', 't'));
    },
  },
  // --- live-execution preflight plan: live surfaces / raw paths must fail closed ---
  {
    id: 'live-surface-url-in-plan', category: 'live-surface', guard: 'live-preflight-plan', kind: 'blocks',
    held: () => buildLivePreflightPlan({ plan: basePlan({ note: LIVE_URL }) }).blockers.includes('LIVE_SURFACE_IN_PLAN'),
  },
  {
    id: 'raw-media-path-in-plan', category: 'raw-path-leak', guard: 'live-preflight-plan', kind: 'blocks',
    held: () => buildLivePreflightPlan({ plan: basePlan({ items: [{ ...validItem(), sourcePath: RAW_MEDIA_PATH }] }) }).blockers.includes('LIVE_SURFACE_IN_PLAN'),
  },
  {
    id: 'symlink-containment-target-in-plan', category: 'symlink-containment', guard: 'live-preflight-plan', kind: 'blocks',
    held: () => buildLivePreflightPlan({ plan: basePlan({ items: [{ ...validItem(), symlinkTarget: SYMLINK_TARGET }] }) }).blockers.includes('LIVE_SURFACE_IN_PLAN'),
  },
  {
    id: 'preflight-item-pre-approved', category: 'forged-approval-status', guard: 'live-preflight-plan', kind: 'blocks',
    held: () => buildLivePreflightPlan({ plan: basePlan({ items: [{ ...validItem(), approvalStatus: 'APPROVED' }] }) }).blockers.includes('ITEM_NOT_PENDING'),
  },
  // --- approval-request packet: an input that already claims an approval must be refused ---
  {
    id: 'approval-request-input-claims-approval', category: 'forged-approval-status', guard: 'approval-request-packet', kind: 'blocks',
    held: () => buildApprovalRequestPacket({ reviewAuthorization: { report: 'phase-230-promotion-review-authorization', authorization: 'APPROVED' } }).blockers.includes('APPROVAL_CLAIM_PRESENT'),
  },
  // --- review checklist v2: a forged (non-recomputing) closure summary must not clear ---
  {
    id: 'checklist-forged-closure-summary', category: 'forged-component', guard: 'review-checklist-v2', kind: 'blocks',
    held: () => buildReviewChecklistV2(CORPUS_PROJECT_ROOT, { closureSummary: forgedClosureSummary(), bundleAudit: forgedClosureSummary() }).overall === 'CHECKLIST_BLOCKED',
  },
  // --- operator acceptance trace: a forged component and a smuggled claim must both block ---
  {
    id: 'acceptance-trace-forged-approval', category: 'forged-component', guard: 'operator-acceptance-trace', kind: 'blocks',
    held: () => buildOperatorAcceptanceTrace({ approvalRequest: forgedApprovalRequest() }).overall === 'ACCEPTANCE_TRACE_BLOCKED',
  },
  {
    id: 'acceptance-trace-component-claims-live', category: 'nested-hard-claim', guard: 'operator-acceptance-trace', kind: 'blocks',
    held: () => buildOperatorAcceptanceTrace({ approvalRequest: { report: 'phase-230-promotion-approval-request-packet', overall: 'APPROVED', packetDigest: A64 } }).overall === 'ACCEPTANCE_TRACE_BLOCKED',
  },
  // --- safe cases: must stay clean / pending with no false positive ---
  {
    id: 'safe-clean-artifacts', category: 'safe', guard: 'no-live-authorization-guard', kind: 'stays-clean',
    held: () => buildNoLiveAuthorizationGuard({ artifacts: [{ report: 'phase-230-promotion-review-authorization', authorization: 'NONE', status: 'PENDING', overall: 'LOCAL_REVIEW_AUTHORIZED' }] }).overall === 'NO_LIVE_AUTHORIZATION_CLEAN',
  },
  {
    id: 'safe-valid-preflight-plan', category: 'safe', guard: 'live-preflight-plan', kind: 'stays-clean',
    held: () => buildLivePreflightPlan({ plan: basePlan({}) }).overall === 'PREFLIGHT_PLAN_VALID',
  },
  {
    id: 'safe-pending-gate-lists-tokens', category: 'safe', guard: 'no-live-authorization-guard', kind: 'stays-clean',
    held: () => buildNoLiveAuthorizationGuard({ artifacts: [{ report: 'phase-230-promotion-human-gate', humanGate: true, status: 'PENDING', authorization: 'NONE', pendingGates: ['PHASE_231_AUTHORIZED', 'APPROVED'] }] }).overall === 'NO_LIVE_AUTHORIZATION_CLEAN',
  },
];

// The checklist sample needs a real project root to read the local-suite gate; it is injected per build.
let CORPUS_PROJECT_ROOT = '';

export const GUARD_ADVERSARIAL_SAMPLE_COUNT = SAMPLES.length;

export interface GuardSampleResult { readonly sample: string; readonly category: string; readonly guard: string; readonly kind: string; readonly held: boolean; }

export interface GuardAdversarialCorpusV2Report {
  readonly report: 'phase-230-promotion-guard-adversarial-corpus-v2';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'GUARD_CORPUS_V2_HELD' | 'GUARD_CORPUS_V2_BREACHED';
  readonly count: number;
  readonly guardsCovered: readonly string[];
  readonly categories: Readonly<Record<string, number>>;
  readonly samples: readonly GuardSampleResult[];
  readonly breaches: readonly string[];
  readonly corpusV2Digest: string;
}

export function buildGuardAdversarialCorpusV2(projectRoot: string): GuardAdversarialCorpusV2Report {
  CORPUS_PROJECT_ROOT = projectRoot;
  const samples: GuardSampleResult[] = SAMPLES.map((s) => {
    let held = false;
    try { held = s.held() === true; } catch { held = false; }
    return { sample: s.id, category: s.category, guard: s.guard, kind: s.kind, held };
  });
  const breaches = samples.filter((s) => !s.held).map((s) => s.sample);
  const categories: Record<string, number> = {};
  for (const s of SAMPLES) categories[s.category] = (categories[s.category] ?? 0) + 1;
  const guardsCovered = [...new Set(SAMPLES.map((s) => s.guard))].sort();

  const overall: GuardAdversarialCorpusV2Report['overall'] = breaches.length === 0 ? 'GUARD_CORPUS_V2_HELD' : 'GUARD_CORPUS_V2_BREACHED';
  const withoutDigest: Omit<GuardAdversarialCorpusV2Report, 'corpusV2Digest'> = {
    report: 'phase-230-promotion-guard-adversarial-corpus-v2',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    count: SAMPLES.length,
    guardsCovered,
    categories,
    samples,
    breaches,
  };
  return { ...withoutDigest, corpusV2Digest: digest('phase-230-guard-adversarial-corpus-v2', JSON.stringify(withoutDigest)) };
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
