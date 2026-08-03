#!/usr/bin/env bash
# The EMBY data-plane gate: PostgreSQL -> the production publisher -> the production projectiond image -> a
# FUSE mount -> a REAL EMBY that scans, direct-plays, seeks and transcodes out of it.
#
# WHY A THIRD MEDIA SERVER, AND WHY IT IS NOT THE JELLYFIN GATE WITH A DIFFERENT IMAGE. Emby is the server
# Jellyfin was forked from, so the endpoint spellings are largely shared and the temptation to parameterise is
# strong. FIVE of the Jellyfin gate's hardest-won BEHAVIOURAL conclusions were measured against a live,
# digest-pinned Emby 4.9.5.0 and found to be FALSE for it:
#
#   1. `/System/Info/Public` carries NO `StartupWizardCompleted`. The Jellyfin driver keys its bootstrap
#      idempotency on that field; against Emby it reads `undefined !== true`, which is ALWAYS true, so a copied
#      bootstrap would re-run the first-run wizard on every invocation — including the post-restart re-login
#      this gate performs precisely to prove the installation SURVIVED. What replaces it is measured: an
#      unauthenticated `GET /Startup/Configuration` answers 200 before the wizard and 401 after it.
#   2. THE DIRECT-PLAY ENDPOINT IS NOT ANONYMOUS. The pinned Jellyfin answers `static=true` direct play 200
#      with the whole file to a request carrying no credential; the pinned Emby answers it 401. That is a
#      claim the Jellyfin gate had to DECLINE to make, and this gate asserts it — by issuing the unauthorized
#      request and requiring the refusal. It also costs something: the paced consumer now needs a credential,
#      which it reads from a file rather than from a command line.
#   3. THE ENCODING CONFIGURATION HAS NO TRANSCODING TEMP PATH AND NO THROTTLE DELAY. Jellyfin's gate sets
#      both, and its comment says the temp path is what makes the encoder observable at all. Emby's encoding
#      configuration has seventeen keys and neither of those. So this gate BINDS `/config/transcoding-temp`
#      instead of configuring a path, and asserts the bind exists so a zero-file soak means the encoder wrote
#      nothing rather than that the gate looked in the wrong place.
#   4. HLS SEGMENT URLS CARRY NO `runtimeTicks`. Jellyfin's do, and its seek gate reads the server's own
#      position out of them. Emby's are `hls1/main/{N}.ts?PlaySessionId=…` and nothing else. The position
#      therefore comes from the cumulative `#EXTINF` sums of the server's own playlist — still the server's
#      arithmetic, and verified against a decoder: segments 1, 106 and 22 declared 3 s, 318 s and 66 s and
#      decoded at 13.0 s, 328.0 s and 76.0 s, a constant 10.0 s offset in all three.
#   5. `docker exec` LANDS AS ROOT. Emby's image drops privilege internally from `UID`/`GID` rather than
#      running under `--user`, so a write-refusal script that asserts `id -u != 0` inline — as Jellyfin's does
#      — fails here. This gate runs the mutation attempts TWICE, as the server's own uid AND as root, and
#      asserts both: the first is the claim that matters, the second is the stronger claim that the DAEMON is
#      what refuses, since no permission bit is standing in the way.
#
# WHAT IT PROVES, AND WHY EACH PART IS HERE.
#
#   1. A REAL, MIGRATED POSTGRESQL and the production write path: one LOCAL stable source and one HTTP RANGE
#      stable source, registered through ops:projection-register, published by ops:projection-publish.
#   2. LEGAL, SYNTHETIC MEDIA GENERATED ON THIS MACHINE, by the ffmpeg inside the pinned Emby image. Nothing
#      is downloaded, nothing copyrighted is touched, no fixture is committed. Digests and byte lengths are
#      recorded OUTSIDE the mount, before anything is published.
#   3. THE ALREADY-MERGED PRODUCTION IMAGE, strict-direct-mounted with /dev/fuse and CAP_SYS_ADMIN and nothing
#      else, its namespace bind-propagated to sibling containers.
#   4. EMBY AS AN ORDINARY CONTAINER whose server process runs as uid 1000, with the mount as its library root.
#   5. DIRECT PLAY, byte for byte, against digests recorded outside the mount — and the anonymous negative
#      control this server makes possible.
#   6. A FORCED TRANSCODE, proved by DECODING what came out: mpeg4 in, h264 demanded, the segments ffprobed.
#   7. THE FIVE-MINUTE HALF: ten media-time seeks, five minutes of paced direct play, five minutes of paced
#      continuously decoded transcoded playback.
#   8. THE VIOLENT HALF: a successor published under a held-open stream, a SIGKILL of the daemon mid-stream and
#      the real recovery path, a media-server restart, a generation admitted mid-scan, and a provider outage.
#   9. MUTATION REFUSED FROM EMBY'S OWN CONTAINER, at the daemon rather than at a Docker flag: the mount is
#      deliberately NOT bound read-only.
#
# WHAT IT DOES NOT PROVE, AND WILL NOT BE PRESENTED AS PROVING. A Docker Desktop pass is NOT Linux/Unraid
# closure. A real Unraid host and a real provider endpoint remain entirely unproved, and
# docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md says the tranche closes on a Linux/Unraid run, on all three media
# servers, three times.
#
# EVERYTHING IS BOUNDED. Every readiness probe, read, scan, transcode and wait has a hard deadline; a hang
# fails the gate rather than occupying the machine.
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
GO_IMAGE="golang:1.26.5-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
# THE MEDIA SERVER, PINNED BY DIGEST. A tag would let the thing under test change between two runs of a gate
# whose entire claim is that it passed three times in a row. Every measured finding in
# src/core/projection/emby-dataplane.ts belongs to the version behind THIS digest, and the gate asserts the
# version it actually meets so a moved digest is a named failure rather than a silent inheritance.
EMBY_IMAGE="emby/embyserver@sha256:734a6f03c7c783a9e566b08d09a2b6376f41229ff29f032a7e00302e0be98f8a"
# MEASURED: `find / -name ffmpeg -type f` inside that image. Jellyfin's live under /usr/lib/jellyfin-ffmpeg,
# and Plex ships no ffprobe at all — which is why THAT gate has to borrow a third party's decoder and this one
# does not.
EMBY_FFMPEG="/bin/ffmpeg"
EMBY_FFPROBE="/bin/ffprobe"
# MEASURED: Emby writes its transcoding scratch here and its encoding configuration exposes no way to move it.
EMBY_TRANSCODE_SUBDIR="transcoding-temp"

COMPOSE_FILE="docker-compose.projection-emby.yml"
NETWORK="projection-emby-gate"
PG_PORT="${PROJECTION_EMBY_GATE_PG_PORT:-5500}"
EMBY_PORT="${PROJECTION_EMBY_GATE_HTTP_PORT:-8100}"
RANGE_PORT="${PROJECTION_EMBY_GATE_RANGE_PORT:-8101}"
DAEMON_STATUS_PORT=9099

MOUNT_CONTAINER="projection-em-mount-$$"
RANGE_CONTAINER="projection-em-range-$$"
EMBY_CONTAINER="projection-em-server-$$"
# The PACED CONSUMER, named so the cleanup trap can remove it: it runs for five minutes, and a gate that
# failed halfway through one would otherwise leave an ffmpeg reading the mount for the rest of the run — and a
# stale reader is what stops a FUSE mount unmounting cleanly, which is how the NEXT run inherits a namespace
# and passes for the wrong reason.
PLAY_CONTAINER="projection-em-play-$$"

# TWO SPELLINGS OF ONE DIRECTORY: WORK is absolute and is what Docker bind mounts name, and it lives beside
# the repository because bind propagation needs a shared host mount; REL is relative and is what node and tsx
# are given, because an MSYS absolute path is not something a Windows node binary can open.
GATE_ROOT="$PWD/.projection-emby-gate"
REL=".projection-emby-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_EMBY_GATE_PG_PORT="$PG_PORT"

cleanup() {
  # THE MEDIA SERVER FIRST. It holds open handles on the mount, and a FUSE mount with a live reader does not
  # unmount cleanly — leaving one behind is how the NEXT run inherits a stale namespace and passes for the
  # wrong reason.
  docker rm -f "$PLAY_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$EMBY_CONTAINER" >/dev/null 2>&1 || true
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
drive()    { npx tsx src/ops/projection-emby-dataplane-cli.ts "$@" --results "$REL/out/results.json"; }
ffmpeg_run()  { docker run --rm --entrypoint "$EMBY_FFMPEG"  -v "$WORK:/work" "$EMBY_IMAGE" "$@"; }
ffprobe_run() { docker run --rm --entrypoint "$EMBY_FFPROBE" -v "$WORK:/work" "$EMBY_IMAGE" "$@"; }

mkdir -p "$WORK/manifest" "$WORK/media" "$WORK/remote" "$WORK/cache" "$WORK/mnt" "$WORK/out" \
         "$WORK/emby-config"
# The media server's server process runs non-root and owns nothing on this host, so its state directory is
# made writable by whoever it turns out to be. The MEDIA is not: it is 444 through the mount, and that is
# under test.
chmod 777 "$WORK/cache" "$WORK/mnt" "$WORK/out" "$WORK/emby-config"
# ...AND THE PATH INTO THEM IS TRAVERSABLE BY A UID THAT DID NOT CREATE IT.
#
# A DEFECT DOCKER DESKTOP CANNOT SHOW YOU. The permissive directories above are reached THROUGH `$GATE_ROOT`
# and `$WORK`, which `mkdir -p` created under whatever umask the operator happens to have. At the common 022
# they land at 0755 and everything works; at 077 -- an ordinary hardened default, and one some operators set
# for root -- they land at 0700, and a container running as uid 1000 cannot traverse into them however
# permissive the leaf is. The five-minute paced play then dies on a permission error four phases in.
#
# On Docker Desktop none of this is visible, because the host side of a bind carries no modes at all. So the
# traversal is made explicit rather than inherited: 0755, not 0777, because traversal is all that is needed
# and the writable leaves are already 0777.
chmod 755 "$GATE_ROOT" "$WORK"


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

cat > "$WORK/counters.cjs" <<'COUNTERS'
// One counter from the endpoint, for the shell. Bounded, like everything else here.
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 15000);
fetch(process.argv[2], { signal: controller.signal })
  .then((response) => response.json())
  .then((snapshot) => { clearTimeout(timer); console.log(String(snapshot[process.argv[3]] ?? 0)); })
  .catch((error) => { clearTimeout(timer); console.error(`counters failed: ${error.name}`); process.exit(1); });
COUNTERS

cat > "$WORK/ctl.cjs" <<'CTL'
// Drive the fake endpoint's hold/release control surface. Bounded, and a non-2xx is a failure.
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 15000);
fetch(process.argv[2], { method: 'POST', signal: controller.signal })
  .then((response) => {
    clearTimeout(timer);
    if (!response.ok) { console.error(`control answered ${response.status}`); process.exit(1); }
  })
  .catch((error) => { clearTimeout(timer); console.error(`control failed: ${error.name}`); process.exit(1); });
CTL

