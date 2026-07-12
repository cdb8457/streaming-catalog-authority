# Phase 177 - Launch v1 Operator Runbook

Report id: `phase-177-launch-v1-operator-runbook`

Phase 177 is the concise operator runbook for Launch v1. Launch v1 means the Catalog Authority
backend/operator stack on Unraid: Postgres, one-shot ops commands, the read-only operator UI, evidence
capture, and redaction-safe launch validation.

## Install Or Update

```bash
cd /mnt/user/appdata/catalog/repo
git pull --ff-only origin master
npm run image:build:local
docker compose -f docker-compose.unraid.runtime.yml up -d postgres app
```

## Required Paths

```text
/mnt/user/appdata/catalog/repo
/mnt/user/appdata/catalog/backups
/mnt/user/appdata/catalog/backups/evidence
/mnt/user/appdata/catalog/keystore
/mnt/user/appdata/catalog/secrets
/mnt/user/appdata/catalog/repo/docker-compose.unraid.runtime.yml
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh
```

## Start And Validate

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh start-ui
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh status
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check
```

Expected:

- `catalogauthority-postgres-1` is healthy;
- `catalogauthority-app-1` is healthy;
- operator UI is reachable on the configured host port, default `8099`;
- unauthenticated API calls are rejected;
- authenticated status/log checks pass without printing the token.

## Evidence Loop

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check-save
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-evidence-review <saved-ui-evidence.json>
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh o4-o5-evidence-capture
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh o4-o5-packet-review <saved-o4-o5-packet.json>
```

Expected:

- saved UI evidence review reports `ok=true`;
- saved O4/O5 packet review reports `ok=true`;
- O4 remains open;
- O5 remains open.

## Routine Operations

Use Arcane or Unraid User Scripts for:

- `start-ui`;
- `restart-ui`;
- `status`;
- `ui-live-check`;
- `ui-live-check-save`;
- `ui-evidence-review`;
- `o4-o5-evidence-capture`;
- `o4-o5-packet-review`;
- `ui-logs`;
- `ui-token-status`.

## Not Included In Launch v1

Launch v1 does not include provider contact, Real-Debrid/TorBox live provider mode, scraping,
downloading, playback, Plex/Jellyfin mutation, media-server library writes, managed KMS, O4 closure,
or O5 closure.

Do not describe Launch v1 as a managed-custody production closure.
