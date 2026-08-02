#!/usr/bin/env bash
# The EMBY data-plane gate for a host where it is OPTIONAL.
#
# WHAT THIS IS FOR. A general CI job that runs on whatever runner it is given cannot require a mount: a host
# without /dev/fuse is not a defect there, it is a fact about the runner. This entry point runs the real gate
# and maps its SKIP status (77) to 0, so such a job stays green when the gate genuinely cannot run.
#
# THE GATE HAS ONE SKIP CONDITION AND IT IS /dev/fuse. There is deliberately no second one. In particular
# there is no internet-reachability skip: this gate's Emby is stood up entirely through its own local first-run
# API, with every internet metadata fetcher turned off in the library it creates, so nothing it asserts depends
# on an external service being reachable. (What is NOT claimed is that the run is air-gapped — the gate's
# network is an ordinary bridge, and Emby's own `/System/Info/Public` was observed reporting a WAN address, so
# the server does reach out on its own initiative. Nothing this gate asserts rests on that succeeding, but
# "does not depend on the internet" and "has been proved with no route to it" are different claims and only
# the first is made.)
#
# WHAT IT IS NOT FOR, AND THE DISTINCTION IS THE POINT. It is NOT the command the acceptance plan names as
# evidence. `npm run go:emby-dataplane-gate` and `npm run go:emby-dataplane-gate:three` propagate 77, so a
# required acceptance invocation on a host that cannot host the gate FAILS rather than quietly passing.
# Skip-as-success is a property of the CALLER's requirements, so it lives in a separate entry point that a
# caller has to choose deliberately, rather than in the gate where everyone would inherit it.
#
# A REAL FAILURE IS STILL A FAILURE HERE. Only 77 is mapped. Anything else propagates unchanged.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
GATE_COMMAND="${PROJECTION_EMBY_GATE_COMMAND:-$HERE/projection-emby-dataplane-gate.sh}"

bash "$GATE_COMMAND" "$@"
status=$?

if [ "$status" -eq "$GATE_SKIP_STATUS" ]; then
  echo >&2
  echo "OPTIONAL HOST: the Emby data-plane gate skipped (status ${GATE_SKIP_STATUS}) and this entry point" >&2
  echo "treats that as success. NOTHING WAS PROVED. No acceptance gate is closed by this run. Use" >&2
  echo "'npm run go:emby-dataplane-gate:three' on a host that can host it for evidence." >&2
  exit 0
fi
exit "$status"
