#!/usr/bin/env bash
# The MOUNT-TRUTH gate: does the daemon report what is AT its mount point, or only what it remembers doing
# to it?
#
# WHAT IT IS FOR. `status.mounted` is a boolean the daemon sets once when it believes it has mounted, and
# `ready` is that boolean AND the absence of an observed serve death. Neither is ever compared against the
# mount point, so both of the worst failures in this product's history presented as a healthy daemon: the
# `--auto-remount` defect that remounted into a namespace with no host peer, and the cold corpse that refused
# every remount — each with /readyz answering ready while no consumer could read a byte. Phase 4 adds an
# OBSERVATION beside the belief, and this gate is what says the observation tells the truth.
#
# THE DIVERGENCE IS THE MEASUREMENT. MT2 aborts the connection under a living daemon and requires
# `mountObserved` to become `stale-projectiond` WHILE `mounted` is still true. A gate that only ever saw the
# two agree would pass against a field wired to the boolean it is supposed to be independent of.
#
# WHY /readyz LATENCY IS ASSERTED IN EVERY ARM. The probe decides with statfs, and statfs reaches the
# connection — on a live mount the daemon's own serve loop answers it. If the endpoint ever probed inline it
# would block for exactly as long as the thing it exists to report on is broken. The budget is strictly under
# the probe timeout by contract, so a handler that had waited for a probe could not pass MT3. The number
# matters far less than that property.
#
# WHAT IT DOES NOT TOUCH. No provider, no endpoint, no credential, no operator corpus, no media server. The
# daemon's configuration names no endpoint at all, so there is nothing it could contact. The namespace is a
# single LOCAL entry served from a host file through the production image, and the only other participant is
# one unprivileged consumer this gate starts itself.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

GATE_ROOT="$PWD/.projection-mount-truth-gate"
REL_GATE_ROOT=".projection-mount-truth-gate"
REL=".projection-mount-truth-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"

PG_PORT="${PROJECTION_MOUNT_TRUTH_GATE_PG_PORT:-5600}"
COMPOSE_FILE="docker-compose.projection-mount-truth.yml"
COMPOSE_PROJECT="projection-mount-truth-gate"
NETWORK="$COMPOSE_PROJECT"

DAEMON_CONTAINER="projection-mount-truth-daemon-$$"
VERIFIER_CONTAINER="projection-mount-truth-verifier-$$"
STATUS_ADDR="127.0.0.1:9000"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_MOUNT_TRUTH_GATE_PG_PORT="$PG_PORT"

# THE THRESHOLDS ARE READ FROM THE MODULE, NEVER SPELLED HERE. `test/projection-mount-truth.ts` asserts this
# file contains no literal spelling of any of them, so a number cannot drift between the contract and the gate
# that measures against it.
MT_BUDGETS="$(npx tsx src/ops/projection-mount-truth-cli.ts budgets --sh)" \
  || { echo "the mount-truth thresholds could not be read; nothing can be measured against them" >&2; exit 1; }
eval "$MT_BUDGETS"

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

mkdir -p "$WORK/manifest" "$WORK/media" "$WORK/cache" "$WORK/mnt" "$WORK/out"
chmod 755 "$GATE_ROOT" "$WORK"
chmod 777 "$WORK/cache" "$WORK/mnt" "$WORK/out"

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

# THE FAULT: THE KERNEL'S OWN TEARDOWN OF ONE FUSE CONNECTION, GUARDED TO THIS RUN.
#
# It is an abort rather than an unmount because an unmount with a consumer attached detaches namespaces and
# leaves the connection alive — the daemon would observe nothing and the arm would report a fault that never
# happened. The guard is two-fold and both halves are required: only `fuse.projectiond` mounts, and only ones
# at or under THIS run's own mount point. The host serves its array over shfs, which is also FUSE, and
# aborting the wrong connection would take the array offline.
#
# THE TOP OF THE STACK IS THE ROW NOTHING ELSE CALLS ITS PARENT, AND IT IS NOT THE HIGHEST MOUNT ID. Sorting
# by id and taking the last assumes a later mount carries a larger id; THE KERNEL RECYCLES MOUNT IDS, and a
# real run met a live mount at id 3234 stacked on a floor at 3400 and aborted the floor — tearing down a
# corpse nobody was serving while the daemon carried on untouched. mountinfo names the parent in field 2, so
# the stack is a chain and its top is the only row at this mount point that no other row names as its parent.
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
  docker rm -f "$DAEMON_CONTAINER" "$VERIFIER_CONTAINER" >/dev/null 2>&1 || true
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
# THE STATUS SURFACE, READ FROM A SIBLING THAT SHARES THE DAEMON'S NETWORK NAMESPACE.
#
# The production image is distroless — no shell, no HTTP client — and the status server binds loopback only,
# which is not relaxed for a test. So the request comes from a pinned container joined to the daemon's own
# network namespace, which is exactly how every other gate here reads it.
# ----------------------------------------------------------------------------------------------------------
readyz_body() {
  docker run --rm --network "container:$DAEMON_CONTAINER" "$VERIFY_IMAGE" \
    wget -q -T 5 -O - "http://${STATUS_ADDR}/readyz" 2>/dev/null
}

