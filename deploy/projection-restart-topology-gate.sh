#!/usr/bin/env bash
# THE RESTART-TOPOLOGY GATE — PROJECTION PHASE 7 §8.7, WITH A LIVING DAEMON AND A CONSUMER THAT NEVER LETS GO.
#
# WHY THIS GATE EXISTS, AND IT IS §11.4 #16 IN ONE PARAGRAPH. The mount-layer residual that has blocked this
# tranche twice is not produced by a fault, by a supervisor or by an arm: it is produced by REPLACING THE
# DAEMON. A projectiond that goes away without removing its own mount leaves it standing at a mount point whose
# propagation is `rshared` — destroying a mount namespace is not an unmount and does not propagate one — and
# the replacement stacks over it, exactly as its startup log says it does. One dead layer per stop, for ever.
#
# WHY IT IS NOT COVERED BY ANYTHING ALREADY HERE, WHICH IS THE ARGUMENT FOR ANOTHER GATE RATHER THAN A ROW IN
# ONE. The nine gates of the §9 matrix all stop the daemon when they are finished with it and none of them
# ASSERTS anything about what that left at the mount point; the Phase 7 gate's `P7-R3-restart-left-no-layer`
# does, and it needs three digest-pinned media servers and a real provider to get there. So the one product
# behaviour §8.7 changed had no instrument that could reach it without a metered provider account and three
# hours. This is that instrument: no provider, no media server, no access material — one local entry, one
# unprivileged consumer, and the daemon's own mount lifecycle.
#
# AND THE CONSUMER IS THE WHOLE POINT, NOT SCENERY. An ordinary unmount removes a mount nobody is holding, so a
# stop with nothing attached would take the polite path every time and prove nothing about the repair. The
# verifier here holds an OPEN DESCRIPTOR on a file inside the mount for the life of the gate, which is what a
# media server does by accident while it is reading, and it is what makes the ordinary unmount fail.
#
# WHAT IT ASSERTS, IN ORDER:
#
#   RT1  a graceful stop, with a consumer holding an open descriptor, leaves NOTHING of ours at the mount point
#   RT2  and the daemon says which row it removed and why, in its own log
#   RT3  three sequential generations never exceed ONE layer above the floor the FIRST one measured
#   RT4  the control: a SIGKILLed daemon DOES leave a layer, so a green RT1 is evidence rather than a tautology
#   RT5  a foreign overlay on top is REFUSED at shutdown, left mounted and byte-unmodified
#   RT6  the host's container, network and volume SETS are identical and no mountpoint is left behind
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

GATE_ROOT="$PWD/.projection-restart-topology-gate"
REL=".projection-restart-topology-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"

PG_PORT="${PROJECTION_RESTART_TOPOLOGY_GATE_PG_PORT:-5630}"
COMPOSE_FILE="docker-compose.projection-restart-topology.yml"
COMPOSE_PROJECT="projection-restart-topology-gate"
NETWORK="$COMPOSE_PROJECT"

DAEMON_CONTAINER="projection-restart-topology-daemon-$$"
VERIFIER_CONTAINER="projection-restart-topology-verifier-$$"
STATUS_ADDR="127.0.0.1:9000"

# HOW LONG THE DAEMON IS GIVEN TO PUT ITS OWN MOUNT DOWN. Generously above everything the shipped shutdown path
# can spend, so a stop that runs out of time is a product fault rather than an instrument that did not wait.
STOP_TIMEOUT_S="${PROJECTION_RESTART_TOPOLOGY_STOP_TIMEOUT_S:-25}"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_RESTART_TOPOLOGY_GATE_PG_PORT="$PG_PORT"

# THE SHARED CLEANUP CONTRACT. Sourced before anything can fail, so the EXIT trap is armed from the first
# container name onward.
# shellcheck source=projection-gate-cleanup.sh
. "$HERE/projection-gate-cleanup.sh"

