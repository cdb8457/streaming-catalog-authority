#!/usr/bin/env bash
# The OPERATIONAL MOUNT HEALTH gate: does readiness now answer from the mount, does liveness stay a different
# question, and does the shipped container healthcheck report the difference?
#
# WHAT IT IS FOR. Phase 4 put an OBSERVATION beside the daemon's BELIEF and changed neither `ready` nor
# `mounted`; its §5 named the remaining half and deferred it on purpose. Phase 5 takes that decision:
# readiness now depends on the observation through a bounded policy — a bootstrap grace, a fault hold and a
# recovery confirmation — and `/healthz` becomes a separate surface that answers only whether the process is
# alive. This gate is what says all of that is true of a real mount on a real host.
#
# WHY THE POLICY IS NOT `observed == live`, WHICH IS WHY HALF THESE ARMS EXIST. The observation is a SAMPLE
# and a sample is late by construction. Wiring readiness straight to it would make a HEALTHY daemon flap, so
# MH6 asserts that a transient fault does NOT take the appliance out of service while MH2 asserts that a
# sustained one does, and MH8 asserts that the way back requires the mount to be OBSERVED live rather than
# merely declared mounted.
#
# WHAT IT DOES NOT TOUCH. No provider, no endpoint, no credential, no operator corpus, no media server. The
# daemons' configurations name no endpoint at all, so there is nothing they could contact. The namespace is a
# single LOCAL entry served from a host file through the production image.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

GATE_ROOT="$PWD/.projection-mount-health-gate"
REL_GATE_ROOT=".projection-mount-health-gate"
REL=".projection-mount-health-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"

PG_PORT="${PROJECTION_MOUNT_HEALTH_GATE_PG_PORT:-5610}"
COMPOSE_FILE="docker-compose.projection-mount-health.yml"
COMPOSE_PROJECT="projection-mount-health-gate"
NETWORK="$COMPOSE_PROJECT"

DAEMON_CONTAINER="projection-mount-health-daemon-$$"
BLOCKER_CONTAINER="projection-mount-health-blocker-$$"
VERIFIER_CONTAINER="projection-mount-health-verifier-$$"
STATUS_ADDR="127.0.0.1:9000"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_MOUNT_HEALTH_GATE_PG_PORT="$PG_PORT"

# THE THRESHOLDS ARE READ FROM THE MODULE, NEVER SPELLED HERE.
# `test/projection-operational-mount-health.ts` asserts this file contains no literal spelling of any of them,
# so a number cannot drift between the contract and the gate that measures against it. The reason CODES come
# through the same door for the same reason: an arm comparing against a mistyped literal is an arm that can
# never fail.
MH_BUDGETS="$(npx tsx src/ops/projection-mount-health-cli.ts budgets --sh)" \
  || { echo "the mount-health thresholds could not be read; nothing can be measured against them" >&2; exit 1; }
eval "$MH_BUDGETS"

# THE SHARED CLEANUP CONTRACT. Sourced before anything can fail, so the EXIT trap is armed from the first
# container name onward.
# shellcheck source=projection-gate-cleanup.sh
. "$HERE/projection-gate-cleanup.sh"

# THE ONE SKIP CONDITION, AND IT IS /dev/fuse. A host that cannot host a mount cannot host this gate, and on
# such a host the honest answer is "nothing was proved", which is what status 77 says.
GATE_SKIP_STATUS="${GATE_SKIP_STATUS:-77}"
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no /dev/fuse is reachable from a container on this host." >&2
  exit "$GATE_SKIP_STATUS"
fi
echo "  /dev/fuse is reachable from a container"

mkdir -p "$WORK/manifest" "$WORK/media" "$WORK/cache" "$WORK/blocker-cache" "$WORK/mnt" "$WORK/out"
chmod 755 "$GATE_ROOT" "$WORK"
chmod 777 "$WORK/cache" "$WORK/blocker-cache" "$WORK/mnt" "$WORK/out"

PASSED=0
FAILED=0

step() { echo; echo "=== $* ==="; }
die()  { echo "GATE FAILED: $*" >&2; exit 1; }

# ONE VERDICT, PRINTED UNDER ITS OWN ID. A failing id does not abort the run on its own: the arms after it
# still carry information, and a gate that stopped at the first failure would report one defect per run.
pass() { PASSED=$(( PASSED + 1 )); echo "  PASS  $*"; }
fail() { FAILED=$(( FAILED + 1 )); echo "  FAIL  $*" >&2; }

# EVERY EMBEDDED SCRIPT IS A FILE IN A QUOTED HEREDOC, never an inline multi-line `node -e`.
# `test/custody-runtime-closure.ts` parses every shipped script and refuses a line whose quotes do not close.
# AN UNREADABLE DOCUMENT PRINTS NOTHING RATHER THAN THROWING. A field read out of a body that never arrived
# is an ABSENT measurement, and the arm that wanted it must fail on a non-value.
cat > "$WORK/out/jq.cjs" <<'JQ'
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log('');
    return;
  }
  const value = parsed[process.argv[2]];
  console.log(value === undefined ? '' : String(value));
});
JQ

# THE STATUS SURFACES ARE READ WITH A RAW REQUEST, AND THE STATUS CODE IS PART OF THE MEASUREMENT.
#
# `/readyz` answers 503 whenever the daemon is not ready — which, under every fault below, is precisely when
# the body is worth reading. BusyBox `wget` treats a 503 as an error and DISCARDS the body, which is the
# defect the Phase 4 gate met on its first real run. A raw HTTP/1.0 request keeps the body whatever the
# status line says, and it needs no image beyond the one already pinned here.
#
# THE CODE IS PRINTED FIRST, ON ITS OWN LINE. Several arms are about the code as much as the body: MH2 asks
# for a 503 and MH10 asks for a 200 from the OTHER endpoint at the same moment, and a gate that read only
# bodies could not tell those apart.
cat > "$WORK/out/http.sh" <<'HTTP'
set -eu
addr="$1"
path="$2"
host="${addr%%:*}"
port="${addr##*:}"
raw="$(printf 'GET %s HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n' "$path" "$addr" | nc "$host" "$port")"
printf '%s\n' "$raw" | head -1 | awk '{print $2}'
printf '%s\n' "$raw" | sed -e '1,/^[[:space:]]*$/d'
HTTP

cat > "$WORK/out/sha.cjs" <<'SHA'
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
console.log(createHash('sha256').update(readFileSync(process.argv[2])).digest('hex'));
SHA

# THE TOP OF THE MOUNT STACK IN A GIVEN NAMESPACE, AND IT IS NOT THE LAST LINE OR THE HIGHEST MOUNT ID.
#
# THE KERNEL RECYCLES MOUNT IDS. A real Phase 4 run met a live mount at id 3234 stacked on a floor at 3400
# and, sorting by id, acted on the floor. mountinfo names the parent in field 2, so a stack at one mountpoint
# is a CHAIN and its top is the only row there that no other row at that mountpoint names as its parent.
# Prints "<mountid> <fstype>", or "none".
cat > "$WORK/out/top-mount.sh" <<'TOPMOUNT'
set -eu
mountinfo="$1"
target="$2"
awk -v target="$target" '
  {
    sep = 0
    for (i = 7; i <= NF; i++) if ($i == "-") { sep = i; break }
    if (sep == 0) next
    if ($5 != target) next
    id[$1] = $1
    type[$1] = $(sep + 1)
    isparent[$2] = 1
  }
  END {
    for (k in id) if (!(k in isparent)) { print k, type[k]; found = 1 }
    if (!found) print "none"
  }' "$mountinfo"
TOPMOUNT

