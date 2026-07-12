# Phase 193 - Runtime Cutover Plan

Report id: `phase-193-runtime-cutover-plan`

Phase 193 defines the reviewed production cutover procedure from `CUSTODIAN_MODE=file` to
`CUSTODIAN_MODE=sidecar`. This is a plan-only phase. It does not edit
`docker-compose.unraid.runtime.yml`, does not install or start the sidecar service, does not change
runtime custody mode, does not contact providers, does not perform playback, does not mutate media
servers, does not close O4, and does not close O5.

This plan satisfies the Phase 193 criterion in the Phase 192 O4 sidecar closure-readiness gate. It
does not satisfy Phase 194 or Phase 195.

## Preconditions

All preconditions must be true before a future operator may execute this plan:

- Phase 192 readiness gate is present with verdict `O4_READY_PENDING_EXECUTION`.
- Phase 191 source acceptance record exists at commit `7990ac2` / tag `phase-191`.
- Phase 189 evidence digest: `sha256:a3b1c61af28ac37b8e24ed7cfb941eb128a119a201036263e4ac2e7daee1fe8a`.
- Phase 190 review digest: `sha256:f75d46172af9ff3c1a1c452dad4a1914958908e6a2210871510c017d6fdea0f2`.
- Phase 194 sidecar service install evidence exists, is reviewed, and reports local socket only,
  no public ports, healthy service status, and rollback readiness.
- A clean pre-cutover evidence snapshot has been captured by report ID and digest only.
- A fresh backup of custody-relevant state has been captured and verified by report ID and digest
  only. Required state classes are database backup, file-custodian keystore snapshot, sidecar state snapshot, and runtime compose snapshot.
- Current runtime still reports `CUSTODIAN_MODE=file`.
- O4 status is `open/deferred`.
- O5 status is `open/deferred`.

## Exact Runtime Diff

The future Phase 195 change applies to both the `ops` and `app` services in
`docker-compose.unraid.runtime.yml`.

Before:

```yaml
environment:
  CUSTODIAN_MODE: file
  COMPLETION_SECRET_FILE: /run/secrets/completion_secret
  CUSTODIAN_KEYSTORE_DIR: /var/lib/catalog/keystore
  CUSTODIAN_KEK_FILE: /run/secrets/custodian_kek
volumes:
  - ${CATALOG_AUTHORITY_APPDATA_DIR:-<canonical-appdata>}/keystore:/var/lib/catalog/keystore
secrets:
  - completion_secret
  - custodian_kek
```

After:

```yaml
environment:
  CUSTODIAN_MODE: sidecar
  CUSTODIAN_SIDECAR_SOCKET_PATH: /run/catalog-sidecar/catalog-sidecar.sock
volumes:
  - ${CATALOG_AUTHORITY_APPDATA_DIR:-<canonical-appdata>}/sidecar/run:/run/catalog-sidecar
secrets:
  # completion_secret and custodian_kek are not mounted into app/ops in sidecar mode.
```

The database URL secrets and operator UI token secret remain unchanged. The `postgres` service
remains unchanged. The operator UI host port remains unchanged. No sidecar port is published.

## Cutover Sequence

1. Pre-check Phase 192: confirm `phase-192-o4-sidecar-closure-readiness` reports
   `O4_READY_PENDING_EXECUTION`.
2. Pre-check Phase 194: confirm the sidecar service is installed, healthy, local socket only, and
   exposes no public ports.
3. Capture pre-cutover evidence: record report IDs and digests for current `ops:doctor --json`,
   `ui-live-check`, runtime compose snapshot, file-custodian keystore snapshot, sidecar state
   snapshot, and verified backup.
4. Stop app only: stop the `app` service while leaving `postgres` and the sidecar service running.
   Expected signal: `postgres` healthy, sidecar healthy, `app` stopped by operator action.
5. Apply the runtime diff from this document to `ops` and `app`.
6. Restart app: recreate `app` with sidecar mode.
   Expected signal: app starts, no missing `CUSTODIAN_SIDECAR_SOCKET_PATH` error, no network endpoint
   error, and healthcheck moves to healthy.
7. Run post-switch evidence: capture `ops:doctor --json`, `ui-live-check`, sidecar status evidence,
   and a redaction-safe custody smoke evidence report by ID/digest only.
