# Phase 155 - Public Deploy Smoke

Report id: `phase-155-public-deploy-smoke`

Purpose: simulate a fresh external user from committed Git history only, using the documented
release compose file.

Clean-smoke command shape:

```bash
SMOKE_ROOT=/tmp/catalog-authority-public-smoke
SMOKE_APPDATA="$SMOKE_ROOT/appdata"
SMOKE_REPO="$SMOKE_ROOT/repo"
SMOKE_PROJECT=catalogauthority-public-smoke
SMOKE_PORT=18199

rm -rf "$SMOKE_ROOT"
mkdir -p "$SMOKE_APPDATA"/{pgdata,keystore,backups,secrets}
git clone /mnt/user/appdata/catalog/repo "$SMOKE_REPO"
cd "$SMOKE_REPO"

printf '%s\n' 'postgres' > "$SMOKE_APPDATA/secrets/postgres_password"
printf '%s\n' 'postgresql://postgres:postgres@postgres:5432/catalog' > "$SMOKE_APPDATA/secrets/admin_database_url"
printf '%s\n' 'postgresql://app:app@postgres:5432/catalog' > "$SMOKE_APPDATA/secrets/database_url"
openssl rand -base64 32 > "$SMOKE_APPDATA/secrets/completion_secret"
openssl rand -base64 32 > "$SMOKE_APPDATA/secrets/custodian_kek"
openssl rand -base64 32 > "$SMOKE_APPDATA/secrets/operator_ui_token"
chmod 600 "$SMOKE_APPDATA"/secrets/*

npm ci
npm run image:build:local
CATALOG_AUTHORITY_APPDATA_DIR="$SMOKE_APPDATA" OPERATOR_UI_HOST_PORT="$SMOKE_PORT" \
  docker compose -p "$SMOKE_PROJECT" -f docker-compose.unraid.runtime.yml up -d postgres
CATALOG_AUTHORITY_APPDATA_DIR="$SMOKE_APPDATA" OPERATOR_UI_HOST_PORT="$SMOKE_PORT" \
  docker compose -p "$SMOKE_PROJECT" -f docker-compose.unraid.runtime.yml run -T --rm ops ops:init
CATALOG_AUTHORITY_APPDATA_DIR="$SMOKE_APPDATA" OPERATOR_UI_HOST_PORT="$SMOKE_PORT" \
  docker compose -p "$SMOKE_PROJECT" -f docker-compose.unraid.runtime.yml up -d app
CATALOG_AUTHORITY_APPDATA_DIR="$SMOKE_APPDATA" OPERATOR_UI_HOST_PORT="$SMOKE_PORT" \
  docker compose -p "$SMOKE_PROJECT" -f docker-compose.unraid.runtime.yml run -T --rm ops --silent \
  ops:operator-ui-live-check -- --url "http://app:8099" --json > "$SMOKE_APPDATA/backups/evidence/operator-ui-live-check-smoke.json"
CATALOG_AUTHORITY_APPDATA_DIR="$SMOKE_APPDATA" OPERATOR_UI_HOST_PORT="$SMOKE_PORT" \
  docker compose -p "$SMOKE_PROJECT" -f docker-compose.unraid.runtime.yml run -T --rm ops --silent \
  ops:operator-ui-evidence-review -- "$SMOKE_APPDATA/backups/evidence/operator-ui-live-check-smoke.json"
CATALOG_AUTHORITY_APPDATA_DIR="$SMOKE_APPDATA" OPERATOR_UI_HOST_PORT="$SMOKE_PORT" \
  docker compose -p "$SMOKE_PROJECT" -f docker-compose.unraid.runtime.yml down --remove-orphans
```

The overrides are smoke-only:

- `CATALOG_AUTHORITY_APPDATA_DIR` keeps the smoke from reading or writing existing
  `/mnt/user/appdata/catalog` data.
- `OPERATOR_UI_HOST_PORT` keeps the smoke from colliding with a real operator UI on `8099`.
- `docker compose -p "$SMOKE_PROJECT"` keeps containers and networks separate from the real
  `catalogauthority` project.

The release defaults remain `/mnt/user/appdata/catalog`, `/mnt/user/appdata/catalog/repo`, and
host port `8099`.

Still forbidden:

- provider contact;
- scraping;
- downloading;
- playback;
- media-server mutation;
- token printing;
- UI write actions.