# ONE FIELD OUT OF /readyz. A field that is absent prints nothing rather than a zero, so an assertion about a
# missing field fails on a non-number instead of passing on a default.
readyz_field() { printf '%s' "$1" | node "$REL/out/jq.cjs" "$2"; }

# HOW LONG /readyz TOOK, IN MILLISECONDS, MEASURED ON THE HOST AROUND THE WHOLE REQUEST.
#
# IT IS AN UPPER BOUND AND IT IS DELIBERATELY UNFAIR TO THE PRODUCT. The elapsed time includes starting a
# container, which is tens to hundreds of milliseconds of Docker and none of it the daemon's. That is the
# right direction to be wrong in: the arm exists to catch a handler that WAITED for a probe, and a budget
# that a container start already eats most of still separates "answered from a stored sample" from "blocked
# for two seconds on a statfs".
READYZ_MS=0
READYZ_BODY=""
timed_readyz() {
  local started ended
  started="$(date +%s%3N)"
  set +e
  READYZ_BODY="$(readyz_body)"
  set -e
  ended="$(date +%s%3N)"
  READYZ_MS=$(( ended - started ))
}

await_readyz() {
  local attempts="${1:-120}" n=0
  while [ "$n" -lt "$attempts" ]; do
    if readyz_body | grep -q '"ready":true'; then return 0; fi
    n=$((n + 1)); sleep 0.5
  done
  return 1
}

# THE CONSUMER READS BYTES AND DIGESTS THEM, and it does so through its OWN bind, as its own uid.
#
# A dead FUSE mount answers `stat` from the kernel's attribute cache for a full attribute timeout after the
# connection is gone, so `test -f` here would pass over the exact state this gate exists to detect. This is
# also why the pre-fault control below is a digest and not a presence check.
consumer_sha() {
  docker exec -u 1000:1000 "$VERIFIER_CONTAINER" \
    sh -c "sha256sum '/media/projection/$ENTRY_PATH'" 2>/dev/null | awk '{print $1}'
}

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
SUBJECT_FILE="mount-truth-subject.bin"
SUBJECT_SIZE=$((8 * 1024 * 1024))
head -c "$SUBJECT_SIZE" /dev/urandom > "$WORK/media/$SUBJECT_FILE"
SUBJECT_SHA="$(node "$REL/out/sha.cjs" "$REL/media/$SUBJECT_FILE")"
ENTRY_PATH="Movies/Mount Truth Subject (2026)/Mount Truth Subject (2026).bin"

register root --id media --kind local
register version --key mount-truth-subject --size "$SUBJECT_SIZE" --mtime 2026-06-01T10:00:00.000Z
register entry --item "cccccccc-4444-4444-8444-cccccccccccc" --version-key mount-truth-subject \
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

# BEFORE, because that is the shipped consumer-attachment contract (§11 of the Phase 0 product contract): a
# bind taken while the path is a plain directory is a slave of the PARENT's peer group and follows every later
# mount at that path, while a bind taken over an existing mount belongs to that mount's group alone and is
# stranded the moment it goes. MT4 asks whether a consumer survives a remount, so a late binder would fail it
# for a reason that is about the bind and not about the product.
docker run -d --name "$VERIFIER_CONTAINER" --user 1000:1000 \
  -v "$WORK/mnt:/media/projection:rslave" "$VERIFY_IMAGE" \
  sh -c 'while :; do sleep 3600; done' >/dev/null
