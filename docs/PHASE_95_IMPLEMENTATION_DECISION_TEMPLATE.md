# Phase 95 - Implementation Decision Template

This template records the operator decision required by
`docs/PHASE_95_4_IMPLEMENTATION_AUTHORIZATION_GATE.md`.

Default state is HOLD. Do not treat this template, or an incomplete copy of it, as approval to build
an O4 custodian, managed KMS adapter, secret-store integration, scheduler, service, network client, or
runtime automation.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.

## Decision Record

```json
{
  "decisionLabel": "phase-95-implementation-decision-hold",
  "decisionStatus": "hold",
  "o4CustodianDirection": "defer",
  "o5CustodyDirection": "defer",
  "unraidDeploymentMode": "catalog-one-shot-ops-bind-mounted",
  "liveServiceContactAllowed": false,
  "implementationScopeLabel": "no-implementation-authorized",
  "requiredEvidenceLabels": [
    "phase-95-review-handoff",
    "o4-o5-readiness-packet-redacted",
    "custodian-preflight-pending",
    "kek-preflight-pending",
    "kek-rewrap-plan-redacted",
    "redaction-review-pending"
  ],
  "reviewerLabel": "reviewer-required-before-o4-o5-closure",
  "residualRiskLabel": "o4-o5-residual-risk-pending",
  "closesO4": false,
  "closesO5": false
}
```

## Allowed Values

`decisionStatus`:

- `hold`
- `authorize-one-slice`
- `defer`

`o4CustodianDirection`:

- `defer`
- `local-sidecar`
- `managed-external-service`
- `other-reviewed-direction`

`o5CustodyDirection`:

- `defer`
- `operator-held-secret-media`
- `managed-secret-store`
- `external-custodian-owned-kek`
- `other-reviewed-direction`

`liveServiceContactAllowed`:

- `false`: no live custodian, KMS, managed secret store, cloud, vendor, or external-service contact.
- `true`: operator-run live contact may occur only in the explicitly authorized slice and remains out
  of CI.

## Required Before `authorize-one-slice`

To authorize a narrow implementation slice, replace the HOLD defaults with:

- a concrete `decisionLabel`;
- `decisionStatus: "authorize-one-slice"`;
- one selected O4 or O5 direction;
- a single narrow `implementationScopeLabel`;
- specific redaction-safe evidence labels;
- a reviewer label;
- residual-risk status;
- explicit statement that `closesO4` and `closesO5` remain false.

If any field is missing, ambiguous, or contains sensitive values, the decision is invalid and the
project remains on HOLD.

## Forbidden In Decision Records

Do not include:

- KEKs, DEKs, wrapping keys, private keys, age identities, passphrases, API keys, bearer tokens,
  credentials, secret file contents, secret paths, or environment dumps;
- database URLs, connection strings, service URLs, account IDs, tenant IDs, raw logs, command output
  blobs, receipt values, tombstone contents, backup contents, ciphertext, provider refs, media titles,
  provider/debrid identifiers, Jellyfin/Plex identifiers, or artifact contents;
- implementation directions that include provider adapters, Real-Debrid, TorBox, Plex, Jellyfin,
  scraping, downloading, playback, web UI, mobile UI, HTTP service, or media-server workflows.

## Example Authorized Slice

This example authorizes only descriptor/contract-harness planning. It still does not authorize live
service contact or runtime implementation.

```json
{
  "decisionLabel": "phase-95-contract-harness-expansion-redacted",
  "decisionStatus": "authorize-one-slice",
  "o4CustodianDirection": "defer",
  "o5CustodyDirection": "defer",
  "unraidDeploymentMode": "catalog-one-shot-ops-bind-mounted",
  "liveServiceContactAllowed": false,
  "implementationScopeLabel": "contract-harness-expansion-without-live-service-contact",
  "requiredEvidenceLabels": [
    "phase-95-review-handoff",
    "production-custodian-contract-existing",
    "custodian-acceptance-harness-existing",
    "redaction-review-required"
  ],
  "reviewerLabel": "reviewer-required-before-o4-o5-closure",
  "residualRiskLabel": "o4-o5-residual-risk-pending",
  "closesO4": false,
  "closesO5": false
}
```

## Review Rule

The next agent or reviewer must reject a decision record if it:

- omits the decision status;
- authorizes more than one implementation slice;
- allows live contact without naming the live-contact boundary;
- contains sensitive material;
- implies O4 or O5 closure;
- expands into provider/media/UI scope.

Until a valid decision record exists, continue planning or review only.
