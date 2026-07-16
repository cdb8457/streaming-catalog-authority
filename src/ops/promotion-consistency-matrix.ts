import { createHash } from 'node:crypto';

// Local, non-live cross-report consistency matrix. It takes the top-level offline records — the evidence
// packet, review transcript, provenance ledger, gate DAG, archive manifest, and review bundle — and
// checks every shared digest that appears in more than one report agrees across all of them (e.g. the
// ledger's recorded evidence digest, the archive's evidence component, and the review bundle's evidence
// component must all equal the evidence packet's own self-digest). It reads parsed JSON only; it performs
// no promotion, never touches the real Movies root, never contacts Jellyfin, and authorizes nothing live.

export interface ConsistencyInput {
  readonly evidence?: unknown;
  readonly transcript?: unknown;
  readonly ledger?: unknown;
  readonly dag?: unknown;
  readonly archive?: unknown;
  readonly reviewBundle?: unknown;
}

export interface ConsistencyEdge {
  readonly relation: string;
  readonly status: 'consistent' | 'inconsistent' | 'incomplete';
}

export interface ConsistencyMatrix {
  readonly report: 'phase-230-promotion-cross-report-consistency-matrix';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'MATRIX_CONSISTENT' | 'MATRIX_INCONSISTENT' | 'MATRIX_INCOMPLETE';
  readonly edges: readonly ConsistencyEdge[];
  readonly mismatches: readonly string[];
  readonly incomplete: readonly string[];
  readonly matrixDigest: string;
}

export function buildConsistencyMatrix(input: ConsistencyInput): ConsistencyMatrix {
  const self = (v: unknown, field: string): (() => string | undefined) => () => asSha256(asObject(v)[field]);
  const eD = self(input.evidence, 'packetDigest');
  const tD = self(input.transcript, 'transcriptDigest');
  const lD = self(input.ledger, 'ledgerDigest');
  const gD = self(input.dag, 'dagDigest');
  const aD = self(input.archive, 'archiveDigest');
  const ledgerEntry = (id: string): (() => string | undefined) => () => ledgerDigestFor(input.ledger, id);
  const archiveComp = (name: string): (() => string | undefined) => () => componentDigest(input.archive, name);
  const reviewComp = (name: string): (() => string | undefined) => () => componentDigest(input.reviewBundle, name);

  // Every cross-report edge: the two sides must resolve to the same digest.
  const defs: ReadonlyArray<readonly [string, () => string | undefined, () => string | undefined]> = [
    ['ledger.evidence-entry=evidence.self', ledgerEntry('phase-230-promotion-coordinator-evidence-packet'), eD],
    ['ledger.transcript-entry=transcript.self', ledgerEntry('phase-230-promotion-review-transcript'), tD],
    ['archive.evidence=evidence.self', archiveComp('evidence'), eD],
    ['archive.transcript=transcript.self', archiveComp('transcript'), tD],
    ['archive.ledger=ledger.self', archiveComp('ledger'), lD],
    ['archive.dag=dag.self', archiveComp('dag'), gD],
    ['review.evidence=evidence.self', reviewComp('evidence'), eD],
    ['review.transcript=transcript.self', reviewComp('transcript'), tD],
    ['review.ledger=ledger.self', reviewComp('ledger'), lD],
    ['review.dag=dag.self', reviewComp('dag'), gD],
    ['review.archive=archive.self', reviewComp('archive'), aD],
  ];

  const edges: ConsistencyEdge[] = [];
  const mismatches: string[] = [];
  const incomplete: string[] = [];
  for (const [relation, left, right] of defs) {
    const l = left();
    const r = right();
    let status: ConsistencyEdge['status'];
    if (l === undefined || r === undefined) { status = 'incomplete'; incomplete.push(relation); }
    else if (l === r) { status = 'consistent'; }
    else { status = 'inconsistent'; mismatches.push(relation); }
    edges.push({ relation, status });
  }

  const overall: ConsistencyMatrix['overall'] =
    mismatches.length > 0 ? 'MATRIX_INCONSISTENT' : incomplete.length > 0 ? 'MATRIX_INCOMPLETE' : 'MATRIX_CONSISTENT';
  const withoutDigest: Omit<ConsistencyMatrix, 'matrixDigest'> = {
    report: 'phase-230-promotion-cross-report-consistency-matrix',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    edges,
    mismatches,
    incomplete,
  };
  return { ...withoutDigest, matrixDigest: digest('phase-230-consistency-matrix', JSON.stringify(withoutDigest)) };
}

function ledgerDigestFor(ledger: unknown, id: string): string | undefined {
  const entries = asObject(ledger).entries;
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) { const e = asObject(entry); if (e.id === id) return asSha256(e.digest); }
  return undefined;
}
function componentDigest(report: unknown, name: string): string | undefined {
  const comps = asObject(report).components;
  if (!Array.isArray(comps)) return undefined;
  for (const c of comps) { const co = asObject(c); if (co.component === name) return asSha256(co.digest); }
  return undefined;
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
