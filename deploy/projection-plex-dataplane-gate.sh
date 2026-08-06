#!/usr/bin/env bash
# The PLEX DATA-PLANE gate: PostgreSQL -> the production publisher -> the production projectiond image
# -> a FUSE mount -> a REAL PLEX MEDIA SERVER that scans, direct-plays, seeks and transcodes out of it.
#
# WHAT MAKES THIS DIFFERENT FROM THE JELLYFIN DATA-PLANE GATE. It is the SECOND media server, and the second
# is the one that shows whether the data plane works or whether the first gate was shaped around one server.
# Almost nothing survived the translation: Plex has no first-run wizard to drive, no `MediaBrowser`
# authorization header, no `static=true`, no scheduled-task list, no `Protocol`/`LocationType` quartet, a
# completely different HLS session model, and a scan-completion flag that goes false about thirty seconds
# before the library stops changing. What IS shared — what a five-minute claim has to mean, what ten seeks
# have to look like as a SET, what a report may contain — lives in `src/core/projection/media-server-*.ts`
# and is imported by both drivers, so neither can quietly hold a different rule.
#
# WHOSE PLEX ACCOUNT THIS NEEDS: NOBODY'S. The server is started UNCLAIMED — no `PLEX_CLAIM`, no sign-in, no
# personal credential anywhere in this repository — and an unclaimed Plex answers a local address with no
# token at all. The gate asserts `claimed=0` rather than assuming it, and separately asserts that no
# `PlexOnlineToken` was written to disk.
#
# WHAT A LOCAL REQUEST HAS TO LOOK LIKE. Plex treats a request whose `Host` header names something it does not
# recognise as NON-LOCAL and answers 401 — its own log says `Request came in with unrecognized domain / IP
# '<name>' in header Host` — so every URL this gate hands to a container names the server by ADDRESS. An
# earlier version of this header blamed plex.tv reachability for the same 401; that finding was confounded by
# exactly this, and it is retracted. See section 3.0 of the data-plane document.
#
# WHAT IS AND IS NOT KNOWN ABOUT RUNNING IT OFFLINE. Measured on a network created `--internal`, with DNS for
# servers.plex.tv failing throughout and the server addressed by IP, an unclaimed Plex answered `GET /`,
# `GET /library/sections`, `GET /:/prefs` and `POST /library/sections`. Those four, and no others. Scanning,
# playback, seeking and transcoding air-gapped are NOT established, because this gate has never run that way:
# Docker Desktop cannot publish a port from an internal network and the driver reaches the server through one.
# The DAEMON, the FAKE PROVIDER and the MOUNT stay on the gate's own network regardless, the provider's
# counters account for every media byte the server fetched, and the run asserts that no provider access
# material reaches the manifest, the probe cache or Plex's own library state.
#
# THE DECODER IS NOT THE SERVER UNDER TEST, AND ON PLEX IT STRUCTURALLY CANNOT BE. The Plex image ships
# `Plex Transcoder` — an ffmpeg fork — and NO ffprobe at all. So every "playable video" claim in this gate is
# made by a decoder from an unrelated pinned image, which also generates the media. On Jellyfin that
# separation is a discipline; here it is a fact about the image, and it makes the transcode evidence stronger
# rather than weaker.
#
# WHAT IT DOES NOT PROVE, AND WILL NOT BE PRESENTED AS PROVING. A Docker Desktop pass is NOT Linux/Unraid
# closure. Emby, a real Unraid host and a real provider endpoint remain entirely unproved, and the acceptance
# plan says the tranche closes on a Linux/Unraid run, on all three media servers, three times.
#
# EVERYTHING IS BOUNDED. Every readiness probe, read, scan, transcode and wait has a hard deadline; a hang
# fails the gate rather than occupying the machine.

set -euo pipefail
# shellcheck source=deploy/projection-gate-cleanup.sh
. "$(cd "$(dirname "$0")" && pwd)/projection-gate-cleanup.sh"

export MSYS_NO_PATHCONV=1

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
GO_IMAGE="golang:1.26.5-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"

# THE MEDIA SERVER, PINNED BY DIGEST. A tag would let the thing under test change between two runs of a gate
# whose entire claim is that it passed three times in a row.
PLEX_IMAGE="plexinc/pms-docker@sha256:a2b03d75aa16f422488c692935cab476d966b75f2af3c93bb6d910c6051906f5"

# THE DECODER AND MEDIA GENERATOR, WHICH IS DELIBERATELY NOT PLEX.
#
# The Plex image has no ffprobe, so a decoder has to come from somewhere. This one is the ffmpeg inside the
# image this repository already pins for the Jellyfin gate — already downloaded on any host that has run
# that, already digest-pinned, and with no relationship whatsoever to the server under test here. Using the
# server's own encoder to judge the server's own output would be the kind of round trip the Jellyfin gate had
# to remove an assertion over; using a third party's is simply better evidence.
DECODER_IMAGE="jellyfin/jellyfin@sha256:7ae36aab93ef9b6aaff02b37f8bb23df84bb2d7a3f6054ec8fc466072a648ce2"
DECODER_FFMPEG="/usr/lib/jellyfin-ffmpeg/ffmpeg"
DECODER_FFPROBE="/usr/lib/jellyfin-ffmpeg/ffprobe"

# THE OPT-IN GEOMETRY DIAGNOSTIC, WHICH IS NOT A GATE AND CANNOT BE MISTAKEN FOR ONE.
#
# WHAT IT IS FOR. gate6 measured the large-object scan at 32,505,856 bytes over 10 ranged requests, and that
# total cannot be decomposed: 7.75 demand blocks is not a whole number of anything. A budget derived from it
# would be a multiplier chosen to clear an observation, which is the mistake this gate has already made once.
# The endpoint now reports request SHAPE, and this mode measures that shape over two large objects of
# materially different sizes -- because one object cannot distinguish a fixed per-item cost from one that
# scales with size, and a single point would let either story be told.
#
# WHAT MAKES IT SAFE TO HAVE IN THE PRODUCTION GATE AT ALL. It is off unless PROJECTION_PLEX_GEOMETRY_DIAGNOSTIC=1,
# it adds nothing to the default path, it scores nothing -- no ceiling, no floor, no fraction is applied to
# the second object -- and it exits **78**, which is neither 0 nor the 77 that means "skipped". The three-run
# wrapper counts only 0, so a diagnostic can never be counted as one of the three required runs; the optional
# entry point maps only 77, so it cannot be laundered into a success either.
GEOMETRY_DIAGNOSTIC="${PROJECTION_PLEX_GEOMETRY_DIAGNOSTIC:-0}"
GEOMETRY_EXIT_STATUS=78

COMPOSE_FILE="docker-compose.projection-plex.yml"
NETWORK="projection-plex-gate"
PG_PORT="${PROJECTION_PLEX_GATE_PG_PORT:-5490}"
PLEX_PORT="${PROJECTION_PLEX_GATE_HTTP_PORT:-32491}"
RANGE_PORT="${PROJECTION_PLEX_GATE_RANGE_PORT:-8095}"

MOUNT_CONTAINER="projection-px-mount-$$"
RANGE_CONTAINER="projection-px-range-$$"
PLEX_CONTAINER="projection-px-server-$$"
# THE PACED CONSUMER, named so the cleanup trap can remove it: it runs for five minutes, and a gate that
# failed halfway through one would otherwise leave an ffmpeg reading the mount for the rest of the run — and
# a stale reader is what stops a FUSE mount unmounting cleanly, which is how the NEXT run inherits a
# namespace and passes for the wrong reason.
PLAY_CONTAINER="projection-px-play-$$"

# TWO SPELLINGS OF ONE DIRECTORY. WORK is absolute and is what Docker bind mounts name, and it lives beside
# the repository because bind propagation needs a shared host mount; REL is relative and is what node and tsx
# are given, because an MSYS absolute path is not something a Windows node binary can open.
GATE_ROOT="$PWD/.projection-plex-gate"
REL=".projection-plex-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_PLEX_GATE_PG_PORT="$PG_PORT"

cleanup() {
  # THE MEDIA SERVER FIRST. It holds open handles on the mount, and a FUSE mount with a live reader does not
  # unmount cleanly — leaving one behind is how the NEXT run inherits a stale namespace and passes for the
  # wrong reason.
  docker rm -f "$PLAY_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$PLEX_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$MOUNT_CONTAINER" "$RANGE_CONTAINER" >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  # THE UNMOUNT PROPAGATES BACK TO THE HOST, which the inline version that used to be here did not:
  # it unmounted inside a container whose bind of the gate root was `rprivate`, so the host mountpoint
  # survived every run. See `deploy/projection-gate-cleanup.sh`.
  if [ -n "${WORK:-}" ]; then
    projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true
    projection_gate_report_cleanliness "$GATE_ROOT" "$WORK" || true
  fi
}
trap cleanup EXIT

step() { echo; echo "=== $* ==="; }

# THE MEDIA SERVER'S OWN LAST WORDS, BOUNDED AND SCRUBBED, WHENEVER THE GATE FAILS.
#
# WHY A GATE NEEDS THIS. The cleanup trap deletes the run directory, and the media server's log lives inside
# it — so a failure that happens once in a thirty-minute run leaves NOTHING behind to diagnose it with. That
# is not hypothetical: a seek timed out on segment 17 and the only surviving evidence was the timeout itself.
# The information existed at the time and was thrown away. It is the difference between a gate that finds
# defects and a gate that reports that something went wrong.
#
# TIME-BOUNDED, LINE-BOUNDED, BEST EFFORT AND SCRUBBED — and it lives in its own script so the offline suite
# can drive a hanging collector and prove the bound holds. `docker exec` blocks indefinitely against a wedged
# container, and the failures that most need a log tail are exactly the ones where the container is wedged; a
# diagnostic that hangs there would replace an explained failure with an unexplained one.
# See deploy/projection-plex-log-tail.sh.
die() {
  echo "GATE FAILED: $*" >&2
  if docker inspect "$PLEX_CONTAINER" >/dev/null 2>&1; then
    echo "--- the media server's last 40 log lines, time-bounded and scrubbed ---" >&2
    bash "$(dirname "$0")/projection-plex-log-tail.sh" "$PLEX_CONTAINER" 40 >&2 || true
    echo "--- end ---" >&2
  fi
  exit 1
}

field()    { node "$REL/jq.cjs" "$1"; }
publish()  { npx tsx src/ops/projection-publish-cli.ts --manifest-dir "$REL/manifest" "$@"; }
register() { npx tsx src/ops/projection-register-cli.ts "$@"; }
drive()    { npx tsx src/ops/projection-plex-dataplane-cli.ts "$@" --results "$REL/out/results.json"; }
# `--no-healthcheck` ON EVERY DECODER CONTAINER, AND IT IS ABOUT TRUTHFUL SUPERVISION.
#
# The decoder image is a media server's image, borrowed here for its ffmpeg. Its own `HEALTHCHECK` probes
# that server on localhost:8096, which is not running in these containers because the entrypoint is ffmpeg.
# So a container doing exactly what it was asked to do reports `unhealthy` for its whole life. A five-minute
# paced play showed red in `docker ps` throughout a successful run. Nothing failed, and that is the problem:
# a status that is always wrong spends the signal, and the next genuinely unhealthy container inherits an
# operator who has learned to ignore it.
DECODER_RUN_FLAGS=(--rm --no-healthcheck)
ffmpeg_run()  { docker run "${DECODER_RUN_FLAGS[@]}" --entrypoint "$DECODER_FFMPEG"  -v "$WORK:/work" "$DECODER_IMAGE" "$@"; }
ffprobe_run() { docker run "${DECODER_RUN_FLAGS[@]}" --entrypoint "$DECODER_FFPROBE" -v "$WORK:/work" "$DECODER_IMAGE" "$@"; }

mkdir -p "$WORK/manifest" "$WORK/media" "$WORK/remote" "$WORK/cache" "$WORK/mnt" "$WORK/out" \
         "$WORK/plex-config" "$WORK/plex-transcode"
