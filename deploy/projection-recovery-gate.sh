#!/usr/bin/env bash
# Projection Phase 6 — THE BOUNDED RECOVERY GATE. Does the daemon repair the mount faults it is entitled to
# repair, refuse the ones it is not, and stop rather than loop?
#
# WHAT IT IS FOR. Phase 5 closed saying "it reports; it does not act", and named wiring health to an action as
# the decision somebody would have to take. Phase 6 takes it. This gate is what says the taking was safe.
#
# MOST OF THESE ARMS ASSERT THAT NOTHING HAPPENED, AND THAT IS THE POINT. A recovery supervisor is judged by
# what it declines to do: a remount loop with no floor is strictly WORSE than a mount that stays broken and
# says so, because the broken mount is visible and the loop looks like activity. So RC2, RC3, RC5, RC6, RC9
# and RC10 all measure inaction, and only RC4 and RC8 measure an action at all.
#
# WHAT IT DOES NOT TOUCH. No provider, no endpoint, no credential, no operator corpus, no media server. Every
# daemon here is configured with `"endpoints": []`, so there is nothing any of them could contact.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

GATE_ROOT="$PWD/.projection-recovery-gate"
REL_GATE_ROOT=".projection-recovery-gate"
REL=".projection-recovery-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"

PG_PORT="${PROJECTION_RECOVERY_GATE_PG_PORT:-5611}"
COMPOSE_FILE="docker-compose.projection-recovery.yml"
COMPOSE_PROJECT="projection-recovery-gate"
NETWORK="$COMPOSE_PROJECT"

DAEMON_CONTAINER="projection-recovery-daemon-$$"
BLOCKER_CONTAINER="projection-recovery-blocker-$$"
VERIFIER_CONTAINER="projection-recovery-verifier-$$"
STATUS_ADDR="127.0.0.1:9000"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_RECOVERY_GATE_PG_PORT="$PG_PORT"

# THE THRESHOLDS AND EVERY CLOSED-SET CODE ARE READ FROM THE MODULE, NEVER SPELLED HERE.
# `test/projection-bounded-recovery.ts` asserts this file contains no literal spelling of any of them, so a
# number or a code cannot drift between the contract and the gate that measures against it. An arm comparing
# against a mistyped literal is an arm that can never fail.
RC_BUDGETS="$(npx tsx src/ops/projection-recovery-cli.ts budgets --sh)" \
  || { echo "the recovery thresholds could not be read; nothing can be measured against them" >&2; exit 1; }
eval "$RC_BUDGETS"

# shellcheck source=projection-gate-cleanup.sh
. "$HERE/projection-gate-cleanup.sh"

GATE_SKIP_STATUS="${GATE_SKIP_STATUS:-77}"
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no /dev/fuse is reachable from a container on this host." >&2
  exit "$GATE_SKIP_STATUS"
fi
echo "  /dev/fuse is reachable from a container"

# RC8 AND RC9 NEED A MOUNT SYSCALL THAT FAILS, AND `nsenter` IS THE ONLY WAY TO PRODUCE ONE HERE.
#
# Making a remount FAIL deterministically means making `Mount()` fail, and nothing a gate can stack on a mount
# point does that — every overlay is something the supervisor either clears or refuses. So the injector binds
# `/dev/null` over `/dev/fuse` INSIDE THE SUBJECT CONTAINER'S OWN MOUNT NAMESPACE, which is confined to a
# namespace that dies with the container and is removed inside the arm.
#
# A HOST WITHOUT `nsenter` MAKES THOSE TWO ARMS SKIP, AND A SKIP IS A FAILURE HERE. This gate has no optional
# arms: an unproven bound is not a proven one.
#
# ...AND `nsenter -m` ALONE IS NOT ENOUGH, WHICH THE SECOND REAL TOWER RUN IS WHAT TAUGHT US. Entering the
# target's mount namespace means the command is resolved in the TARGET's filesystem, and the runtime stage of
# this image is distroless: no shell, no `mount`, nothing but the daemon. `nsenter` reported `failed to
# execute mount: No such file or directory`, which is a true statement about a container with no userland.
#
# So a STATIC busybox is copied in first, from a digest-pinned image, and the injector runs THAT. It lives
# inside a container this run created and removes, it is never executed on the host, and the mask it makes is
# confined to that container's own mount namespace — verified restored inside the arm and, in any case, gone
# with the container.
RC_BUSYBOX_IMAGE="busybox@sha256:0872fb3a7632ba9d0ae46a8e832a62b30ce83a6f220b8bb52903d9cf477dabe3"
RC_HAS_NSENTER=0
command -v nsenter >/dev/null 2>&1 && RC_HAS_NSENTER=1

mkdir -p "$WORK/manifest" "$WORK/media" "$WORK/cache" "$WORK/blocker-cache" "$WORK/mnt" "$WORK/out"
chmod 755 "$GATE_ROOT" "$WORK"
chmod 777 "$WORK/cache" "$WORK/blocker-cache" "$WORK/mnt" "$WORK/out"

PASSED=0
FAILED=0
SKIPPED=0

step() { echo; echo "=== $* ==="; }
die()  { echo "GATE FAILED: $*" >&2; exit 1; }

pass() { PASSED=$(( PASSED + 1 )); echo "  PASS  $*"; }
fail() { FAILED=$(( FAILED + 1 )); echo "  FAIL  $*" >&2; }
skip() { SKIPPED=$(( SKIPPED + 1 )); echo "  SKIP  $*" >&2; }

# EVERY EMBEDDED SCRIPT IS A FILE IN A QUOTED HEREDOC, never an inline multi-line `node -e`.
# `test/custody-runtime-closure.ts` parses every shipped script and refuses a line whose quotes do not close.
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

# THE FAULT INJECTOR: THE KERNEL'S OWN TEARDOWN OF ONE FUSE CONNECTION, GUARDED TO THIS RUN.
#
# The guard is two-fold and both halves are required: only `fuse.projectiond` mounts, and only ones at or
# under THIS run's own mount point. The host serves its array over shfs, which is also FUSE, and aborting the
# wrong connection would take the array offline.
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

HTTP_CODE=""
HTTP_BODY=""

http_call() {
  local path="$1" raw
  set +e
  raw="$(docker run --rm --network "container:$DAEMON_CONTAINER" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
    sh /out/http.sh "$STATUS_ADDR" "$path" 2>/dev/null)"
  set -e
  HTTP_CODE="$(printf '%s\n' "$raw" | head -1)"
  HTTP_BODY="$(printf '%s\n' "$raw" | tail -n +2)"
}

body_field() { printf '%s' "$1" | node "$REL/out/jq.cjs" "$2"; }

# EVERY READING TAKES THE WHOLE RECOVERY SURFACE AT ONCE, out of ONE document.
#
# A reading assembled from two requests would describe two instants, and every assertion below is about the
# relationship between fields: a generation that did not advance WHILE a refusal was published, a state of
# `locked-out` WITH the attempts that produced it. Splitting them would make each arm a race.
READY_CODE=""; READY_BODY=""; READY_REASON=""; READY_OBSERVED=""
REC_STATE=""; REC_REASON=""; REC_ATTEMPTS=""; REC_GENERATION=""; REC_OUTCOME=""; REC_REMEDIATION=""
# The closed-set discipline, enforced on the product rather than assumed of it: any published code outside
# the contract's own sets is counted here and reported by RC13's companion assertion.
CLOSED_SET_VIOLATIONS=0

in_set() {
  local needle="$1" haystack="$2" item
  for item in $haystack; do
    [ "$item" = "$needle" ] && return 0
  done
  return 1
}

