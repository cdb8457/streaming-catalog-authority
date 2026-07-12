# Phase 194 - Unraid Sidecar Service Install

Report id: `phase-194-unraid-sidecar-service-install`

Phase 194 installs the long-running sidecar custodian service on Unraid while keeping the application
runtime on `CUSTODIAN_MODE=file`. This is additive only. The sidecar runs idle alongside the current
app and `ops` containers. This phase does not switch custody, does not change app/ops custody mode,
does not close O4, and does not close O5.

## Service Definition

Service name: `sidecar`

Runtime stack: `docker-compose.unraid.runtime.yml`

Image source: `${CATALOG_AUTHORITY_OPS_IMAGE:-repo-ops:latest}` built from the Phase 194 source tree.

Pinned build source: `phase-194` tag after this phase is committed.

Command:

```yaml
entrypoint: ["npm", "run"]
command: ["ops:sidecar-daemon", "--", "--serve"]
```

Environment:

```yaml
SIDECAR_SOCKET_PATH: /run/catalog-sidecar/catalog-sidecar.sock
SIDECAR_STATE_DIR: /var/lib/catalog-sidecar/state
SIDECAR_COMPLETION_SECRET_FILE: /run/secrets/completion_secret
SIDECAR_KEK_FILE: /run/secrets/custodian_kek
```

Mounts:

```yaml
- ${CATALOG_AUTHORITY_APPDATA_DIR:-<canonical-appdata>}/sidecar/run:/run/catalog-sidecar
- ${CATALOG_AUTHORITY_APPDATA_DIR:-<canonical-appdata>}/sidecar/state:/var/lib/catalog-sidecar/state
```

Health check:

```yaml
test: ["CMD-SHELL", "test -S /run/catalog-sidecar/catalog-sidecar.sock"]
```

Least privilege:

- no published ports;
- no `network_mode: host`;
- no `privileged: true`;
- no Docker socket mount;
- `read_only: true`;
- `tmpfs: /tmp`;
- `cap_drop: [ALL]`;
- `security_opt: no-new-privileges:true`;
- `pids_limit: 128`;
- `mem_limit: 256m`;
- only completion-secret and KEK secrets are mounted into the sidecar service.

## Install Record

Install state: `installed-and-idle`

App custody mode after install: `file`

Ops custody mode after install: `file`

Sidecar custody mode: `local-filecustodian-reference-harness`

Socket exposure: `local-unix-socket-only`

Public exposure: `none`

O4 status after install: `open/deferred`

O5 status after install: `open/deferred`

## Evidence Identifiers

Evidence is retained by report ID and digest only. No raw socket path, host path, secret, key
material, KEK value, log payload, hostname, database URL, or command output is included in this
document.

- Install evidence report id: `phase-194-sidecar-install-evidence`
- Install evidence digest: `pending-unraid-install`
- Service health evidence id: `phase-194-sidecar-health-evidence`
- Service health digest: `pending-unraid-install`
- Exposure proof evidence id: `phase-194-sidecar-exposure-proof`
- Exposure proof digest: `pending-unraid-install`
- Restart persistence evidence id: `phase-194-sidecar-restart-persistence`
- Restart persistence digest: `pending-unraid-install`
- App unchanged evidence id: `phase-194-app-custody-unchanged`
- App unchanged digest: `pending-unraid-install`
- Runtime image id: `pending-unraid-install`

## Evidence Requirements

The retained evidence must prove:

- the sidecar container is running and healthy;
- the sidecar remains healthy after a restart cycle;
- the sidecar socket exists and has restrictive permissions;
- no public port is published for the sidecar service;
- the sidecar service does not use host networking;
- the sidecar service is not privileged;
- the sidecar service does not mount the Docker socket;
- a redaction-safe sidecar handshake or socket-readiness probe succeeds;
- the app service still uses `CUSTODIAN_MODE=file`;
- the ops service still uses `CUSTODIAN_MODE=file`;
- the app and Postgres services remain healthy;
- `ui-live-check` still returns `ok:true`.

## Rollback

Rollback is additive-service removal only and has zero intended app impact:

1. Stop the `sidecar` service.
2. Remove the `sidecar` container.
3. Leave app, ops, Postgres, file-custodian keystore, database, and operator UI settings unchanged.
4. Preserve sidecar state until reviewed; do not delete sidecar state as part of emergency rollback.
5. Run `ui-live-check` and confirm app remains `CUSTODIAN_MODE=file`.

Rollback trigger criteria:

- sidecar health check does not become healthy;
- sidecar restart cycle does not return healthy;
- sidecar exposes any published port;
- sidecar uses host network, privileged mode, Docker socket, or unexpected mounts;
- app or ops custody mode changes away from `file`;
- app or Postgres health regresses after adding sidecar.

## Phase 192 Matrix Update

This phase satisfies the Phase 194 criterion in the Phase 192 gate:

`Sidecar service installed on Unraid, local socket only, no public ports`

Phase 195 remains unsatisfied. O4 remains open/deferred until the production custody switch evidence
and final O4 authorization path are complete.

## Boundary

Allowed in this phase:

- add the sidecar service to the Unraid runtime compose stack;
- build and deploy the sidecar service on Unraid;
- start and restart the sidecar service;
- capture redaction-safe health, socket, exposure, restart, and app-unchanged evidence.

Forbidden in this phase:

- changing app or ops `CUSTODIAN_MODE` away from `file`;
- mounting the sidecar socket into the app service;
- switching production custody;
- closing O4;
- closing O5;
- publishing sidecar ports;
- host networking;
- Docker socket mount;
- privileged container mode;
- provider contact;
- scraping;
- downloading;
- playback;
- Plex/Jellyfin mutation.

## Review Status

Recommended next status: `ready-for-phase-195-production-custody-switch`.

O4 remains open. O5 remains open. This install does not close O4 and does not close O5.
