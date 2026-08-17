#!/usr/bin/env bash
# THREE CONSECUTIVE FRESH RUNS OF THE PHASE 11 MIXED-SOURCE ACCEPTANCE GATE.
#
# WHY THIS IS ITS OWN SCRIPT RATHER THAN A LOOP INSIDE THE GATE. The most valuable property of the repetition
# is that each run starts from NOTHING: a fresh throwaway database on a tmpfs, a fresh registry, a fresh
# manifest directory, a fresh media root, a fresh appliance, a fresh fake origin, a fresh fake worker. A loop
# inside the gate would share the database between runs.
#
# ON THIS TRANCHE THE INHERITANCE RISK IS SPECIFIC AND IT IS THE MIXED GENERATION ITSELF. A registry that
# survived into the next run would make that run's P11-M1 pass on a generation the PREVIOUS run assembled —
# so the arm the whole tranche is named for would report a mixed namespace it never composed, and P11-M5's
# "nothing publishes implicitly" would be measured against a pointer that already existed. That is the exact
# shape of a green run that measured nothing, and it is why the database is on a tmpfs and why this wrapper
# is a separate process per run.
#
# A SKIPPED RUN IS NOT A COMPLETED RUN AND THIS SCRIPT CANNOT SAY OTHERWISE. Runs are COUNTED, the closing
# message is emitted only when the count reaches the target, and a 77 propagates as 77 rather than being
# folded into success.
#
# IT STOPS ON THE FIRST FAILURE OR SKIP. Not `|| true`, not a tally: "two of three passed" is not what a
# repetition convention asks for, and averaging it is the failure mode this repository is trying to leave
# behind.
#
# THREE OF THESE ARE P11-S2 AND THEY ARE STILL NOT P11-S4. §5.1's last claim asks for three consecutive fresh
# runs of the COMPLETE TIER-ONE SEQUENCE — this gate plus the offline inventory from both shells plus the
# provider-free regression subset — and this wrapper runs one third of that, three times.
#
# AND NOTHING HERE TOUCHES TIER TWO. Three fake runs are three fake runs. §5.2's four claims need operator
# TorBox credentials, an operator SABnzbd with a real NNTP provider behind it, an entitled NZB and three real
# pre-attached media servers, and repetition supplies none of them.
set -uo pipefail

RUNS="${PROJECTION_PHASE11_GATE_RUNS:-3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
# A seam for the offline audit: it points this at a stub that exits with a scripted status, so the ACCOUNTING
# below is exercised as behaviour rather than read as source. It defaults to the real gate.
GATE_COMMAND="${PROJECTION_PHASE11_GATE_ENTRYPOINT:-$HERE/projection-phase11-mixed-gate.sh}"

completed=0
for run in $(seq 1 "$RUNS"); do
  echo
  echo "############################################################"
  echo "# Projection Phase 11 mixed gate: run $run of $RUNS"
  echo "############################################################"
  bash "$GATE_COMMAND"
  status=$?

  if [ "$status" -eq "$GATE_SKIP_STATUS" ]; then
    echo >&2
    echo "SKIPPED at run $run of $RUNS: the gate reported that this host cannot host it." >&2
    echo "  Runs completed: $completed of $RUNS required. THIS SEQUENCE PROVES NOTHING." >&2
    echo "  A skipped run is not a completed run, and this command exits ${GATE_SKIP_STATUS} rather than 0" >&2
    echo "  so that no caller can read it as three required runs having passed." >&2
    exit "$GATE_SKIP_STATUS"
  fi
  if [ "$status" -ne 0 ]; then
    echo >&2
    echo "FAILED at run $run of $RUNS (status $status). Runs completed: $completed of $RUNS required." >&2
    exit "$status"
  fi
  completed=$((completed + 1))
done

# THE CLOSING MESSAGE IS GUARDED BY THE COUNT, not by having fallen out of the loop. A loop that never ran —
# `PROJECTION_PHASE11_GATE_RUNS=0`, say — must not be able to announce a completed sequence either.
if [ "$completed" -ne "$RUNS" ] || [ "$completed" -eq 0 ]; then
  echo "INTERNAL: completed $completed of $RUNS; refusing to report a completed sequence." >&2
  exit 1
fi

echo
echo "$completed of $RUNS consecutive Phase 11 mixed gates completed, none skipped."
echo
echo "WHAT THIS DOES AND DOES NOT CLOSE."
echo
echo "  Each run started from nothing: a fresh throwaway database on a tmpfs, a fresh registry, a fresh"
echo "  manifest directory, a fresh appliance, a fresh fake range origin and a fresh fake worker. Each one"
echo "  assembled a generation holding both kinds through the shipped verbs, read both halves back through"
echo "  the one mount the shipped alpha script owns, failed each source under the other and found the other"
echo "  undisturbed, reached all six predeclared arms, and left the host's container, network and volume sets"
echo "  identical to how it found them."
echo
echo "  THIS IS P11-S2. IT IS NOT P11-S4, AND IT IS NOWHERE NEAR TIER TWO. §5.1's last claim asks for three"
echo "  consecutive fresh runs of the COMPLETE TIER-ONE SEQUENCE, which also includes the offline inventory"
echo "  from BOTH shells and the provider-free regression subset from the same frozen candidate. §5.2's four"
echo "  tier-two claims need real operator inputs and three real pre-attached media servers, and"
echo "  src/core/projection/phase11.ts refuses to let a fake verdict close one."
echo
exit 0
