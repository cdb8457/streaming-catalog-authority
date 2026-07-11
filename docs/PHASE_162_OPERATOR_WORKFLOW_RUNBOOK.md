# Phase 162 - Operator Workflow Runbook

Report id: `phase-162-operator-workflow-runbook`

Use this runbook for normal Catalog Authority operations on Unraid.

## Update

```bash
cd /mnt/user/appdata/catalog/repo
git pull --ff-only
npm run image:build:local
docker compose -f docker-compose.unraid.runtime.yml down --remove-orphans
docker compose -f docker-compose.unraid.runtime.yml up -d postgres app
```

## Arcane Project

Arcane project path:

```text
/mnt/user/projects/CatalogAuthority
```

The Arcane project compose should match the canonical runtime compose:

```text
/mnt/user/appdata/catalog/repo/docker-compose.unraid.runtime.yml
```

The Arcane project `.env` should keep these defaults:

```text
CATALOG_AUTHORITY_OPS_IMAGE=repo-ops:latest
CATALOG_AUTHORITY_APPDATA_DIR=/mnt/user/appdata/catalog
OPERATOR_UI_HOST_PORT=8099
```

## Validate

Run these from Arcane custom commands, Unraid User Scripts, or the Unraid shell:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh status
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh restart-ui
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check
```

Expected result:

- `postgres` is running and healthy;
- `app` is running and healthy;
- `ui-live-check` returns `ok=true`;
- unauthenticated status/log checks return `401`;
- authenticated status/log checks pass without printing the token.

## Save Evidence

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check-save
```

The saved evidence path is under:

```text
/mnt/user/appdata/catalog/backups/evidence
```

## Review Evidence

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-evidence-review /mnt/user/appdata/catalog/backups/evidence/operator-ui-live-check-*.json
```

Expected result:

- report is `phase-152-operator-ui-evidence-review`;
- `ok=true`;
- each reviewed current evidence file reports `PASS`.

## Recovery

If the UI is unavailable:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh restart-ui
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check
```

If the stack still does not recover, inspect redacted app logs:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-logs
```

## Forbidden During Normal Operations

- Do not print the operator token.
- Do not restore backups from Arcane buttons.
- Do not run KEK rotation from Arcane buttons.
- Do not add provider contact, scraping, downloading, playback, or media-server mutation to this
  workflow.