cat > "$WORK/expect.cjs" <<'EXPECT'
// Build an expectation file: a base file (or `-`), plus entries given as groups of five arguments —
// key, size, sha256, kind, anchor. ONE document per generation, rather than a heredoc that has to be edited
// in three places every time the corpus grows.
const { readFileSync, writeFileSync } = require('node:fs');
const [, , out, base, ...rest] = process.argv;
const entries = base === '-' ? [] : JSON.parse(readFileSync(base, 'utf8'));
if (rest.length % 5 !== 0) { console.error('an expectation is key size sha kind anchor'); process.exit(1); }
for (let i = 0; i < rest.length; i += 5) {
  entries.push({
    key: rest[i], sizeBytes: Number(rest[i + 1]), sha256: rest[i + 2], kind: rest[i + 3],
    anchor: rest[i + 4] === 'anchor',
  });
}
writeFileSync(out, `${JSON.stringify(entries, null, 2)}\n`);
console.log(String(entries.length));
EXPECT

cat > "$WORK/corpus.cjs" <<'CORPUS'
// THE ~50-ENTRY CORPUS, described once, from the files that were actually generated.
//
// It emits three documents from one walk: what to register, what to expect, and the byte totals the scan
// budget needs as its two denominators. Deriving all three from the same walk is what stops the gate from
// asserting a corpus that differs from the one it published.
//
// EVERY REMOTE ENTRY IS CROSS-CHECKED AGAINST THE ENDPOINT before it is registered. If the endpoint's own
// size and digest disagree with what this walk found, the gate would be publishing a manifest describing one
// byte stream and reading another, and every later digest comparison would be measuring the wrong thing.
const { readFileSync, writeFileSync, statSync } = require('node:fs');
const { createHash } = require('node:crypto');
const [, , work, totalRaw, localRaw] = process.argv;
const total = Number(totalRaw);
const localCount = Number(localRaw);
const objects = JSON.parse(readFileSync(`${work}/out/objects.json`, 'utf8'));
const byRef = new Map(objects.map((object) => [object.ref, object]));

