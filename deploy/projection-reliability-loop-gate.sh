#!/usr/bin/env bash
# PROJECTION PHASE 3 — THE RELIABILITY LOOP. The only gate here that puts a REAL PROVIDER, THREE REAL MEDIA
# SERVERS and A DELIBERATE FAILURE in the same run.
#
# WHY IT EXISTS, IN ONE PARAGRAPH. Phase 1 proved the slice works. Phase 2 proved the daemon's own mount
# lifecycle survives three named failures — with NO media server in any of its nine runs and NO real provider
# contacted. Phase 3 is the intersection those two tranches deliberately left empty, and the intersection is
# not implied by the halves: Phase 2's worst defect was `--auto-remount` recovering the namespace FOR THE
# DAEMON AND FOR NOBODY ELSE. The daemon logged success, /readyz said ready, and no consumer could see a
# file. That is invisible to every gate with no consumer attached and invisible to every gate with no fault
# injected. It is visible only here.
#
# THE CONTRACT AND ITS THRESHOLDS WERE WRITTEN DOWN BEFORE ANY OF THIS RAN.
# `docs/PROJECTION_PHASE_3_RELIABILITY_LOOP.md` is the contract; `src/core/projection/reliability-loop.ts` is
# the same thresholds as code, and THIS SCRIPT RESTATES NONE OF THEM — it evaluates them out of that module
# once, at the top, so a budget cannot drift between the document, the module and the shell.
#
# THE TOPOLOGY IS TWO EXISTING GATES BOLTED TOGETHER AND NOTHING NEW:
#
#   * G18's arrangement — ONE PostgreSQL, ONE publisher, ONE admitted generation, ONE production projectiond,
#     ONE FUSE mount, and THREE real digest-pinned media servers holding the SAME mount as the SAME library
#     root — with G18's own drivers, observer and overlap analysis, imported rather than reimplemented;
#   * the TorBox real gate's arrangement for reaching a real provider — the resolver container joins the
#     DAEMON'S network namespace, so it is never published to a host port and the TorBox API key exists only
#     inside it. The daemon holds the independent gate secret and nothing else.
#
# THE NAMESPACE IS TWO ENTRIES AND BOTH ARE LOAD-BEARING. The operator's real object, published under a path
# THIS GATE CHOOSES so the operator's own label never reaches a media server's database; and a local
# synthetic seed, which gives three libraries something to resolve before anything remote exists (Plex begins
# scanning a section the instant it is created and nothing in its API can prevent it) and which is the
# CONTROL: a fault aimed at the remote path must not stop the local one, and a fault aimed at the mount must
# stop both.
#
# IT EXITS 77 BEFORE AN IMAGE, A DATABASE OR A PACKET when the operator has supplied nothing. That is the
# expected outcome on every machine nobody has deliberately prepared, and a skip is not a pass.
set -euo pipefail
# shellcheck source=deploy/projection-gate-cleanup.sh
. "$(cd "$(dirname "$0")" && pwd)/projection-gate-cleanup.sh"
export MSYS_NO_PATHCONV=1

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
NODE_IMAGE="node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32"

# THE THREE MEDIA SERVERS, AT THE SAME DIGESTS THEIR OWN GATES PIN. Every behavioural finding this gate
# inherits — Emby publishing no `LocationType`, Plex refusing a request whose Host header it does not know,
# Jellyfin leaving a library's item id absent until the first scan — belongs to the version behind a
# particular digest, so pinning a different one here would mean the drivers were driving something else.
JELLYFIN_IMAGE="jellyfin/jellyfin@sha256:7ae36aab93ef9b6aaff02b37f8bb23df84bb2d7a3f6054ec8fc466072a648ce2"
PLEX_IMAGE="plexinc/pms-docker@sha256:a2b03d75aa16f422488c692935cab476d966b75f2af3c93bb6d910c6051906f5"
EMBY_IMAGE="emby/embyserver@sha256:734a6f03c7c783a9e566b08d09a2b6376f41229ff29f032a7e00302e0be98f8a"
GENERATOR_IMAGE="$JELLYFIN_IMAGE"
GENERATOR_FFMPEG="/usr/lib/jellyfin-ffmpeg/ffmpeg"
GENERATOR_FFPROBE="/usr/lib/jellyfin-ffmpeg/ffprobe"

COMPOSE_FILE="docker-compose.projection-reliability.yml"
NETWORK="projection-reliability-gate"
PG_PORT="${PROJECTION_RELIABILITY_GATE_PG_PORT:-5590}"
JF_PORT="${PROJECTION_RELIABILITY_GATE_JELLYFIN_PORT:-8180}"
EMBY_PORT="${PROJECTION_RELIABILITY_GATE_EMBY_PORT:-8181}"
RESOLVER_PORT="${PROJECTION_RELIABILITY_GATE_RESOLVER_PORT:-8182}"
PLEX_PORT="${PROJECTION_RELIABILITY_GATE_PLEX_PORT:-32560}"
DAEMON_STATUS_PORT=9099

MOUNT_CONTAINER="projection-rl-mount-$$"
JF_CONTAINER="projection-rl-jellyfin-$$"
PLEX_CONTAINER="projection-rl-plex-$$"
EMBY_CONTAINER="projection-rl-emby-$$"
# THE RESOLVER IS RECREATED, NOT RESTARTED, AND ITS NAME CARRIES A SEQUENCE. It joins the daemon's network
# namespace with `--network container:<daemon>`, so every daemon restart destroys the namespace it is living
# in. A restarted daemon therefore needs a NEW resolver container bound to the new sandbox, and a fresh name
# is what stops `Conflict. The container name ... is already in use` — the defect the multi-frontend harness
# spent an arm discovering.
RESOLVER_SEQ=0
RESOLVER_CONTAINER=""
CONSUMER_PREFIX="projection-rl-consumer-$$"

GATE_ROOT="$PWD/.projection-reliability-loop-gate"
REL_GATE_ROOT=".projection-reliability-loop-gate"
REL=".projection-reliability-loop-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

GATE_SKIP_STATUS=77
CLEANED=0

# THE APPROVED PATH, AND THE ONLY PLACE THIS GATE EVER LOOKS. It is the TorBox gate's own directory, with the
# TorBox gate's own four files and the TorBox gate's own schema, because two gates that read one directory
# with two mutually exclusive schemas is a state Phase 1 already had to repair once.
INPUT_DIR="${PROJECTION_TORBOX_INPUT_DIR:-/mnt/user/appdata/catalog/secrets/real-provider/torbox}"
TORBOX_CREDENTIAL="$INPUT_DIR/torbox-credential"
GATE_SECRET="$INPUT_DIR/credential"
OBJECTS_FILE="$INPUT_DIR/objects.json"
ENDPOINT_FILE="$INPUT_DIR/endpoint.json"

# THE VERDICT LOG IS WRITTEN STRAIGHT INTO THE EVIDENCE DIRECTORY, NOT INTO THE RUN DIRECTORY, and that is a
# repair rather than a convenience. The run directory is what the cleanup contract DELETES — so a gate that
# wrote its verdicts there had to copy them out before cleaning up, and then the cleanup's OWN verdicts (this
# run's mountpoints, this run's directory, the host's sets) landed in a file nobody kept. The closure check
# would then have judged a document that stopped four ids short of what it requires. Writing here from the
# first line also means a run killed halfway leaves the verdicts it had already taken, with no copy step to
# have failed.
EVIDENCE_DIR="$GATE_ROOT/evidence"
RESULTS_REL="$REL_GATE_ROOT/evidence/cycles-$$.jsonl"
CYCLES_REL="$REL_GATE_ROOT/evidence/arms-$$.jsonl"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_RELIABILITY_GATE_PG_PORT="$PG_PORT"

step() { echo; echo "=== $* ==="; }
die()  { echo "GATE FAILED: $*" >&2; exit 1; }
logs_tail() { docker logs --tail 60 "$1" 2>&1 | tail -60 >&2 || true; }

# ----------------------------------------------------------------------------------------------------------
# CLEANUP — the failure path, which can only ever REPORT
# ----------------------------------------------------------------------------------------------------------
# A non-zero return from an EXIT trap overwrites the gate's own status and turns a failing run into a passing
# one. The SUCCESS path asserts its cleanup separately, at the end, where it can afford to fail.
cleanup() {
  # THE MEDIA SERVERS FIRST, ALL THREE. Each holds open handles on the mount and a FUSE mount with a live
  # reader does not unmount cleanly; three of them makes that three times as likely, not less.
  docker rm -f "$PLEX_CONTAINER" "$JF_CONTAINER" "$EMBY_CONTAINER" >/dev/null 2>&1 || true
  for leftover in $(docker ps -aq --filter "name=^${CONSUMER_PREFIX}" 2>/dev/null); do
    docker rm -f "$leftover" >/dev/null 2>&1 || true
  done
  for leftover in $(docker ps -aq --filter "name=^projection-rl-resolver-$$-" 2>/dev/null); do
    docker rm -f "$leftover" >/dev/null 2>&1 || true
  done
  docker rm -f "$MOUNT_CONTAINER" >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$GATE_ROOT/host-containers-before-$$.txt" "$GATE_ROOT/host-networks-before-$$.txt" \
        "$GATE_ROOT/host-volumes-before-$$.txt" "$GATE_ROOT/host-containers-after-$$.txt" \
        "$GATE_ROOT/host-networks-after-$$.txt" "$GATE_ROOT/host-volumes-after-$$.txt" 2>/dev/null || true
  if [ "$CLEANED" -eq 0 ] && [ -n "${WORK:-}" ]; then
    # THE VERDICT LOG NEEDS NO PRESERVING BECAUSE IT WAS NEVER IN THE RUN DIRECTORY. What a failing run
    # leaves behind is exactly what it had recorded when it died — gate ids, gate-chosen names, offsets,
    # byte counts and verdicts, which structurally cannot hold a secret, a reference or a provider filename.
    if [ -s "$GATE_ROOT/evidence/cycles-$$.jsonl" ]; then
      echo "  evidence from the FAILED run is at $REL_GATE_ROOT/evidence/cycles-$$.jsonl" >&2
    fi
    projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true
    projection_gate_report_cleanliness "$GATE_ROOT" "$WORK" || true
  fi
}
trap cleanup EXIT

# ----------------------------------------------------------------------------------------------------------
# THE SKIP, AND IT COMES FIRST — BEFORE AN IMAGE, A DATABASE OR A PACKET
# ----------------------------------------------------------------------------------------------------------
missing=""
[ -f "$TORBOX_CREDENTIAL" ] || missing="$missing torbox-credential"
[ -f "$GATE_SECRET" ]       || missing="$missing credential"
[ -f "$OBJECTS_FILE" ]      || missing="$missing objects.json"
[ -f "$ENDPOINT_FILE" ]     || missing="$missing endpoint.json"
if [ -n "$missing" ]; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): the operator has supplied no real-provider corpus." >&2
  echo "      Missing under the approved input directory:$missing" >&2
  echo "" >&2
  echo "      NOTHING WAS CONTACTED and nothing was built or started. Phase 3 stays open, and this run" >&2
  echo "      closes nothing. It is not a pass and must not be reported as one." >&2
  echo "      The directory this gate looks in: $INPUT_DIR" >&2
  echo "      What to place: deploy/torbox-resolver.template.json" >&2
  exit "$GATE_SKIP_STATUS"
fi
echo "  four operator inputs are present; this run WILL contact the provider"

mkdir -p "$WORK/manifest" "$WORK/media" "$WORK/cache" "$WORK/mnt" "$WORK/out" "$WORK/inputs" \
         "$WORK/inprog" "$WORK/daemon-inputs" "$WORK/consumer" \
         "$WORK/jf-config" "$WORK/jf-cache" "$WORK/plex-config" "$WORK/plex-transcode" "$WORK/emby-config"
# THE PATH INTO THE PERMISSIVE DIRECTORIES MUST BE TRAVERSABLE BY A UID THAT DID NOT CREATE IT — 0755 and not
# 0777, because traversal is all that is needed, and explicit rather than inherited from the operator's
# umask, which at a hardened 077 leaves 0700 and a container running as uid 1000 outside.
chmod 755 "$GATE_ROOT" "$WORK"
chmod 777 "$WORK/cache" "$WORK/mnt" "$WORK/out" "$WORK/consumer" \
          "$WORK/jf-config" "$WORK/jf-cache" "$WORK/plex-config" "$WORK/plex-transcode" "$WORK/emby-config"
chmod 755 "$WORK/inprog"
chmod 700 "$WORK/inputs" "$WORK/daemon-inputs"
# 0700, BECAUSE THIS IS THE ONE THING THE GATE DELIBERATELY LEAVES ON THE HOST. The gate root is 0755 so
# containers running as other uids can traverse it; without this the preserved evidence would be the only
# artifact of a real-provider run that every user on the host could read.
mkdir -p "$EVIDENCE_DIR"
chmod 700 "$EVIDENCE_DIR"
: > "$GATE_ROOT/evidence/cycles-$$.jsonl"
: > "$GATE_ROOT/evidence/arms-$$.jsonl"
chmod 600 "$GATE_ROOT/evidence/cycles-$$.jsonl" "$GATE_ROOT/evidence/arms-$$.jsonl"

# THE SECRETS ARE COPIED AT 0600 INTO A 0700 DIRECTORY, never moved and never widened.
#
# AND THE TWO CONSUMERS GET DIFFERENT COPIES, WHICH IS WHAT MAKES A5 POSSIBLE AT ALL. The resolver reads the
# gate secret it will ACCEPT; the daemon reads the one it will PRESENT. In the TorBox gate those are the same
# file and a rotation could not be staged against it without touching the operator's own directory — which
# this gate never does.
install -m 600 "$TORBOX_CREDENTIAL" "$WORK/inputs/torbox-credential"
install -m 600 "$GATE_SECRET" "$WORK/inputs/gate-secret"
install -m 600 "$GATE_SECRET" "$WORK/daemon-inputs/gate-secret"
if cmp -s "$WORK/inputs/torbox-credential" "$WORK/inputs/gate-secret"; then
  die "the provider credential and the gate secret are the same value; they must differ, or the daemon holds \
the credential that can manage the whole account"
fi

# ----------------------------------------------------------------------------------------------------------
# THE THRESHOLDS, EVALUATED OUT OF THE MODULE THAT DECIDES THEM
# ----------------------------------------------------------------------------------------------------------
# NOT ONE OF THESE NUMBERS IS SPELLED IN THIS FILE, and `test/projection-reliability-loop.ts` asserts that.
# A budget restated in a shell script is a budget that drifts from the document the moment either moves, and
# this repository has already retired two thresholds for exactly that.
step "the predeclared thresholds, read from src/core/projection/reliability-loop.ts"
RL_BUDGETS="$(npx tsx src/ops/projection-reliability-loop-cli.ts budgets --sh)" \
  || die "the reliability-loop thresholds could not be read; nothing can be measured against nothing"
