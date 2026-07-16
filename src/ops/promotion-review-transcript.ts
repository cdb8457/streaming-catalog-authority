import { createHash } from 'node:crypto';

// Local, non-live coordinator review transcript / checklist packet. It records a review: the reviewed
// commit, the local test commands and their results, any blockers and their remediations, the remaining
// human gates, and explicit no-live / no-Phase-231 language. It is deterministic (a pure function of its
// inputs) and redaction-safe. It performs no promotion, never touches the real Movies root, never
// contacts Jellyfin, and authorizes nothing live.

export interface ReviewTestResult {
  readonly command: string;
  readonly passed: number;
  readonly failed: number;
}

export interface ReviewTranscriptInput {
  readonly reviewedCommit?: string;
  readonly testResults?: readonly ReviewTestResult[];
  readonly blockers?: readonly string[];
  readonly remediations?: readonly string[];
}

export const REVIEW_HUMAN_GATES: readonly string[] = [
  'A human operator authors and independently attests the approval file; this tooling validates it but does not issue it.',
  'The live real-library promotion (the Phase 229 operator-approved launcher writing to the real Movies library) is a human-authorized step, out of scope and not performed by this tooling.',
  'The coordinator records an explicit ACCEPT decision in the acceptance seal.',
  'Phase 231 authorization is a separate human decision, granted by nothing in this review.',
];

export const REVIEW_DISCLAIMERS: readonly string[] = [
  'This review transcript does NOT authorize Phase 231.',
  'This review transcript does NOT authorize live promotion.',
  'No live Jellyfin call or real Movies write is implied or performed by this transcript.',
  'This transcript is a redaction-safe, deterministic record of an offline review.',
];

export interface ReviewTranscript {
  readonly report: 'phase-230-promotion-review-transcript';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly verdict: 'REVIEW_CLEAN' | 'REVIEW_BLOCKED';
  readonly reviewedCommit?: string;
  readonly testResults: readonly ReviewTestResult[];
  readonly blockers: readonly string[];
  readonly remediations: readonly string[];
  readonly humanGates: readonly string[];
  readonly disclaimers: readonly string[];
  readonly problems: readonly string[];
  readonly transcriptDigest: string;
}

export function buildReviewTranscript(input: ReviewTranscriptInput): ReviewTranscript {
  const problems: string[] = [];

  const reviewedCommit = typeof input.reviewedCommit === 'string' && /^[0-9a-f]{7,64}$/.test(input.reviewedCommit) ? input.reviewedCommit : undefined;
  if (reviewedCommit === undefined) problems.push('REVIEWED_COMMIT_INVALID');

  const testResults: ReviewTestResult[] = [];
  for (const r of input.testResults ?? []) {
    const command = typeof r.command === 'string' ? r.command : '';
    const passed = Number.isInteger(r.passed) ? r.passed : -1;
    const failed = Number.isInteger(r.failed) ? r.failed : -1;
    testResults.push({ command, passed, failed });
    if (command.length === 0 || passed < 0 || failed < 0) problems.push('TEST_RESULT_MALFORMED');
    if (failed > 0) problems.push('TEST_FAILED');
  }

  const blockers = (input.blockers ?? []).map(String);
  const remediations = (input.remediations ?? []).map(String);

  const verdict: ReviewTranscript['verdict'] =
    problems.length === 0 && blockers.length === 0 ? 'REVIEW_CLEAN' : 'REVIEW_BLOCKED';

  const body: Omit<ReviewTranscript, 'transcriptDigest'> = {
    report: 'phase-230-promotion-review-transcript',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    verdict,
    ...(reviewedCommit ? { reviewedCommit } : {}),
    testResults,
    blockers,
    remediations,
    humanGates: REVIEW_HUMAN_GATES,
    disclaimers: REVIEW_DISCLAIMERS,
    problems,
  };

  // Caller-provided fields (commands, blockers, remediations) must not carry a raw filesystem path.
  if (hasRawPathLeak(body)) {
    const leaked = { ...body, verdict: 'REVIEW_BLOCKED' as const, problems: [...problems, 'RAW_PATH_IN_TRANSCRIPT'] };
    return { ...leaked, transcriptDigest: digest('phase-230-review-transcript', JSON.stringify(leaked)) };
  }
  return { ...body, transcriptDigest: digest('phase-230-review-transcript', JSON.stringify(body)) };
}

function hasRawPathLeak(value: unknown): boolean {
  let leak = false;
  const walk = (v: unknown, key: string | undefined): void => {
    if (leak) return;
    if (typeof v === 'string') {
      if (key === 'disclaimers' || key === 'humanGates') return; // fixed language
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

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
