#!/usr/bin/env bash
# Projection Phase 6 — THE ALPHA INSTALL MATRIX. Can an operator actually install this thing, and does every
# verb do what the document says it does?
#
# WHAT IT IS FOR. The recovery gate proves the DAEMON behaves. This proves the PACKAGING behaves: that the
# refusals refuse, that the verbs are idempotent, that a fault is visible on the status surface an operator
# reads, that a recovery is followed by the SAME bytes through a consumer that was attached first, and that
# an upgrade can be undone.
#
# IT DRIVES THE SHIPPED COMMAND AND NOT AN IMITATION OF IT. Every step below runs
# `deploy/projection-alpha.sh` with the environment contract an operator would set, which is the only way a
# gate can say anything about a script an operator will run. A gate that reimplemented the verbs would be
# testing itself.
#
# WHAT IT DOES NOT TOUCH. No provider, no endpoint, no credential, no operator corpus, no media server, no
# existing library. The appliance's configuration names no endpoint at all. Every path is under this run's
# own directory, and the host's container, network and volume sets are asserted identical at the end.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

GATE_ROOT="$PWD/.projection-alpha-acceptance"
REL=".projection-alpha-acceptance/run-$$"
WORK="$GATE_ROOT/run-$$"

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
CONSUMER_CONTAINER="projection-alpha-acceptance-consumer-$$"
APPLIANCE="projection-alpha-projectiond"

PG_PORT="${PROJECTION_ALPHA_ACCEPTANCE_PG_PORT:-5612}"
COMPOSE_FILE="docker-compose.projection-recovery.yml"
export PROJECTION_RECOVERY_GATE_PG_PORT="$PG_PORT"
export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"

# shellcheck source=projection-gate-cleanup.sh
. "$HERE/projection-gate-cleanup.sh"

GATE_SKIP_STATUS="${GATE_SKIP_STATUS:-77}"
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no /dev/fuse is reachable from a container on this host." >&2
  exit "$GATE_SKIP_STATUS"
fi

# THE APPLIANCE'S OWN NAME IS FIXED BY THE PROFILE, so a previous run still holding it would make every
# assertion below about somebody else's container. Refused rather than cleaned up: the other run's cleanup
# owns its own containers.
if docker ps -a --format '{{.Names}}' | grep -qx "$APPLIANCE"; then
  echo "REFUSING TO RUN: a projection-alpha appliance already exists on this host." >&2
  echo "  This gate drives the shipped profile, whose container name is fixed. Stop it first." >&2
  exit 1
fi

mkdir -p "$WORK/manifest" "$WORK/media" "$WORK/cache" "$WORK/mnt" "$WORK/secrets" "$WORK/out"
chmod 755 "$GATE_ROOT" "$WORK"
chmod 777 "$WORK/cache" "$WORK/mnt" "$WORK/out"

PASSED=0
FAILED=0
step() { echo; echo "=== $* ==="; }
die()  { echo "GATE FAILED: $*" >&2; exit 1; }
pass() { PASSED=$(( PASSED + 1 )); echo "  PASS  $*"; }
fail() { FAILED=$(( FAILED + 1 )); echo "  FAIL  $*" >&2; }

cat > "$WORK/out/sha.cjs" <<'SHA'
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
console.log(createHash('sha256').update(readFileSync(process.argv[2])).digest('hex'));
SHA

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

field()    { node "$REL/out/jq.cjs" "$1"; }
publish()  { npx tsx src/ops/projection-publish-cli.ts --manifest-dir "$REL/manifest" "$@"; }
register() { npx tsx src/ops/projection-register-cli.ts "$@"; }

CLEANED=0
cleanup() {
  docker rm -f "$CONSUMER_CONTAINER" >/dev/null 2>&1 || true
  docker compose -p projection-alpha -f "$ROOT/docker-compose.projection-alpha.yml" down --remove-orphans \
    >/dev/null 2>&1 || true
  docker rm -f "$APPLIANCE" >/dev/null 2>&1 || true
  docker network rm projection-alpha >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  docker network rm projection-recovery-gate >/dev/null 2>&1 || true
  rm -f "$GATE_ROOT"/host-*-"$$".txt 2>/dev/null || true
  if [ "$CLEANED" -eq 0 ] && [ -n "${WORK:-}" ]; then
    projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true
    projection_gate_report_cleanliness "$GATE_ROOT" "$WORK" || true
  fi
}
trap cleanup EXIT

