#!/usr/bin/env bash
# THE TORBOX RESOLVER, PROVEN THROUGH A MOUNTED READ.
#
# WHAT THIS GATE EXISTS TO PROVE, AND WHY NOTHING ELSE PROVES IT. `npm run test:torbox-resolver` drives the
# real resolver service against the fixture over real HTTP and checks real bytes — but it calls the resolver
# ITSELF. That leaves the one claim the whole tranche is about untested: that a TorBox object becomes an
# ORDINARY READ-ONLY FILE, and that the projection daemon's own HTTP Range source calls the resolver, takes
# the CDN link, and serves byte ranges out of a FUSE mount. This gate is the only thing that closes that, and
# it closes it by reading the file the way a media server would: `open`, `pread` at a tail offset, `pread`
# backwards, compare digests.
#
# IT IS OFFLINE AND IT CONTACTS NOTHING. The provider is the repository's own TorBox fixture, the credential
# is 32 random bytes this script generates, and no real TorBox account exists anywhere in it. The REAL run
# against a real account is `deploy/projection-real-provider-gate.sh`, which skips with 77 until an operator
# supplies inputs. The two are deliberately separate: this one can never be mistaken for that one, because
# this one never had a credential to use.
#
# THE FAIL-CLOSED SEPARATION IS THE POINT OF THE ARRANGEMENT, NOT A DETAIL OF IT. The fixture speaks plaintext
# HTTP on a private address, which is exactly what the resolver refuses by default. Both exemptions that make
# this run possible — `--fixture-plaintext-link` on the resolver and `allowInsecureHttp`/
# `allowPrivateAddresses` on the daemon endpoint — are OPT-IN, are set in this file and nowhere else in a
# shipped path, and default to refusing. A real run that forgot to think about either one refuses plaintext
# rather than accepting it.
#
# THE RESOLVER STAYS LOOPBACK-ONLY, WHICH IS WHY IT JOINS THE DAEMON'S NETWORK NAMESPACE. A resolver reachable
# off-host is a credential oracle: anything that can reach it can mint CDN links for the operator's account.
# So it is never published on the gate network. Instead its container runs with
# `--network container:<daemon>`, so `127.0.0.1` means the same thing to both processes, the peer check sees a
# real loopback peer, and nothing else on the network can address the resolver at all.
set -euo pipefail
# shellcheck source=deploy/projection-gate-cleanup.sh
. "$(cd "$(dirname "$0")" && pwd)/projection-gate-cleanup.sh"
export MSYS_NO_PATHCONV=1

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
# PINNED BY DIGEST, like every other external image this repository runs. The fixture and the resolver are
# ordinary Node processes; they run the repository own tsx from the bind-mounted node_modules rather than
# fetching anything, so this container needs a network only to reach the fixture and never the registry.
NODE_IMAGE="node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32"

COMPOSE_FILE="docker-compose.projection-torbox.yml"
NETWORK="projection-torbox-gate"
PG_PORT="${PROJECTION_TORBOX_GATE_PG_PORT:-5570}"
TORBOX_PORT="${PROJECTION_TORBOX_GATE_FIXTURE_PORT:-8150}"
RESOLVER_PORT="${PROJECTION_TORBOX_GATE_RESOLVER_PORT:-8140}"

MOUNT_CONTAINER="projection-tb-mount-$$"
FIXTURE_CONTAINER="projection-tb-fixture-$$"
RESOLVER_CONTAINER="projection-tb-resolver-$$"

GATE_ROOT="$PWD/.projection-torbox-gate"
REL=".projection-torbox-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_TORBOX_GATE_PG_PORT="$PG_PORT"

GATE_SKIP_STATUS=77

cleanup() {
  # THE RESOLVER FIRST: it lives in the daemon's network namespace, so removing the daemon out from under it
  # leaves a container whose network is gone and which docker is slower to reap.
  docker rm -f "$RESOLVER_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$MOUNT_CONTAINER" "$FIXTURE_CONTAINER" >/dev/null 2>&1 || true
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

field()    { node "$REL/jq.cjs" "$1"; }
publish()  { npx tsx src/ops/projection-publish-cli.ts --manifest-dir "$REL/manifest" "$@"; }
register() { npx tsx src/ops/projection-register-cli.ts "$@"; }

mkdir -p "$WORK/manifest" "$WORK/cache" "$WORK/mnt" "$WORK/out" "$WORK/inputs"
chmod 755 "$GATE_ROOT" "$WORK"
chmod 700 "$WORK/inputs"
chmod 777 "$WORK/cache" "$WORK/mnt" "$WORK/out"

cat > "$WORK/jq.cjs" <<'JQ'
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const value = JSON.parse(raw)[process.argv[2]];
  console.log(value === undefined ? '' : String(value));
});
JQ

