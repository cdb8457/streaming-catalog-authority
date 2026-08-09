#!/usr/bin/env bash
# The STALE-MOUNT gate: a projectiond corpse — our own mount whose transport is gone — and how the daemon
# answers one at startup.
#
# WHAT A STALE MOUNT IS. A mount is a conversation between the kernel and a process, and a FUSE mount keeps
# its place in the namespace even after the conversation is over. A daemon that dies WITHOUT unmounting
# leaves its mountpoint behind: mountinfo still shows "fuse.projectiond", but every statfs on it answers
# ENOTCONN, because the process that served it is gone. The probe names exactly that state
# (`stale-projectiond`) with one statfs and one mountinfo read — a dead daemon's corpse.
#
# HOW THE CORPSE IS MADE HERE, AND ONLY HERE. The gate's daemon mounts with `:rshared` propagation, exactly
# like every other gate, so its mount is visible to the host. The gate then SIGKILLs that daemon without
# giving it a chance to unmount, and the host-side copy of its mount becomes the corpse — the same dangling
# mount the shared cleanup contract exists to clear ("clear it with: umount -l"). Nothing else on this system
# creates one, and the gate proves the daemon's startup probe handles exactly this object.
#
# WHY STATFS, NOT STAT, NAMES THE CORPSE. stat() on a dead mount's ROOT is answered from the kernel's
# attribute cache for a while after the connection dies — a corpse "stats fine" while its cache is warm. FUSE
# caches nothing for statfs: every statfs reaches the connection, so a dead one answers ENOTCONN immediately.
# The gate verifies the corpse the same way the probe does, from a sibling container.
#
# THE TWO PHASES, BOTH AGAINST THE SAME CORPSE.
#
#   default        the daemon probes the corpse, NAMES it in its log ("stale projectiond mount detected"),
#                  says what it is doing about it ("stacking over the stale mount (default); clear it with:
#                  umount -l"), stacks over the corpse, and serves generation 1 — verified through /readyz and
#                  through the mount, with the same entry identity the corpse carried. A SIGTERM then unmounts
#                  the recovery mount cleanly (exit 0), leaving the corpse for phase 2.
#   --refuse-stale the daemon probes the SAME corpse and refuses to serve over it: it logs "refusing to
#                  start: stale mount at /mnt/projection" and exits 1, because serving a namespace whose
#                  transport is gone is exactly the state that must not be inherited silently.
#
# WHY IT IS NOT G7-G9. The media-server gates SIGKILL the daemon and restart it, and prove the mount SURVIVES
# a process death — the new process stacks over the corpse and the supervisor keeps serving. This gate's
# subject is the corpse itself: the daemon faces one at STARTUP, where the probe decides the stack lands on
# something it should name rather than something it should guess about. Both halves are the probe, and the
# probe is only as good as the corpse it is exercised against, so the corpse is made by the production image
# and verified stale before either phase runs.
#
# WHAT THE GATE DOES NOT TOUCH. No media server, no provider, no access material. The namespace is a single
# LOCAL entry served from a host file through the production image, so the whole experiment is the daemon's
# own mount lifecycle and nothing else.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

GATE_ROOT="$PWD/.projection-stale-mount-gate"
REL=".projection-stale-mount-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"

PG_PORT="${PROJECTION_STALE_MOUNT_GATE_PG_PORT:-5570}"
COMPOSE_FILE="docker-compose.projection-stale-mount.yml"
COMPOSE_PROJECT="projection-stale-mount-gate"
NETWORK="$COMPOSE_PROJECT"

SOURCE_CONTAINER="projection-stale-mount-source-$$"
REFUSE_CONTAINER="projection-stale-mount-refuse-$$"
RECOVERY_CONTAINER="projection-stale-mount-recovery-$$"
STATUS_ADDR="127.0.0.1:9000"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_STALE_MOUNT_GATE_PG_PORT="$PG_PORT"

