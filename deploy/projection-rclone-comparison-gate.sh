#!/usr/bin/env bash
# The RCLONE/WEBDAV COMPARISON CONTROL — G22.
#
# WHAT G22 SAYS, VERBATIM, IN `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §5:
#
#   "The same corpus behind an rclone/WebDAV mount, measured the same way. This is EVIDENCE, NOT ARCHITECTURE:
#    it exists to record what the naive approach costs. It has NO PASS THRESHOLD."
#
# THIS IS A CONTROL, NOT A CANDIDATE, AND IT IS THE FIRST THING TO SAY. `docs/ADR_002_PROJECTION_APPLIANCE.md`
# §2 rejected rclone over WebDAV as production architecture — a provider's URL space inside the media server's
# view, file identity that is a function of a remote path, and an outage that empties the mount, which a media
# server reads as a mass deletion — and kept it as a TEST CONTROL, in those words. Nothing measured here
# reopens that. A cheap number would not, and an expensive one is not what closed it. This gate does not
# replace `projectiond`, does not add a source adapter, does not add a frontend, and stands up neither a
# manifest nor a publisher nor a database, because the naive path has none of those and standing them up
# beside it would be measuring something nobody would ever deploy.
#
# WHAT IT ACTUALLY DOES:
#
#   ONE deterministic WebDAV endpoint serving THE SAME ~50-entry corpus the product's own gates publish,
#   generated here from the same synthetic signals; ONE read-only rclone mount of it with a FRESH cache; and
#   THREE REAL, DIGEST-PINNED MEDIA SERVERS — Plex, Jellyfin and Emby — each holding THE SAME mount directory
#   as its library root, all three scanning it AT THE SAME TIME.
#
#   WebDAV endpoint -> rclone mount -> ORDINARY read-only files -> three media servers.
#
# THE TWO KINDS OF CHECK IN THIS FILE, AND CONFUSING THEM WOULD DESTROY THE POINT OF IT:
#
#   FAILS CLOSED — the mount works, the corpus is exactly the corpus, all three servers use the SAME mount and
#     really scan and really overlap, the telemetry is coherent, monotonic and fully attributed, the window is
#     COLD, no credential leaks, every image is digest-pinned, every wait is bounded, and cleanup succeeds.
#     Each is a property of the INSTRUMENT or of the SHAPE of the comparison. A run that cannot establish one
#     has measured nothing.
#
#   RECORDED, WITH NO THRESHOLD — every cost figure, without exception: ranged and whole-body GETs, PROPFIND /
#     OPTIONS / HEAD, COMMITTED and OBSERVED media bytes as two separate figures, metadata bytes, 429s,
#     peak connections, per-server scan duration, per-object
#     cost, and the mount client's own accounting beside the endpoint's. An expensive number here is THE
#     FINDING. A gate that failed on one would be a gate nobody could run to produce it.
#
# HOW THE WINDOW IS KEPT COLD, WHICH IS THE WAY THIS GATE COULD MOST EASILY LIE. A client cache that had
# already been filled answers a scan without reaching the endpoint at all, and the naive path would then be
# reported as costing a fraction of what it costs — far worse for a control than any expensive number. So the
# corpus is HELD BACK at the endpoint until every library exists, the client's cached listings are dropped
# explicitly, and the gate asserts all of: the corpus was visible, the endpoint had neither promised nor
# written a single byte for any
# corpus object beforehand, the client's cache directory was EMPTY, the window reached the endpoint at least
# once per corpus object, and a request really was blocked at the barrier and released rather than lapsing.
#
# WHAT IT DOES NOT PROVE. A Docker Desktop pass is NOT Linux/Unraid closure and closes NONE of G7–G13, G18 or
# G22. No run has ever happened on a real Linux or Unraid host and no real provider endpoint has ever been
# contacted. Per-server attribution is impossible here and is not claimed: one mount client serves all three
# servers, so the endpoint sees the client and never the server behind a byte. Nothing here decodes anything.
# Phase 1 remains open.
#
# EVERYTHING IS BOUNDED. Every readiness probe, scan, observation and wait has a hard deadline; a hang fails
# the gate rather than occupying the machine.
set -euo pipefail
export MSYS_NO_PATHCONV=1

GO_IMAGE="golang:1.26.5-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"

# THE MOUNT CLIENT, PINNED BY DIGEST LIKE EVERYTHING ELSE. rclone v1.71.1. A moving tag would mean three
# consecutive runs measured three possibly different clients, and the cost figures are the whole output.
RCLONE_IMAGE="rclone/rclone@sha256:d5971950c2b370fb04dd3292541b5bda6d9103143fd7e345aeb435a399388afc"

# THE THREE MEDIA SERVERS, EACH THE SAME DIGEST ITS OWN GATE PINS — AND THE SAME ONES G18 PINS.
#
# THEY ARE THE SAME DIGESTS BECAUSE THIS IS A COMPARISON. Every behavioural finding the three drivers encode
# belongs to the version behind a particular digest. Pinning a different one here would mean the two sides of
# the comparison were not read by the same three servers, and the difference between them would include the
# difference between two Plexes.
JELLYFIN_IMAGE="jellyfin/jellyfin@sha256:7ae36aab93ef9b6aaff02b37f8bb23df84bb2d7a3f6054ec8fc466072a648ce2"
PLEX_IMAGE="plexinc/pms-docker@sha256:a2b03d75aa16f422488c692935cab476d966b75f2af3c93bb6d910c6051906f5"
EMBY_IMAGE="emby/embyserver@sha256:734a6f03c7c783a9e566b08d09a2b6376f41229ff29f032a7e00302e0be98f8a"

# THE MEDIA GENERATOR, and the choice is immaterial here for the same reason it is in G18: nothing in this
# gate decodes anything. It is a fixture factory rather than a judge.
GENERATOR_IMAGE="$JELLYFIN_IMAGE"
GENERATOR_FFMPEG="/usr/lib/jellyfin-ffmpeg/ffmpeg"

NETWORK="projection-rclone-gate-$$"
DAV_PORT="${PROJECTION_RCLONE_GATE_DAV_PORT:-8132}"
RC_PORT="${PROJECTION_RCLONE_GATE_RC_PORT:-5573}"
JF_PORT="${PROJECTION_RCLONE_GATE_JELLYFIN_PORT:-8130}"
EMBY_PORT="${PROJECTION_RCLONE_GATE_EMBY_PORT:-8131}"
PLEX_PORT="${PROJECTION_RCLONE_GATE_PLEX_PORT:-32530}"

# EVERY CONTAINER NAME CARRIES THIS SHELL'S PID, so a second copy of this gate — or any of the four
# projectiond gates, which use different prefixes and different ports — cannot collide with it.
DAV_CONTAINER="projection-rc-dav-$$"
MOUNT_CONTAINER="projection-rc-mount-$$"
JF_CONTAINER="projection-rc-jellyfin-$$"
PLEX_CONTAINER="projection-rc-plex-$$"
EMBY_CONTAINER="projection-rc-emby-$$"

# TWO SPELLINGS OF ONE DIRECTORY: WORK is absolute and is what Docker bind mounts name, and it lives beside
# the repository because bind propagation needs a shared host mount; REL is relative and is what node and tsx
# are given, because an MSYS absolute path is not something a Windows node binary can open.
GATE_ROOT="$PWD/.projection-rclone-gate"
REL=".projection-rclone-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

