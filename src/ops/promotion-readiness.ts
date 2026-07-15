import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { canonicalPath, defaultRealMoviesRoot } from './real-library-promotion.js';

// Local, non-live coordinator readiness checklist. It ties together the artifacts other
// Phase 230 tools already produce — the approval attestation, the promotion evidence report,
// and the promotion evidence review — and cross-checks that they describe ONE consistent,
// completed, observed, and accepted promotion. It emits a redaction-safe READY/BLOCKED
// checklist.
//
// It reads parsed JSON objects only. It performs no promotion, never touches the real Movies
// root, never contacts Jellyfin, and grants no authorization: a READY verdict is a paperwork
// consistency result for a coordinator, not a live gate.

export interface PromotionReadinessInput {
  readonly approval?: unknown;          // approval attestation (may contain real paths; never echoed)
  readonly approvalEvidence?: unknown;  // redaction-safe approval-attestation evidence (optional)
  readonly promotionEvidence?: unknown; // phase-230-real-library-promotion report (optional)
  readonly evidenceReview?: unknown;    // phase-230-promotion-evidence-review record (optional)
}

export type ChecklistStatus = 'PASS' | 'FAIL' | 'SKIPPED';

export interface ChecklistItem {
  readonly id: string;
  readonly required: boolean;
  readonly status: ChecklistStatus;
  readonly detail: string; // generic, value-free
  readonly mismatches?: readonly string[];
}

export interface PromotionReadinessChecklist {
  readonly report: 'phase-230-promotion-readiness-checklist';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly verdict: 'READY' | 'BLOCKED';
  readonly targetRoot: '/mnt/user/media/Movies' | 'custom-real-movies-root' | 'unknown';
  readonly approvalIdDigest?: string;
  readonly itemDigest?: string;
  readonly destinationNameDigest?: string;
  readonly subjectEvidenceDigest?: string;
  readonly items: readonly ChecklistItem[];
  readonly blockers: readonly string[];
  readonly checklistDigest: string;
}

