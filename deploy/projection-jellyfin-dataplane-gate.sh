#!/usr/bin/env bash
# The media-server DATA-PLANE gate: PostgreSQL -> the production publisher -> the production projectiond image
# -> a FUSE mount -> a REAL JELLYFIN that scans, direct-plays, seeks and transcodes out of it.
#
# WHAT MAKES THIS DIFFERENT FROM EVERY OTHER JELLYFIN JOB IN THIS REPOSITORY. The existing ones drive a FAKE
# Jellyfin about collections; none of them opens a byte of media, and none involves a mount. This one starts a
# real, digest-pinned Jellyfin container, stands it up through its own first-run API, hands it the projected
# mount as a library root, and makes it read media through the daemon. It is the first evidence in this
# product that a media server — not a shell with sha256sum — can use the data plane.
#
# WHAT IT PROVES, AND WHY EACH PART IS HERE.
#
#   1. A REAL, MIGRATED POSTGRESQL and the production write path, exactly as the publisher-to-mount gate uses
#      them: one LOCAL stable source and one HTTP RANGE stable source, registered through
#      ops:projection-register, published by ops:projection-publish.
#   2. LEGAL, SYNTHETIC MEDIA GENERATED ON THIS MACHINE. Two mp4 files encoded from ffmpeg's own `testsrc`
#      pattern and a sine tone by the ffmpeg that ships inside the pinned Jellyfin image. Nothing is
#      downloaded, nothing copyrighted is touched, and no fixture is committed. The digests and byte lengths
#      are recorded OUTSIDE the mount, before anything is published.
#   3. THE ALREADY-MERGED PRODUCTION IMAGE, strict-direct-mounted with /dev/fuse and CAP_SYS_ADMIN and nothing
#      else, and the namespace bind-propagated to a sibling container.
#   4. JELLYFIN AS AN ORDINARY NON-ROOT CONTAINER, which is how a media server actually runs. Its library root
#      is the mount. It scans, and the items it finds are matched against what was published, by size and by
#      the media server's OWN view of the file — a real file, not a symlink and not a `.strm` placeholder.
#   5. DIRECT PLAY, byte for byte, digest-compared against the value recorded outside the mount. A REAL HTTP
#      SEEK, whose 206 and Content-Range are asserted before the body is looked at, because a 200-with-the-
#      whole-file would otherwise pass as a successful seek.
#   6. A FORCED TRANSCODE, proved by DECODING what came out. The media is encoded as mpeg4 and h264 is asked
#      for; the segments Jellyfin produced are then ffprobed and must be h264. A transcode claim that rested
#      on the server's own bookkeeping would be a claim, not a measurement.
#   7. A SUCCESSOR PUBLISHED MID-STREAM, and a SIGKILL of the daemon mid-stream followed by the real recovery
#      path. Playback may fail across the kill and be resumable; the LIBRARY may not move. After each event
#      Jellyfin re-scans and the gate asserts zero removals, zero duplicates and unchanged item ids.
#   8. MUTATION REFUSED FROM JELLYFIN'S OWN CONTAINER, at the daemon rather than at a Docker flag: the mount
#      is deliberately NOT bound read-only, so what refuses a write is projectiond.
#
# WHAT IT DOES NOT PROVE, AND WILL NOT BE PRESENTED AS PROVING. A Docker Desktop pass is NOT Linux/Unraid
# closure. Plex, Emby, a real Unraid host and a real provider endpoint remain entirely unproved, and the
# acceptance plan says the tranche closes on a Linux/Unraid run, three times.
#
# EVERYTHING IS BOUNDED. Every readiness probe, read, scan, transcode and wait has a hard deadline; a hang
# fails the gate rather than occupying the machine.
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
GO_IMAGE="golang:1.26.5-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
# THE MEDIA SERVER, PINNED BY DIGEST. A tag would let the thing under test change between two runs of a gate
# whose entire claim is that it passed three times in a row.
JELLYFIN_IMAGE="jellyfin/jellyfin@sha256:7ae36aab93ef9b6aaff02b37f8bb23df84bb2d7a3f6054ec8fc466072a648ce2"
JELLYFIN_FFMPEG="/usr/lib/jellyfin-ffmpeg/ffmpeg"
JELLYFIN_FFPROBE="/usr/lib/jellyfin-ffmpeg/ffprobe"

COMPOSE_FILE="docker-compose.projection-jellyfin.yml"
NETWORK="projection-jellyfin-gate"
PG_PORT="${PROJECTION_JELLYFIN_GATE_PG_PORT:-5480}"
JF_PORT="${PROJECTION_JELLYFIN_GATE_HTTP_PORT:-8098}"
RANGE_PORT="${PROJECTION_JELLYFIN_GATE_RANGE_PORT:-8097}"

MOUNT_CONTAINER="projection-jf-mount-$$"
RANGE_CONTAINER="projection-jf-range-$$"
JELLYFIN_CONTAINER="projection-jf-server-$$"

# TWO SPELLINGS OF ONE DIRECTORY, for the same reasons the publisher-to-mount gate has them: WORK is absolute
# and is what Docker bind mounts name, and it lives beside the repository because bind propagation needs a
# shared host mount; REL is relative and is what node and tsx are given, because an MSYS absolute path is not
# something a Windows node binary can open.
GATE_ROOT="$PWD/.projection-jellyfin-gate"
REL=".projection-jellyfin-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_JELLYFIN_GATE_PG_PORT="$PG_PORT"

