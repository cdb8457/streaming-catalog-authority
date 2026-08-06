#!/usr/bin/env bash
# G27's THREE-SERVER HALF: a path is immutable, and a corrected path is a delete and an add.
#
# WHAT G27 SAYS, VERBATIM. "A successor that moves a carried entry's path is REFUSED by admission and the
# namespace does not change. The retire -> grace -> delete -> add sequence is then run end to end; all three
# servers show the removal and the addition. Whether a server preserves watch state across that pair is
# RECORDED, not asserted."
#
# WHAT THIS GATE IS AND WHAT IT IS NOT. The admission-refusal half is already closed OFFLINE by
# `npm run test:projection-publisher`, which builds the moved-carried-entry snapshot directly and requires the
# named problem `PATH_CHANGED_FOR_CARRIED_ENTRY`. That test is untouched and remains the authority on the
# PUBLISHER's refusal. This gate is the half a unit test cannot reach: the same illegal move forged into a
# real artifact under a real pointer and refused by the DAEMON, with three real, digest-pinned media servers
# watching the namespace not change — and then the lawful four-generation sequence run end to end past them.
#
# ONE DAEMON, ONE MOUNT, ONE GENERATION SEQUENCE, THREE READERS. Running three single-server gates in
# sequence would stand up three daemons over three namespaces and would prove that three unrelated appliances
# each handle a deletion. Nothing would be shared, so nothing would be about the thing G27 is about: that ONE
# namespace change is observed the same way by three servers that see it independently.
#
# EVERY PHASE IS A SET DIFFERENCE, NEVER A COUNT. "All three servers show the removal" is satisfied by a count
# that happens to drop, by a scan that returned nothing, by a stale inventory read twice, and by a server that
# removed the wrong item and added another. Counts cannot tell those apart, so each phase compares two
# INVENTORIES — path, the server's OWN item id, size — and reports what entered, what left, and what changed
# identity underneath a path that stayed.
#
# NOTHING HERE NEEDS A PROVIDER. Both entries are LOCAL passthrough sources, so no endpoint is stood up and no
# byte is fetched over HTTP. G27 is about the namespace, not the transport.
#
# EVERYTHING IS BOUNDED. Every readiness probe, scan and wait has a hard deadline; a hang fails the gate
# rather than occupying the machine.
set -euo pipefail
# shellcheck source=deploy/projection-gate-cleanup.sh
. "$(cd "$(dirname "$0")" && pwd)/projection-gate-cleanup.sh"
export MSYS_NO_PATHCONV=1

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
# THE MEDIA SERVERS, PINNED BY DIGEST, and the same three digests the other three-server gate pins. A tag
# would let the thing under test change between two runs of a gate whose claim is that it passed three times.
JELLYFIN_IMAGE="jellyfin/jellyfin@sha256:7ae36aab93ef9b6aaff02b37f8bb23df84bb2d7a3f6054ec8fc466072a648ce2"
PLEX_IMAGE="plexinc/pms-docker@sha256:a2b03d75aa16f422488c692935cab476d966b75f2af3c93bb6d910c6051906f5"
EMBY_IMAGE="emby/embyserver@sha256:734a6f03c7c783a9e566b08d09a2b6376f41229ff29f032a7e00302e0be98f8a"
# THE MEDIA GENERATOR IS THE JELLYFIN IMAGE, because it already ships an ffmpeg and is already pinned here.
# Pulling a separate ffmpeg image would add a fourth external dependency to a gate that needs no new one.
GENERATOR_IMAGE="$JELLYFIN_IMAGE"
GENERATOR_FFMPEG="/usr/lib/jellyfin-ffmpeg/ffmpeg"

COMPOSE_FILE="docker-compose.projection-lifecycle.yml"
NETWORK="projection-lifecycle-gate"
PG_PORT="${PROJECTION_LIFECYCLE_GATE_PG_PORT:-5550}"
JF_PORT="${PROJECTION_LIFECYCLE_GATE_JELLYFIN_PORT:-8160}"
EMBY_PORT="${PROJECTION_LIFECYCLE_GATE_EMBY_PORT:-8161}"
PLEX_PORT="${PROJECTION_LIFECYCLE_GATE_PLEX_PORT:-32540}"

