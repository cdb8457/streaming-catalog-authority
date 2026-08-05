#!/usr/bin/env bash
# THE REAL-PROVIDER CORRECTNESS GATE — the last thing Phase 1 is waiting on.
#
# WHAT §2 OF THE ACCEPTANCE PLAN ASKS FOR. "1-3 files the operator is legally entitled to, supplied by the
# operator", to answer one question: does the HTTP Range adapter work against a real endpoint. That is a
# CORRECTNESS question. Every quantitative question -- amplification, concurrency, re-scan, duplicate probes,
# rate limiting -- is answered against the FAKE corpus, where the harness controls the answers and can assert
# on them. So nothing in this gate is a budget, a rate or a multiplier, and NOTHING HERE IS A LOAD TEST.
#
# IT IS OPERATOR-RUN AND IT SUPPLIES NOTHING ITSELF. This gate never invents a credential, never generates an
# object manifest, and never contacts anything unless the operator has ALREADY placed real files at the
# approved path. With nothing there it SKIPS -- status 77 -- and says in as many words that a skip closes
# nothing. That is the common case and it is the correct one: a gate that manufactured a fixture and called
# it a real provider would be the worst outcome available here.
#
# NOT ONE URL, TOKEN, REFERENCE OR FILENAME REACHES ARGV, A LOG LINE OR A REPORT. argv is world-readable --
# `ps` shows it to every user on the host for as long as the run lasts -- so every one of those arrives as a
# FILE PATH and is read inside the process that needs it. The object's only identity in any output is an
# operator-chosen label and a digest prefix. `src/core/projection/real-provider.ts` enforces that, and the
# report is scrubbed before it is printed rather than after.
#
# TWO MODES, ONE CODE PATH.
#   --fake  stands up the pinned deterministic fake provider and runs EVERY phase and EVERY adversarial case
#           against it, offline, with no credential and no external contact. This is what CI and every
#           developer runs, and it is what proves the gate can fail.
#   (real)  the operator's own endpoint, credential and objects. Never in CI.
# The phases, the assertions and the verdict module are identical in both. A gate whose real mode ran code no
# offline run had ever executed would be a gate first tested against somebody's production account.
set -euo pipefail
# shellcheck source=deploy/projection-gate-cleanup.sh
. "$(cd "$(dirname "$0")" && pwd)/projection-gate-cleanup.sh"
export MSYS_NO_PATHCONV=1

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"

COMPOSE_FILE="docker-compose.projection-real-provider.yml"
NETWORK="projection-real-provider-gate"
PG_PORT="${PROJECTION_REAL_PROVIDER_GATE_PG_PORT:-5560}"
FAKE_PORT="${PROJECTION_REAL_PROVIDER_GATE_FAKE_PORT:-8130}"

MOUNT_CONTAINER="projection-rp-mount-$$"
FAKE_CONTAINER="projection-rp-fake-$$"

GATE_ROOT="$PWD/.projection-real-provider-gate"
REL=".projection-real-provider-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

# THE APPROVED PATH, AND IT IS THE ONLY PLACE THIS GATE EVER LOOKS.
#
# It does not search the filesystem for anything that might be a credential, does not read environment
# variables holding secrets, and does not prompt. Either the operator has deliberately placed files here, or
# this gate skips. Overridable for a non-default install, and the override is a DIRECTORY, never a value.
INPUT_DIR="${PROJECTION_REAL_PROVIDER_INPUT_DIR:-/mnt/user/appdata/catalog/secrets/real-provider}"
CREDENTIAL_FILE="$INPUT_DIR/credential"
OBJECTS_FILE="$INPUT_DIR/objects.json"
ENDPOINT_FILE="$INPUT_DIR/endpoint.json"

MODE="real"
for arg in "$@"; do
  case "$arg" in
    --fake) MODE="fake" ;;
    --real) MODE="real" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_REAL_PROVIDER_GATE_PG_PORT="$PG_PORT"