# The media server runs non-root and owns nothing on this host, so its state directories are made writable by
# whoever it turns out to be. The MEDIA is not: it is 444 through the mount, and that is under test.
chmod 777 "$WORK/cache" "$WORK/mnt" "$WORK/out" "$WORK/plex-config" "$WORK/plex-transcode"
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
  // `?? 0` PRINTED A ZERO FOR A COUNTER THE ENDPOINT DOES NOT CARRY, and a zero that means "the field is
  // not there" is indistinguishable from one that means "it did not happen" — on the surface every budget in
  // section 5 is read from. Every name these gates ask for exists at the endpoint today, so this was latent
  // rather than live; it is refused because the class is the one this audit is about.
  .then((snapshot) => {
    clearTimeout(timer);
    const value = snapshot === null || typeof snapshot !== 'object' ? undefined : snapshot[process.argv[3]];
    // A COUNTER IS AN int64 AT THE ENDPOINT AND A double HERE, so one past 2**53 arrives already rounded;
    // differencing two such values is arithmetic on numbers neither side agrees about.
    if (!Number.isSafeInteger(value) || value < 0) {
      console.error(`counters: the endpoint reports no exact non-negative '${process.argv[3]}'`);
      process.exit(1);
    }
    console.log(String(value));
  })
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
// key, size, sha256, kind, anchor. One document per generation, so a corpus that grows never needs three
// heredocs edited in step with each other.
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
// The most a fixed-window probe cache can legitimately hold for one corpus, computed FROM the corpus rather
// than written down. Per entry the plan allows three one-megabyte windows, or the whole object when the
// object is below the contract's single-probe threshold, plus slack — because what this rules out is an
// order of magnitude, not a byte.
const { readFileSync } = require('node:fs');
const WINDOW = 1048576;
const SINGLE_PROBE_BELOW = 3 * WINDOW;
//
// AND A MISSING SIZE USED TO *RAISE* IT, which is the direction a budget must never move when its input
// degrades. `undefined < SINGLE_PROBE_BELOW` is false, so an entry carrying no `sizeBytes` fell through to
// the three-window branch and bought itself 3 MiB of headroom, silently, exit 0. Measured by running this
// program against a 51-entry corpus with one size removed: the ceiling went from 25,185,364 to 29,858,950
// with no diagnostic. A size that is not a non-negative SAFE integer is now REFUSED rather than
// absorbed, for the reason the next paragraph gives. No number in this ceiling moved.
const expected = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(expected) || expected.length === 0) {
  console.error('cacheceiling: the corpus document is empty or is not a list, so a ceiling over it would '
    + 'bound nothing');
  process.exit(2);
}
//
// AND `Number.isInteger` IS NOT THE CHECK. It accepts 2**53 + 2 and every integer above it, where addition
// silently stops being exact — so a corpus could carry sizes that each pass and a ceiling that is off by an
// arbitrary amount. `Number.isSafeInteger` is what `windowProblems` in `lease-gates.ts` already holds the
// lease counters to, and the RUNNING total is checked too: individually safe sizes can sum past the
// boundary, and a budget computed in inexact arithmetic is not a budget.
let ceiling = 0;
for (const entry of expected) {
  const size = entry === null || typeof entry !== 'object' ? undefined : entry.sizeBytes;
  if (!Number.isSafeInteger(size) || size < 0) {
    console.error('cacheceiling: an entry carries no usable sizeBytes, so a ceiling derived from this '
      + 'corpus would be looser than the corpus and would bound nothing');
    process.exit(2);
  }
  ceiling += size < SINGLE_PROBE_BELOW ? size : 3 * WINDOW;
  if (!Number.isSafeInteger(ceiling)) {
    console.error('cacheceiling: the corpus sums past the exact-integer boundary, so every arithmetic '
      + 'result after this point is approximate');
    process.exit(2);
  }
}
const answer = Math.floor(ceiling * 1.5) + 4 * 1048576;
if (!Number.isSafeInteger(answer)) {
  console.error('cacheceiling: the ceiling is past the exact-integer boundary');
  process.exit(2);
}
console.log(String(answer));
CEILING

cat > "$WORK/published.cjs" <<'PUBLISHED'
const { readFileSync } = require('node:fs');
//
// THE DENOMINATOR IS VALIDATED BECAUSE `+` IS NOT ARITHMETIC IN JAVASCRIPT. With one size arriving as a
// string, `total + entry.sizeBytes` CONCATENATES: measured, a 122,345,436-byte corpus reported
// 87511611050000008594275 — a syntactically valid integer bash accepts without complaint, about 10^15 times
// the truth, which makes `test "$CACHE_BYTES" -lt "$PUBLISHED_BYTES"` unfailable. A missing size reported
// NaN. Both are refused rather than printed.
const entries = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(entries) || entries.length === 0) {
  console.error('published: the generation document is empty or is not a list');
  process.exit(2);
}
let total = 0;
for (const entry of entries) {
  const size = entry === null || typeof entry !== 'object' ? undefined : entry.sizeBytes;
  if (!Number.isSafeInteger(size) || size < 0) {
    console.error('published: an entry carries no usable sizeBytes, so the published total would not be one');
    process.exit(2);
  }
  total += size;
  // INDIVIDUALLY SAFE SIZES CAN SUM PAST THE BOUNDARY, and a denominator computed in inexact arithmetic is
  // a denominator that compares wrong in the same direction every time.
  if (!Number.isSafeInteger(total)) {
    console.error('published: the generation sums past the exact-integer boundary, so the total is not one');
    process.exit(2);
  }
}
console.log(String(total));
PUBLISHED

cat > "$WORK/probes.cjs" <<'PROBES'
// Turn a directory of decoded-segment reports into the JSON the verify phases read.
//
// IT DOES NO DECIDING: a segment that decoded as nothing at all still becomes a record with an empty codec
// and zero packets, so the phase that holds them against the acceptance plan sees a FAILURE rather than an
// absence.
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

cat > "$WORK/seekprobes.cjs" <<'SEEKPROBES'
// The same, for the seek segments, whose fourth field is the decoded picture's own START TIMESTAMP rather
// than a duration. That number is the temporal evidence: it must track the position asked for.
const { readFileSync, writeFileSync } = require('node:fs');
const lines = readFileSync(process.argv[2], 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
const decodes = lines.map((line) => {
  const [index, codec, packets, start] = line.split('|');
  return {
    index: Number(index),
    codec: (codec ?? '').trim(),
    packets: Number(packets) || 0,
    startSeconds: Number(start) || 0,
  };
});
writeFileSync(process.argv[3], `${JSON.stringify(decodes, null, 2)}\n`);
console.log(String(decodes.length));
SEEKPROBES

cat > "$WORK/sizelist.cjs" <<'SIZELIST'
// Every REMOTE object in the library, as a comma-separated list of byte lengths.
//
// THE BUDGET EVALUATES THE CLASS FORMULA AT EACH OBJECT'S LENGTH, so the sizes cannot be summed before they
// get there: a forty-kilobyte corpus entry cannot cost a four-megabyte demand block, and folding it into a
// total would inflate the allowance by orders of magnitude. The endpoint reports bytes PER OBJECT, so the
// ceiling is asserted per object and a breach names the object; this list is what the aggregate cross-check
// and the floor are computed from.
// Extra sizes given on the command line are the objects that are not in the corpus document -- the soak
// source and the remote anchor.
const { readFileSync } = require('node:fs');
const [, , expectedPath, ...extra] = process.argv;
const entries = JSON.parse(readFileSync(expectedPath, 'utf8'));
const sizes = entries.filter((entry) => entry.kind === 'http-range').map((entry) => entry.sizeBytes);
for (const value of extra) {
  const size = Number(value);
  if (Number.isFinite(size) && size > 0) sizes.push(size);
}
console.log(sizes.join(','));
SIZELIST

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
# 77 is the conventional "skipped" status. It is NOT 0, so anything that treats zero as success — a shell, a
# CI step, the three-run wrapper — reports a skip as a non-success. A green tranche-closing command that
# proved nothing is the single worst failure this repository can have, and it is one status code away. A host
# where skip-as-success is genuinely wanted has its own entry point,
# `deploy/projection-plex-dataplane-gate-optional.sh`, which maps 77 to 0 and nothing else — and which the
# acceptance plan does not name as evidence.
GATE_SKIP_STATUS=77
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no /dev/fuse is reachable from a container on this host." >&2
  echo "      The PLEX DATA PLANE is entirely UNPROVEN here. Nothing in this gate ran, and this run" >&2
  echo "      closes NO acceptance gate. It is not a pass and must not be reported as one." >&2
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


# THERE IS NO plex.tv REACHABILITY CHECK HERE, AND THERE USED TO BE ONE.
#
# It skipped the whole gate with status 77 when `servers.plex.tv` did not resolve, on the strength of a
# measurement that an unclaimed Plex answers 401 to its own local API without it. That measurement was
# confounded: every probe in it addressed the server by its Docker container NAME, and what was refusing was
# Plex's Host-header rebinding protection, not plex.tv. Re-measured on a `--internal` network with the server
# addressed by IP, an unclaimed Plex with no route out answered `GET /`, `GET /library/sections`,
# `GET /:/prefs` and `POST /library/sections`. So the check would have skipped a host for a reason that does
# not exist -- a false SKIP, which is the same family of defect as a false PASS and is deleted rather than
# softened. See `PLEX_REJECTS_UNRECOGNISED_HOST_HEADER` and section 3.0 of the data-plane document.

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
# is a generated tone; both are produced here and thrown away with the run directory.
#
# THE VIDEO CODEC IS MPEG4 ON PURPOSE. The transcode gate asks Plex for h264, and a server given a source it
# can already stream will remux rather than re-encode — which would make "a transcode ran" a claim about an
# endpoint rather than a measurement of an encoder.
#
# THE FILES ARE OVER 3 MiB so the contract's full three-window probe plan applies rather than its
# single-window one; a remote entry read through one window would not exercise the seek path at all.
#
# EVERY FILE IS DELIBERATELY DIFFERENT FROM EVERY OTHER. Two entries generated from identical parameters
# would be byte-identical, and a gate that read the LOCAL file where it meant to read the REMOTE one would
# still match its digest and pass.
encode() {
  # $1 destination inside /work, $2 duration, $3 lavfi video source, $4 tone frequency,
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
MIDSCAN_FILE="Projection Remote Held (2026).mp4"

# THE REMOTE ANCHOR'S MOOV ATOM IS AT THE END, ON PURPOSE. With `+faststart` the index sits in the first few
# kilobytes and a scanner identifies the file from its head alone — the easy case, which leaves the
# contract's TAIL probe window unexercised by any media server. Leaving the index at the end forces the
# scanner to seek to the far end of an object it is reading over HTTP Range.
encode "media/$LOCAL_FILE" 40 testsrc 440 faststart
encode "remote/$REMOTE_FILE" 8 testsrc2 660 moov-at-end
# A THIRD REMOTE OBJECT, generated now and published much later, for the mid-scan gate: it needs an entry
# whose probe windows are NOT in the daemon's cache, so that the endpoint can hold the scanner's read.
encode "remote/$MIDSCAN_FILE" 6 smptebars 550 faststart

# ----------------------------------------------------------------------------------------------------------
# THE LARGE REMOTE OBJECT, GENERATED HERE AND PUBLISHED MUCH LATER -- AND GENERATED HERE FOR A REASON THAT IS
# ABOUT EVIDENCE RATHER THAN CONVENIENCE.
#
# It is the only fixture the product's "a scan reads a fraction of the object" claim can be tested against;
# see the step that publishes it. The obvious way to add it was to restart the fake endpoint once the file
# existed -- and THAT WOULD HAVE DESTROYED THE RUN'S PROVIDER EVIDENCE. The endpoint's counters are process
# lifetime counters, and `PX15` asserts over the WHOLE run that it served zero 429s, zero full-body answers
# to a ranged request and never exceeded the connection cap. Restarting it mid-run resets those to zero, so
# every violation before the restart would have been discarded and PX15 would have been describing the last
# few minutes while claiming to describe the run.
#
# So every remote object this run will ever serve is generated BEFORE the endpoint starts and registered with
# it at launch. Registering an object with the endpoint is not publishing it: nothing is visible through the
# mount until the control plane mints a generation naming it.
#
# THE BITRATE MAKES THE SIZE; the frame size only makes it slow. 640x480 at 8 Mbit/s reaches ~100 MB in a
# hundred seconds and encodes in a fraction of that.
LARGE_FILE="Projection Large Remote (2026).mp4"
ffmpeg_run -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=640x480:rate=24:duration=105" \
  -f lavfi -i "sine=frequency=277:duration=105" \
  -c:v mpeg4 -b:v 8M -minrate 8M -maxrate 8M -bufsize 16M \
  -c:a aac -b:a 64k -shortest -movflags +faststart "/work/remote/$LARGE_FILE"

LARGE_SIZE="$(wc -c < "$WORK/remote/$LARGE_FILE" | tr -d ' ')"
LARGE_SHA="$(node "$REL/sha.cjs" "$REL/remote/$LARGE_FILE")"
# THE FIXTURE HAS TO BE BIG ENOUGH FOR THE CLAIM TO MEAN ANYTHING, and that is asserted rather than assumed.
# The ALLOWED CEILING for identifying one object is the class caps evaluated against its own length: 8 block
# fetches plus 3 probe windows, each evaluated at the object's length. On a 20 MB object that exceeds half the
# object -- so a 0.5
# fraction would be asserting something the ceiling does not constrain and the result would say nothing either
# way. 94 MiB is PLEX_LARGE_FIXTURE.MIN_BYTES, the smallest whole MiB at which the envelope is under three
# quarters of the headline fraction; an offline test asserts this literal still equals that constant.
# (The ceiling is an upper bound on what a scan MAY read, not a floor on what it needs; an earlier version of
# this comment called it the bytes a scan legitimately needs, which reads it backwards.)
test "$LARGE_SIZE" -ge 98566144 \
  || die "the large fixture is $LARGE_SIZE bytes, under the 94 MiB the fraction claim needs to be testable"
echo "  the large remote object is $LARGE_SIZE bytes"

# THE SECOND LARGE OBJECT, GENERATED ONLY IN DIAGNOSTIC MODE AND ONLY HERE.
#
# SAME CODEC AND SETTINGS, MATERIALLY DIFFERENT DURATION. Identical encoder parameters are what make the two
# measurements comparable: if the second object differed in codec, bitrate or container as well as in size,
# a difference in its read shape could be attributed to any of them. Only the duration changes, so only the
# size does -- which is the single variable the question is about.
#
# IT IS GENERATED BEFORE THE PROVIDER STARTS, for the same reason the first one is: the endpoint's counters
# are process-lifetime counters that PX15 asserts over the whole run, and restarting it to add an object
# would silently reset them.
SECOND_LARGE_FILE="Projection Second Large Remote (2026).mp4"
SECOND_LARGE_REF="obj-projection-second-large-remote"
SECOND_LARGE_SIZE=0
if [ "$GEOMETRY_DIAGNOSTIC" = "1" ]; then
  step "GEOMETRY DIAGNOSTIC: generating a second large object of a different size"
  ffmpeg_run -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=640x480:rate=24:duration=45" \
    -f lavfi -i "sine=frequency=277:duration=45" \
    -c:v mpeg4 -b:v 8M -minrate 8M -maxrate 8M -bufsize 16M \
    -c:a aac -b:a 64k -shortest -movflags +faststart "/work/remote/$SECOND_LARGE_FILE"
  SECOND_LARGE_SIZE="$(wc -c < "$WORK/remote/$SECOND_LARGE_FILE" | tr -d ' ')"
  SECOND_LARGE_SHA="$(node "$REL/sha.cjs" "$REL/remote/$SECOND_LARGE_FILE")"
  # THE TWO SIZES MUST DIFFER ENOUGH TO SEPARATE THE TWO STORIES. A fixed per-item cost and one that scales
  # with size are indistinguishable across objects of nearly equal length, so the run refuses to produce
  # evidence that could not answer its own question.
  test "$SECOND_LARGE_SIZE" -lt "$(( LARGE_SIZE / 2 ))" \
    || die "the second large object is $SECOND_LARGE_SIZE bytes against $LARGE_SIZE; too close to tell a fixed cost from a scaling one"
  echo "  the second large remote object is $SECOND_LARGE_SIZE bytes, against $LARGE_SIZE for the first"
fi

CORPUS_COUNT=47
CORPUS_LOCAL=9
# ----------------------------------------------------------------------------------------------------------
step "generating the ${CORPUS_COUNT}-item legal synthetic corpus, in one container"
# ----------------------------------------------------------------------------------------------------------
# G7 IS A SCAN OF A ~50-ENTRY CORPUS, and what it measures is whether a media server catalogues FIFTY
# DISTINCT IDENTITIES correctly — a question about namespace, metadata and stable identity, not about bytes.
# Fifty large files would answer the same question, cost gigabytes and minutes per run, and make the gate
# slow enough that somebody would eventually shrink the corpus. A fifty-entry gate run against five entries
# is worse than no gate at all.
#
# THE GENERATOR IS A FILE, NOT A MULTI-LINE `-c '...'` ARGUMENT, and that is a rule this repository enforces:
# `test/custody-runtime-closure.ts` refuses a shipped line whose quotes do not close on it.
cat > "$WORK/out/gen-corpus.sh" <<'GENCORPUS'
set -eu
total="$1"; localCount="$2"; ff="$3"
i=1
while [ "$i" -le "$total" ]; do
  n=$(printf "%02d" "$i")
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
docker run "${DECODER_RUN_FLAGS[@]}" --entrypoint /bin/sh -v "$WORK:/work" "$DECODER_IMAGE" \
  /work/out/gen-corpus.sh "$CORPUS_COUNT" "$CORPUS_LOCAL" "$DECODER_FFMPEG"

# ----------------------------------------------------------------------------------------------------------
SOAK_SECONDS=340
SOAK_FILE="Projection Soak Source (2026).mp4"
step "generating the long, low-bitrate soak source (${SOAK_SECONDS}s)"
# ----------------------------------------------------------------------------------------------------------
# G8 wants five minutes of playback, G9 ten seeks spread across a duration with one beyond 90 % of it, and
# G10 five minutes of transcoding. All three need a source longer than five minutes and none needs fifty of
# them. THE BITRATE IS PINNED rather than quality-targeted: `testsrc` compresses to almost nothing under a
# quality target, and a soak source under 3 MiB would fall below the contract's single-probe threshold, which
# would leave the seek gate reading an object whose whole probe plan is one window over all of it.
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
# position and the five-minute play are computed from this number; taking it from the request rather than
# from the artifact would make a short encode look like a successful long one.
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

# THE DIGESTS ARE RECORDED OUTSIDE THE MOUNT, before anything is published. A hash taken through the thing
# being verified only proves a file hashes to itself.
LOCAL_SHA="$(node "$REL/sha.cjs" "$REL/media/$LOCAL_FILE")"
REMOTE_SHA="$(node "$REL/sha.cjs" "$REL/remote/$REMOTE_FILE")"
echo "  local  $LOCAL_SIZE bytes, sha256 $LOCAL_SHA"
echo "  remote $REMOTE_SIZE bytes, sha256 $REMOTE_SHA"
test "$LOCAL_SHA" != "$REMOTE_SHA" || die "the two entries are byte-identical, so no read could be mismatched"
test "$LOCAL_SIZE" != "$REMOTE_SIZE" || die "the two entries are the same length, so a size check proves nothing"

SOURCE_CODEC="$(ffprobe_run -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 \
  "/work/remote/$SOAK_FILE" | tr -d " \r\n")"
test "$SOURCE_CODEC" = "mpeg4" \
  || die "the generated soak source is $SOURCE_CODEC, not the mpeg4 the transcode gate needs"
echo "  the soak source decodes as mpeg4 video, which is what makes 'transcoded to h264' checkable"

# ----------------------------------------------------------------------------------------------------------
step "starting the deterministic HTTP Range endpoint, serving the remote objects from those files"
# ----------------------------------------------------------------------------------------------------------
# THE ENDPOINT IS internal/fakeprovider, the only "provider" any automated gate here contacts. Its counters
# are what the amplification budgets are measured against.
REMOTE_REF="obj-projection-remote-two"
MIDSCAN_REF="obj-projection-remote-held"
SOAK_REF="obj-projection-soak-source"
LARGE_REF="obj-projection-large-remote"

# A REAL, EXPIRING ACCESS LEASE, WITH A SECRET THIS GATE CAN SEARCH FOR BY EXACT VALUE. The endpoint runs in
# RESOLVER mode, so the daemon must exchange the stable objectRef for short-lived access material. The lease
# id carries a per-run 16-byte random marker: `l1` occurs by chance in any few megabytes of binary and could
# only produce false positives, and a 32-hex marker cannot — so a search for it across the manifest, the
# probe cache and the media server's database is a search for THE ACTUAL SECRET.
LEASE_MARKER="PJDLEASE$(node -e "console.log(require('node:crypto').randomBytes(16).toString('hex'))" | tr -d ' \r\n')"
echo "  the endpoint will mint leases prefixed with a per-run secret marker"

# The second large object joins the SINGLE launch below rather than prompting a restart. In the default
# path this array is empty and the launch is byte-for-byte what it always was.
DIAGNOSTIC_OBJECT_FLAGS=()
if [ "$GEOMETRY_DIAGNOSTIC" = "1" ]; then
  DIAGNOSTIC_OBJECT_FLAGS+=(--file-object "${SECOND_LARGE_REF}=/remote/${SECOND_LARGE_FILE}")
fi

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
  --file-object "${LARGE_REF}=/remote/${LARGE_FILE}" \
  "${DIAGNOSTIC_OBJECT_FLAGS[@]}" \
  "${CORPUS_OBJECT_FLAGS[@]}" --emit /out/objects.json >/dev/null

echo "  waiting for the endpoint to come up"
# A LIVENESS PROBE MUST NOT BE PROVIDER TRAFFIC. `/counters` is a control surface the endpoint deliberately
# does not count; a readiness loop that read the object would consume the budget it is about to measure.
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
# without a Range header is answered 416 on purpose — and busybox wget exits non-zero on a 206.
docker run --rm --network "$NETWORK" -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
  sh /probe/probe.sh "http://fakerange:8099/direct/${REMOTE_REF}" >/dev/null 2>&1 \
  || { docker logs "$RANGE_CONTAINER" 2>&1 | tail -20 >&2; die "the endpoint does not answer a ranged request with 206"; }

ENDPOINT_SIZE="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$REMOTE_REF" size)"
ENDPOINT_SHA="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$REMOTE_REF" sha256)"
REMOTE_PROBES="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$REMOTE_REF" probes)"
test "$ENDPOINT_SIZE" = "$REMOTE_SIZE" || die "the endpoint disagrees with the file about its size"
test "$ENDPOINT_SHA" = "$REMOTE_SHA"   || die "the endpoint is not serving the file the gate hashed"
echo "  the endpoint serves exactly the generated files"

