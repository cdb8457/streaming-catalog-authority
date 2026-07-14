#!/usr/bin/env sh
set -eu

REPO_DIR="${CATALOG_AUTHORITY_REPO_DIR:-/mnt/user/appdata/catalog/repo}"
APPDATA_DIR="${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}"
COMPOSE_FILE="${CATALOG_AUTHORITY_COMPOSE_FILE:-docker-compose.unraid.runtime.yml}"
SECRET_FILE="${JELLYFIN_API_KEY_FILE_HOST:-$APPDATA_DIR/secrets/jellyfin_api_key}"
SECRET_MOUNT="/run/secrets/jellyfin_api_key"
EVIDENCE_DIR="${CATALOG_AUTHORITY_EVIDENCE_DIR:-$APPDATA_DIR/evidence}"
BASE_URL="${JELLYFIN_BASE_URL:-http://host.docker.internal:8096}"
LIMIT="${1:-25}"
OUT_FILE="${2:-$EVIDENCE_DIR/phase-221-jellyfin-write-proof.json}"

usage() {
  cat <<'EOF'
Usage:
  unraid-jellyfin-write-proof.sh [limit] [output-file]

Environment:
  CATALOG_AUTHORITY_REPO_DIR      Repo path, default /mnt/user/appdata/catalog/repo
  CATALOG_AUTHORITY_APPDATA_DIR   Appdata path, default /mnt/user/appdata/catalog
  JELLYFIN_API_KEY_FILE_HOST      Host secret file, default /mnt/user/appdata/catalog/secrets/jellyfin_api_key
  JELLYFIN_BASE_URL               Jellyfin URL from inside Docker, default http://host.docker.internal:8096
  CATALOG_AUTHORITY_EVIDENCE_DIR  Evidence directory, default /mnt/user/appdata/catalog/evidence
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 2
fi

case "$LIMIT" in
  ''|*[!0-9]*)
    echo "limit must be a positive integer" >&2
    exit 2
    ;;
esac

if [ ! -f "$SECRET_FILE" ]; then
  echo "Jellyfin secret file is missing or is not a regular file: $SECRET_FILE" >&2
  exit 2
fi

if [ ! -s "$SECRET_FILE" ]; then
  echo "Jellyfin secret file is empty: $SECRET_FILE" >&2
  exit 2
fi

mkdir -p "$(dirname "$OUT_FILE")"
chmod 700 "$(dirname "$OUT_FILE")" 2>/dev/null || true

cd "$REPO_DIR"

tmp_out="${OUT_FILE}.tmp-$$"
rm -f "$tmp_out"

docker compose -f "$COMPOSE_FILE" run --rm \
  --entrypoint npm \
  --add-host=host.docker.internal:host-gateway \
  -v "$SECRET_FILE:$SECRET_MOUNT:ro" \
  -v "$(dirname "$OUT_FILE"):/evidence" \
  -e JELLYFIN_ENABLE_NETWORK=true \
  -e JELLYFIN_ALLOW_LIVE_PUBLISH=true \
  -e "JELLYFIN_BASE_URL=$BASE_URL" \
  -e "JELLYFIN_API_KEY_FILE=$SECRET_MOUNT" \
  app \
  run --silent ops:jellyfin-write-proof -- \
    --limit "$LIMIT" \
    --out "/evidence/$(basename "$tmp_out")" \
    --confirm-disposable-write

chmod 600 "$tmp_out" 2>/dev/null || true
mv "$tmp_out" "$OUT_FILE"
echo "Saved redaction-safe Jellyfin write-proof evidence: $OUT_FILE"