MOUNT_CONTAINER="projection-lc-mount-$$"
JF_CONTAINER="projection-lc-jellyfin-$$"
PLEX_CONTAINER="projection-lc-plex-$$"
EMBY_CONTAINER="projection-lc-emby-$$"

GATE_ROOT="$PWD/.projection-lifecycle-gate"
REL=".projection-lifecycle-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_LIFECYCLE_GATE_PG_PORT="$PG_PORT"

cleanup() {
  # THE MEDIA SERVERS FIRST, ALL THREE. Each holds open handles on the mount, and a FUSE mount with a live
  # reader does not unmount cleanly.
  docker rm -f "$PLEX_CONTAINER" "$JF_CONTAINER" "$EMBY_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$MOUNT_CONTAINER" >/dev/null 2>&1 || true
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
logs_tail() { docker logs --tail 40 "$1" 2>&1 | tail -40 >&2 || true; }

field()     { node "$REL/jq.cjs" "$1"; }
publish()   { npx tsx src/ops/projection-publish-cli.ts --manifest-dir "$REL/manifest" "$@"; }
register()  { npx tsx src/ops/projection-register-cli.ts "$@"; }
forge()     { npx tsx src/ops/projection-forge-adversarial-cli.ts --manifest-dir "$REL/manifest" "$@"; }
lifecycle() { npx tsx src/ops/projection-path-lifecycle-cli.ts "$@" --results "$REL/out/results.json"; }
jellyfin()  { npx tsx src/ops/projection-jellyfin-dataplane-cli.ts "$@"; }
plex()      { npx tsx src/ops/projection-plex-dataplane-cli.ts "$@"; }
emby()      { npx tsx src/ops/projection-emby-dataplane-cli.ts "$@"; }
ffmpeg_run() { docker run --rm --entrypoint "$GENERATOR_FFMPEG" -v "$WORK:/work" "$GENERATOR_IMAGE" "$@"; }

# THE DAEMON'S OWN STATEMENT OF WHAT IT IS SERVING. Not the pointer — the pointer is the CONTROL PLANE's
# claim, and the whole point of the refusal phase is that the daemon does not follow it.
#
# IT TAKES BOTH SPELLINGS, and run 4 on the real host is why. The daemon says `serving generation N` ONCE,
# when it first mounts; every later admission is `admitted generation N (+a added, -r removed)`. Matching
# only the first spelling meant every phase read back generation 1 — so the whole lifecycle passed, the
# namespace demonstrably changed twice under it, and the sequence check then reported one distinct
# generation. That check was right to fail: an observer that always returns the same answer cannot tell a
# four-generation lifecycle from a world that never moved.
served_generation() {
  docker logs "$MOUNT_CONTAINER" 2>&1 \
    | grep -oE "(serving|admitted) generation [0-9]+" | tail -1 | awk '{print $3}'
}

mkdir -p "$WORK/manifest" "$WORK/media" "$WORK/cache" "$WORK/mnt" "$WORK/out" \
         "$WORK/jf-config" "$WORK/jf-cache" "$WORK/emby-config" "$WORK/plex-config" "$WORK/plex-transcode"
chmod 755 "$GATE_ROOT" "$WORK"
chmod 777 "$WORK/cache" "$WORK/mnt" "$WORK/out" "$WORK/jf-config" "$WORK/jf-cache" \
          "$WORK/emby-config" "$WORK/plex-config" "$WORK/plex-transcode"

cat > "$WORK/jq.cjs" <<'JQ'
// One field out of a JSON document on stdin, for shells that have no jq.
//
// THE DECODE IS SET ON THE STREAM, NOT DONE PER CHUNK. `raw += chunk` coerces each Buffer with its own
// `toString()`, so a multi-byte character split across a read boundary becomes two U+FFFD replacement
// characters -- silently, exit 0, with a value that is no longer the value the document carried. Measured on
// an 800 KB document of two-byte characters: 24 replacement characters and a wrong answer, reported as a
// success. `setEncoding` decodes with a StringDecoder that holds the partial sequence across the boundary.
// Today's fixtures are ASCII, so this is latent. The operator corpus Phase 1 closes against is NOT GUARANTEED
// to be ASCII -- no such corpus exists yet, so nothing here claims to have measured one -- and every gate reads
// its verdicts through this program.
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const document = JSON.parse(raw);
  // AND A DOCUMENT THAT IS NOT AN OBJECT ANSWERS '' FOR EVERY FIELD, which is the shape of a field that is
  // merely absent. A caller comparing that to an expected value fails for the wrong reason, and one testing
  // it for emptiness passes. Neither may read a scalar as an answer.
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    console.error('jq: the document on stdin is not an object, so no field of it can be read');
    process.exit(2);
  }
  const value = document[process.argv[2]];
  console.log(value === undefined ? '' : String(value));
});
JQ