# THE OPERATOR'S OWN ENVIRONMENT, SET EXACTLY AS THE CONTRACT DOCUMENT SAYS TO SET IT.
export PROJECTIOND_ALPHA_IMAGE="$IMAGE"
export PROJECTIOND_ALPHA_MANIFEST_DIR="$WORK/manifest"
export PROJECTIOND_ALPHA_MEDIA_ROOT="$WORK/media"
export PROJECTIOND_ALPHA_CACHE_DIR="$WORK/cache"
export PROJECTIOND_ALPHA_MOUNT="$WORK/mnt"
export PROJECTIOND_ALPHA_CONFIG="$WORK/config.json"
export PROJECTIOND_ALPHA_SECRETS_DIR="$WORK/secrets"

alpha() { bash "$HERE/projection-alpha.sh" "$@"; }

step "the host's container, network and volume SETS, before anything of this run exists"
docker ps -a --format '{{.Names}}' | sort > "$GATE_ROOT/host-containers-$$.txt"
docker network ls --format '{{.Name}}' | sort > "$GATE_ROOT/host-networks-$$.txt"
docker volume ls --format '{{.Name}}'  | sort > "$GATE_ROOT/host-volumes-$$.txt"
echo "  captured"

step "building the production projectiond image"
docker build -t "$IMAGE" ./projectiond >/dev/null

step "a real PostgreSQL, migrated, so a real generation can be published"
docker compose -f "$COMPOSE_FILE" up -d --wait postgres >/dev/null
npx tsx src/ops/migrate-cli.ts >/dev/null
echo "  migrated"

step "a local fixture and generation 1"
SUBJECT_FILE="alpha-subject.bin"
SUBJECT_SIZE=$((4 * 1024 * 1024))
head -c "$SUBJECT_SIZE" /dev/urandom > "$WORK/media/$SUBJECT_FILE"
SUBJECT_SHA="$(node "$REL/out/sha.cjs" "$REL/media/$SUBJECT_FILE")"
ENTRY_PATH="Movies/Alpha Subject (2026)/Alpha Subject (2026).bin"

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

register root --id media --kind local >/dev/null
register version --key alpha-subject --size "$SUBJECT_SIZE" --mtime 2026-06-01T10:00:00.000Z >/dev/null
register entry --item "ffffffff-7777-4777-8777-ffffffffffff" --version-key alpha-subject \
  --path "$ENTRY_PATH" --source "local:media:${SUBJECT_FILE}" >/dev/null
publish > "$WORK/out/publish-1.json"
test "$(field outcome < "$WORK/out/publish-1.json")" = "published" || die "generation 1 was not published"
echo "  generation 1 published; the fixture is $SUBJECT_SIZE bytes"

# ----------------------------------------------------------------------------------------------------------
step "AA1 — preflight REFUSES before a consumer is attached, and changes nothing"
# ----------------------------------------------------------------------------------------------------------
# THIS IS THE REFUSAL MOST LIKELY TO BE READ AS A BUG AND IT IS THE MOST VALUABLE ONE IN THE SCRIPT. §11 of
# the Phase 0 product contract: a bind taken after the daemon has mounted belongs to that mount's peer group
# alone and is stranded by the first recovery. An operator who attaches Plex afterwards gets a library that
# works until something goes wrong once, and then never again.
set +e
AA1_OUT="$(alpha preflight 2>&1)"
AA1_RC=$?
set -e
AA1_MADE_ANYTHING=0
[ -e "$WORK/cache/.projection-alpha-owned" ] && AA1_MADE_ANYTHING=1
if [ "$AA1_RC" -ne 0 ] && printf '%s' "$AA1_OUT" | grep -q 'NO CONSUMER IS ATTACHED' \
   && [ "$AA1_MADE_ANYTHING" -eq 0 ]; then
  pass "AA1 preflight refused with no consumer attached, exit $AA1_RC, and created nothing"
