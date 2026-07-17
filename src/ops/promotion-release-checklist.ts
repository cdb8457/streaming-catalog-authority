import { createHash } from 'node:crypto';

// Local, non-live coordinator evidence release checklist. It directly consumes AND binds the underlying
// evidence artifacts -- the review bundle, the review transcript (with its test results), the coordinator
// final summary, and the closure/dependency hygiene report -- plus the negative-evidence adversarial corpus
// (and, optionally, the self-digest verification). Beyond requiring each item green, it cross-checks that
// they describe the SAME run: the review bundle must bind the supplied transcript, and the final summary's
// reviewed commit and test totals must match that transcript. A set stitched from different runs (each
// individually green) is caught. It reads parsed JSON only; it performs no promotion, never touches the
// real Movies root, never contacts Jellyfin, and authorizes nothing live. Clearing the checklist is NOT a
// merge, a release action, or a Phase 231 authorization.

export interface ReleaseChecklistInput {
  readonly reviewBundle?: unknown;
  readonly transcript?: unknown;
  readonly finalSummary?: unknown;
  readonly closureHygiene?: unknown;
  readonly negativeCorpus?: unknown;
  readonly selfDigest?: unknown;
}

export const RELEASE_CHECKLIST_HUMAN_GATES: readonly string[] = [
  'Approval authoring and independent attestation by a human operator.',
  'The live promotion itself, which is Phase 229-defined, operator-run, and out of scope here.',
  'Explicit coordinator ACCEPT recorded by the acceptance seal.',
  'Phase 231 authorization, which is NOT granted by any tool, doc, or artifact here.',
];

export const RELEASE_CHECKLIST_DISCLAIMERS: readonly string[] = [
  'Clearing this checklist does NOT authorize Phase 231.',
  'Clearing this checklist does NOT authorize live promotion or any merge/tag/master action.',
  'No live Jellyfin call or real Movies write is implied or performed by this checklist.',
  'This is a redaction-safe, deterministic aggregation of offline records only.',
];

export interface ChecklistItem { readonly item: string; readonly present: boolean; readonly pass: boolean; }
export interface ChecklistBinding { readonly binding: string; readonly ok: boolean; }

export interface ReleaseChecklist {
  readonly report: 'phase-230-promotion-coordinator-release-checklist';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'RELEASE_CHECKLIST_CLEARED' | 'RELEASE_CHECKLIST_BLOCKED';
  readonly items: readonly ChecklistItem[];
  readonly bindings: readonly ChecklistBinding[];
  readonly boundDigests: Readonly<Record<string, string>>;
  readonly blockers: readonly string[];
  readonly humanGates: readonly string[];
  readonly disclaimers: readonly string[];
  readonly checklistDigest: string;
}

interface Spec {
  readonly key: keyof ReleaseChecklistInput;
  readonly item: string;
  readonly report: string;
  readonly ok: (o: Record<string, unknown>) => boolean;
  readonly digestField: string;
  readonly missing: string;
  readonly invalid: string;
  readonly notOk: string;
  readonly required: boolean;
}

const SPECS: readonly Spec[] = [
  { key: 'reviewBundle', item: 'review-bundle', report: 'phase-230-promotion-coordinator-review-bundle', ok: (o) => o.overall === 'REVIEW_BUNDLE_READY', digestField: 'reviewBundleDigest', missing: 'REVIEW_BUNDLE_MISSING', invalid: 'REVIEW_BUNDLE_INVALID', notOk: 'REVIEW_BUNDLE_NOT_READY', required: true },
  { key: 'transcript', item: 'transcript', report: 'phase-230-promotion-review-transcript', ok: (o) => o.verdict === 'REVIEW_CLEAN', digestField: 'transcriptDigest', missing: 'TRANSCRIPT_MISSING', invalid: 'TRANSCRIPT_INVALID', notOk: 'TRANSCRIPT_NOT_CLEAN', required: true },
  { key: 'finalSummary', item: 'final-summary', report: 'phase-230-promotion-coordinator-final-summary', ok: (o) => o.overall === 'FINAL_SUMMARY_READY', digestField: 'summaryDigest', missing: 'FINAL_SUMMARY_MISSING', invalid: 'FINAL_SUMMARY_INVALID', notOk: 'FINAL_SUMMARY_NOT_READY', required: true },
  { key: 'closureHygiene', item: 'closure-hygiene', report: 'phase-230-promotion-closure-hygiene', ok: (o) => o.overall === 'HYGIENE_OK', digestField: 'hygieneDigest', missing: 'CLOSURE_HYGIENE_MISSING', invalid: 'CLOSURE_HYGIENE_INVALID', notOk: 'CLOSURE_HYGIENE_NOT_OK', required: true },
  { key: 'negativeCorpus', item: 'negative-evidence-corpus', report: 'phase-230-promotion-negative-evidence-corpus', ok: (o) => o.overall === 'CORPUS_HELD', digestField: 'corpusDigest', missing: 'NEGATIVE_CORPUS_MISSING', invalid: 'NEGATIVE_CORPUS_INVALID', notOk: 'NEGATIVE_CORPUS_BREACHED', required: true },
  { key: 'selfDigest', item: 'self-digest', report: 'phase-230-promotion-self-digest-verification', ok: (o) => o.overall === 'ALL_VERIFIED', digestField: 'verifierDigest', missing: 'SELF_DIGEST_MISSING', invalid: 'SELF_DIGEST_INVALID', notOk: 'SELF_DIGEST_NOT_VERIFIED', required: false },
];

