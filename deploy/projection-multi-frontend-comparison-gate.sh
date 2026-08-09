#!/usr/bin/env bash
# THE MULTI-FRONTEND COMPARISON — a harness, not an acceptance gate.
#
# WHAT THIS IS. The acceptance plan's gates are each written around ONE frontend: G18 measures the product's
# own `projectiond` FUSE daemon, G22 measures a naive rclone/WebDAV mount. Both share the same ~50-entry
# synthetic corpus, the same three digest-pinned media servers, and the same observer (`concurrent-scan`).
# This harness runs THREE frontends against THE SAME generated corpus and THE SAME three manufactured provider
# failures, so the frontends are compared on outage behaviour rather than on prose.
#
# THE THREE ARMS (Phase 2b design deviation note, recorded 2026-08-07):
#
#   ARM A (projectiond-FUSE): fakerange in RESOLVER mode with a bearer credential -> ONE projectiond FUSE
#                             daemon -> three media servers. This is G18's topology, plus a token file so a
#                             credential-rotation round is measurable.
#   ARM B (rclone off):       fakewebdav -> ONE rclone mount, --vfs-cache-mode off -> the same three media
#                             servers. This is G22's topology, unchanged.
#   ARM C (rclone full):      the same as B, with --vfs-cache-mode full. `mount2` is a hidden alias of
#                             `mount` in the pinned rclone v1.71.1, so the second rclone arm is the OTHER
#                             cache policy that actually differs in a media-read workload.
#
# Each arm is assembled from the EXISTING gates' own commands — the same register, publish, drive, jellyfin,
# plex, emby drivers, the same endpoints, the same observer — so a difference between arms is a difference
# between frontends and never between observers. ONE frontend per arm (design deviation note 2): the G18/G22
# observer already attributes per server through each server's own scan and its own catalogue document.
#
# THE THREE MANUFACTURED FAILURES, IDENTICAL ACROSS ARMS (design deviation note 3):
#
#   R1 PROVIDER STALL. The endpoint is told to hold one registered object's ranged reads (POST /control/hold)
#      — the same barrier object the concurrent-scan rendezvous uses. A full read of that object through the
#      frontend is then a playback read that must reach the provider. It FAILS, or is served from a cache that
#      should not have it — the outcome is RECORDED, not assumed. Recovery: the hold is released and the same
#      read must succeed with the right bytes.
#   R2 CREDENTIAL ROTATION. The endpoint is given a NEW bearer token and restarted; the frontend still holds
#      the old one. A read that must reach the resolver fails. Recovery is per-frontend and is MEASURED:
#      rclone re-reads its token on every request (a file rewrite takes effect at once); the daemon reloads
#      its secret only when a resolution is refused (a file rewrite converges on the following read).
#   R3 FRONTEND RESTART. The daemon (arm A) or the mount client (arms B/C) is restarted over the same
#      mountpoint. The namespace must come back, and a warm re-scan must settle with the same identities.
#      Time-to-ready is recorded.
#
# WHY EACH FAILURE READ MUST REACH THE WIRE, OR THE ROUND MEASURES NOTHING. R1 reads the 94 MiB barrier: the
# daemon's probe cache is bounded below that, and on arm B (cache off) no cache can hold it. R2 reads a NEWLY
# PUBLISHED object on arm A (nothing can have cached a byte the daemon has never served) and the canary on
# arms B/C (outside the library root, never read through the mount, and the /dav path refuses an
# unauthenticated request by construction).
#
# WHAT THIS IS NOT. It is not an acceptance gate and it adds no pass/fail to the plan: the existing gates'
# own assertions still run inside each arm — window, telemetry, cold-window where it applies, verify-corpus,
# the leak searches — and THIS file adds only the three manufactured failures and the comparison that reads
# them. A Docker Desktop pass is not Linux closure and closes none of G7-G13, G18 or G22 on its own.
#
# EVERYTHING IS BOUNDED. Every readiness probe, read, scan and wait has a hard deadline; a hang fails the run
# rather than occupying the machine.
set -Eeuo pipefail
# shellcheck source=deploy/projection-gate-cleanup.sh
. "$(cd "$(dirname "$0")" && pwd)/projection-gate-cleanup.sh"

export MSYS_NO_PATHCONV=1

# THE SKIP STATUS, WHICH THIS HARNESS USED TO REFERENCE WITHOUT EVER DEFINING.
#
# `$GATE_SKIP_STATUS` appeared twice — in the "no /dev/fuse" message and in the `exit` beneath it — and was
# assigned nowhere. Under `set -u` that is not a wrong number, it is an ABORT: on any host without /dev/fuse
# reachable from a container the harness died with `GATE_SKIP_STATUS: unbound variable` and exit 1, having
# printed nothing about why. 1 is the status this repository reserves for a gate that RAN AND FAILED, so the
# one contract the skip exists to honour — 77 and never anything else — was inverted on exactly the hosts the
# skip is for, which includes every Docker Desktop machine without the device.
GATE_SKIP_STATUS="${GATE_SKIP_STATUS:-77}"

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
GO_IMAGE="golang:1.26.5-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
RCLONE_IMAGE="rclone/rclone@sha256:d5971950c2b370fb04dd3292541b5bda6d9103143fd7e345aeb435a399388afc"
# THE MEDIA GENERATOR IS JELLYFIN'S ffmpeg BECAUSE THAT IMAGE IS ALREADY PINNED AND PULLED BY G18. The corpus
# is tiny, valid, individually distinct media; nothing in this harness decodes it.
GENERATOR_IMAGE="jellyfin/jellyfin@sha256:7ae36aab93ef9b6aaff02b37f8bb23df84bb2d7a3f6054ec8fc466072a648ce2"
GENERATOR_FFMPEG="/usr/lib/jellyfin-ffmpeg/ffmpeg"
JELLYFIN_IMAGE="$GENERATOR_IMAGE"
PLEX_IMAGE="plexinc/pms-docker@sha256:a2b03d75aa16f422488c692935cab476d966b75f2af3c93bb6d910c6051906f5"
EMBY_IMAGE="emby/embyserver@sha256:734a6f03c7c783a9e566b08d09a2b6376f41229ff29f032a7e00302e0be98f8a"

COMPOSE_FILE="docker-compose.projection-multi-frontend.yml"
NETWORK="projection-multi-frontend-comparison-$$"
PG_PORT="${PROJECTION_MULTI_FRONTEND_GATE_PG_PORT:-5515}"

# ONE PORT PER ARM PER SERVICE, IN A BLOCK NO OTHER GATE CLAIMS.
#
# THIS COMMENT USED TO SAY "no other gate can collide" WHILE THE BLOCK BELOW WAS G22'S OWN. The defaults were
# 8130/8131/8132/32530/5573 — five ports held by `deploy/projection-rclone-comparison-gate.sh`, and 8130 also
# by `deploy/projection-real-provider-gate.sh`. G22 is precisely the gate an operator runs BESIDE this one,
# because this harness exists to extend its comparison; the first person to run both at once would have got a
# port-in-use failure from the second, or worse, an arm quietly talking to the other gate's endpoint. The
# claim is now true rather than merely written: 8170-8175, 32550-32551 and 5576 appear in no other gate, and
# `test/projection-multi-frontend.ts` fails if that stops being so.
#
# The daemon's status surface binds loopback inside its OWN container namespace, so it needs no host port.
PD_RANGE_PORT="${PROJECTION_MULTI_FRONTEND_PD_RANGE_PORT:-8170}"
PD_JF_PORT="${PROJECTION_MULTI_FRONTEND_PD_JF_PORT:-8171}"
PD_EMBY_PORT="${PROJECTION_MULTI_FRONTEND_PD_EMBY_PORT:-8172}"
PD_PLEX_PORT="${PROJECTION_MULTI_FRONTEND_PD_PLEX_PORT:-32550}"
RC_DAV_PORT="${PROJECTION_MULTI_FRONTEND_RC_DAV_PORT:-8173}"
RC_JF_PORT="${PROJECTION_MULTI_FRONTEND_RC_JF_PORT:-8174}"
RC_EMBY_PORT="${PROJECTION_MULTI_FRONTEND_RC_EMBY_PORT:-8175}"
RC_PLEX_PORT="${PROJECTION_MULTI_FRONTEND_RC_PLEX_PORT:-32551}"
RC_RC_PORT="${PROJECTION_MULTI_FRONTEND_RC_RC_PORT:-5576}"
DAEMON_STATUS_PORT=9099

# EVERY CONTAINER NAME CARRIES THIS SHELL'S PID, so a second copy of this harness cannot collide with it.
# The two rclone arms reuse the same name templates because they run sequentially.
PD_RANGE_CONTAINER="projection-mf-pd-range-$$"
PD_MOUNT_CONTAINER="projection-mf-pd-mount-$$"
PD_JF_CONTAINER="projection-mf-pd-jellyfin-$$"
PD_PLEX_CONTAINER="projection-mf-pd-plex-$$"
PD_EMBY_CONTAINER="projection-mf-pd-emby-$$"
RC_DAV_CONTAINER="projection-mf-rc-dav-$$"
RC_MOUNT_CONTAINER="projection-mf-rc-mount-$$"
RC_JF_CONTAINER="projection-mf-rc-jellyfin-$$"
RC_PLEX_CONTAINER="projection-mf-rc-plex-$$"
RC_EMBY_CONTAINER="projection-mf-rc-emby-$$"

# TWO SPELLINGS OF ONE DIRECTORY: WORK is absolute and is what Docker bind mounts name, and it lives beside
# the repository because bind propagation needs a shared host mount; REL is relative and is what node and tsx
# are given, because an MSYS absolute path is not something a Windows node binary can open. The CORPUS is
# generated ONCE and served by all three arms' endpoints, so a comparison is between frontends and never
# between corpora. Each arm's subdirectory of WORK holds its own mount, manifest, caches, secrets and out
# directory, and is removed with the run.
GATE_ROOT="$PWD/.projection-multi-frontend-comparison-gate"
REL=".projection-multi-frontend-comparison-gate/run-$$"
WORK="$GATE_ROOT/run-$$"
ARM_A_REL="$REL/arm-a"
ARM_B_REL="$REL/arm-b"
ARM_C_REL="$REL/arm-c"
ARM_A_OUT="$WORK/arm-a/out"
ARM_B_OUT="$WORK/arm-b/out"
ARM_C_OUT="$WORK/arm-c/out"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_MULTI_FRONTEND_GATE_PG_PORT="$PG_PORT"

# THE SHARED CORPUS, AND THE SHARED CONSTANTS ALL THREE ARMS SERVE. The barrier file's name starts with "Aaa"
# so its projected path sorts first in the namespace: that is what makes the scan rendezvous land inside the
# hold's bounded window instead of after it (the same load-bearing name G18 uses).
SEED_FILE="Projection Seed (2026).mp4"
SEED_PATH="Movies/Projection Seed (2026)/$SEED_FILE"
SEED_DAV="/Movies/Projection Seed (2026)/$SEED_FILE"
SEED_REF="obj-projection-seed"
SEED_MTIME="2026-06-01T10:00:00.000Z"
CANARY_FILE="projection-canary.bin"
CANARY_REF="obj-projection-canary"
CANARY_SIZE=262144
LARGE_FILE="Aaa Projection Barrier (2026).mp4"
LARGE_REF="obj-projection-barrier"
LARGE_MIN_BYTES=98566144
LARGE_PATH="Movies/${LARGE_FILE%.mp4}/$LARGE_FILE"
LARGE_DAV_PATH="/Movies/${LARGE_FILE%.mp4}/$LARGE_FILE"
# THE ROTATED OBJECT: served by the endpoints from the first instant, but OUTSIDE the library root and NOT in
# the manifest until R2 publishes it. It is what R2 reads on arm A, because it is the one object nothing can
# have cached a byte of.
ROT_FILE="Projection Rotated (2026).mp4"
ROT_REF="obj-projection-rotated"
ROT_PATH="Rotated/$ROT_FILE"
ROT_DAV_PATH="/Rotated/$ROT_FILE"
ROT_ITEM="f0000000-0000-4000-8000-000000000099"
CORPUS_COUNT=48
CORPUS_LOCAL=6
# THE HOLD BACKSTOP, THE SAME 4,500 ms BOTH SOURCE GATES USE. R1's stalled read fails when this backstop
# fires, which is strictly under the daemon's 10 s first-byte deadline and the mount client's 30 s IO
# deadline, so no round can attribute a failure to a deadline this harness imposed.
HOLD_MAX="4500ms"
# A HIGH-ENTROPY PER-RUN LEASE MARKER, MINTED HERE, WHICH IS WHAT THE LEAK SEARCHES LOOK FOR BY EXACT VALUE.
LEASE_MARKER="PJDLEASE$(node -e "console.log(require('node:crypto').randomBytes(16).toString('hex'))" | tr -d ' \r\n')"

# ----------------------------------------------------------------------------------------------------------
# THE HELPERS. `drive` and `plain` are rebound per arm to that arm's CLI: the three-server CLI for arm A, the
# rclone comparison CLI for arms B/C. Everything above and below this line is CLI-agnostic.
# ----------------------------------------------------------------------------------------------------------
step() { echo; echo "=== $* ==="; }
die()  { echo "GATE FAILED: $*" >&2; exit 1; }
logs_tail() { docker logs --tail 40 "$1" 2>&1 | tail -40 >&2 || true; }
field()     { node "$REL/out/jq.cjs" "$1"; }
digest()    { node "$REL/out/sha.cjs" "$1"; }
publish()   { npx tsx src/ops/projection-publish-cli.ts --manifest-dir "$ARM_REL/manifest" "$@"; }
register()  { npx tsx src/ops/projection-register-cli.ts "$@"; }
jellyfin()  { npx tsx src/ops/projection-jellyfin-dataplane-cli.ts "$@"; }
plex()      { npx tsx src/ops/projection-plex-dataplane-cli.ts "$@"; }
emby()      { npx tsx src/ops/projection-emby-dataplane-cli.ts "$@"; }
ffmpeg_run() {
  docker run --rm --entrypoint "$GENERATOR_FFMPEG" -v "$WORK:/work" "$GENERATOR_IMAGE" "$@"
}
drive() { npx tsx "$ARM_CLI" "$@" --results "$ARM_REL/out/results.json"; }
plain() { npx tsx "$ARM_CLI" "$@"; }

# A LIVENESS PROBE MUST NOT BE PROVIDER TRAFFIC, and a readiness loop that sends a ranged GET would be a real
# object read that increments the endpoint's counters and serves bytes. So liveness is `/counters`, which the
# endpoints deliberately do not count, and RANGE SEMANTICS are checked exactly once, afterwards, against the
# canary.
wait_ready() {
  local container="$1" url="$2" n=0
  while [ "$n" -lt 240 ]; do
    # EVERY ARM'S ENDPOINT EMITS objects.json INTO THE SHARED $WORK/out (never into the arm's own out
    # directory), so the emit guard and the probe volume come from the shared out directory.
    if [ -f "$WORK/out/objects.json" ] && docker run --rm --network "$NETWORK" \
         -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
         sh /probe/alive.sh "$url" >/dev/null 2>&1; then
      return 0
    fi
    n=$((n + 1)); sleep 1
  done
  logs_tail "$container"; die "the endpoint never answered"
}

# WAIT UNTIL A PROJECTED PATH IS VISIBLE TO A SIBLING CONTAINER. A FUSE namespace that never appears is the
# first and most expensive failure mode of every arm, so it is waited out with a hard deadline rather than
# assumed.
await_path() {
  local target="$1" attempts="${2:-240}" n=0
  while [ "$n" -lt "$attempts" ]; do
    if docker run --rm -v "$ARM_MNT:/mnt:rslave" "$VERIFY_IMAGE" \
         test -f "/mnt/$target" >/dev/null 2>&1; then
      return 0
    fi
    n=$((n + 1)); sleep 0.5
  done
  return 1
}

