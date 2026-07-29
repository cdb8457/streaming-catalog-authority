# Catalog Authority Release Notes

Newest first. Every released version stays published and immutable; nothing here is ever re-tagged or
overwritten, which is what makes rolling an image pin backwards a real operation.

## v1.2.6 - Sidecar and managed-ring rehearsal hardening

Release candidate; not yet published. Schema remains version 9.

Fixed:

- **The steady-state sidecar now bounds the Go scheduler used by `tsx`/esbuild.** A 128-core Unraid host
  proved that the daemon plus its health probe could exhaust the service's deliberate 128-PID limit before
  the protocol handshake ran. `GOMAXPROCS=2` preserves that confinement and makes the handshake reliable.
- **Upgrade and rollback rehearsals now restore root-only managed-ring custody correctly.** The generated
  override previously selected the restored legacy static KEK even when the runtime selected the restored
  root key, so the fail-closed sidecar saw both custody sources and refused startup. The static file is still
  restored as part of the complete recovery set, but only the managed-ring root key is selected.
- **The release browser gate now agrees with its own pre-settled lifecycle.** Its shell steps already recover
  the deliberately lost create response and prove a third reconcile is a no-op. The following browser click
  now requires the correct terminal `Nothing is outstanding` verdict instead of stale `Created` wording.
- **Both corrections came from real Tower acceptance.** Production remained healthy and untouched while
  each failed disposable rehearsal retained only its marker-scoped project for diagnosis and exact cleanup.

All earlier product behavior and safety boundaries are unchanged. Catalog Authority still never downloads,
scrapes, plays, or acquires media and never creates media symlinks.

## v1.2.5 - Recursive Jellyfin collection membership

Published `2026-07-29`, immutable. Schema remains version 9.

Fixed:

- **Collection audits now request recursive descendants from Jellyfin.** Jellyfin 10.11 does not return a
  collection's members from `GET /Items?parentId=...` unless `Recursive=true` is explicit. The missing
  parameter made a populated disposable collection appear empty, producing false `MEMBERS_MISSING` drift
  and ineffective repair loops.
- **The correction came from the real Tower lifecycle rehearsal.** The direct Jellyfin API proved the
  collection held its one expected member while Catalog Authority's audit saw zero. The write gates were
  closed immediately, and this patch adds the required request parameter plus a regression assertion before
  the bounded lifecycle resumes.
- **Complete backups now quiesce the shipped sidecar by its real Compose service name.** The sidecar topology
  previously attempted to stop `custodian`, while the released Unraid service is `sidecar`. That mismatch
  would refuse a scheduled complete backup after custody cutover; the exact service ledger is now asserted.

All earlier product behavior and safety boundaries are unchanged. Catalog Authority still never downloads,
scrapes, plays, or acquires media and never creates media symlinks.

## v1.2.4 - Portable legacy dump grants

Release candidate; not yet published. Schema remains version 9.

Fixed:

- **The disposable rehearsal prepares the product-managed runtime role before each SQL replay.** PostgreSQL
  dumps preserve grants but do not include cluster-wide roles. Both restore legs now create the known `app`
  role using PostgreSQL's non-authenticating default, with no credential in the command; the normal bootstrap
  later enables it with the password from the restored secret.
- **The correction came from the real Tower restore.** v1.2.3 waited for a healthy database and then proved
  the verified dump reached its final grant statements, where the absent role stopped it. A credential-free
  role preparation made that same dump replay cleanly in the retained disposable project.

All earlier product behavior and safety boundaries are unchanged. Catalog Authority still never downloads,
scrapes, plays, or acquires media and never creates media symlinks.

## v1.2.3 - Bounded disposable database readiness

Published `2026-07-29`, immutable. Schema remains version 9.

Fixed:

- **Each fresh rehearsal database must declare a healthcheck and reach it before restore.** Both the upgrade
  and restore-based rollback legs now run Compose with a bounded 60-second readiness wait. A definition
  without a PostgreSQL healthcheck is refused during the read-only resolved-model preflight.
- **The correction came from the real Tower rehearsal.** v1.2.2 passed isolation, pinning, and backup
  verification, then raced PostgreSQL initialization and safely retained only the disposable project for
  diagnosis. Production, the verified set, network state, and every media boundary remained untouched.

All v1.2.2 product behavior is unchanged. Catalog Authority still never downloads, scrapes, plays, or
acquires media and never creates media symlinks.

## v1.2.2 - Release acceptance alignment

Published `2026-07-29`, immutable. Schema remains version 9.

Fixed:

- **The release-only Jellyfin browser acceptance now recognizes the existing terminal no-work verdict.**
  After the first reconcile drains every durable intent, the second click correctly reports
  `Nothing is outstanding` without entering a zero-effect run. The previous assertion waited for the older
  `Created 0 collection(s)` wording and blocked publication even though the API acceptance had already
  proved idempotency and no duplicate.