const versions = [];
const entries = [];
const expected = [];
let smallRemoteBytes = 0;
let localBytes = 0;
for (let index = 1; index <= total; index += 1) {
  const n = String(index).padStart(2, '0');
  const file = `Projection Corpus ${n} (2026).mp4`;
  const local = index <= localCount;
  const onDisk = `${work}/${local ? 'media' : 'remote'}/${file}`;
  const bytes = readFileSync(onDisk);
  const size = statSync(onDisk).size;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ref = `obj-projection-corpus-${n}`;
  let probes = [];
  if (!local) {
    const object = byRef.get(ref);
    if (!object) { console.error(`the endpoint is not serving corpus entry ${n}`); process.exit(1); }
    if (object.size !== size || object.sha256 !== sha256) {
      console.error(`the endpoint and the file disagree about corpus entry ${n}`);
      process.exit(1);
    }
    probes = object.probes.map((probe) => `${probe.position}:${probe.offset}:${probe.length}:${probe.sha256}`);
    smallRemoteBytes += size;
  } else {
    localBytes += size;
  }
  versions.push({ key: `corpus-${n}`, size, mtime: '2026-06-01T10:00:00.000Z', probes });
  entries.push({
    // A DETERMINISTIC ITEM ID PER INDEX, so two runs register the same corpus and a diff between two runs is
    // a difference in behaviour rather than in identifiers.
    item: `f0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    versionKey: `corpus-${n}`,
    path: `Movies/Projection Corpus ${n} (2026)/${file}`,
    sources: [local ? `local:media:${file}` : `http-range:vault:${ref}`],
  });
  expected.push({ key: file, sizeBytes: size, sha256, kind: local ? 'local' : 'http-range' });
}

writeFileSync(`${work}/out/corpus-register.json`, `${JSON.stringify({ versions, entries }, null, 2)}\n`);
writeFileSync(`${work}/out/corpus-expected.json`, `${JSON.stringify(expected, null, 2)}\n`);
writeFileSync(`${work}/out/corpus-totals.json`, `${JSON.stringify({
  entries: expected.length,
  localEntries: localCount,
  remoteEntries: total - localCount,
  smallRemoteBytes,
  localBytes,
}, null, 2)}\n`);
console.log(String(expected.length));
CORPUS

cat > "$WORK/cacheceiling.cjs" <<'CEILING'
// The most a fixed-window probe cache can legitimately hold for one corpus.
//
// IT IS COMPUTED FROM THE CORPUS RATHER THAN WRITTEN DOWN. A flat constant that was right for two entries
// would be a ceiling nothing could reach for fifty, and a ceiling that cannot be reached is not a ceiling.
// Per entry the plan allows three one-megabyte windows, or the whole object when the object is smaller than
// the contract's single-probe threshold — plus generous slack, because what this rules out is an order of
// magnitude, not a byte.
const { readFileSync } = require('node:fs');
const WINDOW = 1048576;
const SINGLE_PROBE_BELOW = 3 * WINDOW;
const expected = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let ceiling = 0;
for (const entry of expected) {
  ceiling += entry.sizeBytes < SINGLE_PROBE_BELOW ? entry.sizeBytes : 3 * WINDOW;
}
console.log(String(Math.floor(ceiling * 1.5) + 4 * 1048576));
CEILING

cat > "$WORK/published.cjs" <<'PUBLISHED'
// Total bytes across a published generation, from the same document every scan assertion is made against.
const { readFileSync } = require('node:fs');
const entries = JSON.parse(readFileSync(process.argv[2], 'utf8'));
console.log(String(entries.reduce((total, entry) => total + entry.sizeBytes, 0)));
PUBLISHED

cat > "$WORK/probes.cjs" <<'PROBES'
// Turn a directory of decoded-segment reports into the JSON the verify phases read.
//
// ONE CONTAINER DECODES EVERY SEGMENT AND WRITES ONE LINE PER FILE — `index|codec|packets|seconds`. This does
// no deciding: a segment that decoded as nothing at all still becomes a record with an empty codec and zero
// packets, so the phase that holds them against the acceptance plan sees a failure rather than an absence.
const { readFileSync, writeFileSync } = require('node:fs');
const lines = readFileSync(process.argv[2], 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
const probes = lines.map((line) => {
  const [index, codec, packets, seconds] = line.split('|');
  return {
    index: Number(index),
    codec: (codec ?? '').trim(),
    packets: Number(packets) || 0,
    seconds: Number(seconds) || 0,
  };
});
writeFileSync(process.argv[3], `${JSON.stringify(probes, null, 2)}\n`);
console.log(String(probes.length));
PROBES

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
# A SKIP IS NOT A PASS, AND IT DOES NOT EXIT 0.
#
# On a host with no /dev/fuse, an exit of 0 would produce a "successful" run whose only warning was on stderr
# — exactly the shape a required Linux/Unraid acceptance invocation would have if somebody ran it somewhere the
# mount could not exist. A green tranche-closing command that proved nothing is the single worst failure this
# repository can have.
#
# 77 is the conventional "skipped" status. It is NOT 0, so anything that treats zero as success — a shell, a
# CI step, the three-run wrapper — reports a skip as a non-success. A host where skip-as-success is genuinely
# wanted has its own entry point: deploy/projection-emby-dataplane-gate-optional.sh, which maps 77 to 0 and
# nothing else.
GATE_SKIP_STATUS=77
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no /dev/fuse is reachable from a container on this host." >&2
  echo "      The EMBY DATA PLANE is entirely UNPROVEN here. Nothing in this gate ran, and this run closes" >&2
  echo "      NO acceptance gate. It is not a pass and must not be reported as one." >&2
  exit "$GATE_SKIP_STATUS"
fi
echo "  /dev/fuse is reachable from a container"

# ----------------------------------------------------------------------------------------------------------
# ...AND WHETHER ITS MOUNTS LET THE DAEMON PUBLISH A NAMESPACE AT ALL.
#
# THE FAILURE THIS CATCHES IS THE MOST LIKELY FIRST FAILURE OF THE FIRST UNRAID RUN, and no run on Docker
# Desktop could ever have revealed it. The daemon binds its mount point `rshared` so the FUSE namespace it
# creates inside its container becomes visible to the media server beside it, and the kernel only permits
# `rshared` on a bind whose SOURCE IS ALREADY A SHARED MOUNT. Docker refuses the container outright otherwise
# -- the daemon never starts. On Docker Desktop the bind source lives inside Docker's own Linux VM, whose root
# is shared, so the condition holds by construction; Unraid is not systemd, and a checkout under /mnt/user is
# on a FUSE share. Neither is shared by default.
#
# IT DIAGNOSES AND DOES NOT REPAIR. Making a host mount shared changes the machine the operator is standing
# on and outlives the run, so the check names the remedy rather than performing it.
#
# `--require` MAKES A `not-shared` ANSWER FATAL, and an UNDETERMINED one is deliberately not: a Windows host
# publishes no /proc/self/mountinfo and the gates demonstrably pass there. A check that cannot run says so on
# stderr rather than passing quietly.
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

# ----------------------------------------------------------------------------------------------------------
step "generating legal synthetic media on this machine"
# ----------------------------------------------------------------------------------------------------------
# NOTHING IS DOWNLOADED AND NOTHING IS COMMITTED. `testsrc` is ffmpeg's own generated test pattern and `sine`
# is a generated tone; both are produced here, by the ffmpeg inside the pinned media-server image, and thrown
# away with the run directory.
#
# THE VIDEO CODEC IS MPEG4 ON PURPOSE. The transcode gate asks the media server for h264, and a server given a
# source it can already stream will remux rather than re-encode — which would make "a transcode ran" a claim
# about an endpoint rather than a measurement of an encoder.
#
# THE FILES ARE OVER 3 MiB so the contract's full three-window probe plan applies rather than its
# single-window one; a remote entry read through one window would not exercise the seek path at all.
#
# `-qscale:v 2` RATHER THAN A TARGET BITRATE, because `testsrc` is a synthetic pattern a rate-controlled
# encoder compresses to almost nothing — which would quietly drop the entry below the three-window threshold
# and make the seek gate meaningless.
#
# EVERY FILE IS DELIBERATELY DIFFERENT FROM EVERY OTHER. Two entries generated from identical parameters would
# be byte-identical, and then a gate that read the LOCAL file where it meant to read the REMOTE one would
# still match its digest and pass.
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
# alone — the easy case, which leaves the contract's TAIL probe window completely unexercised. A great many
# real files are not written that way. Leaving the index at the end forces the scanner to seek to the far end
# of an object it is reading over HTTP Range, which is the read pattern this appliance exists to make cheap
# and the one most likely to degrade into "just download the file".
encode "media/$LOCAL_FILE" 40 testsrc 440 faststart
encode "remote/$REMOTE_FILE" 8 testsrc2 660 moov-at-end

# A THIRD, SEPARATE REMOTE OBJECT, GENERATED NOW AND PUBLISHED MUCH LATER.
#
# It exists for the mid-scan gate, which needs a library scan that is DETERMINISTICALLY still running while a
# successor is published. The only way to get that without racing the scanner is to make the scan block on
# something the gate controls: an entry whose probe windows are NOT yet in the daemon's cache, served by an
# endpoint the gate can hold. It has to be a distinct object for exactly that reason — once anything has been
# scanned its windows are cached and a later scan of it costs the provider nothing, so re-using an existing
# entry would produce a hold that is never hit.
MIDSCAN_FILE="Projection Remote Held (2026).mp4"
encode "remote/$MIDSCAN_FILE" 6 smptebars 550 faststart

# ----------------------------------------------------------------------------------------------------------
# THE ~50-ENTRY CORPUS THE ACCEPTANCE PLAN ASKS FOR, AND WHY IT IS MADE OF TINY FILES.
#
# G7 is a scan of a ~50-entry corpus. It is not a throughput test and not a soak: what it measures is whether
# a media server catalogues FIFTY DISTINCT IDENTITIES correctly, which is a question about namespace, metadata
# and stable identity rather than about bytes. Fifty large files would answer the same question, cost
# gigabytes of generated media and minutes of encoding per run, and would make the gate slow enough that
# somebody would eventually shrink the corpus — at which point the fifty-entry gate is a five-entry gate with
# a fifty-entry name.
#
# So the corpus is fifty tiny, valid, individually distinct media files, and the things that genuinely need
# LENGTH — five minutes of playback, ten seeks spread across a duration, five minutes of transcoding — get ONE
# separate source that is long, generated once, below.
#
# ONE CONTAINER GENERATES ALL OF THEM. Fifty `docker run`s cost more in container start-up than in encoding.
CORPUS_COUNT=47
CORPUS_LOCAL=9
step "generating the ${CORPUS_COUNT}-item legal synthetic corpus, in one container"
# THE GENERATOR IS A FILE, NOT A MULTI-LINE `-c '...'` ARGUMENT, and that is a rule this repository enforces
# rather than a style choice: test/custody-runtime-closure.ts parses every shipped script and REFUSES a line
# whose quotes do not close on it, because an unreadable line is one a "does this region contain X" gate
# answers "no" for. Every other embedded script in this gate is written the same way.
cat > "$WORK/out/gen-corpus.sh" <<'GENCORPUS'
set -eu
total="$1"; localCount="$2"; ff="$3"
i=1
while [ "$i" -le "$total" ]; do
  n=$(printf "%02d" "$i")
  # A DIFFERENT PATTERN, TONE AND DURATION PER INDEX. The tone alone would make the files differ; all three
  # make them differ in ways a scanner can also see.
  case $(( i % 3 )) in
    0) src=testsrc ;;
    1) src=testsrc2 ;;
    *) src=smptebars ;;
  esac
  dur="2.$(( i % 7 ))"
  freq=$(( 200 + i * 7 ))
  if [ "$i" -le "$localCount" ]; then dir=media; else dir=remote; fi
  "$ff" -hide_banner -loglevel error -y \
    -f lavfi -i "${src}=size=128x96:rate=15:duration=${dur}" \
    -f lavfi -i "sine=frequency=${freq}:duration=${dur}" \
    -c:v mpeg4 -qscale:v 5 -c:a aac -b:a 32k -shortest -movflags +faststart \
    "/work/${dir}/Projection Corpus ${n} (2026).mp4"
  i=$(( i + 1 ))
done
echo "  generated ${total} corpus files"
GENCORPUS
docker run --rm --entrypoint /bin/sh -v "$WORK:/work" "$EMBY_IMAGE" \
  /work/out/gen-corpus.sh "$CORPUS_COUNT" "$CORPUS_LOCAL" "$EMBY_FFMPEG"

# ----------------------------------------------------------------------------------------------------------
# THE ONE LONG SOURCE, AND WHY THERE IS EXACTLY ONE.
#
# G8 wants five minutes of playback, G9 wants ten seeks spread across a duration with one beyond 90 % of it,
# and G10 wants five minutes of transcoding. All three need a source LONGER THAN FIVE MINUTES, and none of
# them needs fifty of them.
#
# THE BITRATE IS PINNED RATHER THAN QUALITY-TARGETED. `testsrc` compresses to almost nothing under a quality
# target, and a soak source under 3 MiB would fall below the contract's single-probe threshold — leaving the
# seek gate reading an object whose entire probe plan is one window covering all of it.
#
# `+faststart` HERE, unlike the remote anchor: a player seeking to 90 % of duration needs the index to find
# the position at all, and every real long file a person would play is written this way.
SOAK_SECONDS=340
SOAK_FILE="Projection Soak Source (2026).mp4"
step "generating the long, low-bitrate soak source (${SOAK_SECONDS}s)"
ffmpeg_run -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc=size=320x240:rate=12:duration=$SOAK_SECONDS" \
  -f lavfi -i "sine=frequency=333:duration=$SOAK_SECONDS" \
  -c:v mpeg4 -b:v 150k -minrate 150k -maxrate 150k -bufsize 300k \
  -c:a aac -b:a 48k -shortest -movflags +faststart "/work/remote/$SOAK_FILE"

SOAK_SIZE="$(wc -c < "$WORK/remote/$SOAK_FILE" | tr -d ' ')"
SOAK_SHA="$(node "$REL/sha.cjs" "$REL/remote/$SOAK_FILE")"
test "$SOAK_SIZE" -gt 3145728 \
  || die "the soak source is under 3 MiB, so its whole probe plan would be a single window and the seek gate would prove nothing"
# THE DURATION IS READ BACK FROM THE FILE, not assumed from the argument passed to the encoder. Every seek
# position and the five-minute play are computed from this number; taking it from the request rather than from
# the artifact would make a short encode look like a successful long one.
SOAK_DURATION="$(ffprobe_run -v error -show_entries format=duration -of csv=p=0 "/work/remote/$SOAK_FILE" \
  | head -1 | tr -d " \r\n")"
SOAK_DURATION_INT="${SOAK_DURATION%%.*}"
test "${SOAK_DURATION_INT:-0}" -gt 300 \
  || die "the soak source decodes as ${SOAK_DURATION}s, which is not longer than the five minutes the gates need"
echo "  the soak source is $SOAK_SIZE bytes and decodes as ${SOAK_DURATION}s"

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
# THE ENDPOINT IS internal/fakeprovider, the only "provider" any automated gate here contacts. It serves the
# object FROM THE GENERATED FILE, because a media server has to be able to DECODE what it fetched. Its
# counters are what the amplification budgets are measured against.
REMOTE_REF="obj-projection-remote-two"
MIDSCAN_REF="obj-projection-remote-held"
SOAK_REF="obj-projection-soak-source"

# A REAL, EXPIRING ACCESS LEASE, WITH A SECRET THIS GATE CAN SEARCH FOR BY EXACT VALUE.
#
# The endpoint runs in RESOLVER mode rather than direct mode, so the daemon must exchange the stable objectRef
# for short-lived access material — a URL containing a lease id, a request header carrying it, and an expiry.
# That is the shape Phase 0 section 7.6 says must live in the daemon's memory for the length of one read and
# nowhere else, and the leak checks near the end of this gate are what hold it to that.
#
# The lease id is prefixed with a high-entropy marker minted here. A short literal occurs by chance in any few
# megabytes of binary and could only ever produce false positives; a 32-hex marker cannot, so a search for it
# across the manifest, the probe cache and the media server's own database is a search for THE ACTUAL SECRET,
# and finding none of it means something.
LEASE_MARKER="PJDLEASE$(node -e "console.log(require('node:crypto').randomBytes(16).toString('hex'))" | tr -d ' \r\n')"
echo "  the endpoint will mint leases prefixed with a per-run secret marker"

# EVERY REMOTE OBJECT THE RUN WILL EVER NEED IS SERVED FROM THE START, and published later in whatever
# generation wants it. Registering an object with the endpoint is not publishing it: nothing is visible through
# the mount until the control plane mints a generation naming it, which is what the mid-scan step depends on.
CORPUS_OBJECT_FLAGS=()
index=$(( CORPUS_LOCAL + 1 ))
while [ "$index" -le "$CORPUS_COUNT" ]; do
  n="$(printf "%02d" "$index")"
  CORPUS_OBJECT_FLAGS+=(--file-object "obj-projection-corpus-${n}=/remote/Projection Corpus ${n} (2026).mp4")
  index=$(( index + 1 ))
done

docker run -d --name "$RANGE_CONTAINER" --network "$NETWORK" --network-alias fakerange \
  -p "127.0.0.1:${RANGE_PORT}:8099" \
  -v "$PWD:/workspace" -w /workspace/projectiond -v "$WORK/out:/out" -v "$WORK/remote:/remote:ro" \
  -e GOFLAGS=-buildvcs=false -e GOTOOLCHAIN=local -e CGO_ENABLED=0 \
  "$GO_IMAGE" go run ./cmd/fakerange --addr 0.0.0.0:8099 --lease-prefix "$LEASE_MARKER" \
  --public-base-url "http://fakerange:8099" \
  --file-object "${REMOTE_REF}=/remote/${REMOTE_FILE}" \
  --file-object "${MIDSCAN_REF}=/remote/${MIDSCAN_FILE}" \
  --file-object "${SOAK_REF}=/remote/${SOAK_FILE}" \
  "${CORPUS_OBJECT_FLAGS[@]}" --emit /out/objects.json >/dev/null

echo "  waiting for the endpoint to come up"
# A LIVENESS PROBE MUST NOT BE PROVIDER TRAFFIC. A readiness loop that sends a ranged GET is a real object
# read: it increments `rangeRequests`, serves bytes, and on a slow host does so dozens of times before the
# first assertion has been made. A health check that consumes the budget it is about to measure quietly widens
# it — and the whole argument of this appliance is carried by those numbers. So liveness is `/counters`, which
# the endpoint deliberately does not count, and the RANGE SEMANTICS are checked exactly once, afterwards.
cat > "$WORK/out/probe.sh" <<'PROBE'
set -eu
wget -S --header "Range: bytes=0-1023" -O /dev/null "$1" 2>&1 | grep -q "206 Partial Content"
PROBE
cat > "$WORK/out/alive.sh" <<'ALIVE'
set -eu
wget -q -O /dev/null "$1"
ALIVE

ready=0
for _ in $(seq 1 180); do
  if [ -f "$WORK/out/objects.json" ] && docker run --rm --network "$NETWORK" \
       -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
       sh /probe/alive.sh "http://fakerange:8099/counters" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" -eq 1 || { docker logs "$RANGE_CONTAINER" 2>&1 | tail -20 >&2; die "the range endpoint never answered"; }

# ONE ranged request, and its status line asserted. The endpoint is Range-only by construction — a request
# without a Range header is answered 416 on purpose — and busybox wget exits non-zero on a 206 because it
# treats anything but 200 as an error, so the exit code is useless in both directions.
docker run --rm --network "$NETWORK" -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
  sh /probe/probe.sh "http://fakerange:8099/direct/${REMOTE_REF}" >/dev/null 2>&1 \
  || { docker logs "$RANGE_CONTAINER" 2>&1 | tail -20 >&2; die "the endpoint does not answer a ranged request with 206"; }

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
  "statusAddr": "127.0.0.1:9099",
  "localRoots": { "media": "/var/lib/projectiond/media" },
  "endpoints": [
    {
      "id": "vault",
      "resolverUrl": "http://fakerange:8099/resolve",
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

# THE DAEMON'S OWN PLAYBACK-CACHE COUNTERS, over the same window the provider's are measured across.
#
# WHY THIS IS NEEDED AT ALL. A playback window can legitimately reach the provider ZERO times — the bytes are
# already in the daemon's memory. "Zero provider requests" then has two explanations that call for opposite
# responses: the daemon served it, or something that is not the daemon did. Only the daemon can say which.
#
# WHY IT JOINS THE CONTAINER'S NETWORK NAMESPACE. The status server binds LOOPBACK ONLY and that restriction
# is not relaxed for a test — a published port would not reach it and must not be made to. A container started
# with `--network container:<name>` shares that namespace, so the daemon's own 127.0.0.1 is reachable without
# the daemon listening anywhere else. The image that serves the mount is distroless and has no shell and no
# HTTP client, which is why the request comes from a separate, pinned one.
#
# THE TWO SNAPSHOT ORDERS ARE DELIBERATELY ASYMMETRIC, AND THAT ASYMMETRY IS THE POINT.
#
#   at the START:  provider first, THEN daemon
#   at the END:    daemon first,   THEN provider
#
# So the daemon's evidence interval is CONTAINED INSIDE the provider's rather than overlapping it. Any read
# landing between the two closing snapshots counts on the PROVIDER side only, where it can push the request
# delta above zero and take the window out of the warm arm altogether. Reverse the closing order and a late
# read would add cache hits the provider delta never saw — an inflated warm claim built out of activity the
# provider window excludes. The conservative direction is the one where straggling work can only make the
# window look COLDER.
daemon_counters() {
  docker run --rm --network "container:$MOUNT_CONTAINER" "$VERIFY_IMAGE" \
    wget -q -T 15 -O - "http://127.0.0.1:${DAEMON_STATUS_PORT}/readyz" > "$1" \
    || die "the daemon's status surface did not answer; a warm window cannot be told from a bypassed daemon"
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

# The expectations the driver compares the server's answers against, recorded outside the mount. BOTH ARE
# ANCHORS: entries whose BYTES are read back and digest-compared, not merely catalogued.
node "$REL/expect.cjs" "$REL/out/expected.json" - \
  "$LOCAL_FILE"  "$LOCAL_SIZE"  "$LOCAL_SHA"  local      anchor \
  "$REMOTE_FILE" "$REMOTE_SIZE" "$REMOTE_SHA" http-range anchor >/dev/null

# ----------------------------------------------------------------------------------------------------------
step "starting a REAL EMBY, server process non-root, with the projected mount as its library root"
# ----------------------------------------------------------------------------------------------------------
# THE MOUNT IS DELIBERATELY NOT BOUND READ-ONLY. Adding `:ro` here would make Docker refuse writes and the
# mutation-refusal assertion below would be evidence about a Docker flag rather than about projectiond.
#
# THE UID COMES FROM THE ENVIRONMENT, NOT FROM `--user`, and that is this image's own mechanism rather than a
# preference: the entrypoint is an s6 supervision tree that reads `UID`/`GID` and drops privilege itself.
# Forcing `--user 1000:1000` would run the supervisor as an unprivileged user that cannot do the setuid it
# exists to do. Measured under exactly the flags below: `ps` inside the container shows `root s6-svscan` and
# `1000 EmbyServer`, so the SERVER runs unprivileged and the init does not.
#
# THE CAPABILITY SET IS THE NARROWEST THE IMAGE ACTUALLY STARTS UNDER, measured rather than copied: ALL
# dropped, then SETUID/SETGID for the privilege drop and CHOWN/DAC_OVERRIDE/FOWNER for the config directory it
# takes ownership of on first run. `--cap-drop ALL` alone — which is what the Jellyfin gate can use, because
# that container is `--user`ed from outside — leaves this image unable to start at all.
start_emby() {
  docker run -d --name "$EMBY_CONTAINER" \
    --network "$NETWORK" \
    --cap-drop ALL \
    --cap-add SETUID --cap-add SETGID --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --security-opt no-new-privileges \
    -e UID=1000 -e GID=1000 \
    -p "127.0.0.1:${EMBY_PORT}:8096" \
    -v "$WORK/emby-config:/config" \
    -v "$WORK/mnt:/media/projection:rslave" \
    "$EMBY_IMAGE" >/dev/null
}
start_emby

EMBY_BASE="http://127.0.0.1:${EMBY_PORT}"
STATE="$REL/out/state.json"

drive bootstrap --base "$EMBY_BASE" --state "$STATE" \
  || { docker logs "$EMBY_CONTAINER" 2>&1 | tail -40 >&2; die "the media server never came up"; }
# A bootstrap that exited 0 without leaving a credential behind would fail three commands later with an
# unreadable ENOENT. This turns it into one named failure at the point it happened.
test -s "$WORK/out/state.json" || die "the bootstrap exited 0 but wrote no state"

# THE MEDIA SERVER MUST BE ABLE TO READ THE MOUNT AS THE UID IT ACTUALLY RUNS AS. Checked from inside its own
# container BEFORE a scan is asked for — otherwise a scan that finds nothing is ambiguous between "projection
# is broken" and "the container cannot see the directory".
#
# `-u 1000:1000` IS LOAD-BEARING HERE AND IS THE FIRST PLACE FINDING 5 BITES. A bare `docker exec` on this
# image lands as ROOT, because the image drops privilege internally rather than running under `--user`. Root
# being able to read the mount says nothing about whether the SERVER can, and the server is the thing that
# has to.
docker exec -u 1000:1000 "$EMBY_CONTAINER" test -r "/media/projection/$LOCAL_PATH" \
  || die "the media server's own uid cannot read the projected file"
docker exec -u 1000:1000 "$EMBY_CONTAINER" test ! -L "/media/projection/$LOCAL_PATH" \
  || die "the media server sees a symlink where a file was published"
echo "  the media server can read the projected files as the uid it runs as"

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
# identified it really did have to fetch from the provider. Zero ranged requests would score perfectly against
# every ceiling above and would mean the media server never opened it.
drive budget --before "$REL/out/counters-before-scan.json" --after "$REL/out/counters-after-scan.json" \
  --gate EM9-scan --entries 1 --bytes "$REMOTE_SIZE" --min-range 1

# ----------------------------------------------------------------------------------------------------------
step "direct play, byte for byte, against digests recorded outside the mount"
# ----------------------------------------------------------------------------------------------------------
drive play --state "$STATE" --items "$REL/out/items-1.json" --key "$LOCAL_FILE" \
  --expect-file "$REL/out/expected.json"
drive play --state "$STATE" --items "$REL/out/items-1.json" --key "$REMOTE_FILE" \
  --expect-file "$REL/out/expected.json"

# ----------------------------------------------------------------------------------------------------------
step "the anonymous negative control this server makes possible and Jellyfin does not"
# ----------------------------------------------------------------------------------------------------------
# The identical direct-play request, carrying NO credential. The pinned Jellyfin answers it 200 with the whole
# file, which is why THAT gate states plainly that its direct-play evidence is about bytes and not about
# authorization. The pinned Emby answers it 401, so this gate asserts the refusal.
drive anonymous-play --state "$STATE" --items "$REL/out/items-1.json" --key "$LOCAL_FILE"
drive anonymous-play --state "$STATE" --items "$REL/out/items-1.json" --key "$REMOTE_FILE"

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
# Run against the REMOTE entry on purpose: it is the read pattern that generates non-sequential,
# multi-position reads through the HTTP Range source, which is what the whole design is for.
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
step "publishing the ~50-entry corpus and the long soak source"
# ----------------------------------------------------------------------------------------------------------
# EVERYTHING ABOVE WAS TWO ENTRIES, AND EVERYTHING ABOVE STAYS. The first generation is deliberately small so
# the amplification evidence it produces is about ONE remote object and is not averaged with anything. The
# corpus is a second generation on top of it, measured in its own window, so neither claim borrows from the
# other.
node "$REL/corpus.cjs" "$REL" "$CORPUS_COUNT" "$CORPUS_LOCAL" >/dev/null \
  || die "the corpus could not be described, or the endpoint disagrees with a generated file"
register batch --file "$REL/out/corpus-register.json"

# The long source is registered here rather than in the batch because its probes come from the endpoint's own
# descriptor and it is the only entry with a duration the later gates compute positions from.
SOAK_SIZE_AT_ENDPOINT="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$SOAK_REF" size)"
SOAK_SHA_AT_ENDPOINT="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$SOAK_REF" sha256)"
test "$SOAK_SIZE_AT_ENDPOINT" = "$SOAK_SIZE" || die "the endpoint disagrees with the soak file about its size"
test "$SOAK_SHA_AT_ENDPOINT" = "$SOAK_SHA"   || die "the endpoint is not serving the soak file the gate hashed"
SOAK_PROBES="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$SOAK_REF" probes)"
SOAK_PROBE_FLAGS=""
for probe in $SOAK_PROBES; do SOAK_PROBE_FLAGS="$SOAK_PROBE_FLAGS --probe $probe"; done
SOAK_ITEM="ffffffff-6666-4666-8666-ffffffffffff"
SOAK_PATH="Movies/Projection Soak Source (2026)/$SOAK_FILE"
# shellcheck disable=SC2086
register version --key soak-source --size "$SOAK_SIZE" --mtime 2026-06-01T10:00:00.000Z $SOAK_PROBE_FLAGS
register entry --item "$SOAK_ITEM" --version-key soak-source --path "$SOAK_PATH" \
  --source "http-range:vault:${SOAK_REF}"

publish > "$WORK/out/publish-corpus.json"
test "$(field outcome < "$WORK/out/publish-corpus.json")" = "published" || die "the corpus was not published"
test "$(field additions < "$WORK/out/publish-corpus.json")" = "$(( CORPUS_COUNT + 1 ))" \
  || die "the corpus generation added $(field additions < "$WORK/out/publish-corpus.json") entries, not $(( CORPUS_COUNT + 1 ))"

echo "  waiting for the corpus to be admitted"
ready=0
for _ in $(seq 1 180); do
  if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" test -f "/mnt/$SOAK_PATH" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
test "$ready" -eq 1 || { docker logs "$MOUNT_CONTAINER" 2>&1 | tail -30 >&2; die "the corpus never became visible"; }

# The full expectation: the two anchors, the soak source (also an anchor — its bytes are read back), and every
# corpus entry.
CORPUS_TOTAL="$(node "$REL/expect.cjs" "$REL/out/expected-corpus.json" "$REL/out/corpus-expected.json" \
  "$LOCAL_FILE"  "$LOCAL_SIZE"  "$LOCAL_SHA"  local      anchor \
  "$REMOTE_FILE" "$REMOTE_SIZE" "$REMOTE_SHA" http-range anchor \
  "$SOAK_FILE"   "$SOAK_SIZE"   "$SOAK_SHA"   http-range anchor)"
echo "  the corpus is $CORPUS_TOTAL entries"
drive corpus-check --expect-file "$REL/out/expected-corpus.json" --min-entries 50 --min-remote 39

SMALL_REMOTE_BYTES="$(field smallRemoteBytes < "$WORK/out/corpus-totals.json")"
REMOTE_CORPUS_ENTRIES="$(field remoteEntries < "$WORK/out/corpus-totals.json")"

drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-before-corpus.json"
drive scan --state "$STATE" --expect-file "$REL/out/expected-corpus.json" \
  --out "$REL/out/items-corpus.json" --label corpus
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-after-corpus.json"

# WHAT A ~50-ENTRY SCAN COST AT THE PROVIDER, with both denominators named. The soak source is above the
# contract's single-probe threshold and is budgeted as a FRACTION of itself; the tiny corpus entries are below
# it, where the contract's own probe plan is one window covering the whole object, so identifying one costs its
# whole length by construction and a sub-1.0 budget over it could never pass.
drive budget --before "$REL/out/counters-before-corpus.json" --after "$REL/out/counters-after-corpus.json" \
  --gate EM9b-corpus-scan --entries "$(( REMOTE_CORPUS_ENTRIES + 1 ))" \
  --bytes "$SOAK_SIZE" --small-bytes "$SMALL_REMOTE_BYTES" --min-range 1

# ----------------------------------------------------------------------------------------------------------
step "a repeat scan of the ~50-entry corpus, with zero churn"
# ----------------------------------------------------------------------------------------------------------
drive scan --state "$STATE" --expect-file "$REL/out/expected-corpus.json" \
  --out "$REL/out/items-corpus-2.json" --label corpus-repeat
drive compare --before "$REL/out/items-corpus.json" --after "$REL/out/items-corpus-2.json" \
  --gate EM13b-corpus-rescan

# ----------------------------------------------------------------------------------------------------------
step "the encoder is observable, which on this server is a bind rather than a setting"
# ----------------------------------------------------------------------------------------------------------
# FINDING 3. The Jellyfin gate has a `configure-encoding` phase that sets `TranscodingTempPath` and
# `ThrottleDelaySeconds`. NEITHER FIELD EXISTS on this server's encoding configuration, so there is nothing to
# configure — and POSTing a document with fields the server ignores would be a phase reporting success for
# doing nothing. What makes the encoder observable here is that Emby writes to a FIXED path inside the volume
# this gate already binds.
drive encoder-observability --producer-dir "$REL/emby-config/${EMBY_TRANSCODE_SUBDIR}"

# ----------------------------------------------------------------------------------------------------------
step "ten real media-time seeks, including backwards and beyond 90% of duration"
# ----------------------------------------------------------------------------------------------------------
# THIS IS NOT THE RANGED READ ABOVE, AND THE DIFFERENCE IS THE GATE. A ranged GET proves the daemon serves byte
# offset N. G9 asks whether SECOND N of the media can be reached, which is a question only the media server can
# answer: it demuxes, finds the position, and starts an encode there — and the non-sequential, multi-position
# reads that fall out of that are the read pattern this appliance exists to make cheap.
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-before-seeks.json"
daemon_counters "$WORK/out/daemon-before-seeks.json"
drive media-seeks --state "$STATE" --items "$REL/out/items-corpus-2.json" --key "$SOAK_FILE" \
  --duration-seconds "$SOAK_DURATION_INT" --segment-dir "$REL/out/seek-segments" \
  --out "$REL/out/seeks.json"
daemon_counters "$WORK/out/daemon-after-seeks.json"
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-after-seeks.json"

# EVERY SEEK'S SEGMENT DECODED, BY A DECODER, OUTSIDE THE PROCESS THAT FETCHED IT. "Playable video within 10 s"
# is a decoder's answer; a 200 and a byte count are not one, and a segment that decodes as nothing is exactly
# what a seek to a position the server could not reach would produce.
#
# THE FOURTH FIELD IS THE DECODED PICTURE'S OWN START TIMESTAMP, and it is the temporal evidence: it must move
# one second per second of media asked for, across all ten positions. On this server the position the gate
# compares it against comes from the playlist's cumulative `#EXTINF` sums, because Emby's segment URLs carry
# no `runtimeTicks` — measured at a constant 10.0 s offset over three out-of-order probes.
cat > "$WORK/out/probe-seeks.sh" <<'PROBESEEKS'
set -eu
probe="$1"
: > /work/out/seek-probes.txt
for file in /work/out/seek-segments/seek-*.ts; do
  index=$(basename "$file" .ts | sed "s/^seek-//")
  codec=$("$probe" -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$file" 2>/dev/null | head -1 | tr -d " \r\n" || true)
  packets=$("$probe" -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 "$file" 2>/dev/null | head -1 | tr -d " \r\n" || true)
  start=$("$probe" -v error -select_streams v:0 -show_entries stream=start_time -of csv=p=0 "$file" 2>/dev/null | head -1 | tr -d " \r\n" || true)
  echo "${index#0}|${codec}|${packets:-0}|${start:-0}" >> /work/out/seek-probes.txt
done
PROBESEEKS
docker run --rm --entrypoint /bin/sh -v "$WORK:/work" "$EMBY_IMAGE" \
  /work/out/probe-seeks.sh "$EMBY_FFPROBE"
node "$REL/probes.cjs" "$REL/out/seek-probes.txt" "$REL/out/seek-probes.json" >/dev/null
drive seek-verify --key "$SOAK_FILE" --seeks "$REL/out/seeks.json" --probes "$REL/out/seek-probes.json"

drive traffic-window --before "$REL/out/counters-before-seeks.json" \
  --after "$REL/out/counters-after-seeks.json" --gate EM19-seek-traffic \
  --object-bytes "$SOAK_SIZE" --max-object-multiplier 6 --max-range-requests 400 \
  --daemon-before "$REL/out/daemon-before-seeks.json" --daemon-after "$REL/out/daemon-after-seeks.json"

# ----------------------------------------------------------------------------------------------------------
step "direct play, PACED, for five minutes"
# ----------------------------------------------------------------------------------------------------------
# WHAT THIS DOES THAT THE `play` PHASE CANNOT. That one drains the whole response and digests it, which takes a
# second or two and proves the BYTES are right. Nothing about it can support "starts within 10 s and runs 5
# minutes without a stall", and the obvious way to make it take five minutes — add a sleep — produces a phase
# that takes five minutes and measures a download.
#
# So a real decoder consumes the stream AT THE MEDIA'S OWN RATE (`ffmpeg -re`), reports its position about once
# a second, and the gate holds that trace against four numbers: startup, wall clock, DECODED MEDIA TIME, and
# the ratio between the last two.
#
# IT CARRIES A CREDENTIAL, WHICH THE JELLYFIN EQUIVALENT DOES NOT, because this server refuses anonymous
# playback. The token is written to a file in the run directory and read by a script inside the container, so
# `docker run`'s argv never contains it — and the phase asserts its absence from Docker's own record of the
# container afterwards.
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-before-play.json"
daemon_counters "$WORK/out/daemon-before-play.json"
drive paced-play --state "$STATE" --items "$REL/out/items-corpus-2.json" --key "$SOAK_FILE" \
  --image "$EMBY_IMAGE" --ffmpeg "$EMBY_FFMPEG" --network "$NETWORK" \
  --container-name "$PLAY_CONTAINER" --work-dir "$WORK" --local-work-dir "$REL" \
  --stream-base "http://${EMBY_CONTAINER}:8096" --output-rel "out/paced-play.mp4" \
  --trace "$REL/out/paced-play-trace.json" --seconds 300
daemon_counters "$WORK/out/daemon-after-play.json"
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-after-play.json"

# THE CONSUMER'S OWN OUTPUT, DECODED. Five minutes of progress records is evidence that a decoder was running;
# five minutes of decodable video in the file it wrote is evidence that what it was decoding was video.
test -s "$WORK/out/paced-play.mp4" || die "the paced consumer wrote no output to decode"
PLAY_OUT_SECONDS="$(ffprobe_run -v error -show_entries format=duration -of csv=p=0 /work/out/paced-play.mp4 \
  | head -1 | tr -d " \r\n")"
PLAY_OUT_PACKETS="$(ffprobe_run -v error -select_streams v:0 -count_packets \
  -show_entries stream=nb_read_packets -of csv=p=0 /work/out/paced-play.mp4 | head -1 | tr -d " \r\n")"
drive paced-play-output --probed-seconds "${PLAY_OUT_SECONDS%%.*}" --probed-packets "${PLAY_OUT_PACKETS:-0}" \
  --seconds 300

drive traffic-window --before "$REL/out/counters-before-play.json" \
  --after "$REL/out/counters-after-play.json" --gate EM18-paced-play-traffic \
  --object-bytes "$SOAK_SIZE" --max-object-multiplier 3 --max-range-requests 400 \
  --daemon-before "$REL/out/daemon-before-play.json" --daemon-after "$REL/out/daemon-after-play.json"

# THE MOUNT'S OWN VIEW, AFTER FIVE MINUTES OF BEING READ. Metadata is a snapshot the daemon holds, and five
# minutes of streaming must not have moved any of it.
SOAK_STAT_AFTER_PLAY="$(docker run --rm --user 65534:65534 --cap-drop ALL -v "$WORK/mnt:/mnt:rslave" \
  "$VERIFY_IMAGE" stat -c "%s %i %a" "/mnt/$SOAK_PATH")"
echo "  the soak entry after five minutes of playback: $SOAK_STAT_AFTER_PLAY"

# ----------------------------------------------------------------------------------------------------------
step "a forced transcode, run and consumed for five minutes"
# ----------------------------------------------------------------------------------------------------------
# WHAT THIS STEP CLAIMS, EXACTLY: five minutes of PACED, CONTINUOUSLY DECODED, TRANSCODED PLAYBACK. It does NOT
# claim five minutes of encoder CPU time, and the difference is measured rather than glossed over. Both encoder
# numbers are reported and neither is asserted.
#
# WHAT IS ASSERTED, AND WHAT EACH REFUSES:
#   - THE CLIENT'S PACE, so the window is five minutes of consumption rather than of sleeping after a download.
#   - CONTINUITY. Every ADJACENT pair of segments must arrive close together; a five-minute span alone is
#     satisfied by consuming everything in ten seconds and fetching one more at the end.
#   - THE OUTPUT. Every consumed segment is DECODED, and the decoded media time must reach five minutes with
#     every segment h264, none empty, and no two the same.
#   - THE LATE WINDOW. A quarter of the required media must be decoded in the LAST THIRD, so a dense start with
#     a padded tail cannot pass.
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-before-soak.json"
daemon_counters "$WORK/out/daemon-before-soak.json"
drive transcode-soak --state "$STATE" --items "$REL/out/items-corpus-2.json" --key "$SOAK_FILE" \
  --segment-dir "$REL/out/soak-segments" --producer-dir "$REL/emby-config/${EMBY_TRANSCODE_SUBDIR}" \
  --out "$REL/out/soak.json" --seconds 300
daemon_counters "$WORK/out/daemon-after-soak.json"
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-after-soak.json"

cat > "$WORK/out/probe-soak.sh" <<'PROBESOAK'
set -eu
probe="$1"
: > /work/out/soak-probes.txt
for file in /work/out/soak-segments/seg-*.ts; do
  index=$(basename "$file" .ts | sed "s/^seg-0*//")
  codec=$("$probe" -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$file" 2>/dev/null | head -1 | tr -d " \r\n" || true)
  packets=$("$probe" -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 "$file" 2>/dev/null | head -1 | tr -d " \r\n" || true)
  seconds=$("$probe" -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "$file" 2>/dev/null | head -1 | tr -d " \r\n" || true)
  if [ -z "${seconds:-}" ] || [ "${seconds}" = "N/A" ]; then
    seconds=$("$probe" -v error -show_entries format=duration -of csv=p=0 "$file" 2>/dev/null | head -1 | tr -d " \r\n" || true)
  fi
  echo "${index:-0}|${codec}|${packets:-0}|${seconds:-0}" >> /work/out/soak-probes.txt
done
PROBESOAK
docker run --rm --entrypoint /bin/sh -v "$WORK:/work" "$EMBY_IMAGE" \
  /work/out/probe-soak.sh "$EMBY_FFPROBE"
node "$REL/probes.cjs" "$REL/out/soak-probes.txt" "$REL/out/soak-probes.json" >/dev/null
drive transcode-soak-verify --key "$SOAK_FILE" --items "$REL/out/items-corpus-2.json" \
  --soak "$REL/out/soak.json" --probes "$REL/out/soak-probes.json" --seconds 300

drive traffic-window --before "$REL/out/counters-before-soak.json" \
  --after "$REL/out/counters-after-soak.json" --gate EM20-transcode-soak-traffic \
  --object-bytes "$SOAK_SIZE" --max-object-multiplier 4 --max-range-requests 600 \
  --daemon-before "$REL/out/daemon-before-soak.json" --daemon-after "$REL/out/daemon-after-soak.json"

# THE TRANSCODING JOB IS GONE. A five-minute encode left running would occupy the machine for the rest of the
# gate, and every later measurement would be taken against a host under load.
docker exec -u 1000:1000 "$EMBY_CONTAINER" \
  sh -c "rm -rf /config/${EMBY_TRANSCODE_SUBDIR}/* 2>/dev/null || true"
echo "  the transcoding job was stopped and its output removed"

# ----------------------------------------------------------------------------------------------------------
step "a successor published while a stream is in flight"
# ----------------------------------------------------------------------------------------------------------
rm -f "$WORK/out/stream-ready" "$WORK/out/stream-release"
drive hold-stream --state "$STATE" --items "$REL/out/items-corpus-2.json" --key "$REMOTE_FILE" \
  --expect-file "$REL/out/expected-corpus.json" \
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

node "$REL/expect.cjs" "$REL/out/expected-2.json" "$REL/out/expected-corpus.json" \
  "$THIRD_FILE" "$THIRD_SIZE" "$THIRD_SHA" local anchor >/dev/null

drive scan --state "$STATE" --expect-file "$REL/out/expected-2.json" --out "$REL/out/items-2.json" --label scan2
drive compare --before "$REL/out/items-corpus-2.json" --after "$REL/out/items-2.json" \
  --gate EM10-successor --expect-added 1

# ----------------------------------------------------------------------------------------------------------
step "SIGKILL the daemon during playback, then the real recovery path"
# ----------------------------------------------------------------------------------------------------------
# WHAT THE PUBLISHED GENERATION WAS BEFORE ANY OF THIS, so that "it did not move" can be checked against the
# fact rather than against a number somebody wrote down while counting the publishes above. A constant that
# encodes how many times something earlier in the script happened is a constant that will be wrong the next
# time somebody adds a step — and its failure message would accuse the product of a defect it does not have.
publish --status > "$WORK/out/status-before-kill.json"
SEQUENCE_BEFORE_KILL="$(field pointerSequence < "$WORK/out/status-before-kill.json")"
test -n "$SEQUENCE_BEFORE_KILL" || die "the publisher reported no current sequence before the kill"
echo "  the published generation before the kill is sequence $SEQUENCE_BEFORE_KILL"

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

# THE MEDIA SERVER'S OWN VIEW OF THE REMOUNT, FROM INSIDE ITS OWN CONTAINER, BEFORE ANY CHURN IS ASSERTED.
#
# A container started BEFORE a daemon restart can be left holding a dead FUSE mount whose `stat` still answers
# and whose `open` returns ENOTCONN. A library scan across that reports ZERO REMOVALS — because declining to
# delete a library whose root has gone unreadable is correct scanner behaviour — so every churn assertion below
# would have passed on a mount nothing could read. `await_namespace` cannot see it either: it uses a FRESH
# container, which picks up the new mount correctly.
#
# So the read is done as the media server, through the mount it actually holds, and it reads BYTES rather than
# metadata. As the uid the server runs as, for the same reason as above: root's ability to read says nothing
# about the server's.
docker exec -u 1000:1000 "$EMBY_CONTAINER" \
  sh -c "head -c 65536 '/media/projection/$REMOTE_PATH' > /dev/null" \
  || { docker logs "$MOUNT_CONTAINER" 2>&1 | tail -30 >&2
       die "after the remount the media server's own mount cannot be READ, so every churn assertion that follows would be about a dead mount"; }
echo "  the media server can still read bytes through its own mount after the remount"

# A TRANSIENT SOURCE OUTAGE IS NOT A DELETION. The publisher must still say the same generation is current:
# nothing about a crashed daemon may cause a SMALLER published generation.
publish --status > "$WORK/out/status-after-kill.json"
cat "$WORK/out/status-after-kill.json"
SEQUENCE_AFTER_KILL="$(field pointerSequence < "$WORK/out/status-after-kill.json")"
test "$(field agrees < "$WORK/out/status-after-kill.json")" = "true" || die "the directory and the database disagree after the kill"
test "$SEQUENCE_AFTER_KILL" = "$SEQUENCE_BEFORE_KILL" \
  || die "the published generation moved because a daemon died: $SEQUENCE_BEFORE_KILL -> $SEQUENCE_AFTER_KILL"
echo "  the published generation is still sequence $SEQUENCE_AFTER_KILL, exactly as before the kill"
publish > "$WORK/out/publish-after-kill.json"
test "$(field outcome < "$WORK/out/publish-after-kill.json")" = "unchanged" \
  || die "a publish after the kill was not a no-op, so an outage produced a new generation"

touch "$WORK/out/kill-release"
wait "$KILL_PID" || die "the post-kill stream assertion failed"

# Playback is resumable, which is the half of G12 the acceptance plan says IS required.
drive resume --state "$STATE" --items "$REL/out/items-2.json" --key "$REMOTE_FILE" \
  --expect-file "$REL/out/expected-2.json"

drive scan --state "$STATE" --expect-file "$REL/out/expected-2.json" --out "$REL/out/items-3.json" --label scan3
drive compare --before "$REL/out/items-2.json" --after "$REL/out/items-3.json" --gate EM11-recovery

# ----------------------------------------------------------------------------------------------------------
step "restarting the media server, and re-scanning twice more"
# ----------------------------------------------------------------------------------------------------------
docker restart -t 30 "$EMBY_CONTAINER" >/dev/null
# A FRESH LOGIN AGAINST THE SAME INSTALLATION. The wizard is already complete — which on this server is
# established by probing the wizard endpoint rather than by reading a flag, because there is no flag — so this
# is an ordinary authentication. What it proves is that the library, its item ids and the projected paths the
# server persisted all survived the restart.
drive bootstrap --base "$EMBY_BASE" --state "$STATE"

drive scan --state "$STATE" --expect-file "$REL/out/expected-2.json" \
  --out "$REL/out/items-4.json" --label scan4
drive compare --before "$REL/out/items-3.json" --after "$REL/out/items-4.json" --gate EM12-server-restart

# A RE-SCAN OVER AN UNCHANGED GENERATION MUST COST THE PROVIDER NOTHING IT HAS NOT ALREADY PAID. The window is
# drawn tightly around the re-scan alone, because everything else in this run — a full direct play, a
# transcode — legitimately fetches bytes, and a delta taken over those would say nothing about a scan.
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-before-rescan.json"
drive scan --state "$STATE" --expect-file "$REL/out/expected-2.json" \
  --out "$REL/out/items-5.json" --label scan5
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-after-rescan.json"
drive compare --before "$REL/out/items-4.json" --after "$REL/out/items-5.json" --gate EM13-rescan-churn
drive budget --before "$REL/out/counters-before-rescan.json" --after "$REL/out/counters-after-rescan.json" \
  --gate EM14-rescan --entries 1 --bytes 0 --windows 0

# THE WHOLE-RUN PROVIDER INVARIANTS ARE TAKEN HERE, and here rather than at the very end for a reason: the
# source-outage step below stops and restarts the endpoint process, which resets its counters. A snapshot taken
# after that would describe the last few seconds of the run and would be read as describing all of it.
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-final.json"
drive provider-invariants --counters "$REL/out/counters-final.json" --gate EM15-provider

# ----------------------------------------------------------------------------------------------------------
step "a generation admitted WHILE A SCAN IS RUNNING"
# ----------------------------------------------------------------------------------------------------------
# The successor test above swapped a generation under an open PLAYBACK. This one swaps it under an open SCAN,
# which is a different hazard: the scanner is walking the namespace, and the namespace changes beneath it.
#
# WHAT IS ASSERTED IS NOT WHAT THE RACED SCAN SAW. It may legitimately have seen the predecessor, the
# successor, or a mixture, and asserting a count against any of them would be asserting the outcome of a race.
# What must hold is that nothing half-formed appears, and that the NEXT scan converges with zero removals and
# zero item-id churn for everything carried across.
FOURTH_FILE="Projection Local Four (2026).mp4"
encode "media/$FOURTH_FILE" 10 testsrc 990 faststart
FOURTH_SIZE="$(wc -c < "$WORK/media/$FOURTH_FILE" | tr -d ' ')"
FOURTH_SHA="$(node "$REL/sha.cjs" "$REL/media/$FOURTH_FILE")"

# ----------------------------------------------------------------------------------------------------------
# MAKING THE SCAN DETERMINISTICALLY LONG, WHICH IS WHAT MAKES THE REST OF THIS STEP EVIDENCE.
#
# A small scan takes a couple of seconds, and the handshake below — observe running, publish, observe running
# again — costs about as long. Timing it is a coin flip, and a coin flip with a retry loop around it is still
# not evidence. Measured on this server, a one-item scan starts and finishes BETWEEN TWO POLLS.
#
# So the scan is made to BLOCK on something this gate controls. A brand-new REMOTE entry is published first;
# its probe windows are not in the daemon's cache, so the scanner's probe of it must fetch from the endpoint —
# and the endpoint is told to hold that request. The entry has to be NEW for this to work at all: anything
# already scanned has its windows cached and EM14 asserts a re-scan costs the provider nothing, so a hold on an
# existing entry would never be hit. That the hold WAS hit is asserted below from the endpoint's own counter.
MIDSCAN_SIZE="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$MIDSCAN_REF" size)"
MIDSCAN_SHA="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$MIDSCAN_REF" sha256)"
MIDSCAN_PROBES="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$MIDSCAN_REF" probes)"
MIDSCAN_PATH="Movies/Projection Remote Held (2026)/$MIDSCAN_FILE"
MIDSCAN_ITEM="eeeeeeee-5555-4555-8555-eeeeeeeeeeee"

MIDSCAN_PROBE_FLAGS=""
for probe in $MIDSCAN_PROBES; do MIDSCAN_PROBE_FLAGS="$MIDSCAN_PROBE_FLAGS --probe $probe"; done
# shellcheck disable=SC2086
register version --key remote-held --size "$MIDSCAN_SIZE" --mtime 2026-06-01T10:00:00.000Z $MIDSCAN_PROBE_FLAGS
register entry --item "$MIDSCAN_ITEM" --version-key remote-held --path "$MIDSCAN_PATH" \
  --source "http-range:vault:${MIDSCAN_REF}"

publish > "$WORK/out/publish-holdable.json"
test "$(field outcome < "$WORK/out/publish-holdable.json")" = "published" || die "the holdable entry was not published"
echo "  waiting for the holdable remote entry to be admitted"
ready=0
for _ in $(seq 1 120); do
  if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" test -f "/mnt/$MIDSCAN_PATH" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
test "$ready" -eq 1 || die "the holdable remote entry never became visible"

# NOW the successor's rows, so that the only thing the mid-scan publish can add is this one entry. NOTE THE
# ORDER, WHICH IS LOAD-BEARING: `publish` mints one generation out of everything registered at the time, so
# registering the successor first would sweep it into the holdable entry's generation, the mid-scan publish
# would have nothing to add, report `unchanged`, and the step would fail having proved nothing.
register version --key local-four --size "$FOURTH_SIZE" --mtime 2026-06-01T10:00:00.000Z
register entry --item "$FOURTH_ITEM" --version-key local-four \
  --path "Movies/Projection Local Four (2026)/$FOURTH_FILE" --source "local:media:$FOURTH_FILE"

# HOLD IT. Every ranged request for this object now blocks at the endpoint until released.
node "$REL/ctl.cjs" "http://127.0.0.1:${RANGE_PORT}/control/hold/${MIDSCAN_REF}" \
  || die "the endpoint would not accept the hold"
echo "  the endpoint is holding reads of the new remote entry"

HOLD_BEFORE="$(node "$REL/counters.cjs" "http://127.0.0.1:${RANGE_PORT}/counters" heldRequests)"
HOLD_TIMEOUTS_BEFORE="$(node "$REL/counters.cjs" "http://127.0.0.1:${RANGE_PORT}/counters" holdTimeouts)"

rm -f "$WORK/out/scan-running"
drive scan --state "$STATE" --expect-file "$REL/out/expected-2.json" \
  --out "$REL/out/items-6.json" --label scan6 --tolerant true \
  --running-marker "$REL/out/scan-running" &
SCAN_PID=$!

# WAIT FOR AN OBSERVED RUNNING SCAN, NOT FOR A SLEEP. A publish one second after the trigger can land before
# the scanner starts or after it finishes, and in either case the step would still pass while claiming "a
# generation was admitted WHILE A SCAN IS RUNNING" — a claim about a race that was never observed to have
# happened. The marker is written by the scanning process at the moment the media server's own scheduled task
# is seen in flight. A scan that starts and finishes between two polls is a valid COMPLETION and is not an
# in-flight observation; it does not raise the marker.
running=0
for _ in $(seq 1 300); do
  if [ -f "$WORK/out/scan-running" ]; then running=1; break; fi
  if ! kill -0 "$SCAN_PID" 2>/dev/null; then break; fi
  sleep 0.2
done
if [ "$running" -ne 1 ]; then
  wait "$SCAN_PID" || true
  die "the scanner was never observed running, so a mid-scan publish could not be performed"
fi

release_hold() {
  node "$REL/ctl.cjs" "http://127.0.0.1:${RANGE_PORT}/control/release/${MIDSCAN_REF}" >/dev/null 2>&1 || true
}
held_now() { node "$REL/counters.cjs" "http://127.0.0.1:${RANGE_PORT}/counters" currentHeldWaiters; }
hold_timeouts() { node "$REL/counters.cjs" "http://127.0.0.1:${RANGE_PORT}/counters" holdTimeouts; }

# A REQUEST MUST BE BLOCKED RIGHT NOW, NOT MERELY HAVE BEEN BLOCKED ONCE. The lifetime `heldRequests` counter
# says a request entered a hold at SOME point; it says nothing about whether that request is still waiting.
# `currentHeldWaiters` is the live gauge that answers the actual question.
waiter=0
for _ in $(seq 1 120); do
  if [ "$(held_now)" -ge 1 ]; then waiter=1; break; fi
  if ! kill -0 "$SCAN_PID" 2>/dev/null; then break; fi
  sleep 0.25
done
if [ "$waiter" -ne 1 ]; then
  release_hold; wait "$SCAN_PID" || true
  die "no provider request ever blocked on the hold, so the scan was not deterministically stopped"
fi
echo "  a provider request is blocked on the hold right now"

drive assert-scan-in-flight --state "$STATE" \
  || { release_hold; wait "$SCAN_PID" || true; die "the scan was not in flight before the mid-scan publish"; }

publish > "$WORK/out/publish-midscan.json"
publish_outcome="$(field outcome   < "$WORK/out/publish-midscan.json")"
publish_added="$(field additions   < "$WORK/out/publish-midscan.json")"

# THE SECOND PRESENT-TENSE CHECK, AND IT IS NOT OPTIONAL. Passing it means the scanner was running BEFORE the
# publish was issued and STILL running once it had returned — so the publish landed strictly INSIDE the scan
# window, with both edges observed rather than one observed and the other assumed.
drive assert-scan-in-flight --state "$STATE" \
  || { release_hold; wait "$SCAN_PID" || true; die "the scan ended during the publish, so the publish did not land strictly inside it"; }

# THE WAITER IS STILL BLOCKED, AND NOTHING LAPSED WHILE WE WERE LOOKING AWAY. Both halves are needed: the
# gauge alone could look unchanged if the original waiter timed out and a fresh request arrived in its place,
# which would mean the hold had a gap in exactly the interval this step claims to have covered.
HELD_STILL="$(held_now)"
HOLD_TIMEOUTS_AFTER="$(hold_timeouts)"
if [ "${HELD_STILL:-0}" -lt 1 ]; then
  release_hold; wait "$SCAN_PID" || true
  die "the held provider request was no longer blocked after the publish, so the hold did not cover it"
fi
if [ "$(( HOLD_TIMEOUTS_AFTER - HOLD_TIMEOUTS_BEFORE ))" -ne 0 ]; then
  release_hold; wait "$SCAN_PID" || true
  die "a hold lapsed during the publish window, so the block had a gap in it"
fi
echo "  the same hold was still blocking $HELD_STILL request(s) after the publish, with no lapse in between"

release_hold
echo "  the hold is released; the scan may finish"

# AND THE RELEASE ACTUALLY RELEASED. A gauge that never came back down would mean every reading above was a
# leak rather than a live waiter, and the next run would inherit a wedged endpoint.
drained=0
for _ in $(seq 1 120); do
  if [ "$(held_now)" -eq 0 ]; then drained=1; break; fi
  sleep 0.25
done
test "$drained" -eq 1 || die "a provider request is still blocked after the hold was released"

test "$publish_outcome" = "published" || die "the mid-scan successor was not published"
test "$publish_added"   = "1"         || die "the mid-scan successor should add exactly one entry"
wait "$SCAN_PID" || die "the scan did not complete after the hold was released"

# The lifetime counter as a cross-check on the live gauge readings above. It is the weakest of the three and is
# stated last for that reason: what licensed the claim was the gauge being up before AND after the publish with
# no lapse in between, not this number being non-zero.
HOLD_AFTER="$(node "$REL/counters.cjs" "http://127.0.0.1:${RANGE_PORT}/counters" heldRequests)"
test "$(( HOLD_AFTER - HOLD_BEFORE ))" -ge 1 \
  || die "no provider request was ever held, so the scan was not deterministically blocked and the mid-scan window was luck"
echo "  $(( HOLD_AFTER - HOLD_BEFORE )) provider request(s) entered the hold; one was still blocked across the publish"
echo "  a generation was admitted while the scanner was provably walking the namespace"

node "$REL/expect.cjs" "$REL/out/expected-3.json" "$REL/out/expected-2.json" \
  "$MIDSCAN_FILE" "$MIDSCAN_SIZE" "$MIDSCAN_SHA" http-range anchor \
  "$FOURTH_FILE"  "$FOURTH_SIZE"  "$FOURTH_SHA"  local      anchor >/dev/null

# THE CONVERGENCE ASSERTION, which is the one that matters, and it must be reached with the hold released and
# the scan finished. TWO ADDITIONS, NOT ONE, AND BOTH ARE ACCOUNTED FOR: the holdable remote entry was
# published BEFORE the raced scan so its probe would be uncached and holdable; the successor was published
# DURING it, and the mid-scan publish is separately asserted above to have added exactly one.
drive scan --state "$STATE" --expect-file "$REL/out/expected-3.json" --out "$REL/out/items-7.json" --label scan7
drive compare --before "$REL/out/items-5.json" --after "$REL/out/items-7.json" \
  --gate EM16-midscan-swap --expect-added 2

# ----------------------------------------------------------------------------------------------------------
step "a source outage is not a deletion, and does not shrink a published generation"
# ----------------------------------------------------------------------------------------------------------
# Take the provider away entirely. The namespace is metadata the control plane published, held by the daemon,
# and it must not move — the entry stays visible with the same size and the same inode, and a publish over the
# unmoved catalog must still be a no-op rather than a smaller generation. This is the media-server-visible half
# of what G6 says: an outage is not a deletion.
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
# Liveness on the uncounted control surface again, for the same reason: a recovery poll that reads the object
# would put a burst of provider traffic into the run at the one moment the gate is asserting an outage produced
# none.
ready=0
for _ in $(seq 1 120); do
  if docker run --rm --network "$NETWORK" -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
       sh /probe/alive.sh "http://fakerange:8099/counters" >/dev/null 2>&1; then ready=1; break; fi
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
# Run INSIDE the media server's own container, against a mount that was NOT bound read-only. Every one of these
# is refused by projectiond.
#
# IT RUNS TWICE, AS TWO DIFFERENT IDENTITIES, AND THAT IS FINDING 5.
#
# Jellyfin's container is `--user`ed from outside, so a bare `docker exec` there IS the media server's uid and
# its script can assert `id -u != 0` inline. Emby drops privilege INTERNALLY, from `UID`/`GID`, so a bare
# `docker exec` here lands as ROOT. Copying the Jellyfin script would fail — which is fine, it would be
# noticed — but the dangerous repair is the one where somebody deletes the uid assertion to make it pass, at
# which point the mutation attempts run as root and the gate has quietly stopped testing the thing it names.
#
# So both are run and both are asserted, because neither alone says what both say:
#   AS UID 1000, the identity the server actually runs as. This is the claim that matters — the media server
#     cannot write to its own library root.
#   AS ROOT, which is strictly stronger: no permission bit is standing in the way, so what refuses is the
#     daemon and not the kernel's own mode check.
cat > "$WORK/out/mutate.sh" <<'MUT'
set -eu
root=/media/projection
expected_uid="$1"
target="$root/$2"
test "$(id -u)" = "$expected_uid" \
  || { echo "the mutation test is running as $(id -u), not the $expected_uid it names" >&2; exit 1; }
( : > "$target" ) 2>/dev/null && { echo "truncate succeeded" >&2; exit 1; }
( rm -f "$target" ) 2>/dev/null && test ! -e "$target" && { echo "unlink succeeded" >&2; exit 1; }
( mkdir "$root/newdir" ) 2>/dev/null && { echo "mkdir succeeded" >&2; exit 1; }
( echo x > "$root/newfile" ) 2>/dev/null && { echo "create succeeded" >&2; exit 1; }
( ln -s /etc/passwd "$root/link" ) 2>/dev/null && { echo "symlink succeeded" >&2; exit 1; }
( chmod 666 "$target" ) 2>/dev/null && { echo "chmod succeeded" >&2; exit 1; }
test -f "$target" || { echo "the file is gone after the attempts" >&2; exit 1; }
echo "every mutation refused as uid $(id -u), and the file is intact"
MUT
# FED THROUGH STDIN RATHER THAN `docker cp`. The media server's container is already running, so the script
# cannot be bind-mounted in; and `docker cp` takes a HOST path, which on an MSYS shell is `/c/Users/...` — a
# spelling the Windows docker binary cannot resolve, unlike the `-v` sources Docker Desktop normalises. `sh -s`
# reads the program from stdin and still takes positional arguments.
docker exec -i -u 1000:1000 "$EMBY_CONTAINER" sh -s 1000 "$LOCAL_PATH" < "$WORK/out/mutate.sh"
docker exec -i "$EMBY_CONTAINER" sh -s 0 "$LOCAL_PATH" < "$WORK/out/mutate.sh"

# ----------------------------------------------------------------------------------------------------------
step "no PROVIDER access lease reached the manifest, the probe cache or the media server's library state"
# ----------------------------------------------------------------------------------------------------------
# WHAT THIS STEP CLAIMS, AND WHAT IT DOES NOT.
#
# THE CLAIM IS ABOUT PROVIDER ACCESS MATERIAL. During this run the daemon really did resolve a stable objectRef
# into short-lived access material — a URL containing a lease id, a header carrying it, and an expiry — because
# the endpoint is configured in resolver mode. Phase 0 section 7.6 says that material lives in the daemon's
# memory for the length of one read and nowhere else. This step is the check on that.
#
# THE CLAIM IS NOT "NO TOKEN EXISTS ANYWHERE ON DISK", and stating that would be false in two ways worth naming
# rather than quietly narrowing:
#
#   1. THIS GATE PERSISTS AN EMBY TOKEN ON PURPOSE, in `out/state.json`, because the phases run as separate
#      processes and each needs it — and, on THIS server specifically, in a second file the paced consumer
#      reads, because Emby refuses anonymous playback and a credential has to reach that container somehow.
#      Both live in the run directory, which the cleanup trap deletes on success and on failure. That is a
#      property of the HARNESS, not of the product.
#   2. EMBY PERSISTS ITS OWN AUTHENTICATION STATE. A media server that did not would not survive a restart, and
#      this gate restarts it and requires the library to still be there.
#
# Neither is provider access material, and neither is searched for below.
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
  "$LEASE_MARKER" "fakerange" "://" "X-Fake-Lease" "expiresAtUnixMs" "Authorization:" "Bearer " \
  || die "the manifest directory holds provider access material"

# THE PROBE CACHE IS MEDIA BYTES, and `://` is not a usable signal against it. A cached probe window is a
# verbatim megabyte of a compressed video stream, and a three-byte sequence occurs in a few megabytes of
# high-entropy data by chance — a check that fires on those is evidence about probability, not about access
# material. So the cache is searched for the things that could only have got there from a leak, and FIRST
# AMONG THEM THE ACTUAL LEASE SECRET minted for this run: 16 random bytes as hex behind a fixed prefix, whose
# probability of occurring by chance is nil.
docker run --rm -v "$WORK/cache:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
  sh /out/leakcheck.sh "the daemon probe cache" \
  "$LEASE_MARKER" "fakerange" "http://" "https://" "X-Fake-Lease" "expiresAtUnixMs" "Authorization:" "Bearer " \
  || die "the probe cache holds provider access material"

# ...AND THE CACHE IS NOT A COPY OF THE LIBRARY. The scan-window cache is supposed to hold three fixed megabyte
# windows per projected version, not the object. If a read path ever started writing whole files through it, no
# substring check would notice — but the size would.
CACHE_BYTES="$(docker run --rm -v "$WORK/cache:/scan:ro" "$VERIFY_IMAGE" \
  sh -c 'du -sb /scan 2>/dev/null | cut -f1' | tr -d " \r\n")"
CACHE_CEILING="$(node "$REL/cacheceiling.cjs" "$REL/out/expected-3.json")"
PUBLISHED_BYTES="$(node "$REL/published.cjs" "$REL/out/expected-3.json")"
echo "  the probe cache holds $CACHE_BYTES bytes against $PUBLISHED_BYTES bytes published"
drive cache-accounting --cache-bytes "${CACHE_BYTES:-0}" --ceiling-bytes "$CACHE_CEILING" \
  --published-bytes "$PUBLISHED_BYTES"

# THE MEDIA SERVER'S OWN LIBRARY STATE must hold the projected PATH and nothing about a provider. It DOES hold
# its own device and access-token records — it has to, or it could not survive the restart this gate performs
# earlier — and those are not searched for here, because they are Emby's own credentials for its own API and
# have nothing to do with the provider lease this step is about.
#
# THE CONSUMER'S TOKEN FILE IS EXCLUDED BY LOCATION, NOT BY NAME-MATCHING. It lives under the run directory's
# root, not under `emby-config`, so this search cannot trip over the gate's own scratch credential — and the
# assertion that the credential stayed out of Docker's metadata is made separately, in the paced-play phase,
# where it can be measured rather than assumed.
docker run --rm -v "$WORK/emby-config:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
  sh /out/leakcheck.sh "the media server's library state" \
  "$LEASE_MARKER" "fakerange" "X-Fake-Lease" "expiresAtUnixMs" \
  || die "the media server persisted provider access material"
echo "  the media server's library state names no provider endpoint and holds no lease"

# AND THE LEASE REALLY EXISTED, or every search above was a search for nothing. The endpoint counts each
# resolution it served; a run that resolved zero times never minted the secret these checks look for, and would
# pass them by doing nothing at all.
RESOLUTIONS="$(field resolutions < "$WORK/out/counters-final.json")"
test "${RESOLUTIONS:-0}" -ge 1 \
  || die "the endpoint served no access resolution, so the leak check searched for a secret that never existed"
echo "  $RESOLUTIONS access lease(s) were minted during this run, so the searches above had a subject"

# THE CONSUMER'S TOKEN FILE IS GONE FROM EVERYTHING BUT THE RUN DIRECTORY, and the run directory is deleted by
# the cleanup trap. Stated rather than omitted, because this gate creates a credential file that the other two
# do not.
CONSUMER_TOKEN_FILE="$(npx tsx src/ops/projection-emby-dataplane-cli.ts consumer-token-file | tr -d " \r\n")"
test -f "$WORK/$CONSUMER_TOKEN_FILE" \
  || die "the paced consumer's token file is missing, so the credential-exposure assertion had no subject"
echo "  NOTE: this harness persists an Emby access token in its own scratch state file AND in a second file"
echo "        the paced consumer reads, because this server refuses anonymous playback. Both are inside the"
echo "        run directory the cleanup trap deletes. Emby also persists its own device and token records,"
echo "        which it must in order to survive the restart this gate performs. None is provider access"
echo "        material, and the paced-play phase separately asserts the token never entered Docker's metadata."

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
npx tsx src/ops/projection-emby-dataplane-cli.ts report --results "$REL/out/results.json"

echo
echo "EMBY data-plane gate PASSED. Exactly what was proved:"
echo "  - a real, digest-pinned EMBY container, stood up non-interactively through its own first-run API,"
echo "    with its server process running as uid 1000 and the FUSE mount bind-propagated in as a library root."
echo "  - legal synthetic media generated on this machine by the ffmpeg inside that image. Nothing downloaded,"
echo "    nothing copyrighted, no fixture committed."
echo "  - a real library scan of a ~50-ENTRY CORPUS in which every published identity was catalogued at the"
echo "    size the control plane published and as an ORDINARY FILE -- not symlinks, not .strm placeholders,"
echo "    not remote media sources -- with zero missing, zero duplicated and zero unexpected; and zero churn"
echo "    of any kind across a repeat scan, a media-server restart, a mid-scan generation swap and the daemon"
echo "    SIGKILL/restart/remount path, which is followed by a byte-for-byte read so it cannot pass on a dead"
echo "    mount."
echo "  - FIVE MINUTES OF PACED DIRECT PLAY: a real decoder consuming at the media's own frame rate, with"
echo "    startup, decoded MEDIA time, the media-seconds-per-wall-second ratio and the longest stall each"
echo "    asserted separately."
echo "  - TEN MEDIA-TIME SEEKS through the server's own playlist, four transitions backwards and two beyond"
echo "    90% of duration, each returning decodable h264 inside ten seconds -- plus ten DISTINCT segments,"
echo "    positions the server itself declares, and decoded timestamps tracking them with a constant offset."
echo "    ON THIS SERVER THE POSITIONS COME FROM THE PLAYLIST'S OWN #EXTINF SUMS, because Emby's segment URLs"
echo "    carry no runtimeTicks -- and the gate asserts that none of them does, so the day one appears the"
echo "    position source is re-measured rather than silently inherited."
echo "  - FIVE MINUTES OF PACED, CONTINUOUSLY DECODED, TRANSCODED PLAYBACK: every consumed segment decoded as"
echo "    h264 from an mpeg4 source, no adjacent arrival gap over 20s, a quarter of the media decoded in the"
echo "    LAST THIRD of the window, all segments distinct."
echo "    THIS IS NOT A CLAIM THAT AN ENCODER WAS BUSY FOR FIVE MINUTES. The encoder's own output span and the"
echo "    live-encoder sample count are REPORTED and asserted on by nothing. G10 is run, not closed."
echo "  - AN ANONYMOUS DIRECT-PLAY REQUEST REFUSED. Unlike the pinned Jellyfin -- which answers the identical"
echo "    request 200 with the whole file -- this server answers 401, so this gate can assert that the media"
echo "    server authorized the read, which the Jellyfin gate had to decline to claim."
echo "  - a generation admitted while ONE HELD-OPEN RESPONSE BODY was mid-delivery, which then completed from"
echo "    the SAME response with the whole file's digest and a measured share of its bytes arriving after."
echo "  - a generation admitted while the scanner was OBSERVED IN FLIGHT, not merely after a sleep."
echo "  - a SIGKILL of the daemon mid-stream followed by the ordinary restart-and-remount. The held-open"
echo "    stream is permitted to fail there and is recorded as INTERRUPTED, which is not open-handle evidence;"
echo "    resumability is asserted separately. The published generation did not move."
echo "  - every mutation refused BY THE DAEMON from the media server's own container, run TWICE -- as the uid"
echo "    the server actually runs as, and as root, because this image drops privilege internally and a bare"
echo "    docker exec lands as root. The mount is deliberately not bound read-only."
echo "  - a real PROVIDER access lease minted during the run, whose per-run secret marker appears in NONE of"
echo "    the manifest directory, the probe cache or the media server's library state."
echo
echo "WHAT THIS GATE DOES NOT PROVE. A Docker Desktop pass is NOT Linux/Unraid closure and SHALL NOT be"
echo "reported as one. A real Unraid host and a real provider endpoint remain entirely unproved, and the"
echo "acceptance plan closes the tranche only on a Linux or Unraid run, on all three media servers, three"
echo "consecutive times."
