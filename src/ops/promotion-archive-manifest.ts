import { createHash } from 'node:crypto';

// Local, non-live evidence archive manifest. It consumes the provenance ledger, the gate DAG, the
// coordinator evidence packet, and the review transcript, and produces a redaction-safe archive manifest
// that is ARCHIVE_READY only when all four are present, valid, green, AND mutually consistent. Beyond the
// per-component green checks it (a) recomputes each component's self-digest and (b) cross-checks that the
// ledger actually records the supplied evidence packetDigest and transcript transcriptDigest — so a set
// stitched together from different runs (each individually green) is caught with a generic mismatch code.
// It reads parsed JSON only; it performs no promotion, never touches the real Movies root, never contacts
// Jellyfin, and authorizes nothing live.

export interface ArchiveInput {
  readonly ledger?: unknown;
  readonly dag?: unknown;
  readonly evidence?: unknown;
  readonly transcript?: unknown;
}

export interface ArchiveComponent {
  readonly component: string;
  readonly present: boolean;
  readonly ok: boolean;
  readonly digest?: string;
}

export interface ArchiveManifest {
  readonly report: 'phase-230-promotion-evidence-archive-manifest';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'ARCHIVE_READY' | 'ARCHIVE_BLOCKED';
  readonly components: readonly ArchiveComponent[];
  readonly blockers: readonly string[];
  readonly archiveDigest: string;
}

interface Spec {
  readonly key: keyof ArchiveInput;
  readonly report: string;
  readonly ok: (o: Record<string, unknown>) => boolean;
  readonly digestField: string;
  readonly scope: string;
  readonly missing: string;
  readonly invalid: string;
  readonly notOk: string;
  readonly mismatch: string;
}

const SPECS: readonly Spec[] = [
  { key: 'ledger', report: 'phase-230-promotion-provenance-ledger', ok: (o) => o.complete === true, digestField: 'ledgerDigest', scope: 'phase-230-provenance-ledger', missing: 'LEDGER_MISSING', invalid: 'LEDGER_INVALID', notOk: 'LEDGER_INCOMPLETE', mismatch: 'LEDGER_DIGEST_MISMATCH' },
  { key: 'dag', report: 'phase-230-promotion-gate-dag', ok: (o) => o.ok === true, digestField: 'dagDigest', scope: 'phase-230-gate-dag', missing: 'DAG_MISSING', invalid: 'DAG_INVALID', notOk: 'DAG_NOT_ACYCLIC', mismatch: 'DAG_DIGEST_MISMATCH' },
  { key: 'evidence', report: 'phase-230-promotion-coordinator-evidence-packet', ok: (o) => o.overall === 'EVIDENCE_COMPLETE', digestField: 'packetDigest', scope: 'phase-230-evidence-packet', missing: 'EVIDENCE_MISSING', invalid: 'EVIDENCE_INVALID', notOk: 'EVIDENCE_NOT_COMPLETE', mismatch: 'EVIDENCE_DIGEST_MISMATCH' },
  { key: 'transcript', report: 'phase-230-promotion-review-transcript', ok: (o) => o.verdict === 'REVIEW_CLEAN', digestField: 'transcriptDigest', scope: 'phase-230-review-transcript', missing: 'TRANSCRIPT_MISSING', invalid: 'TRANSCRIPT_INVALID', notOk: 'TRANSCRIPT_NOT_CLEAN', mismatch: 'TRANSCRIPT_DIGEST_MISMATCH' },
];

export function buildArchiveManifest(input: ArchiveInput): ArchiveManifest {
  const blockers: string[] = [];
  const parsed: Partial<Record<keyof ArchiveInput, Record<string, unknown>>> = {};
  const components: ArchiveComponent[] = SPECS.map((spec) => {
    const value = input[spec.key];
    if (value === undefined) { blockers.push(spec.missing); return { component: spec.key, present: false, ok: false }; }
    const obj = asObject(value);
    if (obj.report !== spec.report) { blockers.push(spec.invalid); return { component: spec.key, present: true, ok: false }; }
    parsed[spec.key] = obj;
    const ok = spec.ok(obj);
    if (!ok) blockers.push(spec.notOk);
    const d = asSha256(obj[spec.digestField]);
    // Self-digest cross-check: the component must actually hash to its stated digest.
    if (!d || recomputeSelfDigest(obj, spec.digestField, spec.scope) !== d) blockers.push(spec.mismatch);
    return { component: spec.key, present: true, ok, ...(d ? { digest: d } : {}) };
  });

  // Cross-artifact consistency: the ledger must record the very evidence packet and review transcript
  // supplied here. A set stitched from different runs (each internally valid) fails this generic check.
  const ledgerObj = parsed.ledger;
  if (ledgerObj) {
    const recordedFor = ledgerDigestFor(ledgerObj);
    if (parsed.evidence && recordedFor('phase-230-promotion-coordinator-evidence-packet') !== asSha256(parsed.evidence.packetDigest)) blockers.push('EVIDENCE_LEDGER_MISMATCH');
    if (parsed.transcript && recordedFor('phase-230-promotion-review-transcript') !== asSha256(parsed.transcript.transcriptDigest)) blockers.push('TRANSCRIPT_LEDGER_MISMATCH');
  }

  const overall: ArchiveManifest['overall'] = blockers.length === 0 ? 'ARCHIVE_READY' : 'ARCHIVE_BLOCKED';
  const withoutDigest: Omit<ArchiveManifest, 'archiveDigest'> = {
    report: 'phase-230-promotion-evidence-archive-manifest',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    components,
    blockers,
  };
  return { ...withoutDigest, archiveDigest: digest('phase-230-archive-manifest', JSON.stringify(withoutDigest)) };
}

function ledgerDigestFor(ledger: Record<string, unknown>): (id: string) => string | undefined {
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  return (id: string): string | undefined => {
    for (const entry of entries) { const e = asObject(entry); if (e.id === id) return asSha256(e.digest); }
    return undefined;
  };
}
function recomputeSelfDigest(obj: Record<string, unknown>, digestField: string, scope: string): string {
  const without: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) if (k !== digestField) without[k] = obj[k];
  return digest(scope, JSON.stringify(without));
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
