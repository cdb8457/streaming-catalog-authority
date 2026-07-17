import { createHash } from 'node:crypto';
import { verifyCliContract } from './promotion-cli-contract.js';
import { buildFinalSummary } from './promotion-final-summary.js';
import { buildMergeReadiness } from './promotion-merge-readiness.js';
import { buildProvenanceDiff } from './promotion-provenance-diff.js';

// Local, non-live redaction regression corpus. Each leak sample is a path/title-shaped payload that every
// Phase 230 redaction detector must flag: the CLI-contract capture scanner, the final-summary test-result
// command validator, the merge-readiness context validator, and the provenance-diff subject validator. A
// companion set of safe values (command labels, hex digests, enums, report ids, relative branch names)
// must NOT be flagged, proving the detectors are discriminating, not trigger-happy. It is a pure self-test
// over synthetic inputs; it performs no promotion, never touches the real Movies root, never contacts
// Jellyfin, and authorizes nothing live. The report never echoes any payload -- only fixed sample ids,
// categories, and counts. Payload strings are assembled from fragments so this source carries no literal
// media path.

const VALID_SHA = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const HEX64 = 'a'.repeat(64);
const READY_BUNDLE = { report: 'phase-230-promotion-coordinator-review-bundle', overall: 'REVIEW_BUNDLE_READY' };
const CLEARED_CHECKLIST = {
  report: 'phase-230-promotion-coordinator-release-checklist', overall: 'RELEASE_CHECKLIST_CLEARED', blockers: [],
  boundDigests: { 'review-bundle': HEX64, 'transcript': HEX64, 'final-summary': HEX64, 'closure-hygiene': HEX64, 'negative-evidence-corpus': HEX64 },
};
const CLEAN_TRANSCRIPT = { report: 'phase-230-promotion-review-transcript', verdict: 'REVIEW_CLEAN', reviewedCommit: VALID_SHA, transcriptDigest: HEX64 };

interface LeakSample { readonly id: string; readonly category: string; readonly value: string; }
interface SafeSample { readonly id: string; readonly value: string; }

const J = (...parts: readonly string[]): string => parts.join('');

const LEAKS: readonly LeakSample[] = [
  { id: 'unix-absolute-path', category: 'absolute-path', value: J('/', 'srv/media/incoming/item') },
  { id: 'mnt-movies-media-path', category: 'live-library-path', value: ['', 'mnt', 'user', 'media', 'Movies', 'feature.mkv'].join('/') },
  { id: 'windows-drive-path', category: 'absolute-path', value: J('D:', '\\media\\staging\\feature.mp4') },
  { id: 'backslash-mnt-path', category: 'live-library-path', value: J('\\', 'mnt', '\\user\\media') },
  { id: 'bare-media-filename', category: 'media-title', value: J('Some.Feature.2024.1080p', '.mkv') },
  { id: 'uppercase-media-filename', category: 'media-title', value: J('TRAILER', '.MP4') },
  { id: 'm4v-clip-filename', category: 'media-title', value: J('clip', '.m4v') },
  { id: 'test-library-marker', category: 'fixture-marker', value: J('catalog-authority', '-test-library', '/item') },
];

const SAFE: readonly SafeSample[] = [
  { id: 'command-label', value: 'npm run test:phase230-local' },
  { id: 'hex-digest', value: HEX64 },
  { id: 'status-enum', value: 'REVIEW_BUNDLE_READY' },
  { id: 'report-id', value: 'phase-230-promotion-coordinator-review-bundle' },
  { id: 'relative-branch', value: 'work/phase-230-branch' },
];

interface Detector { readonly detector: string; readonly flags: (value: string) => boolean; }