# HOW MANY OF OUR OWN MOUNTS ARE AT A PATH IN A GIVEN NAMESPACE. MH4 stacks a SECOND projectiond mount above
# the first, and both are `fuse.projectiond` — indistinguishable by type. The count is what says the blocker
# landed and, afterwards, that it is gone.
cat > "$WORK/out/count-mounts.sh" <<'COUNTMOUNTS'
set -eu
mountinfo="$1"
target="$2"
awk -v target="$target" '
  {
    sep = 0
    for (i = 7; i <= NF; i++) if ($i == "-") { sep = i; break }
    if (sep == 0) next
    if ($5 != target) next
    if ($(sep + 1) != "fuse.projectiond") next
    n++
  }
  END { print n + 0 }' "$mountinfo"
COUNTMOUNTS

# THE FAULT FOR MH3: THE KERNEL'S OWN TEARDOWN OF ONE FUSE CONNECTION, GUARDED TO THIS RUN.
#
# It is an abort rather than an unmount because an unmount with a consumer attached detaches namespaces and
# leaves the connection alive — the daemon would observe nothing and the arm would report a fault that never
# happened. The guard is two-fold and both halves are required: only `fuse.projectiond` mounts, and only ones
# at or under THIS run's own mount point. The host serves its array over shfs, which is also FUSE, and
# aborting the wrong connection would take the array offline.
# (No apostrophes in this program: it is a single-quoted argument and one in a comment would end it.)
cat > "$WORK/out/fuse-abort.sh" <<'FUSEABORT'
set -eu
root="${1:-}"
mountinfo="${2:-/proc/self/mountinfo}"
connections="${3:-/sys/fs/fuse/connections}"
test -n "$root" || { echo "abort:no-root"; exit 1; }
test -r "$mountinfo" || { echo "abort:no-mountinfo"; exit 1; }
test -d "$connections" || { echo "abort:no-connections-dir"; exit 1; }
matched="$(awk -v root="$root" '
  {
    sep = 0
    for (i = 7; i <= NF; i++) if ($i == "-") { sep = i; break }
    if (sep == 0) next
    fstype = $(sep + 1)
    mountpoint = $5
    if (fstype != "fuse.projectiond") next
    if (mountpoint != root && index(mountpoint, root "/") != 1) next
    key = mountpoint SUBSEP $1
    dev[key] = $3
    at[key] = mountpoint
    isparent[mountpoint SUBSEP $2] = 1
  }
  END { for (k in dev) if (!(k in isparent)) print at[k], dev[k] }' "$mountinfo" \
  | awk '{ print $2 }' | sort -u)"
if [ -z "$matched" ]; then
  echo "abort:none"
  exit 1
fi
count=0
for majmin in $matched; do
  minor="${majmin#*:}"
  case "$minor" in
    ''|*[!0-9]*) echo "abort:bad-minor"; exit 1 ;;
  esac
  test -w "$connections/$minor/abort" || { echo "abort:not-writable"; exit 1; }
  echo "abort:choice majmin=$majmin minor=$minor"
  echo 1 > "$connections/$minor/abort"
  count=$(( count + 1 ))
done
echo "abort:done $count"
FUSEABORT

field()    { node "$REL/out/jq.cjs" "$1"; }
publish()  { npx tsx src/ops/projection-publish-cli.ts --manifest-dir "$REL/manifest" "$@"; }
register() { npx tsx src/ops/projection-register-cli.ts "$@"; }

CLEANED=0
cleanup() {
  # THE BLOCKER IS UNPAUSED BEFORE IT IS STOPPED, ALWAYS. A frozen container cannot process a signal, so a
  # `docker stop` against one waits out its whole timeout and then kills it — leaving its FUSE mount behind
  # on the host, which is precisely the leak MH12 exists to catch. Unpausing first lets it unmount its own
  # mount the way every other exit here does.
  docker unpause "$BLOCKER_CONTAINER" >/dev/null 2>&1 || true
  docker stop -t 30 "$BLOCKER_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$DAEMON_CONTAINER" "$BLOCKER_CONTAINER" "$VERIFIER_CONTAINER" >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -f "$GATE_ROOT/host-containers-before-$$.txt" "$GATE_ROOT/host-networks-before-$$.txt" \
        "$GATE_ROOT/host-volumes-before-$$.txt" "$GATE_ROOT/host-containers-after-$$.txt" \
        "$GATE_ROOT/host-networks-after-$$.txt" "$GATE_ROOT/host-volumes-after-$$.txt" 2>/dev/null || true
  if [ "$CLEANED" -eq 0 ] && [ -n "${WORK:-}" ]; then
    projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true
    projection_gate_report_cleanliness "$GATE_ROOT" "$WORK" || true
  fi
}
trap cleanup EXIT

# ----------------------------------------------------------------------------------------------------------
# THE TWO STATUS SURFACES, READ FROM A SIBLING THAT SHARES THE DAEMON'S NETWORK NAMESPACE.
#
# The production image is distroless — no shell, no HTTP client — and the status server binds loopback only,
# which is not relaxed for a test. So each request comes from a pinned container joined to the daemon's own
# network namespace, which is exactly how every other gate here reads it.
# ----------------------------------------------------------------------------------------------------------
HTTP_CODE=""
HTTP_BODY=""
HTTP_MS=0

# HOW LONG THE CALL TOOK, IN MILLISECONDS, MEASURED ON THE HOST AROUND THE WHOLE REQUEST.
#
# IT IS AN UPPER BOUND AND IT IS DELIBERATELY UNFAIR TO THE PRODUCT. The elapsed time includes starting a
# container, which is tens to hundreds of milliseconds of Docker and none of it the daemon's. That is the
# right direction to be wrong in: MH11 exists to catch a handler that WAITED for a probe, and a budget that a
# container start already eats most of still separates "answered from a stored sample" from "blocked for two
# seconds on a statfs".
http_call() {
  local path="$1" started ended raw
  started="$(date +%s%3N)"
  set +e
  raw="$(docker run --rm --network "container:$DAEMON_CONTAINER" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
    sh /out/http.sh "$STATUS_ADDR" "$path" 2>/dev/null)"
  set -e
  ended="$(date +%s%3N)"
  HTTP_MS=$(( ended - started ))
  HTTP_CODE="$(printf '%s\n' "$raw" | head -1)"
  HTTP_BODY="$(printf '%s\n' "$raw" | tail -n +2)"
}

# ONE FIELD OUT OF A DOCUMENT. A field that is absent prints nothing rather than a zero, so an assertion about
# a missing field fails on a non-value instead of passing on a default.
body_field() { printf '%s' "$1" | node "$REL/out/jq.cjs" "$2"; }