# BOTH PHASES RUN, DEFAULT THEN --refuse-stale, AGAINST THE SAME CORPSE. There is no phase flag, and the
# absence is the point.
#
# THIS GATE USED TO HAVE ONE, AND IT MADE THE EVIDENCE COMMAND PROVE HALF ITS CLAIM. The phase was selected by
# `--refuse-stale` or `PROJECTION_STALE_MOUNT_GATE_REFUSE_STALE`, both defaulting to the first phase — and
# nothing that an operator actually runs passed either. `npm run go:stale-mount-gate:three` therefore ran the
# stacking half three times, printed "PHASE 1 COMPLETE", exited 0, and was recorded as the gate passing, while
# the Phase 2 document said the gate exercises BOTH halves against the SAME corpse. The refusal — the entire
# reason `--refuse-stale` exists in the daemon — was never once executed by the command that closes the gate.
#
# A default that decides how much of a gate runs is a default that decides how much is proved, so the choice
# is gone rather than re-defaulted: a caller who wants half the evidence is a caller who wants half the
# evidence, and the acceptance plan names one stale-mount gate.

# How long phase 2 waits for the refusing daemon to exit, in half-second ticks. A refusal is a startup
# decision — probe, log, exit, before any mount — so 60s is enormous for it; the bound exists to turn a daemon
# that never exits into a failure rather than a hang.
REFUSE_TIMEOUT_TICKS=120

# THE SHARED CLEANUP CONTRACT. Sourced before anything can fail, so the EXIT trap is armed from the first
# container name onward — and the corpse this gate creates is exactly the mount the contract was written to
# clear.
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
  docker rm -f "$SOURCE_CONTAINER" "$REFUSE_CONTAINER" "$RECOVERY_CONTAINER" >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  if [ -n "${WORK:-}" ]; then
    # THE CORPSE IS CLEARED THE WAY THE PROBE ITSELF PRESCRIBES: "clear it with: umount -l".
    projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true
    projection_gate_report_cleanliness "$GATE_ROOT" "$WORK" || true
  fi
}
trap cleanup EXIT

readyz_ready() {
  docker run --rm --network "container:$1" "$VERIFY_IMAGE" \
    wget -q -T 5 -O - "http://${STATUS_ADDR}/readyz" 2>/dev/null | grep -q '"ready":true'
}

await_readyz() {
  local container="$1" attempts="${2:-60}" n=0
  while [ "$n" -lt "$attempts" ]; do
    if readyz_ready "$container"; then return 0; fi
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
  docker run -d --name "$1" \
    --network "$NETWORK" --user 0:0 \
    --cap-drop ALL --cap-add SYS_ADMIN --security-opt apparmor:unconfined \
    --device /dev/fuse:/dev/fuse \
    -v "$WORK/manifest:/var/lib/projectiond/manifest:ro" \
    -v "$WORK/media:/var/lib/projectiond/media:ro" \
    -v "$WORK/cache:/var/lib/projectiond/cache" \
    -v "$WORK/config.json:/etc/projectiond/config.json:ro" \
    -v "$WORK/mnt:/mnt/projection:rshared" \
    "$IMAGE" --config /etc/projectiond/config.json --poll 2s --strict-direct-mount ${2:-} >/dev/null
}

# THE CORPSE CHECK, RUN FROM A SIBLING CONTAINER, THE SAME WAY THE PROBE LOOKS AT IT: statfs (never cached,
# so ENOTCONN is immediate on a corpse) plus a mountinfo read that must still name the mount fuse.projectiond.
# A stale mount keeps "statting fine" while its attribute cache is warm, so a stat-based check would not prove
# anything; this one proves what the probe proves.
corpse_is_stale() {
  local stderr err
  if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" df -P /mnt >/dev/null 2>&1; then
    die "the corpse is not stale: a sibling container's statfs still answered"
  fi
  stderr="$(docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" df -P /mnt 2>&1 || true)"
  printf '%s' "$stderr" | grep -qi "transport endpoint is not connected" \
    || die "the corpse is stale for the wrong reason: $(printf '%s' "$stderr" | tr '\n' ' ')"
  err=""
  local count
  count="$(docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
    sh -c "grep -c 'fuse.projectiond' /proc/self/mountinfo || true")"
  [ "${count:-0}" -ge 1 ] || die "no fuse.projectiond mount in the sibling's mountinfo"
  echo "  the corpse is stale: statfs answers ENOTCONN and mountinfo still names fuse.projectiond"
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
# a corpse therefore has exactly one explanation.
STALE_FILE="stale-mount-subject.bin"
STALE_SIZE=$((8 * 1024 * 1024))
head -c "$STALE_SIZE" /dev/urandom > "$WORK/media/$STALE_FILE"
STALE_SHA="$(node "$REL/sha.cjs" "$REL/media/$STALE_FILE")"
ENTRY_PATH="Movies/Stale Mount Subject (2026)/Stale Mount Subject (2026).bin"

