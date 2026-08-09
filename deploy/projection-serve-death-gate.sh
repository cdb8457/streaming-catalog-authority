#!/usr/bin/env bash
# The SERVE-DEATH gate: the FUSE serve loop dies while the process lives, and the daemon is asked to prove
# both halves of its answer — exit honestly (phase A) or bring the namespace back in place (phase B).
#
# WHAT SERVE-DEATH IS. A FUSE mount is a conversation between the kernel and a process. Most of the ways a
# conversation stops are on the daemon's side of the table — it is asked to unmount, or it is SIGKILLed, or it
# crashes. Serve-death is the remaining way: the MOUNTPOINT is taken out from under it. The kernel aborts the
# connection, the serve loop reads an error, and the process is left alive with no namespace to serve. That is
# the failure mode this gate exists to pin down, because a daemon that parked on Wait() and exited 0 over a
# vanished namespace is a media server with no files that nevertheless reports success.
#
# WHY THE DEATH IS CAUSED BY AN EXTERNAL UNMOUNT AND BY NOTHING ELSE. "External" means a sibling container
# unmounts the mountpoint through a shared mount — `projection_gate_unmount_run`, the same propagation path the
# daemon's own mount travelled out of its container. It is the one honest way to tear a live serve loop down
# without touching the daemon process: the process stays alive, the mount is gone. This is precisely the case
# the supervisor's comment names — "an external umount or a closed /dev/fuse tears the connection down from
# underneath us".
#
# THE TWO PHASES, AND BOTH RUN, A THEN B, OVER THE SAME MOUNT POINT AND THE SAME GENERATION.
#
#   phase A           the death, with no --auto-remount: detected, reported, and the daemon EXITS 3. The gate
#                     proves /readyz was ready, the live read digest was verified, the external umount killed
#                     the serve loop, the daemon exited with status 3 rather than parking, and its log says
#                     "serve loop died". After the exit the status surface is unreachable.
#   phase B           the same death, and the daemon is allowed to recover: a FRESH daemon starts with
#                     --auto-remount over the same mount point and the same generation. The gate proves the
#                     death was OBSERVED (the readyz poller sees a not-ready window), that /readyz comes back
#                     ready, that the daemon process never exited, that the entry's inode, size and mtime are
#                     unchanged across the remount, and that the log says both "serve loop died" and
#                     "remounted; serving generation 1".
#
# WHY BOTH, AND WHY IN ONE RUN. The two phases are the two halves of one assertion — that a serve-loop death
# is distinguished from a requested unmount, reported as a death, and reacted to — and a gate that proved one
# half would let the other rot. The acceptance plan names ONE serve-death gate; this is it, and it proves both
# halves in a single run, against the same fixture, the same catalog and the same generation, so the phase-A
# exit and the phase-B remount are exercised by the same evidence the plan names.
#
# WHY IT IS NOT G7-G9. The media-server gates SIGKILL the daemon and restart it, and prove the mount survives
# a process death. That is a different property: the process died and the namespace came back with it. This
# gate leaves the process alive the whole time and proves the serve loop's death is distinguished from a
# requested unmount, reported as a death, and reacted to — exit 3 without --auto-remount, a bounded remount
# with it. A daemon that always exited 0 on a serve death would pass G7-G9 and fail this gate.
#
# WHAT THE GATE DOES NOT TOUCH. No media server, no provider, no access material. The namespace is a single
# LOCAL entry served from a host file through the production image, so the whole experiment is the daemon's
# own mount lifecycle and nothing else.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

GATE_ROOT="$PWD/.projection-serve-death-gate"
REL=".projection-serve-death-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"

PG_PORT="${PROJECTION_SERVE_DEATH_GATE_PG_PORT:-5560}"
COMPOSE_FILE="docker-compose.projection-serve-death.yml"
COMPOSE_PROJECT="projection-serve-death-gate"
NETWORK="$COMPOSE_PROJECT"