RESULTS=0
FAILURES=0
pass() { echo "  PASS  $*"; RESULTS=$(( RESULTS + 1 )); }
fail() { echo "  FAIL  $*" >&2; RESULTS=$(( RESULTS + 1 )); FAILURES=$(( FAILURES + 1 )); }
step() { echo; echo "=== $* ==="; }
die()  { echo "GATE FAILED: $*" >&2; exit 1; }

cleanup() {
  docker rm -f "$DAEMON_CONTAINER" "$VERIFIER_CONTAINER" >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  if [ -n "${WORK:-}" ]; then
    projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true
    projection_gate_report_cleanliness "$GATE_ROOT" "$WORK" || true
  fi
}
trap cleanup EXIT

GATE_SKIP_STATUS="${GATE_SKIP_STATUS:-77}"
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no /dev/fuse is reachable from a container on this host." >&2
  exit "$GATE_SKIP_STATUS"
fi

mkdir -p "$WORK/manifest" "$WORK/media" "$WORK/cache" "$WORK/mnt" "$WORK/out"
chmod 755 "$GATE_ROOT" "$WORK"
chmod 777 "$WORK/cache" "$WORK/mnt" "$WORK/out"

# EVERY EMBEDDED PROGRAM IS A FILE IN A QUOTED HEREDOC, never an inline `node -e` spanning lines.
# `test/custody-runtime-closure.ts` refuses a shipped line whose quotes do not close on it, and §11.4 #3 is the
# run that died two hours in for exactly that.
cat > "$WORK/out/jq.cjs" <<'JQ'
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const value = JSON.parse(raw)[process.argv[2]];
  console.log(value === undefined ? '' : String(value));
});
JQ

cat > "$WORK/out/sha.cjs" <<'SHA'
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
console.log(createHash('sha256').update(readFileSync(process.argv[2])).digest('hex'));
SHA

field()    { node "$REL/out/jq.cjs" "$1"; }
publish()  { npx tsx src/ops/projection-publish-cli.ts --manifest-dir "$REL/manifest" "$@"; }
register() { npx tsx src/ops/projection-register-cli.ts "$@"; }

# WHAT IS COUNTED, AND WHY IT IS COUNTED ON THE HOST. The daemon binds its mount `rshared`, so every layer it
# mounts propagates to the host at this run's own mount point — which is the whole reason a consumer in another
# container can see the file. It counts only `fuse.projectiond` rows at EXACTLY this path: a foreign overlay is
# not one of ours and a row beneath the mount point belongs to somebody else's filesystem.
count_our_layers() {
  awk -v target="$WORK/mnt" '{ sep = 0; for (i = 1; i <= NF; i++) { if ($i == "-") { sep = i; break } } if ($5 == target && sep > 0 && $(sep + 1) == "fuse.projectiond") n++ } END { print n + 0 }' /proc/self/mountinfo
}
count_rows_at_mountpoint() {
  awk -v target="$WORK/mnt" '$5 == target { n++ } END { print n + 0 }' /proc/self/mountinfo
}
survey() {
  awk -v target="$WORK/mnt" '{ sep = 0; for (i = 1; i <= NF; i++) { if ($i == "-") { sep = i; break } } if ($5 == target && sep > 0) print "    row id=" $1 " parent=" $2 " dev=" $3 " fstype=" $(sep + 1) }' /proc/self/mountinfo
}

# DOES THIS CONTAINER'S LOG SAY THIS? Asked without a pipeline: `grep -q` exits on its first match and the
# producer dies of SIGPIPE, which `pipefail` then reports as the pipeline's status — an assertion that can fail
# while what it asserts is true. Measured twice on the real host, in another gate.
logs_say() {
  case "$(docker logs "$1" 2>&1)" in
    *"$2"*) return 0 ;;
    *)      return 1 ;;
  esac
}

