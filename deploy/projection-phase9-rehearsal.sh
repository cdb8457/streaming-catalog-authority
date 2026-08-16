#!/usr/bin/env bash
# Projection Phase 9 — THE PROVIDER-FREE MIXED TORBOX-PLUS-USENET REHEARSAL.
#
# WHAT IT RUNS, AND WHY IT IS CALLED A REHEARSAL RATHER THAN A GATE. §5 of
# `docs/PROJECTION_PHASE_9_TORBOX_USENET.md` asks eleven things. Four of them need a real Usenet provider,
# operator content and three pre-attached media servers, and no amount of engineering makes those appear.
# This runs the OTHER SEVEN end to end against a fake SABnzbd-compatible worker that the driver starts inside
# its own process on an ephemeral loopback port:
#
#   §5.1  the offline boundary, redaction, path-safety, idempotency and restart suites
#   §5.4  a mixed namespace holding a TorBox entry and an admitted Usenet entry
#   §5.6  a restart that submits no duplicate job and loses no admitted entry
#   §5.7  a Usenet outage that leaves the TorBox half untouched
#   §5.8  the existing focused projection regression gates
#   §5.9  evidence carrying no secret, URL, article id or completed path
#   §5.10 cleanup leaving nothing behind
#
# EVERY VERDICT IT EMITS IS STAMPED `rehearsal: true`, and `src/core/projection/phase9.ts` REFUSES to let a
# rehearsal verdict close a provider-required claim. So this command cannot close Phase 9, and the refusal is
# in code rather than in this comment.
#
# WHAT IT CONTACTS: a PostgreSQL container it starts and removes itself, and a loopback listener the driver
# starts and closes itself. No Usenet provider. No indexer. No TorBox endpoint. No operator corpus. No
# credential file. No Tower production container. Running it changes nothing on this host that it does not
# also remove.
#
# EXIT STATUS. 0 when every rehearsed step passed. 1 when any failed. 77 when this host cannot run it at all,
# which is a SKIP and is not a pass — `projection-phase9-rehearsal-optional.sh` is the entry point that folds
# a skip, and folding one is a decision that belongs in the command somebody typed.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
GATE_SKIP_STATUS=77
COMPOSE_FILE="$ROOT/docker-compose.projection-phase9.yml"
PROJECT="projection-phase9-gate"
PG_PORT="${PROJECTION_PHASE9_GATE_PG_PORT:-5660}"

# A seam for the offline regression suite, which points this at a stub so the ACCOUNTING below is exercised as
# behaviour rather than read as source. It defaults to the real driver.
REHEARSAL_COMMAND="${PROJECTION_PHASE9_REHEARSAL_COMMAND:-}"

say() { echo "[phase9] $*"; }
fail() { echo "[phase9] FAILED: $*" >&2; exit 1; }

skip() {
  echo >&2
  echo "SKIPPED: $1" >&2
  echo "  NOTHING WAS PROVED. This host cannot run the Phase 9 rehearsal, and a skip is not a pass." >&2
  exit "$GATE_SKIP_STATUS"
}

# ---------------------------------------------------------------------------------------------------------
# Preconditions. Every one of them is checked BEFORE anything is created, so a host that cannot run this
# leaves with nothing to clean up.
# ---------------------------------------------------------------------------------------------------------

command -v node >/dev/null 2>&1 || skip "node is not on PATH"
command -v npx >/dev/null 2>&1 || skip "npx is not on PATH"
[ -f "$ROOT/package.json" ] || fail "the repository root does not look like this project"

USE_DOCKER=1
if ! command -v docker >/dev/null 2>&1; then
  USE_DOCKER=0
  say "docker is not on PATH; the rehearsal will run WITHOUT a database"
elif ! docker info >/dev/null 2>&1; then
  USE_DOCKER=0
  say "the docker daemon is not answering; the rehearsal will run WITHOUT a database"
fi

# ---------------------------------------------------------------------------------------------------------
# Cleanup, registered BEFORE anything is created. §5.10 is a claim about what this leaves behind, and a
# cleanup that only runs on the success path is a claim that is false exactly when it matters.
# ---------------------------------------------------------------------------------------------------------

