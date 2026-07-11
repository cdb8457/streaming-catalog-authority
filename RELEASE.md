# Catalog Authority Release Deployment

Current release tag: `phase-154`

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
git pull --ff-only
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
```

Review saved evidence:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-evidence-review /mnt/user/appdata/catalog/backups/evidence/operator-ui-live-check-*.json
```

The release path does not enable provider contact, scraping, downloading, playback, media-server
mutation, token printing, or UI write actions.
