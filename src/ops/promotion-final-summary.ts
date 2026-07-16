import { createHash } from 'node:crypto';

// Local, non-live coordinator final summary generator. From the review bundle (required) and, optionally,
// the cross-report consistency matrix, the self-digest verification, and the blocker taxonomy, it produces
// a redaction-safe one-page summary that is FINAL_SUMMARY_READY only when the review bundle is READY and
// every supplied optional check is green. It restates the remaining human gates and the fixed non-live
// disclaimers. It reads parsed JSON only; it performs no promotion, never touches the real Movies root,
// never contacts Jellyfin, and authorizes nothing live.

export interface FinalSummaryInput {
  readonly reviewBundle?: unknown;
  readonly transcript?: unknown;
  readonly consistencyMatrix?: unknown;
  readonly selfDigest?: unknown;
  readonly taxonomy?: unknown;
}

export interface SummaryTestResult {
  readonly command: string;
  readonly passed: number;
  readonly failed: number;
}

export const FINAL_SUMMARY_HUMAN_GATES: readonly string[] = [
  'Approval authoring and independent attestation by a human operator.',
  'The live promotion itself, which is Phase 229-defined, operator-run, and out of scope here.',
  'Explicit coordinator ACCEPT recorded by the acceptance seal.',
  'Phase 231 authorization, which is NOT granted by any tool, doc, or artifact here.',
];

export const FINAL_SUMMARY_DISCLAIMERS: readonly string[] = [
  'This summary does NOT authorize Phase 231.',
  'This summary does NOT authorize live promotion.',
  'No live Jellyfin call or real Movies write is implied or performed by this summary.',
  'This is a redaction-safe, deterministic aggregation of offline records only.',
];

export interface SummaryCheck {
  readonly check: string;
  readonly present: boolean;
  readonly ok: boolean;
}

export interface FinalSummary {
  readonly report: 'phase-230-promotion-coordinator-final-summary';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'FINAL_SUMMARY_READY' | 'FINAL_SUMMARY_BLOCKED';
  readonly reviewedCommit: string | null;
  readonly testResults: readonly SummaryTestResult[];
  readonly testsPassed: number;
  readonly testsFailed: number;
  readonly checks: readonly SummaryCheck[];
  readonly blockers: readonly string[];
  readonly humanGates: readonly string[];
  readonly disclaimers: readonly string[];
  readonly summaryDigest: string;
}

interface OptionalSpec {
  readonly key: keyof FinalSummaryInput;
  readonly report: string;
  readonly ok: (o: Record<string, unknown>) => boolean;
  readonly invalid: string;
  readonly notOk: string;
}

const OPTIONAL: readonly OptionalSpec[] = [
  { key: 'consistencyMatrix', report: 'phase-230-promotion-cross-report-consistency-matrix', ok: (o) => o.overall === 'MATRIX_CONSISTENT', invalid: 'MATRIX_INVALID', notOk: 'MATRIX_NOT_CONSISTENT' },
  { key: 'selfDigest', report: 'phase-230-promotion-self-digest-verification', ok: (o) => o.overall === 'ALL_VERIFIED', invalid: 'SELF_DIGEST_INVALID', notOk: 'SELF_DIGEST_NOT_VERIFIED' },
  { key: 'taxonomy', report: 'phase-230-promotion-blocker-taxonomy', ok: (o) => o.overall === 'TAXONOMY_CONSISTENT', invalid: 'TAXONOMY_INVALID', notOk: 'TAXONOMY_NOT_CONSISTENT' },
];

