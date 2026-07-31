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
  bootstrap)
    # ---- AN EXCLUSIVE, UNPREDICTABLE TEMP IN THE PROVED PROJECT DIRECTORY, THEN AN ATOMIC RENAME --------
    #
    # THE HOLE THIS CLOSES. This was `printf ... > "${MARKER}.tmp.$$"`. Two things were wrong with it, and the
    # TypeScript writer beside it had already fixed both. The NAME WAS PREDICTABLE — a process id is four or
    # five digits and this script's own name tells anybody the rest — and shell redirection FOLLOWS A SYMBOLIC
    # LINK, so a link planted at that name turns this into a write wherever the link points, as whichever
    # account runs this script. Root, on Unraid, in a web terminal.
    #
    # `mktemp` creates the file itself, with O_CREAT|O_EXCL and an unpredictable name, so it cannot be
    # pre-planted and cannot be followed. `umask 077` makes it private from the instant it exists rather than
    # a moment afterwards, and the trap removes it on any exit path — including the one where `mv` fails.
    #
    # PHASE 329. AND THE TRAP MUST NOT DECIDE THE EXIT STATUS. `cleanup() { [ -n "${TEMP}" ] && rm -f
    # "${TEMP}"; }` ends in a TEST, and after a successful `mv` clears `TEMP` that test is FALSE — so the
    # function returned 1, and because it is the last thing an EXIT trap runs, the SHELL EXITED 1 after doing
    # everything correctly. A successful bootstrap reported failure: the marker was written, the stack was
    # selected, and every caller that reads an exit code — an Unraid User Script, a runbook step, anything
    # that would roll back on non-zero — was told the switch had not happened. That is the worst shape a
    # status bug can take, because the rollback it invites acts against state that IS already committed.
    #
    # PHASE 329 CORRECTION 1. AND THE FIRST FIX PUT A SECOND HOLE WHERE THE FIRST ONE HAD BEEN, because it
    # ended a handler that was ALSO INSTALLED FOR `INT` AND `TERM` with `return 0`.
    #
    # A signal handler that returns is not a refusal — it is a RESUMPTION. Bash runs the handler and then
    # CARRIES ON at the next statement, so `kill -TERM` on this script cleaned up a temporary the script was
    # still about to use, ran on to `mv`, published the marker, printed the success text and exited 0. An
    # operator pressing Ctrl-C, or an automation sending TERM to stop a switch mid-flight, got the switch
    # anyway AND was told it succeeded. `set -euo pipefail` does not help: nothing failed.
    #
    # So the two jobs are now separate, because they were never the same job:
    #
    #   `remove_temp`     ONE responsibility — the private temporary is gone. Says whether it managed it.
    #   `on_exit`         THE STATUS IS ALREADY DECIDED when this runs. It captures `$?` FIRST, cleans up, and
    #                     re-exits with the status the script had arrived with — so it can never overwrite an
    #                     earlier failure with a later success. The one thing it may change is 0: a cleanup
    #                     that FAILED after an otherwise successful run is a private temporary left behind in
    #                     the project directory, and that must not disappear into an exit 0.
    #   `on_signal`       THE STATUS IS NOT DECIDED — termination was REQUESTED and must happen. It disarms
    #                     every trap so nothing recurses, removes the temporary, and RE-RAISES the same signal
    #                     against itself with the default disposition, so this script dies of the signal it
    #                     was sent and the caller sees the conventional 128+N. The `exit` after the re-raise
    #                     is unreachable in practice and is there so that a host where the re-raise somehow
    #                     does not kill the shell still cannot fall through into publishing.
    TEMP=""
    remove_temp() {
      [ -n "${TEMP}" ] || return 0
      rm -f "${TEMP}" || return 1
      TEMP=""
      return 0
    }
    on_exit() {
      status=$?
      trap - EXIT
      if ! remove_temp && [ "${status}" -eq 0 ]; then
        echo "refusing: the private temporary file could not be removed from ${PROJECT_DIR}" >&2
        exit 4
      fi
      exit "${status}"
    }
    on_signal() {
      trap - EXIT INT TERM
      remove_temp || echo "warning: the private temporary file could not be removed" >&2
      # STATE IS READ FROM THE FILESYSTEM, NOT FROM A FLAG THIS SCRIPT KEPT. A `PUBLISHED=1` set on the line
      # after `mv` has a real window: a signal delivered between the rename returning and the assignment
      # running would report "not published" about a marker that IS on disk. The marker itself has no such
      # window — it either exists when the handler looks or it does not — so the handler looks.
      if [ -e "${MARKER}" ]; then
        echo "terminated by SIG$1; a custody marker IS present at ${MARKER}." >&2
        echo "Run this script with 'status' to see which mode is in force." >&2
      else
        echo "refusing: terminated by SIG$1 before any custody marker was written" >&2
      fi
      kill -s "$1" "$$"
      exit $((128 + $2))
    }
    trap on_exit EXIT
    trap 'on_signal INT 2' INT
    trap 'on_signal TERM 15' TERM
    TEMP="$(umask 077; mktemp "${PROJECT_DIR}/.custody-mode.XXXXXXXXXX")" || {
      echo "refusing: a private temporary file could not be created in ${PROJECT_DIR}" >&2
      exit 3
    }
    printf '%s\n' "bootstrap" > "${TEMP}"
    chmod 0644 "${TEMP}"
    mv -f "${TEMP}" "${MARKER}"
    TEMP=""
    echo "custody mode: bootstrap"
    echo
    echo "Nothing has been started or stopped. Apply it with:"
    print_command "${ACTION}"
    echo
    echo "This is a TEMPORARY state. Finish it with a verified complete backup and:"
    echo "  npm run ops:custody-cutover -- --project ${PROJECT_DIR} --project-name catalogauthority \\"
    echo "    --backup-set <set-name> --plan"
    ;;
  root-only)
    # THE STEADY STATE IS THE ABSENCE OF A MARKER, so returning to it REMOVES one and never writes one first.
    # The previous version wrote `root-only` and then deleted it: two changes to reach a state defined by
    # having had none, with a window in between where a reader saw a marker this script was about to remove.
    rm -f "${MARKER}"
    echo "custody mode: root-only"
    echo
    echo "Nothing has been started or stopped. Apply it with:"
    print_command "${ACTION}"
    if [ ! -e "${PROJECT_DIR}/.ring-checked" ]; then
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