# THE MIRROR OF await_path: WAIT FOR THE NAMESPACE TO GO AWAY, and read the PROBE's verdict rather than
# docker's.
#
# BOTH ARMS' TEARDOWN CHECKS USED TO BE `if ! docker run ... test -d /mnt/Movies; then gone=1`, and that
# cannot fail for the reason it states. `docker run` reports its OWN refusals — an image it cannot pull, a
# bind it cannot make, a daemon that has gone away — as 125/126/127 BEFORE `test` executes an instruction, and
# the leading `!` turns every one of them into "the namespace is gone". The step whose whole subject is
# whether a FUSE mount was left attached to the host therefore passed hardest exactly when nothing had been
# looked at, and "arm A stopped; the namespace is gone" was printed over a mountpoint still there.
#
# It is the same defect the Phase 2 mount-hardening tranche removed from the serve-death and sustained-outage
# gates, and the same one the Phase 1 review found four times in the TorBox gate's read-only refusals. The
# answer is the same: the probe prints one of two tokens, the loop reads the token, and a run that produced
# NEITHER is a third outcome that is refused rather than counted as either.
namespace_gone() {
  local what="$1" attempts="${2:-60}" n=0 verdict="" ran=0
  while [ "$n" -lt "$attempts" ]; do
    verdict="$(docker run --rm -v "$ARM_MNT:/mnt:rslave" "$VERIFY_IMAGE" \
      sh -c 'test -d /mnt/Movies && echo ns:present || echo ns:absent' 2>/dev/null || true)"
    case "$verdict" in
      *ns:absent*)  echo "  the namespace is no longer visible after $what stopped"; return 0 ;;
      *ns:present*) ran=1 ;;
      *) ;;   # docker refused the probe; recorded below, never as evidence either way.
    esac
    n=$((n + 1)); sleep 0.5
  done
  if [ "$ran" -eq 0 ]; then
    die "the namespace probe never ran in $attempts attempts (docker refused it every time), so nothing was" \
        "observed about the mount $what left behind: last output '$verdict'"
  fi
  return 1
}

# RESOURCE ACCOUNTING FOR THE FRONTEND CONTAINER ONLY. `docker stats --no-stream` is sampled once a second
# into a TSV while the arm's measurement runs; resources.cjs turns the series into averages and peaks. A
# comparison between frontends has to say which container it measured, and on every arm that container is the
# frontend — the daemon on arm A, the mount client on arms B/C — never the media servers.
resource_sample() {
  : > "$ARM_OUT/cpu-ram.tsv"
  ( while true; do
      docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' "$FRONTEND_CONTAINER" \
        >> "$ARM_OUT/cpu-ram.tsv" 2>/dev/null
      sleep 1
    done ) &
  SAMPLER_PID=$!
}
resource_sample_stop() {
  kill "$SAMPLER_PID" >/dev/null 2>&1 || true
  wait "$SAMPLER_PID" >/dev/null 2>&1 || true
  node "$REL/out/resources.cjs" "$ARM_REL/out/cpu-ram.tsv" "$ARM_REL/out/resources.json" "$FRONTEND_CONTAINER"
}

cleanup() {
  # THE MEDIA SERVERS FIRST, ALL THREE PER ARM. Each holds open handles on the mount, and a FUSE mount with a
  # live reader does not unmount cleanly — leaving one behind is how the NEXT run inherits a stale namespace.
  docker rm -f "$PD_PLEX_CONTAINER" "$PD_JF_CONTAINER" "$PD_EMBY_CONTAINER" \
    "$RC_PLEX_CONTAINER" "$RC_JF_CONTAINER" "$RC_EMBY_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$PD_MOUNT_CONTAINER" "$PD_RANGE_CONTAINER" \
    "$RC_MOUNT_CONTAINER" "$RC_DAV_CONTAINER" >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  # AND THE MOUNTS AND THE RUN DIRECTORY, THROUGH THE SHARED HELPER — which this harness did not call at all.
  #
  # Removing the containers is not removing the mounts. THREE arms each stand up a FUSE mount under
  # `$WORK/<arm>/mnt` with three media servers holding handles on it, and killing the container that served
  # one leaves the mountpoint attached to the HOST: the next run inherits a corpse, and `rm -rf` on a
  # directory with a dead FUSE mount under it does not do what it looks like it does. Every other gate in
  # this repository routes its teardown through `projection_gate_cleanup_run`, which unmounts depth-first
  # from a privileged container before it deletes, and then REPORTS what is still attached — because a
  # cleanup that cannot say whether it worked is indistinguishable from one that did not run.
  #
  # The report is a report and never an assertion: this is an EXIT trap, and a non-zero return here would
  # overwrite the harness's own status.
  if [ -n "${WORK:-}" ]; then
    projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true
    projection_gate_report_cleanliness "$GATE_ROOT" "$WORK" || true
  fi
}
trap cleanup EXIT

# ----------------------------------------------------------------------------------------------------------
step "G1: the network the three arms share"
# ----------------------------------------------------------------------------------------------------------
docker network create "$NETWORK" >/dev/null

# ----------------------------------------------------------------------------------------------------------
step "G2: /dev/fuse must actually be reachable from a container, or every arm measures nothing"
# ----------------------------------------------------------------------------------------------------------
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no /dev/fuse is reachable from a container on this host." >&2
  echo "      The MULTI-FRONTEND COMPARISON measured NOTHING here. This run is not a pass and must not be" >&2
  echo "      reported as one." >&2
  exit "$GATE_SKIP_STATUS"
fi
echo "  /dev/fuse is reachable from a container"

# ----------------------------------------------------------------------------------------------------------
step "G3: the production projectiond image"
# ----------------------------------------------------------------------------------------------------------
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -t "$IMAGE" ./projectiond
fi
echo "  $IMAGE present"

# ----------------------------------------------------------------------------------------------------------
step "minting the endpoint credential, into a file and never into an argument"
# ----------------------------------------------------------------------------------------------------------
# A NAIVE MOUNT STILL AUTHENTICATES, and so does the resolver this harness gives arm A — an open endpoint
# would make R2 a round about nothing. The credential is high-entropy and minted per run, it travels in a file
# (mode 0644, the same idiom G22 documents for its token), and every leak search below searches for it by
# exact value. The rclone client reads it through its own bearer-token-command hook; the endpoints through
# --token-file.
# `$WORK/out` IS CREATED HERE, AND IT WAS NOT CREATED ANYWHERE. Every shared program below is written into
# it — `jq.cjs`, `sha.cjs`, `corpus.cjs`, `probe.sh`, `leakcheck.sh` and the rest — and not one `mkdir` in
# this harness ever made the directory. Under `set -e` the first `cat > "$REL/out/jq.cjs"` aborted the run,
# before an endpoint started or an arm existed, on every host.
mkdir -p "$WORK/secret" "$WORK/out"

# AND sha.cjs IS WRITTEN BEFORE THE FIRST THING THAT RUNS IT, which is the other half of the same mistake.
# The corpus step below calls `digest`, and `digest` is `node "$REL/out/sha.cjs"` — but the program was
# written two hundred lines further down, so the corpus step died with MODULE_NOT_FOUND. A program has to
# exist before the helper that runs it is called, and the shortest way to keep that true is for the write to
# sit next to the directory that holds it.
cat > "$REL/out/sha.cjs" <<'SHA'
// The sha256 of a file, STREAMED — the barrier fixture is 94 MiB and this program is run on it, so reading
// it whole into a buffer to hash it is a real cost rather than a style preference.
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const hash = createHash('sha256');
createReadStream(process.argv[2])
  .on('data', (chunk) => hash.update(chunk))
  .on('end', () => console.log(hash.digest('hex')));
SHA

DAV_TOKEN="PJDDAV$(node -e "console.log(require('node:crypto').randomBytes(16).toString('hex'))" | tr -d ' \r\n')"
printf '%s' "$DAV_TOKEN" > "$WORK/secret/token"
cat > "$WORK/secret/token.sh" <<'TOKENSH'
cat /secret/token
TOKENSH
chmod 644 "$WORK/secret/token" "$WORK/secret/token.sh"
chmod 755 "$WORK/secret"
test "${#DAV_TOKEN}" -ge 8 \
  || die "the endpoint credential is under 8 bytes, so a search for it could not be decisive"

# ----------------------------------------------------------------------------------------------------------
step "generating legal synthetic media on this machine — THE SAME CORPUS THE PRODUCT'S GATES PUBLISH"
# ----------------------------------------------------------------------------------------------------------
# NOTHING IS DOWNLOADED AND NOTHING IS COMMITTED. `testsrc` is ffmpeg's own generated test pattern and `sine`
# is a generated tone; both are produced here and thrown away with the run directory. The parameters below are
# character-for-character the ones in `deploy/projection-rclone-comparison-gate.sh`; an offline test compares
# the two scripts rather than trusting this comment.
mkdir -p "$WORK/media/seed" "$WORK/media/canary" "$WORK/media/large" "$WORK/remote"
ffmpeg_run -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc=size=128x96:rate=15:duration=3" \
  -f lavfi -i "sine=frequency=311:duration=3" \
  -c:v mpeg4 -qscale:v 5 -c:a aac -b:a 32k -shortest -movflags +faststart "/work/media/seed/$SEED_FILE"
SEED_SIZE="$(wc -c < "$WORK/media/seed/$SEED_FILE" | tr -d ' ')"
SEED_SHA="$(digest "$REL/media/seed/$SEED_FILE")"
echo "  the seed entry is $SEED_SIZE bytes"

# THE CANARY: A REGISTERED OBJECT OUTSIDE THE LIBRARY ROOT, served from a path no library root contains,
# never visible to a media server. Its name carries no space because it is reached by busybox wget in the
# readiness probe, which does not handle the percent-encoding the corpus deliberately exercises.
head -c 262144 /dev/urandom > "$WORK/remote/$CANARY_FILE"

# THE LARGE FIXTURE, WHICH IS ALSO THE BARRIER OBJECT. A hundred-megabyte object is where a client's
# read-ahead and chunk sizing become visible in the numbers; and its projected path sorts first, which is what
# makes the scan rendezvous land inside the hold's bounded window.
ffmpeg_run -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=640x480:rate=24:duration=105" \
  -f lavfi -i "sine=frequency=277:duration=105" \
  -c:v mpeg4 -b:v 8M -minrate 8M -maxrate 8M -bufsize 16M \
  -c:a aac -b:a 64k -shortest -movflags +faststart "/work/remote/$LARGE_FILE"
LARGE_SIZE="$(wc -c < "$WORK/remote/$LARGE_FILE" | tr -d ' ')"
test "$LARGE_SIZE" -ge "$LARGE_MIN_BYTES" \
  || die "the large fixture is $LARGE_SIZE bytes, under the size the product's own corpus generates"
echo "  the barrier object is $LARGE_SIZE bytes"

# THE REST OF THE ~50-ENTRY CORPUS. Same counts, same generator, same everything as the product's gates. The
# generator is a FILE, not a multi-line `-c '...'` argument, because an unreadable line is one a "does this
# region contain X" gate answers "no" for. The six entries the product publishes as LOCAL passthrough live in
# $WORK/media and are served directly by the daemon on arm A; everything else lives in $WORK/remote and is
# served by every arm's endpoint.
cat > "$WORK/out-gen-corpus.sh" <<'GENCORPUS'
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
docker run --rm --entrypoint /bin/sh -v "$WORK:/work" "$GENERATOR_IMAGE" \
  /work/out-gen-corpus.sh "$CORPUS_COUNT" "$CORPUS_LOCAL" "$GENERATOR_FFMPEG"

# ----------------------------------------------------------------------------------------------------------
# THE SHARED NODE PROGRAMS. Each is written once into $REL/out and read by every arm.
# ----------------------------------------------------------------------------------------------------------
cat > "$REL/out/jq.cjs" <<'JQ'
// A single-field JSON extractor: reads one top-level field from a document on stdin. This is the JSON shape
// every program here writes, and a one-field extractor is all the shell ever needs.
const { readFileSync } = require('node:fs');
const key = process.argv[2];
const doc = JSON.parse(readFileSync(0, 'utf8'));
const value = key.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), doc);
if (value === undefined) process.exit(1);
console.log(String(value));
JQ
# sha.cjs is NOT written here. It is written beside `mkdir -p "$WORK/out"` above, because the corpus step
# between there and here calls `digest`, which runs it.
cat > "$REL/out/resources.cjs" <<'RESOURCES'
// Turns a docker-stats TSV series (name, cpu%, mem-used) into the average/peak CPU and RAM figures the
// comparison reads. A line with no separator is a moment the stats feed returned nothing; it is skipped, not
// counted as a zero — a zero-CPU sample would pull a frontend's average down for a reason that has nothing to
// do with the frontend.
const { readFileSync, writeFileSync } = require('node:fs');
const [, , tsvPath, outPath, expectedName] = process.argv;
const rows = readFileSync(tsvPath, 'utf8').split(/\r?\n/).filter(Boolean);
const cpus = [];
const mems = [];
for (const line of rows) {
  const [name, cpu, mem] = line.split('\t');
  if (name !== expectedName) continue;
  const cpuPct = parseFloat(cpu);
  if (Number.isFinite(cpuPct)) cpus.push(cpuPct);
  const memMb = parseFloat(mem);
  if (Number.isFinite(memMb)) mems.push(memMb);
}
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const peak = (a) => (a.length ? Math.max(...a) : 0);
writeFileSync(outPath, `${JSON.stringify({
  samples: cpus.length,
  cpuAvgPct: Number(avg(cpus).toFixed(2)),
  cpuPeakPct: Number(peak(cpus).toFixed(2)),
  memAvgMb: Number(avg(mems).toFixed(1)),
  memPeakMb: Number(peak(mems).toFixed(1)),
}, null, 2)}\n`);
RESOURCES
# THE ROTATED OBJECT, MINTED HERE FOR ARM A'S R2 ROUND. It is a tiny valid mp4, served by arm A's endpoint
# from the first instant but NOT in the manifest until R2 publishes it, so R2 reads the one object nothing
# can have cached a byte of. Arms B/C rotate against the canary instead, which is outside the library root.
ffmpeg_run -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc=size=128x96:rate=15:duration=2" \
  -f lavfi -i "sine=frequency=233:duration=2" \
  -c:v mpeg4 -qscale:v 5 -c:a aac -b:a 32k -shortest -movflags +faststart "/work/remote/$ROT_FILE"
ROT_SIZE="$(wc -c < "$WORK/remote/$ROT_FILE" | tr -d ' ')"
ROT_SHA="$(digest "$REL/remote/$ROT_FILE")"
# THE CREDENTIAL THE ENDPOINT IS ROTATED TO IN R2. Both the original and this value are searched for by the
# leak checks, because both were in force during this run.
ROTATED_TOKEN="PJDDAV$(node -e "console.log(require('node:crypto').randomBytes(16).toString('hex'))" | tr -d ' \r\n')"

# ----------------------------------------------------------------------------------------------------------
step "the PostgreSQL every arm's control plane shares"
# ----------------------------------------------------------------------------------------------------------
# It takes its own project name, its own port, and throwaway storage, for the same reason G18's sixth compose
# file says it does: a previous run, or another gate, or an installation, must not be able to lend this run
# state.
# THE COMPOSE FILE IS COMMITTED, NOT GENERATED, and that is the convention every other gate here follows.
#
# This harness used to write `docker-compose.projection-multi-frontend.yml` into the repository root through
# a heredoc on every run, and never remove it — so a run left an untracked file in the working tree, and the
# only description of the shared Postgres lived buried inside an 1,800-line script where no reviewer reads a
# compose file and no diff shows it changing. Every `docker-compose.projection-*.yml` the other gates use is
# a tracked file they merely name; this one is now too. The `${...:-5515}` in it is resolved by docker
# compose itself, so the behaviour is identical to the generated version.
test -f "$COMPOSE_FILE" || die "the compose file $COMPOSE_FILE is missing from the repository"
docker compose -f "$COMPOSE_FILE" config -q
docker compose -f "$COMPOSE_FILE" up -d --wait postgres
# AND IT IS MIGRATED, WHICH THIS HARNESS NEVER DID.
#
# The compose file brings up an EMPTY database owned by `postgres`. The `app` role the control plane connects
# as, and every table it writes, are created by the migration — so without this line the very first
# `register` died with `projection-register: password authentication failed for user "app"`, a message that
# points at credentials when the truth is that the role had never been created. Every gate in this
# repository that touches the control plane runs this immediately after Postgres reports healthy; this one
# is now one of them.
npx tsx src/ops/migrate-cli.ts
echo "  postgres is ready and migrated"