cleanup() {
  # THE MEDIA SERVERS FIRST, ALL THREE. Each holds open handles on the mount, and a FUSE mount with a live
  # reader does not unmount cleanly — leaving one behind is how the NEXT run inherits a stale namespace and
  # reports a cost figure produced by a mount it did not create.
  docker rm -f "$PLEX_CONTAINER" "$JF_CONTAINER" "$EMBY_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$MOUNT_CONTAINER" "$DAV_CONTAINER" >/dev/null 2>&1 || true
  if [ -n "${WORK:-}" ] && [ -d "$WORK" ]; then
    docker run --rm --privileged -v "$GATE_ROOT:/gate" "$VERIFY_IMAGE" \
      sh -c "umount -l /gate/$(basename "$WORK")/mnt 2>/dev/null; rm -rf /gate/$(basename "$WORK")" \
      >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step() { echo; echo "=== $* ==="; }
die()  { echo "GATE FAILED: $*" >&2; exit 1; }

# THE LOG COLLECTOR IS BOUNDED AND CANNOT HANG. `docker logs` on a live container without `--tail` streams
# until the container stops; a diagnostic that never returns turns a named failure into a wedged run, and the
# operator then has no diagnosis AND no machine.
logs_tail() { docker logs --tail 40 "$1" 2>&1 | tail -40 >&2 || true; }

drive()    { npx tsx src/ops/projection-rclone-comparison-cli.ts "$@" --results "$REL/out/results.json"; }
plain()    { npx tsx src/ops/projection-rclone-comparison-cli.ts "$@"; }
jellyfin() { npx tsx src/ops/projection-jellyfin-dataplane-cli.ts "$@"; }
plex()     { npx tsx src/ops/projection-plex-dataplane-cli.ts "$@"; }
emby()     { npx tsx src/ops/projection-emby-dataplane-cli.ts "$@"; }
ffmpeg_run() { docker run --rm --entrypoint "$GENERATOR_FFMPEG" -v "$WORK:/work" "$GENERATOR_IMAGE" "$@"; }

mkdir -p "$WORK/media" "$WORK/mnt" "$WORK/out" "$WORK/secret" \
         "$WORK/rclone-cache" "$WORK/rclone-config" \
         "$WORK/jf-config" "$WORK/jf-cache" "$WORK/plex-config" "$WORK/plex-transcode" "$WORK/emby-config"
# Each media server's state directory is made writable by whoever it turns out to be. The MEDIA is not: what
# the mount presents is read-only, and that is under test.
chmod 777 "$WORK/mnt" "$WORK/out" "$WORK/rclone-cache" "$WORK/rclone-config" \
          "$WORK/jf-config" "$WORK/jf-cache" "$WORK/plex-config" "$WORK/plex-transcode" "$WORK/emby-config"
# ...AND THE PATH INTO THEM IS TRAVERSABLE BY A UID THAT DID NOT CREATE IT.
#
# A DEFECT DOCKER DESKTOP CANNOT SHOW YOU. The permissive directories above are reached THROUGH `$GATE_ROOT`
# and `$WORK`, which `mkdir -p` created under whatever umask the operator happens to have. At the common 022
# they land at 0755 and everything works; at 077 — an ordinary hardened default — they land at 0700, and a
# container running as uid 1000 cannot traverse into them however permissive the leaf is. On Docker Desktop
# none of this is visible, because the host side of a bind carries no modes at all.
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
createReadStream(process.argv[2])
  .on('data', (chunk) => hash.update(chunk))
  .on('end', () => console.log(hash.digest('hex')));
SHA

field() { node "$REL/jq.cjs" "$1"; }

cat > "$WORK/expect.cjs" <<'EXPECT'
// THE SHARED CORPUS EXPECTATION, DERIVED FROM THE ENDPOINT'S OWN REGISTRATION DOCUMENT.
//
// The endpoint writes that document at startup, from the files on disk, BEFORE anything has read one byte
// through a mount. Deriving the expectation from it rather than from a second walk is what stops this gate
// asserting a corpus that differs from the one the endpoint is serving — and an expectation derived from the
// mount would be an expectation the mount cannot fail.
//
// `kind` IS THE PRODUCT'S VOCABULARY AND MEANS NOTHING ON THIS TOPOLOGY. `CorpusExpectation` offers `local`
// or `http-range`, which are the two source kinds a manifest can name. There is no manifest here and no
// choice of source: every entry's bytes come over WebDAV, because a naive mount has nowhere else to get them
// from. `http-range` is recorded as the closer of the two — the bytes are not local — and no assertion in
// this gate reads the field.
//
// THE CANARY IS EXCLUDED. It is registered at the endpoint and lives outside the library root on purpose, so
// the readiness probe can check range semantics without putting a byte on a corpus object and destroying the
// cold measurement before the gate has done anything.
const { readFileSync, writeFileSync } = require('node:fs');
const [, , registered, out, canaryRef, barrierRef] = process.argv;
const objects = JSON.parse(readFileSync(registered, 'utf8'));
const entries = [];
for (const object of objects) {
  if (object.ref === canaryRef) continue;
  const key = object.path.slice(object.path.lastIndexOf('/') + 1);
  entries.push({
    key,
    sizeBytes: object.size,
    sha256: object.sha256,
    kind: 'http-range',
    ...(object.ref === barrierRef || object.seed ? { anchor: true } : {}),
  });
}
writeFileSync(out, `${JSON.stringify(entries, null, 2)}\n`);
console.log(String(entries.length));
EXPECT

# ----------------------------------------------------------------------------------------------------------
step "the Compose file this repository's Go gates use still parses"
# ----------------------------------------------------------------------------------------------------------
# THIS GATE STANDS UP NO COMPOSE PROJECT OF ITS OWN, AND THE ABSENCE IS THE POINT: there is no PostgreSQL, no
# publisher and no daemon in the topology under test. The one Compose file it is adjacent to is the Go gates'
# toolchain, and a broken one there would break the endpoint this gate builds from source.
docker compose -f docker-compose.projectiond.yml config -q
echo "  parses"

# ----------------------------------------------------------------------------------------------------------
step "the non-mutating host preflight, BEFORE this gate starts a single container"
# ----------------------------------------------------------------------------------------------------------
# WHETHER THIS HOST'S MOUNTS LET A FUSE MOUNT REACH A SIBLING CONTAINER AT ALL.
#
# IT RUNS BEFORE ANY CONTAINER STARTS, AND THE ORDER IS THE POINT. A preflight that runs after a container is
# diagnosing a host this gate has already begun using, and its "the host was fine" verdict is a verdict about
# a host with side effects on it.
#
# IT MUTATES NOTHING. Two read-only host queries — `findmnt` on the run root, and a mode check on two
# directories this gate created itself. No container, no image, no daemon.
#
# THE REQUIREMENT IS THE SAME ONE THE PRODUCT'S OWN GATES HAVE, and it is required here for the same reason:
# the mount client binds its mount point `rshared` so the namespace it creates inside its container becomes
# visible to the three media servers beside it, and the kernel permits `rshared` only from an already-shared
# source. That the naive topology needs exactly the same host property as the product's is itself worth
# recording — it is not one of the things that differ.
#
# `--require` MAKES A `not-shared` ANSWER FATAL, and an UNDETERMINED one is deliberately not: a Windows host
# publishes no /proc/self/mountinfo. A check that cannot run says so on stderr rather than passing quietly.
# ----------------------------------------------------------------------------------------------------------
npx tsx src/ops/projection-host-preflight-cli.ts propagation --path "$GATE_ROOT" --require
npx tsx src/ops/projection-host-preflight-cli.ts traversal --path "$GATE_ROOT" --path "$WORK"

# ----------------------------------------------------------------------------------------------------------
step "checking this host can host the gate at all"
# ----------------------------------------------------------------------------------------------------------
# A SKIP IS NOT A PASS, AND IT DOES NOT EXIT 0.
#
# 77 is the conventional "skipped" status. It is NOT 0, so anything that treats zero as success — a shell, a
# CI step, the three-run wrapper — reports a skip as a non-success. A host where skip-as-success is genuinely
# wanted has its own entry point: deploy/projection-rclone-comparison-gate-optional.sh, which maps 77 and
# nothing else.
#
# THERE IS EXACTLY ONE SKIP CONDITION AND IT IS /dev/fuse. In particular there is no "this host is too small
# for three media servers" skip: a host that cannot run three at once will FAIL on a deadline, loudly, which
# is correct, because the comparison is about what happens when all three run at once.
GATE_SKIP_STATUS=77
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no /dev/fuse is reachable from a container on this host." >&2
  echo "      The rclone/WebDAV COMPARISON CONTROL measured NOTHING here. This run closes NO acceptance" >&2
  echo "      gate and produced no comparison. It is not a pass and must not be reported as one." >&2
  exit "$GATE_SKIP_STATUS"
fi
echo "  /dev/fuse is reachable from a container"

docker network create "$NETWORK" >/dev/null

# ----------------------------------------------------------------------------------------------------------
step "generating legal synthetic media on this machine — THE SAME CORPUS THE PRODUCT'S GATES PUBLISH"
# ----------------------------------------------------------------------------------------------------------
# NOTHING IS DOWNLOADED AND NOTHING IS COMMITTED. `testsrc` is ffmpeg's own generated test pattern and `sine`
# is a generated tone; both are produced here and thrown away with the run directory.
#
# THE PARAMETERS BELOW ARE CHARACTER-FOR-CHARACTER THE ONES IN
# `deploy/projection-three-server-concurrency-gate.sh`, AND AN OFFLINE TEST COMPARES THE TWO SCRIPTS RATHER
# THAN TRUSTING THIS COMMENT. A comparison over two corpora that merely had the same NUMBER of files would be
# a comparison of corpora: the cost of identifying a library depends on the bytes in it, and two libraries
# generated from different signals differ in exactly the way that matters.
#
# EVERY FILE IS DELIBERATELY DIFFERENT FROM EVERY OTHER. Two entries generated from identical parameters would
# be byte-identical, and then a read that returned the wrong entry would still match its digest.
SEED_FILE="Projection Seed (2026).mp4"
SEED_DAV="/Movies/Projection Seed (2026)/$SEED_FILE"
SEED_REF="obj-projection-seed"
mkdir -p "$WORK/media/seed"
ffmpeg_run -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc=size=128x96:rate=15:duration=3" \
  -f lavfi -i "sine=frequency=311:duration=3" \
  -c:v mpeg4 -qscale:v 5 -c:a aac -b:a 32k -shortest -movflags +faststart "/work/media/seed/$SEED_FILE"
echo "  the seed entry is $(wc -c < "$WORK/media/seed/$SEED_FILE" | tr -d ' ') bytes"

# THE CANARY: A REGISTERED OBJECT OUTSIDE THE LIBRARY ROOT.
#
# The endpoint's range semantics have to be checked before anything depends on them, and the obvious way —
# one ranged GET against a corpus object — would put bytes on that object and DESTROY the cold-window
# measurement before the gate has done anything. So the readiness probe reads a canary: registered at the
# endpoint, served from a path no library root contains, never visible to a media server. Its share of the
# window's bytes is then reported separately and the corpus's own is exact.
#
# ITS NAME CARRIES NO SPACE, AND THAT IS DELIBERATE RATHER THAN INCONSISTENT. Every other name in this corpus
# does, because a naive mount meeting spaces and parentheses is exactly the kind of thing a comparison should
# find out about — and the whole corpus exercises that, through rclone, which percent-encodes them properly.
# The canary is reached by a BUSYBOX `wget` in a readiness probe instead, which does not, and a readiness
# probe that failed on its own URL quoting would be a gate that never got as far as measuring anything. The
# first real run of this gate failed exactly there.
CANARY_FILE="projection-canary.bin"
CANARY_REF="obj-projection-canary"
mkdir -p "$WORK/media/canary"
head -c 262144 /dev/urandom > "$WORK/media/canary/$CANARY_FILE"

# ----------------------------------------------------------------------------------------------------------
# THE LARGE FIXTURE, WHICH IS ALSO THE BARRIER OBJECT.
#
# WHY IT IS IN THIS CORPUS AT ALL. It is in the product's, so it is in this one — that is what "the same
# corpus" means. What it buys HERE is different from what it buys there: with no threshold to bind, its value
# is that a hundred-megabyte object is where a client's read-ahead and chunk sizing become visible in the
# numbers. A corpus of tiny files would report a small multiplier for a reason that has nothing to do with
# the topology.
#
# ITS PROJECTED PATH SORTS FIRST so a scanner reaches it early, which is what makes the rendezvous land
# inside the hold's bounded window.
# ----------------------------------------------------------------------------------------------------------
LARGE_FILE="Aaa Projection Barrier (2026).mp4"
LARGE_REF="obj-projection-barrier"
LARGE_MIN_BYTES=98566144
mkdir -p "$WORK/media/large"
step "generating the large barrier fixture (>= ${LARGE_MIN_BYTES} bytes)"
ffmpeg_run -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=640x480:rate=24:duration=105" \
  -f lavfi -i "sine=frequency=277:duration=105" \
  -c:v mpeg4 -b:v 8M -minrate 8M -maxrate 8M -bufsize 16M \
  -c:a aac -b:a 64k -shortest -movflags +faststart "/work/media/large/$LARGE_FILE"
LARGE_SIZE="$(wc -c < "$WORK/media/large/$LARGE_FILE" | tr -d ' ')"
test "$LARGE_SIZE" -ge "$LARGE_MIN_BYTES" \
  || die "the large fixture is $LARGE_SIZE bytes, under the size the product's own corpus generates"
echo "  the barrier object is $LARGE_SIZE bytes"

# ----------------------------------------------------------------------------------------------------------
# THE REST OF THE ~50-ENTRY CORPUS. Same counts, same generator, same everything as the product's gates.
#
# WHY THE LOCAL/REMOTE SPLIT SURVIVES AS A COMMENT AND NOT AS A BEHAVIOUR. The product publishes six of these
# as LOCAL passthrough entries, whose bytes never reach an endpoint at all. This topology has no such
# distinction: everything a naive mount presents comes from the remote, because there is nowhere else. So all
# of them are served over WebDAV here, and the report rolls the figures up BOTH ways — over the whole corpus,
# and over just the subset the product also fetches remotely, which is the only sub-total for which the two
# sides compare like with like.
#
# ONE CONTAINER GENERATES ALL OF THEM. Forty-nine `docker run`s cost more in container start-up than in
# encoding.
# ----------------------------------------------------------------------------------------------------------
CORPUS_COUNT=48
CORPUS_LOCAL=6
step "generating the ${CORPUS_COUNT}-item legal synthetic corpus, in one container"
# THE GENERATOR IS A FILE, NOT A MULTI-LINE `-c '...'` ARGUMENT, and that is a rule this repository enforces
# rather than a style choice: test/custody-runtime-closure.ts parses every shipped script and REFUSES a line
# whose quotes do not close on it, because an unreadable line is one a "does this region contain X" gate
# answers "no" for.
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
  if [ "$i" -gt $(( total - localCount )) ]; then dir=media; else dir=remote; fi
  "$ff" -hide_banner -loglevel error -y \
    -f lavfi -i "${src}=size=128x96:rate=15:duration=${dur}" \
    -f lavfi -i "sine=frequency=${freq}:duration=${dur}" \
    -c:v mpeg4 -qscale:v 5 -c:a aac -b:a 32k -shortest -movflags +faststart \
    "/work/${dir}/Projection Corpus ${n} (2026).mp4"
  i=$(( i + 1 ))
done
echo "  generated ${total} corpus files"
GENCORPUS
# THE GENERATOR WRITES INTO TWO DIRECTORIES BECAUSE THE PRODUCT'S GATE DOES, and the file is byte-identical to
# that one so an offline test can compare them. Here the split has no meaning — both directories are served
# over WebDAV — and the registration below walks them in the SAME index order the product publishes, so
# ordinal N on this side and ordinal N on that side are the same generated file.
mkdir -p "$WORK/media" "$WORK/remote"
docker run --rm --entrypoint /bin/sh -v "$WORK:/work" "$GENERATOR_IMAGE" \
  /work/out/gen-corpus.sh "$CORPUS_COUNT" "$CORPUS_LOCAL" "$GENERATOR_FFMPEG"

# ----------------------------------------------------------------------------------------------------------
step "minting the endpoint credential, into a file and never into an argument"
# ----------------------------------------------------------------------------------------------------------
# A NAIVE MOUNT STILL AUTHENTICATES, and a comparison against an open endpoint would be dishonest: nobody
# points a media server's library root at an unauthenticated share. What this gate is entitled to require of
# the topology is not that the credential is well designed — it is the operator's — but that it does not end
# up somewhere a media server, or the mount's own cache, keeps it.
#
# SO IT IS HIGH-ENTROPY AND MINTED PER RUN. A short literal occurs by chance in any few megabytes of binary
# and could only ever produce false positives; a 32-hex marker is what makes the searches below a search for
# THE ACTUAL SECRET.
#
# AND IT TRAVELS IN A FILE. Neither the endpoint nor the client is given it as an argument, so it is in no
# argv, no container inspect output and no shell history. The client reads it through its own
# bearer-token-command hook; the endpoint through --token-file.
#
# THE MODE IS 0644 AND THAT IS A DELIBERATE CHOICE RATHER THAN AN OVERSIGHT. §6.0 of the acceptance plan
# records a real defect this repository has already paid for: a token file written 0600 that the consuming
# container's uid could not have read, invisible on Docker Desktop because the host side of a bind carries no
# modes. Both consumers here run as uid 0 and 0600 would work — but this file is a synthetic, per-run,
# throwaway value in a directory the run deletes, and choosing the mode that cannot reintroduce that defect on
# the tranche-closing host is worth more than tightening a secret with no lifetime. The property that matters
# is asserted directly further down: the value does not appear in the client's cache, its configuration, or
# any media server's library state.
DAV_TOKEN="PJDDAV$(node -e "console.log(require('node:crypto').randomBytes(16).toString('hex'))" | tr -d ' \r\n')"
printf '%s' "$DAV_TOKEN" > "$WORK/secret/token"
cat > "$WORK/secret/token.sh" <<'TOKENSH'
cat /secret/token
TOKENSH
chmod 644 "$WORK/secret/token" "$WORK/secret/token.sh"
chmod 755 "$WORK/secret"

# ----------------------------------------------------------------------------------------------------------
step "starting the deterministic WebDAV endpoint"
# ----------------------------------------------------------------------------------------------------------
# THE REGISTRATION ORDER IS LOAD-BEARING AND IS ASSERTED BELOW. The endpoint's per-object columns carry a
# registration ordinal and no path — deliberately, so telemetry can be attributed without the endpoint ever
# reporting a name — so the gate and the endpoint agree on which objects are "the corpus" by a BOUNDARY:
#
#   ordinal 0  the canary          registered as a seed object so the readiness probe can read it pre-reveal
#   ordinal 1  the seed entry      visible before the reveal, so a library can be created against a non-empty
#                                  root and the corpus can still be the concurrent scan's first read
#   ordinal 2  the barrier fixture the first CORPUS ordinal
#   ordinal 3+ the generated corpus, in the product's own index order
FIRST_CORPUS_ORDINAL=2
CORPUS_OBJECTS=$(( 1 + CORPUS_COUNT ))

# The subset the product ALSO fetches remotely: the barrier fixture and every generated entry the product
# does not publish as local passthrough. Ordinals 2 .. 2 + (CORPUS_COUNT - CORPUS_LOCAL).
PRODUCT_ORDINALS="$FIRST_CORPUS_ORDINAL"
index=1
while [ "$index" -le "$(( CORPUS_COUNT - CORPUS_LOCAL ))" ]; do
  PRODUCT_ORDINALS="${PRODUCT_ORDINALS},$(( FIRST_CORPUS_ORDINAL + index ))"
  index=$(( index + 1 ))
done

CORPUS_OBJECT_FLAGS=()
index=1
while [ "$index" -le "$CORPUS_COUNT" ]; do
  n="$(printf "%02d" "$index")"
  if [ "$index" -gt "$(( CORPUS_COUNT - CORPUS_LOCAL ))" ]; then hostdir=media; else hostdir=remote; fi
  CORPUS_OBJECT_FLAGS+=(--file-object \
    "obj-projection-corpus-${n}=/Movies/Projection Corpus ${n} (2026)/Projection Corpus ${n} (2026).mp4=/media-src/${hostdir}/Projection Corpus ${n} (2026).mp4")
  index=$(( index + 1 ))
done

docker run -d --name "$DAV_CONTAINER" --network "$NETWORK" --network-alias fakedav \
  -p "127.0.0.1:${DAV_PORT}:8098" \
  -v "$PWD:/workspace" -w /workspace/projectiond \
  -v "$WORK:/media-src:ro" -v "$WORK/out:/out" -v "$WORK/secret:/secret:ro" \
  -e GOFLAGS=-buildvcs=false -e GOTOOLCHAIN=local -e CGO_ENABLED=0 \
  "$GO_IMAGE" go run ./cmd/fakewebdav --addr 0.0.0.0:8098 --token-file /secret/token \
  --max-hold 4500ms --emit /out/objects.json \
  --seed-object "${CANARY_REF}=/Canary/${CANARY_FILE}=/media-src/media/canary/${CANARY_FILE}" \
  --seed-object "${SEED_REF}=${SEED_DAV}=/media-src/media/seed/${SEED_FILE}" \
  --file-object "${LARGE_REF}=/Movies/${LARGE_FILE%.mp4}/${LARGE_FILE}=/media-src/media/large/${LARGE_FILE}" \
  "${CORPUS_OBJECT_FLAGS[@]}" >/dev/null

echo "  waiting for the endpoint to come up"
# A LIVENESS PROBE MUST NOT BE TRAFFIC. A readiness loop that sent a GET would be a real object read: it would
# serve bytes and, on a slow host, do so dozens of times before the first figure was recorded. So liveness is
# `/counters`, which the endpoint deliberately does not count, and the RANGE SEMANTICS are checked exactly
# once, afterwards, against the canary.
cat > "$WORK/out/alive.sh" <<'ALIVE'
set -eu
wget -q -O /dev/null "$1"
ALIVE
cat > "$WORK/out/probe.sh" <<'PROBE'
set -eu
wget -S --header "Range: bytes=0-1023" --header "Authorization: Bearer $2" -O /dev/null "$1" 2>&1 \
  | grep -q "206 Partial Content"
PROBE

ready=0
for _ in $(seq 1 240); do
  if [ -f "$WORK/out/objects.json" ] && docker run --rm --network "$NETWORK" \
       -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
       sh /probe/alive.sh "http://fakedav:8098/counters" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" -eq 1 || { logs_tail "$DAV_CONTAINER"; die "the WebDAV endpoint never answered"; }

# ONE ranged request, AGAINST THE CANARY, and its status line asserted. busybox wget exits non-zero on a 206
# because it treats anything but 200 as an error, so the exit code is useless and the status line is checked.
docker run --rm --network "$NETWORK" -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
  sh /probe/probe.sh "http://fakedav:8098/dav/Canary/${CANARY_FILE}" "$DAV_TOKEN" >/dev/null 2>&1 \
  || { logs_tail "$DAV_CONTAINER"; die "the endpoint does not answer a ranged request with 206"; }
echo "  the endpoint answers a ranged request with 206, and the object it was asked about is not in the corpus"

# AND IT REFUSES AN UNAUTHENTICATED ONE, or the credential searches later in this run would be searching for
# something that never had to exist.
if docker run --rm --network "$NETWORK" -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
     sh /probe/probe.sh "http://fakedav:8098/dav/Canary/${CANARY_FILE}" "not-the-token" >/dev/null 2>&1; then
  die "the endpoint served a ranged request with the wrong credential"
fi
echo "  and refuses the same request with the wrong credential"

ENDPOINT_LARGE_SIZE="$(plain objects --file "$REL/out/objects.json" --ref "$LARGE_REF" --field size)"
test "$ENDPOINT_LARGE_SIZE" = "$LARGE_SIZE" || die "the endpoint disagrees with the barrier file about its size"

CORPUS_TOTAL="$(node "$REL/expect.cjs" "$REL/out/objects.json" "$REL/out/expected.json" \
  "$CANARY_REF" "$LARGE_REF")"
echo "  the shared corpus all three servers will be held against is $CORPUS_TOTAL entries"
test "$CORPUS_TOTAL" -ge 48 \
  || die "the corpus is $CORPUS_TOTAL entries, not the ~50 the acceptance plan asks for"

# ----------------------------------------------------------------------------------------------------------
step "mounting the endpoint with a digest-pinned rclone, read-only, with a FRESH cache"
# ----------------------------------------------------------------------------------------------------------
# EVERY BOUND IS SET EXPLICITLY RATHER THAN INHERITED, and that is what makes the figures below attributable.
# A cost measured against a client whose deadlines and cache mode came from whatever the pinned image happened
# to default to is a cost nobody can reproduce or reason about.
#
#   --read-only          the product's mount is read-only; a writable control would be measuring something else
#   --vfs-cache-mode off the naive default, stated. A different mode would produce different figures and the
#                        report says which one produced these
#   --dir-cache-time     the naive default, stated, because it is what decides how much of the metadata cost
#                        a scan pays and how much it inherits
#   --file-perms 0444    so what a media server sees is an ordinary READ-ONLY regular file, exactly as the
#     --dir-perms 0555   product's mount presents it. Comparing a 0644 tree against a 0444 one would be
#                        comparing two different things a server can do with a file
#   --timeout            wide on purpose, and far wider than this corpus needs, so that no figure can be
#     --contimeout       attributed to a deadline this gate imposed. The barrier hold is bounded strictly
#                        under the first of them
#   --allow-other        the three media servers run as uid 1000 and the mount is created by uid 0
#   --allow-non-empty    the mount point IS the bind whose propagation carries the namespace outward, exactly
#                        as the production daemon's is, so it is already a mount when the client arrives
#
# THE CREDENTIAL IS READ FROM A FILE BY A COMMAND HOOK, so it is in no argument and no environment value.
docker run -d --name "$MOUNT_CONTAINER" \
  --network "$NETWORK" \
  --user 0:0 \
  --cap-drop ALL --cap-add SYS_ADMIN \
  --security-opt apparmor:unconfined \
  --device /dev/fuse:/dev/fuse \
  -p "127.0.0.1:${RC_PORT}:5572" \
  -v "$WORK/secret:/secret:ro" \
  -v "$WORK/rclone-config:/config" \
  -v "$WORK/rclone-cache:/cache" \
  -v "$WORK/mnt:/mnt/rclone:rshared" \
  -e RCLONE_CONFIG=/config/rclone.conf \
  -e RCLONE_CONFIG_VAULT_TYPE=webdav \
  -e RCLONE_CONFIG_VAULT_URL=http://fakedav:8098/dav \
  -e RCLONE_CONFIG_VAULT_VENDOR=other \
  -e RCLONE_CONFIG_VAULT_BEARER_TOKEN_COMMAND="sh /secret/token.sh" \
  "$RCLONE_IMAGE" mount vault: /mnt/rclone \
  --read-only --allow-other --allow-non-empty \
  --file-perms 0444 --dir-perms 0555 \
  --vfs-cache-mode off --dir-cache-time 5m \
  --timeout 30s --contimeout 10s \
  --cache-dir /cache \
  --rc --rc-addr 0.0.0.0:5572 --rc-no-auth \
  --log-level INFO >/dev/null

RC_BASE="http://127.0.0.1:${RC_PORT}"
DAV_BASE="http://127.0.0.1:${DAV_PORT}"

await_path() {
  local target="$1"
  local attempts="${2:-240}"
  local n=0
  while [ "$n" -lt "$attempts" ]; do
    if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
         test -f "/mnt/$target" >/dev/null 2>&1; then
      return 0
    fi
    n=$((n + 1))
    sleep 0.5
  done
  return 1
}

echo "  waiting for the mount client's control surface"
alive=0
for _ in $(seq 1 120); do
  if plain client-alive --rc "$RC_BASE" >/dev/null 2>&1; then alive=1; break; fi
  sleep 1
done
test "$alive" -eq 1 || { logs_tail "$MOUNT_CONTAINER"; die "the mount client never came up"; }
plain client-alive --rc "$RC_BASE"

echo "  waiting for the namespace to become visible to a sibling container"
SEED_PATH="Movies/Projection Seed (2026)/$SEED_FILE"
await_path "$SEED_PATH" || { logs_tail "$MOUNT_CONTAINER"; die "the mount never became visible"; }
echo "  visible"

# ----------------------------------------------------------------------------------------------------------
step "what an ordinary non-root container sees, and whether the mount really carries the bytes"
# ----------------------------------------------------------------------------------------------------------
# THIS IS THE CHECK THAT MAKES `--allow-non-empty` SAFE. The mount point is the bind that propagates the
# namespace outward, so if the client died the directory underneath would still be there — empty, readable,
# and silent. A gate that only ever asked "did the scan find things" would report a clean small number for a
# dead mount. So a KNOWN file is read through the mount and digest-compared against a value recorded outside
# it, before any measurement begins.
cat > "$WORK/out/baseline.sh" <<'BASE'
set -eu
test "$(id -u)" != "0" || { echo "the verifier is root" >&2; exit 1; }
for target in "$@"; do
  test -f "/mnt/$target"  || { echo "not a regular file: $target" >&2; exit 1; }
  test ! -L "/mnt/$target" || { echo "a media server would see a symlink" >&2; exit 1; }
  case "$target" in *.strm) echo "a .strm placeholder is not a projected file" >&2; exit 1;; esac
  test "$(stat -c %a "/mnt/$target")" = "444" || { echo "not read-only: $target" >&2; exit 1; }
  stat -c "    %n size=%s mode=%a" "/mnt/$target"
