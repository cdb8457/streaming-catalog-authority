import { createHash } from 'node:crypto';

// Local, non-live acceptance packet/seal — the final coordinator sign-off layer for a Phase 230
// promotion. It takes a READY promotion readiness checklist (and, optionally, the evidence review
// and approval evidence), re-verifies the checklist is untampered and READY, requires an explicit
// human ACCEPT decision, and emits a redaction-safe, tamper-evident sealed acceptance packet.
//
// It reads parsed JSON only. It performs no promotion, never touches the real Movies root, never
// contacts Jellyfin, and authorizes nothing live: a sealed packet records a coordinator's paperwork
// acceptance, not a live gate, and does not authorize Phase 231.

export interface AcceptanceDecisionInput {
  readonly accepted?: boolean;
  readonly decision?: string; // 'ACCEPT' | 'REJECT'
  readonly acceptorId?: string;
}

export interface AcceptanceSealInput {
  readonly readinessChecklist?: unknown;
  readonly evidenceReview?: unknown;   // optional: binds the review digest and re-checks the tie
  readonly approvalEvidence?: unknown; // optional: binds the approval evidence digest
  readonly acceptance?: AcceptanceDecisionInput;
}

export type AcceptanceRefusal =
  | 'READINESS_INVALID'
  | 'READINESS_DIGEST_MISMATCH'
  | 'READINESS_NOT_READY'
  | 'ACCEPTOR_MISSING'
  | 'ACCEPTANCE_REJECTED'
  | 'ACCEPTANCE_NOT_GIVEN'
  | 'EVIDENCE_REVIEW_INCONSISTENT'
  | 'RAW_PATH_IN_PACKET';

export interface PromotionAcceptancePacket {
  readonly report: 'phase-230-promotion-acceptance-packet';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly status: 'ACCEPTED_SEALED' | 'ACCEPTANCE_REFUSED';
  readonly accepted: boolean;
  readonly readiness: {
    readonly verdict: 'READY' | 'BLOCKED' | 'UNKNOWN';
    readonly checklistVerified: boolean;
  };
  readonly boundDigests: {
    readonly checklistDigest?: string;
    readonly itemDigest?: string;
    readonly destinationNameDigest?: string;
    readonly subjectEvidenceDigest?: string;
    readonly evidenceReviewDigest?: string;
    readonly approvalEvidenceDigest?: string;
  };
  readonly acceptance: {
    readonly decision: 'ACCEPT' | 'REJECT' | 'NONE';
    readonly acceptorDigest?: string;
  };
  readonly refusals: readonly AcceptanceRefusal[];
  readonly sealDigest: string;
}