echo "  a persistent unprivileged consumer is attached to the mount point BEFORE anything is mounted there"

# ----------------------------------------------------------------------------------------------------------
step "the daemon serves, with --auto-remount, and the mount is observed"
# ----------------------------------------------------------------------------------------------------------
# `--auto-remount` IS ON FOR THE WHOLE RUN AND MT4 IS WHY: the recovery it performs is what restores the live
# observation. MT1 and MT2 are unaffected by it, and running two daemon configurations inside one run would
# mean the arms were not done to the same subject.
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

await_readyz || { docker logs "$DAEMON_CONTAINER" 2>&1 | tail -30 >&2; die "the daemon never became ready"; }
echo "  the daemon is ready"

# ----------------------------------------------------------------------------------------------------------
step "MT1 — the control: a live mount, observed live, with the consumer reading real bytes"
# ----------------------------------------------------------------------------------------------------------
# WITHOUT THIS ARM EVERY ARM BELOW IS SATISFIED BY A DAEMON THAT ANSWERS "not live" UNCONDITIONALLY, which is
# the unfailable-check shape this repository has found five separate times.

# THE SAMPLER IS GIVEN ITS OWN CADENCE TO PRODUCE A SAMPLE. Reading the field the instant the daemon answers
# ready would be reading it before the first probe had necessarily completed, and `unchecked` would then be a
# correct answer that this arm would have to score as a failure.
MT_SETTLE_S=$(( (MT_SAMPLE_MAX_AGE_MS / 1000) + 1 ))
sleep "$MT_SETTLE_S"

timed_readyz
MT1_OBSERVED="$(readyz_field "$READYZ_BODY" mountObserved)"
MT1_MOUNTED="$(readyz_field "$READYZ_BODY" mounted)"
MT1_AGE="$(readyz_field "$READYZ_BODY" mountObservedAgeMs)"
MT1_READYZ_MS="$READYZ_MS"

CONSUMER_SHA_BEFORE="$(consumer_sha)"
if [ "$MT1_OBSERVED" = "live-projectiond" ] && [ "$MT1_MOUNTED" = "true" ] \
   && [ -n "$CONSUMER_SHA_BEFORE" ] && [ "$CONSUMER_SHA_BEFORE" = "$SUBJECT_SHA" ]; then
  pass "MT1 the mount is observed live, mounted is true, and the consumer reads the right bytes" \
       "(observed=$MT1_OBSERVED mounted=$MT1_MOUNTED)"
else
  fail "MT1 observed=$MT1_OBSERVED mounted=$MT1_MOUNTED consumerDigestMatches=" \
       "$( [ "$CONSUMER_SHA_BEFORE" = "$SUBJECT_SHA" ] && echo yes || echo NO )"
fi

# ----------------------------------------------------------------------------------------------------------
step "MT5 — the sample is fresh while the daemon is healthy"
# ----------------------------------------------------------------------------------------------------------
# A STALE OBSERVATION MUST NOT BE READABLE AS A CURRENT ONE. The age is what carries that, and an arm that
# read the verdict without it would treat a minutes-old `live` as though it described now.
case "$MT1_AGE" in
  ''|*[!0-9]*) fail "MT5 the sample age is not a number (${MT1_AGE:-absent}), so freshness cannot be judged" ;;
  *)
    if [ "$MT1_AGE" -le "$MT_SAMPLE_MAX_AGE_MS" ]; then
      pass "MT5 the observation is ${MT1_AGE}ms old against a ceiling of ${MT_SAMPLE_MAX_AGE_MS}ms"
    else
      fail "MT5 the observation is ${MT1_AGE}ms old against a ceiling of ${MT_SAMPLE_MAX_AGE_MS}ms"
    fi ;;
esac

# ----------------------------------------------------------------------------------------------------------
step "MT2 — the divergence: the connection is aborted under a living daemon"
# ----------------------------------------------------------------------------------------------------------
set +e
ABORT_OUTPUT="$(bash "$WORK/out/fuse-abort.sh" "$WORK/mnt" 2>&1)"
set -e
echo "$ABORT_OUTPUT" | sed 's/^/  /'
case "$(echo "$ABORT_OUTPUT" | tail -1)" in
  abort:done*) echo "  the connection was torn down under a living daemon" ;;
  *) die "the fault could not be injected ($(echo "$ABORT_OUTPUT" | tail -1)), so nothing below is about it" ;;
