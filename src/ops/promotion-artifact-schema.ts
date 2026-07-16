import { createHash } from 'node:crypto';

// Local, non-live strict schema/status validator for Phase 230 offline artifacts. It checks each
// artifact's structural shape and status/verdict enums — independent of digests — so an artifact that
// is internally self-digested yet malformed (wrong report, bad version, invalid status, missing fields,
// not flagged redaction-safe) is still rejected. It reads parsed JSON only; it performs no promotion,
// never touches the real Movies root, never contacts Jellyfin, and authorizes nothing live.

export type ArtifactKind = 'approvalEvidence' | 'promotionEvidence' | 'evidenceReview' | 'readiness' | 'acceptancePacket';

export interface ArtifactBundle {
  readonly approvalEvidence?: unknown;
  readonly promotionEvidence?: unknown;
  readonly evidenceReview?: unknown;
  readonly readiness?: unknown;
  readonly acceptancePacket?: unknown;
}

export interface ArtifactSchemaReport {
  readonly report: 'phase-230-promotion-artifact-schema';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly ok: boolean;
  readonly checkedArtifacts: readonly string[];
  readonly problems: readonly string[];
  readonly schemaDigest: string;
}

interface KindSpec {
  readonly code: string;              // uppercase prefix for problem codes
  readonly report: string;
  readonly statusField: string;
  readonly statuses: readonly string[];
  readonly selfDigest: string;
  readonly required: readonly string[];
  readonly missing: string;
}

const SPECS: Record<ArtifactKind, KindSpec> = {
  approvalEvidence: {
    code: 'APPROVAL_EVIDENCE', report: 'phase-230-promotion-approval-attestation', statusField: 'status',
    statuses: ['APPROVAL_ATTESTATION_READY', 'APPROVAL_ATTESTATION_INVALID'], selfDigest: 'evidenceDigest',
    required: ['itemDigest', 'targetRoot', 'problems'], missing: 'APPROVAL_EVIDENCE_MISSING',
  },
  promotionEvidence: {
    code: 'PROMOTION_EVIDENCE', report: 'phase-230-real-library-promotion', statusField: 'status',
    statuses: ['REAL_LIBRARY_PROMOTION_VISIBLE', 'REAL_LIBRARY_PROMOTION_WITHDRAWN', 'REAL_LIBRARY_PROMOTION_FAILED'], selfDigest: 'evidenceDigest',
    required: ['ok', 'runDigest', 'itemDigest', 'lifecycle', 'forbidden', 'targetRoot'], missing: 'PROMOTION_EVIDENCE_MISSING',
  },
  evidenceReview: {
    code: 'EVIDENCE_REVIEW', report: 'phase-230-promotion-evidence-review', statusField: 'status',
    statuses: ['PROMOTION_EVIDENCE_ACCEPTED', 'PROMOTION_EVIDENCE_REJECTED'], selfDigest: 'reviewDigest',
    required: ['ok', 'checks', 'problems'], missing: 'EVIDENCE_REVIEW_MISSING',
  },
  readiness: {
    code: 'READINESS', report: 'phase-230-promotion-readiness-checklist', statusField: 'verdict',
    statuses: ['READY', 'BLOCKED'], selfDigest: 'checklistDigest',
    required: ['items', 'blockers', 'targetRoot'], missing: 'READINESS_MISSING',
  },
  acceptancePacket: {
    code: 'ACCEPTANCE_PACKET', report: 'phase-230-promotion-acceptance-packet', statusField: 'status',
    statuses: ['ACCEPTED_SEALED', 'ACCEPTANCE_REFUSED'], selfDigest: 'sealDigest',
    required: ['accepted', 'boundDigests', 'acceptance'], missing: 'ACCEPTANCE_PACKET_MISSING',
  },
};

const ARTIFACT_ORDER: readonly ArtifactKind[] = ['approvalEvidence', 'promotionEvidence', 'evidenceReview', 'readiness', 'acceptancePacket'];

// Validate a single artifact's schema/status. Returns generic problem codes (empty = valid).
export function validateArtifactSchema(kind: ArtifactKind, value: unknown): string[] {
  const spec = SPECS[kind];
  const problems: string[] = [];
  const obj = asObject(value);
  if (obj.report !== spec.report) problems.push(`${spec.code}_REPORT_INVALID`);
  if (obj.version !== 1) problems.push(`${spec.code}_VERSION_INVALID`);
  if (obj.redactionSafe !== true) problems.push(`${spec.code}_NOT_REDACTION_SAFE`);
  if (typeof obj[spec.statusField] !== 'string' || !spec.statuses.includes(obj[spec.statusField] as string)) problems.push(`${spec.code}_STATUS_INVALID`);
  if (!isSha256(obj[spec.selfDigest])) problems.push(`${spec.code}_SELF_DIGEST_MALFORMED`);
  for (const field of spec.required) {
    if (obj[field] === undefined) problems.push(`${spec.code}_MISSING_FIELD`);
  }
  return problems;
}

export function validateArtifactSchemas(bundle: ArtifactBundle): ArtifactSchemaReport {
  const problems: string[] = [];
  const checkedArtifacts: string[] = [];
  for (const kind of ARTIFACT_ORDER) {
    const value = (bundle as Record<string, unknown>)[kind];
    if (value === undefined) { problems.push(SPECS[kind].missing); continue; }
    checkedArtifacts.push(kind);
    problems.push(...validateArtifactSchema(kind, value));
  }
  const ok = problems.length === 0;
  const withoutDigest: Omit<ArtifactSchemaReport, 'schemaDigest'> = {
    report: 'phase-230-promotion-artifact-schema',
    version: 1,
    redactionSafe: true,
    ok,
    checkedArtifacts,
    problems,
  };
  return { ...withoutDigest, schemaDigest: digest('phase-230-artifact-schema', JSON.stringify(withoutDigest)) };
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