# ----------------------------------------------------------------------------------------------------------
step "seeding the catalog through the production write path"
# ----------------------------------------------------------------------------------------------------------
LOCAL_PATH="Movies/Projection Local One (2026)/$LOCAL_FILE"
REMOTE_PATH="Movies/Projection Remote Two (2026)/$REMOTE_FILE"
SOAK_PATH="Movies/Projection Soak Source (2026)/$SOAK_FILE"
LOCAL_ITEM="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
REMOTE_ITEM="bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"
THIRD_ITEM="cccccccc-3333-4333-8333-cccccccccccc"
FOURTH_ITEM="dddddddd-4444-4444-8444-dddddddddddd"

register root --id media --kind local
register root --id vault --kind http-range
register version --key local-one --size "$LOCAL_SIZE" --mtime 2026-06-01T10:00:00.000Z
register entry --item "$LOCAL_ITEM"  --version-key local-one  --path "$LOCAL_PATH"  --source "local:media:$LOCAL_FILE"

# GENERATION 1 IS THE LOCAL ENTRY ALONE, AND THE REMOTE ANCHOR IS DELIBERATELY NOT IN IT.
#
# THE DEFECT THIS CLOSES, WHICH ONLY A REAL HOST COULD SHOW. Plex begins its OWN library-creation scan the
# instant a library exists, and this gate cannot prevent that. When the remote anchor was already published,
# that creation scan identified it -- and the PX9 window, which opens afterwards, measured a re-scan of an
# object Plex had already catalogued. On one Unraid run the window recorded ZERO provider bytes and ZERO
# ranged requests: every ceiling in it passed by having had nothing happen, and only the FLOORS caught it.
# The evidence is unambiguous -- the counters snapshot taken BEFORE the window already read 6 requests and
# 11,535,360 bytes for that object, and the snapshot after it was byte-identical.
#
# So the window was never cold; it was a RACE against Plex's creation scan, and the runs that passed were the
# ones where the snapshot happened to be taken before that scan finished its provider work.
#
# THE FIX IS THE CONTRACT'S OWN UNIT OF CHANGE, and it is the one G18 already uses: seed a generation the
# creation scan can find that COSTS THE PROVIDER NOTHING -- a local passthrough entry contacts no endpoint at
# all -- wait for Plex's own barrier to say that scan settled, and only then publish the remote anchor as a
# NEW generation. The object identity does not exist while the creation scan is running, so no scan can have
# touched it, and the window is cold BY CONSTRUCTION rather than by timing.
echo "  one local stable source registered; the HTTP Range anchor is published later, on purpose"

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
# WHY THIS IS NEEDED AT ALL. Since a handle release stopped deleting playback entries, a playback window can
# legitimately reach the provider zero times — the bytes are already in the daemon's memory. "Zero provider
# requests" then has two explanations that call for opposite responses: the daemon served it, or something
# that is not the daemon did. Only the daemon can say which, so the daemon is asked.
#
# WHY IT JOINS THE CONTAINER'S NETWORK NAMESPACE. The status server binds LOOPBACK ONLY and that restriction
# is not being relaxed for a test — a published port would not reach it and must not be made to. A container
# started with `--network container:<name>` shares that namespace, so the daemon's own 127.0.0.1 is reachable
# without the daemon listening anywhere else. The image that serves the mount is distroless and has no shell
# and no HTTP client, which is why the request comes from a separate, pinned one.
#
# IT IS NOT THE DIAGNOSTIC. `/readyz` carries cumulative counters and is always on; the per-event cache
# diagnostic stays off, and its route is not even registered unless an operator enables it.
#
# THE TWO SNAPSHOT ORDERS ARE DELIBERATELY ASYMMETRIC, AND THAT ASYMMETRY IS THE POINT.
#
#   at the START:  provider first, THEN daemon
#   at the END:    daemon first,   THEN provider
#
# So the daemon's evidence interval is CONTAINED INSIDE the provider's rather than overlapping it. Any read
# that lands between the two closing snapshots then counts on the PROVIDER side only, where it can push the
# request delta above zero and take the window out of the warm arm altogether. Reverse the closing order and
# the containment reverses with it: a late read would add cache hits the provider delta never saw, which is
# an inflated warm claim built out of activity the provider window excludes. The conservative direction is
# the one where straggling work can only make the window look COLDER, never warmer than it was.
DAEMON_STATUS_PORT=9099
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
  sh /out/baseline.sh "$LOCAL_PATH"

# THE SEED EXPECTATION: the local entry alone, which is all generation 1 contains. It is what Plex's own
# library-creation scan will find, and finding it costs the provider nothing.
node "$REL/expect.cjs" "$REL/out/seed-expected.json" - \
  "$LOCAL_FILE"  "$LOCAL_SIZE"  "$LOCAL_SHA"  local      anchor >/dev/null

