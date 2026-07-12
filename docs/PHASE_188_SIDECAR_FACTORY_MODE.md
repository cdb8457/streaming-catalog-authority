# Phase 188 - Sidecar Factory Mode

Report id: `phase-188-sidecar-factory-mode`

Phase 188 adds an app-side `CUSTODIAN_MODE=sidecar` factory mode. The mode constructs a
`LocalSidecarCustodianClient` over the local socket transport and requires
`CUSTODIAN_SIDECAR_SOCKET_PATH`. It does not modify `docker-compose.unraid.runtime.yml`, install or
start a sidecar service, change the current Unraid runtime environment, rebuild the live image, close
O4, or close O5.

## Configuration

Required when selected:

```text
CUSTODIAN_MODE=sidecar
CUSTODIAN_SIDECAR_SOCKET_PATH=/mnt/user/appdata/catalog/sidecar/run/catalog-sidecar.sock
```

The sidecar mode intentionally does not require app-held `COMPLETION_SECRET`, `CUSTODIAN_KEK`, or
`CUSTODIAN_KEYSTORE_DIR`. Those values belong to the sidecar boundary, not the app process.

## Boundary

Allowed in this phase:

- parse `CUSTODIAN_MODE=sidecar`;
- validate the socket path as local IPC only;
- build a `LocalSidecarCustodianClient`;
- prove local sidecar round-trip behavior in tests;
- fail closed when socket configuration is missing or network-shaped.

Forbidden in this phase:

- Compose changes;
- Unraid service install;
- runtime custody cutover;
- published ports;
- TCP listener;
- HTTP API;
- provider adapters;
- scraping;
- downloading;
- playback;
- Plex/Jellyfin mutation;
- media-server library writes.

## Evidence

The factory suite proves:

- sidecar mode parses without app-held secret or KEK;
- missing `CUSTODIAN_SIDECAR_SOCKET_PATH` fails closed;
- network-shaped socket values fail closed;
- `custodianFromEnv` can talk to a local test sidecar socket;
- destroyed keys remain fail-closed through the sidecar transport.

## Review Status

Recommended next status: `ready-for-sidecar-factory-mode-review`.

O4 remains open. O5 remains open. This phase does not close O4 and does not close O5.