start_daemon() {
  docker run -d --name "$DAEMON_CONTAINER" \
    --network "$NETWORK" --user 0:0 \
    --cap-drop ALL --cap-add SYS_ADMIN --security-opt apparmor:unconfined \
    --device /dev/fuse:/dev/fuse \
    -v "$WORK/manifest:/var/lib/projectiond/manifest:ro" \
    -v "$WORK/media:/var/lib/projectiond/media:ro" \
    -v "$WORK/cache:/var/lib/projectiond/cache" \
    -v "$WORK/config.json:/etc/projectiond/config.json:ro" \
    -v "$WORK/mnt:/mnt/projection:rshared" \
    "$IMAGE" --config /etc/projectiond/config.json --poll 2s --strict-direct-mount \
    --auto-remount --auto-recover >/dev/null
}

readyz_ready() {
  docker run --rm --network "container:$DAEMON_CONTAINER" "$VERIFY_IMAGE" \
    wget -q -T 5 -O - "http://${STATUS_ADDR}/readyz" 2>/dev/null | grep -q '"ready":true'
}

await_readyz() {
  local n=0
  while [ "$n" -lt 120 ]; do
    if readyz_ready; then return 0; fi
    n=$((n + 1)); sleep 0.5
  done
  return 1
}

# THE CONSUMER'S OWN VIEW, THROUGH THE BIND IT HAS HELD SINCE BEFORE THE FIRST MOUNT.
await_visible() {
  local n=0
  while [ "$n" -lt 240 ]; do
    if docker exec -u 1000:1000 "$VERIFIER_CONTAINER" \
         test -f "/media/projection/$ENTRY_PATH" >/dev/null 2>&1; then return 0; fi
    n=$((n + 1)); sleep 0.5
  done
  return 1
}

# THE OPEN DESCRIPTOR THAT MAKES AN ORDINARY UNMOUNT FAIL, held by the consumer that was attached first. It is
# what a media server holds by accident while it is reading, and without it every stop below takes the polite
# path and this gate measures nothing.
hold_descriptor() {
  docker exec -d -u 1000:1000 "$VERIFIER_CONTAINER" \
    sh -c "exec 9< '/media/projection/$ENTRY_PATH'; while :; do sleep 3600; done"
}

# STOP THE DAEMON THE WAY THE SHIPPED OPERATOR COMMAND DOES — `deploy/projection-alpha.sh stop` is
# `compose down`, which is SIGTERM — and settle the count rather than snapping it: a mount namespace is torn
# down when its last process exits, and `docker stop` returning is not by itself a promise that the host's
# mount table has caught up. A residual that is real never reaches the floor and is reported at the bound.
STOP_LOG=""
stop_daemon_gracefully() {
  docker stop -t "$STOP_TIMEOUT_S" "$DAEMON_CONTAINER" >/dev/null 2>&1 || true
  STOP_LOG="$(docker logs "$DAEMON_CONTAINER" 2>&1 || true)"
  docker rm -f "$DAEMON_CONTAINER" >/dev/null 2>&1 || true
  local settle=0
  while [ "$settle" -lt 20 ] && [ "$(count_our_layers)" -gt "$FLOOR" ]; do
    sleep 0.5
    settle=$(( settle + 1 ))
  done
}

# ----------------------------------------------------------------------------------------------------------
step "building the production projectiond image"
# ----------------------------------------------------------------------------------------------------------
docker build -t "$IMAGE" ./projectiond

# ----------------------------------------------------------------------------------------------------------
step "the host, before anything of this gate's exists"
# ----------------------------------------------------------------------------------------------------------
# THE SNAPSHOTS ARE HELD IN VARIABLES AND NOT IN THE RUN DIRECTORY, because the cleanup contract REMOVES the
# run directory — and the first execution of this gate wrote its "after" files into a directory that had just
# been deleted, so the comparison compared two absences and reported every set as different. A snapshot that
# the teardown can destroy is not a snapshot of the teardown.
CONTAINERS_BEFORE="$(docker ps -a --format '{{.Names}}' | LC_ALL=C sort)"
NETWORKS_BEFORE="$(docker network ls --format '{{.Name}}' | LC_ALL=C sort)"
VOLUMES_BEFORE="$(docker volume ls --format '{{.Name}}' | LC_ALL=C sort)"
echo "  $(echo "$CONTAINERS_BEFORE" | wc -l) containers, $(echo "$NETWORKS_BEFORE" | wc -l) networks, $(echo "$VOLUMES_BEFORE" | wc -l) volumes"