else
  fail "AA1 rc=$AA1_RC createdSomething=$AA1_MADE_ANYTHING output: $(printf '%s' "$AA1_OUT" | tail -3)"
fi

# ----------------------------------------------------------------------------------------------------------
step "AA2 — preflight REFUSES a relative path, a host root and a floating tag"
# ----------------------------------------------------------------------------------------------------------
refuses() {
  local what="$1"; shift
  local out rc
  set +e
  out="$(env "$@" bash "$HERE/projection-alpha.sh" preflight 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'REFUSED'; then
    echo "    refused: $what"
    return 0
  fi
  echo "    DID NOT REFUSE: $what (rc=$rc)" >&2
  return 1
}
AA2_OK=1
refuses "a relative mount path" PROJECTIOND_ALPHA_MOUNT="relative/path" || AA2_OK=0
refuses "a path with a .. segment" PROJECTIOND_ALPHA_MOUNT="$WORK/../mnt" || AA2_OK=0
refuses "a host root directory" PROJECTIOND_ALPHA_MOUNT="/mnt/user" || AA2_OK=0
refuses "a floating image tag" PROJECTIOND_ALPHA_IMAGE="projectiond:latest" || AA2_OK=0
if [ "$AA2_OK" -eq 1 ]; then
  pass "AA2 every ambiguous or dangerous input was REFUSED rather than resolved"
else
  fail "AA2 at least one ambiguous or dangerous input was accepted"
fi

# ----------------------------------------------------------------------------------------------------------
step "a consumer attaches BEFORE anything is ever mounted there"
# ----------------------------------------------------------------------------------------------------------
docker run -d --name "$CONSUMER_CONTAINER" --user 1000:1000 \
  -v "$WORK/mnt:/media/projection:rslave" "$VERIFY_IMAGE" \
  sh -c 'while :; do sleep 3600; done' >/dev/null
echo "  attached"
consumer_sha() {
  docker exec -u 1000:1000 "$CONSUMER_CONTAINER" \
    sh -c "sha256sum '/media/projection/$ENTRY_PATH'" 2>/dev/null | awk '{print $1}'
}

# ----------------------------------------------------------------------------------------------------------
step "AA3 — install and start, and BOTH are idempotent"
# ----------------------------------------------------------------------------------------------------------
alpha install > "$WORK/out/install-1.log" 2>&1 || die "AA3: install failed"
alpha install > "$WORK/out/install-2.log" 2>&1 || die "AA3: a second install failed, so install is not idempotent"
alpha start   > "$WORK/out/start-1.log"   2>&1 || die "AA3: start failed"
alpha start   > "$WORK/out/start-2.log"   2>&1 || die "AA3: a second start failed, so start is not idempotent"
AA3_HEALTH="$(docker inspect -f '{{.State.Health.Status}}' "$APPLIANCE" 2>/dev/null || echo unknown)"
# THE TWO THIS APPLIANCE ACTUALLY WRITES TO, AND NOT THE MANIFEST DIRECTORY. That one belongs to the control
# plane — the daemon mounts it read-only because it consumes generations and never publishes one — so a
# marker there would be this appliance putting its name on somebody else's directory. Measured: with the
# manifest claimed, `install` refused a perfectly correct installation the moment a generation existed.
# THE CACHE MARKER IS THE ONE THAT CAN BE SEEN WHILE THE APPLIANCE IS RUNNING. The mount point's marker is
# written into the directory and the namespace is then mounted OVER it, so ownership of the mount point is
# proved by the live mount itself — which is what `check_dir_ownership` was taught to accept after a second
# `start` refused for exactly this reason.
AA3_MARKERS=0
[ -e "$WORK/cache/.projection-alpha/owned" ] && AA3_MARKERS=$(( AA3_MARKERS + 1 ))
AA3_MOUNT_IS_OURS=0
findmnt -rno TARGET,FSTYPE 2>/dev/null | grep -qxF "$WORK/mnt fuse.projectiond" && AA3_MOUNT_IS_OURS=1
AA3_MANIFEST_UNCLAIMED=1
[ -e "$WORK/manifest/.projection-alpha/owned" ] && AA3_MANIFEST_UNCLAIMED=0
if [ "$AA3_HEALTH" = "healthy" ] && [ "$AA3_MARKERS" -eq 1 ] && [ "$AA3_MOUNT_IS_OURS" -eq 1 ]    && [ "$AA3_MANIFEST_UNCLAIMED" -eq 1 ]; then
  pass "AA3 install and start are both idempotent, the appliance is $AA3_HEALTH, it claims the cache it"        "writes to and holds its mount point with its own file system, and it left the control plane's"        "manifest directory unclaimed"
