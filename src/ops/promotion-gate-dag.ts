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
  { id: 'blocker-taxonomy', test: 'test/promotion-blocker-taxonomy.ts', dependsOn: [], blockers: ['TAXONOMY_INCONSISTENT', 'MALFORMED_CODE'] },
  { id: 'final-summary', test: 'test/promotion-final-summary.ts', dependsOn: ['review-bundle', 'consistency-matrix', 'self-digest-verifier', 'blocker-taxonomy'], blockers: ['REVIEW_BUNDLE_NOT_READY', 'MATRIX_NOT_CONSISTENT', 'SELF_DIGEST_NOT_VERIFIED', 'TAXONOMY_NOT_CONSISTENT'] },
  { id: 'closure-hygiene', test: 'test/promotion-closure-hygiene.ts', dependsOn: ['gate-dag', 'blocker-taxonomy'], blockers: ['HYGIENE_VIOLATION', 'REGISTRY_NOT_WIRED'] },
  { id: 'negative-evidence-corpus', test: 'test/promotion-negative-evidence-corpus.ts', dependsOn: [], blockers: ['CORPUS_BREACHED'] },
  { id: 'release-checklist', test: 'test/promotion-release-checklist.ts', dependsOn: ['review-bundle', 'review-transcript', 'final-summary', 'negative-evidence-corpus', 'closure-hygiene'], blockers: ['RELEASE_CHECKLIST_BLOCKED', 'NEGATIVE_CORPUS_BREACHED', 'COMMIT_BINDING_MISMATCH', 'TRANSCRIPT_BUNDLE_MISMATCH', 'REQUIRED_DIGEST_MISSING'] },
  { id: 'merge-readiness', test: 'test/promotion-merge-readiness.ts', dependsOn: ['release-checklist'], blockers: ['MERGE_DRY_RUN_BLOCKED', 'RELEASE_CHECKLIST_NOT_CLEARED', 'MERGE_CONTEXT_INVALID', 'FINAL_SUMMARY_BINDING_MISMATCH', 'CHECKLIST_BINDING_INCOMPLETE'] },
  { id: 'provenance-diff', test: 'test/promotion-provenance-diff.ts', dependsOn: ['review-transcript'], blockers: ['HEAD_REVIEWED_COMMIT_MISMATCH', 'STALE_ARTIFACT', 'COMMIT_SHA_MALFORMED'] },
  { id: 'gate-coverage', test: 'test/promotion-gate-coverage.ts', dependsOn: ['gate-dag', 'blocker-taxonomy'], blockers: ['MISSING_WIRING', 'GATE_NOT_IN_LOCAL_SUITE'] },
  { id: 'chain-bundle', test: 'test/promotion-chain-bundle.ts', dependsOn: ['final-summary', 'release-checklist', 'merge-readiness', 'negative-evidence-corpus', 'provenance-diff', 'gate-coverage'], blockers: ['CHAIN_BUNDLE_BLOCKED', 'FINAL_SUMMARY_BINDING_MISMATCH', 'COMPONENT_DIGEST_MISSING'] },
  { id: 'redaction-corpus', test: 'test/promotion-redaction-corpus.ts', dependsOn: [], blockers: ['LEAK_NOT_DETECTED', 'SAFE_VALUE_FLAGGED'] },
  { id: 'boundary-policy', test: 'test/promotion-boundary-policy.ts', dependsOn: [], blockers: ['FORBIDDEN_HOOK_FOUND', 'BOUNDARY_LANGUAGE_MISSING', 'UNSANDBOXED_PROMOTION_CALL'] },
  { id: 'review-automation', test: 'test/promotion-review-automation.ts', dependsOn: ['chain-bundle', 'redaction-corpus', 'boundary-policy'], blockers: ['CHAIN_BUNDLE_NOT_READY', 'REDACTION_CORPUS_BREACHED', 'BOUNDARY_POLICY_VIOLATED'] },
  { id: 'reviewer-pack', test: 'test/promotion-reviewer-pack.ts', dependsOn: ['final-summary', 'release-checklist', 'merge-readiness', 'chain-bundle', 'review-automation', 'redaction-corpus', 'boundary-policy'], blockers: ['PACK_BINDING_MISMATCH', 'COMPONENT_DIGEST_MISSING', 'REVIEW_AUTOMATION_NOT_PASSED'] },
  { id: 'acceptance-preflight', test: 'test/promotion-acceptance-preflight.ts', dependsOn: ['reviewer-pack'], blockers: ['REVIEWER_PACK_NOT_READY', 'REVIEWER_PACK_DIGEST_MISMATCH', 'PACK_COMPONENT_INCOMPLETE', 'PACK_BINDING_FAILED', 'CONTEXT_HEAD_MISMATCH', 'CONTEXT_COMMITS_MISMATCH', 'HEAD_NOT_TERMINAL_COMMIT', 'PREFLIGHT_CONTEXT_INVALID', 'MACHINE_GATE_FAILED'] },
  { id: 'failure-matrix', test: 'test/promotion-failure-matrix.ts', dependsOn: ['gate-dag', 'blocker-taxonomy'], blockers: ['UNMAPPED_BLOCKER', 'BLOCKER_WITHOUT_EVIDENCE'] },
  { id: 'cli-ergonomics', test: 'test/promotion-cli-ergonomics.ts', dependsOn: [], blockers: ['USAGE_MISSING', 'HELP_MISSING'] },
  { id: 'report-schema', test: 'test/promotion-report-schema.ts', dependsOn: [], blockers: ['REPORT_SHAPE_INVALID', 'UNKNOWN_KEY', 'REPORT_DIGEST_MISMATCH'] },
  { id: 'boundary-audit', test: 'test/promotion-boundary-audit.ts', dependsOn: ['boundary-policy'], blockers: ['AUDIT_POLICY_VIOLATED', 'AUDIT_NETWORK_URL_FOUND', 'AUDIT_NON_LOCAL_SUITE'] },
  { id: 'coordinator-readiness', test: 'test/promotion-coordinator-readiness.ts', dependsOn: ['acceptance-preflight', 'failure-matrix', 'report-schema', 'boundary-audit', 'cli-ergonomics'], blockers: ['ACCEPTANCE_PREFLIGHT_NOT_READY', 'BOUNDARY_AUDIT_FAILED', 'REPORT_SCHEMA_NOT_OK'] },
  { id: 'transcript-verifier', test: 'test/promotion-transcript-verifier.ts', dependsOn: ['review-transcript'], blockers: ['HEAD_MISMATCH', 'COMMAND_MISSING', 'TEST_EXIT_NONZERO'] },
  { id: 'evidence-minimizer', test: 'test/promotion-evidence-minimizer.ts', dependsOn: [], blockers: ['MINIMIZED_LEAK'] },
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