# ----------------------------------------------------------------------------------------------------------
step "starting a real PostgreSQL and migrating it"
# ----------------------------------------------------------------------------------------------------------
docker compose -f "$COMPOSE_FILE" up -d --wait postgres
npx tsx src/ops/migrate-cli.ts
docker network create "$NETWORK" >/dev/null 2>&1 || true
echo "  migrated"

# ----------------------------------------------------------------------------------------------------------
step "seeding one LOCAL entry — no provider, no access material, no media server"
# ----------------------------------------------------------------------------------------------------------
SUBJECT_FILE="restart-topology-subject.bin"
SUBJECT_SIZE=$((4 * 1024 * 1024))
head -c "$SUBJECT_SIZE" /dev/urandom > "$WORK/media/$SUBJECT_FILE"
SUBJECT_SHA="$(node "$REL/out/sha.cjs" "$REL/media/$SUBJECT_FILE")"
ENTRY_PATH="Movies/Restart Topology Subject (2026)/Restart Topology Subject (2026).bin"

register root --id media --kind local
register version --key restart-topology --size "$SUBJECT_SIZE" --mtime 2026-06-01T10:00:00.000Z
register entry --item "cccccccc-3333-4333-8333-cccccccccccc" --version-key restart-topology \
  --path "$ENTRY_PATH" --source "local:media:${SUBJECT_FILE}"
publish > "$WORK/out/publish-1.json"
test "$(field outcome < "$WORK/out/publish-1.json")" = "published" || die "generation 1 was not published"
echo "  generation 1 published; the subject is $SUBJECT_SIZE bytes"

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

# ----------------------------------------------------------------------------------------------------------
step "the consumer attaches BEFORE anything has ever been mounted here"
# ----------------------------------------------------------------------------------------------------------
# BEFORE, because that is the shipped consumer-attachment contract: a bind taken while the path is a plain
# directory is a slave of the PARENT's peer group and follows every later mount at that path, while a bind
# taken over an existing mount belongs to that mount's group alone and is stranded the moment it goes.
docker run -d --name "$VERIFIER_CONTAINER" --user 1000:1000 \
  -v "$WORK/mnt:/media/projection:rslave" "$VERIFY_IMAGE" \
  sh -c 'while :; do sleep 3600; done' >/dev/null
echo "  a persistent unprivileged consumer is attached to the mount point BEFORE anything is mounted there"

# THE FLOOR IS TAKEN BEFORE THE DAEMON HAS EVER MOUNTED, so it is a fact rather than an inference — and it is
# never re-taken, which is the whole point: every generation below is measured against THIS number.
FLOOR="$(count_our_layers)"
echo "  the floor at the mount point is $FLOOR of ours and $(count_rows_at_mountpoint) row(s) of any kind"

# ----------------------------------------------------------------------------------------------------------
step "RT1 and RT2 — a graceful stop with a consumer HOLDING the mount open"
# ----------------------------------------------------------------------------------------------------------
start_daemon
await_readyz || { docker logs "$DAEMON_CONTAINER" >&2 2>&1; die "the daemon never became ready"; }
await_visible || die "the namespace never became visible to the consumer that attached first"
GOT_SHA="$(docker exec -u 1000:1000 "$VERIFIER_CONTAINER" \
  sh -c "sha256sum '/media/projection/$ENTRY_PATH'" | awk '{print $1}')"