sample() {
  http_call /readyz
  READY_CODE="$HTTP_CODE"; READY_BODY="$HTTP_BODY"
  READY_REASON="$(body_field "$READY_BODY" readyReason)"
  READY_OBSERVED="$(body_field "$READY_BODY" mountObserved)"
  REC_STATE="$(body_field "$READY_BODY" recoveryState)"
  REC_REASON="$(body_field "$READY_BODY" recoveryReason)"
  REC_ATTEMPTS="$(body_field "$READY_BODY" recoveryAttempts)"
  REC_GENERATION="$(body_field "$READY_BODY" recoveryGeneration)"
  REC_OUTCOME="$(body_field "$READY_BODY" recoveryLastOutcome)"
  REC_REMEDIATION="$(body_field "$READY_BODY" recoveryRemediation)"
  # AN ABSENT FIELD IS A VIOLATION TOO. Every one of these is published unconditionally by contract, so an
  # empty string here means the daemon under test is not the one this gate is written for.
  if [ -n "$REC_STATE" ]; then
    in_set "$REC_STATE" "$RC_STATES" || {
      CLOSED_SET_VIOLATIONS=$(( CLOSED_SET_VIOLATIONS + 1 ))
      echo "  recoveryState '$REC_STATE' is outside the contract's closed set" >&2
    }
    in_set "$REC_REASON" "$RC_DECISION_CODES" || {
      CLOSED_SET_VIOLATIONS=$(( CLOSED_SET_VIOLATIONS + 1 ))
      echo "  recoveryReason '$REC_REASON' is outside the contract's closed set" >&2
    }
    in_set "$REC_REMEDIATION" "$RC_REMEDIATIONS" || {
      CLOSED_SET_VIOLATIONS=$(( CLOSED_SET_VIOLATIONS + 1 ))
      echo "  recoveryRemediation '$REC_REMEDIATION' is outside the contract's closed set" >&2
    }
  elif [ "$READY_CODE" = "200" ] || [ "$READY_CODE" = "503" ]; then
    CLOSED_SET_VIOLATIONS=$(( CLOSED_SET_VIOLATIONS + 1 ))
    echo "  the readiness document carries no recoveryState at all" >&2
  fi
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

# THE CONSUMER READS BYTES AND DIGESTS THEM, through its OWN bind, as its own uid. A dead FUSE mount answers
# `stat` from a warm attribute cache while every `open` returns ENOTCONN, so `test -f` would pass over the
# exact state this gate exists to detect.
consumer_sha() {
  docker exec -u 1000:1000 "$VERIFIER_CONTAINER" \
    sh -c "sha256sum '/media/projection/$ENTRY_PATH'" 2>/dev/null | awk '{print $1}'
}

serve_deaths() { docker logs "$DAEMON_CONTAINER" 2>&1 | grep -c 'serve loop died' || true; }

# HOW MANY REMOUNTS THE SERVE SUPERVISOR HAS STARTED, AND THE ANCHOR IS WHAT MAKES IT A COUNT OF REMOUNTS.
#
# `remount attempt 1/3` occurs on THREE lines of one attempt — the announcement, the `: calling mount` bracket
# and the `: mounted` or `: returned` result — so an unanchored count reported one remount as three. Measured
# on the real host, where RC10 read `serveSupervisorRemounts=3` for a single serve-loop death. Anchoring to
# end-of-line counts the announcement and nothing else.
remount_starts() { docker logs "$DAEMON_CONTAINER" 2>&1 | grep -cE 'remount attempt 1/3$' || true; }

# WHAT THE RECOVERY LOOP HAS ACTUALLY DONE, READ FROM THE DAEMON'S OWN LOG RATHER THAN CAUGHT ON THE SURFACE.
#
# THE STATUS SURFACE PUBLISHES AN ACTION ONLY WHILE IT IS IN FLIGHT, which is about a second, and every
# reading here costs a container start. So an arm that required CATCHING `recover-stale-mount` on `/readyz`
# was a race the product could win and the gate could still lose — measured, on the second real Tower run,
# where the generation advanced 0 -> 1 and the arm reported `sawAction=0`. The log line is emitted by the
# supervisor at the moment it acts and is durable, so the fact is read where it cannot be missed.
recovery_actions() { docker logs "$DAEMON_CONTAINER" 2>&1 | grep -cE 'projectiond: recovery: recover-' || true; }
recovery_last_action() {
  docker logs "$DAEMON_CONTAINER" 2>&1 | grep -oE 'projectiond: recovery: recover-[a-z-]+' | tail -1 \
    | sed 's/^projectiond: recovery: //'
}

DAEMON_PID=""
daemon_top()   { sh "$WORK/out/top-mount.sh" "/proc/$DAEMON_PID/mountinfo" /mnt/projection; }
daemon_mounts(){ sh "$WORK/out/count-mounts.sh" "/proc/$DAEMON_PID/mountinfo" /mnt/projection; }

# WAIT FOR A RECOVERY VERDICT, BOUNDED, WITHOUT ASSERTING WHAT IT WILL BE. Several arms need the daemon to
# have had a full opportunity to act before they can honestly say it did not.
wait_seconds() {
  local want="$1" n=0
  while [ "$n" -lt "$want" ]; do
    sample
    n=$((n + 1)); sleep 1
  done
}

# ----------------------------------------------------------------------------------------------------------
step "the host's container, network and volume SETS, before anything of this run exists"
# ----------------------------------------------------------------------------------------------------------
docker ps -a --format '{{.Names}}' | sort > "$GATE_ROOT/host-containers-before-$$.txt"
docker network ls --format '{{.Name}}' | sort > "$GATE_ROOT/host-networks-before-$$.txt"
docker volume ls --format '{{.Name}}'  | sort > "$GATE_ROOT/host-volumes-before-$$.txt"
echo "  captured"

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
SUBJECT_FILE="recovery-subject.bin"
SUBJECT_SIZE=$((8 * 1024 * 1024))
head -c "$SUBJECT_SIZE" /dev/urandom > "$WORK/media/$SUBJECT_FILE"
SUBJECT_SHA="$(node "$REL/out/sha.cjs" "$REL/media/$SUBJECT_FILE")"
ENTRY_PATH="Movies/Recovery Subject (2026)/Recovery Subject (2026).bin"

register root --id media --kind local
register version --key recovery-subject --size "$SUBJECT_SIZE" --mtime 2026-06-01T10:00:00.000Z
register entry --item "eeeeeeee-6666-4666-8666-eeeeeeeeeeee" --version-key recovery-subject \
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

cat > "$WORK/blocker-config.json" <<'JSON'
{
  "mountPoint": "/mnt/projection",
  "pointerPath": "/var/lib/projectiond/manifest/pointer.json",
  "probeCacheDir": "/var/lib/projectiond/cache",
  "localRoots": { "media": "/var/lib/projectiond/media" },
  "endpoints": []
}
JSON

docker run -d --name "$VERIFIER_CONTAINER" --user 1000:1000 \
  -v "$WORK/mnt:/media/projection:rslave" "$VERIFY_IMAGE" \
  sh -c 'while :; do sleep 3600; done' >/dev/null
echo "  a persistent unprivileged consumer is attached to the mount point BEFORE anything is mounted there"

# ----------------------------------------------------------------------------------------------------------
step "the subject daemon serves, with --auto-remount AND --auto-recover"
# ----------------------------------------------------------------------------------------------------------
# BOTH SUPERVISORS ARE ON FOR THE WHOLE RUN, AND RC6 AND RC10 ARE WHY. The interesting question is not whether
# either works alone; it is whether the two of them, watching the same mount point, ever act at once. A run
# that turned one off for some arms would be unable to ask it.
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
start_daemon

# ----------------------------------------------------------------------------------------------------------
step "RC2 — the bootstrap is not a fault, and nothing is acted on during it"
# ----------------------------------------------------------------------------------------------------------
# TAKEN BEFORE `await_ready` DELIBERATELY. The grace is the one window in which readiness can be true with the
# mount never observed, and it is exactly the window in which a supervisor that keyed on "not ok yet" would
# remount a perfectly healthy daemon that had simply not finished starting.
RC2_ACTED=0
RC2_STATES=""
n=0
while [ "$n" -lt 12 ]; do
  sample
  [ -n "$REC_STATE" ] && RC2_STATES="$RC2_STATES $REC_STATE"
  [ "$REC_STATE" = "$RC_STATE_ACTING" ] && RC2_ACTED=1
  [ -n "$REC_GENERATION" ] && [ "$REC_GENERATION" != "0" ] && RC2_ACTED=1
  n=$((n + 1))
done

await_ready || { docker logs "$DAEMON_CONTAINER" 2>&1 | tail -30 >&2; die "the daemon never became ready"; }
DAEMON_PID="$(docker inspect -f '{{.State.Pid}}' "$DAEMON_CONTAINER")"
test "${DAEMON_PID:-0}" -gt 0 || die "this run's daemon has no pid"
echo "  the daemon is ready (pid $DAEMON_PID)"

if [ "$RC2_ACTED" -eq 0 ]; then
  pass "RC2 nothing was acted on during the bootstrap; the states seen were:$RC2_STATES"
else
  fail "RC2 the supervisor acted during the bootstrap; the states seen were:$RC2_STATES"
fi

# ----------------------------------------------------------------------------------------------------------
step "waiting for the bootstrap grace to expire"
# ----------------------------------------------------------------------------------------------------------
# EVERY ARM BELOW IS TAKEN AFTER THE GRACE HAS GONE. An arm measured inside it would be measuring a window in
# which readiness is entitled to stand on nothing, so no fault could make it false and no recovery could ever
# be entitled to act.
RC_GRACE_WAIT_S=$(( (RC_MOUNT_BOOTSTRAP_GRACE_MS / 1000) + 5 ))
n=0
while [ "$n" -lt "$RC_GRACE_WAIT_S" ]; do
  sample
  [ "$(body_field "$READY_BODY" mountBootstrapGrace)" = "false" ] && break
  n=$((n + 1)); sleep 1
done
echo "  the grace is over"

# ----------------------------------------------------------------------------------------------------------
step "RC1 — the control: a healthy mount, an idle supervisor, and real bytes"
# ----------------------------------------------------------------------------------------------------------
# WITHOUT THIS ARM EVERY ARM BELOW IS SATISFIED BY A SUPERVISOR THAT NEVER ACTS UNDER ANY CIRCUMSTANCES,
# which — given that most of the arms here assert inaction — is the unfailable shape this gate would otherwise
# be almost entirely made of.
sample
RC1_CODE="$READY_CODE"; RC1_REASON="$READY_REASON"; RC1_OBSERVED="$READY_OBSERVED"
RC1_STATE="$REC_STATE"; RC1_RECREASON="$REC_REASON"
RC1_ATTEMPTS="$REC_ATTEMPTS"; RC1_GENERATION="$REC_GENERATION"; RC1_REMEDIATION="$REC_REMEDIATION"
CONSUMER_SHA_BEFORE="$(consumer_sha)"

if [ "$RC1_CODE" = "200" ] && [ "$RC1_REASON" = "$RC_REASON_OK" ] \
   && [ "$RC1_OBSERVED" = "$RC_OBSERVED_LIVE_PROJECTIOND" ] \
   && [ "$RC1_STATE" = "$RC_STATE_IDLE" ] \
   && [ "$RC1_RECREASON" = "$RC_CODE_NO_ACTION_HEALTHY" ] \
   && [ "$RC1_ATTEMPTS" = "0" ] && [ "$RC1_GENERATION" = "0" ] \
   && [ "$RC1_REMEDIATION" = "$RC_REMEDIATION_NONE" ] \
   && [ -n "$CONSUMER_SHA_BEFORE" ] && [ "$CONSUMER_SHA_BEFORE" = "$SUBJECT_SHA" ]; then
  pass "RC1 a healthy mount leaves the supervisor $RC1_STATE/$RC1_RECREASON with 0 attempts and generation" \
       "0, and the pre-attached consumer reads the right bytes"
else
  fail "RC1 code=$RC1_CODE reason=$RC1_REASON observed=$RC1_OBSERVED state=$RC1_STATE" \
       "recoveryReason=$RC1_RECREASON attempts=$RC1_ATTEMPTS generation=$RC1_GENERATION" \
       "remediation=$RC1_REMEDIATION consumerDigestMatches=" \
       "$( [ "$CONSUMER_SHA_BEFORE" = "$SUBJECT_SHA" ] && echo yes || echo NO )"
fi

# ----------------------------------------------------------------------------------------------------------
step "RC3 — a TRANSIENT fault is reported and is NOT acted on"
# ----------------------------------------------------------------------------------------------------------
# THE ARM HAS A CONTROL INSIDE IT, AND IT IS THE HALF THAT MATTERS. "Nothing was acted on" is satisfied by a
# fault the daemon never saw, so this also requires that a NON-LIVE OBSERVATION WAS ACTUALLY REPORTED.
# Without that, the arm would pass most reliably when the fault injection was broken.
RC3_TAG="rc-flap-$$"
case "$DAEMON_CONTAINER" in
  projection-recovery-daemon-$$) ;;
  *) die "RC3: refusing to touch a namespace that is not this run's own daemon ($DAEMON_CONTAINER)" ;;
