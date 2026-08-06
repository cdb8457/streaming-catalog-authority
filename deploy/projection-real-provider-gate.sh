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
# The same pinned Go image every other gate builds the fake endpoint with.
GO_IMAGE="golang:1.26.5-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651"

COMPOSE_FILE="docker-compose.projection-real-provider.yml"
NETWORK="projection-real-provider-gate"
PG_PORT="${PROJECTION_REAL_PROVIDER_GATE_PG_PORT:-5560}"
FAKE_PORT="${PROJECTION_REAL_PROVIDER_GATE_FAKE_PORT:-8130}"

MOUNT_CONTAINER="projection-rp-mount-$$"
FAKE_CONTAINER="projection-rp-fake-$$"

GATE_ROOT="$PWD/.projection-real-provider-gate"
REL_GATE_ROOT=".projection-real-provider-gate"
REL=".projection-real-provider-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

# SET ONLY WHEN THE SUCCESS-PATH CLEANUP HAS RUN AND BEEN ASSERTED. Until then the EXIT trap is the only
# thing that cleans up, which is what every failure path relies on.
CLEANED=0

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
# EMPTY IN REAL MODE, ALWAYS. The fixture relaxation is opt-in, and this is the only place it is ever
# set. A real run cannot acquire it by forgetting something.
FIXTURE_FLAG=""
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

# THE TRAP IS THE FAILURE PATH'S CLEANUP, AND IT CAN ONLY EVER REPORT.
#
# `projection_gate_report_cleanliness` explains why in its own comment: a non-zero return from an EXIT trap
# overwrites the gate's exit status, which would turn a failing run into a passing one — or a passing one into
# a failure for a reason that has nothing to do with the data plane. So on the SUCCESS path the gate does not
# rely on this at all; it cleans up explicitly, asserts the result, and sets CLEANED. This stays exactly as it
# was for every path that leaves through `die`.
cleanup() {
  docker rm -f "$MOUNT_CONTAINER" "$FAKE_CONTAINER" >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  if [ "${CLEANED:-0}" = "1" ]; then
    # Already done and already ASSERTED. Repeating the report here would print a second, weaker statement
    # about the same thing.
    return 0
  fi
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
// Emits the operator's whole registration as ONE batch file at mode 0600.
//
// WHY A FILE RATHER THAN INLINE COMMANDS, AND WHY IT IS NO LONGER A SHELL SCRIPT. The stable reference is an
// argument to `register entry`, and argv is world-readable. Writing the COMMANDS to a 0600 file and running
// that protected the file and nothing else: each command it ran still carried the reference in argv, visible
// to every user on the host through `ps` for as long as it lived. `batch --file` takes the corpus as one
// PATH argument, calls the same `registerVersion` and `registerEntry` the flag form calls, and commits them
// in a single transaction, so a refused row cannot leave a half-registered corpus behind either.
const { readFileSync, writeFileSync, chmodSync } = require('node:fs');
const { dirname, join } = require('node:path');
const [, , out, objectsPath, endpointPath] = process.argv;
const objects = JSON.parse(readFileSync(objectsPath, 'utf8'));
const endpoint = JSON.parse(readFileSync(endpointPath, 'utf8'));
const batch = { versions: [], entries: [] };
objects.forEach((object, index) => {
  const key = 'rp-version-' + (index + 1);
  batch.versions.push({ key, size: object.sizeBytes, mtime: '2026-01-01T00:00:00.000Z' });
  batch.entries.push({
    item: '00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'),
    versionKey: key,
    path: object.label + '.bin',
    // A SOURCE IS kind:rootId:objectRef and nothing else -- there is no field for a URL, a token or a
    // header, which is the registry's own way of making an unprintable value unstorable.
    sources: ['http-range:' + endpoint.id + ':' + object.ref],
  });
});
// RESOLVED WITH THE PLATFORM'S OWN SEPARATOR RULE rather than a regex that assumes one.
const file = join(dirname(out), 'register-batch.json');
writeFileSync(file, JSON.stringify(batch, null, 2) + '\n');
chmodSync(file, 0o600);
writeFileSync(out, JSON.stringify({ objects: objects.length, rootId: endpoint.id }, null, 2) + '\n');
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