test "$GOT_SHA" = "$SUBJECT_SHA" || die "the mount is serving the wrong bytes"
LIVE="$(count_our_layers)"
echo "  serving: $LIVE of ours at the mount point, against a floor of $FLOOR"
test "$LIVE" -eq $(( FLOOR + 1 )) || die "a freshly started daemon is not exactly one layer above the floor"

hold_descriptor
sleep 2
stop_daemon_gracefully

AFTER="$(count_our_layers)"
if [ "$AFTER" -eq "$FLOOR" ]; then
  pass "RT1 a graceful stop with a consumer holding an open descriptor left NOTHING of ours at the mount point ($FLOOR)"
else
  survey >&2
  echo "$STOP_LOG" | grep -E "unmount|detach|leaving|request loop" | tail -8 | sed 's/^/    daemon: /' >&2 || true
  fail "RT1 the stop left $AFTER of ours against a floor of $FLOOR"
fi

# AND THE DAEMON SAYS WHICH ROW IT REMOVED AND WHY. A count that came back to the floor for some other reason
# would pass RT1 and prove nothing about the repair; the log line is what ties the number to the decision.
if echo "$STOP_LOG" | grep -q "detaching this process's own mount"; then
  pass "RT2 the daemon named the removal as its OWN row, on the ordinary unmount being refused"
elif echo "$STOP_LOG" | grep -q "unmount refused"; then
  fail "RT2 the ordinary unmount was refused and the daemon did NOT detach its own row"
else
  # THE POLITE PATH IS NOT A FAILURE AND IT IS NOT THE MEASUREMENT EITHER. If the ordinary unmount succeeded
  # the repair was never reached, and saying so is the honest outcome — but with a descriptor held open it is
  # also a surprise, so it is reported loudly rather than counted as a pass.
  fail "RT2 the ordinary unmount was NOT refused even with a consumer holding a descriptor, so the shutdown detach was never exercised"
fi

# ----------------------------------------------------------------------------------------------------------
step "RT3 — three sequential generations against the floor the FIRST one measured"
# ----------------------------------------------------------------------------------------------------------
# THE POINT IS THE SEQUENCE AND NOT THE GENERATION. Every generation in isolation measures one layer above its
# OWN floor; the defect is that the floor MOVES, and a cold-start check cannot see it. This is #16 in the shape
# an instrument can actually reach without a provider.
SEQ_MAX=0
for generation in 1 2 3; do
  start_daemon
  await_readyz || { docker logs "$DAEMON_CONTAINER" >&2 2>&1; die "generation $generation never became ready"; }
  await_visible || die "generation $generation never became visible to the consumer"
  hold_descriptor
  sleep 2
  ABOVE=$(( $(count_our_layers) - FLOOR ))
  echo "  generation $generation: $ABOVE layer(s) above the floor of $FLOOR while serving"
  if [ "$ABOVE" -gt "$SEQ_MAX" ]; then SEQ_MAX="$ABOVE"; fi
  SEQ_SHA="$(docker exec -u 1000:1000 "$VERIFIER_CONTAINER" \
    sh -c "sha256sum '/media/projection/$ENTRY_PATH'" | awk '{print $1}')"
  test "$SEQ_SHA" = "$SUBJECT_SHA" \
    || die "generation $generation serves different bytes to the consumer that never re-bound"
  stop_daemon_gracefully
  BETWEEN=$(( $(count_our_layers) - FLOOR ))
  echo "  generation $generation: $BETWEEN layer(s) above the floor after the stop"
  if [ "$BETWEEN" -ne 0 ]; then
    survey >&2
    fail "RT3 generation $generation left $BETWEEN layer(s) behind, so the next generation would stack over it"
    SEQ_MAX=99
    break
  fi
done
if [ "$SEQ_MAX" -le 1 ]; then
  pass "RT3 three sequential generations never exceeded 1 layer above the floor the FIRST one measured, and the same consumer read the same digest through every one without being restarted or re-bound"
else
  fail "RT3 the sequence reached $SEQ_MAX layer(s) above the floor"
fi