cat > "$WORK/probe-resolver.cjs" <<'PROBE'
// Is the resolver listening, and does it refuse an unauthenticated request?
//
// WHY THIS IS A FILE RATHER THAN `node -e`. `test/custody-runtime-closure.ts` refuses a shipped script
// carrying a multi-line `node -e` string, and it is right to: a quoted program inside a quoted shell
// argument is one escaping mistake away from being unparseable, and an unreadable line in a gate is not an
// empty one. It also gives the probe somewhere to explain itself.
//
// A 401 IS THE HEALTHY ANSWER. The probe presents no credential on purpose: a resolver that answered
// anything else to an unauthenticated request would be a resolver worth failing the gate over.
const http = require('node:http');
const port = Number(process.argv[2]);
const req = http.request(
  { host: '127.0.0.1', port, path: '/resolve', method: 'POST' },
  (res) => process.exit(res.statusCode === 401 ? 0 : 1),
);
req.on('error', () => process.exit(1));
req.end();
PROBE

cat > "$WORK/register.cjs" <<'REGISTER'
// Emits the register commands into a 0600 shell file.
//
// WHY A FILE. The stable reference is an argument to `register entry`, and argv is world-readable. A
// reference identifies an item in somebody's TorBox account, so it stays out of every process listing.
const { readFileSync, writeFileSync, chmodSync } = require('node:fs');
const [, , out, objectsPath] = process.argv;
const objects = JSON.parse(readFileSync(objectsPath, 'utf8'));
const q = (value) => JSON.stringify(String(value));
const cli = 'npx tsx src/ops/projection-register-cli.ts';
const lines = ['#!/usr/bin/env bash', 'set -euo pipefail',
  cli + ' root --id torbox --kind http-range'];
objects.forEach((object, index) => {
  const key = 'tb-version-' + (index + 1);
  const item = '00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0');
  lines.push(cli + ' version --key ' + key + ' --size ' + object.sizeBytes
    + ' --mtime 2026-01-01T00:00:00.000Z');
  // A SOURCE IS kind:rootId:objectRef, and the register CLI splits on the FIRST TWO colons only -- so the
  // TorBox reference keeps its own colons intact as the objectRef.
  lines.push(cli + ' entry --item ' + q(item) + ' --version-key ' + key
    + ' --path ' + q(object.label + '.bin')
    + ' --source ' + q('http-range:torbox:' + object.ref));
});
const script = out.replace(/[^/]*$/, '') + 'register.sh';
writeFileSync(script, lines.join('\n') + '\n');
chmodSync(script, 0o600);
writeFileSync(out, JSON.stringify({ objects: objects.length }, null, 2) + '\n');
REGISTER

cat > "$WORK/verify.cjs" <<'VERIFY'
// Reads each object THROUGH THE MOUNT and compares against digests the fixture computed outside it.
//
// THE THREE SHAPES ARE THE POINT. A tail read past 90% is where a container index lives and where an
// implementation that can only stream forward from zero falls over. A backward read to a LOWER offset than
// one already read is the seek a player makes when somebody scrubs back. Reading only forwards from zero
// would pass against an implementation that is wrong in both of the ways that matter.
const { openSync, readSync, closeSync, readFileSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const [, , objectsPath, mountDir, out, shiftRaw] = process.argv;
const objects = JSON.parse(readFileSync(objectsPath, 'utf8'));

// THE SHIFT IS WHAT MAKES THE SECOND PASS MEAN ANYTHING.
//
// The first pass reads three windows per object. Reading the SAME windows again proves nothing about the
// provider: the daemon's caches already hold those bytes, so the read is served without a request and the
// resolution count does not move -- which is exactly what the first version of this gate mistook for a
// failure to re-resolve. A non-zero shift moves every window to an offset nothing has touched, so the bytes
// can only come from the provider, and the provider can only be reached by re-resolving an expired link.
//
// A SHIFTED WINDOW HAS NO APPROVED DIGEST, and none is invented. What is asserted for a cold pass is the
// length, the distinctness of the windows, and -- in the gate above -- that the resolution count rose.
const shift = Number(shiftRaw ?? '0');
const cold = shift !== 0;

// EVERY WINDOW IS CLAMPED INSIDE THE OBJECT. A shifted cold offset can otherwise run past the end -- which
// is a defect in the GATE, not in the thing under test, and it presents as an unreadable file.
function clampOffset(offset, length, size) {
  return Math.max(0, Math.min(offset, size - length));
}

function windowAt(path, offset, length) {
  const started = Date.now();
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const got = readSync(fd, buffer, filled, length - filled, offset + filled);
      if (got === 0) break;
      filled += got;
    }
    return { bytes: buffer.subarray(0, filled), elapsedMs: Date.now() - started };
  } finally { closeSync(fd); }
}