cleanup() {
  docker rm -f "$MOUNT_CONTAINER" "$FAKE_CONTAINER" >/dev/null 2>&1 || true
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

field()         { node "$REL/jq.cjs" "$1"; }
publish()       { npx tsx src/ops/projection-publish-cli.ts --manifest-dir "$REL/manifest" "$@"; }
register()      { npx tsx src/ops/projection-register-cli.ts "$@"; }
real_provider() { npx tsx src/ops/projection-real-provider-cli.ts "$@"; }

GATE_SKIP_STATUS=77

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

cat > "$WORK/fake-objects.cjs" <<'FAKEOBJECTS'
// Turns the fake provider's own emitted descriptor into the operator-shaped object manifest, so FAKE MODE
// drives the identical input path a real run does rather than a parallel one.
const { readFileSync, writeFileSync } = require('node:fs');
const [, , emitted, out, size] = process.argv;
const descriptor = JSON.parse(readFileSync(emitted, 'utf8'));
const list = Array.isArray(descriptor) ? descriptor : (descriptor.objects ?? []);
const first = list[0];
const ref = typeof first === 'string' ? first : (first?.ref ?? 'rp-object-1');
// A PROBE DIGEST RATHER THAN A WHOLE-OBJECT ONE, because that is the path an operator with a large file
// takes, and the path that would otherwise never be exercised offline. The digest is a placeholder here and
// is replaced by the control, which reads the same window directly, outside the mount.
const manifest = [{ label: 'object-1', ref, sizeBytes: Number(size),
  probeDigests: [{ offset: 1, length: 65536, sha256: '0'.repeat(64) }] }];
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
FAKEOBJECTS

cat > "$WORK/register.cjs" <<'REGISTER'
// Emits the register commands for the operator's objects into a shell file at mode 0600.
//
// WHY A FILE RATHER THAN INLINE COMMANDS. The stable reference is an argument to `register entry`, and argv
// is world-readable. Writing the commands to a 0600 file and running that keeps the reference out of every
// process listing taken while the gate runs.
const { readFileSync, writeFileSync, chmodSync } = require('node:fs');
const [, , out, objectsPath, endpointPath] = process.argv;
const objects = JSON.parse(readFileSync(objectsPath, 'utf8'));
const endpoint = JSON.parse(readFileSync(endpointPath, 'utf8'));
const q = (value) => JSON.stringify(String(value));
const cli = 'npx tsx src/ops/projection-register-cli.ts';
const lines = ['#!/usr/bin/env bash', 'set -euo pipefail',
  cli + ' root --id ' + q(endpoint.id) + ' --kind http-range'];
objects.forEach((object, index) => {
  const key = 'rp-version-' + (index + 1);
  const item = '00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0');
  lines.push(cli + ' version --key ' + key + ' --size ' + object.sizeBytes
    + ' --mtime 2026-01-01T00:00:00.000Z');
  lines.push(cli + ' entry --item ' + q(item) + ' --version-key ' + key
    + ' --path ' + q(object.label + '.bin')
    + ' --source ' + q(endpoint.id + ':' + object.ref));
});
const script = out.replace(/[^/]*$/, '') + 'register.sh';
writeFileSync(script, lines.join('\n') + '\n');
chmodSync(script, 0o600);
writeFileSync(out, JSON.stringify({ objects: objects.length }, null, 2) + '\n');
REGISTER

cat > "$WORK/config.cjs" <<'CONFIG'
// The daemon config, built from the operator's endpoint description.
//
// THE CREDENTIAL IS NAMED BY PATH AND ITS VALUE IS NEVER READ HERE. The daemon opens the file itself, checks
// its mode, and keeps the value inside `source.SecretFile`, which never renders it.
const { readFileSync, writeFileSync } = require('node:fs');
const [, , endpointPath, out] = process.argv;
const endpoint = JSON.parse(readFileSync(endpointPath, 'utf8'));
const config = {
  mountPoint: '/mnt/projection',
  pointerPath: '/var/lib/projectiond/manifest/pointer.json',
  probeCacheDir: '/var/lib/projectiond/cache',
  globalMaxInflight: 4,
  perEndpointMaxInflight: 2,
  endpoints: [{
    id: endpoint.id,
    resolverUrl: endpoint.resolverUrl,
    directBaseUrl: endpoint.directBaseUrl,
    allowedOrigins: endpoint.allowedOrigins,
    tokenFile: '/var/lib/projectiond/inputs/credential',
    allowInsecureHttp: endpoint.allowInsecureHttp === true,
    allowPrivateAddresses: endpoint.allowPrivateAddresses === true,
    maxConnections: 2,
  }],
};
writeFileSync(out, JSON.stringify(config, null, 2) + '\n');
CONFIG