esac

# THE OBSERVATION IS WAITED FOR, NOT SAMPLED ONCE. The sampler has its own cadence, so asking the instant the
# abort returns would ask before the next probe had run — and would record the daemon's PREVIOUS answer as
# though it were its answer to this fault.
MT2_OBSERVED=""
MT2_MOUNTED=""
MT2_READYZ_MS=0
n=0
while [ "$n" -lt 60 ]; do
  timed_readyz
  MT2_OBSERVED="$(readyz_field "$READYZ_BODY" mountObserved)"
  MT2_MOUNTED="$(readyz_field "$READYZ_BODY" mounted)"
  MT2_READYZ_MS="$READYZ_MS"
  [ "$MT2_OBSERVED" = "stale-projectiond" ] && break
  n=$((n + 1)); sleep 0.5
done

# THE WHOLE POINT OF THE TRANCHE IS THE TWO FIELDS DISAGREEING HERE. `mounted` is what the daemon remembers
# doing; `mountObserved` is what is actually there. A field that could never differ from the boolean would be
# the boolean under a second name.
if [ "$MT2_OBSERVED" = "stale-projectiond" ] && [ "$MT2_MOUNTED" = "true" ]; then
  pass "MT2 the mount is observed stale WHILE mounted is still true — belief and observation diverged"
else
  fail "MT2 observed=$MT2_OBSERVED mounted=$MT2_MOUNTED (wanted stale-projectiond while mounted stayed true)"
fi

# ----------------------------------------------------------------------------------------------------------
step "MT3 — /readyz answered inside its budget in every arm, including over a dead connection"
# ----------------------------------------------------------------------------------------------------------
# IF THE ENDPOINT HAD WAITED FOR A PROBE IT COULD NOT PASS THIS. The budget is strictly under the probe
# timeout by contract (`READYZ_CANNOT_HAVE_WAITED_FOR_A_PROBE`), and MT2's request is the one that matters:
# it is taken while the connection is dead, which is exactly when an inline statfs would block.
MT3_WORST="$MT1_READYZ_MS"
[ "$MT2_READYZ_MS" -gt "$MT3_WORST" ] && MT3_WORST="$MT2_READYZ_MS"
if [ "$MT3_WORST" -le "$MT_READYZ_LATENCY_BUDGET_MS" ]; then
  pass "MT3 the slowest /readyz was ${MT3_WORST}ms against ${MT_READYZ_LATENCY_BUDGET_MS}ms" \
       "(live ${MT1_READYZ_MS}ms, over a dead connection ${MT2_READYZ_MS}ms)"
else
  fail "MT3 the slowest /readyz was ${MT3_WORST}ms against ${MT_READYZ_LATENCY_BUDGET_MS}ms" \
       "(live ${MT1_READYZ_MS}ms, over a dead connection ${MT2_READYZ_MS}ms)"
fi

# ----------------------------------------------------------------------------------------------------------
step "MT4 — --auto-remount restores the live observation, and the consumer reads the same bytes"
# ----------------------------------------------------------------------------------------------------------
# THE CONSUMER IS THE ONE ATTACHED BEFORE THE FIRST MOUNT. Phase 2's worst defect recovered the namespace for
# the daemon and for nobody else, so an observation that returned to `live` while no consumer could read
# would be the same failure wearing this tranche's new field.
MT4_OBSERVED=""
MT4_READYZ_MS=0
n=0
while [ "$n" -lt 240 ]; do
  timed_readyz
  MT4_OBSERVED="$(readyz_field "$READYZ_BODY" mountObserved)"
  MT4_READYZ_MS="$READYZ_MS"
  [ "$MT4_OBSERVED" = "live-projectiond" ] && break
  n=$((n + 1)); sleep 0.5
done
[ "$MT4_READYZ_MS" -gt "$MT3_WORST" ] && MT3_WORST="$MT4_READYZ_MS"

CONSUMER_SHA_AFTER=""
n=0
while [ "$n" -lt 120 ]; do
  CONSUMER_SHA_AFTER="$(consumer_sha)"
  [ -n "$CONSUMER_SHA_AFTER" ] && break
  n=$((n + 1)); sleep 0.5
done