# ----------------------------------------------------------------------------------------------------------
step "starting a REAL, UNCLAIMED Plex Media Server with the projected mount as its library root"
# ----------------------------------------------------------------------------------------------------------
# THE MOUNT IS DELIBERATELY NOT BOUND READ-ONLY. Adding `:ro` here would make Docker refuse writes and the
# mutation-refusal assertion below would be evidence about a Docker flag rather than about projectiond. What
# has to refuse a media server's write is the daemon.
#
# NON-ROOT: `PLEX_UID`/`PLEX_GID` make the server process run as uid 1000, which is how a media server runs
# on any host somebody has configured properly, and which matters because the projected files are mode 444
# owned by somebody else. A root reader would prove nothing about whether an ordinary uid can open them. The
# entrypoint itself needs root to set the container up and then drops; that the SERVER is not root is
# asserted below rather than assumed.
#
# NO `PLEX_CLAIM`. This gate uses nobody's Plex account.
#
# `ALLOWED_NETWORKS=0.0.0.0/0` is what makes the local API answerable without a credential. It is scoped by
# the container's own network rather than by the value: this container publishes its port on 127.0.0.1 only.
start_plex() {
  docker run -d --name "$PLEX_CONTAINER" \
    --network "$NETWORK" \
    -p "127.0.0.1:${PLEX_PORT}:32400" \
    -e TZ=UTC \
    -e PLEX_UID=1000 -e PLEX_GID=1000 \
    -e ALLOWED_NETWORKS=0.0.0.0/0 \
    -e ADVERTISE_IP="http://127.0.0.1:${PLEX_PORT}/" \
    -v "$WORK/plex-config:/config" \
    -v "$WORK/plex-transcode:/transcode" \
    -v "$WORK/mnt:/media/projection:rslave" \
    "$PLEX_IMAGE" >/dev/null
}
start_plex

PLEX_BASE="http://127.0.0.1:${PLEX_PORT}"
STATE="$REL/out/state.json"

drive bootstrap --base "$PLEX_BASE" --state "$STATE" \
  || { docker logs "$PLEX_CONTAINER" 2>&1 | tail -40 >&2; die "the media server never came up"; }
test -s "$WORK/out/state.json" || die "the bootstrap exited 0 but wrote no state"

# THE SERVER IS NOT ROOT, ASSERTED FROM INSIDE ITS OWN CONTAINER.
PLEX_PROC_USER="$(docker exec "$PLEX_CONTAINER" sh -c \
  "ps -eo user:16,args | grep 'Plex Media Server' | grep -v grep | head -1 | awk '{print \$1}'" \
  | tr -d " \r\n")"
test -n "$PLEX_PROC_USER" || die "no Plex Media Server process is running inside the container"
test "$PLEX_PROC_USER" != "root" || die "the media server is running as root, so a 444 file proves nothing"
echo "  the media server process runs as '$PLEX_PROC_USER', not root"

# THE MEDIA SERVER MUST BE ABLE TO READ THE MOUNT AS ITSELF, before a scan is asked for — otherwise a scan
# that finds nothing is ambiguous between "projection is broken" and "the container cannot see the directory".
docker exec --user 1000:1000 "$PLEX_CONTAINER" test -r "/media/projection/$LOCAL_PATH" \
  || die "the media server's own uid cannot read the projected file"
docker exec --user 1000:1000 "$PLEX_CONTAINER" test ! -L "/media/projection/$LOCAL_PATH" \
  || die "the media server sees a symlink where a file was published"
echo "  the media server can read the projected files as itself"

# THE MEDIA SERVER'S ADDRESS ON THE GATE NETWORK, WHICH IS HOW EVERY CONTAINER HERE MUST NAME IT.
#
# Plex refuses a request whose `Host` header is a name it does not recognise -- its own log says
# `Request came in with unrecognized domain / IP '<name>' in header Host; treating as non-local` -- and
# answers 401. Measured with everything else identical: the same peer on the same network gets 401 for
# `http://<container-name>:32400/...` and 200 for `http://<container-ip>:32400/...`, and forcing an IP into
# the Host header of a by-name request turns the 401 back into a 200. `allowedNetworks` does not override it.
#
# This cost the paced direct-play phase a run: the consumer reached the server by container name and ffmpeg
# got a 401 before it decoded a frame. So the consumer is handed an ADDRESS.
# INDEXED BY THE GATE NETWORK'S NAME, NOT `range`. A `range` over `.NetworkSettings.Networks` concatenates
# every address the container has, in map order — so the moment the container is attached to a second network
# it yields two addresses glued together and the consumer is handed a URL that resolves to nothing. The
# consumer must reach the server on the network the daemon and the provider are on, and that network has a
# name; naming it is both correct today and stable if another is ever added.
PLEX_IP="$(docker inspect "$PLEX_CONTAINER" \
  --format "{{index .NetworkSettings.Networks \"$NETWORK\" \"IPAddress\"}}" | tr -d " \r\n")"
test -n "$PLEX_IP" || die "the media server has no address on the $NETWORK network"
case "$PLEX_IP" in
  *[!0-9.]*|"") die "the media server's address on $NETWORK is not a bare IPv4 address: '$PLEX_IP'" ;;
esac
echo "  the media server will be addressed by its address, not by its container name"

drive prefs --state "$STATE"
# THE PROVIDER BASELINE, TAKEN BEFORE THE LIBRARY EXISTS.
#
# It is a DELTA that matters, not the absolute counter. The gate has already made one ranged request of
# its own by this point — the endpoint self-check that asserts a 206 — and an absolute comparison would
# blame Plex for it. The first version of this assertion did exactly that and failed the run it was
# written to protect.
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-before-library.json"
BEFORE_LIBRARY_RANGE="$(field rangeRequests < "$WORK/out/counters-before-library.json")"

drive library --state "$STATE" --mount-path /media/projection/Movies --name "Projection Movies"

# ----------------------------------------------------------------------------------------------------------
step "waiting out Plex's OWN library-creation scan, against a generation that costs the provider nothing"
# ----------------------------------------------------------------------------------------------------------
# Plex starts scanning the moment the library exists. Nothing here can stop that, so the gate makes it
# HARMLESS instead: the only thing published so far is a LOCAL passthrough entry, which contacts no endpoint,
# and this waits for Plex's own barrier to report that scan settled before anything remote is published.
drive scan --state "$STATE" --expect-file "$REL/out/seed-expected.json" \
  --out "$REL/out/items-seed.json" --label seed \
  || { docker logs "$PLEX_CONTAINER" 2>&1 | tail -30 >&2; die "Plex never settled after its own library-creation scan"; }

drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-after-seed.json"
SEED_COUNTERS_RANGE="$(field rangeRequests < "$WORK/out/counters-after-seed.json")"
SEED_RANGE_DELTA=$(( SEED_COUNTERS_RANGE - BEFORE_LIBRARY_RANGE ))
test "$SEED_RANGE_DELTA" -eq 0 \
  || die "the library-creation scan reached the provider $SEED_RANGE_DELTA time(s); the seed generation is local-only, so it must cost nothing"
echo "  Plex's creation scan settled, and it cost the provider zero ranged requests"

# ----------------------------------------------------------------------------------------------------------
step "publishing the HTTP Range anchor as a NEW generation, which nothing has ever scanned"
# ----------------------------------------------------------------------------------------------------------
PROBE_FLAGS=""
for probe in $REMOTE_PROBES; do PROBE_FLAGS="$PROBE_FLAGS --probe $probe"; done
# shellcheck disable=SC2086
register version --key remote-two --size "$REMOTE_SIZE" --mtime 2026-06-01T10:00:00.000Z $PROBE_FLAGS
register entry --item "$REMOTE_ITEM" --version-key remote-two --path "$REMOTE_PATH" --source "http-range:vault:${REMOTE_REF}"

publish > "$WORK/out/publish-remote.json"
test "$(field outcome < "$WORK/out/publish-remote.json")" = "published" \
  || die "the remote anchor generation was not published"
test "$(field additions < "$WORK/out/publish-remote.json")" = "1" \
  || die "the remote anchor generation added $(field additions < "$WORK/out/publish-remote.json") entries, not 1"

echo "  waiting for the daemon to admit the remote anchor"
ready=0
for _ in $(seq 1 240); do
  if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" test -f "/mnt/$REMOTE_PATH" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
test "$ready" -eq 1 || { docker logs "$MOUNT_CONTAINER" 2>&1 | tail -30 >&2; die "the remote anchor never became visible"; }

# ...and it is an ordinary read-only file to a non-root container, exactly as the local one is.
docker run --rm --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges \
  -v "$WORK/mnt:/mnt:rslave" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
  sh /out/baseline.sh "$REMOTE_PATH"

# The full expectation for the scan below: both anchors, entries whose BYTES are read back and digest-compared.
node "$REL/expect.cjs" "$REL/out/expected.json" - \
  "$LOCAL_FILE"  "$LOCAL_SIZE"  "$LOCAL_SHA"  local      anchor \
  "$REMOTE_FILE" "$REMOTE_SIZE" "$REMOTE_SHA" http-range anchor >/dev/null

# ----------------------------------------------------------------------------------------------------------
step "the first real library scan OF THE REMOTE ANCHOR — a window nothing has warmed"
# ----------------------------------------------------------------------------------------------------------
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-before-scan.json"
drive scan --state "$STATE" --expect-file "$REL/out/expected.json" --out "$REL/out/items-1.json" --label scan1
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-after-scan.json"

# WHAT THE SCAN COST AT THE PROVIDER. One remote entry; the byte budget is a FRACTION of the object's own
# length, so a scanner that downloaded the file to identify it cannot pass. AND A FLOOR AS WELL AS A CEILING:
# the remote anchor's index is at the END of the object, so a scanner that identified it really did have to
# fetch from the provider. Zero ranged requests would score perfectly against every ceiling and would mean
# the media server never opened it.
drive budget --before "$REL/out/counters-before-scan.json" --after "$REL/out/counters-after-scan.json" \
  --gate PX9-scan --entries 1 --object-sizes "$REMOTE_SIZE" --min-range 1

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

LOCAL_SEEK_OFFSET=$(( LOCAL_SIZE / 2 + 4321 ))
LOCAL_SEEK_SHA="$(node "$REL/sha.cjs" "$REL/media/$LOCAL_FILE" "$LOCAL_SEEK_OFFSET" "$SEEK_LENGTH")"
drive seek --state "$STATE" --items "$REL/out/items-1.json" --key "$LOCAL_FILE" \
  --offset "$LOCAL_SEEK_OFFSET" --length "$SEEK_LENGTH" --expect-sha "$LOCAL_SEEK_SHA"

# ----------------------------------------------------------------------------------------------------------
step "publishing the ~50-entry corpus and the long soak source"
# ----------------------------------------------------------------------------------------------------------
# EVERYTHING ABOVE WAS TWO ENTRIES, AND EVERYTHING ABOVE STAYS. The first generation is deliberately small so
# that the amplification evidence it produces is about ONE remote object and is not averaged with anything.
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
# shellcheck disable=SC2086
register version --key soak-source --size "$SOAK_SIZE" --mtime 2026-06-01T10:00:00.000Z $SOAK_PROBE_FLAGS
register entry --item "99999999-9999-4999-8999-999999999999" --version-key soak-source \
  --path "$SOAK_PATH" --source "http-range:vault:${SOAK_REF}"

publish > "$WORK/out/publish-corpus.json"
test "$(field outcome < "$WORK/out/publish-corpus.json")" = "published" || die "the corpus was not published"
test "$(field additions < "$WORK/out/publish-corpus.json")" = "$(( CORPUS_COUNT + 1 ))" \
  || die "the corpus generation added $(field additions < "$WORK/out/publish-corpus.json") entries, not $(( CORPUS_COUNT + 1 ))"

# The full expectation for this generation: every corpus entry, plus the two anchors and the soak source —
# which is also an anchor, because its bytes are read back and digest-compared.
CORPUS_TOTAL="$(node "$REL/expect.cjs" "$REL/out/expected-corpus.json" "$REL/out/corpus-expected.json" \
  "$LOCAL_FILE"  "$LOCAL_SIZE"  "$LOCAL_SHA"  local      anchor \
  "$REMOTE_FILE" "$REMOTE_SIZE" "$REMOTE_SHA" http-range anchor \
  "$SOAK_FILE"   "$SOAK_SIZE"   "$SOAK_SHA"   http-range anchor)"
echo "  the corpus is $CORPUS_TOTAL entries"
drive corpus-check --expect-file "$REL/out/expected-corpus.json" --min-entries 50 --min-remote 39

echo "  waiting for the daemon to admit the corpus generation"
ready=0
for _ in $(seq 1 240); do
  if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" test -f "/mnt/$SOAK_PATH" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
test "$ready" -eq 1 || { docker logs "$MOUNT_CONTAINER" 2>&1 | tail -30 >&2; die "the corpus never became visible"; }

drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-before-corpus.json"
drive scan --state "$STATE" --expect-file "$REL/out/expected-corpus.json" \
  --out "$REL/out/items-corpus.json" --label corpus
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-after-corpus.json"

