# Phase 100 - Sidecar Evidence Harness Packet

Phase 100 defines the redaction-safe evidence manifest required before the future self-hosted
sidecar can be reviewed for O4. It does not run the sidecar, read logs, inspect backups, open
sockets, contact live services, or approve production.

This phase adds no daemon, no socket listener, no HTTP API, no TCP listener, no Docker topology, no
Unraid service install, no cloud KMS, no vendor SDK, no provider adapter, no media-server workflow,
no UI, and no live validation execution.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.

## Manifest Contract

The manifest must use labels and booleans only. It must not include secrets, paths, raw logs, raw
key material, provider references, media titles, database URLs, backup archive contents, service
response bodies, or credentials.

Required labels:

- `runtimeDesignLabel`
- `contractKitLabel`
- `failureInjectionLabel`
- `attestationLabel`
- `redactionReviewLabel`
- `backupRestoreLabel`
- `operatorAcceptanceLabel`
- `reviewerAcceptanceLabel`

Required true fields:

- `sidecarProcessImplemented`
- `unixSocketBoundaryImplemented`
- `independentSidecarStateImplemented`
- `appCannotForgeAttestation`
- `noRawSecretsInEvidence`
- `restoreWithoutSidecarFailsClosed`

The packet can classify a manifest as ready for review, but it never closes O4 or O5. O4 closure
still requires separate reviewer and operator acceptance after real implementation evidence exists.

## Command

```sh
npm run ops:sidecar-evidence-harness-packet -- -- --json
```

The command is static and redaction-safe. It does not read environment variables, scan directories,
open sockets, start services, contact live services, read key files, run Docker, or mutate Unraid.
