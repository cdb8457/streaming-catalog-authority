#!/usr/bin/env bash
# Projection Phase 12 — THE HOST PREFLIGHT AND THE CANDIDATE STAGING COMMAND.
#
# WHAT IT IS FOR. Phase 12 §5.2's first two claims. `P12-P1` asks for a READ-ONLY capability preflight of the
# real host, recorded BEFORE anything is created, that names every declared precondition and the answer this
# host gives it. `P12-P2` asks for one frozen candidate staged onto that host and proved BYTE-IDENTICAL IN
# BOTH DIRECTIONS against `git archive` of that commit.
#
# WHY BOTH LIVE IN ONE SCRIPT AND WHY PREFLIGHT IS THE DEFAULT. A staging run that discovers the host cannot
# host the gates has already written to the host. The preflight answers that first, writes nothing anywhere,
# and is what somebody runs when they do not yet know whether to run the other half. `stage` is a mode a
# caller has to type, exactly as folding a skip is.
#
# WHAT IT NEVER DOES. It starts, stops, restarts, reconfigures, upgrades or deletes NO production container,
# media server, share, operator content, provider configuration or credential. It reads no `endpoint.json`,
# holds no secret, prints no secret, and contacts no provider, indexer, worker or media server. It removes
# nothing outside the staging directory it was given, and it REFUSES a staging directory whose name does not
# carry this phase's own marker — a script that takes a path and clears it is one bad variable away from
# clearing something else.
#
# WHY THE COMPARISON IS AGAINST `git archive` AND NOT AGAINST THE WORKING TREE. The archive is TRACKED FILES
# ONLY, so no working-tree drift can leak into a run: what lands on the host is what the commit contains and
# nothing else. It is extracted locally, hashed, and compared against the host — an empty diff is byte
# identity in both directions. `LC_ALL=C` is on BOTH sides because Git Bash and a Linux host disagree on
# collation for uppercase-leading filenames, and an unlocalised sort produces a six-hundred-line diff between
# two identical trees.
#
# AND THE ARCHIVE IS TAKEN WITH THE WORKING-TREE CONVERSION DISABLED, WHICH IS THE MOST IMPORTANT LINE IN
# THIS FILE. `git archive` applies `core.autocrlf`, and on a Windows development host that is `true` — so a
# plain `git archive` emits CRLF for every text file the commit stores with LF, and carries a tree onto the
# Linux host that is not the commit. A verification that compared the host against THE SAME converted archive
# agreed while both sides were wrong, which is a check that cannot see the one thing it exists to see.
# `-c core.autocrlf=false -c core.eol=lf` is what makes the archive the commit's own bytes, and `no_cr_under`
# below is the control: this repository's commit contains no CR in any text file at all.
#
# EXIT STATUS. 0 when the mode succeeded. 1 when it failed. 77 when this host cannot answer at all, which is a
# SKIP and is not a pass.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
GATE_SKIP_STATUS=77

MODE="preflight"
FULL=0
COMMIT=""

# THE TARGET IS SUPPLIED BY THE OPERATOR AND IS NEVER GUESSED. A default ssh alias here would be this script
# deciding which machine an operator's command lands on.
HOST="${PROJECTION_PHASE12_HOST:-}"
STAGE_DIR="${PROJECTION_PHASE12_STAGE_DIR:-}"
STAGE_MARKER="catalog-phase12-"
# A SECOND MARKER, AND THE GUARD IS NOT WEAKENED BY IT.
#
# WHY THERE IS ONE AT ALL. The Phase 12 staging directory holds a candidate this repository deliberately
# preserved, and `stage` begins by `rm -rf`-ing whatever it is pointed at. A pre-entry campaign that
# staged into it would destroy that candidate; one that could not stage anywhere would have to widen the
# guard, and a guard widened to a prefix or handed to an environment variable is not a guard.
#
# WHY THIS DOES NOT WEAKEN IT. The admitted set is a CLOSED LIST OF TWO LITERALS in this file. Nothing
# external can add to it, no option sets it, and every other basename is refused by exactly the check
# that refused it before. The absolute-path guard, the parent-traversal guard and the order of
# guard-before-clear are all untouched. Going from one literal to two does not make the set open; it
# makes it two.
STAGE_MARKER_PREENTRY="catalog-phase13-preentry-"

