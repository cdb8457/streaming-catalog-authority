#!/usr/bin/env bash
# Catalog Authority — Arcane/Unraid project setup.
#
#   bash deploy/arcane-setup.sh /mnt/user/projects/catalog-authority
#
# Run this ON THE UNRAID HOST (a terminal on the server, or the Unraid web terminal), against the folder you
# want this installation to live in. It creates the directory layout `docker-compose.arcane.yml` binds, and
# generates one file per secret.
#
# WHY IT TAKES THE PATH AS AN ARGUMENT AND HAS NO DEFAULT. Where your projects live is your decision and this
# repository does not know it. A built-in default is how an installation silently lands somewhere nobody
# chose — which, under Arcane, is precisely the failure this whole file exists downstream of. The path you
# pass here is the same string you put in CATALOG_AUTHORITY_PROJECT_DIR, and a preflight checks that they
# agree with reality before Docker has to. WHICH preflight depends on where this script is running from, and
# it works that out for itself: from a source checkout it is `npm run ops:arcane-preflight`, and from an
# extracted release bundle — where there is no Node.js and must not need to be — it is
# `docker compose -f docker-compose.arcane.yml config --quiet`, which makes Compose itself refuse the
# required variables when they are unset or wrong.
#
# IT IS SAFE TO RE-RUN. Every secret that already exists is KEPT, never regenerated: a re-run cannot lock you
# out of a running stack, cannot orphan a database that was initialised with the old password, and cannot
# invalidate the operator token in someone's browser. Only the file modes are re-applied.
#
# IT STARTS NOTHING. No container, no migration, no promotion, no approval, no execution, no archival, no
# deletion. It contacts no provider, no media server and no library.
set -euo pipefail

# WHERE AM I RUNNING FROM? This script ships twice: here under deploy/ in a checkout, and at the root of the
# release bundle, where there is no deploy/ directory, no package.json and no Node.js. The difference decides
# which check to print — telling a bundle user to run `npm` would be telling them to install a toolchain the
# whole bundle exists to avoid. Same detection the ordinary setup script already uses.
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
if [ "$(basename "${SCRIPT_DIR}")" = "deploy" ]; then
  USAGE_PREFIX="bash deploy/arcane-setup.sh"
  PREFLIGHT_COMMAND="npm run ops:arcane-preflight"
else
  USAGE_PREFIX="bash ./arcane-setup.sh"
  PREFLIGHT_COMMAND="docker compose -f docker-compose.arcane.yml config --quiet"
fi

PROJECT_DIR="${1:-}"
if [ -z "${PROJECT_DIR}" ]; then
  echo "usage: ${USAGE_PREFIX} /absolute/host/path/to/your/project" >&2
  echo >&2
  echo "The path is the one the UNRAID HOST uses — the path Unraid shows you under Shares, not the path" >&2
  echo "Arcane shows you. Arcane stores projects inside its own container by default, and the Docker daemon" >&2
  echo "cannot see that path; a bind source written that way fails with an error naming a path you never" >&2
  echo "typed. See the header of docker-compose.arcane.yml." >&2
  exit 2
fi