# ----------------------------------------------------------------------------------------------------------
step "RT4 — THE CONTROL: a SIGKILLed daemon still leaves its mount, and that has to be true"
# ----------------------------------------------------------------------------------------------------------
# A GREEN RT1 IS ONLY EVIDENCE IF THE DEFECT IS STILL REPRODUCIBLE. If a kernel or a topology change had made
# the residual impossible, every assertion above would pass for a reason that has nothing to do with the
# repair — which is precisely the shape #13 was wrongly resolved by.
start_daemon
await_readyz || die "the control generation never became ready"
await_visible || die "the control generation never became visible"
hold_descriptor
sleep 2
docker rm -f "$DAEMON_CONTAINER" >/dev/null 2>&1 || true
KILL_SETTLE=0
while [ "$KILL_SETTLE" -lt 20 ] && [ "$(count_our_layers)" -le "$FLOOR" ]; do
  sleep 0.5
  KILL_SETTLE=$(( KILL_SETTLE + 1 ))
done
KILLED_LEFT=$(( $(count_our_layers) - FLOOR ))
if [ "$KILLED_LEFT" -ge 1 ]; then
  pass "RT4 a SIGKILLed daemon left $KILLED_LEFT of its own at the mount point, so the defect RT1 measures the repair for is still real on this host"
else
  fail "RT4 a SIGKILLed daemon left nothing behind, so RT1 passes for a reason that is not the repair and this gate proves nothing"
fi
# AND IT IS CLEARED THE WAY THE SHIPPED PREFLIGHT PRESCRIBES, which is the operator's own remediation for the
# one case §8.7 says it cannot cover: `clear-stale-mount`, `umount -l <your mount point>`.
CLEARED=0
n=0
while [ "$n" -lt 8 ] && [ "$(count_our_layers)" -gt "$FLOOR" ]; do
  umount -l "$WORK/mnt" 2>/dev/null || true
  n=$(( n + 1 )); sleep 0.5
done
[ "$(count_our_layers)" -eq "$FLOOR" ] && CLEARED=1
if [ "$CLEARED" -eq 1 ]; then
  pass "RT4 and the operator remediation the shipped preflight prints — umount -l — cleared it back to the floor"
else
  survey >&2
  fail "RT4 the mount point could not be cleared back to the floor by the shipped remediation"
fi

# ----------------------------------------------------------------------------------------------------------
step "RT5 — a FOREIGN overlay on top is refused at shutdown, left mounted and byte-unmodified"
# ----------------------------------------------------------------------------------------------------------
# THE MOST IMPORTANT ROW IN THIS GATE. §8.7's removal is authorised by an IDENTITY, so anything that is not the
# row this process made must be refused — and the likeliest such thing at a projection mount point is somebody
# else's mount. Phase 6 `AA6` and `RC5` assert the same property of the recovery path; this asserts it of the
# shutdown path, which is new.
start_daemon
await_readyz || die "the overlay generation never became ready"
await_visible || die "the overlay generation never became visible"
hold_descriptor
sleep 2
OVERLAY_TAG="restart-topology-foreign-$$"
mount -t tmpfs -o size=1m,nr_inodes=64 "$OVERLAY_TAG" "$WORK/mnt" \
  || die "RT5: a tmpfs could not be stacked above the live mount, so nothing could be refused"
CANARY="$WORK/mnt/foreign-canary.txt"
echo "$OVERLAY_TAG" > "$CANARY"
CANARY_BEFORE="$(cat "$CANARY")"
stop_daemon_gracefully

TOP_FS="$(awk -v target="$WORK/mnt" '{ sep = 0; for (i = 1; i <= NF; i++) { if ($i == "-") { sep = i; break } } if ($5 == target && sep > 0) t = $(sep + 1) } END { print t }' /proc/self/mountinfo)"
CANARY_AFTER="$(cat "$CANARY" 2>/dev/null || echo "")"
if [ "$TOP_FS" = "tmpfs" ] && [ -n "$CANARY_BEFORE" ] && [ "$CANARY_BEFORE" = "$CANARY_AFTER" ]; then
  pass "RT5 the foreign overlay is STILL the top of the stack and byte-unmodified after the daemon stopped"
