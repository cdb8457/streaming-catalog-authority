#!/usr/bin/env sh
set -eu

# Catalog Authority Unraid ops launcher.
#
# Designed for Arcane custom commands and Unraid User Scripts. It uses the runtime compose file so
# launchers do not need the repository directory as a Docker build context.

REPO_DIR="${CATALOG_AUTHORITY_REPO_DIR:-/mnt/user/appdata/catalog/repo}"
COMPOSE_FILE="${CATALOG_AUTHORITY_COMPOSE_FILE:-$REPO_DIR/docker-compose.unraid.runtime.yml}"
BACKUP_DIR="${CATALOG_AUTHORITY_BACKUP_DIR:-/mnt/user/appdata/catalog/backups}"
EVIDENCE_DIR="${CATALOG_AUTHORITY_EVIDENCE_DIR:-$BACKUP_DIR/evidence}"
PREVIOUS_KEK_FILE="${CATALOG_AUTHORITY_PREVIOUS_KEK_FILE:-/mnt/user/appdata/catalog/secrets/custodian_kek_previous}"

cd "$REPO_DIR"

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

run_ops() {
  compose run --rm ops "$@"
}

run_ops_silent() {
  compose run --rm ops --silent "$@"
}

run_ui_live_check() {
  run_ops_silent ops:operator-ui-live-check -- --url "${CATALOG_AUTHORITY_UI_URL:-http://app:8099}" --json
}

run_rewrap_plan() {
  compose run --rm \
    -e CUSTODIAN_KEK_PREVIOUS_FILE=/run/secrets/custodian_kek_previous \
    -v "$PREVIOUS_KEK_FILE:/run/secrets/custodian_kek_previous:ro" \
    ops ops:rewrap-kek -- --plan --json
}

usage() {
  cat <<'EOF'
Catalog Authority Unraid ops launcher

Usage:
  unraid-ops-launcher.sh start-postgres
  unraid-ops-launcher.sh start-ui
  unraid-ops-launcher.sh restart-ui
  unraid-ops-launcher.sh status
  unraid-ops-launcher.sh ui-logs
  unraid-ops-launcher.sh ui-live-check
  unraid-ops-launcher.sh ui-live-check-save [output-file]
  unraid-ops-launcher.sh ui-token-status
  unraid-ops-launcher.sh ui-token-rotate
  unraid-ops-launcher.sh migrate
  unraid-ops-launcher.sh doctor
  unraid-ops-launcher.sh backup [output-file]
  unraid-ops-launcher.sh rewrap-plan

Notes:
  postgres and app are the long-running services.
  ops is a one-shot command container and exits after each command.
  ui-token-rotate changes the operator UI login token but does not print it.
  rewrap-plan requires a temporary previous KEK file at:
    /mnt/user/appdata/catalog/secrets/custodian_kek_previous
EOF
}

case "${1:-}" in
  start-postgres)
    compose up -d postgres
    ;;
  start-ui)
    compose up -d postgres app
    ;;
  restart-ui)
    compose up -d postgres
    compose up -d --force-recreate app
    ;;
  status)
    compose ps -a
    ;;
  ui-logs)
    compose logs --tail "${CATALOG_AUTHORITY_UI_LOG_TAIL:-80}" app
    ;;
  ui-live-check)
    run_ui_live_check
    ;;
  ui-live-check-save)
    target="${2:-$EVIDENCE_DIR/operator-ui-live-check-$(date -u +%Y%m%dT%H%M%SZ).json}"
    mkdir -p "$(dirname "$target")"
    tmp="${target}.tmp-$$"
    run_ui_live_check > "$tmp"
    chmod 600 "$tmp" 2>/dev/null || true
    mv "$tmp" "$target"
    echo "Saved redaction-safe operator UI live check: $target"
    ;;
  ui-token-status)
    run_ops ops:operator-ui-token -- --status --json
    ;;
  ui-token-rotate)
    run_ops ops:operator-ui-token -- --rotate --confirm --json
    ;;
  migrate)
    run_ops ops:migrate
    ;;
  doctor)
    run_ops ops:doctor -- --json
    ;;
  backup)
    target="${2:-$BACKUP_DIR/catalog-$(date -u +%Y%m%dT%H%M%SZ).json}"
    run_ops ops:backup -- dump "$target"
    ;;
  rewrap-plan)
    if [ ! -s "$PREVIOUS_KEK_FILE" ]; then
      echo "Missing previous KEK file for rewrap-plan: $PREVIOUS_KEK_FILE" >&2
      echo "Create it only for the planned KEK rotation window, then remove it after review." >&2
      exit 2
    fi
    run_rewrap_plan
    ;;
  ""|-h|--help|help)
    usage
    ;;
  *)
    echo "Unknown command: $1" >&2
    usage >&2
    exit 2
    ;;
esac
