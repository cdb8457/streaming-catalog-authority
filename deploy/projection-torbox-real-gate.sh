#!/usr/bin/env bash
# THE REAL TORBOX RUN — operator-supplied, and the only gate here that ever contacts TorBox.
#
# WHY THIS SCRIPT HAD TO EXIST AT ALL. The previous documented procedure could not work, and the review was
# right to fail it: it told an operator to start the resolver on the Unraid HOST at `127.0.0.1:8140` and then
# start projectiond in a Docker bridge network. Inside that container `127.0.0.1` is the CONTAINER, so the
# daemon would have dialled its own loopback and found nothing. The offline mount gate only worked because
# its resolver joins the daemon's network namespace — and that arrangement was never written down for a real
# run. It is written down here, executably, and there is no host-port spelling of it to get wrong.
#
# THE SHARED NAMESPACE IS THE ARCHITECTURE, NOT A TRICK. The daemon container is started first; the resolver
# container then runs with `--network container:<daemon>`. They share one loopback, so:
#
#   * the daemon reaches the resolver at 127.0.0.1:PORT, which is a LITERAL loopback address and the only
#     thing the daemon's narrow `loopbackResolver` authority permits it to dial;
#   * the resolver is NEVER published to a host port, so nothing off-host can address it. A resolver that
#     anything on the network could reach is a credential oracle: it mints CDN links for the operator's
#     account to whoever asks;
#   * the TorBox API key exists ONLY inside the resolver container. The daemon is given the independent gate
#     secret and nothing else, so the binary that talks to arbitrary provider-supplied CDN hosts never holds
#     the credential that can manage the whole account.
#
# IT EXITS 77 BEFORE ANY NETWORK CONTACT WHEN THE OPERATOR HAS SUPPLIED NOTHING. That is the expected outcome
# on every machine nobody has deliberately prepared, and it is checked before an image is built, before a
# database is started and before a single packet is sent.
set -euo pipefail
# shellcheck source=deploy/projection-gate-cleanup.sh
. "$(cd "$(dirname "$0")" && pwd)/projection-gate-cleanup.sh"
export MSYS_NO_PATHCONV=1

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
NODE_IMAGE="node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32"

COMPOSE_FILE="docker-compose.projection-torbox.yml"
NETWORK="projection-torbox-real-gate"
PG_PORT="${PROJECTION_TORBOX_REAL_GATE_PG_PORT:-5580}"
RESOLVER_PORT="${PROJECTION_TORBOX_REAL_GATE_RESOLVER_PORT:-8140}"

MOUNT_CONTAINER="projection-tbr-mount-$$"
RESOLVER_CONTAINER="projection-tbr-resolver-$$"

GATE_ROOT="$PWD/.projection-torbox-real-gate"
REL=".projection-torbox-real-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

GATE_SKIP_STATUS=77

# THE APPROVED PATH, AND THE ONLY PLACE THIS GATE EVER LOOKS. It does not search the filesystem for anything
# that might be a credential, does not read one from the environment, and does not prompt.
INPUT_DIR="${PROJECTION_REAL_PROVIDER_INPUT_DIR:-/mnt/user/appdata/catalog/secrets/real-provider}"
TORBOX_CREDENTIAL="$INPUT_DIR/torbox-credential"
GATE_SECRET="$INPUT_DIR/credential"
OBJECTS_FILE="$INPUT_DIR/objects.json"
ENDPOINT_FILE="$INPUT_DIR/endpoint.json"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_TORBOX_GATE_PG_PORT="$PG_PORT"