const results = [];
let problems = 0;
for (const object of objects) {
  const path = mountDir + '/' + object.label + '.bin';
  const probe = object.probeDigests[0];

  // 1. THE APPROVED WINDOW, against a digest recorded outside the mount. On a cold pass the window is
  //    shifted, so there is no approved digest for it and only the length is asserted.
  const probeOffset = clampOffset(probe.offset + shift, probe.length, object.sizeBytes);
  const got = windowAt(path, probeOffset, probe.length);
  const digest = createHash('sha256').update(got.bytes).digest('hex');
  const ok = got.bytes.length === probe.length && (cold || digest === probe.sha256);
  if (!ok) problems += 1;
  results.push({ label: object.label, kind: cold ? 'probe-cold' : 'probe', bytes: got.bytes.length,
    expected: probe.length, match: ok, digestChecked: !cold, elapsedMs: got.elapsedMs });

  // 2. PAST 90%.
  const tailOffset = clampOffset(Math.floor(object.sizeBytes * 0.91) + shift, 65536, object.sizeBytes);
  const tailLength = Math.min(65536, object.sizeBytes - tailOffset);
  const tail = windowAt(path, tailOffset, tailLength);
  const tailOk = tail.bytes.length === tailLength;
  if (!tailOk) problems += 1;
  results.push({ label: object.label, kind: cold ? 'tail-cold' : 'tail', bytes: tail.bytes.length,
    expected: tailLength, match: tailOk, elapsedMs: tail.elapsedMs,
    sha256: createHash('sha256').update(tail.bytes).digest('hex') });

  // 3. BACKWARDS, to an offset lower than the one just read.
  const back = windowAt(path, clampOffset(shift, 65536, object.sizeBytes), 65536);
  const backOk = back.bytes.length === 65536;
  if (!backOk) problems += 1;
  results.push({ label: object.label, kind: cold ? 'backward-cold' : 'backward', bytes: back.bytes.length,
    expected: 65536, match: backOk, elapsedMs: back.elapsedMs,
    sha256: createHash('sha256').update(back.bytes).digest('hex') });

  // The two windows must DIFFER, or the mount is serving one buffer for every offset.
  if (createHash('sha256').update(back.bytes).digest('hex')
    === createHash('sha256').update(tail.bytes).digest('hex')) {
    problems += 1;
    results.push({ label: object.label, kind: 'distinct-windows', match: false });
  }
}
writeFileSync(out, JSON.stringify({ results, problems }, null, 2) + '\n');
console.log('  ' + results.length + ' read(s), ' + problems + ' problem(s)');
process.exit(problems === 0 ? 0 : 1);
VERIFY

cat > "$WORK/scan.cjs" <<'SCAN'
// Searches everything the run wrote for either secret. The needle arrives as a FILE PATH so it never enters
// argv, and only a COUNT is printed -- never a match, never a line, never a filename.
const { readFileSync, readdirSync, statSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const [, , secretPath, ...roots] = process.argv;
const needle = readFileSync(secretPath, 'utf8').trim();
let hits = 0;
const walk = (dir) => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let info;
    try { info = statSync(full); } catch { continue; }
    if (info.isDirectory()) { walk(full); continue; }
    if (info.size > 64 * 1024 * 1024) continue;
    let text;
    try { text = readFileSync(full, 'latin1'); } catch { continue; }
    if (text.includes(needle)) hits += 1;
  }
};
if (needle.length >= 8) { for (const root of roots) walk(root); }
console.log(String(hits));
SCAN

