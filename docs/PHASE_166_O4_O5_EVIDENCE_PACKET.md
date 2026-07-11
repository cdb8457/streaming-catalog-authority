# Phase 166 - O4/O5 Evidence Packet

Report id: `phase-166-o4-o5-evidence-packet`

Phase 166 defines the redaction-safe packet shape for collecting O4 external custodian evidence and
O5 KEK custody/scheduling evidence before any closure review. This is a documentation and review
artifact only. It does not close O4, does not close O5, and does not add runtime behavior.

## Packet Purpose

The packet gives operators one place to gather the already-built static preflight outputs:

- O4 production custodian descriptor review from `ops:custodian-evidence-preflight`;
- O5 KEK custody/scheduling descriptor review from `ops:kek-evidence-preflight`;
- the existing offline decision slice from `ops:o4-o5-evidence-decision`;
- optional KEK rotation planning from `ops:rewrap-kek -- --plan --json`.

The packet is evidence indexing, not evidence scanning. It names artifacts by redacted labels and
review status only.

## Packet Shape

```json
{
  "packetReport": "phase-166-o4-o5-evidence-packet",
  "createdAt": "2026-07-11T00:00:00.000Z",
  "scope": "redaction-safe-o4-o5-evidence-index",
  "o4": {
    "descriptorPreflightLabel": "phase-29-redacted-o4-preflight",
    "custodianBoundary": "external-local-sidecar-custodian",
    "reviewStatus": "pending"
  },
  "o5": {
    "descriptorPreflightLabel": "phase-30-redacted-o5-preflight",
    "rewrapPlanLabel": "phase-166-redacted-rewrap-plan",
    "reviewStatus": "pending"
  },
  "decision": {
    "decisionPacketLabel": "phase-96-redacted-decision-packet",
    "closureRequested": false
  },
  "forbidden": [
    "no provider contact",
    "no scraping",
    "no downloading",
    "no playback"
  ],
  "openGates": ["O4 remains open", "O5 remains open"]
}
```

## Redaction Rules

Do not include tokens, KEKs, DEKs, wrapping keys, age identities, private keys, database URLs, raw
logs, environment dumps, backup contents, secret file contents, provider refs, media titles,
Jellyfin/Plex ids, TorBox/Real-Debrid identifiers, URLs, or artifact bodies.

Allowed values are fixed labels, timestamps, pass/warn/fail style review states, open-gate status,
and one-line reviewer notes with no secrets or identity values.

## Required Inputs

Before a reviewer can use this packet, the operator should have redaction-safe outputs from:

```bash
npm run ops:custodian-evidence-preflight -- -- <o4-descriptor.json> --json
npm run ops:kek-evidence-preflight -- -- <o5-descriptor.json> --json
npm run ops:o4-o5-evidence-decision -- -- --decision <decision.json> --custodian <o4-descriptor.json> --kek <o5-descriptor.json> --json
npm run ops:rewrap-kek -- --plan --json
```

The commands above remain static or planning commands. They do not contact provider services, do not
scan media, do not start playback, do not download content, and do not mutate media servers.

## Gate Semantics

This packet may make O4/O5 evidence easier to review, but it cannot close either gate.

- O4 remains open until an external or managed custodian implementation, live validation evidence,
  independent review, and explicit closure authorization are complete.
- O5 remains open until managed KEK custody, scheduling/rotation operations, independent review, and
  explicit closure authorization are complete.
- `FileCustodian` remains a hardened reference harness, not production KMS.