# EVERY READINESS READING IS ALSO A LIVENESS READING, AND MH10 IS WHY.
#
# Liveness has to be responsive in EVERY arm, including the ones in which readiness is correctly 503. Taking
# the two together at every measurement point means no arm can be quietly exempted from it, and the worst
# case each budget is judged against folds in every reading the run ever took.
READY_CODE=""; READY_BODY=""; READY_REASON=""; READY_OBSERVED=""
LIVE_WORST_MS=0; READY_WORST_MS=0
LIVE_FAILURES=0; LIVE_READINGS=0
sample_surfaces() {
  http_call /readyz
  READY_CODE="$HTTP_CODE"; READY_BODY="$HTTP_BODY"
  [ "$HTTP_MS" -gt "$READY_WORST_MS" ] && READY_WORST_MS="$HTTP_MS"
  READY_REASON="$(body_field "$READY_BODY" readyReason)"
  READY_OBSERVED="$(body_field "$READY_BODY" mountObserved)"

  http_call /healthz
  [ "$HTTP_MS" -gt "$LIVE_WORST_MS" ] && LIVE_WORST_MS="$HTTP_MS"
  LIVE_READINGS=$(( LIVE_READINGS + 1 ))
  # LIVENESS MUST BE 200, MUST SAY ALIVE, AND MUST DISCLAIM THE MOUNT. Any of the three missing is a failed
  # reading, counted here and reported by MH10 rather than aborting the arm that happened to take it.
  if [ "$HTTP_CODE" != "200" ] \
     || [ "$(body_field "$HTTP_BODY" alive)" != "true" ] \
     || [ "$(body_field "$HTTP_BODY" claimsMountUsable)" != "false" ]; then
    LIVE_FAILURES=$(( LIVE_FAILURES + 1 ))
    echo "  liveness reading failed: code=$HTTP_CODE body=$HTTP_BODY" >&2
  fi
  # ...AND IT MUST CARRY NO READINESS OR MOUNT FIELD. This is the assertion that stops the two surfaces
  # converging again the first time somebody finds it convenient.
  for forbidden in ready readyReason mounted mountObserved generationId serveError; do
    if [ -n "$(body_field "$HTTP_BODY" "$forbidden")" ]; then
      LIVE_FAILURES=$(( LIVE_FAILURES + 1 ))
      echo "  the liveness document carries $forbidden, so it is claiming something about the mount" >&2
    fi
  done
}

await_ready() {
  local attempts="${1:-120}" n=0
  while [ "$n" -lt "$attempts" ]; do
    http_call /readyz
    [ "$HTTP_CODE" = "200" ] && return 0
    n=$((n + 1)); sleep 0.5
  done
  return 1
}

# THE CONSUMER READS BYTES AND DIGESTS THEM, and it does so through its OWN bind, as its own uid.
#
# A dead FUSE mount answers `stat` from the kernel's attribute cache for a full attribute timeout after the
# connection is gone, so `test -f` here would pass over the exact state this gate exists to detect.
consumer_sha() {
  docker exec -u 1000:1000 "$VERIFIER_CONTAINER" \
    sh -c "sha256sum '/media/projection/$ENTRY_PATH'" 2>/dev/null | awk '{print $1}'
}

container_health() { docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null || echo unknown; }
serve_deaths()     { docker logs "$DAEMON_CONTAINER" 2>&1 | grep -c 'serve loop died' || true; }

# THE SUBJECT DAEMON'S OWN MOUNT TABLE, READ FROM THE HOST BY PID. The production image is distroless, so
# entering its mount namespace to LOOK is impossible: `nsenter` lands in a filesystem with no binaries.
# `/proc/<pid>/mountinfo` is that namespace's table and the gate is already root here.
DAEMON_PID=""
daemon_top()   { sh "$WORK/out/top-mount.sh" "/proc/$DAEMON_PID/mountinfo" /mnt/projection; }
daemon_mounts(){ sh "$WORK/out/count-mounts.sh" "/proc/$DAEMON_PID/mountinfo" /mnt/projection; }

# ----------------------------------------------------------------------------------------------------------
step "the host's container, network and volume SETS, before anything of this run exists"
# ----------------------------------------------------------------------------------------------------------
# SETS, NOT COUNTS. A run that leaked one container and removed somebody else's would keep the count and
# change the set, and the count would report success.
docker ps -a --format '{{.Names}}' | sort > "$GATE_ROOT/host-containers-before-$$.txt"
docker network ls --format '{{.Name}}' | sort > "$GATE_ROOT/host-networks-before-$$.txt"
docker volume ls --format '{{.Name}}'  | sort > "$GATE_ROOT/host-volumes-before-$$.txt"
echo "  captured"

# ----------------------------------------------------------------------------------------------------------
step "building the production projectiond image"
# ----------------------------------------------------------------------------------------------------------
docker build -t "$IMAGE" ./projectiond

# THE HEALTHCHECK IS PART OF THE IMAGE UNDER TEST, AND ITS PRESENCE IS ASSERTED BEFORE ANYTHING DEPENDS ON IT.
# MH1 and MH7 both read a container health status; an image with no HEALTHCHECK reports `unknown` for ever,
# and an arm that waited for `healthy` would fail with a message about timing rather than about the image.
IMAGE_HEALTHCHECK="$(docker inspect -f '{{if .Config.Healthcheck}}yes{{else}}no{{end}}' "$IMAGE")"
test "$IMAGE_HEALTHCHECK" = "yes" \
  || die "the production image carries no HEALTHCHECK, so nothing below could measure a health transition"
echo "  the production image carries a HEALTHCHECK"

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
# ONE LOCAL ENTRY, AND NO PROVIDER ANYWHERE. The daemon serves it from `localRoots`, so every state this gate
# drives the mount into has exactly one explanation: the mount itself.
SUBJECT_FILE="mount-health-subject.bin"
SUBJECT_SIZE=$((8 * 1024 * 1024))
head -c "$SUBJECT_SIZE" /dev/urandom > "$WORK/media/$SUBJECT_FILE"
SUBJECT_SHA="$(node "$REL/out/sha.cjs" "$REL/media/$SUBJECT_FILE")"
ENTRY_PATH="Movies/Mount Health Subject (2026)/Mount Health Subject (2026).bin"

register root --id media --kind local
register version --key mount-health-subject --size "$SUBJECT_SIZE" --mtime 2026-06-01T10:00:00.000Z
register entry --item "dddddddd-5555-4555-8555-dddddddddddd" --version-key mount-health-subject \
  --path "$ENTRY_PATH" --source "local:media:${SUBJECT_FILE}"
publish > "$WORK/out/publish-1.json"
test "$(field outcome < "$WORK/out/publish-1.json")" = "published" || die "generation 1 was not published"
echo "  generation 1 published; the fixture is $SUBJECT_SIZE bytes, sha256 $SUBJECT_SHA"

# ----------------------------------------------------------------------------------------------------------
step "one unprivileged consumer attaches BEFORE anything is ever mounted there"
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
# `endpoints` IS EMPTY AND THAT IS THE PROVIDER-FREE GUARANTEE. The daemon is not told about any endpoint, so
# there is nothing it could contact even if an arm below were wrong.

# THE BLOCKER'S OWN CONFIGURATION. Same manifest and media, its OWN cache, and NO status surface: it is a
# fault injector and nothing about it is measured, so giving it a status server would only invite an arm to
# read the wrong daemon.
cat > "$WORK/blocker-config.json" <<'JSON'
{
  "mountPoint": "/mnt/projection",
  "pointerPath": "/var/lib/projectiond/manifest/pointer.json",
  "probeCacheDir": "/var/lib/projectiond/cache",
  "localRoots": { "media": "/var/lib/projectiond/media" },
  "endpoints": []
}
JSON

# BEFORE, because that is the shipped consumer-attachment contract (§11 of the Phase 0 product contract): a
# bind taken while the path is a plain directory is a slave of the PARENT's peer group and follows every later
# mount at that path, while a bind taken over an existing mount belongs to that mount's group alone and is
# stranded the moment it goes. MH9 asks whether a consumer survives a recovery, so a late binder would fail it
# for a reason that is about the bind and not about the product.
docker run -d --name "$VERIFIER_CONTAINER" --user 1000:1000 \
  -v "$WORK/mnt:/media/projection:rslave" "$VERIFY_IMAGE" \
  sh -c 'while :; do sleep 3600; done' >/dev/null
echo "  a persistent unprivileged consumer is attached to the mount point BEFORE anything is mounted there"