esac
RC3_TOP_BEFORE="$(daemon_top | awk '{print $2}')"
test "$RC3_TOP_BEFORE" = "fuse.projectiond" \
  || die "RC3: the top of the stack in the daemon namespace is '$RC3_TOP_BEFORE', not ours; refusing to stack"

RC3_GENERATION_BEFORE="$REC_GENERATION"
mount -t tmpfs -o size=1m,nr_inodes=64 "$RC3_TAG" "$WORK/mnt" \
  || die "RC3: the transient overlay could not be stacked"
RC3_STACKED_AT="$(date +%s%3N)"
RC3_SAW_FAULT=0
RC3_UNMOUNTED=0
n=0
while [ "$n" -lt 60 ]; do
  sample
  case "$READY_OBSERVED" in
    "$RC_OBSERVED_LIVE_PROJECTIOND") ;;
    '') ;;
    *) RC3_SAW_FAULT=1 ;;
  esac
  NOW_MS="$(date +%s%3N)"
  if [ "$RC3_UNMOUNTED" -eq 0 ] && [ "$(( NOW_MS - RC3_STACKED_AT ))" -ge "$RC_ANTI_FLAP_TRANSIENT_MS" ]; then
    RC3_TOP_NOW="$(daemon_top | awk '{print $2}')"
    if [ "$RC3_TOP_NOW" = "tmpfs" ]; then
      umount "$WORK/mnt" || die "RC3: the transient overlay could not be removed"
      RC3_UNMOUNTED=1
    else
      fail "RC3 the top of the stack is '$RC3_TOP_NOW', not the tmpfs this run stacked; nothing was unmounted"
      break
    fi
  fi
  [ "$RC3_UNMOUNTED" -eq 1 ] && [ "$READY_OBSERVED" = "$RC_OBSERVED_LIVE_PROJECTIOND" ] && break
  n=$((n + 1))
done
sample
RC3_GENERATION_AFTER="$REC_GENERATION"

if [ "$RC3_SAW_FAULT" -eq 1 ] && [ "$RC3_UNMOUNTED" -eq 1 ] \
   && [ "$RC3_GENERATION_AFTER" = "$RC3_GENERATION_BEFORE" ]; then
  pass "RC3 a non-live observation was reported during the transient and the generation stayed at" \
       "$RC3_GENERATION_AFTER — nothing was acted on"
else
  fail "RC3 sawNonLiveObservation=$RC3_SAW_FAULT overlayRemoved=$RC3_UNMOUNTED" \
       "generation=$RC3_GENERATION_BEFORE->$RC3_GENERATION_AFTER"
fi

# ----------------------------------------------------------------------------------------------------------
step "RC5 — a FOREIGN overlay is REFUSED, and the overlay is left exactly where it is"
# ----------------------------------------------------------------------------------------------------------
# THE MOST IMPORTANT ARM IN THIS GATE. In every containerised topology this daemon ships in, the likeliest
# foreign mount at the mount point is THE OPERATOR'S OWN BIND — the one mount that must survive for any
# recovery to be visible to anybody. `--auto-remount` unmounted it once already, logged success, and recovered
# for the daemon and for nobody else.
#
# SO THE ASSERTION IS NOT ONLY THE REASON CODE. It is that after a whole sustain window and a whole cooldown
# beyond it, the tmpfs is STILL THERE and the generation has STILL not moved. A refusal that published the
# right word and then acted anyway would pass an arm that only read the surface.
RC5_TAG="rc-foreign-$$"
RC5_GENERATION_BEFORE="$REC_GENERATION"
RC5_ATTEMPTS_BEFORE="$REC_ATTEMPTS"
RC5_TOP_BEFORE="$(daemon_top | awk '{print $2}')"
test "$RC5_TOP_BEFORE" = "fuse.projectiond" \
  || die "RC5: the top of the stack is '$RC5_TOP_BEFORE', not ours; refusing to stack"

