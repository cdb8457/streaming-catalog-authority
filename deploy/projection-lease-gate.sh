#!/usr/bin/env bash
# The ACCESS-LEASE gate: G24, G25 and G26, against the production projectiond over a real FUSE mount.
#
# WHAT THESE THREE ARE ABOUT, AND WHY NO MEDIA SERVER APPEARS. G7-G13 ask whether a real media server can read
# the projection. These ask something narrower and further down: whether the daemon's TRANSPORT RESOLUTION
# behaves when the short-lived access material it was handed lapses underneath a read that is already in
# flight. A scanner's timing would add nothing but noise, so the reader here is synthetic and the acceptance
# plan says so.
#
# WHAT WAS ALREADY BUILT AND WHAT WAS NOT. The daemon's lease path was COMPLETE before this gate existed:
# `internal/source/resolver.go` carries single-flight resolution, a refresh cooldown, an egress allowlist and a
# lease type that redacts itself, and `internal/source/http.go` spends exactly ONE refresh per read and then
# `terminalize`s so a refresh can never lead to another. Nothing in the product was missing. What was missing
# was the evidence, and this file is it.
#
# EVERY LAPSE AND EVERY FAULT IS AN EVENT THIS GATE CAUSES, NOT A RACE IT HOPES FOR.
#
# The obvious way to write G24 is a lease TTL shorter than the read. That gate passes or fails on which of two
# things happened first: too long and the read finishes before the lapse, too short and the lease is dead
# before the read starts. This repository has already paid for that shape twice — a byte budget that sat
# between two legitimate read patterns, and a scan window that was warm or cold depending on when a snapshot
# was taken. So the TTL here is an HOUR, nothing expires by accident, and the lapse happens at the moment the
# gate chooses through `/control/expire-leases`, between two reads it controls.
#
# THE CONTROL SURFACE IS UNCOUNTED AND ISOLATED. `/control/...` moves neither the range counter nor the
# resolution counter — a control request that spent the budget would widen the very thing these gates measure,
# and a Go test pins that. The endpoint is reachable only on this gate's own private Docker network and its
# published port is bound to 127.0.0.1.
#
# EVERYTHING IS BOUNDED. Every readiness probe, read and wait has a hard deadline; a hang fails the gate rather
# than occupying the machine.
set -euo pipefail
# shellcheck source=deploy/projection-gate-cleanup.sh
. "$(cd "$(dirname "$0")" && pwd)/projection-gate-cleanup.sh"
export MSYS_NO_PATHCONV=1

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
GO_IMAGE="golang:1.26.5-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"

COMPOSE_FILE="docker-compose.projection-lease.yml"
NETWORK="projection-lease-gate"
PG_PORT="${PROJECTION_LEASE_GATE_PG_PORT:-5540}"
RANGE_PORT="${PROJECTION_LEASE_GATE_RANGE_PORT:-8150}"
# The origin the disallowed-host fault names. It is a REAL listener this gate stands up, on a port the daemon
# was never told about, precisely so "the daemon did not contact it" is an observation rather than a DNS
# failure dressed up as one.
TRAP_PORT="${PROJECTION_LEASE_GATE_TRAP_PORT:-8151}"

MOUNT_CONTAINER="projection-lease-mount-$$"
RANGE_CONTAINER="projection-lease-range-$$"
TRAP_CONTAINER="projection-lease-trap-$$"
READER_CONTAINER="projection-lease-reader-$$"

GATE_ROOT="$PWD/.projection-lease-gate"
REL=".projection-lease-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

# THE REFRESH COOLDOWN IS CONFIGURED HERE AND ASSERTED AGAINST ITSELF. G25's "fails fast" ceiling is derived
# from this number in `lease-gates.ts`, so moving it moves the ceiling and neither can drift from the other.
# THE COOLDOWN IS LONG ENOUGH TO LAND INSIDE, AND EVERY WAIT BELOW IS DERIVED FROM IT.
#
# The measured window has to open INSIDE the cooldown the setup failure starts, and two `docker run`s sit
# between them at a second or two each. Five seconds left that to luck. Twenty gives bounded margin without
# touching what is asserted: `lease-gates.ts` derives G25's fast-failure ceiling from this same number, so
# moving it moves the ceiling and the two cannot drift apart.
COOLDOWN_MS=20000
COOLDOWN_S=$(( COOLDOWN_MS / 1000 ))

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_LEASE_GATE_PG_PORT="$PG_PORT"