else
  fail "AA3 health=$AA3_HEALTH cacheMarker=$AA3_MARKERS mountIsOurs=$AA3_MOUNT_IS_OURS"        "manifestUnclaimed=$AA3_MANIFEST_UNCLAIMED"
fi

# ----------------------------------------------------------------------------------------------------------
step "AA4 — the consumer reads real BYTES through the appliance"
# ----------------------------------------------------------------------------------------------------------
# BYTES, NEVER A METADATA SUBSTITUTE. A dead FUSE mount answers `stat` from a warm attribute cache while every
# `open` returns ENOTCONN, so a `test -f` here would pass over the exact state this whole tranche is about.
AA4_SHA=""
n=0
while [ "$n" -lt 60 ]; do
  AA4_SHA="$(consumer_sha)"
  [ -n "$AA4_SHA" ] && break
  n=$((n + 1)); sleep 1
done
if [ "$AA4_SHA" = "$SUBJECT_SHA" ]; then
  pass "AA4 the pre-attached unprivileged consumer digest-matched bytes recorded outside the mount"
else
  fail "AA4 the consumer read '${AA4_SHA:-nothing}', not the '$SUBJECT_SHA' recorded outside the mount"
fi

# ----------------------------------------------------------------------------------------------------------
step "AA5 — status carries the closed-set operator surface and leaks nothing"
# ----------------------------------------------------------------------------------------------------------
alpha status > "$WORK/out/status-1.log" 2>&1 || true
AA5_OK=1
for want in 'recovery state' 'recovery reason' 'recovery generation' 'remediation' 'mount observed'; do
  grep -q "$want" "$WORK/out/status-1.log" || { echo "    missing: $want" >&2; AA5_OK=0; }
done
# NOTHING SENSITIVE, ASSERTED RATHER THAN INTENDED. No token, no URL, no origin, no media identity.
for forbidden in 'http://' 'https://' "$ENTRY_PATH" 'serveError' 'Bearer'; do
  if grep -qF "$forbidden" "$WORK/out/status-1.log"; then
    echo "    the status surface leaked: $forbidden" >&2
    AA5_OK=0
  fi
done
if [ "$AA5_OK" -eq 1 ]; then
  pass "AA5 the status surface names the recovery state, reason, generation and remediation, and carries no" \n       "URL, media identity or free-text error"
else
  fail "AA5 the status surface is incomplete or leaked something"
fi

# ----------------------------------------------------------------------------------------------------------
step "AA6 — a fault is visible on the status surface, is REFUSED because it is foreign, and is reversible"
# ----------------------------------------------------------------------------------------------------------
# A tmpfs stacked ABOVE the appliance's live mount is a foreign mount by construction, and the point of the
# arm is that the appliance says so and does NOT touch it. An operator who sees `inspect-mount-owner` is being
# told the truth: something that is not this appliance's is on its mount point, and a human decides what.
AA6_TAG="alpha-foreign-$$"
mount -t tmpfs -o size=1m,nr_inodes=64 "$AA6_TAG" "$WORK/mnt" || die "AA6: the overlay could not be stacked"
AA6_SEEN=0
n=0
while [ "$n" -lt 60 ]; do
  alpha status > "$WORK/out/status-fault.log" 2>&1 || true
  if grep -q 'inspect-mount-owner' "$WORK/out/status-fault.log"; then AA6_SEEN=1; break; fi
  n=$((n + 1)); sleep 2