else
  survey >&2
  fail "RT5 the foreign overlay was disturbed by the shutdown (top is now '$TOP_FS')"
fi
if echo "$STOP_LOG" | grep -q "leaving .* exactly as it is"; then
  pass "RT5 and the daemon said so: it refused to remove a row that is not the attachment it created"
else
  echo "$STOP_LOG" | grep -E "unmount|detach|leaving" | tail -6 | sed 's/^/    daemon: /' >&2 || true
  fail "RT5 the daemon did not record refusing to remove a row that is not its own"
fi
# THE GATE REMOVES ITS OWN OVERLAY, AND ONLY IT. This is the human in Phase 6's `AA6`.
rm -f "$CANARY" 2>/dev/null || true
umount "$WORK/mnt" 2>/dev/null || umount -l "$WORK/mnt" 2>/dev/null || true
n=0
while [ "$n" -lt 8 ] && [ "$(count_our_layers)" -gt "$FLOOR" ]; do
  umount -l "$WORK/mnt" 2>/dev/null || true
  n=$(( n + 1 )); sleep 0.5
done

# ----------------------------------------------------------------------------------------------------------
step "RT6 — the host is as it was found, asserted rather than reported"
# ----------------------------------------------------------------------------------------------------------
docker rm -f "$VERIFIER_CONTAINER" >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
docker network rm "$NETWORK" >/dev/null 2>&1 || true
projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true

CONTAINERS_AFTER="$(docker ps -a --format '{{.Names}}' | LC_ALL=C sort)"
NETWORKS_AFTER="$(docker network ls --format '{{.Name}}' | LC_ALL=C sort)"
VOLUMES_AFTER="$(docker volume ls --format '{{.Name}}' | LC_ALL=C sort)"
SETS_OK=1
if [ "$CONTAINERS_BEFORE" != "$CONTAINERS_AFTER" ]; then
  SETS_OK=0; echo "  the container SET differs:" >&2
  diff <(echo "$CONTAINERS_BEFORE") <(echo "$CONTAINERS_AFTER") | head -6 >&2 || true
fi
if [ "$NETWORKS_BEFORE" != "$NETWORKS_AFTER" ]; then
  SETS_OK=0; echo "  the network SET differs:" >&2
  diff <(echo "$NETWORKS_BEFORE") <(echo "$NETWORKS_AFTER") | head -6 >&2 || true
fi
if [ "$VOLUMES_BEFORE" != "$VOLUMES_AFTER" ]; then
  SETS_OK=0; echo "  the volume SET differs:" >&2
  diff <(echo "$VOLUMES_BEFORE") <(echo "$VOLUMES_AFTER") | head -6 >&2 || true
fi
LEFT="$(count_our_layers)"
if [ "$SETS_OK" -eq 1 ] && [ "$LEFT" -eq "$FLOOR" ]; then
  pass "RT6 the container, network and volume SETS are identical and nothing of ours is left at the mount point"
else
  fail "RT6 the host is not as it was found (sets ok=$SETS_OK, $LEFT of ours at the mount point against a floor of $FLOOR)"
fi

echo
echo "RESTART-TOPOLOGY GATE: $(( RESULTS - FAILURES )) pass, $FAILURES fail, of $RESULTS assertions."
echo "WHAT THIS GATE DOES NOT PROVE:"
echo "  - No provider was contacted and none could be: the daemon is configured with no endpoint."
echo "  - No media server was involved. The consumer is an unprivileged container holding a descriptor."
echo "  - It says nothing about any Phase 7 arm. P7-arm-layers is measured by the Phase 7 gate and nowhere else."
if [ "$FAILURES" -ne 0 ]; then
  exit 1
fi
echo "RESULT: PASSED"