# ----------------------------------------------------------------------------------------------------------
# THE SHARED NODE PROGRAMS. Each is written once into $REL/out and read by every arm. The corpus.cjs walk is
# character-for-character the one G18 ships (an offline test compares them); it derives the register
# document, the expectation document and the byte totals from ONE walk, so a gate can never assert a corpus
# that differs from the one it published.
# ----------------------------------------------------------------------------------------------------------
cat > "$REL/out/corpus.cjs" <<'CORPUS'
// THE SHARED CORPUS, DESCRIBED ONCE, FROM THE FILES THAT WERE ACTUALLY GENERATED.
//
// It emits three documents from one walk: what to register, what to expect, and the byte totals the scan
// budget needs as its denominators. Deriving all three from the same walk is what stops the gate from
// asserting a corpus that differs from the one it published — and on THIS gate it does more than that,
// because ONE expectation document is what all three media servers are held against. Three servers matched
// against three separately derived expectations would not be a shared-corpus claim at all.
//
// EVERY REMOTE ENTRY IS CROSS-CHECKED AGAINST THE ENDPOINT before it is registered. If the endpoint's own
// size and digest disagree with what this walk found, the gate would be publishing a manifest describing one
// byte stream and reading another, and every later comparison would be measuring the wrong thing.
const { readFileSync, writeFileSync, statSync } = require('node:fs');
const { createHash } = require('node:crypto');
const [, , work, totalRaw, localRaw, largeFile, largeRef] = process.argv;
const total = Number(totalRaw);
const localCount = Number(localRaw);
const objects = JSON.parse(readFileSync(`${work}/out/objects.json`, 'utf8'));
const byRef = new Map(objects.map((object) => [object.ref, object]));

const versions = [];
const entries = [];
const expected = [];
let smallRemoteBytes = 0;
let largeRemoteBytes = 0;
let localBytes = 0;

// THE BARRIER OBJECT IS FIRST, AND IT IS FIRST FOR TWO INDEPENDENT REASONS. Its projected path sorts before
// every other entry's, so a scanner walking the namespace reaches it early rather than at the end — which is
// what makes the rendezvous happen inside the hold's bounded window instead of after it. And it is the large
// fixture: a whole-object read of it is where a client's read-ahead and chunk sizing become visible.
const describe = (ref, onDisk, key, path, versionKey, source) => {
  const bytes = readFileSync(onDisk);
  const size = statSync(onDisk).size;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let probes = [];
  if (ref !== null) {
    const object = byRef.get(ref);
    if (!object) { console.error(`the endpoint is not serving ${ref}`); process.exit(1); }
    if (object.size !== size || object.sha256 !== sha256) {
      console.error(`the endpoint and the file disagree about ${ref}`);
      process.exit(1);
    }
    probes = object.probes.map((probe) => `${probe.position}:${probe.offset}:${probe.length}:${probe.sha256}`);
  }
  versions.push({ key: versionKey, size, mtime: '2026-06-01T10:00:00.000Z', probes });
  entries.push({ item: source.item, versionKey, path, sources: [source.source] });
  expected.push({ key, sizeBytes: size, sha256, kind: ref === null ? 'local' : 'http-range',
    ...(source.anchor ? { anchor: true } : {}) });
  return size;
};

largeRemoteBytes += describe(
  largeRef, `${work}/remote/${largeFile}`, largeFile,
  `Movies/${largeFile.replace(/\.mp4$/, '')}/${largeFile}`, 'corpus-barrier',
  { item: 'a0000000-0000-4000-8000-000000000001', source: `http-range:vault:${largeRef}`, anchor: true },
);

