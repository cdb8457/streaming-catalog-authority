# Phase 174 - Arcane O4/O5 Packet Review

Report id: `phase-174-arcane-o4-o5-packet-review`

Phase 174 extends the Arcane operator button list with two O4/O5 evidence controls. Both are
read-only/static evidence controls and do not authorize provider or media behavior.

## Buttons

| Button | Exact command | Description |
|---|---|---|
| `o4-o5-evidence-capture` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh o4-o5-evidence-capture` | Captures a redaction-safe O4/O5 packet bundle from templates and static preflight outputs. |
| `o4-o5-packet-review` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh o4-o5-packet-review <packet-file>` | Reviews saved Phase 166 packet JSON for valid JSON, schema, open gates, forbidden boundary, and redaction safety. |

The second command intentionally requires the operator to provide an explicit packet file. Arcane
should not scan the evidence directory automatically.

## Forbidden Buttons

Do not add Arcane buttons for token printing, database shell access, backup restore, mutating KEK
rotation, provider contact, scraping, downloading, playback, Real-Debrid live mode, TorBox live
provider mode, Plex/Jellyfin mutation, or media-server library writes.

O4 remains open. O5 remains open. This phase does not close O4 and does not close O5.