say()  { echo "[phase12] $*"; }
fail() { echo "[phase12] FAILED: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

skip() {
  echo >&2
  echo "SKIPPED: $1" >&2
  echo "  NOTHING WAS PROVED. A skip is not a pass." >&2
  exit "$GATE_SKIP_STATUS"
}

usage() {
  echo "usage: projection-phase12-stage.sh [preflight|stage|verify] [--full] [--commit <rev>]"
  echo
  echo "  preflight  READ-ONLY capability report of the target host. Writes nothing. The default."
  echo "  stage      archive one commit onto the host and prove byte identity in both directions."
  echo "  verify     prove byte identity of what is already staged, and stage nothing."
  echo
  echo "  --full     include the two probes that start a THROWAWAY container and remove it again."
  echo "  --commit   the candidate to stage. Defaults to HEAD, and is resolved to a full sha."
  echo
  echo "  PROJECTION_PHASE12_HOST        ssh target. Required. Never defaulted."
  echo "  PROJECTION_PHASE12_STAGE_DIR   absolute directory on the host whose basename begins"
  echo "                                 ${STAGE_MARKER} or ${STAGE_MARKER_PREENTRY} -- and nothing"
  echo "                                 else. Any other name is REFUSED, which is why this script is"
  echo "                                 allowed to clear a directory at all."
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    preflight|stage|verify) MODE="$1" ;;
    --full) FULL=1 ;;
    --commit) shift; COMMIT="${1:-}" ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
  shift
done

command -v ssh >/dev/null 2>&1 || skip "ssh is not on PATH, so no target host can be reached from here"
command -v git >/dev/null 2>&1 || skip "git is not on PATH, so no candidate can be archived"
[ -n "$HOST" ] || fail "PROJECTION_PHASE12_HOST names no target host, and this script never guesses one"

# THE CONNECTION IS BATCH-MODE AND BOUNDED. A prompt for a passphrase in a non-interactive run is a hang, and
# a hang is worse than a failure because a failure is a verdict and a hang is a person deciding to give up.
remote() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "$@"; }

remote true >/dev/null 2>&1 \
  || skip "the target host did not answer a batch-mode ssh, so nothing here can be asked of it. That is a \
fact about the connection and not about the product."

# ---------------------------------------------------------------------------------------------------------
# THE READ-ONLY PREFLIGHT. Every command below READS. Nothing is created, started, stopped or written, and
# the two probes that would start a throwaway container are behind --full and say so.
# ---------------------------------------------------------------------------------------------------------