cleanup() {
  docker rm -f "$READER_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$MOUNT_CONTAINER" "$RANGE_CONTAINER" "$TRAP_CONTAINER" >/dev/null 2>&1 || true
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
lease()   { npx tsx src/ops/projection-lease-gate-cli.ts "$@" --results "$REL/out/results.json"; }

# The endpoint's control surface. UNCOUNTED, and reached over the published loopback port.
control() { curl -fsS --max-time 15 "http://127.0.0.1:${RANGE_PORT}/control/$1" >/dev/null; }
counters(){ lease counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/$1"; }

mkdir -p "$WORK/manifest" "$WORK/media" "$WORK/cache" "$WORK/mnt" "$WORK/out" "$WORK/secret"
chmod 755 "$GATE_ROOT" "$WORK"
chmod 777 "$WORK/cache" "$WORK/mnt" "$WORK/out"

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

# EVERY EMBEDDED SCRIPT IS A FILE IN A QUOTED HEREDOC, not an inline `node -e "..."` spanning lines.
# `test/custody-runtime-closure.ts` parses every shipped script and refuses a line whose quotes do not close
# on it, because an unreadable line is one a "does this region contain X" gate answers "no" for.
cat > "$WORK/delta.cjs" <<'DELTA'
const { readFileSync } = require('node:fs');
const [, , before, after, key] = process.argv;
const a = JSON.parse(readFileSync(before, 'utf8'));
const b = JSON.parse(readFileSync(after, 'utf8'));
console.log(b[key] - a[key]);
DELTA

cat > "$WORK/g26-record.cjs" <<'G26REC'
const { readFileSync, writeFileSync } = require('node:fs');
const [, , path, fault, bytes, failed] = process.argv;
const seen = JSON.parse(readFileSync(path, 'utf8'));
seen.push({ fault, bytesAccepted: Number(bytes), readFailed: failed === 'true' });
writeFileSync(path, JSON.stringify(seen));
G26REC

cat > "$WORK/objects.cjs" <<'OBJECTS'
const { readFileSync } = require('node:fs');
const objects = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const object = objects.find((entry) => entry.ref === process.argv[3]);
if (process.argv[4] === 'sha256') console.log(object.sha256);
else if (process.argv[4] === 'size') console.log(object.size);
else console.log(object.probes.map((p) => [p.position, p.offset, p.length, p.sha256].join(':')).join(' '));
OBJECTS

# The seven identity fields G24 pins, read from the mount and from the published manifest. `stat` gives the
# inode, the size and the mtime a media server would see; the manifest gives the four ids.
cat > "$WORK/identity.cjs" <<'IDENT'
const { readFileSync, statSync, readdirSync } = require('node:fs');
const [, , mountPath, manifestDir, entryPath, out] = process.argv;
const pointer = JSON.parse(readFileSync(`${manifestDir}/pointer.json`, 'utf8'));
const artifact = readdirSync(manifestDir).find((name) => name.startsWith('generation-'));
const manifest = JSON.parse(readFileSync(`${manifestDir}/${artifact}`, 'utf8'));
const entry = manifest.entries.find((candidate) => candidate.path === entryPath);
if (entry === undefined) throw new Error('the manifest does not carry the entry the gate is pinning');
const source = entry.sources[0];
const stat = statSync(mountPath);
require('node:fs').writeFileSync(out, `${JSON.stringify({
  projectedEntryId: entry.projectedEntryId,
  generationId: pointer.generationId,
  sourceId: source.sourceId,
  sourceGeneration: source.sourceGeneration,
  inode: String(stat.ino),
  sizeBytes: String(stat.size),
  mtime: String(Math.trunc(stat.mtimeMs)),
  sequence: String(pointer.sequence),
}, null, 2)}\n`);
IDENT

# ----------------------------------------------------------------------------------------------------------
step "checking this host can host the gate at all"
# ----------------------------------------------------------------------------------------------------------
GATE_SKIP_STATUS=77
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no /dev/fuse is reachable from a container on this host." >&2
  echo "      G24, G25 and G26 are entirely UNPROVEN here. Nothing in this gate ran, and this run closes NO" >&2
  echo "      acceptance gate. It is not a pass and must not be reported as one." >&2
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
step "starting the endpoint in EXPIRING-LEASE mode, with a file-backed credential"
# ----------------------------------------------------------------------------------------------------------
# THE CREDENTIAL IS A FILE ON BOTH SIDES AND A VALUE ON NEITHER. The endpoint reads it from a file and the
# daemon is configured with a PATH; there is no field in either that holds a token, so a configuration that
# leaked could not leak one. It is high-entropy so the redaction assertions have an exact string to search for.
TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d " \n")"
printf '%s' "$TOKEN" > "$WORK/secret/endpoint-token"
# 0600, BECAUSE THE DAEMON REFUSES ANYTHING WIDER, AND IT IS RIGHT TO.
#  fails a credential whose mode has any group or world bit set: "a credential that
# anybody on the host can read is not a credential". The first version of this gate wrote 644 and the read
# died with an I/O error the reader could only report as "standard input". The gate was wrong and the
# product was right, which is the outcome a gate should be able to have.
#
# BOTH SIDES CAN STILL READ IT: the daemon and the endpoint both run as root in their containers.
chmod 600 "$WORK/secret/endpoint-token"
LEASE_MARKER="lease-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d " \n")"

OBJECT_REF="obj-projection-lease"
OBJECT_SIZE=$((32 * 1024 * 1024))
# TWO OBJECTS, AND THE SECOND IS NOT A CONVENIENCE.
#
# G24 reads its subject WHOLE — it has to, because the digest recorded outside the mount is over the whole
# object and that is the only comparison worth making. That leaves every byte of it in the daemon's cache,
# so a stampede pointed at the same object reaches the provider ZERO times. The first version of this gate
# did exactly that and G25 failed on its own floor, correctly, saying no lease had lapsed.
#
# So G25 and G26 read a SECOND, LARGE object, and every phase takes its own 4 MiB-ALIGNED offset — aligned
# because the daemon fetches in demand blocks, and two offsets inside one block are one fetch.
OBJECT_B_REF="obj-projection-lease-cold"
OBJECT_B_SIZE=$((256 * 1024 * 1024))
MIB=$((1024 * 1024))

# THE TRAP LISTENER. It is a second endpoint on a port the daemon's allowlist does NOT name, and the
# disallowed-host fault points at it. "The daemon never contacted the host it was told to" is only evidence if
# something was listening to notice, and this is that something.
docker run -d --name "$TRAP_CONTAINER" --network "$NETWORK" --network-alias trap \
  -p "127.0.0.1:${TRAP_PORT}:8099" \
  -v "$PWD:/workspace" -w /workspace/projectiond \
  -e GOFLAGS=-buildvcs=false -e GOTOOLCHAIN=local -e CGO_ENABLED=0 \
  "$GO_IMAGE" go run ./cmd/fakerange --addr 0.0.0.0:8099 \
  --object "trap-object:1024" >/dev/null

docker run -d --name "$RANGE_CONTAINER" --network "$NETWORK" --network-alias fakerange \
  -p "127.0.0.1:${RANGE_PORT}:8099" \
  -v "$PWD:/workspace" -w /workspace/projectiond -v "$WORK/out:/out" \
  -v "$WORK/secret:/secret:ro" \
  -e GOFLAGS=-buildvcs=false -e GOTOOLCHAIN=local -e CGO_ENABLED=0 \
  "$GO_IMAGE" go run ./cmd/fakerange --addr 0.0.0.0:8099 \
  --lease-prefix "$LEASE_MARKER" --lease-ttl 1h --token-file /secret/endpoint-token \
  --public-base-url "http://fakerange:8099" \
  --disallowed-host-url "http://trap:8099/direct/trap-object" \
  --object "${OBJECT_REF}:${OBJECT_SIZE}" --object "${OBJECT_B_REF}:${OBJECT_B_SIZE}" \
  --emit /out/objects.json >/dev/null

echo "  waiting for both endpoints to come up"
ready=0
for _ in $(seq 1 180); do
  if curl -fsS --max-time 5 "http://127.0.0.1:${RANGE_PORT}/counters" >/dev/null 2>&1 \
     && curl -fsS --max-time 5 "http://127.0.0.1:${TRAP_PORT}/counters" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
test "$ready" -eq 1 || { docker logs "$RANGE_CONTAINER" 2>&1 | tail -20 >&2; die "the endpoints never answered"; }
# THE DESCRIPTOR IS THE READINESS SIGNAL, NOT THE COUNTERS. `cmd/fakerange` starts serving BEFORE it
# computes each object's whole-object digest, so /counters answers while --emit is still being written.
# With a 256 MiB object that gap is seconds wide, and the first run to use one failed inside it.
ready=0
for _ in $(seq 1 180); do
  if [ -s "$WORK/out/objects.json" ]; then ready=1; break; fi
  sleep 1
done
test "$ready" -eq 1 \
  || { docker logs "$RANGE_CONTAINER" 2>&1 | tail -20 >&2; die "the endpoint never emitted its object descriptor"; }
OBJECT_SHA="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$OBJECT_REF" sha256)"
echo "  the endpoint is in resolver mode and serves one $OBJECT_SIZE-byte object"

