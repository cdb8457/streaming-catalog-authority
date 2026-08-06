#!/usr/bin/env bash
# Three consecutive clean runs of the REAL-PROVIDER CORRECTNESS gate (acceptance plan §6.10).
#
# THIS HEADER USED TO DESCRIBE A DIFFERENT GATE. It was a verbatim copy of the path-lifecycle wrapper's, and
# it told a reader that this sequence turns on three fresh media-server config directories and on set
# differences between three real media servers' inventories. There is no media server anywhere in this gate.
#
# WHY THIS EXISTS AS ITS OWN SCRIPT. "Passing" in `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` means every
# hard gate holds on THREE CONSECUTIVE RUNS, because one green run is a coincidence. Making that a loop inside
# the gate itself would hide the most valuable property of the repetition: each run must start from nothing —
# a fresh throwaway database, a fresh manifest directory, a fresh mount and a fresh probe cache — and a run
# that inherited the previous one's state would pass for the wrong reason.
#
# ON THIS GATE THE INHERITANCE RISK IS SPECIFIC AND NASTY, and it is the PROBE CACHE. Nearly every assertion
# here is an "at most", and every one of them is satisfied by a run that fetched nothing. A cache directory
# that survived into the next run would serve that run's reads out of bytes the previous run already
# fetched — zero retries, zero refreshes, zero contacts — and `RP5-bytes-from-provider` exists precisely
# because that shape otherwise reports a clean pass. A fresh cache per run is what keeps it honest.
#
# A SKIPPED RUN IS NOT A COMPLETED RUN, AND THIS SCRIPT CANNOT SAY OTHERWISE. The gate exits 77 when the host
# cannot host it. So: runs are COUNTED, the closing message is emitted only when the count reaches the target,
# and a skip propagates 77 rather than being folded into success. A green tranche-closing command that proved
# nothing is the single worst failure this repository can have.
#
# IT STOPS ON THE FIRST FAILURE OR SKIP. Not `|| true`, not a tally: "two of three passed" is not what the
# acceptance plan asks for, and averaging it would be the exact failure mode this repository is trying to
# leave behind.
#
# WHAT IT IS STILL NOT. Three green runs HERE are three green runs on this host. On Windows and Docker Desktop
# that is not Phase 1 closure, does not close the real-provider row, and SHALL NOT be reported as either;
# the acceptance plan closes the tranche on a Linux or Unraid host. This script exists so that the same
# command means the same thing when it is finally run there.
set -uo pipefail

RUNS="${PROJECTION_REAL_PROVIDER_GATE_RUNS:-3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
# A seam for the offline regression suite: it points this at a stub that exits with a scripted status, so the
# ACCOUNTING below is exercised as behaviour rather than read as source. It defaults to the real gate.
GATE_COMMAND="${PROJECTION_REAL_PROVIDER_GATE_COMMAND:-$HERE/projection-real-provider-gate.sh}"

completed=0
for run in $(seq 1 "$RUNS"); do
  echo
  echo "############################################################"
  echo "# real-provider gate: run $run of $RUNS"
  echo "############################################################"
  bash "$GATE_COMMAND"
  status=$?

  if [ "$status" -eq "$GATE_SKIP_STATUS" ]; then
    echo >&2
    echo "SKIPPED at run $run of $RUNS: the gate reported that this host cannot host it." >&2
    echo "  Runs completed: $completed of $RUNS required. THIS SEQUENCE CLOSES NOTHING." >&2
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

# THE CLOSING MESSAGE IS GUARDED BY THE COUNT, not by having fallen out of the loop. A loop that never ran --
# `PROJECTION_REAL_PROVIDER_GATE_RUNS=0`, say -- must not be able to announce a completed sequence either.
if [ "$completed" -ne "$RUNS" ] || [ "$completed" -eq 0 ]; then
  echo "INTERNAL: completed $completed of $RUNS; refusing to report a completed sequence." >&2
  exit 1
fi

echo
echo "$completed of $RUNS consecutive real-provider runs completed, none skipped."
echo
echo "WHAT THAT MEANS DEPENDS ENTIRELY ON WHICH MODE RAN, AND THIS WRAPPER DOES NOT KNOW."
echo
echo "  If these were FAKE-MODE runs, they closed NOTHING. They prove the gate works, that it evaluates"
echo "  every assertion, and that it can fail -- which is worth having and is why fake mode exists. They"
echo "  prove nothing whatsoever about any real provider, because no provider was contacted."
echo
echo "  If these were REAL runs against an operator-supplied corpus, they are the repetition the acceptance"
echo "  plan asks for, for THIS gate, and they close the real-provider correctness requirement of"
echo "  docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md section 2 -- and NOTHING ELSE."
echo
echo "  Read the report above: the TLS assertions SKIP in fake mode and are asserted in a real one. That"
echo "  is how you tell the two apart, and a skip is never a pass."
