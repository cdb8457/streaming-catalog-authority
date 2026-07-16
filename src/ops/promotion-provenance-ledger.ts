import { createHash } from 'node:crypto';

// Local, non-live provenance ledger. From a fixture evidence bundle (and, optionally, the replay,
// evidence packet, and review transcript) it records, for every Phase 230 artifact/report: its report
// id, self-digest, producing tool, consuming tools, and present/absent status. It reads parsed JSON
// only; it performs no promotion, never touches the real Movies root, never contacts Jellyfin, and
// authorizes nothing live.

export interface ProvenanceInput {
  readonly bundle?: unknown;
  readonly replay?: unknown;
  readonly evidence?: unknown;
  readonly transcript?: unknown;
}

export interface ProvenanceEntry {
  readonly id: string;
  readonly producer: string;
  readonly consumers: readonly string[];
  readonly status: 'present' | 'absent';
  readonly digest?: string;
}

export interface ProvenanceLedger {
  readonly report: 'phase-230-promotion-provenance-ledger';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly complete: boolean;
  readonly entries: readonly ProvenanceEntry[];
  readonly absent: readonly string[];
  readonly ledgerDigest: string;
}

type Where = 'artifact' | 'report' | 'manifest' | 'bundle' | 'replay' | 'evidence' | 'transcript';

interface RegistryItem {
  readonly key: string;
  readonly id: string;
  readonly digestField: string;
  readonly producer: string;
  readonly consumers: readonly string[];
  readonly where: Where;
}

const REGISTRY: readonly RegistryItem[] = [
  { key: 'approvalEvidence', id: 'phase-230-promotion-approval-attestation', digestField: 'evidenceDigest', producer: 'promotion-approval', consumers: ['promotion-readiness', 'promotion-artifact-integrity', 'promotion-artifact-schema', 'promotion-handoff'], where: 'artifact' },
  { key: 'promotionEvidence', id: 'phase-230-real-library-promotion', digestField: 'evidenceDigest', producer: 'promotion-rehearsal', consumers: ['promotion-evidence-review', 'promotion-readiness', 'promotion-artifact-integrity', 'promotion-artifact-schema'], where: 'artifact' },
  { key: 'evidenceReview', id: 'phase-230-promotion-evidence-review', digestField: 'reviewDigest', producer: 'promotion-evidence-review', consumers: ['promotion-readiness', 'promotion-artifact-integrity', 'promotion-artifact-schema'], where: 'artifact' },
  { key: 'readiness', id: 'phase-230-promotion-readiness-checklist', digestField: 'checklistDigest', producer: 'promotion-readiness', consumers: ['promotion-acceptance-seal', 'promotion-artifact-integrity', 'promotion-artifact-schema'], where: 'artifact' },
  { key: 'acceptancePacket', id: 'phase-230-promotion-acceptance-packet', digestField: 'sealDigest', producer: 'promotion-acceptance-seal', consumers: ['promotion-handoff', 'promotion-artifact-integrity', 'promotion-artifact-schema'], where: 'artifact' },
  { key: 'integrity', id: 'phase-230-promotion-artifact-integrity', digestField: 'integrityDigest', producer: 'promotion-artifact-integrity', consumers: ['promotion-dashboard', 'promotion-handoff', 'promotion-evidence-packet'], where: 'report' },
  { key: 'schema', id: 'phase-230-promotion-artifact-schema', digestField: 'schemaDigest', producer: 'promotion-artifact-schema', consumers: ['promotion-dashboard', 'promotion-evidence-packet'], where: 'report' },
  { key: 'matrix', id: 'phase-230-promotion-rehearsal-matrix', digestField: 'matrixDigest', producer: 'promotion-rehearsal-matrix', consumers: ['promotion-handoff', 'promotion-dashboard', 'promotion-evidence-packet'], where: 'report' },
  { key: 'handoff', id: 'phase-230-promotion-coordinator-handoff', digestField: 'handoffDigest', producer: 'promotion-handoff', consumers: ['promotion-dashboard', 'promotion-evidence-packet'], where: 'report' },
  { key: 'dashboard', id: 'phase-230-promotion-acceptance-dashboard', digestField: 'dashboardDigest', producer: 'promotion-dashboard', consumers: ['promotion-evidence-packet'], where: 'report' },
  { key: 'rehearsalManifest', id: 'phase-230-promotion-rehearsal-manifest', digestField: 'manifestDigest', producer: 'promotion-rehearsal', consumers: ['promotion-fixture-bundle', 'promotion-bundle-replay'], where: 'manifest' },
  { key: 'bundle', id: 'phase-230-promotion-fixture-evidence-bundle', digestField: 'bundleDigest', producer: 'promotion-fixture-bundle', consumers: ['promotion-bundle-replay', 'promotion-bundle-diff', 'promotion-tamper-corpus', 'promotion-evidence-packet'], where: 'bundle' },
  { key: 'replay', id: 'phase-230-promotion-bundle-replay', digestField: 'replayDigest', producer: 'promotion-bundle-replay', consumers: ['promotion-evidence-packet'], where: 'replay' },
  { key: 'evidence', id: 'phase-230-promotion-coordinator-evidence-packet', digestField: 'packetDigest', producer: 'promotion-evidence-packet', consumers: ['promotion-review-bundle'], where: 'evidence' },
  { key: 'transcript', id: 'phase-230-promotion-review-transcript', digestField: 'transcriptDigest', producer: 'promotion-review-transcript', consumers: ['promotion-review-bundle'], where: 'transcript' },
];

export function buildProvenanceLedger(input: ProvenanceInput): ProvenanceLedger {
  const bundle = asObject(input.bundle);
  const artifacts = asObject(bundle.artifacts);
  const reports = asObject(bundle.reports);
  const locate = (item: RegistryItem): unknown => {
    switch (item.where) {
      case 'artifact': return asObject(artifacts[item.key])[item.digestField];
      case 'report': return asObject(reports[item.key])[item.digestField];
      case 'manifest': return asObject(bundle.rehearsalManifest)[item.digestField];
      case 'bundle': return bundle[item.digestField];
      case 'replay': return asObject(input.replay)[item.digestField];
      case 'evidence': return asObject(input.evidence)[item.digestField];
      case 'transcript': return asObject(input.transcript)[item.digestField];
    }
  };

  const entries: ProvenanceEntry[] = REGISTRY.map((item) => {
    const d = asSha256(locate(item));
    return { id: item.id, producer: item.producer, consumers: item.consumers, status: d ? 'present' : 'absent', ...(d ? { digest: d } : {}) };
  });
  const absent = entries.filter((e) => e.status === 'absent').map((e) => e.id);
  const complete = absent.length === 0;

  const withoutDigest: Omit<ProvenanceLedger, 'ledgerDigest'> = {
    report: 'phase-230-promotion-provenance-ledger',
    version: 1,
    redactionSafe: true,
    complete,
    entries,
    absent,
  };
  return { ...withoutDigest, ledgerDigest: digest('phase-230-provenance-ledger', JSON.stringify(withoutDigest)) };
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
