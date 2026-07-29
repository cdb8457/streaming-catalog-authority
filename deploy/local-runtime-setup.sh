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
# Phase 259. Where you put catalog snapshots to import. Mounted READ-ONLY into the container.
IMPORT_DIR="${CATALOG_IMPORT_HOST_DIR:-./import}"

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
SECRET_MODE_CUSTODY=600 # owner rw only — every KEK in the installation is reachable from the root key

# ---- THE CUSTODY SECRET, AND WHY IT IS NOT A SHELL FUNCTION ----------------------------------------------
#
# THE ROOT WRAPPING KEY IS THE ONE FILE FROM WHICH EVERY KEY IN THE INSTALLATION IS REACHABLE, and outside
# Swarm Compose delivers it by BIND MOUNTING it — so its ownership and mode ON THIS HOST are the whole of the
# guarantee. A shell version of this checked the path, then redirected into the path, then chmod'ed and
# chown'ed the path: every step resolves the NAME again, and between any two of them the name can become a
# symlink to somewhere else. Running as root during setup, that would re-mode, re-own and overwrite whatever
# it now points at. Checking harder does not close it — the gap is between the check and the use.
#
# So it is done on a DESCRIPTOR, once, by `write-custody-secret.mjs`: O_CREAT|O_EXCL|O_NOFOLLOW to create,
# O_NOFOLLOW to inspect an existing one, and fchmod/fchown/fstat thereafter. An existing file is VERIFIED and
# never repaired, because silently re-owning a key that has been readable by another account is a decision
# this script must not make on an operator's behalf.
#
# THE HELPER IS RESOLVED FROM WHERE THIS FILE IS, not from the working directory: it ships beside this script
# in the release bundle and under deploy/ in a checkout, and both are `${SCRIPT_DIR}`. Its absence is a
# refusal rather than a fallback — a fallback here is a root wrapping key written without the guarantee.
CUSTODY_HELPER="${SCRIPT_DIR}/write-custody-secret.mjs"
# THE OWNER THE SIDECAR RUNS AS, AND WHY THE DEFAULT DEPENDS ON WHO IS RUNNING THIS.
#
# The runtime image declares `USER node`, which is 1000:1000, and the root key is bind-mounted into that
# container — so this host file's ownership is what decides whether the sidecar can read it and whether
# anything else can. GIVING A FILE AWAY IS PRIVILEGED, though: an ordinary user cannot chown to 1000, so a
# non-root setup can only produce a key owned by the person running it. Both are owner-only and neither is a
# weaker file; what differs is which account that owner is. So: as root (the Unraid/Arcane path) the key goes
# to the runtime user; otherwise it goes to you, and the sidecar must then run as you (`user:` in Compose).
# Either way this REFUSES rather than producing a key it cannot place.
if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
  CUSTODY_RUNTIME_UID="${CATALOG_AUTHORITY_RUNTIME_UID:-1000}"
  CUSTODY_RUNTIME_GID="${CATALOG_AUTHORITY_RUNTIME_GID:-1000}"
else
  CUSTODY_RUNTIME_UID="${CATALOG_AUTHORITY_RUNTIME_UID:-$(id -u)}"
  CUSTODY_RUNTIME_GID="${CATALOG_AUTHORITY_RUNTIME_GID:-$(id -g)}"
fi

write_custody_secret() {
  # THE VALUE IS NOT AN ARGUMENT, HERE OR ANYWHERE. It used to be `"$(random_secret)"` handed to the helper
  # on its command line — which put the ROOT WRAPPING KEY of a new installation into `ps` for every account
  # on the host, into shell history, and into the log of any scheduler that ran it. The helper generates it
  # internally now and never prints it, so this function never holds a key and has nothing to leak.
  local name="$1" outcome=""
  if [ ! -f "${CUSTODY_HELPER}" ]; then
    printf 'the custody writer is not beside this script, so the root wrapping key cannot be created with the ownership it requires; refusing.\n' >&2
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    printf 'node is needed to create the root wrapping key on a descriptor rather than through a path; refusing.\n' >&2
    exit 1
  fi
  outcome="$(node "${CUSTODY_HELPER}" "${SECRETS_DIR}/${name}" --generate \
    "${CUSTODY_RUNTIME_UID}" "${CUSTODY_RUNTIME_GID}")" || {
    printf 'FAILED to establish %s as an owner-only file for the sidecar runtime user; refusing.\n' "${name}" >&2
    exit 1
  }
  # THE SAME TWO WORDS EVERY OTHER SECRET REPORTS, so a re-run reads the same whatever wrote the file. An
  # existing custody secret is VERIFIED and kept, never regenerated and never silently re-moded.
  case "${outcome}" in
    created*) echo "  created   ${SECRETS_DIR}/${name}" ;;
    *)        echo "  kept      ${SECRETS_DIR}/${name} (already exists)" ;;
  esac
}

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

