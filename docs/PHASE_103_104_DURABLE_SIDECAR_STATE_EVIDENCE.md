# Phase 103/104 - Durable Sidecar State and Restore Evidence

Phase 103/104 combines durable sidecar-owned state with restart and restore-mismatch evidence. It
keeps the Phase 101/102 local socket runtime, but backs it with a sidecar-owned state directory using
the hardened `FileCustodian` reference harness.

This is still a prototype. `FileCustodian` remains a hardened reference harness, not production KMS.
O4 remains open/deferred. O5 remains open/deferred.

## What It Proves

The command `ops:sidecar-durable-state-evidence` starts local socket runtimes against temporary
sidecar-owned state directories and verifies:

- active key state survives a sidecar restart;
- destroyed tombstones survive a sidecar restart;
- destroyed keys remain unreadable after restart;
- a mismatched sidecar state directory returns `not_found` and cannot read the catalog key;
- the evidence contains labels and counts only.

The packet reports:

- `restartPersistenceExercised: true`
- `restoreFailClosedExercised: true`
- `sidecarStateValuesEchoed: false`
- `serviceInstallAllowed: false`
- `liveValidationAllowed: false`
- `closesO4: false`

## Boundaries

This phase adds no TCP listener, no HTTP API, no LAN exposure, no reverse proxy, no Docker topology,
no Unraid service install, no cloud KMS, no vendor SDK, no provider adapter, no media-server
workflow, no UI, and no production live validation.

It does not read production secrets, production databases, backups, provider refs, media titles, or
Unraid paths. It does not mutate Unraid.

## Command

```sh
npm run ops:sidecar-durable-state-evidence -- -- --json
```

The command uses temporary local state only and deletes it before exit.
