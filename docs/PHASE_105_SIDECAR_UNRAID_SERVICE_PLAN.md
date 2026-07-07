# Phase 105 - Sidecar Unraid Service Plan

Phase 105 defines the service-wrapper plan for running the local sidecar on Unraid later. It is a
plan packet only. It does not install, start, stop, or modify any Unraid service.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.

## Planned Layout

- `/mnt/user/appdata/streaming-catalog-authority/sidecar/state`
- `/mnt/user/appdata/streaming-catalog-authority/sidecar/run`
- `/mnt/user/appdata/streaming-catalog-authority/sidecar/logs`
- `/mnt/user/appdata/streaming-catalog-authority/catalog`

The sidecar state and run directories must be owner-only. The catalog app receives only the socket
path, not sidecar state secrets. Main catalog DB backups must exclude sidecar state and sidecar
secret material.

## Planned Wrapper Shape

- create appdata directories and permissions;
- start the sidecar process bound only to the Unix socket path;
- run a local socket readiness probe;
- stop the sidecar and remove stale socket files;
- defer boot-time service installation until a reviewed operator script exists.

The packet reports:

- `serviceInstalled: false`
- `serviceStarted: false`
- `mutatesUnraid: false`
- `tcpListenerAllowed: false`
- `httpApiAllowed: false`
- `lanExposureAllowed: false`
- `closesO4: false`

## Blocked Actions

This phase does not write `/boot/config/go`, install rc.d scripts, start a background daemon, bind
TCP ports, bind `0.0.0.0`, publish through a reverse proxy, add Docker or Compose topology, read
production secrets, contact live services, add provider/media-server/UI work, or claim O4/O5
closure.

## Command

```sh
npm run ops:sidecar-unraid-service-plan -- -- --json
```
