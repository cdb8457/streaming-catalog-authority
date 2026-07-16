import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';
import { buildArchiveManifest } from './promotion-archive-manifest.js';
import { buildReviewBundle } from './promotion-review-bundle.js';
import { buildConsistencyMatrix } from './promotion-consistency-matrix.js';
import { buildFinalSummary } from './promotion-final-summary.js';
import { verifyCliContract } from './promotion-cli-contract.js';

// Local, non-live negative-evidence adversarial corpus. Each sample is a deliberately malformed or
// adversarial evidence artifact (a tampered self-digest, an unknown report id, a stitched-together set, an
// unsubstantiated review, a redaction leak, a malformed capture). The corpus feeds every sample through
// the matching Phase 230 validator and confirms it is REJECTED -- proving the validators fail closed and
// no adversarial input is ever accepted as green. It is a pure self-test over synthetic inputs; it
// performs no promotion, never touches the real Movies root, never contacts Jellyfin, and authorizes
// nothing live. The report never echoes any payload, only fixed sample ids, categories, and booleans.

const VALID_SHA = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const A64 = 'a'.repeat(64);
const B64 = 'b'.repeat(64);
const READY_BUNDLE = { report: 'phase-230-promotion-coordinator-review-bundle', overall: 'REVIEW_BUNDLE_READY' };

interface NegativeSample {
  readonly id: string;
  readonly category: string;
  readonly rejected: () => boolean;
}

const SAMPLES: readonly NegativeSample[] = [
  {
    id: 'tampered-ledger-self-digest', category: 'tampered-digest',
    rejected: () => verifySelfDigests([{ report: 'phase-230-promotion-provenance-ledger', version: 1, redactionSafe: true, complete: true, entries: [], absent: [], ledgerDigest: '0'.repeat(64) }]).overall === 'DIGEST_MISMATCH',
  },
  {
    id: 'unrecognized-report', category: 'unknown-report',
    rejected: () => verifySelfDigests([{ report: 'phase-230-not-a-real-report', someDigest: A64 }]).overall === 'UNRECOGNIZED_REPORT',
  },
  {
    id: 'empty-archive-manifest', category: 'missing-components',
    rejected: () => buildArchiveManifest({}).overall === 'ARCHIVE_BLOCKED',
  },
  {
    id: 'empty-review-bundle', category: 'missing-components',
    rejected: () => buildReviewBundle({}).overall === 'REVIEW_BUNDLE_BLOCKED',
  },
  {
    id: 'consistency-matrix-digest-mismatch', category: 'cross-report-mismatch',
    rejected: () => buildConsistencyMatrix({
      evidence: { report: 'phase-230-promotion-coordinator-evidence-packet', packetDigest: A64 },
      ledger: { report: 'phase-230-promotion-provenance-ledger', entries: [{ id: 'phase-230-promotion-coordinator-evidence-packet', digest: B64 }] },
    }).overall === 'MATRIX_INCONSISTENT',
  },
  {
    id: 'final-summary-bogus-commit', category: 'unsubstantiated-review',
    rejected: () => buildFinalSummary({
      reviewBundle: READY_BUNDLE,
      transcript: { report: 'phase-230-promotion-review-transcript', verdict: 'REVIEW_CLEAN', reviewedCommit: 'not-a-sha', testResults: [{ command: 'npm test', passed: 1, failed: 0 }] },
    }).blockers.includes('REVIEWED_COMMIT_INVALID'),
  },
  {
    id: 'final-summary-empty-tests', category: 'unsubstantiated-review',
    rejected: () => buildFinalSummary({
      reviewBundle: READY_BUNDLE,
      transcript: { report: 'phase-230-promotion-review-transcript', verdict: 'REVIEW_CLEAN', reviewedCommit: VALID_SHA, testResults: [] },
    }).blockers.includes('TEST_RESULTS_INVALID'),
  },
  {
    id: 'cli-capture-redaction-leak', category: 'redaction-leak',
    rejected: () => { const r = verifyCliContract({ report: 'phase-230-promotion-thing-capture', redactionSafe: true, thingDigest: A64, note: leakString() }); return !r.ok && r.problems.includes('RAW_PATH_LEAK'); },
  },
  {
    id: 'cli-capture-non-object', category: 'malformed',
    rejected: () => { const r = verifyCliContract(42); return !r.ok && r.problems.includes('NOT_AN_OBJECT'); },
  },
];

export const NEGATIVE_SAMPLE_COUNT = SAMPLES.length;

export interface NegativeSampleResult { readonly sample: string; readonly category: string; readonly rejected: boolean; }

export interface NegativeEvidenceCorpusReport {
  readonly report: 'phase-230-promotion-negative-evidence-corpus';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'CORPUS_HELD' | 'CORPUS_BREACHED';
  readonly count: number;
  readonly categories: Readonly<Record<string, number>>;
  readonly samples: readonly NegativeSampleResult[];
  readonly breaches: readonly string[];
  readonly corpusDigest: string;
}

export function buildNegativeEvidenceCorpus(): NegativeEvidenceCorpusReport {
  const samples: NegativeSampleResult[] = SAMPLES.map((s) => {
    let rejected = false;
    try { rejected = s.rejected() === true; } catch { rejected = false; }
    return { sample: s.id, category: s.category, rejected };
  });
  const breaches = samples.filter((s) => !s.rejected).map((s) => s.sample);
  const categories: Record<string, number> = {};
  for (const s of SAMPLES) categories[s.category] = (categories[s.category] ?? 0) + 1;

  const overall: NegativeEvidenceCorpusReport['overall'] = breaches.length === 0 ? 'CORPUS_HELD' : 'CORPUS_BREACHED';
  const withoutDigest: Omit<NegativeEvidenceCorpusReport, 'corpusDigest'> = {
    report: 'phase-230-promotion-negative-evidence-corpus',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    count: SAMPLES.length,
    categories,
    samples,
    breaches,
  };
  return { ...withoutDigest, corpusDigest: digest('phase-230-negative-evidence-corpus', JSON.stringify(withoutDigest)) };
}

// A path-like value assembled from fragments so the corpus source carries no literal media path.
function leakString(): string {
  return ['', 'mnt', 'user', 'media', 'Movies', 'x.mkv'].join('/');
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