export function buildPromotionReadinessChecklist(input: PromotionReadinessInput): PromotionReadinessChecklist {
  const approval = asObject(input.approval);
  const approvalEvidence = input.approvalEvidence === undefined ? undefined : asObject(input.approvalEvidence);
  const promotionEvidence = input.promotionEvidence === undefined ? undefined : asObject(input.promotionEvidence);
  const evidenceReview = input.evidenceReview === undefined ? undefined : asObject(input.evidenceReview);

  const items: ChecklistItem[] = [];

  // 1. Approval attestation is structurally complete.
  const approvalWellFormed = isNonEmpty(approval.approvalId) && isNonEmpty(approval.itemId)
    && isNonEmpty(approval.targetRoot) && isNonEmpty(approval.sourceRealPath)
    && isSha256(approval.sourceSha256) && isNonEmpty(approval.destinationPath);
  items.push({
    id: 'APPROVAL_WELL_FORMED',
    required: true,
    status: approvalWellFormed ? 'PASS' : 'FAIL',
    detail: approvalWellFormed ? 'approval attestation carries all binding fields' : 'approval attestation is missing or malformed binding fields',
  });

  const targetRootEnum: PromotionReadinessChecklist['targetRoot'] = approvalWellFormed
    ? (canonicalPath(approval.targetRoot as string) === canonicalPath(defaultRealMoviesRoot()) ? '/mnt/user/media/Movies' : 'custom-real-movies-root')
    : 'unknown';

  const approvalIdDigest = approvalWellFormed ? digest('phase-230-approval', approval.approvalId as string) : undefined;
  const itemDigest = approvalWellFormed ? digest('phase-230-item', approval.itemId as string) : undefined;
  const destinationNameDigest = approvalWellFormed ? digest('phase-230-destination-name', basename(approval.destinationPath as string)) : undefined;

  // 2. Approval evidence is optional to supply, but when supplied it must be consistent:
  //    a missing or malformed expected digest field is a divergence, not a silent pass.
  if (approvalEvidence === undefined) {
    items.push({ id: 'APPROVAL_EVIDENCE_MATCHES_APPROVAL', required: false, status: 'SKIPPED', detail: 'no approval evidence supplied' });
  } else if (!approvalWellFormed) {
    items.push({ id: 'APPROVAL_EVIDENCE_MATCHES_APPROVAL', required: false, status: 'SKIPPED', detail: 'cannot cross-check approval evidence against a malformed approval' });
  } else {
    const m = approvalEvidenceMismatches(approval, approvalEvidence);
    items.push({
      id: 'APPROVAL_EVIDENCE_MATCHES_APPROVAL',
      required: true,
      status: m.length === 0 ? 'PASS' : 'FAIL',
      detail: m.length === 0 ? 'approval evidence digests match the approval binding' : 'approval evidence digests are missing, malformed, or diverge from the approval binding',
      ...(m.length ? { mismatches: m } : {}),
    });
  }

  // 3. Promotion evidence present.
  const havePromotion = promotionEvidence !== undefined;
  items.push({
    id: 'PROMOTION_EVIDENCE_PRESENT',
    required: true,
    status: havePromotion ? 'PASS' : 'FAIL',
    detail: havePromotion ? 'promotion evidence report supplied' : 'no promotion evidence report supplied',
  });

  // 4. Promotion evidence describes the SAME item/source/destination/root the approval authorized.
  if (!havePromotion || !approvalWellFormed) {
    items.push({ id: 'PROMOTION_MATCHES_APPROVAL', required: true, status: 'SKIPPED', detail: 'requires both a valid approval and a promotion evidence report' });
  } else {
    const m = promotionMismatches(approval, promotionEvidence!, targetRootEnum);
    items.push({
      id: 'PROMOTION_MATCHES_APPROVAL',
      required: true,
      status: m.length === 0 ? 'PASS' : 'FAIL',
      detail: m.length === 0 ? 'promotion evidence binds the same item, source, destination, and root as the approval' : 'promotion evidence diverges from the approved item/source/destination/root',
      ...(m.length ? { mismatches: m } : {}),
    });
  }

  // 5. Observed read-only Jellyfin real-library state is proven (not just a file-on-disk claim).
  if (!havePromotion) {
    items.push({ id: 'OBSERVED_JELLYFIN_STATE', required: true, status: 'SKIPPED', detail: 'requires a promotion evidence report' });
  } else {
    const observed = hasObservedState(promotionEvidence!);
    items.push({
      id: 'OBSERVED_JELLYFIN_STATE',
      required: true,
      status: observed ? 'PASS' : 'FAIL',
      detail: observed ? 'promotion evidence proves observed real-library visibility by exact path' : 'promotion evidence lacks observed read-only Jellyfin real-library visibility',
    });
  }

  // 6. Evidence review accepted THIS promotion evidence.
  if (evidenceReview === undefined) {
    items.push({ id: 'EVIDENCE_REVIEW_ACCEPTED', required: true, status: 'FAIL', detail: 'no promotion evidence review supplied' });
  } else {
    const accepted = evidenceReview.status === 'PROMOTION_EVIDENCE_ACCEPTED' && evidenceReview.ok === true;
    const tied = !havePromotion
      ? false
      : isSha256(evidenceReview.subjectEvidenceDigest) && evidenceReview.subjectEvidenceDigest === promotionEvidence!.evidenceDigest;
    const ok = accepted && tied;
    items.push({
      id: 'EVIDENCE_REVIEW_ACCEPTED',
      required: true,
      status: ok ? 'PASS' : 'FAIL',
      detail: ok ? 'evidence review accepted the supplied promotion evidence' : (!accepted ? 'evidence review did not accept the evidence' : 'evidence review is for a different promotion evidence report'),
    });
  }

  // 7. Self-check: nothing assembled so far leaks a raw path.
  const subjectEvidenceDigest = havePromotion && isSha256(promotionEvidence!.evidenceDigest) ? promotionEvidence!.evidenceDigest as string : undefined;
  const provisional = {
    targetRoot: targetRootEnum,
    ...(approvalIdDigest ? { approvalIdDigest } : {}),
    ...(itemDigest ? { itemDigest } : {}),
    ...(destinationNameDigest ? { destinationNameDigest } : {}),
    ...(subjectEvidenceDigest ? { subjectEvidenceDigest } : {}),
    items,
  };
  const noLeak = !hasRawPathLeak(provisional);
  items.push({
    id: 'NO_LEAK_IN_CHECKLIST',
    required: true,
    status: noLeak ? 'PASS' : 'FAIL',
    detail: noLeak ? 'assembled checklist contains no raw filesystem path' : 'assembled checklist contains a raw filesystem path',
  });

  const blockers = items.filter((i) => i.required && i.status !== 'PASS').map((i) => i.id);
  const verdict = blockers.length === 0 ? 'READY' : 'BLOCKED';

  const withoutDigest: Omit<PromotionReadinessChecklist, 'checklistDigest'> = {
    report: 'phase-230-promotion-readiness-checklist',
    version: 1,
    redactionSafe: true,
    verdict,
    targetRoot: targetRootEnum,
    ...(approvalIdDigest ? { approvalIdDigest } : {}),
    ...(itemDigest ? { itemDigest } : {}),
    ...(destinationNameDigest ? { destinationNameDigest } : {}),
    ...(subjectEvidenceDigest ? { subjectEvidenceDigest } : {}),
    items,
    blockers,
  };
  return { ...withoutDigest, checklistDigest: digest('phase-230-readiness-checklist', JSON.stringify(withoutDigest)) };
}

