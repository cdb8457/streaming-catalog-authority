# Phase 99 - Sidecar Runtime Design Packet

Phase 99 chooses the next production-hardening shape for O4 without implementing a daemon. The
selected direction is a separate local custodian sidecar process on the Unraid host, reached through
a Unix domain socket under appdata with owner-only filesystem permissions.

This phase adds no daemon, no socket listener, no HTTP API, no TCP listener, no Docker topology, no
Unraid service install, no cloud KMS, no vendor SDK, no provider adapter, no media-server workflow,
no UI, and no live validation execution.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.

## Selected Boundary

- `process-boundary`: run the custodian outside the catalog app process.
- `ipc-boundary`: use a local Unix domain socket, not LAN-visible TCP.
- `state-boundary`: store sidecar state outside the catalog database and outside DB backups.
- `attestation-boundary`: make destruction receipts sidecar-attested so the app cannot forge them.
- `supervision-boundary`: defer concrete Unraid service installation until implementation.

The Phase 98 `LocalSidecarCustodianClient` remains the client-side contract shape. Phase 99 only
chooses the runtime direction needed to turn that injected transport into a real self-hosted
boundary later.

## Implementation Backlog

The next implementation unit must still create the sidecar executable, Unix socket listener, state
store, sidecar transport adapter, fail-closed startup behavior, Unraid service wrapper instructions,
and independent sidecar backup/restore rehearsal.

## Evidence Prerequisites

Before O4 can be reviewed, the runtime must produce redaction-safe operator evidence for:

- contract-kit behavior;
- failure injection;
- app non-forgeability of destruction receipts;
- log/stdout/stderr redaction;
- backup/restore fail-closed behavior;
- operator and reviewer acceptance labels.

## Command

```sh
npm run ops:sidecar-runtime-design-packet -- -- --json
```

The command is static and redaction-safe. It does not read environment variables, scan directories,
open sockets, start services, contact live services, read key files, run Docker, or mutate Unraid.