- **All v1.2.1 product behavior is unchanged.** This patch carries the Docker Compose 2.40 rehearsal parser
  correction forward without changing schema, runtime behavior, custody, media boundaries, or write gates.

Catalog Authority still never downloads, scrapes, plays, or acquires media and never creates media symlinks.

## v1.2.1 - Docker Compose 2.40 rehearsal compatibility

Tagged `2026-07-29`; its release workflow intentionally published no image or consumer asset because the
release-only Jellyfin browser assertion described in v1.2.2 blocked the publication job. Schema remains
version 9.

Fixed:

- **The host-side upgrade/rollback rehearsal now accepts Docker Compose 2.40's fully resolved
  `KEY=value` environment arrays.** It still refuses bare pass-through names, non-string entries, duplicate
  assignments, invalid names, null mapping values, and oversized environments. Values are split only at the
  first equals sign.
- **The correction came from a real Tower rehearsal refusal.** The v1.2.0 command safely stopped before
  starting a disposable container, left its marker-scoped evidence for diagnosis, did not address
  production, and did not change the verified backup set.

All v1.2.0 boundaries and schema remain unchanged. Catalog Authority still never downloads, scrapes, plays,
or acquires media and never creates media symlinks.

## v1.2.0 - Offline authority, managed collections, and managed custody

Published `2026-07-29`, immutable. Schema remains version 9.

Added:

- **Real offline snapshot production and import acceptance.** An operator-supplied export is transformed
  deterministically into the shipped import format, validated by the shipped importer, and published
  atomically without overwrite. Acquisition and media-location namespaces are refused.
- **Read-only Jellyfin discovery and matching.** Catalog records can be compared with a bounded Jellyfin
  library scan while every write gate remains closed. Failure and truncation produce `unknown`, never a
  fabricated absence, and the match writes neither Catalog Authority nor Jellyfin state.
- **A disposable managed-collection lifecycle.** The release gate exercises plan, digest-confirmed
  reconcile, drift audit, repair, revoke, and cleanup against a test-only fake server that cannot ship in
  the production image.
- **Automated recovery operations.** Complete four-component backups are taken from one quiesced moment and
  verified before success; unattended doctor monitoring preserves the shipped doctor verdict; disposable
  upgrade and restore-based rollback rehearsals prove both images and all four recovery components.
- **O4 sidecar and O5 managed-KEK hardening.** Local IPC is bounded and non-networked; managed custody uses a
  sealed KEK ring, explicit backup-gated rotation and retirement, resumable journals, legacy-safe cutover,
  drift audit and repair, and a complete disposable custody lifecycle.

Upgrade notes:

- **Schema stays at 9**, but custody state changes are operationally significant. Take and verify a complete
  backup before upgrading.
- A released v1.1.4 installation starts in static-KEK legacy mode with no ring, root wrapping key, or custody
  marker. The transition command classifies that state and refuses mutation until a valid root key and a
  fresh backup carrying it are both present.
- Catalog Authority still never downloads, scrapes, plays, or acquires media and never creates media
  symlinks. External acquisition and symlink systems may provide inputs only.

Release gates: typecheck and complete bounded suite inventory; production-image smoke; offline snapshot,
read-only Jellyfin and disposable collection acceptance; complete backup and monitoring; real disposable
upgrade/rollback; sidecar and KEK lifecycle gates; catalog and Jellyfin browser acceptance; release bundle,
candidate acceptance, and final release rehearsal. Publishing remains a separate release-event action.

## v1.1.4 - High-core keystore startup hotfix

Published `2026-07-29`, immutable. This focused hotfix keeps the v1.1.3 application, schema version 9,
security boundaries and operator workflows unchanged.

Fixed:

- **The fail-closed keystore preparation one-shot now starts on high-core Docker hosts.** `tsx` launches
  esbuild's Go helper before Catalog Authority repair code runs. CPU quotas do not reduce the processor count
  visible to that helper, so a host exposing 128 CPUs could make it exhaust the service's deliberate 64-PID
  limit and fail before checking the keystore. Both shipped Compose stacks now set `GOMAXPROCS=2` for this
  one-shot. The existing PID, CPU, memory, capability, mount, network and read-only boundaries remain intact.
- **The constraint is regression-tested in both consumer stacks.** The keystore repair suite requires the
  ordinary runtime and Arcane/Unraid Compose definitions to retain the bound.

Upgrade notes:

- There is no schema or stored-data change from v1.1.3. Upgrading or rolling back between v1.1.3 and v1.1.4
  does not require restoring a database or keystore backup.
- Existing release guarantees remain unchanged: the helper still has no network or secrets, mounts only the
  keystore, changes only understood ownership/mode state, and blocks migration and app startup on refusal.

External acceptance on a 128-CPU Unraid host reproduced the v1.1.3 failure under the published 64-PID limit,
proved the bound in isolation, and then passed first run, restart/idempotency, schema 9, least-privileged
doctor checks, authenticated version agreement, import preview/apply/replay protection, catalog browsing and
durable import history.