done
BASE
docker run --rm --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges \
  -v "$WORK/mnt:/mnt:rslave" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
  sh /out/baseline.sh "$SEED_PATH"

SEED_SHA_EXPECTED="$(plain objects --file "$REL/out/objects.json" --ref "$SEED_REF" --field sha256)"
cat > "$WORK/out/digest.sh" <<'DIGEST'
set -eu
sha256sum "/mnt/$1" | cut -d' ' -f1
DIGEST
SEED_SHA_THROUGH_MOUNT="$(docker run --rm --user 65534:65534 -v "$WORK/mnt:/mnt:rslave" \
  -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" sh /out/digest.sh "$SEED_PATH")"
test "$SEED_SHA_THROUGH_MOUNT" = "$SEED_SHA_EXPECTED" \
  || die "the bytes read through the mount are not the bytes the endpoint serves"
echo "  a file read THROUGH the mount digests to the value recorded outside it"

# ----------------------------------------------------------------------------------------------------------
step "starting THREE REAL MEDIA SERVERS over the SAME rclone mount"
# ----------------------------------------------------------------------------------------------------------
# EACH ONE IS STARTED THE WAY ITS OWN GATE STARTS IT, AND THE THREE COMMANDS ARE DELIBERATELY NOT UNIFIED.
# Jellyfin runs under `--user 1000:1000` with all capabilities dropped; Emby cannot, because its entrypoint is
# an s6 supervision tree that reads UID/GID and does the setuid itself; Plex takes PLEX_UID/PLEX_GID and must
# be addressed by ADDRESS rather than by name, since it answers 401 to a request whose Host header it does not
# recognise. A single parameterised helper would have had to pick one of the three.
#
# THE MOUNT IS THE SAME DIRECTORY IN ALL THREE. That is the comparison: one namespace, three readers, exactly
# as G18 arranges it over the product's own mount.
start_jellyfin() {
  docker run -d --name "$JF_CONTAINER" \
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
start_jellyfin
start_emby
start_plex
echo "  three media servers started, all three with the same rclone mount as a library root"

JF_BASE="http://127.0.0.1:${JF_PORT}"
EMBY_BASE="http://127.0.0.1:${EMBY_PORT}"
PLEX_BASE="http://127.0.0.1:${PLEX_PORT}"
JF_STATE="$REL/out/state-jellyfin.json"
EMBY_STATE="$REL/out/state-emby.json"
PLEX_STATE="$REL/out/state-plex.json"

# ----------------------------------------------------------------------------------------------------------
step "standing each server up through ITS OWN driver"
# ----------------------------------------------------------------------------------------------------------
jellyfin bootstrap --base "$JF_BASE" --state "$JF_STATE" \
  || { logs_tail "$JF_CONTAINER"; die "Jellyfin never came up"; }
emby bootstrap --base "$EMBY_BASE" --state "$EMBY_STATE" \
  || { logs_tail "$EMBY_CONTAINER"; die "Emby never came up"; }
plex bootstrap --base "$PLEX_BASE" --state "$PLEX_STATE" \
  || { logs_tail "$PLEX_CONTAINER"; die "Plex never came up"; }
test -s "$WORK/out/state-jellyfin.json" || die "the Jellyfin bootstrap exited 0 but wrote no state"
test -s "$WORK/out/state-emby.json"     || die "the Emby bootstrap exited 0 but wrote no state"
test -s "$WORK/out/state-plex.json"     || die "the Plex bootstrap exited 0 but wrote no state"

# EACH SERVER MUST BE ABLE TO READ THE MOUNT AS THE UID IT ACTUALLY RUNS AS, checked from inside its own
# container BEFORE a scan is asked for — otherwise a scan that finds nothing is ambiguous between "the mount
# is broken" and "the container cannot see the directory". `-u 1000:1000` is load-bearing on Emby, where a
# bare `docker exec` lands as ROOT because the image drops privilege internally.
docker exec -u 1000:1000 "$JF_CONTAINER"   test -r "/media/projection/$SEED_PATH" \
  || die "Jellyfin's own uid cannot read the mounted file"
docker exec -u 1000:1000 "$EMBY_CONTAINER" test -r "/media/projection/$SEED_PATH" \
  || die "Emby's own uid cannot read the mounted file"
docker exec --user 1000:1000 "$PLEX_CONTAINER" test -r "/media/projection/$SEED_PATH" \
  || die "Plex's own uid cannot read the mounted file"
echo "  all three servers can read the same mounted file as the uid each runs as"

# Plex's server preferences, which turn off every background job that reads whole media files on a timer. A
# butler window opening mid-gate would put bytes into the window this gate attributes to a scan.
plex prefs --state "$PLEX_STATE"

# ----------------------------------------------------------------------------------------------------------
step "adding the SAME mount as a Movies library on all three"
# ----------------------------------------------------------------------------------------------------------
jellyfin library --state "$JF_STATE"   --mount-path /media/projection/Movies --name "Projection Movies"
emby     library --state "$EMBY_STATE" --mount-path /media/projection/Movies --name "Projection Movies"
# PLEX LAST, AND THE ORDER IS LOAD-BEARING. Creating a Plex section starts a scan of it immediately and
# nothing in its API asks it not to. That scan is harmless here because only the seed entry is visible — but
# it is a scan, and putting it last means the other two libraries already exist when it runs.
plex library --state "$PLEX_STATE" --mount-path /media/projection/Movies --name "Projection Movies"

# ...AND THEN PLEX'S CREATION SCAN IS WAITED OUT, EXPLICITLY, BEFORE THE CORPUS IS REVEALED.
#
# THIS IS THE STEP THAT MAKES THE COLD WINDOW A FACT RATHER THAN A HOPE. Publishing the corpus while that scan
# was still running would let Plex catalogue part of it, filling the client's caches, and the "concurrent"
# window would then measure a topology that had already done the work.
cat > "$WORK/out/seed-expect.cjs" <<'SEEDEXPECT'
const { readFileSync, writeFileSync } = require('node:fs');
const [, , registered, out, seedRef] = process.argv;
const objects = JSON.parse(readFileSync(registered, 'utf8'));
const seed = objects.find((object) => object.ref === seedRef);
if (!seed) { console.error('the seed entry is not registered'); process.exit(1); }
const key = seed.path.slice(seed.path.lastIndexOf('/') + 1);
writeFileSync(out, `${JSON.stringify([
  { key, sizeBytes: seed.size, sha256: seed.sha256, kind: 'http-range', anchor: true },
], null, 2)}\n`);
SEEDEXPECT
node "$REL/out/seed-expect.cjs" "$REL/out/objects.json" "$REL/out/seed-expected.json" "$SEED_REF"
plex scan --state "$PLEX_STATE" --expect-file "$REL/out/seed-expected.json" \
  --out "$REL/out/plex-seed-items.json" --label seed \
  || { logs_tail "$PLEX_CONTAINER"; die "Plex never settled after its own library-creation scan"; }

# ----------------------------------------------------------------------------------------------------------
step "revealing the corpus — AFTER every library exists, and BEFORE anything has listed or read it"
# ----------------------------------------------------------------------------------------------------------
# THE REVEAL IS THIS TOPOLOGY'S ONLY ANALOGUE OF A PUBLISH, and it is stated plainly rather than glossed. The
# product's gates publish a one-entry generation, create the libraries against it, and publish the corpus
# afterwards. A naive mount has no publish step at all, so the endpoint holds the corpus back until told. It
# changes nothing about what listing and reading the corpus then costs; it decides only WHEN.
plain reveal --endpoint "$DAV_BASE"

# THE CLIENT'S CACHED LISTINGS ARE DROPPED EXPLICITLY, TWICE, AND NEITHER IS A TUNING. A cached listing can
# only ever REDUCE the metadata traffic a scan pays; dropping it can only ever add. The first invalidation
# lets the corpus become visible at a moment this gate chooses rather than somewhere inside the client's
# configured directory-cache window; the second undoes the warming that the visibility check itself caused, so
# the measured window pays for its own first listing.
plain forget --rc "$RC_BASE"
LARGE_PATH="Movies/${LARGE_FILE%.mp4}/$LARGE_FILE"
await_path "$LARGE_PATH" || { logs_tail "$MOUNT_CONTAINER"; die "the corpus never became visible"; }
plain forget --rc "$RC_BASE"
echo "  the corpus is visible through the mount, and the client's cached listings have been dropped again"

# ----------------------------------------------------------------------------------------------------------
step "the state of the world immediately before the concurrent scan"
# ----------------------------------------------------------------------------------------------------------
# THE COLD-WINDOW EVIDENCE IS TAKEN HERE, NOT INFERRED LATER, on two independent instruments on opposite sides
# of the wire: the endpoint's own per-object byte totals, and the mount client's cache directory.
cat > "$WORK/out/cachesize.sh" <<'CACHESIZE'
set -eu
find /cache -type f -exec cat {} + 2>/dev/null | wc -c
CACHESIZE
cache_bytes() {
  docker run --rm -v "$WORK/rclone-cache:/cache:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
    sh /out/cachesize.sh | tr -d ' \r\n'
}
CACHE_BEFORE="$(cache_bytes)"
echo "  the mount client's cache directory holds ${CACHE_BEFORE:-0} bytes"
drive counters --url "$DAV_BASE" --out "$REL/out/counters-before.json"
plain client-stats --rc "$RC_BASE" --out "$REL/out/client-before.json"

# ----------------------------------------------------------------------------------------------------------
step "THREE REAL LIBRARY SCANS, AT THE SAME TIME, OVER THE SAME rclone MOUNT"
# ----------------------------------------------------------------------------------------------------------
# THE SAME OBSERVER, THE SAME THREE DRIVERS AND THE SAME BARRIER AS G18, POINTED AT A DIFFERENT MOUNT. That is
# what "measured the same way" has to mean to be worth saying: a second observer written for this topology
# would make the comparison include the difference between two observers.
drive concurrent-scan \
  --state-jellyfin "$JF_STATE" --state-plex "$PLEX_STATE" --state-emby "$EMBY_STATE" \
  --endpoint "$DAV_BASE" --barrier-ref "$LARGE_REF" \
  --out "$REL/out/concurrent-scan.json" --catalogue-dir "$REL/out" \
  || { logs_tail "$MOUNT_CONTAINER"; die "the concurrent scan did not complete"; }

# THE AFTER SNAPSHOT WAITS FOR EVERY BODY TO FINISH WRITING BEFORE IT IS TAKEN.
#
# The endpoint counts a response's COMMITTED length before its first byte reaches the socket and its OBSERVED
# length after the write returns. A snapshot taken between those two moments has the first counted and the
# second not, so the gap between the totals would be a measurement of when this script happened to look. The
# `counters` command polls the endpoint's own in-flight gauge and REFUSES to write a snapshot that never
# settled, rather than recording a half-written window and letting the analysis quote it.
drive counters --url "$DAV_BASE" --out "$REL/out/counters-after.json"
plain client-stats --rc "$RC_BASE" --out "$REL/out/client-after.json"
CACHE_AFTER="$(cache_bytes)"

# ----------------------------------------------------------------------------------------------------------
step "was it actually simultaneous, and did all three really scan?"
# ----------------------------------------------------------------------------------------------------------
drive verify-overlap --scan "$REL/out/concurrent-scan.json"

# ----------------------------------------------------------------------------------------------------------
step "did each server see the SAME ~50 identities, through ITS OWN semantics?"
# ----------------------------------------------------------------------------------------------------------
drive verify-corpus --server jellyfin --catalogue "$REL/out/catalogue-jellyfin.json" \
  --expect-file "$REL/out/expected.json"
drive verify-corpus --server plex     --catalogue "$REL/out/catalogue-plex.json" \
  --expect-file "$REL/out/expected.json"
drive verify-corpus --server emby     --catalogue "$REL/out/catalogue-emby.json" \
  --expect-file "$REL/out/expected.json"

# ----------------------------------------------------------------------------------------------------------
step "is the instrument trustworthy, and was the window cold?"
# ----------------------------------------------------------------------------------------------------------
# THE ORDER IS THE ARGUMENT. A figure is not read until the counters it comes from are known to be coherent,
# and a cold-window claim is not made until the corpus is known to have been visible and unread.
REGISTERED_OBJECTS=$(( 2 + 1 + CORPUS_COUNT ))
drive telemetry --before "$REL/out/counters-before.json" --after "$REL/out/counters-after.json" \
  --objects "$REGISTERED_OBJECTS" --gate RC3
drive cold-window --before "$REL/out/counters-before.json" --after "$REL/out/counters-after.json" \
  --gate RC3 --first-corpus-ordinal "$FIRST_CORPUS_ORDINAL" --corpus-objects "$CORPUS_OBJECTS" \
  --client-cache-before "${CACHE_BEFORE:-0}"

# ----------------------------------------------------------------------------------------------------------
step "WHAT THE NAIVE PATH COST — recorded, with no threshold, because G22 has none"
# ----------------------------------------------------------------------------------------------------------
drive measure --before "$REL/out/counters-before.json" --after "$REL/out/counters-after.json" \
  --gate RC4 --first-corpus-ordinal "$FIRST_CORPUS_ORDINAL" --product-ordinals "$PRODUCT_ORDINALS" \
  --corpus-objects "$CORPUS_OBJECTS" \
  --client-stats-before "$REL/out/client-before.json" --client-stats-after "$REL/out/client-after.json" \
  --client-cache-before "${CACHE_BEFORE:-0}" --client-cache-after "${CACHE_AFTER:-0}"

# ----------------------------------------------------------------------------------------------------------
step "does this topology preserve seek and ordinary-file behaviour? MEASURED, not assumed"
# ----------------------------------------------------------------------------------------------------------
# THE ACCEPTANCE PLAN SAYS THE COMPARISON MUST RECORD A LIMITATION RATHER THAN CHANGE THE CONTRACT IF ONE IS
# FOUND. So the question is asked directly and after the measured window, so its answer cannot appear inside
# the cost figures: a forward seek past the middle of an object, a BACKWARD seek to its start, and a
# whole-object read, each digest-compared against a value recorded outside the mount.
#
# IT IS NOT G9. Ten media-time seeks through a media server, decoded, are a different claim entirely and
# belong to the three single-server gates. This is the filesystem-level question — does a byte range read at
# an arbitrary offset return the right bytes, in both directions — which is what "ordinary file" has to mean
# before anything above it can be true.
cat > "$WORK/out/seekprobe.sh" <<'SEEKPROBE'
set -eu
target="$1"
block="$2"
# THREE READS, IN THIS ORDER, AND THE ORDER IS THE TEST. A FORWARD seek past the middle, then a BACKWARD seek
# all the way to the start — which is the transition a naive client is most likely to answer wrongly, because
# it is the one that cannot be served by reading onward — and then the whole object. `dd`'s `skip` is a seek,
# and the block size is a whole number of 64 KiB units so this is a handful of syscalls rather than a million.
dd if="$target" bs=65536 skip="$block" count=1 2>/dev/null | sha256sum | cut -d' ' -f1
dd if="$target" bs=65536 count=1 2>/dev/null | sha256sum | cut -d' ' -f1
sha256sum "$target" | cut -d' ' -f1
SEEKPROBE
SEEK_TARGET="Movies/${LARGE_FILE%.mp4}/$LARGE_FILE"
SEEK_BLOCK=$(( LARGE_SIZE / 2 / 65536 ))
SEEK_OUT="$(docker run --rm --user 65534:65534 -v "$WORK/mnt:/mnt:rslave" -v "$WORK/out:/out:ro" \
  "$VERIFY_IMAGE" sh /out/seekprobe.sh "/mnt/$SEEK_TARGET" "$SEEK_BLOCK")"
# THE COMPARISON IS AGAINST THE SAME FILE READ OUTSIDE THE MOUNT, so it is against values this topology had
# no part in producing. The whole-object digest is additionally checked against the endpoint's own
# registration document, which was written before anything had been mounted at all.
OUTSIDE_OUT="$(docker run --rm -v "$WORK/media/large:/src:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
  sh /out/seekprobe.sh "/src/$LARGE_FILE" "$SEEK_BLOCK")"