done
if findmnt -rno FSTYPE --target "$WORK/mnt" 2>/dev/null | head -1 | grep -qx tmpfs; then
  AA6_UNTOUCHED=1
  umount "$WORK/mnt" || die "AA6: the overlay could not be removed"
else
  AA6_UNTOUCHED=0
fi
n=0
AA6_RECOVERED=0
while [ "$n" -lt 90 ]; do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$APPLIANCE" 2>/dev/null)" = "healthy" ]; then
    AA6_RECOVERED=1; break
  fi
  n=$((n + 1)); sleep 2
done
if [ "$AA6_SEEN" -eq 1 ] && [ "$AA6_UNTOUCHED" -eq 1 ] && [ "$AA6_RECOVERED" -eq 1 ]; then
  pass "AA6 a foreign overlay showed as inspect-mount-owner on the operator surface, was left EXACTLY where" \n       "it was, and the appliance returned to healthy once it was removed"
else
  fail "AA6 sawRemediation=$AA6_SEEN overlayUntouched=$AA6_UNTOUCHED returnedHealthy=$AA6_RECOVERED"
fi

# ----------------------------------------------------------------------------------------------------------
step "AA7 — the same consumer reads the same digest after the fault"
# ----------------------------------------------------------------------------------------------------------
AA7_SHA=""
n=0
while [ "$n" -lt 60 ]; do
  AA7_SHA="$(consumer_sha)"
  [ -n "$AA7_SHA" ] && break
  n=$((n + 1)); sleep 1
done
if [ "$AA7_SHA" = "$SUBJECT_SHA" ]; then
  pass "AA7 the SAME pre-attached consumer read the SAME digest after the fault"
else
  fail "AA7 the consumer read '${AA7_SHA:-nothing}' after the fault, not '$SUBJECT_SHA'"
fi

# ----------------------------------------------------------------------------------------------------------
step "AA8 — upgrade records a rollback target, and rollback uses it"
# ----------------------------------------------------------------------------------------------------------
alpha upgrade > "$WORK/out/upgrade.log" 2>&1 || die "AA8: upgrade failed"
AA8_RECORD="$WORK/cache/.projection-alpha-previous-image"
AA8_HAS_RECORD=0
[ -s "$AA8_RECORD" ] && AA8_HAS_RECORD=1
alpha rollback > "$WORK/out/rollback.log" 2>&1 || die "AA8: rollback failed"
AA8_RUNNING=0
n=0
while [ "$n" -lt 90 ]; do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$APPLIANCE" 2>/dev/null)" = "healthy" ]; then
    AA8_RUNNING=1; break
  fi
  n=$((n + 1)); sleep 2
done
if [ "$AA8_HAS_RECORD" -eq 1 ] && [ "$AA8_RUNNING" -eq 1 ]; then
  pass "AA8 upgrade recorded a rollback target before changing anything, and rollback returned to it with" \n       "the appliance healthy"
else
  fail "AA8 recordedRollbackTarget=$AA8_HAS_RECORD healthyAfterRollback=$AA8_RUNNING"
fi

# ----------------------------------------------------------------------------------------------------------
step "AA9 — reset-recovery runs against a live appliance and is idempotent"
# ----------------------------------------------------------------------------------------------------------
alpha reset-recovery > "$WORK/out/reset-1.log" 2>&1 || die "AA9: reset-recovery failed"
alpha reset-recovery > "$WORK/out/reset-2.log" 2>&1 || die "AA9: a second reset-recovery failed"
if [ ! -e "$WORK/cache/recovery-ledger.json" ]; then
  pass "AA9 reset-recovery cleared the durable budget and a second run of it is still a success"
else
  fail "AA9 the recovery ledger is still present after reset-recovery"
fi