cleanup() {
  local status=$?
  if [ "$USE_DOCKER" -eq 1 ]; then
    docker compose -f "$COMPOSE_FILE" -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  return "$status"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------------------------------------
# The database, when there is one. It is throwaway, on its own port, in its own project and on its own
# network, so no other gate and no installation can lend this run state.
# ---------------------------------------------------------------------------------------------------------

if [ "$USE_DOCKER" -eq 1 ]; then
  say "starting a throwaway PostgreSQL on 127.0.0.1:$PG_PORT"
  PROJECTION_PHASE9_GATE_PG_PORT="$PG_PORT" \
    docker compose -f "$COMPOSE_FILE" -p "$PROJECT" up -d --wait \
    || fail "the throwaway PostgreSQL did not become healthy"
fi

# ---------------------------------------------------------------------------------------------------------
# The rehearsal itself.
# ---------------------------------------------------------------------------------------------------------

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"; cleanup' EXIT

say "running the provider-free mixed rehearsal"
if [ -n "$REHEARSAL_COMMAND" ]; then
  bash "$REHEARSAL_COMMAND" > "$OUT/rehearsal.txt" 2>&1
  status=$?
else
  ( cd "$ROOT" && npx tsx src/ops/usenet-rehearsal-cli.ts ) > "$OUT/rehearsal.txt" 2>&1
  status=$?
fi
cat "$OUT/rehearsal.txt"

if [ "$status" -ne 0 ]; then
  fail "the rehearsal reported a failure (status $status)"
fi

# ---------------------------------------------------------------------------------------------------------
# The two assertions this script makes about the rehearsal's OWN output, rather than about the product.
# ---------------------------------------------------------------------------------------------------------

# THE REHEARSAL MUST SAY WHAT IT DID NOT PROVE. A run whose output does not list the still-open claims is a
# run that has quietly started reading as a closure, and the whole point of the provider-free boundary is
# that it announces itself.
grep -q "still open" "$OUT/rehearsal.txt" \
  || fail "the rehearsal did not report what remains open; a rehearsal that reads as a closure is the one \
failure mode this entry point exists to prevent"

for claim in P9-2-real-job-admitted-once P9-3-failed-job-refused-and-absent \
             P9-5-three-servers-scan-and-read-both P9-11-three-consecutive-fresh-sequences; do
  grep -q "$claim" "$OUT/rehearsal.txt" \
    || fail "the rehearsal did not name $claim as still open"
done

# ---------------------------------------------------------------------------------------------------------
# The focused offline regression suites §5.1 and §5.8 are stated in terms of.
# ---------------------------------------------------------------------------------------------------------

say "running the Phase 9 offline suites"
( cd "$ROOT" && npx tsx src/ops/test-runner-cli.ts --group offline --filter usenet ) \
  || fail "the Phase 9 offline suites did not pass"

say "running the projection offline suites"
( cd "$ROOT" && npx tsx src/ops/test-runner-cli.ts --group offline --filter projection ) \
  || fail "the projection offline suites did not pass"

echo
echo "############################################################"
echo "# Projection Phase 9 rehearsal: COMPLETE, AND CLOSES NOTHING"
echo "############################################################"
echo
echo "WHAT THIS PROVED."
echo
echo "  A submission reached a worker exactly once and survived a control-plane restart without reaching it"
echo "  again. A completed job was proved — no-follow path checks, regular-file enforcement, a stable-size"
echo "  dwell, a whole-file digest and a post-digest re-check — and admitted exactly once, however many times"
echo "  reconciliation ran. The resulting namespace held one provider-backed entry and one admitted Usenet"
echo "  entry, and the provider-backed one did not move: not its path, its version, its inode, its size, its"
echo "  visibility or its locator. A worker outage changed none of it. No secret, NZB URL, article id,"
echo "  release name, worker job id or completed path appears anywhere in this run's output."
echo
echo "WHAT THIS DID NOT PROVE, AND CANNOT."
echo
echo "  No Usenet provider was contacted, so no REAL job was downloaded, repaired, unpacked, verified or"
echo "  admitted, and no real job was deliberately failed and refused. No media server read anything. Phase 9"
echo "  §5.2, §5.3, §5.5 and §5.11 are exactly as open as they were before this command, and"
echo "  src/core/projection/phase9.ts refuses to let this run's verdicts close them."
echo
echo "  WHAT THE OPERATOR MUST SUPPLY BEFORE THE OTHER HALF CAN RUN:"
echo "    npx tsx src/ops/usenet-command-cli.ts diagnose"
echo
exit 0
