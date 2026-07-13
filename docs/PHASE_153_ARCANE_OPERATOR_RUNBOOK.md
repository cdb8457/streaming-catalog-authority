# Phase 153 - Arcane Operator Runbook

Report id: `phase-153-arcane-operator-runbook`

Add these Arcane custom command buttons for the Catalog Authority Unraid stack.

Canonical launcher:

```text
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh
```

| Button | Exact command | Description |
| --- | --- | --- |
| `start-ui` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh start-ui` | Starts Postgres and the read-only operator UI. |
| `status` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh status` | Shows the runtime Compose service state. |
| `ui-live-check` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check` | Runs the redaction-safe live UI check and prints JSON. |
| `ui-live-check-save` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check-save` | Saves redaction-safe live-check JSON evidence. |
| `ui-logs` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-logs` | Shows recent redacted operator UI Docker logs. |
| `ui-token-status` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-token-status` | Reports operator UI token-file metadata without printing the token. |
| `restart-ui` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh restart-ui` | Recreates the read-only operator UI container after ensuring Postgres is up. |
| `o4-o5-evidence-capture` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh o4-o5-evidence-capture` | Captures a redaction-safe O4/O5 packet bundle from templates and static preflight outputs. |
| `o4-o5-packet-review` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh o4-o5-packet-review <packet-file>` | Reviews one explicit saved Phase 166 packet JSON without scanning evidence directories. |
| `jellyfin-live-capture` | `/mnt/user/appdata/catalog/repo/deploy/unraid-jellyfin-live-capture.sh tmdb 603` | Runs the guarded read-only Jellyfin evidence capture after secret readiness passes. |

Do not add Arcane buttons for provider contact, scraping, downloading, playback, media-server
mutation, token printing, database shell access, backup restore, migration, or mutating KEK rotation
unless a later explicit phase authorizes that control surface.