export function buildFinalSummary(input: FinalSummaryInput): FinalSummary {
  const blockers: string[] = [];
  const checks: SummaryCheck[] = [];

  // Required: the review bundle must be present, valid, and READY.
  const rb = input.reviewBundle;
  if (rb === undefined) { blockers.push('REVIEW_BUNDLE_MISSING'); checks.push({ check: 'reviewBundle', present: false, ok: false }); }
  else {
    const o = asObject(rb);
    if (o.report !== 'phase-230-promotion-coordinator-review-bundle') { blockers.push('REVIEW_BUNDLE_INVALID'); checks.push({ check: 'reviewBundle', present: true, ok: false }); }
    else {
      const ok = o.overall === 'REVIEW_BUNDLE_READY';
      if (!ok) blockers.push('REVIEW_BUNDLE_NOT_READY');
      checks.push({ check: 'reviewBundle', present: true, ok });
    }
  }

  // Required: the review transcript must pin an EXACT reviewed commit and non-empty, well-formed test
  // results. A clean transcript with a malformed/missing commit or missing/empty/malformed results still
  // fails closed -- the summary must never claim readiness it cannot substantiate.
  let reviewedCommit: string | null = null;
  let testResults: SummaryTestResult[] = [];
  const tr = input.transcript;
  if (tr === undefined) { blockers.push('TRANSCRIPT_MISSING'); checks.push({ check: 'transcript', present: false, ok: false }); }
  else {
    const o = asObject(tr);
    if (o.report !== 'phase-230-promotion-review-transcript') { blockers.push('TRANSCRIPT_INVALID'); checks.push({ check: 'transcript', present: true, ok: false }); }
    else {
      const clean = o.verdict === 'REVIEW_CLEAN';
      if (!clean) blockers.push('TRANSCRIPT_NOT_CLEAN');
      checks.push({ check: 'transcript', present: true, ok: clean });

      const commitOk = typeof o.reviewedCommit === 'string' && /^[0-9a-f]{40}$/.test(o.reviewedCommit);
      if (commitOk) reviewedCommit = o.reviewedCommit as string;
      else blockers.push('REVIEWED_COMMIT_INVALID');
      checks.push({ check: 'reviewed-commit', present: true, ok: commitOk });

      const validated = validateTestResults(o.testResults);
      if (validated === null) blockers.push('TEST_RESULTS_INVALID');
      else testResults = validated;
      checks.push({ check: 'test-results', present: true, ok: validated !== null });
    }
  }
  const testsPassed = testResults.reduce((a, t) => a + t.passed, 0);
  const testsFailed = testResults.reduce((a, t) => a + t.failed, 0);

  // Optional cross-checks: absent is fine; present-but-not-green blocks.
  for (const spec of OPTIONAL) {
    const v = input[spec.key];
    if (v === undefined) { checks.push({ check: spec.key, present: false, ok: true }); continue; }
    const o = asObject(v);
    if (o.report !== spec.report) { blockers.push(spec.invalid); checks.push({ check: spec.key, present: true, ok: false }); continue; }
    const ok = spec.ok(o);
    if (!ok) blockers.push(spec.notOk);
    checks.push({ check: spec.key, present: true, ok });
  }

  const overall: FinalSummary['overall'] = blockers.length === 0 ? 'FINAL_SUMMARY_READY' : 'FINAL_SUMMARY_BLOCKED';
  const withoutDigest: Omit<FinalSummary, 'summaryDigest'> = {
    report: 'phase-230-promotion-coordinator-final-summary',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    reviewedCommit,
    testResults,
    testsPassed,
    testsFailed,
    checks,
    blockers,
    humanGates: FINAL_SUMMARY_HUMAN_GATES,
    disclaimers: FINAL_SUMMARY_DISCLAIMERS,
  };
  return { ...withoutDigest, summaryDigest: digest('phase-230-final-summary', JSON.stringify(withoutDigest)) };
}

// Strict validation: the test results must be a NON-EMPTY array of well-formed, redaction-safe rows -- a
// non-empty path-free command label and non-negative integer passed/failed counts. Any deviation (missing,
// empty, non-array, bad command, or malformed counts) returns null so the caller blocks.
function validateTestResults(value: unknown): SummaryTestResult[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: SummaryTestResult[] = [];
  for (const r of value) {
    const o = asObject(r);
    if (typeof o.command !== 'string' || o.command.length === 0 || looksLikePath(o.command)) return null;
    if (!isNonNegInt(o.passed) || !isNonNegInt(o.failed)) return null;
    out.push({ command: o.command, passed: o.passed as number, failed: o.failed as number });
  }
  return out;
}
function isNonNegInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}
function looksLikePath(s: string): boolean {
  return /^\//.test(s) || /[A-Za-z]:[\\/]/.test(s) || /\/mnt\//.test(s) || /\\mnt\\/.test(s)
    || s.includes('catalog-authority-test-library') || /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i.test(s);
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
