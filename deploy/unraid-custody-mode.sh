#!/usr/bin/env bash
# Catalog Authority — which custody the Unraid runtime stack runs under.
#
#   bash deploy/unraid-custody-mode.sh <project-dir> status
#   bash deploy/unraid-custody-mode.sh <project-dir> bootstrap
#   bash deploy/unraid-custody-mode.sh <project-dir> root-only
#
# Run this ON THE UNRAID HOST. It reads or sets ONE marker file and prints the exact compose command that
# matches it. It starts nothing, stops nothing, changes no YAML, touches no secret and contacts no network.
#
# -----------------------------------------------------------------------------------------------------
# WHY THIS EXISTS.
# -----------------------------------------------------------------------------------------------------
#
# The runtime stack has exactly two valid custody wirings, and the sidecar refuses to start on anything else:
#
#   root-only   the canonical STEADY STATE. The sidecar opens its KEK ring with the root wrapping key. The
#               static KEK is not mounted anywhere in the stack.
#   bootstrap   TEMPORARY, for an installation created before the ring existed. Its wrapped keys are under
#               the STATIC KEK, so the sidecar runs on that key until `ops:custody-cutover` adopts it as
#               generation 1 of a ring.
#
# The previous version of this stack asked an operator to move between those states by EDITING the shipped
# compose file in three places — and to remember to redo it after every upgrade, because an upgrade replaces
# that file. This selects between two files instead.
set -euo pipefail

PROJECT_DIR="${1:-}"
ACTION="${2:-status}"
MARKER_NAME="custody-runtime-mode"
RUNTIME_FILE="docker-compose.unraid.runtime.yml"
BOOTSTRAP_FILE="docker-compose.unraid.bootstrap.yml"

if [ -z "${PROJECT_DIR}" ]; then
  echo "usage: bash deploy/unraid-custody-mode.sh /absolute/host/path/to/project <status|bootstrap|root-only>" >&2
  exit 2
fi
case "${PROJECT_DIR}" in
  /*) ;;
  *) echo "the project directory must be an ABSOLUTE host path, beginning with /" >&2; exit 2 ;;
esac
if [ ! -d "${PROJECT_DIR}" ]; then
  echo "refusing: ${PROJECT_DIR} is not a directory on this host" >&2
  exit 2
fi
if [ ! -f "${PROJECT_DIR}/${RUNTIME_FILE}" ]; then
  echo "refusing: ${PROJECT_DIR} does not hold ${RUNTIME_FILE}, so it is not a Catalog Authority project" >&2
  exit 2
fi

MARKER="${PROJECT_DIR}/${MARKER_NAME}"

current_mode() {
  # NO MARKER IS THE STEADY STATE. An installation nobody has said anything about should be running the
  # canonical stack — and if it has not migrated, its sidecar refuses to start and says so, which is the
  # honest outcome. Defaulting to bootstrap would silently keep a migrated installation on its static key.
  if [ ! -e "${MARKER}" ]; then echo "root-only"; return; fi
  if [ -L "${MARKER}" ] || [ ! -f "${MARKER}" ]; then
    echo "refusing: ${MARKER_NAME} is not a regular file" >&2
    exit 3
  fi
  local value
  value="$(tr -d '[:space:]' < "${MARKER}")"
  case "${value}" in
    bootstrap|root-only) echo "${value}" ;;
    *) echo "refusing: ${MARKER_NAME} does not name a mode this build defines" >&2; exit 3 ;;
  esac
}

print_command() {
  case "$1" in
    bootstrap) echo "  docker compose -f ${RUNTIME_FILE} -f ${BOOTSTRAP_FILE} up -d" ;;
    root-only) echo "  docker compose -f ${RUNTIME_FILE} up -d" ;;
  esac
}

MODE="$(current_mode)"

case "${ACTION}" in
  status)
    echo "custody mode: ${MODE}"
    echo
    echo "Start this stack with:"
    print_command "${MODE}"
    if [ "${MODE}" = "bootstrap" ]; then
      echo
      echo "This is a TEMPORARY state. Finish it with a verified complete backup and:"
      echo "  npm run ops:custody-cutover -- --project ${PROJECT_DIR} --project-name catalogauthority \\"
      echo "    --backup-set <set-name> --plan"
    fi
    ;;
  bootstrap|root-only)
    printf '%s\n' "${ACTION}" > "${MARKER}.tmp.$$"
    mv -f "${MARKER}.tmp.$$" "${MARKER}"
    if [ "${ACTION}" = "root-only" ]; then rm -f "${MARKER}"; fi
    echo "custody mode: ${ACTION}"
    echo
    echo "Nothing has been started or stopped. Apply it with:"
    print_command "${ACTION}"
    if [ "${ACTION}" = "root-only" ] && [ ! -e "${PROJECT_DIR}/.ring-checked" ]; then
      echo
      echo "A FRESH installation needs a ring before the sidecar can start in this mode. If this one has"
      echo "never held a key, create it once:"
      echo "  docker compose -f ${RUNTIME_FILE} run --rm custody-maintenance ops:kek-ring -- init \\"
      echo "    --state /var/lib/catalog-sidecar/state --root-file /run/catalog-custody/custodian_root_key"
      echo
      echo "An installation that already holds wrapped keys must MIGRATE instead — select bootstrap and run"
      echo "ops:custody-cutover. Never run init against a keystore that already holds keys."
    fi
    ;;
  *)
    echo "usage: bash deploy/unraid-custody-mode.sh <project-dir> <status|bootstrap|root-only>" >&2
    exit 2
    ;;
esac