# ----------------------------------------------------------------------------------------------------------
step "deciding whether this host can host the gate at all, and refusing to guess"
# ----------------------------------------------------------------------------------------------------------
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no /dev/fuse is reachable from a container on this host." >&2
  echo "      The TorBox mount path is entirely UNPROVEN here. Nothing ran, and this run closes NO" >&2
  echo "      acceptance gate. It is not a pass and must not be reported as one." >&2
  exit "$GATE_SKIP_STATUS"
fi
docker compose -f "$COMPOSE_FILE" config >/dev/null || die "the gate's Compose file is not valid"
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
docker network create "$NETWORK" >/dev/null 2>&1 || true

# ----------------------------------------------------------------------------------------------------------
step "generating TWO secrets, neither of them real, and never letting them meet"
# ----------------------------------------------------------------------------------------------------------
# The fixture's API key and the gate secret the daemon presents to the resolver are DIFFERENT VALUES on
# purpose: the entire reason the resolver is a separate process is that the daemon never holds the provider
# credential. A gate that used one value for both would pass while proving the opposite of the design.
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$WORK/inputs/torbox-credential"
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$WORK/inputs/gate-secret"
chmod 600 "$WORK/inputs/torbox-credential" "$WORK/inputs/gate-secret"
# THE FIXTURE ORIGIN ARRIVES AS A FILE TOO. The resolver CLI refuses ANY url on its command line --
# there is no exception for "it is only an origin" -- so the override that only the offline fixture
# needs is written here rather than passed.
printf '%s' "http://torbox-fixture:${TORBOX_PORT}" > "$WORK/inputs/api-origin"
test "$(cat "$WORK/inputs/torbox-credential")" != "$(cat "$WORK/inputs/gate-secret")" \
  || die "the two secrets are identical, which would defeat the split this gate exists to prove"

npx tsx src/ops/torbox-resolver-cli.ts preflight \
  --credential "$REL/inputs/torbox-credential" --gate-secret "$REL/inputs/gate-secret" \
  || die "the resolver preflight refused its own generated secrets"

# ----------------------------------------------------------------------------------------------------------
step "standing up the TorBox fixture: the requestdl API and the CDN it hands off to"
# ----------------------------------------------------------------------------------------------------------
TB_SIZE=$((8 * 1024 * 1024))
# THE FIXTURE IS REACHED BY NETWORK ALIAS, because the CDN link it mints has to name a host the DAEMON can
# dial. A loopback spelling would resolve in the wrong namespace and the second hop would fail.
docker run -d --name "$FIXTURE_CONTAINER" --network "$NETWORK" --network-alias torbox-fixture \
  -v "$PWD:/workspace" -w /workspace \
  -v "$WORK/inputs:/inputs:ro" -v "$WORK/out:/out" \
  -e npm_config_update_notifier=false \
  "$NODE_IMAGE" ./node_modules/.bin/tsx src/ops/torbox-fixture-cli.ts serve \
  --token-file /inputs/torbox-credential \
  --object "torbox:torrent:1234:0:${TB_SIZE}" \
  --object "torbox:webdl:5678:1:${TB_SIZE}" \
  --object "torbox:usenet:9012:2:${TB_SIZE}" \
  --port "${TORBOX_PORT}" --public-origin "http://torbox-fixture:${TORBOX_PORT}" \
  --emit /out/torbox-objects.json >/dev/null \
  || die "the TorBox fixture did not start"

cat > "$WORK/out/alive.sh" <<'ALIVE'
set -eu
wget -q -O /dev/null "$1"
ALIVE
ready=0
for _ in $(seq 1 240); do
  if docker run --rm --network "$NETWORK" -v "$WORK/out:/out" "$VERIFY_IMAGE" \
    sh /out/alive.sh "http://torbox-fixture:${TORBOX_PORT}/healthz" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
test "$ready" -eq 1 || { logs_tail "$FIXTURE_CONTAINER"; die "the TorBox fixture never came up"; }
test -s "$WORK/out/torbox-objects.json" || die "the fixture started but emitted no object descriptor"
echo "  the fixture is serving all three source kinds, and has emitted its digests"

