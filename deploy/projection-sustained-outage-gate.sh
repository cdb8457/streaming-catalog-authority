#!/usr/bin/env bash
# The SUSTAINED-OUTAGE gate: a provider that keeps taking every ranged request down with it, for longer than
# the circuit breaker's trip budget, and the daemon that must keep serving the snapshot while it burns down.
#
# WHAT THE GATE IS ABOUT. A provider outage is not a single failed request; it is every request, for a while.
# G26 already covers short-lived faults — one bad response, refreshed and retried. This gate covers what the
# breaker exists for: an endpoint that is STILL down after five counted failures, where refusing further
# requests locally is strictly better than sending them somewhere that is not answering. The design asserts
# four things: reads fail within a bounded deadline, the namespace does not churn (list/stat still answer from
# the snapshot, no entries vanish), the endpoint sees ZERO provider traffic while it is down, and the first
# read after the outage ends succeeds.
#
# THE OUTAGE IS A FAULT FOLLOWED BY A HOLD, AND THE ORDER IS THE HONEST MECHANISM.
#
# The design's reference to the Hold/Release control (`internal/fakewebdav/fakewebdav.go:407-428`) is where
# that control was first written. The daemon's adapter does not speak WebDAV: it resolves an access URL and
# then makes ranged HTTP GETs, so the endpoint here is `cmd/fakerange`, which serves the same Hold/Release
# control plus the fault injection (`internal/fakeprovider/fakeprovider.go:470-503`).
#
# A held ranged request that REACHES the provider blocks until the daemon's read deadline and then fails with
# CondReadDeadline — and that condition deliberately does NOT count toward the breaker (only endpoint-health
# conditions do: `CountsTowardEndpointBreaker` in `internal/source/source.go:121`). A gate that armed the
# hold first and then read would fail reads slowly and never trip the breaker at all, and it would fail for a
# reason unrelated to the gate it claimed to run. So the outage is staged the way an outage actually happens:
#
#   1. TRIP — the endpoint answers every ranged request with 503 for a moment. A 503 is CondSourceUnreachable,
#      which IS counted, and readpath retries each read up to three times, so a handful of reads records five
#      counted failures inside the 30s window and the breaker opens (5 failures / 30s window / 60s cooldown /
#      1 half-open probe — `NewBreaker(5, 30s, 60s, 1)`, `internal/daemon/daemon.go:184`).
#   2. HOLD — the object is held down for the rest of the outage. With the breaker open every further read is
#      refused locally in microseconds, before any packet could leave the host, so "zero provider traffic
#      during the hold" is measured rather than hoped for.
#   3. RELEASE — after the 60s cooldown has elapsed, the object is released and the first read is admitted as
#      the half-open probe. It must succeed: that is the breaker closing on real evidence.
#
# WHY NOTHING READS DURING THE COOLDOWN. A half-open probe that arrives while the hold is still armed would
# block until the read deadline and fail with the uncounted CondReadDeadline, leaving the breaker stuck
# half-open — probesIssued stays at one and every later read is refused forever. So the gate holds through the
# whole cooldown, releases only after it has elapsed, and only then reads. The stuck-half-open state is
# exactly the defect a probe test in `internal/source/limits.go` says cannot wedge, and this gate would be the
# first to see it if it came back.
#
# THE BOUNDED-DEADLINE ASSERTION IS CONFIGURED, NOT HOPED FOR. `readDeadlineMs` is set to 5000, which is what
# makes "bounded" a number rather than a feeling: every FUSE read that reaches the daemon has 5s to produce
# bytes. The fast-fail reads it asserts are far under that, and the gate's ceiling for them (4500ms) sits
# between the two shapes a slow read could take — refused by the open breaker (microseconds) or burned against
# a held request to the deadline (>= 5s plus container startup).
#
# WHAT THE GATE DOES NOT TOUCH. No media server, no real provider, no access material beyond the file-backed
# credential every resolver-mode gate uses, and NO DAEMON CHANGE: the breaker, the 503 classification, the
# readpath retry budget and the probe plan are all existing product behaviour. The design says the evidence is
# what is missing, and this file is it.
set -euo pipefail
# shellcheck source=deploy/projection-gate-cleanup.sh
. "$(cd "$(dirname "$0")" && pwd)/projection-gate-cleanup.sh"
export MSYS_NO_PATHCONV=1

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
GO_IMAGE="golang:1.26.5-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"