# ----------------------------------------------------------------------------------------------------------
step "the subject daemon serves, with --auto-remount"
# ----------------------------------------------------------------------------------------------------------
# `--auto-remount` IS ON FOR THE WHOLE RUN AND MH8 IS WHY: the recovery it performs is what readiness has to
# refuse to trust until the mount is observed live again. Running two daemon configurations inside one run
# would mean the arms were not done to the same subject.
docker run -d --name "$DAEMON_CONTAINER" \
  --network "$NETWORK" --user 0:0 \
  --cap-drop ALL --cap-add SYS_ADMIN --security-opt apparmor:unconfined \
  --device /dev/fuse:/dev/fuse \
  -v "$WORK/manifest:/var/lib/projectiond/manifest:ro" \
  -v "$WORK/media:/var/lib/projectiond/media:ro" \
  -v "$WORK/cache:/var/lib/projectiond/cache" \
  -v "$WORK/config.json:/etc/projectiond/config.json:ro" \
  -v "$WORK/mnt:/mnt/projection:rshared" \
  "$IMAGE" --config /etc/projectiond/config.json --poll 2s --strict-direct-mount --auto-remount >/dev/null

await_ready || { docker logs "$DAEMON_CONTAINER" 2>&1 | tail -30 >&2; die "the daemon never became ready"; }
DAEMON_PID="$(docker inspect -f '{{.State.Pid}}' "$DAEMON_CONTAINER")"
test "${DAEMON_PID:-0}" -gt 0 || die "this run's daemon has no pid"
echo "  the daemon is ready (pid $DAEMON_PID)"

# ----------------------------------------------------------------------------------------------------------
step "MH5 (first half) — the bootstrap grace is in force early, and it says so"
# ----------------------------------------------------------------------------------------------------------
# THE GRACE IS THE ONE WINDOW IN WHICH `ready` CAN BE TRUE WITH THE MOUNT NEVER OBSERVED. It is published as
# a field precisely so that a reader never has to infer from uptime whether a green answer rests on evidence
# or on a grace — and so this arm can measure the difference instead of assuming it.
sample_surfaces
MH5_GRACE_EARLY="$(body_field "$READY_BODY" mountBootstrapGrace)"
MH5_GRACE_LEFT="$(body_field "$READY_BODY" mountGraceRemainingMs)"
echo "  early: ready=$READY_CODE reason=$READY_REASON grace=$MH5_GRACE_EARLY remaining=${MH5_GRACE_LEFT}ms"

# ----------------------------------------------------------------------------------------------------------
step "waiting for the grace to expire and the container to report healthy"
# ----------------------------------------------------------------------------------------------------------
# EVERY ARM BELOW IS TAKEN AFTER THE GRACE HAS GONE, and that is deliberate: an arm measured inside it would
# be measuring a window in which readiness is entitled to stand on nothing.
MH_GRACE_WAIT_S=$(( (MH_MOUNT_BOOTSTRAP_GRACE_MS / 1000) + 5 ))
n=0
MH5_GRACE_LATE="unread"
while [ "$n" -lt "$MH_GRACE_WAIT_S" ]; do
  http_call /readyz
  MH5_GRACE_LATE="$(body_field "$HTTP_BODY" mountBootstrapGrace)"
  [ "$MH5_GRACE_LATE" = "false" ] && break
  n=$((n + 1)); sleep 1
done

# THE CONTAINER'S HEALTH IS DOCKER'S OWN READING OF THE SAME ENDPOINT, and it cannot be reported before the
# start period has elapsed, by design — that relation is what stops a container reporting healthy on a probe
# the grace answered.
MH_HEALTH_WAIT=$(( MH_HEALTHCHECK_START_PERIOD_S + (MH_HEALTHCHECK_INTERVAL_S * 6) ))
n=0
MH1_HEALTH="unknown"
while [ "$n" -lt "$MH_HEALTH_WAIT" ]; do
  MH1_HEALTH="$(container_health "$DAEMON_CONTAINER")"
  [ "$MH1_HEALTH" = "healthy" ] && break
  n=$((n + 1)); sleep 1
done
echo "  grace=$MH5_GRACE_LATE, container health=$MH1_HEALTH"

# ----------------------------------------------------------------------------------------------------------
step "MH1 — the control: a live mount, ready for the right reason, healthy container, real bytes"
# ----------------------------------------------------------------------------------------------------------
# WITHOUT THIS ARM EVERY ARM BELOW IS SATISFIED BY A DAEMON THAT ANSWERS NOT-READY UNCONDITIONALLY, which is
# the unfailable-check shape this repository has found five separate times.
sample_surfaces
MH1_CODE="$READY_CODE"; MH1_REASON="$READY_REASON"; MH1_OBSERVED="$READY_OBSERVED"
MH1_MOUNTED="$(body_field "$READY_BODY" mounted)"
MH1_LIVE_RUN="$(body_field "$READY_BODY" mountLiveRunMs)"
CONSUMER_SHA_BEFORE="$(consumer_sha)"

if [ "$MH1_CODE" = "200" ] && [ "$MH1_REASON" = "$MH_REASON_OK" ] \
   && [ "$MH1_OBSERVED" = "$MH_STATE_LIVE" ] && [ "$MH1_MOUNTED" = "true" ] \
   && [ "$MH1_HEALTH" = "healthy" ] \
   && [ -n "$CONSUMER_SHA_BEFORE" ] && [ "$CONSUMER_SHA_BEFORE" = "$SUBJECT_SHA" ]; then
  pass "MH1 a live mount answers 200/$MH1_REASON with observed=$MH1_OBSERVED, the container is $MH1_HEALTH," \
       "and the pre-attached consumer reads the right bytes"
else
  fail "MH1 code=$MH1_CODE reason=$MH1_REASON observed=$MH1_OBSERVED mounted=$MH1_MOUNTED" \
       "health=$MH1_HEALTH consumerDigestMatches=" \
       "$( [ "$CONSUMER_SHA_BEFORE" = "$SUBJECT_SHA" ] && echo yes || echo NO )"
fi

# ----------------------------------------------------------------------------------------------------------
step "MH5 (second half) — the grace is bounded, and readiness in the steady state does not rest on it"
# ----------------------------------------------------------------------------------------------------------
# THE CLAIM IS NOT "THE GRACE EXISTS". It is that the grace CANNOT CARRY A RUN: it is in force early, it is
# gone later, and by the time it is gone readiness is standing on an actual live observation. A grace that
# never expired would make every arm below meaningless, because a broken mount would stay ready.
if [ "$MH5_GRACE_EARLY" = "true" ] && [ "$MH5_GRACE_LATE" = "false" ] \
   && [ "$MH1_OBSERVED" = "$MH_STATE_LIVE" ] && [ "$MH1_REASON" = "$MH_REASON_OK" ] \
   && [ -n "$MH1_LIVE_RUN" ] && [ "$MH1_LIVE_RUN" -ge "$MH_MOUNT_RECOVERY_CONFIRM_MS" ]; then
  pass "MH5 the grace was in force early and gone later, and steady-state readiness rests on a live run of" \
       "${MH1_LIVE_RUN}ms rather than on the grace"
else
  fail "MH5 graceEarly=$MH5_GRACE_EARLY graceLate=$MH5_GRACE_LATE observed=$MH1_OBSERVED" \
       "reason=$MH1_REASON liveRunMs=${MH1_LIVE_RUN:-absent}"
fi