cat > "$WORK/sha.cjs" <<'SHA'
// The digest of a whole file. AN OBJECT THAT YIELDED NO BYTES IS NOT AN OBJECT THAT DIGESTS TO
// e3b0c442...b855 -- that value is the answer to "there was nothing here", and a gate comparing it against
// another empty read would call the two equal.
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const bytes = readFileSync(process.argv[2]);
if (bytes.length === 0) {
  console.error('sha: the object is empty, so there is nothing to digest');
  process.exit(3);
}
console.log(createHash('sha256').update(bytes).digest('hex'));
SHA

cat > "$WORK/watch.cjs" <<'WATCH'
const { readFileSync, writeFileSync } = require('node:fs');
const [, , beforePath, afterPath, keyA, keyB, out] = process.argv;
const before = JSON.parse(readFileSync(beforePath, 'utf8'));
const after = JSON.parse(readFileSync(afterPath, 'utf8'));
const observations = before.map((inventory) => {
  const was = inventory.items.find((item) => item.key === keyA);
  const now = (after.find((entry) => entry.server === inventory.server)?.items ?? [])
    .find((item) => item.key === keyB);
  return {
    server: inventory.server,
    preserved: was === undefined || now === undefined ? undefined : was.itemId === now.itemId,
    detail: was === undefined || now === undefined
      ? 'one side of the pair was not catalogued, so nothing can be said'
      : `the item id ${was.itemId === now.itemId ? 'was reused' : 'changed'} across the pair`,
  };
});
writeFileSync(out, `${JSON.stringify(observations, null, 2)}\n`);
WATCH

cat > "$WORK/expect.cjs" <<'EXPECT'
// The expectation each server's own scan barrier is driven against, as a BARE ARRAY of entries carrying an
// `anchor` flag — which is the shape `corpusProblems` in media-server-dataplane.ts actually reads.
//
// IT TAKES (key, size, sha) TRIPLES rather than one entry, so the barrier covers the lifecycle entry AND the
// bystander together. A barrier that waited for only one of the two published entries would release while
// the library was still half-scanned, and the very first inventory would then be a partial one.
const { writeFileSync } = require('node:fs');
const [, , out, ...rest] = process.argv;
const entries = [];
for (let index = 0; index + 2 < rest.length; index += 3) {
  entries.push({ key: rest[index], sizeBytes: Number(rest[index + 1]), sha256: rest[index + 2],
    kind: 'local', anchor: true });
}
writeFileSync(out, `${JSON.stringify(entries, null, 2)}\n`);
EXPECT

# ----------------------------------------------------------------------------------------------------------
step "the Compose file this gate uses is valid"
# ----------------------------------------------------------------------------------------------------------
docker compose -f "$COMPOSE_FILE" config >/dev/null || die "the gate's Compose file is not valid"

# ----------------------------------------------------------------------------------------------------------
step "checking this host can host the gate at all"
# ----------------------------------------------------------------------------------------------------------
GATE_SKIP_STATUS=77
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no /dev/fuse is reachable from a container on this host." >&2
  echo "      G27's three-server half is entirely UNPROVEN here. Nothing in this gate ran, and this run" >&2
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
step "writing the two local files, and recording their digests OUTSIDE the mount"
# ----------------------------------------------------------------------------------------------------------
# PATH A AND PATH B ARE DIFFERENT FILES WITH DIFFERENT BYTES, and that is deliberate. If the corrected path
# carried the same bytes, a server that had silently kept the old item and renamed it would produce exactly
# the digest the addition phase expects.
#
# THEY ARE REAL MP4s, GENERATED WITH FFMPEG, and run 2 on the real host is why. The first version wrote
# deterministic byte fills named `.bin`: Jellyfin and Emby both catalogued them, Plex catalogued NOTHING and
# its scan settled in one second. Plex's movie scanner only considers files whose extension it recognises as
# video, so a `.bin` is not a thing it declines to identify — it is a thing it never looks at. The gate would
# have been asserting a lifecycle against two servers and an empty library.
FILE_A="Projection Lifecycle A (2026).mp4"
FILE_B="Projection Lifecycle B (2026).mp4"
# THE BYSTANDER. It is published in generation 1, is never retired, never deleted and never re-registered,
# and it exists so that NO inventory in this gate is ever empty. An empty listing produces a difference of
# zero against anything, which is what every "nothing else changed" assertion below wants to hear -- so a
# scan that silently did no work would satisfy the deletion phase and the addition phase both. With a
# bystander in the library, a zero-work scan fails coherence instead, and "exactly the removal of path A"
# becomes a claim about a world that still demonstrably contains something else.
FILE_C="Projection Lifecycle Bystander (2026).mp4"
PATH_A="Movies/Projection Lifecycle A (2026)/$FILE_A"
PATH_B="Movies/Projection Lifecycle B (2026)/$FILE_B"
PATH_C="Movies/Projection Lifecycle Bystander (2026)/$FILE_C"