cleanup() {
  docker rm -f "$RESOLVER_CONTAINER" >/dev/null 2>&1 || true
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

# ----------------------------------------------------------------------------------------------------------
# THE SKIP, AND IT COMES FIRST — BEFORE AN IMAGE, A DATABASE OR A PACKET
# ----------------------------------------------------------------------------------------------------------
missing=""
[ -f "$TORBOX_CREDENTIAL" ] || missing="$missing torbox-credential"
[ -f "$GATE_SECRET" ]       || missing="$missing credential"
[ -f "$OBJECTS_FILE" ]      || missing="$missing objects.json"
[ -f "$ENDPOINT_FILE" ]     || missing="$missing endpoint.json"
if [ -n "$missing" ]; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): the operator has supplied no TorBox corpus." >&2
  echo "      Missing under the approved input directory:$missing" >&2
  echo "" >&2
  echo "      NOTHING WAS CONTACTED, and nothing was built or started. This gate never invents a" >&2
  echo "      credential and never reaches TorBox without all four files already present. A skip here is" >&2
  echo "      the CORRECT and expected outcome on any machine nobody has deliberately prepared." >&2
  echo "" >&2
  echo "      It is not a pass and must not be reported as one. Phase 1 stays open." >&2
  echo "      What to place: deploy/torbox-resolver.template.json" >&2
  echo "      To exercise the whole path offline instead: npm run go:torbox-mount-gate:three" >&2
  exit "$GATE_SKIP_STATUS"
fi
echo "  four operator inputs are present; this run WILL contact TorBox"

mkdir -p "$WORK/manifest" "$WORK/cache" "$WORK/mnt" "$WORK/out" "$WORK/inputs"
chmod 755 "$GATE_ROOT" "$WORK"
chmod 700 "$WORK/inputs"
chmod 777 "$WORK/cache" "$WORK/mnt" "$WORK/out"

# THE SECRETS ARE COPIED INTO A 0700 RUN DIRECTORY AT MODE 0600, never moved and never widened. The resolver
# container mounts that directory read-only; the daemon container mounts ONLY the gate secret.
install -m 600 "$TORBOX_CREDENTIAL" "$WORK/inputs/torbox-credential"
install -m 600 "$GATE_SECRET" "$WORK/inputs/gate-secret"
if cmp -s "$WORK/inputs/torbox-credential" "$WORK/inputs/gate-secret"; then
  die "the TorBox credential and the gate secret are the same value; they must differ, or the daemon holds \
the credential that can manage the whole account"
fi

cat > "$WORK/jq.cjs" <<'JQ'
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const value = JSON.parse(raw)[process.argv[2]];
  console.log(value === undefined ? '' : String(value));
});
JQ

cat > "$WORK/register.cjs" <<'REGISTER'
// Emits the register commands into a 0600 shell file, because a TorBox stable reference identifies an item
// in the operator's account and argv is world-readable.
const { readFileSync, writeFileSync, chmodSync } = require('node:fs');
const [, , out, objectsPath, endpointPath] = process.argv;
const objects = JSON.parse(readFileSync(objectsPath, 'utf8'));
const endpoint = JSON.parse(readFileSync(endpointPath, 'utf8'));
const q = (value) => JSON.stringify(String(value));
const cli = 'npx tsx src/ops/projection-register-cli.ts';
const lines = ['#!/usr/bin/env bash', 'set -euo pipefail',
  cli + ' root --id ' + q(endpoint.id) + ' --kind http-range'];
objects.forEach((object, index) => {
  const key = 'tbr-version-' + (index + 1);
  const item = '00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0');
  lines.push(cli + ' version --key ' + key + ' --size ' + object.sizeBytes
    + ' --mtime 2026-01-01T00:00:00.000Z');
  lines.push(cli + ' entry --item ' + q(item) + ' --version-key ' + key
    + ' --path ' + q(object.label + '.bin')
    + ' --source ' + q('http-range:' + endpoint.id + ':' + object.ref));
});
const script = out.replace(/[^/]*$/, '') + 'register.sh';
writeFileSync(script, lines.join('\n') + '\n');
chmodSync(script, 0o600);
writeFileSync(out, JSON.stringify({ objects: objects.length }, null, 2) + '\n');
REGISTER

cat > "$WORK/config.cjs" <<'CONFIG'
// The daemon config, built from the EFFECTIVE endpoint -- the same validated file the preflight consumed.
//
// THIS SCRIPT DOES NO REASONING ABOUT ORIGINS OR SWITCHES ANY MORE, and that is the repair. It used to
// derive the resolver URL and filter the allowlist itself, in parallel with what the preflight was given.
// Two derivations of one thing is how a gate validates a shape it does not run: the preflight was handed
// the operator's MINIMAL file, which names no resolver at all, and would have refused it. Now the effective
// endpoint is built and validated once, and both consumers read that.
//
// THE DAEMON IS GIVEN THE GATE SECRET AND NOTHING ELSE. `tokenFile` names the gate secret, which authorises
// the daemon to ASK the resolver for access material. The TorBox API key never appears here and is never
// mounted into this container.
const { readFileSync, writeFileSync } = require('node:fs');
const [, , effectivePath, out] = process.argv;
const endpoint = JSON.parse(readFileSync(effectivePath, 'utf8'));