# ----------------------------------------------------------------------------------------------------------
step "MH6 — a TRANSIENT fault is reported and does not flap readiness"
# ----------------------------------------------------------------------------------------------------------
# THE ARM HAS A CONTROL INSIDE IT, AND IT IS THE HALF THAT MATTERS. "Readiness stayed true" is satisfied by a
# fault the daemon never saw, so this also requires that a NON-LIVE OBSERVATION WAS ACTUALLY REPORTED. Without
# that, the arm would pass most reliably when the fault injection was broken.
#
# THE TRANSIENT IS BOUNDED ON BOTH SIDES BY DERIVATION: long enough that at least one probe must land on it,
# short enough that readiness is not ENTITLED to go false. Readings continue past the removal until the
# observation returns live, because the sample that recorded the fault may not land until after it is gone —
# and a window that ended at the removal would be a race the product could lose without being wrong.
MH6_TAG="mh-flap-$$"
case "$DAEMON_CONTAINER" in
  projection-mount-health-daemon-$$) ;;
  *) die "MH6: refusing to touch a namespace that is not this run's own daemon ($DAEMON_CONTAINER)" ;;
esac
MH6_TOP_BEFORE="$(daemon_top | awk '{print $2}')"
test "$MH6_TOP_BEFORE" = "fuse.projectiond" \
  || die "MH6: the top of the stack in the daemon namespace is '$MH6_TOP_BEFORE', not ours; refusing to stack"

mount -t tmpfs -o size=1m,nr_inodes=64 "$MH6_TAG" "$WORK/mnt" \
  || die "MH6: the transient overlay could not be stacked"
MH6_STACKED_AT="$(date +%s%3N)"
MH6_SAW_FAULT=0
MH6_LOST_READY=0
MH6_MIN_CODE=200
MH6_UNMOUNTED=0
n=0
while [ "$n" -lt 60 ]; do
  sample_surfaces
  [ "$READY_CODE" != "200" ] && { MH6_LOST_READY=1; MH6_MIN_CODE="$READY_CODE"; }
  [ "$READY_REASON" != "$MH_REASON_OK" ] && MH6_LOST_READY=1
  case "$READY_OBSERVED" in
    "$MH_STATE_LIVE") ;;
    '') ;;
    *) MH6_SAW_FAULT=1 ;;
  esac
  NOW_MS="$(date +%s%3N)"
  if [ "$MH6_UNMOUNTED" -eq 0 ] && [ "$(( NOW_MS - MH6_STACKED_AT ))" -ge "$MH_ANTI_FLAP_TRANSIENT_MS" ]; then
    # CLEANUP REMOVES ONLY WHAT THIS RUN STACKED. The top must still be a tmpfs; if it is not, the overlay is
    # already gone or something else is there, and unmounting would take the product's own mount instead.
    MH6_TOP_NOW="$(daemon_top | awk '{print $2}')"
    if [ "$MH6_TOP_NOW" = "tmpfs" ]; then
      umount "$WORK/mnt" || die "MH6: the transient overlay could not be removed"
      MH6_UNMOUNTED=1
    else
      fail "MH6 the top of the stack is '$MH6_TOP_NOW', not the tmpfs this run stacked; nothing was unmounted"
      break
    fi
  fi
  # The window closes when the observation is live again, which is the earliest moment at which a later
  # not-ready could no longer be blamed on this fault.
  [ "$MH6_UNMOUNTED" -eq 1 ] && [ "$READY_OBSERVED" = "$MH_STATE_LIVE" ] && break
  n=$((n + 1))
done

if [ "$MH6_SAW_FAULT" -eq 1 ] && [ "$MH6_LOST_READY" -eq 0 ] && [ "$MH6_UNMOUNTED" -eq 1 ]; then
  pass "MH6 a non-live observation was reported during the transient and readiness never left 200/ok"
else
  fail "MH6 sawNonLiveObservation=$MH6_SAW_FAULT lostReady=$MH6_LOST_READY (code $MH6_MIN_CODE)" \
       "overlayRemoved=$MH6_UNMOUNTED"
fi

# ----------------------------------------------------------------------------------------------------------
step "MH2 and MH7 — a SUSTAINED foreign overlay: not ready for the right reason, and an unhealthy container"
# ----------------------------------------------------------------------------------------------------------
# THE FAULT IS AN ADDITION, NOT A REMOVAL, AND THAT IS WHY IT IS THE RIGHT SUBJECT. Every fault that REMOVES
# something takes the FUSE connection with it, which wakes the supervisor, which sets `mounted` false — so the
# reason would be `serve-loop-dead` and this arm would be measuring rule 3 instead of rule 4. Stacking a
# foreign filesystem ABOVE the live mount touches the connection not at all: no supervisor code runs,
# `mounted` stays true, and the divergence is INVISIBLE to everything except the observation.
MH2_TAG="mh-overlay-$$"
MH2_DEATHS_BEFORE="$(serve_deaths)"
MH2_TOP_BEFORE="$(daemon_top | awk '{print $2}')"
test "$MH2_TOP_BEFORE" = "fuse.projectiond" \
  || die "MH2: the top of the stack is '$MH2_TOP_BEFORE', not ours; refusing to stack"

mount -t tmpfs -o size=1m,nr_inodes=64 "$MH2_TAG" "$WORK/mnt" \
  || die "MH2: the overlay could not be stacked"
echo "  a tmpfs named $MH2_TAG is stacked ABOVE the live projection mount at this run's own directory"

# The daemon's own policy is what must make readiness false, and it must do so for the RULE-4 reason.
MH2_CODE=""; MH2_REASON=""; MH2_MOUNTED=""; MH2_SINCE_LIVE=""
MH_FAULT_WAIT=$(( (MH_MOUNT_FAULT_HOLD_MS / 1000) + 15 ))
n=0
while [ "$n" -lt "$MH_FAULT_WAIT" ]; do
  sample_surfaces
  MH2_CODE="$READY_CODE"; MH2_REASON="$READY_REASON"
  MH2_MOUNTED="$(body_field "$READY_BODY" mounted)"
  MH2_SINCE_LIVE="$(body_field "$READY_BODY" mountSinceLiveMs)"
  [ "$MH2_REASON" = "$MH_REASON_MOUNT_OBSERVED_NOT_LIVE" ] && break
  n=$((n + 1)); sleep 1
done
MH2_DEATHS_AFTER="$(serve_deaths)"
MH2_RUNNING="$(docker inspect -f '{{.State.Running}}' "$DAEMON_CONTAINER" 2>/dev/null || echo false)"
echo "  under the overlay: code=$MH2_CODE reason=$MH2_REASON mounted=$MH2_MOUNTED sinceLive=${MH2_SINCE_LIVE}ms"

# MH7: DOCKER'S OWN READING OF THE SAME ENDPOINT. The bound is derived — the daemon's fault hold plus every
# retry plus one whole probe timeout for the last of them — and it is an upper bound, not a target.
MH7_HEALTH="unknown"
MH_UNHEALTHY_WAIT=$(( (MH_HEALTHCHECK_UNHEALTHY_BOUND_MS / 1000) + 15 ))
n=0
while [ "$n" -lt "$MH_UNHEALTHY_WAIT" ]; do
  MH7_HEALTH="$(container_health "$DAEMON_CONTAINER")"
  [ "$MH7_HEALTH" = "unhealthy" ] && break
  n=$((n + 1)); sleep 1
done
echo "  the container's health under the sustained fault: $MH7_HEALTH"

MH2_TOP_NOW="$(daemon_top | awk '{print $2}')"
if [ "$MH2_TOP_NOW" = "tmpfs" ]; then
  umount "$WORK/mnt" || die "MH2: the overlay could not be removed"
  echo "  the overlay was unmounted; only the tmpfs was removed"
else
  fail "MH2 the top of the stack is '$MH2_TOP_NOW', not the tmpfs this run stacked; nothing was unmounted"
fi