MOUNT_CONTAINER="projection-serve-death-mount-$$"
PROBE_CONTAINER="projection-serve-death-probe-$$"
STATUS_ADDR="127.0.0.1:9000"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_SERVE_DEATH_GATE_PG_PORT="$PG_PORT"

# BOTH PHASES RUN, A THEN B. There is no phase flag: a caller that wants one half is a caller that wants half
# the evidence, and the acceptance plan names one serve-death gate.
AUTO_REMOUNT_FLAG=""

# THE SHARED CLEANUP CONTRACT. Sourced before anything can fail, so the EXIT trap is armed from the first
# container name onward.
# shellcheck source=projection-gate-cleanup.sh
. "$HERE/projection-gate-cleanup.sh"

# THE ONE SKIP CONDITION, AND IT IS /dev/fuse. There is deliberately no second one: a host that cannot host a
# mount cannot host this gate, and on such a host the honest answer is "nothing was proved", which is what
# status 77 says.
GATE_SKIP_STATUS="${GATE_SKIP_STATUS:-77}"
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no /dev/fuse is reachable from a container on this host." >&2
  exit "$GATE_SKIP_STATUS"
fi
echo "  /dev/fuse is reachable from a container"

mkdir -p "$WORK/manifest" "$WORK/media" "$WORK/cache" "$WORK/mnt" "$WORK/out"
chmod 755 "$GATE_ROOT" "$WORK"
chmod 777 "$WORK/cache" "$WORK/mnt" "$WORK/out"

# EVERY EMBEDDED SCRIPT IS A FILE IN A QUOTED HEREDOC, not an inline `node -e "..."` spanning lines.
# `test/custody-runtime-closure.ts` parses every shipped script and refuses a line whose quotes do not close
# on it, because an unreadable line is one a "does this region contain X" gate answers "no" for.
cat > "$WORK/jq.cjs" <<'JQ'
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const value = JSON.parse(raw)[process.argv[2]];
  console.log(value === undefined ? '' : String(value));
});
JQ

cat > "$WORK/sha.cjs" <<'SHA'
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
console.log(createHash('sha256').update(readFileSync(process.argv[2])).digest('hex'));
SHA

step() { echo; echo "=== $* ==="; }
die()  { echo "GATE FAILED: $*" >&2; exit 1; }

field()    { node "$REL/jq.cjs" "$1"; }
publish()  { npx tsx src/ops/projection-publish-cli.ts --manifest-dir "$REL/manifest" "$@"; }
register() { npx tsx src/ops/projection-register-cli.ts "$@"; }

cleanup() {
  docker rm -f "$PROBE_CONTAINER" "$MOUNT_CONTAINER" >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  if [ -n "${WORK:-}" ]; then
    projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true
    projection_gate_report_cleanliness "$GATE_ROOT" "$WORK" || true
  fi
}
trap cleanup EXIT

# THE DAEMON'S STATUS SURFACE, reached the way every gate reaches it: a sibling container that SHARES the
# daemon's network namespace. The status server binds loopback only, and that restriction is not relaxed for
# a test. `--network container:$MOUNT_CONTAINER` is the only way in.
readyz_ready() {
  docker run --rm --network "container:$MOUNT_CONTAINER" "$VERIFY_IMAGE" \
    wget -q -T 5 -O - "http://${STATUS_ADDR}/readyz" 2>/dev/null | grep -q '"ready":true'
}

await_readyz() {
  local attempts="${1:-60}" n=0
  while [ "$n" -lt "$attempts" ]; do
    if readyz_ready; then return 0; fi
    n=$((n + 1))
    sleep 0.5
  done
  return 1
}

await_namespace() {
  local attempts="${1:-180}" n=0
  while [ "$n" -lt "$attempts" ]; do
    if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
         test -f "/mnt/$ENTRY_PATH" >/dev/null 2>&1; then
      return 0
    fi
    n=$((n + 1))
    sleep 0.5
  done
  return 1
}