for (let index = 1; index <= total; index += 1) {
  const n = String(index).padStart(2, '0');
  const file = `Projection Corpus ${n} (2026).mp4`;
  const local = index > total - localCount;
  const ref = local ? null : `obj-projection-corpus-${n}`;
  const size = describe(
    ref, `${work}/${local ? 'media' : 'remote'}/${file}`, file,
    `Movies/Projection Corpus ${n} (2026)/${file}`, `corpus-${n}`,
    {
      item: `f0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      source: local ? `local:media:${file}` : `http-range:vault:${ref}`,
    },
  );
  if (local) localBytes += size; else smallRemoteBytes += size;
}

writeFileSync(`${work}/out/corpus-register.json`, `${JSON.stringify({ versions, entries }, null, 2)}\n`);
writeFileSync(`${work}/out/corpus-expected.json`, `${JSON.stringify(expected, null, 2)}\n`);
writeFileSync(`${work}/out/corpus-totals.json`, `${JSON.stringify({
  entries: expected.length,
  localEntries: localCount,
  remoteEntries: expected.length - localCount,
  smallRemoteBytes,
  largeRemoteBytes,
  localBytes,
}, null, 2)}\n`);
console.log(String(expected.length));
CORPUS
cat > "$REL/out/seed-expect.cjs" <<'SEEDEXPECT'
// The seed-only expectation, which exists for exactly one reason: Plex scans a section the moment it is
// created and nothing in its API asks it not to, so the gate needs a deterministic point at which that
// unavoidable creation scan is OVER before it publishes the corpus.
const { writeFileSync } = require('node:fs');
const [, , out, key, size, sha] = process.argv;
const entry = { key, sizeBytes: Number(size), sha256: sha, kind: 'local', anchor: true };
writeFileSync(out, `${JSON.stringify([entry], null, 2)}
`);
SEEDEXPECT
cat > "$REL/out/expect.cjs" <<'EXPECT'
// Merge the seed entry into the corpus expectation, so ONE document describes the whole namespace all three
// servers are held against.
const { readFileSync, writeFileSync } = require('node:fs');
const [, , out, base, key, size, sha] = process.argv;
const entries = JSON.parse(readFileSync(base, 'utf8'));
entries.unshift({ key, sizeBytes: Number(size), sha256: sha, kind: 'local', anchor: true });
writeFileSync(out, `${JSON.stringify(entries, null, 2)}\n`);
console.log(String(entries.length));
EXPECT
cat > "$REL/out/objects.cjs" <<'OBJECTS'
// Extract ONE field from ONE entry of the endpoint's emitted objects.json, selected by ref. The shell uses it
// to hold the endpoint's own registration document against the file a fixture was generated from, before
// anything has read a byte through a mount.
const { readFileSync } = require('node:fs');
const [, , file, ref, key] = process.argv;
const doc = JSON.parse(readFileSync(file, 'utf8'));
const object = doc.find((entry) => entry.ref === ref);
if (object === undefined) process.exit(1);
console.log(String(object[key]));
OBJECTS
cat > "$REL/out/rounds.cjs" <<'ROUNDS'
// ONE ARM'S R1/R2/R3 OUTCOMES, WRITTEN AS THIS ARM'S OWN RECORD. The comparison at the end of the run reads
// three of these and puts them in one table, so the shape has to be identical across arms — which is why it
// is ONE program called twice rather than two copies of a program.
//
// IT IS A FILE RATHER THAN A `node -e '...'` BECAUSE THE REPOSITORY REFUSES THE LATTER. Both call sites used
// to inline this program in a multi-line single-quoted argument, and `test/custody-runtime-closure.ts` reads
// every shipped script under all three line endings: an embedded program is a program, and one that the
// shared reader cannot parse is one no test can ever check. Every other program in this harness is written
// through a QUOTED heredoc for the same reason — the shell expands nothing inside it, so what is read is
// what runs.
const { writeFileSync } = require('node:fs');
const [, , out, arm, r1Held, r1Ms, r2Attempt, r3Ms, resolutions] = process.argv;
writeFileSync(out, `${JSON.stringify({
  arm,
  r1: { stallBound: r1Held === 'true', stallMs: Number(r1Ms) },
  r2: { convergedOnRead: Number(r2Attempt) },
  r3: { readyMs: Number(r3Ms) },
  resolutions: Number(resolutions),
}, null, 2)}\n`);
ROUNDS

# ----------------------------------------------------------------------------------------------------------
# THE SMALL SHARED SHELL PROGRAMS, mounted into the pinned verifier image and run by every arm.
# ----------------------------------------------------------------------------------------------------------
cat > "$WORK/out/alive.sh" <<'ALIVE'
set -eu
wget -q -O /dev/null "$1"
ALIVE
cat > "$WORK/out/probe.sh" <<'PROBE'
set -eu
# THE CREDENTIAL ARRIVES AS AN ARGUMENT HERE, WHICH IS FINE: this probe is a control read of the endpoint,
# not a scan of the mount, and it is the only place either endpoint's token is ever passed to a container.
wget -S --header "Range: bytes=0-1023" --header "Authorization: Bearer $2" -O /dev/null "$1" 2>&1 \
  | grep -q "206 Partial Content"
PROBE
cat > "$WORK/out/fullread.sh" <<'FULLREAD'
set -eu
sha256sum "$1" | cut -d' ' -f1
FULLREAD
cat > "$WORK/out/resolveprobe.sh" <<'RESOLVEPROBE'
set -eu
# THE CREDENTIAL ON THE RANGE ENDPOINT GUARDS /resolve, AND NOTHING ELSE.
#
# Arm A's credential assertions used to probe `/direct/<ref>` with a wrong bearer token and expect a refusal.
# `/direct/` is UNAUTHENTICATED BY CONSTRUCTION — `handleDirect` calls `serveRange` with no auth check at all,
# because in direct mode the URL is the capability. Only `handleResolve` compares the Authorization header
# (`internal/fakeprovider/fakeprovider.go`). So the endpoint answered 206 to the wrong token, exactly as
# designed, and the harness died with "the endpoint served a ranged request with the wrong credential" — an
# accusation aimed at the one path that never made the promise.
#
# /resolve is also the path that MATTERS here: it is what the daemon calls in resolver mode, so it is what R2
# rotates. This probe prints its own verdict — `resolve:<status>` — so a container that never started is a
# third outcome rather than being read as a refusal.
out="$(wget -S --header "Authorization: Bearer $2" --header "Content-Type: application/json" \
  --post-data "{\"objectRef\":\"$3\"}" -O /dev/null "$1/resolve" 2>&1 || true)"
# THE CODE IS THE THREE DIGITS AFTER AN HTTP VERSION, wherever they appear. Taking `$2` of any line matching
# "HTTP/" picked up busybox's own diagnostic — `wget: server returned error: HTTP/1.1 401 Unauthorized` — and
# printed `resolve:server`, which the caller then correctly refused as "the probe never ran". Both the header
# line and that diagnostic carry the real status; matching the pattern rather than a column reads either.
code="$(printf '%s' "$out" | grep -oE 'HTTP/[0-9.]+ [0-9]{3}' | tail -1 | awk '{print $2}')"
echo "resolve:${code:-none}"
RESOLVEPROBE
cat > "$WORK/out/seekprobe.sh" <<'SEEKPROBE'
set -eu
target="$1"
block="$2"
# THREE READS, IN THIS ORDER, AND THE ORDER IS THE TEST. A FORWARD seek past the middle, then a BACKWARD seek
# all the way to the start — which is the transition a naive client is most likely to answer wrongly — and
# then the whole object. `dd`'s `skip` is a seek, and the block size is a whole number of 64 KiB units.
dd if="$target" bs=65536 skip="$block" count=1 2>/dev/null | sha256sum | cut -d' ' -f1
dd if="$target" bs=65536 count=1 2>/dev/null | sha256sum | cut -d' ' -f1
sha256sum "$target" | cut -d' ' -f1
SEEKPROBE
cat > "$WORK/out/leakcheck.sh" <<'LEAK'
# THE SEARCH BEHIND "NO PROVIDER ACCESS MATERIAL REACHED DISK", AND THE THREE WAYS IT PROVED NOTHING. Each was
# found by RUNNING this program in the gate's own digest-pinned image against fixtures, not by reading it:
#
#   - IT DISCARDED grep's ERRORS AND ITS EXIT STATUS ALIKE. `grep -rlF "$pattern" /scan 2>/dev/null` sends a
#     scan root that does not exist and a file that cannot be opened down the same path as a clean miss. A
#     zero that means "did not look" is indistinguishable from one that means "did not leak". busybox grep
#     exits 2 and writes a diagnostic for both, so both are hard failures.
#   - THE NEEDLE ARRIVED IN ARGV. Every call site passed the secret as a `docker run` argument, so it lived
#     in the host's process table and in `docker inspect .Config.Cmd`. The needles arrive as a FILE PATH.
#   - THE FAILURE PATH PRINTED THE SECRET AND THE FILES IT WAS FOUND IN. A hit now names the needle by its
#     INDEX; no needle and no path under the scan root is ever printed.
#
# WHAT IS REPORTED RATHER THAN REQUIRED, so that what is required can be trusted. The examined-file count is
# printed for every scan and is REQUIRED only at the minimum the caller passes.
set -eu
label="$1"
needles="$2"
minimum="${3:-1}"
root="${4:-/scan}"

refuse() { echo "leakcheck: $label: $1" >&2; exit 3; }

test -d "$root" \
  || refuse "the scan root is not a directory, so a clean result would mean the search never ran"
test -s "$needles" \
  || refuse "the needle list is missing or empty, so a clean result would mean nothing was searched for"

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

# A NEEDLE LIST THAT DOES NOT END IN A NEWLINE IS REFUSED. `wc -l` counts TERMINATORS and `read` drops an
# unterminated final record, so a one-line needle file with no trailing newline counts ZERO needles, runs ZERO
# searches, and then agrees with itself at zero. Command substitution strips trailing newlines, so an empty
# last byte IS the terminator.
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

# THE HOLD AND RELEASE CONTROLS, ON THE CONTROL SURFACE EVERY ENDPOINT EXPOSES. These are CONTROL, not
# traffic: neither endpoint counts them, exactly as it does not count /counters, and the control surface is
# the only way a gate outside the process can drive the barrier. The request comes from the pinned verifier
# image so it needs no curl and no credential handling.
control_hold()    { docker run --rm --network "$NETWORK" "$VERIFY_IMAGE" \
                      wget -q -O /dev/null --post-data= "http://${ENDPOINT_ALIAS}/control/hold/$1" \
                      || die "the endpoint did not accept a hold on $1"; }
control_release() { docker run --rm --network "$NETWORK" "$VERIFY_IMAGE" \
                      wget -q -O /dev/null --post-data= "http://${ENDPOINT_ALIAS}/control/release/$1" \
                      || die "the endpoint did not accept a release on $1"; }

# ----------------------------------------------------------------------------------------------------------
step "starting the endpoints, the daemon and the media servers for ARM A (projectiond-FUSE)"
# ----------------------------------------------------------------------------------------------------------
# `$WORK/arm-a/config.json` IS NOT IN THIS LIST, AND THAT IS THE FIX. It was, and `mkdir -p` on a path makes
# a DIRECTORY at it — so the daemon's configuration file was a directory, and the `cat > "$WORK/arm-a/config.json"`
# a few dozen lines below could not write to it. Arm A could not start, on any host.
mkdir -p "$WORK/arm-a/out" "$WORK/arm-a/manifest" "$WORK/arm-a/cache" "$WORK/arm-a/mnt" \
         "$WORK/arm-a/jf-config" "$WORK/arm-a/jf-cache" "$WORK/arm-a/emby-config" "$WORK/arm-a/plex-config" \
         "$WORK/arm-a/plex-transcode"
chmod 755 "$GATE_ROOT" "$WORK" "$WORK/arm-a" "$WORK/arm-a/mnt"
# THE MEDIA SERVERS' STATE DIRECTORIES HAVE TO BE WRITABLE BY THE UIDS THOSE SERVERS RUN AS, and none of them
# was. `mkdir -p` makes them 755 owned by root; Jellyfin runs `--user 1000:1000` and its very first act is to
# create its application paths under /config and /cache, so it died on startup with
# `System.IO.Directory.CreateDirectory` and the harness reported "Jellyfin never came up". Emby's s6
# entrypoint does its own setuid and Plex takes PLEX_UID, so all three need the same thing. This is exactly
# what `deploy/projection-jellyfin-dataplane-gate.sh` does for the same directories, and the harness was the
# only place that ran three media servers without it.
chmod 777 "$WORK/arm-a/cache" "$WORK/arm-a/out" \
          "$WORK/arm-a/jf-config" "$WORK/arm-a/jf-cache" "$WORK/arm-a/emby-config" \
          "$WORK/arm-a/plex-config" "$WORK/arm-a/plex-transcode"

# THE ENDPOINT IS internal/fakeprovider, the only "provider" any automated gate here contacts. It runs in
# RESOLVER mode rather than direct mode, so the daemon must exchange the stable objectRef for short-lived
# access material. The lease id is prefixed with the high-entropy marker minted above, which is what makes the
# leak searches a search for THE ACTUAL SECRET. A bearer credential is required, so R2's rotation is real.
# Every object the run will ever need is served from the start, in a registration order the window assertion
# depends on: THE CANARY FIRST, then the barrier, then the corpus. The six local-passthrough entries are NOT
# served here — the daemon publishes them from its own local root, exactly as G18 does.
CORPUS_OBJECT_FLAGS=()
index=1
while [ "$index" -le "$(( CORPUS_COUNT - CORPUS_LOCAL ))" ]; do
  n="$(printf "%02d" "$index")"
  CORPUS_OBJECT_FLAGS+=(--file-object "obj-projection-corpus-${n}=/remote/Projection Corpus ${n} (2026).mp4")
  index=$(( index + 1 ))
done

docker run -d --name "$PD_RANGE_CONTAINER" --network "$NETWORK" --network-alias fakerange \
  -p "127.0.0.1:${PD_RANGE_PORT}:8099" \
  -v "$PWD:/workspace" -w /workspace/projectiond -v "$WORK/out:/out" -v "$WORK/remote:/remote:ro" \
  -v "$WORK/secret:/secret:ro" \
  -e GOFLAGS=-buildvcs=false -e GOTOOLCHAIN=local -e CGO_ENABLED=0 \
  "$GO_IMAGE" go run ./cmd/fakerange --addr 0.0.0.0:8099 --lease-prefix "$LEASE_MARKER" \
  --token-file /secret/token --public-base-url "http://fakerange:8099" --max-hold "$HOLD_MAX" \
  --file-object "${CANARY_REF}=/remote/${CANARY_FILE}" \
  --file-object "${LARGE_REF}=/remote/${LARGE_FILE}" \
  --file-object "${ROT_REF}=/remote/${ROT_FILE}" \
  "${CORPUS_OBJECT_FLAGS[@]}" --emit /out/objects.json >/dev/null

# ARM A'S LINES ARE THE SHARED CORPUS DESCRIPTION'S INPUT. The endpoint emits objects.json into the shared
# $REL/out, where corpus.cjs reads it and cross-checks every remote entry against it.
ARM_MNT="$WORK/arm-a/mnt"
ARM_OUT="$WORK/arm-a/out"
ARM_REL="$REL/arm-a"
FRONTEND_CONTAINER="$PD_MOUNT_CONTAINER"
ARM_TOKEN="$DAV_TOKEN"
ENDPOINT_ALIAS="fakerange"
ARM_CLI="src/ops/projection-three-server-concurrency-cli.ts"
DAV_BASE="http://127.0.0.1:${PD_RANGE_PORT}"

wait_ready "$PD_RANGE_CONTAINER" "http://fakerange:8099/counters"
echo "  the range endpoint is up"

# ONE ranged request, AGAINST THE CANARY, and its status line asserted. The endpoint is Range-only by
# construction and busybox wget exits non-zero on a 206, so the status line is checked.
docker run --rm --network "$NETWORK" -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
  sh /probe/probe.sh "http://fakerange:8099/direct/${CANARY_REF}" "$ARM_TOKEN" >/dev/null 2>&1 \
  || { logs_tail "$PD_RANGE_CONTAINER"; die "the endpoint does not answer a ranged request with 206"; }
# AND THE CREDENTIAL IS EXERCISED WHERE IT ACTUALLY GUARDS: /resolve, which is what the daemon calls in
# resolver mode and therefore what R2 rotates. `/direct/` is unauthenticated by construction, so asserting a
# refusal there asserted nothing and failed for it.
resolve_probe() {
  docker run --rm --network "$NETWORK" -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
    sh /probe/resolveprobe.sh "http://fakerange:8099" "$1" "$CANARY_REF" 2>/dev/null || true
}
RESOLVE_GOOD="$(resolve_probe "$ARM_TOKEN")"
case "$RESOLVE_GOOD" in
  *resolve:200*) ;;
  *) logs_tail "$PD_RANGE_CONTAINER"
     die "the endpoint did not resolve with the CORRECT credential (got '$RESOLVE_GOOD'), so a rotation" \
         "round against it would measure nothing" ;;
esac
RESOLVE_BAD="$(resolve_probe "not-the-token")"
case "$RESOLVE_BAD" in
  *resolve:401*) ;;
  *resolve:200*) die "the endpoint resolved with the WRONG credential; R2 would be a round about nothing" ;;
  *) die "the credential probe never ran against the endpoint (got '$RESOLVE_BAD'), so nothing was checked" ;;
esac
echo "  the endpoint answers a ranged request with 206, resolves with the right credential and returns 401 for the wrong one"

ENDPOINT_LARGE_SIZE="$(node "$REL/out/objects.cjs" "$REL/out/objects.json" "$LARGE_REF" size)"
test "$ENDPOINT_LARGE_SIZE" = "$LARGE_SIZE" || die "the endpoint disagrees with the barrier file about its size"

# THE PRODUCTION DAEMON, WITH A TOKEN FILE ON THE VAULT ENDPOINT — the difference from G18's config is
# exactly one field, and it is what makes R2 measurable here. The admission caps are set explicitly rather
# than defaulted, for the same reason G18's config says they are.
cat > "$WORK/arm-a/config.json" <<'JSON'
{
  "mountPoint": "/mnt/projection",
  "pointerPath": "/var/lib/projectiond/manifest/pointer.json",
  "probeCacheDir": "/var/lib/projectiond/cache",
  "statusAddr": "127.0.0.1:9099",
  "localRoots": { "media": "/var/lib/projectiond/media" },
  "globalMaxInflight": 8,
  "perEndpointMaxInflight": 4,
  "endpoints": [
    {
      "id": "vault",
      "resolverUrl": "http://fakerange:8099/resolve",
      "tokenFile": "/secret/token",
      "allowedOrigins": ["http://fakerange:8099"],
      "allowInsecureHttp": true,
      "allowPrivateAddresses": true,
      "maxConnections": 4
    }
  ]
}
JSON

start_daemon() {
  docker run -d --name "$PD_MOUNT_CONTAINER" \
    --network "$NETWORK" \
    --user 0:0 \
    --cap-drop ALL --cap-add SYS_ADMIN \
    --security-opt apparmor:unconfined \
    --device /dev/fuse:/dev/fuse \
    -v "$WORK/arm-a/manifest:/var/lib/projectiond/manifest:ro" \
    -v "$WORK/media:/var/lib/projectiond/media:ro" \
    -v "$WORK/arm-a/cache:/var/lib/projectiond/cache" \
    -v "$WORK/arm-a/config.json:/etc/projectiond/config.json:ro" \
    -v "$WORK/secret:/secret:ro" \
    -v "$WORK/arm-a/mnt:/mnt/projection:rshared" \
    "$IMAGE" --config /etc/projectiond/config.json --poll 2s --strict-direct-mount >/dev/null
}
daemon_status() {
  docker run --rm --network "container:$PD_MOUNT_CONTAINER" "$VERIFY_IMAGE" \
    wget -q -T 15 -O - "http://127.0.0.1:${DAEMON_STATUS_PORT}/readyz" > "$1" \
    || die "the daemon's status surface did not answer; a cold window cannot be told from a warm one"
}

# ----------------------------------------------------------------------------------------------------------
step "publishing generation 1: ONE LOCAL SEED ENTRY, AND NOTHING REMOTE"
# ----------------------------------------------------------------------------------------------------------
# THIS RUNS BEFORE THE DAEMON STARTS, AND IT DID NOT.
#
# `start_daemon` was called thirty lines above this step, so the daemon came up against an empty manifest
# directory, found no admitted generation, and exited 1 with `no generation could be admitted, so there is
# nothing to serve: pointer-unreadable`. The harness then sat in `await_path` for its full 120-second budget
# waiting for a namespace no live process was serving, and reported "the mount never became visible" — which
# is true, and says nothing about why. Every gate that works publishes first; this one is now one of them.
# Two of the three media servers create a library without scanning it. PLEX DOES NOT: creating a section
# starts a scan of it immediately. If the corpus were already published at that moment, Plex would scan it
# before this gate had triggered anything and the concurrent scan would measure a window in which the data
# plane did no work. So generation 1 is ONE LOCAL entry, the provider serves ZERO bytes for it, and the three
# concurrent scans are the first thing that has ever read the corpus.
register root --id media --kind local
register root --id vault --kind http-range
register version --key seed --size "$SEED_SIZE" --mtime 2026-06-01T10:00:00.000Z
register entry --item "b0000000-0000-4000-8000-000000000002" --version-key seed --path "$SEED_PATH" \
  --source "local:media:$SEED_FILE"

publish > "$ARM_OUT/publish-1.json"
test "$(field outcome  < "$ARM_OUT/publish-1.json")" = "published" || die "generation 1 was not published"
test "$(field sequence < "$ARM_OUT/publish-1.json")" = "1"         || die "the first sequence is not 1"

ARTIFACT="$(field artifactName < "$ARM_OUT/publish-1.json")"
POINTER_DIGEST="$(field manifestDigest < "$WORK/arm-a/manifest/pointer.json")"
ACTUAL_DIGEST="sha256:$(node "$REL/out/sha.cjs" "$ARM_REL/manifest/$ARTIFACT")"
test "$POINTER_DIGEST" = "$ACTUAL_DIGEST" || die "the pointer digest does not describe the artifact"
echo "  pointer digest verified against the artifact file"

# NOW the daemon, with a generation waiting for it.
start_daemon
echo "  waiting for the namespace to become visible to a sibling container"
await_path "$SEED_PATH" || { logs_tail "$PD_MOUNT_CONTAINER"; die "the mount never became visible"; }
echo "  the namespace is visible to a sibling container"

# ----------------------------------------------------------------------------------------------------------
step "starting THREE REAL MEDIA SERVERS over the SAME mount"
# ----------------------------------------------------------------------------------------------------------
# EACH ONE IS STARTED THE WAY ITS OWN GATE STARTS IT, AND THE THREE COMMANDS ARE DELIBERATELY NOT UNIFIED.
# Jellyfin runs under --user 1000:1000 with all capabilities dropped; Emby cannot (its entrypoint is an s6
# supervision tree that reads UID/GID and does the setuid itself); Plex takes PLEX_UID/PLEX_GID and must be
# addressed by ADDRESS rather than by name.
start_jellyfin() {
  docker run -d --name "$JF_CONTAINER" \
    --network "$NETWORK" \
    --user 1000:1000 \
    --cap-drop ALL --security-opt no-new-privileges \
    -p "127.0.0.1:${JF_PORT}:8096" \
    -e JELLYFIN_PublishedServerUrl="http://127.0.0.1:${JF_PORT}" \
    -v "$ARM_DIR/jf-config:/config" \
    -v "$ARM_DIR/jf-cache:/cache" \
    -v "$ARM_MNT:/media/projection:rslave" \
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
    -v "$ARM_DIR/emby-config:/config" \
    -v "$ARM_MNT:/media/projection:rslave" \
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
    -v "$ARM_DIR/plex-config:/config" \
    -v "$ARM_DIR/plex-transcode:/transcode" \
    -v "$ARM_MNT:/media/projection:rslave" \
    "$PLEX_IMAGE" >/dev/null
}

# EVERY MEDIA SERVER'S STATE LIVES UNDER THE ARM'S OWN OUT DIRECTORY, so per-server attribution and the arm's
# results stay in the same place.
JF_CONTAINER="$PD_JF_CONTAINER";  JF_PORT="$PD_JF_PORT";  JF_BASE="http://127.0.0.1:${PD_JF_PORT}"
EMBY_CONTAINER="$PD_EMBY_CONTAINER"; EMBY_PORT="$PD_EMBY_PORT"; EMBY_BASE="http://127.0.0.1:${PD_EMBY_PORT}"
PLEX_CONTAINER="$PD_PLEX_CONTAINER"; PLEX_PORT="$PD_PLEX_PORT"; PLEX_BASE="http://127.0.0.1:${PD_PLEX_PORT}"
JF_STATE="$ARM_REL/out/state-jellyfin.json"
EMBY_STATE="$ARM_REL/out/state-emby.json"
PLEX_STATE="$ARM_REL/out/state-plex.json"
ARM_DIR="$WORK/arm-a"

start_jellyfin
start_emby
start_plex
echo "  three media servers started, all three with the same projected mount as a library root"

# THE BOOTSTRAPS ARE THE THREE EXISTING ONES AND THEY ARE NOT FLATTENED. Emby's cannot key on
# `StartupWizardCompleted` because this server never sends one; Plex has no wizard at all.
jellyfin bootstrap --base "$JF_BASE" --state "$JF_STATE" \
  || { logs_tail "$JF_CONTAINER"; die "Jellyfin never came up"; }
emby bootstrap --base "$EMBY_BASE" --state "$EMBY_STATE" \
  || { logs_tail "$EMBY_CONTAINER"; die "Emby never came up"; }
plex bootstrap --base "$PLEX_BASE" --state "$PLEX_STATE" \
  || { logs_tail "$PLEX_CONTAINER"; die "Plex never came up"; }
test -s "$JF_STATE"   || die "the Jellyfin bootstrap exited 0 but wrote no state"
test -s "$EMBY_STATE" || die "the Emby bootstrap exited 0 but wrote no state"
test -s "$PLEX_STATE" || die "the Plex bootstrap exited 0 but wrote no state"

# EACH SERVER MUST BE ABLE TO READ THE MOUNT AS THE UID IT ACTUALLY RUNS AS, checked from inside its own
# container BEFORE a scan is asked for.
docker exec -u 1000:1000 "$JF_CONTAINER"   test -r "/media/projection/$SEED_PATH" \
  || die "Jellyfin's own uid cannot read the projected file"
docker exec -u 1000:1000 "$EMBY_CONTAINER" test -r "/media/projection/$SEED_PATH" \
  || die "Emby's own uid cannot read the projected file"
docker exec --user 1000:1000 "$PLEX_CONTAINER" test -r "/media/projection/$SEED_PATH" \
  || die "Plex's own uid cannot read the projected file"
echo "  all three servers can read the same projected file as the uid each runs as"

# Plex's server preferences, which turn off every background job that reads whole media files on a timer.
plex prefs --state "$PLEX_STATE"

# ----------------------------------------------------------------------------------------------------------
step "adding the SAME mount as a Movies library on all three"
# ----------------------------------------------------------------------------------------------------------
jellyfin library --state "$JF_STATE"   --mount-path /media/projection/Movies --name "Projection Movies"
emby     library --state "$EMBY_STATE" --mount-path /media/projection/Movies --name "Projection Movies"
# PLEX LAST, AND THE ORDER IS LOAD-BEARING. Creating a Plex section starts a scan of it immediately; putting
# it last means the other two libraries already exist when it runs, so nothing about it can race a library
# creation.
plex library --state "$PLEX_STATE" --mount-path /media/projection/Movies --name "Projection Movies"

# ...AND THEN PLEX'S CREATION SCAN IS WAITED OUT, EXPLICITLY, BEFORE THE CORPUS IS PUBLISHED. Publishing the
# corpus while that scan was still running would let Plex catalogue part of it — warming the daemon's
# scan-window cache — and the concurrent scan would then measure a window in which the data plane had already
# done the work. The seed entry is a LOCAL passthrough source and contacts no endpoint at all.
node "$REL/out/seed-expect.cjs" "$ARM_REL/out/seed-expected.json" "$SEED_FILE" "$SEED_SIZE" "$SEED_SHA"
plex scan --state "$PLEX_STATE" --expect-file "$ARM_REL/out/seed-expected.json" \
  --out "$ARM_REL/out/plex-seed-items.json" --label seed \
  || { logs_tail "$PLEX_CONTAINER"; die "Plex never settled after its own library-creation scan"; }

# ----------------------------------------------------------------------------------------------------------
step "publishing the ~50-entry corpus — AFTER every library exists, and BEFORE anything has scanned it"
# ----------------------------------------------------------------------------------------------------------
node "$REL/out/corpus.cjs" "$REL" "$CORPUS_COUNT" "$CORPUS_LOCAL" "$LARGE_FILE" "$LARGE_REF" >/dev/null \
  || die "the corpus could not be described, or the endpoint disagrees with a generated file"
register batch --file "$REL/out/corpus-register.json"
publish > "$ARM_OUT/publish-corpus.json"
test "$(field outcome < "$ARM_OUT/publish-corpus.json")" = "published" || die "the corpus was not published"
test "$(field additions < "$ARM_OUT/publish-corpus.json")" = "$(( CORPUS_COUNT + 1 ))" \
  || die "the corpus generation added $(field additions < "$ARM_OUT/publish-corpus.json") entries, not $(( CORPUS_COUNT + 1 ))"

echo "  waiting for the corpus to be admitted"
await_path "$LARGE_PATH" || { logs_tail "$PD_MOUNT_CONTAINER"; die "the corpus never became visible"; }

CORPUS_TOTAL="$(node "$REL/out/expect.cjs" "$REL/out/expected.json" "$REL/out/corpus-expected.json" \
  "$SEED_FILE" "$SEED_SIZE" "$SEED_SHA")"
echo "  the shared corpus all three servers will be held against is $CORPUS_TOTAL entries"
test "$CORPUS_TOTAL" -ge 48 || die "the corpus is $CORPUS_TOTAL entries, not the ~50 the acceptance plan asks for"

REMOTE_ENTRIES="$(field remoteEntries    < "$WORK/out/corpus-totals.json")"
SMALL_REMOTE_BYTES="$(field smallRemoteBytes < "$WORK/out/corpus-totals.json")"
LARGE_REMOTE_BYTES="$(field largeRemoteBytes < "$WORK/out/corpus-totals.json")"
REGISTERED_OBJECTS=$(( 1 + 1 + CORPUS_COUNT - CORPUS_LOCAL ))
echo "  $REMOTE_ENTRIES remote entries; $LARGE_REMOTE_BYTES bytes above the single-probe threshold and"
echo "  $SMALL_REMOTE_BYTES below it; $REGISTERED_OBJECTS objects registered at the endpoint"
# ----------------------------------------------------------------------------------------------------------
step "the state of the world immediately before the concurrent scan, and the instrument that samples it"
# ----------------------------------------------------------------------------------------------------------
# THE RESOURCE SAMPLER RUNS FOR EXACTLY THE MEASUREMENT THAT FOLLOWS — the base window and the three rounds —
# and reports on the FRONTEND container only, never on the media servers or the endpoint.
resource_sample

# THE CACHE IS NOT EMPTY AT THIS POINT AND NOTHING IS WRONG. It holds the LOCAL seed entry's own byte-identity
# window, because this gate publishes a local entry on purpose so that Plex's unavoidable library-creation scan
# has something to find that costs the provider nothing. So the daemon-side assertion is that the cache GREW
# across the window, and the emptiness question is asked where it can actually be answered: at the endpoint,
# per corpus object.
daemon_status "$WORK/out/daemon-before.json"
PROBE_CACHE_BEFORE="$(field probeCacheBytes < "$WORK/out/daemon-before.json")"
echo "  the daemon's scan-window cache holds ${PROBE_CACHE_BEFORE:-0} bytes"
drive counters --url "$DAV_BASE" --out "$ARM_REL/out/counters-before.json"

# ----------------------------------------------------------------------------------------------------------
step "THREE REAL LIBRARY SCANS, AT THE SAME TIME, OVER THE SAME MOUNT"
# ----------------------------------------------------------------------------------------------------------
# ONE PROCESS, ONE CLOCK. It arms the rendezvous hold, fires all three triggers together, and then asks all
# three servers their own present-tense in-flight state on a shared tick until every scan has settled.
drive concurrent-scan \
  --state-jellyfin "$JF_STATE" --state-plex "$PLEX_STATE" --state-emby "$EMBY_STATE" \
  --endpoint "$DAV_BASE" --barrier-ref "$LARGE_REF" \
  --out "$ARM_REL/out/concurrent-scan.json" --catalogue-dir "$ARM_REL/out" \
  || { logs_tail "$PD_MOUNT_CONTAINER"; die "the concurrent scan did not complete"; }

# THE AFTER SNAPSHOT WAITS FOR EVERY BODY TO FINISH WRITING. The endpoint counts a response's COMMITTED payload
# length before it writes it and the count its write RETURNED afterwards; a snapshot taken between those two
# moments would report a deficit that belongs to the clock rather than to the daemon. The command polls the
# endpoint's own in-flight gauge and REFUSES a snapshot that never settled.
drive counters --url "$DAV_BASE" --out "$ARM_REL/out/counters-after.json"
daemon_status "$WORK/out/daemon-after.json"
PROBE_CACHE_AFTER="$(field probeCacheBytes < "$WORK/out/daemon-after.json")"

# ----------------------------------------------------------------------------------------------------------
step "was it actually simultaneous?"
# ----------------------------------------------------------------------------------------------------------
drive verify-overlap --scan "$ARM_REL/out/concurrent-scan.json"

# ----------------------------------------------------------------------------------------------------------
step "did each server see the SAME ~50 identities, through ITS OWN semantics?"
# ----------------------------------------------------------------------------------------------------------
# ONE EXPECTATION DOCUMENT, THREE PREDICATES. The corpus, the sizes and the digests are shared — that is what
# makes this one library rather than three. What is NOT shared is how each server describes an ordinary file.
drive verify-corpus --server jellyfin --catalogue "$ARM_REL/out/catalogue-jellyfin.json" \
  --expect-file "$REL/out/expected.json"
drive verify-corpus --server plex     --catalogue "$ARM_REL/out/catalogue-plex.json" \
  --expect-file "$REL/out/expected.json"
drive verify-corpus --server emby     --catalogue "$ARM_REL/out/catalogue-emby.json" \
  --expect-file "$REL/out/expected.json"

# ----------------------------------------------------------------------------------------------------------
step "G14a-G17 across the simultaneous window, unchanged"
# ----------------------------------------------------------------------------------------------------------
drive window --before "$ARM_REL/out/counters-before.json" --after "$ARM_REL/out/counters-after.json" \
  --gate TS3 --objects "$REGISTERED_OBJECTS" --non-corpus-objects 1 \
  --remote-entries "$REMOTE_ENTRIES" \
  --large-bytes "$LARGE_REMOTE_BYTES" --small-bytes "$SMALL_REMOTE_BYTES" \
  --probe-cache-before "${PROBE_CACHE_BEFORE:-0}" --probe-cache-after "${PROBE_CACHE_AFTER:-0}"

# ----------------------------------------------------------------------------------------------------------
step "R1: a provider stall, and what a full read does under it"
# ----------------------------------------------------------------------------------------------------------
# THE HOLD IS THE SAME BARRIER OBJECT THE RENDEZVOUS USES, and the read is the whole 94 MiB barrier: a
# frontend that cached it can serve it, a frontend that cannot must wait on the provider hold. The stall
# outcome is RECORDED, not assumed — a cache hit here is a finding, not a failure — and the RECOVERY is
# required: the same read, after the release, must return the bytes recorded outside the mount.
LARGE_SHA="$(digest "$REL/remote/$LARGE_FILE")"
control_hold "$LARGE_REF"
R1_STALL_START="$(date +%s%3N)"
R1_HELD_SHA="$(docker run --rm --user 1000:1000 -v "$ARM_MNT:/mnt:rslave" -v "$WORK/out:/out:ro" \
  "$VERIFY_IMAGE" sh /out/fullread.sh "/mnt/$LARGE_PATH" 2>/dev/null || true)"
R1_STALL_MS="$(($(date +%s%3N) - R1_STALL_START))"
if [ -n "$R1_HELD_SHA" ] && [ "$R1_HELD_SHA" = "$LARGE_SHA" ]; then
  R1_HELD=false
  echo "  RECORDED: a full read of the held object was served — a cache path bound where the stall should have"
else
  R1_HELD=true
  echo "  RECORDED: a full read of the held object stalled for ${R1_STALL_MS} ms"
fi
control_release "$LARGE_REF"
R1_AFTER_SHA="$(docker run --rm --user 1000:1000 -v "$ARM_MNT:/mnt:rslave" -v "$WORK/out:/out:ro" \
  "$VERIFY_IMAGE" sh /out/fullread.sh "/mnt/$LARGE_PATH")"
test "$R1_AFTER_SHA" = "$LARGE_SHA" \
  || die "the read did not recover with the bytes recorded outside the mount after the release"
echo "  the same read after the release recovered with the bytes recorded outside the mount"

# ----------------------------------------------------------------------------------------------------------
step "R2: rotating the provider credential mid-run"
# ----------------------------------------------------------------------------------------------------------
# THE ROTATED OBJECT was served by the endpoint from the first instant and was never in the manifest, so
# NOTHING can have cached a byte of it. Publishing it now makes R2's read a read that must reach the resolver.
# The endpoint is then rotated onto a NEW credential, and the daemon — which reloads its secret only when a
# resolution is refused — must converge on the following read. The read it converged on is recorded.
register version --key rotated --size "$ROT_SIZE" --mtime 2026-06-01T10:00:00.000Z
register entry --item "$ROT_ITEM" --version-key rotated --path "$ROT_PATH" \
  --source "http-range:vault:$ROT_REF"
publish > "$ARM_OUT/publish-r2.json"
test "$(field outcome < "$ARM_OUT/publish-r2.json")" = "published" \
  || die "the rotation generation was not published"
test "$(field additions < "$ARM_OUT/publish-r2.json")" = "1" \
  || die "the rotation generation added $(field additions < "$ARM_OUT/publish-r2.json") entries, not 1"
await_path "$ROT_PATH" || { logs_tail "$PD_MOUNT_CONTAINER"; die "the rotated object never became visible"; }

# THE PRE-ROTATION READ: the daemon holds the original credential and the endpoint accepts it.
R2_BEFORE_SHA="$(docker run --rm --user 1000:1000 -v "$ARM_MNT:/mnt:rslave" -v "$WORK/out:/out:ro" \
  "$VERIFY_IMAGE" sh /out/fullread.sh "/mnt/$ROT_PATH")"
test "$R2_BEFORE_SHA" = "$ROT_SHA" \
  || die "a pre-rotation read of the rotated object did not return the bytes recorded outside the mount"

# ROTATE THE ENDPOINT: the new credential goes into the same file, and the endpoint restarts against it.
printf '%s' "$ROTATED_TOKEN" > "$WORK/secret/token"
docker rm -f "$PD_RANGE_CONTAINER" >/dev/null
docker run -d --name "$PD_RANGE_CONTAINER" --network "$NETWORK" --network-alias fakerange \
  -p "127.0.0.1:${PD_RANGE_PORT}:8099" \
  -v "$PWD:/workspace" -w /workspace/projectiond -v "$WORK/out:/out" -v "$WORK/remote:/remote:ro" \
  -v "$WORK/secret:/secret:ro" \
  -e GOFLAGS=-buildvcs=false -e GOTOOLCHAIN=local -e CGO_ENABLED=0 \
  "$GO_IMAGE" go run ./cmd/fakerange --addr 0.0.0.0:8099 --lease-prefix "$LEASE_MARKER" \
  --token-file /secret/token --public-base-url "http://fakerange:8099" --max-hold "$HOLD_MAX" \
  --file-object "${CANARY_REF}=/remote/${CANARY_FILE}" \
  --file-object "${LARGE_REF}=/remote/${LARGE_FILE}" \
  --file-object "${ROT_REF}=/remote/${ROT_FILE}" \
  "${CORPUS_OBJECT_FLAGS[@]}" --emit /out/objects.json >/dev/null
wait_ready "$PD_RANGE_CONTAINER" "http://fakerange:8099/counters"
echo "  the endpoint restarted onto the rotated credential"

# AND THE ROTATION REALLY BOUND, or this round measured nothing — checked on /resolve, the path the
# credential guards and the one the daemon uses, not on the unauthenticated /direct/.
ROT_OLD="$(resolve_probe "$ARM_TOKEN")"
case "$ROT_OLD" in
  *resolve:401*) ;;
  *resolve:200*) die "the endpoint still honours the OLD credential after the rotation" ;;
  *) die "the post-rotation credential probe never ran (got '$ROT_OLD'), so the rotation was not verified" ;;