8. Run persistence-check restart: restart app, confirm it returns healthy, then restart sidecar by
   the Phase 194 service procedure and confirm app returns healthy again.
9. Confirm UI/API health: `ui-live-check` must return `ok:true`, authenticated status must pass,
   authenticated logs must remain redacted, and forbidden runtime/provider/playback checks must
   remain absent.
10. Record Phase 195 post-switch evidence. O4 still remains open until separate final authorization.

## Verification Matrix

| Checkpoint | Healthy Means | Command Or Evidence |
|---|---|---|
| Pre-cutover readiness | Phase 192 verdict is `O4_READY_PENDING_EXECUTION` and O4/O5 are open/deferred | `test:o4-sidecar-closure-readiness`, Phase 192 doc |
| Sidecar service | Installed service healthy, local socket only, no public ports | Phase 194 install evidence ID/digest |
| Backup and snapshots | Verified database backup plus file keystore, sidecar state, and compose snapshot digests retained | Backup/snapshot report IDs and digests |
| App stopped | Only `app` is stopped; `postgres` and sidecar remain healthy | `docker compose ps` plus sidecar status evidence |
| App recreated | App starts with `CUSTODIAN_MODE=sidecar` and socket path configured | `docker compose ps`, app logs redacted summary |
| Operator UI | Health endpoint OK; auth rejection works; authenticated status/logs pass | `deploy/unraid-ops-launcher.sh ui-live-check` |
| Persistence restart | App and sidecar restart sequence returns to healthy | Phase 195 restart persistence evidence |
| Post-switch custody | Sidecar custody path works and file-custodian app-held KEK path is no longer used by app/ops | Phase 195 post-switch custody evidence |

## Rollback

Rollback direction: `CUSTODIAN_MODE=sidecar` back to `CUSTODIAN_MODE=file`.

Reverse procedure:

1. Stop `app`.
2. Revert the runtime diff: set `CUSTODIAN_MODE: file`, restore
   `COMPLETION_SECRET_FILE`, `CUSTODIAN_KEYSTORE_DIR`, `CUSTODIAN_KEK_FILE`, restore the keystore
   mount, and restore `completion_secret` and `custodian_kek` secret mounts for `ops` and `app`.
3. Recreate `app`.
4. Run `ops:doctor --json`.
5. Run `ui-live-check`.
6. Capture post-rollback evidence by report ID and digest only.

Rollback triggers:

- Phase 194 sidecar service is not healthy before cutover: abort before any runtime edit.
- Runtime diff cannot be applied cleanly: abort before restart.
- App fails to start because the sidecar socket is missing or invalid: rollback immediately.
- App starts but healthcheck does not become healthy: retry once after checking sidecar service
  health; rollback if the second start fails.
- `ui-live-check` returns `ok:false`: rollback unless the failure is an unrelated operator token
  issue verified by pre-cutover evidence.
- Post-switch custody smoke evidence fails: rollback immediately.
- Restart persistence check fails: rollback immediately.

Data-safety notes:

- Rollback must not delete sidecar state.
- Rollback must not delete file-custodian keystore state.
- Rollback must not rewrite or fork item custody records.
- Rollback restores the app/ops custody client only; it does not migrate or mutate catalog data.
- If any write occurred during the failed sidecar window, preserve all sidecar state and file
  keystore state for reconciliation review before retrying.

## Abort Points

Safe abort points:

- Before Phase 194 service evidence is accepted.
- Before the pre-cutover backup and snapshots are captured.
- Before stopping `app`.
- After stopping `app` but before editing runtime compose: restart app with existing file mode.
- After editing runtime compose but before app starts: revert the diff and start app in file mode.

Not-safe-to-ignore points:

- After app starts in sidecar mode and any custody write might have occurred, do not discard sidecar
  state or file keystore state.
- After post-switch evidence starts, failures must become rollback evidence or retry evidence.
- After persistence restart begins, operator must either finish verification or roll back and retain
  evidence.

## O4/O5 Status

O4 status after this phase: `open/deferred`

O5 status after this phase: `open/deferred`

This plan satisfies the Phase 193 criterion in the Phase 192 gate. It does not close O4, does not
close O5, and does not authorize production custody switch execution.

## Review Status

Recommended next status: `ready-for-phase-194-sidecar-service-install`.

Phase 194 is now unblocked. Phase 195 remains blocked until Phase 194 evidence exists.