# THE REVERSAL IS PART OF BOTH ARMS. A divergence that could not be undone would leave them unable to say
# whether the mount had been broken permanently, and a health transition in one direction is not a transition.
MH2_RESTORED_REASON=""
n=0
while [ "$n" -lt 60 ]; do
  sample_surfaces
  MH2_RESTORED_REASON="$READY_REASON"
  [ "$READY_CODE" = "200" ] && [ "$READY_REASON" = "$MH_REASON_OK" ] \
    && [ "$READY_OBSERVED" = "$MH_STATE_LIVE" ] && break
  n=$((n + 1)); sleep 1
done
MH7_HEALTH_RESTORED="unknown"
n=0
while [ "$n" -lt "$MH_HEALTH_WAIT" ]; do
  MH7_HEALTH_RESTORED="$(container_health "$DAEMON_CONTAINER")"
  [ "$MH7_HEALTH_RESTORED" = "healthy" ] && break
  n=$((n + 1)); sleep 1
done

if [ "$MH2_CODE" = "503" ] && [ "$MH2_REASON" = "$MH_REASON_MOUNT_OBSERVED_NOT_LIVE" ] \
   && [ "$MH2_MOUNTED" = "true" ] && [ "$MH2_DEATHS_AFTER" = "$MH2_DEATHS_BEFORE" ] \
   && [ "$MH2_RUNNING" = "true" ] && [ "$MH2_RESTORED_REASON" = "$MH_REASON_OK" ]; then
  pass "MH2 a sustained foreign overlay answered 503/$MH2_REASON while mounted stayed true and the serve" \
       "loop never noticed, and removing only the overlay restored 200/ok"
else
  fail "MH2 code=$MH2_CODE reason=$MH2_REASON mounted=$MH2_MOUNTED" \
       "serveDeaths=$MH2_DEATHS_BEFORE->$MH2_DEATHS_AFTER running=$MH2_RUNNING restored=$MH2_RESTORED_REASON"
fi

if [ "$MH7_HEALTH" = "unhealthy" ] && [ "$MH7_HEALTH_RESTORED" = "healthy" ]; then
  pass "MH7 the shipped healthcheck took the container healthy -> unhealthy under the sustained fault and" \
       "back to healthy after it, inside the derived bound"
else
  fail "MH7 healthUnderFault=$MH7_HEALTH healthAfterRecovery=$MH7_HEALTH_RESTORED (started from $MH1_HEALTH)"
fi

# ----------------------------------------------------------------------------------------------------------
step "MH4 — a BLOCKED observation: a second projectiond mount, stacked above and frozen"
# ----------------------------------------------------------------------------------------------------------
# THIS IS THE ONE FAULT A REMOVAL CANNOT PRODUCE, AND IT IS THE MOST DANGEROUS ONE IN PRODUCTION. A mount
# whose server has stopped answering hangs every consumer that touches it while the daemon's own belief stays
# perfectly intact. The sampler's probe cannot complete, so the last sample is never replaced and simply AGES
# — which is why rule 5 keys on a live verdict that has stopped advancing rather than on a negative one.
#
# THE BLOCKER IS A FAULT INJECTOR, NOT A SECOND SUBJECT. Freezing a FUSE server is the only way to produce a
# blocking statfs on a real host, and the only FUSE server this repository can freeze without introducing an
# external image is its own. It is stacked, frozen, and removed inside this arm.
MH4_DEATHS_BEFORE="$(serve_deaths)"
MH4_MOUNTS_BEFORE="$(daemon_mounts)"
MH4_TOP_BEFORE="$(daemon_top | awk '{print $1}')"
test "$MH4_MOUNTS_BEFORE" = "1" \
  || die "MH4: the daemon namespace holds $MH4_MOUNTS_BEFORE of our mounts at the mount point, not one"

docker run -d --name "$BLOCKER_CONTAINER" \
  --network "$NETWORK" --user 0:0 \
  --cap-drop ALL --cap-add SYS_ADMIN --security-opt apparmor:unconfined \
  --device /dev/fuse:/dev/fuse \
  -v "$WORK/manifest:/var/lib/projectiond/manifest:ro" \
  -v "$WORK/media:/var/lib/projectiond/media:ro" \
  -v "$WORK/blocker-cache:/var/lib/projectiond/cache" \
  -v "$WORK/blocker-config.json:/etc/projectiond/config.json:ro" \
  -v "$WORK/mnt:/mnt/projection:rshared" \
  "$IMAGE" --config /etc/projectiond/config.json --poll 60s >/dev/null

# THE BLOCKER MUST HAVE LANDED ON TOP BEFORE IT IS FROZEN. Two guards, and both are required: the count of
# our own mounts at the path goes to two, and the top of the chain is a DIFFERENT mount id from the subject's.
# Freezing without them would freeze nothing and the arm would measure a mount that was never blocked.
MH4_LANDED=0
n=0
while [ "$n" -lt 60 ]; do
  if [ "$(daemon_mounts)" = "2" ] && [ "$(daemon_top | awk '{print $1}')" != "$MH4_TOP_BEFORE" ]; then
    MH4_LANDED=1; break
  fi
  n=$((n + 1)); sleep 0.5
done
test "$MH4_LANDED" -eq 1 || die "MH4: the blocking mount never landed above this run's own mount"
echo "  a second projectiond mount is stacked above; freezing its server"

docker pause "$BLOCKER_CONTAINER" >/dev/null || die "MH4: the blocking server could not be frozen"

# THE SAMPLE MUST AGE PAST THE CEILING AND THE FAULT MUST OUTLAST THE HOLD. Both are the daemon's own bounds;
# the wait here is generous around them and the arm asserts the reason, not the timing.
MH4_CODE=""; MH4_REASON=""; MH4_MOUNTED=""; MH4_AGE=""; MH4_GRACE=""
MH_BLOCK_WAIT=$(( ((MH_MOUNT_FAULT_HOLD_MS + MH_SAMPLE_MAX_AGE_MS) / 1000) + 20 ))
n=0
while [ "$n" -lt "$MH_BLOCK_WAIT" ]; do
  sample_surfaces
  MH4_CODE="$READY_CODE"; MH4_REASON="$READY_REASON"
  MH4_MOUNTED="$(body_field "$READY_BODY" mounted)"
  MH4_AGE="$(body_field "$READY_BODY" mountObservedAgeMs)"
  MH4_GRACE="$(body_field "$READY_BODY" mountBootstrapGrace)"
  [ "$MH4_REASON" = "$MH_REASON_MOUNT_OBSERVATION_STALE" ] && break
  n=$((n + 1)); sleep 1
done
MH4_DEATHS_AFTER="$(serve_deaths)"
echo "  under the frozen mount: code=$MH4_CODE reason=$MH4_REASON observed=$READY_OBSERVED age=${MH4_AGE}ms"

# RELEASED AND REMOVED, IN THAT ORDER. A frozen container cannot process a signal, so stopping it while
# paused would wait out the whole timeout, kill it, and leave its mount on the host.
docker unpause "$BLOCKER_CONTAINER" >/dev/null 2>&1 || true
docker stop -t 30 "$BLOCKER_CONTAINER" >/dev/null 2>&1 || true
docker rm -f "$BLOCKER_CONTAINER" >/dev/null 2>&1 || true

MH4_MOUNTS_AFTER=""
n=0
while [ "$n" -lt 60 ]; do
  MH4_MOUNTS_AFTER="$(daemon_mounts)"
  [ "$MH4_MOUNTS_AFTER" = "1" ] && break
  n=$((n + 1)); sleep 1
done
MH4_RESTORED=""
n=0
while [ "$n" -lt 60 ]; do
  sample_surfaces
  MH4_RESTORED="$READY_REASON"
  [ "$READY_CODE" = "200" ] && [ "$READY_REASON" = "$MH_REASON_OK" ] && break
  n=$((n + 1)); sleep 1
done

