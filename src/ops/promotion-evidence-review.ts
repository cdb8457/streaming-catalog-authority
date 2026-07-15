import { createHash } from 'node:crypto';

// Local, non-live reviewer for a `phase-230-real-library-promotion` evidence report (the
// document runRealLibraryPromotion emits). It is the mechanical pre-acceptance gate an
// operator/reviewer runs on a produced evidence file BEFORE accepting or sharing it:
// it confirms the report is well-formed, redaction-safe, complete, internally consistent,
// and that its self-attested evidenceDigest actually recomputes.
//
// It reads a parsed JSON object only. It never promotes, never touches the real Movies
// root, and never contacts Jellyfin.

export type EvidenceReviewProblem =
  | 'REPORT_TYPE_INVALID'
  | 'VERSION_INVALID'
  | 'NOT_FLAGGED_REDACTION_SAFE'
  | 'IDENTITY_ECHO_FLAG_SET'
  | 'CORE_DIGEST_MISSING_OR_MALFORMED'
  | 'FORBIDDEN_LIST_INCOMPLETE'
  | 'LIFECYCLE_MALFORMED'
  | 'TARGET_ROOT_NOT_AN_ENUM'
  | 'STATE_STATUS_INCONSISTENT'
  | 'EVIDENCE_DIGEST_MISMATCH'
  | 'RAW_PATH_LEAK_SUSPECTED';

export interface PromotionEvidenceReview {
  readonly report: 'phase-230-promotion-evidence-review';
  readonly version: 1;
  readonly ok: boolean;
  readonly redactionSafe: true;
  readonly status: 'PROMOTION_EVIDENCE_ACCEPTED' | 'PROMOTION_EVIDENCE_REJECTED';
  readonly subjectReport: string;
  readonly subjectStatus?: string;
  readonly subjectLifecycleState?: string;
  readonly subjectEvidenceDigest?: string;
  readonly checks: {
    readonly reportTypeValid: boolean;
    readonly redactionSafeFlagged: boolean;
    readonly digestsPresent: boolean;
    readonly forbiddenListComplete: boolean;
    readonly lifecycleWellFormed: boolean;
    readonly stateStatusConsistent: boolean;
    readonly evidenceDigestVerified: boolean;
    readonly noRawPathLeak: boolean;
  };
  readonly problems: readonly EvidenceReviewProblem[];
  readonly reviewDigest: string;
}

const EXPECTED_REPORT = 'phase-230-real-library-promotion';

const CANONICAL_FORBIDDEN: readonly string[] = [
  'provider-live-mode',
  'downloading',
  'scraping',
  'playback',
  'jellyfin-write-api',
  'gelato-path',
  'aio-streams-path',
  'overwrite-real-library-file',
  'raw-source-path',
  'raw-destination-path',
  'raw-media-title',
];

const VALID_STATES = new Set([
  'VISIBLE_IN_JELLYFIN',
  'PROMOTION_APPROVED',
  'PROMOTED',
  'VISIBLE_IN_REAL_LIBRARY',
  'PROMOTION_WITHDRAWN',
  'PROMOTION_FAILED',
]);

const VALID_TARGET_ROOTS = new Set(['/mnt/user/media/Movies', 'custom-real-movies-root']);

// status -> { ok, terminal lifecycle state } the report must agree with.
const STATUS_EXPECTATION: Record<string, { ok: boolean; state: string }> = {
  REAL_LIBRARY_PROMOTION_VISIBLE: { ok: true, state: 'VISIBLE_IN_REAL_LIBRARY' },
  REAL_LIBRARY_PROMOTION_WITHDRAWN: { ok: true, state: 'PROMOTION_WITHDRAWN' },
  REAL_LIBRARY_PROMOTION_FAILED: { ok: false, state: 'PROMOTION_FAILED' },
};

