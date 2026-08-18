#!/usr/bin/env bash
# The PATH LIFECYCLE gate for a host where it is OPTIONAL.
#
# WHAT THIS IS FOR. A general CI job that runs on whatever runner it is given cannot require a mount: a host
# without /dev/fuse is not a defect there, it is a fact about the runner. This entry point runs
# `projection-path-lifecycle-gate.sh` and maps its SKIP status (77) to 0, so such a job stays green when
# the gate genuinely cannot run.
#
# IT RUNS THE GATE ITS OWN FILENAME NAMES, AND THAT SENTENCE HAD TO BE REPAIRED TO BE TRUE. Until the Phase 13
# pre-entry repair this file was a verbatim copy of the three-server-concurrency wrapper -- header, prose and
# default alike -- so it ran `projection-three-server-concurrency-gate.sh` and reported success for a gate
# that was never invoked. Four wrappers carried the same defect. It is exactly the class
# `test/projection-phase11-gate-audit.ts` pins by name -- "a wrapper that runs something other than what it
# names" -- surviving because that audit reads only Phase 11's own three scripts.
# `test/projection-phase13-preentry-gate-audit.ts` now sweeps EVERY `deploy/*-optional.sh` instead, so a
# fifth cannot appear unnoticed.
#
# WHAT ITS SKIP CONDITIONS ARE. ONE, and it is /dev/fuse. A host from which no container can reach the FUSE
# device cannot host a
# mount, and that is a fact about the runner rather than a defect in the product.
#
# WHAT IT IS NOT FOR, AND THE DISTINCTION IS THE POINT. It is NOT the command an acceptance plan names as
# evidence. `npm run go:path-lifecycle-gate` and `go:path-lifecycle-gate:three` propagate 77, so a required
# acceptance
# invocation on a host that cannot host the gate FAILS rather than quietly passing. Skip-as-success is a
# property of the CALLER's requirements, so it lives in a separate entry point that a caller has to choose
# deliberately, rather than in the gate where everyone would inherit it.
#
# A REAL FAILURE IS STILL A FAILURE HERE. ONLY 77 IS MAPPED. Anything else -- 1, 70, 124, 137, a signal --
# propagates unchanged, and no verdict of any phase is closed by an invocation of this file.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
# THE SAME SEAM NAME AS THE `-three` WRAPPER OF THIS GATE, AND THAT IS DELIBERATE. Both entry points drive the
# same gate, so a suite that redirects one to a stub redirects the other to the same stub. What was wrong
# before was the DEFAULT, not the variable.
GATE_COMMAND="${PROJECTION_LIFECYCLE_GATE_COMMAND:-$HERE/projection-path-lifecycle-gate.sh}"

bash "$GATE_COMMAND" "$@"
status=$?

if [ "$status" -eq "$GATE_SKIP_STATUS" ]; then
  echo >&2
  echo "OPTIONAL HOST: the path lifecycle gate skipped (status ${GATE_SKIP_STATUS}) and this" >&2
  echo "entry point treats that as success. NOTHING WAS PROVED. No acceptance gate is closed by this run." >&2
  echo "Use 'npm run go:path-lifecycle-gate:three' on a host that can host it for evidence." >&2
  exit 0
fi
exit "$status"
