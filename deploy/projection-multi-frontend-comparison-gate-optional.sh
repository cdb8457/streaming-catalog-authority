#!/usr/bin/env bash
# The multi-frontend comparison harness for a host where it is OPTIONAL.
#
# WHAT THIS IS FOR. A general CI job that runs on whatever runner it is given cannot require a mount: a host
# without /dev/fuse is not a defect there, it is a fact about the runner. This entry point runs the real
# harness and maps its SKIP status (77) to 0, so such a job stays green when it genuinely cannot run.
#
# WHAT IT IS NOT FOR, AND THE DISTINCTION IS THE POINT. It is NOT the command that produces the comparison.
# `npm run go:multi-frontend-comparison` propagates 77, so an invocation that is supposed to yield figures
# FAILS on a host that cannot host it rather than quietly passing. Skip-as-success is a property of the
# CALLER's requirements, so it lives in a separate entry point that a caller has to choose deliberately.
#
# AND THERE IS NO `:three` WRAPPER HERE, WHICH IS NOT AN OVERSIGHT. Every Phase 1 and Phase 2 acceptance gate
# has one, because three consecutive fresh runs is what closes a gate. This is a HARNESS: it has no pass
# threshold, it closes nothing, and its output is a table of measurements. A `:three` would say the opposite
# of all three of those by the mere fact of existing, and a wrapper that implies closure the thing cannot
# deliver is the failure mode this tranche keeps finding. Reproducibility of these figures is established by
# recording each run in `docs/PROJECTION_PHASE_2_RCLONE_BAKEOFF.md`, not by a wrapper counting to three.
#
# A REAL FAILURE IS STILL A FAILURE HERE. Only 77 is mapped. Anything else propagates unchanged.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
GATE_COMMAND="${PROJECTION_MULTI_FRONTEND_COMPARISON_COMMAND:-$HERE/projection-multi-frontend-comparison-gate.sh}"

bash "$GATE_COMMAND" "$@"
status=$?

if [ "$status" -eq "$GATE_SKIP_STATUS" ]; then
  echo >&2
  echo "OPTIONAL HOST: the multi-frontend comparison skipped (status ${GATE_SKIP_STATUS}) and this entry" >&2
  echo "point treats that as success. NOTHING WAS MEASURED. No arm ran, no frontend was compared, and no" >&2
  echo "figure in the bake-off document is supported by this run. Use" >&2
  echo "'npm run go:multi-frontend-comparison' on a host that can host it." >&2
  exit 0
fi
exit "$status"