COMPOSE_FILE="docker-compose.projection-sustained-outage.yml"
NETWORK="projection-sustained-outage-gate"
PG_PORT="${PROJECTION_SUSTAINED_OUTAGE_GATE_PG_PORT:-5580}"
RANGE_PORT="${PROJECTION_SUSTAINED_OUTAGE_GATE_RANGE_PORT:-8155}"

MOUNT_CONTAINER="projection-sustained-outage-mount-$$"
RANGE_CONTAINER="projection-sustained-outage-range-$$"
STATUS_ADDR="127.0.0.1:9000"

GATE_ROOT="$PWD/.projection-sustained-outage-gate"
REL=".projection-sustained-outage-gate/run-$$"
WORK="$GATE_ROOT/run-$$"
MIB=$((1024 * 1024))

# THE READ AND BREAKER NUMBERS, EVERY ONE OF THEM OBSERVABLE, NONE OF THEM A COINCIDENCE.
#
# readDeadlineMs is the gate's own configuration and the bound every read during the outage is asserted
# against. The breaker's numbers — 5 failures within 30s to open, a 60s cooldown, one half-open probe — come
# from `internal/daemon/daemon.go:184` and are NOT configurable, so the gate derives its waits from them and
# would fail loudly if a refactor moved them.
READ_DEADLINE_MS=5000
BREAKER_THRESHOLD=5
BREAKER_COOLDOWN_S=60
# The ceiling for a fast-fail read, explained in the header: refused-by-open-breaker is microseconds, a held
# request burned to the deadline is >= READ_DEADLINE_MS, and this sits between them with room for `docker run`
# startup.
FAST_FAIL_CEILING_MS=4500

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_SUSTAINED_OUTAGE_GATE_PG_PORT="$PG_PORT"

cleanup() {
  docker rm -f "$MOUNT_CONTAINER" "$RANGE_CONTAINER" >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  if [ -n "${WORK:-}" ]; then
    projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true
    projection_gate_report_cleanliness "$GATE_ROOT" "$WORK" || true
  fi
}
trap cleanup EXIT

step() { echo; echo "=== $* ==="; }
die()  { echo "GATE FAILED: $*" >&2; exit 1; }

field()   { node "$REL/jq.cjs" "$1"; }
publish() { npx tsx src/ops/projection-publish-cli.ts --manifest-dir "$REL/manifest" "$@"; }
register(){ npx tsx src/ops/projection-register-cli.ts "$@"; }

# The endpoint's control surface. UNCOUNTED — a control request moves neither the range counter nor the
# resolution counter (`fakeprovider.go:468-503`), and it is reached over the published loopback port.
control()  { curl -fsS --max-time 15 "http://127.0.0.1:${RANGE_PORT}/control/$1" >/dev/null; }
range_requests() { curl -fsS --max-time 10 "http://127.0.0.1:${RANGE_PORT}/counters" | node "$REL/jq.cjs" rangeRequests; }
resolutions()    { curl -fsS --max-time 10 "http://127.0.0.1:${RANGE_PORT}/counters" | node "$REL/jq.cjs" resolutions; }

# A SINGLE 64KiB READ AT A BYTE OFFSET, THE SMALLEST UNIT THAT FORCES ONE BLOCK FETCH. `dd` fails with a
# nonzero status when the daemon returns EIO for the read, which is what the outage means to a media server.
read_block() {
  docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
    sh -c "dd if='/mnt/$ENTRY_PATH' bs=65536 skip=$(( $1 / 65536 )) count=1 of=/dev/null 2>/dev/null" >/dev/null 2>&1
}

