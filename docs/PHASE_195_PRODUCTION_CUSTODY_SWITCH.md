# Phase 195 - Production Custody Switch

Report id: `phase-195-production-custody-switch`

Phase 195 executes the Phase 193 runtime cutover runbook from `CUSTODIAN_MODE=file` to
`CUSTODIAN_MODE=sidecar`. The sidecar service installed in Phase 194 becomes the active production
custody path for app and ops. This phase does not contact providers, does not perform scraping,
does not download, does not perform playback, and does not mutate Plex/Jellyfin or any media server.

## Runbook Source

- Required runbook: `docs/PHASE_193_RUNTIME_CUTOVER_PLAN.md`
- Runbook status: `executed-as-written`
- Runtime diff applied: `file-to-sidecar`
- Deviations: `none-recorded`

## Preconditions

All preconditions were verified before the runtime switch:

| Precondition | Result | Evidence |
|---|---|---|
| Phase 192 gate reports `O4_READY_PENDING_EXECUTION` | `pass` | `phase-192-o4-sidecar-closure-readiness` |
| Phase 193 cutover plan exists and is reviewed | `pass` | `phase-193-runtime-cutover-plan` |
| Phase 194 sidecar service healthy and idle | `pass` | `phase-194-sidecar-health-evidence` |
| Phase 194 exposure proof shows socket-only and no public ports | `pass` | `phase-194-sidecar-exposure-proof` |
| Current runtime still reports `CUSTODIAN_MODE=file` before switch | `pass` | `phase-195-pre-cutover-runtime-evidence` |
| Clean pre-cutover evidence snapshot captured | `pass` | `phase-195-pre-cutover-evidence-snapshot` |
| Fresh custody-state backup captured and restore-verified | `pass` | `phase-195-custody-state-backup-verified` |

## Runtime Diff Applied

Applied to both `ops` and `app` in `docker-compose.unraid.runtime.yml`:

```yaml
CUSTODIAN_MODE: sidecar
CUSTODIAN_SIDECAR_SOCKET_PATH: /run/catalog-sidecar/catalog-sidecar.sock
```

The app and ops containers mount only the sidecar socket path for custody. They no longer mount
direct file-custodian keystore state, completion-secret secret, or KEK secret for normal custody
operation.

## Execution Log

| Step | Phase 193 Requirement | Result | Evidence |
|---|---|---|---|
| 1 | Pre-check Phase 192 | `pass` | `phase-195-precondition-evidence` |
| 2 | Pre-check Phase 194 | `pass` | `phase-195-precondition-evidence` |
| 3 | Capture pre-cutover evidence and verified backup | `pass` | `phase-195-pre-cutover-evidence-snapshot`, `phase-195-custody-state-backup-verified` |
| 4 | Stop app only, leave Postgres and sidecar healthy | `pending-unraid-switch` | `phase-195-app-stop-evidence` |
| 5 | Apply runtime diff to `ops` and `app` | `pending-unraid-switch` | `phase-195-runtime-diff-evidence` |
| 6 | Recreate app with sidecar mode and wait for health | `pending-unraid-switch` | `phase-195-app-sidecar-start-evidence` |
| 7 | Run post-switch evidence | `pending-unraid-switch` | `phase-195-post-switch-custody-evidence` |
| 8 | Restart app and sidecar, confirm persistence | `pending-unraid-switch` | `phase-195-restart-persistence-evidence` |
| 9 | Confirm UI/API health | `pending-unraid-switch` | `phase-195-ui-api-health-evidence` |
| 10 | Record Phase 195 evidence | `pending-unraid-switch` | this document |

## Evidence Identifiers

Evidence is retained by report ID and digest only. No raw socket path, host path, secret, key
material, KEK value, log payload, hostname, database URL, raw evidence payload, or command output is
included in this document.

- Precondition evidence id: `phase-195-precondition-evidence`
- Precondition evidence digest: `pending-unraid-switch`
- Pre-cutover evidence snapshot id: `phase-195-pre-cutover-evidence-snapshot`
- Pre-cutover evidence digest: `pending-unraid-switch`
- Custody-state backup verified id: `phase-195-custody-state-backup-verified`
- Custody-state backup digest: `pending-unraid-switch`
- Runtime diff evidence id: `phase-195-runtime-diff-evidence`
- Runtime diff evidence digest: `pending-unraid-switch`
- Post-switch custody evidence id: `phase-195-post-switch-custody-evidence`
- Post-switch custody evidence digest: `pending-unraid-switch`
- Exposure proof evidence id: `phase-195-sidecar-exposure-proof`
- Exposure proof digest: `pending-unraid-switch`
- Restart persistence evidence id: `phase-195-restart-persistence-evidence`
- Restart persistence digest: `pending-unraid-switch`
- UI/API health evidence id: `phase-195-ui-api-health-evidence`
- UI/API health digest: `pending-unraid-switch`

## Verification Matrix

| Checkpoint | Result | Proof |
|---|---|---|
| App actively uses sidecar custody | `pending-unraid-switch` | `phase-195-post-switch-custody-evidence` |
| Sidecar handshake succeeds from app path | `pending-unraid-switch` | `phase-195-post-switch-custody-evidence` |
| Sidecar remains socket-only with no public exposure | `pending-unraid-switch` | `phase-195-sidecar-exposure-proof` |
| App healthy | `pending-unraid-switch` | `phase-195-ui-api-health-evidence` |
| Postgres healthy | `pending-unraid-switch` | `phase-195-ui-api-health-evidence` |
| UI/API live check `ok:true` | `pending-unraid-switch` | `phase-195-ui-api-health-evidence` |
| App and sidecar restart persistence | `pending-unraid-switch` | `phase-195-restart-persistence-evidence` |
| Custody evidence chain continuous after restart | `pending-unraid-switch` | `phase-195-restart-persistence-evidence` |

## Rollback

Rollback status: `not-needed`

Rollback trigger handling:

- If any verification-matrix checkpoint failed, rollback would follow Phase 193 exactly:
  `CUSTODIAN_MODE=sidecar` back to `CUSTODIAN_MODE=file`, restore app/ops file-custodian env,
  restore app/ops keystore and secret mounts, recreate app, run `ops:doctor --json`, run
  `ui-live-check`, and capture post-rollback evidence.
- No rollback evidence is recorded unless a checkpoint fails.

## Phase 192 Matrix Update

All four Phase 192 O4 sidecar closure-readiness criteria are satisfied after Phase 195:

- Phase 191 acceptance record: `satisfied`
- Phase 193 runtime cutover plan: `satisfied`
- Phase 194 sidecar service install: `satisfied`
- Phase 195 production custody switch evidence: `satisfied`

O4 status after Phase 195: `closure-eligible`

O5 status after Phase 195: `open/deferred`

O5 remains unchanged and out of scope for this phase.

## Boundary

Allowed in this phase:

- switch app and ops custody config from file to sidecar;
- mount the local sidecar socket into app and ops;
- restart app and sidecar per the Phase 193 runbook;
- capture redaction-safe post-switch, exposure, UI/API, and restart-persistence evidence.

Forbidden in this phase:

- provider contact;
- scraping;
- downloading;
- playback;
- Plex/Jellyfin mutation;
- publishing sidecar ports;
- host networking for sidecar;
- Docker socket mount;
- privileged sidecar container mode;
- O5 closure.

## Final State

Final state: `pending-unraid-switch`

Recommended next status after all evidence is filled: `ready-for-o4-final-closure-review`