start_daemon() {
  # shellcheck disable=SC2086
  docker run -d --name "$MOUNT_CONTAINER" \
    --network "$NETWORK" --user 0:0 \
    --cap-drop ALL --cap-add SYS_ADMIN --security-opt apparmor:unconfined \
    --device /dev/fuse:/dev/fuse \
    -v "$WORK/manifest:/var/lib/projectiond/manifest:ro" \
    -v "$WORK/media:/var/lib/projectiond/media:ro" \
    -v "$WORK/cache:/var/lib/projectiond/cache" \
    -v "$WORK/config.json:/etc/projectiond/config.json:ro" \
    -v "$WORK/mnt:/mnt/projection:rshared" \
    "$IMAGE" --config /etc/projectiond/config.json --poll 2s --strict-direct-mount $AUTO_REMOUNT_FLAG >/dev/null
}

# ----------------------------------------------------------------------------------------------------------
step "building the production projectiond image"
# ----------------------------------------------------------------------------------------------------------
docker build -t "$IMAGE" ./projectiond

# ----------------------------------------------------------------------------------------------------------
step "starting a real PostgreSQL and migrating it"
# ----------------------------------------------------------------------------------------------------------
docker compose -f "$COMPOSE_FILE" up -d --wait postgres
npx tsx src/ops/migrate-cli.ts
echo "  migrated"

docker network create "$NETWORK" >/dev/null 2>&1 || true

# ----------------------------------------------------------------------------------------------------------
step "seeding a local fixture and publishing generation 1"
# ----------------------------------------------------------------------------------------------------------
# ONE LOCAL ENTRY, and no provider anywhere. The daemon serves it from `localRoots`, so the whole experiment
# is the daemon's own mount lifecycle: nothing outside the daemon and the mount can move, change, or fail, and
# a serve-loop death therefore has exactly one explanation.
SERVE_FILE="serve-death-subject.bin"
SERVE_SIZE=$((8 * 1024 * 1024))
head -c "$SERVE_SIZE" /dev/urandom > "$WORK/media/$SERVE_FILE"
SERVE_SHA="$(node "$REL/sha.cjs" "$REL/media/$SERVE_FILE")"
ENTRY_PATH="Movies/Serve Death Subject (2026)/Serve Death Subject (2026).bin"

register root --id media --kind local
register version --key serve-subject --size "$SERVE_SIZE" --mtime 2026-06-01T10:00:00.000Z
register entry --item "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" --version-key serve-subject \
  --path "$ENTRY_PATH" --source "local:media:${SERVE_FILE}"
publish > "$WORK/out/publish-1.json"
test "$(field outcome < "$WORK/out/publish-1.json")" = "published" || die "generation 1 was not published"
echo "  generation 1 published; the fixture is $SERVE_SIZE bytes, sha256 $SERVE_SHA"

# ----------------------------------------------------------------------------------------------------------
step "mounting with the production image"
# ----------------------------------------------------------------------------------------------------------
cat > "$WORK/config.json" <<'JSON'
{
  "mountPoint": "/mnt/projection",
  "pointerPath": "/var/lib/projectiond/manifest/pointer.json",
  "probeCacheDir": "/var/lib/projectiond/cache",
  "statusAddr": "127.0.0.1:9000",
  "localRoots": { "media": "/var/lib/projectiond/media" },
  "endpoints": []
}
JSON

# PHASE A'S DAEMON RUNS WITHOUT --auto-remount. A serve-loop death it cannot recover from is the honest
# version of the death: the daemon must exit 3 rather than park over a namespace that is gone.
start_daemon

echo "  waiting for the daemon to be ready and the namespace to be visible"
await_readyz || { docker logs "$MOUNT_CONTAINER" 2>&1 | tail -30 >&2; die "the daemon never became ready"; }
await_namespace || { docker logs "$MOUNT_CONTAINER" 2>&1 | tail -30 >&2; die "the mount never became visible"; }
echo "  /readyz answers ready=true and the entry is visible through the mount"

