import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';
import { buildArchiveManifest } from './promotion-archive-manifest.js';
import { buildReviewBundle } from './promotion-review-bundle.js';
import { buildConsistencyMatrix } from './promotion-consistency-matrix.js';
import { buildFinalSummary } from './promotion-final-summary.js';
import { verifyCliContract } from './promotion-cli-contract.js';
import { buildReleaseChecklist } from './promotion-release-checklist.js';
import { buildMergeReadiness } from './promotion-merge-readiness.js';

// Local, non-live negative-evidence adversarial corpus. Each sample is a deliberately malformed or
// adversarial evidence artifact (a tampered self-digest, an unknown report id, a stitched-together set, an
// unsubstantiated review, a redaction leak, a malformed capture). The corpus feeds every sample through
// the matching Phase 230 validator and confirms it is REJECTED -- proving the validators fail closed and
// no adversarial input is ever accepted as green. It is a pure self-test over synthetic inputs; it
// performs no promotion, never touches the real Movies root, never contacts Jellyfin, and authorizes
// nothing live. The report never echoes any payload, only fixed sample ids, categories, and booleans.

const VALID_SHA = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const OTHER_SHA = 'a1b2c3d4e5f6071829304152637485960a1b2c3d';
const A64 = 'a'.repeat(64);
const B64 = 'b'.repeat(64);
const T64 = 'c'.repeat(64);
const Z64 = 'd'.repeat(64);
const READY_BUNDLE = { report: 'phase-230-promotion-coordinator-review-bundle', overall: 'REVIEW_BUNDLE_READY' };
const GOOD_CONTEXT = { branch: 'work/branch', base: '1'.repeat(40), head: '2'.repeat(40), commits: [{ sha: VALID_SHA, subject: 'a commit' }], requiredTests: ['npm run test:phase230-local'] };
const HELD_CORPUS = { report: 'phase-230-promotion-negative-evidence-corpus', overall: 'CORPUS_HELD' };
const OK_HYGIENE = { report: 'phase-230-promotion-closure-hygiene', overall: 'HYGIENE_OK' };

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
  {
    id: 'archive-evidence-ledger-mismatch', category: 'cross-report-mismatch',
    rejected: () => buildArchiveManifest({
      ledger: { report: 'phase-230-promotion-provenance-ledger', complete: true, absent: [], ledgerDigest: '0'.repeat(64), entries: [{ id: 'phase-230-promotion-coordinator-evidence-packet', digest: B64 }, { id: 'phase-230-promotion-review-transcript', digest: T64 }] },
      dag: { report: 'phase-230-promotion-gate-dag', ok: true, dagDigest: '0'.repeat(64) },
      evidence: { report: 'phase-230-promotion-coordinator-evidence-packet', overall: 'EVIDENCE_COMPLETE', packetDigest: A64 },
      transcript: { report: 'phase-230-promotion-review-transcript', verdict: 'REVIEW_CLEAN', transcriptDigest: T64 },
    }).blockers.includes('EVIDENCE_LEDGER_MISMATCH'),
  },
  {
    id: 'review-bundle-archive-component-mismatch', category: 'cross-report-mismatch',
    rejected: () => buildReviewBundle({
      evidence: { report: 'phase-230-promotion-coordinator-evidence-packet', overall: 'EVIDENCE_COMPLETE', packetDigest: A64 },
      transcript: { report: 'phase-230-promotion-review-transcript', verdict: 'REVIEW_CLEAN', transcriptDigest: T64 },
      ledger: { report: 'phase-230-promotion-provenance-ledger', complete: true, ledgerDigest: B64 },
      dag: { report: 'phase-230-promotion-gate-dag', ok: true, dagDigest: Z64 },
      archive: { report: 'phase-230-promotion-evidence-archive-manifest', overall: 'ARCHIVE_READY', components: [{ component: 'evidence', digest: Z64 }] },
    }).blockers.includes('ARCHIVE_EVIDENCE_MISMATCH'),
  },
  {
    id: 'matrix-review-archive-mismatch', category: 'cross-report-mismatch',
    rejected: () => buildConsistencyMatrix({
      archive: { report: 'phase-230-promotion-evidence-archive-manifest', archiveDigest: A64 },
      reviewBundle: { report: 'phase-230-promotion-coordinator-review-bundle', components: [{ component: 'archive', digest: B64 }] },
    }).overall === 'MATRIX_INCONSISTENT',
  },
  {
    id: 'self-digest-stale-review-bundle', category: 'tampered-digest',
    rejected: () => verifySelfDigests([{ report: 'phase-230-promotion-coordinator-review-bundle', version: 1, redactionSafe: true, authorization: 'NONE', overall: 'REVIEW_BUNDLE_READY', components: [], blockers: [], disclaimers: [], reviewBundleDigest: '0'.repeat(64) }]).overall === 'DIGEST_MISMATCH',
  },
  {
    id: 'release-checklist-commit-binding-mismatch', category: 'stale-binding',
    rejected: () => buildReleaseChecklist({
      reviewBundle: { report: 'phase-230-promotion-coordinator-review-bundle', overall: 'REVIEW_BUNDLE_READY', components: [{ component: 'transcript', digest: T64 }] },
      transcript: { report: 'phase-230-promotion-review-transcript', verdict: 'REVIEW_CLEAN', reviewedCommit: VALID_SHA, testResults: [{ command: 'x', passed: 1, failed: 0 }], transcriptDigest: T64 },
      finalSummary: { report: 'phase-230-promotion-coordinator-final-summary', overall: 'FINAL_SUMMARY_READY', reviewedCommit: OTHER_SHA, testsPassed: 1, testsFailed: 0 },
      closureHygiene: OK_HYGIENE,
      negativeCorpus: HELD_CORPUS,
    }).blockers.includes('COMMIT_BINDING_MISMATCH'),
  },
  {
    id: 'release-checklist-transcript-bundle-mismatch', category: 'stale-binding',
    rejected: () => buildReleaseChecklist({
      reviewBundle: { report: 'phase-230-promotion-coordinator-review-bundle', overall: 'REVIEW_BUNDLE_READY', components: [{ component: 'transcript', digest: Z64 }] },
      transcript: { report: 'phase-230-promotion-review-transcript', verdict: 'REVIEW_CLEAN', reviewedCommit: VALID_SHA, testResults: [{ command: 'x', passed: 1, failed: 0 }], transcriptDigest: T64 },
      finalSummary: { report: 'phase-230-promotion-coordinator-final-summary', overall: 'FINAL_SUMMARY_READY', reviewedCommit: VALID_SHA, testsPassed: 1, testsFailed: 0 },
      closureHygiene: OK_HYGIENE,
      negativeCorpus: HELD_CORPUS,
    }).blockers.includes('TRANSCRIPT_BUNDLE_MISMATCH'),
  },
  {
    id: 'merge-readiness-final-summary-unbound', category: 'stale-binding',
    rejected: () => buildMergeReadiness({
      releaseChecklist: { report: 'phase-230-promotion-coordinator-release-checklist', overall: 'RELEASE_CHECKLIST_CLEARED', blockers: [], boundDigests: { 'final-summary': A64 } },
      finalSummary: { report: 'phase-230-promotion-coordinator-final-summary', overall: 'FINAL_SUMMARY_READY', summaryDigest: B64 },
      context: GOOD_CONTEXT,
    }).blockers.includes('FINAL_SUMMARY_BINDING_MISMATCH'),
  },
  {
    id: 'merge-readiness-missing-context', category: 'incomplete-context',
    rejected: () => buildMergeReadiness({
      releaseChecklist: { report: 'phase-230-promotion-coordinator-release-checklist', overall: 'RELEASE_CHECKLIST_CLEARED', blockers: [], boundDigests: {} },
    }).blockers.includes('MERGE_CONTEXT_MISSING'),
  },
  {
    id: 'merge-readiness-not-cleared', category: 'not-ready-upstream',
    rejected: () => buildMergeReadiness({
      releaseChecklist: { report: 'phase-230-promotion-coordinator-release-checklist', overall: 'RELEASE_CHECKLIST_BLOCKED', blockers: ['COMMIT_BINDING_MISMATCH'], boundDigests: {} },
      context: GOOD_CONTEXT,
    }).blockers.includes('RELEASE_CHECKLIST_NOT_CLEARED'),
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