// A LAST ASSERTION BEFORE THE DAEMON SEES IT. These are guaranteed by the builder; restating them here costs
// nothing and means a future change to either side cannot quietly disagree with the other.
for (const [field, expected] of [['allowInsecureHttp', false], ['allowPrivateAddresses', false],
  ['loopbackResolver', true]]) {
  if (endpoint[field] !== expected) {
    console.error('the effective endpoint has ' + field + ' = ' + String(endpoint[field])
      + ', which a real run never sets');
    process.exit(1);
  }
}
if (!String(endpoint.resolverUrl).startsWith('http://127.0.0.1:')) {
  console.error('the effective endpoint resolver is not a literal loopback address');
  process.exit(1);
}

writeFileSync(out, JSON.stringify({
  mountPoint: '/mnt/projection',
  pointerPath: '/var/lib/projectiond/manifest/pointer.json',
  probeCacheDir: '/var/lib/projectiond/cache',
  globalMaxInflight: 4,
  perEndpointMaxInflight: 2,
  endpoints: [{
    id: endpoint.id,
    resolverUrl: endpoint.resolverUrl,
    allowedOrigins: endpoint.allowedOrigins,
    tokenFile: '/var/lib/projectiond/inputs/gate-secret',
    allowInsecureHttp: false,
    allowPrivateAddresses: false,
    loopbackResolver: true,
    maxConnections: 2,
    resolutionDeadlineMs: 15000,
    refreshCooldownMs: 250,
  }],
}, null, 2) + '\n');
CONFIG

cat > "$WORK/verify.cjs" <<'VERIFY'
// Reads each object THROUGH THE MOUNT and compares against the digests the OPERATOR recorded outside it.
const { openSync, readSync, closeSync, readFileSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const [, , objectsPath, mountDir, out] = process.argv;
const objects = JSON.parse(readFileSync(objectsPath, 'utf8'));

function clampOffset(offset, length, size) { return Math.max(0, Math.min(offset, size - length)); }

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

  // THE OPERATOR'S APPROVED WINDOWS, against digests recorded outside the mount before the run.
  for (const probe of object.probeDigests ?? []) {
    const got = windowAt(path, probe.offset, probe.length);
    const digest = createHash('sha256').update(got.bytes).digest('hex');
    const ok = got.bytes.length === probe.length && digest === probe.sha256;
    if (!ok) problems += 1;
    results.push({ label: object.label, kind: 'probe', bytes: got.bytes.length, match: ok,
      elapsedMs: got.elapsedMs });
  }
  if (object.sha256) {
    const whole = windowAt(path, 0, object.sizeBytes);
    const ok = createHash('sha256').update(whole.bytes).digest('hex') === object.sha256;
    if (!ok) problems += 1;
    results.push({ label: object.label, kind: 'whole', bytes: whole.bytes.length, match: ok,
      elapsedMs: whole.elapsedMs });
  }

  // PAST 90%, then BACKWARDS to a lower offset than the one just read.
  const tailOffset = clampOffset(Math.floor(object.sizeBytes * 0.91), 65536, object.sizeBytes);
  const tail = windowAt(path, tailOffset, Math.min(65536, object.sizeBytes - tailOffset));
  if (tail.bytes.length === 0) problems += 1;
  results.push({ label: object.label, kind: 'tail', bytes: tail.bytes.length,
    match: tail.bytes.length > 0, elapsedMs: tail.elapsedMs });

  const back = windowAt(path, 0, Math.min(65536, object.sizeBytes));
  if (back.bytes.length === 0) problems += 1;
  results.push({ label: object.label, kind: 'backward', bytes: back.bytes.length,
    match: back.bytes.length > 0, elapsedMs: back.elapsedMs });

  const tailDigest = createHash('sha256').update(tail.bytes).digest('hex');
  const backDigest = createHash('sha256').update(back.bytes).digest('hex');
  if (tailDigest === backDigest) {
    problems += 1;
    results.push({ label: object.label, kind: 'distinct-windows', match: false });
  }
}
writeFileSync(out, JSON.stringify({ results, problems }, null, 2) + '\n');
console.log('  ' + results.length + ' read(s), ' + problems + ' problem(s)');
process.exit(problems === 0 ? 0 : 1);
VERIFY

