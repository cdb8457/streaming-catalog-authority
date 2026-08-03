#!/usr/bin/env bash
# Three consecutive clean runs of the RCLONE/WEBDAV COMPARISON CONTROL (G22).
#
# WHY A GATE WITH NO PASS THRESHOLD IS STILL RUN THREE TIMES. `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md`
# says "passing" means every hard gate holds on THREE CONSECUTIVE RUNS, because one green run is a
# coincidence. G22 has no cost threshold to hold — but everything that makes its numbers worth reading does:
# the mount works, the corpus is the corpus, the telemetry is coherent, the window is cold, nothing leaked.
# And the FIGURES need the repetition more than a threshold ever would: a comparison quoted from one run is a
# comparison somebody has to take on trust, while three runs of a deterministic corpus say whether the number
# is a property of the topology or of the afternoon.
#
# EACH RUN MUST START FROM NOTHING — a fresh WebDAV endpoint, a fresh mount, a FRESH CLIENT CACHE and three
# fresh media-server config directories. Making that a loop inside the gate would hide the most valuable
# property of the repetition. On this gate it matters more than on any other: the central measurement is what
# a COLD scan costs, and a run that inherited a populated VFS cache would answer most of the scan without
# reaching the endpoint at all and report the naive path as costing a fraction of what it costs. The gate
# asserts the cache directory was EMPTY, so an inherited one is a failure rather than a silent bargain — but
# the reason it can be is that each run starts from nothing, and this script is what makes that true three
# times.
#
# A SKIPPED RUN IS NOT A COMPLETED RUN, AND THIS SCRIPT CANNOT SAY OTHERWISE. The gate exits 77 when the host
# cannot host it. So: runs are COUNTED, the closing message is emitted only when the count reaches the target,
# and a skip propagates 77 rather than being folded into success.
#
# IT STOPS ON THE FIRST FAILURE OR SKIP. Not `|| true`, not a tally: "two of three produced a measurement" is
# not what the acceptance plan asks for, and averaging it would be the exact failure mode this repository is
# trying to leave behind.
#
# WHAT IT IS STILL NOT. Three runs HERE are three runs on this host. On Windows and Docker Desktop that closes
# NOTHING — not G22, not G7-G13, not G18 — and SHALL NOT be reported as Phase 1 closure. This script exists so
# that the same command means the same thing when it is finally run on Linux or Unraid.
set -uo pipefail

RUNS="${PROJECTION_RCLONE_GATE_RUNS:-3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
# A seam for the offline regression suite: it points this at a stub that exits with a scripted status, so the
# ACCOUNTING below is exercised as behaviour rather than read as source. It defaults to the real gate.
GATE_COMMAND="${PROJECTION_RCLONE_GATE_COMMAND:-$HERE/projection-rclone-comparison-gate.sh}"

completed=0
for run in $(seq 1 "$RUNS"); do
  echo
  echo "############################################################"
  echo "# rclone/WebDAV comparison control: run $run of $RUNS"
  echo "############################################################"
  bash "$GATE_COMMAND"
  status=$?

  if [ "$status" -eq "$GATE_SKIP_STATUS" ]; then
    echo >&2
    echo "SKIPPED at run $run of $RUNS: the gate reported that this host cannot host it." >&2
    echo "  Runs completed: $completed of $RUNS required. THIS SEQUENCE MEASURED NOTHING." >&2
    echo "  A skipped run is not a completed run, and this command exits ${GATE_SKIP_STATUS} rather than 0" >&2
    echo "  so that no caller can read it as three required runs having produced a comparison." >&2
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
# `PROJECTION_RCLONE_GATE_RUNS=0`, say -- must not be able to announce a completed sequence either.
if [ "$completed" -ne "$RUNS" ] || [ "$completed" -eq 0 ]; then
  echo "INTERNAL: completed $completed of $RUNS; refusing to report a completed sequence." >&2
  exit 1
fi

echo
echo "$completed of $RUNS consecutive rclone/WebDAV comparison runs completed, none skipped. That is the"
echo "repetition the acceptance plan asks for -- ON THIS HOST. On Windows or Docker Desktop it closes"
echo "NEITHER G22 NOR any of G7-G13 or G18, and it must not be reported as Phase 1 closure."
echo "G22 has no pass threshold, so what these runs establish is that the comparison's instrumentation held"
echo "three times and that its figures are reproducible -- NOT that the naive path passed or failed anything."
echo "No run of this gate has ever happened on Linux or Unraid, and no real provider endpoint has ever been"
echo "contacted."
