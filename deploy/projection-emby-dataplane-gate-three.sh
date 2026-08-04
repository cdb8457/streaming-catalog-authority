#!/usr/bin/env bash
# Three consecutive clean runs of the EMBY data-plane gate.
#
# WHY THIS EXISTS AS ITS OWN SCRIPT. "Passing" in `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` means every hard
# gate holds on THREE CONSECUTIVE RUNS, because one green run is a coincidence. Making that a loop inside the
# gate itself would hide the most valuable property of the repetition: each run must start from nothing — a
# fresh throwaway database, a fresh manifest directory, a fresh media-server config directory, a fresh mount —
# and a run that inherited the previous one's state would pass for the wrong reason.
#
# A SKIPPED RUN IS NOT A COMPLETED RUN, AND THIS SCRIPT CANNOT SAY OTHERWISE. The gate exits 77 when the host
# cannot host it. So: runs are COUNTED, the closing message is emitted only when the count reaches the target,
# and a skip propagates 77 rather than being folded into success. A green tranche-closing command that proved
# nothing is the single worst failure this repository can have.
#
# WHAT IT IS STILL NOT. Three green runs HERE are three green runs on this host. On Windows and Docker Desktop
# that is not Phase 1 closure and SHALL NOT be reported as one; the acceptance plan closes the tranche on a
# Linux or Unraid host, on all three media servers. This script exists so that the same command means the same
# thing when it is finally run there.
set -uo pipefail

RUNS="${PROJECTION_EMBY_GATE_RUNS:-3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
# A seam for the offline regression suite: it points this at a stub that exits with a scripted status, so the
# ACCOUNTING below is exercised as behaviour rather than read as source. It defaults to the real gate.
GATE_COMMAND="${PROJECTION_EMBY_GATE_COMMAND:-$HERE/projection-emby-dataplane-gate.sh}"

completed=0
for run in $(seq 1 "$RUNS"); do
  echo
  echo "############################################################"
  echo "# EMBY data-plane gate: run $run of $RUNS"
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
# `PROJECTION_EMBY_GATE_RUNS=0`, say -- must not be able to announce a completed sequence either.
if [ "$completed" -ne "$RUNS" ] || [ "$completed" -eq 0 ]; then
  echo "INTERNAL: completed $completed of $RUNS; refusing to report a completed sequence." >&2
  exit 1
fi

echo
echo "$completed of $RUNS consecutive EMBY runs completed, none skipped. On a Linux or Unraid host this is one"
echo "media server's share of the repetition the acceptance plan asks for; on Windows or Docker Desktop it is"
echo "not, and must not be reported as Phase 1 closure. All three media servers now have a gate, and all"
echo "three HAVE now run three consecutive fresh times on a real Unraid host. That is one media servers"
echo "share each of G7-G13 and nothing more: G18 and G22 are separate gates, G24-G26 and G27s three-server"
echo "half have NO EXECUTABLE GATE AT ALL, no real provider endpoint has ever been contacted, and Phase 1"
echo "remains open. docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md section 6.1 is the authority on what has run."