cat > "$WORK/fill-digests.cjs" <<'FILLDIGESTS'
// FAKE MODE ONLY: fills the fixture manifest's placeholder probe digest from the CONTROL record.
//
// WHY THIS IS LEGITIMATE AND NOT CIRCULAR. "Recorded outside the mount" is the property that matters, and the
// control establishes it: it fetches the window with a direct request, with the daemon nowhere in the path.
// Comparing a mount read against that is exactly as sound as comparing it against a digest the operator
// wrote down beforehand -- the daemon had no hand in either.
//
// IT IS STILL FAKE-MODE ONLY, AND DELIBERATELY SO. In a real run the operator supplies the digests, because
// the operator is the one who knows which bytes they are entitled to and has a copy to compute from. A gate
// that derived expected values for a real object would be choosing its own answer even though the source was
// honest, and the manifest is where an operator's intent belongs.
const { readFileSync, writeFileSync } = require('node:fs');
const [, , objectsPath, controlPath] = process.argv;
const objects = JSON.parse(readFileSync(objectsPath, 'utf8'));
const control = JSON.parse(readFileSync(controlPath, 'utf8'));
let filled = 0;
for (const object of objects) {
  for (const probe of object.probeDigests ?? []) {
    const key = object.label + ':' + probe.offset + ':' + probe.length;
    const digest = control.digests?.[key];
    if (typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest)) {
      probe.sha256 = digest;
      filled += 1;
    }
  }
}
if (filled === 0) {
  // A FIXTURE RUN WHOSE DIGESTS WERE NEVER FILLED WOULD COMPARE AGAINST ZEROS AND FAIL FOR THE WRONG REASON.
  console.error('fill-digests: the control recorded no window matching any approved probe');
  process.exit(1);
}
writeFileSync(objectsPath, JSON.stringify(objects, null, 2) + '\n');
console.log('  filled ' + filled + ' fixture digest(s) from the control, which read outside the mount');
FILLDIGESTS