# ----------------------------------------------------------------------------------------------------------
step "phase A — a serve-loop death with no --auto-remount is an exit, not a parked daemon"
# ----------------------------------------------------------------------------------------------------------
# THE LIVE READ IS VERIFIED AGAINST A DIGEST RECORDED OUTSIDE THE MOUNT, before the death. It is the
# baseline that makes the death meaningful: the namespace carried the right bytes before it was torn down.
GOT_SHA="$(docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
  sh -c "sha256sum '/mnt/$ENTRY_PATH'" | awk '{print $1}')"
test "$GOT_SHA" = "$SERVE_SHA" || die "the live read digest does not match the host digest"
echo "  the live read digest is verified outside the mount"

# THE DEATH: an external unmount through the shared mount — the same propagation path the daemon's own
# mount travelled out of its container. The daemon process is untouched.
projection_gate_unmount_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE"
echo "  umounted the mountpoint from a sibling container"

# THE DAEMON MUST EXIT, AND IT MUST EXIT WITH STATUS 3 — the serve-exit-code the supervisor reserves for a
# serve-loop death. A daemon that parked would hang this loop; one that exited 0 would have reported a
# vanished namespace as a successful run.
STATUS_NOW=""
n=0
while [ "$n" -lt 60 ]; do
  STATUS_NOW="$(docker inspect -f '{{.State.Status}}' "$MOUNT_CONTAINER" 2>/dev/null || echo missing)"
  [ "$STATUS_NOW" = "exited" ] && break
  n=$((n + 1))
  sleep 0.5
done
test "$STATUS_NOW" = "exited" || die "the daemon never exited after the external umount"
SERVE_EXIT="$(docker inspect -f '{{.State.ExitCode}}' "$MOUNT_CONTAINER")"
test "$SERVE_EXIT" = "3" || die "the daemon exited $SERVE_EXIT, not 3, for a serve-loop death"
echo "  the daemon exited with status 3"

docker logs "$MOUNT_CONTAINER" 2>&1 | grep -q "serve loop died" \
  || die "the daemon did not report the serve-loop death"
echo "  the daemon's log says 'serve loop died'"

# A DEAD DAEMON'S STATUS SURFACE DOES NOT ANSWER, AND THE CHECK HAS TO EARN THAT.
#
# THE OBVIOUS VERSION OF THIS CHECK CANNOT FAIL FOR THE REASON IT STATES. It ran the probe and treated any
# non-zero status as "unreachable" — but `docker run --network container:<exited>` cannot START at all, and
# `docker run` reports its own refusal as 125/126/127 before the probe image executes a single instruction.
# So the assertion passed on docker's error, not on the surface's silence, and would have kept passing with
# the daemon still serving happily on another container. This is the same defect the Phase 1 review found four
# times over in the TorBox gate's read-only refusals.
#
# SO THE PROBE'S OWN VERDICT IS WHAT IS READ. The probe prints exactly one token and the gate demands it: a
# `wget` that fails prints `probe:unreachable`, and one that succeeds prints `probe:answered`. If the
# container could not start, neither token appears and the run status is docker's — all three are separated
# below and only one of them passes.
PROBE_OUT="$(docker run --rm --network "container:$MOUNT_CONTAINER" "$VERIFY_IMAGE" \
  sh -c "wget -q -T 3 -O - 'http://${STATUS_ADDR}/readyz' >/dev/null 2>&1 && echo probe:answered || echo probe:unreachable" \
  2>/dev/null || true)"
