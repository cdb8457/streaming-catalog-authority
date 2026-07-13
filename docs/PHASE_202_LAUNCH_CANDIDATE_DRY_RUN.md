# Phase 202: Launch Candidate Consumer Dry Run

Report id: `phase-202-launch-candidate-consumer-dry-run`

Dry-run date: `2026-07-13`

Phase type: artifact, documentation, and test work only. This phase validates the public consumer
launch path from the documented repository and release package. It makes no runtime, Docker Compose,
custody-mode, KEK, sidecar service, provider, playback, download, scraping, or media-server changes.

## Verdict

Dry-run status: `LAUNCH_CANDIDATE_CONSUMER_DRY_RUN_READY_WITH_ACCEPTED_WARNINGS`

Consumer handoff source: Phase 201, commit `9378a07`, tag `phase-201`

Launch readiness source: Phase 200, commit `0d08052`, tag `phase-200`

Required launch warning: `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`

This dry run verifies that a fresh operator can discover the canonical Unraid path, build or pull the
operator image, start the documented stack, run the launcher commands, and understand the accepted O5
warning without relying on hidden local history.

## Dry-Run Inputs

| Input | Requirement |
| --- | --- |
| Public repository | `https://github.com/cdb8457/streaming-catalog-authority.git` |
| Operator handoff | `docs/PHASE_201_LAUNCH_PACKAGE.md` |
| Release package | `RELEASE.md` |
| Canonical Unraid repo path | `/mnt/user/appdata/catalog/repo` |
| Canonical Unraid appdata path | `/mnt/user/appdata/catalog` |
| Canonical Compose file | `/mnt/user/appdata/catalog/repo/docker-compose.unraid.runtime.yml` |
| Canonical launcher | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh` |

## Consumer Procedure Checked

The documented consumer path is:

```bash
mkdir -p /mnt/user/appdata/catalog/repo
cd /mnt/user/appdata/catalog/repo
git clone https://github.com/cdb8457/streaming-catalog-authority.git . 2>/dev/null || git fetch origin --tags --force
git checkout master
git reset --hard origin/master
docker build -t repo-ops:latest .
docker compose -f docker-compose.unraid.runtime.yml up -d postgres app sidecar
```

The path is valid only after the documented secret files exist under
`/mnt/user/appdata/catalog/secrets`. The release package must list every required file and must not
ask operators to edit multiple Compose files or remove services to boot the launch stack.

## Arcane / User Scripts Commands Checked

The launch package exposes these exact operator commands:

| Button | Exact command |
| --- | --- |
| Status | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh status` |
| Start UI | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh start-ui` |
| Restart UI | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh restart-ui` |
| UI Live Check | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check` |
| Save UI Evidence | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check-save` |
| Review UI Evidence | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-evidence-review` |
| UI Logs | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-logs` |
| UI Token Status | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-token-status` |

## Expected Healthy State

- app, sidecar, and Postgres are running and healthy;
- app custody mode is `sidecar`;
- sidecar publishes no ports;
- `ui-live-check` returns `ok:true`;
- the only accepted launch warning is `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`.

## Dry-Run Stop Lines

Stop and return to readiness review if any of these occur:

- a fresh clone cannot find the documented Compose file or launcher;
- the documented procedure requires a second Compose file or local-only path;
- any required secret file is missing from the release package;
- `ui-live-check` returns `ok:false`;
- app custody mode is not `sidecar`;
- sidecar exposes a public port;
- O5 is claimed closed;
- any provider, scraping, downloading, playback, or media-server behavior is claimed.

## Scope Boundary

Allowed claim:

```text
Catalog Authority has a documented consumer launch path for the self-hosted backend/operator
foundation, with O4 closed, O5 deferred-accepted with a visible warning, sidecar custody active, and
no provider or media runtime behavior enabled.
```

Forbidden claims:

- no streaming product claim;
- no provider live mode claim;
- no Real-Debrid, TorBox, Usenet, Plex, Jellyfin, Emby, or Stremio integration claim;
- no scraping, downloading, playback, create-download, request-link, or media-server mutation claim;
- no claim that O5 is closed;
- no managed KEK custody/scheduling claim.

## Verification

Phase 202 verification checks:

- `RELEASE.md` exposes the consumer install/update procedure and required secret-file list;
- `docs/PHASE_201_LAUNCH_PACKAGE.md` exposes the launcher commands and healthy state;
- `docker-compose.unraid.runtime.yml` remains the only documented Unraid runtime compose entrypoint;
- package scripts and deploy guard pin `test:launch-candidate-dry-run`;
- no runtime or provider scope is introduced.