esac
ROT_NEW="$(resolve_probe "$ROTATED_TOKEN")"
case "$ROT_NEW" in
  *resolve:200*) ;;
  *) die "the endpoint does not honour the NEW credential after the rotation (got '$ROT_NEW')" ;;
esac

# THE READ THE ROTATION IS ABOUT. The daemon's next resolution is refused under the old credential, and the
# daemon reloads its secret only when a resolution is refused — so the FIRST read may fail and the FOLLOWING
# read must converge. The attempt it converged on is recorded, not assumed.
R2_ATTEMPT=0
R2_CONVERGED_SHA=""
while [ "$R2_ATTEMPT" -lt 3 ]; do
  R2_ATTEMPT=$(( R2_ATTEMPT + 1 ))
  R2_CONVERGED_SHA="$(docker run --rm --user 1000:1000 -v "$ARM_MNT:/mnt:rslave" -v "$WORK/out:/out:ro" \
    "$VERIFY_IMAGE" sh /out/fullread.sh "/mnt/$ROT_PATH" 2>/dev/null || true)"
  if [ -n "$R2_CONVERGED_SHA" ] && [ "$R2_CONVERGED_SHA" = "$ROT_SHA" ]; then break; fi
  sleep 2
done
test "$R2_CONVERGED_SHA" = "$ROT_SHA" \
  || die "the daemon never converged onto the rotated credential"
echo "  the daemon converged onto the rotated credential on read $R2_ATTEMPT of the rotation"

# ----------------------------------------------------------------------------------------------------------
step "the whole-run provider invariants, across R1 and R2"
# ----------------------------------------------------------------------------------------------------------
drive counters --url "$DAV_BASE" --out "$ARM_REL/out/counters-final.json"
drive provider-invariants --counters "$ARM_REL/out/counters-final.json" --gate TS4

# ----------------------------------------------------------------------------------------------------------
step "R3: restarting the frontend, and a warm re-scan settling with the same identities"
# ----------------------------------------------------------------------------------------------------------
R3_START="$(date +%s%3N)"
docker rm -f "$PD_MOUNT_CONTAINER" >/dev/null
start_daemon
await_path "$SEED_PATH" \
  || { logs_tail "$PD_MOUNT_CONTAINER"; die "the mount never came back after the restart"; }
R3_READY_MS="$(($(date +%s%3N) - R3_START))"
echo "  the daemon was back and the namespace visible again in ${R3_READY_MS} ms"
jellyfin scan --state "$JF_STATE" --expect-file "$REL/out/expected.json" \
  --out "$ARM_REL/out/r3-jellyfin.json" --label r3