cat > "$WORK/probe-resolver.cjs" <<'PROBE'
// Is the resolver listening, and does it refuse an unauthenticated request? A 401 is the healthy answer.
const http = require('node:http');
const port = Number(process.argv[2]);
const req = http.request({ host: '127.0.0.1', port, path: '/resolve', method: 'POST' },
  (res) => process.exit(res.statusCode === 401 ? 0 : 1));
req.on('error', () => process.exit(1));
req.end();
PROBE

cat > "$WORK/scan.cjs" <<'SCAN'
// Searches everything the run wrote for a secret. The needle arrives as a FILE PATH so it never enters argv,
// and only a COUNT is printed -- never a match, never a line, never a filename.
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
step "PREFLIGHT — every input check that needs no Docker, BEFORE any image, database or packet"
# ----------------------------------------------------------------------------------------------------------
# THE ORDER IS THE POINT. A fully populated but malformed corpus must fail closed having built nothing and
# contacted nothing: an operator whose endpoint file has a typo should learn that in two seconds, not after a
# container image is built and a database is started. Every check below is pure file inspection.

# 1. THE SECRETS: present, regular, non-empty, mode 0600.
npx tsx src/ops/torbox-resolver-cli.ts preflight \
  --credential "$REL/inputs/torbox-credential" --gate-secret "$REL/inputs/gate-secret" \
  || die "the operator's secret files are not usable; nothing was contacted"

# 2. THE ENDPOINT: validate what the operator wrote, refuse every field the GATE owns, and build the
#    complete description. THIS IS THE FIX FOR THE DEFECT REVIEW FOUND -- the generic preflight below used to
#    be handed the operator's MINIMAL file, which names no resolver at all, so the first fully populated real
#    run would have died here. One construction, two consumers.
EFFECTIVE_ENDPOINT="$REL/out/effective-endpoint.json"
npx tsx src/ops/torbox-resolver-cli.ts effective-endpoint \
  --endpoint "$ENDPOINT_FILE" --resolver-port "${RESOLVER_PORT}" --out "$EFFECTIVE_ENDPOINT" \
  || die "the operator's endpoint description is not usable; nothing was contacted"

# 3. THE CORPUS AND THE CREDENTIAL, against the endpoint that will ACTUALLY be used.
npx tsx src/ops/projection-real-provider-cli.ts preflight \
  --objects "$OBJECTS_FILE" --credential "$REL/inputs/gate-secret" --endpoint "$EFFECTIVE_ENDPOINT" \
  || die "the operator's object manifest is not usable; nothing was contacted"

# 4. THE DAEMON CONFIGURATION, built now rather than later, so a configuration this gate would refuse is
#    found before anything is started.
node "$REL/config.cjs" "$EFFECTIVE_ENDPOINT" "$WORK/config.json" \
  || die "the effective endpoint could not be turned into a daemon configuration"

# 5. THE REGISTER PLAN, which parses the object manifest and writes a 0600 script. Still no Docker.
node "$REL/register.cjs" "$REL/out/register.json" "$OBJECTS_FILE" "$EFFECTIVE_ENDPOINT"
echo "  every input check passed, and NOTHING has been built, started or contacted"

# ----------------------------------------------------------------------------------------------------------
step "host and Compose checks — the first steps that need Docker at all"
# ----------------------------------------------------------------------------------------------------------
# THE /dev/fuse PROBE MOVED HERE, BEHIND THE FILE CHECKS. It is a docker run, and a fully populated but
# malformed corpus should fail closed having started no container at all -- an operator with a typo in
# endpoint.json learns that in two seconds rather than after a container has been pulled and run.
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no /dev/fuse is reachable from a container on this host." >&2
  echo "      It is not a pass and must not be reported as one." >&2
  exit "$GATE_SKIP_STATUS"