const DETECTORS: readonly Detector[] = [
  {
    detector: 'cli-contract-capture',
    flags: (v) => verifyCliContract({ report: 'phase-230-promotion-probe-capture', redactionSafe: true, probeDigest: HEX64, value: v }).problems.includes('RAW_PATH_LEAK'),
  },
  {
    detector: 'final-summary-test-results',
    flags: (v) => buildFinalSummary({
      reviewBundle: READY_BUNDLE,
      transcript: { report: 'phase-230-promotion-review-transcript', verdict: 'REVIEW_CLEAN', reviewedCommit: VALID_SHA, testResults: [{ command: v, passed: 1, failed: 0 }] },
    }).blockers.includes('TEST_RESULTS_INVALID'),
  },
  {
    detector: 'merge-readiness-context',
    flags: (v) => buildMergeReadiness({
      releaseChecklist: CLEARED_CHECKLIST,
      context: { branch: 'work/probe', base: '1'.repeat(40), head: VALID_SHA, commits: [{ sha: VALID_SHA, subject: 'a commit' }], requiredTests: [v] },
    }).blockers.includes('MERGE_CONTEXT_INVALID'),
  },
  {
    detector: 'provenance-diff-subject',
    flags: (v) => buildProvenanceDiff({
      context: { branch: 'work/probe', base: '1'.repeat(40), head: VALID_SHA, commits: [{ sha: VALID_SHA, subject: v }] },
      transcript: CLEAN_TRANSCRIPT,
    }).blockers.includes('RAW_PATH_LEAK'),
  },
];

export const REDACTION_LEAK_COUNT = LEAKS.length;
export const REDACTION_SAFE_COUNT = SAFE.length;
export const REDACTION_DETECTOR_COUNT = DETECTORS.length;

export interface RedactionLeakResult { readonly sample: string; readonly category: string; readonly detectedBy: number; readonly detected: boolean; }
export interface RedactionSafeResult { readonly sample: string; readonly flaggedBy: number; readonly clean: boolean; }

export interface RedactionCorpusReport {
  readonly report: 'phase-230-promotion-redaction-corpus';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'REDACTION_CORPUS_HELD' | 'REDACTION_CORPUS_BREACHED';
  readonly leakCount: number;
  readonly safeCount: number;
  readonly detectorCount: number;
  readonly categories: Readonly<Record<string, number>>;
  readonly leaks: readonly RedactionLeakResult[];
  readonly safe: readonly RedactionSafeResult[];
  readonly breaches: readonly string[];
  readonly gaps: readonly string[];
  readonly redactionDigest: string;
}

export function buildRedactionCorpus(): RedactionCorpusReport {
  const leaks: RedactionLeakResult[] = LEAKS.map((l) => {
    let detectedBy = 0;
    for (const d of DETECTORS) { try { if (d.flags(l.value)) detectedBy++; } catch { /* an erroring detector detects nothing */ } }
    return { sample: l.id, category: l.category, detectedBy, detected: detectedBy === DETECTORS.length };
  });
  const safe: RedactionSafeResult[] = SAFE.map((s) => {
    let flaggedBy = 0;
    for (const d of DETECTORS) { try { if (d.flags(s.value)) flaggedBy++; } catch { flaggedBy++; } }
    return { sample: s.id, flaggedBy, clean: flaggedBy === 0 };
  });

  const gaps: string[] = [];
  if (leaks.some((l) => !l.detected)) gaps.push('LEAK_NOT_DETECTED');
  if (safe.some((s) => !s.clean)) gaps.push('SAFE_VALUE_FLAGGED');
  const breaches = [...leaks.filter((l) => !l.detected).map((l) => l.sample), ...safe.filter((s) => !s.clean).map((s) => s.sample)];
  const categories: Record<string, number> = {};
  for (const l of LEAKS) categories[l.category] = (categories[l.category] ?? 0) + 1;

  const overall: RedactionCorpusReport['overall'] = gaps.length === 0 ? 'REDACTION_CORPUS_HELD' : 'REDACTION_CORPUS_BREACHED';
  const withoutDigest: Omit<RedactionCorpusReport, 'redactionDigest'> = {
    report: 'phase-230-promotion-redaction-corpus',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    leakCount: LEAKS.length,
    safeCount: SAFE.length,
    detectorCount: DETECTORS.length,
    categories,
    leaks,
    safe,
    breaches,
    gaps,
  };
  return { ...withoutDigest, redactionDigest: digest('phase-230-redaction-corpus', JSON.stringify(withoutDigest)) };
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
