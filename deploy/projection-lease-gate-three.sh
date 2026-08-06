#!/usr/bin/env bash
# Three consecutive clean runs of the ACCESS-LEASE gate: G24, G25 and G26.
#
# WHY THIS EXISTS AS ITS OWN SCRIPT. "Passing" in `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` means every
# hard gate holds on THREE CONSECUTIVE RUNS, because one green run is a coincidence. Making that a loop inside
# the gate itself would have hidden the most valuable property of the repetition: each run must start from
# nothing — a fresh throwaway database, a fresh manifest directory, a fresh media server config, a fresh mount
# — and a run that inherited the previous one's state would pass for the wrong reason.
#
# A SKIPPED RUN IS NOT A COMPLETED RUN, AND THIS SCRIPT CANNOT SAY OTHERWISE.
#
# The gate exits 77 when the host cannot host it. An earlier version of this wrapper looped over a gate that
# exited 0 on skip, so on a host with no /dev/fuse it printed "3 consecutive runs completed" and exited 0
# having proved nothing whatsoever. That is the shape a tranche-closing acceptance command must never be able
# to take. So: runs are COUNTED, the closing message is emitted only when the count reaches the target, and a
# skip propagates 77 rather than being folded into success.
#
# WHAT IT IS STILL NOT. Three green runs HERE are three green runs on this host. On Windows and Docker Desktop
# that is not Phase 1 closure and SHALL NOT be reported as one; the acceptance plan closes the tranche on a
# Linux or Unraid host. This script exists so that the same command means the same thing when it is finally
# run there.
set -uo pipefail

RUNS="${PROJECTION_LEASE_GATE_RUNS:-3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
# A seam for the offline regression suite: it points this at a stub that exits with a scripted status, so the
# ACCOUNTING below is exercised as behaviour rather than read as source. It defaults to the real gate.
GATE_COMMAND="${PROJECTION_LEASE_GATE_COMMAND:-$HERE/projection-lease-gate.sh}"

completed=0
for run in $(seq 1 "$RUNS"); do
  echo
  echo "############################################################"
  echo "# access-lease gate (G24-G26): run $run of $RUNS"
  echo "############################################################"
  # NOT `|| true`. A failed run stops the sequence, because "two of three passed" is not what the acceptance
  # plan asks for and averaging it would be the exact failure mode this repository is trying to leave behind.
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
# `PROJECTION_LEASE_GATE_RUNS=0`, say -- must not be able to announce a completed sequence either.
if [ "$completed" -ne "$RUNS" ] || [ "$completed" -eq 0 ]; then
  echo "INTERNAL: completed $completed of $RUNS; refusing to report a completed sequence." >&2
  exit 1
fi

echo
echo "$completed of $RUNS consecutive access-lease runs completed, none skipped. On a Linux or Unraid host"
echo "this is the repetition the acceptance plan asks for; on Windows or Docker Desktop it is not, and must"
echo "not be reported as Phase 1 closure. It closes G24, G25 and G26 and NOTHING ELSE: G7-G13 and G18 are"
echo "other gates, G27s three-server half has run 3/3 on a real Unraid host too, and no real provider"
echo "endpoint has ever been contacted, so Phase 1 remains open."