mount -t tmpfs -o size=1m,nr_inodes=64 "$RC5_TAG" "$WORK/mnt" \
  || die "RC5: the foreign overlay could not be stacked"
echo "  a tmpfs named $RC5_TAG is stacked ABOVE the live projection mount"

# WAIT OUT BOTH WINDOWS AND THEN SOME. The supervisor is entitled to act only after the fault hold and the
# sustain window; giving it both plus a whole cooldown means "it did not act" is a measurement rather than an
# impatience.
RC5_WAIT_S=$(( ((RC_MOUNT_FAULT_HOLD_MS + RC_RECOVERY_SUSTAIN_MS + RC_RECOVERY_COOLDOWN_MS) / 1000) + 10 ))
RC5_SAW_REFUSAL=0
n=0
while [ "$n" -lt "$RC5_WAIT_S" ]; do
  sample
  [ "$REC_REASON" = "$RC_CODE_REFUSE_FOREIGN_MOUNT" ] && RC5_SAW_REFUSAL=1
  n=$((n + 1)); sleep 1
done
RC5_CODE="$READY_CODE"; RC5_REASON="$READY_REASON"
RC5_RECREASON="$REC_REASON"; RC5_REMEDIATION="$REC_REMEDIATION"
RC5_GENERATION_AFTER="$REC_GENERATION"; RC5_ATTEMPTS_AFTER="$REC_ATTEMPTS"
RC5_TOP_AFTER="$(daemon_top | awk '{print $2}')"

if [ "$RC5_TOP_AFTER" = "tmpfs" ]; then
  umount "$WORK/mnt" || die "RC5: the foreign overlay could not be removed"
  echo "  the overlay was unmounted BY THE GATE; only the tmpfs was removed"
fi

# Back to healthy before the next arm, so RC4 starts from a known state.
n=0
while [ "$n" -lt 90 ]; do
  sample
  [ "$READY_CODE" = "200" ] && [ "$READY_REASON" = "$RC_REASON_OK" ] && break
  n=$((n + 1)); sleep 1
done

if [ "$RC5_SAW_REFUSAL" -eq 1 ] && [ "$RC5_CODE" = "503" ] \
   && [ "$RC5_REASON" = "$RC_REASON_MOUNT_OBSERVED_NOT_LIVE" ] \
   && [ "$RC5_RECREASON" = "$RC_CODE_REFUSE_FOREIGN_MOUNT" ] \
   && [ "$RC5_REMEDIATION" = "$RC_REMEDIATION_INSPECT_MOUNT_OWNER" ] \
   && [ "$RC5_TOP_AFTER" = "tmpfs" ] \
   && [ "$RC5_GENERATION_AFTER" = "$RC5_GENERATION_BEFORE" ] \
   && [ "$RC5_ATTEMPTS_AFTER" = "$RC5_ATTEMPTS_BEFORE" ]; then
  pass "RC5 a foreign overlay was refused with $RC5_RECREASON/$RC5_REMEDIATION, the overlay was STILL" \
       "MOUNTED after a whole sustain window and cooldown, and nothing was spent"
else
  fail "RC5 sawRefusal=$RC5_SAW_REFUSAL code=$RC5_CODE reason=$RC5_REASON recoveryReason=$RC5_RECREASON" \
       "remediation=$RC5_REMEDIATION topAfter=$RC5_TOP_AFTER" \
       "generation=$RC5_GENERATION_BEFORE->$RC5_GENERATION_AFTER" \
       "attempts=$RC5_ATTEMPTS_BEFORE->$RC5_ATTEMPTS_AFTER"
fi

# ----------------------------------------------------------------------------------------------------------
step "RC4, RC7 and RC12 — a SUSTAINED fault on one of OUR OWN mounts is recovered, confirmed and readable"
# ----------------------------------------------------------------------------------------------------------
# THE FAULT IS A CORPSE OF OURS ON TOP, AND IT IS PRODUCED WITHOUT KILLING THE SUBJECT. A second projectiond
# is stacked above and ITS connection is aborted, so what the subject observes is `stale-projectiond` while
# its own serve loop never notices — which is the whole point: this is the fault the SERVE supervisor cannot
# see, and therefore the one the recovery loop exists for.
RC4_GENERATION_BEFORE="$REC_GENERATION"
RC4_DEATHS_BEFORE="$(serve_deaths)"
RC4_MOUNTS_BEFORE="$(daemon_mounts)"
RC4_TOP_BEFORE="$(daemon_top | awk '{print $1}')"
test "$RC4_MOUNTS_BEFORE" = "1" \
  || die "RC4: the daemon namespace holds $RC4_MOUNTS_BEFORE of our mounts, not one"

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

RC4_LANDED=0
n=0
while [ "$n" -lt 60 ]; do
  if [ "$(daemon_mounts)" = "2" ] && [ "$(daemon_top | awk '{print $1}')" != "$RC4_TOP_BEFORE" ]; then
    RC4_LANDED=1; break
  fi
  n=$((n + 1)); sleep 0.5
done
test "$RC4_LANDED" -eq 1 || die "RC4: the second mount never landed above this run's own mount"
echo "  a second projectiond mount is stacked above; tearing down ITS connection to leave a corpse"

set +e
RC4_ABORT="$(bash "$WORK/out/fuse-abort.sh" "$WORK/mnt" 2>&1)"
set -e
echo "$RC4_ABORT" | sed 's/^/  /'
case "$(echo "$RC4_ABORT" | tail -1)" in
  abort:done*) : ;;
  *) die "RC4: the corpse could not be produced ($(echo "$RC4_ABORT" | tail -1))" ;;
esac
docker rm -f "$BLOCKER_CONTAINER" >/dev/null 2>&1 || true

RC4_ACTIONS_BEFORE="$(recovery_actions)"
RC4_WAIT_S=$(( ((RC_MOUNT_FAULT_HOLD_MS + RC_RECOVERY_SUSTAIN_MS) / 1000) + 40 ))
n=0
while [ "$n" -lt "$RC4_WAIT_S" ]; do
  sample
  [ -n "$REC_GENERATION" ] && [ "$REC_GENERATION" != "$RC4_GENERATION_BEFORE" ] && break
  n=$((n + 1)); sleep 1
done
RC4_GENERATION_AFTER="$REC_GENERATION"
RC4_DEATHS_AFTER="$(serve_deaths)"
# THE ACTION AND ITS REASON COME FROM THE LOG, WHICH IS DURABLE, RATHER THAN FROM CATCHING A ONE-SECOND STATE.
RC4_ACTIONS_AFTER="$(recovery_actions)"
RC4_ACT_REASON="$(recovery_last_action)"
RC4_SAW_ACTION=0
[ "$RC4_ACTIONS_AFTER" -eq "$(( RC4_ACTIONS_BEFORE + 1 ))" ] && RC4_SAW_ACTION=1

if [ "$RC4_GENERATION_AFTER" = "$(( RC4_GENERATION_BEFORE + 1 ))" ] && [ "$RC4_SAW_ACTION" -eq 1 ]; then
  pass "RC4 a sustained fault on one of our own mounts was acted on exactly once ($RC4_ACT_REASON):" \
       "generation $RC4_GENERATION_BEFORE -> $RC4_GENERATION_AFTER"
else
  docker logs "$DAEMON_CONTAINER" 2>&1 | grep -E 'recovery|remount' | tail -10 >&2 || true
  fail "RC4 generation=$RC4_GENERATION_BEFORE->${RC4_GENERATION_AFTER:-absent} sawAction=$RC4_SAW_ACTION" \
       "actionReason=${RC4_ACT_REASON:-none} serveDeaths=$RC4_DEATHS_BEFORE->$RC4_DEATHS_AFTER"
fi