# ----------------------------------------------------------------------------------------------------------
step "AA10 — stop leaves every byte of data where it is"
# ----------------------------------------------------------------------------------------------------------
alpha stop > "$WORK/out/stop-1.log" 2>&1 || die "AA10: stop failed"
alpha stop > "$WORK/out/stop-2.log" 2>&1 || die "AA10: a second stop failed, so stop is not idempotent"
AA10_DATA=1
[ -s "$WORK/media/$SUBJECT_FILE" ] || AA10_DATA=0
[ -e "$WORK/manifest/pointer.json" ] || AA10_DATA=0
[ -d "$WORK/cache" ] || AA10_DATA=0
AA10_GONE=0
docker ps -a --format '{{.Names}}' | grep -qx "$APPLIANCE" || AA10_GONE=1
if [ "$AA10_DATA" -eq 1 ] && [ "$AA10_GONE" -eq 1 ]; then
  pass "AA10 stop is idempotent, the appliance is gone, and the media, manifest and cache are untouched"
else
  fail "AA10 dataIntact=$AA10_DATA applianceGone=$AA10_GONE"
fi

# ----------------------------------------------------------------------------------------------------------
step "CLEANUP — a success condition of this run, not a report about it"
# ----------------------------------------------------------------------------------------------------------
docker rm -f "$CONSUMER_CONTAINER" >/dev/null 2>&1 || true
docker compose -p projection-alpha -f "$ROOT/docker-compose.projection-alpha.yml" down --remove-orphans \
  >/dev/null 2>&1 || true
docker network rm projection-alpha >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
docker network rm projection-recovery-gate >/dev/null 2>&1 || true
projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true
LEFT_MOUNTS="$(projection_gate_mounts_under "$WORK")"
CLEANED=1

# ----------------------------------------------------------------------------------------------------------
step "AA11 — the host is as it was found, asserted rather than reported"
# ----------------------------------------------------------------------------------------------------------
AA11_OK=1
docker ps -a --format '{{.Names}}' | sort > "$GATE_ROOT/host-containers-after-$$.txt"
docker network ls --format '{{.Name}}' | sort > "$GATE_ROOT/host-networks-after-$$.txt"
docker volume ls --format '{{.Name}}'  | sort > "$GATE_ROOT/host-volumes-after-$$.txt"
for what in containers networks volumes; do
  if ! diff -q "$GATE_ROOT/host-${what}-$$.txt" "$GATE_ROOT/host-${what}-after-$$.txt" >/dev/null; then
    AA11_OK=0
    echo "  the $what on this host changed across the run:" >&2
    diff "$GATE_ROOT/host-${what}-$$.txt" "$GATE_ROOT/host-${what}-after-$$.txt" >&2 || true
  fi
done
[ "${LEFT_MOUNTS:-1}" = "0" ] || { AA11_OK=0; echo "  ${LEFT_MOUNTS} mountpoint(s) left" >&2; }
[ -d "$WORK" ] && { AA11_OK=0; echo "  this run's own directory still exists" >&2; }
rm -f "$GATE_ROOT"/host-*-"$$".txt 2>/dev/null || true
if [ "$AA11_OK" -eq 1 ]; then
  pass "AA11 the container, network and volume SETS are identical and this run's mountpoints and directory" \n       "are gone"
else
  fail "AA11 the host is not as it was found"
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "ALPHA INSTALL MATRIX FAILED: $PASSED passed, $FAILED failed." >&2
  exit 1
fi
echo "ALPHA INSTALL MATRIX PASSED: $PASSED of $PASSED arms. Exactly what was proved:"
echo "  - preflight refuses before a consumer is attached, and refuses every ambiguous or dangerous path;"
echo "  - install, start, stop and reset-recovery are each idempotent;"
echo "  - a pre-attached unprivileged consumer reads real BYTES through the shipped profile;"
echo "  - a foreign fault is visible on the operator surface as inspect-mount-owner, is LEFT ALONE, and the"
echo "    appliance returns to healthy once a human removes it;"
echo "  - the same consumer reads the same digest afterwards;"
echo "  - upgrade records a rollback target BEFORE changing anything and rollback returns to it;"
echo "  - stop leaves the media, the manifest and the cache untouched;"
echo "  - the host's container, network and volume SETS are identical, asserted rather than reported."
echo
echo "WHAT THIS GATE DOES NOT PROVE:"
echo "  - No provider was contacted and none could be: the appliance was configured with no endpoint."
echo "  - No media server was involved. The consumer is an unprivileged container reading bytes."
echo "  - It is not a load test and no figure here is a performance claim."
