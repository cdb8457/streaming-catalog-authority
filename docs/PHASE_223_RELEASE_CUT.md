# Phase 223: Versioned Release Cut

Report id: `phase-223-versioned-release-cut`

Release date: `2026-07-14`

Phase type: packaging, verification, and release records only. This phase adds no feature work, no
scope expansion, no runtime behavior change, no Docker Compose behavior change, no custody-mode
change, and no media-server state change.

## Version Decision

Selected version: `v1.0.0`

Source release commit: `4d1f81830`

Source release tag: `v1.0.0`

Version rationale: this is the first versioned release because the current scope is launch-ready
with accepted warnings. O4 sidecar custody is closed, O5 is formally deferred-accepted with a launch
warning, and Jellyfin read-only integration is proven for the current scope. The version does not
claim provider runtime, downloading, playback, scraping, or media-server writes.

The Phase 223 evidence record is intentionally post-tag evidence for the `v1.0.0` source. The
runtime image digest is recorded after building the immutable source tag; embedding that digest into
the same source tag would change the image input and invalidate the digest.

## Release Notes

Release notes are recorded in `RELEASE.md` under `v1.0.0 - Current Scope Release`.

What ships:

- self-hosted Catalog Authority backend/operator foundation for Unraid;
- sidecar custody active for production runtime, with O4 status `O4_CLOSED`;
- read-only operator UI/API and Arcane/User Scripts launcher path;
- Jellyfin read-only integration proven with live evidence for auth, server info, library lookup,
  and Catalog Authority to Jellyfin library-item mapping.

Accepted warnings:

- `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`;
- `JELLYFIN_COLLECTION_WRITE_MEMBERSHIP_NOT_MATERIALIZING`.

Forbidden claims:

- no provider live mode;
- no Real-Debrid, TorBox, Usenet, Plex, Emby, or Stremio integration claim;
- no Jellyfin write-capable integration claim;
- no scraping, downloading, playback, create-download, request-link, or media-server mutation;
- no managed KEK custody/scheduling closure claim.

## Evidence Anchors

| Evidence | Anchor |
| --- | --- |
| O4 final closure | Phase 198, tag `phase-198`, commit `a3681d3` |
| O5 final disposition | Phase 199, tag `phase-199`, commit `4998c65`, status `O5_DEFERRED_ACCEPTED` |
| Launch readiness | Phase 200, tag `phase-200`, status `LAUNCH_READY_WITH_ACCEPTED_WARNINGS` |
| Jellyfin read-only data-positive mapping | Phase 220, tag `phase-220`, file SHA-256 `7b8cb31e703f20b87a7f262cc376f956c26ed14827ec3c2349db22d183ea3055`, report digest `ac423af0f96afcb2fff905c228cdc3dd43e29ee866340b3b96c89f9a8e3e9b71` |
| Jellyfin final integration decision | Phase 222, tag `phase-222`, status `JELLYFIN_INTEGRATION_DECISION_READ_ONLY_PROVEN_WRITE_BLOCKED` |

## Fresh-Clone Smoke

Fresh clone target: source tag `v1.0.0`

Fresh clone result: `RELEASE_FRESH_CLONE_SMOKE_PASS`

Commands executed from a clean temporary clone:

- `git checkout v1.0.0`;
- `npm ci`;
- `npm run typecheck`;
- `npm run test`;
- `npm run test:deploy`.

Observed package version: `1.0.0`

Observed exact tag: `v1.0.0`

Fresh-clone constraints satisfied:

- no dependency on local working tree history;
- no dependency on untracked files;
- no dependency on pre-existing volumes;
- no dependency on undocumented environment variables for the repository checks.

## Release Image

Image source tag: `v1.0.0`

Image source commit: `4d1f81830`

Local Unraid image tags:

- `repo-ops:v1.0.0`;
- `repo-ops:latest`.

Image ID:

`sha256:a8342b416a005734faf7dd16f312ec6a7254c979b8a6143c9477d4b20ee8d3f5`

Published-image convention remains `ghcr.io/catalog-authority/catalog-authority-ops:v1.0.0` if a
registry image is explicitly published later. This phase records the local Unraid image used for the
current release runtime.

## Unraid Runtime Evidence

Unraid repo state:

- checked out exact tag: `v1.0.0`;
- checked out commit: `4d1f81830`.

Container state after recreating runtime services:

- `catalogauthority-app-1`: healthy;
- `catalogauthority-sidecar-1`: healthy;
- `catalogauthority-postgres-1`: healthy.

Release image use:

- app image ID: `sha256:a8342b416a005734faf7dd16f312ec6a7254c979b8a6143c9477d4b20ee8d3f5`;
- sidecar image ID: `sha256:a8342b416a005734faf7dd16f312ec6a7254c979b8a6143c9477d4b20ee8d3f5`.

Runtime custody:

- `CUSTODIAN_MODE=sidecar`;
- `CUSTODIAN_SIDECAR_SOCKET_PATH=/run/catalog-sidecar/catalog-sidecar.sock`.

Exposure:

- operator UI publishes the intentional `8099` port;
- sidecar published ports: `{}`;
- Jellyfin compose write guard: `JELLYFIN_COMPOSE_WRITE_GUARD_OK`.

Operator UI:

- live check report: `phase-150-operator-ui-live-check`;
- live check status: `ok:true`;
- pass count: `11`;
- warn count: `1`;
- fail count: `0`;
- forbidden list includes provider contact, scraping, downloading, playback, and runtime mutations.

## Alignment Sweep

Alignment status: `PHASE_223_RELEASE_ALIGNMENT_PASS`

- `package.json` version is `1.0.0`;
- `RELEASE.md` declares source tag `v1.0.0` and honest warnings;
- `docker-compose.unraid.runtime.yml` continues to use `${CATALOG_AUTHORITY_OPS_IMAGE:-repo-ops:latest}`;
- Arcane/User Scripts launcher remains `deploy/unraid-ops-launcher.sh`;
- canonical Unraid repo path remains `/mnt/user/appdata/catalog/repo`;
- shipped Compose does not enable `JELLYFIN_ALLOW_LIVE_PUBLISH=true`;
- no shipped record claims provider runtime, playback, downloading, scraping, or media-server writes.

## Final Disposition

Release status: `VERSIONED_RELEASE_CUT_READY_WITH_ACCEPTED_WARNINGS`

Source release: `v1.0.0`

Phase tag: `phase-223`

Accepted warnings remain launch-visible:

- `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`;
- `JELLYFIN_COLLECTION_WRITE_MEMBERSHIP_NOT_MATERIALIZING`.

Clean post-release branches can start from this baseline for:

- Jellyfin collection-write investigation;
- Plex rung-1 read-only ladder;
- O5 reopening or closure work.

## Phase 224 Addendum

Phase 224 clarifies that the `v1.0.0` release cut describes infrastructure readiness, not product
readiness. The release remains valid for the scoped backend/operator foundation: runtime stack,
sidecar custody, operator UI health/status, release packaging, and Jellyfin read-only evidence.

It does not claim a complete media workflow. Product readiness remains false until the project proves
one boring, repeatable end-to-end process from operator input to Jellyfin-visible result with UI
lifecycle status. The current named gap is `PRODUCT_READY_FALSE_E2E_WORKFLOW_MISSING`.