eval "$RL_BUDGETS"
npx tsx src/ops/projection-reliability-loop-cli.ts budgets

# ----------------------------------------------------------------------------------------------------------
# THE EMBEDDED PROGRAMS
# ----------------------------------------------------------------------------------------------------------
# EVERY ONE OF THEM IS A FILE WITH A QUOTED HEREDOC, never a multi-line `node -e` argument. Phase 1 spent four
# dispatches on programs written into gates and checked only by regex, and every dispatch found defects a
# regex could not see; `test/custody-runtime-closure.ts` cannot even PARSE a script whose quotes do not close
# on their own line, so an unparseable line is one every "does this file contain X" test answers no for.

cat > "$WORK/out/jq.cjs" <<'JQ'
// One field out of a JSON document on stdin, for shells that have no jq.
//
// THE DECODE IS SET ON THE STREAM, NOT DONE PER CHUNK: `raw += chunk` coerces each Buffer separately, so a
// multi-byte character split across a read boundary becomes two replacement characters, silently, at exit 0.
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const document = JSON.parse(raw);
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    console.error('jq: the document on stdin is not an object, so no field of it can be read');
    process.exit(2);
  }
  const value = document[process.argv[2]];
  console.log(value === undefined ? '' : String(value));
});
JQ

cat > "$WORK/out/sha.cjs" <<'SHA'
// The digest of a whole file. A READ THAT RETURNED NOTHING IS NOT A DIGEST: an empty or vanished object
// hashes to e3b0c442...b855 and exits 0, and a stream with no 'error' listener turns an unreadable file into
// an uncaught exception rather than a statement. Both are refused by name.
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const hash = createHash('sha256');
let read = 0;
createReadStream(process.argv[2])
  .on('error', (error) => {
    console.error(`sha: could not read the object: ${error.code ?? error.message}`);
    process.exit(3);
  })
  .on('data', (chunk) => { read += chunk.length; hash.update(chunk); })
  .on('end', () => {
    if (read === 0) {
      console.error('sha: the object yielded no bytes, so there is nothing to digest');
      process.exit(3);
    }
    console.log(hash.digest('hex'));
  });
SHA

cat > "$WORK/out/record.cjs" <<'RECORD'
// ONE VERDICT, APPENDED AS ONE JSON LINE.
//
// WHY A LOCAL PROGRAM RATHER THAN THE CLI. A run records roughly two hundred and fifty verdicts, and
// `npx tsx` costs well over a second to start: the accounting would take longer than the faults. This writes
// the line; `projection-reliability-loop-cli.ts close` is what JUDGES the file, and it re-derives every
// budget from the module rather than trusting what is written here.
//
// THE COMPARISON OPERATOR IS THE CALLER'S, THE THRESHOLD IS NEVER THIS PROGRAM'S. `le`, `ge`, `eq` and
// `bool` are three lines of arithmetic; the number they are given came out of the module.
//
// A MEASUREMENT THAT IS NOT A NUMBER IS A FAILED MEASUREMENT, NOT A ZERO. `Number('')` is 0 and `Number(x)`
// of anything else is NaN, and both are exactly what a shell hands over when the command that was supposed
// to measure something produced nothing. Either one records a FAIL naming the measurement, because a step
// that did not happen must never be indistinguishable from one that measured zero.
const { appendFileSync } = require('node:fs');
const [, , out, gate, op, measuredRaw, budgetRaw, ...noteParts] = process.argv;
const note = noteParts.join(' ');
const num = (raw) => (String(raw ?? '').trim() === '' ? Number.NaN : Number(raw));
const line = (result) => {
  appendFileSync(out, `${JSON.stringify(result)}\n`);
  const shown = result.measured === undefined ? '' : ` ${result.measured}/${result.budget}`;
  console.log(`  ${result.verdict.toUpperCase()}  ${result.gate}${shown}`);
  return result.verdict === 'pass' ? 0 : 1;
};
let status;
if (op === 'bool') {
  const measured = num(measuredRaw);
  if (!Number.isFinite(measured)) {
    status = line({ gate, verdict: 'fail', note: `${note} [the observation produced no value at all]` });
  } else {
    status = line({ gate, verdict: measured === 1 ? 'pass' : 'fail', ...(note ? { note } : {}) });
  }
} else {
  const measured = num(measuredRaw);
  const budget = num(budgetRaw);
  if (!Number.isFinite(measured) || !Number.isFinite(budget)) {
    status = line({ gate, verdict: 'fail',
      note: `${note} [a measurement or its budget was not a number, so nothing was compared]` });
  } else {
    const pass = op === 'le' ? measured <= budget : op === 'ge' ? measured >= budget
      : op === 'eq' ? measured === budget : false;
    if (op !== 'le' && op !== 'ge' && op !== 'eq') {
      status = line({ gate, verdict: 'fail', measured, budget,
        note: `${note} [unknown comparison ${JSON.stringify(op)}]` });
    } else {
      status = line({ gate, verdict: pass ? 'pass' : 'fail', measured, budget, ...(note ? { note } : {}) });
    }
  }
}
process.exit(status);
RECORD

cat > "$WORK/out/cycle.cjs" <<'CYCLE'
// One cycle, appended as one JSON line. The closure check compares this SEQUENCE against the contract's arm
// order, so six cycles all running one arm cannot clear a count.
const { appendFileSync } = require('node:fs');
const [, , out, cycle, arm] = process.argv;
const n = Number(cycle);
if (!Number.isSafeInteger(n) || n < 1) { console.error('cycle: not a cycle number'); process.exit(1); }
if (!/^A[0-9]$/.test(String(arm))) { console.error('cycle: not an arm id'); process.exit(1); }
appendFileSync(out, `${JSON.stringify({ cycle: n, arm })}\n`);
CYCLE

cat > "$WORK/out/corpus.cjs" <<'CORPUS'
// THE OPERATOR'S CORPUS, SPLIT INTO THE PART THAT CARRIES REFERENCES AND THE PART THAT DOES NOT.
//
// Three documents come out of one read, and the split is the whole redaction argument:
//
//   register-batch.json  0600, holds the stable references, and is consumed only by the register CLI as ONE
//                        PATH argument. A reference never reaches argv.
//   corpus.json          holds NO reference and NO operator label — a gate-chosen name, the gate-chosen
//                        projected path, the size and the approved window digests. Everything downstream
//                        that could be printed reads this one.
//   meta.json            counts and the endpoint's boring slug.
//
// THE PROJECTED PATH IS THE GATE'S, NOT THE OPERATOR'S, and that is a redaction decision rather than a
// naming one: a media server writes the path it scanned into its database, its logs and its API responses,
// so a path built from the operator's label would put that label in three places this gate then has to
// search for it in. The extension is `.mkv` because that is what makes all three scanners treat the entry as
// a movie file; every one of them determines the codec facts by probing bytes, not by reading the name.
const { readFileSync, writeFileSync, chmodSync } = require('node:fs');
const { dirname, join } = require('node:path');
const [, , out, objectsPath, endpointPath] = process.argv;
const die = (message) => { console.error(`corpus: ${message}`); process.exit(1); };
const objects = JSON.parse(readFileSync(objectsPath, 'utf8'));
const endpoint = JSON.parse(readFileSync(endpointPath, 'utf8'));
if (!Array.isArray(objects) || objects.length === 0) die('the operator corpus is not a non-empty array');

const batch = { versions: [], entries: [] };
const corpus = [];
objects.forEach((object, index) => {
  const n = String(index + 1).padStart(2, '0');
  const name = `Projection Real Object ${n} (2026)`;
  const path = `Movies/${name}/${name}.mkv`;
  const size = Number(object.sizeBytes);
  if (!Number.isSafeInteger(size) || size <= 0) die(`object ${n} has no usable sizeBytes`);
  const windows = Array.isArray(object.probeDigests) ? object.probeDigests : [];
  for (const probe of windows) {
    if (!Number.isSafeInteger(Number(probe.offset)) || Number(probe.offset) < 0
      || !Number.isSafeInteger(Number(probe.length)) || Number(probe.length) <= 0
      || !/^[0-9a-f]{64}$/.test(String(probe.sha256))) {
      die(`object ${n} has an approved window that is not an offset, a length and a sha256`);
    }
    if (Number(probe.offset) + Number(probe.length) > size) {
      die(`object ${n} has an approved window that ends past the object`);
    }
  }
  const key = `tbr-version-${index + 1}`;
  batch.versions.push({ key, size, mtime: '2026-01-01T00:00:00.000Z' });
  batch.entries.push({
    item: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    versionKey: key,
    path,
    // A SOURCE IS kind:rootId:objectRef, and the register CLI splits on the FIRST TWO colons only, so the
    // provider reference keeps its own colons intact as the objectRef.
    sources: [`http-range:${endpoint.id}:${object.ref}`],
  });
  corpus.push({ name, path, file: `${name}.mkv`, sizeBytes: size,
    probeDigests: windows.map((probe) => ({
      offset: Number(probe.offset), length: Number(probe.length), sha256: String(probe.sha256) })) });
});

const file = join(dirname(out), 'register-batch.json');
writeFileSync(file, `${JSON.stringify(batch, null, 2)}\n`);
chmodSync(file, 0o600);
writeFileSync(join(dirname(out), 'corpus.json'), `${JSON.stringify(corpus, null, 2)}\n`);
const windows = corpus.reduce((total, object) => total + object.probeDigests.length, 0);
writeFileSync(out, `${JSON.stringify({ objects: corpus.length, rootId: endpoint.id, windows }, null, 2)}\n`);
console.log(`  ${corpus.length} operator object(s), ${windows} approved window(s), no reference in argv`);
CORPUS

cat > "$WORK/out/config.cjs" <<'CONFIG'
// The daemon config, built from the EFFECTIVE endpoint the preflight already validated — one construction
// with two consumers, rather than two derivations of one thing.
//
// THE DAEMON IS GIVEN THE GATE SECRET AND NOTHING ELSE. `tokenFile` names its own copy, in its own 0700
// directory; the provider API key is never mounted into this container and is not merely unreferenced in it.
//
// THE STATUS SURFACE IS ON, AND IT IS LOOPBACK ONLY. Phase 3 reads `/readyz` for readiness, for the serve
// death A3 causes and for the probe-cache level, and the daemon binds it to 127.0.0.1 — reachable only from
// a container sharing this one's network namespace.
const { readFileSync, writeFileSync } = require('node:fs');
const [, , effectivePath, out, statusPort, pollMs] = process.argv;
const endpoint = JSON.parse(readFileSync(effectivePath, 'utf8'));
for (const [field, expected] of [['allowInsecureHttp', false], ['allowPrivateAddresses', false],
  ['loopbackResolver', true]]) {
  if (endpoint[field] !== expected) {
    console.error(`config: the effective endpoint has ${field} = ${String(endpoint[field])}, which a real `
      + 'run never sets');
    process.exit(1);
  }
}
if (!String(endpoint.resolverUrl).startsWith('http://127.0.0.1:')) {
  console.error('config: the effective endpoint resolver is not a literal loopback address');
  process.exit(1);
}
if (!Number.isSafeInteger(Number(pollMs)) || Number(pollMs) <= 0) {
  console.error('config: the poll interval the ready budget is derived from is not a whole number of ms');
  process.exit(1);
}
writeFileSync(out, `${JSON.stringify({
  mountPoint: '/mnt/projection',
  pointerPath: '/var/lib/projectiond/manifest/pointer.json',
  probeCacheDir: '/var/lib/projectiond/cache',
  localRoots: { media: '/var/lib/projectiond/media' },
  statusAddr: `127.0.0.1:${statusPort}`,
  globalMaxInflight: 8,
  perEndpointMaxInflight: 4,
  endpoints: [{
    id: endpoint.id,
    resolverUrl: endpoint.resolverUrl,
    allowedOrigins: endpoint.allowedOrigins,
    tokenFile: '/var/lib/projectiond/inputs/gate-secret',
    allowInsecureHttp: false,
    allowPrivateAddresses: false,
    loopbackResolver: true,
    maxConnections: 4,
    resolutionDeadlineMs: 15000,
  }],
}, null, 2)}\n`);
CONFIG

cat > "$WORK/out/verify.cjs" <<'VERIFY'
// READS THE OPERATOR'S APPROVED WINDOWS THROUGH THE MOUNT and compares them against digests recorded
// OUTSIDE it, before any run existed. It is `deploy/projection-torbox-real-gate.sh`'s program, with two
// changes: the path comes from the gate-chosen corpus rather than from the operator's label, and the
// summary it writes is machine-readable so the loop can record a verdict per cycle from it.
const { openSync, readSync, closeSync, readFileSync, writeFileSync, lstatSync } = require('node:fs');
const { createHash } = require('node:crypto');
const [, , corpusPath, mountDir, out] = process.argv;
const objects = JSON.parse(readFileSync(corpusPath, 'utf8'));

// EVERY READ IS BOUNDED, BECAUSE A GATE THAT HANGS NEVER REPORTS. This is the only place in this gate where
// a real provider sits behind a system call. A `readSync` already blocked in the kernel cannot be
// interrupted from here, so the gate ALSO runs this program under `timeout`; this check is what turns a
// slow-but-finite read into a named failure rather than a number nobody looks at.
//
// THE SEAM CAN ONLY TIGHTEN. The offline suite has to make the deadline bite against a local file, and it
// cannot make one take two minutes. So the environment may LOWER the ceiling and can do nothing else:
// absent, blank, unparseable, or at or above the built-in all yield the built-in.
const DEADLINE_CEILING_MS = 120000;
const requestedRaw = process.env.PROJECTION_GATE_READ_DEADLINE_MS;
const requestedDeadline = requestedRaw === undefined || requestedRaw.trim() === ''
  ? Number.NaN : Number(requestedRaw);
const READ_DEADLINE_MS = Number.isFinite(requestedDeadline) && requestedDeadline < DEADLINE_CEILING_MS
  ? requestedDeadline : DEADLINE_CEILING_MS;

const READ_CHUNK = 1024 * 1024;

