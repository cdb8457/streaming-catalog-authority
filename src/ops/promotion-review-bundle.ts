import { createHash } from 'node:crypto';

// Local, non-live final coordinator review bundle. It combines the five top-level offline records — the
// evidence packet, the review transcript, the provenance ledger, the gate DAG (graph), and the archive
// manifest — into one redaction-safe, deterministic bundle that is REVIEW_BUNDLE_READY only when all are
// present, valid, green, AND mutually consistent: the archive manifest's own component digests must match
// the evidence/transcript/ledger/dag actually supplied here, so an archive assembled from a different run
// is caught with a generic mismatch code. It reads parsed JSON only; it performs no promotion, never
// touches the real Movies root, never contacts Jellyfin, and authorizes nothing live.

export interface ReviewBundleInput {
  readonly evidence?: unknown;
  readonly transcript?: unknown;
  readonly ledger?: unknown;
  readonly dag?: unknown;
  readonly archive?: unknown;
}

export const REVIEW_BUNDLE_DISCLAIMERS: readonly string[] = [
  'This review bundle does NOT authorize Phase 231.',
  'This review bundle does NOT authorize live promotion.',
  'No live Jellyfin call or real Movies write is implied or performed by this bundle.',
  'This is a redaction-safe, deterministic aggregation of offline records only.',
];

export interface ReviewBundleComponent {
  readonly component: string;
  readonly present: boolean;
  readonly ok: boolean;
  readonly digest?: string;
}

export interface ReviewBundle {
  readonly report: 'phase-230-promotion-coordinator-review-bundle';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'REVIEW_BUNDLE_READY' | 'REVIEW_BUNDLE_BLOCKED';
  readonly components: readonly ReviewBundleComponent[];
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly reviewBundleDigest: string;
}

interface Spec {
  readonly key: keyof ReviewBundleInput;
  readonly report: string;
  readonly ok: (o: Record<string, unknown>) => boolean;
  readonly digestField: string;
  readonly missing: string;
  readonly invalid: string;
  readonly notOk: string;
}

const SPECS: readonly Spec[] = [
  { key: 'evidence', report: 'phase-230-promotion-coordinator-evidence-packet', ok: (o) => o.overall === 'EVIDENCE_COMPLETE', digestField: 'packetDigest', missing: 'EVIDENCE_MISSING', invalid: 'EVIDENCE_INVALID', notOk: 'EVIDENCE_NOT_COMPLETE' },
  { key: 'transcript', report: 'phase-230-promotion-review-transcript', ok: (o) => o.verdict === 'REVIEW_CLEAN', digestField: 'transcriptDigest', missing: 'TRANSCRIPT_MISSING', invalid: 'TRANSCRIPT_INVALID', notOk: 'TRANSCRIPT_NOT_CLEAN' },
  { key: 'ledger', report: 'phase-230-promotion-provenance-ledger', ok: (o) => o.complete === true, digestField: 'ledgerDigest', missing: 'LEDGER_MISSING', invalid: 'LEDGER_INVALID', notOk: 'LEDGER_INCOMPLETE' },
  { key: 'dag', report: 'phase-230-promotion-gate-dag', ok: (o) => o.ok === true, digestField: 'dagDigest', missing: 'DAG_MISSING', invalid: 'DAG_INVALID', notOk: 'DAG_NOT_ACYCLIC' },
  { key: 'archive', report: 'phase-230-promotion-evidence-archive-manifest', ok: (o) => o.overall === 'ARCHIVE_READY', digestField: 'archiveDigest', missing: 'ARCHIVE_MISSING', invalid: 'ARCHIVE_INVALID', notOk: 'ARCHIVE_NOT_READY' },
];

export function buildReviewBundle(input: ReviewBundleInput): ReviewBundle {
  const blockers: string[] = [];
  const parsed: Partial<Record<keyof ReviewBundleInput, Record<string, unknown>>> = {};
  const components: ReviewBundleComponent[] = SPECS.map((spec) => {
    const value = input[spec.key];
    if (value === undefined) { blockers.push(spec.missing); return { component: spec.key, present: false, ok: false }; }
    const obj = asObject(value);
    if (obj.report !== spec.report) { blockers.push(spec.invalid); return { component: spec.key, present: true, ok: false }; }
    parsed[spec.key] = obj;
    const ok = spec.ok(obj);
    if (!ok) blockers.push(spec.notOk);
    const d = asSha256(obj[spec.digestField]);
    return { component: spec.key, present: true, ok, ...(d ? { digest: d } : {}) };
  });

  // Cross-check: the archive manifest must have been built over THIS evidence/transcript/ledger/dag. Each
  // archive component digest must match the corresponding supplied record; an archive from a different run
  // is caught even though every individual component is internally green.
  const archiveObj = parsed.archive;
  if (archiveObj) {
    const archiveDigestFor = componentDigestFor(archiveObj);
    for (const [key, digestField] of ARCHIVE_LINKS) {
      const supplied = parsed[key] ? asSha256(parsed[key]![digestField]) : undefined;
      if (supplied && archiveDigestFor(key) !== supplied) blockers.push(`ARCHIVE_${key.toUpperCase()}_MISMATCH`);
    }
  }

  const overall: ReviewBundle['overall'] = blockers.length === 0 ? 'REVIEW_BUNDLE_READY' : 'REVIEW_BUNDLE_BLOCKED';
  const withoutDigest: Omit<ReviewBundle, 'reviewBundleDigest'> = {
    report: 'phase-230-promotion-coordinator-review-bundle',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    components,
    blockers,
    disclaimers: REVIEW_BUNDLE_DISCLAIMERS,
  };
  return { ...withoutDigest, reviewBundleDigest: digest('phase-230-review-bundle', JSON.stringify(withoutDigest)) };
}

// Which archive component each supplied record must agree with, and the field carrying that record's digest.
const ARCHIVE_LINKS: readonly [key: 'evidence' | 'transcript' | 'ledger' | 'dag', digestField: string][] = [
  ['evidence', 'packetDigest'],
  ['transcript', 'transcriptDigest'],
  ['ledger', 'ledgerDigest'],
  ['dag', 'dagDigest'],
];

function componentDigestFor(archive: Record<string, unknown>): (name: string) => string | undefined {
  const comps = Array.isArray(archive.components) ? archive.components : [];
  return (name: string): string | undefined => {
    for (const c of comps) { const co = asObject(c); if (co.component === name) return asSha256(co.digest); }
    return undefined;
  };
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asSha256(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
