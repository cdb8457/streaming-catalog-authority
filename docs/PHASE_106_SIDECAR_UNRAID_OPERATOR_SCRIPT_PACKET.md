# Phase 106 - Sidecar Unraid Operator Script Packet

Phase 106 provides copy/paste-safe operator script shapes for a future Unraid sidecar run. The
packet does not execute commands, install services, start daemons, write boot files, or mutate
Unraid.

The packet reports `commandExecution: false`, `operatorRunRequired: true`, `mutatesUnraidNow:
false`, `serviceInstalled: false`, `tcpListenerAllowed: false`, `httpApiAllowed: false`, and
`closesO4: false`.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.

## Script Shapes

- setup appdata directories and owner-only sidecar permissions;
- start the sidecar bound only to the local socket path;
- run local socket health checks;
- stop the sidecar while retaining state and tombstones;
- collect redacted evidence labels.

## Blocked

The packet blocks automatic command execution, `/boot/config/go` changes, rc.d installs, boot-time
service registration, TCP listeners, `0.0.0.0`, reverse proxy publication, Docker topology changes,
live service contact in CI, provider/media-server/UI work, and O4/O5 closure claims.

## Command

```sh
npm run ops:sidecar-unraid-operator-script-packet -- -- --json
```
