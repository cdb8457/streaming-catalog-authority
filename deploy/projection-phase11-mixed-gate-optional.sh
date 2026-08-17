#!/usr/bin/env bash
# The Phase 11 mixed gate on a host where it is OPTIONAL: 77 becomes 0, and nothing else changes.
#
# WHY THIS IS A SEPARATE ENTRY POINT A CALLER HAS TO CHOOSE. A skip is not a pass, and the gate exits 77 to
# say so. On a machine with no Docker daemon, no reachable /dev/fuse, no Go toolchain image, a filesystem
# whose lstat and fstat disagree about a file's device, or a shell whose temporary directory the shipped
# commands cannot resolve, that 77 is correct and inconvenient at the same time, so the fold exists. It is
# deliberately NOT the default and deliberately not a flag on the gate: folding a skip into success is a
# decision, and a decision belongs in the command somebody typed.
#
# EVERY OTHER STATUS PASSES THROUGH UNCHANGED. A gate that RAN AND FAILED still fails here.
#
# AND IT STILL CLOSES NOTHING. Even a gate that runs and passes leaves P11-S1, P11-S2, P11-S3 and P11-S4 open,
# because one run is not a set of runs and one shell is not both — and it leaves the WHOLE OF TIER TWO open,
# because a fake range origin and a fake worker are not a provider, an NZB and three real media servers. This
# wrapper folds a SKIP into a zero exit; it does not fold an open phase into a closed one, and nothing in this
# repository can.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE_SKIP_STATUS=77
GATE_COMMAND="${PROJECTION_PHASE11_GATE_ENTRYPOINT:-$HERE/projection-phase11-mixed-gate.sh}"

bash "$GATE_COMMAND"
status=$?

if [ "$status" -eq "$GATE_SKIP_STATUS" ]; then
  echo >&2
  echo "NOTHING WAS PROVED. The Phase 11 mixed gate skipped on this host and this entry point maps that" >&2
  echo "skip to 0 because the caller asked for it. No database was migrated, no fake origin was started, no" >&2
  echo "worker completed a job, no generation was assembled, no appliance mounted anything, no half was read" >&2
  echo "and no source was failed under another. Projection Phase 11 is exactly as open as it was before this" >&2
  echo "command, in both of its tiers." >&2
  exit 0
fi
exit "$status"
