# Phase 169 - O4/O5 Evidence Templates

Report id: `phase-169-o4-o5-evidence-templates`

Phase 169 adds copy/paste-safe redacted JSON templates for the O4/O5 evidence path. The templates
are examples for operator-filled labels and boolean status only. They are not evidence artifacts by
themselves and do not close O4 or O5.

## Templates

| Template | Purpose |
|---|---|
| `docs/templates/O4_CUSTODIAN_DESCRIPTOR.redacted.json` | Input shape for `ops:custodian-evidence-preflight`. |
| `docs/templates/O5_KEK_DESCRIPTOR.redacted.json` | Input shape for `ops:kek-evidence-preflight`. |
| `docs/templates/O4_O5_DECISION_RECORD.redacted.json` | Input shape for `ops:o4-o5-evidence-decision`. |
| `docs/templates/O4_O5_EVIDENCE_PACKET.redacted.json` | Index shape from Phase 166 for retained evidence labels. |

## Redaction Boundary

The templates use redacted labels, fixed strings, booleans, and open-gate markers only. Operators must
not replace placeholders with tokens, KEKs, DEKs, wrapping keys, private keys, database URLs, raw logs,
secret file contents, provider refs, media titles, backup contents, or artifact bodies.

## Validation Commands

```bash
npm run ops:custodian-evidence-preflight -- -- docs/templates/O4_CUSTODIAN_DESCRIPTOR.redacted.json --json
npm run ops:kek-evidence-preflight -- -- docs/templates/O5_KEK_DESCRIPTOR.redacted.json --json
npm run ops:o4-o5-evidence-decision -- -- --decision docs/templates/O4_O5_DECISION_RECORD.redacted.json --custodian docs/templates/O4_CUSTODIAN_DESCRIPTOR.redacted.json --kek docs/templates/O5_KEK_DESCRIPTOR.redacted.json --json
```

These commands are static preflights over explicit JSON files. They do not contact a custodian, KMS,
provider, debrid service, media server, or network endpoint.

## Gate Semantics

O4 remains open. O5 remains open. This phase does not close O4 and does not close O5.

Still forbidden: no provider contact, no scraping, no downloading, no playback, no Real-Debrid live
mode, no TorBox live provider mode, no Plex/Jellyfin mutation, and no media-server library writes.

