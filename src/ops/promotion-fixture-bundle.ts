import { createHash } from 'node:crypto';
import { runPromotionRehearsal, type RehearsalInput } from './promotion-rehearsal.js';
import { runRehearsalMatrix } from './promotion-rehearsal-matrix.js';
import { verifyArtifactIntegrity } from './promotion-artifact-integrity.js';
import { validateArtifactSchemas } from './promotion-artifact-schema.js';
import { buildCoordinatorHandoff } from './promotion-handoff.js';
import { buildAcceptanceDashboard } from './promotion-dashboard.js';
import { ALLOWED_MEDIA_EXTENSIONS } from './real-library-promotion.js';

// Local, non-live fixture evidence bundle generator. It runs one successful offline rehearsal and
// assembles a single redaction-safe, deterministic bundle carrying every derived artifact and report:
// approval evidence, promotion evidence, review, readiness, acceptance, plus integrity, schema, matrix,
// handoff, and dashboard reports. It reads/writes local JSON only; it performs no promotion, never
// touches the real Movies root, never contacts Jellyfin, and authorizes nothing live (no Phase 231).

export interface FixtureBundleInput {
  readonly workDir?: string;
  readonly runId?: string;
  readonly acceptorId?: string;
  readonly now?: () => Date;
}

export interface FixtureEvidenceBundle {
  readonly report: 'phase-230-promotion-fixture-evidence-bundle';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly mode: 'offline-fixture';
  readonly authorization: 'NONE';
  readonly outcome: 'BUNDLE_READY' | 'BUNDLE_INCOMPLETE';
  readonly rehearsalManifest: unknown;
  readonly artifacts: {
    readonly approvalEvidence: unknown;
    readonly promotionEvidence: unknown;
    readonly evidenceReview: unknown;
    readonly readiness: unknown;
    readonly acceptancePacket: unknown;
  };
  readonly reports: {
    readonly integrity: unknown;
    readonly schema: unknown;
    readonly matrix: unknown;
    readonly handoff: unknown;
    readonly dashboard: unknown;
  };
  readonly notes: readonly string[];
  readonly bundleDigest: string;
}

export async function buildFixtureEvidenceBundle(input: FixtureBundleInput = {}): Promise<FixtureEvidenceBundle> {
  const runId = input.runId ?? 'fixture-bundle';
  const acceptorId = input.acceptorId ?? 'rehearsal-operator';
  const now = input.now;
  const base: RehearsalInput = {
    ...(input.workDir !== undefined ? { workDir: input.workDir } : {}),
    ...(now !== undefined ? { now } : {}),
    runId, itemId: `fixture-item-${runId}`, acceptorId, scenario: 'success',
  };

  const { manifest, artifacts } = await runPromotionRehearsal(base);
  const artifactBundle = {
    approvalEvidence: artifacts.approvalEvidence,
    promotionEvidence: artifacts.promotionEvidence,
    evidenceReview: artifacts.evidenceReview,
    readiness: artifacts.readiness,
    acceptancePacket: artifacts.acceptancePacket,
  };

  const integrity = verifyArtifactIntegrity(artifactBundle);
  const schema = validateArtifactSchemas(artifactBundle);
  const matrix = await runRehearsalMatrix({
    ...(input.workDir !== undefined ? { workDir: `${input.workDir}/matrix` } : {}),
    ...(now !== undefined ? { now } : {}),
    runId: `${runId}-matrix`, acceptorId,
  });
  const handoff = buildCoordinatorHandoff({ acceptancePacket: artifacts.acceptancePacket, rehearsalManifest: matrix, integrityReport: integrity });
  const dashboard = buildAcceptanceDashboard({ matrix, integrity, schema, handoff });

  const notes: string[] = [];
  const green = (manifest as { outcome?: unknown }).outcome === 'REHEARSAL_PASS'
    && (integrity as { ok?: unknown }).ok === true
    && (schema as { ok?: unknown }).ok === true
    && (handoff as { handoffState?: unknown }).handoffState === 'READY_FOR_COORDINATOR'
    && (dashboard as { overall?: unknown }).overall === 'DASHBOARD_READY';
  if (!green) notes.push('BUNDLE_NOT_ALL_GREEN');

  const body: Omit<FixtureEvidenceBundle, 'bundleDigest'> = {
    report: 'phase-230-promotion-fixture-evidence-bundle',
    version: 1,
    redactionSafe: true,
    mode: 'offline-fixture',
    authorization: 'NONE',
    outcome: green ? 'BUNDLE_READY' : 'BUNDLE_INCOMPLETE',
    rehearsalManifest: manifest,
    artifacts: artifactBundle,
    reports: { integrity, schema, matrix, handoff, dashboard },
    notes,
  };

  if (hasRawPathLeak(body)) {
    const leaked = { ...body, outcome: 'BUNDLE_INCOMPLETE' as const, notes: [...notes, 'RAW_PATH_IN_BUNDLE'] };
    return { ...leaked, bundleDigest: digest('phase-230-fixture-bundle', JSON.stringify(leaked)) };
  }
  return { ...body, bundleDigest: digest('phase-230-fixture-bundle', JSON.stringify(body)) };
}

function hasRawPathLeak(value: unknown): boolean {
  let leak = false;
  const walk = (v: unknown, key: string | undefined): void => {
    if (leak) return;
    if (typeof v === 'string') {
      if (key === 'disclaimers' || key === 'targetRoot') return; // fixed language / enum values
      if (key === 'extension' && (ALLOWED_MEDIA_EXTENSIONS as readonly string[]).includes(v)) return; // safe media enum
      if (looksLikePath(v)) leak = true;
      return;
    }
    if (Array.isArray(v)) { for (const e of v) walk(e, key); return; }
    if (v && typeof v === 'object') { for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(val, k); }
  };
  walk(value, undefined);
  return leak;
}

function looksLikePath(s: string): boolean {
  return s.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(s)
    || s.includes('/mnt/')
    || s.includes('\\mnt\\')
    || s.includes('catalog-authority-test-library')
    || /\.(mkv|mp4|m4v|avi|mov|webm)$/i.test(s);
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
