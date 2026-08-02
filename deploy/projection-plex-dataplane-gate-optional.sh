#!/usr/bin/env bash
# The PLEX data-plane gate for a host where it is OPTIONAL.
#
# WHAT THIS IS FOR. A general CI job that runs on whatever runner it is given cannot require a mount: a host
# without /dev/fuse is not a defect there, it is a fact about the runner. Nor can it require egress to
# plex.tv, which an unclaimed Plex needs in order to answer its own local API at all. This entry point runs
# the real gate and maps its SKIP status (77) to 0, so such a job stays green when the gate genuinely cannot
# run.
#
# WHAT IT IS NOT FOR, AND THE DISTINCTION IS THE POINT. It is NOT the command the acceptance plan names as
# evidence. `npm run go:plex-dataplane-gate` and `npm run go:plex-dataplane-gate:three` propagate 77, so a
# required acceptance invocation on a host that cannot host the gate FAILS rather than quietly passing.
# Skip-as-success is a property of the CALLER's requirements, so it lives in a separate entry point that a
# caller has to choose deliberately, rather than in the gate where everyone would inherit it.
#
# A REAL FAILURE IS STILL A FAILURE HERE. Only 77 is mapped. Anything else propagates unchanged.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
GATE_COMMAND="${PROJECTION_PLEX_GATE_COMMAND:-$HERE/projection-plex-dataplane-gate.sh}"

bash "$GATE_COMMAND" "$@"
status=$?

if [ "$status" -eq "$GATE_SKIP_STATUS" ]; then
  echo >&2
  echo "OPTIONAL HOST: the Plex data-plane gate skipped (status ${GATE_SKIP_STATUS}) and this entry point" >&2
  echo "treats that as success. NOTHING WAS PROVED. No acceptance gate is closed by this run. Use" >&2
  echo "'npm run go:plex-dataplane-gate:three' on a host that can host it for evidence." >&2
  exit 0
fi
exit "$status"