# THREE DIFFERENT DURATIONS AND THREE DIFFERENT TONES, so no two of them are byte-identical. If the corrected
# path carried the same bytes as the original, a server that had silently kept the old item and renamed it
# would produce exactly the digest the addition phase expects, and the digest check would confirm a defect.
generate() { # file, duration, tone
  ffmpeg_run -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc=size=128x96:rate=15:duration=$2" \
    -f lavfi -i "sine=frequency=$3:duration=$2" \
    -c:v mpeg4 -qscale:v 5 -c:a aac -b:a 32k -shortest -movflags +faststart "/work/media/$1"
}
generate "$FILE_A" 3 311
generate "$FILE_B" 4 440
generate "$FILE_C" 2 220
SIZE_A="$(wc -c < "$WORK/media/$FILE_A" | tr -d ' ')"
SIZE_B="$(wc -c < "$WORK/media/$FILE_B" | tr -d ' ')"
SIZE_C="$(wc -c < "$WORK/media/$FILE_C" | tr -d ' ')"
SHA_A="$(node "$REL/sha.cjs" "$REL/media/$FILE_A")"
SHA_B="$(node "$REL/sha.cjs" "$REL/media/$FILE_B")"
SHA_C="$(node "$REL/sha.cjs" "$REL/media/$FILE_C")"
test "$SHA_A" != "$SHA_B" || die "the two files are byte-identical, so no digest comparison could discriminate"
test "$SIZE_A" -gt 0 && test "$SIZE_B" -gt 0 && test "$SIZE_C" -gt 0 || die "a generated file is empty"
echo "  A $SIZE_A bytes, B $SIZE_B bytes, bystander $SIZE_C bytes; digests recorded before publishing"

# ----------------------------------------------------------------------------------------------------------
step "generation 1: the active item at path A"
# ----------------------------------------------------------------------------------------------------------
ITEM_A="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
ITEM_B="bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"
ITEM_C="cccccccc-3333-4333-8333-cccccccccccc"
register root --id media --kind local
register version --key lifecycle-a --size "$SIZE_A" --mtime 2026-06-01T10:00:00.000Z
register entry --item "$ITEM_A" --version-key lifecycle-a --path "$PATH_A" --source "local:media:$FILE_A"
register version --key lifecycle-c --size "$SIZE_C" --mtime 2026-06-01T09:00:00.000Z
register entry --item "$ITEM_C" --version-key lifecycle-c --path "$PATH_C" --source "local:media:$FILE_C"
publish > "$WORK/out/publish-1.json"
test "$(field outcome < "$WORK/out/publish-1.json")" = "published" || die "generation 1 was not published"
echo "  generation 1 published"

# ----------------------------------------------------------------------------------------------------------
step "mounting with the production image: /dev/fuse, CAP_SYS_ADMIN, strict direct mount, nothing else"
# ----------------------------------------------------------------------------------------------------------
cat > "$WORK/config.json" <<'JSON'
{
  "mountPoint": "/mnt/projection",
  "pointerPath": "/var/lib/projectiond/manifest/pointer.json",
  "probeCacheDir": "/var/lib/projectiond/cache",
  "localRoots": { "media": "/var/lib/projectiond/media" }
}
JSON

