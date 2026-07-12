# Phase 180 - Arcane Final Button Checklist

Report id: `phase-180-arcane-final-button-checklist`

Phase 180 is the final Arcane button checklist for Launch v1. These buttons are enough to operate and
validate the backend/operator launch without exposing secret-printing, restore, mutating KEK, provider,
or media controls.

## Required Buttons

| Button | Exact command |
|---|---|
| `start-ui` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh start-ui` |
| `restart-ui` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh restart-ui` |
| `status` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh status` |
| `ui-live-check` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check` |
| `ui-live-check-save` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check-save` |
| `ui-evidence-review` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-evidence-review <saved-ui-evidence.json>` |
| `o4-o5-evidence-capture` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh o4-o5-evidence-capture` |
| `o4-o5-packet-review` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh o4-o5-packet-review <saved-o4-o5-packet.json>` |
| `ui-logs` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-logs` |
| `ui-token-status` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-token-status` |

## Optional Shell-Only Commands

Keep these out of default Arcane buttons unless the operator intentionally adds them:

- `doctor`;
- `backup`;
- `rewrap-plan`.

## Forbidden Buttons

Do not add buttons for token printing, backup restore, mutating KEK rotation, database shell access,
provider contact, scraping, downloading, playback, Real-Debrid live mode, TorBox live provider mode,
Plex/Jellyfin mutation, or media-server library writes.

O4 remains open. O5 remains open. This checklist does not close O4 and does not close O5.

