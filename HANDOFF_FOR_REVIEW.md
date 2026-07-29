# Handoff for review — v1.2.6

Branch `cdb8457/v1-2-6-sidecar-rehearsal-hardening`, based on the published v1.2.5 merge
`efd426148f31ea9af82a37f3215b8497809ba065`. Earlier releases remain published and immutable.

## Release scope

- Carry all prior release corrections forward unchanged.
- Bound the steady-state sidecar's Go scheduler so its health handshake stays within the 128-PID service
  limit on high-core hosts.
- Make the disposable upgrade/rollback rehearsal select the restored managed-ring root key and leave the
  restored legacy static KEK unselected, matching the shipped root-only runtime.
- Assert both corrections in the focused deployment and rehearsal suites.
- Retain every v1.2.0 offline, Jellyfin, collection lifecycle, recovery, O4 sidecar, and O5 managed-custody
  boundary unchanged.

## Absolute boundary

Catalog Authority never downloads, scrapes, plays, or acquires media and never creates media symlinks.
External acquisition and symlink systems may provide inputs only. The acceptance suites assert that the new
operations issue no media, media-server write, acquisition, registry-fetch, or network command outside their
explicit local test boundaries.

## Release identity and rollback

- `package.json` and the lockfile report `1.2.6`.
- The consumer bundle coordinate and shipped Compose defaults select `v1.2.6`.
- v1.2.6 remains schema version 9.
- The released v1.2.5 installation is the upgrade source and rollback target. Before upgrade, take and verify
  a complete set containing database, keystore, secrets, and promotion records.
- A rollback after custody or database state changes restores the complete pre-upgrade set; changing only the
  image is not represented as rollback.

## Required gates

The PR must pass typecheck, the complete bounded suite inventory, production-image smoke, release bundle and
verification, fresh/restart/upgrade/rollback lifecycle, catalog and Jellyfin browser acceptance, release
candidate acceptance, and final rehearsal. Publishing remains release-event-only and must prove anonymous
pull of the exact published digest before attaching the consumer archive.
