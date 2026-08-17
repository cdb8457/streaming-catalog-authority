#!/usr/bin/env bash
# THREE CONSECUTIVE FRESH RUNS OF THE PHASE 10 PROVIDER-FREE CONTENT-PLANE REHEARSAL.
#
# WHY THIS IS ITS OWN SCRIPT RATHER THAN A LOOP INSIDE THE REHEARSAL. The most valuable property of the
# repetition is that each run starts from NOTHING: a fresh throwaway database on a tmpfs, a fresh manifest
# directory, a fresh media root, a fresh temporary tree. A loop inside the rehearsal would share the database
# between runs.
#
# ON THIS TRANCHE THE INHERITANCE RISK IS SPECIFIC AND IT IS THE REGISTRY. A registry that survived into the
# next run would make that run's `add-local` report an entry that was ALREADY PUBLISHED — so the run would
# report idempotence it never exercised, would never once see `admitted-not-published`, and P10-4's whole
# sequence would pass by having nothing left to do. That is the exact shape of a green run that measured
# nothing, and it is why the database is on a tmpfs and why this wrapper is a separate process per run.
#
# A SKIPPED RUN IS NOT A COMPLETED RUN AND THIS SCRIPT CANNOT SAY OTHERWISE. Runs are COUNTED, the closing
# message is emitted only when the count reaches the target, and a 77 propagates as 77 rather than being
# folded into success.
#
# IT STOPS ON THE FIRST FAILURE OR SKIP. Not `|| true`, not a tally: "two of three passed" is not what a
# repetition convention asks for, and averaging it is the failure mode this repository is trying to leave
# behind.
#
# THREE OF THESE ARE P10-2 AND THEY ARE STILL NOT P10-10. §5's last claim asks for three consecutive fresh
# runs of the COMPLETE SEQUENCE — the rehearsal plus the offline inventory from both shells plus the
# provider-free regression subset — and this wrapper runs one third of that, three times.
set -uo pipefail

RUNS="${PROJECTION_PHASE10_REHEARSAL_RUNS:-3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
# A seam for the offline regression suite: it points this at a stub that exits with a scripted status, so the
# ACCOUNTING below is exercised as behaviour rather than read as source. It defaults to the real rehearsal.
GATE_COMMAND="${PROJECTION_PHASE10_REHEARSAL_ENTRYPOINT:-$HERE/projection-phase10-rehearsal.sh}"

completed=0
for run in $(seq 1 "$RUNS"); do
  echo
  echo "############################################################"
  echo "# Projection Phase 10 rehearsal: run $run of $RUNS"
  echo "############################################################"
  bash "$GATE_COMMAND"
  status=$?

  if [ "$status" -eq "$GATE_SKIP_STATUS" ]; then
    echo >&2
    echo "SKIPPED at run $run of $RUNS: the rehearsal reported that this host cannot host it." >&2
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
# `PROJECTION_PHASE10_REHEARSAL_RUNS=0`, say — must not be able to announce a completed sequence either.
if [ "$completed" -ne "$RUNS" ] || [ "$completed" -eq 0 ]; then
  echo "INTERNAL: completed $completed of $RUNS; refusing to report a completed sequence." >&2
  exit 1
fi

echo
echo "$completed of $RUNS consecutive Phase 10 rehearsals completed, none skipped."
echo
echo "WHAT THIS DOES AND DOES NOT CLOSE."
echo
echo "  Each run started from nothing: a fresh throwaway database on a tmpfs, a fresh registry, a fresh"
echo "  manifest directory and a fresh synthesised corpus. Each one drove the SHIPPED content command from an"
echo "  empty control plane to a published namespace holding a local entry and a provider-backed one, proved"
echo "  the drift guard on a real admission through the real publisher, removed a local source and found the"
echo "  published generation byte-identical after the report, and left the host's container, network and"
echo "  volume sets identical to how it found them."
echo
echo "  THIS IS P10-2. IT IS NOT P10-10. §5's last claim asks for three consecutive fresh runs of the COMPLETE"
echo "  SEQUENCE, which also includes the offline inventory from BOTH shells and the provider-free regression"
echo "  subset from the same frozen candidate. Neither is in this wrapper, and"
echo "  src/core/projection/phase10.ts refuses to let a rehearsal verdict close P10-1, P10-2, P10-7 or P10-10."
echo
exit 0