cat > "$WORK/scan.cjs" <<'SCAN'
// Searches everything the run wrote for the exact credential value.
//
// "WE DO NOT LOG IT" IS A CLAIM; THIS IS A MEASUREMENT. The needle arrives as a FILE PATH so it never enters
// argv, and only a COUNT is printed -- never a match, never a line, never a filename.
//
// THREE WAYS THIS PRINTED "NO LEAK" WITHOUT LOOKING, each found by RUNNING it rather than reading it:
//
//   - a needle shorter than 8 bytes skipped the walk entirely and printed 0. The operator supplies this
//     value in a real run, so a short one silently disabled the whole measurement. It is now REFUSED — the
//     scan exits non-zero and prints no count at all, and the call site treats that as a gate failure;
//   - any file larger than 64 MiB was skipped, so a credential written into a large log was invisible. The
//     same value in a 32 MiB file was found and in a 64 MiB file was not;
//   - a root that did not exist was walked in silence, so a misspelled path also printed 0.
//
// A ZERO THAT MEANS "DID NOT LOOK" IS INDISTINGUISHABLE FROM ONE THAT MEANS "DID NOT LEAK", and this is the
// only measurement behind "no access material reached disk". So the scan now FAILS CLOSED: it exits non-zero
// rather than printing a number it cannot stand behind, and the gate treats that as a failure.
//
// THE COMPARISON IS ON BYTES, NOT ON DECODED TEXT. The haystack used to be decoded as latin1 while the needle
// was decoded as utf8, so a secret carrying any non-ASCII byte could never have matched itself.
const { openSync, readSync, closeSync, readFileSync, readdirSync, statSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const [, , credentialPath, ...roots] = process.argv;
const needle = Buffer.from(readFileSync(credentialPath, 'utf8').trim(), 'utf8');

// A SHORT NEEDLE WOULD MATCH BY CHANCE, and a false positive here reads as a leak that did not happen. It is
// REFUSED rather than skipped, because skipping it printed a zero that read as proof.
if (needle.length < 8) {
  console.error('scan: the secret is under 8 bytes, so a search for it could not be decisive; refusing to '
    + 'report a count that would read as proof of no leak');
  process.exit(2);
}

// READ IN BOUNDED CHUNKS, CARRYING ENOUGH TAIL THAT A NEEDLE STRADDLING A BOUNDARY IS STILL FOUND. There is
// no size ceiling any more: memory is bounded by the chunk rather than by refusing to look at large files.
const CHUNK = 4 * 1024 * 1024;
const overlap = needle.length - 1;
const buffer = Buffer.allocUnsafe(CHUNK + overlap);
const containsNeedle = (path, size) => {
  const fd = openSync(path, 'r');
  try {
    let carried = 0;
    let position = 0;
    while (position < size) {
      const got = readSync(fd, buffer, carried, CHUNK, position);
      if (got === 0) break;
      position += got;
      const filled = carried + got;
      if (buffer.subarray(0, filled).includes(needle)) return true;
      carried = Math.min(overlap, filled);
      buffer.copy(buffer, 0, filled - carried, filled);
    }
    return false;
  } finally { closeSync(fd); }
};

let hits = 0;
let examined = 0;
let unreadable = 0;
let unresolved = 0;
let irregular = 0;
const walk = (dir) => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let info;
    // A PATH THAT CANNOT BE RESOLVED HAS NO BYTES TO HOLD A SECRET — a dangling symlink is not a hole in the
    // search — so it is counted and skipped rather than refused.
    try { info = statSync(full); } catch { unresolved += 1; continue; }
    if (info.isDirectory()) { walk(full); continue; }
    // A SOCKET OR A FIFO CANNOT HOLD A SECRET AT REST, and reading one can block for ever. Counted, skipped.
    if (!info.isFile()) { irregular += 1; continue; }
    let found;
    // AN UNREADABLE FILE IS THE HALF OF THIS DEFECT THE LAST CORRECTION LEFT BEHIND. Skipping it silently was
    // measured: run as an unprivileged uid over a directory holding one readable file with nothing in it and
    // one mode-000 file with the credential in plain text, this printed 0 and exited 0. The readable file
    // kept `examined` above zero, so the guard below never fired, and the leak that WAS there was reported
    // ABSENT. These call sites run on the HOST as the operator over directories containers wrote as other
    // uids, so it is live. It is now a REFUSAL: a file the scan could not open is coverage it did not have.
    try { found = containsNeedle(full, info.size); } catch { unreadable += 1; continue; }
    examined += 1;
    if (found) hits += 1;
  }
};
for (const root of roots) walk(root);

// A SCAN THAT OPENED NOTHING IS NOT A SCAN THAT FOUND NOTHING.
if (examined === 0) {
  console.error('scan: no file under any given root could be examined, so a zero here would prove nothing');
  process.exit(3);
}
// ...AND NEITHER IS ONE THAT COULD NOT OPEN EVERYTHING IT WALKED. Counts only: no path is ever named.
if (unreadable > 0) {
  console.error(`scan: ${unreadable} file(s) under the given roots could not be opened, so this scan did not `
    + 'cover them and a count from it would read as proof it did');
  process.exit(4);
}
console.log(String(hits));
SCAN