# A read that is EXPECTED to fail during the outage, timed. Dies if it unexpectedly succeeded; prints the
# elapsed milliseconds. The read itself fails fast; the timing includes `docker run` startup.
timed_read_fail() {
  local start now
  start="$(date +%s%3N)"
  if read_block "$1"; then
    die "a read at $1 bytes unexpectedly succeeded during the outage"
  fi
  now="$(date +%s%3N)"
  echo $(( now - start ))
}

# The digest of one whole probe window read through the mount. Probe windows are exactly 1 MiB
# (`manifest.ProbeWindowBytes`), a multiple of the 64KiB read unit, so a count of `length / 65536` reads the
# window exactly.
window_digest() {
  docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
    sh -c "dd if='/mnt/$ENTRY_PATH' bs=65536 skip=$(( $1 / 65536 )) count=$(( $2 / 65536 )) 2>/dev/null | sha256sum | cut -d' ' -f1"
}

entry_identity() {
  docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
    sh -c "stat -c '%i:%s:%Y' '/mnt/$ENTRY_PATH'"
}

dir_listing() {
  docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
    sh -c "ls '/mnt/$ENTRY_DIR'"
}

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

cat > "$WORK/objects.cjs" <<'OBJECTS'
const { readFileSync } = require('node:fs');
const objects = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const object = objects.find((entry) => entry.ref === process.argv[3]);
if (process.argv[4] === 'sha256') console.log(object.sha256);
else if (process.argv[4] === 'size') console.log(object.size);
else console.log(object.probes.map((p) => [p.position, p.offset, p.length, p.sha256].join(':')).join(' '));
OBJECTS

# One named probe window's offset, length and digest, so the gate can read exactly the window that carries
# the digest it will compare against.
cat > "$WORK/probe.cjs" <<'PROBE'
const { readFileSync } = require('node:fs');
const objects = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const object = objects.find((entry) => entry.ref === process.argv[3]);
const probe = object.probes.find((p) => p.position === process.argv[4]);
if (probe === undefined) process.exit(1);
console.log([probe.offset, probe.length, probe.sha256].join(':'));
PROBE

mkdir -p "$WORK/manifest" "$WORK/cache" "$WORK/mnt" "$WORK/out" "$WORK/secret"
chmod 755 "$GATE_ROOT" "$WORK"
chmod 777 "$WORK/cache" "$WORK/mnt" "$WORK/out"

# ----------------------------------------------------------------------------------------------------------
step "checking this host can host the gate at all"
# ----------------------------------------------------------------------------------------------------------
GATE_SKIP_STATUS="${GATE_SKIP_STATUS:-77}"
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no /dev/fuse is reachable from a container on this host." >&2
  echo "      The sustained-outage gate is entirely UNPROVEN here. Nothing in this gate ran, and this run" >&2
  echo "      closes NO acceptance gate. It is not a pass and must not be reported as one." >&2
  exit "$GATE_SKIP_STATUS"
fi
echo "  /dev/fuse is reachable from a container"
npx tsx src/ops/projection-host-preflight-cli.ts propagation --path "$GATE_ROOT" --require
npx tsx src/ops/projection-host-preflight-cli.ts traversal --path "$GATE_ROOT" --path "$WORK"

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
step "starting the endpoint in resolver mode, with a file-backed credential"
# ----------------------------------------------------------------------------------------------------------
# THE CREDENTIAL IS A FILE ON BOTH SIDES AND A VALUE ON NEITHER, exactly as in the lease gate: the endpoint
# reads it from a file and the daemon is configured with a PATH, so a configuration that leaked could not
# leak a token. It is high-entropy so the leak assertion has an exact string to search for.
TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d " \n")"
printf '%s' "$TOKEN" > "$WORK/secret/endpoint-token"
# 0600, BECAUSE THE DAEMON REFUSES ANYTHING WIDER, AND IT IS RIGHT TO. A credential that anybody on the host
# can read is not a credential.
chmod 600 "$WORK/secret/endpoint-token"
LEASE_MARKER="lease-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d " \n")"

OBJECT_REF="obj-sustained-outage"
OBJECT_SIZE=$((64 * MIB))

