#!/usr/bin/env bash
# The RCLONE/WEBDAV COMPARISON CONTROL (G22) for a host where it is OPTIONAL.
#
# WHAT THIS IS FOR. A general CI job that runs on whatever runner it is given cannot require a mount: a host
# without /dev/fuse is not a defect there, it is a fact about the runner. This entry point runs the real gate
# and maps its SKIP status (77) to 0, so such a job stays green when the gate genuinely cannot run.
#
# THE GATE HAS ONE SKIP CONDITION AND IT IS /dev/fuse. There is deliberately no second one, and in particular
# there is no "this host is too small for three media servers" skip. A host that cannot run three at once will
# FAIL on a deadline, loudly, which is the correct answer: the comparison's subject is what happens when all
# three read one mount at once, and a version that quietly downgraded to two would be reporting a figure for
# something that is not the thing being compared.
#
# WHAT IT IS NOT FOR, AND THE DISTINCTION IS THE POINT. It is NOT the command that produces the evidence.
# `npm run go:rclone-comparison-gate` and `…:three` propagate 77, so an invocation that was meant to produce a
# comparison FAILS on a host that cannot host it rather than quietly printing nothing. Skip-as-success is a
# property of the CALLER's requirements, so it lives in a separate entry point that a caller has to choose
# deliberately, rather than in the gate where everyone would inherit it.
#
# A REAL FAILURE IS STILL A FAILURE HERE. Only 77 is mapped. Anything else propagates unchanged.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
GATE_COMMAND="${PROJECTION_RCLONE_GATE_COMMAND:-$HERE/projection-rclone-comparison-gate.sh}"

bash "$GATE_COMMAND" "$@"
status=$?

if [ "$status" -eq "$GATE_SKIP_STATUS" ]; then
  echo >&2
  echo "OPTIONAL HOST: the rclone/WebDAV comparison control skipped (status ${GATE_SKIP_STATUS}) and this" >&2
  echo "entry point treats that as success. NOTHING WAS MEASURED. No comparison was produced and no" >&2
  echo "acceptance gate is closed by this run." >&2
  echo "Use 'npm run go:rclone-comparison-gate:three' on a host that can host it for evidence." >&2
  exit 0
fi
exit "$status"