cleanup() {
  # THE MEDIA SERVER FIRST. It holds open handles on the mount, and a FUSE mount with a live reader does not
  # unmount cleanly — leaving one behind is how the NEXT run inherits a stale namespace and passes for the
  # wrong reason.
  docker rm -f "$JELLYFIN_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$MOUNT_CONTAINER" "$RANGE_CONTAINER" >/dev/null 2>&1 || true
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

field()    { node "$REL/jq.cjs" "$1"; }
publish()  { npx tsx src/ops/projection-publish-cli.ts --manifest-dir "$REL/manifest" "$@"; }
register() { npx tsx src/ops/projection-register-cli.ts "$@"; }
drive()    { npx tsx src/ops/projection-jellyfin-dataplane-cli.ts "$@" --results "$REL/out/results.json"; }
ffmpeg_run()  { docker run --rm --entrypoint "$JELLYFIN_FFMPEG"  -v "$WORK:/work" "$JELLYFIN_IMAGE" "$@"; }
ffprobe_run() { docker run --rm --entrypoint "$JELLYFIN_FFPROBE" -v "$WORK:/work" "$JELLYFIN_IMAGE" "$@"; }

mkdir -p "$WORK/manifest" "$WORK/media" "$WORK/remote" "$WORK/cache" "$WORK/mnt" "$WORK/out" \
         "$WORK/jf-config" "$WORK/jf-cache"
# The media server runs non-root and owns nothing on this host, so its state directories are made writable by
# whoever it turns out to be. The MEDIA is not: it is 444 through the mount, and that is under test.
chmod 777 "$WORK/cache" "$WORK/mnt" "$WORK/out" "$WORK/jf-config" "$WORK/jf-cache"

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
const { createReadStream } = require('node:fs');
const hash = createHash('sha256');
const start = Number(process.argv[3] ?? 0);
const length = process.argv[4] === undefined ? Infinity : Number(process.argv[4]);
const end = length === Infinity ? Infinity : start + length - 1;
createReadStream(process.argv[2], { start, end })
  .on('data', (chunk) => hash.update(chunk))
  .on('end', () => console.log(hash.digest('hex')));
SHA

cat > "$WORK/objects.cjs" <<'OBJECTS'
const { readFileSync } = require('node:fs');
const objects = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const object = objects.find((o) => o.ref === process.argv[3]);
if (!object) { console.error('no such object'); process.exit(1); }
if (process.argv[4] === 'sha256') console.log(object.sha256);
else if (process.argv[4] === 'size') console.log(object.size);
else console.log(object.probes.map((p) => [p.position, p.offset, p.length, p.sha256].join(':')).join(' '));
OBJECTS

# ----------------------------------------------------------------------------------------------------------
step "the Compose files this gate uses are valid"
# ----------------------------------------------------------------------------------------------------------
docker compose -f "$COMPOSE_FILE" config -q
docker compose -f docker-compose.projectiond.yml config -q
echo "  both parse"

# ----------------------------------------------------------------------------------------------------------
step "checking this host can host the gate at all"
# ----------------------------------------------------------------------------------------------------------
# A SKIP IS NOT A PASS, and it exits 0 only because a machine without /dev/fuse cannot be asked to prove
# anything about a mount. It says loudly which half went unproven.
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIP: no /dev/fuse is reachable from a container on this host." >&2
  echo "      The MEDIA-SERVER DATA PLANE is entirely UNPROVEN here. Nothing in this gate ran." >&2
  exit 0
fi
echo "  /dev/fuse is reachable from a container"

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
step "generating legal synthetic media on this machine"
# ----------------------------------------------------------------------------------------------------------
# NOTHING IS DOWNLOADED AND NOTHING IS COMMITTED. `testsrc` is ffmpeg's own generated test pattern and `sine`
# is a generated tone; both are produced here, by the ffmpeg inside the pinned media-server image, and thrown
# away with the run directory.
#
# THE VIDEO CODEC IS MPEG4 ON PURPOSE. The transcode gate asks the media server for h264, and a server given a
# source it can already stream will remux rather than re-encode — which would make "a transcode ran" a claim
# about an endpoint rather than a measurement of an encoder. Encoding in one codec and demanding another is
# what makes the decode assertion later in this gate mean something.
#
# THE FILES ARE OVER 3 MiB so the contract's full three-window probe plan applies rather than its
# single-window one; a remote entry read through one window would not exercise the seek path at all.
#
# `-qscale:v 2` RATHER THAN A TARGET BITRATE, because `testsrc` is a synthetic pattern that a rate-controlled
# encoder compresses to almost nothing — an earlier version of this asked for 900 kbit/s over 40 seconds and
# got under a megabyte, which would have quietly dropped the entry below the contract's three-window probe
# threshold and made the seek gate meaningless.
#
# EVERY FILE IS DELIBERATELY DIFFERENT FROM EVERY OTHER. Generating two entries from identical parameters
# would make them byte-identical, and then a gate that read the LOCAL file where it meant to read the REMOTE
# one would still match its digest and pass. A different pattern, a different tone and a different duration
# per entry is what makes "the bytes came from where the manifest said" checkable at all.
encode() {
  # $1 destination inside /work, $2 duration in seconds, $3 lavfi video source, $4 tone frequency,
  # $5 `faststart` to put the moov atom at the FRONT, anything else to leave it at the END
  faststart="-movflags +faststart"
  if [ "$5" != "faststart" ]; then faststart=""; fi
  # shellcheck disable=SC2086
  ffmpeg_run -hide_banner -loglevel error -y \
    -f lavfi -i "$3=size=1280x720:rate=30:duration=$2" \
    -f lavfi -i "sine=frequency=$4:duration=$2" \
    -c:v mpeg4 -qscale:v 2 -c:a aac -b:a 128k -shortest \
    $faststart "/work/$1"
}

LOCAL_FILE="Projection Local One (2026).mp4"
REMOTE_FILE="Projection Remote Two (2026).mp4"

# THE REMOTE ENTRY'S MOOV ATOM IS AT THE END, ON PURPOSE, AND IT IS THE POINT OF THE REMOTE ENTRY.
#
# With `+faststart` the index sits in the first few kilobytes and a scanner identifies the file from its head
# alone — which is the easy case, and which would leave the contract's TAIL probe window completely
# unexercised by any media server. A great many real files are not written that way. Leaving the index at the
# end forces the scanner to seek to the far end of an object it is reading over HTTP Range, which is the read
# pattern this whole appliance exists to make cheap, and the one most likely to degrade into "just download
# the file".
#
# The LOCAL entry keeps `+faststart`, so the two are not only different bytes but different shapes, and the
# local one remains the known-correct baseline the remote path is compared against.
encode "media/$LOCAL_FILE" 40 testsrc 440 faststart
encode "remote/$REMOTE_FILE" 8 testsrc2 660 moov-at-end

LOCAL_SIZE="$(wc -c < "$WORK/media/$LOCAL_FILE" | tr -d ' ')"
REMOTE_SIZE="$(wc -c < "$WORK/remote/$REMOTE_FILE" | tr -d ' ')"
test "$LOCAL_SIZE" -gt 3145728  || die "the local media is under 3 MiB, so the full probe plan would not apply"
test "$REMOTE_SIZE" -gt 3145728 || die "the remote media is under 3 MiB, so the full probe plan would not apply"

# THE DIGESTS ARE RECORDED OUTSIDE THE MOUNT, before anything is published, which is the only kind worth
# comparing against: a hash taken through the thing being verified only proves a file hashes to itself.
LOCAL_SHA="$(node "$REL/sha.cjs" "$REL/media/$LOCAL_FILE")"
REMOTE_SHA="$(node "$REL/sha.cjs" "$REL/remote/$REMOTE_FILE")"
echo "  local  $LOCAL_SIZE bytes, sha256 $LOCAL_SHA"
echo "  remote $REMOTE_SIZE bytes, sha256 $REMOTE_SHA"
# The assertion that makes every later digest comparison discriminating rather than decorative.
test "$LOCAL_SHA" != "$REMOTE_SHA" || die "the two entries are byte-identical, so no read could be mismatched"
test "$LOCAL_SIZE" != "$REMOTE_SIZE" || die "the two entries are the same length, so a size check proves nothing"

# And the source really is what the transcode gate is about to assume it is.
SOURCE_CODEC="$(ffprobe_run -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 \
  "/work/media/$LOCAL_FILE" | tr -d " \r\n")"
test "$SOURCE_CODEC" = "mpeg4" || die "the generated media is $SOURCE_CODEC, not the mpeg4 the transcode gate needs"
echo "  both files decode as mpeg4 video with aac audio"

# ----------------------------------------------------------------------------------------------------------
step "starting the deterministic HTTP Range endpoint, serving the remote object from that file"
# ----------------------------------------------------------------------------------------------------------
# THE ENDPOINT IS internal/fakeprovider, the only "provider" any automated gate here contacts. It serves this
# object FROM THE GENERATED FILE, because a media server has to be able to DECODE what it fetched and the
# deterministic content function has no container header. Its counters are what the amplification budgets are
# measured against, and they are published on loopback so the driver can read them.
REMOTE_REF="obj-projection-remote-two"
docker run -d --name "$RANGE_CONTAINER" --network "$NETWORK" --network-alias fakerange \
  -p "127.0.0.1:${RANGE_PORT}:8099" \
  -v "$PWD:/workspace" -w /workspace/projectiond -v "$WORK/out:/out" -v "$WORK/remote:/remote:ro" \
  -e GOFLAGS=-buildvcs=false -e GOTOOLCHAIN=local -e CGO_ENABLED=0 \
  "$GO_IMAGE" go run ./cmd/fakerange --addr 0.0.0.0:8099 \
  --file-object "${REMOTE_REF}=/remote/${REMOTE_FILE}" --emit /out/objects.json >/dev/null

echo "  waiting for the endpoint to answer a RANGED request"
# THE PROBE SENDS A RANGE HEADER AND ASSERTS THE STATUS LINE. The endpoint is Range-only by construction — a
# request without a Range header is answered 416 on purpose — and busybox wget exits non-zero on a 206 because
# it treats anything but 200 as an error, so the exit code is useless in both directions.
cat > "$WORK/out/probe.sh" <<'PROBE'
set -eu
wget -S --header "Range: bytes=0-1023" -O /dev/null "$1" 2>&1 | grep -q "206 Partial Content"
PROBE

ready=0
for _ in $(seq 1 120); do
  if [ -f "$WORK/out/objects.json" ] && docker run --rm --network "$NETWORK" \
       -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
       sh /probe/probe.sh "http://fakerange:8099/direct/${REMOTE_REF}" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" -eq 1 || { docker logs "$RANGE_CONTAINER" 2>&1 | tail -20 >&2; die "the range endpoint never answered"; }

ENDPOINT_SIZE="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$REMOTE_REF" size)"
ENDPOINT_SHA="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$REMOTE_REF" sha256)"
REMOTE_PROBES="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$REMOTE_REF" probes)"
test "$ENDPOINT_SIZE" = "$REMOTE_SIZE" || die "the endpoint disagrees with the file about its size"
test "$ENDPOINT_SHA" = "$REMOTE_SHA"   || die "the endpoint is not serving the file the gate hashed"
echo "  the endpoint serves exactly the generated file"

