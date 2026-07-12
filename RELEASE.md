# Catalog Authority Launch v1 Release

Current release tag: `launch-v1`

Launch v1 is the self-hosted Catalog Authority backend/operator foundation on Unraid. It includes
Postgres, one-shot ops commands, the read-only operator UI, Arcane/User Scripts launchers, and
redaction-safe evidence capture/review.

Launch v1 ships with O4/O5 accepted as open warnings:

- O4 external/managed custodian remains open.
- O5 managed KEK custody/scheduling remains open.
- `FileCustodian` remains a hardened reference harness, not production KMS.

Canonical Unraid paths:

- repo: `/mnt/user/appdata/catalog/repo`
- appdata root: `/mnt/user/appdata/catalog`
- compose file: `/mnt/user/appdata/catalog/repo/docker-compose.unraid.runtime.yml`
- launcher: `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh`

Image:

- default local image: `repo-ops:latest`
- published image naming convention: `ghcr.io/catalog-authority/catalog-authority-ops:<tag>`
- set `CATALOG_AUTHORITY_OPS_IMAGE` only when pulling a published image instead of using the
  locally built default image.

Install or update:

```bash
mkdir -p /mnt/user/appdata/catalog/repo
cd /mnt/user/appdata/catalog/repo
git clone https://github.com/cdb8457/streaming-catalog-authority.git . 2>/dev/null || git pull --ff-only origin master
npm run image:build:local
docker compose -f docker-compose.unraid.runtime.yml up -d postgres app
```

Required secret files:

```text
/mnt/user/appdata/catalog/secrets/postgres_password
/mnt/user/appdata/catalog/secrets/admin_database_url
/mnt/user/appdata/catalog/secrets/database_url
/mnt/user/appdata/catalog/secrets/completion_secret
/mnt/user/appdata/catalog/secrets/custodian_kek
/mnt/user/appdata/catalog/secrets/operator_ui_token
```

Verify:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh status
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check-save
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh o4-o5-evidence-capture
```

Fresh public deploy smoke:

- run from a clean clone of committed Git history;
- use the same `docker-compose.unraid.runtime.yml` file;
- set `CATALOG_AUTHORITY_APPDATA_DIR` to a temporary appdata directory;
- set `OPERATOR_UI_HOST_PORT` to a temporary host port if `8099` is already in use;
- use `docker compose -p <temporary-project-name>` so the smoke cannot reuse production
  containers, networks, or volumes.

See `docs/PHASE_155_PUBLIC_DEPLOY_SMOKE.md`.

Review saved evidence:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-evidence-review /mnt/user/appdata/catalog/backups/evidence/operator-ui-live-check-*.json
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh o4-o5-packet-review /mnt/user/appdata/catalog/backups/evidence/o4-o5/<bundle>/o4-o5-evidence-packet.redacted.json
```

The release path does not enable provider contact, scraping, downloading, playback, media-server
mutation, token printing, UI write actions, O4 closure, or O5 closure.

Allowed launch claim:

```text
Catalog Authority Launch v1 is ready as a self-hosted backend/operator foundation with visible
O4/O5 managed-custody warnings and no provider/media behavior.
```