LARGE_SHA="$(plain objects --file "$REL/out/objects.json" --ref "$LARGE_REF" --field sha256)"
test "$(echo "$SEEK_OUT" | sed -n '1p')" = "$(echo "$OUTSIDE_OUT" | sed -n '1p')" \
  || die "a FORWARD seek through the mount returned different bytes than the same seek outside it"
test "$(echo "$SEEK_OUT" | sed -n '2p')" = "$(echo "$OUTSIDE_OUT" | sed -n '2p')" \
  || die "a BACKWARD seek through the mount returned different bytes than the same read outside it"
test "$(echo "$SEEK_OUT" | sed -n '3p')" = "$LARGE_SHA" \
  || die "a whole-object read through the mount does not digest to the value recorded outside it"
echo "  forward seek, backward seek and whole-object read all returned the bytes recorded outside the mount"
echo "  — so this topology PRESERVES ordinary-file and seek behaviour at the filesystem level, measured"

# ----------------------------------------------------------------------------------------------------------
step "no endpoint credential reached the mount, the client's cache or any server's library state"
# ----------------------------------------------------------------------------------------------------------
# THE CLAIM IS ABOUT THE ENDPOINT CREDENTIAL. It is minted per run, it is high-entropy, and it is searched for
# by exact value — so finding none means something.
#
# THE CLAIM IS NOT "NO TOKEN EXISTS ANYWHERE ON DISK". This gate persists a Jellyfin and an Emby access token
# in its own scratch state files, because the phases run as separate processes, and all three servers persist
# their own authentication state. None of that is the endpoint credential and none of it is searched for.
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