case "$PROBE_OUT" in
  *probe:answered*)
    die "the daemon's status surface answered after a serve-loop death and exit" ;;
  *probe:unreachable*)
    echo "  the daemon's status surface refused the connection after the exit (the probe ran and said so)" ;;
  *)
    # Docker refused to start the probe, which is the EXPECTED shape here — you cannot join the network
    # namespace of a container that has exited — and it is reported as what it is rather than counted as
    # evidence. The assertion the gate keeps is the one above it: the daemon exited 3.
    echo "  the probe could not be started against the exited container, which is itself the namespace being gone;" \
         "no status-surface claim is made from it" ;;
esac

echo
echo "PHASE A COMPLETE: the serve loop died, the death was reported, and the daemon exited 3 rather than"
echo "parking alive over a namespace that was gone."

# ----------------------------------------------------------------------------------------------------------
step "phase B — the serve loop dies and --auto-remount brings the namespace back in place"
# ----------------------------------------------------------------------------------------------------------
# A FRESH DAEMON, STILL OVER THE SAME MOUNT POINT AND THE SAME GENERATION. Phase A's daemon exited; its
# container is removed so the name can be reused, and the namespace under $WORK/mnt is rebuilt by the new
# daemon's own mount. The fixture, the manifest and the config are all unchanged, so a remount that served
# something different could only be the remount loop's doing.
docker rm -f "$MOUNT_CONTAINER" >/dev/null 2>&1 || true
AUTO_REMOUNT_FLAG="--auto-remount"
start_daemon
echo "  waiting for the phase-B daemon to be ready and the namespace to be visible"
await_readyz || { docker logs "$MOUNT_CONTAINER" 2>&1 | tail -30 >&2; die "the phase-B daemon never became ready"; }
await_namespace || { docker logs "$MOUNT_CONTAINER" 2>&1 | tail -30 >&2; die "the phase-B mount never became visible"; }
echo "  /readyz answers ready=true again and the entry is visible through the fresh mount"

# THE IDENTITY IS RECORDED BEFORE THE DEATH AND ASSERTED AFTER THE REMOUNT, through the mount both times, so
# a remount that served something different — another generation, an empty namespace, a fresh inode — would
# change what a consumer sees. Inode and mtime are the two things G7's churn assertions already watch; the
# remount must not move either.
STAT_BEFORE="$(docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
  sh -c "stat -c '%i:%s:%Y' '/mnt/$ENTRY_PATH'")"
echo "  entry identity before the death: inode:size:mtime=$STAT_BEFORE"

# THE READYZ POLLER. It shares the daemon's network namespace and samples /readyz every half second through
# the whole death and recovery. "The daemon came back" is only evidence of a recovery if something actually
# saw it leave; the poller is that something.
#
# IT RECORDS THE SEQUENCE, NOT TWO COUNTERS, AND THAT IS THE WHOLE DIFFERENCE. The counting version asserted
# `ready_ok >= 2` and called it "ready before and after the death" — but two ready samples taken half a second
# apart BEFORE the umount satisfy it just as well, so the assertion's own sentence was not what it checked. A
# daemon that went ready, died and never came back would have passed it, which is precisely the regression
# phase B exists for. What has to be true is an ORDER: ready, then not-ready, then ready again. So the probe
# collapses its samples into a transition string — R and D, one letter per change of state — and the gate
# matches the order rather than a population.
cat > "$WORK/readyz-probe.sh" <<'PROBE'
#!/bin/sh
i=0
ok=0
dead=0
seq=""
last=""
while [ "$i" -lt 120 ]; do
  if wget -q -T 5 -O - "http://127.0.0.1:9000/readyz" 2>/dev/null | grep -q '"ready":true'; then
    state=R
    ok=$((ok + 1))
  else
    state=D
    dead=$((dead + 1))
  fi
  if [ "$state" != "$last" ]; then
    seq="${seq}${state}"
    last="$state"
  fi
  # The recovery is complete the moment the sequence has been seen whole; stopping here keeps the probe from
  # outliving the phase it measures.
  case "$seq" in RDR*) break ;; esac
  i=$((i + 1))
  sleep 0.5