# ----------------------------------------------------------------------------------------------------------
step "seeding the catalog through the production write path"
# ----------------------------------------------------------------------------------------------------------
LOCAL_PATH="Movies/Projection Local One (2026)/$LOCAL_FILE"
REMOTE_PATH="Movies/Projection Remote Two (2026)/$REMOTE_FILE"
LOCAL_ITEM="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
REMOTE_ITEM="bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"
THIRD_ITEM="cccccccc-3333-4333-8333-cccccccccccc"
FOURTH_ITEM="dddddddd-4444-4444-8444-dddddddddddd"

register root --id media --kind local
register root --id vault --kind http-range
register version --key local-one --size "$LOCAL_SIZE" --mtime 2026-06-01T10:00:00.000Z

PROBE_FLAGS=""
for probe in $REMOTE_PROBES; do PROBE_FLAGS="$PROBE_FLAGS --probe $probe"; done
# shellcheck disable=SC2086
register version --key remote-two --size "$REMOTE_SIZE" --mtime 2026-06-01T10:00:00.000Z $PROBE_FLAGS

register entry --item "$LOCAL_ITEM"  --version-key local-one  --path "$LOCAL_PATH"  --source "local:media:$LOCAL_FILE"
register entry --item "$REMOTE_ITEM" --version-key remote-two --path "$REMOTE_PATH" --source "http-range:vault:${REMOTE_REF}"
echo "  one local and one HTTP Range stable source registered"

# ----------------------------------------------------------------------------------------------------------
step "publishing generation 1"
# ----------------------------------------------------------------------------------------------------------
publish > "$WORK/out/publish-1.json"
cat "$WORK/out/publish-1.json"
test "$(field outcome  < "$WORK/out/publish-1.json")" = "published" || die "generation 1 was not published"
test "$(field sequence < "$WORK/out/publish-1.json")" = "1"         || die "the first sequence is not 1"

ARTIFACT="$(field artifactName < "$WORK/out/publish-1.json")"
POINTER_DIGEST="$(field manifestDigest < "$WORK/manifest/pointer.json")"
ACTUAL_DIGEST="sha256:$(node "$REL/sha.cjs" "$REL/manifest/$ARTIFACT")"
test "$POINTER_DIGEST" = "$ACTUAL_DIGEST" || die "the pointer digest does not describe the artifact"
echo "  pointer digest verified against the artifact file"

