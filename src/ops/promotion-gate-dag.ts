import { createHash } from 'node:crypto';

// Local, non-live gate dependency DAG for the Phase 230 pipeline. It declares each verification gate,
// its dependencies, its test, and its representative blockers, then verifies the graph is acyclic and
// every dependency resolves. It is a pure declaration + check; it performs no promotion, never touches
// the real Movies root, never contacts Jellyfin, and authorizes nothing live.

export interface GateNode {
  readonly id: string;
  readonly test: string;
  readonly dependsOn: readonly string[];
  readonly blockers: readonly string[];
}

export interface GateDagReport {
  readonly report: 'phase-230-promotion-gate-dag';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly ok: boolean;
  readonly acyclic: boolean;
  readonly nodeCount: number;
  readonly topoOrder: readonly string[];
  readonly problems: readonly string[];
  readonly nodes: readonly GateNode[];
  readonly dagDigest: string;
}

const NODES: readonly GateNode[] = [
  { id: 'approval', test: 'test/promotion-approval.ts', dependsOn: [], blockers: ['PROMOTION_APPROVAL_REQUIRED', 'PROMOTION_APPROVAL_MISMATCH'] },
  { id: 'promotion', test: 'test/real-library-promotion.ts', dependsOn: ['approval'], blockers: ['PROMOTION_VISIBILITY_REQUIRED', 'PROMOTION_TARGET_FORBIDDEN'] },
  { id: 'rehearsal', test: 'test/promotion-rehearsal.ts', dependsOn: ['approval', 'promotion'], blockers: ['REHEARSAL_FAIL'] },
  { id: 'evidence-review', test: 'test/promotion-evidence-review.ts', dependsOn: ['promotion'], blockers: ['EVIDENCE_DIGEST_MISMATCH', 'RAW_PATH_LEAK_SUSPECTED'] },
  { id: 'readiness', test: 'test/promotion-readiness.ts', dependsOn: ['approval', 'promotion', 'evidence-review'], blockers: ['PROMOTION_MATCHES_APPROVAL', 'OBSERVED_JELLYFIN_STATE'] },
  { id: 'acceptance-seal', test: 'test/promotion-acceptance-seal.ts', dependsOn: ['readiness'], blockers: ['READINESS_NOT_READY', 'ACCEPTANCE_REJECTED'] },
  { id: 'rehearsal-matrix', test: 'test/promotion-rehearsal-matrix.ts', dependsOn: ['rehearsal'], blockers: ['MATRIX_FAIL'] },
  { id: 'artifact-integrity', test: 'test/promotion-artifact-integrity.ts', dependsOn: ['acceptance-seal'], blockers: ['PROMOTION_EVIDENCE_SELF_DIGEST_MISMATCH', 'REVIEW_TO_PROMOTION_MISMATCH'] },
  { id: 'artifact-schema', test: 'test/promotion-artifact-schema.ts', dependsOn: ['acceptance-seal'], blockers: ['ACCEPTANCE_PACKET_STATUS_INVALID'] },
  { id: 'handoff', test: 'test/promotion-handoff.ts', dependsOn: ['acceptance-seal', 'artifact-integrity', 'rehearsal-matrix'], blockers: ['ACCEPTANCE_NOT_SEALED', 'INTEGRITY_NOT_OK'] },
  { id: 'dashboard', test: 'test/promotion-dashboard.ts', dependsOn: ['rehearsal-matrix', 'artifact-integrity', 'artifact-schema', 'handoff'], blockers: ['MATRIX_NOT_PASS', 'SCHEMA_NOT_OK', 'HANDOFF_NOT_READY'] },
  { id: 'fixture-bundle', test: 'test/promotion-fixture-bundle.ts', dependsOn: ['rehearsal', 'artifact-integrity', 'artifact-schema', 'rehearsal-matrix', 'handoff', 'dashboard'], blockers: ['BUNDLE_NOT_ALL_GREEN', 'RAW_PATH_IN_BUNDLE'] },
  { id: 'bundle-replay', test: 'test/promotion-bundle-replay.ts', dependsOn: ['fixture-bundle'], blockers: ['BUNDLE_SELF_DIGEST_MISMATCH', 'MANIFEST_STAGE_MISMATCH'] },
  { id: 'bundle-diff', test: 'test/promotion-bundle-diff.ts', dependsOn: ['fixture-bundle'], blockers: [] },
  { id: 'tamper-corpus', test: 'test/promotion-tamper-corpus.ts', dependsOn: ['fixture-bundle'], blockers: [] },
  { id: 'provenance-ledger', test: 'test/promotion-provenance-ledger.ts', dependsOn: ['fixture-bundle'], blockers: [] },
  { id: 'evidence-packet', test: 'test/promotion-evidence-packet.ts', dependsOn: ['fixture-bundle', 'bundle-replay'], blockers: ['BUNDLE_NOT_READY', 'REPLAY_MISSING', 'REPLAY_NOT_OK'] },
  { id: 'review-transcript', test: 'test/promotion-review-transcript.ts', dependsOn: [], blockers: ['REVIEWED_COMMIT_INVALID', 'TEST_FAILED'] },
  { id: 'gate-dag', test: 'test/promotion-gate-dag.ts', dependsOn: [], blockers: ['CYCLE_DETECTED', 'UNKNOWN_DEPENDENCY'] },
  { id: 'changelog', test: 'test/promotion-changelog.ts', dependsOn: [], blockers: ['CHANGELOG_COMMIT_INVALID', 'RAW_PATH_LEAK_SUSPECTED'] },
  { id: 'archive-manifest', test: 'test/promotion-archive-manifest.ts', dependsOn: ['provenance-ledger', 'gate-dag', 'evidence-packet', 'review-transcript'], blockers: ['ARCHIVE_NOT_READY', 'EVIDENCE_LEDGER_MISMATCH', 'TRANSCRIPT_LEDGER_MISMATCH'] },
  { id: 'acceptance-meta', test: 'test/promotion-acceptance-meta.ts', dependsOn: [], blockers: ['ACCEPTANCE_META_INCOMPLETE'] },
  { id: 'injection-corpus', test: 'test/promotion-injection-corpus.ts', dependsOn: [], blockers: ['INJECTION_EXECUTION_DETECTED', 'INJECTION_LIVE_CALL_DETECTED'] },
  { id: 'review-bundle', test: 'test/promotion-review-bundle.ts', dependsOn: ['evidence-packet', 'review-transcript', 'provenance-ledger', 'gate-dag', 'archive-manifest'], blockers: ['REVIEW_BUNDLE_BLOCKED', 'ARCHIVE_EVIDENCE_MISMATCH'] },
  { id: 'consistency-matrix', test: 'test/promotion-consistency-matrix.ts', dependsOn: ['archive-manifest', 'review-bundle'], blockers: ['MATRIX_INCONSISTENT', 'MATRIX_INCOMPLETE'] },
  { id: 'self-digest-verifier', test: 'test/promotion-self-digest-verifier.ts', dependsOn: [], blockers: ['DIGEST_MISMATCH', 'UNRECOGNIZED_REPORT'] },
  { id: 'cli-contract', test: 'test/promotion-cli-contract.ts', dependsOn: [], blockers: ['CONTRACT_VIOLATION', 'RAW_PATH_LEAK'] },
  { id: 'determinism', test: 'test/promotion-determinism.ts', dependsOn: [], blockers: ['NON_DETERMINISTIC', 'INSUFFICIENT_SAMPLES'] },
  { id: 'closure', test: 'test/phase230-closure.ts', dependsOn: [], blockers: ['OP_NOT_FULLY_MAPPED', 'GATE_REFERENCES_NON_LOCAL_SUITE'] },
  { id: 'live-boundary', test: 'test/promotion-live-boundary-guard.ts', dependsOn: [], blockers: ['FORBIDDEN_LIVE_HOOK', 'MISSING_BOUNDARY_LANGUAGE'] },
];