plex scan --state "$PLEX_STATE" --expect-file "$REL/out/expected.json" \
  --out "$ARM_REL/out/r3-plex.json" --label r3 \
  || { logs_tail "$PD_PLEX_CONTAINER"; die "Plex never settled after the frontend restart"; }
emby scan --state "$EMBY_STATE" --expect-file "$REL/out/expected.json" \
  --out "$ARM_REL/out/r3-emby.json" --label r3
echo "  all three servers re-catalogued the same identities after the restart"

# ----------------------------------------------------------------------------------------------------------
step "does the frontend preserve seek and ordinary-file behaviour? MEASURED, not assumed"
# ----------------------------------------------------------------------------------------------------------
# A FORWARD seek past the middle, then a BACKWARD seek all the way to the start — the transition a naive client
# is most likely to answer wrongly — and then a whole-object read, each digest-compared against values recorded
# outside the mount. seekprobe.sh performs the three reads and prints one digest per line.
SEEK_TARGET="$LARGE_PATH"
SEEK_BLOCK=$(( LARGE_SIZE / 2 / 65536 ))
SEEK_OUT="$(docker run --rm --user 1000:1000 -v "$ARM_MNT:/mnt:rslave" -v "$WORK/out:/out:ro" \
  "$VERIFY_IMAGE" sh /out/seekprobe.sh "/mnt/$SEEK_TARGET" "$SEEK_BLOCK")"
OUTSIDE_OUT="$(docker run --rm -v "$WORK/remote:/src:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
  sh /out/seekprobe.sh "/src/$LARGE_FILE" "$SEEK_BLOCK")"
test "$(echo "$SEEK_OUT" | sed -n '1p')" = "$(echo "$OUTSIDE_OUT" | sed -n '1p')" \
  || die "a FORWARD seek through the mount returned different bytes than the same seek outside it"
test "$(echo "$SEEK_OUT" | sed -n '2p')" = "$(echo "$OUTSIDE_OUT" | sed -n '2p')" \
  || die "a BACKWARD seek through the mount returned different bytes than the same read outside it"
test "$(echo "$SEEK_OUT" | sed -n '3p')" = "$LARGE_SHA" \
  || die "a whole-object read through the mount does not digest to the value recorded outside it"
echo "  forward seek, backward seek and whole-object read all returned the bytes recorded outside the mount"

resource_sample_stop

# ----------------------------------------------------------------------------------------------------------
step "no PROVIDER access material reached the manifest, the probe cache or any server's library state"
# ----------------------------------------------------------------------------------------------------------
# THE CLAIM IS ABOUT PROVIDER ACCESS MATERIAL, and this arm carried three kinds: the lease marker the resolver
# mints, the original endpoint credential, and the credential it was rotated to. Each is searched for by exact
# value, so a clean result means something.
#
# THE CLAIM IS NOT "NO TOKEN EXISTS ANYWHERE ON DISK". The three servers persist their own authentication
# state, because a server that did not would not survive a restart; none of that is provider access material
# and none of it is searched for below.
printf '%s\n' "$LEASE_MARKER" "$DAV_TOKEN" "$ROTATED_TOKEN" "fakerange" "://" "X-Fake-Lease" \
  "expiresAtUnixMs" "Authorization:" "Bearer " > "$WORK/out/leak-needles-manifest.txt"
printf '%s\n' "$LEASE_MARKER" "$DAV_TOKEN" "$ROTATED_TOKEN" "fakerange" "http://" "https://" \
  "X-Fake-Lease" "expiresAtUnixMs" "Authorization:" "Bearer " > "$WORK/out/leak-needles-cache.txt"
printf '%s\n' "$LEASE_MARKER" "$DAV_TOKEN" "$ROTATED_TOKEN" "fakerange" "X-Fake-Lease" \
  "expiresAtUnixMs" > "$WORK/out/leak-needles-library.txt"
chmod 644 "$WORK/out/leak-needles-manifest.txt" "$WORK/out/leak-needles-cache.txt" \
  "$WORK/out/leak-needles-library.txt"
test "${#LEASE_MARKER}" -ge 8 \
  || die "the lease marker is under 8 bytes, so a search for it could not be decisive"

# THE MANIFEST DIRECTORY IS TEXT the control plane authored, so a bare `://` there is conclusive.
docker run --rm -v "$WORK/arm-a/manifest:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
  sh /out/leakcheck.sh "the published manifest directory" /out/leak-needles-manifest.txt \
  || die "the manifest directory holds provider access material"

# THE PROBE CACHE IS MEDIA BYTES, and `://` is not a usable signal against it; it is searched for the things
# that could only have got there from a leak, first among them the three secrets this arm carried.
docker run --rm -v "$WORK/arm-a/cache:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
  sh /out/leakcheck.sh "the daemon probe cache" /out/leak-needles-cache.txt \
  || die "the probe cache holds provider access material"

for scan_dir in jf-config plex-config emby-config; do
  docker run --rm -v "$WORK/arm-a/$scan_dir:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
    sh /out/leakcheck.sh "a media server's library state" /out/leak-needles-library.txt \
    || die "a media server persisted provider access material"
done
echo "  no media server's library state names the provider endpoint or holds a lease"

# AND THE LEASE REALLY EXISTED, or every search above was a search for nothing.
RESOLUTIONS="$(field resolutions < "$ARM_REL/out/counters-final.json")"
test "${RESOLUTIONS:-0}" -ge 1 \
  || die "the endpoint served no access resolution, so the leak check searched for a secret that never existed"
echo "  $RESOLUTIONS access lease(s) were minted during this run, so the searches above had a subject"

# ----------------------------------------------------------------------------------------------------------
step "recording ARM A's operational rounds, and stopping it: the namespace goes away, and a stale one does not linger"
# ----------------------------------------------------------------------------------------------------------
node "$REL/out/rounds.cjs" \
  "$ARM_REL/out/operational-rounds.json" "arm-a" "$R1_HELD" "$R1_STALL_MS" "$R2_ATTEMPT" "$R3_READY_MS" "$RESOLUTIONS"

# WITH THREE MEDIA SERVERS HOLDING THE MOUNT, that is why this step is worth more here than elsewhere: a stale
# FUSE mount is what stops the NEXT run from starting clean, and three live readers is three times the
# opportunity to leave one behind.
docker rm -f "$PD_PLEX_CONTAINER" "$PD_JF_CONTAINER" "$PD_EMBY_CONTAINER" >/dev/null 2>&1 || true
docker stop -t 30 "$PD_MOUNT_CONTAINER" >/dev/null
namespace_gone "the daemon" || die "the namespace is still visible after the daemon stopped"
docker rm -f "$PD_RANGE_CONTAINER" >/dev/null 2>&1 || true
echo "  arm A stopped; the namespace is gone"
# ==========================================================================================================
# CHUNK 4: ARMS B AND C — THE NAIVE PATH, TWO CACHE MODES. Same WebDAV endpoint, same corpus, same three
# media servers, two rclone mounts. Each arm is one call to run_rclone_arm, and the function carries the
# SAME three rounds as arm A — R1 a provider stall, R2 a credential rotation, R3 a frontend restart — plus
# the same leak searches, now against the client cache and the mount configuration.
# ==========================================================================================================

# ----------------------------------------------------------------------------------------------------------
step "ARM A's own report: every gate verdict inside the arm, held against the redaction rule"
# ----------------------------------------------------------------------------------------------------------
ARM_REL="$REL/arm-a"
ARM_CLI="src/ops/projection-three-server-concurrency-cli.ts"
drive redaction-check --file "$ARM_REL/out/results.json"
npx tsx "$ARM_CLI" report --results "$ARM_REL/out/results.json"

# THE ORDINALS OF THE WEBDAV REGISTRATION, IN THE ENDPOINT'S OWN ORDER, which is what the rclone CLI's
# per-object attribution indexes. The canary and the seed are seed-objects (visible from the first instant,
# because a library has to be creatable against a non-empty root), the barrier is the first file-object, and
# the generated corpus follows it in index order:
#   ordinal 0  the canary            outside the library root, reached only by probes and R2
#   ordinal 1  the seed entry        visible before the reveal, so a library can be created against the root
#   ordinal 2  the barrier fixture   the first CORPUS ordinal
#   ordinal 3+ the generated corpus  in the product's own index order
FIRST_CORPUS_ORDINAL=2
CORPUS_OBJECTS=$(( 1 + CORPUS_COUNT ))

# THE SUBSET THE PRODUCT ALSO FETCHES REMOTELY: the barrier and every generated entry the product does not
# publish as local passthrough. Ordinals 2 .. 2 + (CORPUS_COUNT - CORPUS_LOCAL).
PRODUCT_ORDINALS="$FIRST_CORPUS_ORDINAL"
index=1
while [ "$index" -le "$(( CORPUS_COUNT - CORPUS_LOCAL ))" ]; do
  PRODUCT_ORDINALS="${PRODUCT_ORDINALS},$(( FIRST_CORPUS_ORDINAL + index ))"
  index=$(( index + 1 ))
done
RC_REGISTERED_OBJECTS=$(( 2 + 1 + CORPUS_COUNT ))

# EVERY CORPUS FILE IS SERVED HERE, INCLUDING THE SIX THE PRODUCT READS LOCALLY: a naive mount has no local
# root, so its namespace IS the WebDAV URL space and a file absent from it is a file a server can never see.
RC_CORPUS_OBJECT_FLAGS=()
index=1
while [ "$index" -le "$CORPUS_COUNT" ]; do
  n="$(printf "%02d" "$index")"
  if [ "$index" -gt "$(( CORPUS_COUNT - CORPUS_LOCAL ))" ]; then hostdir=media; else hostdir=remote; fi
  RC_CORPUS_OBJECT_FLAGS+=(--file-object \
    "obj-projection-corpus-${n}=/Movies/Projection Corpus ${n} (2026)/Projection Corpus ${n} (2026).mp4=/media-src/${hostdir}/Projection Corpus ${n} (2026).mp4")
  index=$(( index + 1 ))
done

# THE CACHE-SIZE INSTRUMENT, ON THE MOUNT CLIENT'S OWN CACHE DIRECTORY. `find | cat | wc -c` rather than
# `du`, because this must run inside the pinned verifier image where du is not available.
cat > "$WORK/out/cachesize.sh" <<'CACHESIZE'
set -eu
find /cache -type f -exec cat {} + 2>/dev/null | wc -c
CACHESIZE
cache_bytes() {
  docker run --rm -v "$1:/cache:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
    sh /out/cachesize.sh | tr -d ' \r\n'
}

# THE WEBDAV ENDPOINT, THE SAME OBJECT SET THE RANGE ENDPOINT SERVED ON ARM A. It authenticates through the
# same token file, holds the barrier through the same control surface, and emits objects.json into the same
# shared out directory. The corpus is HELD BACK until `reveal`, exactly as G22's is.
start_rc_endpoint() {
  docker run -d --name "$RC_DAV_CONTAINER" --network "$NETWORK" --network-alias fakedav \
    -p "127.0.0.1:${RC_DAV_PORT}:8098" \
    -v "$PWD:/workspace" -w /workspace/projectiond \
    -v "$WORK:/media-src:ro" -v "$WORK/out:/out" -v "$WORK/secret:/secret:ro" \
    -e GOFLAGS=-buildvcs=false -e GOTOOLCHAIN=local -e CGO_ENABLED=0 \
    "$GO_IMAGE" go run ./cmd/fakewebdav --addr 0.0.0.0:8098 --token-file /secret/token \
    --max-hold "$HOLD_MAX" --emit /out/objects.json \
    --seed-object "${CANARY_REF}=/Canary/${CANARY_FILE}=/media-src/remote/${CANARY_FILE}" \
    --seed-object "${SEED_REF}=${SEED_DAV}=/media-src/media/seed/${SEED_FILE}" \
    --file-object "${LARGE_REF}=${LARGE_DAV_PATH}=/media-src/remote/${LARGE_FILE}" \
    "${RC_CORPUS_OBJECT_FLAGS[@]}" >/dev/null
}

# THE MOUNT CLIENT. Every bound is set explicitly rather than inherited: --read-only because the product's
# mount is read-only, --file-perms 0444/--dir-perms 0555 so a server sees an ordinary read-only regular file,
# --dir-cache-time 5m as the stated naive default, wide timeouts so no figure is attributed to a deadline this
# gate imposed, and the credential through rclone's bearer-token-command hook so it is in no argv and no
# environment value. The cache MODE is the arm: off is the naive default, full is the read-ahead cache.
start_rc_mount() {
  local cache_mode="$1" work_arm="$2"
  docker run -d --name "$RC_MOUNT_CONTAINER" \
    --network "$NETWORK" \
    --user 0:0 \
    --cap-drop ALL --cap-add SYS_ADMIN \
    --security-opt apparmor:unconfined \
    --device /dev/fuse:/dev/fuse \
    -p "127.0.0.1:${RC_RC_PORT}:5572" \
    -v "$WORK/secret:/secret:ro" \
    -v "$work_arm/rclone-config:/config" \
    -v "$work_arm/rclone-cache:/cache" \
    -v "$ARM_MNT:/mnt/rclone:rshared" \
    -e RCLONE_CONFIG=/config/rclone.conf \
    -e RCLONE_CONFIG_VAULT_TYPE=webdav \
    -e RCLONE_CONFIG_VAULT_URL=http://fakedav:8098/dav \
    -e RCLONE_CONFIG_VAULT_VENDOR=other \
    -e RCLONE_CONFIG_VAULT_BEARER_TOKEN_COMMAND="sh /secret/token.sh" \
    "$RCLONE_IMAGE" mount vault: /mnt/rclone \
    --read-only --allow-other --allow-non-empty \
    --file-perms 0444 --dir-perms 0555 \
    --vfs-cache-mode "$cache_mode" --dir-cache-time 5m \
    --timeout 30s --contimeout 10s \
    --cache-dir /cache \
    --rc --rc-addr 0.0.0.0:5572 --rc-no-auth \
    --log-level INFO >/dev/null
}

