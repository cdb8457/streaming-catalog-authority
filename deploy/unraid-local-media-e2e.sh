#!/usr/bin/env sh
set -eu

# Live Phase 226 local-media E2E launcher.
# Imports one operator-supplied media file into the isolated Jellyfin test library
# and confirms visibility through Jellyfin read-only queries.

REPO_DIR="${CATALOG_AUTHORITY_REPO_DIR:-/mnt/user/appdata/catalog/repo}"
APPDATA_DIR="${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}"
COMPOSE_FILE="${CATALOG_AUTHORITY_COMPOSE_FILE:-docker-compose.unraid.runtime.yml}"
OPS_IMAGE="${CATALOG_AUTHORITY_OPS_IMAGE:-repo-ops:latest}"
SECRET_FILE="${JELLYFIN_API_KEY_FILE_HOST:-$APPDATA_DIR/secrets/jellyfin_api_key}"
SECRET_MOUNT="/run/secrets/jellyfin_api_key"
EVIDENCE_DIR="${CATALOG_AUTHORITY_EVIDENCE_DIR:-$APPDATA_DIR/evidence}"
BASE_URL="${JELLYFIN_BASE_URL:-http://192.168.1.31:8096}"
HOST_TEST_DIR="${CATALOG_AUTHORITY_TEST_LIBRARY_HOST_PATH:-/mnt/user/media/catalog-authority-test-library}"
COMPOSE_NETWORK="${CATALOG_AUTHORITY_COMPOSE_NETWORK:-catalogauthority_default}"

SOURCE_FILE="${1:-}"
OUT_FILE="${2:-$EVIDENCE_DIR/phase-226-local-media-e2e.json}"
ITEM_ID="${CATALOG_AUTHORITY_E2E_ITEM_ID:-}"
TITLE="${CATALOG_AUTHORITY_E2E_TITLE:-Catalog Authority E2E Probe}"
YEAR="${CATALOG_AUTHORITY_E2E_YEAR:-2026}"
REF_TYPE="${CATALOG_AUTHORITY_E2E_REF_TYPE:-local-test-file}"
REF_VALUE="${CATALOG_AUTHORITY_E2E_REF_VALUE:-phase-226-local-media-e2e}"
VISIBILITY_POLLS="${CATALOG_AUTHORITY_E2E_VISIBILITY_POLLS:-24}"
VISIBILITY_POLL_MS="${CATALOG_AUTHORITY_E2E_VISIBILITY_POLL_MS:-5000}"

if [ -z "$SOURCE_FILE" ]; then
  echo "usage: $0 <source-media-file> [evidence-output.json]" >&2
  exit 2
fi

if [ ! -f "$SOURCE_FILE" ]; then
  echo "source media file is missing: $SOURCE_FILE" >&2
  exit 2
fi

case "$SOURCE_FILE" in
  "$HOST_TEST_DIR"/*)
    echo "source media file must not already be inside the isolated test library" >&2
    exit 2
    ;;
esac

if [ ! -d "$HOST_TEST_DIR" ]; then
  echo "Catalog Authority test library host folder is missing: $HOST_TEST_DIR" >&2
  exit 2
fi

if [ ! -f "$SECRET_FILE" ] || [ ! -s "$SECRET_FILE" ]; then
  echo "Jellyfin API key file is missing or empty: $SECRET_FILE" >&2
  exit 2
fi

if [ -z "$ITEM_ID" ]; then
  ITEM_ID="$(node -e "console.log(require('crypto').randomUUID())")"
fi

mkdir -p "$(dirname "$OUT_FILE")"
chmod 700 "$(dirname "$OUT_FILE")" 2>/dev/null || true

cd "$REPO_DIR"

docker compose -f "$COMPOSE_FILE" up -d postgres sidecar

docker run --rm \
  --network "$COMPOSE_NETWORK" \
  --volume "$APPDATA_DIR/secrets/admin_database_url:/run/secrets/admin_database_url:ro" \
  --volume "$APPDATA_DIR/secrets/database_url:/run/secrets/database_url:ro" \
  --volume "$APPDATA_DIR/sidecar/run:/run/catalog-sidecar" \
  --volume "$SECRET_FILE:$SECRET_MOUNT:ro" \
  --volume "$(dirname "$OUT_FILE"):/evidence" \
  --volume "$SOURCE_FILE:$SOURCE_FILE:ro" \
  --volume "$HOST_TEST_DIR:$HOST_TEST_DIR" \
  --env APP_ENV=production \
  --env ADMIN_DATABASE_URL_FILE=/run/secrets/admin_database_url \
  --env DATABASE_URL_FILE=/run/secrets/database_url \
  --env CUSTODIAN_MODE=sidecar \
  --env CUSTODIAN_SIDECAR_SOCKET_PATH=/run/catalog-sidecar/catalog-sidecar.sock \
  --env JELLYFIN_ENABLE_NETWORK=true \
  --env "JELLYFIN_BASE_URL=$BASE_URL" \
  --env "JELLYFIN_API_KEY_FILE=$SECRET_MOUNT" \
  --env JELLYFIN_TRIGGER_LIBRARY_SCAN=true \
  --env JELLYFIN_ALLOW_LIVE_PUBLISH=false \
  "$OPS_IMAGE" \
  npm run --silent ops:local-media-pipeline -- \
    --out "/evidence/$(basename "$OUT_FILE")" \
    --item-id "$ITEM_ID" \
    --title "$TITLE" \
    --year "$YEAR" \
    --source-file "$SOURCE_FILE" \
    --library-root "$HOST_TEST_DIR" \
    --ref-type "$REF_TYPE" \
    --ref-value "$REF_VALUE" \
    --await-jellyfin \
    --visibility-polls "$VISIBILITY_POLLS" \
    --visibility-poll-ms "$VISIBILITY_POLL_MS"

echo "Saved redaction-safe local-media E2E evidence: $OUT_FILE"
