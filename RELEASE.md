# Catalog Authority Release Notes

Newest first. Every released version stays published and immutable; nothing here is ever re-tagged or
overwritten, which is what makes rolling an image pin backwards a real operation.

## v1.1.1 - First-run remediation (Phase 253)

Not yet published. A usability release, driven by a real clean `v1.1.0` installation on Unraid through
Arcane. Nothing about what this product does changes; what changes is what installing it does to you.

Fixed:

- **The database migrates itself, before the UI exists.** `v1.1.0` shipped no migration step at all, so a
  first `docker compose up -d` produced a UI reporting itself healthy in front of an empty database, and the
  only way forward was a command that appeared in no instruction. A one-shot `migrate` container now runs
  `ops:bootstrap` to completion first; it is idempotent, serialised by a PostgreSQL advisory lock, verified
  by reading the schema back over the least-privileged runtime connection, and fail-closed — the app
  container is gated on it exiting zero, so a failed migration produces no UI rather than a broken one.
- **An operational install with an empty evidence folder no longer reports itself as unfinished.** New
  verdict `READY_NO_RECORDS`, rendered `READY - NO RECORDS LOADED`, with an explicit sentence stating that
  nothing was audited and nothing concluded — not a passing audit, not an authorization, not a Phase 231
  result. `MISSING` (a wrong mount) is still `NEEDS_SETUP`, because that genuinely is unfinished setup.
- **A failing self-check names what failed.** The page was discarding the `/api/status` body — which listed
  the failing check — in favour of "a dependency it needs is not ready", which named nothing.
- **An Arcane/Unraid install path whose paths resolve on the host the Docker daemon runs on.**
  `docker-compose.arcane.yml` takes one required, validated variable for the project's absolute host path and
  builds every bind source from it; `deploy/arcane-setup.sh` prepares the host folder; `ops:arcane-preflight`
  checks it before Docker has to, and recognises a launcher-internal path as exactly that.
- **Deliberate LAN bind guidance.** The Arcane stack refuses to start without an explicit bind address and
  refuses a wildcard; the Unraid runtime stack now defaults to loopback instead of publishing on every
  interface by omission. Loopback is documented as what it is — that server only, not remotely reachable.
- **A latent readiness bug found on the way.** The readiness probe read a table the schema revokes from the
  runtime role, so on any correctly least-privileged deployment it reported `SCHEMA_MISSING` against a
  migrated database, forever. Schema v4 adds an owner-defined reader granted to the runtime role, and the
  setup scripts now generate a credential for that role instead of handing it the superuser.

Behaviour changes to be aware of before upgrading:

- **Schema version 3 → 4.** There are no down-migrations, so rolling back to `v1.1.0` or `v1.0.0` requires
  restoring a backup taken before the upgrade. See `docs/LIFECYCLE_MIGRATION_BACKUP_UPGRADE_ROLLBACK.md`.
- **Both Unraid stacks now publish the operator UI to `127.0.0.1` by default** —
  `docker-compose.unraid.runtime.yml` and `docker-compose.unraid.yml` — where they previously published on
  every interface by omission. If you reach that UI from another machine on your LAN, set
  `OPERATOR_UI_BIND_ADDRESS` to the server's LAN address before upgrading, or it will stop being reachable
  from the network. The change is deliberately fail-safe — it restricts rather than exposes — but it is a
  change, and it is the one thing here that can surprise a working installation.
- **`/healthz` answers 503 until the schema is present** in the shipped stacks
  (`OPERATOR_UI_HEALTHZ_REQUIRES_SCHEMA=1`). Any external monitor pointed at that route will now correctly
  report a container with an unmigrated database as unhealthy.
- **New installs give the runtime its own least-privileged credential.** Existing installs are NOT changed:
  a setup re-run keeps every secret it already made, so an install whose `database_url` is the superuser
  stays that way, and `ops:doctor` keeps reporting that honestly. Moving across is a documented, optional
  step.

Unchanged: no provider live mode, no downloading, scraping or playback, no media-server mutation, no
promotion, approval, execution, archival or deletion, and no Phase 231 authorization or execution. The
ordinary-computer release stack and the bundle it ships are otherwise as they were.

Detail: `docs/PHASE_253_FIRST_RUN_AND_ARCANE.md`.

## v1.1.0 - Operator UI and consumer release

Published, immutable. Operator UI, consumer release bundle and release-delivery hardening. See
`docs/PHASE_245_CONSUMER_RELEASE_IMAGE.md` and the Phase 246-252 documents.

## v1.0.0 - Current Scope Release

Release date: `2026-07-14`

Version choice: `v1.0.0`. This is the first versioned release because Phase 200 established
`LAUNCH_READY_WITH_ACCEPTED_WARNINGS`, Phase 198 closed O4 sidecar custody, and Phase 222 concluded
the Jellyfin ladder with read-only integration proven for the current scope. The version does not
claim a streaming product, provider runtime, download orchestration, playback, scraping, or
media-server write capability.

What ships:

- self-hosted Catalog Authority backend/operator foundation for Unraid;
- Postgres-backed catalog authority and ops commands;
- sidecar custody active for production runtime, with O4 status `O4_CLOSED`;
- read-only operator UI/API and Arcane/User Scripts launcher path;
- Jellyfin read-only integration proven with live evidence for auth, server info, library lookup,
  and Catalog Authority to Jellyfin library-item mapping.

Accepted warnings:

- `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`: managed KEK custody/scheduling remains deferred by owner
  decision. Reopen O5 for suspected KEK compromise, custody incident, multi-user/production-scale
  milestone, provider/download/playback/media-server mutation scope, or the 90-day review interval.