// A READ THAT FAILS IS A RESULT, NOT A CRASH. Against a real provider whose CDN origin had rotated out of
// the operator's allowlist, the daemon correctly refused the resolved URL and the mount answered EIO — and
// the ancestor of this program let that escape as an uncaught exception, so the one case the evidence exists
// FOR produced no evidence at all. An I/O error is recorded with its errno and the remaining windows are
// still attempted.
function windowAt(path, offset, length) {
  const started = Date.now();
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    return { bytesRead: 0, sha256: '', elapsedMs: Date.now() - started,
      error: error && error.code ? error.code : 'OPEN_FAILED' };
  }
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(length, READ_CHUNK));
    let filled = 0;
    while (filled < length) {
      const want = Math.min(buffer.length, length - filled);
      const got = readSync(fd, buffer, 0, want, offset + filled);
      if (got === 0) break;
      hash.update(buffer.subarray(0, got));
      filled += got;
    }
    return { bytesRead: filled, sha256: hash.digest('hex'), elapsedMs: Date.now() - started };
  } catch (error) {
    return { bytesRead: 0, sha256: '', elapsedMs: Date.now() - started,
      error: error && error.code ? error.code : 'READ_FAILED' };
  } finally { closeSync(fd); }
}

const results = [];
let problems = 0;
let windowsMatched = 0;
let statOk = 0;
let slowest = 0;
for (const object of objects) {
  const path = `${mountDir}/${object.path}`;
  // LOOKUP AND STAT BEFORE ANY READ — the half of "an ordinary regular file" that reading cannot prove.
  // `lstat`, not `stat`: `stat` follows a symlink and would answer for the target rather than for what is
  // in the namespace.
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    problems += 1;
    results.push({ name: object.name, kind: 'stat', match: false, error: error.code });
    continue;
  }
  const regular = info.isFile();
  const sizeAgrees = info.size === object.sizeBytes;
  if (regular && sizeAgrees) statOk += 1; else problems += 1;
  results.push({ name: object.name, kind: 'stat', match: regular && sizeAgrees,
    regularFile: regular, size: info.size, expectedSize: object.sizeBytes });
  // A SIZE THAT DISAGREES MAKES EVERY WINDOW BELOW MEANINGLESS: the offsets are the manifest's.
  if (!regular || !sizeAgrees) continue;

  for (const probe of object.probeDigests) {
    const got = windowAt(path, probe.offset, probe.length);
    const ok = got.bytesRead === probe.length && got.sha256 === probe.sha256;
    if (ok) windowsMatched += 1; else problems += 1;
    if (got.elapsedMs > slowest) slowest = got.elapsedMs;
    results.push({ name: object.name, kind: 'probe', bytes: got.bytesRead, match: ok,
      elapsedMs: got.elapsedMs, ...(got.error ? { error: got.error } : {}) });
  }
}
// AND EVERY READ FINISHED INSIDE THE DEADLINE, asserted once so the failure names the window rather than
// leaving a large number in a file for a reader to notice.
for (const entry of results.filter((r) => typeof r.elapsedMs === 'number' && r.elapsedMs > READ_DEADLINE_MS)) {
  problems += 1;
  results.push({ name: entry.name, kind: 'deadline', match: false, of: entry.kind,
    elapsedMs: entry.elapsedMs, budgetMs: READ_DEADLINE_MS });
}
writeFileSync(out, `${JSON.stringify({ results, problems, windowsMatched, statOk,
  objects: objects.length, slowestMs: slowest }, null, 2)}\n`);
console.log(`  ${results.length} read(s), ${windowsMatched} window(s) matched, ${problems} problem(s), `
  + `slowest ${slowest} ms`);
process.exit(problems === 0 ? 0 : 1);
VERIFY

cat > "$WORK/out/summary.cjs" <<'SUMMARY'
// One field out of the verify summary, as a bare number, so the shell can hand it to `record.cjs`.
// A MISSING FIELD PRINTS NOTHING RATHER THAN ZERO, and `record.cjs` fails a measurement that is not a
// number — so a summary this program could not read becomes a failed verdict rather than a passing zero.
const { readFileSync } = require('node:fs');
const [, , path, field] = process.argv;
try {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  const value = document[field];
  if (typeof value === 'number' && Number.isFinite(value)) console.log(String(value));
} catch { /* nothing printed: the caller's measurement is absent, which is a failure and not a zero */ }
SUMMARY

cat > "$WORK/out/playfigures.cjs" <<'PLAYFIGURES'
// The startup time and the decoded media seconds out of a media-server driver's OWN results file.
//
// WHY IT READS THE DRIVER'S FILE RATHER THAN TIMING THE PLAY ITSELF. The drivers already measure both, from
// the decoder's own progress trace, and they already fail on their own G8 thresholds. Timing the wrapper
// would measure a `docker run` and call it a startup; re-deriving decoded media time from outside the
// decoder is not possible at all. So the loop records the driver's numbers under its OWN gate ids, against
// the budgets Phase 3 predeclared, and a driver that failed its own threshold has already exited non-zero.
//
// A FIGURE THAT IS NOT THERE PRINTS NOTHING. Same rule as `summary.cjs`: absence is a failed measurement.
const { readFileSync } = require('node:fs');
const [, , path, want] = process.argv;
let results;
try {
  results = JSON.parse(readFileSync(path, 'utf8'));
} catch { process.exit(0); }
if (!Array.isArray(results)) process.exit(0);
// The three drivers spell their gate ids differently on purpose — JD18, PX18, EM18 — and none of them is
// going to be renamed for this. The SUFFIX is what they share, so that is what is matched.
const patterns = {
  startupSeconds: /(paced-play-)?startup-seconds/,
  decodedSeconds: /(paced-play-)?decoded-media-seconds/,
};
const pattern = patterns[want];
if (pattern === undefined) process.exit(0);
const hit = results.find((entry) => entry && typeof entry.gate === 'string' && pattern.test(entry.gate)
  && typeof entry.measured === 'number' && Number.isFinite(entry.measured));
if (hit === undefined) process.exit(0);
// Startup is reported in seconds and Phase 3's budget is in milliseconds, so the conversion happens here
// rather than in a shell arithmetic expansion that would truncate a fractional second to zero.
console.log(String(want === 'startupSeconds' ? Math.round(hit.measured * 1000) : Math.floor(hit.measured)));
PLAYFIGURES

