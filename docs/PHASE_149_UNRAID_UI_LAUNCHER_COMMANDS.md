# Phase 149 - Unraid UI Launcher Commands

Report id: `phase-149-unraid-ui-launcher-commands`

Phase 149 adds operator-facing launcher commands for Arcane custom commands and Unraid User Scripts.
The commands wrap the existing `docker-compose.unraid.runtime.yml` services. They do not add UI write
actions, providers, scraping, playback, or media-server mutation.

Launcher path:

```text
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh
```

UI service commands:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh start-ui
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh restart-ui
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh status
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-logs
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check
```

Token commands:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-token-status
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-token-rotate
```

Expected results:

- `start-ui` starts `postgres` and `app`.
- `restart-ui` recreates only the `app` container after ensuring `postgres` is up.
- `status` shows the runtime Compose services.
- `ui-logs` shows recent Docker logs from the read-only operator UI service.
- `ui-live-check` runs the redaction-safe live validation command against the operator UI service.
- `ui-token-status` reports token file metadata only.
- `ui-token-rotate` rotates the token with explicit confirmation and does not print the token value.

Still forbidden:

- provider contact;
- scraping;
- downloading;
- playback;
- command execution from the UI;
- backup or migration buttons in the UI;
- media-server mutation;
- raw token or secret exposure.