# The RUNTIME role's own credential.
#
# Phase 253. Both URLs used to be the postgres superuser, which meant `ops:doctor` reported
# `runtime-least-privileged: FAIL` — correctly — on every ordinary install, forever, because the connection
# the app actually used could write every table and read the completion secret. migrations.sql has always
# created a least-privileged `app` role; what was missing was a credential for it. `ops:bootstrap` reads this
# file and makes the database agree with it, so the runtime connects as `app` and the doctor check passes
# because it is TRUE, not because it was silenced.
#
# On an existing install this file is created but `database_url` below is KEPT as it was — a re-run never
# regenerates a secret. Moving an existing install onto the least-privileged role is a deliberate, documented
# step; see docs/LIFECYCLE_MIGRATION_BACKUP_UPGRADE_ROLLBACK.md.
APP_PASSWORD="$(random_secret | tr -d '\n/+=' | cut -c1-32)"
write_secret_if_absent app_password "${APP_PASSWORD}" "${SECRET_MODE_APP}"
APP_PASSWORD="$(cat "${SECRETS_DIR}/app_password")"

# Read by the NON-ROOT operator UI app (startup token, and the readiness panel that inspects every secret),
# so these carry the world-read bit — guarded on the host by the 0700 SECRETS_DIR.
write_secret_if_absent admin_database_url "postgresql://postgres:${PG_PASSWORD}@postgres:5432/catalog" "${SECRET_MODE_APP}"
write_secret_if_absent database_url "postgresql://app:${APP_PASSWORD}@postgres:5432/catalog" "${SECRET_MODE_APP}"
write_secret_if_absent completion_secret "$(random_secret)" "${SECRET_MODE_APP}"
write_secret_if_absent custodian_kek "$(random_secret)" "${SECRET_MODE_APP}"
# PHASE 282. The ROOT WRAPPING KEY for the sidecar-managed KEK ring. Generated here so a new install
# has one from the start; an existing install adopts its static KEK with `ops:kek-ring migrate`. It is read
# only by the custodian sidecar, only from this file, and never from an environment variable or a command line.
# PHASE 284. THE ROOT WRAPPING KEY IS NOT A COMPOSE SECRET AND IS NOT BEST-EFFORT.
#
# Outside Swarm, Compose implements a `file:` secret as a BIND MOUNT and IGNORES uid/gid/mode — so the only
# thing that decides whether the sidecar can read this file, and whether anything else can, is the OWNERSHIP
# AND MODE OF THIS FILE ON THE HOST. It is therefore created owned by the container's runtime user and
# readable by nobody else, and this script REFUSES rather than continuing if it cannot establish that. A
# best-effort chown here would produce a root key readable by every account on the box, silently.
write_custody_secret custodian_root_key
write_secret_if_absent operator_ui_token "$(random_secret)" "${SECRET_MODE_APP}"

mkdir -p "${RECORDS_DIR}"
echo "  ready     ${RECORDS_DIR} (mounted read-only into the container)"
mkdir -p "${IMPORT_DIR}"
echo "  ready     ${IMPORT_DIR} (catalog snapshots, mounted read-only into the container)"

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
echo "To fill the catalog, put a snapshot file in ${IMPORT_DIR} and preview it:"
echo "  docker compose ${COMPOSE_ARGS}run --rm app npm run ops:catalog-import -- --file your-snapshot.json"
echo "Add --apply to commit it, then open the Catalog panel in the UI."
echo
echo "Stop with:  docker compose ${COMPOSE_ARGS}down"
