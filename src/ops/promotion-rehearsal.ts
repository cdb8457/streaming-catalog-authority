import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildApprovalAttestation } from './promotion-approval.js';
import { reviewPromotionEvidence } from './promotion-evidence-review.js';
import { buildPromotionReadinessChecklist } from './promotion-readiness.js';
import { sealPromotionAcceptance } from './promotion-acceptance-seal.js';
import { canonicalPath, defaultRealMoviesRoot, runRealLibraryPromotion, type RealLibraryVisibilityClient } from './real-library-promotion.js';

// Local, non-live end-to-end rehearsal of the Phase 230 promotion pipeline. It builds an ephemeral
// fixture sandbox, then runs the real modules in order — approval attestation → guarded promotion
// (promote AND withdraw) → evidence review → readiness checklist → acceptance seal — using a local
// file-state visibility observer (never Jellyfin) against a sandbox Movies directory (never the real
// /mnt/user/media/Movies). It emits a redaction-safe manifest that digests each stage.
//
// It never runs the deploy launcher, never writes to the real Movies root, never contacts Jellyfin,
// and authorizes nothing live: a passing rehearsal proves the mechanics on fixtures, it is not a live
// gate and does not authorize Phase 231.

// Fixture-only rehearsal scenarios. Every one runs entirely on sandbox fixtures with a local observer;
// the non-success scenarios inject a deterministic fault to exercise a specific failure mode.
export type RehearsalScenario =
  | 'success'
  | 'visibility-timeout'
  | 'rejected-acceptance'
  | 'tampered-readiness'
  | 'digest-chain-mismatch';

export const REHEARSAL_SCENARIOS: readonly RehearsalScenario[] = [
  'success', 'visibility-timeout', 'rejected-acceptance', 'tampered-readiness', 'digest-chain-mismatch',
];

export interface RehearsalInput {
  readonly workDir?: string;      // base dir for the ephemeral sandbox (default: OS temp dir)
  readonly runId?: string;        // sandbox id + run digest (default: random)
  readonly itemId?: string;       // fixture catalog item id (default: random)
  readonly title?: string;        // fixture title (default: 'Rehearsal Fixture')
  readonly year?: number;         // fixture year (default: 2026)
  readonly acceptorId?: string;   // acceptance-seal acceptor (default: 'rehearsal-operator')
  readonly keepSandbox?: boolean; // keep the sandbox for inspection (default: false, ephemeral)
  readonly scenario?: RehearsalScenario; // fixture fault to inject (default: 'success')
  readonly now?: () => Date;
}

export type RehearsalStageId = 'APPROVAL' | 'PROMOTION' | 'EVIDENCE_REVIEW' | 'READINESS' | 'ACCEPTANCE_SEAL';

export interface RehearsalStage {
  readonly stage: RehearsalStageId;
  readonly ok: boolean;
  readonly status: string;
  readonly digest?: string;
}

export interface RehearsalManifest {
  readonly report: 'phase-230-promotion-rehearsal-manifest';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly mode: 'offline-fixture-rehearsal';
  readonly scenario: RehearsalScenario;
  readonly outcome: 'REHEARSAL_PASS' | 'REHEARSAL_FAIL';
  readonly runDigest: string;
  readonly itemDigest: string;
  readonly targetRoot: 'sandbox';
  readonly stages: readonly RehearsalStage[];
  readonly notes: readonly string[];
  readonly forbidden: readonly [
    'live-jellyfin',
    'real-movies-write',
    'deploy-launcher',
    'phase-231-authorization',
    'provider',
    'download',
    'playback',
  ];
  readonly manifestDigest: string;
}

// The raw stage artifacts, in memory. They may contain sandbox paths, so a caller that persists them
// should treat them as operator-local (they are NOT redaction-safe like the manifest).
export interface RehearsalArtifacts {
  approval?: unknown;
  approvalEvidence?: unknown;
  promotionEvidence?: unknown;
  evidenceReview?: unknown;
  readiness?: unknown;
  acceptancePacket?: unknown;
}

export interface RehearsalResult {
  readonly manifest: RehearsalManifest;
  readonly artifacts: RehearsalArtifacts;
}

const FORBIDDEN: RehearsalManifest['forbidden'] = [
  'live-jellyfin',
  'real-movies-write',
  'deploy-launcher',
  'phase-231-authorization',
  'provider',
  'download',
  'playback',
];

