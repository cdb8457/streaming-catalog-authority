import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';
import { REVIEW_PLACEHOLDER, type ReviewMatrixRow } from './promotion-review-matrix.js';

// Local, non-live coordinator review-authorization scaffold. It is NOT-authorized by default and becomes
// LOCAL_REVIEW_AUTHORIZED only when valid offline evidence is supplied AND the review matrix binds to the
// AUTHORITATIVE context behind readiness. The authoritative context is derived from evidence that is
// cryptographically chained to the readiness record -- not from any self-echoed field -- so a stale or
// forged/resealed matrix cannot ride through:
//   readiness (CONFIRMED) -> boundDigests['terminal-closure'] == terminalClosure.terminalDigest,
//   terminalClosure (CONFIRMED) -> boundDigests['commit-range-closure'] == commitRangeClosure.closureDigest
//                                and boundDigests['transcript-verification'] == transcriptVerification.verificationDigest.
// The commit range (base / head / ordered commit shas) then comes from commit-range-closure and the required
// test set from transcript-verification; the review matrix must match them EXACTLY (ordered commits, test
// set). Every consumed report's self-digest is recomputed. It reads parsed JSON only; it performs no
// promotion, never touches the real Movies root, never contacts Jellyfin, and its `authorization` field is
// the constant NONE. LOCAL_REVIEW_AUTHORIZED is strictly LOCAL and does NOT authorize Phase 231, live
// promotion, or any merge/tag/master -- those remain separate human steps not performed or authorized here.

export interface ReviewAuthorizationInput {
  readonly readiness?: unknown;               // phase-230-promotion-terminal-readiness-v2
  readonly terminalClosure?: unknown;         // phase-230-promotion-terminal-closure-manifest
  readonly commitRangeClosure?: unknown;      // phase-230-promotion-commit-range-closure
  readonly transcriptVerification?: unknown;  // phase-230-promotion-transcript-verification
  readonly reviewMatrix?: unknown;            // phase-230-promotion-review-matrix
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
  'LOCAL_REVIEW_AUTHORIZED means only that the offline evidence is valid, chained, and the matrix binds to the authoritative context.',
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
  readonly contextBound: boolean;
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
  const readiness = validate(input.readiness, 'phase-230-promotion-terminal-readiness-v2', 'readinessV2Digest',
    (o) => o.overall === 'TERMINAL_READINESS_V2_CONFIRMED', 'READINESS_MISSING', 'READINESS_INVALID', 'READINESS_NOT_CONFIRMED', blockers);
  if (readiness.verified) boundDigests['terminal-readiness-v2'] = readiness.digest!;
  const evidenceValid = readiness.ok;

  // The terminal closure record must recompute, be CONFIRMED, and be the one bound inside readiness.
  const terminalClosure = validate(input.terminalClosure, 'phase-230-promotion-terminal-closure-manifest', 'terminalDigest',
    (o) => o.overall === 'TERMINAL_CLOSURE_CONFIRMED', 'TERMINAL_CLOSURE_MISSING', 'TERMINAL_CLOSURE_INVALID', 'TERMINAL_CLOSURE_NOT_CONFIRMED', blockers);
  if (terminalClosure.verified) boundDigests['terminal-closure'] = terminalClosure.digest!;
  const terminalBound = readiness.verified && terminalClosure.verified
    && boundDigestOf(readiness.obj, 'terminal-closure') === terminalClosure.digest;
  if (readiness.verified && terminalClosure.verified && !terminalBound) blockers.push('TERMINAL_CLOSURE_NOT_BOUND');

  // The commit-range closure must recompute, be RANGE_CLOSED, and be the one bound inside terminal closure.
  const commitRange = validate(input.commitRangeClosure, 'phase-230-promotion-commit-range-closure', 'closureDigest',
    (o) => o.overall === 'RANGE_CLOSED', 'COMMIT_RANGE_CLOSURE_MISSING', 'COMMIT_RANGE_CLOSURE_INVALID', 'COMMIT_RANGE_NOT_CLOSED', blockers);
  if (commitRange.verified) boundDigests['commit-range-closure'] = commitRange.digest!;
  const commitRangeBound = terminalClosure.verified && commitRange.verified
    && boundDigestOf(terminalClosure.obj, 'commit-range-closure') === commitRange.digest;
  if (terminalClosure.verified && commitRange.verified && !commitRangeBound) blockers.push('COMMIT_RANGE_NOT_BOUND');

  // The transcript verification must recompute, be VERIFIED, and be the one bound inside terminal closure.
  const transcript = validate(input.transcriptVerification, 'phase-230-promotion-transcript-verification', 'verificationDigest',
    (o) => o.overall === 'TRANSCRIPT_VERIFIED', 'TRANSCRIPT_VERIFICATION_MISSING', 'TRANSCRIPT_VERIFICATION_INVALID', 'TRANSCRIPT_VERIFICATION_NOT_VERIFIED', blockers);
  if (transcript.verified) boundDigests['transcript-verification'] = transcript.digest!;
  const transcriptBound = terminalClosure.verified && transcript.verified
    && boundDigestOf(terminalClosure.obj, 'transcript-verification') === transcript.digest;
  if (terminalClosure.verified && transcript.verified && !transcriptBound) blockers.push('TRANSCRIPT_VERIFICATION_NOT_BOUND');

