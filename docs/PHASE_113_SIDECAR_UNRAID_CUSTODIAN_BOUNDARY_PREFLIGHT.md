# Phase 113 - Sidecar Unraid Custodian Boundary Preflight

Phase 113 adds `ops:sidecar-unraid-custodian-boundary-preflight` as a redaction-safe O4 preflight for the Phase 112 blocker `managed-custodian-sidecar-boundary-attestation-redacted`. The emitted report label is `phase-113-sidecar-unraid-custodian-boundary-preflight`.

The command is:

```bash
npm run --silent ops:sidecar-unraid-custodian-boundary-preflight -- -- path/to/sidecar-boundary.redacted.json --json
```

The descriptor input label is `single-redacted-sidecar-custodian-boundary-json-file`. The descriptor must prove fixed booleans for sidecar process separation, app inability to read raw DEKs, app inability to forge attestations, documented attestation format, durable non-secret tombstones, lost-ack recovery, restore mismatch fail-closed behavior, local-socket-only operation, no TCP/HTTP/LAN exposure, no provider contact, and no FileCustodian-as-production-KMS claim.

The preflight emits fixed findings only. It keeps `descriptorValuesEchoed: false`, `commandExecution: false`, `serviceInstalled: false`, `serviceStarted: false`, `providerContactAllowed: false`, `productionReady: false`, `closesO4: false`, and `closesO5: false`.

This phase does not mutate Unraid, install or start a service, contact live services, approve production readiness, close O4/O5, enable provider mode, read raw evidence, or expand Docker/Compose/UI/API/provider scope. O4/O5 remain open/deferred and FileCustodian remains a hardened reference harness.
