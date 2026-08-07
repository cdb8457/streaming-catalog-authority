#!/usr/bin/env bash
# The SUSTAINED-OUTAGE GATE, three times: a runner that proves the gate is repeatable, not lucky.
#
# WHY THREE. A mount of the same namespace on the same host is the same kernel conversation every time, so
# the flake that a single run cannot see is the one that only shows up when the conversation happens again.
# The gate's assertions are mostly fast-fail windows — a read refused by an open breaker should take
# microseconds, not 4500ms — and a host under load can make ONE of them late without the gate being wrong.
# Three clean runs with every run asserted the same way is the difference between "it passed on a good day"
# and "it passes".
#
# WHAT IT DOES. Cleans the gate's home directory first, then runs the gate itself three times, keeping each
# run's summary. A run that SKIPS (status 77) is a FAILURE for the runner: an unproven gate is not a proven
# gate, and the runner refuses to let a silent skip count as a pass. A run that fails at all is a failure.
# Only three full passes exit 0, and the timings are printed either way.
#
# WHAT IT DOES NOT DO. It does not run the gate's phases out of order and it does not warm anything between
# runs: each run is a cold start of PostgreSQL, the endpoint and the daemon, exactly as `npm run
# go:sustained-outage-gate` would start it. The two runs a CI user actually cares about are the direct one
# and this one, and this one is deliberately the same gate again, not a trimmed variant.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/projection-sustained-outage-gate.sh"
GATE_ROOT="$PWD/.projection-sustained-outage-gate"

# A host that is still serving the previous run's container or network is a host the next run would collide
# with (port, container name, compose project). The runner refuses to clean up a gate that is still mounted:
# the cleanup trap in the gate itself is the only thing allowed to remove the run directory. The check comes
# FIRST for that reason — deleting the run directory under a still-alive container would disturb the very
# gate this runner is refusing to touch.
if docker ps --filter "name=projection-sustained-outage-" --format '{{.Names}}' | grep -q .; then
  echo "REFUSING TO RUN: a previous sustained-outage container is still alive." >&2
  echo "  The prior run did not finish. Its cleanup trap owns its run directory, not this runner." >&2
  echo "  Its run directory was left in place: $GATE_ROOT" >&2
  exit 1
fi
rm -rf "$GATE_ROOT"

PASS=0
FAIL=0
TIMES=""
declare -a RESULTS
for round in 1 2 3; do
  echo
  echo "==== sustained-outage gate, run $round/3 ===="
  set +e
  START="$(date +%s%3N)"
  bash "$GATE"
  RC=$?
  END="$(date +%s%3N)"
  set -e
  ELAPSED_MS=$(( END - START ))
  if [ "$RC" -eq 77 ]; then
    RESULTS[$round]="SKIP"
    FAIL=$(( FAIL + 1 ))
    TIMES="$TIMES $ELAPSED_MS(ms)"
    echo "RUN $round: SKIPPED (77) — a skipped gate is not a pass for the runner."
  elif [ "$RC" -eq 0 ]; then
    RESULTS[$round]="PASS"
    PASS=$(( PASS + 1 ))
    TIMES="$TIMES $ELAPSED_MS(ms)"
    echo "RUN $round: PASS in ${ELAPSED_MS}ms"
  else
    RESULTS[$round]="FAIL($RC)"
    FAIL=$(( FAIL + 1 ))
    TIMES="$TIMES $ELAPSED_MS(ms)"
    echo "RUN $round: FAILED (${RC}) in ${ELAPSED_MS}ms"
  fi
  rm -rf "$GATE_ROOT"
done

echo
echo "sustained-outage gate: ${PASS} pass, ${FAIL} fail${TIMES}"
if [ "$FAIL" -ne 0 ]; then
  echo "RESULT: FAILED (${RESULTS[1]} ${RESULTS[2]} ${RESULTS[3]})"
  exit 1
fi
echo "RESULT: PASSED three consecutive cold-start runs"