fi
docker compose -f "$COMPOSE_FILE" config >/dev/null || die "the gate's Compose file is not valid"
npx tsx src/ops/projection-host-preflight-cli.ts propagation --path "$GATE_ROOT" --require
npx tsx src/ops/projection-host-preflight-cli.ts traversal --path "$GATE_ROOT" --path "$WORK"

# ----------------------------------------------------------------------------------------------------------
step "building the production projectiond image, and migrating a throwaway PostgreSQL"
# ----------------------------------------------------------------------------------------------------------
docker build -t "$IMAGE" ./projectiond
docker compose -f "$COMPOSE_FILE" up -d --wait postgres
npx tsx src/ops/migrate-cli.ts
docker network create "$NETWORK" >/dev/null 2>&1 || true

# ----------------------------------------------------------------------------------------------------------
step "publishing a generation whose sources are the operator's TorBox stable references"
# ----------------------------------------------------------------------------------------------------------
# The register script was written during preflight, before anything was built.
bash "$WORK/out/register.sh"
npx tsx src/ops/projection-publish-cli.ts --manifest-dir "$REL/manifest" > "$WORK/out/publish.json"
test "$(node "$REL/jq.cjs" outcome < "$WORK/out/publish.json")" = "published" \
  || die "the generation was not published"

# ----------------------------------------------------------------------------------------------------------
step "mounting — the daemon gets the GATE SECRET only, never the TorBox key"
# ----------------------------------------------------------------------------------------------------------
# The daemon configuration was built during preflight, from the effective endpoint.
# ONLY THE GATE SECRET IS MOUNTED. A separate directory is built for the daemon so the TorBox key is not
# merely unreferenced in its container — it is not present in it.
mkdir -p "$WORK/daemon-inputs"
chmod 700 "$WORK/daemon-inputs"
install -m 600 "$WORK/inputs/gate-secret" "$WORK/daemon-inputs/gate-secret"

docker run -d --name "$MOUNT_CONTAINER" \
  --network "$NETWORK" --user 0:0 \
  --cap-drop ALL --cap-add SYS_ADMIN --security-opt apparmor:unconfined \
  --device /dev/fuse:/dev/fuse \
  -v "$WORK/manifest:/var/lib/projectiond/manifest:ro" \
  -v "$WORK/cache:/var/lib/projectiond/cache" \
  -v "$WORK/daemon-inputs:/var/lib/projectiond/inputs:ro" \
  -v "$WORK/config.json:/etc/projectiond/config.json:ro" \
  -v "$WORK/mnt:/mnt/projection:rshared" \
  "$IMAGE" --config /etc/projectiond/config.json --poll 2s --strict-direct-mount >/dev/null

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

# ----------------------------------------------------------------------------------------------------------
step "starting the resolver INSIDE the daemon's network namespace — no host port, loopback only"
# ----------------------------------------------------------------------------------------------------------
# THIS IS THE FIX FOR THE TOPOLOGY THE REVIEW REJECTED. A resolver started on the HOST at 127.0.0.1 is
# unreachable from a daemon in a bridge network, because inside that container 127.0.0.1 is the container.
# Sharing the namespace makes one loopback for both — and keeps the resolver unpublished, which a host-port
# arrangement could not.
#
# NOTE WHAT IS NOT PASSED: no --fixture-mode, so no origin override and no plaintext CDN link. This resolver
# is pinned to the official TorBox origin and will refuse anything else.
docker run -d --name "$RESOLVER_CONTAINER" \
  --network "container:$MOUNT_CONTAINER" \
  -v "$PWD:/workspace" -w /workspace \
  -v "$WORK/inputs:/inputs:ro" \
  -e npm_config_update_notifier=false \
  "$NODE_IMAGE" ./node_modules/.bin/tsx src/ops/torbox-resolver-cli.ts serve \
  --credential /inputs/torbox-credential --gate-secret /inputs/gate-secret \
  --port "${RESOLVER_PORT}" >/dev/null \
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
echo "  the resolver answers on the shared loopback and refuses an unauthenticated request"

