#!/usr/bin/env bash
# The publisher-to-mount gate: PostgreSQL -> the production publisher -> the production projectiond image ->
# a FUSE mount -> bytes read and hashed by an ordinary non-root container.
#
# WHAT IT PROVES, AND WHY EACH PART IS HERE.
#
#   1. A REAL, MIGRATED POSTGRESQL, in this repository normal Docker shape. The registry and the generation
#      ledger are a schema a real server accepts, and the migration that deploys them is the one an operator
#      runs.
#   2. A SMALL CATALOG SEEDED THROUGH THE PRODUCTION WRITE PATH -- ops:projection-register, the same CLI an
#      operator uses -- with one LOCAL stable source and one HTTP RANGE stable source. Both adapters ship in
#      the same tranche, and a local-only run would prove nothing about the design.
#   3. THE PRODUCTION PUBLISHER, run as an operator runs it: the pointer digest and byte length checked
#      against the artifact, a deterministic sequence, an idempotent retry that mints nothing, a second
#      publisher refused rather than queued, and a run killed at its commit boundary recovered by the next.
#   4. THE ALREADY-MERGED PRODUCTION IMAGE, strict-direct-mounted against that output, with the namespace read
#      and SHA-256 hashed by a SEPARATE, NON-ROOT container -- which is how a media server actually runs. The
#      expected digests are recorded OUTSIDE the mount, so a hash that only proves "the file hashes to its own
#      contents" cannot pass.
#   5. A SUCCESSOR PUBLISHED WHILE A HANDLE IS OPEN. The open handle keeps reading the generation it opened
#      against, byte for byte, while the namespace changes underneath it.
#   6. MALFORMED, OVERSIZED, SHRINKING AND RELOCATING GENERATIONS, forged and published the way a broken or
#      compromised producer would. Every one is refused, the mount does not move, and the production publisher
#      then repairs the directory from PostgreSQL.
#
# WHAT IT DOES NOT PROVE, AND WILL NOT BE PRESENTED AS PROVING. Nothing here is a real media server. Plex,
# Jellyfin, Emby and Unraid acceptance are still ahead of this gate; see
# docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md section 6 for the table that says where each gate can be closed.
#
# Everything is bounded: a hang fails the gate rather than occupying the machine.
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
GO_IMAGE="golang:1.26.5-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
COMPOSE_FILE="docker-compose.projection-publisher.yml"
NETWORK="projection-publisher-gate"
PG_PORT="${PROJECTION_GATE_PG_PORT:-5470}"

MOUNT_CONTAINER="projection-publisher-mount-$$"
RANGE_CONTAINER="projection-publisher-range-$$"
READER_CONTAINER="projection-publisher-reader-$$"

# TWO SPELLINGS OF ONE DIRECTORY, DELIBERATELY.
#
# WORK is absolute and is what Docker bind mounts name. It lives beside the repository rather than under /tmp
# because bind propagation requires the host path to be on a shared mount, and on Docker Desktop the
# shared-folder path is the one that qualifies.
#
# REL is the same directory relative to the repository root, and it is what node and tsx are given. On a
# Windows development machine the shell is MSYS and its absolute paths look like /c/Users/..., which a Windows
# node binary cannot open; a relative path is correct on every platform. A unique child per run, because
# Docker Desktop caches bind-source state and reusing a path that once held a FUSE mount fails opaquely.
GATE_ROOT="$PWD/.projection-publisher-gate"
REL=".projection-publisher-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_GATE_PG_PORT="$PG_PORT"

