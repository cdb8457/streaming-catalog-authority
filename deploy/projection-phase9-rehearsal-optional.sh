#!/usr/bin/env bash
# The Phase 9 rehearsal on a host where it is OPTIONAL: 77 becomes 0, and nothing else changes.
#
# WHY THIS IS A SEPARATE ENTRY POINT A CALLER HAS TO CHOOSE. A skip is not a pass, and the rehearsal exits 77
# to say so. On a machine with no node, or no Docker daemon, that 77 is correct and inconvenient at the same
# time, so the fold exists. It is deliberately NOT the default and deliberately not a flag on the rehearsal:
# folding a skip into success is a decision, and a decision belongs in the command somebody typed.
#
# EVERY OTHER STATUS PASSES THROUGH UNCHANGED. A rehearsal that RAN AND FAILED still fails here.
#
# AND IT STILL CLOSES NOTHING. Even a rehearsal that runs and passes leaves §5.2, §5.3, §5.5 and §5.11 open,
# because no Usenet provider was contacted. This wrapper folds a SKIP into a zero exit; it does not fold an
# open phase into a closed one, and nothing in this repository can.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
GATE_COMMAND="${PROJECTION_PHASE9_REHEARSAL_ENTRYPOINT:-$HERE/projection-phase9-rehearsal.sh}"

bash "$GATE_COMMAND"
status=$?

if [ "$status" -eq "$GATE_SKIP_STATUS" ]; then
  echo >&2
  echo "NOTHING WAS PROVED. The Phase 9 rehearsal skipped on this host and this entry point maps that" >&2
  echo "skip to 0 because the caller asked for it. No submission was made, no output was proved, no" >&2
  echo "namespace was compared, no provider was contacted, and Projection Phase 9 is exactly as open as" >&2
  echo "it was before this command." >&2
  exit 0
fi
exit "$status"