# ----------------------------------------------------------------------------------------------------------
step "mounting with the production image: /dev/fuse, CAP_SYS_ADMIN, strict direct mount, nothing else"
# ----------------------------------------------------------------------------------------------------------
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

start_daemon() {
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
}

await_namespace() {
  local attempts="${1:-180}"
  local n=0
  while [ "$n" -lt "$attempts" ]; do
    if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
         test -f "/mnt/$LOCAL_PATH" >/dev/null 2>&1; then
      return 0
    fi
    n=$((n + 1))
    sleep 0.5
  done
  return 1
}

start_daemon
echo "  waiting for the namespace to become visible to a sibling container"
await_namespace || { docker logs "$MOUNT_CONTAINER" 2>&1 | tail -30 >&2; die "the mount never became visible"; }
echo "  visible"

# ----------------------------------------------------------------------------------------------------------
step "what an ordinary non-root container sees before any media server is involved"
# ----------------------------------------------------------------------------------------------------------
# The baseline. If this fails, nothing a media server does afterwards is interpretable.
cat > "$WORK/out/baseline.sh" <<'BASE'
set -eu
test "$(id -u)" != "0" || { echo "the verifier is root" >&2; exit 1; }
for target in "$@"; do
  test -f "/mnt/$target"  || { echo "not a regular file: $target" >&2; exit 1; }
  test ! -L "/mnt/$target" || { echo "a media server would see a symlink" >&2; exit 1; }
  case "$target" in *.strm) echo "a .strm placeholder is not a projected file" >&2; exit 1;; esac
  test "$(stat -c %a "/mnt/$target")" = "444" || { echo "not read-only: $target" >&2; exit 1; }
  stat -c "    %n size=%s mode=%a inode=%i" "/mnt/$target"
done
BASE
docker run --rm --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges \
  -v "$WORK/mnt:/mnt:rslave" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
  sh /out/baseline.sh "$LOCAL_PATH" "$REMOTE_PATH"

# The expectations the driver compares Jellyfin's answers against, recorded outside the mount.
cat > "$WORK/out/expected.json" <<JSON
[
  { "key": "$LOCAL_FILE",  "sizeBytes": $LOCAL_SIZE,  "sha256": "$LOCAL_SHA",  "kind": "local" },
  { "key": "$REMOTE_FILE", "sizeBytes": $REMOTE_SIZE, "sha256": "$REMOTE_SHA", "kind": "http-range" }
]
JSON

# ----------------------------------------------------------------------------------------------------------
step "starting a REAL Jellyfin, non-root, with the projected mount as its library root"
# ----------------------------------------------------------------------------------------------------------
# THE MOUNT IS DELIBERATELY NOT BOUND READ-ONLY. Adding `:ro` here would make Docker refuse writes and the
# mutation-refusal assertion below would be evidence about a Docker flag rather than about projectiond. What
# has to refuse a media server's write is the daemon.
#
# NON-ROOT because that is how a media server runs on any host somebody has configured properly, and because
# the projected files are mode 444 owned by somebody else — a root reader would prove nothing about whether an
# ordinary uid can open them.
start_jellyfin() {
  docker run -d --name "$JELLYFIN_CONTAINER" \
    --network "$NETWORK" \
    --user 1000:1000 \
    --cap-drop ALL --security-opt no-new-privileges \
    -p "127.0.0.1:${JF_PORT}:8096" \
    -e JELLYFIN_PublishedServerUrl="http://127.0.0.1:${JF_PORT}" \
    -v "$WORK/jf-config:/config" \
    -v "$WORK/jf-cache:/cache" \
    -v "$WORK/mnt:/media/projection:rslave" \
    "$JELLYFIN_IMAGE" >/dev/null
}
start_jellyfin

JF_BASE="http://127.0.0.1:${JF_PORT}"
STATE="$REL/out/state.json"

drive bootstrap --base "$JF_BASE" --state "$STATE" \
  || { docker logs "$JELLYFIN_CONTAINER" 2>&1 | tail -40 >&2; die "the media server never came up"; }
# A bootstrap that exited 0 without leaving a credential behind would fail three commands later with an
# unreadable ENOENT. This turns it into one named failure at the point it happened.
test -s "$WORK/out/state.json" || die "the bootstrap exited 0 but wrote no state"

# THE MEDIA SERVER MUST BE ABLE TO READ THE MOUNT AS ITSELF. Checked from inside its own container, as its own
# uid, before a scan is asked for — otherwise a scan that finds nothing is ambiguous between "projection is
# broken" and "the container cannot see the directory".
docker exec "$JELLYFIN_CONTAINER" test -r "/media/projection/$LOCAL_PATH" \
  || die "the media server's own uid cannot read the projected file"
docker exec "$JELLYFIN_CONTAINER" test ! -L "/media/projection/$LOCAL_PATH" \
  || die "the media server sees a symlink where a file was published"
echo "  the media server can read the projected files as itself"

drive library --state "$STATE" --mount-path /media/projection/Movies --name "Projection Movies"

# ----------------------------------------------------------------------------------------------------------
step "the first real library scan"
# ----------------------------------------------------------------------------------------------------------
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-before-scan.json"
drive scan --state "$STATE" --expect-file "$REL/out/expected.json" --out "$REL/out/items-1.json" --label scan1
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-after-scan.json"

# WHAT THE SCAN COST AT THE PROVIDER. One remote entry; the byte budget is a FRACTION of the object's own
# length, so a scanner that downloaded the file to identify it cannot pass.
#
# AND A FLOOR AS WELL AS A CEILING. The remote entry's index is at the END of the object, so a scanner that
# identified it really did have to fetch from the provider — at least the head and the tail. Zero ranged
# requests would score perfectly against every ceiling above and would mean the media server never opened it.
drive budget --before "$REL/out/counters-before-scan.json" --after "$REL/out/counters-after-scan.json" \
  --gate JD9-scan --entries 1 --bytes "$REMOTE_SIZE" --min-range 1

# ----------------------------------------------------------------------------------------------------------
step "direct play, byte for byte, against digests recorded outside the mount"
# ----------------------------------------------------------------------------------------------------------
drive play --state "$STATE" --items "$REL/out/items-1.json" --key "$LOCAL_FILE" \
  --expect-file "$REL/out/expected.json"