docker run -d --name "$MOUNT_CONTAINER" \
  --network "$NETWORK" --user 0:0 \
  --cap-drop ALL --cap-add SYS_ADMIN --security-opt apparmor:unconfined \
  --device /dev/fuse:/dev/fuse \
  -v "$WORK/manifest:/var/lib/projectiond/manifest:ro" \
  -v "$WORK/media:/var/lib/projectiond/media:ro" \
  -v "$WORK/cache:/var/lib/projectiond/cache" \
  -v "$WORK/config.json:/etc/projectiond/config.json:ro" \
  -v "$WORK/mnt:/mnt/projection:rshared" \
  "$IMAGE" --config /etc/projectiond/config.json --poll 2s --strict-direct-mount >/dev/null

echo "  waiting for the namespace to become visible to another container"
ready=0
for _ in $(seq 1 120); do
  if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" test -f "/mnt/$PATH_A" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
test "$ready" -eq 1 || { logs_tail "$MOUNT_CONTAINER"; die "the mount never became visible"; }
GEN_SEED="$(served_generation)"
echo "  the daemon is serving generation $GEN_SEED"

# ----------------------------------------------------------------------------------------------------------
step "starting THREE REAL MEDIA SERVERS over the SAME mount"
# ----------------------------------------------------------------------------------------------------------
# The three start commands are deliberately NOT unified; see the three-server concurrency gate for why. Emby
# cannot take --user because its entrypoint is an s6 tree that does the setuid itself; Plex must be addressed
# by address rather than by name; only Jellyfin runs happily under --user with all capabilities dropped.
docker run -d --name "$JF_CONTAINER" --network "$NETWORK" --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges \
  -p "127.0.0.1:${JF_PORT}:8096" \
  -e JELLYFIN_PublishedServerUrl="http://127.0.0.1:${JF_PORT}" \
  -v "$WORK/jf-config:/config" -v "$WORK/jf-cache:/cache" \
  -v "$WORK/mnt:/media/projection:rslave" "$JELLYFIN_IMAGE" >/dev/null
docker run -d --name "$EMBY_CONTAINER" --network "$NETWORK" \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --security-opt no-new-privileges -e UID=1000 -e GID=1000 \
  -p "127.0.0.1:${EMBY_PORT}:8096" \
  -v "$WORK/emby-config:/config" -v "$WORK/mnt:/media/projection:rslave" "$EMBY_IMAGE" >/dev/null
docker run -d --name "$PLEX_CONTAINER" --network "$NETWORK" \
  -p "127.0.0.1:${PLEX_PORT}:32400" -e TZ=UTC -e PLEX_UID=1000 -e PLEX_GID=1000 \
  -e ALLOWED_NETWORKS=0.0.0.0/0 -e ADVERTISE_IP="http://127.0.0.1:${PLEX_PORT}/" \
  -v "$WORK/plex-config:/config" -v "$WORK/plex-transcode:/transcode" \
  -v "$WORK/mnt:/media/projection:rslave" "$PLEX_IMAGE" >/dev/null
echo "  three media servers started, all three with the same projected mount as a library root"

JF_STATE="$REL/out/state-jellyfin.json"
EMBY_STATE="$REL/out/state-emby.json"
PLEX_STATE="$REL/out/state-plex.json"
# NAMED EXPLICITLY, one flag per server, so a state file that was never written is a NAMED failure rather
# than an empty inventory that would satisfy the deletion assertion for entirely the wrong reason.
STATES="--state-jellyfin $JF_STATE --state-emby $EMBY_STATE --state-plex $PLEX_STATE"

# ----------------------------------------------------------------------------------------------------------
step "standing each server up through ITS OWN driver"
# ----------------------------------------------------------------------------------------------------------
jellyfin bootstrap --base "http://127.0.0.1:${JF_PORT}" --state "$JF_STATE" \
  || { logs_tail "$JF_CONTAINER"; die "Jellyfin never came up"; }
emby bootstrap --base "http://127.0.0.1:${EMBY_PORT}" --state "$EMBY_STATE" \
  || { logs_tail "$EMBY_CONTAINER"; die "Emby never came up"; }
plex bootstrap --base "http://127.0.0.1:${PLEX_PORT}" --state "$PLEX_STATE" \
  || { logs_tail "$PLEX_CONTAINER"; die "Plex never came up"; }