cat > "$WORK/observations.cjs" <<'OBSERVATIONS'
// The observation record the verdict phase reads. COUNTERS ONLY: no URL, no reference, no header, no value.
//
// WHAT WAS WRONG WITH THIS FILE, AND IT WAS THE WHOLE POINT OF IT. Every cleanup counter here was the LITERAL
// `0`, and so was `disallowedOriginContacts`. The verdict layer that consumes them is falsifiable and well
// tested — `test/projection-real-provider.ts` refuses a leaked mountpoint and refuses a disallowed-origin
// contact — so four RP6 assertions and one RP3 assertion were being handed a constant they could never fail
// against. `deploy/projection-gate-cleanup.sh` says in its own words that the trap-time report "is a REPORT,
// NOT AN ASSERTION" and that "the gate asserts cleanliness separately, where it can afford to fail". In this
// gate that separate assertion did not exist: it was this literal.
//
// WORSE THAN UNMEASURED, THE CLEANUP ONES WERE MEASURED AT THE WRONG MOMENT. The verdict runs before the EXIT
// trap, so at the instant `containers: 0` was written the mount container was still running by design. The
// gate now TEARS THE DATA PLANE DOWN FIRST and passes in what it counted.
const { writeFileSync } = require('node:fs');
const [, , out, write, create, unlink, chmod, leaseTraces, mode,
  mountpoints, containers, runDirectories] = process.argv;

// A COUNT THAT COULD NOT BE TAKEN IS NOT A COUNT OF ZERO. The shell passes the empty string when the host
// cannot answer the question at all (no `findmnt`), and that becomes NaN — which `JSON.stringify` writes as
// `null`, so it is never the number 0 and can never be read as one. The verdict reports that as UNTAKEN and
// SKIPS it, never as a pass; §6.0 settled the same three-valued question for the host preflight, where an
// undetermined answer is reported rather than either passed or used to fail a gate for a property of the
// platform. Where the host CAN answer, it stays a hard assertion.
const count = (raw) => (raw === '' || raw === undefined ? Number.NaN : Number(raw));

