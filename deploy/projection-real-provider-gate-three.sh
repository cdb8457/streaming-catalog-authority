#!/usr/bin/env bash
# Three consecutive clean runs of the PATH LIFECYCLE gate (G27's three-server half).
#
# WHY THIS EXISTS AS ITS OWN SCRIPT. "Passing" in `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` means every
# hard gate holds on THREE CONSECUTIVE RUNS, because one green run is a coincidence. Making that a loop inside
# the gate itself would hide the most valuable property of the repetition: each run must start from nothing —
# a fresh throwaway database, a fresh manifest directory, THREE fresh media-server config directories, a fresh
# mount and a fresh probe cache — and a run that inherited the previous one's state would pass for the wrong
# reason.
#
# ON THIS GATE THE INHERITANCE RISK IS SPECIFIC AND NASTY. Every assertion here is a SET DIFFERENCE between
# two inventories taken from three real media servers. A media-server config directory that survived into the
# next run would carry its library, its item ids and its previous catalogue with it — so the "before"
# inventory of run 2 could contain path B from run 1, the deletion phase would compare against the wrong
# baseline, and the addition phase could be satisfied by an item that was never added because it never left.
# Three fresh config directories are what make each run's baseline its own.
#
# A SKIPPED RUN IS NOT A COMPLETED RUN, AND THIS SCRIPT CANNOT SAY OTHERWISE. The gate exits 77 when the host
# cannot host it. So: runs are COUNTED, the closing message is emitted only when the count reaches the target,
# and a skip propagates 77 rather than being folded into success. A green tranche-closing command that proved
# nothing is the single worst failure this repository can have.
#
# IT STOPS ON THE FIRST FAILURE OR SKIP. Not `|| true`, not a tally: "two of three passed" is not what the
# acceptance plan asks for, and averaging it would be the exact failure mode this repository is trying to
# leave behind.
#
# WHAT IT IS STILL NOT. Three green runs HERE are three green runs on this host. On Windows and Docker Desktop
# that is not Phase 1 closure, does not close G27, and SHALL NOT be reported as either; the acceptance plan
# closes the tranche on a Linux or Unraid host. This script exists so that the same command means the same
# thing when it is finally run there.
set -uo pipefail

RUNS="${PROJECTION_REAL_PROVIDER_GATE_RUNS:-3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
# A seam for the offline regression suite: it points this at a stub that exits with a scripted status, so the
# ACCOUNTING below is exercised as behaviour rather than read as source. It defaults to the real gate.
GATE_COMMAND="${PROJECTION_REAL_PROVIDER_GATE_COMMAND:-$HERE/projection-real-provider-gate.sh}"

completed=0
for run in $(seq 1 "$RUNS"); do
  echo
  echo "############################################################"
  echo "# real-provider gate: run $run of $RUNS"
  echo "############################################################"
  bash "$GATE_COMMAND"
  status=$?

  if [ "$status" -eq "$GATE_SKIP_STATUS" ]; then
    echo >&2
    echo "SKIPPED at run $run of $RUNS: the gate reported that this host cannot host it." >&2
    echo "  Runs completed: $completed of $RUNS required. THIS SEQUENCE CLOSES NOTHING." >&2
    echo "  A skipped run is not a completed run, and this command exits ${GATE_SKIP_STATUS} rather than 0" >&2
    echo "  so that no caller can read it as three required runs having passed." >&2
    exit "$GATE_SKIP_STATUS"
  fi
  if [ "$status" -ne 0 ]; then
    echo >&2
    echo "FAILED at run $run of $RUNS (status $status). Runs completed: $completed of $RUNS required." >&2
    exit "$status"
  fi
  completed=$((completed + 1))
done

# THE CLOSING MESSAGE IS GUARDED BY THE COUNT, not by having fallen out of the loop. A loop that never ran --
# `PROJECTION_REAL_PROVIDER_GATE_RUNS=0`, say -- must not be able to announce a completed sequence either.
if [ "$completed" -ne "$RUNS" ] || [ "$completed" -eq 0 ]; then
  echo "INTERNAL: completed $completed of $RUNS; refusing to report a completed sequence." >&2
  exit 1
fi

echo
echo "$completed of $RUNS consecutive real-provider runs completed, none skipped. On a Linux or Unraid host"
echo "this is the repetition the acceptance plan asks for, for THIS gate, and it closes NOTHING ELSE: a real"
echo "provider endpoint has still never been contacted, and Phase 1 remains open on that ground alone."
echo "What has been run is docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md G27's three-server half. The publisher"
echo "side of G27 -- that admission REFUSES a moved carried entry -- is closed separately and offline by"
echo "npm run test:projection-publisher, and this gate does not replace it."
