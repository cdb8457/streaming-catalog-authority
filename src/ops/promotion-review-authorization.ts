import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';
import { REVIEW_PLACEHOLDER, type ReviewMatrixRow } from './promotion-review-matrix.js';

// Local, non-live coordinator review-authorization scaffold. It is NOT-authorized by default and becomes
// LOCAL_REVIEW_AUTHORIZED only when valid offline evidence is supplied: the terminal readiness v2 record
// (present, valid, CONFIRMED, self-digest recomputes) AND the coordinator review matrix (present, valid,
// READY, self-digest recomputes). It then INCLUDES the exact reviewed commit/test matrix placeholders (all
// PENDING) for the human to complete. `authorized` here is strictly LOCAL -- it means the offline evidence
// is complete and the review scaffold is ready for a human -- and it NEVER means live authorization. It
// reads parsed JSON only; it performs no promotion, never touches the real Movies root, never contacts
// Jellyfin, and its `authorization` field is the constant NONE. LOCAL_REVIEW_AUTHORIZED does NOT authorize
// Phase 231 or any live promotion / merge / tag / master -- those remain separate human steps not performed
// or authorized here.

export interface ReviewAuthorizationInput {
  readonly readiness?: unknown;    // phase-230-promotion-terminal-readiness-v2
  readonly reviewMatrix?: unknown; // phase-230-promotion-review-matrix
}

export const REVIEW_AUTHORIZATION_HUMAN_GATES: readonly string[] = [
  'Human completion of every PENDING placeholder in the included review matrix.',
  'Explicit coordinator sign-off recorded via the acceptance seal.',
  'The merge / tag / push-to-master action itself -- a human operator step NOT performed or authorized here.',
  'Phase 231 authorization, which is NOT granted by any tool, doc, or artifact here.',
];

export const REVIEW_AUTHORIZATION_BOUNDARY =
  'No deploy launcher run, no real media-library write, no live Jellyfin call, no merge/tag/push/master, and no Phase 231 or live-promotion authorization is implied or performed by this scaffold.';

export const REVIEW_AUTHORIZATION_DISCLAIMERS: readonly string[] = [
  'LOCAL_REVIEW_AUTHORIZED means only that the offline evidence is valid and the review scaffold is ready for a human.',
  'It does NOT authorize Phase 231, live promotion, or any merge/tag/master action.',
  'No live Jellyfin call or real media write is implied or performed by this scaffold.',
  'This is a redaction-safe, deterministic scaffold over offline records only.',
];

export interface ReviewAuthorizationReport {
  readonly report: 'phase-230-promotion-review-authorization';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'LOCAL_REVIEW_AUTHORIZED' | 'LOCAL_REVIEW_NOT_AUTHORIZED';
  readonly evidenceValid: boolean;
  readonly matrixValid: boolean;
  readonly reviewedCommitCount: number;
  readonly reviewedTestCount: number;
  readonly placeholders: readonly ReviewMatrixRow[];
  readonly boundDigests: Readonly<Record<string, string>>;
  readonly humanGates: readonly string[];
  readonly boundary: string;
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly authorizationDigest: string;
}