# EACH SERVER MUST READ THE MOUNT AS THE UID IT ACTUALLY RUNS AS, before a scan is asked for — otherwise a
# scan that finds nothing is ambiguous between "projection is broken" and "the container cannot see it".
docker exec -u 1000:1000 "$JF_CONTAINER"   test -r "/media/projection/$PATH_A" \
  || die "Jellyfin's own uid cannot read the projected file"
docker exec -u 1000:1000 "$EMBY_CONTAINER" test -r "/media/projection/$PATH_A" \
  || die "Emby's own uid cannot read the projected file"
docker exec --user 1000:1000 "$PLEX_CONTAINER" test -r "/media/projection/$PATH_A" \
  || die "Plex's own uid cannot read the projected file"
echo "  all three servers can read the projected file as the uid each runs as"
plex prefs --state "$PLEX_STATE"

# ----------------------------------------------------------------------------------------------------------
step "adding the SAME mount as a Movies library on all three"
# ----------------------------------------------------------------------------------------------------------
jellyfin library --state "$JF_STATE"   --mount-path /media/projection/Movies --name "Projection Movies"
emby     library --state "$EMBY_STATE" --mount-path /media/projection/Movies --name "Projection Movies"
# PLEX LAST, because creating a section starts a scan of it immediately and nothing in its API asks it not to.
plex     library --state "$PLEX_STATE" --mount-path /media/projection/Movies --name "Projection Movies"

# ...AND PLEX'S CREATION SCAN IS WAITED OUT EXPLICITLY, so no later phase races it.
node "$REL/expect.cjs" "$REL/out/expect-a.json" "$FILE_A" "$SIZE_A" "$SHA_A" "$FILE_C" "$SIZE_C" "$SHA_C"
plex scan --state "$PLEX_STATE" --expect-file "$REL/out/expect-a.json" \
  --out "$REL/out/plex-seed-items.json" --label seed \
  || { logs_tail "$PLEX_CONTAINER"; die "Plex never settled after its own library-creation scan"; }
echo "  Plex's own creation scan has settled"

# ----------------------------------------------------------------------------------------------------------
step "L1 — all three servers catalogue the active item at path A"
# ----------------------------------------------------------------------------------------------------------
lifecycle scan $STATES --generation "$GEN_SEED" --out "$REL/out/inv-1.json"
lifecycle seed --after "$REL/out/inv-1.json" --path "$FILE_A" --generation "$GEN_SEED"
# THE BYSTANDER IS PROVEN PRESENT AT THE SEED TOO, so its survival through the lifecycle is a measurement
# against a known starting point rather than an assumption.
lifecycle seed --gate L1-bystander --after "$REL/out/inv-1.json" --path "$FILE_C" --generation "$GEN_SEED"

# ----------------------------------------------------------------------------------------------------------
step "L2 — an illegal MOVE of the carried entry is refused, and nothing anywhere changes"
# ----------------------------------------------------------------------------------------------------------
# THE PUBLISHER WOULD NEVER EMIT THIS, WHICH IS WHY IT IS FORGED. `test/projection-publisher.ts` already
# proves the publisher refuses a moved carried entry with `PATH_CHANGED_FOR_CARRIED_ENTRY`. What that test
# cannot show is a real artifact, under a real pointer, being refused by the DAEMON while three media servers
# watch the namespace not move. The forge writes exactly that successor and advances the pointer to it.
cp -a "$WORK/manifest" "$WORK/manifest-before-forge"
forge --mode relocate-path --path "$PATH_A" --to "$PATH_B" > "$WORK/out/forge.json"
echo "  a successor moving the carried entry's path has been published under a real pointer"
# The daemon polls every 2s; give it several polls to see the pointer, refuse it, and keep serving.
sleep 8
GEN_AFTER_FORGE="$(served_generation)"
lifecycle scan $STATES --generation "$GEN_AFTER_FORGE" --out "$REL/out/inv-2.json"
lifecycle refusal --before "$REL/out/inv-1.json" --after "$REL/out/inv-2.json" \
  --path-a "$FILE_A" --path-b "$FILE_B" \
  --generation-before "$GEN_SEED" --generation-after "$GEN_AFTER_FORGE"