cat > "$WORK/out/oneread.cjs" <<'ONEREAD'
// ONE READ OF THE FIRST APPROVED WINDOW, TIMED, WITH ONE OF EXACTLY THREE VERDICTS.
//
// The loop uses it wherever it needs to know "did a read reach the provider and come back right, and how
// long did that take" — the trip and the hold of the outage arm, and both halves of the rotation arm. It
// prints ONE line, and the caller refuses anything that is not one of the three tokens: a read that neither
// succeeded, mismatched nor failed is a measurement that did not happen, and the two are not the same thing.
//
// THE ERRNO IS THE DIAGNOSIS AND IT IS PRINTED. A real run failed once because a CDN origin had rotated out
// of the operator's allowlist: the daemon correctly refused the resolved URL and the mount answered EIO, and
// the program that read it died with an uncaught exception instead of recording which window failed and why.
const { openSync, readSync, closeSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const [, , corpusPath, mountDir] = process.argv;
const object = JSON.parse(readFileSync(corpusPath, 'utf8'))[0];
const probe = object.probeDigests[0];
const started = Date.now();
let fd;
try {
  fd = openSync(`${mountDir}/${object.path}`, 'r');
} catch (error) {
  console.log(`read:eio ${error.code ?? 'OPEN_FAILED'} elapsedMs=${Date.now() - started}`);
  process.exit(0);
}
try {
  const buffer = Buffer.allocUnsafe(probe.length);
  let filled = 0;
  while (filled < probe.length) {
    const got = readSync(fd, buffer, filled, probe.length - filled, probe.offset + filled);
    if (got === 0) break;
    filled += got;
  }
  const digest = createHash('sha256').update(buffer.subarray(0, filled)).digest('hex');
  const elapsed = Date.now() - started;
  if (filled === probe.length && digest === probe.sha256) console.log(`read:ok elapsedMs=${elapsed}`);
  else console.log(`read:mismatch bytes=${filled} elapsedMs=${elapsed}`);
} catch (error) {
  console.log(`read:eio ${error.code ?? 'READ_FAILED'} elapsedMs=${Date.now() - started}`);
} finally { closeSync(fd); }
ONEREAD

cat > "$WORK/out/corpusfield.cjs" <<'CORPUSFIELD'
// One field of the first corpus object, or the whole window list, as plain text a shell can capture.
//
// IT IS A FILE RATHER THAN A `node -e` ARGUMENT, and that is not style. `test/custody-runtime-closure.ts`
// parses every shipped script under all three line endings and STOPS at an unterminated quote, so a
// multi-line `-e` argument makes the whole file unreadable and every "does this script contain X" test in
// this repository silently skips it. Phase 2's harness shipped exactly that defect and it is recorded as the
// one that was not a defect in the harness but in what could be checked about it.
const { readFileSync } = require('node:fs');
const [, , corpusPath, want] = process.argv;
const object = JSON.parse(readFileSync(corpusPath, 'utf8'))[0];
if (object === undefined) { console.error('corpusfield: the corpus is empty'); process.exit(1); }
if (want === 'windows') {
  for (const probe of object.probeDigests) {
    console.log(`${probe.offset} ${probe.length} ${probe.sha256}`);
  }
} else if (want === 'path' || want === 'file') {
  console.log(String(object[want]));
} else {
  console.error(`corpusfield: ${JSON.stringify(want)} is not a field this program will answer for`);
  process.exit(1);
}
CORPUSFIELD

cat > "$WORK/out/mintsecret.cjs" <<'MINTSECRET'
// A fresh high-entropy gate secret, written at 0600 and printed nowhere.
//
// 32 BYTES BECAUSE THE ONE THING IT MUST NOT BE IS GUESSABLE, and it never leaves this file: the rotation
// arm writes it, the resolver reads it, and the leak search looks for it. `writeFileSync` with a mode is not
// enough on its own if the file already exists — the mode of an existing file is not changed by it — so the
// caller chmods afterwards and this program does too.
const { writeFileSync, chmodSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const [, , out] = process.argv;
writeFileSync(out, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
chmodSync(out, 0o600);
MINTSECRET

cat > "$WORK/out/needles.cjs" <<'NEEDLES'
// THE LEAK-SEARCH NEEDLE LIST: every stable reference, every operator label, and both secrets.
//
// THE LIST ARRIVES AT THE SEARCH AS A FILE PATH AND NEVER IN ARGV. A needle passed to `docker run` lives in
// the host's process table and in `docker inspect .Config.Cmd` for the life of the container, which is
// measurably not "nowhere" — and the needles here include the two secrets themselves.
//
// A SHORT NEEDLE IS REFUSED RATHER THAN SEARCHED FOR. A few bytes occur by chance in any megabyte of binary,
// so a short needle turns a search for a secret into a search for noise and every hit into a false one.
//
// AND THE FILE ENDS IN A NEWLINE, because `wc -l` counts terminators and `read` drops an unterminated final
// record: a list whose last needle every reader silently drops would agree with itself at zero hits.
const { writeFileSync } = require('node:fs');
const { readFileSync } = require('node:fs');
const [, , objectsPath, credentialPath, secretPath, out] = process.argv;
const objects = JSON.parse(readFileSync(objectsPath, 'utf8'));
const needles = [];
for (const object of objects) {
  needles.push(String(object.ref));
  needles.push(String(object.label));
}
needles.push(readFileSync(credentialPath, 'utf8').trim());
needles.push(readFileSync(secretPath, 'utf8').trim());
const short = needles.filter((needle) => needle.length < 8);
if (short.length > 0) {
  console.error(`needles: ${short.length} needle(s) are under 8 bytes, so a search for them could not be `
    + 'decisive; the value itself is deliberately not printed');
  process.exit(1);
}
writeFileSync(out, `${needles.join('\n')}\n`, { mode: 0o644 });
console.log(`  ${needles.length} needle(s): every reference, every label and both secrets`);
NEEDLES

cat > "$WORK/out/churn.cjs" <<'CHURN'
// Items added and removed between two catalogues of the same library, as one number.
//
// IT REFUSES AN EMPTY CATALOGUE RATHER THAN SCORING IT AS NO CHURN. Two empty catalogues differ by nothing,
// so a server that catalogued the library and a server that answered with an empty list would both report
// zero churn — the shape this repository keeps finding, where the measurement not happening is
// indistinguishable from the measurement passing.
const { readFileSync } = require('node:fs');
const [, , beforePath, afterPath] = process.argv;
const load = (path) => {
  const entries = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(entries) || entries.length === 0) {
    console.error(`churn: ${path} lists no entries, so a churn of zero would mean nothing was compared`);
    process.exit(1);
  }
  return new Set(entries.map((entry) => String(entry.key)));
};
const before = load(beforePath);
const after = load(afterPath);
let added = 0;
let removed = 0;
for (const key of after) if (!before.has(key)) added += 1;
for (const key of before) if (!after.has(key)) removed += 1;
console.log(String(added + removed));
CHURN

cat > "$WORK/out/expect.cjs" <<'EXPECT'
// THE ONE EXPECTATION DOCUMENT ALL THREE SERVERS ARE HELD AGAINST — the seed and the real entry.
//
// THE `sha256` FIELD ON THE REAL ENTRY IS AN IDENTITY DIGEST AND NOT THE OBJECT'S CONTENT DIGEST, and saying
// so plainly is the only honest way to put a value there at all. `corpusSelfProblems` requires two entries
// not to share a digest — so that a read returning the wrong entry cannot still match — and the operator
// records WINDOWS rather than a whole-object hash for an object of this size. So this is the digest of the
// object's approved-window digests and its size: distinct per object, stable across runs, and compared
// against NOTHING. The real entry's BYTES are compared against the operator's four windows in phase B, by
// `verify.cjs`, which is a stronger check than a whole-file hash of a 1.7 GB object would have been cheap.
//
// AND THE REAL ENTRY IS DELIBERATELY NOT AN `anchor`. An anchor is an entry whose bytes THAT gate reads back
// and digest-compares; this gate's anchor check would be comparing against the identity digest above, which
// would be exactly the "assertion that cannot fail for its stated reason" this tranche exists to avoid.
const { readFileSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const [, , out, corpusPath, seedKey, seedSize, seedSha] = process.argv;
const die = (message) => { console.error(`expect: ${message}`); process.exit(1); };
const size = Number(seedSize);
if (!Number.isSafeInteger(size) || size <= 0) die('the seed was given a size that is not a positive integer');
if (!/^[0-9a-f]{64}$/.test(String(seedSha))) die('the seed was given a digest that is not a sha256');
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const entries = [{ key: seedKey, sizeBytes: size, sha256: seedSha, kind: 'local', anchor: true }];
for (const object of corpus) {
  if (object.probeDigests.length === 0) {
    die(`${object.name} has no approved window, so nothing published from it could have its bytes verified`);
  }
  const identity = createHash('sha256')
    .update(`projection.phase3.identity|${object.sizeBytes}|`
      + object.probeDigests.map((probe) => `${probe.offset}:${probe.length}:${probe.sha256}`).join(','))
    .digest('hex');
  entries.push({ key: object.file, sizeBytes: object.sizeBytes, sha256: identity, kind: 'http-range' });
}
writeFileSync(out, `${JSON.stringify(entries, null, 2)}\n`);
console.log(String(entries.length));
EXPECT

cat > "$WORK/out/seed-expect.cjs" <<'SEEDEXPECT'
// The seed-only expectation, for the one scan that has to happen before the real object exists: Plex begins
// scanning a section the instant it is created and nothing in its API asks it not to, so the gate needs a
// deterministic point at which that unavoidable creation scan is OVER.
const { writeFileSync } = require('node:fs');
const [, , out, key, size, sha] = process.argv;
const die = (message) => { console.error(`seed-expect: ${message}`); process.exit(1); };
const sizeBytes = Number(size);
if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) die('the seed size is not a positive whole number');
if (!/^[0-9a-f]{64}$/.test(String(sha))) die('the seed digest is not a sha256');
writeFileSync(out, `${JSON.stringify([{ key, sizeBytes, sha256: sha, kind: 'local', anchor: true }],
  null, 2)}\n`);
SEEDEXPECT

cat > "$WORK/out/probe-resolver.cjs" <<'PROBERESOLVER'
// Is the resolver listening, and does it refuse an unauthenticated request? A 401 is the healthy answer.
// AND IT IS BOUNDED, BECAUSE `http.request` IS NOT: Node applies no default timeout, so a resolver that
// accepted the connection and never answered would leave this waiting for ever, and a gate that hangs is
// worse than one that fails because nothing reports a hang.
const http = require('node:http');
const port = Number(process.argv[2]);
const req = http.request({ host: '127.0.0.1', port, path: '/resolve', method: 'POST', timeout: 4000 },
  (res) => { res.resume(); process.exit(res.statusCode === 401 ? 0 : 1); });
req.on('timeout', () => { req.destroy(); process.exit(2); });
req.on('error', () => process.exit(3));
req.end('{"objectRef":"probe"}');
PROBERESOLVER

cat > "$WORK/out/probe-reachable.cjs" <<'PROBEREACHABLE'
// Can anything on the gate network open a TCP connection to the resolver's port? This is a TRANSPORT
// measurement, not an HTTP one, because an HTTP client's exit code cannot tell a refused connection from a
// 404 — and the resolver answers 404 to a GET, so a reachable resolver would have looked unreachable.
//
//   exit 0  a connection was ESTABLISHED  -> the resolver is reachable, which is the FAILURE
//   exit 1  refused, reset or timed out   -> loopback only, which is the property
//   exit 2  the host could not be resolved at all, so nothing was measured
const net = require('node:net');
const [, , host, portRaw] = process.argv;
const socket = net.connect({ host, port: Number(portRaw) });
socket.setTimeout(4000);
socket.on('connect', () => { socket.destroy(); process.exit(0); });
socket.on('timeout', () => { socket.destroy(); process.exit(1); });
socket.on('error', (error) => process.exit(error && error.code === 'ENOTFOUND' ? 2 : 1));
PROBEREACHABLE

cat > "$WORK/out/leakcheck.sh" <<'LEAK'
# THE SEARCH BEHIND "NO SECRET, REFERENCE OR LABEL REACHED ANYTHING THIS RUN WROTE".
#
# It is the shared shape three gates already use, and every one of its refusals exists because the obvious
# version could not fail: a grep whose errors and whose clean misses both produce no output and exit 0; a
# needle that arrived in argv and therefore lived in the host process table for the life of the container; a
# needle list with no trailing newline, whose last needle every reader drops, agreeing with itself at zero.
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

if ! find "$root" -type f > "$work/files" 2> "$work/walk"; then
  refuse "the scan root could not be walked"
fi
test ! -s "$work/walk" || refuse "the scan root could not be walked completely"
examined="$(wc -l < "$work/files" | tr -d ' ')"
test "$examined" -ge "$minimum" \
  || refuse "$examined file(s) under the scan root against a required $minimum; a clean result proves nothing"

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

cat > "$WORK/out/baseline.sh" <<'BASE'
# What an ordinary non-root container sees, before any media server is involved.
set -eu
test "$(id -u)" != "0" || { echo "the verifier is root" >&2; exit 1; }
# A BASELINE OVER NOTHING IS NOT A BASELINE: an empty argument list runs the body zero times and falls off
# the end at exit 0, reporting every property as holding for a set it never looked at.
test "$#" -gt 0 || { echo "no targets were named, so this baseline established nothing" >&2; exit 1; }
for target in "$@"; do
  test -f "/mnt/$target"  || { echo "not a regular file: $target" >&2; exit 1; }
  test ! -L "/mnt/$target" || { echo "a media server would see a symlink" >&2; exit 1; }
  case "$target" in *.strm) echo "a .strm placeholder is not a projected file" >&2; exit 1;; esac
  test "$(stat -c %a "/mnt/$target")" = "444" || { echo "not read-only: $target" >&2; exit 1; }
  stat -c "    size=%s mode=%a inode=%i" "/mnt/$target"
done
BASE

# THE PROGRAM EACH MEDIA SERVER RUNS INSIDE ITS OWN CONTAINER, AS ITS OWN UID.
#
# THIS IS THE ATTRIBUTION G18 SAYS IT CANNOT MAKE, AND THE DIFFERENCE IS WHAT IS BEING ATTRIBUTED. G18's
# point is that one daemon serves three servers, so the ENDPOINT sees the daemon and never the server behind
# a byte — true, and unchanged here. What this attributes is not a provider byte but a READ: this server's
# container, this server's uid, this server's view of the namespace, and the bytes it got back compared
# against digests recorded outside the mount. A remount that recovered "for the daemon and for nobody else"
# fails here and passes everything else.
#
# `tail -c +N | head -c L` RATHER THAN `dd iflag=skip_bytes`, because the three server images are three
# different distributions and byte-granular `skip` is a GNU extension. The offsets are not multiples of any
# block size, so a block-granular skip would read the wrong window and digest it perfectly.
cat > "$WORK/inprog/inread.sh" <<'INREAD'
set -eu
file="$1"
windows="$2"
test -f "$file" || { echo "inread:absent" ; exit 1; }
test -s "$windows" || { echo "inread:no-windows"; exit 1; }
# A WINDOW LIST WITH NO TRAILING NEWLINE DROPS ITS LAST RECORD IN EVERY READER, which would silently reduce
# a four-window check to three and still print inread:ok.
test -z "$(tail -c 1 "$windows")" || { echo "inread:unterminated-window-list"; exit 1; }
total=0
matched=0
while IFS=' ' read -r offset length want; do
  test -n "$offset" || { echo "inread:blank-window"; exit 1; }
  total=$(( total + 1 ))
  got="$(tail -c "+$(( offset + 1 ))" "$file" | head -c "$length" | sha256sum | cut -d' ' -f1)"
  if [ "$got" = "$want" ]; then matched=$(( matched + 1 )); fi
done < "$windows"
# A RUN THAT READ NO WINDOW AT ALL IS NOT A CLEAN RUN. Without this an empty-but-terminated list would
# report inread:ok having compared nothing, which is the same defect as a leak scan over an empty root.
test "$total" -gt 0 || { echo "inread:no-windows"; exit 1; }
if [ "$matched" -eq "$total" ]; then
  echo "inread:ok $matched/$total"
else
  echo "inread:mismatch $matched/$total"
  exit 1
fi
INREAD
chmod 755 "$WORK/inprog/inread.sh"

# ----------------------------------------------------------------------------------------------------------
step "PREFLIGHT — every input check that needs no Docker, BEFORE any image, database or packet"
# ----------------------------------------------------------------------------------------------------------
EFFECTIVE_ENDPOINT="$WORK/out/effective-endpoint.json"
npx tsx src/ops/torbox-resolver-cli.ts preflight \
  --credential "$WORK/inputs/torbox-credential" --gate-secret "$WORK/inputs/gate-secret" \
  || die "the operator's two secret files are not usable"
npx tsx src/ops/torbox-resolver-cli.ts effective-endpoint \
  --endpoint "$ENDPOINT_FILE" --resolver-port "${RESOLVER_PORT}" --out "$REL/out/effective-endpoint.json" \
  || die "the operator's endpoint description is not usable"

node "$REL/out/corpus.cjs" "$REL/out/meta.json" "$OBJECTS_FILE" "$EFFECTIVE_ENDPOINT" \
  || die "the operator corpus could not be described"
OBJECT_COUNT="$(node "$REL/out/jq.cjs" objects < "$WORK/out/meta.json")"
ROOT_ID="$(node "$REL/out/jq.cjs" rootId < "$WORK/out/meta.json")"
WINDOW_COUNT="$(node "$REL/out/jq.cjs" windows < "$WORK/out/meta.json")"
test "${OBJECT_COUNT:-0}" -ge 1 || die "the operator corpus describes no object"
test "${WINDOW_COUNT:-0}" -ge "$RL_OPERATOR_WINDOWS_REQUIRED" \
  || die "the operator corpus carries $WINDOW_COUNT approved window(s), under the \
$RL_OPERATOR_WINDOWS_REQUIRED this contract needs to hold a byte-correctness claim"

node "$REL/out/config.cjs" "$REL/out/effective-endpoint.json" "$REL/config.json" \
  "$DAEMON_STATUS_PORT" "$RL_POLL_INTERVAL_MS" \
  || die "the daemon configuration could not be built"
# THE DAEMON'S POLL FLAG IS BUILT FROM THE SAME NUMBER `READY_BUDGET_MS` IS DERIVED FROM, so the interval the
# gate configures and the interval the budget assumes cannot drift apart.
DAEMON_POLL="$(( RL_POLL_INTERVAL_MS / 1000 ))s"
test "$(( RL_POLL_INTERVAL_MS % 1000 ))" -eq 0 \
  || die "the poll interval is not a whole number of seconds, which is the only unit the daemon flag takes"

# THE PROJECTED PATHS AND THE WINDOW LIST THE IN-CONTAINER READ USES. Neither carries a reference or a label.
REAL_PATH="$(node "$REL/out/corpusfield.cjs" "$REL/out/corpus.json" path)"
REAL_FILE="$(node "$REL/out/corpusfield.cjs" "$REL/out/corpus.json" file)"
test -n "$REAL_PATH" || die "the corpus describes no projected path"
node "$REL/out/corpusfield.cjs" "$REL/out/corpus.json" windows > "$WORK/inprog/windows.txt"
chmod 644 "$WORK/inprog/windows.txt"
test -s "$WORK/inprog/windows.txt" || die "the in-container window list is empty"
echo "  every input check passed, and NOTHING has been built, started or contacted"

# ----------------------------------------------------------------------------------------------------------
step "host and Compose checks — the first steps that need Docker at all"
# ----------------------------------------------------------------------------------------------------------
# THE /dev/fuse PROBE IS BEHIND THE FILE CHECKS. It is a `docker run`, and a fully populated but malformed
# corpus should fail closed having started no container at all.
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no /dev/fuse is reachable from a container on this host." >&2
  echo "      THE RELIABILITY LOOP is entirely UNPROVEN here. Nothing in this gate ran." >&2
  echo "      It is not a pass and must not be reported as one." >&2
  exit "$GATE_SKIP_STATUS"
fi
docker compose -f "$COMPOSE_FILE" config -q || die "the gate's Compose file is not valid"
npx tsx src/ops/projection-host-preflight-cli.ts propagation --path "$GATE_ROOT" --require
npx tsx src/ops/projection-host-preflight-cli.ts traversal --path "$GATE_ROOT" --path "$WORK"

# ----------------------------------------------------------------------------------------------------------
step "the host as it was found — the SETS, not the counts"
# ----------------------------------------------------------------------------------------------------------
# COUNTS ARE WHAT PHASE 2 COMPARED AND SETS ARE STRICTLY STRONGER. A run that removed somebody else's
# container and left one of its own behind has identical counts and has done real damage. What is compared
# here is the sorted set of names, minus this run's own, so "the host baseline was untouched" is a statement
# about the same objects rather than about how many there were.
host_containers() { docker ps -a --format '{{.Names}}' | grep -v -e "-$$\$" -e "-$$-" | LC_ALL=C sort; }
host_networks()   { docker network ls --format '{{.Name}}' | LC_ALL=C sort; }
host_volumes()    { docker volume ls --format '{{.Name}}' | LC_ALL=C sort; }
# THEY ARE CAPTURED OUTSIDE THE RUN DIRECTORY, because the cleanup contract deletes that directory before
# the comparison happens — and a comparison whose left-hand side the gate itself removed is not one.
host_containers > "$GATE_ROOT/host-containers-before-$$.txt"
host_networks   > "$GATE_ROOT/host-networks-before-$$.txt"
host_volumes    > "$GATE_ROOT/host-volumes-before-$$.txt"
echo "  $(wc -l < "$GATE_ROOT/host-containers-before-$$.txt" | tr -d ' ') container(s), \
$(wc -l < "$GATE_ROOT/host-networks-before-$$.txt" | tr -d ' ') network(s), \
$(wc -l < "$GATE_ROOT/host-volumes-before-$$.txt" | tr -d ' ') volume(s) that are not this run's"

# ----------------------------------------------------------------------------------------------------------
step "building the production projectiond image, and migrating a throwaway PostgreSQL"
# ----------------------------------------------------------------------------------------------------------
docker build -t "$IMAGE" ./projectiond
docker compose -f "$COMPOSE_FILE" up -d --wait postgres
npx tsx src/ops/migrate-cli.ts
docker network create "$NETWORK" >/dev/null 2>&1 || true

# ----------------------------------------------------------------------------------------------------------
step "generating the local seed entry — the control, and the thing three libraries can point at"
# ----------------------------------------------------------------------------------------------------------
# NOTHING IS DOWNLOADED AND NOTHING IS COMMITTED. `testsrc` is ffmpeg's own generated pattern and `sine` a
# generated tone; both are produced here and thrown away with the run directory.
SEED_FILE="Projection Seed (2026).mp4"
SEED_PATH="Movies/Projection Seed (2026)/$SEED_FILE"
docker run --rm --entrypoint "$GENERATOR_FFMPEG" -v "$WORK:/work" "$GENERATOR_IMAGE" \
  -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc=size=128x96:rate=15:duration=3" \
  -f lavfi -i "sine=frequency=311:duration=3" \
  -c:v mpeg4 -qscale:v 5 -c:a aac -b:a 32k -shortest -movflags +faststart "/work/media/$SEED_FILE"
SEED_SIZE="$(wc -c < "$WORK/media/$SEED_FILE" | tr -d ' ')"
SEED_SHA="$(node "$REL/out/sha.cjs" "$REL/media/$SEED_FILE")"
test "${SEED_SIZE:-0}" -gt 0 || die "the generator exited 0 but left no bytes in the seed"
echo "  the seed entry is $SEED_SIZE bytes"

# ----------------------------------------------------------------------------------------------------------
step "publishing generation 1: the local seed and nothing remote"
# ----------------------------------------------------------------------------------------------------------
npx tsx src/ops/projection-register-cli.ts root --id media --kind local
npx tsx src/ops/projection-register-cli.ts root --id "$ROOT_ID" --kind http-range
npx tsx src/ops/projection-register-cli.ts version --key seed --size "$SEED_SIZE" \
  --mtime 2026-06-01T10:00:00.000Z
npx tsx src/ops/projection-register-cli.ts entry --item "b0000000-0000-4000-8000-000000000002" \
  --version-key seed --path "$SEED_PATH" --source "local:media:$SEED_FILE"
npx tsx src/ops/projection-publish-cli.ts --manifest-dir "$REL/manifest" > "$WORK/out/publish-1.json"
test "$(node "$REL/out/jq.cjs" outcome < "$WORK/out/publish-1.json")" = "published" \
  || die "generation 1 was not published"

# ----------------------------------------------------------------------------------------------------------
# THE DAEMON AND THE RESOLVER — started together, and restarted together, for the whole run
# ----------------------------------------------------------------------------------------------------------
# `--auto-remount` IS ON FOR THE WHOLE RUN AND A3 IS WHY. A requested stop and a SIGKILL are not serve
# deaths, so A1 and A2 are unaffected by it; running two daemon configurations inside one run would mean the
# six arms were not done to the same subject.
start_daemon() {
  docker run -d --name "$MOUNT_CONTAINER" \
    --network "$NETWORK" --user 0:0 \
    --cap-drop ALL --cap-add SYS_ADMIN --security-opt apparmor:unconfined \
    --device /dev/fuse:/dev/fuse \
    -v "$WORK/manifest:/var/lib/projectiond/manifest:ro" \
    -v "$WORK/media:/var/lib/projectiond/media:ro" \
    -v "$WORK/cache:/var/lib/projectiond/cache" \
    -v "$WORK/daemon-inputs:/var/lib/projectiond/inputs:ro" \
    -v "$WORK/config.json:/etc/projectiond/config.json:ro" \
    -v "$WORK/mnt:/mnt/projection:rshared" \
    "$IMAGE" --config /etc/projectiond/config.json --poll "$DAEMON_POLL" \
    --strict-direct-mount --auto-remount >/dev/null
  local up=0 n=0
  while [ "$n" -lt 120 ]; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$MOUNT_CONTAINER" 2>/dev/null)" = "true" ]; then
      up=1; break
    fi
    n=$((n + 1)); sleep 0.5
  done
  if [ "$up" -ne 1 ]; then
    logs_tail "$MOUNT_CONTAINER"
    die "the daemon is not running, so the resolver cannot share its network namespace"
  fi
}