# ----------------------------------------------------------------------------------------------------------
# ONE ARM, CALLED TWICE. Everything below is parameterized by the two arguments: the arm's name (arm-b or
# arm-c) and the cache mode that IS the arm. The rclone CLI is the observer for both.
# ----------------------------------------------------------------------------------------------------------
run_rclone_arm() {
  local arm="$1" cache_mode="$2"
  local work_arm="$WORK/$arm" rel_arm="$REL/$arm"
  ARM_MNT="$WORK/$arm/mnt"
  ARM_OUT="$WORK/$arm/out"
  ARM_REL="$REL/$arm"
  ARM_DIR="$WORK/$arm"
  FRONTEND_CONTAINER="$RC_MOUNT_CONTAINER"
  ARM_TOKEN="$DAV_TOKEN"
  ENDPOINT_ALIAS="fakedav"
  ARM_CLI="src/ops/projection-rclone-comparison-cli.ts"
  DAV_BASE="http://127.0.0.1:${RC_DAV_PORT}"
  RC_BASE="http://127.0.0.1:${RC_RC_PORT}"
  JF_CONTAINER="$RC_JF_CONTAINER";  JF_PORT="$RC_JF_PORT";  JF_BASE="http://127.0.0.1:${RC_JF_PORT}"
  EMBY_CONTAINER="$RC_EMBY_CONTAINER"; EMBY_PORT="$RC_EMBY_PORT"; EMBY_BASE="http://127.0.0.1:${RC_EMBY_PORT}"
  PLEX_CONTAINER="$RC_PLEX_CONTAINER"; PLEX_PORT="$RC_PLEX_PORT"; PLEX_BASE="http://127.0.0.1:${RC_PLEX_PORT}"
  JF_STATE="$ARM_REL/out/state-jellyfin.json"
  EMBY_STATE="$ARM_REL/out/state-emby.json"
  PLEX_STATE="$ARM_REL/out/state-plex.json"

  # ------------------------------------------------------------------------------------------------------
  step "ARM $arm (rclone $cache_mode): the endpoint, the mount and the three media servers"
  # ------------------------------------------------------------------------------------------------------
  mkdir -p "$work_arm/out" "$work_arm/rclone-config" "$work_arm/rclone-cache" \
    "$work_arm/jf-config" "$work_arm/jf-cache" "$work_arm/emby-config" "$work_arm/plex-config" \
    "$work_arm/plex-transcode" "$work_arm/mnt"
  # The media-server state directories too, for the same reason arm A's are: Jellyfin runs as 1000:1000 and
  # creates its application paths on startup, and `mkdir -p` leaves these 755 owned by root.
  chmod 777 "$work_arm/mnt" "$work_arm/out" "$work_arm/rclone-cache" "$work_arm/rclone-config" \
            "$work_arm/jf-config" "$work_arm/jf-cache" "$work_arm/emby-config" \
            "$work_arm/plex-config" "$work_arm/plex-transcode"
  chmod 755 "$work_arm"

  # THE CREDENTIAL IS RESET TO THE ORIGINAL AT THE TOP OF EVERY ARM. Arm A's R2 rotated the shared token file
  # onto the rotated value; this arm's baseline has to run under the original credential for the rotation in
  # its own R2 to be a rotation.
  printf '%s' "$DAV_TOKEN" > "$WORK/secret/token"

  start_rc_endpoint
  wait_ready "$RC_DAV_CONTAINER" "http://fakedav:8098/counters"
  echo "  the WebDAV endpoint is up"

  # ONE ranged request, against the canary, and its status line asserted; then the same request with the wrong
  # credential, refused — or R2 would be a round about nothing.
  docker run --rm --network "$NETWORK" -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
    sh /probe/probe.sh "http://fakedav:8098/dav/Canary/${CANARY_FILE}" "$ARM_TOKEN" >/dev/null 2>&1 \
    || { logs_tail "$RC_DAV_CONTAINER"; die "the endpoint does not answer a ranged request with 206"; }
  if docker run --rm --network "$NETWORK" -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
       sh /probe/probe.sh "http://fakedav:8098/dav/Canary/${CANARY_FILE}" "not-the-token" >/dev/null 2>&1; then
    die "the endpoint served a ranged request with the wrong credential"
  fi
  echo "  the endpoint answers a ranged request with 206, and refuses one with the wrong credential"

  ENDPOINT_LARGE_SIZE="$(node "$REL/out/objects.cjs" "$REL/out/objects.json" "$LARGE_REF" size)"
  test "$ENDPOINT_LARGE_SIZE" = "$LARGE_SIZE" || die "the endpoint disagrees with the barrier file about its size"

  start_rc_mount "$cache_mode" "$work_arm"
  echo "  waiting for the mount client's control surface"
  alive=0
  for _ in $(seq 1 120); do
    if plain client-alive --rc "$RC_BASE" >/dev/null 2>&1; then alive=1; break; fi
    sleep 1
  done
  test "$alive" -eq 1 || { logs_tail "$RC_MOUNT_CONTAINER"; die "the mount client never came up"; }
  plain client-alive --rc "$RC_BASE"
  echo "  waiting for the namespace to become visible to a sibling container"
  await_path "$SEED_PATH" || { logs_tail "$RC_MOUNT_CONTAINER"; die "the mount never became visible"; }
  echo "  visible"

  # THE MOUNT REALLY CARRIES THE BYTES, or every figure below is a measurement of nothing. A known file is
  # read through the mount and digest-compared against the value recorded outside it, before any measurement.
  SEED_SHA_THROUGH_MOUNT="$(docker run --rm --user 65534:65534 -v "$ARM_MNT:/mnt:rslave" \
    -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" sh /out/fullread.sh "/mnt/$SEED_PATH")"
  test "$SEED_SHA_THROUGH_MOUNT" = "$SEED_SHA" \
    || die "the bytes read through the mount are not the bytes recorded outside it"
  echo "  a file read THROUGH the mount digests to the value recorded outside it"

  # ------------------------------------------------------------------------------------------------------
  step "ARM $arm: THREE REAL MEDIA SERVERS over the SAME rclone mount"
  # ------------------------------------------------------------------------------------------------------
  start_jellyfin
  start_emby
  start_plex
  echo "  three media servers started, all three with the same rclone mount as a library root"

  jellyfin bootstrap --base "$JF_BASE" --state "$JF_STATE" \
    || { logs_tail "$JF_CONTAINER"; die "Jellyfin never came up"; }
  emby bootstrap --base "$EMBY_BASE" --state "$EMBY_STATE" \
    || { logs_tail "$EMBY_CONTAINER"; die "Emby never came up"; }
  plex bootstrap --base "$PLEX_BASE" --state "$PLEX_STATE" \
    || { logs_tail "$PLEX_CONTAINER"; die "Plex never came up"; }
  test -s "$JF_STATE"   || die "the Jellyfin bootstrap exited 0 but wrote no state"
  test -s "$EMBY_STATE" || die "the Emby bootstrap exited 0 but wrote no state"
  test -s "$PLEX_STATE" || die "the Plex bootstrap exited 0 but wrote no state"

  docker exec -u 1000:1000 "$JF_CONTAINER"   test -r "/media/projection/$SEED_PATH" \
    || die "Jellyfin's own uid cannot read the mounted file"
  docker exec -u 1000:1000 "$EMBY_CONTAINER" test -r "/media/projection/$SEED_PATH" \
    || die "Emby's own uid cannot read the mounted file"
  docker exec --user 1000:1000 "$PLEX_CONTAINER" test -r "/media/projection/$SEED_PATH" \
    || die "Plex's own uid cannot read the mounted file"
  echo "  all three servers can read the same mounted file as the uid each runs as"

  plex prefs --state "$PLEX_STATE"

  jellyfin library --state "$JF_STATE"   --mount-path /media/projection/Movies --name "Projection Movies"
  emby     library --state "$EMBY_STATE" --mount-path /media/projection/Movies --name "Projection Movies"
  # PLEX LAST, AND THE ORDER IS LOAD-BEARING: creating a Plex section starts a scan of it immediately, and
  # putting it last means the other two libraries already exist when it runs.
  plex library --state "$PLEX_STATE" --mount-path /media/projection/Movies --name "Projection Movies"
  node "$REL/out/seed-expect.cjs" "$rel_arm/out/seed-expected.json" "$SEED_FILE" "$SEED_SIZE" "$SEED_SHA"
  plex scan --state "$PLEX_STATE" --expect-file "$rel_arm/out/seed-expected.json" \
    --out "$rel_arm/out/plex-seed-items.json" --label seed \
    || { logs_tail "$RC_PLEX_CONTAINER"; die "Plex never settled after its own library-creation scan"; }

  # ------------------------------------------------------------------------------------------------------
  step "ARM $arm: revealing the corpus — AFTER every library exists, and BEFORE anything has listed or read it"
  # ------------------------------------------------------------------------------------------------------
  # THE REVEAL IS THIS TOPOLOGY'S ONLY ANALOGUE OF A PUBLISH. The product's gates publish a one-entry
  # generation, create the libraries against it, and publish the corpus afterwards. A naive mount has no
  # publish step at all, so the endpoint holds the corpus back until told — and the client's cached listings
  # are dropped explicitly, twice, so the measured window pays for its own first listing.
  plain reveal --endpoint "$DAV_BASE"
  plain forget --rc "$RC_BASE"
  await_path "$LARGE_PATH" || { logs_tail "$RC_MOUNT_CONTAINER"; die "the corpus never became visible"; }
  plain forget --rc "$RC_BASE"
  echo "  the corpus is visible through the mount, and the client's cached listings have been dropped again"

  # ------------------------------------------------------------------------------------------------------
  step "ARM $arm: the state of the world immediately before the concurrent scan"
  # ------------------------------------------------------------------------------------------------------
  resource_sample
  RC_CACHE_BEFORE="$(cache_bytes "$work_arm/rclone-cache")"
  echo "  the mount client's cache directory holds ${RC_CACHE_BEFORE:-0} bytes"
  drive counters --url "$DAV_BASE" --out "$rel_arm/out/counters-before.json"
  plain client-stats --rc "$RC_BASE" --out "$rel_arm/out/client-before.json"

  # ------------------------------------------------------------------------------------------------------
  step "ARM $arm: THREE REAL LIBRARY SCANS, AT THE SAME TIME, OVER THE SAME rclone MOUNT"
  # ------------------------------------------------------------------------------------------------------
  # THE SAME OBSERVER, THE SAME THREE DRIVERS AND THE SAME BARRIER AS ARM A, pointed at a different mount —
  # which is what "measured the same way" has to mean to be worth saying.
  drive concurrent-scan \
    --state-jellyfin "$JF_STATE" --state-plex "$PLEX_STATE" --state-emby "$EMBY_STATE" \
    --endpoint "$DAV_BASE" --barrier-ref "$LARGE_REF" \
    --out "$rel_arm/out/concurrent-scan.json" --catalogue-dir "$rel_arm/out" \
    || { logs_tail "$RC_MOUNT_CONTAINER"; die "the concurrent scan did not complete"; }

  drive counters --url "$DAV_BASE" --out "$rel_arm/out/counters-after.json"
  plain client-stats --rc "$RC_BASE" --out "$rel_arm/out/client-after.json"
  RC_CACHE_AFTER="$(cache_bytes "$work_arm/rclone-cache")"

  # ------------------------------------------------------------------------------------------------------
  step "ARM $arm: was it actually simultaneous, and did each server see the SAME ~50 identities?"
  # ------------------------------------------------------------------------------------------------------
  drive verify-overlap --scan "$rel_arm/out/concurrent-scan.json"
  drive verify-corpus --server jellyfin --catalogue "$rel_arm/out/catalogue-jellyfin.json" \
    --expect-file "$REL/out/expected.json"
  drive verify-corpus --server plex     --catalogue "$rel_arm/out/catalogue-plex.json" \
    --expect-file "$REL/out/expected.json"
  drive verify-corpus --server emby     --catalogue "$rel_arm/out/catalogue-emby.json" \
    --expect-file "$REL/out/expected.json"

  # ------------------------------------------------------------------------------------------------------
  step "ARM $arm: is the instrument trustworthy, and was the window cold?"
  # ------------------------------------------------------------------------------------------------------
  # THE ORDER IS THE ARGUMENT. A figure is not read until the counters it comes from are known to be coherent.
  drive telemetry --before "$rel_arm/out/counters-before.json" --after "$rel_arm/out/counters-after.json" \
    --objects "$RC_REGISTERED_OBJECTS" --gate RC3
  # COLD-WINDOW IS A CLAIM THE OFF ARM CAN MAKE AND THE FULL ARM CANNOT. The full arm's client cache has been
  # warmed by the Plex seed scan by this point (that is the mode), so its cache directory is not empty and the
  # cold-window assertion would be a false refusal, not a finding. The corpus itself is still first-read on
  # both arms; the cold-window instrument's cache-empty check is simply the wrong question for the full arm.
  if [ "$cache_mode" = "off" ]; then
    drive cold-window --before "$rel_arm/out/counters-before.json" --after "$rel_arm/out/counters-after.json" \
      --gate RC3 --first-corpus-ordinal "$FIRST_CORPUS_ORDINAL" --corpus-objects "$CORPUS_OBJECTS" \
      --client-cache-before "${RC_CACHE_BEFORE:-0}"
  else
    echo "  cold-window is not asserted on the $cache_mode arm: its client cache is deliberately warm"
  fi

  # ------------------------------------------------------------------------------------------------------
  step "ARM $arm: WHAT THIS PATH COST — recorded, with no threshold, because the comparison has none"
  # ------------------------------------------------------------------------------------------------------
  drive measure --before "$rel_arm/out/counters-before.json" --after "$rel_arm/out/counters-after.json" \
    --gate RC4 --first-corpus-ordinal "$FIRST_CORPUS_ORDINAL" --product-ordinals "$PRODUCT_ORDINALS" \
    --corpus-objects "$CORPUS_OBJECTS" \
    --client-stats-before "$rel_arm/out/client-before.json" --client-stats-after "$rel_arm/out/client-after.json" \
    --client-cache-before "${RC_CACHE_BEFORE:-0}" --client-cache-after "${RC_CACHE_AFTER:-0}"

  # ------------------------------------------------------------------------------------------------------
  step "ARM $arm: R1 — a provider stall, and what a full read does under it"
  # ------------------------------------------------------------------------------------------------------
  # THE HOLD IS THE SAME BARRIER OBJECT THE RENDEZVOUS USES, and the read is the whole 94 MiB barrier. A
  # frontend that cached it can serve it, a frontend that cannot must wait on the provider hold. The stall
  # outcome is RECORDED, not assumed, and the RECOVERY is required: the same read, after the release, must
  # return the bytes recorded outside the mount.
  LARGE_SHA="$(digest "$REL/remote/$LARGE_FILE")"
  control_hold "$LARGE_REF"
  R1_STALL_START="$(date +%s%3N)"
  R1_HELD_SHA="$(docker run --rm --user 65534:65534 -v "$ARM_MNT:/mnt:rslave" -v "$WORK/out:/out:ro" \
    "$VERIFY_IMAGE" sh /out/fullread.sh "/mnt/$LARGE_PATH" 2>/dev/null || true)"
  R1_STALL_MS="$(($(date +%s%3N) - R1_STALL_START))"
  if [ -n "$R1_HELD_SHA" ] && [ "$R1_HELD_SHA" = "$LARGE_SHA" ]; then
    R1_HELD=false
    echo "  RECORDED: a full read of the held object was served — a cache path bound where the stall should have"
  else
    R1_HELD=true
    echo "  RECORDED: a full read of the held object stalled for ${R1_STALL_MS} ms"
  fi
  control_release "$LARGE_REF"
  R1_AFTER_SHA="$(docker run --rm --user 65534:65534 -v "$ARM_MNT:/mnt:rslave" -v "$WORK/out:/out:ro" \
    "$VERIFY_IMAGE" sh /out/fullread.sh "/mnt/$LARGE_PATH")"
  test "$R1_AFTER_SHA" = "$LARGE_SHA" \
    || die "the read did not recover with the bytes recorded outside the mount after the release"
  echo "  the same read after the release recovered with the bytes recorded outside the mount"

  # ------------------------------------------------------------------------------------------------------
  step "ARM $arm: R2 — rotating the provider credential mid-run"
  # ------------------------------------------------------------------------------------------------------
  # ARMS B/C ROTATE AGAINST THE CANARY: it is served by the endpoint from the first instant, outside the
  # library root, and it is the one object nothing in the measured window ever read whole. The endpoint is
  # rotated onto a NEW credential, the old one must be refused and the new one accepted, and the mount client
  # — which re-reads its bearer token from the file on every request — must converge on the following read.
  CANARY_SHA="$(digest "$REL/remote/$CANARY_FILE")"
  R2_BEFORE_SHA="$(docker run --rm --user 65534:65534 -v "$ARM_MNT:/mnt:rslave" -v "$WORK/out:/out:ro" \
    "$VERIFY_IMAGE" sh /out/fullread.sh "/mnt/Canary/$CANARY_FILE")"
  test "$R2_BEFORE_SHA" = "$CANARY_SHA" \
    || die "a pre-rotation read of the canary did not return the bytes recorded outside the mount"

  # ROTATE THE ENDPOINT: the new credential goes into the same file, and the endpoint restarts against it.
  printf '%s' "$ROTATED_TOKEN" > "$WORK/secret/token"
  docker rm -f "$RC_DAV_CONTAINER" >/dev/null
  start_rc_endpoint
  wait_ready "$RC_DAV_CONTAINER" "http://fakedav:8098/counters"
  echo "  the endpoint restarted onto the rotated credential"

  # AND THE ROTATION REALLY BOUND, or this round measured nothing.
  if docker run --rm --network "$NETWORK" -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
       sh /probe/probe.sh "http://fakedav:8098/dav/Canary/${CANARY_FILE}" "$DAV_TOKEN" >/dev/null 2>&1; then
    die "the endpoint still honours the OLD credential after the rotation"
  fi
  if ! docker run --rm --network "$NETWORK" -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
       sh /probe/probe.sh "http://fakedav:8098/dav/Canary/${CANARY_FILE}" "$ROTATED_TOKEN" >/dev/null 2>&1; then
    die "the endpoint does not honour the NEW credential after the rotation"
  fi

  # THE ENDPOINT RESTART RE-HID THE CORPUS, so the reveal is repeated and the mount's stale listing dropped.
  plain reveal --endpoint "$DAV_BASE"
  plain forget --rc "$RC_BASE"

  # THE READ THE ROTATION IS ABOUT. The mount client re-reads its token per request, so the read should
  # converge immediately; the attempt it converged on is recorded, not assumed.
  R2_ATTEMPT=0
  R2_CONVERGED_SHA=""
  while [ "$R2_ATTEMPT" -lt 3 ]; do
    R2_ATTEMPT=$(( R2_ATTEMPT + 1 ))
    R2_CONVERGED_SHA="$(docker run --rm --user 65534:65534 -v "$ARM_MNT:/mnt:rslave" -v "$WORK/out:/out:ro" \
      "$VERIFY_IMAGE" sh /out/fullread.sh "/mnt/Canary/$CANARY_FILE" 2>/dev/null || true)"
    if [ -n "$R2_CONVERGED_SHA" ] && [ "$R2_CONVERGED_SHA" = "$CANARY_SHA" ]; then break; fi
    sleep 2
  done
  test "$R2_CONVERGED_SHA" = "$CANARY_SHA" \
    || die "the mount never converged onto the rotated credential"
  echo "  the mount converged onto the rotated credential on read $R2_ATTEMPT of the rotation"

  # ------------------------------------------------------------------------------------------------------
  step "ARM $arm: R3 — restarting the frontend, and a warm re-scan settling with the same identities"
  # ------------------------------------------------------------------------------------------------------
  R3_START="$(date +%s%3N)"
  docker rm -f "$RC_MOUNT_CONTAINER" >/dev/null
  start_rc_mount "$cache_mode" "$work_arm"
  await_path "$SEED_PATH" \
    || { logs_tail "$RC_MOUNT_CONTAINER"; die "the mount never came back after the restart"; }
  R3_READY_MS="$(($(date +%s%3N) - R3_START))"
  echo "  the mount client was back and the namespace visible again in ${R3_READY_MS} ms"
  jellyfin scan --state "$JF_STATE" --expect-file "$REL/out/expected.json" \
    --out "$rel_arm/out/r3-jellyfin.json" --label r3
  plex scan --state "$PLEX_STATE" --expect-file "$REL/out/expected.json" \
    --out "$rel_arm/out/r3-plex.json" --label r3 \
    || { logs_tail "$RC_PLEX_CONTAINER"; die "Plex never settled after the frontend restart"; }
  emby scan --state "$EMBY_STATE" --expect-file "$REL/out/expected.json" \
    --out "$rel_arm/out/r3-emby.json" --label r3
  echo "  all three servers re-catalogued the same identities after the restart"

  # ------------------------------------------------------------------------------------------------------
  step "ARM $arm: does the frontend preserve seek and ordinary-file behaviour? MEASURED, not assumed"
  # ------------------------------------------------------------------------------------------------------
  SEEK_TARGET="Movies/${LARGE_FILE%.mp4}/$LARGE_FILE"
  SEEK_BLOCK=$(( LARGE_SIZE / 2 / 65536 ))
  SEEK_OUT="$(docker run --rm --user 65534:65534 -v "$ARM_MNT:/mnt:rslave" -v "$WORK/out:/out:ro" \
    "$VERIFY_IMAGE" sh /out/seekprobe.sh "/mnt/$SEEK_TARGET" "$SEEK_BLOCK")"
  OUTSIDE_OUT="$(docker run --rm -v "$WORK/remote:/src:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
    sh /out/seekprobe.sh "/src/$LARGE_FILE" "$SEEK_BLOCK")"
  LARGE_SHA_ENDPOINT="$(plain objects --file "$REL/out/objects.json" --ref "$LARGE_REF" --field sha256)"
  test "$(echo "$SEEK_OUT" | sed -n '1p')" = "$(echo "$OUTSIDE_OUT" | sed -n '1p')" \
    || die "a FORWARD seek through the mount returned different bytes than the same seek outside it"
  test "$(echo "$SEEK_OUT" | sed -n '2p')" = "$(echo "$OUTSIDE_OUT" | sed -n '2p')" \
    || die "a BACKWARD seek through the mount returned different bytes than the same read outside it"
  test "$(echo "$SEEK_OUT" | sed -n '3p')" = "$LARGE_SHA_ENDPOINT" \
    || die "a whole-object read through the mount does not digest to the value recorded by the endpoint"
  echo "  forward seek, backward seek and whole-object read all returned the bytes recorded outside the mount"

  resource_sample_stop

  # ------------------------------------------------------------------------------------------------------
  step "ARM $arm: no provider access material reached the client cache, the mount configuration or a server's library state"
  # ------------------------------------------------------------------------------------------------------
  # THE CLAIM IS ABOUT THE ENDPOINT CREDENTIAL, and this arm carried two of them: the original and the value
  # it was rotated to. Each is searched for by exact value, so a clean result means something.
  printf '%s\n' "$DAV_TOKEN" "$ROTATED_TOKEN" "Authorization:" "Bearer " > "$WORK/out/leak-needles-client.txt"
  printf '%s\n' "$DAV_TOKEN" "$ROTATED_TOKEN" > "$WORK/out/leak-needles-token.txt"
  printf '%s\n' "$DAV_TOKEN" "$ROTATED_TOKEN" "fakedav" > "$WORK/out/leak-needles-library.txt"
  chmod 644 "$WORK/out/leak-needles-client.txt" "$WORK/out/leak-needles-token.txt" \
    "$WORK/out/leak-needles-library.txt"

  docker run --rm -v "$work_arm/rclone-cache:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
    sh /out/leakcheck.sh "the mount client cache" /out/leak-needles-client.txt 0 \
    || die "the mount client's cache holds the endpoint credential"

  docker run --rm -v "$work_arm/rclone-config:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
    sh /out/leakcheck.sh "the mount client configuration" /out/leak-needles-token.txt 0 \
    || die "the mount client wrote the endpoint credential into its configuration"

  for scan_dir in jf-config plex-config emby-config; do
    docker run --rm -v "$work_arm/$scan_dir:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
      sh /out/leakcheck.sh "a media server's library state" /out/leak-needles-library.txt \
      || die "a media server persisted the endpoint credential or the endpoint's name"
  done
  echo "  no media server's library state names the endpoint or holds its credential"

  # AND THE CREDENTIAL REALLY WAS REQUIRED, or every search above was a search for something optional.
  docker run --rm --network "$NETWORK" -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
    sh /probe/probe.sh "http://fakedav:8098/dav/Canary/${CANARY_FILE}" "$ROTATED_TOKEN" >/dev/null 2>&1 \
    || die "the endpoint stopped honouring the credential, so the searches above had no subject"
  echo "  and the endpoint still requires it, so the searches had a subject"

  # ------------------------------------------------------------------------------------------------------
  step "ARM $arm: recording the operational rounds, and the arm's own report"
  # ------------------------------------------------------------------------------------------------------
  # THE WEBDAV ENDPOINT HAS NO ACCESS-RESOLUTION STEP, so `resolutions` is recorded as 0 rather than assumed
  # away: this topology's namespace IS its URL space. The credential-required probe above is this arm's proof
  # that the leak searches had a subject.
  node "$REL/out/rounds.cjs" \
    "$rel_arm/out/operational-rounds.json" "$arm" "$R1_HELD" "$R1_STALL_MS" "$R2_ATTEMPT" "$R3_READY_MS" 0
  drive redaction-check --file "$rel_arm/out/results.json"
  plain report --results "$rel_arm/out/results.json"

  # ------------------------------------------------------------------------------------------------------
  step "ARM $arm: stopping it — the namespace goes away, and a stale one does not linger"
  # ------------------------------------------------------------------------------------------------------
  docker rm -f "$RC_PLEX_CONTAINER" "$RC_JF_CONTAINER" "$RC_EMBY_CONTAINER" >/dev/null 2>&1 || true
  docker stop -t 30 "$RC_MOUNT_CONTAINER" >/dev/null
  namespace_gone "the mount client" || die "the namespace is still visible after the mount client stopped"
  docker rm -f "$RC_DAV_CONTAINER" >/dev/null 2>&1 || true
  echo "  $arm stopped; the namespace is gone"
}