if [ "$MT4_OBSERVED" = "live-projectiond" ] && [ "$CONSUMER_SHA_AFTER" = "$SUBJECT_SHA" ]; then
  pass "MT4 the observation returned to live and the pre-attached consumer reads the same digest again"
else
  docker logs "$DAEMON_CONTAINER" 2>&1 | grep -E 'serve loop died|remount|stale' | tail -8 >&2 || true
  fail "MT4 observed=$MT4_OBSERVED consumerDigestMatches=" \
       "$( [ "$CONSUMER_SHA_AFTER" = "$SUBJECT_SHA" ] && echo yes || echo NO )"
fi

# ----------------------------------------------------------------------------------------------------------
step "CLEANUP — a success condition of this run, not a report about it"
# ----------------------------------------------------------------------------------------------------------
docker rm -f "$VERIFIER_CONTAINER" >/dev/null 2>&1 || true
docker stop -t 30 "$DAEMON_CONTAINER" >/dev/null 2>&1 || true
docker rm -f "$DAEMON_CONTAINER" >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
docker network rm "$NETWORK" >/dev/null 2>&1 || true

projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true
LEFT_MOUNTS="$(projection_gate_mounts_under "$WORK")"
CLEANED=1

# ----------------------------------------------------------------------------------------------------------
step "MT6 — the host is as it was found, asserted rather than reported"
# ----------------------------------------------------------------------------------------------------------
docker ps -a --format '{{.Names}}' | sort > "$GATE_ROOT/host-containers-after-$$.txt"
docker network ls --format '{{.Name}}' | sort > "$GATE_ROOT/host-networks-after-$$.txt"
docker volume ls --format '{{.Name}}'  | sort > "$GATE_ROOT/host-volumes-after-$$.txt"

MT6_OK=1
for what in containers networks volumes; do
  if ! diff -q "$GATE_ROOT/host-${what}-before-$$.txt" "$GATE_ROOT/host-${what}-after-$$.txt" >/dev/null; then
    MT6_OK=0
    echo "  the $what on this host changed across the run:" >&2
    diff "$GATE_ROOT/host-${what}-before-$$.txt" "$GATE_ROOT/host-${what}-after-$$.txt" >&2 || true
  fi
done
if [ "${LEFT_MOUNTS:-1}" != "0" ]; then
  MT6_OK=0
  echo "  ${LEFT_MOUNTS} mountpoint(s) left under this run's own directory" >&2
fi
if [ -d "$WORK" ]; then
  MT6_OK=0
  echo "  this run's own directory still exists" >&2
fi
if [ "$MT6_OK" -eq 1 ]; then
  pass "MT6 the container, network and volume SETS are identical, and this run's mountpoints and directory" \
       "are gone"
else
  fail "MT6 the host is not as it was found"
fi

# ----------------------------------------------------------------------------------------------------------
echo
if [ "$FAILED" -ne 0 ]; then
  echo "MOUNT-TRUTH GATE FAILED: $PASSED passed, $FAILED failed." >&2
  exit 1
fi
echo "MOUNT-TRUTH GATE PASSED: $PASSED of $PASSED arms. Exactly what was proved:"
echo "  - a live mount is OBSERVED live, with a pre-attached unprivileged consumer reading real bytes"
echo "    through its own bind and digest-matching a value recorded outside the mount;"
echo "  - after a guarded abort of this run's own connection, the daemon still BELIEVES it is mounted while"
echo "    the observation says stale — the divergence this field exists to make visible;"
echo "  - /readyz answered inside a budget strictly under the probe timeout in every arm, including over a"
echo "    dead connection, so it cannot have waited for a probe;"
echo "  - --auto-remount restored the live observation and the SAME consumer read the SAME digest again;"
echo "  - the observation was fresh whenever the daemon was healthy;"
echo "  - the host's container, network and volume SETS are identical, asserted rather than reported."
echo
echo "WHAT THIS GATE DOES NOT PROVE:"
echo "  - It closes only itself. It re-closes none of G7-G13, G18 or G22 and does not reopen Phase 3."
echo "  - A field is not a recovery: the daemon survives exactly what it survived before this tranche."
echo "  - No provider was contacted and none could be; the daemon was configured with no endpoint at all."
echo "  - It is not a load test. The latency figure is an upper bound including a container start, not a"
echo "    measurement of how fast the endpoint is."
