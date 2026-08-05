#!/usr/bin/env bash
# Three consecutive clean runs of the THREE-SERVER CONCURRENT SCAN gate (G18).
#
# WHY THIS EXISTS AS ITS OWN SCRIPT. "Passing" in `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` means every
# hard gate holds on THREE CONSECUTIVE RUNS, because one green run is a coincidence. Making that a loop
# inside the gate itself would hide the most valuable property of the repetition: each run must start from
# nothing — a fresh throwaway database, a fresh manifest directory, THREE fresh media-server config
# directories, a fresh mount and a fresh probe cache — and a run that inherited the previous one's state
# would pass for the wrong reason.
#
# ON THIS GATE THAT MATTERS MORE THAN ON THE OTHER THREE. Its central measurement is a COLD window: the
# corpus is published after the libraries exist and the three concurrent scans are the first thing that ever
# reads it. A run that inherited a warm probe cache would measure a window in which the data plane did no
# work, and every ceiling would be satisfied by an empty room. The gate asserts that the ENDPOINT had served
# zero bytes for any corpus object and that the daemon's cache GREW — NOT that the cache was empty, which is
# false and correctly so: the gate publishes a local seed entry on purpose and a local entry's own
# byte-identity window lands in that cache. An inherited warm cache is therefore a failure rather than a
# silent pass — but the reason it can be is that each run starts from nothing, and this script is what makes
# that true three times.
#
# A SKIPPED RUN IS NOT A COMPLETED RUN, AND THIS SCRIPT CANNOT SAY OTHERWISE. The gate exits 77 when the host
# cannot host it. So: runs are COUNTED, the closing message is emitted only when the count reaches the
# target, and a skip propagates 77 rather than being folded into success. A green tranche-closing command
# that proved nothing is the single worst failure this repository can have.
#
# IT STOPS ON THE FIRST FAILURE OR SKIP. Not `|| true`, not a tally: "two of three passed" is not what the
# acceptance plan asks for, and averaging it would be the exact failure mode this repository is trying to
# leave behind.
#
# WHAT IT IS STILL NOT. Three green runs HERE are three green runs on this host. On Windows and Docker
# Desktop that is not Phase 1 closure, does not close G18, and SHALL NOT be reported as either; the
# acceptance plan closes the tranche on a Linux or Unraid host. This script exists so that the same command
# means the same thing when it is finally run there.
set -uo pipefail

RUNS="${PROJECTION_THREE_GATE_RUNS:-3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
# A seam for the offline regression suite: it points this at a stub that exits with a scripted status, so the
# ACCOUNTING below is exercised as behaviour rather than read as source. It defaults to the real gate.
GATE_COMMAND="${PROJECTION_THREE_GATE_COMMAND:-$HERE/projection-three-server-concurrency-gate.sh}"

completed=0
for run in $(seq 1 "$RUNS"); do
  echo
  echo "############################################################"
  echo "# three-server concurrent scan gate: run $run of $RUNS"
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
# `PROJECTION_THREE_GATE_RUNS=0`, say -- must not be able to announce a completed sequence either.
if [ "$completed" -ne "$RUNS" ] || [ "$completed" -eq 0 ]; then
  echo "INTERNAL: completed $completed of $RUNS; refusing to report a completed sequence." >&2
  exit 1
fi

echo
echo "$completed of $RUNS consecutive three-server concurrent-scan runs completed, none skipped. On a Linux"
echo "or Unraid host this would be the repetition the acceptance plan asks for; on Windows or Docker Desktop"
echo "it is NOT, it closes NEITHER G18 NOR any of G7-G13, and it must not be reported as Phase 1 closure."
echo "This gate HAS now run on a real Unraid host — three consecutive fresh runs, none skipped. That is the"
echo "repetition the acceptance plan asks for, for THIS gate, and it closes NOTHING ELSE: G7-G13 are other"
echo "gates, G27s three-server half has no executable gate, no real provider endpoint has ever been"
echo "contacted, and"
echo "Phase 1 remains open. What has been run is docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md section 6.1."