run_rclone_arm "arm-b" "off"
run_rclone_arm "arm-c" "full"

# ==========================================================================================================
# CHUNK 5: THE COMPARISON, AND THE REPORT THE ACCEPTANCE PLAN ACTUALLY ASKS FOR. Every arm recorded the same
# operational rounds (R1/R2/R3) and the same resource figures, so the comparison is a table of three rows of
# the same columns — a comparison whose columns differed per arm would be a comparison of two instruments.
# ==========================================================================================================
cat > "$REL/out/compare.cjs" <<'COMPARE'
const { readFileSync, writeFileSync } = require('node:fs');
const [, , aDir, bDir, cDir, outPath] = process.argv;
const read = (dir, file) => JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
const arms = ['arm-a', 'arm-b', 'arm-c'];
const dirs = { 'arm-a': aDir, 'arm-b': bDir, 'arm-c': cDir };
const rows = [];
for (const arm of arms) {
  const rounds = read(dirs[arm], 'operational-rounds.json');
  const res = read(dirs[arm], 'resources.json');
  const results = read(dirs[arm], 'results.json');
  const counts = results.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] || 0) + 1; return acc; }, {});
  rows.push({
    arm,
    r1: { stallBound: rounds.r1.stallBound, stallMs: rounds.r1.stallMs },
    r2: { convergedOnRead: rounds.r2.convergedOnRead },
    r3: { readyMs: rounds.r3.readyMs },
    resolutions: rounds.resolutions,
    resources: {
      cpuAvgPct: res.cpuAvgPct, cpuPeakPct: res.cpuPeakPct,
      memAvgMb: res.memAvgMb, memPeakMb: res.memPeakMb,
    },
    verdicts: { pass: counts.pass || 0, fail: counts.fail || 0, skip: counts.skip || 0 },
  });
}
const line = (label, a, b, c) => {
  const pad = (s, w) => String(s).padEnd(w);
  console.log(`  ${pad(label, 22)}${pad(a, 12)}${pad(b, 12)}${pad(c, 12)}`);
};
console.log('  === THE THREE FRONTS, SAME COLUMNS, SAME OBSERVER ===');
line('', 'arm-a FUSE', 'arm-b rc-off', 'arm-c rc-full');
line('R1 stall bound', rows[0].r1.stallBound, rows[1].r1.stallBound, rows[2].r1.stallBound);
line('R1 stall (ms)', rows[0].r1.stallMs, rows[1].r1.stallMs, rows[2].r1.stallMs);
line('R2 converged on read', rows[0].r2.convergedOnRead, rows[1].r2.convergedOnRead, rows[2].r2.convergedOnRead);
line('R3 ready (ms)', rows[0].r3.readyMs, rows[1].r3.readyMs, rows[2].r3.readyMs);
line('access resolutions', rows[0].resolutions, rows[1].resolutions, rows[2].resolutions);
line('cpu avg %', rows[0].resources.cpuAvgPct, rows[1].resources.cpuAvgPct, rows[2].resources.cpuAvgPct);
line('cpu peak %', rows[0].resources.cpuPeakPct, rows[1].resources.cpuPeakPct, rows[2].resources.cpuPeakPct);
line('mem avg MB', rows[0].resources.memAvgMb, rows[1].resources.memAvgMb, rows[2].resources.memAvgMb);
line('mem peak MB', rows[0].resources.memPeakMb, rows[1].resources.memPeakMb, rows[2].resources.memPeakMb);
line('gates pass/fail', `${rows[0].verdicts.pass}/${rows[0].verdicts.fail}`,
  `${rows[1].verdicts.pass}/${rows[1].verdicts.fail}`, `${rows[2].verdicts.pass}/${rows[2].verdicts.fail}`);
writeFileSync(outPath, `${JSON.stringify({ arms: rows }, null, 2)}\n`);
COMPARE

# ----------------------------------------------------------------------------------------------------------
step "the comparison: THE SAME OBSERVER MEASURED ALL THREE FRONTS, AND THE ROUNDS SAY WHERE THEY DIFFER"
# ----------------------------------------------------------------------------------------------------------
# A ZERO IN THE RESOLUTIONS COLUMN IS NOT AN EFFICIENCY. Arm A's endpoint mints a short-lived lease per read
# (counted); the WebDAV endpoint has no resolution step because its namespace IS the URL space, so the rclone
# arms' zero means the question does not arise there, exactly as the rclone CLI's own report says.
node "$REL/out/compare.cjs" "$REL/arm-a/out" "$REL/arm-b/out" "$REL/arm-c/out" "$REL/out/comparison.json"

# ----------------------------------------------------------------------------------------------------------
step "the final redaction check, on everything this gate wrote that could have held a secret"
# ----------------------------------------------------------------------------------------------------------
# The per-arm results files and the comparison are the two documents anyone will quote from; both must pass
# the same redaction rule the arms' own reports already enforced on their results files.
ARM_REL="$REL/arm-a"
ARM_CLI="src/ops/projection-three-server-concurrency-cli.ts"
drive redaction-check --file "$ARM_REL/out/results.json"
ARM_CLI="src/ops/projection-rclone-comparison-cli.ts"
drive redaction-check --file "$REL/arm-b/out/results.json"
drive redaction-check --file "$REL/arm-c/out/results.json"

# ----------------------------------------------------------------------------------------------------------
step "the report"
# ----------------------------------------------------------------------------------------------------------
echo
echo "MULTI-FRONTEND COMPARISON (PHASE 1) COMPLETED. What was actually measured:"
echo "  - ARM A  projectiond-FUSE over fakerange: an access-resolution step, a token file, one daemon, and the"
echo "           daemon's own probe cache as the frontend's read-ahead cache."
echo "  - ARM B  rclone --vfs-cache-mode off over fakewebdav: no resolution step, no read-ahead cache."
echo "  - ARM C  rclone --vfs-cache-mode full over the same WebDAV endpoint: a persistent read-ahead cache."
echo "  - every arm served THE SAME corpus and barrier fixture, under three real digest-pinned media servers,"
echo "    and was scanned by THE SAME observer, with THE SAME three rounds:"
echo "      R1 a provider stall    — can a full read be served from what the frontend already holds?"
echo "      R2 a credential rotation — when the provider's secret changes mid-run, how does the frontend"
echo "                                 converge, and on which read?"
echo "      R3 a frontend restart  — how fast is the namespace back, and do all three servers re-catalogue"
echo "                                 the same identities afterwards?"
echo "  - provider access material (the original and the rotated credential, and arm A's lease marker) was"
echo "    searched for by exact value in every manifest, probe cache, mount configuration and server library"
echo "    state each arm left behind, and each arm proved the searches had a subject."
echo "  - the comparison above is THE same instrument's readout over all three arms; its columns are identical"
echo "    and its figures are the R1/R2/R3 rounds and the sampled CPU/RAM of the FRONTEND container only."
echo
echo "WHAT THIS COMPARISON DOES NOT DO:"
echo "  - it does not declare a winner. The naive path is here to be MEASURED, not to be proved worse."
echo "  - it does not claim a real WebDAV service, a real network FUSE, or a real provider; both endpoints are"
echo "    this gate's own fixtures."
echo "  - it does not claim latency, throughput or any time-to-first-byte figure; the only wall-clock figures"
echo "    are R1's stall and R3's readiness, and they are round outcomes, not transport measurements."
npx tsx "$ARM_CLI" nonclaims
echo
echo "MULTI-FRONTEND COMPARISON GATE COMPLETED: all three arms measured, all three arms reported, and the"
echo "comparison read them through one observer."