# THE BYTE DENOMINATOR IS EVERY REMOTE OBJECT IN THE LIBRARY BEING SCANNED, ONE OBJECT AT A TIME.
#
# THE DEFECT THIS CLOSES. This passed `--bytes $SOAK_SIZE --small-bytes $CORPUS_SMALL_BYTES` -- two POOLED
# totals, which named the soak source and the corpus but silently omitted the REMOTE ANCHOR, an entry that is
# in this library and is re-scanned by this very scan. A budget whose denominator is smaller than the thing
# being measured is not a tight budget, it is a wrong one. And pooling the SIZES was the deeper fault: a
# total handed to the ceiling grants every entry the full envelope, which on this library is orders of
# magnitude more than clamping each of the thirty-eight tiny entries by its own length.
#
# ATTRIBUTION NOW EXISTS, AND THE CEILING USES IT. The endpoint reports bytes per registered object, so each
# object is held to its own ceiling and a breach names it -- this stopped being an aggregate-only claim when
# gate8 exceeded the summed ceiling by 47,065 bytes and nothing could say which of forty objects did it. The
# FLOOR is still a sum, because a floor is a claim about which objects should have been READ and this phase
# does not map the caller's window set onto the endpoint's ordinals.
#
# BOTH FLAGS ARE NOW GONE FROM THE PHASE, so this can no longer be got wrong by omission. Every byte term is
# derived from `--object-sizes`, and the ceiling evaluates the class caps at EACH object's length: 40 KB
# cannot cost a demand block. `--entries` alone carries the request and resolution denominators.
CORPUS_REMOTE_ENTRIES="$(node "$REL/jq.cjs" remoteEntries < "$WORK/out/corpus-totals.json")"
CORPUS_SIZE_LIST="$(node "$REL/sizelist.cjs" "$REL/out/corpus-expected.json" "$SOAK_SIZE" "$REMOTE_SIZE")"
drive budget --before "$REL/out/counters-before-corpus.json" --after "$REL/out/counters-after-corpus.json" \
  --gate PX9b-corpus-scan --entries "$(( CORPUS_REMOTE_ENTRIES + 2 ))" \
  --object-sizes "$CORPUS_SIZE_LIST" --min-range 1

# ----------------------------------------------------------------------------------------------------------
step "a repeat scan of the ~50-entry corpus, with zero churn"
# ----------------------------------------------------------------------------------------------------------
drive scan --state "$STATE" --expect-file "$REL/out/expected-corpus.json" \
  --out "$REL/out/items-corpus-2.json" --label corpus2
drive compare --before "$REL/out/items-corpus.json" --after "$REL/out/items-corpus-2.json" \
  --gate PX13b-corpus-rescan

# ----------------------------------------------------------------------------------------------------------
step "one LARGE remote object, which is the only place the fraction claim can be tested"
# ----------------------------------------------------------------------------------------------------------
# WHY THIS FIXTURE EXISTS, AND WHY EVERY OTHER BYTE BUDGET IN THIS GATE IS THE WRONG PLACE FOR THE CLAIM.
#
# The daemon serves a 4 MiB demand block for a one-byte read, so the CEILING for identifying one object is
# the class caps evaluated against that object -- 8 block fetches plus 3 probe windows, each clamped by the
# object's own length. It SATURATES at one demand block: at 4 MiB or more an object earns the full
# 36,700,160 bytes, and every larger object earns exactly the same. The soak source is 8.6 MB and the anchor
# 14.0 MB, so both are saturated and the ceiling permits a whole-object read several times over at those
# sizes -- satisfying it would prove nothing about the fraction. That is a limit of the INSTRUMENT and not a lower
# bound -- it does not mean a below-one read is unreachable there. The 1.28x and 1.66x measured earlier are
# separately just observations of what was read. An earlier version of this gate answered those numbers by
# raising a multiplier above 1.0, which recorded the observation and retired the claim.
#
# A RETIRED MODEL, NAMED SO IT IS NOT REBUILT: the ceiling here used to be 2 opens x min(3 x 4 MiB, size),
# saturating at 24 MiB. gate6 exceeded it -- 32,505,856 against 25,165,824 -- and it apportioned aggregate
# counters per open, which those counters cannot support. It is gone; nothing below divides by an open count.
#
# THE FIXTURE IS ABOVE 94 MiB, so the envelope is at most three quarters of the headline fraction. AND THE
# HONEST ORDER OF THE TWO ASSERTIONS: at this size the envelope (0.348 of the 105.4 MB object actually built)
# is TIGHTER than the SHARED 0.5 fraction, so the fraction does not mathematically bind -- a run inside the
# byte ceiling is already inside 0.5. The fraction stays the explicit headline because it is the product's
# claim in the product's own terms and it is the same constant the Jellyfin gate is held to, not one of
# Plex's own; the envelope is simply what would catch a regression first.
#
# IT IS PUBLISHED IN ITS OWN GENERATION AND MEASURED IN ITS OWN COUNTER WINDOW, which is what makes the
# delta attributable to this one object: everything already in the library has been scanned and analysed,
# and the repeat scan above has just demonstrated that costs the provider nothing.
#
# THE FILE AND ITS PROVIDER REGISTRATION ALREADY EXIST -- see the media-generation step. Nothing is restarted
# here, because restarting the endpoint would reset the lifetime counters `PX15` asserts over the whole run
# and silently discard every 429 and full-body answer that came before.
LARGE_PATH="Movies/Projection Large Remote (2026)/$LARGE_FILE"
LARGE_ITEM="a1a1a1a1-7777-4777-8777-a1a1a1a1a1a1"

LARGE_SIZE_AT_ENDPOINT="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$LARGE_REF" size)"
LARGE_SHA_AT_ENDPOINT="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$LARGE_REF" sha256)"
test "$LARGE_SIZE_AT_ENDPOINT" = "$LARGE_SIZE" || die "the endpoint disagrees with the large file about its size"
test "$LARGE_SHA_AT_ENDPOINT" = "$LARGE_SHA"   || die "the endpoint is not serving the large file the gate hashed"

LARGE_PROBES="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$LARGE_REF" probes)"
LARGE_PROBE_FLAGS=""
for probe in $LARGE_PROBES; do LARGE_PROBE_FLAGS="$LARGE_PROBE_FLAGS --probe $probe"; done
# shellcheck disable=SC2086
register version --key large-remote --size "$LARGE_SIZE" --mtime 2026-06-01T10:00:00.000Z $LARGE_PROBE_FLAGS
register entry --item "$LARGE_ITEM" --version-key large-remote --path "$LARGE_PATH" \
  --source "http-range:vault:${LARGE_REF}"
publish > "$WORK/out/publish-large.json"
test "$(field outcome   < "$WORK/out/publish-large.json")" = "published" || die "the large object was not published"
test "$(field additions < "$WORK/out/publish-large.json")" = "1"         || die "the large generation should add exactly one entry"

ready=0
for _ in $(seq 1 240); do
  if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" test -f "/mnt/$LARGE_PATH" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
test "$ready" -eq 1 || die "the large object never became visible"

node "$REL/expect.cjs" "$REL/out/expected-large.json" "$REL/out/expected-corpus.json" \
  "$LARGE_FILE" "$LARGE_SIZE" "$LARGE_SHA" http-range plain >/dev/null

drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-before-large.json"
drive scan --state "$STATE" --expect-file "$REL/out/expected-large.json" \
  --out "$REL/out/items-large.json" --label large
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-after-large.json"

# THE CLAIM, AT LAST SOMEWHERE IT CAN BE TESTED: what did identifying an object above the computed 94 MiB
# minimum cost, as a fraction of the object? A scanner that downloaded it would sit at 1.0. The headline is
# the SHARED 0.5 the Jellyfin gate is held to, and the class-envelope ceiling is asserted beside it -- and on
# an object this size the ENVELOPE is the tighter of the two, so 0.5 is the headline but is not what binds.
drive budget --before "$REL/out/counters-before-large.json" --after "$REL/out/counters-after-large.json" \
  --gate PX9c-large-object-scan --entries 1 --object-sizes "$LARGE_SIZE" \
  --large-bytes "$LARGE_SIZE" --min-range 1

drive compare --before "$REL/out/items-corpus-2.json" --after "$REL/out/items-large.json" \
  --gate PX9c-large-added --expect-added 1

# EVERY LATER SCAN BUDGET COVERS THIS OBJECT TOO, so the size list grows with the library it describes. A
# list that stopped at the corpus would under-name the denominator of the restart scan below.
CORPUS_SIZE_LIST="${CORPUS_SIZE_LIST},${LARGE_SIZE}"

# ----------------------------------------------------------------------------------------------------------
if [ "$GEOMETRY_DIAGNOSTIC" = "1" ]; then
step "GEOMETRY DIAGNOSTIC: a second large object, in its own generation and its own counter window"
# ----------------------------------------------------------------------------------------------------------
# TWO POINTS, BECAUSE ONE CANNOT ANSWER THE QUESTION. The question is whether the cost of identifying an
# object is fixed or scales with its size, and a single measurement is consistent with both. Two objects of
# the same codec and settings and materially different length, each scanned alone in its own counter window
# with everything else already warm, separate them.
#
# NOTHING HERE IS SCORED. No ceiling, no floor, no fraction is applied to this object -- `shape-window`
# records the request shape and asserts only that it reconciles. The gate has already made the mistake of
# turning an observation into a budget, and this mode exists so that the next budget can be derived from
# evidence rather than fitted to it.
SECOND_LARGE_PATH="Movies/Projection Second Large Remote (2026)/$SECOND_LARGE_FILE"
SECOND_LARGE_ITEM="b2b2b2b2-8888-4888-8888-b2b2b2b2b2b2"

SECOND_SIZE_AT_ENDPOINT="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$SECOND_LARGE_REF" size)"
test "$SECOND_SIZE_AT_ENDPOINT" = "$SECOND_LARGE_SIZE" \
  || die "the endpoint disagrees with the second large file about its size"

SECOND_LARGE_PROBES="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$SECOND_LARGE_REF" probes)"
SECOND_PROBE_FLAGS=""
for probe in $SECOND_LARGE_PROBES; do SECOND_PROBE_FLAGS="$SECOND_PROBE_FLAGS --probe $probe"; done
# shellcheck disable=SC2086
register version --key second-large --size "$SECOND_LARGE_SIZE" --mtime 2026-06-01T10:00:00.000Z $SECOND_PROBE_FLAGS
register entry --item "$SECOND_LARGE_ITEM" --version-key second-large --path "$SECOND_LARGE_PATH" \
  --source "http-range:vault:${SECOND_LARGE_REF}"
publish > "$WORK/out/publish-second-large.json"
test "$(field outcome   < "$WORK/out/publish-second-large.json")" = "published" || die "the second large object was not published"
test "$(field additions < "$WORK/out/publish-second-large.json")" = "1"         || die "the second large generation should add exactly one entry"

ready=0
for _ in $(seq 1 240); do
  if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" test -f "/mnt/$SECOND_LARGE_PATH" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
test "$ready" -eq 1 || die "the second large object never became visible"

node "$REL/expect.cjs" "$REL/out/expected-second-large.json" "$REL/out/expected-large.json" \
  "$SECOND_LARGE_FILE" "$SECOND_LARGE_SIZE" "$SECOND_LARGE_SHA" http-range plain >/dev/null

# ITS OWN WINDOW, drawn around this scan alone. Everything already in the library has been scanned and
# analysed, and the repeat scan earlier demonstrated that costs the provider nothing -- so the delta is this
# object's.
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-before-second.json"
drive scan --state "$STATE" --expect-file "$REL/out/expected-second-large.json" \
  --out "$REL/out/items-second-large.json" --label second-large
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-after-second.json"

drive shape-window --before "$REL/out/counters-before-second.json" \
  --after "$REL/out/counters-after-second.json" --gate PXD-second-large-object

# ...and the first object's window, re-stated side by side so the two are read together rather than one being
# looked up in an older log.
drive shape-window --before "$REL/out/counters-before-large.json" \
  --after "$REL/out/counters-after-large.json" --gate PXD-first-large-object

echo
echo "############################################################################################"
echo "# DIAGNOSTIC ONLY. NO GATE PASSED. NOTHING HERE IS EVIDENCE FOR ANY ACCEPTANCE GATE."
echo "############################################################################################"
echo
echo "This run was started with PROJECTION_PLEX_GEOMETRY_DIAGNOSTIC=1. It stopped after measuring the"
echo "request shape of two large objects and did NOT run the ten seeks, the five-minute paced play, the"
echo "five-minute transcode, the generation swap, the SIGKILL recovery, the media-server restart, the"
echo "mid-scan publish, the source outage, the mutation refusal or the lease-secrecy checks."
echo
echo "  first  large object: $LARGE_SIZE bytes"
echo "  second large object: $SECOND_LARGE_SIZE bytes"
echo
echo "The two PXD-* shape records above are the measurement. NOTHING was scored against them: no ceiling,"
echo "no floor and no byte fraction was applied to the second object, and no acceptance record, run record"
echo "or three-run count is updated by this run."
echo
echo "Exiting ${GEOMETRY_EXIT_STATUS}, which is neither success nor the 77 that means skipped, so no caller"
echo "can read this as a gate that passed."
exit "$GEOMETRY_EXIT_STATUS"
fi

# ----------------------------------------------------------------------------------------------------------
step "a forced transcode, proved by decoding what came out"
# ----------------------------------------------------------------------------------------------------------
# The transcode is run against the SOAK source on purpose: it is remote, so it is the read pattern that
# generates non-sequential, multi-position reads through the HTTP Range source.
drive transcode --state "$STATE" --items "$REL/out/items-corpus-2.json" --key "$SOAK_FILE" \
  --out-segment "$REL/out/transcoded.ts" --max-segments 2

test -s "$WORK/out/transcoded.ts" || die "the transcode produced no output to decode"
OUT_CODEC="$(ffprobe_run -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 \
  /work/out/transcoded.ts | head -1 | tr -d " \r\n")"
OUT_FRAMES="$(ffprobe_run -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets \
  -of csv=p=0 /work/out/transcoded.ts | head -1 | tr -d " \r\n")"