register root --id media --kind local
register version --key stale-subject --size "$STALE_SIZE" --mtime 2026-06-01T10:00:00.000Z
register entry --item "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" --version-key stale-subject \
  --path "$ENTRY_PATH" --source "local:media:${STALE_FILE}"
publish > "$WORK/out/publish-1.json"
test "$(field outcome < "$WORK/out/publish-1.json")" = "published" || die "generation 1 was not published"
echo "  generation 1 published; the fixture is $STALE_SIZE bytes, sha256 $STALE_SHA"

# ----------------------------------------------------------------------------------------------------------
step "a serving daemon becomes the corpse"
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

start_daemon "$SOURCE_CONTAINER"
echo "  waiting for the daemon to be ready and the namespace to be visible"
await_readyz "$SOURCE_CONTAINER" || die "the source daemon never became ready"
await_namespace || die "the source mount never became visible"
GOT_SHA="$(docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
  sh -c "sha256sum '/mnt/$ENTRY_PATH'" | awk '{print $1}')"
test "$GOT_SHA" = "$STALE_SHA" || die "the source mount is serving the wrong bytes"
echo "  the source mount is live, /readyz answers ready=true, and the live read digest is verified"

docker kill -s 9 "$SOURCE_CONTAINER" >/dev/null
docker wait "$SOURCE_CONTAINER" >/dev/null 2>&1 || true
echo "  the source daemon was SIGKILLed without a chance to unmount; its host-side mount is now a corpse"
corpse_is_stale

# ----------------------------------------------------------------------------------------------------------
step "phase 1 (default) — the daemon names the corpse and stacks over it"
# ----------------------------------------------------------------------------------------------------------
start_daemon "$RECOVERY_CONTAINER"
echo "  waiting for the recovery daemon to be ready and the namespace to be visible again"
await_readyz "$RECOVERY_CONTAINER" || { docker logs "$RECOVERY_CONTAINER" 2>&1 | tail -30 >&2; die "the recovery daemon never became ready"; }
await_namespace || { docker logs "$RECOVERY_CONTAINER" 2>&1 | tail -30 >&2; die "the recovery mount never became visible"; }
RECOVERY_SHA="$(docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
  sh -c "sha256sum '/mnt/$ENTRY_PATH'" | awk '{print $1}')"
test "$RECOVERY_SHA" = "$STALE_SHA" || die "the stacked mount is serving different bytes than the corpse carried"
echo "  /readyz answers ready=true and the stacked mount serves the same digest the corpse carried"

docker logs "$RECOVERY_CONTAINER" 2>&1 | grep -q "stale projectiond mount detected at /mnt/projection" \
  || die "the recovery daemon did not name the corpse in its log"
docker logs "$RECOVERY_CONTAINER" 2>&1 | grep -q "stacking over the stale mount (default); clear it with: umount -l /mnt/projection" \
  || die "the recovery daemon did not say what it was doing about the corpse"
docker logs "$RECOVERY_CONTAINER" 2>&1 | grep -q "serving generation 1" \
  || die "the recovery daemon did not report serving generation 1"
echo "  the recovery daemon's log names the corpse, says it is stacking over it, and reports serving generation 1"

