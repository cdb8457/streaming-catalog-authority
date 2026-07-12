# Phase 195 - Production Custody Switch Attempt

Report id: `phase-195-production-custody-switch`

Phase 195 was attempted against the Phase 193 runbook and concluded as
`attempted-with-rollback`. Production custody is not switched. The app is back on
`CUSTODIAN_MODE=file`.

## Result

Final state: `attempted-with-rollback`

Rollback trigger: `post_switch_doctor_failed`

Finding: the retained post-switch doctor output later parsed as `ok:true`; the rollback trigger came
from the cutover script's evidence parser, not from a confirmed doctor failure. The rollback was
already executed, so this phase is not silently retried.

Runbook deviations: `none-intended`; rollback followed the Phase 193 trigger path.

## Preconditions

Preconditions passed before the switch was attempted:

- Phase 194 sidecar healthy and idle.
- Sidecar socket exists with restrictive permissions.
- Sidecar has no public exposure.
- App and Postgres healthy.
- Runtime was still on `CUSTODIAN_MODE=file`.
- Clean pre-cutover evidence snapshot captured.
- Fresh custody-state backup captured and verified readable/restorable.

## Evidence Identifiers

- Precondition evidence id: `phase-195-precondition-evidence`
- Precondition evidence digest: `sha256:a31f7e3bbf8fe1d7125336c337ef864f07400629576452d63db669f9a68fc5aa`
- Pre-cutover evidence snapshot id: `phase-195-pre-cutover-evidence-snapshot`
- Pre-cutover evidence digest: `sha256:9ac43d78e3a45814c7346113ad509756cf225208370632be4a4e29c55ac083de`
- Custody-state backup verified id: `phase-195-custody-state-backup-verified`
- Custody-state backup digest: `sha256:32d6896125b93c2c70dd87c77f04e79205d7a54dd9ab37ea0a722248156e2f8d`
- App stop evidence id: `phase-195-app-stop-evidence`
- Runtime diff evidence id: `phase-195-runtime-diff-evidence`
- App sidecar start evidence id: `phase-195-app-sidecar-start-evidence`
- Attempted rollback evidence id: `phase-195-attempted-rollback-evidence`
- Attempted rollback evidence digest: `sha256:12652633758ac72ce36e439aab29eee852c1d3060ff8639feea0452fd85ba001`
- Post-rollback verification id: `phase-195-post-rollback-verification`
- Post-rollback verification digest: `sha256:5c0bced8b0c1288293e43e00ef4f15d6ce3b584909630748027fb812583b6d23`

## Verification Matrix

| Checkpoint | Result | Notes |
|---|---|---|
| Pre-cutover readiness | `pass` | Evidence and backup captured before runtime switch |
| App stopped while sidecar/Postgres stayed healthy | `pass` | Runbook step completed |
| Runtime diff applied | `pass-then-rolled-back` | Sidecar-mode compose was applied during attempt |
| App started in sidecar mode | `pass-then-rolled-back` | App reached healthy before rollback trigger |
| Post-switch doctor | `parser-triggered-rollback` | Stored doctor output later parsed as `ok:true` |
| Rollback to file mode | `pass` | App returned to `CUSTODIAN_MODE=file` |
| Post-rollback app/Postgres/sidecar health | `pass` | All healthy |
| Post-rollback UI live check | `pass` | `ok:true` after steady-state verification |

## Final Status

O4 status after this attempt: `open/deferred`

O5 status after this attempt: `open/deferred`

Phase 195 exit criteria are not met. Production is not on sidecar custody. A future retry must be a
new explicit attempt with the evidence parser fixed before cutover.