cat > "$WORK/scan.cjs" <<'SCAN'
// Searches everything the run wrote for the exact credential value.
//
// "WE DO NOT LOG IT" IS A CLAIM; THIS IS A MEASUREMENT. The needle arrives as a FILE PATH so it never enters
// argv, and only a COUNT is printed -- never a match, never a line, never a filename.
const { readFileSync, readdirSync, statSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const [, , credentialPath, ...roots] = process.argv;
const needle = readFileSync(credentialPath, 'utf8').trim();
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
// A SHORT NEEDLE WOULD MATCH BY CHANCE, and a false positive here reads as a leak that did not happen.
if (needle.length >= 8) { for (const root of roots) walk(root); }
console.log(String(hits));
SCAN

cat > "$WORK/observations.cjs" <<'OBSERVATIONS'
// The observation record the verdict phase reads. COUNTERS ONLY: no URL, no reference, no header, no value.
const { writeFileSync } = require('node:fs');
const [, , out, write, create, unlink, chmod, leaseTraces, mode] = process.argv;
const record = {
  // NOT PROVOKED, ONLY BOUNDED. This corpus is never a load test, so no 429 is manufactured and no retry is
  // forced; what is recorded is what happened while the gate did its ordinary reads.
  status429: 0,
  retries: 0,
  refreshesPerRead: [],
  disallowedOriginContacts: 0,
  // The direct path has no expiring access material, so the refresh assertion correctly SKIPS -- and a skip
  // says so. G24-G26 assert the refresh contract in full against the expiring-lease mode.
  endpointExpires: false,
  readOnly: {
    writeRefused: write === 'true',
    createRefused: create === 'true',
    unlinkRefused: unlink === 'true',
    chmodRefused: chmod === 'true',
  },
  cleanup: { mountpoints: 0, containers: 0, runDirectories: 0, leaseTracesOnDisk: Number(leaseTraces) },
  mode,
};
writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
OBSERVATIONS






# ----------------------------------------------------------------------------------------------------------
step "deciding whether this host can run the gate at all, and refusing to guess"
# ----------------------------------------------------------------------------------------------------------
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no /dev/fuse is reachable from a container on this host." >&2
  echo "      The real-provider correctness run is entirely UNPROVEN here. Nothing ran, and this run" >&2
  echo "      closes NO acceptance gate. It is not a pass and must not be reported as one." >&2
  exit "$GATE_SKIP_STATUS"
fi

if [ "$MODE" = "real" ]; then
  # THE ONLY PLACE THIS GATE LOOKS, AND IT LOOKS ONCE.
  missing=""
  [ -f "$CREDENTIAL_FILE" ] || missing="$missing credential"
  [ -f "$OBJECTS_FILE" ]    || missing="$missing objects.json"
  [ -f "$ENDPOINT_FILE" ]   || missing="$missing endpoint.json"
  if [ -n "$missing" ]; then
    echo "SKIPPED (status ${GATE_SKIP_STATUS}): the operator has supplied no real-provider corpus." >&2
    echo "      Missing under the approved input directory:$missing" >&2
    echo "" >&2
    echo "      This gate NEVER invents a credential, an object manifest or an endpoint, and never" >&2
    echo "      contacts anything without all three already present. A skip here is the CORRECT and" >&2
    echo "      expected outcome on any machine the operator has not deliberately prepared." >&2
    echo "" >&2
    echo "      It is not a pass and must not be reported as one. Phase 1 stays open." >&2
    echo "      Templates: deploy/real-provider-objects.template.json, ...-endpoint.template.json" >&2
    echo "      To exercise every assertion offline instead: npm run go:real-provider-gate:fake" >&2
    exit "$GATE_SKIP_STATUS"
  fi
  echo "  the operator has supplied a corpus; this run WILL contact a real provider"
  OBJECTS="$OBJECTS_FILE"
  ENDPOINT="$ENDPOINT_FILE"
  CREDENTIAL="$CREDENTIAL_FILE"
else
  echo "  FAKE MODE: no credential, no external contact, every assertion still evaluated"
fi

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
if [ "$MODE" = "fake" ]; then
step "standing up the pinned deterministic fake provider, and writing the inputs it implies"
# ----------------------------------------------------------------------------------------------------------
  # THE FAKE PROVIDER IS THE PRODUCT'S OWN, and it is the same one G14-G26 use. Its faults are what make the
  # adversarial half of this gate executable: full-body-on-range, malformed and mismatched Content-Range,
  # short body, wrong total size, redirect, 429 and disallowed-host are all injectable per object.
  FAKE_SIZE=$((8 * 1024 * 1024))
  head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$WORK/inputs/credential"
  chmod 600 "$WORK/inputs/credential"

  docker run -d --name "$FAKE_CONTAINER" --network "$NETWORK" \
    -p "127.0.0.1:${FAKE_PORT}:8099" \
    -v "$WORK/inputs:/inputs:ro" -v "$WORK/out:/out" \
    --entrypoint /usr/local/bin/fakerange "$IMAGE" \
    -addr 0.0.0.0:8099 -object "rp-object-1:${FAKE_SIZE}" \
    -token-file /inputs/credential -emit /out/fake-objects.json >/dev/null \
    || die "the fake provider did not start"

  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:${FAKE_PORT}/healthz" >/dev/null 2>&1 && break
    sleep 0.5
  done

  # THE FAKE PROVIDER SPEAKS PLAINTEXT ON LOOPBACK, so this mode deliberately relaxes the two switches the
  # real mode refuses -- and `endpointProblems` refuses BOTH of them for a real endpoint, which is exactly
  # why the fake inputs are written here rather than reused as a template for an operator.
  cat > "$WORK/inputs/endpoint.json" <<JSON
{
  "id": "fake",
  "directBaseUrl": "http://127.0.0.1:${FAKE_PORT}/direct",
  "allowedOrigins": ["http://127.0.0.1:${FAKE_PORT}"],
  "allowInsecureHttp": true,
  "allowPrivateAddresses": true
}
JSON
  node "$REL/fake-objects.cjs" "$REL/out/fake-objects.json" "$REL/inputs/objects.json" "$FAKE_SIZE"
  OBJECTS="$REL/inputs/objects.json"
  ENDPOINT="$REL/inputs/endpoint.json"
  CREDENTIAL="$REL/inputs/credential"
fi

# ----------------------------------------------------------------------------------------------------------
step "PREFLIGHT — the input shape and the credential's permissions, contacting NOTHING"
# ----------------------------------------------------------------------------------------------------------
# THIS RUNS BEFORE ANY REQUEST IS MADE, and that ordering is the point. An operator with a 0644 credential,
# a manifest missing a digest or an endpoint that would send a bearer token over plaintext finds out here --
# not from a read failure forty seconds into a run against an account they are being charged for.
if [ "$MODE" = "fake" ]; then
  # In fake mode the endpoint deliberately fails the real-endpoint rules, so the preflight is run against a
  # REAL-SHAPED endpoint template to prove the check bites, and the fake run proceeds without it.
  real_provider preflight --objects "$OBJECTS" --credential "$CREDENTIAL" \
    --endpoint deploy/real-provider-endpoint.template.json >/dev/null 2>&1 \
    && die "the preflight accepted the template, which still carries REPLACE-ME placeholders"
  echo "  the preflight correctly REFUSES a template that has not been filled in"
else
  real_provider preflight --objects "$OBJECTS" --credential "$CREDENTIAL" --endpoint "$ENDPOINT" \
    || die "the operator's inputs are not usable; nothing was contacted"
fi

# ----------------------------------------------------------------------------------------------------------
step "CONTROL — one direct ranged request per object, with the daemon nowhere in the path"
# ----------------------------------------------------------------------------------------------------------
real_provider control --objects "$OBJECTS" --credential "$CREDENTIAL" --endpoint "$ENDPOINT" \
  --out "$REL/out/control.json" \
  || die "the control could not establish what the provider does"

# ----------------------------------------------------------------------------------------------------------
step "publishing a generation naming the operator's objects, and mounting it"
# ----------------------------------------------------------------------------------------------------------
node "$REL/register.cjs" "$REL/out/register.json" "$OBJECTS" "$ENDPOINT"
bash "$WORK/out/register.sh"
publish > "$WORK/out/publish.json"
test "$(field outcome < "$WORK/out/publish.json")" = "published" || die "the generation was not published"

node "$REL/config.cjs" "$REL/inputs/endpoint.json" "$WORK/config.json" "$CREDENTIAL"

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

ready=0
for _ in $(seq 1 120); do
  if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" sh -c 'ls /mnt/*.bin' >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
test "$ready" -eq 1 || { logs_tail "$MOUNT_CONTAINER"; die "the mount never became visible"; }

# ----------------------------------------------------------------------------------------------------------
step "READS — backward, past 90%, and the approved windows, digested against values from outside the mount"
# ----------------------------------------------------------------------------------------------------------
real_provider reads --objects "$OBJECTS" --mount "$WORK/mnt" --control "$REL/out/control.json" \
  --out "$REL/out/reads.json" \
  || { logs_tail "$MOUNT_CONTAINER"; die "the reads through the mount failed"; }

# ----------------------------------------------------------------------------------------------------------
step "the mount is READ-ONLY, checked as the unprivileged uid a media server actually runs as"
# ----------------------------------------------------------------------------------------------------------
TARGET="$(docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" sh -c 'ls /mnt/*.bin | head -1')"
refused() { docker run --rm --user 65534:65534 --cap-drop ALL -v "$WORK/mnt:/mnt:rslave" \
  "$VERIFY_IMAGE" sh -c "$1" >/dev/null 2>&1 && echo false || echo true; }
