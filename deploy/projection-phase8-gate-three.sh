#!/usr/bin/env bash
# THREE CONSECUTIVE FRESH SOAKS OF THE PHASE 8 GATE - the command Phase 8 closes on.
#
# WHY THIS IS ITS OWN SCRIPT RATHER THAN A LOOP INSIDE THE GATE. "Passing" here means the predeclared closure
# rule holds on three consecutive runs, and the most valuable property of that repetition is that each run
# starts from NOTHING: a fresh throwaway database, a fresh manifest directory, a fresh mount, a fresh probe
# cache, three fresh media-server configuration directories and a fresh resolver process. A loop inside the
# gate would share all of them and would be measuring recovery-while-already-degraded — a different question,
# and one nobody agreed to ask.
#
# ON THIS GATE THE INHERITANCE RISK IS SPECIFIC AND IT IS THE PROBE CACHE. A cache directory that survived
# into the next run would serve that run's reads out of bytes the previous one already fetched, so no link
# would be minted and the provider would never be asked anything — and the gate whose whole subject is a real
# provider surviving faults would report a pass over a run that contacted nothing.
#
# A SKIPPED RUN IS NOT A COMPLETED RUN AND THIS SCRIPT CANNOT SAY OTHERWISE. Runs are COUNTED, the closing
# message is emitted only when the count reaches the target, and a 77 propagates as 77 rather than being
# folded into success.
#
# IT STOPS ON THE FIRST FAILURE OR SKIP. Not `|| true`, not a tally: "two of three passed" is not what the
# contract asks for, and averaging it is the failure mode this repository is trying to leave behind.
set -uo pipefail

RUNS="${PROJECTION_PHASE8_GATE_SOAKS:-3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
# A seam for the offline regression suite: it points this at a stub that exits with a scripted status, so the
# ACCOUNTING below is exercised as behaviour rather than read as source. It defaults to the real gate.
GATE_COMMAND="${PROJECTION_PHASE8_GATE_COMMAND:-$HERE/projection-phase8-gate.sh}"

completed=0
for run in $(seq 1 "$RUNS"); do
  echo
  echo "############################################################"
  echo "# Projection Phase 8: run $run of $RUNS"
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

# THE CLOSING MESSAGE IS GUARDED BY THE COUNT, not by having fallen out of the loop. A loop that never ran —
# `PROJECTION_PHASE8_GATE_SOAKS=0`, say — must not be able to announce a completed sequence either.
if [ "$completed" -ne "$RUNS" ] || [ "$completed" -eq 0 ]; then
  echo "INTERNAL: completed $completed of $RUNS; refusing to report a completed sequence." >&2
  exit 1
fi

echo
echo "$completed of $RUNS consecutive Phase 7 runs completed, none skipped."
echo
echo "WHAT THIS DOES AND DOES NOT CLOSE."
echo
echo "  Each run put THREE real, digest-pinned media servers on ONE production projectiond mount over a REAL"
echo "  provider with BOUNDED AUTOMATIC RECOVERY ON, played five minutes of direct video and five minutes of"
echo "  forced transcode through each of them, seeked ten times on each, and then broke the mount six times"
echo "  on purpose - a lost mount, a corpse, a provider outage, a serve-loop death, a foreign overlay and an"
echo "  unrecoverable fault that spends the whole budget - checking the operator's own approved windows"
echo "  through the mount AND inside each server's container, the mount-layer count, and the three servers'"
echo "  own container binds, after every one of them."
echo
echo "  WHAT IT STILL DOES NOT CLOSE. It is this gate and no other. It re-closes none of G7-G13, G18 or G22,"
echo "  it is not a load test, it declares no winner between frontends, and three green runs on a host that"
echo "  is not Linux or Unraid close nothing at all — read the run header above for which host this was."
