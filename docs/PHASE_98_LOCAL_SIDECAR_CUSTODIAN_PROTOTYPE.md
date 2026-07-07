# Phase 98 - Local Sidecar Custodian Prototype

Phase 98 starts the recommended self-hosted O4 direction with an offline local-sidecar prototype. It
adds a `LocalSidecarCustodianClient` that implements the existing `KeyCustodian` contract through an
injected transport boundary, plus a deterministic test harness that dispatches requests to an
in-memory custodian.

This is a prototype contract boundary, not a production sidecar service. It adds no sockets, no
daemon, no HTTP service, no Docker topology, no Unraid service, no cloud SDK, no vendor SDK, no
managed KMS, no managed secret store, no scheduler, no provider integration, no media-server
workflow, and no UI.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.

## What It Adds

- `src/core/crypto/local-sidecar-custodian.ts`
- `test/local-sidecar-custodian.ts`
- `test:local-sidecar-custodian`

The client speaks a JSON-shaped protocol:

- `provision`
- `commitProvision`
- `get`
- `destroy`
- `status`
- `listStaleProvisioning`

DEKs cross the protocol as base64 strings and are validated back to exactly 32 bytes by the client.
Malformed responses fail closed as `CustodianTransportError`.

## Boundary

The transport is injected. This phase intentionally does not choose IPC, sockets, HTTP, gRPC, named
pipes, TLS, service supervision, Unraid startup behavior, backup policy for sidecar state, or
operator-run live validation.

The prototype proves:

- the sidecar-shaped client passes the shared `KeyCustodian` contract kit;
- transport failures throw instead of returning synthetic statuses or fallback key material;
- lost acknowledgement and idempotency semantics remain covered by the shared contract;
- redaction-safe evidence can describe the self-hosted boundary without printing secrets.

## Descriptor

The prototype descriptor reports:

```json
{
  "adapterName": "LocalSidecarCustodianClient",
  "adapterVersion": "phase-98-prototype",
  "custodyBoundary": "external-self-hosted",
  "implementsKeyCustodian": true,
  "attestationFormatDocumented": true,
  "durableTombstones": true,
  "appCannotForgeAttestation": true,
  "failClosedSemanticsDocumented": true,
  "liveValidationEvidenceLabel": "local-sidecar-prototype-contract-redacted",
  "contractKitCommandLabel": "test-local-sidecar-custodian-redacted",
  "redactionReviewStatus": "passed",
  "noRawSecretsInEvidence": true,
  "backupRestoreFailClosedEvidence": true
}
```

That descriptor can become ready for review, but it does not close O4. O4 still requires a real
sidecar process, independent state/custody boundary, operator-run evidence, restore fail-closed proof,
and reviewer/operator acceptance.

## Command

```sh
npm run test:local-sidecar-custodian
```

The command is deterministic and safe for CI. It does not read environment variables, scan
directories, connect to a database, run Docker, open sockets, contact live services, read key files,
or mutate Unraid.