docker stop "$RECOVERY_CONTAINER" >/dev/null
# `docker stop` has already returned, so the container has exited and its status is a fact to be read rather
# than an event to be waited for. Read it, rather than blocking on `docker wait`: a wait whose result IS the
# assertion is the shape that hung phase 2 below, and there is no reason for this one to take that shape.
RECOVERY_EXIT="$(docker inspect -f '{{.State.ExitCode}}' "$RECOVERY_CONTAINER")"
test "$RECOVERY_EXIT" = "0" || die "the recovery daemon exited $RECOVERY_EXIT after a requested SIGTERM, not 0"
echo "  a requested SIGTERM unmounted the recovery mount cleanly (exit 0)"
corpse_is_stale

echo
echo "PHASE 1 COMPLETE: the daemon faced the corpse, named it, stacked over it, and served generation 1;"
echo "a requested SIGTERM then unmounted cleanly. The corpse remains, and phase 2 faces the same one."

# ----------------------------------------------------------------------------------------------------------
step "phase 2 (--refuse-stale) — the SAME corpse, and the daemon refuses to serve over it"
# ----------------------------------------------------------------------------------------------------------
# THE CORPSE IS THE ONE PHASE 1 LEFT, re-verified stale immediately above. That is what makes the two halves
# comparable: the default stacked over this object, and the flag refuses this object.
start_daemon "$REFUSE_CONTAINER" "--refuse-stale"

# THE WAIT IS BOUNDED, AND THE BOUND IS THE ASSERTION. A refusal is a startup decision — the daemon probes,
# logs and exits before it ever mounts — so it is over in seconds. An unbounded `docker wait` here would mean
# that the one regression this phase exists to catch, a --refuse-stale daemon that SERVES instead of refusing,
# hangs the gate forever instead of failing it: the daemon would sit there serving, and `docker wait` would
# sit there waiting. A gate that hangs on the defect it is looking for reports nothing at all.
REFUSE_EXIT=""
n=0
while [ "$n" -lt "$REFUSE_TIMEOUT_TICKS" ]; do
  REFUSE_STATE="$(docker inspect -f '{{.State.Status}}' "$REFUSE_CONTAINER" 2>/dev/null || echo missing)"
  if [ "$REFUSE_STATE" = "exited" ]; then
    REFUSE_EXIT="$(docker inspect -f '{{.State.ExitCode}}' "$REFUSE_CONTAINER")"
    break
  fi
  n=$((n + 1))
  sleep 0.5
done
if [ -z "$REFUSE_EXIT" ]; then
  docker logs "$REFUSE_CONTAINER" 2>&1 | tail -30 >&2
  die "the --refuse-stale daemon was still running after $((REFUSE_TIMEOUT_TICKS / 2))s; a refusal exits at startup, so it is serving over the corpse"
fi
test "$REFUSE_EXIT" = "1" || die "the refusing daemon exited $REFUSE_EXIT, not 1, for a stale mount"
echo "  the refusing daemon exited with status 1"
docker logs "$REFUSE_CONTAINER" 2>&1 | grep -q "stale projectiond mount detected at /mnt/projection" \
  || die "the refusing daemon did not name the corpse in its log"
docker logs "$REFUSE_CONTAINER" 2>&1 | grep -q "refusing to start: stale mount at /mnt/projection" \
  || die "the refusing daemon did not report its refusal"
echo "  the refusing daemon's log names the corpse and says 'refusing to start: stale mount at /mnt/projection'"
# AND IT REFUSED WITHOUT MOUNTING. A daemon that stacked and then exited 1 would satisfy every assertion
# above; the corpse still being the only projectiond mount here is what says the refusal happened instead of
# a mount followed by a late failure.
corpse_is_stale

echo
echo "PHASE 2 COMPLETE: with --refuse-stale, the daemon refuses to serve over the corpse and exits 1."

echo
echo "STALE-MOUNT GATE COMPLETE. Both halves ran against the same corpse. The cleanup trap unmounts and"
echo "removes the run directory, and the report above (or in the transcript's tail) says whether any"
echo "mountpoint was left behind."