# THE FORGED POINTER IS ROLLED BACK BY RESTORING THE BYTES THAT WERE THERE BEFORE IT, which is why the
# manifest directory was copied aside BEFORE the forge ran. There is no "un-publish" verb and there should
# not be one: the publisher's job is to REFUSE this successor, not to offer a way to withdraw one. But the
# lawful sequence below has to start from a pointer the daemon and the control plane agree about, and the
# only honest way to get there is to put back the last generation the daemon actually admitted.
#
# THE DIRECTORY ITSELF IS NEVER REPLACED, ONLY ITS CONTENTS, and run 3 on the real host is why. The first
# version did `rm -rf` on the manifest directory and copied the backup back into place. That directory is
# BIND-MOUNTED into the daemon's container: removing it detaches the container's mount from the new host
# inode, so the daemon saw `pointer-unreadable` on every poll from then on and never admitted another
# generation. The retire, the deletion and the addition were all published into a directory nothing was
# reading, and the run died four phases later at a symptom with no visible cause.
find "$WORK/manifest" -mindepth 1 -delete
cp -a "$WORK/manifest-before-forge/." "$WORK/manifest/"
sleep 6
if [ "$(served_generation)" != "$GEN_SEED" ]; then
  die "the daemon is not back on the generation it was serving before the forged one"
fi
# AND THE DAEMON IS PROVEN TO BE READING THE DIRECTORY AGAIN, not merely to have kept its last good state.
# Those two look identical from `served_generation` alone, and the second one is the failure above.
if docker logs --since 10s "$MOUNT_CONTAINER" 2>&1 | grep -q "pointer-unreadable"; then
  die "the daemon cannot read the restored pointer; its bind mount no longer reaches the manifest directory"
fi

# ----------------------------------------------------------------------------------------------------------
step "L3 — the entry is RETIRED, and path A stays visible and readable"
# ----------------------------------------------------------------------------------------------------------
GRACE_AT="$(node -e "console.log(new Date(Date.now() + 20000).toISOString())")"
register retire --path "$PATH_A" --intent-key lifecycle-drop-a \
  --declared-at "$(node -e "console.log(new Date().toISOString())")" --grace "$GRACE_AT"
publish > "$WORK/out/publish-retire.json"
test "$(field outcome < "$WORK/out/publish-retire.json")" = "published" || die "the retirement was not published"
sleep 6
GEN_RETIRE="$(served_generation)"

READABLE=false
docker run --rm -v "$WORK/mnt:/mnt:rslave" -v "$WORK/out:/out" "$VERIFY_IMAGE" \
  sh -c "sha256sum '/mnt/$PATH_A' | cut -d' ' -f1 > /out/retire-digest.txt" >/dev/null 2>&1 || true
[ "$(tr -d ' \r\n' < "$WORK/out/retire-digest.txt" 2>/dev/null)" = "$SHA_A" ] && READABLE=true

lifecycle scan $STATES --generation "$GEN_RETIRE" --out "$REL/out/inv-3.json"
lifecycle still-there --gate L3-retiring --before "$REL/out/inv-1.json" --after "$REL/out/inv-3.json" \
  --path "$FILE_A" --generation "$GEN_RETIRE" --readable "$READABLE"

# ----------------------------------------------------------------------------------------------------------
step "L4 — the grace deadline PASSES, and nothing disappears merely because time did"
# ----------------------------------------------------------------------------------------------------------
# THIS IS THE PHASE WITH TEETH. An implementation that swept retiring entries on a timer would pass every
# assertion about the retirement itself and fail only here. The deadline is 20s out and the gate waits past it.
echo "  waiting past the grace deadline ($GRACE_AT)"
sleep 26
GEN_GRACE="$(served_generation)"
lifecycle scan $STATES --generation "$GEN_GRACE" --out "$REL/out/inv-4.json"
lifecycle still-there --gate L4-past-grace --before "$REL/out/inv-3.json" --after "$REL/out/inv-4.json" \
  --path "$FILE_A" --generation "$GEN_GRACE" --readable true

# ----------------------------------------------------------------------------------------------------------
step "L5 — an EXPLICIT deletion generation removes exactly path A, on all three"
# ----------------------------------------------------------------------------------------------------------
publish --intent deletion --delete "$PATH_A" --acknowledge-deletion-guard > "$WORK/out/publish-delete.json"
test "$(field outcome < "$WORK/out/publish-delete.json")" = "published" || die "the deletion was not published"
test "$(field deletions < "$WORK/out/publish-delete.json")" = "1" || die "the deletion generation named none"
echo "  waiting for path A to leave the namespace"
gone=0
for _ in $(seq 1 120); do
  if ! docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" test -f "/mnt/$PATH_A" >/dev/null 2>&1; then
    gone=1; break
  fi
  sleep 0.5