drive play --state "$STATE" --items "$REL/out/items-1.json" --key "$REMOTE_FILE" \
  --expect-file "$REL/out/expected.json"

# ----------------------------------------------------------------------------------------------------------
step "a real HTTP seek through the media server, into the middle of the remote object"
# ----------------------------------------------------------------------------------------------------------
# The window is deliberately past the head probe and not aligned to it, so a daemon that only ever served
# cached probe windows would fail here.
SEEK_OFFSET=$(( REMOTE_SIZE / 2 + 12345 ))
SEEK_LENGTH=131072
SEEK_SHA="$(node "$REL/sha.cjs" "$REL/remote/$REMOTE_FILE" "$SEEK_OFFSET" "$SEEK_LENGTH")"
drive seek --state "$STATE" --items "$REL/out/items-1.json" --key "$REMOTE_FILE" \
  --offset "$SEEK_OFFSET" --length "$SEEK_LENGTH" --expect-sha "$SEEK_SHA"

# The same seek against the LOCAL entry, so the remote path has a known-correct baseline to be compared with.
LOCAL_SEEK_OFFSET=$(( LOCAL_SIZE / 2 + 4321 ))
LOCAL_SEEK_SHA="$(node "$REL/sha.cjs" "$REL/media/$LOCAL_FILE" "$LOCAL_SEEK_OFFSET" "$SEEK_LENGTH")"
drive seek --state "$STATE" --items "$REL/out/items-1.json" --key "$LOCAL_FILE" \
  --offset "$LOCAL_SEEK_OFFSET" --length "$SEEK_LENGTH" --expect-sha "$LOCAL_SEEK_SHA"

# ----------------------------------------------------------------------------------------------------------
step "a forced transcode, proved by decoding what came out"
# ----------------------------------------------------------------------------------------------------------
# The transcode is run against the REMOTE entry on purpose: it is the read pattern that generates
# non-sequential, multi-position reads through the HTTP Range source, which is what the whole design is for.
drive transcode --state "$STATE" --items "$REL/out/items-1.json" --key "$REMOTE_FILE" \
  --out-segment "$REL/out/transcoded.ts" --max-segments 2

test -s "$WORK/out/transcoded.ts" || die "the transcode produced no output to decode"
OUT_CODEC="$(ffprobe_run -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 \
  /work/out/transcoded.ts | head -1 | tr -d " \r\n")"
OUT_FRAMES="$(ffprobe_run -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets \
  -of csv=p=0 /work/out/transcoded.ts | head -1 | tr -d " \r\n")"
echo "  the segment decodes as $OUT_CODEC, $OUT_FRAMES video packets"
test "$OUT_CODEC" = "h264" || die "the media server did not transcode: the output is $OUT_CODEC, the source is mpeg4"
test "${OUT_FRAMES:-0}" -gt 0 || die "the transcoded output has no decodable video packets"
echo "  the source is mpeg4 and the output is h264, so a real re-encode ran"

# ----------------------------------------------------------------------------------------------------------
step "a successor published while a stream is in flight"
# ----------------------------------------------------------------------------------------------------------
rm -f "$WORK/out/stream-ready" "$WORK/out/stream-release"
drive hold-stream --state "$STATE" --items "$REL/out/items-1.json" --key "$REMOTE_FILE" \
  --expect-file "$REL/out/expected.json" \
  --ready "$REL/out/stream-ready" --release "$REL/out/stream-release" &
HOLD_PID=$!

ready=0
for _ in $(seq 1 240); do
  if [ -f "$WORK/out/stream-ready" ]; then ready=1; break; fi
  if ! kill -0 "$HOLD_PID" 2>/dev/null; then break; fi
  sleep 0.5
done
test "$ready" -eq 1 || { wait "$HOLD_PID" || true; die "the stream never became live"; }

THIRD_FILE="Projection Local Three (2026).mp4"
encode "media/$THIRD_FILE" 20 smptebars 880 faststart
THIRD_SIZE="$(wc -c < "$WORK/media/$THIRD_FILE" | tr -d ' ')"
THIRD_SHA="$(node "$REL/sha.cjs" "$REL/media/$THIRD_FILE")"
register version --key local-three --size "$THIRD_SIZE" --mtime 2026-06-01T10:00:00.000Z
register entry --item "$THIRD_ITEM" --version-key local-three \
  --path "Movies/Projection Local Three (2026)/$THIRD_FILE" --source "local:media:$THIRD_FILE"
publish > "$WORK/out/publish-2.json"
test "$(field outcome   < "$WORK/out/publish-2.json")" = "published" || die "the successor was not published"
test "$(field additions < "$WORK/out/publish-2.json")" = "1"         || die "the successor should add exactly one entry"

echo "  waiting for the daemon to admit the successor"
ready=0
for _ in $(seq 1 120); do
  if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
       test -f "/mnt/Movies/Projection Local Three (2026)/$THIRD_FILE" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
test "$ready" -eq 1 || { docker logs "$MOUNT_CONTAINER" 2>&1 | tail -30 >&2; die "the successor never became visible"; }

touch "$WORK/out/stream-release"
wait "$HOLD_PID" || die "the in-flight stream did not survive the generation swap"
echo "  the stream completed correctly across the swap"

cat > "$WORK/out/expected-2.json" <<JSON
[
  { "key": "$LOCAL_FILE",  "sizeBytes": $LOCAL_SIZE,  "sha256": "$LOCAL_SHA",  "kind": "local" },
  { "key": "$REMOTE_FILE", "sizeBytes": $REMOTE_SIZE, "sha256": "$REMOTE_SHA", "kind": "http-range" },
  { "key": "$THIRD_FILE",  "sizeBytes": $THIRD_SIZE,  "sha256": "$THIRD_SHA",  "kind": "local" }
]
JSON

drive scan --state "$STATE" --expect-file "$REL/out/expected-2.json" --out "$REL/out/items-2.json" --label scan2
drive compare --before "$REL/out/items-1.json" --after "$REL/out/items-2.json" \
  --gate JD10-successor --expect-added 1