export function reviewPromotionEvidence(candidate: unknown): PromotionEvidenceReview {
  const problems = new Set<EvidenceReviewProblem>();
  const report = (candidate && typeof candidate === 'object' ? candidate : {}) as Record<string, unknown>;

  const subjectReport = typeof report.report === 'string' ? report.report : 'unknown';
  if (subjectReport !== EXPECTED_REPORT) problems.add('REPORT_TYPE_INVALID');
  if (report.version !== 1) problems.add('VERSION_INVALID');

  if (report.redactionSafe !== true) problems.add('NOT_FLAGGED_REDACTION_SAFE');
  if (report.titleEchoed !== false || report.sourcePathEchoed !== false || report.destinationPathEchoed !== false) {
    problems.add('IDENTITY_ECHO_FLAG_SET');
  }

  const realLibrary = asObject(report.realLibrary);
  if (!isSha256(report.runDigest) || !isSha256(report.itemDigest) || !isSha256(report.evidenceDigest) || !isSha256(realLibrary.beforeDigest)) {
    problems.add('CORE_DIGEST_MISSING_OR_MALFORMED');
  }

  if (!arrayEquals(report.forbidden, CANONICAL_FORBIDDEN)) problems.add('FORBIDDEN_LIST_INCOMPLETE');

  if (!VALID_TARGET_ROOTS.has(report.targetRoot as string)) problems.add('TARGET_ROOT_NOT_AN_ENUM');

  const lifecycle = asObject(report.lifecycle);
  const currentState = typeof lifecycle.currentState === 'string' ? lifecycle.currentState : undefined;
  const transitions = lifecycle.transitions;
  const lifecycleWellFormed = lifecycle.logsRetrievable === true
    && Array.isArray(transitions) && transitions.length > 0
    && currentState !== undefined && VALID_STATES.has(currentState);
  if (!lifecycleWellFormed) problems.add('LIFECYCLE_MALFORMED');

  const status = typeof report.status === 'string' ? report.status : undefined;
  const expectation = status ? STATUS_EXPECTATION[status] : undefined;
  if (!expectation || report.ok !== expectation.ok || currentState !== expectation.state) {
    problems.add('STATE_STATUS_INCONSISTENT');
  }

  if (!verifyEvidenceDigest(report)) problems.add('EVIDENCE_DIGEST_MISMATCH');

  if (hasRawPathLeak(report)) problems.add('RAW_PATH_LEAK_SUSPECTED');

  const ok = problems.size === 0;
  const withoutDigest: Omit<PromotionEvidenceReview, 'reviewDigest'> = {
    report: 'phase-230-promotion-evidence-review',
    version: 1,
    ok,
    redactionSafe: true,
    status: ok ? 'PROMOTION_EVIDENCE_ACCEPTED' : 'PROMOTION_EVIDENCE_REJECTED',
    subjectReport,
    ...(typeof report.status === 'string' ? { subjectStatus: report.status } : {}),
    ...(currentState ? { subjectLifecycleState: currentState } : {}),
    ...(isSha256(report.evidenceDigest) ? { subjectEvidenceDigest: report.evidenceDigest as string } : {}),
    checks: {
      reportTypeValid: !problems.has('REPORT_TYPE_INVALID') && !problems.has('VERSION_INVALID'),
      redactionSafeFlagged: !problems.has('NOT_FLAGGED_REDACTION_SAFE') && !problems.has('IDENTITY_ECHO_FLAG_SET'),
      digestsPresent: !problems.has('CORE_DIGEST_MISSING_OR_MALFORMED'),
      forbiddenListComplete: !problems.has('FORBIDDEN_LIST_INCOMPLETE'),
      lifecycleWellFormed: !problems.has('LIFECYCLE_MALFORMED'),
      stateStatusConsistent: !problems.has('STATE_STATUS_INCONSISTENT'),
      evidenceDigestVerified: !problems.has('EVIDENCE_DIGEST_MISMATCH'),
      noRawPathLeak: !problems.has('RAW_PATH_LEAK_SUSPECTED'),
    },
    problems: [...problems],
  };
  return { ...withoutDigest, reviewDigest: digest('phase-230-evidence-review', JSON.stringify(withoutDigest)) };
}

// Recompute the report's own evidenceDigest exactly as runRealLibraryPromotion does:
// sha256("phase-230-report:" + JSON.stringify(report without evidenceDigest)). Assumes the
// evidence is the verbatim service output (as its CLI writes it); a re-serialized/re-ordered
// copy will not verify, which is the intended strictness.
function verifyEvidenceDigest(report: Record<string, unknown>): boolean {
  const evidenceDigest = report.evidenceDigest;
  if (!isSha256(evidenceDigest)) return false;
  const withoutDigest: Record<string, unknown> = {};
  for (const key of Object.keys(report)) {
    if (key !== 'evidenceDigest') withoutDigest[key] = report[key];
  }
  return digest('phase-230-report', JSON.stringify(withoutDigest)) === evidenceDigest;
}

// A redaction-safe report contains no raw filesystem paths: the only path-like strings are
// the `targetRoot` enum and the `file.extension` value. Any other absolute/drive/media-suffix
// string, or a test-library path fragment, is a suspected identity leak.
function hasRawPathLeak(report: Record<string, unknown>): boolean {
  let leak = false;
  const walk = (value: unknown, key: string | undefined): void => {
    if (leak) return;
    if (typeof value === 'string') {
      if (key === 'targetRoot' || key === 'extension') return;
      if (looksLikePath(value)) leak = true;
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, key);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, k);
    }
  };
  walk(report, undefined);
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

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function arrayEquals(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && expected.every((e, i) => value[i] === e);
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
