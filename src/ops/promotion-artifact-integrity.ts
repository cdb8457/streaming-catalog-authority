import { createHash } from 'node:crypto';

// Local, non-live integrity verifier for a Phase 230 artifact bundle. It confirms that every supplied
// artifact's own self-digest recomputes (tamper detection), that the cross-artifact digest chain is
// consistent (approval evidence → promotion evidence → review → readiness → acceptance packet), and
// that no artifact is missing. It reads parsed JSON only; it performs no promotion, never touches the
// real Movies root, never contacts Jellyfin, and authorizes nothing live.

export interface ArtifactBundle {
  readonly approvalEvidence?: unknown;
  readonly promotionEvidence?: unknown;
  readonly evidenceReview?: unknown;
  readonly readiness?: unknown;
  readonly acceptancePacket?: unknown;
}

export interface ArtifactIntegrityReport {
  readonly report: 'phase-230-promotion-artifact-integrity';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly ok: boolean;
  readonly checkedArtifacts: readonly string[];
  readonly problems: readonly string[];
  readonly integrityDigest: string;
}

// artifact key -> { self-digest field, digest scope }
const SELF_DIGEST_SPEC: Record<string, { field: string; scope: string; code: string; missing: string }> = {
  approvalEvidence: { field: 'evidenceDigest', scope: 'phase-230-approval-evidence', code: 'APPROVAL_EVIDENCE_SELF_DIGEST_MISMATCH', missing: 'APPROVAL_EVIDENCE_MISSING' },
  promotionEvidence: { field: 'evidenceDigest', scope: 'phase-230-report', code: 'PROMOTION_EVIDENCE_SELF_DIGEST_MISMATCH', missing: 'PROMOTION_EVIDENCE_MISSING' },
  evidenceReview: { field: 'reviewDigest', scope: 'phase-230-evidence-review', code: 'EVIDENCE_REVIEW_SELF_DIGEST_MISMATCH', missing: 'EVIDENCE_REVIEW_MISSING' },
  readiness: { field: 'checklistDigest', scope: 'phase-230-readiness-checklist', code: 'READINESS_SELF_DIGEST_MISMATCH', missing: 'READINESS_MISSING' },
  acceptancePacket: { field: 'sealDigest', scope: 'phase-230-acceptance-seal', code: 'ACCEPTANCE_PACKET_SELF_DIGEST_MISMATCH', missing: 'ACCEPTANCE_PACKET_MISSING' },
};

const ARTIFACT_ORDER = ['approvalEvidence', 'promotionEvidence', 'evidenceReview', 'readiness', 'acceptancePacket'] as const;

export function verifyArtifactIntegrity(bundle: ArtifactBundle): ArtifactIntegrityReport {
  const problems: string[] = [];
  const checkedArtifacts: string[] = [];
  const present: Record<string, Record<string, unknown> | undefined> = {};

  for (const key of ARTIFACT_ORDER) {
    const spec = SELF_DIGEST_SPEC[key]!;
    const value = (bundle as Record<string, unknown>)[key];
    if (value === undefined) { problems.push(spec.missing); continue; }
    const obj = asObject(value);
    present[key] = obj;
    checkedArtifacts.push(key);
    if (!selfDigestValid(obj, spec.field, spec.scope)) problems.push(spec.code);
  }

  const promotionDigest = present.promotionEvidence ? present.promotionEvidence.evidenceDigest : undefined;

  // Cross-artifact chain (checked only where both ends are present).
  if (present.evidenceReview && present.promotionEvidence) {
    if (present.evidenceReview.subjectEvidenceDigest !== promotionDigest) problems.push('REVIEW_TO_PROMOTION_MISMATCH');
  }
  if (present.readiness && present.promotionEvidence) {
    if (present.readiness.subjectEvidenceDigest !== promotionDigest) problems.push('READINESS_TO_PROMOTION_MISMATCH');
  }
  if (present.acceptancePacket) {
    const bound = asObject(present.acceptancePacket.boundDigests);
    if (present.readiness && bound.checklistDigest !== present.readiness.checklistDigest) problems.push('PACKET_TO_READINESS_MISMATCH');
    if (present.promotionEvidence && bound.subjectEvidenceDigest !== promotionDigest) problems.push('PACKET_TO_PROMOTION_MISMATCH');
    if (present.evidenceReview && bound.evidenceReviewDigest !== present.evidenceReview.reviewDigest) problems.push('PACKET_TO_REVIEW_MISMATCH');
    if (present.approvalEvidence && bound.approvalEvidenceDigest !== present.approvalEvidence.evidenceDigest) problems.push('PACKET_TO_APPROVAL_EVIDENCE_MISMATCH');
  }

  const ok = problems.length === 0;
  const withoutDigest: Omit<ArtifactIntegrityReport, 'integrityDigest'> = {
    report: 'phase-230-promotion-artifact-integrity',
    version: 1,
    redactionSafe: true,
    ok,
    checkedArtifacts,
    problems,
  };
  return { ...withoutDigest, integrityDigest: digest('phase-230-artifact-integrity', JSON.stringify(withoutDigest)) };
}

function selfDigestValid(obj: Record<string, unknown>, field: string, scope: string): boolean {
  const claimed = obj[field];
  if (!isSha256(claimed)) return false;
  const without: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) if (k !== field) without[k] = obj[k];
  return digest(scope, JSON.stringify(without)) === claimed;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