echo "  the segment decodes as $OUT_CODEC, $OUT_FRAMES video packets"
drive transcode-verify --key "$SOAK_FILE" --codec "$OUT_CODEC" --packets "${OUT_FRAMES:-0}" \
  --source-codec "$SOURCE_CODEC"

# ----------------------------------------------------------------------------------------------------------
step "ten real media-time seeks, including backwards and beyond 90% of duration"
# ----------------------------------------------------------------------------------------------------------
# THIS IS NOT THE RANGED READ ABOVE, AND THE DIFFERENCE IS THE GATE. A ranged GET proves the daemon serves
# byte offset N. G9 asks whether SECOND N of the media can be reached, which is a question only the media
# server can answer: it demuxes, finds the position, and starts an encode there.
#
# THE POSITION IS THE SERVER'S OWN, MEASURED. Each seek asks for the segment the position falls inside, and
# the position credited to that segment is the running sum of the playlist's own `#EXTINF` values — the
# server stating where the segment begins. A gate that computed `index * 8` would be asserting a property of
# one build's segmenter.
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-before-seeks.json"
daemon_counters "$WORK/out/daemon-before-seeks.json"
drive media-seeks --state "$STATE" --items "$REL/out/items-corpus-2.json" --key "$SOAK_FILE" \
  --duration-seconds "$SOAK_DURATION_INT" --segment-dir "$REL/out/seek-segments" \
  --out "$REL/out/seeks.json"
daemon_counters "$WORK/out/daemon-after-seeks.json"
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-after-seeks.json"

# EVERY SEEK'S SEGMENT DECODED, BY A DECODER THAT IS NOT PLEX, OUTSIDE THE PROCESS THAT FETCHED IT. The
# fourth field is the decoded picture's own START TIMESTAMP, and it is the temporal evidence: it must move
# one second per second of media asked for, across all ten positions. A server that ignored the positions and
# returned the same segment ten times produces ten identical timestamps and fails that — while passing every
# per-seek check it is possible to write.
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
docker run "${DECODER_RUN_FLAGS[@]}" --entrypoint /bin/sh -v "$WORK:/work" "$DECODER_IMAGE" \
  /work/out/probe-seeks.sh "$DECODER_FFPROBE"
node "$REL/seekprobes.cjs" "$REL/out/seek-probes.txt" "$REL/out/seek-probes.json" >/dev/null
drive seek-verify --key "$SOAK_FILE" --seeks "$REL/out/seeks.json" --probes "$REL/out/seek-probes.json"

# THE DENOMINATOR IS A SEEK'S BLOCK GEOMETRY, NOT THE OBJECT. Every seek on Plex restarts the encoder at the
# new position and a restart is an open: at most three 4 MiB demand blocks, plus one session-setup allowance.
# Two earlier spellings were wrong in the same way -- "six times the object over the window" and then "1.2x
# the object per seek" -- because both scaled with the fixture: on an 8.6 MB object either sits a hair above
# the arithmetic floor of ten 4 MiB reads, and on a large one either would mean nothing. Measured against the
# derived ceiling of 128,974,848: 54,485,469.
drive traffic-window --before "$REL/out/counters-before-seeks.json" \
  --after "$REL/out/counters-after-seeks.json" --gate PX19-seek-traffic \
  --object-bytes "$SOAK_SIZE" --events 10 --seek-ceiling true --max-range-requests 400 \
  --daemon-before "$REL/out/daemon-before-seeks.json" --daemon-after "$REL/out/daemon-after-seeks.json"

# ----------------------------------------------------------------------------------------------------------
step "direct play, PACED, for five minutes"
# ----------------------------------------------------------------------------------------------------------
# WHAT THIS DOES THAT THE `play` PHASE ABOVE CANNOT. That one drains the whole response and digests it in a
# second or two, which proves the BYTES are right. Nothing about it can support "starts within 10 s and runs
# 5 minutes without a stall", and the obvious way to make it take five minutes — add a sleep — produces a
# phase that takes five minutes and measures a download.
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-before-play.json"
daemon_counters "$WORK/out/daemon-before-play.json"
drive paced-play --state "$STATE" --items "$REL/out/items-corpus-2.json" --key "$SOAK_FILE" \
  --image "$DECODER_IMAGE" --ffmpeg "$DECODER_FFMPEG" --network "$NETWORK" \
  --container-name "$PLAY_CONTAINER" --work-dir "$WORK" \
  --stream-base "http://${PLEX_IP}:32400" --output-rel "out/paced-play.mp4" \
  --trace "$REL/out/paced-play-trace.json" --seconds 300
daemon_counters "$WORK/out/daemon-after-play.json"
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-after-play.json"

# THE CONSUMER'S OWN OUTPUT, DECODED. Five minutes of progress records is evidence that a decoder was
# running; five minutes of decodable video in the file it wrote is evidence that what it was decoding was
# video.
test -s "$WORK/out/paced-play.mp4" || die "the paced consumer wrote no output to decode"
PLAY_OUT_SECONDS="$(ffprobe_run -v error -show_entries format=duration -of csv=p=0 /work/out/paced-play.mp4 \
  | head -1 | tr -d " \r\n")"
PLAY_OUT_PACKETS="$(ffprobe_run -v error -select_streams v:0 -count_packets \
  -show_entries stream=nb_read_packets -of csv=p=0 /work/out/paced-play.mp4 | head -1 | tr -d " \r\n")"
drive paced-play-output --probed-seconds "${PLAY_OUT_SECONDS%%.*}" --probed-packets "${PLAY_OUT_PACKETS:-0}" \
  --seconds 300

drive traffic-window --before "$REL/out/counters-before-play.json" \
  --after "$REL/out/counters-after-play.json" --gate PX18-paced-play-traffic \
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
# WHAT THIS STEP CLAIMS: five minutes of PACED, CONTINUOUSLY DECODED, TRANSCODED PLAYBACK — and, on this
# server and unlike on Jellyfin, a bounded claim about the ENCODER as well.
#
# THE DIFFERENCE IS MEASURED, NOT ASSUMED. Jellyfin's encoder finishes a 340-second, 320x240, 150 kbit/s
# source in about 1.6 seconds and exits, so the Jellyfin gate records encoder lifetime and asserts nothing
# about it. Plex throttles against the client's consumption — `TranscoderThrottleBuffer` defaults to sixty
# seconds — so its job stays incomplete and keeps producing new output across a paced window. The gate
# asserts that: distinct moments at which the encoder had produced NEW output, the wall span between the
# first and the last of them, and at least one sample in which the server said the encoder was throttled.
# Every floor sits well below what was measured, because a threshold pinned to an observed value fails on a
# loaded machine. The rest of the server's bookkeeping is recorded and asserted on by nothing.
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-before-soak.json"
daemon_counters "$WORK/out/daemon-before-soak.json"
drive transcode-soak --state "$STATE" --items "$REL/out/items-corpus-2.json" --key "$SOAK_FILE" \
  --segment-dir "$REL/out/soak-segments" --out "$REL/out/soak.json" --seconds 300
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
docker run "${DECODER_RUN_FLAGS[@]}" --entrypoint /bin/sh -v "$WORK:/work" "$DECODER_IMAGE" \
  /work/out/probe-soak.sh "$DECODER_FFPROBE"
node "$REL/probes.cjs" "$REL/out/soak-probes.txt" "$REL/out/soak-probes.json" >/dev/null
drive transcode-soak-verify --key "$SOAK_FILE" --items "$REL/out/items-corpus-2.json" \
  --soak "$REL/out/soak.json" --probes "$REL/out/soak-probes.json" \
  --producer-dir "$REL/plex-transcode" --seconds 300

drive traffic-window --before "$REL/out/counters-before-soak.json" \
  --after "$REL/out/counters-after-soak.json" --gate PX20-transcode-soak-traffic \
  --object-bytes "$SOAK_SIZE" --max-object-multiplier 4 --max-range-requests 600 \
  --daemon-before "$REL/out/daemon-before-soak.json" --daemon-after "$REL/out/daemon-after-soak.json"

# THE TRANSCODING JOB IS GONE. A five-minute encode left running would occupy the machine for the rest of the
# gate, and every later measurement would be taken against a host under load.
docker exec "$PLEX_CONTAINER" sh -c 'rm -rf /transcode/* 2>/dev/null || true'
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

node "$REL/expect.cjs" "$REL/out/expected-2.json" "$REL/out/expected-large.json" \
  "$THIRD_FILE" "$THIRD_SIZE" "$THIRD_SHA" local anchor >/dev/null

drive scan --state "$STATE" --expect-file "$REL/out/expected-2.json" --out "$REL/out/items-2.json" --label scan2
drive compare --before "$REL/out/items-large.json" --after "$REL/out/items-2.json" \
  --gate PX10-successor --expect-added 1

# ----------------------------------------------------------------------------------------------------------
step "SIGKILL the daemon during playback, then the real recovery path"
# ----------------------------------------------------------------------------------------------------------
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
# NOTHING IS UNMOUNTED HERE, AND THE REAL HOST IS WHY.
#
# There used to be a `umount -l` at this point, "so a stale mount does not go on answering". It never did
# anything: it ran inside a container whose bind of the gate root carried Docker's default `rprivate`, so
# the unmount happened in a namespace that was discarded immediately. On Docker Desktop that was invisible.
#
# MAKING IT WORK BROKE THE GATE, WHICH IS THE FINDING. Routed through the propagating helper it genuinely
# detached the mount — and the MEDIA SERVER IS STILL RUNNING at this point, holding `$WORK/mnt` as an
# `rslave` bind. A lazy unmount of the master detaches the slave copy too, and the media server can never
# get it back: the run failed at the very next assertion with "the media server's own mount cannot be
# READ". The dead mount is not what breaks recovery; removing it is.
#
# WHAT ACTUALLY MAKES RECOVERY WORK is that the restarted daemon mounts again at the same path and the new
# mount STACKS over the dead one, so the media server's slave view resolves to the live namespace. That is
# also what a real operator restart looks like, and this gate exists to measure that rather than to tidy
# up before measuring it.
#
# THE STALE MOUNT IS NOT LEAKED, IT IS DEFERRED. Cleanup removes the media server FIRST and only then walks
# every mountpoint under the run root, stacked ones included, and verifies the count reached zero.
#
# AND THE ASSERTION THIS COMMENT USED TO JUSTIFY IS STILL MADE, harder: the gate reads real bytes back
# through the media server's own mount after the remount, so a dead namespace fails here whatever is or is
# not mounted underneath it.

echo "  restarting and remounting through the ordinary daemon start"
start_daemon
await_namespace || { docker logs "$MOUNT_CONTAINER" 2>&1 | tail -30 >&2; die "the daemon did not remount"; }

# THE MEDIA SERVER'S OWN VIEW OF THE REMOUNT, FROM INSIDE ITS OWN CONTAINER, BEFORE ANY CHURN IS ASSERTED.
#
# A container started BEFORE a daemon restart can be left holding a dead FUSE mount whose `stat` still
# answers and whose `open` returns ENOTCONN. A library scan across that reports ZERO REMOVALS — because
# declining to delete a library whose root has gone unreadable is correct scanner behaviour — so every churn
# assertion below would have passed on a mount nothing could read. `await_namespace` cannot see it either: it
# uses a FRESH container, which picks up the new mount correctly. So the read is done as the media server,
# through the mount it actually holds, and it reads BYTES rather than metadata.
docker exec --user 1000:1000 "$PLEX_CONTAINER" \
  sh -c "head -c 65536 '/media/projection/$REMOTE_PATH' > /dev/null" \
  || { docker logs "$MOUNT_CONTAINER" 2>&1 | tail -30 >&2
       die "after the remount the media server's own mount cannot be READ, so every churn assertion that follows would be about a dead mount"; }
echo "  the media server can still read bytes through its own mount after the remount"

# A TRANSIENT OUTAGE IS NOT A DELETION. The sequence is compared against WHAT IT WAS BEFORE THE KILL rather
# than against a literal, because a constant that encodes how many times something earlier in the script
# happened is a constant that will be wrong the next time somebody adds a step.
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

drive resume --state "$STATE" --items "$REL/out/items-2.json" --key "$REMOTE_FILE" \
  --expect-file "$REL/out/expected-2.json"

drive scan --state "$STATE" --expect-file "$REL/out/expected-2.json" --out "$REL/out/items-3.json" --label scan3
drive compare --before "$REL/out/items-2.json" --after "$REL/out/items-3.json" --gate PX11-recovery

# ----------------------------------------------------------------------------------------------------------
step "restarting the media server, and re-scanning twice more"
# ----------------------------------------------------------------------------------------------------------
docker restart -t 30 "$PLEX_CONTAINER" >/dev/null
# THE SAME INSTALLATION, COMING BACK. What this proves is that the library, its rating keys and the projected
# paths the server persisted all survived the restart. A media server that had stored a path it could not
# resolve again, or that re-created its items, fails the comparison below rather than this line.
drive bootstrap --base "$PLEX_BASE" --state "$STATE" --name "Projection Movies"