# RC7: THE BUDGET IS REFUNDED ONLY BY OBSERVED, CONFIRMED READINESS — never by a mount syscall returning.
# That distinction is Phase 2's worst defect in one line: the daemon logged a successful remount and no
# consumer could read a byte.
RC7_READY=0; RC7_OUTCOME=""; RC7_ATTEMPTS=""
RC7_WAIT_S=$(( (RC_RECOVERY_CONFIRM_MS / 1000) + 90 ))
n=0
while [ "$n" -lt "$RC7_WAIT_S" ]; do
  sample
  if [ "$READY_CODE" = "200" ] && [ "$READY_REASON" = "$RC_REASON_OK" ]; then
    RC7_READY=1; RC7_OUTCOME="$REC_OUTCOME"; RC7_ATTEMPTS="$REC_ATTEMPTS"
    [ "$RC7_ATTEMPTS" = "0" ] && break
  fi
  n=$((n + 1)); sleep 1
done

if [ "$RC7_READY" -eq 1 ] && [ "$RC7_OUTCOME" = "succeeded" ] && [ "$RC7_ATTEMPTS" = "0" ] \
   && [ "$REC_GENERATION" = "$RC4_GENERATION_AFTER" ]; then
  pass "RC7 readiness returned to 200/ok, the outcome is $RC7_OUTCOME, the budget was refunded to" \
       "$RC7_ATTEMPTS, and the generation stayed at $REC_GENERATION"
else
  fail "RC7 ready=$RC7_READY outcome=${RC7_OUTCOME:-absent} attempts=${RC7_ATTEMPTS:-absent}" \
       "generation=$REC_GENERATION (expected $RC4_GENERATION_AFTER)"
fi

CONSUMER_SHA_AFTER=""
n=0
while [ "$n" -lt 120 ]; do
  CONSUMER_SHA_AFTER="$(consumer_sha)"
  [ -n "$CONSUMER_SHA_AFTER" ] && break
  n=$((n + 1)); sleep 0.5
done
if [ "$CONSUMER_SHA_AFTER" = "$SUBJECT_SHA" ] && [ "$CONSUMER_SHA_AFTER" = "$CONSUMER_SHA_BEFORE" ]; then
  pass "RC12 the SAME pre-attached unprivileged consumer read the SAME digest after the recovery"
else
  fail "RC12 the pre-attached consumer digest after recovery is '${CONSUMER_SHA_AFTER:-absent}', not the" \
       "'$SUBJECT_SHA' it read before"
fi

# ----------------------------------------------------------------------------------------------------------
step "RC6 and RC10 — a serve-loop death belongs to the serve supervisor, and only ONE of them acts"
# ----------------------------------------------------------------------------------------------------------
# THE CONCURRENT TRIGGER IS REAL AND NOT SIMULATED. Aborting this run's own connection produces a serve-loop
# death AND, one sample later, a non-live observation — two supervisors looking at one fault. Rule 3 of the
# readiness precedence makes the reason `serve-loop-dead`, and the recovery loop's table declines it, so the
# serve supervisor remounts and the recovery generation does not move.
RC6_GENERATION_BEFORE="$REC_GENERATION"
RC6_REMOUNTS_BEFORE="$(remount_starts)"
RC6_MOUNTS="$(daemon_mounts)"
# THE GUARD IS ON THE IDENTITY OF WHAT WILL BE ABORTED, NOT ON HOW MANY OF OURS ARE THERE, AND THE FIRST REAL
# TOWER RUN IS WHY.
#
# This arm originally required EXACTLY ONE of our mounts, copied from an arm that runs before any recovery
# has happened. By the time RC6 runs, RC4's recovery has already been performed — and the shipped supervisor
# recovers by STACKING over the corpse rather than by removing it, because `ProbeMountpoint` reads the bottom
# entry of a stacked mount point and correctly declines to touch what it finds there (the operator's bind).
# So the namespace legitimately held three of ours, and the arm refused to run over a state the product had
# produced on purpose.
#
# WHAT ACTUALLY MAKES THE ABORT SAFE IS UNCHANGED AND IS ASSERTED HERE INSTEAD: the injector only ever tears
# down the TOP of the chain, only when it is `fuse.projectiond`, and only at or under this run's own mount
# point. The host serves its array over shfs, which is also FUSE, so that guard is the one that matters.
RC6_TOP_TYPE="$(daemon_top | awk '{print $2}')"
test "$RC6_TOP_TYPE" = "fuse.projectiond" \
  || die "RC6: the top of the stack is '$RC6_TOP_TYPE', not ours; refusing to abort"
test "${RC6_MOUNTS:-0}" -ge 1 \
  || die "RC6: the daemon namespace holds none of our mounts; there is nothing to abort"
echo "  the daemon namespace holds $RC6_MOUNTS of our mounts, and the top of the chain is $RC6_TOP_TYPE"

set +e
RC6_ABORT="$(bash "$WORK/out/fuse-abort.sh" "$WORK/mnt" 2>&1)"
set -e
echo "$RC6_ABORT" | sed 's/^/  /'
case "$(echo "$RC6_ABORT" | tail -1)" in
  abort:done*) echo "  the connection was torn down under a living daemon" ;;
  *) die "RC6: the fault could not be injected ($(echo "$RC6_ABORT" | tail -1))" ;;
esac

RC6_SAW_DEAD=0; RC6_SAW_DECLINE=0
n=0
while [ "$n" -lt 120 ]; do
  sample
  [ "$READY_REASON" = "$RC_REASON_SERVE_LOOP_DEAD" ] && RC6_SAW_DEAD=1
  [ "$REC_REASON" = "$RC_CODE_NO_ACTION_SERVE_SUPERVISOR_OWNS" ] && RC6_SAW_DECLINE=1
  [ "$READY_CODE" = "200" ] && [ "$READY_REASON" = "$RC_REASON_OK" ] && [ "$n" -gt 8 ] && break
  n=$((n + 1))
done

# AND THEN A WHOLE SUSTAIN WINDOW BEYOND THE RECOVERY, so that "the recovery loop did not act" is a
# measurement rather than the arm having stopped looking too early.
wait_seconds $(( (RC_RECOVERY_SUSTAIN_MS / 1000) + 5 ))
RC6_GENERATION_AFTER="$REC_GENERATION"
RC6_REMOUNTS_AFTER="$(remount_starts)"

if [ "$RC6_SAW_DEAD" -eq 1 ] && [ "$RC6_GENERATION_AFTER" = "$RC6_GENERATION_BEFORE" ]; then
  pass "RC6 a serve-loop death was reported as $RC_REASON_SERVE_LOOP_DEAD and the recovery generation" \
       "stayed at $RC6_GENERATION_AFTER — the serve supervisor owned it"
else
  fail "RC6 sawServeLoopDead=$RC6_SAW_DEAD sawDecline=$RC6_SAW_DECLINE" \
       "generation=$RC6_GENERATION_BEFORE->$RC6_GENERATION_AFTER"
fi

# RC10: EXACTLY ONE ACTION ACROSS BOTH SUPERVISORS. The serve supervisor logs `remount attempt 1/3` once per
# recovery it starts, and the recovery loop's own actions advance the generation. One of each fault, one
# action total.
RC10_REMOUNT_STARTS=$(( RC6_REMOUNTS_AFTER - RC6_REMOUNTS_BEFORE ))
RC10_RECOVERIES=$(( RC6_GENERATION_AFTER - RC6_GENERATION_BEFORE ))
if [ "$RC10_REMOUNT_STARTS" -eq 1 ] && [ "$RC10_RECOVERIES" -eq 0 ]; then
  pass "RC10 one fault visible to both supervisors produced exactly one action: 1 serve-supervisor remount," \
       "0 recovery-loop actions"
else
  fail "RC10 serveSupervisorRemounts=$RC10_REMOUNT_STARTS recoveryLoopActions=$RC10_RECOVERIES" \
       "(exactly one action in total was predeclared)"
fi