start_resolver() {
  RESOLVER_SEQ=$(( RESOLVER_SEQ + 1 ))
  RESOLVER_CONTAINER="projection-rl-resolver-$$-$RESOLVER_SEQ"
  # NOTE WHAT IS NOT PASSED: no --fixture-mode, so no origin override and no plaintext link. The checkout is
  # mounted READ-ONLY: this is the one container on the host holding the provider API key and it has no
  # reason to be able to write to the repository it runs out of.
  docker run -d --name "$RESOLVER_CONTAINER" \
    --network "container:$MOUNT_CONTAINER" \
    -v "$PWD:/workspace:ro" -w /workspace \
    -v "$WORK/inputs:/inputs:ro" \
    -e npm_config_update_notifier=false \
    "$NODE_IMAGE" ./node_modules/.bin/tsx src/ops/torbox-resolver-cli.ts serve \
    --credential /inputs/torbox-credential --gate-secret /inputs/gate-secret \
    --port "${RESOLVER_PORT}" >/dev/null \
    || die "the resolver did not start"
  local ready=0 n=0
  while [ "$n" -lt 240 ]; do
    if docker exec "$RESOLVER_CONTAINER" \
      node "/workspace/$REL/out/probe-resolver.cjs" "${RESOLVER_PORT}" >/dev/null 2>&1; then
      ready=1; break
    fi
    n=$((n + 1)); sleep 0.5
  done
  test "$ready" -eq 1 || { logs_tail "$RESOLVER_CONTAINER"; die "the resolver never came up"; }
}

stop_resolver() {
  [ -n "$RESOLVER_CONTAINER" ] || return 0
  docker rm -f "$RESOLVER_CONTAINER" >/dev/null 2>&1 || true
  RESOLVER_CONTAINER=""
}

# EVERY REQUEST THE RESOLVER HAS SEEN, counted from its own log rather than inferred from anything else.
#
# A "REQUEST" IS EVERY OUTCOME IT CAN HAVE, not just the successful one. Counting only resolutions would let
# A4's "zero provider traffic while the breaker is open" pass over a hold in which the daemon hammered a
# resolver that refused every call.
resolver_requests() {
  docker logs "$RESOLVER_CONTAINER" 2>&1 \
    | grep -cE 'torbox-resolver: (resolved a |refusing every request|rejected a request|refused a malformed|the provider did not yield|resolution failed)' \
    || true
}
resolver_resolutions() {
  docker logs "$RESOLVER_CONTAINER" 2>&1 \
    | grep -cE 'torbox-resolver: resolved a (torrent|webdl|usenet) reference in [0-9]+ attempt' || true
}

# THE DAEMON'S OWN STATUS SURFACE. It binds LOOPBACK ONLY and that is not relaxed for a test, so the request
# comes from a container sharing the daemon's network namespace. The production image is distroless and has
# neither a shell nor an HTTP client, which is why the request comes from a separate pinned one.
daemon_status() {
  docker run --rm --network "container:$MOUNT_CONTAINER" "$VERIFY_IMAGE" \
    wget -q -T 15 -O - "http://127.0.0.1:${DAEMON_STATUS_PORT}/readyz" > "$1" 2>/dev/null
}

await_path() {
  local target="$1" attempts="${2:-240}" n=0
  while [ "$n" -lt "$attempts" ]; do
    if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
         test -f "/mnt/$target" >/dev/null 2>&1; then
      return 0
    fi
    n=$((n + 1)); sleep 0.5
  done
  return 1
}

# HOW LONG IT TOOK FOR THE NAMESPACE TO BE READABLE BY A SIBLING AGAIN, in milliseconds, measured from a
# caller-supplied start. It is a SIBLING and not the daemon on purpose: `/readyz` answering ready is the
# claim Phase 2 found to be insufficient.
RECOVERY_MS=0
await_recovery() {
  local started="$1" target="$2"
  if await_path "$target" 240; then
    RECOVERY_MS=$(( $(date +%s%3N) - started ))
    return 0
  fi
  RECOVERY_MS=-1
  return 1
}

# A daemon restart is three steps, always in this order, because the resolver lives in the daemon's network
# namespace and a restarted daemon has a new one.
restart_daemon() {
  stop_resolver
  docker rm -f "$MOUNT_CONTAINER" >/dev/null 2>&1 || true
  start_daemon
  start_resolver
}

record() { node "$REL/out/record.cjs" "$RESULTS_REL" "$@"; }

# ONE READ OF THE REAL ENTRY'S APPROVED WINDOWS, TIMED, WITH A TWO-TOKEN VERDICT.
#
# IT RUNS ON THE HOST RATHER THAN IN A CONTAINER, and that is not a shortcut: the daemon binds its mount
# `rshared`, so the FUSE namespace is on the HOST — that is the entire reason a media server beside it can
# see the file. A container start costs about a second, and A4 alone takes twenty-five of these reads.
#
# A RUN THAT PRODUCED NEITHER TOKEN DIES RATHER THAN BEING SCORED AS EITHER. That is the class of defect
# Phase 2 §7 found four times and Phase 1 found four more: a step that reports a result the product was
# never consulted for.
TIMED_READ_MS=0
TIMED_READ_VERDICT=""
timed_read() {
  local out
  set +e
  out="$(node "$REL/out/oneread.cjs" "$REL/out/corpus.json" "$REL/mnt" 2>&1 | tail -1)"
  set -e
  TIMED_READ_MS="$(printf '%s' "$out" | sed -n 's/.*elapsedMs=\([0-9][0-9]*\).*/\1/p')"
  case "$out" in
    read:ok*)       TIMED_READ_VERDICT="ok" ;;
    read:mismatch*) TIMED_READ_VERDICT="mismatch" ;;
    read:eio*)      TIMED_READ_VERDICT="eio" ;;
    *)              TIMED_READ_VERDICT="" ;;
  esac
  [ -n "$TIMED_READ_VERDICT" ] && [ -n "$TIMED_READ_MS" ] \
    || die "a timed read produced neither verdict nor an elapsed time, so nothing was measured: \
$(printf '%s' "$out" | tr '\n' ' ')"
}

step "mounting — the daemon gets the GATE SECRET only, never the provider key"
start_daemon
step "starting the resolver INSIDE the daemon's network namespace — no host port, loopback only"
start_resolver
echo "  the resolver answers on the shared loopback and refuses an unauthenticated request"

# THE RESOLVER IS NOT REACHABLE FROM ANYWHERE ELSE, MEASURED AT THE TRANSPORT. A resolver anything on the
# network could reach is a credential oracle: it mints CDN links for the operator's account to whoever asks.
set +e
docker run --rm --network "$NETWORK" -v "$PWD:/workspace:ro" -w /workspace \
  -e npm_config_update_notifier=false "$NODE_IMAGE" \
  node "/workspace/$REL/out/probe-reachable.cjs" "$MOUNT_CONTAINER" "${RESOLVER_PORT}" >/dev/null 2>&1
resolver_reach=$?
set -e
case "$resolver_reach" in
  0) record RL-resolver-loopback-only bool 0 "" "the resolver accepted a TCP connection from the gate network"
     die "the resolver is reachable from the gate network; it must be loopback-only" ;;
  1) record RL-resolver-loopback-only bool 1 "" "refused at the transport from the gate network" ;;
  *) record RL-resolver-loopback-only bool 0 "" "the reachability probe could not take the measurement"
     die "the resolver's reachability could not be determined (probe exit $resolver_reach); a gate that \
could not take the measurement must not report the property as proven" ;;
esac

echo "  waiting for the seed namespace to become visible to a sibling container"
await_path "$SEED_PATH" || { logs_tail "$MOUNT_CONTAINER"; die "the mount never became visible"; }

# ----------------------------------------------------------------------------------------------------------
step "what an ordinary non-root container sees before any media server is involved"
# ----------------------------------------------------------------------------------------------------------
docker run --rm --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges \
  -v "$WORK/mnt:/mnt:rslave" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
  sh /out/baseline.sh "$SEED_PATH"

# ----------------------------------------------------------------------------------------------------------
step "starting THREE REAL MEDIA SERVERS over the SAME mount"
# ----------------------------------------------------------------------------------------------------------
# EACH IS STARTED THE WAY ITS OWN GATE STARTS IT, AND THE THREE COMMANDS ARE DELIBERATELY NOT UNIFIED.
# Jellyfin runs under `--user 1000:1000` with all capabilities dropped; Emby CANNOT, because its entrypoint
# is an s6 supervision tree that does the setuid itself; Plex takes PLEX_UID/PLEX_GID and must be addressed
# by ADDRESS rather than by name, because it answers 401 to a request whose Host header it does not know.
#
# `$WORK/inprog` IS BOUND READ-ONLY INTO ALL THREE. It holds the in-container read program and the window
# list — no reference, no label, no secret — and it is what lets each server read the object's bytes as
# itself rather than having the gate read them on its behalf.
start_jellyfin() {
  docker run -d --name "$JF_CONTAINER" \
    --network "$NETWORK" --user 1000:1000 \
    --cap-drop ALL --security-opt no-new-privileges \
    -p "127.0.0.1:${JF_PORT}:8096" \
    -e JELLYFIN_PublishedServerUrl="http://127.0.0.1:${JF_PORT}" \
    -v "$WORK/jf-config:/config" -v "$WORK/jf-cache:/cache" \
    -v "$WORK/inprog:/gate:ro" \
    -v "$WORK/mnt:/media/projection:rslave" \
    "$JELLYFIN_IMAGE" >/dev/null
}
start_emby() {
  docker run -d --name "$EMBY_CONTAINER" \
    --network "$NETWORK" --cap-drop ALL \
    --cap-add SETUID --cap-add SETGID --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --security-opt no-new-privileges -e UID=1000 -e GID=1000 \
    -p "127.0.0.1:${EMBY_PORT}:8096" \
    -v "$WORK/emby-config:/config" \
    -v "$WORK/inprog:/gate:ro" \
    -v "$WORK/mnt:/media/projection:rslave" \
    "$EMBY_IMAGE" >/dev/null
}
start_plex() {
  docker run -d --name "$PLEX_CONTAINER" \
    --network "$NETWORK" \
    -p "127.0.0.1:${PLEX_PORT}:32400" \
    -e TZ=UTC -e PLEX_UID=1000 -e PLEX_GID=1000 \
    -e ALLOWED_NETWORKS=0.0.0.0/0 -e ADVERTISE_IP="http://127.0.0.1:${PLEX_PORT}/" \
    -v "$WORK/plex-config:/config" -v "$WORK/plex-transcode:/transcode" \
    -v "$WORK/inprog:/gate:ro" \
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

jellyfin() { npx tsx src/ops/projection-jellyfin-dataplane-cli.ts "$@"; }
plex()     { npx tsx src/ops/projection-plex-dataplane-cli.ts "$@"; }
emby()     { npx tsx src/ops/projection-emby-dataplane-cli.ts "$@"; }
drive()    { npx tsx src/ops/projection-three-server-concurrency-cli.ts "$@"; }

container_for() {
  case "$1" in
    jellyfin) echo "$JF_CONTAINER" ;;
    plex)     echo "$PLEX_CONTAINER" ;;
    emby)     echo "$EMBY_CONTAINER" ;;
    *) die "unknown server $1" ;;
  esac
}
base_for() {
  case "$1" in
    jellyfin) echo "$JF_BASE" ;;
    plex)     echo "$PLEX_BASE" ;;
    emby)     echo "$EMBY_BASE" ;;
    *) die "unknown server $1" ;;
  esac
}
state_for() {
  case "$1" in
    jellyfin) echo "$JF_STATE" ;;
    plex)     echo "$PLEX_STATE" ;;
    emby)     echo "$EMBY_STATE" ;;
    *) die "unknown server $1" ;;
  esac
}
cli_for() {
  case "$1" in
    jellyfin) echo "src/ops/projection-jellyfin-dataplane-cli.ts" ;;
    plex)     echo "src/ops/projection-plex-dataplane-cli.ts" ;;
    emby)     echo "src/ops/projection-emby-dataplane-cli.ts" ;;
    *) die "unknown server $1" ;;
  esac
}

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