# THE RESTART SCAN COSTS PROVIDER TRAFFIC, AND IT USED TO BE THE ONE SCAN NOBODY BUDGETED.
#
# THE GAP THIS CLOSES. The gate measured churn across a media-server restart and measured the WARM repeat
# scan at zero provider bytes -- and drew a counter window around neither the restart scan itself. Measured
# in a real run: provider bytes went from 141,687,710 to 179,612,586 across the restart and scan4, so a
# restarted Plex re-fetched **+37,924,876 bytes over +14 ranged requests**, re-reading almost the whole
# first-scan pattern. The immediately following scan5 then cost zero. Letting only the warm scan carry the
# zero-refetch claim would have been the strongest-sounding half of a two-part measurement with the
# expensive half unmeasured.
#
# ITS CEILING IS A COLD SCAN'S AND IT HAS NO FLOOR, because this window can legitimately be either.
#
# A LATER RUN MEASURED THE SAME WINDOW AT ZERO. The daemon's persistent probe cache served everything the
# restarted Plex re-read, which is what that cache is for. So both outcomes are correct: a restart may
# re-analyse and pay a cold scan's cost, or it may be served entirely from cache and pay nothing. A floor
# here would fail the good outcome -- and would contradict PX14, which asserts zero for a warm re-scan --
# so `--warm-capable true` drops the floors for this window and keeps every ceiling. What is still refused
# is a restart costing MORE than a first scan, and the churn and library assertions are untouched.
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-before-restart-scan.json"
drive scan --state "$STATE" --expect-file "$REL/out/expected-2.json" \
  --out "$REL/out/items-4.json" --label scan4
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-after-restart-scan.json"
drive compare --before "$REL/out/items-3.json" --after "$REL/out/items-4.json" --gate PX12-server-restart
drive budget --before "$REL/out/counters-before-restart-scan.json" \
  --after "$REL/out/counters-after-restart-scan.json" \
  --gate PX12b-restart-scan --entries "$(( CORPUS_REMOTE_ENTRIES + 3 ))" \
  --object-sizes "$CORPUS_SIZE_LIST" --warm-capable true

# A RE-SCAN OVER AN UNCHANGED GENERATION MUST COST THE PROVIDER NOTHING IT HAS NOT ALREADY PAID. The window
# is drawn tightly around the re-scan alone, because everything else in this run — a full direct play, a
# transcode — legitimately fetches bytes.
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-before-rescan.json"
drive scan --state "$STATE" --expect-file "$REL/out/expected-2.json" \
  --out "$REL/out/items-5.json" --label scan5
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-after-rescan.json"
drive compare --before "$REL/out/items-4.json" --after "$REL/out/items-5.json" --gate PX13-rescan-churn
drive budget --before "$REL/out/counters-before-rescan.json" --after "$REL/out/counters-after-rescan.json" \
  --gate PX14-rescan --entries 1 --windows 0

# THE WHOLE-RUN PROVIDER INVARIANTS ARE TAKEN HERE, and here rather than at the very end, because the
# source-outage step below stops and restarts the endpoint process, which resets its counters.
drive counters --url "http://127.0.0.1:${RANGE_PORT}/counters" --out "$REL/out/counters-final.json"
drive provider-invariants --counters "$REL/out/counters-final.json" --gate PX15-provider

# ----------------------------------------------------------------------------------------------------------
step "a generation admitted WHILE A SCAN IS RUNNING"
# ----------------------------------------------------------------------------------------------------------
# The successor test above swapped a generation under an open PLAYBACK. This one swaps it under an open SCAN,
# which is a different hazard: the scanner is walking the namespace, and the namespace changes beneath it.
#
# WHAT IS ASSERTED IS NOT WHAT THE RACED SCAN SAW. It may legitimately have seen the predecessor, the
# successor, or a mixture. What must hold is that nothing half-formed appears, and that the NEXT scan
# converges with zero removals and zero item-id churn for everything carried across.
#
# MAKING THE SCAN DETERMINISTICALLY LONG IS WHAT MAKES THIS EVIDENCE. Timing it is a coin flip, and a coin
# flip with a retry loop around it is still not evidence. So the scan is made to BLOCK on something this gate
# controls: a brand-new REMOTE entry whose probe windows are not in the daemon's cache, served by an endpoint
# that is told to hold the read.
FOURTH_FILE="Projection Local Four (2026).mp4"
encode "media/$FOURTH_FILE" 10 testsrc 990 faststart
FOURTH_SIZE="$(wc -c < "$WORK/media/$FOURTH_FILE" | tr -d ' ')"
FOURTH_SHA="$(node "$REL/sha.cjs" "$REL/media/$FOURTH_FILE")"

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

# NOW the successor's rows, so that the only thing the mid-scan publish can add is this one entry.
# Registering is a database write and publishes nothing; the generation is minted by `publish` alone.
register version --key local-four --size "$FOURTH_SIZE" --mtime 2026-06-01T10:00:00.000Z
register entry --item "$FOURTH_ITEM" --version-key local-four \
  --path "Movies/Projection Local Four (2026)/$FOURTH_FILE" --source "local:media:$FOURTH_FILE"

node "$REL/ctl.cjs" "http://127.0.0.1:${RANGE_PORT}/control/hold/${MIDSCAN_REF}" \
  || die "the endpoint would not accept the hold"
echo "  the endpoint is holding reads of the new remote entry"

HOLD_BEFORE="$(node "$REL/counters.cjs" "http://127.0.0.1:${RANGE_PORT}/counters" heldRequests)"
HOLD_TIMEOUTS_BEFORE="$(node "$REL/counters.cjs" "http://127.0.0.1:${RANGE_PORT}/counters" holdTimeouts)"

node "$REL/expect.cjs" "$REL/out/expected-midscan.json" "$REL/out/expected-2.json" \
  "$MIDSCAN_FILE" "$MIDSCAN_SIZE" "$MIDSCAN_SHA" http-range anchor >/dev/null

rm -f "$WORK/out/scan-running"
drive scan --state "$STATE" --expect-file "$REL/out/expected-midscan.json" \
  --out "$REL/out/items-6.json" --label scan6 --tolerant true \
  --running-marker "$REL/out/scan-running" &
SCAN_PID=$!

release_hold() {
  node "$REL/ctl.cjs" "http://127.0.0.1:${RANGE_PORT}/control/release/${MIDSCAN_REF}" >/dev/null 2>&1 || true
}
held_now() { node "$REL/counters.cjs" "http://127.0.0.1:${RANGE_PORT}/counters" currentHeldWaiters; }
hold_timeouts() { node "$REL/counters.cjs" "http://127.0.0.1:${RANGE_PORT}/counters" holdTimeouts; }

# WAIT FOR AN OBSERVED RUNNING SCAN, NOT FOR A SLEEP. The marker is written by the scanning process at the
# moment the scanner is seen in flight, and only for a genuinely in-flight sample: a scan that starts and
# finishes between two polls is a valid COMPLETION and is not an in-flight observation.
running=0
for _ in $(seq 1 600); do
  if [ -f "$WORK/out/scan-running" ]; then running=1; break; fi
  if ! kill -0 "$SCAN_PID" 2>/dev/null; then break; fi
  sleep 0.2
done
if [ "$running" -ne 1 ]; then
  release_hold; wait "$SCAN_PID" || true
  die "the scanner was never observed running, so a mid-scan publish could not be performed"
fi

# A REQUEST MUST BE BLOCKED RIGHT NOW, NOT MERELY HAVE BEEN BLOCKED ONCE. The lifetime `heldRequests` counter
# stays up after a hold's bound fires and the request proceeds, so it cannot answer the live question.
# `currentHeldWaiters` can, and this waits for it to RISE before anything is claimed.
waiter=0
for _ in $(seq 1 240); do
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

HOLD_AFTER="$(node "$REL/counters.cjs" "http://127.0.0.1:${RANGE_PORT}/counters" heldRequests)"
test "$(( HOLD_AFTER - HOLD_BEFORE ))" -ge 1 \
  || die "no provider request was ever held, so the scan was not deterministically blocked and the mid-scan window was luck"
echo "  $(( HOLD_AFTER - HOLD_BEFORE )) provider request(s) entered the hold; one was still blocked across the publish"
echo "  a generation was admitted while the scanner was provably walking the namespace"

node "$REL/expect.cjs" "$REL/out/expected-3.json" "$REL/out/expected-midscan.json" \
  "$FOURTH_FILE" "$FOURTH_SIZE" "$FOURTH_SHA" local anchor >/dev/null

# THE CONVERGENCE ASSERTION, which is the one that matters, reached with the hold released and the scan
# finished. TWO ADDITIONS, NOT ONE, AND BOTH ARE ACCOUNTED FOR: the holdable remote entry was published
# BEFORE the raced scan so that its probe would be uncached and holdable; the successor was published DURING
# it, and the mid-scan publish is separately asserted above to have added exactly one.
drive scan --state "$STATE" --expect-file "$REL/out/expected-3.json" \
  --out "$REL/out/items-7.json" --label scan7
drive compare --before "$REL/out/items-5.json" --after "$REL/out/items-7.json" \
  --gate PX16-midscan-swap --expect-added 2

# ----------------------------------------------------------------------------------------------------------
step "a source outage is not a deletion, and does not shrink a published generation"
# ----------------------------------------------------------------------------------------------------------
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
       sh /probe/alive.sh "http://fakerange:8099/counters" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
test "$ready" -eq 1 || die "the provider never came back"
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
# spelling the Windows docker binary cannot resolve, unlike the `-v` sources Docker Desktop normalises.
docker exec -i --user 1000:1000 "$PLEX_CONTAINER" sh -s "$LOCAL_PATH" < "$WORK/out/mutate.sh"

# ----------------------------------------------------------------------------------------------------------
step "no PROVIDER access lease reached the manifest, the probe cache or the media server's library state"
# ----------------------------------------------------------------------------------------------------------
# WHAT THIS STEP CLAIMS, AND WHAT IT DOES NOT.
#
# THE CLAIM IS ABOUT PROVIDER ACCESS MATERIAL. During this run the daemon really did resolve a stable
# objectRef into short-lived access material — a URL containing a lease id, a header carrying it, and an
# expiry — because the endpoint is configured in resolver mode. Phase 0 §7.6 says that material lives in the
# daemon's memory for the length of one read and nowhere else. This step is the check on that.
#
# THE CLAIM IS NOT "NO CREDENTIAL EXISTS ANYWHERE ON DISK". Plex persists its own device records and its own
# server identity — it has to, or it could not survive the restart this gate performs. Those are Plex's own,
# they are not provider access material, and they are not searched for. What IS separately asserted is that
# no plex.tv sign-in happened: `PlexOnlineToken` and `PlexOnlineMail` must be absent from its preferences.
cat > "$WORK/out/leakcheck.sh" <<'LEAK'
# THE SEARCH BEHIND "NO PROVIDER ACCESS MATERIAL REACHED DISK", AND THE THREE WAYS IT PROVED NOTHING.
#
# Each was found by RUNNING this program in the gate's own digest-pinned image against fixtures, not by
# reading it:
#
#   - IT DISCARDED grep's ERRORS AND ITS EXIT STATUS ALIKE. `grep -rlF "$pattern" /scan 2>/dev/null` sends a
#     scan root that does not exist and a file that cannot be opened down the same path as a clean miss: no
#     output, so no leak, so exit 0. Measured in the pinned image: a secret sitting in plain text in a
#     mode-000 file was reported ABSENT, and a /scan that did not exist was reported CLEAN. busybox grep
#     exits 2 and writes a diagnostic for both, so both are now hard failures. A zero that means "did not
#     look" is indistinguishable from one that means "did not leak", and this is the ONLY measurement
#     standing behind the claim.
#   - THE NEEDLE ARRIVED IN ARGV. Every call site passed the secret as a `docker run` argument, so it lived
#     in the host's process table and in `docker inspect .Config.Cmd` for the life of the container --
#     measured, verbatim -- while the rclone gate's own comment says its token "is in no argv, no container
#     inspect output and no shell history". The needles now arrive as a FILE PATH, which is the idiom the
#     register path was already corrected to.
#   - THE FAILURE PATH PRINTED THE SECRET AND THE FILES IT WAS FOUND IN. Section 7 of the acceptance plan
#     allows counts, digests and gate ids and nothing else. A hit now names the needle by its INDEX in the
#     list; no needle and no path under the scan root is ever printed.
#
# WHAT IS REPORTED RATHER THAN REQUIRED, so that what is required can be trusted. The examined-file count is
# printed for every scan and is REQUIRED only at the minimum the caller passes. A mount client entitled to
# write nothing into its own cache directory must not fail a check about a leak that could not have happened,
# and inventing a floor there would be fitting a threshold to an expectation.
set -eu
label="$1"
needles="$2"
minimum="${3:-1}"
# THE ROOT IS AN ARGUMENT WITH THE CONTAINER PATH AS ITS DEFAULT, so the offline suite can run these exact
# bytes against a temporary directory. A program only a container can execute is a program only a container
# has ever executed, which is how this one kept three defects nobody could see.
root="${4:-/scan}"

refuse() { echo "leakcheck: $label: $1" >&2; exit 3; }

test -d "$root" \
  || refuse "the scan root is not a directory, so a clean result would mean the search never ran"
test -s "$needles" \
  || refuse "the needle list is missing or empty, so a clean result would mean nothing was searched for"

# THE SCRATCH IS ITS OWN REFUSAL. Every diagnostic below is read out of a file, so a scratch directory
# that could not be created would silently turn each of them into an empty file -- which is the shape of
# "clean". It is created first and its failure ends the run.
work="$(mktemp -d)" || refuse "no scratch directory could be created, so no diagnostic could be read back"
trap 'rm -rf "$work"' EXIT