# ----------------------------------------------------------------------------------------------------------
step "publishing a generation whose sources are TORBOX STABLE REFERENCES"
# ----------------------------------------------------------------------------------------------------------
node "$REL/register.cjs" "$REL/out/register.json" "$REL/out/torbox-objects.json"
bash "$WORK/out/register.sh"
publish > "$WORK/out/publish.json"
test "$(field outcome < "$WORK/out/publish.json")" = "published" || die "the generation was not published"
test "$(field entryCount < "$WORK/out/publish.json")" = "3" || die "the generation did not name three entries"

# ----------------------------------------------------------------------------------------------------------
step "mounting, with the endpoint pointed at the LOOPBACK resolver rather than at any provider"
# ----------------------------------------------------------------------------------------------------------
# THE ALLOWLIST NAMES BOTH HOPS, AND THAT IS THE PRODUCT'''S RULE RATHER THAN THIS GATE'''S CHOICE. The daemon
# checks EVERY url it is about to dial against the endpoint allowlist -- and the resolver is one of those:
# the first run of this gate failed with "origin not in endpoint allowlist" naming the resolver, not the
# CDN. So the list carries the resolver origin AND the origin the CDN links will name. An operator
# configuring a real run has to do the same, and the template says so.
#
# BOTH RELAXATIONS BELOW ARE FIXTURE-ONLY AND OPT-IN. The fixture speaks plaintext HTTP on a private address;
# a real endpoint description sets neither of these, and the real-provider gate's preflight REFUSES a
# configuration that does. They are here, in an offline gate, and in no shipped real path.
cat > "$WORK/config.json" <<JSON
{
  "mountPoint": "/mnt/projection",
  "pointerPath": "/var/lib/projectiond/manifest/pointer.json",
  "probeCacheDir": "/var/lib/projectiond/cache",
  "globalMaxInflight": 4,
  "perEndpointMaxInflight": 2,
  "endpoints": [
    {
      "id": "torbox",
      "resolverUrl": "http://127.0.0.1:${RESOLVER_PORT}/resolve",
      "allowedOrigins": [
        "http://127.0.0.1:${RESOLVER_PORT}",
        "http://torbox-fixture:${TORBOX_PORT}"
      ],
      "tokenFile": "/var/lib/projectiond/inputs/gate-secret",
      "allowInsecureHttp": true,
      "allowPrivateAddresses": true,
      "maxConnections": 2,
      "resolutionDeadlineMs": 15000,
      "refreshCooldownMs": 250
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
  -v "$WORK/inputs:/var/lib/projectiond/inputs:ro" \
  -v "$WORK/config.json:/etc/projectiond/config.json:ro" \
  -v "$WORK/mnt:/mnt/projection:rshared" \
  "$IMAGE" --config /etc/projectiond/config.json --poll 2s --strict-direct-mount >/dev/null

# ----------------------------------------------------------------------------------------------------------
step "waiting for the daemon to be RUNNING before anything joins its namespace"
# ----------------------------------------------------------------------------------------------------------
# A CONTAINER THAT EXITED CANNOT LEND ITS NETWORK NAMESPACE, and "cannot join network of a non running
# container" says nothing about WHY the daemon stopped. So the daemon is confirmed up first, and its own log
# is dumped if it is not -- the failure an operator needs to see is the daemon's, not docker's complaint
# about a consequence of it.
daemon_up=0
for _ in $(seq 1 120); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$MOUNT_CONTAINER" 2>/dev/null)" = "true" ]; then
    daemon_up=1; break
  fi
  sleep 0.5
done
if [ "$daemon_up" -ne 1 ]; then
  echo "--- the daemon exited; its own log follows ---" >&2
  logs_tail "$MOUNT_CONTAINER"
  die "the daemon is not running, so the resolver cannot share its network namespace"
fi
echo "  the daemon is running"

# ----------------------------------------------------------------------------------------------------------
step "starting the REAL resolver INSIDE the daemon's network namespace, so it stays loopback-only"
# ----------------------------------------------------------------------------------------------------------
docker run -d --name "$RESOLVER_CONTAINER" \
  --network "container:$MOUNT_CONTAINER" \
  -v "$PWD:/workspace" -w /workspace \
  -v "$WORK/inputs:/inputs:ro" \
  -e npm_config_update_notifier=false \
  "$NODE_IMAGE" ./node_modules/.bin/tsx src/ops/torbox-resolver-cli.ts serve \
  --credential /inputs/torbox-credential --gate-secret /inputs/gate-secret \
  --port "${RESOLVER_PORT}" --api-origin-file /inputs/api-origin \
  --fixture-plaintext-link >/dev/null \
  || die "the resolver did not start"

resolver_ready=0
for _ in $(seq 1 240); do
  if docker exec "$RESOLVER_CONTAINER" \
    node "/workspace/$REL/probe-resolver.cjs" "${RESOLVER_PORT}" >/dev/null 2>&1; then
    resolver_ready=1; break
  fi
  sleep 0.5
done
test "$resolver_ready" -eq 1 || { logs_tail "$RESOLVER_CONTAINER"; die "the resolver never came up"; }
echo "  the resolver answers on loopback, and refuses an unauthenticated request"

echo "  waiting for the namespace to become visible to another container"
ready=0
for _ in $(seq 1 120); do
  if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" sh -c 'ls /mnt/*.bin' >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
test "$ready" -eq 1 || { logs_tail "$MOUNT_CONTAINER"; die "the mount never became visible"; }

# ----------------------------------------------------------------------------------------------------------
step "READING A TORBOX OBJECT AS AN ORDINARY FILE — probe window, past 90%, and backwards"
# ----------------------------------------------------------------------------------------------------------
# THIS IS THE ASSERTION THE WHOLE TRANCHE IS ABOUT. Everything above is setup; if the daemon does not call
# the resolver, take the CDN link and serve byte ranges, this fails here and nothing else can hide it.
node "$REL/verify.cjs" "$REL/out/torbox-objects.json" "$WORK/mnt" "$REL/out/reads.json" \
  || { logs_tail "$MOUNT_CONTAINER"; logs_tail "$RESOLVER_CONTAINER"; die "reads through the mount failed"; }

RESOLUTIONS_AFTER_READS="$(docker run --rm --network "$NETWORK" -v "$WORK/out:/out" "$VERIFY_IMAGE" \
  wget -qO- "http://torbox-fixture:${TORBOX_PORT}/control/counters" | node "$REL/jq.cjs" resolveRequests)"
test "$RESOLUTIONS_AFTER_READS" -ge 3 \
  || die "the daemon read three objects having resolved $RESOLUTIONS_AFTER_READS time(s); the resolver was not in the path"
echo "  the resolver was genuinely in the read path: $RESOLUTIONS_AFTER_READS resolution(s)"

# ----------------------------------------------------------------------------------------------------------
step "EXPIRING EVERY CDN LINK, and proving a read recovers by re-resolving"
# ----------------------------------------------------------------------------------------------------------
# A link that has lapsed answers 401. The data plane's rule is at most ONE refresh per read, and the read
# must still return the right bytes. A gate that only proved the happy path would pass against an
# implementation that could never recover from the expiry every TorBox link eventually has.
docker run --rm --network "$NETWORK" "$VERIFY_IMAGE" \
  wget -qO- "http://torbox-fixture:${TORBOX_PORT}/control/expire-links" >/dev/null
BEFORE_REFRESH="$RESOLUTIONS_AFTER_READS"

# A COLD READ, AT OFFSETS NOTHING HAS TOUCHED, so the answer cannot come from a cache.
#
# The first version of this gate re-read the SAME windows here and then failed because the resolution count
# had not moved. It had not moved because the daemon served those bytes from its own cache without asking
# anybody -- which is correct behaviour, and meant the assertion was measuring the cache rather than the
# refresh. The shift moves every window somewhere untouched, so reaching the provider is the only way to
# answer, and reaching the provider after an expiry requires a re-resolution.
COLD_SHIFT=1048576
node "$REL/verify.cjs" "$REL/out/torbox-objects.json" "$WORK/mnt" "$REL/out/reads-after-expiry.json" \
  "$COLD_SHIFT" \
  || { logs_tail "$MOUNT_CONTAINER"; logs_tail "$RESOLVER_CONTAINER"; die "reads did not recover after expiry"; }

AFTER_REFRESH="$(docker run --rm --network "$NETWORK" "$VERIFY_IMAGE" \
  wget -qO- "http://torbox-fixture:${TORBOX_PORT}/control/counters" | node "$REL/jq.cjs" resolveRequests)"
test "$AFTER_REFRESH" -gt "$BEFORE_REFRESH" \
  || die "the links were expired and nothing re-resolved; the reads cannot have gone to the provider"
echo "  reads recovered after expiry: $BEFORE_REFRESH -> $AFTER_REFRESH resolution(s)"

# ----------------------------------------------------------------------------------------------------------
step "the mount is READ-ONLY, checked as the unprivileged uid a media server actually runs as"
# ----------------------------------------------------------------------------------------------------------
TARGET="$(docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" sh -c 'ls /mnt/*.bin | head -1')"
refused() { docker run --rm --user 65534:65534 --cap-drop ALL -v "$WORK/mnt:/mnt:rslave" \
  "$VERIFY_IMAGE" sh -c "$1" >/dev/null 2>&1 && echo no || echo yes; }
test "$(refused "echo x >> '$TARGET'")" = yes    || die "the mount accepted a write"
test "$(refused "touch /mnt/created.bin")" = yes || die "the mount accepted a file creation"
test "$(refused "rm -f '$TARGET'")" = yes        || die "the mount accepted an unlink"
test "$(refused "chmod 777 '$TARGET'")" = yes    || die "the mount accepted a chmod"
echo "  write, create, unlink and chmod are all refused"

# ----------------------------------------------------------------------------------------------------------
step "NEITHER SECRET, AND NO REFERENCE, REACHED ANYTHING THIS RUN WROTE"
# ----------------------------------------------------------------------------------------------------------
# "We do not log it" is a claim; this is a measurement. Both secrets are high-entropy values this run
# generated, so a search for their exact bytes across everything written is decisive.
CRED_HITS="$(node "$REL/scan.cjs" "$REL/inputs/torbox-credential" "$WORK/out" "$WORK/manifest" "$WORK/cache")"
GATE_HITS="$(node "$REL/scan.cjs" "$REL/inputs/gate-secret" "$WORK/out" "$WORK/manifest" "$WORK/cache")"
test "$CRED_HITS" -eq 0 || die "the TorBox credential reached $CRED_HITS file(s) this run wrote"
test "$GATE_HITS" -eq 0 || die "the gate secret reached $GATE_HITS file(s) this run wrote"

# THE DAEMON AND RESOLVER LOGS ARE SEARCHED TOO, because a container log is where a URL is most likely to
# surface and is not a file under the run directory.
for container in "$MOUNT_CONTAINER" "$RESOLVER_CONTAINER" "$FIXTURE_CONTAINER"; do
  docker logs "$container" > "$WORK/out/log-$container.txt" 2>&1 || true
done
LOG_CRED="$(node "$REL/scan.cjs" "$REL/inputs/torbox-credential" "$WORK/out")"
test "$LOG_CRED" -eq 0 || die "the TorBox credential appears in a container log"
if grep -qE 'torbox:(torrent|webdl|usenet):[0-9]+:[0-9]+' "$WORK/out/log-$RESOLVER_CONTAINER.txt"; then
  die "the resolver logged a stable reference"
fi
echo "  neither secret, and no stable reference, is anywhere in this run's files or container logs"

# ----------------------------------------------------------------------------------------------------------
step "the report"
# ----------------------------------------------------------------------------------------------------------
READS="$(node "$REL/jq.cjs" problems < "$WORK/out/reads.json")"
test "$READS" = "0" || die "the first read pass reported $READS problem(s)"
echo
echo "TORBOX-TO-MOUNT GATE PASSED."
echo "  3 objects (torrent, webdl, usenet), each read through a read-only FUSE mount at an approved window,"
echo "  past 90% of the object, and backwards, with the probe digest compared against a value the fixture"
echo "  computed OUTSIDE the mount. Every CDN link was then expired and every read recovered."
echo
echo "  THIS IS OFFLINE AND CLOSES NOTHING ABOUT ANY REAL PROVIDER. The provider was this repository's own"
echo "  TorBox fixture and the credential was 32 random bytes generated by this script. A real TorBox"
echo "  account has never been contacted. deploy/projection-real-provider-gate.sh is the real run, and it"
echo "  SKIPS with 77 until an operator supplies inputs."