docker run -d --name "$RANGE_CONTAINER" --network "$NETWORK" --network-alias fakerange \
  -p "127.0.0.1:${RANGE_PORT}:8099" \
  -v "$PWD:/workspace" -w /workspace/projectiond -v "$WORK/out:/out" \
  -v "$WORK/secret:/secret:ro" \
  -e GOFLAGS=-buildvcs=false -e GOTOOLCHAIN=local -e CGO_ENABLED=0 \
  "$GO_IMAGE" go run ./cmd/fakerange --addr 0.0.0.0:8099 \
  --lease-prefix "$LEASE_MARKER" --lease-ttl 1h --token-file /secret/endpoint-token \
  --public-base-url "http://fakerange:8099" \
  --object "${OBJECT_REF}:${OBJECT_SIZE}" \
  --emit /out/objects.json >/dev/null

echo "  waiting for the endpoint to come up"
ready=0
for _ in $(seq 1 180); do
  if curl -fsS --max-time 5 "http://127.0.0.1:${RANGE_PORT}/counters" >/dev/null 2>&1 \
     && [ -s "$WORK/out/objects.json" ]; then
    ready=1; break
  fi
  sleep 1
done
test "$ready" -eq 1 || { docker logs "$RANGE_CONTAINER" 2>&1 | tail -20 >&2; die "the endpoint never came up"; }
echo "  the endpoint is in resolver mode and serves one $OBJECT_SIZE-byte object"

PROBES="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$OBJECT_REF" probes)"
PROBE_FLAGS=""
for probe in $PROBES; do PROBE_FLAGS="$PROBE_FLAGS --probe $probe"; done
HEAD_PROBE="$(node "$REL/probe.cjs" "$REL/out/objects.json" "$OBJECT_REF" head)"
TAIL_PROBE="$(node "$REL/probe.cjs" "$REL/out/objects.json" "$OBJECT_REF" tail)"
HEAD_OFFSET="${HEAD_PROBE%%:*}"
HEAD_REST="${HEAD_PROBE#*:}"
HEAD_LENGTH="${HEAD_REST%%:*}"
HEAD_DIGEST="${HEAD_REST##*:}"
TAIL_OFFSET="${TAIL_PROBE%%:*}"
TAIL_REST="${TAIL_PROBE#*:}"
TAIL_LENGTH="${TAIL_REST%%:*}"
TAIL_DIGEST="${TAIL_REST##*:}"
echo "  the head probe window is ${HEAD_OFFSET}+${HEAD_LENGTH} bytes; the tail probe window is ${TAIL_OFFSET}+${TAIL_LENGTH} bytes"

# ----------------------------------------------------------------------------------------------------------
step "seeding the catalog and publishing generation 1"
# ----------------------------------------------------------------------------------------------------------
ENTRY_PATH="Movies/Sustained Outage Subject (2026)/Sustained Outage Subject (2026).bin"
ENTRY_DIR="Movies/Sustained Outage Subject (2026)"

register root --id vault --kind http-range
# shellcheck disable=SC2086
register version --key sustained-subject --size "$OBJECT_SIZE" --mtime 2026-06-01T10:00:00.000Z $PROBE_FLAGS
register entry --item "cccccccc-3333-4333-8333-cccccccccccc" --version-key sustained-subject \
  --path "$ENTRY_PATH" --source "http-range:vault:${OBJECT_REF}"
publish > "$WORK/out/publish-1.json"
test "$(field outcome < "$WORK/out/publish-1.json")" = "published" || die "generation 1 was not published"
GENERATION_1="$(field generationId < "$WORK/out/publish-1.json")"
echo "  generation 1 published"

# ----------------------------------------------------------------------------------------------------------
step "mounting with the production image, in resolver mode with a file-backed credential"
# ----------------------------------------------------------------------------------------------------------
# `readDeadlineMs` is the gate's own bound: every read that reaches the daemon has this long to produce bytes,
# and "fails within a bounded deadline" is asserted against exactly this number.
cat > "$WORK/config.json" <<'JSON'
{
  "mountPoint": "/mnt/projection",
  "pointerPath": "/var/lib/projectiond/manifest/pointer.json",
  "probeCacheDir": "/var/lib/projectiond/cache",
  "readDeadlineMs": 5000,
  "statusAddr": "127.0.0.1:9000",
  "endpoints": [
    {
      "id": "vault",
      "resolverUrl": "http://fakerange:8099/resolve",
      "allowedOrigins": ["http://fakerange:8099"],
      "tokenFile": "/var/lib/projectiond/secret/endpoint-token",
      "allowInsecureHttp": true,
      "allowPrivateAddresses": true
    }
  ]
}
JSON

