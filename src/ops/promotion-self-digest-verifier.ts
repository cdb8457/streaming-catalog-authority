import { createHash } from 'node:crypto';

// Local, non-live all-artifacts self-digest verifier. For any known Phase 230 report it recomputes the
// self-digest from the report body (every key except the trailing digest field) under that report's fixed
// hashing scope and confirms it equals the stated digest. It reads parsed JSON only; it performs no
// promotion, never touches the real Movies root, never contacts Jellyfin, and authorizes nothing live.

interface DigestSpec { readonly field: string; readonly scope: string; }

// report id -> (trailing digest field, hashing scope). Authoritative: taken from each producer module.
const REGISTRY: Readonly<Record<string, DigestSpec>> = {
  'phase-230-promotion-approval-attestation': { field: 'evidenceDigest', scope: 'phase-230-approval-evidence' },
  'phase-230-promotion-evidence-review': { field: 'reviewDigest', scope: 'phase-230-evidence-review' },
  'phase-230-promotion-readiness-checklist': { field: 'checklistDigest', scope: 'phase-230-readiness-checklist' },
  'phase-230-promotion-acceptance-packet': { field: 'sealDigest', scope: 'phase-230-acceptance-seal' },
  'phase-230-promotion-rehearsal-manifest': { field: 'manifestDigest', scope: 'phase-230-rehearsal-manifest' },
  'phase-230-promotion-rehearsal-matrix': { field: 'matrixDigest', scope: 'phase-230-rehearsal-matrix' },
  'phase-230-promotion-artifact-integrity': { field: 'integrityDigest', scope: 'phase-230-artifact-integrity' },
  'phase-230-promotion-artifact-schema': { field: 'selfDigest', scope: 'phase-230-artifact-schema' },
  'phase-230-promotion-acceptance-dashboard': { field: 'dashboardDigest', scope: 'phase-230-acceptance-dashboard' },
  'phase-230-promotion-coordinator-handoff': { field: 'handoffDigest', scope: 'phase-230-coordinator-handoff' },
  'phase-230-promotion-fixture-evidence-bundle': { field: 'bundleDigest', scope: 'phase-230-fixture-bundle' },
  'phase-230-promotion-bundle-replay': { field: 'replayDigest', scope: 'phase-230-bundle-replay' },
  'phase-230-promotion-coordinator-evidence-packet': { field: 'packetDigest', scope: 'phase-230-evidence-packet' },
  'phase-230-promotion-bundle-diff': { field: 'diffDigest', scope: 'phase-230-bundle-diff' },
  'phase-230-promotion-tamper-corpus': { field: 'corpusDigest', scope: 'phase-230-tamper-corpus' },
  'phase-230-promotion-review-transcript': { field: 'transcriptDigest', scope: 'phase-230-review-transcript' },
  'phase-230-promotion-provenance-ledger': { field: 'ledgerDigest', scope: 'phase-230-provenance-ledger' },
  'phase-230-promotion-gate-dag': { field: 'dagDigest', scope: 'phase-230-gate-dag' },
  'phase-230-promotion-changelog': { field: 'changelogDigest', scope: 'phase-230-changelog' },
  'phase-230-promotion-evidence-archive-manifest': { field: 'archiveDigest', scope: 'phase-230-archive-manifest' },
  'phase-230-promotion-acceptance-meta': { field: 'metaDigest', scope: 'phase-230-acceptance-meta' },
  'phase-230-promotion-injection-corpus': { field: 'corpusDigest', scope: 'phase-230-injection-corpus' },
  'phase-230-promotion-coordinator-review-bundle': { field: 'reviewBundleDigest', scope: 'phase-230-review-bundle' },
  'phase-230-promotion-cross-report-consistency-matrix': { field: 'matrixDigest', scope: 'phase-230-consistency-matrix' },
  'phase-230-promotion-self-digest-verification': { field: 'verifierDigest', scope: 'phase-230-self-digest-verifier' },
  'phase-230-promotion-cli-contract': { field: 'contractDigest', scope: 'phase-230-cli-contract' },
  'phase-230-promotion-determinism-stress': { field: 'determinismDigest', scope: 'phase-230-determinism-stress' },
  'phase-230-promotion-blocker-taxonomy': { field: 'taxonomyDigest', scope: 'phase-230-blocker-taxonomy' },
  'phase-230-promotion-coordinator-final-summary': { field: 'summaryDigest', scope: 'phase-230-final-summary' },
  'phase-230-promotion-closure-hygiene': { field: 'hygieneDigest', scope: 'phase-230-closure-hygiene' },
  'phase-230-promotion-negative-evidence-corpus': { field: 'corpusDigest', scope: 'phase-230-negative-evidence-corpus' },
  'phase-230-promotion-coordinator-release-checklist': { field: 'checklistDigest', scope: 'phase-230-release-checklist' },
  'phase-230-promotion-merge-readiness-dry-run': { field: 'manifestDigest', scope: 'phase-230-merge-readiness' },
  'phase-230-promotion-provenance-diff': { field: 'diffDigest', scope: 'phase-230-provenance-diff' },
  'phase-230-promotion-gate-coverage': { field: 'coverageDigest', scope: 'phase-230-gate-coverage' },
  'phase-230-promotion-artifact-chain-bundle': { field: 'chainDigest', scope: 'phase-230-artifact-chain-bundle' },
  'phase-230-promotion-redaction-corpus': { field: 'redactionDigest', scope: 'phase-230-redaction-corpus' },
  'phase-230-promotion-boundary-policy': { field: 'policyDigest', scope: 'phase-230-boundary-policy' },
  'phase-230-promotion-review-automation': { field: 'automationDigest', scope: 'phase-230-review-automation' },
  'phase-230-promotion-merge-review-evidence-pack': { field: 'packDigest', scope: 'phase-230-reviewer-pack' },
  'phase-230-promotion-acceptance-preflight': { field: 'preflightDigest', scope: 'phase-230-acceptance-preflight' },
  'phase-230-promotion-failure-mode-matrix': { field: 'failureMatrixDigest', scope: 'phase-230-failure-matrix' },
  'phase-230-promotion-cli-ergonomics': { field: 'ergonomicsDigest', scope: 'phase-230-cli-ergonomics' },
  'phase-230-promotion-report-schema': { field: 'reportSchemaDigest', scope: 'phase-230-report-schema' },
  'phase-230-promotion-boundary-audit': { field: 'auditDigest', scope: 'phase-230-boundary-audit' },
  'phase-230-promotion-coordinator-readiness-manifest': { field: 'readinessDigest', scope: 'phase-230-coordinator-readiness' },
  'phase-230-promotion-transcript-verification': { field: 'verificationDigest', scope: 'phase-230-transcript-verifier' },
  'phase-230-promotion-evidence-minimizer': { field: 'minimizerDigest', scope: 'phase-230-evidence-minimizer' },
  'phase-230-promotion-commit-range-closure': { field: 'closureDigest', scope: 'phase-230-commit-range-closure' },
  'phase-230-promotion-regression-oracle': { field: 'oracleDigest', scope: 'phase-230-regression-oracle' },
};

