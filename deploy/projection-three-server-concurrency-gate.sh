#!/usr/bin/env bash
# The THREE-SERVER HIGH-CONCURRENCY SCAN gate — G18.
#
# WHAT G18 SAYS, VERBATIM, IN `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §5:
#
#   "All three servers scanning simultaneously: G14a–G17 still hold, unchanged."
#
# Two halves, and the second is the easy one. G14a–G17 are already code — `MEDIA_SERVER_BUDGETS` in
# `src/core/projection/media-server-dataplane.ts` — and this gate imports them rather than restating them,
# because "unchanged" is the word the plan uses. The hard half is SIMULTANEOUSLY, which is not a budget and
# cannot be asserted by measuring traffic.
#
# WHAT THIS IS NOT, AND IT IS THE SINGLE MOST IMPORTANT LINE IN THIS FILE. IT IS NOT A WRAPPER THAT RUNS THE
# THREE EXISTING GATES. Those three each stand up their own PostgreSQL, their own publisher, their own daemon,
# their own mount, their own fake endpoint and their own corpus. Running them at once would prove that three
# unrelated appliances can run beside each other on one laptop, which is a fact about Docker Desktop.
#
# WHAT IT ACTUALLY DOES:
#
#   ONE PostgreSQL, ONE publisher, ONE admitted generation, ONE production `projectiond`, ONE FUSE mount, ONE
#   fake HTTP Range endpoint and ONE ~50-entry corpus — and THREE REAL, DIGEST-PINNED MEDIA SERVERS, Plex,
#   Jellyfin and Emby, each with THE SAME mount directory bind-propagated in as its library root, all three
#   scanning it AT THE SAME TIME.
#
# HOW SIMULTANEITY IS ESTABLISHED, BECAUSE THIS IS WHERE A GATE LIKE THIS LIES.
#
#   NOT BY STARTING THREE COMMANDS QUICKLY. Three triggers landing inside a second is perfectly compatible
#   with three scans that never overlapped: a fast server can finish before a slow one starts. The trigger
#   spread is RECORDED as a harness health check and it is not the evidence.
#
#   BY OBSERVATION. One process, one clock, and every tick asks ALL THREE servers their own present-tense
#   "am I scanning right now" — `Running`/`Cancelling` on the two MediaBrowser-family servers, `refreshing`
#   or an outstanding library activity on Plex. A tick in which all three said yes is a sample of three
#   simultaneous in-flight scans. Three sequential scans produce ZERO of those, by construction.
#
#   AND THE FLOORS ARE ON ONE UNBROKEN RUN OF THOSE TICKS, NOT ON TOTALS. A run is broken by any idle,
#   unreadable or imprecise sample, and by any gap over twice the nominal tick — at most one missed poll —
#   and its duration is CREDITED at most one nominal tick per gap, so an observer that fell behind cannot
#   charge the time it did not poll. Scattered simultaneity is not simultaneous scanning, and unobserved
#   time is not overlap.
#
#   AND BY A RENDEZVOUS, so the observation is not luck. One remote object's provider read is HELD at the
#   endpoint before any scan is triggered. A scanner that reaches that object stops there and waits, so the
#   three arrive at their own pace and then coexist. THE HOLD IS NOT RELEASED WHEN THE RENDEZVOUS SUCCEEDS —
#   the first real run did that and destroyed the overlap it had just created — it runs for its whole bounded
#   window: THREE seconds of actual blocking, with the endpoint's own backstop at 4.5 s. The gap between them
#   is the lag between a request blocking and this gate's polled `/counters` NOTICING that it has, which a
#   real run proved is not free. Both sit strictly
#   under the daemon's five-second admission queue-wait budget, so no other object's read can be starved, and
#   far under its ten-second first-byte deadline, so no held read can fail. The hold makes the observation
#   likely; the observation makes the claim.
#
# HOW THE WINDOW IS KEPT COLD, WHICH IS THE OTHER WAY THIS GATE COULD LIE. G19 of the acceptance plan says a
# re-scan over an unchanged manifest costs the provider ZERO — a correct property of the product and a
# catastrophe for a concurrency measurement, because a warm window satisfies every ceiling by doing nothing.
# So the corpus generation is published AFTER all three libraries exist, the three concurrent scans are the
# FIRST thing that ever reads it, and the gate asserts all of: the endpoint had served ZERO bytes for any
# corpus object — the load-bearing one — the daemon's own scan-window cache GREW across the window, and a
# provider read was actually BLOCKED at the barrier. NOT that the daemon's cache was empty: it is not, and
# nothing is wrong, because this gate publishes a LOCAL seed entry on purpose and a local entry's own
# byte-identity window lands in that same cache. The first real run measured 33,187 bytes there.
#
# WHAT IT DOES NOT PROVE, AND WILL NOT BE PRESENTED AS PROVING. A Docker Desktop pass is NOT Linux/Unraid
# closure and closes NONE of G7–G13 or G18. No run has ever happened on a real Linux or Unraid host and no
# real provider endpoint has ever been contacted. Per-server provider attribution is impossible here and is
# not claimed: one daemon serves all three servers, so the endpoint sees the daemon and never the server
# behind a byte. G22, G27's three-server half and Phase 1 itself remain open.
#
# EVERYTHING IS BOUNDED. Every readiness probe, scan, observation and wait has a hard deadline; a hang fails
# the gate rather than occupying the machine.
set -euo pipefail
# shellcheck source=deploy/projection-gate-cleanup.sh
. "$(cd "$(dirname "$0")" && pwd)/projection-gate-cleanup.sh"

export MSYS_NO_PATHCONV=1

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
GO_IMAGE="golang:1.26.5-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"

# THE THREE MEDIA SERVERS, EACH PINNED BY DIGEST, EACH THE SAME DIGEST ITS OWN SINGLE-SERVER GATE PINS.
#
# THEY ARE THE SAME DIGESTS ON PURPOSE. Every behavioural finding this gate inherits — Emby publishing no
# `StartupWizardCompleted`, Plex refusing a request whose `Host` header it does not recognise, Jellyfin
# leaving a library's item id absent until the first scan — belongs to the version behind a particular
# digest. Pinning a different one here would mean this gate's three servers were not the three servers those
# findings were measured against, and the drivers it reuses would be driving something else.
JELLYFIN_IMAGE="jellyfin/jellyfin@sha256:7ae36aab93ef9b6aaff02b37f8bb23df84bb2d7a3f6054ec8fc466072a648ce2"
PLEX_IMAGE="plexinc/pms-docker@sha256:a2b03d75aa16f422488c692935cab476d966b75f2af3c93bb6d910c6051906f5"
EMBY_IMAGE="emby/embyserver@sha256:734a6f03c7c783a9e566b08d09a2b6376f41229ff29f032a7e00302e0be98f8a"