# A ROOT THE WALKER CANNOT ENUMERATE IS NOT AN EMPTY ROOT.
if ! find "$root" -type f > "$work/files" 2> "$work/walk"; then
  refuse "the scan root could not be walked"
fi
test ! -s "$work/walk" || refuse "the scan root could not be walked completely"
examined="$(wc -l < "$work/files" | tr -d ' ')"
test "$examined" -ge "$minimum" \
  || refuse "$examined file(s) under the scan root against a required $minimum; a clean result proves nothing"

# A NEEDLE LIST THAT DOES NOT END IN A NEWLINE IS REFUSED, AND THIS ONE ALMOST SHIPPED.
#
# `wc -l` counts TERMINATORS and `read` drops an unterminated final record, so a nonempty one-line needle
# file with no trailing newline counts ZERO needles, runs ZERO searches, and then agrees with itself at
# zero: 0 needles read of 0 expected, 0 hits, exit 0. Measured against the same secret in the same tree
# that the terminated list finds it in — "1 file(s) examined for 0 needle(s), 0 hit(s)", clean. A malformed
# needle list is exactly what a caller gets wrong, and it produced the friendliest possible answer.
#
# Command substitution strips trailing newlines, so an empty last byte IS the terminator.
test -z "$(tail -c 1 "$needles")" \
  || refuse "the needle list does not end in a newline, so its last needle is dropped by every reader"
total="$(wc -l < "$needles" | tr -d ' ')"
test "$total" -ge 1 \
  || refuse "the needle list holds no complete needle, so a clean result would mean nothing was searched"
index=0
hits=0
while IFS= read -r pattern; do
  index=$(( index + 1 ))
  test -n "$pattern" || refuse "needle $index of $total is empty, and an empty needle matches every file"
  status=0
  grep -rlF -e "$pattern" "$root" > "$work/hit" 2> "$work/err" || status=$?
  # 0 IS A MATCH, 1 IS A CLEAN MISS, AND ANYTHING ELSE IS A SEARCH THAT DID NOT COMPLETE.
  if [ "$status" -ge 2 ] || [ -s "$work/err" ]; then
    refuse "needle $index of $total could not be searched for across the whole root"
  fi
  if [ "$status" -eq 0 ]; then
    hits=$(( hits + 1 ))
    echo "LEAK: needle $index of $total appears under $label" >&2
  fi
done < "$needles"
test "$index" -eq "$total" \
  || refuse "read $index of $total needles, so the list was not searched in full"

echo "  $label: $examined file(s) examined for $total needle(s), $hits hit(s)"
test "$hits" -eq 0
LEAK

# THE NEEDLES ARRIVE AS A FILE, AND THAT IS THE WHOLE OF WHY THIS BLOCK EXISTS. Passing them to `docker run`
# put every one of them -- including the per-run lease secret the searches below are FOR -- into the host's
# process table and into `docker inspect .Config.Cmd`, which is measurably not "nowhere". A path in argv is
# the idiom this repository already corrected the register path to.
#
# THE MODE IS 0644 FOR THE REASON SECTION 6.0 RECORDS: a file the consuming container's uid cannot read is a
# defect Docker Desktop cannot show you, and these are per-run synthetic markers in a directory the run
# deletes. What changes is not the file's reach but the secret's: it is out of argv.
printf '%s\n' "$LEASE_MARKER" "fakerange" "://" "X-Fake-Lease" "expiresAtUnixMs" "Authorization:" "Bearer " \
  > "$WORK/out/leak-needles-manifest.txt"
printf '%s\n' "$LEASE_MARKER" "fakerange" "http://" "https://" "X-Fake-Lease" "expiresAtUnixMs" \
  "Authorization:" "Bearer " > "$WORK/out/leak-needles-cache.txt"
printf '%s\n' "$LEASE_MARKER" "fakerange" "X-Fake-Lease" "expiresAtUnixMs" \
  > "$WORK/out/leak-needles-library.txt"
chmod 644 "$WORK/out/leak-needles-manifest.txt" "$WORK/out/leak-needles-cache.txt" \
  "$WORK/out/leak-needles-library.txt"
# AND THE MINTED MARKER MUST BE LONG ENOUGH TO BE DECISIVE. A short needle occurs by chance and turns a
# search for the secret into a search for noise; the same rule `scan.cjs` is held to, asserted here because
# this is where the value is chosen.
test "${#LEASE_MARKER}" -ge 8 \
  || die "the lease marker is under 8 bytes, so a search for it could not be decisive"

# THE MANIFEST DIRECTORY IS TEXT the control plane authored, so a bare `://` there is conclusive.
docker run --rm -v "$WORK/manifest:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
  sh /out/leakcheck.sh "the published manifest directory" /out/leak-needles-manifest.txt \
  || die "the manifest directory holds provider access material"

# THE PROBE CACHE IS MEDIA BYTES, and `://` is not a usable signal against it — a cached probe window is a
# verbatim megabyte of compressed video, and a three-byte sequence occurs in it by chance. So the cache is
# searched for the things that could only have got there from a leak, and FIRST AMONG THEM the actual lease
# secret minted for this run: 16 random bytes as hex behind a fixed prefix, which cannot occur by accident.
docker run --rm -v "$WORK/cache:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
  sh /out/leakcheck.sh "the daemon probe cache" /out/leak-needles-cache.txt \
  || die "the probe cache holds provider access material"

# ...AND THE CACHE IS NOT A COPY OF THE LIBRARY. If a read path ever started writing whole objects through
# it, no substring check would notice — but the size would. The ceiling is computed from the corpus that was
# actually published, not written down.
CACHE_BYTES="$(docker run --rm -v "$WORK/cache:/scan:ro" "$VERIFY_IMAGE" \
  sh -c 'du -sb /scan 2>/dev/null | cut -f1' | tr -d " \r\n")"
CACHE_CEILING="$(node "$REL/cacheceiling.cjs" "$REL/out/expected-3.json")"
PUBLISHED_BYTES="$(node "$REL/published.cjs" "$REL/out/expected-3.json")"
echo "  the probe cache holds $CACHE_BYTES bytes against $PUBLISHED_BYTES bytes published"
test "${CACHE_BYTES:-0}" -le "$CACHE_CEILING" \
  || die "the probe cache holds $CACHE_BYTES bytes, which is more than a fixed window plan can account for"
test "${CACHE_BYTES:-0}" -lt "$PUBLISHED_BYTES" \
  || die "the probe cache is as large as the library it is caching windows of"

# THE MEDIA SERVER'S OWN LIBRARY STATE must hold the projected PATH and nothing about a provider.
docker run --rm -v "$WORK/plex-config:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
  sh /out/leakcheck.sh "the media server's library state" /out/leak-needles-library.txt \
  || die "the media server persisted provider access material"
echo "  the media server's library state names no provider endpoint and holds no lease"

# AND NO PLEX ACCOUNT WAS EVER SIGNED IN. An unclaimed server writes no `PlexOnlineToken`; a claimed one does.
PLEX_PREFS="$WORK/plex-config/Library/Application Support/Plex Media Server/Preferences.xml"
test -f "$PLEX_PREFS" || die "the media server wrote no preferences file, so the unclaimed check has no subject"
if grep -q "PlexOnlineToken" "$PLEX_PREFS"; then
  die "the media server holds a plex.tv token, so it was claimed and this run is not credential-free"
fi
if grep -q 'PlexOnlineMail="[^"]' "$PLEX_PREFS"; then
  die "the media server holds a plex.tv account address"
fi
echo "  the media server's preferences hold no plex.tv token and no account address"

# AND THE LEASE REALLY EXISTED, or every search above was a search for nothing.
RESOLUTIONS="$(field resolutions < "$WORK/out/counters-final.json")"
test "${RESOLUTIONS:-0}" -ge 1 \
  || die "the endpoint served no access resolution, so the leak check searched for a secret that never existed"
echo "  $RESOLUTIONS access lease(s) were minted during this run, so the searches above had a subject"

echo "  NOTE: this harness persists no media-server credential -- an unclaimed Plex needs none. Plex persists"
echo "        its own device and server-identity records, which it must in order to survive the restart this"
echo "        gate performs. Neither is provider access material."

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
npx tsx src/ops/projection-plex-dataplane-cli.ts report --results "$REL/out/results.json"

echo
echo "PLEX data-plane gate PASSED. Exactly what was proved:"
echo "  - a real, digest-pinned Plex Media Server, started UNCLAIMED with no Plex account and no claim token,"
echo "    running NON-ROOT, with the FUSE mount bind-propagated in as a library root whose agent is Plex's own"
echo "    personal-media agent -- so no item identity in this run depends on plex.tv's catalogue."
echo "  - legal synthetic media generated on this machine. Nothing downloaded, nothing copyrighted, no fixture"
echo "    committed. The DECODER that judges every playability claim is not Plex: the Plex image ships no"
echo "    ffprobe at all, so the decoding is done by an unrelated pinned image."
echo "  - a real library scan of a ~50-ENTRY CORPUS in which every published identity was catalogued at the"
echo "    size the control plane published, with Plex's OWN LIVE accessible/exists answer through the mount"
echo "    rather than a field its scanner cached at import time -- zero missing, zero duplicated, zero"
echo "    unexpected -- and zero churn of any kind across a repeat scan, a media-server restart and the"
echo "    daemon SIGKILL/restart/remount path, which is followed by a byte-for-byte read from inside the"
echo "    media server's own container so it cannot pass on a dead mount."
echo "  - FIVE MINUTES OF PACED DIRECT PLAY: a real decoder consuming at the media's own frame rate, with"
echo "    startup, decoded MEDIA time, the media-seconds-per-wall-second ratio and the longest stall each"
echo "    asserted separately -- so neither a fast download followed by a sleep, nor a sleep that decoded"
echo "    nothing, nor a play that froze in the middle can pass."
echo "  - TEN MEDIA-TIME SEEKS through the server's own playlist, including backward transitions and two"
echo "    positions beyond 90% of duration, each returning decodable h264 inside ten seconds -- and, because"
echo "    every one of those passes against the same segment served ten times: ten DISTINCT segments,"
echo "    positions taken from the server's own #EXTINF arithmetic rather than from a segment length this"
echo "    gate assumed, and decoded timestamps tracking those positions with a constant measured offset."
echo "  - FIVE MINUTES OF PACED, CONTINUOUSLY DECODED, TRANSCODED PLAYBACK: an mpeg4 source, every consumed"
echo "    segment decoded as h264 by a decoder that is not Plex, no adjacent arrival gap over 20s, a quarter"
echo "    of the media decoded in the LAST THIRD of the window, and all segments distinct."
echo "    AND, UNLIKE THE JELLYFIN GATE, A BOUNDED ENCODER CLAIM -- because Plex throttles its encoder against"
echo "    the client's pace instead of racing to the end and exiting. The advances in the server's own"
echo "    produced-output offset, the wall span between the first and last of them, and the presence of"
echo "    throttling are asserted; every other number the server reports is recorded and asserted by nothing."
echo "  - a generation admitted while ONE HELD-OPEN RESPONSE BODY was mid-delivery -- partially consumed, not"
echo "    drained -- which then completed from the SAME response with the whole file's digest, and with a"
echo "    measured share of its bytes arriving AFTER the successor was admitted."
echo "  - a generation admitted while the scanner was OBSERVED IN FLIGHT, made deterministic by holding a"
echo "    provider read rather than by racing a sleep, with both edges of the window observed."
echo "  - a SIGKILL of the daemon mid-stream followed by the ordinary restart-and-remount. The held-open"
echo "    stream is permitted to fail there and is recorded as INTERRUPTED, which is not open-handle evidence;"
echo "    resumability is asserted separately, by a new request."
echo "  - every mutation from the media server's own non-root container refused BY THE DAEMON, against a"
echo "    mount deliberately not bound read-only."
echo "  - a real PROVIDER access lease was minted during the run, and its per-run secret marker appears in"
echo "    NONE of the manifest directory, the probe cache or the media server's library state; and the"
echo "    media server's preferences hold no plex.tv token and no account address."
echo
echo "WHAT THIS GATE DOES NOT PROVE. A Docker Desktop pass is NOT Linux/Unraid closure and SHALL NOT be"
echo "reported as one. Emby, a real Unraid host and a real provider endpoint remain entirely unproved. This"
echo "run's media server sat on an ordinary bridge network -- not because Plex needs the internet, which was"
echo "measured and found NOT to be so, but because Docker Desktop cannot publish a port from an internal"
echo "network and the driver reaches the server through one; so scanning and playback on an air-gapped Plex"
echo "are NOT established here. The product's fraction-of-the-object scan argument is neither proved nor"
echo "disproved by the small fixtures: the ceiling for identifying one object is a 36,700,160-byte class"
echo "envelope, or the caps against a shorter object -- so on an 8.6 MB or 14.0 MB fixture it already"
echo "permits a whole-object read and satisfying it proves nothing about the fraction. That is a limit of the"
echo "instrument, not a lower bound. The claim is asserted here on ONE fixture above 94 MiB, where an"
echo "actual-byte measurement has margin, against the same 0.5 fraction Jellyfin is held to. On that object"
echo "the envelope is the tighter of the two bounds, so the 0.5 fraction is the headline but is not what"
echo "binds -- see the data-plane"
echo "document. The acceptance plan closes the tranche only on a Linux/Unraid run, on all three media"
echo "servers, three consecutive times."