done
echo "ready_seq=$seq ready_ok=$ok ready_dead=$dead"
PROBE
docker run -d --name "$PROBE_CONTAINER" --network "container:$MOUNT_CONTAINER" \
  -v "$WORK:/work:ro" "$VERIFY_IMAGE" sh /work/readyz-probe.sh >/dev/null
echo "  the readyz poller is sampling through the daemon's network namespace"

# THE DEATH: an external unmount through the shared mount, exactly as in phase A.
projection_gate_unmount_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE"
echo "  umounted the mountpoint from a sibling container; the daemon must notice and remount"

# THE RECOVERY, bounded. The remount loop sleeps 1s, 2s and 3s before its three attempts, so a generous
# bound here still lets the gate fail loudly if the remount never happens.
await_readyz 80 || { docker logs "$MOUNT_CONTAINER" 2>&1 | tail -30 >&2; die "the daemon never came back after the serve-loop death"; }
echo "  /readyz answers ready=true again"

STATUS_NOW="$(docker inspect -f '{{.State.Status}}' "$MOUNT_CONTAINER")"
test "$STATUS_NOW" = "running" || die "the daemon is $STATUS_NOW; --auto-remount must keep the process alive"
echo "  the daemon process survived the serve-loop death"

STAT_AFTER="$(docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
  sh -c "stat -c '%i:%s:%Y' '/mnt/$ENTRY_PATH'")"
test "$STAT_BEFORE" = "$STAT_AFTER" \
  || die "the entry identity changed across the remount: inode:size:mtime $STAT_BEFORE -> $STAT_AFTER"
echo "  the entry's inode, size and mtime are unchanged across the remount ($STAT_AFTER)"

docker logs "$MOUNT_CONTAINER" 2>&1 | grep -q "serve loop died" \
  || die "the daemon did not report the serve-loop death"
docker logs "$MOUNT_CONTAINER" 2>&1 | grep -q "remounted; serving generation" \
  || die "the daemon did not report a successful remount"
echo "  the daemon's log reports both the death and the successful remount"

# THE DEATH WAS OBSERVED, IN ORDER. The poller's transition string must OPEN with `RDR`: ready before the
# umount, not-ready while the serve loop was dead, and ready again after the remount. Anything else is a
# different story — `R` alone is a daemon that never noticed the umount, `RD` is one that died and stayed
# dead, and `DR` is one that was never ready to begin with — and none of them is the recovery phase B claims.
docker wait "$PROBE_CONTAINER" >/dev/null 2>&1 || true
PROBE_LOG="$(docker logs "$PROBE_CONTAINER" 2>&1 | tail -1)"
PROBE_SEQ="$(printf '%s' "$PROBE_LOG" | sed -n 's/.*ready_seq=\([RD]*\).*/\1/p')"
PROBE_OK="$(printf '%s' "$PROBE_LOG" | sed -n 's/.*ready_ok=\([0-9][0-9]*\).*/\1/p')"
PROBE_DEAD="$(printf '%s' "$PROBE_LOG" | sed -n 's/.*ready_dead=\([0-9][0-9]*\).*/\1/p')"
test -n "$PROBE_SEQ" || die "the poller produced no transition sequence: $PROBE_LOG"
case "$PROBE_SEQ" in
  RDR*) ;;
  *) die "the poller saw '$PROBE_SEQ', not ready -> not-ready -> ready; the death and the recovery were not both observed" ;;
esac
echo "  the poller observed ready -> not-ready -> ready ($PROBE_SEQ: $PROBE_OK ready, $PROBE_DEAD not-ready samples)"

echo
echo "PHASE B COMPLETE: the serve loop died, was reported, and was remounted in place over the same"
echo "generation, with the same entry identity, and the daemon process never exited."

echo
echo "SERVE-DEATH GATE COMPLETE. The cleanup trap unmounts and removes the run directory, and the report"
echo "above (or in the transcript's tail) says whether any mountpoint was left behind."