done
test "$gone" -eq 1 || { logs_tail "$MOUNT_CONTAINER"; die "path A never left the namespace"; }
GEN_DELETE="$(served_generation)"
lifecycle scan $STATES --generation "$GEN_DELETE" --out "$REL/out/inv-5.json"
lifecycle deletion --before "$REL/out/inv-4.json" --after "$REL/out/inv-5.json" \
  --path "$FILE_A" --generation "$GEN_DELETE"

# ----------------------------------------------------------------------------------------------------------
step "L6 — the corrected path arrives as an ADDITION, and it is real"
# ----------------------------------------------------------------------------------------------------------
register version --key lifecycle-b --size "$SIZE_B" --mtime 2026-06-01T11:00:00.000Z
register entry --item "$ITEM_B" --version-key lifecycle-b --path "$PATH_B" --source "local:media:$FILE_B"
publish > "$WORK/out/publish-add.json"
test "$(field outcome < "$WORK/out/publish-add.json")" = "published" || die "the addition was not published"
test "$(field additions < "$WORK/out/publish-add.json")" = "1" || die "the addition added something else"
echo "  waiting for path B to enter the namespace"
here=0
for _ in $(seq 1 120); do
  if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" test -f "/mnt/$PATH_B" >/dev/null 2>&1; then
    here=1; break
  fi
  sleep 0.5
done
test "$here" -eq 1 || { logs_tail "$MOUNT_CONTAINER"; die "path B never entered the namespace"; }
GEN_ADD="$(served_generation)"

# THE BYTES, THROUGH THE MOUNT, AGAINST A DIGEST RECORDED OUTSIDE IT BEFORE ANYTHING WAS PUBLISHED.
DIGEST_OK=false
docker run --rm --user 65534:65534 --cap-drop ALL -v "$WORK/mnt:/mnt:rslave" -v "$WORK/out:/out" \
  "$VERIFY_IMAGE" sh -c "sha256sum '/mnt/$PATH_B' | cut -d' ' -f1 > /out/add-digest.tmp" >/dev/null 2>&1 || true
mv "$WORK/out/add-digest.tmp" "$WORK/out/add-digest.txt" 2>/dev/null || true
[ "$(tr -d ' \r\n' < "$WORK/out/add-digest.txt" 2>/dev/null)" = "$SHA_B" ] && DIGEST_OK=true

lifecycle scan $STATES --generation "$GEN_ADD" --out "$REL/out/inv-6.json"
lifecycle addition --before "$REL/out/inv-5.json" --after "$REL/out/inv-6.json" \
  --path "$FILE_B" --generation "$GEN_ADD" --size "$SIZE_B" --digest-ok "$DIGEST_OK"

# ----------------------------------------------------------------------------------------------------------
step "L7 — whether each server preserved watch state across delete+add: RECORDED, NEVER ASSERTED"
# ----------------------------------------------------------------------------------------------------------
# THE PLAN REFUSES TO CLAIM THIS AND SO DOES THIS GATE. A delete followed by an add is two operations on two
# identities; whether a server carries a play position or a watched flag across them is that server's
# business and this product has never promised it. What is recorded is what each server's own item id did.
node "$REL/watch.cjs" "$REL/out/inv-1.json" "$REL/out/inv-6.json" "$FILE_A" "$FILE_B" \
  "$REL/out/watch-state.json"
lifecycle watch-state --observations "$REL/out/watch-state.json"

# ----------------------------------------------------------------------------------------------------------
step "L8 — the sequence really ran: four distinct generations, in order"
# ----------------------------------------------------------------------------------------------------------
node -e "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))" \
  "$WORK/out/generations.json" "$GEN_SEED" "$GEN_RETIRE" "$GEN_DELETE" "$GEN_ADD"
lifecycle sequence --generations "$REL/out/generations.json"

# ----------------------------------------------------------------------------------------------------------
step "the report"
# ----------------------------------------------------------------------------------------------------------
lifecycle report --results "$REL/out/results.json" --json "$REL/out/results-summary.json"
echo "  redaction-safe"