export const KNOWN_REPORT_IDS: readonly string[] = Object.keys(REGISTRY);

export interface SelfDigestResult {
  readonly report: string;
  readonly recognized: boolean;
  readonly verified: boolean;
}

export interface SelfDigestVerification {
  readonly report: 'phase-230-promotion-self-digest-verification';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'ALL_VERIFIED' | 'DIGEST_MISMATCH' | 'UNRECOGNIZED_REPORT' | 'NO_REPORTS';
  readonly count: number;
  readonly results: readonly SelfDigestResult[];
  readonly mismatches: readonly string[];
  readonly unrecognized: readonly string[];
  readonly verifierDigest: string;
}

export function verifySelfDigests(reports: readonly unknown[]): SelfDigestVerification {
  const results: SelfDigestResult[] = [];
  const mismatches: string[] = [];
  const unrecognized: string[] = [];
  for (const r of reports) {
    const obj = asObject(r);
    const id = typeof obj.report === 'string' ? obj.report : '<unknown>';
    const spec = REGISTRY[id];
    if (!spec) { results.push({ report: id, recognized: false, verified: false }); unrecognized.push(id); continue; }
    const stated = asSha256(obj[spec.field]);
    const verified = stated !== undefined && stated === recomputeSelfDigest(obj, spec.field, spec.scope);
    if (!verified) mismatches.push(id);
    results.push({ report: id, recognized: true, verified });
  }

  const overall: SelfDigestVerification['overall'] =
    reports.length === 0 ? 'NO_REPORTS'
      : mismatches.length > 0 ? 'DIGEST_MISMATCH'
        : unrecognized.length > 0 ? 'UNRECOGNIZED_REPORT'
          : 'ALL_VERIFIED';
  const withoutDigest: Omit<SelfDigestVerification, 'verifierDigest'> = {
    report: 'phase-230-promotion-self-digest-verification',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    count: reports.length,
    results,
    mismatches,
    unrecognized,
  };
  return { ...withoutDigest, verifierDigest: digest('phase-230-self-digest-verifier', JSON.stringify(withoutDigest)) };
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
