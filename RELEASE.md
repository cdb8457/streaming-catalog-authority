# Catalog Authority Launch Package

Current launch package: `phase-200` / `0d08052`

Launch status: `LAUNCH_READY_WITH_ACCEPTED_WARNINGS`

Required warning: `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`

Catalog Authority is ready as a self-hosted backend/operator foundation on Unraid. It includes
Postgres, sidecar custody, one-shot ops commands, the read-only operator UI, Arcane/User Scripts
launchers, and redaction-safe evidence capture/review.

Gate status:

- O4: `O4_CLOSED`
- O5: `O5_DEFERRED_ACCEPTED`

O5 is intentionally deferred with a launch warning. This package does not claim managed KEK
custody/scheduling closure.

Operator handoff:

- `docs/PHASE_201_LAUNCH_PACKAGE.md`
- `docs/PHASE_200_LAUNCH_READINESS_PASS.md`
- `docs/RELEASE_CHECKLIST.md`

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
git clone https://github.com/cdb8457/streaming-catalog-authority.git . 2>/dev/null || git fetch origin --tags --force
git checkout master
git reset --hard origin/master
docker build -t repo-ops:latest .
docker compose -f docker-compose.unraid.runtime.yml up -d postgres app sidecar
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
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-evidence-review
```

Expected healthy state:

- app, sidecar, and Postgres running and healthy;
- app custody mode is `sidecar`;
- sidecar publishes no ports;
- `ui-live-check` returns `ok:true`;
- O5 warning remains visible.

Allowed launch claim:

```text
Catalog Authority is ready as a self-hosted backend/operator foundation with O4 closed, O5
deferred-accepted with a visible launch warning, sidecar custody active, and no provider or media
runtime behavior enabled.
```

Forbidden launch claims:

- no streaming product claim;
- no provider live mode;
- no Real-Debrid, TorBox, Usenet, Plex, Jellyfin, Emby, or Stremio integration claim;
- no scraping, downloading, playback, create-download, request-link, or media-server mutation;
- no O5 closed claim;
- no managed KEK custody/scheduling claim.