export function buildReviewAuthorization(input: ReviewAuthorizationInput): ReviewAuthorizationReport {
  const blockers: string[] = [];
  const boundDigests: Record<string, string> = {};

  // Valid offline evidence: the terminal readiness v2 record must recompute and be CONFIRMED.
  let evidenceValid = false;
  const r = input.readiness;
  if (r === undefined) blockers.push('READINESS_MISSING');
  else {
    const o = asObject(r);
    if (o.report !== 'phase-230-promotion-terminal-readiness-v2') blockers.push('READINESS_INVALID');
    else {
      const d = asSha256(o.readinessV2Digest);
      const verified = d !== undefined && verifySelfDigests([o]).results[0]?.verified === true;
      if (o.readinessV2Digest === undefined) blockers.push('COMPONENT_DIGEST_MISSING');
      else if (d === undefined) blockers.push('COMPONENT_DIGEST_INVALID');
      else if (!verified) blockers.push('COMPONENT_DIGEST_MISMATCH');
      const green = o.overall === 'TERMINAL_READINESS_V2_CONFIRMED';
      if (!green) blockers.push('READINESS_NOT_CONFIRMED');
      if (verified) boundDigests['terminal-readiness-v2'] = d;
      evidenceValid = verified && green;
    }
  }

  // The review matrix must recompute and be READY; its exact placeholders are then included.
  let matrixValid = false;
  let placeholders: ReviewMatrixRow[] = [];
  let reviewedCommitCount = 0;
  let reviewedTestCount = 0;
  const rm = input.reviewMatrix;
  if (rm === undefined) blockers.push('REVIEW_MATRIX_MISSING');
  else {
    const o = asObject(rm);
    if (o.report !== 'phase-230-promotion-review-matrix') blockers.push('REVIEW_MATRIX_INVALID');
    else {
      const d = asSha256(o.reviewMatrixDigest);
      const verified = d !== undefined && verifySelfDigests([o]).results[0]?.verified === true;
      if (o.reviewMatrixDigest === undefined) blockers.push('COMPONENT_DIGEST_MISSING');
      else if (d === undefined) blockers.push('COMPONENT_DIGEST_INVALID');
      else if (!verified) blockers.push('COMPONENT_DIGEST_MISMATCH');
      const green = o.overall === 'REVIEW_MATRIX_READY';
      if (!green) blockers.push('REVIEW_MATRIX_NOT_READY');
      if (verified) boundDigests['review-matrix'] = d;
      matrixValid = verified && green;
      if (matrixValid) {
        placeholders = sanitizePlaceholders(o.rows);
        reviewedCommitCount = placeholders.length;
        reviewedTestCount = placeholders[0]?.tests.length ?? 0;
      }
    }
  }

  const uniqueBlockers = [...new Set(blockers)];
  const overall: ReviewAuthorizationReport['overall'] = uniqueBlockers.length === 0 ? 'LOCAL_REVIEW_AUTHORIZED' : 'LOCAL_REVIEW_NOT_AUTHORIZED';
  const withoutDigest: Omit<ReviewAuthorizationReport, 'authorizationDigest'> = {
    report: 'phase-230-promotion-review-authorization',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    evidenceValid,
    matrixValid,
    reviewedCommitCount,
    reviewedTestCount,
    placeholders,
    boundDigests,
    humanGates: REVIEW_AUTHORIZATION_HUMAN_GATES,
    boundary: REVIEW_AUTHORIZATION_BOUNDARY,
    blockers: uniqueBlockers,
    disclaimers: REVIEW_AUTHORIZATION_DISCLAIMERS,
  };
  return { ...withoutDigest, authorizationDigest: digest('phase-230-review-authorization', JSON.stringify(withoutDigest)) };
}

// Re-emit only redaction-safe placeholder cells: a sha40 id, path-free test labels, and the fixed PENDING
// placeholder -- never a completed outcome and never a raw path, regardless of the matrix contents.
function sanitizePlaceholders(rows: unknown): ReviewMatrixRow[] {
  if (!Array.isArray(rows)) return [];
  const out: ReviewMatrixRow[] = [];
  for (const row of rows) {
    const o = asObject(row);
    const sha = asSha40(o.sha);
    if (sha === undefined) continue;
    const rawTests = Array.isArray(o.tests) ? o.tests : [];
    const tests = rawTests
      .map((t) => pathFreeString(asObject(t).test))
      .filter((label): label is string => label !== null)
      .map((test) => ({ test, result: REVIEW_PLACEHOLDER }));
    out.push({ sha, humanReviewed: REVIEW_PLACEHOLDER, signedOff: REVIEW_PLACEHOLDER, tests });
  }
  return out;
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
function pathFreeString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (/^\//.test(value) || /[A-Za-z]:[\\/]/.test(value) || /\/mnt\//.test(value) || /\\mnt\\/.test(value)
    || value.includes('catalog-authority-test-library') || /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i.test(value)) return null;
  return value;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