# ----------------------------------------------------------------------------------------------------------
step "SIGKILL the daemon during playback, then the real recovery path"
# ----------------------------------------------------------------------------------------------------------
rm -f "$WORK/out/kill-ready" "$WORK/out/kill-release"
drive hold-stream --state "$STATE" --items "$REL/out/items-2.json" --key "$REMOTE_FILE" \
  --expect-file "$REL/out/expected-2.json" --allow-interrupt true \
  --ready "$REL/out/kill-ready" --release "$REL/out/kill-release" &
KILL_PID=$!

ready=0
for _ in $(seq 1 240); do
  if [ -f "$WORK/out/kill-ready" ]; then ready=1; break; fi
  if ! kill -0 "$KILL_PID" 2>/dev/null; then break; fi
  sleep 0.5
done
test "$ready" -eq 1 || { wait "$KILL_PID" || true; die "the stream never became live before the kill"; }

echo "  SIGKILL"
docker kill --signal=KILL "$MOUNT_CONTAINER" >/dev/null
docker rm -f "$MOUNT_CONTAINER" >/dev/null 2>&1 || true
# A stale mount must not go on answering as if nothing happened.
docker run --rm --privileged -v "$GATE_ROOT:/gate" "$VERIFY_IMAGE" \
  sh -c "umount -l /gate/$(basename "$WORK")/mnt 2>/dev/null" >/dev/null 2>&1 || true

echo "  restarting and remounting through the ordinary daemon start"
start_daemon
await_namespace || { docker logs "$MOUNT_CONTAINER" 2>&1 | tail -30 >&2; die "the daemon did not remount"; }

# A TRANSIENT SOURCE OUTAGE IS NOT A DELETION. The publisher must still say the same generation is current:
# nothing about a crashed daemon may cause a SMALLER published generation.
publish --status > "$WORK/out/status-after-kill.json"
cat "$WORK/out/status-after-kill.json"
test "$(field agrees         < "$WORK/out/status-after-kill.json")" = "true" || die "the directory and the database disagree after the kill"
test "$(field pointerSequence < "$WORK/out/status-after-kill.json")" = "2"   || die "the published generation moved because a daemon died"
publish > "$WORK/out/publish-after-kill.json"
test "$(field outcome < "$WORK/out/publish-after-kill.json")" = "unchanged" \
  || die "a publish after the kill was not a no-op, so an outage produced a new generation"

touch "$WORK/out/kill-release"
wait "$KILL_PID" || die "the post-kill stream assertion failed"

# Playback is resumable, which is the half of G12 the acceptance plan says IS required.
drive resume --state "$STATE" --items "$REL/out/items-2.json" --key "$REMOTE_FILE" \
  --expect-file "$REL/out/expected-2.json"

drive scan --state "$STATE" --expect-file "$REL/out/expected-2.json" --out "$REL/out/items-3.json" --label scan3
drive compare --before "$REL/out/items-2.json" --after "$REL/out/items-3.json" --gate JD11-recovery

# ----------------------------------------------------------------------------------------------------------
step "restarting the media server, and re-scanning twice more"
# ----------------------------------------------------------------------------------------------------------
docker restart -t 30 "$JELLYFIN_CONTAINER" >/dev/null
# A FRESH LOGIN AGAINST THE SAME INSTALLATION. The wizard is already complete, so this is an ordinary
# authentication; what it proves is that the library, its item ids and the projected paths the server
# persisted all survived the restart. A media server that had stored a path it could not resolve again, or
# that re-created its items, fails the comparison below rather than this line.
drive bootstrap --base "$JF_BASE" --state "$STATE"

drive scan --state "$STATE" --expect-file "$REL/out/expected-2.json" \
  --out "$REL/out/items-4.json" --label scan4
drive compare --before "$REL/out/items-3.json" --after "$REL/out/items-4.json" --gate JD12-server-restart

# A RE-SCAN OVER AN UNCHANGED GENERATION MUST COST THE PROVIDER NOTHING IT HAS NOT ALREADY PAID. The window
# is drawn tightly around the re-scan alone, because everything else in this run -- a full direct play, a
# transcode -- legitimately fetches bytes, and a delta taken over those would say nothing about a scan.
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-before-rescan.json"
drive scan --state "$STATE" --expect-file "$REL/out/expected-2.json" \
  --out "$REL/out/items-5.json" --label scan5
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-after-rescan.json"
drive compare --before "$REL/out/items-4.json" --after "$REL/out/items-5.json" --gate JD13-rescan-churn
drive budget --before "$REL/out/counters-before-rescan.json" --after "$REL/out/counters-after-rescan.json" \
  --gate JD14-rescan --entries 1 --bytes 0 --windows 0

# THE WHOLE-RUN PROVIDER INVARIANTS ARE TAKEN HERE, and here rather than at the very end for a reason: the
# source-outage step below stops and restarts the endpoint process, which resets its counters. A snapshot
# taken after that would describe the last few seconds of the run and would be read as describing all of it.
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-final.json"
drive provider-invariants --counters "$REL/out/counters-final.json" --gate JD15-provider

# ----------------------------------------------------------------------------------------------------------
step "a generation admitted WHILE A SCAN IS RUNNING"
# ----------------------------------------------------------------------------------------------------------
# The successor test above swapped a generation under an open PLAYBACK. This one swaps it under an open SCAN,
# which is a different hazard: the scanner is walking the namespace, and the namespace changes beneath it.
#
# WHAT IS ASSERTED IS NOT WHAT THE RACED SCAN SAW. It may legitimately have seen the predecessor, the
# successor, or a mixture, and asserting a count against any of them would be asserting the outcome of a race.
# What must hold is that nothing half-formed appears, and that the NEXT scan converges on the successor with
# zero removals and zero item-id churn for everything carried across.
FOURTH_FILE="Projection Local Four (2026).mp4"
encode "media/$FOURTH_FILE" 10 testsrc 990 faststart
FOURTH_SIZE="$(wc -c < "$WORK/media/$FOURTH_FILE" | tr -d ' ')"
FOURTH_SHA="$(node "$REL/sha.cjs" "$REL/media/$FOURTH_FILE")"
register version --key local-four --size "$FOURTH_SIZE" --mtime 2026-06-01T10:00:00.000Z
register entry --item "$FOURTH_ITEM" --version-key local-four \
  --path "Movies/Projection Local Four (2026)/$FOURTH_FILE" --source "local:media:$FOURTH_FILE"

drive scan --state "$STATE" --expect-file "$REL/out/expected-2.json" \
  --out "$REL/out/items-6.json" --label scan6 --tolerant true &
