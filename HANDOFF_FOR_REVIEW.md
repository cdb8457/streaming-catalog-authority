# Handoff for review — v1.2.2

Branch `cdb8457/v1-2-2-jellyfin-acceptance`, based on the merged v1.2.1 source
`f87781025b464bd99d126b5ee3a943a849dee435`. v1.2.0 remains published and immutable.

## Release scope

- Carry forward the Docker Compose 2.40 disposable-rehearsal compatibility patch.
- Align the release-only second-reconcile browser assertion with the terminal `Nothing is outstanding`
  verdict the UI already renders and the removal lifecycle already asserts.
- Retain every v1.2.0 offline, Jellyfin, collection lifecycle, recovery, O4 sidecar, and O5 managed-custody
  boundary unchanged.

## Absolute boundary

Catalog Authority never downloads, scrapes, plays, or acquires media and never creates media symlinks.
External acquisition and symlink systems may provide inputs only. The acceptance suites assert that the new
operations issue no media, media-server write, acquisition, registry-fetch, or network command outside their
explicit local test boundaries.

## Release identity and rollback

- `package.json` and the lockfile report `1.2.2`.
- The consumer bundle coordinate and shipped Compose defaults select `v1.2.2`.
- v1.2.2 remains schema version 9.
- The released v1.1.4 installation is the upgrade source and rollback target. Before upgrade, take and verify
  a complete set containing database, keystore, secrets, and promotion records.
- A rollback after custody or database state changes restores the complete pre-upgrade set; changing only the
  image is not represented as rollback.

## Required gates

The PR must pass typecheck, the complete bounded suite inventory, production-image smoke, release bundle and
verification, fresh/restart/upgrade/rollback lifecycle, catalog and Jellyfin browser acceptance, release
candidate acceptance, and final rehearsal. Publishing remains release-event-only and must prove anonymous
pull of the exact published digest before attaching the consumer archive.