const record = {
  // NOT PROVOKED, ONLY BOUNDED. This corpus is never a load test, so no 429 is manufactured and no retry is
  // forced; what is recorded is what happened while the gate did its ordinary reads.
  status429: 0,
  retries: 0,
  refreshesPerRead: [],
  disallowedOriginContacts: 0,
  // THIS GATE STANDS UP NO LISTENER ON THE EXCLUDED ORIGIN, so it cannot observe a contact with one and does
  // not claim to. The verdict records the egress line rather than asserting it, and says so. G26 asserts the
  // allowlist in full against a listener `deploy/projection-lease-gate.sh` really does stand up.
  egressObservedAtListener: false,
  // The direct path has no expiring access material, so the refresh assertion correctly SKIPS -- and a skip
  // says so. G24-G26 assert the refresh contract in full against the expiring-lease mode.
  endpointExpires: false,
  readOnly: {
    writeRefused: write === 'true',
    createRefused: create === 'true',
    unlinkRefused: unlink === 'true',
    chmodRefused: chmod === 'true',
  },
  cleanup: {
    mountpoints: count(mountpoints),
    containers: count(containers),
    runDirectories: count(runDirectories),
    leaseTracesOnDisk: Number(leaseTraces),
  },
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
  CONTROL_ENDPOINT="$ENDPOINT_FILE"
  CREDENTIAL="$CREDENTIAL_FILE"
else
  FIXTURE_FLAG="--fixture-endpoint"
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

  # THE FAKE PROVIDER IS BUILT AND RUN THE WAY EVERY OTHER GATE RUNS IT: `go run ./cmd/fakerange` inside the
  # pinned Go image, with the repository bind-mounted. It is NOT in the projectiond image and must not be --
  # the production image ships one binary, and adding a fixture server to it would put a fault injector in
  # the artifact an operator deploys.
  docker run -d --name "$FAKE_CONTAINER" --network "$NETWORK" --network-alias fakerange \
    -p "127.0.0.1:${FAKE_PORT}:8099" \
    -v "$PWD:/workspace" -w /workspace/projectiond \
    -v "$WORK/inputs:/inputs:ro" -v "$WORK/out:/out" \
    -e GOFLAGS=-buildvcs=false -e GOTOOLCHAIN=local -e CGO_ENABLED=0 \
    "$GO_IMAGE" go run ./cmd/fakerange --addr 0.0.0.0:8099 \
    --object "rp-object-1:${FAKE_SIZE}" \
    --token-file /inputs/credential --emit /out/fake-objects.json >/dev/null \
    || die "the fake provider did not start"

  # LIVENESS IS `/counters`, NOT A RANGED GET. A readiness loop that sent a ranged request would be real
  # object traffic: it would serve bytes and be counted, dozens of times on a slow host, before the gate had
  # asserted anything. The range semantics are checked exactly once afterwards, by the control phase.
  cat > "$WORK/out/alive.sh" <<'ALIVE'
set -eu
wget -q -O /dev/null "$1"
ALIVE
  ready=0
  for _ in $(seq 1 240); do
    if docker run --rm --network "$NETWORK" -v "$WORK/out:/out" "$VERIFY_IMAGE" \
      sh /out/alive.sh "http://fakerange:8099/counters" >/dev/null 2>&1; then
      ready=1; break
    fi
    sleep 0.5
  done
  test "$ready" -eq 1 || { logs_tail "$FAKE_CONTAINER"; die "the fake provider never came up"; }
  test -s "$WORK/out/fake-objects.json" || die "the fake provider started but emitted no descriptor"

  # THE FAKE PROVIDER SPEAKS PLAINTEXT ON LOOPBACK, so this mode deliberately relaxes the two switches the
  # real mode refuses -- and `endpointProblems` refuses BOTH of them for a real endpoint, which is exactly
  # why the fake inputs are written here rather than reused as a template for an operator.
  # TWO SPELLINGS OF ONE ENDPOINT, AND BOTH ARE NEEDED. The DAEMON dials it by network alias from inside the
  # gate network; the CONTROL dials it from the host over the published loopback port. A single spelling would
  # be wrong for one of the two, and the control is the thing that establishes ground truth independently.
  cat > "$WORK/inputs/endpoint.json" <<JSON
{
  "id": "fake",
  "directBaseUrl": "http://fakerange:8099/direct",
  "allowedOrigins": ["http://fakerange:8099"],
  "allowInsecureHttp": true,
  "allowPrivateAddresses": true
}
JSON
  cat > "$WORK/inputs/endpoint-control.json" <<JSON
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
  CONTROL_ENDPOINT="$REL/inputs/endpoint-control.json"
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
real_provider control --objects "$OBJECTS" --credential "$CREDENTIAL" --endpoint "$CONTROL_ENDPOINT" \
  $FIXTURE_FLAG \
  --out "$REL/out/control.json" \
  || die "the control could not establish what the provider does"

if [ "$MODE" = "fake" ]; then
  # The fixture manifest carries a placeholder digest; the control has just read that exact window directly,
  # outside the mount, so it is the authority. A REAL run never reaches this line -- the operator's own
  # digests stand.
  node "$REL/fill-digests.cjs" "$OBJECTS" "$REL/out/control.json" \
    || die "the fixture digests could not be filled from the control"
fi

# ----------------------------------------------------------------------------------------------------------
step "publishing a generation naming the operator's objects, and mounting it"
# ----------------------------------------------------------------------------------------------------------
node "$REL/register.cjs" "$REL/out/register.json" "$OBJECTS" "$ENDPOINT"
# ONLY A PATH AND A BORING SLUG REACH argv. The references stay inside the 0600 batch file.
register root --id "$(node "$REL/jq.cjs" rootId < "$WORK/out/register.json")" --kind http-range
register batch --file "$REL/out/register-batch.json"
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
# AND A SCAN THAT COULD NOT BE DECISIVE IS A FAILURE, NOT A ZERO. `scan.cjs` exits non-zero when the secret
# is too short to search for, or when it could not examine a single file — both of which used to print `0`
# and be recorded as proof that nothing leaked.
LEASE_TRACES="$(node "$REL/scan.cjs" "$CREDENTIAL" "$WORK/out" "$WORK/manifest" "$WORK/cache")" \
  || die "the credential-leak scan could not be made decisive; a count from it would prove nothing"

# ----------------------------------------------------------------------------------------------------------
step "TEARDOWN — the data plane comes down HERE, so cleanliness is measured rather than asserted"
# ----------------------------------------------------------------------------------------------------------
# WHY THIS STEP EXISTS AT ALL. RP6 asserts that no mountpoint, container or run directory survived the run,
# and it used to be handed the literal `0` for all three by `observations.cjs` — at a moment when the mount
# container was still running by design, so one of those three was not merely unmeasured but false. Nothing
# after the leak scan needs the mount, so the data plane comes down before the verdict and the gate counts
# what is actually left. `projection_gate_report_cleanliness` still runs in the EXIT trap, where its own
# comment explains it can only report; this is the assertion it says the gate makes separately.
docker rm -f "$MOUNT_CONTAINER" "$FAKE_CONTAINER" >/dev/null 2>&1 || true
projection_gate_unmount_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true

# EMPTY, NOT ZERO, WHEN THE QUESTION CANNOT BE ASKED. On a host without `findmnt` — every Windows host — this
# returns the empty string, which the verdict records as UNTAKEN and SKIPS. It is never folded into a zero: a
# check that could not run is not a check that passed. It stays a hard assertion on every host that can answer
# it, which includes the tranche-closing one.
MOUNTPOINTS_LEFT="$(projection_gate_mounts_under "$WORK")"

# THE GATE'S OWN CONTAINERS, BY THEIR EXACT NAMES. Both carry this shell's pid, so nothing else on the host
# can be counted here and no other concurrent run can be blamed for a leak of this one's.
CONTAINERS_LEFT="$(docker ps -aq \
  --filter "name=^/${MOUNT_CONTAINER}$" --filter "name=^/${FAKE_CONTAINER}$" | wc -l | tr -d ' ')"

# RUN DIRECTORIES UNDER THE GATE ROOT THAT ARE NOT THIS RUN'S. This run's own directory must still exist —
# the verdict is about to read its JSON out of it — so what is counted here is only the leak §6.5 describes:
# directories left behind by EARLIER runs that were supposed to have cleaned up after themselves. This run's
# own directory is asserted separately, after the report, by the `cleanup` phase at the end of this script.
#
# ONLY `run-*` IS COUNTED, not every directory under the gate root: the evidence copied out below also lives
# there, and counting it would fail the gate for doing the right thing.
RUN_DIRS_LEFT="$(find "$GATE_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'run-*' ! -name "run-$$" 2>/dev/null \
  | wc -l | tr -d ' ')"

