# Phase 167 - O4 Custodian Direction Decision

Report id: `phase-167-o4-custodian-direction-decision`

Phase 167 records the next recommended direction for O4 without closing O4. The selected direction is
an external local sidecar custodian: a separate local service boundary that owns custodian state and
attestation behavior while preserving the Unraid/self-hosted deployment posture.

## Decision

Recommended next path: `external-local-sidecar-custodian`.

This is the best fit for the current system because it moves key custody outside the app process and
app database without forcing a cloud KMS dependency into the first public Unraid posture. It also
matches the existing sidecar planning and preflight work already present in the repo.

## Options Considered

| Option | Status | Reason |
|---|---|---|
| External local sidecar custodian | recommended | Preserves self-hosted operation, creates a separate custody boundary, and can be validated with local Unraid evidence. |
| Managed cloud KMS | deferred | Strong custody model, but adds cloud account, SDK, network, IAM, and operator complexity before the local deployment is settled. |
| Continue `FileCustodian` as accepted-risk reference harness | current fallback only | Useful for local operation and tests, but it must not be represented as production KMS. |

## Implementation Boundary

This phase is a direction record only. It does not add a daemon, install a service, change Compose,
contact a KMS, contact a provider, or change key-destruction semantics.

Future implementation work must still provide:

- a reviewed sidecar service boundary;
- redaction-safe O4 descriptor evidence;
- deterministic attestation behavior that the app cannot forge;
- fail-closed read/status behavior;
- durable non-secret tombstones;
- backup/restore evidence showing app DB backups cannot resurrect identity;
- an explicit O4 closure gate after review.

## Scope Guard

O4 remains open. This phase does not close O4. It also does not close O5.

Still forbidden: no provider contact, no scraping, no downloading, no playback, no Real-Debrid live
mode, no TorBox live provider mode, no Plex/Jellyfin mutation, and no media-server library writes.

`FileCustodian` remains a hardened reference harness, not production KMS.

