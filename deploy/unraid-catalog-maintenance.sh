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
#   * IT DELETES NOTHING, IN ANY MODE. Retention here is a PLAN. Since Phases 305-312 that plan is made by the
#     shipped `ops:backup-retention`, which verifies every set and ends with a digest over the whole list;
#     actually removing a set takes that digest back through `--confirm`, typed by a person who has just read
#     it. There is no mode of this script that does, because "clean up old backups" is one mistyped variable
#     away from "remove the only copy of something irrecoverable".
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
MODE="${1:-monitor}"                                   # monitor | backup | retention-plan | safety-set-plan

usage() {
  cat <<'USAGE'
usage: unraid-catalog-maintenance.sh [monitor|backup|retention-plan|safety-set-plan]

  monitor          run the read-only doctor monitor once (schedule this every few minutes)
  backup           take and verify one complete backup     (schedule this nightly)
  retention-plan   verify every backup set and print what a cleanup WOULD remove, with a digest.
                   Removes nothing, and there is no mode here that does.
  safety-set-plan  the same, for the safety sets a RESTORE left behind. ops:backup-retention never
                   touches those on purpose, so they build up one per restore; this prints what
                   ops:safety-set-lifecycle WOULD remove, with a digest. Removes nothing either.

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
  # RETENTION IS A PLAN HERE, AND THAT IS THE WHOLE DESIGN.
  #
  # PHASES 305-312 CHANGED WHAT THIS MODE RUNS, AND DELIBERATELY DID NOT CHANGE WHAT IT DOES. It used to be a
  # shell loop over `ls`, sorting names LEXICALLY, hashing that listing, and telling an operator to go and
  # recursively delete a directory by hand. That could not tell a set that verifies from one truncated last
  # Tuesday, could not tell the ONLY restorable set from one of ten, could not tell the pre-upgrade rollback
  # point from a routine nightly, took no lock, and — being a recursive delete — left half a set under a name
  # an operator trusts if it was interrupted.
  #
  # It now runs the shipped `ops:backup-retention --plan`, which VERIFIES every set, orders by the manifests'
  # own dates rather than by name, protects the newest restorable set and the newest rollback point
  # unconditionally, and prints a digest over the WHOLE list — every set, its date, its verification and its
  # decision.
  #
  # IT STILL REMOVES NOTHING, AND THERE IS STILL NO FLAG HERE THAT WOULD. Removing a set takes that digest
  # back through `--confirm`, typed by a person who has just read what they are removing. Backups deleted on
  # a timer are how the copy you needed goes away on the night the thing you needed it for happened.
  # -------------------------------------------------------------------------------------------------------
  retention-plan)
    KEEP="${CATALOG_RETENTION_KEEP:-7}"
    MIN_AGE="${CATALOG_RETENTION_MIN_AGE_DAYS:-7}"
    run_in_project npm run --silent ops:backup-retention -- \
      --project "${PROJECT_DIR}" --keep-last "${KEEP}" --min-age-days "${MIN_AGE}" --plan
    echo ""
    echo "Nothing was removed, and this script has no mode that removes anything. To act on the plan above,"
    echo "run ops:backup-retention yourself with the digest it printed. Read the list first."
    ;;

  safety-set-plan)
    # ---------------------------------------------------------------------------------------------------
    # THE SECOND PLAN, AND IT REMOVES NOTHING FOR THE SAME REASON THE FIRST ONE DOES.
    #
    # A restore publishes its safety set inside a directory it claims exclusively, and ops:backup-retention
    # deliberately never descends into an in-flight namespace — so those accumulate one per restore and only
    # ops:safety-set-lifecycle can see them. Acting on this plan means typing its digest back, by a person
    # who has just read the list. A timer cannot read a list.
    # ---------------------------------------------------------------------------------------------------
    SAFETY_KEEP="${CATALOG_SAFETY_SET_KEEP:-3}"
    SAFETY_MIN_AGE="${CATALOG_SAFETY_SET_MIN_AGE_DAYS:-14}"
    run_in_project npm run --silent ops:safety-set-lifecycle -- \
      --project "${PROJECT_DIR}" --keep-last "${SAFETY_KEEP}" --min-age-days "${SAFETY_MIN_AGE}" --plan
    echo ""
    echo "Nothing was removed, and this script has no mode that removes anything. To act on the plan above,"
    echo "run ops:safety-set-lifecycle yourself with the digest it printed. Read the list first."
    ;;

  *)
    usage >&2
    exit 2
    ;;
esac
