#!/usr/bin/env bash
# Catalog Authority — one-command setup for the ordinary-computer runtime stack.
#
# In this repository, where the runtime stack is one of several compose files and must be named:
#   ./deploy/local-runtime-setup.sh
#   docker compose -f docker-compose.runtime.yml up -d
#   open http://127.0.0.1:8099/
#
# In the release bundle, where it is the only one:
#   ./setup.sh
#   docker compose up -d
#
# It creates ./secrets/ (random values, never printed except the operator token you need to log in) and an
# empty ./promotion-records/ folder for the Phase 231-240 chain artifacts. It is safe to re-run: existing
# secrets are kept, never regenerated, so a re-run cannot lock you out of a running stack.
#
# It touches nothing outside this repository directory. It performs no promotion, no approval, no execution,
# no archival and no deletion; it contacts no media server, no provider and no library; it starts nothing.
set -euo pipefail

# This script ships twice: here under deploy/, and at the root of the release bundle, where there is no
# deploy/ directory to step out of. Both must land in the folder that holds the Compose file.
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
if [ "$(basename "${SCRIPT_DIR}")" = "deploy" ]; then
  cd "$(dirname "${SCRIPT_DIR}")"
  # The repository holds several compose files, so the runtime one has to be named.
  COMPOSE_ARGS="-f docker-compose.runtime.yml "
else
  cd "${SCRIPT_DIR}"
  # The bundle holds exactly one, and `docker compose` finds it by itself.
  COMPOSE_ARGS=""
fi

SECRETS_DIR="./secrets"
RECORDS_DIR="${PROMOTION_RECORDS_HOST_DIR:-./promotion-records}"

random_secret() {
  # 32 random bytes, base64. Falls back through the tools an ordinary machine actually has.
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 32
  elif command -v node >/dev/null 2>&1; then node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  elif [ -r /dev/urandom ]; then head -c 32 /dev/urandom | base64
  else echo "need openssl, node, or /dev/urandom to generate a secret" >&2; exit 1
  fi
}

# SECRET FILE MODES — why some of these are not 0600.
#
# Compose delivers ./secrets/* to the containers as file-backed secrets. In non-Swarm `docker compose` (what
# this stack is), a file secret is a BIND MOUNT of the source file: its ownership and permission bits reach
# the container unchanged, and the `uid`/`gid`/`mode` keys of the long secret syntax are ignored (they only
# take effect under Swarm). The operator UI container runs as the unprivileged `node` user, which is neither
# the owner nor in the group of a file this script writes, so a 0600 secret is UNREADABLE inside the container
# and the app refuses to start. Making the app run as root, or dropping its read-only rootfs, would trade a
# real security property for this convenience; neither is acceptable.
#
# The host boundary is the SECRETS_DIR itself, kept at 0700 below: no other host user can traverse into it,
# whatever the individual files are. So the secrets a NON-ROOT app must read are given the world-read bit —
# the container reads them through the mount, while on the host they stay reachable only by you (through the
# 0700 directory). postgres_password is different: the postgres image reads it once, as root, before dropping
# to the postgres user, so it needs no world-read bit and keeps the tighter 0600.
SECRET_MODE_APP=644     # owner rw, world r — read by the non-root `node` user inside the app container
SECRET_MODE_ROOT=600    # owner rw only — read by root inside the postgres container, never by a non-root app

write_secret_if_absent() {
  local name="$1" value="$2" mode="${3:-${SECRET_MODE_APP}}"
  if [ -f "${SECRETS_DIR}/${name}" ]; then
    # Enforce the mode on a re-run too, so a secret written 0600 by an older setup becomes container-readable
    # without regenerating its value — a re-run must never lock you out, and must also never leave the app
    # unable to read a secret it needs.
    chmod "${mode}" "${SECRETS_DIR}/${name}" 2>/dev/null || true
    echo "  kept      ${SECRETS_DIR}/${name} (already exists)"
    return
  fi
  printf '%s\n' "${value}" > "${SECRETS_DIR}/${name}"
  chmod "${mode}" "${SECRETS_DIR}/${name}" 2>/dev/null || true
  echo "  created   ${SECRETS_DIR}/${name}"
}

echo "Catalog Authority local runtime setup"
echo

mkdir -p "${SECRETS_DIR}"
chmod 700 "${SECRETS_DIR}" 2>/dev/null || true

PG_PASSWORD="$(random_secret | tr -d '\n/+=' | cut -c1-32)"
# Read only by root inside the postgres container, so it keeps the tighter owner-only mode.
write_secret_if_absent postgres_password "${PG_PASSWORD}" "${SECRET_MODE_ROOT}"
# Read back whatever is on disk, so the URLs match a password kept from an earlier run.
PG_PASSWORD="$(cat "${SECRETS_DIR}/postgres_password")"

# Read by the NON-ROOT operator UI app (startup token, and the readiness panel that inspects every secret),
# so these carry the world-read bit — guarded on the host by the 0700 SECRETS_DIR.
write_secret_if_absent admin_database_url "postgresql://postgres:${PG_PASSWORD}@postgres:5432/catalog" "${SECRET_MODE_APP}"
write_secret_if_absent database_url "postgresql://postgres:${PG_PASSWORD}@postgres:5432/catalog" "${SECRET_MODE_APP}"
write_secret_if_absent completion_secret "$(random_secret)" "${SECRET_MODE_APP}"
write_secret_if_absent custodian_kek "$(random_secret)" "${SECRET_MODE_APP}"
write_secret_if_absent operator_ui_token "$(random_secret)" "${SECRET_MODE_APP}"

mkdir -p "${RECORDS_DIR}"
echo "  ready     ${RECORDS_DIR} (mounted read-only into the container)"

echo
echo "Next:"
echo "  docker compose ${COMPOSE_ARGS}up -d"
echo "  open http://127.0.0.1:8099/"
echo
echo "Your operator token (paste it into the UI's Operator token box):"
echo
cat "${SECRETS_DIR}/operator_ui_token"
echo
echo "Put your Phase 231-240 chain artifacts in ${RECORDS_DIR} to see them in the"
echo "Promotion Record Chain panel. The container reads that folder and can never write to it."
echo
echo "Stop with:  docker compose ${COMPOSE_ARGS}down"
