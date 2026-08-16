#!/usr/bin/env bash
# THREE CONSECUTIVE FRESH RUNS OF THE PHASE 9 PROVIDER-FREE REHEARSAL.
#
# WHY THIS IS ITS OWN SCRIPT RATHER THAN A LOOP INSIDE THE REHEARSAL. The most valuable property of the
# repetition is that each run starts from NOTHING: a fresh throwaway database, a fresh ledger directory, a
# fresh fake worker on a fresh port, a fresh temporary tree. A loop inside the driver would share the ledger
# between runs — and a shared ledger is exactly the state that makes the second run's "no duplicate
# submission" true for the wrong reason, because the second run would be re-observing the first run's job
# rather than making its own.
#
# ON THIS REHEARSAL THE INHERITANCE RISK IS SPECIFIC AND IT IS THE LEDGER. A ledger directory that survived
# into the next run would make every submission in that run report `already-known`, and a run in which nothing
# was ever submitted would report an exactly-once guarantee it never exercised.
#
# A SKIPPED RUN IS NOT A COMPLETED RUN AND THIS SCRIPT CANNOT SAY OTHERWISE. Runs are COUNTED, the closing
# message is emitted only when the count reaches the target, and a 77 propagates as 77 rather than being
# folded into success.
#
# IT STOPS ON THE FIRST FAILURE OR SKIP. Not `|| true`, not a tally: "two of three passed" is not what a
# repetition convention asks for, and averaging it is the failure mode this repository is trying to leave
# behind.
#
# AND THREE OF THESE STILL CLOSE NOTHING. §5.11 asks for three consecutive fresh runs of THE COMPLETE
# MIXED-PROVIDER SEQUENCE, and this sequence is provider-free by construction. Three rehearsals are three
# rehearsals.
set -uo pipefail

RUNS="${PROJECTION_PHASE9_REHEARSAL_RUNS:-3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
# A seam for the offline regression suite: it points this at a stub that exits with a scripted status, so the
# ACCOUNTING below is exercised as behaviour rather than read as source. It defaults to the real rehearsal.
GATE_COMMAND="${PROJECTION_PHASE9_REHEARSAL_ENTRYPOINT:-$HERE/projection-phase9-rehearsal.sh}"

completed=0
for run in $(seq 1 "$RUNS"); do
  echo
  echo "############################################################"
  echo "# Projection Phase 9 rehearsal: run $run of $RUNS"
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
# `PROJECTION_PHASE9_REHEARSAL_RUNS=0`, say — must not be able to announce a completed sequence either.
if [ "$completed" -ne "$RUNS" ] || [ "$completed" -eq 0 ]; then
  echo "INTERNAL: completed $completed of $RUNS; refusing to report a completed sequence." >&2
  exit 1
fi

echo
echo "$completed of $RUNS consecutive Phase 9 rehearsals completed, none skipped."
echo
echo "WHAT THIS DOES AND DOES NOT CLOSE."
echo
echo "  Each run started from nothing: a fresh ledger, a fresh fake worker and a fresh temporary tree. Each"
echo "  one submitted once, admitted once, compared the namespace before and after, survived a restart and"
echo "  an outage, and left nothing behind — including the throwaway container, network and volume each run"
echo "  created so that §5.10's cleanup claim had something real to be about. The admitted entry was"
echo "  published into an in-memory namespace, NOT into a database: publishing through the real registration"
echo "  boundary needs a migrated schema and an operator's catalog record, and neither is claimed here."
echo
echo "  IT CLOSES NO PART OF PHASE 9. §5.11 asks for three consecutive fresh runs of the complete"
echo "  MIXED-PROVIDER sequence. No Usenet provider, no indexer, no TorBox endpoint and no operator content"
echo "  was involved in any of these three, and src/core/projection/phase9.ts refuses to let a rehearsal"
echo "  verdict close §5.2, §5.3, §5.5 or §5.11."
echo
exit 0