SCAN_PID=$!
# Publish into the middle of it. The scan takes a few seconds; the publish takes well under one.
sleep 1
publish > "$WORK/out/publish-midscan.json"
test "$(field outcome   < "$WORK/out/publish-midscan.json")" = "published" || die "the mid-scan successor was not published"
test "$(field additions < "$WORK/out/publish-midscan.json")" = "1"         || die "the mid-scan successor should add exactly one entry"
wait "$SCAN_PID" || die "a scan raced against a publish did not complete"
echo "  a generation was admitted while the scanner was walking the namespace"

cat > "$WORK/out/expected-3.json" <<JSON
[
  { "key": "$LOCAL_FILE",  "sizeBytes": $LOCAL_SIZE,  "sha256": "$LOCAL_SHA",  "kind": "local" },
  { "key": "$REMOTE_FILE", "sizeBytes": $REMOTE_SIZE, "sha256": "$REMOTE_SHA", "kind": "http-range" },
  { "key": "$THIRD_FILE",  "sizeBytes": $THIRD_SIZE,  "sha256": "$THIRD_SHA",  "kind": "local" },
  { "key": "$FOURTH_FILE", "sizeBytes": $FOURTH_SIZE, "sha256": "$FOURTH_SHA", "kind": "local" }
]
JSON

# The convergence assertion, which is the one that matters.
drive scan --state "$STATE" --expect-file "$REL/out/expected-3.json" \
  --out "$REL/out/items-7.json" --label scan7
drive compare --before "$REL/out/items-5.json" --after "$REL/out/items-7.json" \
  --gate JD16-midscan-swap --expect-added 1

# ----------------------------------------------------------------------------------------------------------
step "a source outage is not a deletion, and does not shrink a published generation"
# ----------------------------------------------------------------------------------------------------------
# Take the provider away entirely. The namespace is metadata the control plane published, held by the daemon,
# and it must not move — the entry stays visible with the same size and the same inode, and a publish over the
# unmoved catalog must still be a no-op rather than a smaller generation. This is the media-server-visible
# half of what G6 says: an outage is not a deletion.
BEFORE_STAT="$(docker run --rm --user 65534:65534 --cap-drop ALL -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
  stat -c "%s %i %a" "/mnt/$REMOTE_PATH")"
docker stop -t 10 "$RANGE_CONTAINER" >/dev/null
echo "  the provider is down"

AFTER_STAT="$(docker run --rm --user 65534:65534 --cap-drop ALL -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
  stat -c "%s %i %a" "/mnt/$REMOTE_PATH")"
test "$BEFORE_STAT" = "$AFTER_STAT" \
  || die "the entry's size, inode or mode changed because its source went away ($BEFORE_STAT -> $AFTER_STAT)"
echo "  the entry is still there, byte-identically described: $AFTER_STAT"

publish --status > "$WORK/out/status-outage.json"
test "$(field agrees < "$WORK/out/status-outage.json")" = "true" || die "the directory and the database disagree during an outage"
publish > "$WORK/out/publish-outage.json"
test "$(field outcome < "$WORK/out/publish-outage.json")" = "unchanged" \
  || die "a publish during a source outage was not a no-op, so an outage produced a new generation"
test "$(field deletions < "$WORK/out/publish-outage.json")" = "0" \
  || die "a source outage produced a deletion"
echo "  a publish during the outage minted nothing and deleted nothing"

docker start "$RANGE_CONTAINER" >/dev/null
ready=0
for _ in $(seq 1 120); do
  if docker run --rm --network "$NETWORK" -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
       sh /probe/probe.sh "http://fakerange:8099/direct/${REMOTE_REF}" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
test "$ready" -eq 1 || die "the provider never came back"
# ...and the entry reads correctly again, which is what makes the outage transient rather than terminal.
drive resume --state "$STATE" --items "$REL/out/items-7.json" --key "$REMOTE_FILE" \
  --expect-file "$REL/out/expected-3.json"
echo "  and reads through the media server are correct again once it returns"

# ----------------------------------------------------------------------------------------------------------
step "the media server cannot write to the projection, and the daemon is what refuses"
# ----------------------------------------------------------------------------------------------------------
# Run INSIDE the media server's own container, as its own non-root uid, against a mount that was NOT bound
# read-only. Every one of these is refused by projectiond.
cat > "$WORK/out/mutate.sh" <<'MUT'
set -eu
root=/media/projection
test "$(id -u)" != "0" || { echo "the media server is running as root" >&2; exit 1; }
target="$root/$1"
( : > "$target" ) 2>/dev/null && { echo "truncate succeeded" >&2; exit 1; }
( rm -f "$target" ) 2>/dev/null && test ! -e "$target" && { echo "unlink succeeded" >&2; exit 1; }
( mkdir "$root/newdir" ) 2>/dev/null && { echo "mkdir succeeded" >&2; exit 1; }
( echo x > "$root/newfile" ) 2>/dev/null && { echo "create succeeded" >&2; exit 1; }
( ln -s /etc/passwd "$root/link" ) 2>/dev/null && { echo "symlink succeeded" >&2; exit 1; }
( chmod 666 "$target" ) 2>/dev/null && { echo "chmod succeeded" >&2; exit 1; }
test -f "$target" || { echo "the file is gone after the attempts" >&2; exit 1; }
echo "every mutation refused, and the file is intact"
MUT
# FED THROUGH STDIN RATHER THAN `docker cp`. The media server's container is already running, so the script
# cannot be bind-mounted in; and `docker cp` takes a HOST path, which on an MSYS shell is `/c/Users/...` — a
# spelling the Windows docker binary cannot resolve, unlike the `-v` sources Docker Desktop normalises. `sh -s`
# reads the program from stdin and still takes positional arguments, so the redirection is done by the shell
# that understands the path.
docker exec -i "$JELLYFIN_CONTAINER" sh -s "$LOCAL_PATH" < "$WORK/out/mutate.sh"

# ----------------------------------------------------------------------------------------------------------
step "no access URL, token, header or expiry was persisted anywhere"
# ----------------------------------------------------------------------------------------------------------
# The manifest artifact, the daemon's probe cache and the media server's own state, searched for the endpoint
# the daemon actually contacted and for the shapes access material takes. The media server was handed a
# FILESYSTEM PATH and nothing else; if it had been handed a URL, this is where it would show up.
cat > "$WORK/out/leakcheck.sh" <<'LEAK'
set -eu
label="$1"
shift
found=0
for pattern in "$@"; do
  if grep -rlF "$pattern" /scan 2>/dev/null | head -5 | grep -q .; then
    echo "LEAK: '$pattern' appears under $label" >&2
    grep -rlF "$pattern" /scan 2>/dev/null | head -5 >&2
    found=1
  fi
