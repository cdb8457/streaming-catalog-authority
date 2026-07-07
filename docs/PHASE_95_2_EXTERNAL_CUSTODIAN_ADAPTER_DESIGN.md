# Phase 95.2 - External Custodian Adapter Design

Phase 95.2 designs the first production external-custodian adapter boundary without implementing it.
It does not add an adapter, sidecar, cloud SDK, vendor SDK, HTTP service, daemon, network client,
Docker topology, scheduler, provider integration, media-server workflow, UI, or runtime behavior.

This phase does not close O4 or O5. It turns the existing `KeyCustodian` contract, production
custodian descriptor, and Phase 95.1 evidence packet into a reviewable design boundary for a later
explicitly-authorized implementation phase.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.

## Design Goal

The future adapter must move key custody outside the app process and app database trust boundary
while preserving the current crypto-shredding semantics:

- the catalog app cannot decrypt identity fields without the custodian;
- database backups do not contain custodian key material;
- destruction remains terminal, durable, idempotent, and retry-safe;
- ambiguous custodian outcomes fail closed;
- evidence remains redaction-safe and label-only unless a reviewer explicitly opens local evidence.

## Non-Goals

- Selecting a vendor or managed KMS.
- Implementing a local sidecar.
- Adding RPC, IPC, HTTP, TLS, gRPC, message queues, sockets, SDKs, or network code.
- Changing the `KeyCustodian` contract.
- Changing catalog encryption semantics.
- Installing Unraid services or Docker Compose runtime topology.
- Closing O4.
- Closing O5.

## Candidate Directions

### Direction A - Local Custodian Sidecar

A local sidecar would run outside the catalog app process and expose a narrow custodian protocol to
the one-shot ops/app runtime. It could be useful for Unraid deployments where the operator wants a
self-hosted custody boundary without a cloud dependency.

Required design constraints:

- distinct process boundary from the catalog app;
- distinct storage boundary from Postgres data and catalog backups;
- explicit authentication between app and sidecar;
- no fallback to in-process `FileCustodian` in production mode;
- durable non-secret tombstones or receipts for destruction;
- idempotency state outside the catalog DB or independently verifiable by the custodian;
- operator-run live validation outside CI;
- restore behavior that fails closed until sidecar prerequisites are restored or reattached.

Open questions:

- IPC mechanism and authentication model;
- where sidecar state lives on Unraid;
- how sidecar state is backed up without rejoining catalog DB backups;
- whether the sidecar has independent passphrase or hardware-backed custody;
- how receipts are encoded without leaking key ids, raw handles, or secrets.

### Direction B - Managed KMS or External Custodian Service

A managed custodian would use an external service controlled outside the catalog host. This can
strengthen custody separation but introduces transport, auth, availability, and operator-account
risks that must fail closed.

Required design constraints:

- no SDK or service dependency in CI;
- live validation is operator-run only;
- external credentials are never stored in repo, committed evidence, or catalog backups;
- auth, timeout, throttling, integrity, ambiguity, and service errors fail closed;
- destruction receipts or tombstones are stable and verifiable without printing secret values;
- restored catalog DB cannot decrypt until external service prerequisites are supplied;
- evidence labels name reports, not accounts, URLs, key ids, tokens, or raw receipts.

Open questions:

- vendor-neutral contract subset versus adapter-specific superset;
- whether account/project/tenant boundaries can be proven without exposing identifiers;
- rotation and custody ownership split between O4 and O5;
- how to retain enough receipt evidence for review while keeping receipt values out of committed
  artifacts.

## Proposed Adapter Boundary

A later implementation should preserve a narrow boundary around the existing custodian contract:

- `store` or equivalent key creation/wrapping must return only opaque, non-secret handles to the app;
- `read` must return key material only after successful custodian authorization and integrity checks;
- `destroy` must produce terminal custodian state even if called repeatedly;
- `status` must not prove custody by returning sensitive values;
- all methods must classify failures into redaction-safe categories;
- no method may silently fall back to local memory, file harness mode, stale cache, default keys, or
  app-database material.

The future adapter may add stricter adapter-specific checks, but it must still pass the shared
contract kit or a documented stricter superset.

## Failure-Mode Matrix

| Failure mode | Required behavior | Evidence label |
| --- | --- | --- |
| Custodian unavailable | Fail closed; no fallback key material | `custodian-unavailable-fail-closed` |
| Auth rejected or expired | Fail closed; no retry with weaker auth | `custodian-auth-fail-closed` |
| Timeout | Fail closed; classify as ambiguous if completion is unknown | `custodian-timeout-fail-closed` |
| Ambiguous destroy result | Treat as not safely readable by app; require reconciliation | `custodian-ambiguous-destroy` |
| Receipt integrity failure | Fail validation; do not accept forged completion | `custodian-receipt-integrity-failed` |
| Replay or duplicate destroy | Idempotent terminal state | `custodian-destroy-idempotent` |
| Restored DB without custodian | Identity decrypt fails closed | `restore-without-custodian-fail-closed` |
| Stale local cache | Must not return stale key material | `custodian-stale-cache-refused` |
| Unsupported mode | Config parsing fails closed | `unsupported-custodian-mode-refused` |
| Redaction violation | Evidence review fails | `custodian-redaction-review-failed` |

## Evidence Plan

The future implementation phase must produce labels that can fit the Phase 95.1 packet:

- `custodianDescriptorLabel`;
- `custodianPreflightReportLabel`;
- `contractKitEvidenceLabel`;
- `liveCustodianEvidenceLabel`;
- `attestationFormatLabel`;
- `backupRestoreFailClosedLabel`;
- `redactionReviewLabel`;
- `residualRiskLabel`.

Evidence must not include:

- key material, wrapping keys, receipt values, raw handles, private keys, passphrases, credentials, or
  tokens;
- service URLs, account identifiers, tenant identifiers, secret paths, database URLs, raw logs,
  command output blobs, backup contents, ciphertext, tombstone contents, provider refs, media titles,
  or artifact contents.

## Test Harness Plan

A later implementation should reuse the existing contract approach:

- run the shared `runCustodianContract` behavior against the adapter or a stricter superset;
- add adapter-specific tests for transport/auth/quorum/timeouts only after implementation is
  explicitly authorized;
- keep deterministic unit tests offline;
- keep live custodian validation out of CI;
- require an operator-run evidence command or runbook for live validation;
- keep hostile-value and redaction tests around all descriptor and evidence output.

## Unraid Deployment Considerations

No Unraid topology is selected in this phase. A later implementation decision must choose:

- whether the custodian runs as a local sidecar, external managed service, or another boundary;
- where custodian state lives relative to `/mnt/user/appdata/catalog`;
- how custodian state avoids catalog DB backup coupling;
- whether and how the custodian service starts on boot;
- how operator-run validation is performed without exposing secrets;
- how restore rehearsal proves fail-closed behavior without embedding custodian secrets in evidence.

## Authorization Gate

Before any implementation begins, require an explicit operator decision that names:

- chosen direction: local sidecar, managed KMS/external service, or defer;
- target Unraid topology;
- allowed live-service contact for operator-run commands;
- accepted evidence labels;
- reviewer needed before O4 can be considered for closure.

Until that decision exists, this document is design-only and cannot be used as evidence that O4 is
closed.
