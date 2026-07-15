#!/usr/bin/env sh
set -eu

# Read-only preflight for Phase 226 local-media E2E.
# Verifies the dedicated Jellyfin test library before any import is attempted.

REPO_DIR="${CATALOG_AUTHORITY_REPO_DIR:-/mnt/user/appdata/catalog/repo}"
APPDATA_DIR="${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}"
COMPOSE_FILE="${CATALOG_AUTHORITY_COMPOSE_FILE:-docker-compose.unraid.runtime.yml}"
SECRET_FILE="${JELLYFIN_API_KEY_FILE_HOST:-$APPDATA_DIR/secrets/jellyfin_api_key}"
SECRET_MOUNT="/run/secrets/jellyfin_api_key"
EVIDENCE_DIR="${CATALOG_AUTHORITY_EVIDENCE_DIR:-$APPDATA_DIR/evidence}"
BASE_URL="${JELLYFIN_BASE_URL:-http://192.168.1.31:8096}"
HOST_TEST_DIR="${CATALOG_AUTHORITY_TEST_LIBRARY_HOST_PATH:-/mnt/user/media/catalog-authority-test-library}"
OUT_FILE="${1:-$EVIDENCE_DIR/phase-226-test-library-preflight.json}"

if [ ! -d "$HOST_TEST_DIR" ]; then
  echo "Catalog Authority test library host folder is missing: $HOST_TEST_DIR" >&2
  exit 2
fi

if [ ! -f "$SECRET_FILE" ] || [ ! -s "$SECRET_FILE" ]; then
  echo "Jellyfin API key file is missing or empty: $SECRET_FILE" >&2
  exit 2
fi

mkdir -p "$(dirname "$OUT_FILE")"
chmod 700 "$(dirname "$OUT_FILE")" 2>/dev/null || true

cd "$REPO_DIR"

mounts="$(docker inspect jellyfin --format '{{range .Mounts}}{{.Destination}}:{{end}}')"

docker compose -f "$COMPOSE_FILE" run --rm \
  --entrypoint npm \
  -v "$SECRET_FILE:$SECRET_MOUNT:ro" \
  -v "$(dirname "$OUT_FILE"):/evidence" \
  -v "$HOST_TEST_DIR:$HOST_TEST_DIR:ro" \
  -e JELLYFIN_ENABLE_NETWORK=true \
  -e "JELLYFIN_BASE_URL=$BASE_URL" \
  -e "JELLYFIN_API_KEY_FILE=$SECRET_MOUNT" \
  -e JELLYFIN_ALLOW_LIVE_PUBLISH=false \
  -e "JELLYFIN_MOUNT_DESTINATIONS=$mounts" \
  -e "CATALOG_AUTHORITY_TEST_LIBRARY_HOST_PATH=$HOST_TEST_DIR" \
  ops \
  run --silent ops:jellyfin-test-library-preflight -- \
    --out "/evidence/$(basename "$OUT_FILE")"

echo "Saved redaction-safe Jellyfin test-library preflight evidence: $OUT_FILE"