# EACH SERVER MUST READ THE MOUNT AS THE UID IT ACTUALLY RUNS AS, checked from inside its own container
# BEFORE a scan is asked for. `-u 1000:1000` is load-bearing on Emby, where a bare `docker exec` lands as
# ROOT because the image drops privilege internally, and root being able to read says nothing about the
# server.
docker exec -u 1000:1000 "$JF_CONTAINER"   test -r "/media/projection/$SEED_PATH" \
  || die "Jellyfin's own uid cannot read the projected file"
docker exec -u 1000:1000 "$EMBY_CONTAINER" test -r "/media/projection/$SEED_PATH" \
  || die "Emby's own uid cannot read the projected file"
docker exec -u 1000:1000 "$PLEX_CONTAINER" test -r "/media/projection/$SEED_PATH" \
  || die "Plex's own uid cannot read the projected file"
echo "  all three servers can read the same projected file as the uid each runs as"

# Plex's own preferences, which turn off every background job that reads whole media files on a timer. A
# butler window opening mid-run would put provider bytes into a window this gate attributes to a scan.
plex prefs --state "$PLEX_STATE"

# ----------------------------------------------------------------------------------------------------------
step "adding the SAME mount as a Movies library on all three"
# ----------------------------------------------------------------------------------------------------------
jellyfin library --state "$JF_STATE"   --mount-path /media/projection/Movies --name "Projection Movies"
emby     library --state "$EMBY_STATE" --mount-path /media/projection/Movies --name "Projection Movies"
# PLEX LAST, AND THE ORDER IS LOAD-BEARING: creating a Plex section starts a scan of it immediately, so
# putting it last means the other two libraries already exist when that scan runs.
plex     library --state "$PLEX_STATE" --mount-path /media/projection/Movies --name "Projection Movies"

node "$REL/out/seed-expect.cjs" "$REL/out/seed-expected.json" "$SEED_FILE" "$SEED_SIZE" "$SEED_SHA"
plex scan --state "$PLEX_STATE" --expect-file "$REL/out/seed-expected.json" \
  --out "$REL/out/plex-seed-items.json" --label seed \
  || { logs_tail "$PLEX_CONTAINER"; die "Plex never settled after its own library-creation scan"; }

# ----------------------------------------------------------------------------------------------------------
step "publishing generation 2: THE OPERATOR'S REAL OBJECT, under a path this gate chose"
# ----------------------------------------------------------------------------------------------------------
# The batch file was written during preflight, before anything was built. Only its PATH and the endpoint's
# boring slug reach argv; the stable references stay inside the 0600 file.
npx tsx src/ops/projection-register-cli.ts batch --file "$REL/out/register-batch.json"
npx tsx src/ops/projection-publish-cli.ts --manifest-dir "$REL/manifest" > "$WORK/out/publish-2.json"
test "$(node "$REL/out/jq.cjs" outcome < "$WORK/out/publish-2.json")" = "published" \
  || die "the real-object generation was not published"
test "$(node "$REL/out/jq.cjs" additions < "$WORK/out/publish-2.json")" = "$OBJECT_COUNT" \
  || die "the real-object generation added a different number of entries than the corpus describes"
await_path "$REAL_PATH" || { logs_tail "$MOUNT_CONTAINER"; die "the real entry never became visible"; }

EXPECT_TOTAL="$(node "$REL/out/expect.cjs" "$REL/out/expected.json" "$REL/out/corpus.json" \
  "$SEED_FILE" "$SEED_SIZE" "$SEED_SHA")"
echo "  the shared expectation all three servers are held against is $EXPECT_TOTAL entries"

# ----------------------------------------------------------------------------------------------------------
# THE ITEM IDS PLAYBACK NEEDS — PRODUCED AFTER THE FIRST CONCURRENT SCAN, NOT BEFORE IT
# ----------------------------------------------------------------------------------------------------------
# THE FIRST REAL RUN FAILED HERE AND THE FAILURE WAS THIS ORDER. The loop scans all three servers on ONE
# clock through `concurrent-scan`, which writes each server's CATALOGUE — key, size, ordinary-file. Direct
# play needs something different: the server's own ITEM ID and media-source id, which each driver's `scan`
# writes and `paced-play` reads. Those three scans used to run HERE, before the loop — and they are what
# actually reads a 1.7 GB remote object through three ffprobes for the first time. Plex's took 15 s. By the
# time cycle 1's concurrent scan ran, every window was warm and all three servers finished a two-entry
# re-scan between two of the observer's ticks: 4 samples, ZERO with a server in flight, and the run died on
# its own simultaneity assertion having warmed the very window it was about to measure.
#
# It is exactly what G18's own header warns about — "the corpus generation is published AFTER all three
# libraries exist, and the three concurrent scans are the FIRST thing that ever reads it" — arrived at
# independently, one tranche later, by running the gate rather than by reading it.
#
# ONCE, BECAUSE ZERO ITEM-ID CHURN IS A THING THIS GATE ASSERTS RATHER THAN ASSUMES. If a restart or a
# remount changed an item id, playback in the next cycle would fail against the stale items file — which is
# the right outcome, and a re-scan per cycle would have hidden it by silently picking up the new one.
ITEMS_READY=0
ensure_items() {
  [ "$ITEMS_READY" -eq 0 ] || return 0
  step "one scan per server through its OWN driver, for the item ids playback needs"
  jellyfin scan --state "$JF_STATE" --expect-file "$REL/out/expected.json" \
    --out "$REL/out/items-jellyfin.json" --label corpus \
    || { logs_tail "$JF_CONTAINER"; die "Jellyfin did not settle on the shared namespace"; }
  emby scan --state "$EMBY_STATE" --expect-file "$REL/out/expected.json" \
    --out "$REL/out/items-emby.json" --label corpus \
    || { logs_tail "$EMBY_CONTAINER"; die "Emby did not settle on the shared namespace"; }
  plex scan --state "$PLEX_STATE" --expect-file "$REL/out/expected.json" \
    --out "$REL/out/items-plex.json" --label corpus \
    || { logs_tail "$PLEX_CONTAINER"; die "Plex did not settle on the shared namespace"; }
  local server
  for server in $RL_SERVERS; do
    test -s "$WORK/out/items-$server.json" || die "$server's scan exited 0 but wrote no items"
  done
  ITEMS_READY=1
}

# ----------------------------------------------------------------------------------------------------------
step "IS THE REAL ENTRY A DECODABLE VIDEO? Asked once, before any server is asked to play it"
# ----------------------------------------------------------------------------------------------------------
# A CORPUS THAT IS NOT PLAYABLE VIDEO IS A CORPUS PROBLEM, AND THIS IS WHERE IT SAYS SO. §2 of the acceptance
# plan requires the operator to have chosen playable video; if they did not, the failure belongs here with a
# named message rather than three phases later inside a media server that is blamed for it.
set +e
docker run --rm --entrypoint "$GENERATOR_FFPROBE" -v "$WORK/mnt:/mnt:rslave" "$GENERATOR_IMAGE" \
  -v error -show_entries "stream=codec_type,codec_name" -of default=nw=1 \
  -read_intervals "%+#1" "/mnt/$REAL_PATH" > "$WORK/out/ffprobe.txt" 2>"$WORK/out/ffprobe.err"
ffprobe_status=$?
set -e
if [ "$ffprobe_status" -eq 0 ] && grep -q "codec_type=video" "$WORK/out/ffprobe.txt"; then
  record RL-entry-is-decodable-video bool 1 "" "a decoder found a video stream in the projected entry"
else
  record RL-entry-is-decodable-video bool 0 "" "no video stream was found in the projected entry"
  echo "--- the decoder's own words ---" >&2
  tail -5 "$WORK/out/ffprobe.err" >&2 || true
  die "the operator's object does not present as playable video through the mount; the acceptance plan's \
real-provider corpus is 1-3 files the operator is entitled to AND has chosen as playable video"
fi

# ----------------------------------------------------------------------------------------------------------
# THE PHASES
# ----------------------------------------------------------------------------------------------------------

# PHASE O — all three servers rescan on one clock, catalogue, and play.
CATALOGUE_ROUND=0
phase_ordinary() {
  local cycle="$1" tag="$2" server catalogue
  CATALOGUE_ROUND=$(( CATALOGUE_ROUND + 1 ))
  mkdir -p "$WORK/out/cat-$CATALOGUE_ROUND"
  # THREE SCANS ON ONE CLOCK, WITH NO BARRIER, AND THE ABSENCE IS RECORDED RATHER THAN GLOSSED. G18 holds a
  # provider read at its own fake endpoint so the three scanners rendezvous; a real provider has no control
  # surface, so `--no-barrier true` is passed and the outcome records `barrier: none`.
  drive concurrent-scan --no-barrier true \
    --state-jellyfin "$JF_STATE" --state-plex "$PLEX_STATE" --state-emby "$EMBY_STATE" \
    --out "$REL/out/scan-$CATALOGUE_ROUND.json" --catalogue-dir "$REL/out/cat-$CATALOGUE_ROUND" \
    --results "$REL/out/drive-$CATALOGUE_ROUND.json" \
    || { logs_tail "$MOUNT_CONTAINER"; die "cycle $cycle phase $tag: the three scans did not complete"; }
  for server in $RL_SERVERS; do
    catalogue="$REL/out/cat-$CATALOGUE_ROUND/catalogue-$server.json"
    if drive verify-corpus --server "$server" --catalogue "$catalogue" \
         --expect-file "$REL/out/expected.json" --results "$REL/out/drive-$CATALOGUE_ROUND.json"; then
      record "RL-$tag-catalogue:$server:c$cycle" bool 1 "" \
        "every published identity at the published size as an ordinary file, through this server's own predicate"
    else
      record "RL-$tag-catalogue:$server:c$cycle" bool 0 "" "this server's catalogue does not match"
      die "cycle $cycle phase $tag: $server did not catalogue the shared namespace"
    fi
  done
}

phase_play() {
  local cycle="$1" server results trace startup decoded
  for server in $RL_SERVERS; do
    results="$WORK/out/play-$server-c$cycle.json"
    trace="$REL/out/play-trace-$server-c$cycle.json"
    set +e
    npx tsx "$(cli_for "$server")" paced-play \
      --state "$(state_for "$server")" --items "$REL/out/items-$server.json" \
      --key "$REAL_FILE" --seconds "$RL_PLAY_DECODED_SECONDS_MIN" \
      --image "$GENERATOR_IMAGE" --ffmpeg "$GENERATOR_FFMPEG" --network "$NETWORK" \
      --container-name "$CONSUMER_PREFIX-$server-c$cycle" --work-dir "$WORK/consumer" \
      --output-rel "play-$server-c$cycle.mp4" --stream-base "$(base_for "$server")" \
      --trace "$trace" --results "$REL/out/play-$server-c$cycle.json"
    local play_status=$?
    set -e
    startup="$(node "$REL/out/playfigures.cjs" "$REL/out/play-$server-c$cycle.json" startupSeconds)"
    decoded="$(node "$REL/out/playfigures.cjs" "$REL/out/play-$server-c$cycle.json" decodedSeconds)"
    record "RL-O-play-start-ms:$server:c$cycle" le "$startup" "$RL_PLAY_START_BUDGET_MS" \
      "from launching the consumer to its first decoded frame" || true
    record "RL-O-play-decoded-seconds:$server:c$cycle" ge "$decoded" \
      "$RL_PLAY_DECODED_SECONDS_MIN" "media the consumer actually decoded, not wall clock it spent" || true
    if [ "$play_status" -ne 0 ]; then
      logs_tail "$(container_for "$server")"
      die "cycle $cycle: $server's direct play of the real entry failed its own driver's thresholds"
    fi
  done
}

# PHASE B and PHASE R's byte half — the operator's windows, read through the mount and inside each server.
phase_bytes() {
  local cycle="$1" tag="$2" server matched problems statok
  set +e
  timeout 900 node "$REL/out/verify.cjs" "$REL/out/corpus.json" "$REL/mnt" \
    "$REL/out/verify-$tag-c$cycle.json"
  set -e
  matched="$(node "$REL/out/summary.cjs" "$REL/out/verify-$tag-c$cycle.json" windowsMatched)"
  problems="$(node "$REL/out/summary.cjs" "$REL/out/verify-$tag-c$cycle.json" problems)"
  statok="$(node "$REL/out/summary.cjs" "$REL/out/verify-$tag-c$cycle.json" statOk)"
  record "RL-$tag-stat:c$cycle" eq "$statok" "$OBJECT_COUNT" \
    "an ordinary regular file at exactly the published size, by lstat so a symlink cannot pass" || true
  # BYTE CORRECTNESS IS FATAL WHERE A TIMING BUDGET IS NOT, and the asymmetry is deliberate. A budget that
  # was missed is a figure worth carrying to the end of the run and judging in one place; bytes that came
  # back wrong mean every later cycle is reading a namespace whose correctness has already failed, and an
  # hour of further measurement over it produces nothing anybody can use.
  record "RL-$tag-windows:c$cycle" ge "$matched" "$RL_OPERATOR_WINDOWS_REQUIRED" \
    "operator windows digest-compared against values recorded OUTSIDE the mount before any run" \
    || die "cycle $cycle phase $tag: the operator's approved windows did not all match through the mount"
  record "RL-$tag-problems:c$cycle" eq "$problems" 0 "every read through the mount, without a problem" \
    || die "cycle $cycle phase $tag: a read through the mount reported a problem"

  # THE LOCAL CONTROL. A fault aimed at the remote path must not stop this one.
  if docker run --rm --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges \
       -v "$WORK/mnt:/mnt:rslave" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
       sh /out/baseline.sh "$SEED_PATH" >/dev/null 2>&1; then
    record "RL-$tag-seed:c$cycle" bool 1 "" "the local control entry still reads as an ordinary file"
  else
    record "RL-$tag-seed:c$cycle" bool 0 "" "the local control entry does not read" || true
  fi

  # AND EACH SERVER READS THE SAME WINDOWS ITSELF, in its own container, as its own uid.
  for server in $RL_SERVERS; do
    set +e
    local verdict
    verdict="$(docker exec -u 1000:1000 "$(container_for "$server")" \
      sh /gate/inread.sh "/media/projection/$REAL_PATH" /gate/windows.txt 2>&1 | tail -1)"
    set -e
    case "$verdict" in
      inread:ok*) record "RL-$tag-inread:$server:c$cycle" bool 1 "" \
        "this server's own container read the operator's windows and every digest matched" ;;
      inread:*)   record "RL-$tag-inread:$server:c$cycle" bool 0 "" \
        "this server's own container could not read the operator's windows correctly" || true ;;
      *)          record "RL-$tag-inread:$server:c$cycle" bool 0 "" \
        "the in-container read produced neither verdict, so nothing was measured" || true ;;
    esac
  done
}