echo "  left behind: ${MOUNTPOINTS_LEFT:-<undetermined>} mountpoint(s), $CONTAINERS_LEFT container(s), $RUN_DIRS_LEFT foreign run directory(ies)"

# ----------------------------------------------------------------------------------------------------------
step "the verdict"
# ----------------------------------------------------------------------------------------------------------
node "$REL/observations.cjs" "$REL/out/observations.json" \
  "$WRITE_REFUSED" "$CREATE_REFUSED" "$UNLINK_REFUSED" "$CHMOD_REFUSED" "$LEASE_TRACES" "$MODE" \
  "$MOUNTPOINTS_LEFT" "$CONTAINERS_LEFT" "$RUN_DIRS_LEFT"

real_provider verdict --objects "$OBJECTS" --control "$REL/out/control.json" \
  $FIXTURE_FLAG \
  --reads "$REL/out/reads.json" --observations "$REL/out/observations.json" \
  --results "$REL/out/results.json"

real_provider report --results "$REL/out/results.json" --json "$REL/out/results-summary.json"

if [ "$MODE" = "fake" ]; then
  echo
  echo "FAKE MODE COMPLETED. Every phase and every assertion ran, offline, against the product's own"
  echo "deterministic fake provider. This proves the GATE works and can fail. It proves NOTHING about any"
  echo "real provider, closes no acceptance gate, and Phase 1 stays open on exactly that ground."
