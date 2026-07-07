# Phase 95.4 - Implementation Authorization Gate

Phase 95.4 defines the minimum operator decision required before any real O4/O5 implementation can
begin. It does not add a CLI, adapter, sidecar, cloud SDK, vendor SDK, HTTP service, daemon, network
client, scheduler, managed secret-store client, Unraid service, provider integration, media-server
workflow, UI, or runtime behavior.

This phase does not close O4 or O5. It is a planning hold gate: until the decision record exists,
implementation remains unauthorized.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.

## Required Decision Record

Before any implementation branch starts, the operator decision must name:

- `decisionLabel`: non-secret label for the decision record;
- `o4CustodianDirection`: `local-sidecar`, `managed-external-service`, `defer`, or another explicitly
  reviewed direction;
- `o5CustodyDirection`: `operator-held-secret-media`, `managed-secret-store`,
  `external-custodian-owned-kek`, `defer`, or another explicitly reviewed direction;
- `unraidDeploymentMode`: target topology label only;
- `liveServiceContactAllowed`: whether operator-run commands may contact a live custodian, managed
  secret store, or external service;
- `implementationScopeLabel`: the exact implementation slice authorized;
- `requiredEvidenceLabels`: evidence labels required before any later closure review;
- `reviewerLabel`: reviewer/operator label required before O4 or O5 can be considered for closure;
- `residualRiskLabel`: accepted, rejected, or pending residual risk label.

The decision record must not include keys, passphrases, credentials, service URLs, account IDs,
tenant IDs, secret paths, database URLs, raw logs, command output blobs, receipt values, backup
contents, ciphertext, provider refs, media titles, or artifact contents.

## Hold Conditions

Implementation must remain on hold if any of these are true:

- O4 direction is not selected and implementation would touch custodian runtime behavior;
- O5 direction is not selected and implementation would touch KEK custody, managed secrets, or
  rotation automation;
- live service contact is ambiguous;
- required evidence labels are missing;
- reviewer responsibility is missing;
- redaction rules are not accepted;
- Unraid topology is ambiguous;
- scope includes provider adapters, Real-Debrid, TorBox, Plex, Jellyfin, scraping, downloading,
  playback, HTTP UI, mobile UI, or media-server workflows;
- implementation would add SDKs, network clients, schedulers, or services outside the selected
  direction.

## Redaction-Safe Example

```json
{
  "decisionLabel": "phase-95-implementation-decision-pending",
  "o4CustodianDirection": "defer",
  "o5CustodyDirection": "operator-held-secret-media",
  "unraidDeploymentMode": "catalog-one-shot-ops-bind-mounted",
  "liveServiceContactAllowed": false,
  "implementationScopeLabel": "docs-only-no-runtime-implementation",
  "requiredEvidenceLabels": [
    "o4-o5-readiness-packet-redacted",
    "custodian-preflight-pending",
    "kek-preflight-pending",
    "kek-rewrap-plan-redacted",
    "redaction-review-pending"
  ],
  "reviewerLabel": "reviewer-required-before-o4-o5-closure",
  "residualRiskLabel": "o4-o5-deferred-risk-accepted-redacted",
  "closesO4": false,
  "closesO5": false
}
```

This example keeps implementation on hold. It is not an approval to build a custodian, managed KMS
adapter, scheduler, secret-store integration, or runtime automation.

## Authorized Work Shapes

The decision record may authorize one narrow slice at a time, for example:

- descriptor-only fixture updates;
- contract-harness expansion without live service contact;
- local sidecar prototype in an isolated branch;
- managed secret-store preflight design;
- operator-run live validation runbook.

Each authorized slice must preserve:

- deterministic offline CI unless live validation is explicitly operator-run and outside CI;
- redaction-safe outputs;
- fail-closed behavior;
- no provider/media/UI scope;
- no O4/O5 closure without separate reviewed evidence.

## Closure Boundary

Even after an implementation is authorized, O4 and O5 cannot close until separate reviewer/operator
evidence proves the target state described in Phase 95:

- O4 requires a real external/managed custodian implementation and reviewed live/operator evidence.
- O5 requires managed KEK custody and rotation automation evidence, or explicit residual-risk
  handling accepted by the reviewer/operator.

This gate authorizes implementation only. It is not production readiness, launch approval, O4
closure, or O5 closure.

## Next-Step Rule

If the decision record is missing or incomplete, the next step remains planning, review, or evidence
label consolidation. Do not start implementation by inference.
