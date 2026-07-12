# Phase 189 - Sidecar Factory Evidence

Report id: `phase-189-sidecar-factory-evidence`

Phase 189 adds `ops:sidecar-factory-evidence`, a redaction-safe evidence command that starts a
temporary local sidecar daemon, builds the app-side `CUSTODIAN_MODE=sidecar` client through the
custodian factory, performs a provision/commit/get/destroy round trip, and exits. It does not modify
`docker-compose.unraid.runtime.yml`, install a service, start a production sidecar, rebuild the live
image, switch runtime custody mode, close O4, or close O5.

## Command

```bash
npm run ops:sidecar-factory-evidence -- -- --json
```

## Evidence Shape

The emitted report uses:

- `report: phase-189-sidecar-factory-evidence`
- `code: SIDECAR_FACTORY_EVIDENCE`
- `daemonWrapperExercised: true`
- `custodianFactorySidecarModeExercised: true`
- `localSocketOnly: true`
- `appHeldCompletionSecretRequired: false`
- `appHeldKekRequired: false`
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

- temporary local sidecar process during the command;
- temporary state, secret, and KEK files under the OS temp directory;
- factory-created sidecar client round-trip evidence;
- redaction-safe JSON and text output.

Forbidden in this phase:

- Compose changes;
- Unraid service install;
- production sidecar start;
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

Recommended next status: `ready-for-sidecar-factory-evidence-review`.

O4 remains open. O5 remains open. This phase does not close O4 and does not close O5.