docker run -d --name "$MOUNT_CONTAINER" \
  --network "$NETWORK" --user 0:0 \
  --cap-drop ALL --cap-add SYS_ADMIN --security-opt apparmor:unconfined \
  --device /dev/fuse:/dev/fuse \
  -v "$WORK/manifest:/var/lib/projectiond/manifest:ro" \
  -v "$WORK/cache:/var/lib/projectiond/cache" \
  -v "$WORK/secret:/var/lib/projectiond/secret:ro" \
  -v "$WORK/config.json:/etc/projectiond/config.json:ro" \
  -v "$WORK/mnt:/mnt/projection:rshared" \
  "$IMAGE" --config /etc/projectiond/config.json --poll 2s --strict-direct-mount >/dev/null

echo "  waiting for the daemon to be ready and the namespace to be visible"
await_readyz || { docker logs "$MOUNT_CONTAINER" 2>&1 | tail -30 >&2; die "the daemon never became ready"; }
await_namespace || { docker logs "$MOUNT_CONTAINER" 2>&1 | tail -30 >&2; die "the mount never became visible"; }
echo "  /readyz answers ready=true and the entry is visible through the mount"

# ----------------------------------------------------------------------------------------------------------
step "warming the scan cache and recording the baseline"
# ----------------------------------------------------------------------------------------------------------
# THE HEAD WINDOW IS READ WHILE THE PROVIDER IS HEALTHY, and its digest is verified against the endpoint's own
# probe plan, recorded OUTSIDE the mount. It then lives in the probe cache for the whole gate, so a read of it
# during the outage is a read of the SNAPSHOT and must succeed with the same bytes.
WARM_SHA="$(window_digest "$HEAD_OFFSET" "$HEAD_LENGTH")"
test "$WARM_SHA" = "$HEAD_DIGEST" \
  || die "the warm head-window read through the mount did not match the endpoint's own digest"
echo "  the head window reads correctly through the mount and is now cached"

IDENT_BEFORE="$(entry_identity)"
LISTING_BEFORE="$(dir_listing)"
RR_BASELINE="$(range_requests)"
echo "  baseline identity=${IDENT_BEFORE}; listing='${LISTING_BEFORE}'; rangeRequests=${RR_BASELINE}"

# ----------------------------------------------------------------------------------------------------------
step "tripping the breaker — the endpoint answers 503 until it has failed enough to open"
# ----------------------------------------------------------------------------------------------------------
# THE 503 FAULT IS THE TRIP, AND THE COUNTERS PROVE IT LANDED. Each failing read is retried up to three times
# by readpath, so two reads record five counted failures inside the 30s window and the breaker opens. The
# counter delta proves the 503s actually reached the endpoint rather than being refused locally for some other
# reason, and the zero-resolution delta proves the warm read had already minted the lease.
RR_BEFORE="$(range_requests)"
RES_BEFORE="$(resolutions)"
control "fault/${OBJECT_REF}?fault=status-503&times=6"
echo "  status-503 is armed for the subject object"

TRIP1_MS="$(timed_read_fail $(( 8 * MIB )))"
test "$TRIP1_MS" -lt "$READ_DEADLINE_MS" || die "the first faulted read took ${TRIP1_MS}ms"
TRIP2_MS="$(timed_read_fail $(( 12 * MIB )))"
test "$TRIP2_MS" -lt "$READ_DEADLINE_MS" || die "the second faulted read took ${TRIP2_MS}ms"
echo "  both faulted reads failed within the ${READ_DEADLINE_MS}ms deadline: ${TRIP1_MS}ms and ${TRIP2_MS}ms"