phase_churn() {
  local cycle="$1" server before after churn
  for server in $RL_SERVERS; do
    before="$REL/out/cat-$(( CATALOGUE_ROUND - 1 ))/catalogue-$server.json"
    after="$REL/out/cat-$CATALOGUE_ROUND/catalogue-$server.json"
    set +e
    churn="$(node "$REL/out/churn.cjs" "$before" "$after")"
    set -e
    record "RL-R-churn:$server:c$cycle" le "$churn" "$RL_LIBRARY_CHURN_MAX" \
      "items added or removed across the fault, on this server's own catalogue" || true
  done
}

# ----------------------------------------------------------------------------------------------------------
# THE SIX ARMS
# ----------------------------------------------------------------------------------------------------------

# THE CORPSE CHECK, from a sibling container, the same way the daemon's own probe looks at it: statfs — which
# FUSE never caches, so a dead connection answers ENOTCONN immediately — plus a mountinfo read that must
# still name the mount `fuse.projectiond`. A stale mount keeps statting fine while its attribute cache is
# warm, so a stat-based check would prove nothing.
corpse_is_stale() {
  local stderr count
  if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" df -P /mnt >/dev/null 2>&1; then
    echo "not-stale"; return 0
  fi
  stderr="$(docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" df -P /mnt 2>&1 || true)"
  # A MESSAGE IS NOT A CONTRACT, THE ERRNO IS — and shell cannot read one numerically here, so what is
  # matched is the SET of libc spellings of ENOTCONN. The pinned verify image is musl and says "Socket not
  # connected"; glibc says "Transport endpoint is not connected". A wrong errno matches neither.
  case "$(printf '%s' "$stderr" | tr '[:upper:]' '[:lower:]')" in
    *"transport endpoint is not connected"*) ;;
    *"socket not connected"*)                ;;
    *) echo "wrong-errno"; return 0 ;;
  esac
  count="$(docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
    sh -c "grep -c 'fuse.projectiond' /proc/self/mountinfo || true")"
  [ "${count:-0}" -ge 1 ] || { echo "not-in-mountinfo"; return 0; }
  echo "stale"
}

arm_A1() {
  local cycle="$1" started
  docker stop -t 30 "$MOUNT_CONTAINER" >/dev/null
  local gone=0 n=0
  while [ "$n" -lt 60 ]; do
    if ! docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
         test -f "/mnt/$SEED_PATH" >/dev/null 2>&1; then gone=1; break; fi
    n=$((n + 1)); sleep 0.5
  done
  record "RL-F-A1-namespace-went-away:c$cycle" bool "$gone" "" \
    "a requested stop takes the namespace with it" || true
  started="$(date +%s%3N)"
  restart_daemon
  await_recovery "$started" "$REAL_PATH" || true
  record "RL-F-A1-ready-ms:c$cycle" le "$RECOVERY_MS" "$RL_READY_BUDGET_MS" \
    "from the restart to a sibling container reading the real entry again" || true
  record "RL-F-A1:c$cycle" bool "$( [ "$gone" -eq 1 ] && [ "$RECOVERY_MS" -ge 0 ] && echo 1 || echo 0 )" "" \
    "graceful daemon restart" || true
}

arm_A2() {
  local cycle="$1" started corpse
  stop_resolver
  docker kill -s KILL "$MOUNT_CONTAINER" >/dev/null 2>&1 || true
  # THE CORPSE IS VERIFIED BEFORE THE RECOVERY IS ASSERTED. Without this the restart below could be stacking
  # over a clean mountpoint and the arm would be a second copy of A1 wearing A2's name.
  local n=0
  corpse="not-stale"
  while [ "$n" -lt 60 ]; do
    corpse="$(corpse_is_stale)"
    [ "$corpse" = "stale" ] && break
    n=$((n + 1)); sleep 0.5
  done
  record "RL-F-A2-corpse-was-stale:c$cycle" bool "$( [ "$corpse" = "stale" ] && echo 1 || echo 0 )" "" \
    "statfs answers ENOTCONN while mountinfo still names fuse.projectiond" || true
  started="$(date +%s%3N)"
  docker rm -f "$MOUNT_CONTAINER" >/dev/null 2>&1 || true
  start_daemon
  start_resolver
  await_recovery "$started" "$REAL_PATH" || true
  local named=0
  if docker logs "$MOUNT_CONTAINER" 2>&1 | grep -q "stale projectiond mount detected"; then named=1; fi
  record "RL-F-A2-probe-named-the-corpse:c$cycle" bool "$named" "" \
    "the startup probe NAMED the corpse rather than guessing about it" || true
  record "RL-F-A2-ready-ms:c$cycle" le "$RECOVERY_MS" "$RL_READY_BUDGET_MS" \
    "from the SIGKILL to a sibling container reading the real entry again" || true
  record "RL-F-A2:c$cycle" bool \
    "$( [ "$corpse" = "stale" ] && [ "$named" -eq 1 ] && [ "$RECOVERY_MS" -ge 0 ] && echo 1 || echo 0 )" "" \
    "daemon SIGKILL and restart over the corpse it left" || true
}

arm_A3() {
  local cycle="$1" started before after
  # THE IDENTITY BEFORE THE DEATH, so "the namespace came back IN PLACE" is a comparison rather than a hope.
  before="$(docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
    stat -c '%i:%s:%Y' "/mnt/$REAL_PATH" 2>/dev/null || echo "")"
  started="$(date +%s%3N)"
  # THE DEATH: an external unmount through the shared mount — the same propagation path the daemon's own
  # mount travelled out of its container. The daemon process is untouched.
  projection_gate_unmount_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE"
  local saw_death=0 n=0
  while [ "$n" -lt 60 ]; do
    if daemon_status "$WORK/out/readyz-a3-c$cycle.json" 2>/dev/null \
      && [ -n "$(node "$REL/out/jq.cjs" lastServeDeathAt < "$WORK/out/readyz-a3-c$cycle.json")" ]; then
      saw_death=1; break
    fi
    n=$((n + 1)); sleep 0.5
  done
  record "RL-F-A3-serve-death-observed:c$cycle" bool "$saw_death" "" \
    "the daemon's own status surface names a serve-loop death, so the connection really was severed" || true
  await_recovery "$started" "$REAL_PATH" || true
  local remounted=0
  if [ "$RECOVERY_MS" -ge 0 ]; then remounted=1; fi
  record "RL-F-A3-remounted-in-place:c$cycle" bool "$remounted" "" \
    "the namespace came back at the same mountpoint without the process exiting" || true
  after="$(docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
    stat -c '%i:%s:%Y' "/mnt/$REAL_PATH" 2>/dev/null || echo "")"
  record "RL-F-A3-identity-unchanged:c$cycle" bool \
    "$( [ -n "$before" ] && [ "$before" = "$after" ] && echo 1 || echo 0 )" "" \
    "inode, size and mtime across the remount" || true
  # THE ASSERTION THIS WHOLE TRANCHE EXISTS FOR. Phase 2's `--auto-remount` recovered for the daemon and for
  # nobody else: /readyz said ready and no consumer could see a file. Three consumers reading through their
  # OWN binds is the only thing that tells those two apart.
  local reading=0 server
  for server in $RL_SERVERS; do
    if docker exec -u 1000:1000 "$(container_for "$server")" \
         test -r "/media/projection/$REAL_PATH" >/dev/null 2>&1; then
      reading=$(( reading + 1 ))
    fi
  done
  record "RL-F-A3-frontends-read-after-remount:c$cycle" eq "$reading" 3 \
    "the recovery is only a recovery if the CONSUMERS can see it; Phase 2's worst defect is that they could not" \
    || true
  record "RL-F-A3:c$cycle" bool \
    "$( [ "$saw_death" -eq 1 ] && [ "$remounted" -eq 1 ] && [ "$reading" -eq 3 ] && echo 1 || echo 0 )" "" \
    "the mount taken out from under a living daemon, then auto-remounted" || true
}

arm_A4() {
  local cycle="$1" started
  # THE ORDER OF THESE TWO STEPS IS THE WHOLE ARM, AND GETTING IT WRONG MEASURES NOTHING.
  #
  # Access material is memory-only by contract, so a source whose lease is still good never asks the
  # resolver anything and an "outage" is invisible to it. The lease therefore has to be dropped, and the only
  # way to drop it is to restart the daemon — which, because the resolver lives in the daemon's network
  # namespace, restarts the resolver too.
  #
  # AND THE RESOLVER FAILS CLOSED AT STARTUP, so it cannot be started with a credential it will refuse. So:
  # restart BOTH while the credential is still good, and break it immediately afterwards, BEFORE anything
  # reads. Nothing between the two steps contacts the provider — a fresh daemon has no lease and every
  # metadata operation is answered locally — so the first read after the break is the one that must resolve.
  restart_daemon
  # THE OUTAGE. The resolver's own COPY of the provider credential is widened to 0644, which
  # `readSecretFile` refuses on EVERY request — so the resolver stays up, logs every request it refuses,
  # answers 503, and CONTACTS THE PROVIDER NOT AT ALL. The operator's own file is never touched.
  chmod 0644 "$WORK/inputs/torbox-credential"
  await_path "$REAL_PATH" 240 || die "cycle $cycle A4: the namespace did not come back before the outage"

  # THE TRIP. Each read fails inside the product's own deadline, and five counted failures open the breaker.
  local trips=0 slowest=0
  while [ "$trips" -lt 8 ]; do
    timed_read
    trips=$(( trips + 1 ))
    if [ "$TIMED_READ_MS" -gt "$slowest" ]; then slowest="$TIMED_READ_MS"; fi
    if [ "$TIMED_READ_VERDICT" = "ok" ]; then break; fi
    if [ "$TIMED_READ_MS" -lt "$RL_BREAKER_REFUSAL_BUDGET_MS" ] && [ "$trips" -ge 6 ]; then break; fi
  done
  record "RL-F-A4-read-fail-ms:c$cycle" le "$slowest" "$RL_READ_FAIL_BUDGET_MS" \
    "the slowest failing read during the trip, against the product's own read deadline" || true

  # THE BREAKER IS OPEN WHEN A READ IS REFUSED LOCALLY, which is the only thing that produces a refusal
  # faster than any admitted read could ever be.
  timed_read
  local opened=0
  if [ "$TIMED_READ_VERDICT" != "ok" ] && [ "$TIMED_READ_MS" -le "$RL_BREAKER_REFUSAL_BUDGET_MS" ]; then
    opened=1
  fi
  record "RL-F-A4-breaker-opened:c$cycle" bool "$opened" "" \
    "a read refused locally rather than attempted; nothing else answers this fast" || true
  record "RL-F-A4-refusal-ms:c$cycle" le "$TIMED_READ_MS" "$RL_BREAKER_REFUSAL_BUDGET_MS" \
    "an open breaker refuses before any admitted read could have got a slot" || true

  # THE HOLD, AND THE ENDPOINT IS HEALTHY THROUGHOUT IT. The credential is restored mid-hold, so what is
  # measured is a LIVE resolver receiving nothing — strictly stronger than holding a dead one down.
  chmod 0600 "$WORK/inputs/torbox-credential"
  local baseline
  baseline="$(resolver_requests)"
  local held=0
  while [ "$held" -lt 12 ]; do
    timed_read
    held=$(( held + 1 ))
    sleep 5
  done
  local during
  during="$(resolver_requests)"
  record "RL-F-A4-hold-resolver-requests:c$cycle" le "$(( during - baseline ))" \
    "$RL_HOLD_RESOLVER_REQUESTS_MAX" \
    "requests reaching a HEALTHY resolver while the breaker is open, counted in its own log" || true

  # THE RELEASE. After the cooldown has elapsed the first read is admitted as the half-open probe, and it
  # must succeed on real bytes.
  started="$(date +%s%3N)"
  local recovered=0 probes_before probes_after
  probes_before="$(resolver_resolutions)"
  local n=0
  while [ "$n" -lt 40 ]; do
    timed_read
    if [ "$TIMED_READ_VERDICT" = "ok" ]; then recovered=1; break; fi
    n=$((n + 1)); sleep 3
  done
  probes_after="$(resolver_resolutions)"
  record "RL-F-A4-recovery-ms:c$cycle" le "$(( $(date +%s%3N) - started ))" \
    "$RL_OUTAGE_RECOVERY_BUDGET_MS" \
    "from the release to a read that succeeded and digest-matched" || true
  record "RL-F-A4-half-open-probes:c$cycle" ge "$(( probes_after - probes_before ))" "$RL_HALF_OPEN_PROBES" \
    "the half-open probe closing the breaker on real evidence" || true
  record "RL-F-A4:c$cycle" bool "$recovered" "" \
    "a sustained provider outage past the breaker cooldown, then recovery" || true
}

