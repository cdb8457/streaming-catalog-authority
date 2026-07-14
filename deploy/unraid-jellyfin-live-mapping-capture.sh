#!/usr/bin/env sh
set -eu

# Guarded Jellyfin live read-only mapping capture for Unraid.
#
# This script uses the existing Catalog Authority runtime and existing Jellyfin server.
# It does not install Jellyfin, publish ports, enable writes, change Compose, or mutate catalog state.

REPO_DIR="${CATALOG_AUTHORITY_REPO_DIR:-/mnt/user/appdata/catalog/repo}"
APPDATA_DIR="${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}"
COMPOSE_FILE="${CATALOG_AUTHORITY_COMPOSE_FILE:-docker-compose.unraid.runtime.yml}"
SECRET_FILE="${JELLYFIN_API_KEY_FILE_HOST:-$APPDATA_DIR/secrets/jellyfin_api_key}"
SECRET_MOUNT="/run/secrets/jellyfin_api_key"
EVIDENCE_DIR="${CATALOG_AUTHORITY_EVIDENCE_DIR:-$APPDATA_DIR/evidence}"
BASE_URL="${JELLYFIN_BASE_URL:-http://host.docker.internal:8096}"
LIMIT="${1:-25}"
OUT_FILE="${2:-$EVIDENCE_DIR/phase-219-jellyfin-live-readonly-mapping.json}"

usage() {
  cat <<'EOF'
Usage:
  unraid-jellyfin-live-mapping-capture.sh [limit] [output-file]

Examples:
  unraid-jellyfin-live-mapping-capture.sh
  unraid-jellyfin-live-mapping-capture.sh 10

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

docker compose -f "$COMPOSE_FILE" up -d postgres sidecar

set +e
docker compose -f "$COMPOSE_FILE" run --rm \
  --entrypoint npm \
  -v "$SECRET_FILE:$SECRET_MOUNT:ro" \
  -v "$(dirname "$OUT_FILE"):/evidence" \
  -e JELLYFIN_ENABLE_NETWORK=true \
  -e "JELLYFIN_BASE_URL=$BASE_URL" \
  -e "JELLYFIN_API_KEY_FILE=$SECRET_MOUNT" \
  -e JELLYFIN_ALLOW_LIVE_PUBLISH=false \
  ops \
  run --silent ops:jellyfin-live-readonly-mapping -- \
    --limit "$LIMIT" \
    --out "/evidence/$(basename "$tmp_out")"
cmd_status=$?
set -e

if [ -f "$tmp_out" ]; then
  chmod 600 "$tmp_out" 2>/dev/null || true
  mv "$tmp_out" "$OUT_FILE"
  echo "Saved redaction-safe Jellyfin live read-only mapping evidence: $OUT_FILE"
else
  echo "Jellyfin live read-only mapping command did not create evidence: $tmp_out" >&2
fi

exit "$cmd_status"