# THE RESOLVER IS NOT REACHABLE FROM ANYWHERE ELSE, and that is asserted rather than assumed.
if docker run --rm --network "$NETWORK" "$VERIFY_IMAGE" \
  timeout 3 wget -q -O /dev/null "http://$MOUNT_CONTAINER:${RESOLVER_PORT}/resolve" >/dev/null 2>&1; then
  die "the resolver answered a request from the gate network; it must be loopback-only"
fi
echo "  and is unreachable from the gate network"

echo "  waiting for the namespace to become visible"
ready=0
for _ in $(seq 1 120); do
  if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" sh -c 'ls /mnt/*.bin' >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
test "$ready" -eq 1 || { logs_tail "$MOUNT_CONTAINER"; die "the mount never became visible"; }

# ----------------------------------------------------------------------------------------------------------
step "READING THE OPERATOR'S TORBOX OBJECTS AS ORDINARY FILES"
# ----------------------------------------------------------------------------------------------------------
node "$REL/verify.cjs" "$OBJECTS_FILE" "$WORK/mnt" "$REL/out/reads.json" \
  || { logs_tail "$MOUNT_CONTAINER"; logs_tail "$RESOLVER_CONTAINER"; die "reads through the mount failed"; }

# ----------------------------------------------------------------------------------------------------------
step "the mount is READ-ONLY, checked as the unprivileged uid a media server runs as"
# ----------------------------------------------------------------------------------------------------------
TARGET="$(docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" sh -c 'ls /mnt/*.bin | head -1')"
refused() { docker run --rm --user 65534:65534 --cap-drop ALL -v "$WORK/mnt:/mnt:rslave" \
  "$VERIFY_IMAGE" sh -c "$1" >/dev/null 2>&1 && echo no || echo yes; }
test "$(refused "echo x >> '$TARGET'")" = yes    || die "the mount accepted a write"
test "$(refused "touch /mnt/created.bin")" = yes || die "the mount accepted a file creation"
test "$(refused "rm -f '$TARGET'")" = yes        || die "the mount accepted an unlink"
test "$(refused "chmod 777 '$TARGET'")" = yes    || die "the mount accepted a chmod"

# ----------------------------------------------------------------------------------------------------------
step "NO SECRET AND NO REFERENCE REACHED ANYTHING THIS RUN WROTE"
# ----------------------------------------------------------------------------------------------------------
for container in "$MOUNT_CONTAINER" "$RESOLVER_CONTAINER"; do
  docker logs "$container" > "$WORK/out/log-$container.txt" 2>&1 || true
done
CRED_HITS="$(node "$REL/scan.cjs" "$REL/inputs/torbox-credential" "$WORK/out" "$WORK/manifest" "$WORK/cache")"
GATE_HITS="$(node "$REL/scan.cjs" "$REL/inputs/gate-secret" "$WORK/out" "$WORK/manifest" "$WORK/cache")"
test "$CRED_HITS" -eq 0 || die "the TorBox credential reached $CRED_HITS file(s) this run wrote"
test "$GATE_HITS" -eq 0 || die "the gate secret reached $GATE_HITS file(s) this run wrote"
if grep -qE 'torbox:(torrent|webdl|usenet):[0-9]+:[0-9]+' "$WORK/out/log-$RESOLVER_CONTAINER.txt"; then
  die "the resolver logged a stable reference"
fi
# THE TORBOX KEY WAS NEVER IN THE DAEMON'S CONTAINER AT ALL, which is stronger than it not being logged.
if docker exec "$MOUNT_CONTAINER" ls /var/lib/projectiond/inputs/torbox-credential >/dev/null 2>&1; then
  die "the TorBox credential is present inside the daemon container"
fi
echo "  neither secret nor any reference is in this run's files or logs, and the TorBox key was never"
echo "  mounted into the daemon at all"

echo
echo "TORBOX REAL-PROVIDER GATE PASSED."
echo "  The operator's objects were read as ordinary read-only files through a FUSE mount, resolved by a"
echo "  loopback-only resolver that holds the TorBox API key the daemon never sees."