# ----------------------------------------------------------------------------------------------------------
step "seeding the catalog and publishing generation 1"
# ----------------------------------------------------------------------------------------------------------
ENTRY_PATH="Movies/Projection Lease Subject (2026)/Projection Lease Subject (2026).bin"
ENTRY_B_PATH="Movies/Projection Lease Cold (2026)/Projection Lease Cold (2026).bin"
PROBES="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$OBJECT_REF" probes)"
PROBE_FLAGS=""
for probe in $PROBES; do PROBE_FLAGS="$PROBE_FLAGS --probe $probe"; done
register root --id vault --kind http-range
# shellcheck disable=SC2086
register version --key lease-subject --size "$OBJECT_SIZE" --mtime 2026-06-01T10:00:00.000Z $PROBE_FLAGS
register entry --item "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" --version-key lease-subject \
  --path "$ENTRY_PATH" --source "http-range:vault:${OBJECT_REF}"
PROBES_B="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$OBJECT_B_REF" probes)"
PROBE_FLAGS_B=""
for probe in $PROBES_B; do PROBE_FLAGS_B="$PROBE_FLAGS_B --probe $probe"; done
# shellcheck disable=SC2086
register version --key lease-cold --size "$OBJECT_B_SIZE" --mtime 2026-06-01T10:00:00.000Z $PROBE_FLAGS_B
register entry --item "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" --version-key lease-cold \
  --path "$ENTRY_B_PATH" --source "http-range:vault:${OBJECT_B_REF}"