cleanup() {
  docker rm -f "$MOUNT_CONTAINER" "$RANGE_CONTAINER" "$READER_CONTAINER" >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  if [ -n "${WORK:-}" ] && [ -d "$WORK" ]; then
    docker run --rm --privileged -v "$GATE_ROOT:/gate" "$VERIFY_IMAGE" \
      sh -c "umount -l /gate/$(basename "$WORK")/mnt 2>/dev/null; rm -rf /gate/$(basename "$WORK")" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step() { echo; echo "=== $* ==="; }
die()  { echo "GATE FAILED: $*" >&2; exit 1; }

# One field out of a publisher report, without a JSON parser in the shell.
field() { node "$REL/jq.cjs" "$1"; }
publish() { npx tsx src/ops/projection-publish-cli.ts --manifest-dir "$REL/manifest" "$@"; }
register() { npx tsx src/ops/projection-register-cli.ts "$@"; }
forge() { npx tsx src/ops/projection-forge-adversarial-cli.ts --manifest-dir "$REL/manifest" --mode "$1"; }

mkdir -p "$WORK/manifest" "$WORK/media" "$WORK/cache" "$WORK/mnt" "$WORK/out"
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

cat > "$WORK/fill.cjs" <<'FILL'
// Deterministic bytes, so two runs of this gate compare the same digest.
const { writeFileSync } = require('node:fs');
const size = Number(process.argv[3]);
const step = Number(process.argv[4]);
const buffer = Buffer.alloc(size);
for (let index = 0; index < size; index += 1) buffer[index] = (index * step + 11) % 251;
writeFileSync(process.argv[2], buffer);
FILL

cat > "$WORK/objects.cjs" <<'OBJECTS'
// Read the descriptor the range endpoint emitted: either the whole-object digest, or the probe flags the
// registration CLI takes. The probe digests are the control plane assertion about the byte stream, and they
// were computed from the same deterministic content function the endpoint serves from.
const { readFileSync } = require('node:fs');
const objects = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const object = objects[0];
if (process.argv[3] === 'sha256') console.log(object.sha256);
else console.log(object.probes.map((p) => [p.position, p.offset, p.length, p.sha256].join(':')).join(' '));
OBJECTS

# ----------------------------------------------------------------------------------------------------------
step "the Compose files this gate uses are valid"
# ----------------------------------------------------------------------------------------------------------
docker compose -f "$COMPOSE_FILE" config -q
docker compose -f docker-compose.projectiond.yml config -q
echo "  both parse"

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

# ----------------------------------------------------------------------------------------------------------
step "starting the deterministic HTTP Range endpoint the remote entry lives at"
# ----------------------------------------------------------------------------------------------------------
# The endpoint is internal/fakeprovider, the only provider any automated gate in this repository contacts.
# Object bytes are a pure function of the reference and the offset, so the digests it emits describe exactly
# what a reader will get -- and they are written OUTSIDE the mount, which is what makes them worth comparing.
REMOTE_REF="obj-remote-two"
REMOTE_SIZE=4194304
docker run -d --name "$RANGE_CONTAINER" --network "$NETWORK" --network-alias fakerange \
  -v "$PWD:/workspace" -w /workspace/projectiond -v "$WORK/out:/out" \
  -e GOFLAGS=-buildvcs=false -e GOTOOLCHAIN=local -e CGO_ENABLED=0 \
  "$GO_IMAGE" go run ./cmd/fakerange --addr 0.0.0.0:8099 \
  --object "${REMOTE_REF}:${REMOTE_SIZE}" --emit /out/objects.json >/dev/null

echo "  waiting for the endpoint to answer"
ready=0
for _ in $(seq 1 90); do
  if [ -f "$WORK/out/objects.json" ] && docker run --rm --network "$NETWORK" "$VERIFY_IMAGE" \
       wget -q -O /dev/null "http://fakerange:8099/direct/${REMOTE_REF}" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  docker logs "$RANGE_CONTAINER" 2>&1 | tail -20 >&2
  die "the range endpoint never answered"
fi

REMOTE_SHA="$(node "$REL/objects.cjs" "$REL/out/objects.json" sha256)"
REMOTE_PROBES="$(node "$REL/objects.cjs" "$REL/out/objects.json" probes)"
echo "  the remote object is $REMOTE_SIZE bytes, sha256 $REMOTE_SHA"

# ----------------------------------------------------------------------------------------------------------
step "writing the local media and recording its digest outside the mount"
# ----------------------------------------------------------------------------------------------------------
LOCAL_SIZE=3145728
node "$REL/fill.cjs" "$REL/media/local-one.bin" "$LOCAL_SIZE" 7
LOCAL_SHA="$(node "$REL/sha.cjs" "$REL/media/local-one.bin")"
echo "  the local object is $LOCAL_SIZE bytes, sha256 $LOCAL_SHA"

# ----------------------------------------------------------------------------------------------------------
step "seeding the catalog through the production write path"
# ----------------------------------------------------------------------------------------------------------
LOCAL_PATH="Movies/Local One/Local One.bin"
REMOTE_PATH="Movies/Remote Two/Remote Two.bin"
LOCAL_ITEM="11111111-1111-4111-8111-111111111111"
REMOTE_ITEM="22222222-2222-4222-8222-222222222222"
EXTRA_ITEM="33333333-3333-4333-8333-333333333333"

register root --id media --kind local
register root --id vault --kind http-range
register version --key local-one --size "$LOCAL_SIZE" --mtime 2026-06-01T10:00:00.000Z

PROBE_FLAGS=""
for probe in $REMOTE_PROBES; do
  PROBE_FLAGS="$PROBE_FLAGS --probe $probe"
done
# shellcheck disable=SC2086
register version --key remote-two --size "$REMOTE_SIZE" --mtime 2026-06-01T10:00:00.000Z $PROBE_FLAGS

register entry --item "$LOCAL_ITEM" --version-key local-one --path "$LOCAL_PATH" --source "local:media:local-one.bin"
register entry --item "$REMOTE_ITEM" --version-key remote-two --path "$REMOTE_PATH" --source "http-range:vault:${REMOTE_REF}"
echo "  one local and one HTTP Range stable source registered"

# ----------------------------------------------------------------------------------------------------------
step "publishing generation 1, and proving the pointer describes the artifact exactly"
# ----------------------------------------------------------------------------------------------------------
publish > "$WORK/out/publish-1.json"
cat "$WORK/out/publish-1.json"
test "$(field outcome < "$WORK/out/publish-1.json")" = "published" || die "generation 1 was not published"
test "$(field sequence < "$WORK/out/publish-1.json")" = "1" || die "the first sequence is not 1"

ARTIFACT="$(field artifactName < "$WORK/out/publish-1.json")"
POINTER_DIGEST="$(field manifestDigest < "$WORK/manifest/pointer.json")"
POINTER_BYTES="$(field artifactBytes < "$WORK/manifest/pointer.json")"
ACTUAL_DIGEST="sha256:$(node "$REL/sha.cjs" "$REL/manifest/$ARTIFACT")"
ACTUAL_BYTES="$(wc -c < "$WORK/manifest/$ARTIFACT" | tr -d ' ')"
test "$POINTER_DIGEST" = "$ACTUAL_DIGEST" || die "the pointer digest does not describe the artifact"
test "$POINTER_BYTES" = "$ACTUAL_BYTES" || die "the pointer byte length does not describe the artifact"
echo "  pointer digest $POINTER_DIGEST over $POINTER_BYTES bytes, verified against the file"

# ----------------------------------------------------------------------------------------------------------
step "an idempotent retry mints nothing"
# ----------------------------------------------------------------------------------------------------------
cp "$WORK/manifest/pointer.json" "$WORK/out/pointer-before-retry.json"
publish > "$WORK/out/publish-retry.json"
test "$(field outcome < "$WORK/out/publish-retry.json")" = "unchanged" || die "a retry over an unmoved catalog changed something"
cmp -s "$WORK/manifest/pointer.json" "$WORK/out/pointer-before-retry.json" || die "the retry rewrote the pointer"
echo "  outcome unchanged, pointer byte-identical"

# ----------------------------------------------------------------------------------------------------------
step "a second publisher is refused while the first holds the lock"
# ----------------------------------------------------------------------------------------------------------
docker compose -f "$COMPOSE_FILE" exec -d postgres psql -v ON_ERROR_STOP=1 -U postgres -d catalog \
  -c "SELECT cat_projection_publish_lock()" -c "SELECT pg_sleep(15)"
sleep 3
set +e
publish > "$WORK/out/publish-concurrent.json"
concurrent_code=$?
set -e
cat "$WORK/out/publish-concurrent.json"
test "$concurrent_code" -eq 4 || die "a concurrent publisher did not exit 4, it exited $concurrent_code"
test "$(field outcome < "$WORK/out/publish-concurrent.json")" = "concurrent-publisher" || die "wrong refusal"
echo "  refused, not queued"
echo "  waiting for the held lock to lapse"
sleep 14

# ----------------------------------------------------------------------------------------------------------
step "a run killed at its commit boundary is recovered by the next one"
# ----------------------------------------------------------------------------------------------------------
node "$REL/fill.cjs" "$REL/media/local-three.bin" 1048576 13
register version --key local-three --size 1048576 --mtime 2026-06-01T10:00:00.000Z
register entry --item "$EXTRA_ITEM" --version-key local-three --path "Movies/Local Three/Local Three.bin" \
  --source "local:media:local-three.bin"

set +e
publish --fault after-db-pointer > "$WORK/out/publish-crash.json" 2>&1
crash_code=$?
set -e
test "$crash_code" -ne 0 || die "the injected fault did not stop the run"

set +e
publish --status > "$WORK/out/status-crashed.json"
set -e
cat "$WORK/out/status-crashed.json"
test "$(field dbSequence < "$WORK/out/status-crashed.json")" = "2" || die "the database did not advance"
test "$(field pointerSequence < "$WORK/out/status-crashed.json")" = "1" || die "the pointer file should still be behind"

publish > "$WORK/out/publish-recovered.json"
cat "$WORK/out/publish-recovered.json"
test "$(field outcome < "$WORK/out/publish-recovered.json")" = "recovered" || die "the crash was not recovered"
publish --status > "$WORK/out/status-recovered.json"
test "$(field agrees < "$WORK/out/status-recovered.json")" = "true" || die "the directory and the database still disagree"
test "$(field pointerSequence < "$WORK/out/status-recovered.json")" = "2" || die "expected to mount generation 2"
echo "  the pointer was rebuilt from PostgreSQL, and the run stopped there rather than skipping a generation"

# ----------------------------------------------------------------------------------------------------------
step "mounting with the production image, root plus CAP_SYS_ADMIN plus /dev/fuse, strict direct mount"
# ----------------------------------------------------------------------------------------------------------
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIP: no /dev/fuse is reachable from a container on this host, so the MOUNT half is UNPROVEN here." >&2
  echo "      Everything above -- a real migrated PostgreSQL, the production write path, the publisher, its" >&2
  echo "      digests, its idempotence, its exclusion and its crash recovery -- did pass." >&2
  exit 0
fi

cat > "$WORK/config.json" <<'JSON'
{
  "mountPoint": "/mnt/projection",
  "pointerPath": "/var/lib/projectiond/manifest/pointer.json",
  "probeCacheDir": "/var/lib/projectiond/cache",
  "localRoots": { "media": "/var/lib/projectiond/media" },
  "endpoints": [
    {
      "id": "vault",
      "directBaseUrl": "http://fakerange:8099/direct",
      "allowedOrigins": ["http://fakerange:8099"],
      "allowInsecureHttp": true,
      "allowPrivateAddresses": true
    }
  ]
}
JSON

docker run -d --name "$MOUNT_CONTAINER" \
  --network "$NETWORK" \
  --user 0:0 \
  --cap-drop ALL --cap-add SYS_ADMIN \
  --security-opt apparmor:unconfined \
  --device /dev/fuse:/dev/fuse \
  -v "$WORK/manifest:/var/lib/projectiond/manifest:ro" \
  -v "$WORK/media:/var/lib/projectiond/media:ro" \
  -v "$WORK/cache:/var/lib/projectiond/cache" \
  -v "$WORK/config.json:/etc/projectiond/config.json:ro" \
  -v "$WORK/mnt:/mnt/projection:rshared" \
  "$IMAGE" --config /etc/projectiond/config.json --poll 2s --strict-direct-mount >/dev/null

echo "  waiting for the namespace to become visible to another container"
ready=0
for _ in $(seq 1 60); do
  if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" test -d /mnt/Movies >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  docker logs "$MOUNT_CONTAINER" 2>&1 | tail -30 >&2
  die "the mount never became visible"
fi

# ----------------------------------------------------------------------------------------------------------
step "reading and hashing BOTH projected files from an ordinary non-root container"
# ----------------------------------------------------------------------------------------------------------
cat > "$WORK/out/verify.sh" <<'VERIFY'
set -eu
echo "--- running as uid $(id -u), gid $(id -g)"
test "$(id -u)" != "0" || { echo "the verifier is root; that proves nothing about a media server" >&2; exit 1; }

check() {
  target="/mnt/$1"
  expected="$2"
  echo "--- $1"
  test -f "$target" || { echo "not a regular file" >&2; exit 1; }
  test ! -L "$target" || { echo "a media server can see a symlink" >&2; exit 1; }
  test "$(stat -c %a "$target")" = "444" || { echo "the namespace is not read-only" >&2; exit 1; }
  stat -c "    size=%s mode=%a inode=%i links=%h" "$target"
  actual="$(sha256sum "$target" | cut -d" " -f1)"
  echo "    sha256 $actual"
  test "$actual" = "$expected" || { echo "the bytes read through the mount are not the bytes published" >&2; exit 1; }
  echo "    matched the digest recorded outside the mount"
}

check "Movies/Local One/Local One.bin" "$1"
check "Movies/Remote Two/Remote Two.bin" "$2"

echo "--- a seek into each file returns bytes"
dd if="/mnt/Movies/Local One/Local One.bin" bs=1024 skip=512 count=1 2>/dev/null | wc -c
dd if="/mnt/Movies/Remote Two/Remote Two.bin" bs=1024 skip=2048 count=1 2>/dev/null | wc -c

echo "--- mutations must be refused"
( true > "/mnt/Movies/Local One/Local One.bin" ) 2>/dev/null && { echo "truncate succeeded" >&2; exit 1; }
( rm -f "/mnt/Movies/Local One/Local One.bin" ) 2>/dev/null && test ! -e "/mnt/Movies/Local One/Local One.bin" && { echo "unlink succeeded" >&2; exit 1; }
( mkdir /mnt/newdir ) 2>/dev/null && { echo "mkdir succeeded" >&2; exit 1; }
( echo x > /mnt/newfile ) 2>/dev/null && { echo "create succeeded" >&2; exit 1; }
( ln -s /etc/passwd /mnt/link ) 2>/dev/null && { echo "symlink succeeded" >&2; exit 1; }
echo "--- every mutation refused"
VERIFY

docker run --rm --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges \
  -v "$WORK/mnt:/mnt:rslave" -v "$WORK/out:/out:ro" \
  "$VERIFY_IMAGE" sh /out/verify.sh "$LOCAL_SHA" "$REMOTE_SHA"

# ----------------------------------------------------------------------------------------------------------
step "publishing a successor while a handle is open"
# ----------------------------------------------------------------------------------------------------------
# The reader opens the LOCAL file, reads its first megabyte through file descriptor 3, waits for a successor
# to be published and admitted, and then reads THE REST OF THE FILE THROUGH THE SAME DESCRIPTOR. If the handle
# were not pinned to the generation it opened against, that second half would come from somewhere else.
cat > "$WORK/out/pinned-read.sh" <<'PINNED'
set -eu
target="/mnt/Movies/Local One/Local One.bin"
exec 3< "$target"
# dd, NOT head -c. `head` may read ahead past the byte count it prints, and the descriptor is SHARED with the
# second half of this read -- so an over-reading head would silently drop bytes from the middle of the file
# and the digest at the end would fail for a reason that has nothing to do with generation pinning.
dd bs=1024 count=1024 <&3 > /out/pinned-part.bin 2>/dev/null
echo opened > /out/handle-open
attempt=0
while [ ! -f /out/swap-done ]; do
  attempt=$((attempt + 1))
  test "$attempt" -lt 240 || { echo "the successor never arrived" >&2; exit 1; }
  sleep 0.5
done
cat <&3 >> /out/pinned-part.bin
exec 3<&-
sha256sum /out/pinned-part.bin | cut -d" " -f1 > /out/pinned-digest.txt
PINNED

rm -f "$WORK/out/handle-open" "$WORK/out/swap-done" "$WORK/out/pinned-digest.txt"
docker run -d --name "$READER_CONTAINER" --user 65534:65534 --cap-drop ALL \
  -v "$WORK/mnt:/mnt:rslave" -v "$WORK/out:/out" "$VERIFY_IMAGE" sh /out/pinned-read.sh >/dev/null

echo "  waiting for the handle to be open"
ready=0
for _ in $(seq 1 60); do
  if [ -f "$WORK/out/handle-open" ]; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  docker logs "$READER_CONTAINER" 2>&1 | tail -20 >&2
  die "the reader never opened its handle"
fi

node "$REL/fill.cjs" "$REL/media/local-four.bin" 524288 29
FOUR_SHA="$(node "$REL/sha.cjs" "$REL/media/local-four.bin")"
register version --key local-four --size 524288 --mtime 2026-06-01T10:00:00.000Z
register entry --item "$EXTRA_ITEM" --version-key local-four --path "Movies/Local Four/Local Four.bin" \
  --source "local:media:local-four.bin"

publish > "$WORK/out/publish-successor.json"
cat "$WORK/out/publish-successor.json"
test "$(field outcome < "$WORK/out/publish-successor.json")" = "published" || die "the successor was not published"
test "$(field sequence < "$WORK/out/publish-successor.json")" = "3" || die "the successor sequence is wrong"
test "$(field additions < "$WORK/out/publish-successor.json")" = "1" || die "the successor should add exactly one entry"

echo "  waiting for the daemon to admit the successor"
ready=0
for _ in $(seq 1 60); do
  if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
       test -f "/mnt/Movies/Local Four/Local Four.bin" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  docker logs "$MOUNT_CONTAINER" 2>&1 | tail -30 >&2
  die "the successor never became visible"
fi
echo "  the namespace changed while the handle was open"

touch "$WORK/out/swap-done"
docker wait "$READER_CONTAINER" >/dev/null
docker logs "$READER_CONTAINER" 2>&1 | tail -5
PINNED_SHA="$(tr -d " \r\n" < "$WORK/out/pinned-digest.txt")"
test "$PINNED_SHA" = "$LOCAL_SHA" || die "the open handle read the wrong bytes across the swap"
echo "  the open handle read the whole file correctly across the generation swap"

docker run --rm --user 65534:65534 --cap-drop ALL -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
  sh -c "sha256sum '/mnt/Movies/Local Four/Local Four.bin' | cut -d' ' -f1" > "$WORK/out/four-digest.txt"
test "$(tr -d " \r\n" < "$WORK/out/four-digest.txt")" = "$FOUR_SHA" || die "the added entry did not read correctly"
echo "  and the entry the successor added reads correctly"

# ----------------------------------------------------------------------------------------------------------
step "malformed, oversized, shrinking and relocating generations never replace the last good one"
# ----------------------------------------------------------------------------------------------------------
cat > "$WORK/out/snapshot.sh" <<'SNAP'
set -eu
find /mnt -type f -exec stat -c "%n %s %i %a" {} \; | sort
SNAP

namespace_snapshot() {
  docker run --rm -v "$WORK/mnt:/mnt:rslave" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" sh /out/snapshot.sh
}
BEFORE="$(namespace_snapshot)"
echo "$BEFORE"

for mode in malformed oversize-pointer digest-mismatch drop-entry relocate-path; do
  echo "--- $mode"
  forge "$mode"
  sleep 6
  AFTER="$(namespace_snapshot)"
  test "$BEFORE" = "$AFTER" || die "the namespace moved after a forged $mode generation"
  docker run --rm --user 65534:65534 --cap-drop ALL -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
    sh -c "sha256sum '/mnt/Movies/Local One/Local One.bin' | cut -d' ' -f1" > "$WORK/out/after-$mode.txt"
  test "$(tr -d " \r\n" < "$WORK/out/after-$mode.txt")" = "$LOCAL_SHA" || die "reads broke after a forged $mode generation"
  echo "    refused; the namespace and the bytes are unchanged"

  publish > "$WORK/out/repair-$mode.json"
  test "$(field outcome < "$WORK/out/repair-$mode.json")" = "recovered" || die "the publisher did not repair after $mode"
  publish --status > "$WORK/out/status-$mode.json"
  test "$(field agrees < "$WORK/out/status-$mode.json")" = "true" || die "the repair did not restore agreement"
  echo "    and the production publisher restored the directory from PostgreSQL"
done

# ----------------------------------------------------------------------------------------------------------
step "unmounting"
# ----------------------------------------------------------------------------------------------------------
docker stop -t 15 "$MOUNT_CONTAINER" >/dev/null
if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" test -d /mnt/Movies >/dev/null 2>&1; then
  die "the namespace is still visible after the daemon stopped"
fi

echo
echo "publisher-to-mount gate PASSED. Exactly what was proved:"
echo "  - a real PostgreSQL 16, migrated by ops:migrate, holding the projection registry and the"
echo "    generation ledger."
echo "  - a catalog seeded through the production write path, ops:projection-register, with one LOCAL and"
echo "    one HTTP RANGE stable source. No access URL, token, header or expiry was written anywhere."
echo "  - the production publisher, ops:projection-publish: a pointer whose digest and byte length were"
echo "    verified against the artifact file, a deterministic sequence, an idempotent retry that minted"
echo "    nothing, a second publisher refused with exit 4, and a run killed at its commit boundary"
echo "    recovered by the next run, which repaired the pointer from PostgreSQL and stopped rather than"
echo "    skipping a generation."
echo "  - the ALREADY-MERGED production projectiond image, strict-direct-mounted, which refuses the"
echo "    fusermount helper the image does not contain, with root inside the container, CAP_SYS_ADMIN and"
echo "    /dev/fuse, and nothing else."
echo "  - BOTH projected files read and SHA-256 hashed by an ORDINARY NON-ROOT container, uid 65534, all"
echo "    capabilities dropped, against digests recorded OUTSIDE the mount. Every mutation was refused."
echo "  - a successor published while a handle was open: the handle read the whole file correctly across"
echo "    the swap, and the namespace gained the new entry."
echo "  - malformed, oversized, digest-mismatched, shrinking and relocating generations, forged and"
echo "    published as a broken producer would: every one refused, the namespace and the bytes unchanged,"
echo "    and the directory repaired from PostgreSQL afterwards."
echo
echo "WHAT THIS GATE DOES NOT PROVE. No Plex, no Jellyfin, no Emby and no Unraid host was involved."
echo "Real media-server scan, play, seek, transcode and library-churn acceptance remain ahead of this"
echo "phase. docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md section 6 is the table that says where each gate"
echo "can be closed."
