#!/usr/bin/env bash
# Catalog Authority — Phase 278 scheduled maintenance, as an Unraid User Scripts / cron example.
#
# WHAT THIS IS. A worked example of scheduling the two commands this product ships for unattended use:
# `ops:doctor-monitor` (every few minutes) and `ops:complete-backup` (nightly). It is an EXAMPLE and not a
# product file: copy it, set the four variables at the top, and schedule it. Nothing here is installed by the
# release bundle and nothing in the product runs it.
#
# WHAT IT DELIBERATELY DOES NOT DO:
#
#   * IT SENDS NO ALERT. It makes no outbound call by any mechanism. The commands exit with distinct codes and this
#     script exits with them; Unraid's User Scripts, cron's MAILTO, or whatever you already run is what tells
#     you. A monitor that alerts is a monitor that is silent when the alerting is what broke.
#   * IT PASSES NO CREDENTIAL. Not on a command line, not in an environment variable. The commands refuse a
#     flag whose name looks like a secret; secrets reach the product through the files the setup script made.
#   * IT DELETES NOTHING BY DEFAULT. Retention is a PLAN. See RETENTION below: removing a backup requires an
#     exact digest of the set list you were shown, typed deliberately, because "clean up old backups" is one
#     mistyped variable away from "remove the only copy of something irrecoverable".
#   * IT TOUCHES NO MEDIA PATH AND NO MEDIA SERVER. Neither does anything it calls.
#
# OVERLAP. Two copies of this cannot run at once: `flock` on a lock file beside the project, plus the
# product's own maintenance lock underneath it. Both are needed — the first stops two of THIS script, the
# second stops this script racing a backup somebody started by hand.

set -euo pipefail

# ---------------------------------------------------------------------------------------------------------
# Set these four. Everything else is derived.
# ---------------------------------------------------------------------------------------------------------
PROJECT_DIR="${CATALOG_PROJECT_DIR:-/mnt/user/appdata/catalog-authority}"
CUSTODY_MODE="${CATALOG_CUSTODY_MODE:-inline}"        # inline | sidecar
SIDECAR_STATE_REL="${CATALOG_SIDECAR_STATE_REL:-}"    # required when CUSTODY_MODE=sidecar, e.g. sidecar-state
STATE_DIR_REL="${CATALOG_STATE_DIR_REL:-monitor}"     # an existing directory for the monitor state file

# How long one scheduled run may take before it is killed. A maintenance run that never ends is a schedule
# that never runs again.
TIMEOUT_SECONDS="${CATALOG_MAINTENANCE_TIMEOUT:-3600}"

LOCK_FILE="${PROJECT_DIR}/.catalog-maintenance.flock"
MODE="${1:-monitor}"                                   # monitor | backup | retention-plan

usage() {
  cat <<'USAGE'
usage: unraid-catalog-maintenance.sh [monitor|backup|retention-plan]

  monitor          run the read-only doctor monitor once (schedule this every few minutes)
  backup           take and verify one complete backup     (schedule this nightly)
  retention-plan   list backup sets and print what a cleanup WOULD remove. Removes nothing.

Exit codes are the underlying command's, unchanged:
  monitor: 0 healthy | 3 WARN | 1 FAIL | 4 the doctor could not be read
  backup:  0 taken and verified | 1 taken and did NOT verify | 3 refused before anything ran
USAGE
}

if [ "${MODE}" = "--help" ] || [ "${MODE}" = "-h" ]; then usage; exit 0; fi

[ -d "${PROJECT_DIR}" ] || { echo "FAIL: the project directory is not there" >&2; exit 3; }
command -v flock >/dev/null 2>&1 || { echo "FAIL: flock is required so two runs cannot overlap" >&2; exit 3; }
command -v timeout >/dev/null 2>&1 || { echo "FAIL: timeout is required so a run is bounded" >&2; exit 3; }

# ---------------------------------------------------------------------------------------------------------
# One at a time, and bounded. `-n` means a second run REFUSES rather than queues: a queue of maintenance runs
# is how a slow night becomes twelve overlapping backups.
# ---------------------------------------------------------------------------------------------------------
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "another maintenance run holds the lock; this one is skipping (that is the correct outcome)" >&2
  exit 0
fi

run_in_project() {
  # `docker compose run --rm --no-deps` is NOT used here: these commands run on the HOST, beside the project,
  # because stopping the app is the one thing a container inside it cannot do to itself.
  ( cd "${PROJECT_DIR}" && timeout "${TIMEOUT_SECONDS}" "$@" )
}

case "${MODE}" in
  monitor)
    run_in_project npm run --silent ops:doctor-monitor -- \
      --project "${PROJECT_DIR}" --state "${STATE_DIR_REL}"
    ;;

  backup)
    SET_NAME="set-$(date -u +%Y%m%dT%H%M%SZ)"
    if [ "${CUSTODY_MODE}" = "sidecar" ]; then
      [ -n "${SIDECAR_STATE_REL}" ] || { echo "FAIL: sidecar custody needs CATALOG_SIDECAR_STATE_REL" >&2; exit 3; }
      run_in_project npm run --silent ops:complete-backup -- \
        --project "${PROJECT_DIR}" --set "${SET_NAME}" \
        --custodian sidecar --sidecar-state "${SIDECAR_STATE_REL}"
    else
      run_in_project npm run --silent ops:complete-backup -- \
        --project "${PROJECT_DIR}" --set "${SET_NAME}" --custodian inline
    fi
    ;;

  # -------------------------------------------------------------------------------------------------------
  # RETENTION IS A PLAN, AND THAT IS THE WHOLE DESIGN.
  #
  # This prints the sets it can see, oldest first, and says which ones a policy WOULD remove. It removes
  # nothing, and there is deliberately no flag here that would. To actually remove a set you read this list,
  # decide, and remove that one directory yourself — a decision with a name attached, taken by a person who
  # has just read what they are removing.
  #
  # The digest below is over the ENUMERATED SET LIST. It exists so that a future destructive step, if one is
  # ever added, can require the exact list the operator was shown: a cleanup authorised against a list that
  # has since changed is a cleanup of something nobody looked at.
  # -------------------------------------------------------------------------------------------------------
  retention-plan)
    BACKUP_DIR="${PROJECT_DIR}/backups"
    [ -d "${BACKUP_DIR}" ] || { echo "no backups directory yet; nothing to plan"; exit 0; }
    KEEP="${CATALOG_RETENTION_KEEP:-7}"
    echo "backup sets, oldest first (keeping the newest ${KEEP}):"
    SETS="$(ls -1 "${BACKUP_DIR}" 2>/dev/null | grep -v '^\.' | sort || true)"
    [ -n "${SETS}" ] || { echo "  (none)"; exit 0; }
    TOTAL="$(printf '%s\n' "${SETS}" | wc -l | tr -d ' ')"
    INDEX=0
    printf '%s\n' "${SETS}" | while IFS= read -r NAME; do
      INDEX=$((INDEX + 1))
      if [ "$((TOTAL - INDEX))" -ge "${KEEP}" ]; then
        echo "  WOULD REMOVE  ${NAME}"
      else
        echo "  keep          ${NAME}"
      fi
    done
    echo ""
    echo "set-list digest: $(printf '%s\n' "${SETS}" | sha256sum | cut -d' ' -f1)"
    echo "Nothing was removed. This command has no flag that removes anything: read the list, then remove the"
    echo "one directory you decided on. Verify what you are keeping with ops:backup-inspect first."
    ;;

  *)
    usage >&2
    exit 2
    ;;
esac