case "${PROJECT_DIR}" in
  /*) ;;
  *) echo "the project directory must be an ABSOLUTE host path, beginning with /" >&2; exit 2 ;;
esac
case "${PROJECT_DIR}" in
  /app/data|/app/data/*)
    echo "refusing: ${PROJECT_DIR} is inside Arcane's own container, not on the Unraid host." >&2
    echo "Give the host path this project really has, or bind-mount your host projects directory into the" >&2
    echo "Arcane container at the SAME path and set Arcane's PROJECTS_DIRECTORY to it." >&2
    exit 2 ;;
esac

SECRETS_DIR="${PROJECT_DIR}/secrets"
RECORDS_DIR="${PROJECT_DIR}/promotion-records"
# Phase 259. Where you put catalog snapshots to import. Mounted READ-ONLY into the container.
IMPORT_DIR="${PROJECT_DIR}/import"

random_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 32
  elif command -v node >/dev/null 2>&1; then node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  elif [ -r /dev/urandom ]; then head -c 32 /dev/urandom | base64
  else echo "need openssl, node, or /dev/urandom to generate a secret" >&2; exit 1
  fi
}

# See the long note in deploy/local-runtime-setup.sh: under non-Swarm `docker compose` a file secret is a bind
# mount whose host permission bits reach the container unchanged, and the app runs as the non-root `node`
# user. The 0700 directory is the host boundary; the world-read bit is what lets the container read through
# the mount. postgres_password is read as root inside its container and keeps the tighter mode.
SECRET_MODE_APP=644
SECRET_MODE_ROOT=600
SECRET_MODE_CUSTODY=600 # owner rw only — every KEK in the installation is reachable from the root key

write_secret_if_absent() {
  name="$1"; value="$2"; mode="${3:-${SECRET_MODE_APP}}"
  if [ -f "${SECRETS_DIR}/${name}" ]; then
    chmod "${mode}" "${SECRETS_DIR}/${name}" 2>/dev/null || true
    echo "  kept      secrets/${name} (already exists)"
    return
  fi
  printf '%s\n' "${value}" > "${SECRETS_DIR}/${name}"
  chmod "${mode}" "${SECRETS_DIR}/${name}" 2>/dev/null || true
  echo "  created   secrets/${name}"
}

echo "Catalog Authority — Arcane/Unraid project setup"
echo "  project directory: ${PROJECT_DIR}"
echo

mkdir -p "${SECRETS_DIR}" "${RECORDS_DIR}" "${IMPORT_DIR}" "${PROJECT_DIR}/pgdata" "${PROJECT_DIR}/keystore"
chmod 700 "${SECRETS_DIR}" 2>/dev/null || true

PG_PASSWORD="$(random_secret | tr -d '\n/+=' | cut -c1-32)"
write_secret_if_absent postgres_password "${PG_PASSWORD}" "${SECRET_MODE_ROOT}"
PG_PASSWORD="$(cat "${SECRETS_DIR}/postgres_password")"

# The RUNTIME role gets its own generated credential, not the owner's. `ops:bootstrap` makes the database
# agree with whatever is in this file, so the app connects with the least-privileged `app` role and
# `ops:doctor` can report runtime-least-privileged honestly instead of failing on every install.
APP_PASSWORD="$(random_secret | tr -d '\n/+=' | cut -c1-32)"
write_secret_if_absent app_password "${APP_PASSWORD}" "${SECRET_MODE_APP}"
APP_PASSWORD="$(cat "${SECRETS_DIR}/app_password")"

write_secret_if_absent admin_database_url "postgresql://postgres:${PG_PASSWORD}@postgres:5432/catalog" "${SECRET_MODE_APP}"
write_secret_if_absent database_url "postgresql://app:${APP_PASSWORD}@postgres:5432/catalog" "${SECRET_MODE_APP}"
write_secret_if_absent completion_secret "$(random_secret)" "${SECRET_MODE_APP}"
write_secret_if_absent custodian_kek "$(random_secret)" "${SECRET_MODE_APP}"
# PHASE 282. The ROOT WRAPPING KEY for the sidecar-managed KEK ring. Generated here so a new install
# has one from the start; an existing install adopts its static KEK with `ops:kek-ring migrate`. It is read
# only by the custodian sidecar, only from this file, and never from an environment variable or a command line.
write_secret_if_absent custodian_root_key "$(random_secret)" "${SECRET_MODE_CUSTODY}"
write_secret_if_absent operator_ui_token "$(random_secret)" "${SECRET_MODE_APP}"

echo "  ready     promotion-records/ (mounted read-only into the container)"
echo "  ready     import/ (catalog snapshots, mounted read-only into the container)"
echo "  ready     pgdata/, keystore/"
echo
echo "Next, in this project's .env, next to docker-compose.arcane.yml:"
echo
echo "  CATALOG_AUTHORITY_PROJECT_DIR=${PROJECT_DIR}"
echo "  OPERATOR_UI_BIND_ADDRESS=<this Unraid server's LAN address>"
echo
echo "OPERATOR_UI_BIND_ADDRESS has no default and the stack will refuse to start without it. Set it to the"
echo "server's LAN address to reach the UI from your network. 127.0.0.1 is also valid and means the Unraid"
echo "server ONLY — not your laptop, not another machine on the LAN, whatever address you type in a browser."
echo
echo "Then check it, and start:"
echo "  ${PREFLIGHT_COMMAND}"
echo "  docker compose -f docker-compose.arcane.yml up -d"
echo
echo "Your operator token (paste it into the UI's Operator token box):"
echo
cat "${SECRETS_DIR}/operator_ui_token"