- `JELLYFIN_COLLECTION_WRITE_MEMBERSHIP_NOT_MATERIALIZING`: Jellyfin write-capable collection proof
  is blocked on this server. A future Jellyfin collection-write investigation and fresh operator
  authorization are required before any write-capable retry.

What this is not:

- no provider live mode;
- no Real-Debrid, TorBox, Usenet, Plex, Emby, or Stremio integration claim;
- no Jellyfin write-capable integration claim;
- no scraping, downloading, playback, create-download, request-link, or media-server mutation;
- no claim that managed KEK custody/scheduling is closed.

Evidence anchors:

- O4 final closure: Phase 198, tag `phase-198`, commit `a3681d3`.
- O5 final disposition: Phase 199, tag `phase-199`, commit `4998c65`,
  status `O5_DEFERRED_ACCEPTED`.
- Launch readiness: Phase 200, tag `phase-200`, status `LAUNCH_READY_WITH_ACCEPTED_WARNINGS`.
- Jellyfin data-positive read-only mapping: Phase 220, tag `phase-220`, file SHA-256
  `7b8cb31e703f20b87a7f262cc376f956c26ed14827ec3c2349db22d183ea3055`, report digest
  `ac423af0f96afcb2fff905c228cdc3dd43e29ee866340b3b96c89f9a8e3e9b71`.
- Jellyfin integration decision: Phase 222, tag `phase-222`, status
  `JELLYFIN_INTEGRATION_DECISION_READ_ONLY_PROVEN_WRITE_BLOCKED`.

Image/tag guidance:

- source release tag: `v1.0.0`;
- local Unraid image tag: `repo-ops:v1.0.0`;
- current local runtime image alias: `repo-ops:latest`;
- published image convention remains `ghcr.io/catalog-authority/catalog-authority-ops:v1.0.0`
  when a registry image is explicitly published.

**Correction (Phase 245).** The `catalog-authority/…` namespace above was a *placeholder* — earlier phases
wrote the convention as `ghcr.io/<owner>/catalog-authority-ops:<tag>` and later documents copied the placeholder as if
it were a name. This project does not own that namespace, and a workflow's `GITHUB_TOKEN` cannot publish into
it. The operative published repository is:

```
ghcr.io/cdb8457/catalog-authority-ops
```

derived from the repository owner in `src/ops/release-coordinates.ts`, which the Compose default, the release
bundle, the release workflow and the documentation all read. Earlier phase records (Phase 3, 145, 154, 223)
keep their original text as written; this correction supersedes the namespace in all of them.

## Launch Package Baseline

Current launch package: `phase-200` / `0d08052`

Launch status: `LAUNCH_READY_WITH_ACCEPTED_WARNINGS`

Required warning: `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`

Operator handoff package: `phase-201` / `9378a07`

Consumer dry-run gate: `docs/PHASE_202_LAUNCH_CANDIDATE_DRY_RUN.md`

Catalog Authority is ready as a self-hosted backend/operator foundation on Unraid. It includes
Postgres, sidecar custody, one-shot ops commands, the read-only operator UI, Arcane/User Scripts
launchers, and redaction-safe evidence capture/review.

Gate status:

- O4: `O4_CLOSED`
- O5: `O5_DEFERRED_ACCEPTED`

O5 is intentionally deferred with a launch warning. This package does not claim managed KEK
custody/scheduling closure.

Operator handoff:

- `docs/PHASE_202_LAUNCH_CANDIDATE_DRY_RUN.md`
- `docs/PHASE_201_LAUNCH_PACKAGE.md`
- `docs/PHASE_200_LAUNCH_READINESS_PASS.md`
- `docs/RELEASE_CHECKLIST.md`

Canonical Unraid paths:

- repo: `/mnt/user/appdata/catalog/repo`
- appdata root: `/mnt/user/appdata/catalog`
- compose file: `/mnt/user/appdata/catalog/repo/docker-compose.unraid.runtime.yml`
- launcher: `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh`

Image:

- default local image: `repo-ops:latest`
- published image naming convention: `ghcr.io/catalog-authority/catalog-authority-ops:<tag>`
- set `CATALOG_AUTHORITY_OPS_IMAGE` only when pulling a published image instead of using the
  locally built default image.

Install or update:

```bash
mkdir -p /mnt/user/appdata/catalog/repo
cd /mnt/user/appdata/catalog/repo
git clone https://github.com/cdb8457/streaming-catalog-authority.git . 2>/dev/null || git fetch origin --tags --force
git checkout master
git reset --hard origin/master
docker build -t repo-ops:latest .
docker compose -f docker-compose.unraid.runtime.yml up -d postgres app sidecar
```

Required secret files:

```text
/mnt/user/appdata/catalog/secrets/postgres_password
/mnt/user/appdata/catalog/secrets/admin_database_url
/mnt/user/appdata/catalog/secrets/database_url
/mnt/user/appdata/catalog/secrets/completion_secret
/mnt/user/appdata/catalog/secrets/custodian_kek
/mnt/user/appdata/catalog/secrets/operator_ui_token
```

Verify:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh status
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check-save
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-evidence-review
```

Expected healthy state:

- app, sidecar, and Postgres running and healthy;
- app custody mode is `sidecar`;
- sidecar publishes no ports;
- `ui-live-check` returns `ok:true`;
- O5 warning remains visible.

Allowed launch claim:

```text
Catalog Authority is ready as a self-hosted backend/operator foundation with O4 closed, O5
deferred-accepted with a visible launch warning, sidecar custody active, and no provider or media
runtime behavior enabled.
```

Forbidden launch claims:

- no streaming product claim;
- no provider live mode;
- no Real-Debrid, TorBox, Usenet, Plex, Jellyfin, Emby, or Stremio integration claim;
- no scraping, downloading, playback, create-download, request-link, or media-server mutation;
- no O5 closed claim;
- no managed KEK custody/scheduling claim.
