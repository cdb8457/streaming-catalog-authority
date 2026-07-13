# Phase 199: O5 Final Disposition - Formal Deferral

Report id: `phase-199-o5-final-disposition`

Disposition date: `2026-07-13`

Phase type: artifact and test work only. This phase makes no runtime, Docker Compose, custody-mode,
sidecar service, managed KEK, provider, playback, download, or media-server changes.

## Final Status

| Gate | Status | Basis |
| --- | --- | --- |
| O4 | `O4_CLOSED` | Context only: Phase 198 closed O4 at commit `a3681d3` / tag `phase-198`. |
| O5 | `O5_DEFERRED_ACCEPTED` | Owner decision to launch with a visible managed KEK custody/scheduling warning and explicit reopening criteria. |

Launch warning: `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`

This is an explicit disposition, not a lingering open state. O5 is not closed, and this record does
not authorize any claim of `O5_CLOSED`.

## O5 Scope

O5 covers the production managed KEK custody and scheduling gate. In launch terms, it includes:

- managed custody for KEK material outside ordinary app/operator runtime handling;
- an accepted KEK rotation cadence and automation/scheduling boundary;
- recovery and handoff procedures for current and previous KEK material during rewrap windows;
- redaction-safe evidence that KEK custody, backup media, and operator recovery paths remain
  independent;
- incident handling criteria for suspected KEK compromise or custody-path failure.

The following are not in place at launch:

- no managed KEK custody service has been accepted as O5 closure evidence;
- no repository-owned automated KEK rotation scheduler is enabled;
- no incident-driven automated KEK rotation path is installed;
- no O5 closure record supersedes this deferral.

Historical Phase 117 through Phase 119 O5 authorization tools remain redaction-safe preflight
machinery. They do not override this Phase 199 final disposition.

## Current Launch Posture

The system is running under sidecar custody from the Phase 197 production switch retry. Under that
posture, the app and ops containers use the sidecar custody path and do not need app-side file-mode
KEK handling. O4 closure confirms the sidecar custody path, local-socket exposure boundary, and
restart-persistence evidence chain.

That sidecar posture does not close O5. Current KEK handling remains operator-managed rather than
managed-and-scheduled. The existing non-mutating `ops:rewrap-kek -- --plan --json` path can support
manual review before rotation work, and backup/recovery docs continue to require independent custody
for KEK-related recovery material. Those mitigations are accepted for launch, but they are not O5
closure evidence.

## Accepted Residual Risks

| Risk | Severity | Accepted mitigation today |
| --- | --- | --- |
| No automated KEK rotation cadence. | Medium | Operator-owned rotation review using `ops:rewrap-kek -- --plan --json`; schedule tracked outside the repo until O5 reopens. |
| Manual recovery burden for KEK-related incidents. | Medium | Release checklist requires independent recovery media and redaction-safe evidence capture before launch decisions. |
| Single-custodian exposure window if sidecar custody is impaired. | Medium | O4 socket-only sidecar posture remains monitored; suspected custody incidents trigger O5 reopening. |
| Human process drift around KEK custody review. | Medium | Launch warning is propagated to README, release checklist, and operator dashboard examples. |
| Delayed O5 closure after launch. | Medium | Time-based reopening criterion forces a new O5 review if the deferral ages out. |

## Reopening Criteria

O5 must be reopened if any of these occur:

- suspected KEK compromise or unauthorized access to KEK-related recovery material;
- sidecar custody incident, socket permission drift with custody impact, or unexplained custody-path
  failure;
- migration beyond single-owner self-hosted operation into multi-user, shared, or production-scale
  operation;
- enabling provider live mode, download orchestration, playback orchestration, or media-server
  mutation that materially increases custody risk;
- 90 days have elapsed since this disposition without a reviewed O5 custody/scheduling update.

## Decision Provenance

The owner accepted O5 deferral on `2026-07-13` with O4 already closed by
`docs/PHASE_198_O4_FINAL_CLOSURE_DISPOSITION.md` at commit `a3681d3` / tag `phase-198`.

This disposition is launch-facing. Launch or release decisions must surface
`LAUNCH_WARNING_O5_DEFERRED_ACCEPTED` and must not represent O5 as closed.

## Verification

- O4 remains `O4_CLOSED`; this phase does not edit O4 closure evidence.
- O5 final disposition is `O5_DEFERRED_ACCEPTED`.
- O5 closure is not claimed; `O5_CLOSED` remains forbidden without a future closure record.
- The launch warning is propagated to README, the release checklist, and operator dashboard examples.
- Phase 200 launch/readiness review is unblocked with O4 closed and O5 deferred-accepted.
