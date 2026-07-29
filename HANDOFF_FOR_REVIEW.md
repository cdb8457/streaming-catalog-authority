# Handoff for review — v1.2.0

Branch `cdb8457/phases-274-276-real-offline-lifecycle`, based on the published v1.1.4 merge
`e01522f3bb20ed3881afb2696a0ccd25b3769407`. v1.1.4 remains published and immutable.

## Release scope

- Offline external-export to canonical-snapshot production, validated by the shipped importer.
- Read-only Jellyfin discovery and matching with all write gates closed.
- Disposable managed-collection plan, confirmed reconcile, drift audit, repair, revoke, and cleanup.
- Complete four-component backup and verification, doctor monitoring, and disposable upgrade/rollback
  rehearsal.
- O4 local sidecar IPC/state hardening and O5 managed KEK ring custody, rotation, retirement, legacy-safe
  transition, cutover, audit, repair, and rollback lifecycle.

## Absolute boundary

Catalog Authority never downloads, scrapes, plays, or acquires media and never creates media symlinks.
External acquisition and symlink systems may provide inputs only. The acceptance suites assert that the new
operations issue no media, media-server write, acquisition, registry-fetch, or network command outside their
explicit local test boundaries.

## Release identity and rollback

- `package.json` and the lockfile report `1.2.0`.
- The consumer bundle coordinate and shipped Compose defaults select `v1.2.0`.
- v1.2.0 remains schema version 9.
- The released v1.1.4 installation is the upgrade source and rollback target. Before upgrade, take and verify
  a complete set containing database, keystore, secrets, and promotion records.
- A rollback after custody or database state changes restores the complete pre-upgrade set; changing only the
  image is not represented as rollback.

## Required gates

The PR must pass typecheck, the complete bounded suite inventory, production-image smoke, release bundle and
verification, fresh/restart/upgrade/rollback lifecycle, catalog and Jellyfin browser acceptance, release
candidate acceptance, and final rehearsal. Publishing remains release-event-only and must prove anonymous
pull of the exact published digest before attaching the consumer archive.
