#!/usr/bin/env bash
# Three consecutive clean runs of the media-server data-plane gate.
#
# WHY THIS EXISTS AS ITS OWN SCRIPT. "Passing" in `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` means every
# hard gate holds on THREE CONSECUTIVE RUNS, because one green run is a coincidence. Making that a loop inside
# the gate itself would have hidden the most valuable property of the repetition: each run must start from
# nothing — a fresh throwaway database, a fresh manifest directory, a fresh media server config, a fresh mount
# — and a run that inherited the previous one's state would pass for the wrong reason.
#
# WHAT IT IS STILL NOT. Three green runs HERE are three green runs on this host. On Windows and Docker Desktop
# that is not Phase 1 closure and SHALL NOT be reported as one; the acceptance plan closes the tranche on a
# Linux or Unraid host. This script exists so that the same command means the same thing when it is finally
# run there.
set -euo pipefail

RUNS="${PROJECTION_JELLYFIN_GATE_RUNS:-3}"
HERE="$(cd "$(dirname "$0")" && pwd)"

for run in $(seq 1 "$RUNS"); do
  echo
  echo "############################################################"
  echo "# media-server data-plane gate: run $run of $RUNS"
  echo "############################################################"
  # NOT `|| true`. A failed run stops the sequence, because "two of three passed" is not what the acceptance
  # plan asks for and averaging it would be the exact failure mode this repository is trying to leave behind.
  bash "$HERE/projection-jellyfin-dataplane-gate.sh"
done

echo
echo "$RUNS consecutive runs completed. On a Linux or Unraid host this is the repetition the acceptance plan"
echo "asks for; on Windows or Docker Desktop it is not, and must not be reported as Phase 1 closure."