publish > "$WORK/out/publish-1.json"
test "$(field outcome < "$WORK/out/publish-1.json")" = "published" || die "generation 1 was not published"
GENERATION_1="$(field generationId < "$WORK/out/publish-1.json")"
echo "  generation 1 published"

# ----------------------------------------------------------------------------------------------------------
step "mounting with the production image, in RESOLVER mode with a file-backed credential"
# ----------------------------------------------------------------------------------------------------------
cat > "$WORK/config.json" <<JSON
{
  "mountPoint": "/mnt/projection",
  "pointerPath": "/var/lib/projectiond/manifest/pointer.json",
  "probeCacheDir": "/var/lib/projectiond/cache",
  "endpoints": [
    {
      "id": "vault",
      "resolverUrl": "http://fakerange:8099/resolve",
      "allowedOrigins": ["http://fakerange:8099"],
      "tokenFile": "/var/lib/projectiond/secret/endpoint-token",
      "allowInsecureHttp": true,
      "allowPrivateAddresses": true,
      "refreshCooldownMs": ${COOLDOWN_MS}
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

echo "  waiting for the namespace to become visible to another container"
ready=0
for _ in $(seq 1 120); do
  if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
      sh -c "test -f '/mnt/$ENTRY_PATH' && test -f '/mnt/$ENTRY_B_PATH'" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
test "$ready" -eq 1 || { docker logs "$MOUNT_CONTAINER" 2>&1 | tail -30 >&2; die "the mount never became visible"; }

# ----------------------------------------------------------------------------------------------------------
step "G24 — a lease lapses under a read that is already in flight"
# ----------------------------------------------------------------------------------------------------------
# THE HANDLE SPANS THE LAPSE. The reader opens the entry, reads its first megabyte through file descriptor 3,
# signals, waits, and then reads THE REST OF THE FILE THROUGH THE SAME DESCRIPTOR. The gate lapses every
# outstanding lease in between. If the daemon did not re-resolve, the second half could not arrive at all.
# THE HEREDOC IS QUOTED, AND THE PATH ARRIVES AS AN ARGUMENT.
#
# An UNQUOTED heredoc body containing a command substitution really executes it at write time, and
# `test/custody-runtime-closure.ts` refuses every shipped script that has one — it parses each of them under
# all three line endings and will not skip past a live command. The first version of this used `<<PINNED`
# so that $ENTRY_PATH would expand, and its escaped arithmetic tripped exactly that rule.
cat > "$WORK/out/pinned-read.sh" <<'PINNED'
set -eu
target="$1"
exec 3< "$target"
dd bs=1024 count=1024 <&3 > /out/g24-part.bin
echo opened > /out/g24-handle-open
attempt=0
while [ ! -f /out/g24-release ]; do
  attempt=$(( attempt + 1 ))
  test "$attempt" -lt 240 || { echo "the release never arrived" >&2; exit 1; }
  sleep 0.5
done
cat <&3 >> /out/g24-part.bin
exec 3<&-
# ATOMIC, OR THE WAITER READS AN EMPTY FILE. A redirect CREATES the file before sha256sum has hashed 32 MiB,
# so a gate polling for its existence can read nothing and call it a digest mismatch.
sha256sum /out/g24-part.bin | cut -d" " -f1 > /out/g24-digest.tmp
mv /out/g24-digest.tmp /out/g24-digest.txt
PINNED

node "$REL/identity.cjs" "$WORK/mnt/$ENTRY_PATH" "$WORK/manifest" "$ENTRY_PATH" "$WORK/out/identity-before.json"

rm -f "$WORK/out/g24-handle-open" "$WORK/out/g24-release" "$WORK/out/g24-digest.txt"
docker run -d --name "$READER_CONTAINER" --user 65534:65534 --cap-drop ALL \
  -v "$WORK/mnt:/mnt:rslave" -v "$WORK/out:/out" "$VERIFY_IMAGE" sh /out/pinned-read.sh "/mnt/$ENTRY_PATH" >/dev/null

ready=0
for _ in $(seq 1 120); do
  if [ -f "$WORK/out/g24-handle-open" ]; then ready=1; break; fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "--- reader logs ---" >&2; docker logs "$READER_CONTAINER" 2>&1 | tail -30 >&2
  echo "--- daemon logs ---" >&2; docker logs "$MOUNT_CONTAINER" 2>&1 | tail -40 >&2
  echo "--- endpoint logs ---" >&2; docker logs "$RANGE_CONTAINER" 2>&1 | tail -20 >&2
  die "the reader never opened its handle"
fi
echo "  the handle is open and one megabyte has been read through it"

# THE WINDOW OPENS HERE, after the handle is open and before anything lapses.
counters counters-g24-before.json
control expire-leases
echo "  every outstanding lease has been lapsed, deliberately"
touch "$WORK/out/g24-release"

echo "  waiting for the pinned read to finish across the lapse"
ready=0
for _ in $(seq 1 240); do
  if [ -f "$WORK/out/g24-digest.txt" ]; then ready=1; break; fi
  if ! docker ps --format '{{.Names}}' | grep -q "^${READER_CONTAINER}$"; then break; fi
  sleep 0.5
done
test "$ready" -eq 1 || { docker logs "$READER_CONTAINER" 2>&1 | tail -20 >&2; die "the pinned read never completed"; }
docker rm -f "$READER_CONTAINER" >/dev/null 2>&1 || true

# The endpoint must have finished writing before the window closes, or the byte columns describe nothing.
sleep 1
counters counters-g24-after.json
node "$REL/identity.cjs" "$WORK/mnt/$ENTRY_PATH" "$WORK/manifest" "$ENTRY_PATH" "$WORK/out/identity-after.json"

G24_DIGEST="$(tr -d " \r\n" < "$WORK/out/g24-digest.txt")"
DIGEST_OK=false
[ "$G24_DIGEST" = "$OBJECT_SHA" ] && DIGEST_OK=true
G24_BYTES="$(wc -c < "$WORK/out/g24-part.bin" | tr -d " ")"
# The digests are over SYNTHETIC content and are safe to print; the byte counts are what say WHERE a
# mismatch came from — a short read and a wrong read are different defects.
echo "  the pinned read produced $G24_BYTES of $OBJECT_SIZE bytes"
if [ "$DIGEST_OK" != "true" ]; then
  echo "  read digest   $G24_DIGEST" >&2
  echo "  expected      $OBJECT_SHA" >&2
fi

# NO NEW GENERATION WAS PUBLISHED, and the media server is told nothing. There is no media server here, so
# what stands in for "told nothing" is the namespace: the pointer has not moved and the entry's own identity
# is byte-identical, which is the whole of what a server could have observed.
GENERATION_NOW="$(field generationId < "$WORK/manifest/pointer.json")"
test "$GENERATION_NOW" = "$GENERATION_1" \
  || die "a new generation was published across the refresh, and G24 says none may be"

lease g24 --before "$REL/out/counters-g24-before.json" --after "$REL/out/counters-g24-after.json" \
  --digest-ok "$DIGEST_OK" \
  --identity-before "$REL/out/identity-before.json" --identity-after "$REL/out/identity-after.json"

# ----------------------------------------------------------------------------------------------------------
step "G25 — twenty concurrent opens meet ONE expired lease"
# ----------------------------------------------------------------------------------------------------------
# EACH READER TAKES A DIFFERENT, UNCACHED OFFSET, so every one of them genuinely needs the provider. Twenty
# readers on the same offset would be answered by the daemon's own single-flight over the READ, and the gate
# would be measuring that instead of resolution single-flight.
# QUOTED, for the same reason, with the projected path passed in.
cat > "$WORK/out/stampede.sh" <<'STAMPEDE'
set -eu
target="$1"
i=1
while [ "$i" -le 20 ]; do
  # FOUR MIB APART, so every reader needs its OWN demand block. Two offsets inside one block are one fetch,
  # and the gate would then be measuring the daemon's read single-flight rather than resolution
  # single-flight, which is what G25 is about.
  offset=$(( i * 4 * 1024 * 1024 ))
  (
    if dd if="$target" bs=65536 skip=$(( offset / 65536 )) count=1 of=/dev/null 2>/dev/null; then
      echo ok > "/out/stampede-$i.done"
    else
      echo fail > "/out/stampede-$i.done"
    fi
  ) &
  echo started > "/out/stampede-$i.started"
  i=$(( i + 1 ))
done
wait
echo done > /out/stampede-complete
STAMPEDE

rm -f "$WORK/out/stampede-"*.started "$WORK/out/stampede-"*.done "$WORK/out/stampede-complete"
# A LEASE MUST EXIST BEFORE IT CAN LAPSE. One read of the cold object mints one, at an offset no later
# phase touches, so what the stampede meets is a STALE lease rather than no lease at all.
docker run --rm --user 65534:65534 --cap-drop ALL -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
  sh -c "dd if='/mnt/$ENTRY_B_PATH' bs=65536 skip=$(( 200 * MIB / 65536 )) count=1 of=/dev/null" \
  >/dev/null 2>&1 || die "the cold object could not be read, so no lease was ever minted"
control expire-leases
counters counters-g25-before.json
docker run --rm --name "${READER_CONTAINER}-s" --user 65534:65534 --cap-drop ALL \
  -v "$WORK/mnt:/mnt:rslave" -v "$WORK/out:/out" "$VERIFY_IMAGE" sh /out/stampede.sh "/mnt/$ENTRY_B_PATH" >/dev/null 2>&1 || true
test -f "$WORK/out/stampede-complete" || die "the stampede never completed"
sleep 1
counters counters-g25-after.json

STARTED="$(find "$WORK/out" -name 'stampede-*.started' | wc -l | tr -d ' ')"
echo "  $STARTED reader(s) started"
lease g25-stampede --before "$REL/out/counters-g25-before.json" \
  --after "$REL/out/counters-g25-after.json" --opens "$STARTED"

# ----------------------------------------------------------------------------------------------------------
step "G25 — after a FAILED resolution, the cooldown holds and the next open fails fast"
# ----------------------------------------------------------------------------------------------------------
# THE ORDER HERE COST A WHOLE SEQUENCE AND A FALSE BUG REPORT, SO IT IS SPELLED OUT.
#
# `Resolver.Get` passes `slot.resolvedOnce` as its `isRefresh` argument. Once ANYTHING has resolved for this
# transport identity, every later resolution on an expired lease is already subject to `RefreshCooldown` —
# the cooldown is NOT confined to the `Refresh` path. The stampede above ends with a successful resolution,
# so it starts a cooldown of its own.
#
# The first version of this phase armed the resolver fault immediately afterwards. That setup read was
# refused LOCALLY by the stampede cooldown, never reached the endpoint, and left the fault ARMED. The
# measured read that followed was by then outside the cooldown, consumed the waiting fault, and recorded one
# resolution — and the gate reported a product defect that does not exist. The product was right both times.
#
# So: wait out the stampede cooldown, then MEASURE that the setup failure really reached the endpoint, then
# open the measured window immediately while the cooldown that failure started is still running.
echo "  waiting out the cooldown the stampede's own successful resolution started"
sleep $(( COOLDOWN_S + 2 ))

counters counters-g25s-before.json
control "fault/${OBJECT_B_REF}?fault=resolver-error&times=1"
control expire-leases
SETUP_FAILED=true
docker run --rm --user 65534:65534 --cap-drop ALL -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
  sh -c "dd if='/mnt/$ENTRY_B_PATH' bs=65536 skip=$(( 100 * MIB / 65536 )) count=1 of=/dev/null 2>/dev/null" \
  >/dev/null 2>&1 && SETUP_FAILED=false
COOLDOWN_START="$(date +%s%3N)"
sleep 1
counters counters-g25s-after.json

# THE SETUP IS MEASURED, NOT ASSUMED. Exactly one resolution must have reached the endpoint and been failed
# there; a setup refused locally reaches zero and arms nothing, and everything after it would be measuring
# an idle cooldown.
lease g25-cooldown-setup --before "$REL/out/counters-g25s-before.json" \
  --after "$REL/out/counters-g25s-after.json" --failed "$SETUP_FAILED"

# ----------------------------------------------------------------------------------------------------------
step "G25 — the 21st open, INSIDE the cooldown that failure started"
# ----------------------------------------------------------------------------------------------------------
counters counters-g25c-before.json
COOLDOWN_FAILED=false
READ_START="$(date +%s%3N)"
docker run --rm --user 65534:65534 --cap-drop ALL -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
  sh -c "dd if='/mnt/$ENTRY_B_PATH' bs=65536 skip=$(( 104 * MIB / 65536 )) count=1 of=/dev/null 2>/dev/null" \
  >/dev/null 2>&1 || COOLDOWN_FAILED=true
COOLDOWN_ELAPSED=$(( $(date +%s%3N) - READ_START ))

# THE WINDOW MUST HAVE BEEN INSIDE THE COOLDOWN, and that is checked rather than hoped for. If the read
# landed after it lapsed, a resolution would be legitimate and a zero would prove nothing.
SINCE_SETUP=$(( $(date +%s%3N) - COOLDOWN_START ))
test "$SINCE_SETUP" -lt "$COOLDOWN_MS" \
  || die "the 21st open landed ${SINCE_SETUP}ms after the failed resolution, outside the ${COOLDOWN_MS}ms cooldown, so a zero here would prove nothing"
echo "  the 21st open landed ${SINCE_SETUP}ms into the ${COOLDOWN_MS}ms cooldown"
sleep 1
counters counters-g25c-after.json

# THE NAMESPACE IS UNCHANGED: a resolver outage is not a deletion.
NAMESPACE_OK=false
docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" test -f "/mnt/$ENTRY_B_PATH" >/dev/null 2>&1 \
  && NAMESPACE_OK=true

lease g25-cooldown --before "$REL/out/counters-g25c-before.json" \
  --after "$REL/out/counters-g25c-after.json" --failed "$COOLDOWN_FAILED" \
  --elapsed-ms "$COOLDOWN_ELAPSED" --cooldown-ms "$COOLDOWN_MS" --namespace-ok "$NAMESPACE_OK"

# ----------------------------------------------------------------------------------------------------------
step "G26 — a refreshed response is held to every rule the first one was"
# ----------------------------------------------------------------------------------------------------------
# THE ORDER MATTERS AND IS NOT AN ACCIDENT. The lease check runs BEFORE the fault is taken, so lapsing first
# and arming second means the 401 is answered without consuming the fault — and the fault then lands on the
# POST-REFRESH request, which is exactly the response G26 is about.
echo '[]' > "$WORK/out/g26.json"
G26_BLOCK=120
for fault in mismatched-content-range short-body wrong-total-size full-body-on-range; do
  # Every fault gets its own cooldown-free window: the previous phase's cooldown must not be what refuses it.
  sleep $(( COOLDOWN_S + 2 ))
  control expire-leases
  control "fault/${OBJECT_B_REF}?fault=${fault}&times=4"
  counters "counters-g26-${fault}-before.json"
  BYTES=0
  FAILED=true
  if docker run --rm --user 65534:65534 --cap-drop ALL -v "$WORK/mnt:/mnt:rslave" -v "$WORK/out:/out" \
      "$VERIFY_IMAGE" sh -c "dd if='/mnt/$ENTRY_B_PATH' bs=65536 skip=$(( G26_BLOCK * MIB / 65536 )) count=1 of=/out/g26-out.bin 2>/dev/null" \
      >/dev/null 2>&1; then
    FAILED=false
  fi
  if [ -f "$WORK/out/g26-out.bin" ]; then
    BYTES="$(wc -c < "$WORK/out/g26-out.bin" | tr -d ' ')"
    rm -f "$WORK/out/g26-out.bin"
  fi
  control "fault/${OBJECT_B_REF}?fault=&times=0"
  node "$REL/g26-record.cjs" "$REL/out/g26.json" "$fault" "$BYTES" "$FAILED"
  echo "  $fault: read failed=$FAILED, bytes accepted=$BYTES"
  G26_BLOCK=$(( G26_BLOCK + 4 ))
done
lease g26-refreshed --observations "$REL/out/g26.json"

# ----------------------------------------------------------------------------------------------------------
step "G26 — a resolved URL outside the allowlist is NOT CONTACTED"
# ----------------------------------------------------------------------------------------------------------
sleep $(( COOLDOWN_S + 2 ))
TRAP_BEFORE="$(curl -fsS --max-time 10 "http://127.0.0.1:${TRAP_PORT}/counters" | node "$REL/jq.cjs" rangeRequests)"
counters counters-g26a-before.json
control expire-leases
control "fault/${OBJECT_B_REF}?fault=disallowed-host&times=4"
ALLOWLIST_FAILED=true
docker run --rm --user 65534:65534 --cap-drop ALL -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
  sh -c "dd if='/mnt/$ENTRY_B_PATH' bs=65536 skip=$(( 150 * MIB / 65536 )) count=1 of=/dev/null 2>/dev/null" \
  && ALLOWLIST_FAILED=false
control "fault/${OBJECT_B_REF}?fault=&times=0"
sleep 1
counters counters-g26a-after.json
TRAP_AFTER="$(curl -fsS --max-time 10 "http://127.0.0.1:${TRAP_PORT}/counters" | node "$REL/jq.cjs" rangeRequests)"
TRAP_DELTA=$(( TRAP_AFTER - TRAP_BEFORE ))
RESOLUTIONS="$(node "$REL/delta.cjs" "$REL/out/counters-g26a-before.json" "$REL/out/counters-g26a-after.json" resolutions)"
echo "  the trap listener saw $TRAP_DELTA ranged request(s); $RESOLUTIONS resolution(s) happened"
lease g26-allowlist --requests "$TRAP_DELTA" --failed "$ALLOWLIST_FAILED" --resolutions "$RESOLUTIONS"

# ----------------------------------------------------------------------------------------------------------
step "no access material reached disk"
# ----------------------------------------------------------------------------------------------------------
# The lease prefix is high-entropy, so finding none of it MEANS something. The probe cache and the manifest are
# where a lease would end up if the daemon ever wrote one down.
LEAKS=0
if grep -rl "$LEASE_MARKER" "$WORK/cache" "$WORK/manifest" >/dev/null 2>&1; then LEAKS=1; fi
test "$LEAKS" -eq 0 || die "an access lease reached the probe cache or the manifest"
TOKEN_LEAKS=0
if grep -rl "$TOKEN" "$WORK/cache" "$WORK/manifest" "$WORK/out" >/dev/null 2>&1; then TOKEN_LEAKS=1; fi
test "$TOKEN_LEAKS" -eq 0 || die "the endpoint credential reached the cache, the manifest or the report"
echo "  no lease and no credential in the probe cache, the manifest or the report"

# ----------------------------------------------------------------------------------------------------------
step "the report"
# ----------------------------------------------------------------------------------------------------------
lease report --results "$REL/out/results.json" --json "$REL/out/results-summary.json"
echo "  redaction-safe"