arm_A5() {
  local cycle="$1"
  # HALF ONE: A ROTATION IS INVISIBLE TO A SOURCE WHOSE ACCESS MATERIAL IS STILL GOOD, and that is a
  # PROPERTY rather than an inconvenience. The resolver re-reads the secret it accepts on every request, so
  # rotating it takes effect immediately at the resolver — and changes nothing for a read that needs no
  # resolution.
  node "$REL/out/mintsecret.cjs" "$REL/inputs/gate-secret"
  chmod 600 "$WORK/inputs/gate-secret"
  timed_read
  record "RL-F-A5-invisible-under-live-lease:c$cycle" bool \
    "$( [ "$TIMED_READ_VERDICT" = "ok" ] && echo 1 || echo 0 )" "" \
    "the rotation changed nothing for a source whose access material had not lapsed" || true

  # HALF TWO: FORCE A RESOLUTION, AND THE RESTART IS PART OF THE ARM RATHER THAN A WORKAROUND. Access
  # material is memory-only by contract, so dropping it means restarting the daemon. The daemon still
  # presents the OLD secret, so the resolution must be REFUSED.
  # THE BASELINE IS TAKEN AFTER THE RESTART, NOT BEFORE IT. `restart_daemon` replaces the resolver container
  # — it lives in the daemon's network namespace — so a count taken from the OLD container's log would be
  # compared against a log that starts empty, and every refusal would look like a new one.
  local refused_before refused_after refusal_reads=0
  restart_daemon
  await_path "$REAL_PATH" 240 || die "cycle $cycle A5: the namespace did not come back after the restart"
  refused_before="$(docker logs "$RESOLVER_CONTAINER" 2>&1 | grep -c 'rejected a request' || true)"
  while [ "$refusal_reads" -lt "$RL_ROTATION_REFUSAL_READS_MAX" ]; do
    timed_read
    refusal_reads=$(( refusal_reads + 1 ))
    if [ "$TIMED_READ_VERDICT" = "ok" ]; then break; fi
  done
  refused_after="$(docker logs "$RESOLVER_CONTAINER" 2>&1 | grep -c 'rejected a request' || true)"
  record "RL-F-A5-refusal-observed:c$cycle" bool \
    "$( [ "$(( refused_after - refused_before ))" -ge 1 ] && echo 1 || echo 0 )" "" \
    "the resolver's own log records a request that did not present the gate secret" || true
  record "RL-F-A5-refusal-reads:c$cycle" le "$refusal_reads" "$RL_ROTATION_REFUSAL_READS_MAX" \
    "bounded strictly under the breaker's failure threshold, so this arm cannot open the breaker A4 is about" \
    || true

  # AND THEN THE NEW SECRET IS DELIVERED TO THE DAEMON, which re-reads its token file only when a resolution
  # is refused — so the read after the reload is the one that converges.
  install -m 600 "$WORK/inputs/gate-secret" "$WORK/daemon-inputs/gate-secret"
  local converged=0 reads=0
  while [ "$reads" -lt "$RL_ROTATION_CONVERGENCE_READS" ]; do
    timed_read
    reads=$(( reads + 1 ))
    if [ "$TIMED_READ_VERDICT" = "ok" ]; then converged=1; break; fi
    sleep 2
  done
  record "RL-F-A5-convergence-reads:c$cycle" le "$reads" "$RL_ROTATION_CONVERGENCE_READS" \
    "one read spends the reload, the next presents the new value" || true
  # AND THE BREAKER STAYED CLOSED, which is what makes the two arms different measurements. A refused read
  # that came back inside the refusal budget would be the breaker answering, not the resolver.
  local closed=1
  [ "$converged" -eq 1 ] || closed=0
  record "RL-F-A5-breaker-stayed-closed:c$cycle" bool "$closed" "" \
    "the arm converged, so the counted failures never reached the breaker's threshold" || true
  record "RL-F-A5:c$cycle" bool "$converged" "" \
    "credential rotation: invisible under a live lease, refused then converged without one" || true
}

arm_A6() {
  local cycle="$1" started server back=0
  started="$(date +%s%3N)"
  for server in $RL_SERVERS; do
    docker restart -t 30 "$(container_for "$server")" >/dev/null
  done
  # A RE-BOOTSTRAP AFTER A RESTART IS THE SAME INSTALLATION: the wizard is already complete, so each
  # driver's bootstrap is an ordinary login and it carries the library the previous state file named.
  jellyfin bootstrap --base "$JF_BASE" --state "$JF_STATE" && back=$(( back + 1 )) || true
  emby bootstrap --base "$EMBY_BASE" --state "$EMBY_STATE" && back=$(( back + 1 )) || true
  plex bootstrap --base "$PLEX_BASE" --state "$PLEX_STATE" && back=$(( back + 1 )) || true
  record "RL-F-A6-frontends-came-back:c$cycle" eq "$back" 3 \
    "all three servers answered their own API again after the restart" || true
  RECOVERY_MS=$(( $(date +%s%3N) - started ))
  # IDENTITIES ACROSS THE RESTART ARE MEASURED IN PHASE R's CHURN, which compares this cycle's catalogues
  # against the ones taken before the fault. This id records that the comparison HAS a subject.
  record "RL-F-A6-identities-unchanged:c$cycle" bool "$( [ "$back" -eq 3 ] && echo 1 || echo 0 )" "" \
    "the churn comparison in phase R is what holds the identities; this is that it had three subjects" || true
  record "RL-F-A6:c$cycle" bool "$( [ "$back" -eq 3 ] && echo 1 || echo 0 )" "" \
    "all three frontends restarted over the same mountpoint" || true
}

# ----------------------------------------------------------------------------------------------------------
step "THE LOOP — $RL_CYCLES_PER_RUN cycles, one per arm, in the order the contract names"
# ----------------------------------------------------------------------------------------------------------
CYCLE=0
for ARM in $RL_ARMS; do
  CYCLE=$(( CYCLE + 1 ))
  step "CYCLE $CYCLE of $RL_CYCLES_PER_RUN — arm $ARM"
  node "$REL/out/cycle.cjs" "$CYCLES_REL" "$CYCLE" "$ARM"

  echo "--- phase O: three real servers scan and play the real entry ---"
  phase_ordinary "$CYCLE" O
  # THE OVERLAP OBSERVATION IS TAKEN ONCE, ON THE COLD CYCLE, AND IT IS RECORDED RATHER THAN REQUIRED.
  # A re-scan of an unchanged library is legitimately cheap (G19), so a floor on how long three of them
  # overlap would be a floor on the wrong thing. What measurement mode still REQUIRES is that all three were
  # observed scanning and that at least one fully attributed three-way sample exists.
  if [ "$CYCLE" -eq 1 ]; then
    if drive verify-overlap --scan "$REL/out/scan-1.json" --overlap-mode measurement \
         --results "$REL/out/drive-1.json"; then
      record RL-overlap-three-way-observed bool 1 "" \
        "all three observed scanning the same real-provider namespace, with a fully attributed sample"
    else
      record RL-overlap-three-way-observed bool 0 "" "the three scans were not observed to overlap" || true
      die "the three scans were not observed to overlap on the cold cycle"
    fi
  fi
  # ...AND ONLY NOW ARE THE ITEM IDS TAKEN. Doing it before the loop is what warmed the window the line above
  # exists to measure; see the comment on `ensure_items`.
  ensure_items
  phase_play "$CYCLE"

  echo "--- phase B: the operator's windows, through the mount and inside each server ---"
  phase_bytes "$CYCLE" B

  echo "--- phase F: arm $ARM ---"
  "arm_$ARM" "$CYCLE"
  record "RL-R-ready-ms:c$CYCLE" le "$RECOVERY_MS" "$RL_READY_BUDGET_MS" \
    "from the fault to a namespace a sibling container could read again" || true

  echo "--- phase R: the same bytes and the same identities, after the fault ---"
  phase_bytes "$CYCLE" R
  phase_ordinary "$CYCLE" R
  phase_churn "$CYCLE"
done

# ----------------------------------------------------------------------------------------------------------
step "NO SECRET, REFERENCE OR LABEL REACHED ANYTHING THIS RUN WROTE"
# ----------------------------------------------------------------------------------------------------------
# THE NEEDLES ARRIVE AS A FILE PATH, never in argv: a needle passed to `docker run` lives in the host's
# process table and in `docker inspect .Config.Cmd` for the life of the container, which is measurably not
# "nowhere". Mode 0644 for the reason §6.0 of the acceptance plan records — a file the consuming container's
# uid cannot read is a defect Docker Desktop cannot show you.
node "$REL/out/needles.cjs" "$OBJECTS_FILE" "$REL/inputs/torbox-credential" "$REL/inputs/gate-secret" \
  "$REL/out/leak-needles.txt" \
  || die "the needle list could not be built, so no leak search could be decisive"
chmod 644 "$WORK/out/leak-needles.txt"

leak_scan() {
  local id="$1" label="$2" dir="$3"
  if docker run --rm -v "$dir:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
       sh /out/leakcheck.sh "$label" /out/leak-needles.txt; then
    record "$id" bool 1 "" "$label"
  else
    record "$id" bool 0 "" "$label" || true
    die "$label holds a secret, a reference or the operator's label"
  fi
}
leak_scan RL-leak-manifest    "the published manifest directory" "$WORK/manifest"
leak_scan RL-leak-probe-cache "the daemon probe cache"           "$WORK/cache"
for scan_dir in jf-config plex-config emby-config; do
  docker run --rm -v "$WORK/$scan_dir:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
    sh /out/leakcheck.sh "a media server's library state" /out/leak-needles.txt \
    || { record RL-leak-library-state bool 0 "" "a media server persisted a secret, reference or label" \
         || true; die "a media server's library state holds a secret, a reference or the operator's label"; }
done
record RL-leak-library-state bool 1 "" "all three servers' library state, searched in full"

# THE PRESERVED EVIDENCE IS SEARCHED TOO, because it is the one thing that outlives the run. It has been
# written straight into this directory from the first verdict, so there is no copy step here that could have
# failed and left the search looking at a file the run never wrote.
leak_scan RL-leak-evidence "the preserved evidence" "$EVIDENCE_DIR"

# AND THE PROVIDER REALLY WAS CONTACTED, or every search above was a search for a secret that never existed
# and every byte in this run came from somewhere the gate did not look.
RESOLUTIONS="$(resolver_resolutions)"
record RL-resolutions-happened ge "${RESOLUTIONS:-0}" 1 \
  "access material was minted against the real provider during this run" || true
test "${RESOLUTIONS:-0}" -ge 1 \
  || die "the resolver never resolved anything, so nothing here was a real-provider read"

# ----------------------------------------------------------------------------------------------------------
step "TEARDOWN — the namespace goes away with three media servers holding it"
# ----------------------------------------------------------------------------------------------------------
docker rm -f "$PLEX_CONTAINER" "$JF_CONTAINER" "$EMBY_CONTAINER" >/dev/null 2>&1 || true
stop_resolver
docker stop -t 30 "$MOUNT_CONTAINER" >/dev/null 2>&1 || true
docker rm -f "$MOUNT_CONTAINER" >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true

# ----------------------------------------------------------------------------------------------------------
step "CLEANUP — a success condition of this run, not a report about it"
# ----------------------------------------------------------------------------------------------------------
# THE EXIT TRAP CAN ONLY REPORT, so the success path cleans up HERE, where a failure is a failure.
projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true
LEFT_MOUNTS="$(projection_gate_mounts_under "$WORK")"
record RL-own-mountpoints-removed eq "${LEFT_MOUNTS:-1}" 0 \
  "mountpoints left under this run's own directory" || true
record RL-own-run-directory-removed bool "$( [ ! -d "$WORK" ] && echo 1 || echo 0 )" "" \
  "this run's own directory, asserted gone rather than reported" || true
CLEANED=1

host_containers > "$GATE_ROOT/host-containers-after-$$.txt"
host_networks   > "$GATE_ROOT/host-networks-after-$$.txt"
host_volumes    > "$GATE_ROOT/host-volumes-after-$$.txt"
compare_sets() {
  local id="$1" what="$2" before="$3" after="$4"
  if diff -q "$before" "$after" >/dev/null 2>&1; then
    record "$id" bool 1 "" "the same $what before and after, compared as SETS rather than as counts"
  else
    record "$id" bool 0 "" "the $what on this host changed across the run" || true
    diff "$before" "$after" >&2 || true
    die "this run changed the host's $what"
  fi
}
# THE BEFORE-SETS WERE IN THE RUN DIRECTORY, WHICH THE CLEANUP ABOVE HAS JUST REMOVED — so they are copied
# out before it runs. A comparison whose left-hand side the gate deleted is not a comparison.
compare_sets RL-host-container-set-unchanged "containers" \
  "$GATE_ROOT/host-containers-before-$$.txt" "$GATE_ROOT/host-containers-after-$$.txt"
compare_sets RL-host-network-set-unchanged "networks" \
  "$GATE_ROOT/host-networks-before-$$.txt" "$GATE_ROOT/host-networks-after-$$.txt"
compare_sets RL-host-volume-set-unchanged "volumes" \
  "$GATE_ROOT/host-volumes-before-$$.txt" "$GATE_ROOT/host-volumes-after-$$.txt"
rm -f "$GATE_ROOT/host-containers-before-$$.txt" "$GATE_ROOT/host-networks-before-$$.txt" \
      "$GATE_ROOT/host-volumes-before-$$.txt" \
      "$GATE_ROOT/host-containers-after-$$.txt" "$GATE_ROOT/host-networks-after-$$.txt" \
      "$GATE_ROOT/host-volumes-after-$$.txt"

# ----------------------------------------------------------------------------------------------------------
step "the report, the closure check, and the nonclaims"
# ----------------------------------------------------------------------------------------------------------
# THE REDACTION CHECK COMES AFTER THE CLEANUP VERDICTS, not before them, because the file it checks is the
# one that outlives the run and the last four ids in it are written by the cleanup itself. Checking it
# earlier would have been checking a prefix.
npx tsx src/ops/projection-reliability-loop-cli.ts redaction-check --file "$RESULTS_REL" \
  || die "the preserved verdict log is not redaction-safe"
npx tsx src/ops/projection-reliability-loop-cli.ts report --results "$RESULTS_REL" --cycles "$CYCLES_REL"
npx tsx src/ops/projection-reliability-loop-cli.ts close --results "$RESULTS_REL" --cycles "$CYCLES_REL" \
  || die "the run did not satisfy the predeclared closure rule"

echo
echo "RELIABILITY LOOP gate PASSED. Exactly what was proved:"
echo "  - $RL_CYCLES_PER_RUN cycles, one per arm, in the order the contract names, each with all four phases."
echo "  - THREE REAL, DIGEST-PINNED MEDIA SERVERS on ONE production projectiond mount over a REAL PROVIDER,"
echo "    each catalogueing the shared namespace through its OWN ordinary-file predicate and each reading the"
echo "    operator's approved windows INSIDE ITS OWN CONTAINER as its own uid."
echo "  - the operator's windows digest-compared against values recorded OUTSIDE the mount, before AND after"
echo "    every fault, with zero library churn on all three."
echo "  - every recovery inside a budget derived from the product's own constants."
echo "  - the host's container, network and volume SETS identical before and after, and this run's own"
echo "    mountpoints and directory ASSERTED gone rather than reported."
echo
echo "WHAT THIS GATE DOES NOT PROVE, AND WILL NOT BE PRESENTED AS PROVING:"
npx tsx src/ops/projection-reliability-loop-cli.ts nonclaims
