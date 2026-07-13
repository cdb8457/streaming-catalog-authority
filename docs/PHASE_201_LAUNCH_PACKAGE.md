# Phase 201: Launch Package / Operator Handoff

Report id: `phase-201-launch-package`

Package date: `2026-07-13`

Phase type: artifact and test work only. This phase packages the Phase 200 launch-ready state for
operators. It makes no runtime, Docker Compose, custody-mode, KEK, sidecar service, provider,
playback, download, scraping, or media-server changes.

## Package Verdict

Launch package status: `LAUNCH_PACKAGE_READY_WITH_ACCEPTED_WARNINGS`

Launch readiness source: Phase 200, commit `0d08052`, tag `phase-200`

Required launch warning: `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`

This package is the operator-facing handoff for the self-hosted Catalog Authority backend/operator
foundation. It is not a streaming product package.

## Final Gate State

| Gate | Final launch disposition | Operator meaning |
| --- | --- | --- |
| O4 sidecar custody | `O4_CLOSED` | Production custody path is sidecar-based and accepted for this launch scope. |
| O5 managed KEK custody/scheduling | `O5_DEFERRED_ACCEPTED` | Launch may proceed only with the visible warning and reopening criteria from Phase 199. |

## Canonical Launch Coordinates

| Item | Value |
| --- | --- |
| Repository | `https://github.com/cdb8457/streaming-catalog-authority.git` |
| Launch commit | `0d08052` |
| Launch tag | `phase-200` |
| Canonical Unraid repo path | `/mnt/user/appdata/catalog/repo` |
| Canonical Unraid appdata path | `/mnt/user/appdata/catalog` |
| Runtime compose file | `/mnt/user/appdata/catalog/repo/docker-compose.unraid.runtime.yml` |
| Operator launcher | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh` |
| Local image name | `repo-ops:latest` |

## Arcane / User Scripts Buttons

| Button | Exact command | Expected result |
| --- | --- | --- |
| Status | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh status` | Shows app, sidecar, and Postgres container state. |
| Start UI | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh start-ui` | Starts the read-only operator UI if it is not running. |
| Restart UI | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh restart-ui` | Restarts only the operator UI app container. |
| UI Live Check | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check` | Returns `ok:true` with no fail checks. |
| Save UI Evidence | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check-save` | Saves redaction-safe live-check JSON. |
| Review UI Evidence | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-evidence-review` | Reviews saved live-check evidence for recency and pass state. |
| UI Logs | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-logs` | Shows recent redacted UI logs. |
| UI Token Status | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-token-status` | Shows token status without printing token material. |

## Healthy State

Expected healthy launch state:

- `catalogauthority-app-1`: running and healthy;
- `catalogauthority-sidecar-1`: running and healthy;
- `catalogauthority-postgres-1`: running and healthy;
- app custody mode: `sidecar`;
- sidecar published ports: `none`;
- operator UI live check: `ok:true`;
- expected warning: `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`.

The expected warning is not a launch blocker unless an O5 reopening criterion has fired.

## Allowed Claim

```text
Catalog Authority is ready as a self-hosted backend/operator foundation with O4 closed, O5
deferred-accepted with a visible launch warning, sidecar custody active, and no provider or media
runtime behavior enabled.
```

## Forbidden Claims

- no streaming product claim;
- no provider live mode claim;
- no Real-Debrid, TorBox, Usenet, Plex, Jellyfin, Emby, or Stremio integration claim;
- no scraping, downloading, playback, create-download, request-link, or media-server mutation claim;
- no claim that O5 is closed;
- no managed KEK custody/scheduling claim.

## Operator Stop Lines

Stop launch or return to readiness review if any of these occur:

- O5 reopening criterion from Phase 199 fires;
- `ui-live-check` reports `ok:false` or any fail check;
- app, sidecar, or Postgres is not running and healthy;
- sidecar exposes a published port;
- app custody mode is not `sidecar`;
- any provider/download/playback/media-server feature is requested for this launch package.

## Verification

Phase 201 verification checks:

- release package exposes the Phase 200 launch-ready status;
- README points operators to the launch package;
- release checklist keeps the O5 warning visible;
- package scripts and deploy guard pin `test:launch-package`;
- no runtime or provider scope is introduced.
