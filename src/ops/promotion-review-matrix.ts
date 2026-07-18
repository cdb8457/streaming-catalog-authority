import { createHash } from 'node:crypto';

// Local, non-live coordinator review matrix. It emits a redaction-safe SCAFFOLD for human review: a matrix
// of every commit in the range crossed with every required test suite, plus per-commit human-review and
// sign-off slots -- all left as `PENDING` PLACEHOLDERS for a human reviewer to complete out-of-band. It
// records ONLY commit shas (hex), path-free test labels, counts, and the fixed `PENDING` placeholder; it
// never echoes commit subjects or any raw path, and it fails closed on missing/malformed range or test
// inputs. It reads parsed JSON only; it performs no promotion, never touches the real Movies root, never
// contacts Jellyfin, and authorizes nothing. A completed matrix -- even one a human fills entirely with
// approvals -- does NOT authorize Phase 231 or any live promotion; that remains a separate human step.

export interface ReviewMatrixInput {
  readonly base?: unknown;
  readonly head?: unknown;
  readonly commits?: unknown;      // [{ sha, subject? }]
  readonly requiredTests?: unknown; // string[]
}

// The only value this tool ever emits into a review cell. A human replaces it out-of-band; the set of
// outcomes a human MAY record is documented but never produced or interpreted here.
export const REVIEW_PLACEHOLDER = 'PENDING';
export const HUMAN_REVIEW_OUTCOMES: readonly string[] = ['PENDING', 'PASS', 'FAIL', 'APPROVED', 'REJECTED'];

export const REVIEW_MATRIX_HUMAN_GATES: readonly string[] = [
  'Human review of each commit and its diff (the humanReviewed placeholders).',
  'Human confirmation of each test result (the per-commit/test placeholders).',
  'Explicit coordinator sign-off per commit (the signedOff placeholders).',
  'The merge / tag / push-to-master action itself -- a human operator step NOT performed or authorized here.',
  'Phase 231 authorization, which is NOT granted by any tool, doc, or artifact here.',
];

export const REVIEW_MATRIX_BOUNDARY =
  'No deploy launcher run, no real media-library write, no live Jellyfin call, no merge/tag/push/master, and no Phase 231 or live-promotion authorization is implied or performed by this matrix.';

export const REVIEW_MATRIX_DISCLAIMERS: readonly string[] = [
  'This matrix is an EMPTY review scaffold: every review cell is a PENDING placeholder for a human.',
  'A completed matrix -- even one filled entirely with approvals -- does NOT authorize Phase 231 or any live promotion.',
  'No live Jellyfin call or real media write is implied or performed by this matrix.',
  'This is a redaction-safe, deterministic scaffold over offline records only.',
];

export interface ReviewTestCell { readonly test: string; readonly result: string; }
export interface ReviewMatrixRow {
  readonly sha: string;
  readonly humanReviewed: string;
  readonly signedOff: string;
  readonly tests: readonly ReviewTestCell[];
}

export interface ReviewMatrixReport {
  readonly report: 'phase-230-promotion-review-matrix';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'REVIEW_MATRIX_READY' | 'REVIEW_MATRIX_BLOCKED';
  readonly base: string | null;
  readonly head: string | null;
  readonly commitCount: number;
  readonly testCount: number;
  readonly placeholderCount: number;
  readonly rows: readonly ReviewMatrixRow[];
  readonly humanGates: readonly string[];
  readonly boundary: string;
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly reviewMatrixDigest: string;
}

export function buildReviewMatrix(input: ReviewMatrixInput): ReviewMatrixReport {
  const blockers: string[] = [];

  const base = asSha40(input.base) ?? null;
  if (base === null) blockers.push('BASE_MISSING');
  const head = asSha40(input.head) ?? null;
  if (head === null) blockers.push('HEAD_MISSING');

  // Test axis: path-free command labels only.
  const rawTests = Array.isArray(input.requiredTests) ? input.requiredTests : null;
  if (rawTests === null || rawTests.length === 0) blockers.push('NO_TESTS');
  const tests: string[] = [];
  for (const t of rawTests ?? []) {
    const label = pathFreeString(t);
    if (label === null) { blockers.push('TEST_NAME_LEAK'); continue; }
    tests.push(label);
  }

  // Commit axis: hex shas only; subjects are inspected for leaks but NEVER echoed.
  const rawCommits = Array.isArray(input.commits) ? input.commits : null;
  if (rawCommits === null || rawCommits.length === 0) blockers.push('NO_COMMITS');
  const shas: string[] = [];
  for (const c of rawCommits ?? []) {
    const o = asObject(c);
    const sha = asSha40(o.sha);
    if (sha === undefined) { blockers.push('COMMIT_SHA_MALFORMED'); continue; }
    if (o.subject !== undefined && pathFreeString(o.subject) === null) blockers.push('COMMIT_SUBJECT_LEAK');
    shas.push(sha);
  }
  if (head !== null && shas.length > 0 && head !== shas[shas.length - 1]) blockers.push('HEAD_NOT_TERMINAL_COMMIT');

  const rows: ReviewMatrixRow[] = shas.map((sha) => ({
    sha,
    humanReviewed: REVIEW_PLACEHOLDER,
    signedOff: REVIEW_PLACEHOLDER,
    tests: tests.map((test) => ({ test, result: REVIEW_PLACEHOLDER })),
  }));
  const placeholderCount = rows.length * (2 + tests.length);

  const uniqueBlockers = [...new Set(blockers)];
  const overall: ReviewMatrixReport['overall'] = uniqueBlockers.length === 0 ? 'REVIEW_MATRIX_READY' : 'REVIEW_MATRIX_BLOCKED';
  const withoutDigest: Omit<ReviewMatrixReport, 'reviewMatrixDigest'> = {
    report: 'phase-230-promotion-review-matrix',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    base,
    head,
    commitCount: rows.length,
    testCount: tests.length,
    placeholderCount,
    rows,
    humanGates: REVIEW_MATRIX_HUMAN_GATES,
    boundary: REVIEW_MATRIX_BOUNDARY,
    blockers: uniqueBlockers,
    disclaimers: REVIEW_MATRIX_DISCLAIMERS,
  };
  return { ...withoutDigest, reviewMatrixDigest: digest('phase-230-review-matrix', JSON.stringify(withoutDigest)) };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
