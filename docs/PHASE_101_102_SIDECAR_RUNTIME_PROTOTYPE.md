# Phase 101/102 - Sidecar Runtime Prototype and Evidence

Phase 101/102 combines the next two custody-hardening steps into one prototype: a local sidecar
runtime over local IPC plus a deterministic redaction-safe evidence packet.

This phase implements:

- `startLocalSidecarRuntime`, a local socket runtime wrapper around the Phase 98 sidecar protocol;
- `UnixSocketSidecarTransport`, a catalog-side client transport for local IPC;
- `ops:sidecar-runtime-evidence`, a one-shot command that starts the prototype, exercises the
  runtime, packages labels into the Phase 100 evidence manifest, then stops the runtime.

This is still a prototype. It adds no TCP listener, no HTTP API, no LAN exposure, no reverse proxy,
no Docker topology, no Unraid service install, no cloud KMS, no vendor SDK, no provider adapter, no
media-server workflow, no UI, and no production live validation.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.

## Runtime Shape

The runtime accepts exactly the JSON-shaped Phase 98 sidecar request/response operations:

- `provision`
- `commitProvision`
- `get`
- `destroy`
- `status`
- `listStaleProvisioning`

The test suite exercises the runtime through a local socket only. It rejects network endpoint shapes
such as `host:port`, `http://...`, and `https://...`.

## Evidence Shape

The evidence command emits `phase-101-102-sidecar-runtime-evidence` with:

- `runtimePrototypeImplemented: true`
- `localSocketExercised: true`
- `tcpListenerAllowed: false`
- `httpApiAllowed: false`
- `serviceInstallAllowed: false`
- `liveValidationAllowed: false`
- `closesO4: false`

The evidence output uses fixed labels and pass/fail counts. It does not emit socket paths, key IDs,
DEKs, base64 key material, raw receipts, raw attestations, secret values, database URLs, provider
references, media titles, or live service responses.

## Command

```sh
npm run ops:sidecar-runtime-evidence -- -- --json
```

The command is a deterministic local prototype run. It starts only a temporary local IPC runtime,
does not bind TCP, does not expose HTTP, does not install or supervise a service, does not contact
live services, does not read production secrets, and does not mutate Unraid.