export function buildGateDag(): readonly GateNode[] {
  return NODES;
}

export function verifyGateDag(nodes: readonly GateNode[] = NODES): GateDagReport {
  const problems: string[] = [];
  const ids = new Set(nodes.map((n) => n.id));

  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      if (!ids.has(dep)) problems.push(`UNKNOWN_DEPENDENCY:${dep}`);
    }
  }

  // Kahn's algorithm for a topological order; a leftover means a cycle.
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const n of nodes) for (const dep of n.dependsOn) if (ids.has(dep)) indegree.set(n.id, (indegree.get(n.id) ?? 0) + 1);
  const queue = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id).sort();
  const topoOrder: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    topoOrder.push(id);
    for (const n of nodes) {
      if (n.dependsOn.includes(id)) {
        const d = (indegree.get(n.id) ?? 0) - 1;
        indegree.set(n.id, d);
        if (d === 0) { queue.push(n.id); queue.sort(); }
      }
    }
  }
  const acyclic = topoOrder.length === nodes.length;
  if (!acyclic) problems.push('CYCLE_DETECTED');

  const ok = problems.length === 0;
  const withoutDigest: Omit<GateDagReport, 'dagDigest'> = {
    report: 'phase-230-promotion-gate-dag',
    version: 1,
    redactionSafe: true,
    ok,
    acyclic,
    nodeCount: nodes.length,
    topoOrder,
    problems,
    nodes,
  };
  return { ...withoutDigest, dagDigest: digest('phase-230-gate-dag', JSON.stringify(withoutDigest)) };
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