# THE MEDIA GENERATOR. It is Jellyfin's ffmpeg because that image is already pinned and already pulled on any
# host that has run the Jellyfin gate — and because on THIS gate the choice is immaterial in a way it is not
# on the other three: nothing here decodes anything. G18 is a scan gate. There is no playback, no seek and no
# transcode, so no assertion rests on a decoder's answer and the generator is a fixture factory rather than a
# judge. (The three single-server gates DO decode, and each of them says whose decoder it used and why.)
GENERATOR_IMAGE="$JELLYFIN_IMAGE"
GENERATOR_FFMPEG="/usr/lib/jellyfin-ffmpeg/ffmpeg"

COMPOSE_FILE="docker-compose.projection-three.yml"
NETWORK="projection-three-gate"
PG_PORT="${PROJECTION_THREE_GATE_PG_PORT:-5510}"
JF_PORT="${PROJECTION_THREE_GATE_JELLYFIN_PORT:-8120}"
EMBY_PORT="${PROJECTION_THREE_GATE_EMBY_PORT:-8121}"
RANGE_PORT="${PROJECTION_THREE_GATE_RANGE_PORT:-8122}"
PLEX_PORT="${PROJECTION_THREE_GATE_PLEX_PORT:-32520}"
DAEMON_STATUS_PORT=9099

# EVERY CONTAINER NAME CARRIES THIS SHELL'S PID, so a second copy of this gate — or one of the three
# single-server gates, which use different prefixes and different ports — cannot collide with it.
MOUNT_CONTAINER="projection-ts-mount-$$"
RANGE_CONTAINER="projection-ts-range-$$"
JF_CONTAINER="projection-ts-jellyfin-$$"
PLEX_CONTAINER="projection-ts-plex-$$"
EMBY_CONTAINER="projection-ts-emby-$$"

# TWO SPELLINGS OF ONE DIRECTORY: WORK is absolute and is what Docker bind mounts name, and it lives beside
# the repository because bind propagation needs a shared host mount; REL is relative and is what node and tsx
# are given, because an MSYS absolute path is not something a Windows node binary can open.
GATE_ROOT="$PWD/.projection-three-gate"
REL=".projection-three-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_THREE_GATE_PG_PORT="$PG_PORT"