export function buildReleaseChecklist(input: ReleaseChecklistInput): ReleaseChecklist {
  const blockers: string[] = [];
  const parsed: Partial<Record<keyof ReleaseChecklistInput, Record<string, unknown>>> = {};
  const boundDigests: Record<string, string> = {};

  const items: ChecklistItem[] = SPECS.map((spec) => {
    const value = input[spec.key];
    if (value === undefined) {
      if (spec.required) { blockers.push(spec.missing); return { item: spec.item, present: false, pass: false }; }
      return { item: spec.item, present: false, pass: true };
    }
    const obj = asObject(value);
    if (obj.report !== spec.report) { blockers.push(spec.invalid); return { item: spec.item, present: true, pass: false }; }
    parsed[spec.key] = obj;
    // Fail closed on binding evidence: a present artifact (required OR supplied-optional) must carry a
    // valid sha256 digest, else the run cannot be bound and the checklist must not clear.
    const rawDigest = obj[spec.digestField];
    const d = asSha256(rawDigest);
    if (rawDigest === undefined) blockers.push('REQUIRED_DIGEST_MISSING');
    else if (d === undefined) blockers.push('REQUIRED_DIGEST_INVALID');
    if (d) boundDigests[spec.item] = d;
    const okState = spec.ok(obj);
    if (!okState) blockers.push(spec.notOk);
    return { item: spec.item, present: true, pass: okState && d !== undefined };
  });

  // Binding cross-checks: the review bundle, transcript, and final summary must describe the same run.
  const bindings: ChecklistBinding[] = [];
  const rb = parsed.reviewBundle;
  const tr = parsed.transcript;
  const fs = parsed.finalSummary;

  if (rb && tr) {
    const bound = componentDigest(rb, 'transcript');
    const ok = bound !== undefined && bound === asSha256(tr.transcriptDigest);
    if (!ok) blockers.push('TRANSCRIPT_BUNDLE_MISMATCH');
    bindings.push({ binding: 'review-bundle=transcript', ok });
  }
  if (fs && tr) {
    const fsCommit = asSha40(fs.reviewedCommit);
    const trCommit = asSha40(tr.reviewedCommit);
    const commitOk = fsCommit !== undefined && fsCommit === trCommit;
    if (!commitOk) blockers.push('COMMIT_BINDING_MISMATCH');
    bindings.push({ binding: 'final-summary.commit=transcript.commit', ok: commitOk });

    const trPassed = sumField(tr.testResults, 'passed');
    const trFailed = sumField(tr.testResults, 'failed');
    const resultsOk = trPassed !== null && trFailed !== null && fs.testsPassed === trPassed && fs.testsFailed === trFailed;
    if (!resultsOk) blockers.push('TEST_RESULTS_BINDING_MISMATCH');
    bindings.push({ binding: 'final-summary.tests=transcript.tests', ok: resultsOk });
  }

  const overall: ReleaseChecklist['overall'] = blockers.length === 0 ? 'RELEASE_CHECKLIST_CLEARED' : 'RELEASE_CHECKLIST_BLOCKED';
  const withoutDigest: Omit<ReleaseChecklist, 'checklistDigest'> = {
    report: 'phase-230-promotion-coordinator-release-checklist',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    items,
    bindings,
    boundDigests,
    blockers,
    humanGates: RELEASE_CHECKLIST_HUMAN_GATES,
    disclaimers: RELEASE_CHECKLIST_DISCLAIMERS,
  };
  return { ...withoutDigest, checklistDigest: digest('phase-230-release-checklist', JSON.stringify(withoutDigest)) };
}

function componentDigest(report: Record<string, unknown>, name: string): string | undefined {
  const comps = report.components;
  if (!Array.isArray(comps)) return undefined;
  for (const c of comps) { const co = asObject(c); if (co.component === name) return asSha256(co.digest); }
  return undefined;
}
function sumField(testResults: unknown, field: 'passed' | 'failed'): number | null {
  if (!Array.isArray(testResults)) return null;
  let total = 0;
  for (const r of testResults) { const o = asObject(r); const v = o[field]; if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return null; total += v; }
  return total;
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
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
