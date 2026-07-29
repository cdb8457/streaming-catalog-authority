# Handoff for review — v1.1.4 high-core keystore hotfix

Branch `cdb8457/v1-1-4-keystore-pids`, based on the published v1.1.3 merge
`88c9d1905f0d11a3d29c99be58a0aa263433f0a8`. v1.1.3 remains published and immutable.

## Defect and scope

The v1.1.3 consumer stacks deliberately limit the root-only `keystore-prepare` one-shot to 64 PIDs. On a
Docker host exposing 128 CPUs, `tsx` starts esbuild's Go helper before Catalog Authority code runs, and Go
attempts to create enough runtime threads to exhaust that limit. The one-shot exits before it can inspect or
repair the volume, which safely blocks migration and app startup but prevents a valid installation.

This hotfix adds `GOMAXPROCS=2` only to `keystore-prepare` in the ordinary runtime and Arcane/Unraid Compose
stacks. It does not widen the PID budget or alter the image, application logic, schema, data, secrets,
networking, capabilities, mounts, read-only filesystem or long-running container.

## Proof

The failure was reproduced with the published v1.1.3 digest on a 128-CPU Unraid host:

```
runtime: failed to create new OS thread
errno=11
```

Running the same image and Compose constraints with `GOMAXPROCS=2` returned `ALREADY_CORRECT`. With the bound
in the installed Compose file, the full stack then passed:

- keystore preparation and migration, followed by an idempotent restart;
- schema version 9 and a fully passing `ops:doctor` report apart from the documented O4/O5 warnings;
- least-privileged runtime database checks and authenticated v1.1.3 release agreement;
- import inbox, write-free preview, three-record apply and confirmation replay refusal;
- catalog list/detail and durable import history; and
- a repeat preview/apply with zero catalog changes and an auditable no-op history entry.

The complete pre-upgrade recovery set is stored on Tower at:

```
/mnt/user/projects/catalog-authority-v110-test/manual-backups/20260728T200100Z-v1.1.3-pre-upgrade
```

Its database dump, keystore, secrets, promotion records, Compose file, environment file, archive structure
and checksums were verified before the upgrade.

## Release identity and rollback

- `package.json` and the lockfile report `1.1.4`.
- The consumer bundle coordinate and shipped Compose defaults select `v1.1.4`.
- v1.1.4 remains schema version 9. Rolling between v1.1.3 and v1.1.4 requires no database or keystore
  restore.
- Publishing remains release-event-only. The workflow must build and label the image, resolve its digest,
  prove an anonymous digest pull, and attach the verified consumer bundle.

## Required gates

The PR must pass typecheck, complete bounded suites, production-image smoke, release bundle/verification,
fresh/restart/upgrade/rollback lifecycle, catalog and Jellyfin browser acceptance, release candidate
acceptance, and final rehearsal. The focused keystore suite additionally asserts `GOMAXPROCS=2` in both
consumer Compose stacks.

No live Jellyfin request, provider call, package visibility change or mutation of an earlier release is in
scope.