# ----------------------------------------------------------------------------------------------------------
step "RC8, RC9 and RC11 — a recovery that cannot succeed retries, cools down, locks out and STAYS locked out"
# ----------------------------------------------------------------------------------------------------------
if [ "$RC_HAS_NSENTER" -eq 0 ]; then
  skip "RC8 no nsenter on this host, so a deterministically failing mount cannot be produced"
  skip "RC9 no nsenter on this host, so the budget cannot be driven to exhaustion"
  skip "RC11 no nsenter on this host, so a lockout cannot be produced to restart across"
else
  # THE INJECTOR, PREDECLARED IN §4 OF THE TRANCHE DOCUMENT. `/dev/null` is bound over `/dev/fuse` inside the
  # SUBJECT CONTAINER'S OWN mount namespace, so every `Mount()` is refused for a reason that has nothing to do
  # with the mount point — which is the only way to make the remount fail without making the fault itself
  # unrepresentative. It dies with the container, and it is removed inside this arm regardless.
  docker run --rm -v "$WORK/out:/out" "$RC_BUSYBOX_IMAGE" cp /bin/busybox /out/busybox \
    || die "RC8: a static busybox could not be extracted, so the injector has nothing to run in a distroless container"
  test -s "$WORK/out/busybox" || die "RC8: the extracted busybox is empty"
  docker cp "$WORK/out/busybox" "$DAEMON_CONTAINER:/busybox" \
    || die "RC8: the injector could not be placed in this run's own daemon container"
  nsenter -t "$DAEMON_PID" -m -- /busybox mount --bind /dev/null /dev/fuse \
    || die "RC8: /dev/fuse could not be masked in this run's own daemon namespace"
  echo "  every mount syscall in the subject's namespace will now be refused"

  RC8_GENERATION_BEFORE="$REC_GENERATION"
  RC8_ATTEMPT_STAMPS=""
  RC8_LAST_ATTEMPTS="$REC_ATTEMPTS"

  # THE FAULT IS A CORPSE OF SOMEBODY ELSE'S MAKING, AND IT MUST NOT BE THE SUBJECT'S OWN DEATH.
  #
  # Aborting the SUBJECT's connection here would kill its serve loop, and with `/dev/fuse` masked the
  # SERVE supervisor's own three remounts would all fail and the process would exit — leaving nothing alive
  # to measure a recovery budget on. So the fault is produced exactly as RC4 produces it: a second projectiond
  # is stacked above and ITS connection is torn down, which the subject observes as `stale-projectiond` while
  # its own serve loop never notices. That is the fault the recovery loop exists for, and it is the only one
  # that leaves a living daemon to spend a budget.
  # THE BASELINE IS TAKEN BEFORE THE BLOCKER STARTS, WHICH IS THE ONLY ORDER THAT IS NOT A RACE. Reading it
  # afterwards means a blocker that mounted quickly is already counted, and "it never landed" is then a
  # statement about how fast the container started.
  RC8_MOUNTS_BEFORE="$(daemon_mounts)"
  RC8_TOP_BEFORE="$(daemon_top | awk '{print $1}')"
  echo "  before the blocker: $RC8_MOUNTS_BEFORE of ours at the mount point, top id $RC8_TOP_BEFORE"

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

  # BOTH GUARDS, THE SAME TWO RC4 USES: the count of ours goes up AND the top of the chain is a different
  # mount id. Either alone can be satisfied by something that is not the blocker landing.
  RC8_LANDED=0
  n=0
  while [ "$n" -lt 120 ]; do
    if [ "$(daemon_mounts)" -gt "$RC8_MOUNTS_BEFORE" ] \
       && [ "$(daemon_top | awk '{print $1}')" != "$RC8_TOP_BEFORE" ]; then
      RC8_LANDED=1; break
    fi
    n=$((n + 1)); sleep 0.5
  done
  if [ "$RC8_LANDED" -ne 1 ]; then
    # THE EVIDENCE A DIAGNOSIS NEEDS, PRINTED WHERE THE FAILURE IS. Counts, mount ids and the blocker's own
    # closed-set log lines — no path beyond this run's own directory and nothing a provider ever said.
    echo "  after waiting: $(daemon_mounts) of ours, top $(daemon_top)" >&2
    docker logs "$BLOCKER_CONTAINER" 2>&1 | tail -10 | sed 's/^/  blocker: /' >&2 || true
    docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' "$BLOCKER_CONTAINER" 2>/dev/null \
      | sed 's/^/  blocker container: /' >&2 || true
    die "RC8: the second mount never landed above this run's own mount"
  fi

  RC8_TOP="$(daemon_top | awk '{print $2}')"
  test "$RC8_TOP" = "fuse.projectiond" || die "RC8: the top of the stack is '$RC8_TOP', not ours"
  set +e
  RC8_ABORT="$(bash "$WORK/out/fuse-abort.sh" "$WORK/mnt" 2>&1)"
  set -e
  case "$(echo "$RC8_ABORT" | tail -1)" in
    abort:done*) : ;;
    *) die "RC8: the fault could not be injected ($(echo "$RC8_ABORT" | tail -1))" ;;
  esac
  docker rm -f "$BLOCKER_CONTAINER" >/dev/null 2>&1 || true

  # THE BUDGET IS DRIVEN TO EXHAUSTION. The COUNT is read from the status surface; the SPACING is not.
  #
  # THE SPACING IS THE STAMPS THE COOLDOWN IS ACTUALLY COMPARED AGAINST, AND NOTHING ELSE WILL DO.
  # `decideRecovery` asks whether `now - lastAttemptAt` has reached the cooldown, and `lastAttemptAt` is
  # written into the durable ledger at the instant the attempt is granted. Every other clock is a proxy:
  #   - the gate's own observation time is late by up to a whole polling interval (measured: 18,955 ms);
  #   - Docker's timestamp on the daemon's log line is late by the gap between granting the attempt and
  #     writing the line — sub-millisecond, and enough. Measured on a fresh run: 19,999 ms against 20,000 ms,
  #     a bound reported as broken by one millisecond of its own measurement error.
  # The ledger is on this host, in this run's own directory, and it holds the exact quantity under test in
  # nanoseconds. The Docker log stamps are kept as an INDEPENDENT corroboration below.
  RC8_LEDGER="$WORK/cache/recovery/recovery-ledger.json"
  RC8_LEDGER_STAMPS=""
  # SEEDED WITH WHAT IS ALREADY THERE, BECAUSE RC4 ALREADY SPENT AN ATTEMPT AND ITS STAMP IS STILL IN THE
  # LEDGER. `lastAttemptUnixNano` is not cleared by the refund that followed it — deliberately, because the
  # cooldown is measured from the last attempt whether it succeeded or not — so a loop starting from an empty
  # baseline records RC4's stamp as this arm's first. Measured: four ledger stamps against three log lines,
  # which the corroboration caught rather than the arm passing on a gap between two different arms.
  RC8_LAST_STAMP=""
  if [ -s "$RC8_LEDGER" ]; then
    RC8_LAST_STAMP="$(node "$REL/out/jq.cjs" lastAttemptUnixNano < "$RC8_LEDGER" 2>/dev/null || true)"
  fi
  RC8_WAIT_S=$(( ((RC_RECOVERY_COOLDOWN_MS * (RC_RECOVERY_MAX_ATTEMPTS + 1)) / 1000) + 90 ))
  RC8_LOCKED=0
  n=0
  while [ "$n" -lt "$RC8_WAIT_S" ]; do
    sample
    if [ -s "$RC8_LEDGER" ]; then
      RC8_STAMP="$(node "$REL/out/jq.cjs" lastAttemptUnixNano < "$RC8_LEDGER" 2>/dev/null || true)"
      if [ -n "$RC8_STAMP" ] && [ "$RC8_STAMP" != "$RC8_LAST_STAMP" ]; then
        RC8_LAST_STAMP="$RC8_STAMP"
        RC8_LEDGER_STAMPS="$RC8_LEDGER_STAMPS $RC8_STAMP"
      fi
    fi
    [ "$REC_STATE" = "$RC_STATE_LOCKED_OUT" ] && { RC8_LOCKED=1; break; }
    n=$((n + 1)); sleep 1
  done
  RC8_ATTEMPTS="$REC_ATTEMPTS"
  RC9_STATE="$REC_STATE"; RC9_REASON="$REC_REASON"; RC9_REMEDIATION="$REC_REMEDIATION"
  RC9_GENERATION="$REC_GENERATION"

  # THE SPACING IS MEASURED FROM DOCKER'S OWN TIMESTAMPS ON THE DAEMON'S LOG, AND THE FIRST FORMULATION WAS
  # MEASURING THE GATE INSTEAD OF THE PRODUCT.
  #
  # It stamped the host clock at the moment it OBSERVED the attempt counter change — and every observation
  # here costs a container start, so an observation lands up to a whole polling interval after the event.
  # Measured, on the real host: three attempts, the closest observed pair 18,955 ms apart against a 20,000 ms
  # cooldown. That 1,045 ms is one poll, not a bound being broken, and an arm that failed on it would be
  # asserting how fast this gate can make an HTTP request.
  #
  # `docker logs -t` timestamps each line when the DAEMON WROTE IT, from Docker's clock rather than from the
  # gate's or the daemon's. It is independent of both, and it is the moment the attempt actually started.
  # The last `RECOVERY_MAX_ATTEMPTS` action lines are this arm's, because every earlier arm's action is
  # already accounted for and RC4's is the only other one.
  RC8_ATTEMPT_STAMPS="$(docker logs -t "$DAEMON_CONTAINER" 2>&1 \
    | grep -E 'projectiond: recovery: recover-' \
    | tail -n "$RC_RECOVERY_MAX_ATTEMPTS" \
    | awk '{print $1}' \
    | while read -r when; do date -d "$when" +%s%3N 2>/dev/null || true; done \
    | tr '\n' ' ')"
  echo "  attempts=$RC8_ATTEMPTS state=$RC9_STATE reason=$RC9_REASON stamps:$RC8_ATTEMPT_STAMPS"

  # THE MEASUREMENT: the daemon's own attempt stamps, in NANOSECONDS, which is the quantity its cooldown
  # compares. Converted to whole milliseconds only for the message.
  RC8_MIN_GAP=""
  RC8_PREV=""
  RC8_STAMP_COUNT=0
  for stamp in $RC8_LEDGER_STAMPS; do
    RC8_STAMP_COUNT=$(( RC8_STAMP_COUNT + 1 ))
    if [ -n "$RC8_PREV" ]; then
      gap=$(( (stamp - RC8_PREV) / 1000000 ))
      if [ -z "$RC8_MIN_GAP" ] || [ "$gap" -lt "$RC8_MIN_GAP" ]; then RC8_MIN_GAP="$gap"; fi
    fi
    RC8_PREV="$stamp"
  done
  # A GAP COMPUTED FROM FEWER STAMPS THAN THERE WERE ATTEMPTS IS NOT A MEASUREMENT OF THE SPACING. Without
  # this the arm would pass on two stamps out of three, which is the unfailable shape all over again.
  if [ "$RC8_STAMP_COUNT" -ne "$RC_RECOVERY_MAX_ATTEMPTS" ]; then
    RC8_MIN_GAP=""
  fi

  # THE CORROBORATION, AND IT IS WHAT STOPS THIS ARM BEING THE PRODUCT MARKING ITS OWN HOMEWORK. The ledger
  # is the daemon's own record; Docker's timestamps on the daemon's log are a third party's. The two must
  # agree on HOW MANY attempts happened and on the span between the first and the last, to within one tick.
  RC8_LOG_COUNT=0
  RC8_LOG_FIRST=""
  RC8_LOG_LAST=""
  for stamp in $RC8_ATTEMPT_STAMPS; do
    RC8_LOG_COUNT=$(( RC8_LOG_COUNT + 1 ))
    [ -z "$RC8_LOG_FIRST" ] && RC8_LOG_FIRST="$stamp"
    RC8_LOG_LAST="$stamp"
  done
  RC8_CORROBORATED=0
  if [ "$RC8_LOG_COUNT" -eq "$RC8_STAMP_COUNT" ] && [ -n "$RC8_LOG_FIRST" ] && [ -n "$RC8_LEDGER_STAMPS" ]; then
    RC8_LEDGER_FIRST="$(echo "$RC8_LEDGER_STAMPS" | awk '{print $1}')"
    RC8_LEDGER_LAST="$(echo "$RC8_LEDGER_STAMPS" | awk '{print $NF}')"
    RC8_LEDGER_SPAN=$(( (RC8_LEDGER_LAST - RC8_LEDGER_FIRST) / 1000000 ))
    RC8_LOG_SPAN=$(( RC8_LOG_LAST - RC8_LOG_FIRST ))
    RC8_SPAN_DIFF=$(( RC8_LEDGER_SPAN - RC8_LOG_SPAN ))
    [ "$RC8_SPAN_DIFF" -lt 0 ] && RC8_SPAN_DIFF=$(( -RC8_SPAN_DIFF ))
    [ "$RC8_SPAN_DIFF" -le "$RC_RECOVERY_TICK_MS" ] && RC8_CORROBORATED=1
    echo "  corroboration: ledger span ${RC8_LEDGER_SPAN}ms, Docker log span ${RC8_LOG_SPAN}ms"
  fi

  if [ "$RC8_ATTEMPTS" = "$RC_RECOVERY_MAX_ATTEMPTS" ] && [ -n "$RC8_MIN_GAP" ] \
     && [ "$RC8_MIN_GAP" -ge "$RC_RECOVERY_COOLDOWN_MS" ] && [ "$RC8_CORROBORATED" -eq 1 ]; then
    pass "RC8 a recovery that cannot succeed spent exactly $RC8_ATTEMPTS attempts, the closest two of them" \
         "${RC8_MIN_GAP}ms apart against a ${RC_RECOVERY_COOLDOWN_MS}ms cooldown, and Docker's own" \
         "timestamps agree with the daemon's record to within one tick"
  else
    fail "RC8 attempts=${RC8_ATTEMPTS:-absent} (budget $RC_RECOVERY_MAX_ATTEMPTS)" \
         "closestGapMs=${RC8_MIN_GAP:-unmeasured} against ${RC_RECOVERY_COOLDOWN_MS}ms" \
         "corroboratedByDockerTimestamps=$RC8_CORROBORATED (ledger stamps $RC8_STAMP_COUNT," \
         "log lines $RC8_LOG_COUNT)"
  fi

  # RC9: LOCKED OUT, AND IT STAYS LOCKED OUT. The second half is the arm: a lockout that only held for a
  # moment would be a pause, and a pause is what an infinite loop is made of.
  RC9_HELD=1
  wait_seconds $(( (RC_RECOVERY_COOLDOWN_MS * 2) / 1000 ))
  [ "$REC_GENERATION" = "$RC9_GENERATION" ] || RC9_HELD=0
  [ "$REC_STATE" = "$RC_STATE_LOCKED_OUT" ] || RC9_HELD=0

  if [ "$RC8_LOCKED" -eq 1 ] && [ "$RC9_HELD" -eq 1 ] \
     && [ "$RC9_REMEDIATION" = "$RC_REMEDIATION_RESET_RECOVERY_LEDGER" ]; then
    pass "RC9 the exhausted budget locked out with $RC9_REASON/$RC9_REMEDIATION and the generation did not" \
         "advance for a further two whole cooldowns"
  else
    fail "RC9 lockedOut=$RC8_LOCKED heldThroughout=$RC9_HELD reason=$RC9_REASON" \
         "remediation=$RC9_REMEDIATION generation=$RC9_GENERATION->$REC_GENERATION"
  fi

  # RC11: THE LOCKOUT SURVIVES THE PROCESS, WHICH IS WHAT MAKES THE BUDGET A BOUND AT ALL.
  #
  # `restart: unless-stopped` restarts a daemon that exits, so an in-memory budget of three would authorise
  # three attempts PER RESTART. The mask is removed first so that the restarted daemon is HEALTHY in every
  # respect except its inherited ledger — a daemon that came back locked out because it was still broken
  # would prove nothing about persistence.
  nsenter -t "$DAEMON_PID" -m -- /busybox umount /dev/fuse >/dev/null 2>&1 || true
  docker rm -f "$DAEMON_CONTAINER" >/dev/null 2>&1 || true

  # THE DEAD LAYERS THIS ARM PRODUCED HAVE TO GO BEFORE ANYTHING CAN BIND THE PATH AGAIN, AND FINDING THAT OUT
  # IS THE MOST USEFUL THING THIS ARM HAS DONE.
  #
  # A mount point carrying a dead FUSE mount answers `stat` with ENOTCONN, and Docker's bind setup reads that
  # as "file exists" and refuses: `error while creating mount source path ... file exists`. So a daemon that
  # exhausted its budget leaves a host path that the NEXT container cannot bind — which is an operator
  # problem, not a gate problem, and `deploy/projection-alpha.sh preflight` now refuses with a named
  # remediation rather than letting Docker produce that sentence.
  #
  # Here the gate clears its OWN run directory with the shared helper, which unmounts only underneath this
  # run's root and verifies rather than assumes.
  projection_gate_unmount_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" \
    || die "RC11: this run's own dead mount layers could not be cleared"
  start_daemon
  await_ready 240 || { docker logs "$DAEMON_CONTAINER" 2>&1 | tail -30 >&2; \
    die "RC11: the restarted daemon never became ready"; }
  DAEMON_PID="$(docker inspect -f '{{.State.Pid}}' "$DAEMON_CONTAINER")"

  sample
  RC11_STATE="$REC_STATE"; RC11_ATTEMPTS="$REC_ATTEMPTS"; RC11_REMEDIATION="$REC_REMEDIATION"

  # ...AND A HUMAN IS THE ONLY THING THAT CLEARS IT. The reset runs in the shipped image, in the mode that
  # constructs no daemon and cannot mount.
  # AS THE UID THAT OWNS THE CACHE, AND THE FIRST RUN THAT GOT THIS FAR IS WHY IT SAYS SO.
  #
  # The image's DEFAULT user is `nonroot`; the daemon runs as root in every shipped profile because a FUSE
  # mount needs it, so the ledger and its directory belong to root. A reset that did not say who to be was
  # refused by the filesystem, and the arm reported "--reset-recovery refused" with no way to tell that from
  # the flag being broken. The daemon now says what to do about it, and this captures what it said.
  RC11_RESET_OUT="$(docker run --rm --user 0:0 \
    -v "$WORK/cache:/var/lib/projectiond/cache" \
    -v "$WORK/config.json:/etc/projectiond/config.json:ro" \
    "$IMAGE" --config /etc/projectiond/config.json --reset-recovery 2>&1)" \
    || die "RC11: --reset-recovery refused: $RC11_RESET_OUT"
  docker rm -f "$DAEMON_CONTAINER" >/dev/null 2>&1 || true
  start_daemon
  await_ready 240 || die "RC11: the daemon never became ready after the reset"
  DAEMON_PID="$(docker inspect -f '{{.State.Pid}}' "$DAEMON_CONTAINER")"
  sample
  RC11_AFTER_RESET="$REC_STATE"

  if [ "$RC11_STATE" = "$RC_STATE_LOCKED_OUT" ] \
     && [ "$RC11_ATTEMPTS" = "$RC_RECOVERY_MAX_ATTEMPTS" ] \
     && [ "$RC11_REMEDIATION" = "$RC_REMEDIATION_RESET_RECOVERY_LEDGER" ] \
     && [ "$RC11_AFTER_RESET" != "$RC_STATE_LOCKED_OUT" ]; then
    pass "RC11 the lockout survived a container restart on the FIRST reading ($RC11_STATE, $RC11_ATTEMPTS" \
         "attempts) and only --reset-recovery cleared it (now $RC11_AFTER_RESET)"
  else
    fail "RC11 stateAfterRestart=$RC11_STATE attempts=$RC11_ATTEMPTS remediation=$RC11_REMEDIATION" \
         "stateAfterReset=$RC11_AFTER_RESET"
  fi