  // The review matrix must recompute and be READY; its placeholders are then included.
  const matrix = validate(input.reviewMatrix, 'phase-230-promotion-review-matrix', 'reviewMatrixDigest',
    (o) => o.overall === 'REVIEW_MATRIX_READY', 'REVIEW_MATRIX_MISSING', 'REVIEW_MATRIX_INVALID', 'REVIEW_MATRIX_NOT_READY', blockers);
  if (matrix.verified) boundDigests['review-matrix'] = matrix.digest!;
  const matrixValid = matrix.ok;

  let placeholders: ReviewMatrixRow[] = [];
  let reviewedCommitCount = 0;
  let reviewedTestCount = 0;
  if (matrixValid) {
    placeholders = sanitizePlaceholders(matrix.obj.rows);
    reviewedCommitCount = placeholders.length;
    reviewedTestCount = placeholders[0]?.tests.length ?? 0;
  }

  // Bind the review matrix EXACTLY to the authoritative context -- but only when the evidence chain that
  // makes the context authoritative is fully intact, so a stitched matrix cannot pass on an unbound chain.
  let contextBound = false;
  const chainIntact = evidenceValid && terminalClosure.ok && terminalBound
    && commitRange.ok && commitRangeBound && transcript.ok && transcriptBound;
  if (chainIntact && matrixValid) {
    const authBase = asSha40(commitRange.obj.base);
    const authHead = asSha40(commitRange.obj.head);
    const authShas = Array.isArray(commitRange.obj.results)
      ? commitRange.obj.results.map((r) => asSha40(asObject(r).sha)).filter((s): s is string => s !== undefined)
      : [];
    const authTests = Array.isArray(transcript.obj.commandResults)
      ? transcript.obj.commandResults.map((c) => strOrNull(asObject(c).command)).filter((s): s is string => s !== null)
      : [];

    const mBase = asSha40(matrix.obj.base);
    const mHead = asSha40(matrix.obj.head);
    const mShas = placeholders.map((r) => r.sha);
    const mTests = [...new Set(placeholders.flatMap((r) => r.tests.map((t) => t.test)))];

    if (!(authBase !== undefined && mBase === authBase)) blockers.push('CONTEXT_BASE_MISMATCH');
    if (!(authHead !== undefined && mHead === authHead)) blockers.push('CONTEXT_HEAD_MISMATCH');
    const commitsMatch = authShas.length > 0 && mShas.length === authShas.length && mShas.every((s, i) => s === authShas[i]);
    if (!commitsMatch) blockers.push('CONTEXT_COMMITS_MISMATCH');
    const testsMatch = authTests.length > 0 && sameStringSet(mTests, authTests);
    if (!testsMatch) blockers.push('CONTEXT_REQUIRED_TESTS_MISMATCH');

    contextBound = (authBase !== undefined && mBase === authBase) && (authHead !== undefined && mHead === authHead) && commitsMatch && testsMatch;
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
    contextBound,
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

interface Validated { readonly obj: Record<string, unknown>; readonly verified: boolean; readonly ok: boolean; readonly digest: string | undefined; }

// Present + right report id + self-digest recomputes + green. Pushes the focused blockers; `ok` means fully
// valid + green, `verified` means the self-digest recomputes (so its digest may be chained/bound).
function validate(value: unknown, reportId: string, digestField: string, green: (o: Record<string, unknown>) => boolean,
  missing: string, invalid: string, notOk: string, blockers: string[]): Validated {
  if (value === undefined) { blockers.push(missing); return { obj: {}, verified: false, ok: false, digest: undefined }; }
  const obj = asObject(value);
  if (obj.report !== reportId) { blockers.push(invalid); return { obj, verified: false, ok: false, digest: undefined }; }
  const raw = obj[digestField];
  const d = asSha256(raw);
  const verified = d !== undefined && verifySelfDigests([obj]).results[0]?.verified === true;
  if (raw === undefined) blockers.push('COMPONENT_DIGEST_MISSING');
  else if (d === undefined) blockers.push('COMPONENT_DIGEST_INVALID');
  else if (!verified) blockers.push('COMPONENT_DIGEST_MISMATCH');
  const isGreen = green(obj);
  if (!isGreen) blockers.push(notOk);
  return { obj, verified, ok: verified && isGreen, digest: verified ? d : undefined };
}

function boundDigestOf(report: Record<string, unknown>, component: string): string | undefined {
  return asSha256(asObject(report.boundDigests)[component]);
}
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
function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
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
function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
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
