# Phase 184 - Sidecar Implementation Workplan

Report id: `phase-184-sidecar-implementation-workplan`

Phase 184 turns the Phase 181 through 183 sidecar custody design into a build sequence. This is a
workplan only. It does not create a daemon, install an Unraid service, modify
`docker-compose.unraid.runtime.yml`, start a sidecar, switch `CUSTODIAN_MODE`, close O4, or close O5.

## Build Sequence

1. Create a sidecar executable entrypoint around the existing local sidecar runtime prototype.
2. Add a Unix domain socket listener with owner-only socket permissions.
3. Move durable state behind a sidecar-owned state store under
   `/mnt/user/appdata/catalog/sidecar/state`.
4. Add a client transport adapter that lets the app call only the Phase 181 operations.
5. Add restart, restore-mismatch, stale-provisional, lost-ack, and corrupt-state tests.
6. Add a reviewed Compose draft for `custodian-sidecar` with no published ports.
7. Add redaction-safe evidence commands before any runtime cutover is allowed.

## Review Units

Each implementation unit should be independently reviewable:

- executable and command-line configuration;
- socket lifecycle and permission handling;
- sidecar-owned state format and migrations;
- client transport mapping to `provision`, `commitProvision`, `get`, `destroy`, `status`, and
  `listStaleProvisioning`;
- attestation generation and verification;
- Unraid appdata layout;
- rollback and fail-closed behavior.

## Forbidden In This Phase

- provider adapters;
- scraping;
- downloading;
- playback;
- Plex/Jellyfin mutation;
- media-server library writes;
- published sidecar ports;
- HTTP sidecar API;
- reverse proxy exposure;
- production custody cutover.

## Review Status

Recommended next status: `ready-for-sidecar-implementation-planning-review`.

O4 remains open. O5 remains open. This phase does not close O4 and does not close O5.
