#!/usr/bin/env sh
set -eu

# Live Phase 230 real-library promotion launcher.
# Promotes one already-imported test-library file into the approved real Movies root,
# verifies read-only Jellyfin visibility, then withdraws it and proves the tree returns.

REPO_DIR="${CATALOG_AUTHORITY_REPO_DIR:-/mnt/user/appdata/catalog/repo}"
APPDATA_DIR="${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}"
COMPOSE_FILE="${CATALOG_AUTHORITY_COMPOSE_FILE:-docker-compose.unraid.runtime.yml}"
OPS_IMAGE="${CATALOG_AUTHORITY_OPS_IMAGE:-repo-ops:latest}"
SECRET_FILE="${JELLYFIN_API_KEY_FILE_HOST:-$APPDATA_DIR/secrets/jellyfin_api_key}"
SECRET_MOUNT="/run/secrets/jellyfin_api_key"
EVIDENCE_DIR="${CATALOG_AUTHORITY_EVIDENCE_DIR:-$APPDATA_DIR/evidence}"
BASE_URL="${JELLYFIN_BASE_URL:-http://192.168.1.31:8096}"
HOST_TEST_DIR="${CATALOG_AUTHORITY_TEST_LIBRARY_HOST_PATH:-/mnt/user/media/catalog-authority-test-library}"
REAL_MOVIES_ROOT="${CATALOG_AUTHORITY_REAL_MOVIES_ROOT:-/mnt/user/media/Movies}"
COMPOSE_NETWORK="${CATALOG_AUTHORITY_COMPOSE_NETWORK:-catalogauthority_default}"

SOURCE_FILE="${1:-}"
OUT_FILE="${2:-$EVIDENCE_DIR/phase-230-real-library-promotion.json}"
ITEM_ID="${CATALOG_AUTHORITY_PROMOTION_ITEM_ID:-}"
TITLE="${CATALOG_AUTHORITY_PROMOTION_TITLE:-Catalog Authority E2E Probe}"
YEAR="${CATALOG_AUTHORITY_PROMOTION_YEAR:-2026}"
APPROVAL_ID="${CATALOG_AUTHORITY_PROMOTION_APPROVAL_ID:-phase-230-single-live-promotion}"
VISIBILITY_POLLS="${CATALOG_AUTHORITY_PROMOTION_VISIBILITY_POLLS:-24}"
VISIBILITY_POLL_MS="${CATALOG_AUTHORITY_PROMOTION_VISIBILITY_POLL_MS:-5000}"

if [ -z "$SOURCE_FILE" ]; then
  echo "usage: $0 <test-library-source-media-file> [evidence-output.json]" >&2
  exit 2
fi

case "$SOURCE_FILE" in
  "$HOST_TEST_DIR"/*) ;;
  *)
    echo "source media file must already be inside the isolated test library: $HOST_TEST_DIR" >&2
    exit 2
    ;;
esac

if [ ! -f "$SOURCE_FILE" ]; then
  echo "source media file is missing: $SOURCE_FILE" >&2
  exit 2
fi

if [ "$REAL_MOVIES_ROOT" != "/mnt/user/media/Movies" ]; then
  echo "refusing unapproved real Movies root: $REAL_MOVIES_ROOT" >&2
  exit 2
fi

case "$REAL_MOVIES_ROOT:$SOURCE_FILE" in
  *Gelato*|*gelato*|*AIO*|*aio*)
    echo "refusing Gelato/AIO promotion path" >&2
    exit 2
    ;;
esac

if [ ! -d "$REAL_MOVIES_ROOT" ]; then
  echo "approved real Movies root is missing: $REAL_MOVIES_ROOT" >&2
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
  --volume "$SECRET_FILE:$SECRET_MOUNT:ro" \
  --volume "$(dirname "$OUT_FILE"):/evidence" \
  --volume "$SOURCE_FILE:$SOURCE_FILE:ro" \
  --volume "$HOST_TEST_DIR:$HOST_TEST_DIR:ro" \
  --volume "$REAL_MOVIES_ROOT:$REAL_MOVIES_ROOT" \
  --env PROMOTION_APPROVED=true \
  --env JELLYFIN_ENABLE_NETWORK=true \
  --env "JELLYFIN_BASE_URL=$BASE_URL" \
  --env "JELLYFIN_API_KEY_FILE=$SECRET_MOUNT" \
  --env JELLYFIN_TRIGGER_LIBRARY_SCAN=true \
  --env JELLYFIN_ALLOW_LIVE_PUBLISH=false \
  "$OPS_IMAGE" \
  npm run --silent ops:real-library-promotion -- \
    --out "/evidence/$(basename "$OUT_FILE")" \
    --item-id "$ITEM_ID" \
    --title "$TITLE" \
    --year "$YEAR" \
    --source-file "$SOURCE_FILE" \
    --test-library-root "$HOST_TEST_DIR" \
    --target-root "$REAL_MOVIES_ROOT" \
    --approval-id "$APPROVAL_ID" \
    --await-jellyfin \
    --withdraw-after \
    --visibility-polls "$VISIBILITY_POLLS" \
    --visibility-poll-ms "$VISIBILITY_POLL_MS"

echo "Saved redaction-safe real-library promotion evidence: $OUT_FILE"