preflight() {
  step "the host, as it answers for itself"
  remote 'uname -srm; echo "docker: $(docker --version 2>&1 | head -1)"; \
echo "compose: $(docker compose version 2>&1 | head -1)"; echo "node: $(node --version 2>&1 | head -1)"; \
echo "curl: $(command -v curl >/dev/null 2>&1 && echo present || echo ABSENT)"; \
echo "findmnt: $(command -v findmnt >/dev/null 2>&1 && echo present || echo ABSENT)"' \
    || fail "the host could not describe itself"

  step "the declared preconditions of the Phase 10 rehearsal and the Phase 11 mixed gate"
  # THE APPLIANCE'S NAME IS FIXED BY THE SHIPPED PROFILE, so a container already holding it would make every
  # assertion in either gate about somebody else's mount. Reported here rather than discovered at run time.
  remote 'echo "appliance container present: $(docker ps -a --format "{{.Names}}" | grep -cx projection-alpha-projectiond)"; \
echo "appliance network present: $(docker network ls --format "{{.Name}}" | grep -cx projection-alpha)"; \
echo "containers: $(docker ps -aq | wc -l); networks: $(docker network ls -q | wc -l); volumes: $(docker volume ls -q | wc -l)"' \
    || fail "the host could not report its container, network and volume state"

  step "the ports these gates bind, and whether anything already holds one"
  remote 'for p in 5670 5680 8300; do \
echo "port $p: $(ss -ltn 2>/dev/null | grep -c ":$p ")"; done' \
    || say "the host has no ss(8), so port occupancy could not be read"

  if [ -n "$STAGE_DIR" ]; then
    step "the staging directory, and the propagation the appliance's shared bind needs"
    # THE ONE PROPERTY THAT DECIDED WHETHER THE PHASE 11 GATE COULD RUN AT ALL. The shipped appliance profile
    # binds its mount point with shared propagation, and Docker refuses that bind when the source is not on a
    # shared subtree. A host whose staging directory is on a private one cannot host the mixed gate, and
    # finding that out here costs nothing.
    remote "echo \"stage dir present: \$([ -d '$STAGE_DIR' ] && echo yes || echo no)\"; \
findmnt -no TARGET,FSTYPE,PROPAGATION -T '$STAGE_DIR' 2>/dev/null || \
findmnt -no TARGET,FSTYPE,PROPAGATION -T \"\$(dirname '$STAGE_DIR')\" 2>/dev/null || echo 'propagation UNREADABLE'" \
      || fail "the staging directory's propagation could not be read"
  else
    say "PROJECTION_PHASE12_STAGE_DIR is unset, so the propagation the mixed gate depends on was NOT asked"
  fi

  if [ "$FULL" -eq 1 ]; then
    step "the two probes that START A THROWAWAY CONTAINER and remove it again"
    remote 'docker run --rm --device /dev/fuse:/dev/fuse \
alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc test -c /dev/fuse \
>/dev/null 2>&1 && echo "/dev/fuse from a container: reachable" || echo "/dev/fuse from a container: NOT REACHABLE"' \
      || say "the /dev/fuse probe could not be run"
    remote 'docker image inspect golang:1.26.5-bookworm >/dev/null 2>&1 \
&& echo "the pinned Go toolchain image: present" || echo "the pinned Go toolchain image: NOT PRESENT (it will be pulled)"' \
      || say "the Go image probe could not be run"
  else
    say "the two container probes were NOT run; pass --full for them, and they are the only writes this mode makes"
  fi
}

# ---------------------------------------------------------------------------------------------------------
# THE BYTE-IDENTITY MANIFEST, TAKEN THE SAME WAY ON BOTH SIDES.
# ---------------------------------------------------------------------------------------------------------

resolve_commit() {
  COMMIT="$(cd "$ROOT" && git rev-parse --verify "${COMMIT:-HEAD}^{commit}" 2>/dev/null)"
  [ -n "$COMMIT" ] || fail "the candidate could not be resolved to a commit"
  say "candidate: $COMMIT"
}

require_stage_dir() {
  [ -n "$STAGE_DIR" ] || fail "PROJECTION_PHASE12_STAGE_DIR names no staging directory on the host"
  case "$STAGE_DIR" in
    /*) : ;;
    *) fail "the staging directory must be an absolute path on the host" ;;
  esac
  case "$STAGE_DIR" in
    *..*) fail "the staging directory contains a parent traversal" ;;
  esac
  # THE MARKER IS THE GUARD, AND IT IS WHY THIS SCRIPT MAY CLEAR A DIRECTORY AT ALL. A staging directory whose
  # basename does not begin with this phase's own marker is a directory this script did not create and will
  # not empty.
  case "$(basename "$STAGE_DIR")" in
    "$STAGE_MARKER"*) : ;;
    "$STAGE_MARKER_PREENTRY"*) : ;;
    *) fail "the staging directory's name begins with neither '$STAGE_MARKER' nor '$STAGE_MARKER_PREENTRY', \
so this script will not clear it. That guard is why it is allowed to clear anything, and the set of \
markers it admits is a closed list of two literals in this file rather than anything a caller can set." ;;
  esac
}

# `manifest_local <dir> <out>` — a sorted per-file sha256 manifest, with Git Bash's binary marker normalised
# to the two spaces coreutils emits, and the whole thing sorted under the C locale on both sides.
manifest_local() {
  ( cd "$1" && find . -type f -print0 | LC_ALL=C sort -z \
      | xargs -0 sha256sum | sed 's/ \*/  /' | LC_ALL=C sort ) > "$2"
}

