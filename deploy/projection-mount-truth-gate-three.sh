#!/usr/bin/env bash
# The MOUNT-TRUTH GATE, three times: a runner that proves the gate is repeatable, not lucky.
#
# WHY THREE. Every arm here is a race that a single run can win by accident. MT1 asks whether a sampler has
# produced a sample yet; MT2 asks whether it has produced a NEW one since a fault; MT4 asks whether a
# supervisor has finished a remount. One green run says those landed in the order the gate expected once.
# Three cold starts, each asserted the same way, is the difference between "it passed on a good day" and
# "it passes" — and it is this repository's rule for every gate that has ever closed.
#
# WHAT IT DOES. Cleans the gate's home directory first, then runs the gate three times, keeping each run's
# result and elapsed time. A run that SKIPS (status 77) is a FAILURE for the runner: an unproven gate is not
# a proven gate. A run that fails at all is a failure. Only three full passes exit 0.
#
# WHAT IT DOES NOT DO. It does not warm anything between runs: each is a cold start of PostgreSQL, the
# daemon and the consumer, exactly as `npm run go:mount-truth-gate` would start them. The sampler's first
# observation is part of what MT1 measures, so a warm daemon carried between runs would remove the arm.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/projection-mount-truth-gate.sh"
GATE_ROOT="$PWD/.projection-mount-truth-gate"

# A host still serving the previous run's container is a host the next run would collide with (port,
# container name, compose project). The runner refuses to clean up a gate that is still alive: the cleanup
# trap in the gate itself is the only thing allowed to remove the run directory, and deleting it under a
# live container would disturb the very gate this runner is refusing to touch. The check comes FIRST.
if docker ps --filter "name=projection-mount-truth-" --format '{{.Names}}' | grep -q .; then
  echo "REFUSING TO RUN: a previous mount-truth container is still alive." >&2
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
  echo "==== mount-truth gate, run $round/3 ===="
  set +e
  START="$(date +%s%3N)"
  bash "$GATE"
  RC=$?
  END="$(date +%s%3N)"
  set -e
  ELAPSED_MS=$(( END - START ))
  TIMES="$TIMES $ELAPSED_MS(ms)"
  if [ "$RC" -eq 77 ]; then
    RESULTS[$round]="SKIP"
    FAIL=$(( FAIL + 1 ))
    echo "RUN $round: SKIPPED (77) — a skipped gate is not a pass for the runner."
  elif [ "$RC" -eq 0 ]; then
    RESULTS[$round]="PASS"
    PASS=$(( PASS + 1 ))
    echo "RUN $round: PASS in ${ELAPSED_MS}ms"
  else
    RESULTS[$round]="FAIL($RC)"
    FAIL=$(( FAIL + 1 ))
    echo "RUN $round: FAILED (${RC}) in ${ELAPSED_MS}ms"
  fi
  rm -rf "$GATE_ROOT"
done

echo
echo "mount-truth gate: ${PASS} pass, ${FAIL} fail${TIMES}"
if [ "$FAIL" -ne 0 ]; then
  echo "RESULT: FAILED (${RESULTS[1]} ${RESULTS[2]} ${RESULTS[3]})"
  exit 1
fi
echo "RESULT: PASSED three consecutive cold-start runs"
