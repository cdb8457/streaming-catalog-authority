import { REHEARSAL_EXIT_CODES, type GateStatus, type ReadinessCheckSummary, type RehearsalOutcome } from './release-rehearsal.js';
import { READINESS_CHECK_IDS, READINESS_TAG_CHECK_ID } from './release-readiness.js';

// Phase 252 — event-aware interpretation of the release rehearsal outcome.
//
// The rehearsal itself is honest and event-BLIND: it assembles the candidate offline and reports HANDOFF_READY,
// BLOCKED, INVALID or NOT_RUN with fixed exit codes. On a pull request (or any non-release validation event)
// the release tag intentionally does not exist yet, so the Phase 250 readiness proof legitimately returns
// NOT_RUN for its "HEAD is at the release tag" check, and the rehearsal is NOT_RUN. That is the correct offline
// answer — but on a PR it must not fail CI, and it must not be faked into HANDOFF_READY either.
//
// This module draws the line WITHOUT letting the release gate weaken:
//   * On an event that would actually publish (a release, or a deliberate version-tag dispatch — decided by the
//     SAME tested release-ref function `publish` uses), ONLY HANDOFF_READY passes. BLOCKED, INVALID and NOT_RUN
//     all fail and prevent publish. A release can never go out over anything but a green rehearsal.
//   * On a non-publishing validation event, HANDOFF_READY passes, and a NOT_RUN passes ONLY when it is caused
//     SOLELY by the intentionally absent release tag — nothing else. A NOT_RUN from missing CI acceptance
//     evidence, or from there being no Git at all, still fails; BLOCKED and INVALID always fail.
//
// It publishes nothing, holds no permission, and decides only whether the rehearsal's honest outcome should be
// read as a CI pass for THIS event.

/** The single rehearsal gate whose NOT_RUN is legitimately explained by the absent release tag: the Phase 250
 *  readiness gate. Any OTHER not-run gate means the NOT_RUN is not "solely the absent tag". */
export const TAG_DEPENDENT_READINESS_GATE = 'offline-readiness';

/** A distinct code for "the handoff packet was missing or unreadable" — the gate fails closed, never open. */
export const REHEARSAL_GATE_UNREADABLE_EXIT = 33;

/** The minimal view of the rehearsal report this gate needs. Matches the shape ops:release-rehearsal writes. */
export interface RehearsalReportView {
  readonly outcome: RehearsalOutcome;
  readonly gates: ReadonlyArray<{ readonly id: string; readonly status: GateStatus }>;
  /** candidateCommit is a binding fact for evidence-tying; it is NOT used as proof that Git was available. */
  readonly candidate: { readonly candidateCommit: string | null };
  /** The Phase 250 readiness summary (IDs + statuses). Absent on a legacy packet, which then fails closed. */
  readonly readinessSummary?: readonly ReadinessCheckSummary[];
}

/**
 * Does the readiness summary prove the readiness NOT_RUN was caused SOLELY by the absent release tag?
 *
 * True only when the summary is COMPLETE — exactly the canonical set of readiness check IDs, no duplicates, no
 * unknowns, none omitted — and every check is PASS except exactly the tag check, which is NOT_RUN. This is what
 * distinguishes an absent tag from no Git (git-clean-checkout would also be NOT_RUN), a dirty checkout (a BLOCK),
 * or any other incomplete readiness. A missing or malformed summary is never a proof, so it returns false and
 * the caller fails closed.
 */
export function readinessProvesSolelyAbsentTag(summary: readonly ReadinessCheckSummary[] | undefined): boolean {
  if (summary === undefined || summary.length === 0) return false;
  const ids = summary.map((check) => check.id);
  // No duplicates, and exactly the canonical set (no omission, no unknown ID).
  if (new Set(ids).size !== ids.length) return false;
  const canonical = new Set(READINESS_CHECK_IDS);
  if (ids.length !== canonical.size) return false;
  for (const id of ids) {
    if (!canonical.has(id)) return false;
  }
  // Every check PASS, except exactly the tag check, which must be NOT_RUN.
  for (const { id, status } of summary) {
    if (id === READINESS_TAG_CHECK_ID) {
      if (status !== 'NOT_RUN') return false;
    } else if (status !== 'PASS') {
      return false;
    }
  }
  return true;
}

