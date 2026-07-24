import { REHEARSAL_EXIT_CODES, type GateStatus, type RehearsalOutcome } from './release-rehearsal.js';

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
  readonly candidate: { readonly candidateCommit: string | null };
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
  const notRunGateIds = report.gates.filter((gate) => gate.status === 'NOT_RUN').map((gate) => gate.id);
  const hasBlockingGate = report.gates.some((gate) => gate.status === 'BLOCK' || gate.status === 'INVALID');
  const solelyAbsentTag =
    !hasBlockingGate
    && notRunGateIds.length === 1
    && notRunGateIds[0] === TAG_DEPENDENT_READINESS_GATE
    // Git WAS available (the candidate commit is known), so the readiness NOT_RUN is the absent tag, not "no Git".
    && report.candidate.candidateCommit !== null;

  if (solelyAbsentTag) {
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
      + `candidate commit ${report.candidate.candidateCommit === null ? 'absent' : 'present'})`,
  };
}