verify_identity() {
  require_stage_dir
  resolve_commit

  local archive_dir local_manifest host_manifest
  archive_dir="$ROOT/.projection-phase12-stage/archive-$$"
  local_manifest="$ROOT/.projection-phase12-stage/local-$$.txt"
  host_manifest="$ROOT/.projection-phase12-stage/host-$$.txt"
  mkdir -p "$archive_dir" || fail "the archive could not be extracted locally"

  ( cd "$ROOT" && git -c core.autocrlf=false -c core.eol=lf archive --format=tar "$COMMIT" ) | ( cd "$archive_dir" && tar -x ) \
    || fail "the candidate could not be extracted locally for comparison"
  manifest_local "$archive_dir" "$local_manifest"

  # THE HOST SIDE EXCLUDES `node_modules` AND EVERY GATE ROOT, because those are produced by running rather
  # than by staging. A manifest that included them would report drift for having done the thing being staged.
  remote "cd '$STAGE_DIR' && find . -type f \
-not -path './node_modules/*' -not -path './.projection-*' -not -path './.git/*' -print0 \
| LC_ALL=C sort -z | xargs -0 sha256sum | LC_ALL=C sort" > "$host_manifest" \
    || fail "the staged tree's manifest could not be read from the host"

  # THE CONTROL THE MANIFEST COMPARISON CANNOT BE, AND THE DEFECT IT WAS WRITTEN FOR. Two sides converted the
  # same wrong way agree, so a diff of zero says the host matches THIS ARCHIVE and not that the archive is the
  # commit. This repository's commit contains NO CR in any text file at all — measured, not assumed — so a
  # single CR anywhere in either tree means a conversion happened between the commit and the host, and every
  # figure a run produced on that tree belongs to no commit.
  local local_crs host_crs
  local_crs="$( ( cd "$archive_dir" && grep -rlI "$(printf '\r')" . 2>/dev/null | wc -l ) | tr -d ' ' )"
  host_crs="$(remote "cd '$STAGE_DIR' && grep -rlI \"\$(printf '\\r')\" . \
--exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | wc -l" | tr -d ' \r')"
  say "text files carrying a CR: $local_crs in the archive, $host_crs on the host (budget 0 on both sides)"
  if [ "${local_crs:-1}" != "0" ] || [ "${host_crs:-1}" != "0" ]; then
    rm -rf "$archive_dir" "$local_manifest" "$host_manifest"
    fail "a line-ending conversion happened between the commit and the tree under test, so no figure from \
that tree belongs to $COMMIT. The archive command applies core.autocrlf; this script disables it, and \
something else has put it back."
  fi

  local differing
  differing="$(diff "$local_manifest" "$host_manifest" | grep -c '^[<>]')"
  say "files differing between the archive of $COMMIT and the staged tree: $differing (budget 0)"
  if [ "$differing" -ne 0 ]; then
    diff "$local_manifest" "$host_manifest" | head -40 >&2
    rm -rf "$archive_dir" "$local_manifest" "$host_manifest"
    fail "the staged tree is not byte-identical to the candidate, so no figure from it belongs to $COMMIT"
  fi
  rm -rf "$archive_dir" "$local_manifest" "$host_manifest"
  rmdir "$ROOT/.projection-phase12-stage" 2>/dev/null || true
  say "byte identity holds in both directions"
}

stage() {
  require_stage_dir
  resolve_commit

  step "clearing and re-creating the staging directory"
  remote "rm -rf '$STAGE_DIR' && mkdir -p '$STAGE_DIR'" \
    || fail "the staging directory could not be cleared and re-created"

  step "extracting the candidate onto the host, tracked files only"
  # TRACKED FILES ONLY, WHICH IS THE WHOLE POINT OF `git archive`: no working-tree drift can leak into a run,
  # and what lands on the host is exactly what the commit contains.
  ( cd "$ROOT" && git -c core.autocrlf=false -c core.eol=lf archive --format=tar "$COMMIT" ) | remote "tar -x -C '$STAGE_DIR'" \
    || fail "the candidate could not be extracted onto the host"

  step "proving byte identity in both directions"
  verify_identity
}

case "$MODE" in
  preflight) preflight ;;
  stage) stage ;;
  verify) verify_identity ;;
  *) usage >&2; fail "unknown mode: $MODE" ;;
esac

echo
say "mode '$MODE' completed. It closes no §5 claim on its own; §10 is where a verdict is written."
exit 0