const MINIMAL_MP4_FIXTURE = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isomphase-230-rehearsal-fixture', 'ascii'),
]);

export async function runPromotionRehearsal(input: RehearsalInput = {}): Promise<RehearsalResult> {
  const runId = input.runId ?? randomUUID();
  const itemId = input.itemId ?? randomUUID();
  const title = input.title ?? 'Rehearsal Fixture';
  const year = input.year ?? 2026;
  const acceptorId = input.acceptorId ?? 'rehearsal-operator';
  const scenario = input.scenario ?? 'success';
  const now = input.now ?? (() => new Date());
  const workDir = input.workDir ?? tmpdir();
  const sandboxRoot = join(workDir, `phase-230-rehearsal-${runId}`);
  const testRoot = join(sandboxRoot, 'catalog-authority-test-library');
  const targetRoot = join(sandboxRoot, 'Movies');

  assertSandboxSafe(sandboxRoot, targetRoot);

  const stages: RehearsalStage[] = [];
  const notes: string[] = [];
  const artifacts: RehearsalArtifacts = {};

  try {
    const source = join(testRoot, 'Movies', `${title} (${year})`, 'source.mp4');
    mkdirSync(dirname(source), { recursive: true });
    mkdirSync(targetRoot, { recursive: true });
    writeFileSync(source, MINIMAL_MP4_FIXTURE);

    // 1. Approval attestation.
    const built = buildApprovalAttestation({ itemId, title, year, sourceFile: source, testLibraryRoot: testRoot, targetRoot, approvalId: `rehearsal-${runId}` });
    artifacts.approvalEvidence = built.evidence;
    stages.push({ stage: 'APPROVAL', ok: built.ok, status: built.evidence.status, digest: built.evidence.evidenceDigest });
    if (!built.ok || !built.approval) {
      notes.push('APPROVAL_FAILED');
      return finalize(runId, itemId, scenario, stages, notes, artifacts);
    }
    artifacts.approval = built.approval;

    // 2. Guarded promotion (promote AND withdraw), local file-state observer only.
    // The 'visibility-timeout' scenario uses an observer that never reports the file visible, so the
    // guarded promotion fails closed with a visibility timeout — no live Jellyfin is ever involved.
    const observer: RealLibraryVisibilityClient = scenario === 'visibility-timeout'
      ? { async findVisibleItem() { return { visible: false }; } }
      : { async findVisibleItem({ destinationPath }) { return existsSync(destinationPath) ? { visible: true, itemId: 'rehearsal-observer', matchBasis: 'path' } : { visible: false }; } };
    const report = await runRealLibraryPromotion({
      itemId, title, year, sourceFile: source, testLibraryRoot: testRoot, targetRoot,
      approval: { approved: true, ...built.approval },
      allowCustomTargetRootForTests: true,
      visibilityClient: observer,
      visibilityPolls: 2, visibilityPollMs: 0,
      withdrawAfter: true,
      runId, // deterministic promotion run digest for a fixed rehearsal runId
      now,
    });
    artifacts.promotionEvidence = report;
    const promotionClean = report.ok && report.status === 'REAL_LIBRARY_PROMOTION_WITHDRAWN' && report.realLibrary.returnedToBefore === true;
    stages.push({ stage: 'PROMOTION', ok: promotionClean, status: report.status, digest: report.evidenceDigest });
    if (!promotionClean) notes.push('PROMOTION_NOT_CLEAN');

    // 3. Evidence review (of the actual report — a well-formed FAILED report still reviews cleanly).
    const review = reviewPromotionEvidence(report);
    artifacts.evidenceReview = review;
    stages.push({ stage: 'EVIDENCE_REVIEW', ok: review.ok, status: review.status, digest: review.reviewDigest });
    if (!review.ok) notes.push('EVIDENCE_REVIEW_NOT_ACCEPTED');

    // 4. Readiness checklist. The 'digest-chain-mismatch' scenario breaks the cross-artifact chain by
    // feeding readiness a promotion evidence whose itemDigest no longer matches the approval.
    const readinessPromotionEvidence = scenario === 'digest-chain-mismatch'
      ? { ...(report as unknown as Record<string, unknown>), itemDigest: 'a'.repeat(64) }
      : report;
    const checklist = buildPromotionReadinessChecklist({ approval: built.approval, approvalEvidence: built.evidence, promotionEvidence: readinessPromotionEvidence, evidenceReview: review });
    artifacts.readiness = checklist;
    stages.push({ stage: 'READINESS', ok: checklist.verdict === 'READY', status: checklist.verdict, digest: checklist.checklistDigest });
    if (checklist.verdict !== 'READY') notes.push('READINESS_NOT_READY');

    // 5. Acceptance seal. 'tampered-readiness' mutates a bound field so the seal's checklist-digest
    // recomputation fails; 'rejected-acceptance' supplies a REJECT decision.
    const sealChecklist = scenario === 'tampered-readiness'
      ? { ...(checklist as unknown as Record<string, unknown>), itemDigest: 'b'.repeat(64) }
      : checklist;
    const decision = scenario === 'rejected-acceptance' ? 'REJECT' : 'ACCEPT';
    const packet = sealPromotionAcceptance({ readinessChecklist: sealChecklist, evidenceReview: review, approvalEvidence: built.evidence, acceptance: { acceptorId, decision, accepted: decision === 'ACCEPT' } });
    artifacts.acceptancePacket = packet;
    stages.push({ stage: 'ACCEPTANCE_SEAL', ok: packet.status === 'ACCEPTED_SEALED', status: packet.status, digest: packet.sealDigest });
    if (packet.status !== 'ACCEPTED_SEALED') notes.push('ACCEPTANCE_NOT_SEALED');
  } catch {
    notes.push('REHEARSAL_EXCEPTION');
  } finally {
    if (!input.keepSandbox) {
      try { rmSync(sandboxRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  return finalize(runId, itemId, scenario, stages, notes, artifacts);
}

function finalize(runId: string, itemId: string, scenario: RehearsalScenario, stages: RehearsalStage[], notes: string[], artifacts: RehearsalArtifacts): RehearsalResult {
  const allStagesGreen = stages.length === 5 && stages.every((s) => s.ok);
  const withoutManifestDigest: Omit<RehearsalManifest, 'manifestDigest'> = {
    report: 'phase-230-promotion-rehearsal-manifest',
    version: 1,
    redactionSafe: true,
    mode: 'offline-fixture-rehearsal',
    scenario,
    outcome: allStagesGreen ? 'REHEARSAL_PASS' : 'REHEARSAL_FAIL',
    runDigest: digest('phase-230-run', runId),
    itemDigest: digest('phase-230-item', itemId),
    targetRoot: 'sandbox',
    stages,
    notes,
    forbidden: FORBIDDEN,
  };
  // Belt-and-suspenders: the manifest is assembled from digests/enums/booleans only.
  if (hasRawPathLeak(withoutManifestDigest)) {
    const leaked = { ...withoutManifestDigest, outcome: 'REHEARSAL_FAIL' as const, notes: [...notes, 'RAW_PATH_IN_MANIFEST'] };
    return { manifest: { ...leaked, manifestDigest: digest('phase-230-rehearsal-manifest', JSON.stringify(leaked)) }, artifacts };
  }
  return { manifest: { ...withoutManifestDigest, manifestDigest: digest('phase-230-rehearsal-manifest', JSON.stringify(withoutManifestDigest)) }, artifacts };
}

// The sandbox must never be, contain, or sit inside the real Movies root — the rehearsal must not be
// able to write to /mnt/user/media/Movies under any workDir.
function assertSandboxSafe(sandboxRoot: string, targetRoot: string): void {
  const realMovies = canonicalPath(defaultRealMoviesRoot());
  for (const p of [canonicalPath(sandboxRoot), canonicalPath(targetRoot)]) {
    if (p === realMovies || p.startsWith(`${realMovies}/`) || realMovies.startsWith(`${p}/`)) {
      throw new Error('rehearsal sandbox must not intersect the real Movies root');
    }
  }
}

function hasRawPathLeak(value: unknown): boolean {
  let leak = false;
  const walk = (v: unknown): void => {
    if (leak) return;
    if (typeof v === 'string') { if (looksLikePath(v)) leak = true; return; }
    if (Array.isArray(v)) { for (const e of v) walk(e); return; }
    if (v && typeof v === 'object') { for (const val of Object.values(v as Record<string, unknown>)) walk(val); }
  };
  walk(value);
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