cleanup() {
  # THE MEDIA SERVERS FIRST, ALL THREE. Each holds open handles on the mount, and a FUSE mount with a live
  # reader does not unmount cleanly — leaving one behind is how the NEXT run inherits a stale namespace and
  # passes for the wrong reason. Three of them makes that three times as likely, not less.
  docker rm -f "$PLEX_CONTAINER" "$JF_CONTAINER" "$EMBY_CONTAINER" >/dev/null 2>&1 || true
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
die()  { echo "GATE FAILED: $*" >&2; exit 1; }

# THE LOG COLLECTOR IS BOUNDED AND CANNOT HANG. `docker logs` on a live container without `--tail` streams
# until the container stops; a diagnostic that never returns turns a named failure into a wedged run, and the
# operator then has no diagnosis AND no machine.
logs_tail() { docker logs --tail 40 "$1" 2>&1 | tail -40 >&2 || true; }

field()    { node "$REL/jq.cjs" "$1"; }
publish()  { npx tsx src/ops/projection-publish-cli.ts --manifest-dir "$REL/manifest" "$@"; }
register() { npx tsx src/ops/projection-register-cli.ts "$@"; }
drive()    { npx tsx src/ops/projection-three-server-concurrency-cli.ts "$@" --results "$REL/out/results.json"; }
jellyfin() { npx tsx src/ops/projection-jellyfin-dataplane-cli.ts "$@"; }
plex()     { npx tsx src/ops/projection-plex-dataplane-cli.ts "$@"; }
emby()     { npx tsx src/ops/projection-emby-dataplane-cli.ts "$@"; }
ffmpeg_run() { docker run --rm --entrypoint "$GENERATOR_FFMPEG" -v "$WORK:/work" "$GENERATOR_IMAGE" "$@"; }

mkdir -p "$WORK/manifest" "$WORK/media" "$WORK/remote" "$WORK/cache" "$WORK/mnt" "$WORK/out" \
         "$WORK/jf-config" "$WORK/jf-cache" "$WORK/plex-config" "$WORK/plex-transcode" "$WORK/emby-config"
# Each media server's state directory is made writable by whoever it turns out to be. The MEDIA is not: it is
# 444 through the mount, and that is under test.
chmod 777 "$WORK/cache" "$WORK/mnt" "$WORK/out" \
          "$WORK/jf-config" "$WORK/jf-cache" "$WORK/plex-config" "$WORK/plex-transcode" "$WORK/emby-config"
# ...AND THE PATH INTO THEM IS TRAVERSABLE BY A UID THAT DID NOT CREATE IT.
#
# A DEFECT DOCKER DESKTOP CANNOT SHOW YOU. The permissive directories above are reached THROUGH `$GATE_ROOT`
# and `$WORK`, which `mkdir -p` created under whatever umask the operator happens to have. At the common 022
# they land at 0755 and everything works; at 077 — an ordinary hardened default — they land at 0700, and a
# container running as uid 1000 cannot traverse into them however permissive the leaf is. On Docker Desktop
# none of this is visible, because the host side of a bind carries no modes at all. So the traversal is made
# explicit rather than inherited: 0755, not 0777, because traversal is all that is needed.
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

cat > "$WORK/objects.cjs" <<'OBJECTS'
const { readFileSync } = require('node:fs');
const objects = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const object = objects.find((o) => o.ref === process.argv[3]);
if (!object) { console.error('no such object'); process.exit(1); }
if (process.argv[4] === 'sha256') console.log(object.sha256);
else if (process.argv[4] === 'size') console.log(object.size);
else console.log(object.probes.map((p) => [p.position, p.offset, p.length, p.sha256].join(':')).join(' '));
OBJECTS

cat > "$WORK/corpus.cjs" <<'CORPUS'
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

// THE BARRIER OBJECT IS FIRST, AND IT IS FIRST FOR TWO INDEPENDENT REASONS.
//
//   ITS PROJECTED PATH SORTS BEFORE EVERY OTHER ENTRY'S, so a scanner walking the namespace reaches it early
//   rather than at the end — which is what makes the rendezvous happen inside the hold's bounded window
//   instead of after it.
//
//   IT IS THE LARGE FIXTURE. Below `PLEX_LARGE_FIXTURE.MIN_BYTES` the daemon's own block envelope permits a
//   whole-object read, so the x0.5 byte fraction is not a bound on anything there and asserting it would
//   prove nothing. Above it the fraction binds, and THREE independent scanners each paying a full envelope
//   would breach it — so passing that assertion is the statement that the second and third concurrent scans
//   read what the first one cached.
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
      // A DETERMINISTIC ITEM ID PER INDEX, so two runs register the same corpus and a diff between two runs
      // is a difference in behaviour rather than in identifiers.
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

cat > "$WORK/seed-expect.cjs" <<'SEEDEXPECT'
// The seed-only expectation, which exists for exactly one reason: Plex scans a section the moment it is
// created and nothing in its API asks it not to, so the gate needs a deterministic point at which that
// unavoidable creation scan is OVER before it publishes the corpus. Waiting on it means the concurrent scan
// is genuinely the first thing that ever reads the corpus.
const { writeFileSync } = require('node:fs');
const [, , out, key, size, sha] = process.argv;
const entry = { key, sizeBytes: Number(size), sha256: sha, kind: 'local', anchor: true };
writeFileSync(out, `${JSON.stringify([entry], null, 2)}
`);
SEEDEXPECT

cat > "$WORK/expect.cjs" <<'EXPECT'
// Merge the seed entry into the corpus expectation, so ONE document describes the whole namespace all three
// servers are held against.
const { readFileSync, writeFileSync } = require('node:fs');
const [, , out, base, key, size, sha] = process.argv;
const entries = JSON.parse(readFileSync(base, 'utf8'));
entries.unshift({ key, sizeBytes: Number(size), sha256: sha, kind: 'local', anchor: true });
writeFileSync(out, `${JSON.stringify(entries, null, 2)}\n`);
console.log(String(entries.length));
EXPECT

# ----------------------------------------------------------------------------------------------------------
step "the Compose files this gate uses are valid"
# ----------------------------------------------------------------------------------------------------------
docker compose -f "$COMPOSE_FILE" config -q
docker compose -f docker-compose.projectiond.yml config -q
echo "  both parse"

# ----------------------------------------------------------------------------------------------------------
step "the non-mutating host preflight, BEFORE this gate starts a single container"
# ----------------------------------------------------------------------------------------------------------
# WHETHER THIS HOST'S MOUNTS LET THE DAEMON PUBLISH A NAMESPACE AT ALL.
#
# THIS RUNS BEFORE ANY CONTAINER STARTS, AND THE ORDER IS THE POINT.
#
# IT USED TO RUN AFTER THE /dev/fuse PROBE, WHICH STARTS A CONTAINER. The offline suite asserted the preflight
# came "before any container is started" and compared it against the RANGE container, three hundred lines
# further down — so the assertion was true of the comparison it made and false of the sentence it existed to
# defend. A preflight that runs after a container is diagnosing a host this gate has already begun using, and
# its "the host was fine" verdict is a verdict about a host with side effects on it.
#
# WHAT MOVING IT COSTS, STATED RATHER THAN GLOSSED. On a host with no /dev/fuse the gate now runs two
# host-local process invocations before deciding to skip; and a host whose propagation is `not-shared` AND
# which has no /dev/fuse now FAILS where it used to SKIP. That is the stricter direction and it is the right
# one: both are real reasons this gate cannot produce evidence, and a failure is louder than a skip.
#
# IT MUTATES NOTHING. Two read-only host queries — `findmnt` on the run root, and a mode check on two
# directories this gate created itself. No container, no image, no database, no daemon.
#
# THE FAILURE IT CATCHES IS THE MOST LIKELY FIRST FAILURE OF THE FIRST UNRAID RUN, and no run on Docker
# Desktop could ever have revealed it. The daemon binds its mount point `rshared` so the FUSE namespace it
# creates inside its container becomes visible to the media servers beside it — and on this gate there are
# THREE of them, so the propagation requirement is exercised three times over. The kernel only permits
# `rshared` on a bind whose SOURCE IS ALREADY A SHARED MOUNT. Docker refuses the container outright otherwise
# — the daemon never starts. On Docker Desktop the bind source lives inside Docker's own Linux VM, whose root
# is shared, so the condition holds by construction; Unraid is not systemd, and a checkout under /mnt/user is
# on a FUSE share. Neither is shared by default.
#
# IT DIAGNOSES AND DOES NOT REPAIR. Making a host mount shared changes the machine the operator is standing
# on and outlives the run, so the check names the remedy rather than performing it.
#
# `--require` MAKES A `not-shared` ANSWER FATAL, and an UNDETERMINED one is deliberately not: a Windows host
# publishes no /proc/self/mountinfo and the gates demonstrably pass there. A check that cannot run says so on
# stderr rather than passing quietly.
# ----------------------------------------------------------------------------------------------------------
npx tsx src/ops/projection-host-preflight-cli.ts propagation --path "$GATE_ROOT" --require
npx tsx src/ops/projection-host-preflight-cli.ts traversal --path "$GATE_ROOT" --path "$WORK"

# ----------------------------------------------------------------------------------------------------------
step "checking this host can host the gate at all"
# ----------------------------------------------------------------------------------------------------------
# A SKIP IS NOT A PASS, AND IT DOES NOT EXIT 0.
#
# On a host with no /dev/fuse, an exit of 0 would produce a "successful" run whose only warning was on stderr
# — exactly the shape a required Linux/Unraid acceptance invocation would have if somebody ran it somewhere
# the mount could not exist. A green tranche-closing command that proved nothing is the single worst failure
# this repository can have.
#
# 77 is the conventional "skipped" status. It is NOT 0, so anything that treats zero as success — a shell, a
# CI step, the three-run wrapper — reports a skip as a non-success. A host where skip-as-success is genuinely
# wanted has its own entry point: deploy/projection-three-server-concurrency-gate-optional.sh, which maps 77
# to 0 and nothing else.
GATE_SKIP_STATUS=77
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no /dev/fuse is reachable from a container on this host." >&2
  echo "      THREE-SERVER CONCURRENCY is entirely UNPROVEN here. Nothing in this gate ran, and this run" >&2
  echo "      closes NO acceptance gate. It is not a pass and must not be reported as one." >&2
  exit "$GATE_SKIP_STATUS"
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
# is a generated tone; both are produced here and thrown away with the run directory.
#
# EVERY FILE IS DELIBERATELY DIFFERENT FROM EVERY OTHER. Two entries generated from identical parameters
# would be byte-identical, and then a read that returned the wrong entry would still match its digest.
# `corpusSelfProblems` refuses the corpus if that ever stops being true.
SEED_FILE="Projection Seed (2026).mp4"
SEED_PATH="Movies/Projection Seed (2026)/$SEED_FILE"
ffmpeg_run -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc=size=128x96:rate=15:duration=3" \
  -f lavfi -i "sine=frequency=311:duration=3" \
  -c:v mpeg4 -qscale:v 5 -c:a aac -b:a 32k -shortest -movflags +faststart "/work/media/$SEED_FILE"
SEED_SIZE="$(wc -c < "$WORK/media/$SEED_FILE" | tr -d ' ')"
SEED_SHA="$(node "$REL/sha.cjs" "$REL/media/$SEED_FILE")"
echo "  the seed entry is $SEED_SIZE bytes"

# THE CANARY: A REGISTERED OBJECT THIS GATE NEVER PUBLISHES.
#
# The endpoint's range semantics have to be checked before anything depends on them, and the obvious way —
# issue one ranged GET against a corpus object — would put bytes on that object and DESTROY the cold-window
# measurement before the gate has done anything. So the readiness probe reads a canary instead: registered at
# the endpoint, never named by any generation, never visible through the mount. The window assertion then
# splits the run's bytes between the corpus and the canary and requires the canary's share to be zero.
CANARY_FILE="Projection Canary.bin"
CANARY_REF="obj-projection-canary"
head -c 262144 /dev/urandom > "$WORK/remote/$CANARY_FILE"

# ----------------------------------------------------------------------------------------------------------
# THE LARGE FIXTURE, WHICH IS ALSO THE BARRIER OBJECT.
#
# WHY IT HAS TO BE THIS BIG. `PLEX_LARGE_FIXTURE.MIN_BYTES` is 94 MiB, computed as the smallest whole MiB at
# which the daemon's own per-object block envelope (8 demand blocks + 3 probe windows = ~35 MiB) sits under
# three quarters of the x0.5 byte fraction. BELOW that size the envelope permits a whole-object read, so
# asserting the fraction would be asserting something no ceiling constrains and the result would say nothing
# either way. Above it, the fraction binds — and three independent scanners each paying a full envelope would
# be ~105 MiB against a ~49 MB allowance, so the assertion is only satisfiable if the three concurrent scans
# actually shared the daemon's cache. That is the strongest claim this gate makes.
#
# THE BITRATE MAKES THE SIZE; the frame size only makes it slow. 640x480 at 8 Mbit/s reaches ~100 MB in a
# hundred seconds and encodes in a fraction of that.
#
# ITS PROJECTED PATH SORTS FIRST so a scanner reaches it early, which is what makes the rendezvous land
# inside the hold's bounded window.
# ----------------------------------------------------------------------------------------------------------
LARGE_FILE="Aaa Projection Barrier (2026).mp4"
LARGE_REF="obj-projection-barrier"
LARGE_MIN_BYTES=98566144
step "generating the large barrier fixture (>= ${LARGE_MIN_BYTES} bytes)"
ffmpeg_run -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=640x480:rate=24:duration=105" \
  -f lavfi -i "sine=frequency=277:duration=105" \
  -c:v mpeg4 -b:v 8M -minrate 8M -maxrate 8M -bufsize 16M \
  -c:a aac -b:a 64k -shortest -movflags +faststart "/work/remote/$LARGE_FILE"
LARGE_SIZE="$(wc -c < "$WORK/remote/$LARGE_FILE" | tr -d ' ')"
test "$LARGE_SIZE" -ge "$LARGE_MIN_BYTES" \
  || die "the large fixture is $LARGE_SIZE bytes, under the 94 MiB the byte-fraction claim needs to be testable"
echo "  the barrier object is $LARGE_SIZE bytes"

# ----------------------------------------------------------------------------------------------------------
# THE REST OF THE ~50-ENTRY CORPUS, AND WHY IT IS MADE OF TINY FILES.
#
# G7 and G18 are about a scan of a ~50-entry corpus. Neither is a throughput test: what they measure is
# whether a media server catalogues FIFTY DISTINCT IDENTITIES correctly, which is a question about namespace,
# metadata and stable identity rather than about bytes. Fifty large files would answer the same question,
# cost gigabytes of generated media per run, and make the gate slow enough that somebody would eventually
# shrink the corpus — at which point the fifty-entry gate is a five-entry gate with a fifty-entry name.
#
# So the corpus is tiny, valid, individually distinct media files plus the ONE large fixture above, which is
# the only entry where the byte-fraction claim is testable at all.
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
docker run --rm --entrypoint /bin/sh -v "$WORK:/work" "$GENERATOR_IMAGE" \
  /work/out/gen-corpus.sh "$CORPUS_COUNT" "$CORPUS_LOCAL" "$GENERATOR_FFMPEG"

# ----------------------------------------------------------------------------------------------------------
step "starting the deterministic HTTP Range endpoint"
# ----------------------------------------------------------------------------------------------------------
# THE ENDPOINT IS internal/fakeprovider, the only "provider" any automated gate here contacts. Its counters
# are what every budget in this gate is measured against.
#
# A REAL, EXPIRING ACCESS LEASE, WITH A SECRET THIS GATE CAN SEARCH FOR BY EXACT VALUE. The endpoint runs in
# RESOLVER mode rather than direct mode, so the daemon must exchange the stable objectRef for short-lived
# access material. The lease id is prefixed with a high-entropy marker minted here: a short literal occurs by
# chance in any few megabytes of binary and could only ever produce false positives, so a 32-hex marker is
# what makes the leak searches below a search for THE ACTUAL SECRET.
LEASE_MARKER="PJDLEASE$(node -e "console.log(require('node:crypto').randomBytes(16).toString('hex'))" | tr -d ' \r\n')"

# THE HOLD IS BOUNDED BY TWO DAEMON CONSTANTS, AND RESPECTING ONLY ONE OF THEM WOULD STILL BREAK THE RUN.
#
# `PROJECTIOND_READ_POLICY.FIRST_BYTE_DEADLINE_MS` is 10 s and bounds THE HELD REQUEST: a held response that
# has not begun by then is abandoned and the READ FAILS, so a media server would catalogue a file it could
# not open. `PROJECTIOND_ADMISSION_LIMITS.MAX_QUEUE_WAIT_MS` is 5 s and bounds EVERY OTHER READ: held
# requests occupy the daemon's four per-endpoint slots, and a read that cannot get one inside that budget
# returns EIO — so a hold that blocked for longer would mis-catalogue forty-nine entries it has nothing to do
# with. The endpoint's own default is 15 s, chosen for gates whose hold is armed and released inside one
# phase; this one is a RENDEZVOUS the three scanners arrive at one at a time, so it is set explicitly.
#
# THE BACKSTOP IS STRICTLY BELOW THE QUEUE-WAIT BUDGET, AND IT USED TO BE EXACTLY EQUAL TO IT. At 5s against
# a 5s budget the guarantee is gone on the boundary: a read arriving an instant after another blocks would
# wait the entire budget and could be refused admission — the very starvation the bound exists to prevent.
# The chain is now strictly ordered and every term is derived:
#
#   arm 3,000ms + release overshoot 500ms  <=  backstop 4,500ms  <  MAX_QUEUE_WAIT_MS 5,000ms
#                                                                  <  FIRST_BYTE_DEADLINE_MS 10,000ms
#
# THE OVERSHOOT TERM IS WHY THE ARM IS THREE SECONDS AND NOT FOUR. The arm window is timed from when the
# driver NOTICES a block; the backstop from when the request ACTUALLY blocks. The barrier watchdog bounds the
# distance between them at two of its own 250ms periods — one to notice, one to act — and the arm window has
# to leave room for it. A real run failed on exactly that gap before the watchdog existed.
#
# SO THE DRIVER RELEASES THREE SECONDS AFTER THE WATCHDOG NOTICES THE BLOCKED REQUEST -- which is NOT the
# same as three seconds after the request blocked, and saying it the second way would contradict the
# paragraph above. The notice can itself lag by up to one watchdog period, so the ACTUAL block runs a little
# longer than the arm window: measured across the three green runs it was 3.1s, the 3,000ms arm plus roughly
# one 250ms period of watchdog lag and overshoot, comfortably inside the 4,500ms backstop. The backstop only
# matters if this gate dies mid-hold, and even then no other object's read can be starved and no held read
# can miss its first byte.
HOLD_MAX=4500ms

# EVERY OBJECT THE RUN WILL EVER NEED IS SERVED FROM THE START, in a registration order the window assertion
# depends on: THE CANARY FIRST, then the barrier, then the corpus. The endpoint's per-object columns are
# indexed by registration order and carry no references, so that boundary is the only way the gate and the
# endpoint can agree on which objects are "the corpus" without the endpoint ever reporting a reference.
CORPUS_OBJECT_FLAGS=()
index=1
while [ "$index" -le "$(( CORPUS_COUNT - CORPUS_LOCAL ))" ]; do
  n="$(printf "%02d" "$index")"
  CORPUS_OBJECT_FLAGS+=(--file-object "obj-projection-corpus-${n}=/remote/Projection Corpus ${n} (2026).mp4")
  index=$(( index + 1 ))
done

docker run -d --name "$RANGE_CONTAINER" --network "$NETWORK" --network-alias fakerange \
  -p "127.0.0.1:${RANGE_PORT}:8099" \
  -v "$PWD:/workspace" -w /workspace/projectiond -v "$WORK/out:/out" -v "$WORK/remote:/remote:ro" \
  -e GOFLAGS=-buildvcs=false -e GOTOOLCHAIN=local -e CGO_ENABLED=0 \
  "$GO_IMAGE" go run ./cmd/fakerange --addr 0.0.0.0:8099 --lease-prefix "$LEASE_MARKER" \
  --public-base-url "http://fakerange:8099" --max-hold "$HOLD_MAX" \
  --file-object "${CANARY_REF}=/remote/${CANARY_FILE}" \
  --file-object "${LARGE_REF}=/remote/${LARGE_FILE}" \
  "${CORPUS_OBJECT_FLAGS[@]}" --emit /out/objects.json >/dev/null

echo "  waiting for the endpoint to come up"
# A LIVENESS PROBE MUST NOT BE PROVIDER TRAFFIC. A readiness loop that sends a ranged GET is a real object
# read: it increments `rangeRequests`, serves bytes, and on a slow host does so dozens of times before the
# first assertion has been made. So liveness is `/counters`, which the endpoint deliberately does not count,
# and the RANGE SEMANTICS are checked exactly once, afterwards, against the canary.
cat > "$WORK/out/probe.sh" <<'PROBE'
set -eu
wget -S --header "Range: bytes=0-1023" -O /dev/null "$1" 2>&1 | grep -q "206 Partial Content"
PROBE
cat > "$WORK/out/alive.sh" <<'ALIVE'
set -eu
wget -q -O /dev/null "$1"
ALIVE

ready=0
for _ in $(seq 1 240); do
  if [ -f "$WORK/out/objects.json" ] && docker run --rm --network "$NETWORK" \
       -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
       sh /probe/alive.sh "http://fakerange:8099/counters" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" -eq 1 || { logs_tail "$RANGE_CONTAINER"; die "the range endpoint never answered"; }

# ONE ranged request, AGAINST THE CANARY, and its status line asserted. The endpoint is Range-only by
# construction — a request without a Range header is answered 416 on purpose — and busybox wget exits
# non-zero on a 206 because it treats anything but 200 as an error, so the exit code is useless.
docker run --rm --network "$NETWORK" -v "$WORK/out:/probe:ro" "$VERIFY_IMAGE" \
  sh /probe/probe.sh "http://fakerange:8099/direct/${CANARY_REF}" >/dev/null 2>&1 \
  || { logs_tail "$RANGE_CONTAINER"; die "the endpoint does not answer a ranged request with 206"; }
echo "  the endpoint answers a ranged request with 206, and the object it was asked about is not in the corpus"

ENDPOINT_LARGE_SIZE="$(node "$REL/objects.cjs" "$REL/out/objects.json" "$LARGE_REF" size)"
test "$ENDPOINT_LARGE_SIZE" = "$LARGE_SIZE" || die "the endpoint disagrees with the barrier file about its size"

# ----------------------------------------------------------------------------------------------------------
step "publishing generation 1: ONE LOCAL SEED ENTRY, AND NOTHING REMOTE"
# ----------------------------------------------------------------------------------------------------------
# WHY THE CORPUS IS NOT IN THIS GENERATION, AND IT IS THE WHOLE COLD-WINDOW ARGUMENT.
#
# Two of the three media servers create a library without scanning it (`refreshLibrary=false`). PLEX DOES
# NOT: creating a section starts a scan of it immediately, and nothing in Plex's API asks it not to. If the
# corpus were already published at that moment, Plex would scan it before this gate had triggered anything,
# the daemon's scan-window cache would be warm, and the concurrent scan would then measure a window in which
# the data plane did no work — a green G18 that measured an empty room.
#
# So generation 1 is ONE LOCAL entry. It gives the three libraries a real directory to point at, Plex's
# unavoidable creation scan finds exactly one local file, and the provider serves ZERO bytes for it because
# a local passthrough source contacts no endpoint at all. The corpus arrives afterwards, and the three
# concurrent scans are the first thing that has ever read it.
register root --id media --kind local
register root --id vault --kind http-range
register version --key seed --size "$SEED_SIZE" --mtime 2026-06-01T10:00:00.000Z
register entry --item "b0000000-0000-4000-8000-000000000002" --version-key seed --path "$SEED_PATH" \
  --source "local:media:$SEED_FILE"

publish > "$WORK/out/publish-1.json"
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
# THE ADMISSION CAPS ARE SET EXPLICITLY RATHER THAN DEFAULTED, and that is what makes G17 a check on a
# CONFIGURED cap rather than on an implementation detail. All three of `maxConnections` (the transport's
# per-host connection cap), `perEndpointMaxInflight` and `globalMaxInflight` default to exactly these values,
# and that is the point: G17 says "concurrent provider connections never
# exceed the configured per-endpoint cap, sampled at the server on every accept"; a gate that let the value
# default would be asserting against a number nobody configured.
cat > "$WORK/config.json" <<'JSON'
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
      "allowedOrigins": ["http://fakerange:8099"],
      "allowInsecureHttp": true,
      "allowPrivateAddresses": true,
      "maxConnections": 4
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

# THE DAEMON'S OWN STATUS SURFACE. It binds LOOPBACK ONLY and that restriction is not relaxed for a test, so
# the request comes from a container sharing the daemon's network namespace. The image that serves the mount
# is distroless and has no shell and no HTTP client, which is why the request comes from a separate, pinned
# one. `probeCacheBytes` from here is what the cold-window assertion reads: the DAEMON's own number, because
# that is what decides whether a read reaches the provider.
daemon_status() {
  docker run --rm --network "container:$MOUNT_CONTAINER" "$VERIFY_IMAGE" \
    wget -q -T 15 -O - "http://127.0.0.1:${DAEMON_STATUS_PORT}/readyz" > "$1" \
    || die "the daemon's status surface did not answer; a cold window cannot be told from a warm one"
}

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

start_daemon
echo "  waiting for the namespace to become visible to a sibling container"
await_path "$SEED_PATH" || { logs_tail "$MOUNT_CONTAINER"; die "the mount never became visible"; }
echo "  visible"

# ----------------------------------------------------------------------------------------------------------
step "what an ordinary non-root container sees before any media server is involved"
# ----------------------------------------------------------------------------------------------------------
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
  sh /out/baseline.sh "$SEED_PATH"

# ----------------------------------------------------------------------------------------------------------
step "starting THREE REAL MEDIA SERVERS over the SAME mount"
# ----------------------------------------------------------------------------------------------------------
# EACH ONE IS STARTED THE WAY ITS OWN GATE STARTS IT, AND THE THREE COMMANDS ARE DELIBERATELY NOT UNIFIED.
#
#   JELLYFIN runs under `--user 1000:1000` with ALL capabilities dropped. That works because this image does
#     not drop privilege itself.
#   EMBY CANNOT. Its entrypoint is an s6 supervision tree that reads `UID`/`GID` and does the setuid itself,
#     so forcing `--user` would run the supervisor as an unprivileged user that cannot do the one thing it
#     exists to do. The capability set below is the narrowest this image actually starts under, measured
#     rather than copied: SETUID/SETGID for the privilege drop and CHOWN/DAC_OVERRIDE/FOWNER for the config
#     directory it takes ownership of on first run.
#   PLEX takes `PLEX_UID`/`PLEX_GID`, needs no claim token, and must be addressed by ADDRESS rather than by
#     name — it treats a request whose `Host` header it does not recognise as non-local and answers 401.
#
# A single parameterised "start a media server" helper would have had to pick one of these three, and two of
# the three servers would then not have started at all.
#
# THE MOUNT IS THE SAME DIRECTORY IN ALL THREE. That is the gate: one namespace, three readers.
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
echo "  three media servers started, all three with the same projected mount as a library root"

JF_BASE="http://127.0.0.1:${JF_PORT}"
EMBY_BASE="http://127.0.0.1:${EMBY_PORT}"
PLEX_BASE="http://127.0.0.1:${PLEX_PORT}"
JF_STATE="$REL/out/state-jellyfin.json"
EMBY_STATE="$REL/out/state-emby.json"
PLEX_STATE="$REL/out/state-plex.json"

# ----------------------------------------------------------------------------------------------------------
step "standing each server up through ITS OWN driver"
# ----------------------------------------------------------------------------------------------------------
# THE BOOTSTRAPS ARE THE THREE EXISTING ONES AND THEY ARE NOT FLATTENED. Emby's cannot key on
# `StartupWizardCompleted` because this server never sends one; Jellyfin's can. Plex has no wizard at all and
# instead asserts `claimed=0` and that its own local API answers without a credential. Six of the Jellyfin
# gate's behavioural conclusions were measured FALSE for Emby, and a combined bootstrap would have inherited
# every one of them.
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
# container BEFORE a scan is asked for — otherwise a scan that finds nothing is ambiguous between "projection
# is broken" and "the container cannot see the directory". `-u 1000:1000` is load-bearing on Emby, where a
# bare `docker exec` lands as ROOT because the image drops privilege internally; root being able to read the
# mount says nothing about whether the server can.
docker exec -u 1000:1000 "$JF_CONTAINER"   test -r "/media/projection/$SEED_PATH" \
  || die "Jellyfin's own uid cannot read the projected file"
docker exec -u 1000:1000 "$EMBY_CONTAINER" test -r "/media/projection/$SEED_PATH" \
  || die "Emby's own uid cannot read the projected file"
docker exec --user 1000:1000 "$PLEX_CONTAINER" test -r "/media/projection/$SEED_PATH" \
  || die "Plex's own uid cannot read the projected file"
echo "  all three servers can read the same projected file as the uid each runs as"

# Plex's server preferences, which turn off every background job that reads whole media files on a timer. A
# butler window opening mid-gate would put provider bytes into the window this gate attributes to a scan.
plex prefs --state "$PLEX_STATE"

# ----------------------------------------------------------------------------------------------------------
step "adding the SAME mount as a Movies library on all three"
# ----------------------------------------------------------------------------------------------------------
jellyfin library --state "$JF_STATE"   --mount-path /media/projection/Movies --name "Projection Movies"
emby     library --state "$EMBY_STATE" --mount-path /media/projection/Movies --name "Projection Movies"
# PLEX LAST, AND THE ORDER IS LOAD-BEARING. Creating a Plex section starts a scan of it immediately and
# nothing in its API asks it not to. That scan is harmless here because only the local seed entry is
# published — but it is a scan, and putting it last means the other two libraries already exist when it runs,
# so nothing about it can race a library creation.
plex library --state "$PLEX_STATE" --mount-path /media/projection/Movies --name "Projection Movies"

# ...AND THEN PLEX'S CREATION SCAN IS WAITED OUT, EXPLICITLY, BEFORE THE CORPUS IS PUBLISHED.
#
# THIS IS THE STEP THAT MAKES THE COLD WINDOW A FACT RATHER THAN A HOPE. Plex begins scanning a section as
# soon as it exists. Publishing the corpus while that scan was still running would let Plex catalogue part of
# it — warming the daemon's scan-window cache — and the "concurrent" scan would then measure a window in
# which the data plane had already done the work. So the gate drives one explicit scan of the ONE-ENTRY
# generation and waits for Plex's own barrier to say it settled. It costs the provider nothing: the seed
# entry is a LOCAL passthrough source and contacts no endpoint at all.
node "$REL/seed-expect.cjs" "$REL/out/seed-expected.json" "$SEED_FILE" "$SEED_SIZE" "$SEED_SHA"
plex scan --state "$PLEX_STATE" --expect-file "$REL/out/seed-expected.json" \
  --out "$REL/out/plex-seed-items.json" --label seed \
  || { logs_tail "$PLEX_CONTAINER"; die "Plex never settled after its own library-creation scan"; }

# ----------------------------------------------------------------------------------------------------------
step "publishing the ~50-entry corpus — AFTER every library exists, and BEFORE anything has scanned it"
# ----------------------------------------------------------------------------------------------------------
node "$REL/corpus.cjs" "$REL" "$CORPUS_COUNT" "$CORPUS_LOCAL" "$LARGE_FILE" "$LARGE_REF" >/dev/null \
  || die "the corpus could not be described, or the endpoint disagrees with a generated file"
register batch --file "$REL/out/corpus-register.json"
publish > "$WORK/out/publish-corpus.json"
test "$(field outcome < "$WORK/out/publish-corpus.json")" = "published" || die "the corpus was not published"
test "$(field additions < "$WORK/out/publish-corpus.json")" = "$(( CORPUS_COUNT + 1 ))" \
  || die "the corpus generation added $(field additions < "$WORK/out/publish-corpus.json") entries, not $(( CORPUS_COUNT + 1 ))"

LARGE_PATH="Movies/${LARGE_FILE%.mp4}/$LARGE_FILE"
echo "  waiting for the corpus to be admitted"
await_path "$LARGE_PATH" || { logs_tail "$MOUNT_CONTAINER"; die "the corpus never became visible"; }

CORPUS_TOTAL="$(node "$REL/expect.cjs" "$REL/out/expected.json" "$REL/out/corpus-expected.json" \
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
step "the state of the world immediately before the concurrent scan"
# ----------------------------------------------------------------------------------------------------------
# THE COLD-WINDOW EVIDENCE IS TAKEN HERE, NOT INFERRED LATER. Two independent instruments: the daemon's own
# scan-window cache level, and the endpoint's own per-object byte totals.
#
# MEASURED ON THE FIRST REAL RUN: the cache is NOT empty at this point and nothing is wrong. It holds the
# LOCAL seed entry's own byte-identity window -- 33,187 bytes -- because this gate publishes a local entry on
# purpose so that Plex's unavoidable library-creation scan has something to find that costs the provider
# nothing. So the daemon-side assertion is that the cache GREW across the window, and the emptiness question
# is asked where it can actually be answered: at the endpoint, per corpus object.
daemon_status "$WORK/out/daemon-before.json"
PROBE_CACHE_BEFORE="$(field probeCacheBytes < "$WORK/out/daemon-before.json")"
echo "  the daemon's scan-window cache holds ${PROBE_CACHE_BEFORE:-0} bytes"
drive counters --url "http://127.0.0.1:${RANGE_PORT}" --out "$REL/out/counters-before.json"

# ----------------------------------------------------------------------------------------------------------
step "THREE REAL LIBRARY SCANS, AT THE SAME TIME, OVER THE SAME MOUNT"
# ----------------------------------------------------------------------------------------------------------
# ONE PROCESS, ONE CLOCK. It arms the rendezvous hold, fires all three triggers together, and then asks all
# three servers their own present-tense in-flight state on a shared tick until every scan has settled. A tick
# in which all three said yes is a sample of three simultaneous in-flight scans; three sequential scans
# produce zero of those.
drive concurrent-scan \
  --state-jellyfin "$JF_STATE" --state-plex "$PLEX_STATE" --state-emby "$EMBY_STATE" \
  --endpoint "http://127.0.0.1:${RANGE_PORT}" --barrier-ref "$LARGE_REF" \
  --out "$REL/out/concurrent-scan.json" --catalogue-dir "$REL/out" \
  || { logs_tail "$MOUNT_CONTAINER"; die "the concurrent scan did not complete"; }

# THE AFTER SNAPSHOT WAITS FOR EVERY BODY TO FINISH WRITING. The endpoint counts a response`s COMMITTED
# payload length before it writes it and the count its write RETURNED afterwards; a snapshot taken between
# those two moments would report a deficit that belongs to the clock rather than to the daemon. The command
# polls the endpoint's own in-flight gauge and REFUSES a snapshot that never settled.
drive counters --url "http://127.0.0.1:${RANGE_PORT}" --out "$REL/out/counters-after.json"
daemon_status "$WORK/out/daemon-after.json"
PROBE_CACHE_AFTER="$(field probeCacheBytes < "$WORK/out/daemon-after.json")"

# ----------------------------------------------------------------------------------------------------------
step "was it actually simultaneous?"
# ----------------------------------------------------------------------------------------------------------
drive verify-overlap --scan "$REL/out/concurrent-scan.json"

# ----------------------------------------------------------------------------------------------------------
step "did each server see the SAME ~50 identities, through ITS OWN semantics?"
# ----------------------------------------------------------------------------------------------------------
# ONE EXPECTATION DOCUMENT, THREE PREDICATES. The corpus, the sizes and the digests are shared — that is what
# makes this one library rather than three. What is NOT shared is how each server describes an ordinary file:
# Jellyfin reads `LocationType`, which Emby omits entirely; Emby reads `MediaSources[0].Type`; Plex reads
# `accessible`/`exists` off a `checkFiles=1` response and has neither field. Three predicates over three
# different field sets is not duplication — it is three servers, and the one time this repository flattened
# them the flattened predicate matched zero of two correctly catalogued entries.
drive verify-corpus --server jellyfin --catalogue "$REL/out/catalogue-jellyfin.json" \
  --expect-file "$REL/out/expected.json"
drive verify-corpus --server plex     --catalogue "$REL/out/catalogue-plex.json" \
  --expect-file "$REL/out/expected.json"
drive verify-corpus --server emby     --catalogue "$REL/out/catalogue-emby.json" \
  --expect-file "$REL/out/expected.json"

# ----------------------------------------------------------------------------------------------------------
step "G14a-G17 across the simultaneous window, unchanged"
# ----------------------------------------------------------------------------------------------------------
drive window --before "$REL/out/counters-before.json" --after "$REL/out/counters-after.json" \
  --gate TS3 --objects "$REGISTERED_OBJECTS" --non-corpus-objects 1 \
  --remote-entries "$REMOTE_ENTRIES" \
  --large-bytes "$LARGE_REMOTE_BYTES" --small-bytes "$SMALL_REMOTE_BYTES" \
  --probe-cache-before "${PROBE_CACHE_BEFORE:-0}" --probe-cache-after "${PROBE_CACHE_AFTER:-0}"

# ----------------------------------------------------------------------------------------------------------
step "the whole-run provider invariants"
# ----------------------------------------------------------------------------------------------------------
drive counters --url "http://127.0.0.1:${RANGE_PORT}" --out "$REL/out/counters-final.json"
drive provider-invariants --counters "$REL/out/counters-final.json" --gate TS4

# ----------------------------------------------------------------------------------------------------------
step "no PROVIDER access lease reached the manifest, the probe cache or any server's library state"
# ----------------------------------------------------------------------------------------------------------
# THE CLAIM IS ABOUT PROVIDER ACCESS MATERIAL. During this run the daemon really did resolve stable object
# references into short-lived access material, because the endpoint is configured in resolver mode. Phase 0
# section 7.6 says that material lives in the daemon's memory for the length of one read and nowhere else.
#
# THE CLAIM IS NOT "NO TOKEN EXISTS ANYWHERE ON DISK". This gate persists a Jellyfin and an Emby access token
# in its own scratch state files, because the phases run as separate processes; all three servers persist
# their own authentication state, because a server that did not would not survive a restart. None of that is
# provider access material and none of it is searched for below.
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

# THE PROBE CACHE IS MEDIA BYTES, and `://` is not a usable signal against it: a three-byte sequence occurs
# in a few megabytes of high-entropy data by chance. So it is searched for the things that could only have
# got there from a leak, and FIRST AMONG THEM THE ACTUAL LEASE SECRET minted for this run.
docker run --rm -v "$WORK/cache:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
  sh /out/leakcheck.sh "the daemon probe cache" /out/leak-needles-cache.txt \
  || die "the probe cache holds provider access material"

# ALL THREE SERVERS' LIBRARY STATE. Each holds its own device and access-token records — it has to — and
# those are not searched for here, because they are the server's own credentials for its own API and have
# nothing to do with the provider lease this step is about.
for scan_dir in jf-config plex-config emby-config; do
  docker run --rm -v "$WORK/$scan_dir:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
    sh /out/leakcheck.sh "a media server's library state" /out/leak-needles-library.txt \
    || die "a media server persisted provider access material"
done
echo "  no media server's library state names the provider endpoint or holds a lease"

# AND THE LEASE REALLY EXISTED, or every search above was a search for nothing.
RESOLUTIONS="$(field resolutions < "$WORK/out/counters-final.json")"
test "${RESOLUTIONS:-0}" -ge 1 \
  || die "the endpoint served no access resolution, so the leak check searched for a secret that never existed"
echo "  $RESOLUTIONS access lease(s) were minted during this run, so the searches above had a subject"

# ----------------------------------------------------------------------------------------------------------
step "stopping the daemon: the namespace goes away, and a stale one does not linger"
# ----------------------------------------------------------------------------------------------------------
# WITH THREE MEDIA SERVERS HOLDING THE MOUNT, and that is why this step is worth more here than in the
# single-server gates: a stale FUSE mount is what stops the NEXT run from starting clean, and three live
# readers is three times the opportunity to leave one behind.
docker rm -f "$PLEX_CONTAINER" "$JF_CONTAINER" "$EMBY_CONTAINER" >/dev/null 2>&1 || true
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
npx tsx src/ops/projection-three-server-concurrency-cli.ts report --results "$REL/out/results.json"

echo
echo "THREE-SERVER CONCURRENT SCAN gate PASSED. Exactly what was proved:"
echo "  - ONE PostgreSQL, ONE publisher, ONE admitted generation, ONE production projectiond, ONE FUSE mount"
echo "    and ONE fake HTTP Range endpoint -- with THREE real, digest-pinned media servers (Plex, Jellyfin,"
echo "    Emby) each holding the SAME mount directory as its library root."
echo "  - THREE LIBRARY SCANS OBSERVED IN FLIGHT AT THE SAME INSTANT, by one process on one clock asking all"
echo "    three servers their own present-tense scan state. A tick whose three answers were more than two"
echo "    seconds apart does not count as one instant, and three SEQUENTIAL scans produce zero such samples."
echo "    The floors are on ONE UNBROKEN RUN of those ticks -- broken by any idle, unreadable or imprecise"
echo "    sample and by any gap over twice the nominal tick -- and its duration is CREDITED at most one"
echo "    nominal tick per gap, so time nobody polled in cannot be counted as overlap."
echo "  - a RENDEZVOUS rather than luck: one remote object's provider read was held at the endpoint before"
echo "    any trigger, so a scanner that reached it waited there. The hold is bounded below the daemon's own"
echo "    first-byte deadline and the gate asserts that none lapsed."
echo "  - a COLD window, on two independent instruments: the endpoint had served ZERO bytes for any corpus"
echo "    object before the scans opened, and the daemon's own scan-window cache GREW across the window."
echo "    NOT 'the cache was empty' -- it is not, and nothing is wrong: this gate publishes a LOCAL seed"
echo "    entry on purpose, and a local entry's own byte-identity window lands in the same cache."
echo "  - EACH SERVER catalogued every published identity at the published size as an ORDINARY FILE -- not"
echo "    symlinks, not .strm placeholders, not remote media sources -- with zero missing, zero wrong-sized,"
echo "    zero duplicated and zero unexpected, THROUGH ITS OWN ordinary-file predicate rather than through a"
echo "    flattened one."
echo "  - G14a, G14b, G15, G16 and G17 across that simultaneous window, against THE CEILINGS THE"
echo "    ACCEPTANCE PLAN ITSELF SETS, imported from PROJECTION_PHASE_1_BUDGETS -- x1.2, not the looser"
echo "    x6 multipliers the three single-server gates hold a real scanner to, which are RECORDED here"
echo "    and asserted on by nothing. The stricter per-object block-geometry ceiling is asserted IN"
echo "    ADDITION, never instead, with every byte attributed to an object in the shared corpus and the"
echo "    request partition reconciled exactly."
echo "  - the byte fraction asserted on an object large enough for it to bind, where three independent"
echo "    scanners each paying a full envelope would breach it -- so passing it is the statement that the"
echo "    second and third concurrent scans read what the first one cached."
echo
echo "WHAT THIS GATE DOES NOT PROVE, AND WILL NOT BE PRESENTED AS PROVING:"
npx tsx src/ops/projection-three-server-concurrency-cli.ts nonclaims