# THE THREE HALVES TOGETHER. `mount-observation-stale` alone could be a daemon that always says so;
# `mounted=true` with ZERO serve deaths is what proves the belief was untouched and no supervisor code ran,
# which is the whole class of failure this rule exists for.
if [ "$MH4_CODE" = "503" ] && [ "$MH4_REASON" = "$MH_REASON_MOUNT_OBSERVATION_STALE" ] \
   && [ "$MH4_MOUNTED" = "true" ] && [ "$MH4_DEATHS_AFTER" = "$MH4_DEATHS_BEFORE" ] \
   && [ "$MH4_GRACE" = "false" ] \
   && [ "$MH4_MOUNTS_AFTER" = "1" ] && [ "$MH4_RESTORED" = "$MH_REASON_OK" ]; then
  pass "MH4 a blocked probe aged the observation to ${MH4_AGE}ms and answered 503/$MH4_REASON while mounted" \
       "stayed true with zero serve deaths, and releasing the block restored 200/ok"
else
  fail "MH4 code=$MH4_CODE reason=$MH4_REASON mounted=$MH4_MOUNTED age=${MH4_AGE:-absent}" \
       "grace=$MH4_GRACE serveDeaths=$MH4_DEATHS_BEFORE->$MH4_DEATHS_AFTER" \
       "mountsAfter=${MH4_MOUNTS_AFTER:-absent} restored=$MH4_RESTORED"
fi

# ----------------------------------------------------------------------------------------------------------
step "MH3 — a dead connection: the supervisor's knowledge outranks the observation"
# ----------------------------------------------------------------------------------------------------------
# THE PRECEDENCE IS THE MEASUREMENT. Aborting the connection produces BOTH a serve-loop death and, one sample
# later, a non-live observation. Rule 3 must win: the supervisor watched the loop exit, which is direct
# evidence, while the observation is a late sample of the same event. A gate that accepted either reason here
# would let the precedence invert without noticing, and an operator would be handed the symptom.
MH3_MOUNTS="$(daemon_mounts)"
test "$MH3_MOUNTS" = "1" \
  || die "MH3: the daemon namespace holds $MH3_MOUNTS of our mounts, not one; refusing to abort"
set +e
ABORT_OUTPUT="$(bash "$WORK/out/fuse-abort.sh" "$WORK/mnt" 2>&1)"
set -e
echo "$ABORT_OUTPUT" | sed 's/^/  /'
case "$(echo "$ABORT_OUTPUT" | tail -1)" in
  abort:done*) echo "  the connection was torn down under a living daemon" ;;
  *) die "the fault could not be injected ($(echo "$ABORT_OUTPUT" | tail -1)), so nothing below is about it" ;;
esac

# THE POLL HAS NO SLEEP IN IT, AND THE WINDOW IT IS LOOKING FOR IS NOT A RACE.
#
# The supervisor sleeps a whole second before its FIRST remount attempt, so the window in which a death is
# recorded is bounded BELOW by that backoff — and readiness stays false past it, because a recorded death ends
# the live run and the next live sample has to be confirmed. Sampling as fast as a container start allows puts
# several readings inside a window that cannot be shorter than a second.
MH3_CODE=""; MH3_REASON=""; MH3_SEEN_DEAD=0
n=0
while [ "$n" -lt 120 ]; do
  sample_surfaces
  MH3_CODE="$READY_CODE"; MH3_REASON="$READY_REASON"
  [ "$MH3_REASON" = "$MH_REASON_SERVE_LOOP_DEAD" ] && { MH3_SEEN_DEAD=1; break; }
  # ...and stop if the daemon has already come all the way back: continuing would only record `ok` readings
  # and report the miss as though the fault had never been injected.
  [ "$MH3_CODE" = "200" ] && [ "$MH3_REASON" = "$MH_REASON_OK" ] && [ "$n" -gt 8 ] && break
  n=$((n + 1))
done

if [ "$MH3_SEEN_DEAD" -eq 1 ] && [ "$MH3_CODE" = "503" ]; then
  pass "MH3 a dead connection answered 503/$MH3_REASON — the supervisor's knowledge outranked both the" \
       "lagging observation and the `mounted` boolean it had already cleared"
else
  docker logs "$DAEMON_CONTAINER" 2>&1 | grep -E 'serve loop died|remount' | tail -5 >&2 || true
  fail "MH3 code=$MH3_CODE reason=$MH3_REASON (the predeclared reason is $MH_REASON_SERVE_LOOP_DEAD)"
fi

# ----------------------------------------------------------------------------------------------------------
step "MH8 and MH9 — recovery requires the predeclared healthy condition, and the consumer follows it"
# ----------------------------------------------------------------------------------------------------------
# THE FIRST READY READING IS THE MEASUREMENT, NOT THE LAST. `--auto-remount` sets `mounted` true and clears
# the serve death well before the mount is observed; if readiness returned on those two facts alone, this arm
# would catch it, because the FIRST reading in which `ready` is true would carry no live observation and no
# confirmed run. That is exactly Phase 2's worst defect — a namespace recovered for the daemon and for nobody
# else — and it is what this arm exists to make impossible to reintroduce.
# AN OUTAGE MUST HAVE BEEN OBSERVED, OR THERE IS NO RECOVERY TO MEASURE.
#
# THIS HALF WAS ADDED AFTER THE ARM PASSED VACUOUSLY. On the first real run MH8 reported "a confirmed live run
# of 72,305 ms" — a run that had begun seventy-two seconds BEFORE the abort it claimed to be a recovery from.
# The whole death and remount had passed between two samples, readiness never dropped, and the arm scored the
# absence of an outage as a successful recovery from one. A recorded death now ends the live run, so this can
# no longer happen — and the arm refuses to conclude anything without having seen the 503 either way.
MH8_SAW_OUTAGE="$MH3_SEEN_DEAD"
MH8_FIRST_OBSERVED=""; MH8_FIRST_RUN=""; MH8_FIRST_GRACE=""; MH8_READY=0
n=0
while [ "$n" -lt 240 ]; do
  sample_surfaces
  [ "$READY_CODE" != "200" ] && MH8_SAW_OUTAGE=1
  if [ "$READY_CODE" = "200" ]; then
    MH8_FIRST_OBSERVED="$READY_OBSERVED"
    MH8_FIRST_RUN="$(body_field "$READY_BODY" mountLiveRunMs)"
    MH8_FIRST_GRACE="$(body_field "$READY_BODY" mountBootstrapGrace)"
    MH8_READY=1
    break
  fi
  n=$((n + 1))
done

MH8_OK=0
if [ "$MH8_READY" -eq 1 ] && [ "$MH8_SAW_OUTAGE" -eq 1 ] \
   && [ "$MH8_FIRST_OBSERVED" = "$MH_STATE_LIVE" ] \
   && [ -n "$MH8_FIRST_RUN" ] && [ "$MH8_FIRST_RUN" -ge "$MH_MOUNT_RECOVERY_CONFIRM_MS" ] \
   && [ "$MH8_FIRST_GRACE" = "false" ]; then
  MH8_OK=1
fi
if [ "$MH8_OK" -eq 1 ]; then
  pass "MH8 readiness was observed to DROP and the first ready reading after the recovery carried" \
       "observed=$MH8_FIRST_OBSERVED and a confirmed live run of ${MH8_FIRST_RUN}ms, with the bootstrap" \
       "grace forfeited by the death"
else
  fail "MH8 sawOutage=$MH8_SAW_OUTAGE becameReady=$MH8_READY observed=$MH8_FIRST_OBSERVED" \
       "liveRunMs=${MH8_FIRST_RUN:-absent} grace=$MH8_FIRST_GRACE" \
       "(the confirmation is ${MH_MOUNT_RECOVERY_CONFIRM_MS}ms)"