export interface RehearsalGateContext {
  /** Whether this event would actually reach publish — computed from the SAME decision `publish` itself uses. */
  readonly publishReaching: boolean;
}

export interface RehearsalGateDecision {
  readonly pass: boolean;
  /** 0 on pass; the underlying rehearsal exit code (30/31/32) on a fail, so the diagnostic is preserved. */
  readonly code: number;
  readonly reason: string;
}

/**
 * Decide whether a rehearsal report should be read as a CI pass for the given event.
 *
 * Pure and total: it never throws and never reads the environment. The caller supplies `publishReaching`
 * (from `decideRelease().publish`) so the interpretation and the real publish gate can never disagree.
 */
export function interpretRehearsalGate(report: RehearsalReportView, context: RehearsalGateContext): RehearsalGateDecision {
  const { outcome } = report;

  if (context.publishReaching) {
    // A release, or a deliberate version-tag dispatch that would publish: ONLY a green rehearsal passes.
    if (outcome === 'HANDOFF_READY') {
      return { pass: true, code: 0, reason: 'HANDOFF_READY on a publish-reaching event' };
    }
    return {
      pass: false,
      code: REHEARSAL_EXIT_CODES[outcome],
      reason: `a publish-reaching event requires HANDOFF_READY, but the rehearsal outcome is ${outcome}`,
    };
  }

  // A non-publishing validation event (pull_request, push, or a dispatch that does not ask to publish).
  if (outcome === 'HANDOFF_READY') {
    return { pass: true, code: 0, reason: 'HANDOFF_READY on a non-publishing validation event' };
  }
  if (outcome === 'BLOCKED' || outcome === 'INVALID') {
    // A real problem the rehearsal found. It fails on every event, publishing or not.
    return {
      pass: false,
      code: REHEARSAL_EXIT_CODES[outcome],
      reason: `${outcome} is a real problem and fails on any event`,
    };
  }

  // outcome === 'NOT_RUN'. Acceptable here ONLY when the sole cause is the intentionally absent release tag.
  //
  // Two independent facts must agree, and neither is `candidateCommit` — which is always supplied as github.sha
  // and therefore proves nothing about whether Git was available:
  //   1. Among the OUTER rehearsal gates, the only NOT_RUN is `offline-readiness` (so it is not, say, a missing
  //      CI-acceptance reference that is NOT_RUN), and nothing is BLOCK/INVALID.
  //   2. The COMPLETE Phase 250 readiness summary proves every readiness check is PASS except exactly the
  //      tag check, which is NOT_RUN — distinguishing an absent tag from no Git, a dirty checkout, or any other
  //      incomplete readiness. A missing/malformed/incomplete summary fails this, so a legacy packet fails closed.
  const notRunGateIds = report.gates.filter((gate) => gate.status === 'NOT_RUN').map((gate) => gate.id);
  const hasBlockingGate = report.gates.some((gate) => gate.status === 'BLOCK' || gate.status === 'INVALID');
  const outerGatesPointAtReadinessOnly =
    !hasBlockingGate && notRunGateIds.length === 1 && notRunGateIds[0] === TAG_DEPENDENT_READINESS_GATE;
  const readinessProven = readinessProvesSolelyAbsentTag(report.readinessSummary);

  if (outerGatesPointAtReadinessOnly && readinessProven) {
    return {
      pass: true,
      code: 0,
      reason: 'NOT_RUN caused solely by the intentionally absent release tag on a non-publishing validation event',
    };
  }
  return {
    pass: false,
    code: REHEARSAL_EXIT_CODES.NOT_RUN,
    reason: `NOT_RUN is not solely the absent release tag (not-run gates: ${notRunGateIds.join(', ') || 'none'}; `
      + `readiness summary ${readinessProven ? 'proves the tag alone' : 'does not prove every other readiness check passed'})`,
  };
}