docker run --rm -v "$WORK/rclone-cache:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
  sh /out/leakcheck.sh "the mount client cache" "$DAV_TOKEN" "Authorization:" "Bearer " \
  || die "the mount client's cache holds the endpoint credential"

docker run --rm -v "$WORK/rclone-config:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
  sh /out/leakcheck.sh "the mount client configuration" "$DAV_TOKEN" \
  || die "the mount client wrote the endpoint credential into its configuration"

for scan_dir in jf-config plex-config emby-config; do
  docker run --rm -v "$WORK/$scan_dir:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
    sh /out/leakcheck.sh "a media server's library state" "$DAV_TOKEN" "fakedav" \
    || die "a media server persisted the endpoint credential or the endpoint's name"
done
echo "  no media server's library state names the endpoint or holds its credential"

# AND THE CREDENTIAL REALLY WAS REQUIRED, or every search above was a search for something optional.
docker run --rm --network "$NETWORK" -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
  sh /probe/probe.sh "http://fakedav:8098/dav/Canary/${CANARY_FILE}" "$DAV_TOKEN" >/dev/null 2>&1 \
  || die "the endpoint stopped honouring the credential, so the searches above had no subject"
echo "  and the endpoint still requires it, so the searches had a subject"

# ----------------------------------------------------------------------------------------------------------
step "stopping the mount client: the namespace goes away, and a stale one does not linger"
# ----------------------------------------------------------------------------------------------------------
# WITH THREE MEDIA SERVERS HOLDING THE MOUNT. A stale FUSE mount is what stops the NEXT run from starting
# clean, and three live readers is three times the opportunity to leave one behind.
docker rm -f "$PLEX_CONTAINER" "$JF_CONTAINER" "$EMBY_CONTAINER" >/dev/null 2>&1 || true
docker stop -t 30 "$MOUNT_CONTAINER" >/dev/null
gone=0
for _ in $(seq 1 60); do
  if ! docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" test -d /mnt/Movies >/dev/null 2>&1; then
    gone=1; break
  fi
  sleep 0.5
