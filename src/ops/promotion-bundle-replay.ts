import { createHash } from 'node:crypto';
import { verifyArtifactIntegrity } from './promotion-artifact-integrity.js';
import { validateArtifactSchemas } from './promotion-artifact-schema.js';
import { buildCoordinatorHandoff } from './promotion-handoff.js';
import { buildAcceptanceDashboard } from './promotion-dashboard.js';

// Local, non-live replay verifier for a fixture evidence bundle. It re-derives integrity, schema,
// handoff, and dashboard from the bundle's own artifacts and checks they match the bundle's stored
// reports; it re-verifies the self-seals of the matrix and rehearsal manifest; and it checks the
// rehearsal manifest's stage digests match the artifact self-digests. It fails closed on any missing,
// tampered, wrong-report, or mismatch. It reads parsed JSON only; it performs no promotion, never
// touches the real Movies root, never contacts Jellyfin, and authorizes nothing live.

export interface BundleReplayReport {
  readonly report: 'phase-230-promotion-bundle-replay';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly ok: boolean;
  readonly checks: readonly string[];
  readonly problems: readonly string[];
  readonly replayDigest: string;
}

const ARTIFACT_KEYS = ['approvalEvidence', 'promotionEvidence', 'evidenceReview', 'readiness', 'acceptancePacket'] as const;

const STAGE_TO_ARTIFACT: Record<string, { key: string; field: string }> = {
  APPROVAL: { key: 'approvalEvidence', field: 'evidenceDigest' },
  PROMOTION: { key: 'promotionEvidence', field: 'evidenceDigest' },
  EVIDENCE_REVIEW: { key: 'evidenceReview', field: 'reviewDigest' },
  READINESS: { key: 'readiness', field: 'checklistDigest' },
  ACCEPTANCE_SEAL: { key: 'acceptancePacket', field: 'sealDigest' },
};

export function replayFixtureBundle(candidate: unknown): BundleReplayReport {
  const problems: string[] = [];
  const checks: string[] = [];
  const bundle = asObject(candidate);

  if (bundle.report !== 'phase-230-promotion-fixture-evidence-bundle' || bundle.version !== 1) {
    return finalize(['BUNDLE_REPORT_INVALID'], []);
  }

  // Verify the bundle's own self-seal: recompute bundleDigest over the body (excluding bundleDigest).
  // Catches a tampered bundleDigest or any tampered bundle-level field.
  checks.push('bundle-self-digest');
  if (!selfDigestValid(bundle, 'bundleDigest', 'phase-230-fixture-bundle')) problems.push('BUNDLE_SELF_DIGEST_MISMATCH');

  const artifacts = asObject(bundle.artifacts);
  const reports = asObject(bundle.reports);
  const manifest = asObject(bundle.rehearsalManifest);

  const artifactBundle: Record<string, unknown> = {};
  for (const key of ARTIFACT_KEYS) {
    if (artifacts[key] === undefined) problems.push(`${upper(key)}_MISSING`);
    else artifactBundle[key] = artifacts[key];
  }

  // Stored reports must have the expected report ids.
  checkReport(reports.integrity, 'phase-230-promotion-artifact-integrity', 'INTEGRITY_REPORT_WRONG', problems);
  checkReport(reports.schema, 'phase-230-promotion-artifact-schema', 'SCHEMA_REPORT_WRONG', problems);
  checkReport(reports.matrix, 'phase-230-promotion-rehearsal-matrix', 'MATRIX_REPORT_WRONG', problems);
  checkReport(reports.handoff, 'phase-230-promotion-coordinator-handoff', 'HANDOFF_REPORT_WRONG', problems);
  checkReport(reports.dashboard, 'phase-230-promotion-acceptance-dashboard', 'DASHBOARD_REPORT_WRONG', problems);

  // Re-derive integrity + schema from the artifacts and compare to the stored digests.
  const integrity = verifyArtifactIntegrity(artifactBundle);
  checks.push('integrity');
  if (integrity.integrityDigest !== asObject(reports.integrity).integrityDigest) problems.push('INTEGRITY_REPLAY_MISMATCH');

  const schema = validateArtifactSchemas(artifactBundle);
  checks.push('schema');
  if (schema.schemaDigest !== asObject(reports.schema).schemaDigest) problems.push('SCHEMA_REPLAY_MISMATCH');

  // Re-derive handoff + dashboard from the (recomputed-correct) integrity/schema + stored matrix.
  const handoff = buildCoordinatorHandoff({ acceptancePacket: artifacts.acceptancePacket, rehearsalManifest: reports.matrix, integrityReport: integrity });
  checks.push('handoff');
  if (handoff.handoffDigest !== asObject(reports.handoff).handoffDigest) problems.push('HANDOFF_REPLAY_MISMATCH');

  const dashboard = buildAcceptanceDashboard({ matrix: reports.matrix, integrity, schema, handoff });
  checks.push('dashboard');
  if (dashboard.dashboardDigest !== asObject(reports.dashboard).dashboardDigest) problems.push('DASHBOARD_REPLAY_MISMATCH');

  // Self-seals that cannot be re-derived from artifacts: matrix and rehearsal manifest.
  checks.push('matrix-self-digest');
  if (!selfDigestValid(asObject(reports.matrix), 'matrixDigest', 'phase-230-rehearsal-matrix')) problems.push('MATRIX_SELF_DIGEST_MISMATCH');
  checks.push('manifest-self-digest');
  if (!selfDigestValid(manifest, 'manifestDigest', 'phase-230-rehearsal-manifest')) problems.push('MANIFEST_SELF_DIGEST_MISMATCH');

  // The rehearsal manifest's stage digests must match the artifact self-digests.
  checks.push('manifest-stages');
  const stages = Array.isArray(manifest.stages) ? manifest.stages : [];
  for (const stage of stages) {
    const s = asObject(stage);
    const map = STAGE_TO_ARTIFACT[typeof s.stage === 'string' ? s.stage : ''];
    if (!map) continue;
    const expected = asObject(artifacts[map.key])[map.field];
    if (s.digest !== expected) { problems.push('MANIFEST_STAGE_MISMATCH'); break; }
  }

  return finalize(problems, checks);
}

function finalize(problems: string[], checks: string[]): BundleReplayReport {
  const ok = problems.length === 0;
  const withoutDigest: Omit<BundleReplayReport, 'replayDigest'> = {
    report: 'phase-230-promotion-bundle-replay',
    version: 1,
    redactionSafe: true,
    ok,
    checks,
    problems,
  };
  return { ...withoutDigest, replayDigest: digest('phase-230-bundle-replay', JSON.stringify(withoutDigest)) };
}

function checkReport(value: unknown, expected: string, code: string, problems: string[]): void {
  if (asObject(value).report !== expected) problems.push(code);
}

function selfDigestValid(obj: Record<string, unknown>, field: string, scope: string): boolean {
  const claimed = obj[field];
  if (!isSha256(claimed)) return false;
  const without: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) if (k !== field) without[k] = obj[k];
  return digest(scope, JSON.stringify(without)) === claimed;
}

function upper(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
