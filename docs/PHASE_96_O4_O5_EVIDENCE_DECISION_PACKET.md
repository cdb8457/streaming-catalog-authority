# Phase 96 - O4/O5 Evidence Decision Packet

Phase 96 implements the first authorized O4/O5 evidence slice from the Phase 95.4 decision gate. It
is intentionally narrow: it combines one operator decision record, one O4 custodian descriptor, and
one O5 KEK descriptor into a redaction-safe review packet.

This phase does not add a real custodian adapter, sidecar, KMS client, secret-store client, cloud SDK,
vendor SDK, HTTP service, daemon, scheduler, provider integration, media-server workflow, playback,
download, scraping, UI, or runtime behavior.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.

## Authorized Slice

The only authorized scope is:

```text
contract-harness-expansion-without-live-service-contact
```

That scope allows deterministic descriptor/preflight consolidation and redaction tests. It does not
authorize runtime custodian implementation, managed KMS selection, managed secret-store contact,
mutating KEK rewrap, Unraid service installation, remote UI exposure, or live-service validation.

## CLI

Text output:

```sh
npm run ops:o4-o5-evidence-decision -- -- --decision <decision.json> --custodian <o4-descriptor.json> --kek <o5-descriptor.json>
```

JSON output:

```sh
npm run ops:o4-o5-evidence-decision -- -- --decision <decision.json> --custodian <o4-descriptor.json> --kek <o5-descriptor.json> --json
```

The command reads exactly three operator-supplied JSON files. It does not read environment variables,
scan directories, connect to a database, contact a custodian/KMS/secret store, run Docker, inspect
backup contents, inspect key files, mutate KEKs, contact providers, or expose a UI.

## Decision Requirements

The decision record must authorize exactly one offline slice:

```json
{
  "decisionLabel": "phase-96-contract-harness-expansion-redacted",
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
    "custodian-preflight-report-redacted",
    "kek-preflight-report-redacted",
    "kek-rewrap-plan-redacted",
    "redaction-review-required"
  ],
  "reviewerLabel": "reviewer-required-before-o4-o5-closure",
  "residualRiskLabel": "o4-o5-residual-risk-pending",
  "closesO4": false,
  "closesO5": false
}
```

Any live-service contact, runtime implementation scope, missing evidence labels, or implied O4/O5
closure makes the packet `not-authorized`.

## Output Semantics

The report uses fixed redaction-safe values:

- `report: "phase-96-o4-o5-evidence-decision-packet"`
- `authorizedScope: "contract-harness-expansion-without-live-service-contact"` only when every
  decision and descriptor preflight check passes
- `runtimeImplementationAuthorized: false`
- `liveServiceContactAllowed: false`
- `closesO4: false`
- `closesO5: false`

The command nests the existing Phase 29 O4 custodian preflight and Phase 30 O5 KEK preflight reports.
Those nested reports also remain descriptor-value silent and do not close O4/O5.

## Boundary

No live service contact is allowed. No provider, media-server, playback, download, scraping, or UI expansion is added.
No secrets, keys, passphrases, secret paths, database URLs, raw logs, command
output blobs, receipt values, backup contents, ciphertext, provider refs, media titles, or artifact
contents may appear in reports.

Phase 96 moves the evidence process forward; it is not production readiness, launch approval, O4
closure, or O5 closure.
