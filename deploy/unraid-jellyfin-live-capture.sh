#!/usr/bin/env sh
set -eu

# Guarded Jellyfin read-only evidence capture for Unraid.
#
# This script is intended for the moment after the operator installs:
#   /mnt/user/appdata/catalog/secrets/jellyfin_api_key
#
# It does not install Jellyfin, publish ports, change Compose, or mutate catalog state.

IMAGE="${CATALOG_AUTHORITY_IMAGE:-repo-ops:latest}"
SECRET_FILE="${JELLYFIN_API_KEY_FILE_HOST:-/mnt/user/appdata/catalog/secrets/jellyfin_api_key}"
SECRET_MOUNT="/run/secrets/jellyfin_api_key"
EVIDENCE_DIR="${CATALOG_AUTHORITY_EVIDENCE_DIR:-/mnt/user/appdata/catalog/evidence}"
BASE_URL="${JELLYFIN_BASE_URL:-http://host.docker.internal:8096}"
OUT_FILE="${3:-$EVIDENCE_DIR/phase-211-jellyfin-live-readonly-smoke.json}"

usage() {
  cat <<'EOF'
Usage:
  unraid-jellyfin-live-capture.sh <ref-type> <ref-value> [output-file]

Examples:
  unraid-jellyfin-live-capture.sh tmdb 603
  unraid-jellyfin-live-capture.sh imdb tt0133093 /mnt/user/appdata/catalog/evidence/jellyfin-live.json

Environment:
  CATALOG_AUTHORITY_IMAGE       Docker image to run, default repo-ops:latest
  JELLYFIN_API_KEY_FILE_HOST    Host secret file, default /mnt/user/appdata/catalog/secrets/jellyfin_api_key
  JELLYFIN_BASE_URL             Jellyfin URL from inside Docker, default http://host.docker.internal:8096
  CATALOG_AUTHORITY_EVIDENCE_DIR Evidence directory, default /mnt/user/appdata/catalog/evidence
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "$#" -lt 2 ]; then
  usage
  exit 2
fi

REF_TYPE="$1"
REF_VALUE="$2"

if [ ! -f "$SECRET_FILE" ]; then
  echo "Jellyfin secret file is missing or is not a regular file: $SECRET_FILE" >&2
  echo "Install it with the Phase 214 no-echo operator packet before live capture." >&2
  exit 2
fi

if [ ! -s "$SECRET_FILE" ]; then
  echo "Jellyfin secret file is empty: $SECRET_FILE" >&2
  exit 2
fi

mkdir -p "$(dirname "$OUT_FILE")"
chmod 700 "$(dirname "$OUT_FILE")" 2>/dev/null || true

docker run --rm \
  -v "$SECRET_FILE:$SECRET_MOUNT:ro" \
  -e "JELLYFIN_API_KEY_FILE=$SECRET_MOUNT" \
  "$IMAGE" \
  npm run --silent ops:jellyfin-secret-readiness

tmp_out="${OUT_FILE}.tmp-$$"
rm -f "$tmp_out"

docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -v "$SECRET_FILE:$SECRET_MOUNT:ro" \
  -v "$(dirname "$OUT_FILE"):/evidence" \
  -e JELLYFIN_ENABLE_NETWORK=true \
  -e "JELLYFIN_BASE_URL=$BASE_URL" \
  -e "JELLYFIN_API_KEY_FILE=$SECRET_MOUNT" \
  "$IMAGE" \
  npm run --silent ops:jellyfin-live-evidence-capture -- \
    --ref-type "$REF_TYPE" \
    --ref-value "$REF_VALUE" \
    --out "/evidence/$(basename "$tmp_out")"

chmod 600 "$tmp_out" 2>/dev/null || true
mv "$tmp_out" "$OUT_FILE"
echo "Saved redaction-safe Jellyfin live read-only evidence: $OUT_FILE"