RR_AFTER="$(range_requests)"
RES_AFTER="$(resolutions)"
RR_TRIP=$(( RR_AFTER - RR_BEFORE ))
RES_TRIP=$(( RES_AFTER - RES_BEFORE ))
test "$RR_TRIP" -ge "$BREAKER_THRESHOLD" \
  || die "only ${RR_TRIP} ranged request(s) reached the endpoint during the trip; the 503s did not land"
test "$RES_TRIP" -eq 0 \
  || die "${RES_TRIP} resolution(s) happened during the trip; the warm read should already have minted the lease"
echo "  ${RR_TRIP} ranged request(s) were failed with 503 at the endpoint, with ${RES_TRIP} resolution(s)"

control "fault/${OBJECT_REF}?fault=&times=0"
echo "  the 503 fault is disarmed"

# THE BREAKER-OPEN OBSERVATION. With the fault gone and the provider healthy, a read at a fresh offset can
# only fail fast if the breaker is refusing it locally — and the zero counter delta proves no packet left the
# host to find out.
RR_BEFORE="$(range_requests)"
VERIFY_MS="$(timed_read_fail $(( 16 * MIB )))"
test "$VERIFY_MS" -lt "$FAST_FAIL_CEILING_MS" \
  || die "a read with the breaker open took ${VERIFY_MS}ms; the fast-fail ceiling is ${FAST_FAIL_CEILING_MS}ms"
RR_AFTER="$(range_requests)"
test "$(( RR_AFTER - RR_BEFORE ))" -eq 0 \
  || die "$(( RR_AFTER - RR_BEFORE )) ranged request(s) reached the provider after the trip"
echo "  the breaker is open: a read at an uncached offset failed in ${VERIFY_MS}ms with zero provider traffic"
TRIP_END_S="$(date +%s)"

# ----------------------------------------------------------------------------------------------------------
step "the outage is sustained — the object is held, reads fail fast, and the namespace does not change"
# ----------------------------------------------------------------------------------------------------------
# THE HOLD IS THE OUTAGE CONTINUING, and it stays armed through the breaker's whole cooldown. Nothing reads
# during that wait — a half-open probe hitting the hold would burn the deadline and wedge the breaker, so the
# release happens only after the cooldown has elapsed.
control "hold/${OBJECT_REF}"
echo "  the object is held down; the outage continues"

# NO METADATA CHURN. Lookup, GetAttr and ReadDir answer from the pinned snapshot and never reach the provider,
# so the entry keeps its inode, size and mtime, the listing keeps its one entry, and the pointer does not move.
IDENT_NOW="$(entry_identity)"
test "$IDENT_NOW" = "$IDENT_BEFORE" || die "the entry identity changed once the outage started"
LISTING_NOW="$(dir_listing)"
test "$LISTING_NOW" = "$LISTING_BEFORE" || die "the directory listing changed once the outage started"
test "$(field generationId < "$WORK/manifest/pointer.json")" = "$GENERATION_1" \
  || die "a new generation was published across the outage"
echo "  the namespace is the snapshot: same identity, same listing, same generation"

# THE SNAPSHOT STILL SERVES ITS CACHED BYTES. A window cached before the outage reads correctly during it;
# only bytes that would have to come from the dead provider are unavailable.
CACHED_SHA="$(window_digest "$HEAD_OFFSET" "$HEAD_LENGTH")"
test "$CACHED_SHA" = "$HEAD_DIGEST" \
  || die "a previously cached window no longer reads correctly during the outage"
echo "  a window cached before the outage still reads correctly, from the snapshot"

# ZERO PROVIDER TRAFFIC DURING THE HOLD, measured across three failing reads at fresh offsets.
RR_BEFORE="$(range_requests)"
RES_BEFORE="$(resolutions)"
for OFF in 20 24 28; do
  MS="$(timed_read_fail $(( OFF * MIB )))"
  test "$MS" -lt "$FAST_FAIL_CEILING_MS" \
    || die "a held-outage read at $(( OFF * MIB )) bytes took ${MS}ms; the fast-fail ceiling is ${FAST_FAIL_CEILING_MS}ms"
  echo "  read at $(( OFF * MIB )) bytes failed in ${MS}ms"