function approvalEvidenceMismatches(approval: Record<string, unknown>, evidence: Record<string, unknown>): string[] {
  const m: string[] = [];
  // A ready approval evidence must carry every one of these as a valid SHA-256 that matches the
  // approval binding. Missing or malformed (non-sha256) counts as a mismatch, never a pass.
  const expect = (actual: unknown, expected: string, code: string): void => {
    if (!isSha256(actual) || actual !== expected) m.push(code);
  };
  expect(evidence.itemDigest, digest('phase-230-item', approval.itemId as string), 'ITEM');
  expect(evidence.approvalIdDigest, digest('phase-230-approval', approval.approvalId as string), 'APPROVAL_ID');
  expect(evidence.sourceRealPathDigest, digest('phase-230-source-real-path', approval.sourceRealPath as string), 'SOURCE_REAL_PATH');
  expect(evidence.sourceSha256, approval.sourceSha256 as string, 'SOURCE_SHA256');
  expect(evidence.destinationPathDigest, digest('phase-230-destination-path', approval.destinationPath as string), 'DESTINATION_PATH');
  expect(evidence.destinationNameDigest, digest('phase-230-destination-name', basename(approval.destinationPath as string)), 'DESTINATION_NAME');
  return m;
}

function promotionMismatches(approval: Record<string, unknown>, evidence: Record<string, unknown>, targetRootEnum: string): string[] {
  const m: string[] = [];
  if (evidence.itemDigest !== digest('phase-230-item', approval.itemId as string)) m.push('ITEM');
  if (isNonEmpty(evidence.approvalDigest) && evidence.approvalDigest !== digest('phase-230-approval', approval.approvalId as string)) m.push('APPROVAL_ID');
  const file = asObject(evidence.file);
  if (file.sourceSha256 !== approval.sourceSha256) m.push('SOURCE');
  if (file.destinationNameDigest !== digest('phase-230-destination-name', basename(approval.destinationPath as string))) m.push('DESTINATION');
  if (evidence.targetRoot !== targetRootEnum) m.push('TARGET_ROOT');
  return m;
}

function hasObservedState(evidence: Record<string, unknown>): boolean {
  if (evidence.ok !== true) return false;
  const status = evidence.status;
  if (status !== 'REAL_LIBRARY_PROMOTION_VISIBLE' && status !== 'REAL_LIBRARY_PROMOTION_WITHDRAWN') return false;
  const jf = asObject(evidence.jellyfin);
  if (jf.awaited !== true || jf.visible !== true || jf.matchBasis !== 'path') return false;
  if (status === 'REAL_LIBRARY_PROMOTION_WITHDRAWN' && jf.absentAfterWithdrawal !== true) return false;
  return true;
}

// The checklist is built only from digests, enums, booleans, and fixed generic strings; this is a
// belt-and-suspenders scan proving no raw path slipped into what will be emitted.
function hasRawPathLeak(value: unknown): boolean {
  let leak = false;
  const walk = (v: unknown, key: string | undefined): void => {
    if (leak) return;
    if (typeof v === 'string') {
      if (key === 'targetRoot' && (v === '/mnt/user/media/Movies' || v === 'custom-real-movies-root' || v === 'unknown')) return;
      if (looksLikePath(v)) leak = true;
      return;
    }
    if (Array.isArray(v)) { for (const e of v) walk(e, key); return; }
    if (v && typeof v === 'object') { for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(val, k); }
  };
  walk(value, undefined);
  return leak;
}

function looksLikePath(s: string): boolean {
  return s.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(s)
    || s.includes('/mnt/')
    || s.includes('\\mnt\\')
    || s.includes('catalog-authority-test-library')
    || /\.(mkv|mp4|m4v|avi|mov|webm)$/i.test(s);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