done
test "$gone" -eq 1 || die "the namespace is still visible after the mount client stopped"
echo "  gone"

# ----------------------------------------------------------------------------------------------------------
step "the report"
# ----------------------------------------------------------------------------------------------------------
drive redaction-check --file "$REL/out/results.json"
plain report --results "$REL/out/results.json"

echo
echo "RCLONE/WEBDAV COMPARISON CONTROL (G22) COMPLETED. Exactly what it measured:"
echo "  - ONE deterministic WebDAV endpoint serving THE SAME ~50-entry corpus the product's own gates"
echo "    publish, generated here from the same synthetic signals; ONE read-only rclone mount of it with a"
echo "    FRESH cache; and THREE real, digest-pinned media servers (Plex, Jellyfin, Emby) each holding the"
echo "    SAME mount directory as its library root."
echo "  - the path topology under test, end to end: WebDAV endpoint -> rclone mount -> ORDINARY read-only"
echo "    regular files -> three media servers. Not symlinks, not .strm placeholders, and proved by reading"
echo "    a file THROUGH the mount and digesting it against a value recorded outside it."
echo "  - THREE LIBRARY SCANS OBSERVED IN FLIGHT AT THE SAME INSTANT, by the SAME observer, the SAME three"
echo "    drivers and the SAME barrier the product's own three-server gate uses -- because a comparison"
echo "    whose two sides were measured by two implementations would include the difference between them."
echo "  - a COLD window, on two independent instruments on opposite sides of the wire: the endpoint had"
echo "    neither PROMISED nor WRITTEN a byte for any corpus object before the scans opened, and the mount"
echo "    client's cache directory was EMPTY."
echo "  - EACH SERVER catalogued every identity at the size recorded outside the mount, as an ORDINARY FILE,"
echo "    THROUGH ITS OWN ordinary-file predicate rather than through a flattened one."
echo "  - and then the COST: ranged and whole-body GETs, PROPFIND/OPTIONS/HEAD, COMMITTED media bytes (what"
echo "    the responses promised in Content-Length) and OBSERVED media bytes (the counts the handler's"
echo "    write calls RETURNED -- an application-write observation, and NOT peer receipt, NOT a TCP"
echo "    acknowledgement, NOT exact wire bytes and NOT billing) as TWO SEPARATE FIGURES, listing bytes,"
echo "    429s, peak connections, per-server scan duration, per-object cost worst-first, and the mount"
echo "    client's OWN accounting beside the endpoint's. EVERY ONE OF THOSE IS RECORDED AND COMPARED"
echo "    AGAINST NOTHING. G22 has no pass threshold, and an expensive number here is the finding."
echo
echo "WHAT THIS GATE DOES NOT PROVE, AND WILL NOT BE PRESENTED AS PROVING:"
npx tsx src/ops/projection-rclone-comparison-cli.ts nonclaims
