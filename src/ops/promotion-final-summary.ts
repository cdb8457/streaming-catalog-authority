import { createHash } from 'node:crypto';

// Local, non-live coordinator final summary generator. From the review bundle (required) and, optionally,
// the cross-report consistency matrix, the self-digest verification, and the blocker taxonomy, it produces
// a redaction-safe one-page summary that is FINAL_SUMMARY_READY only when the review bundle is READY and
// every supplied optional check is green. It restates the remaining human gates and the fixed non-live
// disclaimers. It reads parsed JSON only; it performs no promotion, never touches the real Movies root,
// never contacts Jellyfin, and authorizes nothing live.

export interface FinalSummaryInput {
  readonly reviewBundle?: unknown;
  readonly consistencyMatrix?: unknown;
  readonly selfDigest?: unknown;
  readonly taxonomy?: unknown;
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
    checks,
    blockers,
    humanGates: FINAL_SUMMARY_HUMAN_GATES,
    disclaimers: FINAL_SUMMARY_DISCLAIMERS,
  };
  return { ...withoutDigest, summaryDigest: digest('phase-230-final-summary', JSON.stringify(withoutDigest)) };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