done
RR_AFTER="$(range_requests)"
RES_AFTER="$(resolutions)"
test "$(( RR_AFTER - RR_BEFORE ))" -eq 0 \
  || die "$(( RR_AFTER - RR_BEFORE )) ranged request(s) reached the provider during the hold"
test "$(( RES_AFTER - RES_BEFORE ))" -eq 0 \
  || die "$(( RES_AFTER - RES_BEFORE )) resolution(s) happened during the hold"
echo "  zero provider traffic during the hold: every read was refused locally by the open breaker"

# ----------------------------------------------------------------------------------------------------------
step "the outage ends — after the cooldown, the first read after release succeeds with the same bytes"
# ----------------------------------------------------------------------------------------------------------
# The breaker opened when the fifth 503 was recorded; the cooldown runs 60s from then. The gate sleeps out the
# remainder, HOLDING the object the whole time and reading nothing, so the release lands after the cooldown
# and the first read is the half-open probe.
REMAINING=$(( TRIP_END_S + BREAKER_COOLDOWN_S + 3 - $(date +%s) ))
if [ "$REMAINING" -gt 0 ]; then
  echo "  holding the object down for ${REMAINING}s more, so the release lands after the breaker cooldown"
  sleep "$REMAINING"
fi
control "release/${OBJECT_REF}"
echo "  the object is released; the outage is over"

# THE FIRST READ AFTER RELEASE, at the COLD tail window — never fetched, so it must come from the provider now.
# Its digest is compared against the endpoint's own tail probe, recorded outside the mount.
READ_START="$(date +%s%3N)"
RECOVERY_SHA="$(window_digest "$TAIL_OFFSET" "$TAIL_LENGTH")"
RECOVERY_MS=$(( $(date +%s%3N) - READ_START ))
test "$RECOVERY_SHA" = "$TAIL_DIGEST" \
  || die "the post-release read served different bytes than the endpoint's tail probe"
test "$RECOVERY_MS" -lt "$READ_DEADLINE_MS" \
  || die "the recovery read took ${RECOVERY_MS}ms"
echo "  the first read after release succeeded in ${RECOVERY_MS}ms and matched the tail probe digest"

test "$(docker inspect -f '{{.State.Status}}' "$MOUNT_CONTAINER")" = "running" \
  || die "the daemon process did not survive the outage"
readyz_ready || die "/readyz is not ready after the outage"
echo "  the daemon never exited and /readyz still answers ready=true"

# THE NAMESPACE IS STILL THE SNAPSHOT AT THE END OF THE WHOLE OUTAGE.
IDENT_END="$(entry_identity)"
test "$IDENT_END" = "$IDENT_BEFORE" || die "the entry identity changed by the end of the gate"
LISTING_END="$(dir_listing)"
test "$LISTING_END" = "$LISTING_BEFORE" || die "the directory listing changed by the end of the gate"
echo "  the namespace is exactly what it was before the outage: identity and listing unchanged"

# NO ACCESS MATERIAL REACHED DISK. The lease prefix and the credential are both high-entropy, so finding none
# of them MEANS something: the probe cache and the manifest are where either would end up if the daemon ever
# wrote one down.
LEAKS=0
if grep -rl "$TOKEN" "$WORK/cache" "$WORK/manifest" "$WORK/out" >/dev/null 2>&1; then LEAKS=1; fi
if grep -rl "$LEASE_MARKER" "$WORK/cache" "$WORK/manifest" >/dev/null 2>&1; then LEAKS=1; fi
test "$LEAKS" -eq 0 || die "an access lease or the endpoint credential reached the cache, the manifest or the report"
echo "  no lease and no credential in the probe cache, the manifest or the report"

echo
echo "SUSTAINED-OUTAGE GATE COMPLETE: a provider that failed every ranged request and then stayed down"
echo "past the breaker's 60s cooldown cost zero provider traffic, failed reads within the ${READ_DEADLINE_MS}ms"
echo "deadline, left the namespace untouched, and the first read after release served the same bytes the"
echo "endpoint's own probe plan promised. The cleanup trap unmounts and removes the run directory."