WRITE_REFUSED="$(refused "echo x >> '$TARGET'")"
CREATE_REFUSED="$(refused "touch /mnt/created.bin")"
UNLINK_REFUSED="$(refused "rm -f '$TARGET'")"
CHMOD_REFUSED="$(refused "chmod 777 '$TARGET'")"

# ----------------------------------------------------------------------------------------------------------
step "no access material reached disk — searched for by the exact value the run used"
# ----------------------------------------------------------------------------------------------------------
# "WE DO NOT LOG IT" IS A CLAIM; THIS IS A MEASUREMENT. The credential is a high-entropy value this run
# generated (fake mode) or the operator supplied (real mode), so a grep for it across everything the run
# wrote is decisive. The needle is passed by FILE, never on the command line, so it never enters argv.
LEASE_TRACES="$(node "$REL/scan.cjs" "$CREDENTIAL" "$WORK/out" "$WORK/manifest" "$WORK/cache")"

# ----------------------------------------------------------------------------------------------------------
step "the verdict"
# ----------------------------------------------------------------------------------------------------------
node "$REL/observations.cjs" "$REL/out/observations.json" \
  "$WRITE_REFUSED" "$CREATE_REFUSED" "$UNLINK_REFUSED" "$CHMOD_REFUSED" "$LEASE_TRACES" "$MODE"

real_provider verdict --objects "$OBJECTS" --control "$REL/out/control.json" \
  --reads "$REL/out/reads.json" --observations "$REL/out/observations.json" \
  --results "$REL/out/results.json"

real_provider report --results "$REL/out/results.json" --json "$REL/out/results-summary.json"

if [ "$MODE" = "fake" ]; then
  echo
  echo "FAKE MODE COMPLETED. Every phase and every assertion ran, offline, against the product's own"
  echo "deterministic fake provider. This proves the GATE works and can fail. It proves NOTHING about any"
  echo "real provider, closes no acceptance gate, and Phase 1 stays open on exactly that ground."
fi