## v1.1.3 - Catalog workspace and managed collections (Phases 255–272)

Published `2026-07-28`, immutable. This release turns the installed operator surface into a usable
catalog workspace, fixes the fresh-volume keystore defect found by the real-browser gate, and adds an
explicitly gated lifecycle for one managed Jellyfin collection per accepted plan.

Added:

- **A catalog an operator can fill and browse.** A snapshot in the read-only import folder can be previewed
  without writes, then applied only against the exact bytes previewed. Imports are idempotent, recorded in
  identity-free durable history, and available through the authenticated UI and `ops:catalog-import`.
  Catalog search, filtering, paging, record detail and deterministic redacted export use the same stored
  authority.
- **A managed collection lifecycle.** One named plan now means one durable collection with selected catalog
  records as members. Preview, confirmed queueing, reconcile, read-only drift audit, explicit repair and
  revoke are available in the UI and through `ops:collections`. Re-planning the same name updates the same
  collection; deselection or erasure drives membership removal; an empty collection is revoked.
- **A control plane that remains off by default.** Jellyfin network access, live publishing, collection
  writes and external identity release are four separate gates. The API key comes only from a file, the
  target must be a private/local address, redirects are refused, and the release gate proves the lifecycle
  against a local fake Jellyfin in a real browser and real Compose stack. This is not evidence from the
  operator's live Jellyfin server.
- **Support and complete rollback artifacts.** The authenticated UI can render a redaction-safe support
  report. Backup tooling covers the database, keystore, secrets and promotion records, and offline inspection
  reports which components and schema version a backup actually contains.
- **A bounded aggregate test runner.** Every test file belongs to an explicit inventory, suites run as
  separate bounded processes, and a skipped, signalled, timed-out or never-reached suite fails the run.

Fixed:

- **Fresh and existing keystore volumes are usable by the non-root runtime.** The image seeds a fresh volume
  with `node` ownership. Shipped Compose stacks also run a narrow one-shot `keystore-prepare` before migration
  and app startup: no network, no secrets, one mount, only the capabilities needed to inspect and repair
  ownership, and fail-closed refusal for an unexpected tree. It never reads, rewrites or deletes key
  material.
- **Recovery after a lost external-create response is provable.** Durable recovery-proof state distinguishes
  "the token proved nothing exists" from "the token cannot recover this operation," preventing a reconciler
  from treating ambiguity as permission to create a duplicate.
- **Package identity agrees with the release.** `package.json`, the lockfile, bundle coordinate, Compose
  defaults and OCI release label all report `1.1.3`; a regression assertion prevents the stale `1.0.0`
  package version that made earlier installed-image checks misleading.

Upgrade notes:

- **Schema version 4 → 9.** There are no down-migrations. Before upgrading, back up the database, keystore,
  secrets and promotion records as one recovery set. Rolling back the image requires restoring the
  pre-upgrade database and keystore together.
- **Existing v1.1.2 keystore volumes are repaired automatically on `up -d`.** A refusal stops migration and
  the UI instead of guessing. See `docs/PHASE_263_KEYSTORE_REPAIR.md` for the check, repair and refusal codes.
- The release remains a self-hosted authority and operator tool. It adds no provider download, scraping or
  playback runtime. O4 external/managed custodian evidence and O5 managed KEK custody remain explicit doctor
  warnings rather than being silently treated as closed.

Release gates: typecheck and local suites; production-image smoke; release bundle and verification packet;
fresh/restart/upgrade/rollback lifecycle; catalog import-and-browser acceptance; Jellyfin control-plane
acceptance against a local fake server; release-candidate browser acceptance; and final release rehearsal.
Publishing remains a separate release-event action.

## v1.1.2 - Consumer readiness (Phase 254)

Published `2026-07-25`, immutable. The Arcane/Unraid install path is present in the downloadable archive,
registry-unqualified local images are reported as local rather than malformed, and publishing proves that an
anonymous consumer can pull the exact image digest before attaching the bundle.

Detail: `docs/PHASE_254_CONSUMER_READINESS.md`.

## v1.1.1 - First-run remediation (Phase 253)

Published `2026-07-25`, immutable. A usability release, driven by a real clean `v1.1.0` installation on
Unraid through Arcane. Nothing about what this product does changes; what changes is what installing it does
to you.

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
- **The Unraid stack now publishes the operator UI to `127.0.0.1` by default.**
  `docker-compose.unraid.runtime.yml` previously published on every interface by omission. If you reach that
  UI from another machine on your LAN, set `OPERATOR_UI_BIND_ADDRESS` to the server's LAN address before
  upgrading, or it will stop being reachable from the network. The change is deliberately fail-safe — it
  restricts rather than exposes — but it is a change, and it is the one thing here that can surprise a
  working installation. (The repository's other, undocumented Unraid Compose file was given the same default
  for consistency; see `docs/PHASE_253_FIRST_RUN_AND_ARCANE.md`.)
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
