#!/usr/bin/env bash
# The THREE-SERVER CONCURRENT SCAN gate for a host where it is OPTIONAL.
#
# WHAT THIS IS FOR. A general CI job that runs on whatever runner it is given cannot require a mount: a host
# without /dev/fuse is not a defect there, it is a fact about the runner. This entry point runs the real gate
# and maps its SKIP status (77) to 0, so such a job stays green when the gate genuinely cannot run.
#
# THE GATE HAS ONE SKIP CONDITION AND IT IS /dev/fuse. There is deliberately no second one, and in particular
# there is no "this host is too small for three media servers" skip. A host that cannot run three servers at
# once will FAIL this gate on a deadline, loudly, which is the correct answer: the gate's whole subject is
# what happens when all three run at once, and a version of it that quietly downgraded to two would be
# reporting G18 for something that is not G18.
#
# WHAT IT IS NOT FOR, AND THE DISTINCTION IS THE POINT. It is NOT the command the acceptance plan names as
# evidence. `npm run go:three-server-concurrency-gate` and `…:three` propagate 77, so a required acceptance
# invocation on a host that cannot host the gate FAILS rather than quietly passing. Skip-as-success is a
# property of the CALLER's requirements, so it lives in a separate entry point that a caller has to choose
# deliberately, rather than in the gate where everyone would inherit it.
#
# A REAL FAILURE IS STILL A FAILURE HERE. Only 77 is mapped. Anything else propagates unchanged.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
GATE_COMMAND="${PROJECTION_LIFECYCLE_GATE_COMMAND:-$HERE/projection-three-server-concurrency-gate.sh}"

bash "$GATE_COMMAND" "$@"
status=$?

if [ "$status" -eq "$GATE_SKIP_STATUS" ]; then
  echo >&2
  echo "OPTIONAL HOST: the three-server concurrent scan gate skipped (status ${GATE_SKIP_STATUS}) and this" >&2
  echo "entry point treats that as success. NOTHING WAS PROVED. No acceptance gate is closed by this run." >&2
  echo "Use 'npm run go:three-server-concurrency-gate:three' on a host that can host it for evidence." >&2
  exit 0
fi
exit "$status"