fi

CONSUMER_SHA_AFTER=""
n=0
while [ "$n" -lt 120 ]; do
  CONSUMER_SHA_AFTER="$(consumer_sha)"
  [ -n "$CONSUMER_SHA_AFTER" ] && break
  n=$((n + 1)); sleep 0.5
done
if [ "$CONSUMER_SHA_AFTER" = "$SUBJECT_SHA" ] && [ "$CONSUMER_SHA_AFTER" = "$CONSUMER_SHA_BEFORE" ]; then
  pass "MH9 the SAME pre-attached unprivileged consumer read the SAME digest after the recovery"
else
  fail "MH9 the pre-attached consumer digest after recovery is '${CONSUMER_SHA_AFTER:-absent}', not the" \
       "'$SUBJECT_SHA' it read before"
fi

# ----------------------------------------------------------------------------------------------------------
step "MH10 and MH11 — liveness stayed responsive throughout, and both budgets held"
# ----------------------------------------------------------------------------------------------------------
# MH10 IS A COUNT OVER EVERY READING THE RUN EVER TOOK, not a sample at the end. Liveness that was responsive
# only when readiness was would be readiness under a second name, and the arms above deliberately spend most
# of their time with readiness at 503.
if [ "$LIVE_FAILURES" -eq 0 ] && [ "$LIVE_READINGS" -gt 0 ]; then
  pass "MH10 all $LIVE_READINGS liveness readings answered 200/alive with claimsMountUsable=false and no" \
       "readiness or mount field, including every arm in which readiness answered 503"
else
  fail "MH10 $LIVE_FAILURES of $LIVE_READINGS liveness readings failed"
fi

# MH11: IF EITHER ENDPOINT HAD WAITED FOR A PROBE IT COULD NOT PASS THIS. Both budgets are strictly under the
# probe timeout by contract, and the readings taken over a dead connection and under a FROZEN mount are the
# ones that matter: an inline statfs would block on either for as long as the fault lasted.
MH11_OK=1
[ "$READY_WORST_MS" -gt "$MH_READYZ_LATENCY_BUDGET_MS" ] && MH11_OK=0
[ "$LIVE_WORST_MS" -gt "$MH_LIVEZ_LATENCY_BUDGET_MS" ] && MH11_OK=0
if [ "$MH11_OK" -eq 1 ]; then
  pass "MH11 the slowest /readyz was ${READY_WORST_MS}ms against ${MH_READYZ_LATENCY_BUDGET_MS}ms and the" \
       "slowest /healthz was ${LIVE_WORST_MS}ms against ${MH_LIVEZ_LATENCY_BUDGET_MS}ms"
else
  fail "MH11 slowest /readyz ${READY_WORST_MS}ms against ${MH_READYZ_LATENCY_BUDGET_MS}ms, slowest" \
       "/healthz ${LIVE_WORST_MS}ms against ${MH_LIVEZ_LATENCY_BUDGET_MS}ms"
fi

# ----------------------------------------------------------------------------------------------------------
step "CLEANUP — a success condition of this run, not a report about it"
# ----------------------------------------------------------------------------------------------------------
docker rm -f "$VERIFIER_CONTAINER" >/dev/null 2>&1 || true
docker unpause "$BLOCKER_CONTAINER" >/dev/null 2>&1 || true
docker stop -t 30 "$BLOCKER_CONTAINER" >/dev/null 2>&1 || true
docker rm -f "$BLOCKER_CONTAINER" >/dev/null 2>&1 || true
docker stop -t 30 "$DAEMON_CONTAINER" >/dev/null 2>&1 || true
docker rm -f "$DAEMON_CONTAINER" >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
docker network rm "$NETWORK" >/dev/null 2>&1 || true

projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true
LEFT_MOUNTS="$(projection_gate_mounts_under "$WORK")"
CLEANED=1

# ----------------------------------------------------------------------------------------------------------
step "MH12 — the host is as it was found, asserted rather than reported"
# ----------------------------------------------------------------------------------------------------------
docker ps -a --format '{{.Names}}' | sort > "$GATE_ROOT/host-containers-after-$$.txt"
docker network ls --format '{{.Name}}' | sort > "$GATE_ROOT/host-networks-after-$$.txt"
docker volume ls --format '{{.Name}}'  | sort > "$GATE_ROOT/host-volumes-after-$$.txt"

MH12_OK=1
for what in containers networks volumes; do
  if ! diff -q "$GATE_ROOT/host-${what}-before-$$.txt" "$GATE_ROOT/host-${what}-after-$$.txt" >/dev/null; then
    MH12_OK=0
    echo "  the $what on this host changed across the run:" >&2
    diff "$GATE_ROOT/host-${what}-before-$$.txt" "$GATE_ROOT/host-${what}-after-$$.txt" >&2 || true
  fi
done
if [ "${LEFT_MOUNTS:-1}" != "0" ]; then
  MH12_OK=0
  echo "  ${LEFT_MOUNTS} mountpoint(s) left under this run's own directory" >&2
fi
if [ -d "$WORK" ]; then
  MH12_OK=0
  echo "  this run's own directory still exists" >&2
fi
if [ "$MH12_OK" -eq 1 ]; then
  pass "MH12 the container, network and volume SETS are identical, and this run's mountpoints, overlays," \
       "blocker and directory are gone"
else
  fail "MH12 the host is not as it was found"
fi

# ----------------------------------------------------------------------------------------------------------
echo
if [ "$FAILED" -ne 0 ]; then
  echo "OPERATIONAL MOUNT HEALTH GATE FAILED: $PASSED passed, $FAILED failed." >&2
  exit 1
fi
echo "OPERATIONAL MOUNT HEALTH GATE PASSED: $PASSED of $PASSED arms. Exactly what was proved:"
echo "  - a live mount answers 200/ok with the observation live, a healthy container, and a pre-attached"
echo "    unprivileged consumer digest-matching a value recorded outside the mount;"
echo "  - a sustained foreign overlay makes readiness 503 with mount-observed-not-live while the daemon still"
echo "    BELIEVES it is mounted and the serve loop never notices;"
echo "  - a dead connection is reported as serve-loop-dead, so the supervisor's knowledge outranks the"
echo "    lagging observation rather than the other way round;"
echo "  - a BLOCKED probe ages the observation and is reported as mount-observation-stale, with zero serve"
echo "    deaths - the failure a removal cannot produce and the one that hangs every consumer;"
echo "  - the bootstrap grace is in force early, gone later, and never carries the run;"
echo "  - a transient fault is REPORTED and does not flap readiness, which is why the policy is not a bare"
echo "    comparison against the latest sample;"
echo "  - the shipped healthcheck took the container healthy -> unhealthy -> healthy across the fault;"
echo "  - readiness returned only with a live observation and a confirmed run, never on a cleared death,"
echo "    and the SAME consumer read the SAME digest afterwards;"
echo "  - liveness answered 200 in every reading, including every arm in which readiness answered 503;"
echo "  - both endpoints answered inside budgets strictly under the probe timeout, so neither waited;"
echo "  - the host's container, network and volume SETS are identical, asserted rather than reported."
echo
echo "WHAT THIS GATE DOES NOT PROVE:"
echo "  - It closes only itself. It re-closes none of G7-G13, G18 or G22 and does not reopen Phase 3."
echo "  - It REPORTS; it does not act. No restart policy changed, and Docker's restart policies do not react"
echo "    to health status at all."
echo "  - A policy is not a recovery: the daemon survives exactly what it survived before this tranche."
echo "  - No provider was contacted and none could be; both daemons were configured with no endpoint at all."
echo "  - It is not a load test. The latency figures are upper bounds including a container start."