fi

# ----------------------------------------------------------------------------------------------------------
step "the closed-set discipline, over every reading this run ever took"
# ----------------------------------------------------------------------------------------------------------
# NO ARBITRARY TEXT IS AN API. Every recovery field is checked against the contract's own sets at the moment
# it is read, so a code invented in the product shows up here rather than in an operator's monitoring rule.
if [ "$CLOSED_SET_VIOLATIONS" -eq 0 ]; then
  pass "every recoveryState, recoveryReason and recoveryRemediation published in this run is in the" \
       "contract's closed sets"
else
  fail "$CLOSED_SET_VIOLATIONS published recovery field(s) were outside the contract's closed sets"
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
step "RC13 — the host is as it was found, asserted rather than reported"
# ----------------------------------------------------------------------------------------------------------
docker ps -a --format '{{.Names}}' | sort > "$GATE_ROOT/host-containers-after-$$.txt"
docker network ls --format '{{.Name}}' | sort > "$GATE_ROOT/host-networks-after-$$.txt"
docker volume ls --format '{{.Name}}'  | sort > "$GATE_ROOT/host-volumes-after-$$.txt"

RC13_OK=1
for what in containers networks volumes; do
  if ! diff -q "$GATE_ROOT/host-${what}-before-$$.txt" "$GATE_ROOT/host-${what}-after-$$.txt" >/dev/null; then
    RC13_OK=0
    echo "  the $what on this host changed across the run:" >&2
    diff "$GATE_ROOT/host-${what}-before-$$.txt" "$GATE_ROOT/host-${what}-after-$$.txt" >&2 || true
  fi
