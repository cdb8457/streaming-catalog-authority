#!/usr/bin/env bash
# Three consecutive clean runs of the TORBOX-TO-MOUNT gate, offline against this repository's own fixture.
#
# THIS HEADER USED TO DESCRIBE A DIFFERENT GATE. It was a verbatim copy of the path-lifecycle wrapper's, and
# it told a reader that this sequence turns on three fresh media-server config directories and on set
# differences between three real media servers' inventories. There is no media server anywhere in this gate.
#
# WHY THIS EXISTS AS ITS OWN SCRIPT. "Passing" in `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` means every
# hard gate holds on THREE CONSECUTIVE RUNS, because one green run is a coincidence. Making that a loop inside
# the gate itself would hide the most valuable property of the repetition: each run must start from nothing —
# a fresh throwaway database, a fresh manifest directory, a fresh fixture, a fresh mount and a fresh probe
# cache — and a run that inherited the previous one's state would pass for the wrong reason.
#
# ON THIS GATE THE INHERITANCE RISK IS SPECIFIC AND NASTY, and it is the PROBE CACHE. What this gate proves is
# that the resolver is genuinely in the read path, and it proves it from the fixture's RESOLUTION COUNT. A
# cache directory that survived into the next run would serve that run's reads out of bytes the previous run
# already fetched — no CDN request, no resolution, the count unmoved — and the gate would report that the
# resolver was exercised on a run where it was never called at all. A fresh cache per run is what makes the
# count mean anything.
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
# that is not Phase 1 closure, does not close the TorBox-to-mount row, and SHALL NOT be reported as either;
# the acceptance plan closes the tranche on a Linux or Unraid host. This script exists so that the same
# command means the same thing when it is finally run there.
set -uo pipefail

RUNS="${PROJECTION_TORBOX_GATE_RUNS:-3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
# A seam for the offline regression suite: it points this at a stub that exits with a scripted status, so the
# ACCOUNTING below is exercised as behaviour rather than read as source. It defaults to the real gate.
GATE_COMMAND="${PROJECTION_TORBOX_GATE_COMMAND:-$HERE/projection-torbox-mount-gate.sh}"

completed=0
for run in $(seq 1 "$RUNS"); do
  echo
  echo "############################################################"
  echo "# TorBox-to-mount gate: run $run of $RUNS"
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
# `PROJECTION_TORBOX_GATE_RUNS=0`, say -- must not be able to announce a completed sequence either.
if [ "$completed" -ne "$RUNS" ] || [ "$completed" -eq 0 ]; then
  echo "INTERNAL: completed $completed of $RUNS; refusing to report a completed sequence." >&2
  exit 1
fi

echo
echo "$completed of $RUNS consecutive TorBox-to-mount runs completed, none skipped."
echo
echo "WHAT THIS DOES AND DOES NOT CLOSE."
echo
echo "  It proves the TorBox resolver is genuinely in the read path: three objects -- torrent, webdl and"
echo "  usenet -- each became an ordinary read-only file, was read at an approved window, past 90% of the"
echo "  object and backwards, and every CDN link was expired and every read recovered. Three consecutive"
echo "  fresh runs means each started from nothing."
echo
echo "  IT CLOSES NOTHING ABOUT ANY REAL PROVIDER. The provider was this repository own TorBox fixture and"
echo "  the credential was 32 random bytes the gate generated. A real TorBox account has never been"
echo "  contacted. deploy/projection-torbox-real-gate.sh is the real TorBox run, and it SKIPS with 77"
echo "  until an operator supplies inputs."
