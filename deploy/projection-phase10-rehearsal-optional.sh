#!/usr/bin/env bash
# The Phase 10 rehearsal on a host where it is OPTIONAL: 77 becomes 0, and nothing else changes.
#
# WHY THIS IS A SEPARATE ENTRY POINT A CALLER HAS TO CHOOSE. A skip is not a pass, and the rehearsal exits 77
# to say so. On a machine with no node, or no Docker daemon, that 77 is correct and inconvenient at the same
# time, so the fold exists. It is deliberately NOT the default and deliberately not a flag on the rehearsal:
# folding a skip into success is a decision, and a decision belongs in the command somebody typed.
#
# EVERY OTHER STATUS PASSES THROUGH UNCHANGED. A rehearsal that RAN AND FAILED still fails here.
#
# AND IT STILL CLOSES NOTHING. Even a rehearsal that runs and passes leaves P10-1, P10-2, P10-7 and P10-10
# open, because one run is not a set of runs and one shell is not both. This wrapper folds a SKIP into a zero
# exit; it does not fold an open phase into a closed one, and nothing in this repository can.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
GATE_COMMAND="${PROJECTION_PHASE10_REHEARSAL_ENTRYPOINT:-$HERE/projection-phase10-rehearsal.sh}"

bash "$GATE_COMMAND"
status=$?

if [ "$status" -eq "$GATE_SKIP_STATUS" ]; then
  echo >&2
  echo "NOTHING WAS PROVED. The Phase 10 rehearsal skipped on this host and this entry point maps that" >&2
  echo "skip to 0 because the caller asked for it. No database was migrated, no entry was registered, no" >&2
  echo "generation was published, no namespace was compared, and Projection Phase 10 is exactly as open as" >&2
  echo "it was before this command." >&2
  exit 0
fi
exit "$status"
