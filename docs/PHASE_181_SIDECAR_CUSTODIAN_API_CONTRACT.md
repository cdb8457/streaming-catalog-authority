# Phase 181 - Sidecar Custodian API Contract

Report id: `phase-181-sidecar-custodian-api-contract`

Phase 181 defines the Launch v1 follow-on API contract for the local sidecar custodian. This is a
design contract only. It does not add a daemon, socket listener, Docker service, Compose change,
provider integration, media-server workflow, O4 closure, or O5 closure.

## Transport Boundary

- transport: local Unix domain socket only;
- listener: no TCP listener, no HTTP API, no LAN exposure;
- caller: Catalog Authority app/ops containers only;
- permissions: owner-only socket path under appdata;
- failure mode: transport errors fail closed and never return synthetic key state.

## Operations

| Operation | Purpose | Required fail-closed behavior |
|---|---|---|
| `provision` | Create a provisional DEK for an item/operation/epoch. | Reused operation ids with different inputs are rejected. |
| `commitProvision` | Promote a provisional key to active after DB commit. | Lost acknowledgements are idempotent and never create a second active key. |
| `get` | Return active key material only for the exact item/epoch. | Unknown, provisional, destroyed, wrong-epoch, corrupt, unavailable, or ambiguous state fails closed. |
| `destroy` | Destroy key lineage and write a durable tombstone. | Repeated destroys return stable non-secret receipt metadata. |
| `status` | Return non-secret key lifecycle status. | Service/auth/integrity failures throw transport errors, not fake statuses. |
| `listStaleProvisioning` | Expose stale provisional keys for reconciliation. | Active/destroyed keys are excluded. |

## Attestation Contract

The sidecar owns destruction attestation. The app must not be able to forge completion receipts.

Required receipt fields are non-secret labels only:

- receipt version;
- item id;
- key id;
- operation id;
- epoch;
- destroyed timestamp;
- sidecar instance label;
- attestation signature or MAC label.

The design must not log or return KEKs, DEKs, wrapping keys, private keys, database URLs, secret file
contents, raw logs, provider refs, media titles, or backup bodies.

## Review Status

Recommended next status: `ready-for-sidecar-api-design-review`.

O4 remains open. O5 remains open. This phase does not close O4 and does not close O5.