export function sealPromotionAcceptance(input: AcceptanceSealInput): PromotionAcceptancePacket {
  const refusals = new Set<AcceptanceRefusal>();
  const checklist = asObject(input.readinessChecklist);
  const review = input.evidenceReview === undefined ? undefined : asObject(input.evidenceReview);
  const approvalEvidence = input.approvalEvidence === undefined ? undefined : asObject(input.approvalEvidence);
  const acceptance = input.acceptance ?? {};

  // Readiness checklist must be the right document, untampered, and READY.
  const checklistLooksValid = checklist.report === 'phase-230-promotion-readiness-checklist' && checklist.version === 1;
  if (!checklistLooksValid) refusals.add('READINESS_INVALID');
  const checklistVerified = checklistLooksValid && verifyChecklistDigest(checklist);
  if (checklistLooksValid && !checklistVerified) refusals.add('READINESS_DIGEST_MISMATCH');
  const verdict: PromotionAcceptancePacket['readiness']['verdict'] =
    checklist.verdict === 'READY' ? 'READY' : checklist.verdict === 'BLOCKED' ? 'BLOCKED' : 'UNKNOWN';
  if (!(checklistVerified && verdict === 'READY')) refusals.add('READINESS_NOT_READY');

  // Human acceptance decision.
  const decision: PromotionAcceptancePacket['acceptance']['decision'] =
    acceptance.decision === 'ACCEPT' ? 'ACCEPT' : acceptance.decision === 'REJECT' ? 'REJECT' : 'NONE';
  if (!isNonEmpty(acceptance.acceptorId)) refusals.add('ACCEPTOR_MISSING');
  if (decision === 'REJECT') refusals.add('ACCEPTANCE_REJECTED');
  else if (!(decision === 'ACCEPT' && acceptance.accepted === true)) refusals.add('ACCEPTANCE_NOT_GIVEN');

  // Optional evidence review must be an acceptance tied to the same promotion evidence.
  if (review !== undefined) {
    const tied = isSha256(checklist.subjectEvidenceDigest)
      && isSha256(review.subjectEvidenceDigest)
      && review.subjectEvidenceDigest === checklist.subjectEvidenceDigest;
    const acceptedReview = review.report === 'phase-230-promotion-evidence-review' && review.ok === true && review.status === 'PROMOTION_EVIDENCE_ACCEPTED';
    if (!(tied && acceptedReview)) refusals.add('EVIDENCE_REVIEW_INCONSISTENT');
  }

  const boundDigests = {
    ...(isSha256(checklist.checklistDigest) ? { checklistDigest: checklist.checklistDigest as string } : {}),
    ...(isSha256(checklist.itemDigest) ? { itemDigest: checklist.itemDigest as string } : {}),
    ...(isSha256(checklist.destinationNameDigest) ? { destinationNameDigest: checklist.destinationNameDigest as string } : {}),
    ...(isSha256(checklist.subjectEvidenceDigest) ? { subjectEvidenceDigest: checklist.subjectEvidenceDigest as string } : {}),
    ...(review && isSha256(review.reviewDigest) ? { evidenceReviewDigest: review.reviewDigest as string } : {}),
    ...(approvalEvidence && isSha256(approvalEvidence.evidenceDigest) ? { approvalEvidenceDigest: approvalEvidence.evidenceDigest as string } : {}),
  };

  const acceptorDigest = isNonEmpty(acceptance.acceptorId) ? digest('phase-230-acceptor', acceptance.acceptorId) : undefined;

  const body: Omit<PromotionAcceptancePacket, 'sealDigest'> = {
    report: 'phase-230-promotion-acceptance-packet',
    version: 1,
    redactionSafe: true,
    status: refusals.size === 0 ? 'ACCEPTED_SEALED' : 'ACCEPTANCE_REFUSED',
    accepted: refusals.size === 0,
    readiness: { verdict, checklistVerified },
    boundDigests,
    acceptance: { decision, ...(acceptorDigest ? { acceptorDigest } : {}) },
    refusals: [...refusals],
  };

  // Belt-and-suspenders: the packet is assembled only from digests/enums/booleans; prove no raw path.
  if (hasRawPathLeak(body)) {
    const refusalsWithLeak = new Set(body.refusals);
    refusalsWithLeak.add('RAW_PATH_IN_PACKET');
    const leaked: Omit<PromotionAcceptancePacket, 'sealDigest'> = {
      ...body,
      status: 'ACCEPTANCE_REFUSED',
      accepted: false,
      refusals: [...refusalsWithLeak],
    };
    return { ...leaked, sealDigest: digest('phase-230-acceptance-seal', JSON.stringify(leaked)) };
  }

  return { ...body, sealDigest: digest('phase-230-acceptance-seal', JSON.stringify(body)) };
}

export interface AcceptanceSealVerification {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export function verifyAcceptanceSeal(candidate: unknown): AcceptanceSealVerification {
  const problems: string[] = [];
  const packet = asObject(candidate);
  if (packet.report !== 'phase-230-promotion-acceptance-packet' || packet.version !== 1) problems.push('PACKET_TYPE_INVALID');
  if (!isSha256(packet.sealDigest) || !verifySealDigest(packet)) problems.push('SEAL_DIGEST_MISMATCH');
  const sealedAccepted = packet.status === 'ACCEPTED_SEALED';
  const refused = packet.status === 'ACCEPTANCE_REFUSED';
  const refusalsLen = Array.isArray(packet.refusals) ? packet.refusals.length : -1;
  if (sealedAccepted && (packet.accepted !== true || refusalsLen !== 0)) problems.push('STATUS_INCONSISTENT');
  if (refused && (packet.accepted !== false || refusalsLen <= 0)) problems.push('STATUS_INCONSISTENT');
  if (!sealedAccepted && !refused) problems.push('STATUS_INCONSISTENT');
  return { ok: problems.length === 0, problems };
}

function verifyChecklistDigest(checklist: Record<string, unknown>): boolean {
  const claimed = checklist.checklistDigest;
  if (!isSha256(claimed)) return false;
  const withoutDigest: Record<string, unknown> = {};
  for (const key of Object.keys(checklist)) if (key !== 'checklistDigest') withoutDigest[key] = checklist[key];
  return digest('phase-230-readiness-checklist', JSON.stringify(withoutDigest)) === claimed;
}

function verifySealDigest(packet: Record<string, unknown>): boolean {
  const claimed = packet.sealDigest;
  if (!isSha256(claimed)) return false;
  const withoutDigest: Record<string, unknown> = {};
  for (const key of Object.keys(packet)) if (key !== 'sealDigest') withoutDigest[key] = packet[key];
  return digest('phase-230-acceptance-seal', JSON.stringify(withoutDigest)) === claimed;
}

function hasRawPathLeak(value: unknown): boolean {
  let leak = false;
  const walk = (v: unknown): void => {
    if (leak) return;
    if (typeof v === 'string') { if (looksLikePath(v)) leak = true; return; }
    if (Array.isArray(v)) { for (const e of v) walk(e); return; }
    if (v && typeof v === 'object') { for (const val of Object.values(v as Record<string, unknown>)) walk(val); }
  };
  walk(value);
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
