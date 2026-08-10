#!/usr/bin/env bash
# The reliability loop on a host where it is OPTIONAL: 77 becomes 0, and nothing else changes.
#
# WHY THIS IS A SEPARATE ENTRY POINT A CALLER HAS TO CHOOSE. A skip is not a pass, and the gate exits 77 to
# say so. On a CI runner with no /dev/fuse — or on any machine where nobody has placed the operator's
# corpus — that 77 is correct and inconvenient at the same time, so the fold exists. It is deliberately NOT
# the default and deliberately not a flag on the gate: folding a skip into success is a decision, and a
# decision belongs in the command somebody typed.
#
# EVERY OTHER STATUS PASSES THROUGH UNCHANGED. A gate that RAN AND FAILED still fails here.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
GATE_COMMAND="${PROJECTION_RELIABILITY_GATE_COMMAND:-$HERE/projection-reliability-loop-gate.sh}"

bash "$GATE_COMMAND"
status=$?

if [ "$status" -eq "$GATE_SKIP_STATUS" ]; then
  echo >&2
  echo "NOTHING WAS PROVED. The reliability loop skipped on this host and this entry point maps that skip" >&2
  echo "to 0 because the caller asked for it. No cycle ran, no fault was injected, no provider was" >&2
  echo "contacted, and Projection Phase 3 is exactly as open as it was before this command." >&2
  exit 0
fi
exit "$status"