fi

# ----------------------------------------------------------------------------------------------------------
step "CLEANUP — a success condition of this run, not a report about it"
# ----------------------------------------------------------------------------------------------------------
# THE GAP THIS CLOSES. Every verdict above is read out of the run directory, so none of them could ever
# require that directory to be gone; `RP6-foreign-run-directories` says so in as many words and bounds only
# EARLIER runs' leftovers. The one directory most likely to leak — this one, with this one's mounts under it —
# was covered by nothing that could fail: `projection_gate_report_cleanliness` runs inside the EXIT trap, and
# its own comment explains that a non-zero return there would overwrite the gate's exit status and turn a
# failing run into a passing one. So the gate could print "1 mountpoint left behind" and still exit 0. That is
# the report-versus-assertion gap §6.5 exists to close, reappearing in the gate that closes it.
#
# THE ORDER IS THE POINT. The report is already printed and the evidence is copied out FIRST, so requiring the
# run directory to be gone cannot cost the operator the results that justify the verdict.
#
# AND IT CANNOT MASK AN EARLIER FAILURE, because it is only reached when every phase before it succeeded —
# any earlier failure has already left through `die`, where the EXIT trap does the cleanup and reports it.
# PRESERVING THE EVIDENCE IS ITSELF A PRECONDITION, NOT A COURTESY.
#
# This step is about to DELETE the run directory, which is the only place the verdict evidence exists. The
# first version of it copied both files with `|| true` and then printed "evidence kept" unconditionally — so a
# copy that failed for any reason (a full disk, a read-only gate root, a results file the verdict never wrote)
# destroyed the only record of why the run passed, announced that it had kept it, and exited 0. A gate that
# can lose its own evidence and still report success is the same class of defect as one that reports a
# measurement it never took.
#
# SO EVERY STEP OF IT IS CHECKED: the source must exist and be non-empty, the copy must succeed, and the copy
# must be byte-identical to what the run wrote. Any of those failing ends the run non-zero BEFORE anything is
# deleted.
EVIDENCE_DIR="$GATE_ROOT/evidence"
mkdir -p "$EVIDENCE_DIR" \
  || die "the evidence directory could not be created, and the run directory is about to be deleted; \
refusing to destroy the only copy of this run's verdict"

# EXTRACTED AND EXECUTED BY test/projection-real-provider.ts, so the three failure modes below are proved
# rather than read. $1 is the path under the run directory, $2 the name to keep it under.
copy_evidence() {
  test -s "$WORK/$1" \
    || die "the run wrote no $1, so there is no verdict evidence to preserve and nothing to stand behind"
  cp "$WORK/$1" "$EVIDENCE_DIR/$2" \
    || die "$1 could not be copied out of the run directory, which is about to be deleted"
  cmp -s "$WORK/$1" "$EVIDENCE_DIR/$2" \
    || die "the preserved copy of $1 does not match what the run wrote"
}

copy_evidence "out/results.json" "results-$$.jsonl"
copy_evidence "out/results-summary.json" "results-summary-$$.json"
echo "  evidence kept at $REL_GATE_ROOT/evidence/results-summary-$$.json (scrubbed before it was printed)"

projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true

OWN_MOUNTS_LEFT="$(projection_gate_mounts_under "$WORK")"
OWN_DIR_PRESENT=false
[ -d "$WORK" ] && OWN_DIR_PRESENT=true

if real_provider cleanup --mountpoints "$OWN_MOUNTS_LEFT" --run-directory-present "$OWN_DIR_PRESENT"; then
  # THE TRAP HAS NOTHING LEFT TO DO, and saying so keeps its report from contradicting this assertion.
  CLEANED=1
else
  die "the run cleaned up after itself incompletely; a gate that leaves its run directory or a mountpoint \
behind is how the NEXT run inherits a namespace and passes for the wrong reason"
fi