done
test "$found" -eq 0
LEAK

# THE MANIFEST DIRECTORY IS TEXT the control plane authored, so a bare `://` there is conclusive: nothing the
# publisher writes has any business containing one.
docker run --rm -v "$WORK/manifest:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
  sh /out/leakcheck.sh "the published manifest directory" \
  "fakerange" "://" "X-Fake-Lease" "expiresAtUnixMs" "Authorization:" "Bearer " \
  || die "the manifest directory holds access material"

# THE PROBE CACHE IS MEDIA BYTES, and `://` is not a usable signal against it. This is not a relaxation to get
# a run green — it is a correction of a check that was measuring the wrong thing. A cached probe window is a
# verbatim megabyte of a compressed video stream, and the media this gate generates contains THIRTEEN
# occurrences of the three-byte sequence `://` in its `mdat`, purely as compressed data. A check that fires on
# those is not evidence about access material; it is evidence that a 1-in-16-million byte pattern occurs in a
# few megabytes of high-entropy data, which it does.
#
# So the cache is searched for the things that could only have got there from a leak: the endpoint's own host
# name, a real URL scheme, the fake provider's lease header, an expiry field and an authorization header.
docker run --rm -v "$WORK/cache:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
  sh /out/leakcheck.sh "the daemon probe cache" \
  "fakerange" "http://" "https://" "X-Fake-Lease" "expiresAtUnixMs" "Authorization:" "Bearer " \
  || die "the probe cache holds access material"

# ...AND THE CACHE IS NOT A COPY OF THE LIBRARY. The scan-window cache is supposed to hold three fixed
# megabyte windows per projected version, not the object. If a read path ever started writing whole files
# through it, no substring check would notice — but the size would. The ceiling is generous on purpose: what
# it rules out is an order of magnitude, not a byte.
CACHE_BYTES="$(docker run --rm -v "$WORK/cache:/scan:ro" "$VERIFY_IMAGE" \
  sh -c 'du -sb /scan 2>/dev/null | cut -f1' | tr -d " \r\n")"
# Three entries, at most three one-megabyte windows each, plus a record header per window and some slack.
CACHE_CEILING=$(( 12 * 1048576 ))
PUBLISHED_BYTES=$(( LOCAL_SIZE + REMOTE_SIZE + THIRD_SIZE + FOURTH_SIZE ))
echo "  the probe cache holds $CACHE_BYTES bytes against $PUBLISHED_BYTES bytes published"
test "${CACHE_BYTES:-0}" -le "$CACHE_CEILING" \
  || die "the probe cache holds $CACHE_BYTES bytes, which is more than a fixed window plan can account for"
test "${CACHE_BYTES:-0}" -lt "$PUBLISHED_BYTES" \
  || die "the probe cache is as large as the library it is caching windows of"
echo "  the manifest directory and the probe cache hold no access material"

# The media server's own library database must hold the projected PATH and nothing about a provider.
docker run --rm -v "$WORK/jf-config:/scan:ro" "$VERIFY_IMAGE" \
  sh -c 'grep -rlF "fakerange" /scan 2>/dev/null | head -3' > "$WORK/out/jf-leak.txt" || true
test ! -s "$WORK/out/jf-leak.txt" || { cat "$WORK/out/jf-leak.txt" >&2; die "the media server persisted the provider endpoint"; }
echo "  the media server's own state names no provider endpoint"

# ----------------------------------------------------------------------------------------------------------
step "stopping the daemon: the namespace goes away, and a stale one does not linger"
# ----------------------------------------------------------------------------------------------------------
docker stop -t 30 "$MOUNT_CONTAINER" >/dev/null
gone=0
for _ in $(seq 1 60); do
  if ! docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" test -d /mnt/Movies >/dev/null 2>&1; then
    gone=1; break
  fi
  sleep 0.5
done
test "$gone" -eq 1 || die "the namespace is still visible after the daemon stopped"
echo "  gone"

# ----------------------------------------------------------------------------------------------------------
step "the report"
# ----------------------------------------------------------------------------------------------------------
drive redaction-check --file "$REL/out/results.json"
npx tsx src/ops/projection-jellyfin-dataplane-cli.ts report --results "$REL/out/results.json"

echo
echo "media-server data-plane gate PASSED. Exactly what was proved:"
echo "  - a real, digest-pinned Jellyfin container, stood up non-interactively through its own first-run API,"
echo "    running NON-ROOT, with the FUSE mount bind-propagated in as a Movies library root."
echo "  - legal synthetic media generated on this machine by the ffmpeg inside that image. Nothing downloaded,"
echo "    nothing copyrighted, no fixture committed."
echo "  - a real library scan that found both items, with the sizes the control plane published and the media"
echo "    server's own view of them as ORDINARY FILES -- not symlinks, not .strm placeholders, not remote"
echo "    media sources."
echo "  - direct play of both, digest-compared against values recorded OUTSIDE the mount; a real HTTP seek"
echo "    whose 206 and Content-Range were asserted before the body was read."
echo "  - a forced transcode proved by DECODING its output: mpeg4 in, h264 out."
echo "  - a successor published mid-stream (the stream completed correctly), and a SIGKILL of the daemon"
echo "    mid-stream followed by the ordinary restart-and-remount: playback resumable, the published"
echo "    generation unmoved, and zero removals, zero duplicates and zero item-id churn on every re-scan."
echo "  - every mutation from the media server's own non-root container refused BY THE DAEMON, against a"
echo "    mount deliberately not bound read-only."
echo "  - no access URL, token, header or expiry persisted in the manifest directory, the probe cache or the"
echo "    media server's own state."
echo
echo "WHAT THIS GATE DOES NOT PROVE. A Docker Desktop pass is NOT Linux/Unraid closure and SHALL NOT be"
echo "reported as one. Plex, Emby, a real Unraid host and a real provider endpoint remain entirely unproved,"
echo "and the acceptance plan closes the tranche only on a Linux/Unraid run, three consecutive times."
