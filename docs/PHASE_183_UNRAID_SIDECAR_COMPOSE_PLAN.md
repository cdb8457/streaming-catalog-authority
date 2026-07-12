# Phase 183 - Unraid Sidecar Compose Plan

Report id: `phase-183-unraid-sidecar-compose-plan`

Phase 183 defines how a future local sidecar custodian would fit into the Unraid runtime Compose
topology. This is a plan only. It does not modify `docker-compose.unraid.runtime.yml`, build a sidecar
image, start a service, install an Unraid script, or close O4/O5.

## Planned Service Shape

Future service name: `custodian-sidecar`.

Planned properties:

- image: a reviewed local sidecar image, not the current `repo-ops:latest` app image by default;
- network: no published ports;
- socket: Unix domain socket bind-mounted through appdata;
- state: bind-mounted sidecar state directory under `/mnt/user/appdata/catalog/sidecar/state`;
- logs: redaction-safe sidecar logs under `/mnt/user/appdata/catalog/sidecar/logs`;
- healthcheck: local socket readiness check only;
- restart policy: `unless-stopped` after implementation review.

## Planned Mounts

```text
/mnt/user/appdata/catalog/sidecar/state:/var/lib/catalog-sidecar/state
/mnt/user/appdata/catalog/sidecar/run:/var/run/catalog-sidecar
/mnt/user/appdata/catalog/sidecar/logs:/var/log/catalog-sidecar
```

The app and ops containers should receive only the socket path, not direct state or secret-material
mounts.

## Compose Boundary

Allowed future Compose change after review:

- add `custodian-sidecar`;
- add socket bind mount to app/ops;
- switch custodian mode from `file` to `sidecar`;
- keep Postgres and operator UI unchanged.

Still forbidden in this plan:

- TCP listener;
- HTTP API;
- published sidecar ports;
- reverse proxy exposure;
- provider contact;
- scraping;
- downloading;
- playback;
- Plex/Jellyfin mutation;
- media-server library writes.

## Review Status

Recommended next status: `ready-for-sidecar-compose-design-review`.

O4 remains open. O5 remains open. This phase does not close O4 and does not close O5.