done
if [ "${LEFT_MOUNTS:-1}" != "0" ]; then
  RC13_OK=0
  echo "  ${LEFT_MOUNTS} mountpoint(s) left under this run's own directory" >&2
fi
if [ -d "$WORK" ]; then
  RC13_OK=0
  echo "  this run's own directory still exists" >&2
fi
if [ "$RC13_OK" -eq 1 ]; then
  pass "RC13 the container, network and volume SETS are identical, and this run's mountpoints, overlays," \
       "blocker, ledger and directory are gone"
else
  fail "RC13 the host is not as it was found"
fi

# ----------------------------------------------------------------------------------------------------------
echo
if [ "$SKIPPED" -ne 0 ]; then
  echo "BOUNDED RECOVERY GATE FAILED: $SKIPPED arm(s) SKIPPED, and a skip is a failure here." >&2
  exit 1
fi
if [ "$FAILED" -ne 0 ]; then
  echo "BOUNDED RECOVERY GATE FAILED: $PASSED passed, $FAILED failed." >&2
  exit 1
fi
echo "BOUNDED RECOVERY GATE PASSED: $PASSED of $PASSED arms. Exactly what was proved:"
echo "  - a healthy mount leaves the supervisor idle, with nothing spent and a consumer reading real bytes;"
echo "  - the bootstrap window is not a fault and nothing is acted on inside it;"
echo "  - a transient fault is REPORTED and is not acted on, so the appliance does not remount on flicker;"
echo "  - a sustained fault on one of OUR OWN mounts is acted on exactly ONCE, and readiness has to CONFIRM"
echo "    it before the budget is refunded - a mount syscall returning is not a recovery;"
echo "  - a FOREIGN overlay is REFUSED, is still mounted afterwards, and costs nothing from the budget;"
echo "  - a serve-loop death belongs to the serve supervisor and the recovery loop declines it, so one fault"
echo "    visible to both produces exactly one action;"
echo "  - a recovery that cannot succeed retries a BOUNDED number of times, a whole cooldown apart, and"
echo "    then locks out and STAYS locked out;"
echo "  - the lockout survives a container restart on the first reading, and only --reset-recovery clears it;"
echo "  - the same pre-attached unprivileged consumer read the same digest after the recovery;"
echo "  - every published recovery field is in the contract's closed sets;"
echo "  - the host's container, network and volume SETS are identical, asserted rather than reported."
echo
echo "WHAT THIS GATE DOES NOT PROVE:"
echo "  - It closes only itself. It re-closes no G-number and does not reopen any earlier phase."
echo "  - A recovery is not an availability claim: a bounded set of faults, a bounded number of times."
echo "  - No restart policy changed, and no provider was contacted - every daemon here was configured with"
echo "    no endpoint at all."
echo "  - It is not a load test and no figure here is a performance claim."
