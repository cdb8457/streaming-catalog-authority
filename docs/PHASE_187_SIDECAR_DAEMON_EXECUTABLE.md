# Phase 187 - Sidecar Daemon Executable

Report id: `phase-187-sidecar-daemon-executable`

Phase 187 adds the first local sidecar daemon executable wrapper. It exposes the existing
sidecar runtime through a local Unix socket or Windows named pipe only and provides a finite
redaction-safe `--self-test` mode. This phase does not modify `docker-compose.unraid.runtime.yml`,
install an Unraid service, start a production sidecar, switch `CUSTODIAN_MODE`, close O4, or close
O5.

## Command

```bash
npm run ops:sidecar-daemon -- -- --self-test --json
```

Future controlled serve mode:

```bash
npm run ops:sidecar-daemon -- -- --serve \
  --socket /mnt/user/appdata/catalog/sidecar/run/catalog-sidecar.sock \
  --state-dir /mnt/user/appdata/catalog/sidecar/state \
  --completion-secret-file /run/secrets/sidecar_completion_secret \
  --kek-file /run/secrets/sidecar_kek
```

Environment fallback names:

- `SIDECAR_SOCKET_PATH`
- `SIDECAR_STATE_DIR`
- `SIDECAR_COMPLETION_SECRET_FILE`
- `SIDECAR_KEK_FILE`

## Evidence Shape

The `--self-test --json` output uses report label `phase-187-sidecar-daemon-self-test` and code
`SIDECAR_DAEMON_SELF_TEST`.

Required booleans:

- `executableImplemented: true`
- `localSocketOnly: true`
- `usesFileCustodianReferenceHarness: true`
- `serviceInstallAllowed: false`
- `composeChangeAllowed: false`
- `runtimeCutoverAllowed: false`
- `providerContactAllowed: false`
- `playbackAllowed: false`
- `mediaServerMutationAllowed: false`
- `closesO4: false`
- `closesO5: false`

## Boundary

Allowed in this phase:

- local process wrapper;
- local socket or named-pipe binding;
- owner-only state and run directories;
- redaction-safe self-test evidence;
- finite test execution that starts and stops the daemon.

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

## Review Status

Recommended next status: `ready-for-sidecar-daemon-executable-review`.

O4 remains open. O5 remains open. This phase does not close O4 and does not close O5.
