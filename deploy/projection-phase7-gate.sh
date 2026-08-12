#!/usr/bin/env bash
# PROJECTION PHASE 7 - THE OPERATOR-USABLE ALPHA. Phase 6's BOUNDED AUTOMATIC RECOVERY, done to a mount that
# THREE REAL MEDIA SERVERS are attached to and PLAYING REAL PROVIDER BYTES through - and then asked to keep
# playing.
#
# WHY IT EXISTS, IN ONE PARAGRAPH. Phase 6 closed naming this gap in its own section 12.6: "no media server
# was in any Phase 6 run". Every one of its thirteen recovery arms used a single unprivileged byte-reading
# consumer. Phase 2's worst defect was `--auto-remount` recovering the namespace FOR THE DAEMON AND FOR
# NOBODY ELSE - the daemon logged success, /readyz said ready, and no consumer could see a file - and a
# supervisor that calls that same remount for a SECOND reason inherits the whole of that risk. The only
# instrument that has ever been able to see it is a real consumer reading through its own bind afterwards.
#
# THE CONTRACT AND ITS THRESHOLDS WERE WRITTEN DOWN BEFORE ANY OF THIS RAN.
# `docs/PROJECTION_PHASE_7_OPERATOR_USABLE_ALPHA.md` is the contract; `src/core/projection/phase7.ts` is the
# same thresholds as code, and THIS SCRIPT RESTATES NONE OF THEM - it evaluates them out of that module once,
# at the top, so a budget cannot drift between the document, the module and the shell.
#
# THE TOPOLOGY IS PHASE 3's, UNCHANGED, WITH PHASE 6's DAEMON FLAGS:
#
#   * ONE PostgreSQL, ONE publisher, ONE admitted generation, ONE production projectiond, ONE FUSE mount and
#     THREE real digest-pinned media servers holding the SAME mount as the SAME library root - G18's
#     arrangement with G18's own drivers, observer and overlap analysis, imported rather than reimplemented;
#   * the TorBox real gate's arrangement for reaching a real provider: the resolver container joins the
#     DAEMON'S network namespace, so it is never published to a host port and the TorBox API key exists only
#     inside it;
#   * and `--auto-remount --auto-recover`, which is exactly what `docker-compose.projection-alpha.yml` ships.
#
# WHAT IS NEW HERE AND NOWHERE ELSE. The mount-layer count. Phase 6 section 9.7 measured that a recovery
# STACKS OVER the corpse rather than removing it and named removing them as next work; this gate counts the
# layers at the projected mount point, ABOVE the floor of whatever was already mounted there before the
# daemon started, after EVERY arm and once at the end. An appliance that grows a dead layer per fault
# eventually meets Phase 6 section 9.6 - a mount point nothing can bind - with no operator involved.
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

COMPOSE_FILE="docker-compose.projection-phase7.yml"
NETWORK="projection-phase7-gate"
PG_PORT="${PROJECTION_PHASE7_GATE_PG_PORT:-5620}"
JF_PORT="${PROJECTION_PHASE7_GATE_JELLYFIN_PORT:-8190}"
EMBY_PORT="${PROJECTION_PHASE7_GATE_EMBY_PORT:-8191}"
RESOLVER_PORT="${PROJECTION_PHASE7_GATE_RESOLVER_PORT:-8192}"
PLEX_PORT="${PROJECTION_PHASE7_GATE_PLEX_PORT:-32570}"
DAEMON_STATUS_PORT=9099

MOUNT_CONTAINER="projection-p7-mount-$$"
JF_CONTAINER="projection-p7-jellyfin-$$"
PLEX_CONTAINER="projection-p7-plex-$$"
EMBY_CONTAINER="projection-p7-emby-$$"
# THE RESOLVER IS RECREATED, NOT RESTARTED, AND ITS NAME CARRIES A SEQUENCE. It joins the daemon's network
# namespace with `--network container:<daemon>`, so every daemon restart destroys the namespace it is living
# in. A restarted daemon therefore needs a NEW resolver container bound to the new sandbox, and a fresh name
# is what stops `Conflict. The container name ... is already in use` — the defect the multi-frontend harness
# spent an arm discovering.
RESOLVER_SEQ=0
RESOLVER_CONTAINER=""
CONSUMER_PREFIX="projection-p7-consumer-$$"

GATE_ROOT="$PWD/.projection-phase7-gate"
REL_GATE_ROOT=".projection-phase7-gate"
REL=".projection-phase7-gate/run-$$"
WORK="$GATE_ROOT/run-$$"

GATE_SKIP_STATUS=77

# R6 NEEDS A MOUNT SYSCALL THAT FAILS, AND `nsenter` IS THE ONLY WAY TO PRODUCE ONE HERE.
#
# `/dev/null` over `/dev/fuse` INSIDE THE SUBJECT CONTAINER'S OWN mount namespace, which dies with the
# container and cannot reach the host. A host without `nsenter` makes that arm impossible, and THIS GATE HAS
# NO OPTIONAL ARMS: the arm fails with the reason rather than skipping, because a skip is a failure here.
#
# ...AND `nsenter -m` ALONE IS NOT ENOUGH, WHICH PHASE 6's SECOND TOWER RUN IS WHAT TAUGHT US. Entering the
# namespace makes the kernel resolve the command in the TARGET's filesystem, and the runtime stage of this
# image is distroless: no shell, no `mount`, nothing but the daemon. So a digest-pinned static busybox is
# copied in first and the injector runs THAT.
P7_BUSYBOX_IMAGE="busybox@sha256:0872fb3a7632ba9d0ae46a8e832a62b30ce83a6f220b8bb52903d9cf477dabe3"
P7_HAS_NSENTER=0
command -v nsenter >/dev/null 2>&1 && P7_HAS_NSENTER=1
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
RESULTS_REL="$REL_GATE_ROOT/evidence/verdicts-$$.jsonl"
ARMS_REL="$REL_GATE_ROOT/evidence/arms-$$.jsonl"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_PHASE7_GATE_PG_PORT="$PG_PORT"

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
  for leftover in $(docker ps -aq --filter "name=^projection-p7-resolver-$$-" 2>/dev/null); do
    docker rm -f "$leftover" >/dev/null 2>&1 || true
  done
  docker rm -f "$MOUNT_CONTAINER" >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  # THE RECORDER IS REMOVED LAST OF THIS SET AND ONLY HERE, in the EXIT trap, because every verdict this run
  # will ever write has already been written by the time the trap runs. Removing it any earlier is the defect
  # this line exists because of: the run that deleted its own recorder and then tried to record four more.
  rm -f "$GATE_ROOT/host-containers-before-$$.txt" "$GATE_ROOT/host-networks-before-$$.txt" \
        "$GATE_ROOT/host-volumes-before-$$.txt" "$GATE_ROOT/host-containers-after-$$.txt" \
        "$GATE_ROOT/host-networks-after-$$.txt" "$GATE_ROOT/host-volumes-after-$$.txt" \
        "$GATE_ROOT/record-$$.cjs" 2>/dev/null || true
  if [ "$CLEANED" -eq 0 ] && [ -n "${WORK:-}" ]; then
    # THE VERDICT LOG NEEDS NO PRESERVING BECAUSE IT WAS NEVER IN THE RUN DIRECTORY. What a failing run
    # leaves behind is exactly what it had recorded when it died — gate ids, gate-chosen names, offsets,
    # byte counts and verdicts, which structurally cannot hold a secret, a reference or a provider filename.
    if [ -s "$GATE_ROOT/evidence/verdicts-$$.jsonl" ]; then
      echo "  evidence from the FAILED run is at $REL_GATE_ROOT/evidence/verdicts-$$.jsonl" >&2
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
         "$WORK/blocker-cache" \
         "$WORK/inprog" "$WORK/daemon-inputs" "$WORK/consumer" \
         "$WORK/jf-config" "$WORK/jf-cache" "$WORK/plex-config" "$WORK/plex-transcode" "$WORK/emby-config"
# THE PATH INTO THE PERMISSIVE DIRECTORIES MUST BE TRAVERSABLE BY A UID THAT DID NOT CREATE IT — 0755 and not
# 0777, because traversal is all that is needed, and explicit rather than inherited from the operator's
# umask, which at a hardened 077 leaves 0700 and a container running as uid 1000 outside.
chmod 755 "$GATE_ROOT" "$WORK"
chmod 777 "$WORK/cache" "$WORK/mnt" "$WORK/out" "$WORK/consumer" "$WORK/blocker-cache" \
          "$WORK/jf-config" "$WORK/jf-cache" "$WORK/plex-config" "$WORK/plex-transcode" "$WORK/emby-config"
chmod 755 "$WORK/inprog"
chmod 700 "$WORK/inputs" "$WORK/daemon-inputs"
# 0700, BECAUSE THIS IS THE ONE THING THE GATE DELIBERATELY LEAVES ON THE HOST. The gate root is 0755 so
# containers running as other uids can traverse it; without this the preserved evidence would be the only
# artifact of a real-provider run that every user on the host could read.
mkdir -p "$EVIDENCE_DIR"
chmod 700 "$EVIDENCE_DIR"
: > "$GATE_ROOT/evidence/verdicts-$$.jsonl"
: > "$GATE_ROOT/evidence/arms-$$.jsonl"
chmod 600 "$GATE_ROOT/evidence/verdicts-$$.jsonl" "$GATE_ROOT/evidence/arms-$$.jsonl"

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
P7_BUDGETS="$(npx tsx src/ops/projection-phase7-cli.ts budgets --sh)" \
  || die "the reliability-loop thresholds could not be read; nothing can be measured against nothing"
eval "$P7_BUDGETS"
npx tsx src/ops/projection-phase7-cli.ts budgets

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

# THE RECORDER LIVES OUTSIDE THE RUN DIRECTORY, FOR THE SAME REASON THE VERDICT LOG DOES — and it took a run
# that passed everything to notice the second half of that lesson.
#
# §9's fourth construction defect was a verdict LOG written into the directory the cleanup contract deletes.
# It was moved to `$GATE_ROOT/evidence/`; the PROGRAM that writes it was left behind. The last four verdicts
# of a run are `P7-host-*-set-unchanged`, `P7-own-mountpoints-removed` and `P7-own-run-directory-removed`,
# and every one of them is ABOUT the cleanup, so every one of them runs after it. On the first run that ever
# reached that point with everything else green, all of them died `MODULE_NOT_FOUND` on a recorder the run
# had just deleted, and a complete run failed on its own tidying-up.
#
# It goes beside the other per-run scratch this gate already keeps in the gate root — the six `host-*-$$.txt`
# set captures — and the EXIT trap removes it with them, so the gate root is still left empty.
cat > "$GATE_ROOT/record-$$.cjs" <<'RECORD'
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

cat > "$WORK/out/arm.cjs" <<'ARMLOG'
// One arm, appended as one JSON line. The closure check compares this SEQUENCE against the contract's arm
// order, so six entries all naming one arm cannot clear a count.
const { appendFileSync } = require('node:fs');
const [, , out, index, arm] = process.argv;
const n = Number(index);
if (!Number.isSafeInteger(n) || n < 1) { console.error('arm: not an arm index'); process.exit(1); }
if (!/^R[0-9]$/.test(String(arm))) { console.error('arm: not an arm id'); process.exit(1); }
appendFileSync(out, JSON.stringify({ index: n, arm }) + '
');
ARMLOG

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
// AND THE THREE DRIVERS SHIP TWO FILE FORMATS, WHICH COST A RUN. Jellyfin's and Emby's `appendResult`
// read the whole file, push and rewrite a JSON ARRAY; Plex's appends one JSON object per line. A reader
// that assumed the array threw on Plex's file, printed nothing, and — correctly, because absence is a
// failed measurement and not a zero — failed the two verdicts for a play whose own driver had just
// reported 1.42 s to first frame and 30 decoded seconds. Both shapes are read here rather than one being
// declared canonical, because neither driver is going to be rewritten for this.
const { readFileSync } = require('node:fs');
const [, , path, want] = process.argv;
let raw;
try {
  raw = readFileSync(path, 'utf8');
} catch { process.exit(0); }
let results;
try {
  const parsed = JSON.parse(raw);
  results = Array.isArray(parsed) ? parsed : [parsed];
} catch {
  try {
    results = raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  } catch { process.exit(0); }
}
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
const [, , objectsPath, credentialPath, secretPath, out, manifestOut] = process.argv;
const objects = JSON.parse(readFileSync(objectsPath, 'utf8'));
const refs = [];
const needles = [];
for (const object of objects) {
  refs.push(String(object.ref));
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
// THE MANIFEST'S LIST IS THE SAME ONE MINUS THE STABLE REFERENCES, AND THE MANIFEST IS THE ONLY PLACE THAT
// SUBTRACTION IS MADE. `HttpRangeLocator` is `{ endpointId, objectRef }` (`src/core/projection/manifest-v1.ts`),
// so the published manifest carries the reference BY CONTRACT — it is the control-plane document whose job is
// to name which object the daemon should resolve, and a manifest without it would name nothing. Searching the
// manifest for it is asking a document not to contain its own required field: a check that fails every
// correct run, which is what it did the first time the loop ever reached it.
//
// THE SUBTRACTION IS PAID FOR IMMEDIATELY, and by something stronger than what it removes. `refplacement.cjs`
// requires every occurrence of the reference in the manifest to BE a `locator.objectRef` value, so the
// reference in its contracted field passes and the reference smeared into a path, a label, a note, an id or
// a byte-identity fails. "It is in the manifest" was fatal and unpassable; "it is anywhere in the manifest
// except its own field" is fatal and passable, and it is the claim §6 actually wants.
//
// NOTHING ELSE LOSES A NEEDLE. The probe cache, all three media servers' library state and the preserved
// evidence are still searched for the reference, and the manifest is still searched for the operator's label
// and for both secrets.
const manifestNeedles = needles.filter((needle) => !refs.includes(needle));
if (manifestNeedles.length !== needles.length - refs.length) {
  console.error('needles: the manifest list is not the full list minus exactly the references');
  process.exit(1);
}
if (manifestNeedles.length < 1) {
  console.error('needles: the manifest list is empty, so scanning it would prove nothing');
  process.exit(1);
}
writeFileSync(manifestOut, `${manifestNeedles.join('\n')}\n`, { mode: 0o644 });
console.log(`  ${needles.length} needle(s): every reference, every label and both secrets`);
console.log(`  ${manifestNeedles.length} of them are searched for in the manifest; the references are `
  + 'asserted into their contracted field instead');
NEEDLES

cat > "$WORK/out/refplacement.cjs" <<'REFPLACE'
// WHERE THE STABLE REFERENCE IS ALLOWED TO BE, AND IT IS EXACTLY ONE FIELD.
//
// `HttpRangeLocator` is `{ endpointId, objectRef }`. The published manifest is the control-plane document
// that names which object the daemon must resolve, so it carries the reference BY CONTRACT and a manifest
// without it would name nothing. What must not happen is the reference reaching any other part of the
// document -- an entry path, an item id, a title, a note, a byte identity -- because those travel onward into
// three media servers' databases and into the preserved evidence, and section 2 keeps the operator's own
// label out of a path component for precisely that reason.
//
// SO THIS COUNTS RATHER THAN GREPS. Every occurrence of the reference in every manifest file is counted, the
// occurrences that ARE `locator.objectRef` values are counted separately, and the difference must be zero.
// A grep cannot make that distinction: it failed on the legitimate occurrence and an illegitimate one alike,
// which is what made the old check unpassable on every correct run.
//
// NOTHING IT LEARNS IS PRINTED. Counts only. The reference is read into memory, compared, and never emitted.
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');
const [, , objectsPath, manifestDir] = process.argv;
const refs = JSON.parse(readFileSync(objectsPath, 'utf8')).map((object) => String(object.ref));
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const files = walk(manifestDir);
// A SEARCH OVER NO FILES AGREES WITH ITSELF AT ZERO, which is the failure shape this gate keeps finding.
if (files.length < 1) {
  console.error('  refplacement: the manifest directory holds no files, so a clean result proves nothing');
  process.exit(2);
}
const occurrences = (haystack, needle) => {
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) count += 1;
  return count;
};
const locatorRefs = (node, out) => {
  if (Array.isArray(node)) { for (const item of node) locatorRefs(item, out); return; }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'locator' && value !== null && typeof value === 'object'
      && typeof value.objectRef === 'string') out.push(value.objectRef);
    locatorRefs(value, out);
  }
};
let total = 0;
let inLocator = 0;
let parsed = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const ref of refs) total += occurrences(text, ref);
  try {
    const document = JSON.parse(text);
    parsed += 1;
    const found = [];
    locatorRefs(document, found);
    for (const value of found) if (refs.includes(value)) inLocator += 1;
  } catch {
    // A FILE THAT DOES NOT PARSE IS NOT EXCUSED. Its occurrences are still counted into `total` above and
    // none of them can be accounted for, so an unparseable manifest file holding the reference FAILS here.
  }
}
const unaccounted = total - inLocator;
console.log('  manifest files ' + files.length + ', parsed ' + parsed + '; reference occurrences ' + total
  + ', of which ' + inLocator + ' are locator.objectRef values, leaving ' + unaccounted);
if (unaccounted !== 0) {
  console.error('  refplacement: the stable reference appears outside locator.objectRef, or inside a file '
    + 'that does not parse; the value itself is deliberately not printed');
  process.exit(1);
}
REFPLACE

cat > "$WORK/out/overlaptimeline.cjs" <<'OVERLAP'
// THE OVERLAP TIMELINE, KEPT WHEN THE OVERLAP ASSERTION FAILS -- and it is the A3 lesson applied to the one
// other place in this gate that dies holding its own diagnosis.
//
// The three-way scan observation runs with NO BARRIER, because a real provider has no control surface to
// rendezvous three scanners at. So whether all three are ever caught in flight on one tick is a property of
// how the three servers happen to be paced by the provider that day, and when it fails the ONLY thing that
// can say why is the timeline: which server started late, which finished before the third began, which tick
// saw what. `projection_gate_cleanup_run` deletes the run directory, so that timeline used to be destroyed
// by the same failure that made it worth reading.
//
// IT IS REBUILT RATHER THAN COPIED, and that is what makes it safe to keep from a FAILING run, where the
// leak scan has not run yet. Only ids, integers and booleans are emitted -- never a catalogue key, never a
// path, never a note, never a failure message, because a driver's error text is the one field here that
// could carry a URL. Like the cycles document in section 6, it structurally cannot hold a secret.
const { readFileSync, writeFileSync } = require('node:fs');
const scan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
// AN ABSENT `perServer` MEANS THIS PROGRAM IS READING A SHAPE IT DOES NOT UNDERSTAND, and a timeline kept
// without the per-server times is the "did not look" reading of an empty list. It refuses rather than
// filing a document that would be read as "no server reported anything".
if (!Array.isArray(scan.perServer) || !Array.isArray(scan.timeline)) {
  console.error('  overlaptimeline: the scan outcome has no perServer/timeline array; the shape has moved '
    + 'and a kept document would be missing exactly what it is kept for');
  process.exit(3);
}
const int = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null);
const flags = (value) => {
  const out = {};
  for (const [id, on] of Object.entries(value ?? {})) out[String(id)] = on === true;
  return out;
};
writeFileSync(process.argv[3], `${JSON.stringify({
  keptBecause: 'the three-way overlap assertion failed and the run directory is about to be removed',
  // `perServer` IS THE FIELD `ConcurrentScanOutcome` DECLARES, and the first draft of this program read
  // `outcomes` -- a name taken from the local variable inside `runConcurrentScans` rather than from the
  // interface it returns. It cost the first real failure this instrument was built for: the timeline came
  // out correct and `perServer: []`, so the per-server trigger and finish times -- exactly the stagger
  // evidence the arm needs -- were silently absent from the one document kept to explain the failure.
  // A MISSING FIELD IS NOT AN EMPTY ONE, so it is refused rather than defaulted.
  perServer: (scan.perServer ?? []).map((outcome) => ({
    id: String(outcome.id),
    triggeredAtMs: int(outcome.triggeredAtMs),
    finishedAtMs: int(outcome.finishedAtMs),
    elapsedSeconds: int(outcome.elapsedSeconds),
    observedInFlight: outcome.observedInFlight === true,
    // THE MESSAGE IS DROPPED AND ONLY ITS EXISTENCE IS KEPT. A driver's error text is the one field in this
    // document that could carry an address, and "there was a failure" is what the timeline needs from it.
    failed: outcome.failure !== undefined && outcome.failure !== null,
  })),
  timeline: (scan.timeline ?? []).map((sample) => ({
    atMs: int(sample.atMs),
    spanMs: int(sample.spanMs),
    inFlight: flags(sample.inFlight),
    inFlightCount: Object.values(flags(sample.inFlight)).filter(Boolean).length,
    unreadable: (sample.unreadable ?? []).map((id) => String(id)),
  })),
}, null, 2)}\n`);
const counts = (scan.timeline ?? []).map((s) => Object.values(flags(s.inFlight)).filter(Boolean).length);
console.log(`  the overlap timeline is kept: ${counts.length} sample(s), most servers in flight at once `
  + `${counts.length > 0 ? Math.max(...counts) : 0}`);
OVERLAP

cat > "$WORK/out/fuse-abort.sh" <<'FUSEABORT'
# TAKE THE MOUNT OUT FROM UNDER A LIVING DAEMON, WITH CONSUMERS HOLDING IT.
#
# WHY `umount -l` IS NOT ENOUGH HERE, AND A REAL RUN IS WHY. Phase 2's serve-death gate causes this fault
# with an external lazy unmount, and that works there because the only other thing in the run is a poller
# that holds no reference to the mount. THREE REAL MEDIA SERVERS DO. A lazy unmount detaches the mount from
# the namespaces it can reach, but the FUSE connection stays alive while anything still references the
# superblock — so on the first real run of this arm the daemon logged no serve death, `--auto-remount` had
# nothing to do, and the arm failed reporting a fault THAT HAD NEVER HAPPENED.
#
# THE FIX IS A STRONGER INJECTION, NOT A WEAKER ASSERTION. `/sys/fs/fuse/connections/<minor>/abort` is the
# kernel's own way to tear a FUSE connection down irrespective of who holds it, and it is exactly the death
# this arm names: the serve loop reads an error and the namespace is gone while the process lives.
#
# IT IS GUARDED TWICE AND REFUSES RATHER THAN GUESSES, because this host runs OTHER FUSE filesystems —
# `/mnt/user` is shfs — and aborting one of those would take the operator's array offline. A connection is
# only ever aborted when BOTH hold: its filesystem type is exactly `fuse.projectiond`, AND its mountpoint is
# underneath the run directory this gate was given. Anything else is left alone and reported.
#
# THE TWO PATHS ARE ARGUMENTS WITH THE REAL ONES AS DEFAULTS, so the offline suite can execute THESE BYTES
# against a crafted mount table and a fake connections tree. A program only a privileged container can run
# is a program only a privileged container has ever run — and this one writes to a kernel abort file, which
# is the last program in this repository that should be trusted on a reading.
set -eu
root="${1:-}"
mountinfo="${2:-/proc/self/mountinfo}"
connections="${3:-/sys/fs/fuse/connections}"
test -n "$root" || { echo "abort:no-root"; exit 1; }
test -r "$mountinfo" || { echo "abort:no-mountinfo"; exit 1; }
test -d "$connections" || { echo "abort:no-connections-dir"; exit 1; }

# mountinfo: id parent major:minor sourceroot mountpoint options... - fstype source superopts
# The optional fields between the options and the `-` are why the separator is found rather than counted.
# ONLY THE CONNECTION THE DAEMON IS ACTUALLY SERVING, WHICH IS THE TOPMOST MOUNT AT THE MOUNTPOINT.
#
# WHY NOT ALL OF THEM, AND A REAL RUN IS WHY. By the time this arm runs, earlier cycles have deliberately
# left CORPSES stacked at the same mountpoint — A2 SIGKILLs the daemon without unmounting and the restart
# stacks over what it left. Aborting every `fuse.projectiond` mount under the root therefore tore down two
# connections: the live one AND a corpse that was already dead. The arm's subject is "the mount taken out
# from under a LIVING daemon", so the corpse is not its business, and tearing down a stack of them is a
# fault nobody named.
#
# THE TOPMOST IS THE ONE WITH THE HIGHEST MOUNT ID. Mount ids increase monotonically, so the most recently
# stacked mount at a given mountpoint is the last one — which is exactly the one whose namespace a reader
# resolves to, and the one the daemon is serving. The count that was skipped is reported rather than
# silently dropped.
matched="$(awk -v root="$root" '
  {
    sep = 0
    for (i = 7; i <= NF; i++) if ($i == "-") { sep = i; break }
    if (sep == 0) next
    fstype = $(sep + 1)
    mountpoint = $5
    if (fstype != "fuse.projectiond") next
    if (mountpoint != root && index(mountpoint, root "/") != 1) next
    # THE TOP OF THE STACK IS THE ROW NOTHING ELSE CALLS ITS PARENT, AND IT IS NOT THE HIGHEST MOUNT ID.
    #
    # This used to sort by mount id and take the last, on the assumption that a mount created later carries
    # a higher id. THE KERNEL RECYCLES MOUNT IDS, so that assumption survives only until a host has churned
    # enough mounts -- and this one churns six daemon restarts per run. Run 2 of the first sequence to get
    # this far met a live mount at id 3234 stacked on a floor at id 3400: the abort chose the FLOOR, tore
    # down a corpse nobody was serving, and the arm then spent both of its bounded waits proving that a
    # daemon which had never been touched had not died. All three consumers read perfectly throughout,
    # which is exactly what a fault injected into the wrong connection looks like.
    #
    # mountinfo names the parent in field 2, so the stack is a chain and its top is the only row at this
    # mount point that no other row names as ITS parent. That is a fact about the topology rather than about
    # allocation order, and it cannot be recycled out from under this arm.
    #
    # (No apostrophes below this line or above it: this whole program is a single-quoted argument, and one
    # in a comment ends it. That cost the first attempt at this fix a shell syntax error at run time, which
    # the executed pin caught offline.)
    key = mountpoint SUBSEP $1
    dev[key] = $3
    at[key] = mountpoint
    isparent[mountpoint SUBSEP $2] = 1
  }
  END { for (k in dev) if (!(k in isparent)) print at[k], dev[k] }' "$mountinfo" \
  | awk '{ print $2 }' | sort -u)"

if [ -z "$matched" ]; then
  echo "abort:none"
  exit 1
fi

count=0
for majmin in $matched; do
  minor="${majmin#*:}"
  case "$minor" in
    ''|*[!0-9]*) echo "abort:bad-minor"; exit 1 ;;
  esac
  test -w "$connections/$minor/abort" || { echo "abort:not-writable"; exit 1; }
  echo "abort:choice majmin=$majmin minor=$minor"
  echo 1 > "$connections/$minor/abort"
  count=$(( count + 1 ))
done
echo "abort:done $count"
FUSEABORT

cat > "$WORK/out/mountrows.sh" <<'MOUNTROWS'
# THE MOUNT TABLE AT ONE PATH, IN ONE NAMESPACE, REDACTION-SAFE.
#
# WHY THIS EXISTS. Arm A3 has failed four times for reasons that could only be guessed at from outside, and
# every guess cost a fifteen-minute run. What decides the arm is which mounts exist at the projected path in
# the DAEMON's namespace, in the HOST's, and in each CONSUMER's — so the diagnostic prints exactly that.
#
# WHAT IT MAY EMIT. Mount id, parent id, major:minor and file-system type, and the mount point ONLY as the
# fixed token `<mountpoint>` or a suffix beneath it. The gate root is an operator path and the operator's own
# corpus label must never appear in evidence, so the path is matched and then replaced rather than printed.
set -eu
root="$1"
label="$2"
# THE TABLE IS A SEAM so the same program can read another namespace's, by path, from the host.
table="${MOUNTINFO:-/proc/self/mountinfo}"
if [ ! -r "$table" ]; then echo "  $label rows: NOT READ (no readable mount table)"; exit 0; fi
n=0
while IFS= read -r line; do
  case "$line" in
    *" $root "*|*" $root/"*) ;;
    *) continue ;;
  esac
  sep_seen=0
  fstype=""
  set -- $line
  id="$1"; parent="$2"; majmin="$3"; mountpoint="$5"
  for word in "$@"; do
    if [ "$sep_seen" = "1" ]; then fstype="$word"; break; fi
    if [ "$word" = "-" ]; then sep_seen=1; fi
  done
  case "$mountpoint" in
    "$root") shown="<mountpoint>" ;;
    *) shown="<mountpoint>${mountpoint#"$root"}" ;;
  esac
  n=$(( n + 1 ))
  echo "  $label row: id=$id parent=$parent dev=$majmin fstype=$fstype at=$shown"
done < "$table"
echo "  $label rows at the mount point or beneath it: $n"
MOUNTROWS

cat > "$WORK/out/probes.cjs" <<'PROBES'
// Turn one decoded-segment report per line into the JSON each server's own verifier reads.
//
// ONE CONTAINER DECODES EVERY SEGMENT AND WRITES ONE LINE PER FILE — `index|codec|packets|seconds`. This
// turns that into records and does no deciding: a segment that decoded as nothing at all still becomes a
// record with an empty codec and zero packets, so the verifier that holds them against the acceptance plan
// sees a FAILURE rather than an ABSENCE.
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

cat > "$WORK/out/countseeks.cjs" <<'COUNTSEEKS'
// HOW MANY DISTINCT MEDIA-TIME POSITIONS THIS SERVER ACTUALLY REACHED, counted from its own driver's output.
//
// IT COUNTS DISTINCT POSITIONS AND NOT RECORDS, because a server that ignored every position and returned
// the same segment ten times would produce ten records and has reached one position. The verifier that runs
// beside this makes the stronger temporal assertion; this is the count the contract's threshold compares.
const { readFileSync } = require('node:fs');
let document;
try { document = JSON.parse(readFileSync(process.argv[2], 'utf8')); } catch { console.log('0'); process.exit(0); }
const rows = Array.isArray(document) ? document
  : Array.isArray(document.seeks) ? document.seeks
  : Array.isArray(document.results) ? document.results : [];
// THE FIELD IS `requestedSeconds`, AND GUESSING AT IT COST THE FIRST REAL RUN THREE VERDICTS. Every shipped
// driver writes `{ index, requestedSeconds, serverPositionSeconds, elapsedMs, bytes, sha256 }`; this program
// asked for `positionSeconds` and found none, so it counted zero DISTINCT POSITIONS beside a verifier that
// had just passed every one of its own ten assertions — a gate reporting 0/10 over a product that had done
// the whole thing correctly.
//
// ...AND A DOCUMENT THAT CARRIES ROWS BUT NO USABLE POSITION NOW SAYS SO RATHER THAN ANSWERING ZERO, because
// a zero that means "the field is not there" and a zero that means "no position was reached" are the two
// readings this repository keeps confusing, and only one of them is about the product.
const positions = new Set();
for (const row of rows) {
  const at = row?.requestedSeconds ?? row?.serverPositionSeconds ?? row?.positionSeconds ?? row?.seconds;
  if (typeof at === 'number' && Number.isFinite(at)) positions.add(at);
}
if (rows.length > 0 && positions.size === 0) {
  console.error('countseeks: the driver wrote ' + rows.length + ' seek record(s) and none carries a '
    + 'position field this program knows; that is an unreadable measurement, not a count of zero');
  process.exit(1);
}
console.log(String(positions.size));
COUNTSEEKS

cat > "$WORK/out/soakseconds.cjs" <<'SOAKSECONDS'
// DECODED MEDIA TIME ACROSS EVERY TRANSCODED SEGMENT, from the decoder's own report and nothing else.
//
// A SEGMENT THAT DECODED AS NOTHING CONTRIBUTES NOTHING, which is the whole reason this sums the decoder's
// per-segment durations rather than counting files: a server can emit segments, and it can emit the same one
// repeatedly, and neither is decoded media time.
const { readFileSync } = require('node:fs');
let probes;
try { probes = JSON.parse(readFileSync(process.argv[2], 'utf8')); } catch { console.log('0'); process.exit(0); }
if (!Array.isArray(probes)) { console.log('0'); process.exit(0); }
let total = 0;
for (const probe of probes) {
  if (probe?.packets > 0 && Number.isFinite(probe?.seconds)) total += probe.seconds;
}
console.log(String(Math.floor(total)));
SOAKSECONDS

cat > "$WORK/out/playoverlap.cjs" <<'PLAYOVERLAP'
// DID AN INSTANT EXIST AT WHICH ALL THREE CONSUMERS WERE DECODING?
//
// THREE CONSUMERS LAUNCHED TOGETHER PROVE NOTHING IF TWO OF THEM DIED IN THE FIRST SECOND, and three that
// finished in the same minute prove nothing either. Each driver writes a progress trace — a list of records
// carrying a wall-clock stamp — and the only honest question is whether the three intervals INTERSECT.
//
// A TRACE THAT CANNOT BE READ IS A FAILURE AND NEVER AN EMPTY INTERVAL. Exit 1 says "no overlap was
// established", which is what the caller records; it never says "the files were fine and they did not
// overlap" about a file it could not open.
const { readFileSync } = require('node:fs');
const spanOf = (path) => {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  const rows = Array.isArray(document) ? document
    : Array.isArray(document.samples) ? document.samples
    : Array.isArray(document.records) ? document.records
    : Array.isArray(document.progress) ? document.progress : [];
  const stamps = rows
    .map((row) => row?.atUnixMs ?? row?.at ?? row?.wallMs ?? row?.timestamp)
    .map((value) => (typeof value === 'string' ? Date.parse(value) : value))
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (stamps.length < 2) throw new Error(`${path} carries fewer than two usable progress stamps`);
  return [Math.min(...stamps), Math.max(...stamps)];
};
try {
  const spans = process.argv.slice(2).map(spanOf);
  const start = Math.max(...spans.map((span) => span[0]));
  const end = Math.min(...spans.map((span) => span[1]));
  if (!(end > start)) {
    console.error(`no instant exists at which all ${spans.length} were decoding`);
    process.exit(1);
  }
  console.log(String(end - start));
} catch (error) {
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
}
PLAYOVERLAP

cat > "$WORK/out/probe-seeks.sh" <<'PROBESEEKS'
# EVERY SEEK'S SEGMENT DECODED, BY A DECODER, OUTSIDE THE PROCESS THAT FETCHED IT.
#
# "Playable video within ten seconds" is a decoder's answer; a 200 and a byte count are not one, and a
# segment that decodes as nothing is exactly what a seek to a position the server could not reach produces.
#
# THE FOURTH FIELD IS THE DECODED PICTURE'S OWN START TIMESTAMP, and it is the temporal evidence: a server
# that ignored the positions and returned the same segment ten times produces ten identical timestamps and
# fails the verifier, while passing every per-seek check it is possible to write.
set -eu
probe="$1"
dir="${SEGMENT_DIR:?SEGMENT_DIR must name this server's own segment directory}"
: > /work/out/seek-probes.txt
for file in "/work/$dir"/seek-*.ts; do
  [ -e "$file" ] || continue
  index=$(basename "$file" .ts | sed "s/^seek-//")
  codec=$("$probe" -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$file" 2>/dev/null | head -1 | tr -d " \r\n" || true)
  packets=$("$probe" -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 "$file" 2>/dev/null | head -1 | tr -d " \r\n" || true)
  start=$("$probe" -v error -select_streams v:0 -show_entries stream=start_time -of csv=p=0 "$file" 2>/dev/null | head -1 | tr -d " \r\n" || true)
  echo "${index#0}|${codec}|${packets:-0}|${start:-0}" >> /work/out/seek-probes.txt
done
PROBESEEKS

cat > "$WORK/out/probe-soak.sh" <<'PROBESOAK'
# THE SAME QUESTION FOR THE TRANSCODED SEGMENTS, and the duration is read per stream first because a
# container-level duration is absent on some of them and present on all of the rest.
set -eu
probe="$1"
dir="${SEGMENT_DIR:?SEGMENT_DIR must name this server's own segment directory}"
: > /work/out/soak-probes.txt
for file in "/work/$dir"/seg-*.ts; do
  [ -e "$file" ] || continue
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
# `dd` WITH A BYTE-GRANULAR SKIP, AND `tail -c +N | head -c L` IS WHAT IT REPLACES.
#
# THE DEFECT THAT COST A RUN, AND IT IS A FACT ABOUT ONE OF THE THREE IMAGES. `tail -c +N` on a seekable
# regular file seeks, in GNU coreutils. Emby's image ships BUSYBOX, whose `tail` READS AND DISCARDS the
# first N bytes — and the first window this corpus lists is at offset 1,576,983,267, because the operator
# records windows in descending order so that every fetch after the first is a genuinely backward-going
# ranged GET. So the very first in-container read streamed a gigabyte and a half of a 1.7 GB object through
# a FUSE mount, in busybox-sized chunks, and the run sat there: the daemon's own counters showed 4.4 TB of
# cache-served reads across 1,048,208 playback-cache hits by the time it was stopped. The PROVIDER cost
# stayed bounded — 261 misses, ~147 MB — because the playback cache absorbed it, which is the product
# working; the gate was the thing that was wrong.
#
# `dd ... iflag=skip_bytes,count_bytes` seeks and reads exactly one window on all three images. The
# capability is PROBED FIRST rather than assumed: a `dd` that ignored the flags would read from byte zero,
# digest something else, and fail as a mismatch — correct, but slowly and for the wrong stated reason. The
# probe makes it a named refusal in milliseconds instead.
cat > "$WORK/inprog/inread.sh" <<'INREAD'
set -eu
file="$1"
windows="$2"
test -f "$file" || { echo "inread:absent" ; exit 1; }
test -s "$windows" || { echo "inread:no-windows"; exit 1; }
# THE READ PRIMITIVE IS PROBED BEFORE IT IS TRUSTED, on input that costs nothing.
if ! dd if=/dev/zero of=/dev/null bs=8 skip=4 count=8 iflag=skip_bytes,count_bytes 2>/dev/null; then
  echo "inread:no-byte-granular-skip"
  exit 1
fi
# A WINDOW LIST WITH NO TRAILING NEWLINE DROPS ITS LAST RECORD IN EVERY READER, which would silently reduce
# a four-window check to three and still print inread:ok.
test -z "$(tail -c 1 "$windows")" || { echo "inread:unterminated-window-list"; exit 1; }
total=0
matched=0
while IFS=' ' read -r offset length want; do
  test -n "$offset" || { echo "inread:blank-window"; exit 1; }
  total=$(( total + 1 ))
  # THE BYTE COUNT IS CHECKED, NOT ONLY THE DIGEST. A short read digests something that is not the window,
  # which a comparison would report as a mismatch — true, and the wrong diagnosis. This names it.
  dd if="$file" bs=1048576 skip="$offset" count="$length" \
    iflag=skip_bytes,count_bytes of=/tmp/inread.window 2>/dev/null || true
  read_bytes="$(wc -c < /tmp/inread.window | tr -d ' ')"
  if [ "$read_bytes" != "$length" ]; then
    echo "inread:short-read $read_bytes/$length at $offset"
    rm -f /tmp/inread.window
    exit 1
  fi
  got="$(sha256sum < /tmp/inread.window | cut -d' ' -f1)"
  rm -f /tmp/inread.window
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
test "${WINDOW_COUNT:-0}" -ge "$P7_OPERATOR_WINDOWS_REQUIRED" \
  || die "the operator corpus carries $WINDOW_COUNT approved window(s), under the \
$P7_OPERATOR_WINDOWS_REQUIRED this contract needs to hold a byte-correctness claim"

node "$REL/out/config.cjs" "$REL/out/effective-endpoint.json" "$REL/config.json" \
  "$DAEMON_STATUS_PORT" "$P7_POLL_INTERVAL_MS" \
  || die "the daemon configuration could not be built"
# THE DAEMON'S POLL FLAG IS BUILT FROM THE SAME NUMBER `READY_BUDGET_MS` IS DERIVED FROM, so the interval the
# gate configures and the interval the budget assumes cannot drift apart.
DAEMON_POLL="$(( P7_POLL_INTERVAL_MS / 1000 ))s"
test "$(( P7_POLL_INTERVAL_MS % 1000 ))" -eq 0 \
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
# THE LIBRARY'S NAME IS WRITTEN ONCE, AND A6 IS WHY IT HAD TO BE. Plex's `bootstrap` builds a FRESH state
# and only recovers the section id when it is told which library to look for, so A6 has to name the same
# library the setup created. Spelled twice, the two would drift and the drift would surface as a 404 six
# cycles later.
LIBRARY_NAME="Projection Movies"
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
# WHEN THE DAEMON WAS STARTED, AND WHY THE RECOVERY CLOCK IS READ HERE RATHER THAN AT THE CALLER.
#
# `READY_BUDGET_MS` is derived as the pointer poll plus one read deadline — the two bounded waits between a
# DAEMON start and a namespace a sibling can read. Timing from before `restart_daemon` would have included
# `docker rm -f`, a `docker run`, and a `node:22-alpine` container booting `tsx` to serve the resolver: the
# gate's own orchestration, measured against the product's budget. The resolver is not on the path being
# measured either, because `await_path` is a metadata operation the daemon answers from memory with no
# provider contact at all.
DAEMON_STARTED_MS=""
start_daemon() {
  DAEMON_STARTED_MS="$(date +%s%3N)"
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
    --strict-direct-mount --auto-remount --auto-recover >/dev/null
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
  RESOLVER_CONTAINER="projection-p7-resolver-$$-$RESOLVER_SEQ"
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

# ...AND WHETHER A FRESH SIBLING CAN ACTUALLY READ A BYTE THROUGH IT, WHICH IS A DIFFERENT QUESTION AND IT
# IS THE ONE RECOVERY IS ABOUT.
#
# `await_path` is `test -f`, and THAT IS METADATA. A dead FUSE mount answers `stat` out of the kernel's
# attribute cache for a full `attrTimeout` after the connection is gone — the same warm-cache asymmetry
# §13.6 found inside the mount syscall itself, met here from the other side. A recovery clock built on it
# therefore starts and stops over a corpse. A3's first real execution recorded 695 ms from before the abort
# to "recovered", judged `P7-F-A3-remounted-in-place` against a daemon that had not remounted yet, and read
# the three consumers before the new mount had propagated into their namespaces. All three could read
# moments later — the gate's own diagnostic block printed exactly that, three lines under the FAIL it had
# already recorded. The product had done its job; the instrument could not see it.
#
# AN `open` IS WHAT A CORPSE REFUSES, so readiness is ONE BYTE READ by a fresh sibling, and it is read from
# the LOCAL SEED ENTRY rather than the operator's object. Three things follow from the seed, and each is a
# reason it is the seed and not the real path:
#   - it needs NO PROVIDER CONTACT, so `READY_BUDGET_MS`'s derivation — a pointer poll plus one read
#     deadline, with no endpoint on the path — stays the thing being measured;
#   - a poll loop cannot spend the operator's metered account, however long it waits;
#   - A4 can measure a daemon coming back DURING its own deliberate provider outage, where the remote path
#     is unreadable by design and a real-path probe would be measuring the outage instead.
# A fault aimed at the mount stops the seed too, which is §2's whole reason for having a control entry.
await_readable() {
  local attempts="${1:-240}" n=0
  while [ "$n" -lt "$attempts" ]; do
    if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
         dd "if=/mnt/$SEED_PATH" of=/dev/null bs=1 count=1 >/dev/null 2>&1; then
      return 0
    fi
    n=$((n + 1)); sleep 0.5
  done
  return 1
}

# HOW LONG IT TOOK FOR THE NAMESPACE TO BE READABLE BY A SIBLING AGAIN, in milliseconds, measured from a
# caller-supplied start. It is a SIBLING and not the daemon on purpose: `/readyz` answering ready is the
# claim Phase 2 found to be insufficient.
# IT STARTS EMPTY, NOT AT ZERO, AND EVERY CYCLE RESETS IT.
#
# THE DEFECT THIS CLOSES, FOUND BY READING THE ARMS AGAINST THE CLOSURE RULE RATHER THAN BY RUNNING THEM.
# `P7-R-ready-ms` is required once per cycle, and two of the six arms never set this variable — so cycles 4
# and 5 would have recorded the PREVIOUS cycle's recovery time as their own, against the right budget, and
# passed. A measurement carried over from another cycle is the same class as a step whose success does not
# depend on the thing it measures, and it is the one this repository keeps finding.
#
# Empty rather than -1 because `record.cjs` fails a measurement that is not a number, while `-1 <= 22000` is
# perfectly true. An arm that takes no measurement must fail, not pass by arithmetic.
RECOVERY_MS=""
await_recovery() {
  local started="$1"
  if [ -z "$started" ]; then
    RECOVERY_MS=""
    return 1
  fi
  if await_readable 240; then
    RECOVERY_MS=$(( $(date +%s%3N) - started ))
    return 0
  fi
  RECOVERY_MS=""
  return 1
}
recovered() { [ -n "$RECOVERY_MS" ]; }

# A daemon restart is three steps, always in this order, because the resolver lives in the daemon's network
# namespace and a restarted daemon has a new one.
restart_daemon() {
  stop_resolver
  docker rm -f "$MOUNT_CONTAINER" >/dev/null 2>&1 || true
  start_daemon
  start_resolver
}

record() { node "$REL_GATE_ROOT/record-$$.cjs" "$RESULTS_REL" "$@"; }

# ----------------------------------------------------------------------------------------------------------
# THE RECOVERY STATUS SURFACE, THE MOUNT TOPOLOGY, AND THE BINDS — the three things Phase 3 never had to read
# ----------------------------------------------------------------------------------------------------------
# EVERY FIELD BELOW IS READ FROM THE SHIPPED READINESS DOCUMENT, never inferred. Phase 6 §3.7 publishes six
# recovery fields as closed-set codes and numbers, and an arm that inferred a refusal from an unchanged
# counter would pass over a daemon that had published something else entirely.
READY_CODE=""; READY_REASON=""; READY_OBSERVED=""
REC_STATE=""; REC_REASON=""; REC_ATTEMPTS=""; REC_GENERATION=""; REC_OUTCOME=""; REC_REMEDIATION=""
sample() {
  if daemon_status "$WORK/out/readyz.json" && [ -s "$WORK/out/readyz.json" ]; then
    READY_CODE="200-or-503"
    READY_REASON="$(node "$REL/out/jq.cjs" readyReason < "$WORK/out/readyz.json" 2>/dev/null || true)"
    READY_OBSERVED="$(node "$REL/out/jq.cjs" mountObserved < "$WORK/out/readyz.json" 2>/dev/null || true)"
    REC_STATE="$(node "$REL/out/jq.cjs" recoveryState < "$WORK/out/readyz.json" 2>/dev/null || true)"
    REC_REASON="$(node "$REL/out/jq.cjs" recoveryReason < "$WORK/out/readyz.json" 2>/dev/null || true)"
    REC_ATTEMPTS="$(node "$REL/out/jq.cjs" recoveryAttempts < "$WORK/out/readyz.json" 2>/dev/null || true)"
    REC_GENERATION="$(node "$REL/out/jq.cjs" recoveryGeneration < "$WORK/out/readyz.json" 2>/dev/null || true)"
    REC_OUTCOME="$(node "$REL/out/jq.cjs" recoveryLastOutcome < "$WORK/out/readyz.json" 2>/dev/null || true)"
    REC_REMEDIATION="$(node "$REL/out/jq.cjs" recoveryRemediation < "$WORK/out/readyz.json" 2>/dev/null || true)"
  else
    # AN UNREACHABLE STATUS SURFACE IS AN ABSENT MEASUREMENT AND NEVER A ZERO. Every consumer of these
    # variables compares them, and a silent "" would compare as "not what was expected" rather than as
    # "nothing was read" — which is the difference this repository keeps finding in its own gates.
    READY_CODE=""; READY_REASON=""; READY_OBSERVED=""
    REC_STATE=""; REC_REASON=""; REC_ATTEMPTS=""; REC_GENERATION=""; REC_OUTCOME=""; REC_REMEDIATION=""
  fi
}

# WHAT THE TWO SUPERVISORS HAVE ACTUALLY DONE, READ FROM THE DAEMON'S OWN LOG RATHER THAN CAUGHT ON /readyz.
#
# The status surface publishes an action only WHILE IT IS IN FLIGHT — about a second — and every reading here
# costs a container start. Phase 6's second Tower run measured exactly that: the generation advanced 0 -> 1
# and the arm reported `sawAction=0`. The log lines are written by the supervisor at the moment it acts and
# are durable, so the fact is read where it cannot be missed.
serve_deaths()      { docker logs "$MOUNT_CONTAINER" 2>&1 | grep -c 'serve loop died' || true; }
# `remount attempt 1/3` occurs on THREE lines of one attempt, so an unanchored count reports one remount as
# three — measured on the real host during Phase 6's RC10. Anchoring counts the announcement and nothing else.
remount_starts()    { docker logs "$MOUNT_CONTAINER" 2>&1 | grep -cE 'remount attempt 1/3$' || true; }
recovery_actions()  { docker logs "$MOUNT_CONTAINER" 2>&1 | grep -cE 'projectiond: recovery: recover-' || true; }
recovery_last_action() {
  docker logs "$MOUNT_CONTAINER" 2>&1 | grep -oE 'projectiond: recovery: recover-[a-z-]+' | tail -1 \
    | sed 's/^projectiond: recovery: //'
}
recovery_refusals() {
  docker logs "$MOUNT_CONTAINER" 2>&1 | grep -cE 'projectiond: recovery not started: ' || true
}

# ----------------------------------------------------------------------------------------------------------
# THE MOUNT TOPOLOGY — the one measurement no earlier tranche has ever taken
# ----------------------------------------------------------------------------------------------------------
# PHASE 6 §9.7 MEASURED THAT A RECOVERY STACKS OVER THE CORPSE AND NAMED REMOVING THEM AS NEXT WORK. This is
# where that stops being a note and becomes a threshold.
#
# WHAT IS COUNTED, AND WHY IT IS COUNTED ON THE HOST. The daemon binds its mount `rshared`, so every layer it
# mounts propagates to the host at this run's own mount point — which is the whole reason a media server in
# another container can see the file. The host's mount table therefore carries one row per layer, and it is
# the view a consumer's bind is a slave of.
#
# IT COUNTS ONLY `fuse.projectiond` ROWS AT EXACTLY THIS PATH. A tmpfs stacked by R5 is not one of ours and
# must not be counted as one; a row BENEATH the mount point belongs to somebody else's filesystem.
count_our_layers() {
  # ONE LINE, BECAUSE A QUOTED PROGRAM SPLIT OVER TWO IS ONE `test/custody-runtime-closure.ts` CANNOT PARSE
  # — the same construction defect Phase 3 §9 recorded against a `node -e` and pinned a suite against.
  awk -v target="$WORK/mnt" '{ sep = 0; for (i = 1; i <= NF; i++) { if ($i == "-") { sep = i; break } } if ($5 == target && sep > 0 && $(sep + 1) == "fuse.projectiond") n++ } END { print n + 0 }' /proc/self/mountinfo
}
count_rows_at_mountpoint() {
  awk -v target="$WORK/mnt" '$5 == target { n++ } END { print n + 0 }' /proc/self/mountinfo
}
# THE FLOOR IS TAKEN BEFORE THE DAEMON HAS EVER MOUNTED, so it is a fact rather than an inference — the same
# discipline the daemon's own drain uses for `mountsAtStartup`.
MOUNT_LAYER_FLOOR=""
layers_above_floor() {
  if [ -z "$MOUNT_LAYER_FLOOR" ]; then echo ""; return 0; fi
  echo $(( $(count_our_layers) - MOUNT_LAYER_FLOOR ))
}

# ----------------------------------------------------------------------------------------------------------
# THE CONSUMERS' OWN BINDS — same containers, same mounts, never rebuilt
# ----------------------------------------------------------------------------------------------------------
# THE CLAIM THIS PAYS FOR IS "WITHOUT CONTAINER REBINDING OR RECREATION". A gate that quietly restarted a
# media server to make a recovery visible to it would be demonstrating the workaround rather than the
# product — which is Phase 2's worst defect wearing a hat. The fingerprint is the container's own id and its
# mount table, taken once before the first mount and compared after every arm.
bind_fingerprint() {
  local out="$1" server
  : > "$out"
  for server in $P7_SERVERS; do
    docker inspect "$(container_for "$server")" \
      --format "$server {{.Id}} {{.State.StartedAt}} {{range .Mounts}}{{.Source}}=>{{.Destination}}:{{.Mode}};{{end}}" \
      >> "$out" 2>/dev/null || echo "$server UNREADABLE" >> "$out"
  done
}

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

# ----------------------------------------------------------------------------------------------------------
step "THE THREE MEDIA SERVERS START FIRST, AND THE ORDER IS THE WHOLE OF WHETHER THEY SURVIVE A REMOUNT"
# ----------------------------------------------------------------------------------------------------------
# THIS ORDER IS A CORRECTION, AND IT COST TWO ARMS BEFORE IT WAS UNDERSTOOD.
#
# A consumer that binds `$WORK/mnt` while it is a PLAIN DIRECTORY binds a subtree of the parent filesystem
# and becomes a slave of the PARENT's peer group — so every later mount AT that path propagates into it. A
# consumer that binds the same path while a FUSE mount is already there binds THAT MOUNT, and is a slave of
# that mount's peer group only: once the mount is gone, nothing that happens at the path afterwards reaches
# it, because the new mount belongs to a peer group the container never joined.
#
# MEASURED ON THIS HOST, one daemon and two busybox consumers differing ONLY in when they attached:
#
#                                    bound the directory first   bound the mount itself
#   after the first mount                      reads                     reads
#   graceful stop, then restart                READS                     cannot read
#   external umount + --auto-remount           READS                     cannot read
#
# The daemon is correct in both columns — it logged the serve death and the remount, and a fresh reader saw
# the namespace every time. What differs is only which peer group the consumer's bind belongs to.
#
# WHY THE GATE USED TO START THEM LAST. Every Phase 1 data-plane gate starts its media server after the
# mount, and G12's SIGKILL recovery works there because a SIGKILL leaves a corpse and the restart STACKS
# over it — a new mount on the same mountpoint, inside the peer group the container did join. That path is
# unaffected by this ordering and still passes; it is the two paths that REMOVE the mount, which no Phase 1
# gate exercises with a consumer attached, that need the bind to follow the directory.
#
# THE BIND ITSELF IS UNCHANGED. Same source, same target, same `rslave`. Only the moment changes.
#
# AND IT IS THE PRODUCT'S RULE RATHER THAN THIS GATE'S HABIT. `PROJECTIOND_CONSUMER_ATTACHMENT` in
# `src/core/projection/runtime-contract.ts` and §11 of `docs/PROJECTION_PHASE_0_PRODUCT_CONTRACT.md` say a
# consumer SHALL bind the projected path before the daemon has ever mounted there; this gate is one instance
# of that requirement, not the reason for it. A gate that quietly started its consumers earlier would be
# tuning the experiment until it passed — which is why the rule is shipped, pinned, and cited here.
start_jellyfin
start_emby
start_plex
echo "  three media servers started, each bound to the projected path BEFORE anything is mounted there"

# THE THREE MEASUREMENTS THAT CANNOT BE TAKEN LATER, TAKEN HERE.
#
# CONSUMER ATTACHMENT is a fact about a moment that has already passed by the time anything is mounted, so it
# is recorded as this gate having done it in the order the product contract requires — and the ORDER is what
# `test/projection-phase7.ts` pins, because a gate that started its consumers after the mount would be tuning
# the experiment until it passed.
CONSUMERS_PRE_ATTACHED=0
if docker inspect -f '{{.State.Running}}' "$JF_CONTAINER" "$EMBY_CONTAINER" "$PLEX_CONTAINER" 2>/dev/null \
     | grep -qxc true >/dev/null 2>&1; then
  CONSUMERS_PRE_ATTACHED=1
fi
for _pre in "$JF_CONTAINER" "$EMBY_CONTAINER" "$PLEX_CONTAINER"; do
  [ "$(docker inspect -f '{{.State.Running}}' "$_pre" 2>/dev/null)" = "true" ] || CONSUMERS_PRE_ATTACHED=0
done

# ...AND THE FINGERPRINT OF WHAT THEY ARE HOLDING, which every arm is compared against. Same container ids,
# same start instants, same mounts: a recovery that needed a consumer restarted to become visible is the
# defect this whole line of work started from, and this is what makes the workaround detectable.
bind_fingerprint "$WORK/out/binds-before.txt"

# ...AND THE MOUNT-LAYER FLOOR. It is the count of OUR mounts at this run's mount point before this daemon
# has mounted anything, which on a fresh run is zero and is MEASURED rather than assumed — the same
# discipline `mountsAtStartup` uses inside the daemon, for the same reason: a floor nobody measured
# authorises nothing.
MOUNT_LAYER_FLOOR="$(count_our_layers)"
echo "  the mount-layer floor, taken before the daemon has mounted anything, is $MOUNT_LAYER_FLOOR"

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
  0) record P7-A-resolver-loopback-only bool 0 "" "the resolver accepted a TCP connection from the gate network" || true
     die "the resolver is reachable from the gate network; it must be loopback-only" ;;
  1) record P7-A-resolver-loopback-only bool 1 "" "refused at the transport from the gate network" ;;
  *) record P7-A-resolver-loopback-only bool 0 "" "the reachability probe could not take the measurement" || true
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


JF_BASE="http://127.0.0.1:${JF_PORT}"
EMBY_BASE="http://127.0.0.1:${EMBY_PORT}"
PLEX_BASE="http://127.0.0.1:${PLEX_PORT}"
JF_STATE="$REL/out/state-jellyfin.json"
EMBY_STATE="$REL/out/state-emby.json"
PLEX_STATE="$REL/out/state-plex.json"
# ...AND THE SAME FILE AS THE HOST SEES IT. The drivers run in containers and take the run-relative spelling;
# A6 reads the file itself, from the host, to assert the section id survived a restart.
PLEX_STATE_HOST="$WORK/out/state-plex.json"

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
# THE LOOPBACK BASE IS THE GATE'S OWN CONTROL PLANE ADDRESS AND IT IS NOT THE STREAM ADDRESS. The gate's
# drivers reach each server from the HOST over its published port; a CONSUMER container reaches it from
# inside the gate network, where 127.0.0.1 is the consumer. `stream_base_for` is the other one, and a helper
# that returned this for both is the defect the second real run died on.
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
jellyfin library --state "$JF_STATE"   --mount-path /media/projection/Movies --name "$LIBRARY_NAME"
emby     library --state "$EMBY_STATE" --mount-path /media/projection/Movies --name "$LIBRARY_NAME"
# PLEX LAST, AND THE ORDER IS LOAD-BEARING: creating a Plex section starts a scan of it immediately, so
# putting it last means the other two libraries already exist when that scan runs.
plex     library --state "$PLEX_STATE" --mount-path /media/projection/Movies --name "$LIBRARY_NAME"

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
  for server in $P7_SERVERS; do
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
  record P7-A-entry-is-decodable-video bool 1 "" "a decoder found a video stream in the projected entry"
  # THE MEDIA'S OWN DURATION, WHICH THE TEN SEEKS ARE SPREAD ACROSS. It is asked of the same decoder, in the
  # same pass, because a seek plan built against a guessed duration is a plan that seeks past the end.
  REAL_DURATION="$(docker run --rm --entrypoint "$GENERATOR_FFPROBE" -v "$WORK/mnt:/mnt:rslave" \
    "$GENERATOR_IMAGE" -v error -show_entries format=duration -of csv=p=0 "/mnt/$REAL_PATH" \
    2>/dev/null | head -1 | tr -d " \r\n")"
  REAL_DURATION_INT="${REAL_DURATION%%.*}"
  test "${REAL_DURATION_INT:-0}" -gt "$P7_TRANSCODE_DECODED_SECONDS_MIN" \
    || die "the operator's object is ${REAL_DURATION_INT:-0}s long, which is not longer than the \
five-minute window this contract asks three servers to play and transcode; that is a corpus problem and it \
belongs here with a name rather than three phases later inside a media server that gets blamed for it"
  echo "  the projected entry is ${REAL_DURATION_INT}s of decodable video"
else
  # `|| true` IS LOAD-BEARING HERE AND ITS ABSENCE COST A DIAGNOSIS. `record` returns non-zero for a failed
  # verdict, and under `set -e` that ended the run on this line — before the decoder's own words printed and
  # before `die` said what the failure meant. The one case this diagnostic exists for produced no
  # diagnostic, which is the same defect Phase 1 §6.15 #5 records one layer up.
  record P7-A-entry-is-decodable-video bool 0 "" "no video stream was found in the projected entry" || true
  echo "--- the decoder's own words, which are the diagnosis ---" >&2
  tail -5 "$WORK/out/ffprobe.err" >&2 || true
  # AND THEY ARE PRESERVED, because the cleanup contract removes the run directory on the way out and this
  # file is the only thing that says WHY. ffprobe's stderr names a path and an errno and nothing else: no
  # reference, no URL, no credential.
  if mkdir -p "$EVIDENCE_DIR" && chmod 700 "$EVIDENCE_DIR" \
    && cp "$WORK/out/ffprobe.err" "$EVIDENCE_DIR/ffprobe-$$.err" 2>/dev/null; then
    chmod 600 "$EVIDENCE_DIR/ffprobe-$$.err" 2>/dev/null || true
    echo "  the decoder's words are kept at $REL_GATE_ROOT/evidence/ffprobe-$$.err" >&2
  fi
  # AN EIO HERE IS ALMOST ALWAYS ONE THING, AND NAMING IT SAVES THE NEXT READER AN HOUR. The daemon refuses a
  # resolved URL whose origin is not in the operator's allowlist, and a debrid provider rotates its CDN
  # origins without notice — Phase 1 §6.16 recorded exactly this happening once already. The signature is a
  # `stat` that succeeds, a resolver that resolves, and every read failing EIO in well under a second.
  echo "  IF THOSE WORDS SAY I/O ERROR: the namespace is fine and the bytes are refused. Check whether the" >&2
  echo "  provider has rotated the CDN origin out of the operator's allowedOrigins — that is the egress" >&2
  echo "  allowlist working, not a product fault, and only the operator can refresh it." >&2
  die "the operator's object does not present as playable video through the mount; the acceptance plan's \
real-provider corpus is 1-3 files the operator is entitled to AND has chosen as playable video"
fi

# ----------------------------------------------------------------------------------------------------------
# THE PHASES
# ----------------------------------------------------------------------------------------------------------

# ----------------------------------------------------------------------------------------------------------
# THE PHASES — each is used by more than one stage, so each takes the id shape it is to record under
# ----------------------------------------------------------------------------------------------------------
# WHY THE IDS ARE PARAMETERS RATHER THAN LITERALS. Stage A, stage C and every arm ask the same three
# questions of the same three servers, and a copy per caller is three places for one check to rot. What
# differs between callers is only which id the answer is filed under, so that is what is passed.

CATALOGUE_ROUND=0
phase_catalogue() {
  local id="$1" suffix="$2" what="$3" server catalogue
  CATALOGUE_ROUND=$(( CATALOGUE_ROUND + 1 ))
  mkdir -p "$WORK/out/cat-$CATALOGUE_ROUND"
  # THREE SCANS ON ONE CLOCK, WITH NO BARRIER, AND THE ABSENCE IS RECORDED RATHER THAN GLOSSED. G18 holds a
  # provider read at its own fake endpoint so the three scanners rendezvous; a real provider has no control
  # surface, so `--no-barrier true` is passed and the outcome records `barrier: none`.
  drive concurrent-scan --no-barrier true \
    --state-jellyfin "$JF_STATE" --state-plex "$PLEX_STATE" --state-emby "$EMBY_STATE" \
    --out "$REL/out/scan-$CATALOGUE_ROUND.json" --catalogue-dir "$REL/out/cat-$CATALOGUE_ROUND" \
    --results "$REL/out/drive-$CATALOGUE_ROUND.json" \
    || { logs_tail "$MOUNT_CONTAINER"; die "$what: the three scans did not complete"; }
  for server in $P7_SERVERS; do
    catalogue="$REL/out/cat-$CATALOGUE_ROUND/catalogue-$server.json"
    if drive verify-corpus --server "$server" --catalogue "$catalogue" \
         --expect-file "$REL/out/expected.json" --results "$REL/out/drive-$CATALOGUE_ROUND.json"; then
      record "$id:$server$suffix" bool 1 "" \
        "every published identity at the published size as an ordinary file, through this server's own predicate"
    else
      record "$id:$server$suffix" bool 0 "" "this server's catalogue does not match" || true
      die "$what: $server did not catalogue the shared namespace"
    fi
  done
}

# THE OPERATOR'S WINDOWS, THROUGH THE MOUNT AND INSIDE EACH SERVER.
#
# THE ID ARGUMENTS ARE `-` WHERE A CALLER DOES NOT FILE THAT ANSWER, and `-` is the only spelling for it: an
# empty string would be indistinguishable from a variable that was never set, which is the class of defect
# this repository keeps finding in its own gates.
BYTES_ROUND=0
phase_bytes() {
  local win_id="$1" stat_id="$2" seed_id="$3" inread_prefix="$4" inread_suffix="$5" what="$6"
  local server matched problems statok verdict
  BYTES_ROUND=$(( BYTES_ROUND + 1 ))
  set +e
  timeout 900 node "$REL/out/verify.cjs" "$REL/out/corpus.json" "$REL/mnt" \
    "$REL/out/verify-$BYTES_ROUND.json"
  set -e
  matched="$(node "$REL/out/summary.cjs" "$REL/out/verify-$BYTES_ROUND.json" windowsMatched)"
  problems="$(node "$REL/out/summary.cjs" "$REL/out/verify-$BYTES_ROUND.json" problems)"
  statok="$(node "$REL/out/summary.cjs" "$REL/out/verify-$BYTES_ROUND.json" statOk)"
  if [ "$stat_id" != "-" ]; then
    record "$stat_id" bool "$( [ "${statok:-0}" = "$OBJECT_COUNT" ] && echo 1 || echo 0 )" "" \
      "an ordinary regular file at exactly the published size, by lstat so a symlink cannot pass" || true
  fi
  # BYTE CORRECTNESS IS FATAL WHERE A TIMING BUDGET IS NOT, and the asymmetry is deliberate: bytes that came
  # back wrong mean every later stage is reading a namespace whose correctness has already failed.
  record "$win_id" ge "$matched" "$P7_OPERATOR_WINDOWS_REQUIRED" \
    "operator windows digest-compared against values recorded OUTSIDE the mount before any run" \
    || die "$what: the operator's approved windows did not all match through the mount"
  test "${problems:-1}" -eq 0 || die "$what: a read through the mount reported a problem"

  if [ "$seed_id" != "-" ]; then
    # THE LOCAL CONTROL. A fault aimed at the remote path must not stop this one.
    if docker run --rm --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges \
         -v "$WORK/mnt:/mnt:rslave" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
         sh /out/baseline.sh "$SEED_PATH" >/dev/null 2>&1; then
      record "$seed_id" bool 1 "" "the local control entry still reads as an ordinary file"
    else
      record "$seed_id" bool 0 "" "the local control entry does not read" || true
    fi
  fi

  if [ "$inread_prefix" != "-" ]; then
    # AND EACH SERVER READS THE SAME WINDOWS ITSELF, in its own container, as its own uid.
    for server in $P7_SERVERS; do
      set +e
      verdict="$(timeout "$(( ( P7_READ_FAIL_BUDGET_MS * 2 ) / 1000 ))" \
        docker exec -u 1000:1000 "$(container_for "$server")" \
        sh /gate/inread.sh "/media/projection/$REAL_PATH" /gate/windows.txt 2>&1 | tail -1)"
      set -e
      case "$verdict" in
        inread:ok*)
          record "$inread_prefix:$server$inread_suffix" bool 1 "" \
            "this server's own container read the operator's windows and every digest matched" ;;
        inread:*)
          record "$inread_prefix:$server$inread_suffix" bool 0 "" \
            "this server's own container could not read the operator's windows correctly" || true ;;
        *)
          record "$inread_prefix:$server$inread_suffix" bool 0 "" \
            "the in-container read produced neither verdict, so nothing was measured" || true ;;
      esac
    done
  fi
}

phase_churn() {
  local suffix="$1" server before after churn
  for server in $P7_SERVERS; do
    before="$REL/out/cat-$(( CATALOGUE_ROUND - 1 ))/catalogue-$server.json"
    after="$REL/out/cat-$CATALOGUE_ROUND/catalogue-$server.json"
    set +e
    churn="$(node "$REL/out/churn.cjs" "$before" "$after")"
    set -e
    record "P7-arm-churn:$server$suffix" le "$churn" "$P7_LIBRARY_CHURN_MAX" \
      "items added or removed across the fault, on this server's own catalogue" || true
  done
}

# THE ADDRESS EACH SERVER'S STREAM IS REACHED AT, AND THE THREE ARE DELIBERATELY NOT ONE EXPRESSION.
#
#   JELLYFIN and EMBY by CONTAINER NAME on the gate network.
#   PLEX by ADDRESS, never by name: it answers 401 to a request whose Host header it does not recognise, and
#     `allowedNetworks` does not override it. That cost the Plex gate a whole run once, and the address is
#     read per call because a restarted container can come back on a different one. It is indexed by the
#     network's NAME rather than ranged over, because a `range` over `.NetworkSettings.Networks` glues every
#     address together the moment a second network is attached.
stream_base_for() {
  local server="$1" address
  case "$server" in
    jellyfin) echo "http://${JF_CONTAINER}:8096" ;;
    emby)     echo "http://${EMBY_CONTAINER}:8096" ;;
    plex)
      address="$(docker inspect "$PLEX_CONTAINER" \
        --format "{{index .NetworkSettings.Networks \"$NETWORK\" \"IPAddress\"}}" | tr -d " \r\n")"
      case "$address" in
        ""|*[!0-9.]*) die "Plex has no bare IPv4 address on $NETWORK: '$address'" ;;
      esac
      echo "http://${address}:32400"
      ;;
    *) die "unknown server $server" ;;
  esac
}

# ONE SERVER'S PACED DIRECT PLAY, LAUNCHED IN THE BACKGROUND SO ALL THREE CAN BE IN FLIGHT AT ONCE.
#
# ...AND EMBY TAKES ONE FLAG THE OTHER TWO DO NOT: `--local-work-dir`, the spelling THIS process opens, next
# to `--work-dir`, the spelling Docker bind-mounts. Using one for both is what killed the Emby gate's first
# complete run twenty minutes in.
start_paced_play() {
  local server="$1" label="$2"
  if [ "$server" = "emby" ]; then
    npx tsx "$(cli_for "$server")" paced-play \
      --state "$(state_for "$server")" --items "$REL/out/items-$server.json" \
      --key "$REAL_FILE" --seconds "$P7_PLAY_DECODED_SECONDS_MIN" \
      --image "$GENERATOR_IMAGE" --ffmpeg "$GENERATOR_FFMPEG" --network "$NETWORK" \
      --container-name "$CONSUMER_PREFIX-$server-$label" \
      --work-dir "$WORK/consumer" --local-work-dir "$REL/consumer" \
      --output-rel "play-$server-$label.mp4" --stream-base "$(stream_base_for "$server")" \
      --trace "$REL/out/play-trace-$server-$label.json" \
      --results "$REL/out/play-$server-$label.json" > "$WORK/out/play-log-$server-$label.txt" 2>&1
  else
    npx tsx "$(cli_for "$server")" paced-play \
      --state "$(state_for "$server")" --items "$REL/out/items-$server.json" \
      --key "$REAL_FILE" --seconds "$P7_PLAY_DECODED_SECONDS_MIN" \
      --image "$GENERATOR_IMAGE" --ffmpeg "$GENERATOR_FFMPEG" --network "$NETWORK" \
      --container-name "$CONSUMER_PREFIX-$server-$label" --work-dir "$WORK/consumer" \
      --output-rel "play-$server-$label.mp4" --stream-base "$(stream_base_for "$server")" \
      --trace "$REL/out/play-trace-$server-$label.json" \
      --results "$REL/out/play-$server-$label.json" > "$WORK/out/play-log-$server-$label.txt" 2>&1
  fi
}

# ALL THREE AT ONCE, AND THE OVERLAP IS THE POINT RATHER THAN THE SAVING.
#
# THREE SERVERS TAKING TURNS IS NOT THREE SERVERS CONCURRENT, and the difference is the whole of stage C.
# Running the three paced plays in parallel puts three real decoders on one mount, one cache and one provider
# lease at the same instant — which is the state an operator's appliance is actually in, and the one no
# earlier tranche has ever measured against a real provider. The overlap is then a MEASUREMENT taken from the
# three traces rather than an assumption about how fast each finished.
PLAY_OVERLAPPED=0
play_all_three() {
  local label="$1" id_prefix="$2" server pid status startup decoded failed=0
  local pids="" servers=""
  for server in $P7_SERVERS; do
    start_paced_play "$server" "$label" &
    pids="$pids $!"
    servers="$servers $server"
  done
  # EVERY CHILD IS WAITED FOR INDIVIDUALLY, because `wait` with no argument returns the status of the last one
  # only — and a gate that read one exit code for three plays would report two failures as a pass.
  set -- $pids
  for server in $servers; do
    pid="$1"; shift
    set +e
    wait "$pid"
    status=$?
    set -e
    startup="$(node "$REL/out/playfigures.cjs" "$REL/out/play-$server-$label.json" startupSeconds 2>/dev/null || true)"
    decoded="$(node "$REL/out/playfigures.cjs" "$REL/out/play-$server-$label.json" decodedSeconds 2>/dev/null || true)"
    if [ "$id_prefix" = "P7-B" ]; then
      record "P7-B-play-start-ms:$server" le "$startup" "$P7_PLAY_START_BUDGET_MS" \
        "from launching the consumer to its first decoded frame, with the other two also in flight" || true
      record "P7-B-play-decoded-seconds:$server" ge "$decoded" "$P7_PLAY_DECODED_SECONDS_MIN" \
        "media this server's own consumer actually decoded, not wall clock it spent" || true
    else
      record "$id_prefix:$server" bool "$( [ "$status" -eq 0 ] && echo 1 || echo 0 )" "" \
        "this server direct-played the object again through the bind it has held since before the first mount, without being restarted, re-bound or re-created"
    fi
    if [ "$status" -ne 0 ]; then
      failed=$(( failed + 1 ))
      tail -20 "$WORK/out/play-log-$server-$label.txt" >&2 || true
    fi
  done
  # THE OVERLAP, MEASURED FROM THE THREE TRACES RATHER THAN INFERRED FROM THE THREE LAUNCHES. Three consumers
  # started together prove nothing if two of them failed in the first second.
  PLAY_OVERLAPPED=0
  if node "$REL/out/playoverlap.cjs" "$REL/out/play-trace-emby-$label.json" \
       "$REL/out/play-trace-jellyfin-$label.json" "$REL/out/play-trace-plex-$label.json" >/dev/null 2>&1; then
    PLAY_OVERLAPPED=1
  fi
  return "$failed"
}

# TEN REAL MEDIA-TIME SEEKS, THROUGH THE SERVER'S OWN DRIVER AND VERIFIED BY ITS OWN VERIFIER.
#
# THIS IS NOT A RANGED READ AND THE DIFFERENCE IS THE GATE. A ranged GET proves the daemon serves byte offset
# N; this asks whether SECOND N of the media can be reached, which only the media server can answer — it
# demuxes, finds the position and starts an encode there, and the non-sequential multi-position reads that
# fall out of that are the read pattern this whole appliance exists to make cheap.
seeks_for() {
  local server="$1" seeks seek_status verify_status
  rm -rf "$WORK/out/seek-segments-$server"
  mkdir -p "$WORK/out/seek-segments-$server"
  chmod 777 "$WORK/out/seek-segments-$server"
  set +e
  npx tsx "$(cli_for "$server")" media-seeks --state "$(state_for "$server")" \
    --items "$REL/out/items-$server.json" --key "$REAL_FILE" \
    --duration-seconds "$REAL_DURATION_INT" --segment-dir "$REL/out/seek-segments-$server" \
    --out "$REL/out/seeks-$server.json" > "$WORK/out/seek-log-$server.txt" 2>&1
  seek_status=$?
  set -e
  if [ "$seek_status" -ne 0 ]; then
    tail -20 "$WORK/out/seek-log-$server.txt" >&2 || true
    record "P7-B-seeks:$server" eq 0 "$P7_SEEK_COUNT" \
      "this server's own driver could not complete its ten media-time seeks" || true
    return 0
  fi
  # EVERY SEEK'S SEGMENT DECODED, BY A DECODER, OUTSIDE THE PROCESS THAT FETCHED IT. A 200 and a byte count
  # are not a decoder's answer, and a segment that decodes as nothing is exactly what a seek to a position the
  # server could not reach would produce.
  docker run --rm --entrypoint /bin/sh -e SEGMENT_DIR="out/seek-segments-$server" \
    -v "$WORK:/work" "$GENERATOR_IMAGE" /work/out/probe-seeks.sh "$GENERATOR_FFPROBE" \
    > "$WORK/out/seek-probe-log-$server.txt" 2>&1 \
    || tail -10 "$WORK/out/seek-probe-log-$server.txt" >&2 || true
  node "$REL/out/probes.cjs" "$REL/out/seek-probes.txt" "$REL/out/seek-probes-$server.json" >/dev/null
  # A COUNT THAT COULD NOT BE TAKEN IS NOT A COUNT OF ZERO. `countseeks.cjs` exits non-zero when the driver
  # wrote records it cannot read a position out of, and the empty string that leaves here is what `record`
  # fails as "no finite measurement" rather than as ten seeks that did not happen.
  set +e
  seeks="$(node "$REL/out/countseeks.cjs" "$REL/out/seeks-$server.json" 2>&1)"
  if [ $? -ne 0 ]; then echo "  $seeks" >&2; seeks=""; fi
  set -e
  set +e
  npx tsx "$(cli_for "$server")" seek-verify --key "$REAL_FILE" \
    --seeks "$REL/out/seeks-$server.json" --probes "$REL/out/seek-probes-$server.json" \
    > "$WORK/out/seek-verify-$server.txt" 2>&1
  verify_status=$?
  set -e
  if [ "$verify_status" -ne 0 ]; then
    tail -20 "$WORK/out/seek-verify-$server.txt" >&2 || true
    record "P7-B-seeks:$server" eq 0 "$P7_SEEK_COUNT" \
      "this server's ten seeks did not satisfy its own verifier" || true
    return 0
  fi
  record "P7-B-seeks:$server" eq "${seeks:-0}" "$P7_SEEK_COUNT" \
    "distinct media-time positions this server reached and decoded, including backwards ones and one beyond 90 percent of duration, verified by this server's own verifier" || true
}

# A FORCED TRANSCODE, RUN AND CONSUMED FOR FIVE MINUTES, ONE SERVER AT A TIME.
#
# THE SERIALISATION IS PREDECLARED AND IT IS NOT A SAVING. Three simultaneous encodes measure this host's CPU
# rather than the appliance, and none of the drivers' continuity or late-window thresholds was written
# against a loaded host. The CONCURRENCY claim is carried by the three paced direct plays, which are byte
# passthrough and are run together on purpose.
#
# WHAT IT CLAIMS, EXACTLY: five minutes of PACED, CONTINUOUSLY DECODED, TRANSCODED playback. It does NOT claim
# five minutes of encoder CPU — Phase 1 measured the encoder finishing a short source in about 1.6 seconds and
# recorded it under that description.
transcode_for() {
  local server="$1" producer status decoded
  case "$server" in
    jellyfin)
      npx tsx "$(cli_for "$server")" configure-encoding --state "$JF_STATE" \
        --temp-path /cache/transcodes --throttle-seconds 30 || true
      producer="$REL/jf-cache/transcodes" ;;
    emby) producer="$REL/emby-config/transcoding-temp" ;;
    plex) producer="$REL/plex-transcode" ;;
    *) die "unknown server $server" ;;
  esac
  rm -rf "$WORK/out/soak-segments-$server"
  mkdir -p "$WORK/out/soak-segments-$server"
  chmod 777 "$WORK/out/soak-segments-$server"
  set +e
  npx tsx "$(cli_for "$server")" transcode-soak --state "$(state_for "$server")" \
    --items "$REL/out/items-$server.json" --key "$REAL_FILE" \
    --segment-dir "$REL/out/soak-segments-$server" --producer-dir "$producer" \
    --out "$REL/out/soak-$server.json" --seconds "$P7_TRANSCODE_DECODED_SECONDS_MIN" \
    > "$WORK/out/soak-log-$server.txt" 2>&1
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    tail -25 "$WORK/out/soak-log-$server.txt" >&2 || true
    record "P7-B-transcode-decoded-seconds:$server" ge 0 "$P7_TRANSCODE_DECODED_SECONDS_MIN" \
      "this server's forced transcode did not complete its own five-minute window" || true
    return 0
  fi
  docker run --rm --entrypoint /bin/sh -e SEGMENT_DIR="out/soak-segments-$server" \
    -v "$WORK:/work" "$GENERATOR_IMAGE" /work/out/probe-soak.sh "$GENERATOR_FFPROBE" \
    > "$WORK/out/soak-probe-log-$server.txt" 2>&1 \
    || tail -10 "$WORK/out/soak-probe-log-$server.txt" >&2 || true
  node "$REL/out/probes.cjs" "$REL/out/soak-probes.txt" "$REL/out/soak-probes-$server.json" >/dev/null
  decoded="$(node "$REL/out/soakseconds.cjs" "$REL/out/soak-probes-$server.json")"
  set +e
  if [ "$server" = "plex" ]; then
    npx tsx "$(cli_for "$server")" transcode-soak-verify --key "$REAL_FILE" \
      --items "$REL/out/items-$server.json" --soak "$REL/out/soak-$server.json" \
      --probes "$REL/out/soak-probes-$server.json" --producer-dir "$producer" \
      --seconds "$P7_TRANSCODE_DECODED_SECONDS_MIN" > "$WORK/out/soak-verify-$server.txt" 2>&1
  else
    npx tsx "$(cli_for "$server")" transcode-soak-verify --key "$REAL_FILE" \
      --items "$REL/out/items-$server.json" --soak "$REL/out/soak-$server.json" \
      --probes "$REL/out/soak-probes-$server.json" \
      --seconds "$P7_TRANSCODE_DECODED_SECONDS_MIN" > "$WORK/out/soak-verify-$server.txt" 2>&1
  fi
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    tail -25 "$WORK/out/soak-verify-$server.txt" >&2 || true
    record "P7-B-transcode-decoded-seconds:$server" ge 0 "$P7_TRANSCODE_DECODED_SECONDS_MIN" \
      "this server's forced transcode did not satisfy its own verifier" || true
  else
    record "P7-B-transcode-decoded-seconds:$server" ge "${decoded:-0}" \
      "$P7_TRANSCODE_DECODED_SECONDS_MIN" \
      "decoded h264 media time this server's transcode produced and a client consumed at a player's pace" \
      || true
  fi
  # THE TRANSCODING JOB IS GONE. A five-minute encode left running would occupy the machine for the rest of
  # the run, and every later measurement would be taken against a host under load.
  docker exec "$(container_for "$server")" sh -c 'rm -rf /cache/transcodes/* 2>/dev/null || true' \
    >/dev/null 2>&1 || true
}

# ----------------------------------------------------------------------------------------------------------
# THE SHARED PER-ARM VERIFICATION — §3.2 of the contract, and an arm that skips it proves nothing
# ----------------------------------------------------------------------------------------------------------
# A RECOVERY THAT SATISFIES THE DAEMON AND LOSES A MEDIA SERVER IS THE DEFECT THIS WHOLE LINE OF WORK STARTED
# FROM. So every arm — the ones that recover, the ones that refuse and the one that is a control — is followed
# by the same eight questions, asked of the same three servers that have been attached since before the first
# mount.
verify_after_arm() {
  local arm="$1" layers rows
  phase_bytes "P7-arm-windows:$arm" "P7-arm-stat:$arm" "P7-arm-seed:$arm" \
    "P7-arm-inread" ":$arm" "arm $arm"
  phase_catalogue P7-arm-catalogue ":$arm" "arm $arm"
  phase_churn ":$arm"
  # THE MOUNT TOPOLOGY. Phase 6 §9.7's rough edge, measured rather than described.
  layers="$(layers_above_floor)"
  rows="$(count_rows_at_mountpoint)"
  record "P7-arm-layers:$arm" le "$layers" "$P7_MOUNT_LAYERS_ABOVE_FLOOR_MAX" \
    "mounts of OURS stacked at the projected mount point above the floor of $MOUNT_LAYER_FLOOR taken before the daemon ever mounted; $rows row(s) of any kind are there" || true
  # THE CONSUMERS' OWN BINDS. Same containers, same mounts, never rebuilt by this gate.
  bind_fingerprint "$WORK/out/binds-$arm.txt"
  if cmp -s "$WORK/out/binds-before.txt" "$WORK/out/binds-$arm.txt"; then
    record "P7-arm-binds-unchanged:$arm" bool 1 "" \
      "the same three containers, started at the same instants, holding the same mounts as before the first mount"
  else
    record "P7-arm-binds-unchanged:$arm" bool 0 "" \
      "a consumer container or one of its mounts is not the one that was attached before the first mount" || true
    diff "$WORK/out/binds-before.txt" "$WORK/out/binds-$arm.txt" >&2 || true
  fi
}

# ----------------------------------------------------------------------------------------------------------
# THE SIX ARMS
# ----------------------------------------------------------------------------------------------------------

# THE CORPSE CHECK, from a sibling container, the same way the daemon's own probe looks at it: statfs — which
# FUSE never caches, so a dead connection answers ENOTCONN immediately — plus a mountinfo read that must still
# name the mount `fuse.projectiond`. A stale mount keeps statting fine while its attribute cache is warm, so a
# stat-based check would prove nothing.
corpse_is_stale() {
  local stderr count
  if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" df -P /mnt >/dev/null 2>&1; then
    echo "not-stale"; return 0
  fi
  stderr="$(docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" df -P /mnt 2>&1 || true)"
  # A MESSAGE IS NOT A CONTRACT, THE ERRNO IS — and shell cannot read one numerically here, so what is matched
  # is the SET of libc spellings of ENOTCONN. The pinned verify image is musl and says "Socket not connected";
  # glibc says "Transport endpoint is not connected". A wrong errno matches neither.
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

# THE SECOND PROJECTIOND, WHICH IS HOW A CORPSE IS PRODUCED WITHOUT KILLING THE SUBJECT.
#
# It is `RC4`'s own injector and the reasoning is Phase 6's: a second daemon is stacked ABOVE the subject and
# ITS connection is torn down, so what the subject OBSERVES is `stale-projectiond` while its own serve loop
# never notices — which is the whole point. That is the fault the SERVE supervisor cannot see, and therefore
# the one the recovery loop exists for.
BLOCKER_CONTAINER="projection-p7-blocker-$$"
start_blocker() {
  docker run -d --name "$BLOCKER_CONTAINER" \
    --network "$NETWORK" --user 0:0 \
    --cap-drop ALL --cap-add SYS_ADMIN --security-opt apparmor:unconfined \
    --device /dev/fuse:/dev/fuse \
    -v "$WORK/manifest:/var/lib/projectiond/manifest:ro" \
    -v "$WORK/media:/var/lib/projectiond/media:ro" \
    -v "$WORK/blocker-cache:/var/lib/projectiond/cache" \
    -v "$WORK/daemon-inputs:/var/lib/projectiond/inputs:ro" \
    -v "$WORK/config.json:/etc/projectiond/config.json:ro" \
    -v "$WORK/mnt:/mnt/projection:rshared" \
    "$IMAGE" --config /etc/projectiond/config.json --poll 60s >/dev/null
  # BOTH GUARDS: the count of OUR mounts at the path goes up AND the top of the stack is a different mount.
  # Either alone can be satisfied by something that is not the blocker landing.
  local before="$1" landed=0 n=0
  while [ "$n" -lt 120 ]; do
    if [ "$(count_our_layers)" -gt "$before" ]; then landed=1; break; fi
    n=$((n + 1)); sleep 0.5
  done
  if [ "$landed" -ne 1 ]; then
    docker logs "$BLOCKER_CONTAINER" 2>&1 | tail -10 | sed 's/^/  blocker: /' >&2 || true
    docker rm -f "$BLOCKER_CONTAINER" >/dev/null 2>&1 || true
    return 1
  fi
  return 0
}
stop_blocker() { docker rm -f "$BLOCKER_CONTAINER" >/dev/null 2>&1 || true; }

# HOW LONG THE SUPERVISOR IS GIVEN TO ACT, AND IT IS THE CONTRACT'S OWN BUDGET RATHER THAN A ROUND NUMBER.
# One extra second of polling slack is added so the LAST poll of the window is inside it; the budget itself is
# what the measurement is compared against, and that comparison is `record`'s.
await_recovery_action() {
  local before_generation="$1" deadline elapsed started
  started="$(date +%s%3N)"
  deadline=$(( started + P7_RECOVERY_ACTION_BUDGET_MS + 1000 ))
  while [ "$(date +%s%3N)" -lt "$deadline" ]; do
    sample
    if [ -n "$REC_GENERATION" ] && [ "$REC_GENERATION" != "$before_generation" ]; then
      echo $(( $(date +%s%3N) - started ))
      return 0
    fi
    sleep 1
  done
  echo $(( $(date +%s%3N) - started ))
  return 1
}

# ----------------------------------------------------------------------------------------------------------
arm_R1() {
  # THE MOUNT IS LOST BENEATH A LIVING DAEMON. The daemon's own mount is unmounted from the host; the process
  # is untouched, the serve loop is not killed, and what changes is only what is at the mount point.
  #
  # WHY LAZILY. Three real media servers are holding the mount, and an ordinary unmount cannot remove one
  # somebody is holding — measured on this host in Phase 3, where it returned having removed nothing. The
  # detach is guarded to this run's own mount point and nothing else.
  local generation_before attempts_before actions_before started action_ms ready_ms recovered_ok=0
  generation_before="$REC_GENERATION"
  attempts_before="${REC_ATTEMPTS:-0}"
  actions_before="$(recovery_actions)"
  started="$(date +%s%3N)"
  local layers_before
  layers_before="$(count_our_layers)"
  umount -l "$WORK/mnt" 2>/dev/null || true
  local gone=0 n=0
  while [ "$n" -lt 40 ]; do
    if [ "$(count_our_layers)" -lt "$layers_before" ]; then gone=1; break; fi
    n=$((n + 1)); sleep 0.5
  done
  record "P7-R1-fault-took-the-mount" bool "$gone" "" \
    "the projectiond mount is no longer at the mount point, and the daemon process is still running" || true

  set +e
  action_ms="$(await_recovery_action "$generation_before")"
  local acted=$?
  set -e
  sample
  record "P7-R1-action-ms" le "${action_ms:-}" "$P7_RECOVERY_ACTION_BUDGET_MS" \
    "from the fault to the recovery supervisor having spent an attempt on it" || true
  record "P7-R1-reason" bool "$( [ "$(recovery_last_action)" != "" ] && echo 1 || echo 0 )" "" \
    "the daemon named its decision on its own status surface and in its own log: reason='${REC_REASON:-none}' observation='${READY_OBSERVED:-none}' lastAction='$(recovery_last_action)'" || true
  record "P7-R1-remediation" bool \
    "$( [ "${REC_REMEDIATION:-}" = "none" ] || [ "${REC_REMEDIATION:-}" = "reset-recovery-ledger" ] && echo 1 || echo 0 )" "" \
    "the remediation an operator is told to perform is a closed-set code: '${REC_REMEDIATION:-absent}'" || true
  record "P7-R1-attempts" le "$(( $(recovery_actions) - actions_before ))" "$P7_SINGLE_FLIGHT_ACTIONS_MAX" \
    "recovery actions the daemon started for ONE fault" || true
  record "P7-R1-single-flight" le "$(( $(recovery_actions) - actions_before ))" \
    "$P7_SINGLE_FLIGHT_ACTIONS_MAX" \
    "exactly one supervisor acted: the recovery loop REQUESTS and the goroutine that owns the mount performs" || true
  record "P7-R1-generation" bool "$( [ "$acted" -eq 0 ] && echo 1 || echo 0 )" "" \
    "recoveryGeneration advanced from ${generation_before:-?} to ${REC_GENERATION:-?}, which is the daemon's own count of every attempt it has ever made" || true
  if await_readable 240; then recovered_ok=1; fi
  ready_ms=$(( $(date +%s%3N) - started ))
  record "P7-R1-ready-ms" le "$( [ "$recovered_ok" -eq 1 ] && echo "$ready_ms" || echo "" )" \
    "$P7_RECOVERY_READY_BUDGET_MS" \
    "from the fault to a sibling container reading a byte through the mount again" || true
  record "P7-R1" bool "$( [ "$gone" -eq 1 ] && [ "$acted" -eq 0 ] && [ "$recovered_ok" -eq 1 ] && echo 1 || echo 0 )" "" \
    "the mount lost beneath a living daemon, recovered by the recovery supervisor" || true
}

# ----------------------------------------------------------------------------------------------------------
arm_R2() {
  # A STALE / CORPSE FUSE CONNECTION, PRODUCED WITHOUT KILLING THE SUBJECT — `RC4`'s own injector.
  local generation_before actions_before started action_ms ready_ms recovered_ok=0 corpse layers_before
  generation_before="$REC_GENERATION"
  actions_before="$(recovery_actions)"
  layers_before="$(count_our_layers)"
  start_blocker "$layers_before" || die "R2: the second projectiond mount never landed above this run's own"
  local abort_out
  set +e
  abort_out="$(bash "$WORK/out/fuse-abort.sh" "$WORK/mnt" 2>&1)"
  set -e
  echo "$abort_out" | sed 's/^/  /' >&2
  case "$(echo "$abort_out" | tail -1)" in
    abort:done*) : ;;
    *) stop_blocker; die "R2: the corpse could not be produced ($(echo "$abort_out" | tail -1))" ;;
  esac
  stop_blocker
  started="$(date +%s%3N)"
  corpse="$(corpse_is_stale)"
  record "P7-R2-corpse-was-stale" bool "$( [ "$corpse" = "stale" ] && echo 1 || echo 0 )" "" \
    "statfs answers ENOTCONN while mountinfo still names fuse.projectiond, so what follows is about a corpse" || true

  set +e
  action_ms="$(await_recovery_action "$generation_before")"
  local acted=$?
  set -e
  sample
  record "P7-R2-action-ms" le "${action_ms:-}" "$P7_RECOVERY_ACTION_BUDGET_MS" \
    "from the corpse being produced to the recovery supervisor having spent an attempt on it" || true
  record "P7-R2-reason" bool "$( [ "$(recovery_last_action)" = "recover-stale-mount" ] && echo 1 || echo 0 )" "" \
    "the daemon's own log names the decision it acted on: '$(recovery_last_action)'" || true
  record "P7-R2-remediation" bool \
    "$( [ "${REC_REMEDIATION:-}" = "none" ] || [ "${REC_REMEDIATION:-}" = "reset-recovery-ledger" ] && echo 1 || echo 0 )" "" \
    "the remediation is a closed-set code: '${REC_REMEDIATION:-absent}'" || true
  record "P7-R2-attempts" le "$(( $(recovery_actions) - actions_before ))" "$P7_SINGLE_FLIGHT_ACTIONS_MAX" \
    "recovery actions the daemon started for ONE corpse" || true
  record "P7-R2-single-flight" le "$(( $(recovery_actions) - actions_before ))" \
    "$P7_SINGLE_FLIGHT_ACTIONS_MAX" "exactly one supervisor acted" || true
  record "P7-R2-generation" bool "$( [ "$acted" -eq 0 ] && echo 1 || echo 0 )" "" \
    "recoveryGeneration advanced from ${generation_before:-?} to ${REC_GENERATION:-?}" || true
  if await_readable 240; then recovered_ok=1; fi
  ready_ms=$(( $(date +%s%3N) - started ))
  record "P7-R2-ready-ms" le "$( [ "$recovered_ok" -eq 1 ] && echo "$ready_ms" || echo "" )" \
    "$P7_RECOVERY_READY_BUDGET_MS" \
    "from the corpse to a sibling container reading a byte through the mount again" || true
  record "P7-R2" bool "$( [ "$corpse" = "stale" ] && [ "$acted" -eq 0 ] && [ "$recovered_ok" -eq 1 ] && echo 1 || echo 0 )" "" \
    "this daemon's own stale mount stacked above the live one, recovered" || true
}

# ----------------------------------------------------------------------------------------------------------
arm_R3() {
  # THE CONTROL, AND ITS WHOLE ASSERTION IS AN ABSENCE. Phase 3's A4 injector, with one thing added: the
  # recovery generation must NOT move. A provider outage never touches the mount, and a supervisor that had
  # become trigger-happy fails here and nowhere else in this gate.
  local generation_before actions_before started trips slowest opened
  # THE ORDER OF THESE TWO STEPS IS THE WHOLE ARM. Access material is memory-only by contract, so a source
  # whose lease is still good never asks the resolver anything and an outage is invisible to it. The lease has
  # to be dropped, and the only way to drop it is to restart the daemon — which, because the resolver lives in
  # the daemon's network namespace, restarts the resolver too. And the resolver FAILS CLOSED at startup, so it
  # cannot be started with a credential it will refuse: restart BOTH while the credential is still good, and
  # break it immediately afterwards, BEFORE anything reads.
  restart_daemon
  await_recovery "$DAEMON_STARTED_MS" || die "R3: the namespace did not come back before the outage"
  sample
  generation_before="${REC_GENERATION:-0}"
  actions_before="$(recovery_actions)"
  chmod 0644 "$WORK/inputs/torbox-credential"

  trips=0; slowest=0
  while [ "$trips" -lt 8 ]; do
    timed_read
    trips=$(( trips + 1 ))
    if [ "$TIMED_READ_MS" -gt "$slowest" ]; then slowest="$TIMED_READ_MS"; fi
    if [ "$TIMED_READ_VERDICT" = "ok" ]; then break; fi
    if [ "$TIMED_READ_MS" -lt "$P7_BREAKER_REFUSAL_BUDGET_MS" ] && [ "$trips" -ge 6 ]; then break; fi
  done
  record "P7-R3-read-fail-ms" le "$slowest" "$P7_READ_FAIL_BUDGET_MS" \
    "the slowest failing read during the trip, against the product's own read deadline" || true

  timed_read
  opened=0
  if [ "$TIMED_READ_VERDICT" != "ok" ] && [ "$TIMED_READ_MS" -le "$P7_BREAKER_REFUSAL_BUDGET_MS" ]; then
    opened=1
  fi
  record "P7-R3-breaker-opened" bool "$opened" "" \
    "a read refused locally rather than attempted; nothing else answers this fast" || true
  record "P7-R3-refusal-ms" le "$TIMED_READ_MS" "$P7_BREAKER_REFUSAL_BUDGET_MS" \
    "an open breaker refuses before any admitted read could have got a slot" || true

  local baseline hold_until during
  baseline="$(resolver_requests)"
  hold_until=$(( $(date +%s%3N) + P7_HOLD_WINDOW_MS ))
  while [ "$(date +%s%3N)" -lt "$hold_until" ]; do
    timed_read
    if [ "$TIMED_READ_VERDICT" = "ok" ]; then
      die "R3: a read SUCCEEDED while the breaker was supposed to be open and the endpoint was supposed to be refusing every request"
    fi
    sleep 3
  done
  during="$(resolver_requests)"
  record "P7-R3-hold-resolver-requests" le "$(( during - baseline ))" "$P7_HOLD_RESOLVER_REQUESTS_MAX" \
    "requests reaching a live, logging resolver while the breaker is open, counted in its own log" || true

  # THE RELEASE, WITH THE REST OF THE COOLDOWN STILL TO RUN, so the breaker's one half-open probe meets a
  # working endpoint and closes on real evidence.
  chmod 0600 "$WORK/inputs/torbox-credential"
  started="$(date +%s%3N)"
  local readable_again=0 probes_before probes_after n=0
  probes_before="$(resolver_resolutions)"
  while [ "$n" -lt 40 ]; do
    timed_read
    if [ "$TIMED_READ_VERDICT" = "ok" ]; then readable_again=1; break; fi
    n=$((n + 1)); sleep 3
  done
  probes_after="$(resolver_resolutions)"
  record "P7-R3-recovery-ms" le "$(( $(date +%s%3N) - started ))" "$P7_OUTAGE_RECOVERY_BUDGET_MS" \
    "from the release to a read that succeeded and digest-matched" || true
  record "P7-R3-half-open-probes" ge "$(( probes_after - probes_before ))" "$P7_HALF_OPEN_PROBES" \
    "the half-open probe closing the breaker on real evidence" || true

  # ...AND THE ASSERTION THIS ARM EXISTS FOR.
  sample
  record "P7-R3-no-recovery-action" eq "$(( $(recovery_actions) - actions_before ))" 0 \
    "a provider outage never touches the mount, so the recovery supervisor must have done NOTHING" || true
  record "P7-R3-mount-untouched" bool \
    "$( [ "${REC_GENERATION:-x}" = "$generation_before" ] && echo 1 || echo 0 )" "" \
    "recoveryGeneration is still ${generation_before}, which is the daemon's own count of every attempt it has ever made" || true
  record "P7-R3" bool "$readable_again" "" \
    "a sustained provider outage past the breaker cooldown, then recovery, with the mount untouched throughout" || true
  # THE NAMESPACE CLOCK IS RE-BASED FOR THE ARM VERIFICATION THAT FOLLOWS, because this arm restarted the
  # daemon and the resolver on purpose and both are up.
  await_readable 240 || die "R3: the namespace is not readable after the outage cleared"
}

# ----------------------------------------------------------------------------------------------------------
arm_R4() {
  # A SERVE-LOOP DEATH, AND THE ASSERTION IS THAT EXACTLY ONE SUPERVISOR ACTED.
  #
  # THE DEATH IS AN ABORTED CONNECTION RATHER THAN AN UNMOUNT — Phase 3's A3 injector, and the reason is
  # measured: with three real media servers holding the mount, a lazy unmount detaches namespaces and leaves
  # the connection alive, so the first real run of that arm reported a fault that had never happened. The
  # abort is the kernel's own teardown, guarded to `fuse.projectiond` mounts under this run's directory only.
  local deaths_before remounts_before actions_before generation_before started before after
  local remounted_lines_before
  before="$(docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
    stat -c '%i:%s:%Y' "/mnt/$REAL_PATH" 2>/dev/null || echo "")"
  deaths_before="$(serve_deaths)"
  remounts_before="$(remount_starts)"
  remounted_lines_before="$(docker logs "$MOUNT_CONTAINER" 2>&1 | grep -c 'remounted; serving generation' || true)"
  actions_before="$(recovery_actions)"
  generation_before="${REC_GENERATION:-0}"
  started="$(date +%s%3N)"
  local abort_out
  set +e
  abort_out="$(bash "$WORK/out/fuse-abort.sh" "$WORK/mnt" 2>&1)"
  set -e
  echo "$abort_out" | sed 's/^/  /' >&2
  case "$(echo "$abort_out" | tail -1)" in
    abort:done*) : ;;
    *) die "R4: the fault could not be injected ($(echo "$abort_out" | tail -1))" ;;
  esac
  local saw_death=0 n=0
  while [ "$n" -lt 240 ]; do
    if [ "$(serve_deaths)" -gt "$deaths_before" ]; then saw_death=1; break; fi
    n=$((n + 1)); sleep 0.5
  done
  record "P7-R4-serve-death-observed" bool "$saw_death" "" \
    "the daemon's own log names a serve-loop death, so the connection really was severed" || true
  # THE REMOUNT LINE IS WAITED FOR AND IT IS COUNTED FROM A BASELINE TAKEN BEFORE THE FAULT. A line an earlier
  # arm left behind is not this arm's evidence, and counting from zero would let one be read as it. It is
  # WAITED for rather than sampled once, because the readiness probe a fresh sibling uses can be answered from
  # a warm attribute cache over a corpse — which is how Phase 3 recorded a correct recovery as a failure.
  local remount_logged=0
  n=0
  while [ "$n" -lt 240 ]; do
    if [ "$(docker logs "$MOUNT_CONTAINER" 2>&1 | grep -c 'remounted; serving generation' || true)" \
         -gt "$remounted_lines_before" ]; then
      remount_logged=1; break
    fi
    n=$((n + 1)); sleep 0.5
  done
  local readable=0
  if await_readable 240; then readable=1; fi
  record "P7-R4-remounted-in-place" bool "$( [ "$remount_logged" -eq 1 ] && [ "$readable" -eq 1 ] && echo 1 || echo 0 )" "" \
    "the namespace came back at the same mountpoint without the process exiting" || true
  record "P7-R4-ready-ms" le "$( [ "$readable" -eq 1 ] && echo $(( $(date +%s%3N) - started )) || echo "" )" \
    "$P7_READY_BUDGET_MS" \
    "from the death to a sibling container reading a byte through the mount again" || true
  after="$(docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
    stat -c '%i:%s:%Y' "/mnt/$REAL_PATH" 2>/dev/null || echo "")"
  record "P7-R4-identity-unchanged" bool \
    "$( [ -n "$before" ] && [ "$before" = "$after" ] && echo 1 || echo 0 )" "" \
    "inode, size and mtime across the remount" || true
  # THE ASSERTION THIS ARM EXISTS FOR. Phase 6 §3.2 DECLINES `serve-loop-dead` on purpose: a death is direct
  # evidence already owned by the supervisor that watched the serve loop exit, and the observation is a late
  # sample of the same event. Two supervisors reacting to one fault is two remounts racing on one mount point.
  sample
  record "P7-R4-recovery-declined" eq "$(( $(recovery_actions) - actions_before ))" 0 \
    "the recovery loop watched the serve-death path work and did nothing, which is what it is designed to do" || true
  record "P7-R4-single-flight" le "$(( $(remount_starts) - remounts_before ))" \
    "$P7_SINGLE_FLIGHT_ACTIONS_MAX" \
    "remounts started across BOTH supervisors for one serve-loop death" || true
  record "P7-R4" bool "$( [ "$saw_death" -eq 1 ] && [ "$remount_logged" -eq 1 ] && [ "$readable" -eq 1 ] && echo 1 || echo 0 )" "" \
    "a serve-loop death, with exactly one supervisor acting on it" || true
}

# ----------------------------------------------------------------------------------------------------------
arm_R5() {
  # A FOREIGN OVERLAY, REFUSED — `RC5`'s own injector, and Phase 6 calls this the most important row it has.
  # In every containerised topology this daemon ships in, the likeliest foreign mount at the mount point is
  # THE OPERATOR'S OWN BIND: the one mount that has to survive for any recovery to be visible to anybody.
  local generation_before attempts_before actions_before tag canary
  sample
  generation_before="${REC_GENERATION:-0}"
  attempts_before="${REC_ATTEMPTS:-0}"
  actions_before="$(recovery_actions)"
  tag="p7-foreign-$$"
  mount -t tmpfs -o size=1m,nr_inodes=64 "$tag" "$WORK/mnt" \
    || die "R5: a tmpfs could not be stacked above the live mount, so nothing could be refused"
  # A CANARY INSIDE THE OVERLAY, because "still mounted" and "unmodified" are two different claims and only
  # the second one says the appliance did not write into somebody else's filesystem.
  canary="$WORK/mnt/p7-canary.txt"
  printf 'phase7-canary\n' > "$canary" 2>/dev/null || true
  local canary_before
  canary_before="$(cat "$canary" 2>/dev/null || echo "")"

  # THE SUPERVISOR IS GIVEN A FULL OPPORTUNITY TO ACT BEFORE THE ARM SAYS IT DID NOT.
  local watch_until
  watch_until=$(( $(date +%s%3N) + P7_RECOVERY_ACTION_BUDGET_MS ))
  while [ "$(date +%s%3N)" -lt "$watch_until" ]; do
    sample
    [ "${REC_REASON:-}" = "refuse-foreign-mount" ] && break
    sleep 1
  done
  sample
  record "P7-R5-reason" bool "$( [ "${REC_REASON:-}" = "refuse-foreign-mount" ] && echo 1 || echo 0 )" "" \
    "the daemon named the refusal on its own status surface: reason='${REC_REASON:-absent}' observation='${READY_OBSERVED:-absent}'" || true
  record "P7-R5-remediation" bool "$( [ "${REC_REMEDIATION:-}" = "inspect-mount-owner" ] && echo 1 || echo 0 )" "" \
    "the operator is told to inspect the mount's owner rather than to reset a budget: '${REC_REMEDIATION:-absent}'" || true
  record "P7-R5-attempts" bool "$( [ "${REC_ATTEMPTS:-x}" = "$attempts_before" ] && echo 1 || echo 0 )" "" \
    "a refusal spends NOTHING: recoveryAttempts is still $attempts_before" || true
  record "P7-R5-generation" bool "$( [ "${REC_GENERATION:-x}" = "$generation_before" ] && [ "$(recovery_actions)" = "$actions_before" ] && echo 1 || echo 0 )" "" \
    "recoveryGeneration is still $generation_before and no recovery action was logged" || true

  # AND THE OVERLAY IS ASSERTED STILL MOUNTED AND UNMODIFIED, which is the assertion this whole arm exists for.
  local still=0 top
  top="$(awk -v target="$WORK/mnt" '{ sep = 0; for (i = 1; i <= NF; i++) { if ($i == "-") { sep = i; break } } if ($5 == target && sep > 0) { t = $(sep + 1) } } END { print t }' /proc/self/mountinfo)"
  [ "$top" = "tmpfs" ] && still=1
  record "P7-R5-overlay-still-mounted" bool "$still" "" \
    "the tmpfs the gate stacked is STILL the top of the stack; the appliance touched nothing that was not its own" || true
  local canary_after
  canary_after="$(cat "$canary" 2>/dev/null || echo "")"
  record "P7-R5-overlay-unmodified" bool \
    "$( [ -n "$canary_before" ] && [ "$canary_before" = "$canary_after" ] && echo 1 || echo 0 )" "" \
    "the byte content the gate wrote inside the foreign mount is unchanged" || true

  # THE GATE REMOVES ITS OWN OVERLAY, AND ONLY IT. This is the human in Phase 6's `AA6`.
  rm -f "$canary" 2>/dev/null || true
  umount "$WORK/mnt" 2>/dev/null || umount -l "$WORK/mnt" 2>/dev/null || true
  await_readable 240 || die "R5: the namespace did not come back after the gate removed its own overlay"
  record "P7-R5" bool "$( [ "$still" -eq 1 ] && [ "${REC_REASON:-}" = "refuse-foreign-mount" ] && echo 1 || echo 0 )" "" \
    "a foreign overlay, refused, and asserted still mounted and unmodified afterwards" || true
}

# ----------------------------------------------------------------------------------------------------------
arm_R6() {
  # AN UNRECOVERABLE FAULT SPENDING EXACTLY THE BOUNDED BUDGET — `RC8`/`RC9`/`RC11`'s own injector.
  #
  # `/dev/null` is bound over `/dev/fuse` INSIDE THE SUBJECT CONTAINER'S OWN mount namespace, so every
  # `Mount()` is refused for a reason that has nothing to do with the mount point — the only way to make the
  # remount fail without making the fault itself unrepresentative. It dies with the container and is removed
  # inside this arm regardless.
  if [ "$P7_HAS_NSENTER" -eq 0 ]; then
    die "R6: this host has no nsenter, so a deterministically failing mount cannot be produced; this gate has no optional arms and a skip is a failure"
  fi
  local daemon_pid ledger layers_before
  daemon_pid="$(docker inspect -f '{{.State.Pid}}' "$MOUNT_CONTAINER")"
  docker run --rm -v "$WORK/out:/out" "$P7_BUSYBOX_IMAGE" cp /bin/busybox /out/busybox \
    || die "R6: a static busybox could not be extracted, so the injector has nothing to run in a distroless container"
  test -s "$WORK/out/busybox" || die "R6: the extracted busybox is empty"
  docker cp "$WORK/out/busybox" "$MOUNT_CONTAINER:/busybox" \
    || die "R6: the injector could not be placed in this run's own daemon container"
  nsenter -t "$daemon_pid" -m -- /busybox mount --bind /dev/null /dev/fuse \
    || die "R6: /dev/fuse could not be masked in this run's own daemon namespace"
  echo "  every mount syscall in the subject's namespace will now be refused"

  # THE FAULT IS A CORPSE OF SOMEBODY ELSE'S MAKING AND MUST NOT BE THE SUBJECT'S OWN DEATH. Aborting the
  # SUBJECT's connection here would kill its serve loop, and with `/dev/fuse` masked the SERVE supervisor's
  # own three remounts would all fail and the process would exit — leaving nothing alive to spend a budget.
  layers_before="$(count_our_layers)"
  start_blocker "$layers_before" || die "R6: the second projectiond mount never landed above this run's own"
  local abort_out
  set +e
  abort_out="$(bash "$WORK/out/fuse-abort.sh" "$WORK/mnt" 2>&1)"
  set -e
  case "$(echo "$abort_out" | tail -1)" in
    abort:done*) : ;;
    *) stop_blocker; die "R6: the fault could not be injected ($(echo "$abort_out" | tail -1))" ;;
  esac
  stop_blocker

  # THE BUDGET IS DRIVEN TO EXHAUSTION. The COUNT comes from the status surface; the SPACING comes from the
  # stamps the cooldown is ACTUALLY compared against — `lastAttemptUnixNano` in the durable ledger, written
  # at the instant an attempt is granted. Every other clock is a proxy, and Phase 6 retired two of them.
  ledger="$WORK/cache/recovery/recovery-ledger.json"
  local stamps="" last_stamp="" stamp locked=0 wait_s n=0
  if [ -s "$ledger" ]; then
    last_stamp="$(node "$REL/out/jq.cjs" lastAttemptUnixNano < "$ledger" 2>/dev/null || true)"
  fi
  wait_s=$(( ((P7_RECOVERY_COOLDOWN_MS * (P7_RECOVERY_MAX_ATTEMPTS + 1)) / 1000) + 120 ))
  while [ "$n" -lt "$wait_s" ]; do
    sample
    if [ -s "$ledger" ]; then
      stamp="$(node "$REL/out/jq.cjs" lastAttemptUnixNano < "$ledger" 2>/dev/null || true)"
      if [ -n "$stamp" ] && [ "$stamp" != "$last_stamp" ]; then
        last_stamp="$stamp"
        stamps="$stamps $stamp"
      fi
    fi
    [ "${REC_STATE:-}" = "locked-out" ] && { locked=1; break; }
    n=$((n + 1)); sleep 1
  done
  local attempts_now state_now reason_now remediation_now generation_now
  attempts_now="${REC_ATTEMPTS:-}"; state_now="${REC_STATE:-}"; reason_now="${REC_REASON:-}"
  remediation_now="${REC_REMEDIATION:-}"; generation_now="${REC_GENERATION:-}"

  local min_gap="" prev="" count=0 gap
  for stamp in $stamps; do
    count=$(( count + 1 ))
    if [ -n "$prev" ]; then
      gap=$(( (stamp - prev) / 1000000 ))
      if [ -z "$min_gap" ] || [ "$gap" -lt "$min_gap" ]; then min_gap="$gap"; fi
    fi
    prev="$stamp"
  done
  # A GAP COMPUTED FROM FEWER STAMPS THAN THERE WERE ATTEMPTS IS NOT A MEASUREMENT OF THE SPACING. Without
  # this the arm would pass on two stamps out of three, which is the unfailable shape all over again.
  if [ "$count" -ne "$P7_RECOVERY_MAX_ATTEMPTS" ]; then min_gap=""; fi

  record "P7-R6-attempts-spent" eq "${attempts_now:-}" "$P7_RECOVERY_MAX_ATTEMPTS" \
    "attempts the daemon spent before it stopped for good" || true
  record "P7-R6-cooldown-ms" ge "${min_gap:-}" "$P7_RECOVERY_COOLDOWN_MS" \
    "the closest pair of consecutive attempt starts, read from the daemon's own durable ledger in nanoseconds" || true
  record "P7-R6-state-locked-out" bool "$( [ "$state_now" = "locked-out" ] && echo 1 || echo 0 )" "" \
    "the daemon publishes locked-out with reason '$reason_now'" || true
  record "P7-R6-remediation" bool "$( [ "$remediation_now" = "reset-recovery-ledger" ] && echo 1 || echo 0 )" "" \
    "the operator is told exactly what clears it: '$remediation_now'" || true

  # AND IT STAYS STOPPED. Two whole cooldowns is `RC9`'s own rule; one would be satisfied by a supervisor
  # merely between attempts.
  local quiet_until quiet_ok=1
  quiet_until=$(( $(date +%s%3N) + P7_LOCKOUT_QUIET_WINDOW_MS ))
  while [ "$(date +%s%3N)" -lt "$quiet_until" ]; do
    sample
    if [ -n "${REC_GENERATION:-}" ] && [ "${REC_GENERATION}" != "$generation_now" ]; then quiet_ok=0; break; fi
    sleep 2
  done
  record "P7-R6-quiet-while-locked-out" bool "$quiet_ok" "" \
    "across two whole cooldowns the generation did not advance past $generation_now" || true

  # THE LOCKOUT SURVIVES THE SUPERVISOR. This is the property Phase 6's probe cache silently destroyed, and
  # the one that makes `restart: unless-stopped` safe rather than an unbounded retry loop.
  #
  # THE CAUSE IS REPAIRED FIRST, BY RESTARTING THE CONTAINER — which destroys the mount namespace the mask
  # lived in. So what is being measured after this is a daemon that COULD act and does not, because a human
  # has not cleared the budget.
  restart_daemon
  local restart_state="" restart_attempts="" m=0
  while [ "$m" -lt 60 ]; do
    sample
    [ -n "${REC_STATE:-}" ] && break
    m=$((m + 1)); sleep 1
  done
  restart_state="${REC_STATE:-}"; restart_attempts="${REC_ATTEMPTS:-}"
  record "P7-R6-lockout-survived-restart" bool \
    "$( [ "$restart_state" = "locked-out" ] && [ "$restart_attempts" = "$P7_RECOVERY_MAX_ATTEMPTS" ] && echo 1 || echo 0 )" "" \
    "on the FIRST reading after a container restart the daemon is still locked out with $restart_attempts attempts spent" || true

  # ...AND A HUMAN CLEARS IT, WHICH IS THE ONLY THING THAT CAN. `--user 0:0` is load-bearing: the image's
  # default user is nonroot while every shipped profile runs the daemon as root, so the ledger is root-owned.
  docker run --rm --user 0:0 -v "$WORK/cache:/var/lib/projectiond/cache" \
    -v "$WORK/config.json:/etc/projectiond/config.json:ro" \
    "$IMAGE" --config /etc/projectiond/config.json --reset-recovery \
    > "$WORK/out/reset-recovery.txt" 2>&1 \
    || { cat "$WORK/out/reset-recovery.txt" >&2; die "R6: the operator reset failed"; }
  restart_daemon
  local reset_ok=0 ready_started
  ready_started="$DAEMON_STARTED_MS"
  m=0
  while [ "$m" -lt 60 ]; do
    sample
    [ -n "${REC_STATE:-}" ] && break
    m=$((m + 1)); sleep 1
  done
  [ "${REC_STATE:-}" = "idle" ] && [ "${REC_ATTEMPTS:-x}" = "0" ] && reset_ok=1
  record "P7-R6-reset-cleared-it" bool "$reset_ok" "" \
    "after --reset-recovery the daemon is '${REC_STATE:-absent}' with ${REC_ATTEMPTS:-?} attempts spent" || true
  await_recovery "$ready_started" || true
  record "P7-R6-ready-after-reset" le "$RECOVERY_MS" "$P7_READY_BUDGET_MS" \
    "from the daemon start after the reset to a sibling container reading a byte through the mount again" || true
  record "P7-R6" bool "$( [ "$locked" -eq 1 ] && [ "$reset_ok" -eq 1 ] && echo 1 || echo 0 )" "" \
    "an unrecoverable fault: the whole budget, a durable lockout across a restart, then an operator reset" || true
}

# ----------------------------------------------------------------------------------------------------------
step "STAGE A — the healthy baseline, with all three consumers attached BEFORE anything was ever mounted"
# ----------------------------------------------------------------------------------------------------------
# WITHOUT THIS STAGE EVERY ARM BELOW IS SATISFIED BY A SUPERVISOR THAT NEVER ACTS AND BY THREE SERVERS THAT
# NEVER SAW ANYTHING. It is `RC1`'s control, done with three real media servers instead of one byte reader.
record P7-A-consumers-pre-attached bool "$CONSUMERS_PRE_ATTACHED" "" \
  "all three media servers bound the projected path while it was a plain directory, which is section 11 of \
the Phase 0 product contract and the only bind that can follow a remount" || true
record P7-A-one-generation bool "$( [ "$(node "$REL/out/jq.cjs" outcome < "$WORK/out/publish-2.json")" = "published" ] && echo 1 || echo 0 )" "" \
  "one manifest generation, admitted once, serving one real provider source and one local control entry"

sample
# THE RECOVERY SURFACE ON A HEALTHY APPLIANCE. Every later arm is a difference from this.
record P7-A-recovery-idle bool \
  "$( [ "${REC_STATE:-}" = "idle" ] && [ "${REC_REASON:-}" = "no-action-healthy" ] && [ "${REC_ATTEMPTS:-x}" = "0" ] && [ "${REC_GENERATION:-x}" = "0" ] && echo 1 || echo 0 )" "" \
  "the shipped status surface reads state='${REC_STATE:-absent}' reason='${REC_REASON:-absent}' \
attempts=${REC_ATTEMPTS:-absent} generation=${REC_GENERATION:-absent} on a healthy appliance" || true

# THE FLOOR THE MOUNT-LAYER COUNT IS TAKEN ABOVE WAS CAPTURED BEFORE THE DAEMON EVER MOUNTED, and it is
# recorded here so a reader can check what every later layer figure is relative to.
echo "  the mount-layer floor taken before the daemon started is $MOUNT_LAYER_FLOOR; there are now \
$(count_our_layers) of ours and $(count_rows_at_mountpoint) row(s) of any kind at the mount point"
record P7-A-layers le "$(layers_above_floor)" "$P7_MOUNT_LAYERS_ABOVE_FLOOR_MAX" \
  "mounts of OURS at the projected mount point above the floor taken before the daemon ever mounted" || true

phase_bytes P7-A-windows P7-A-stat - P7-A-inread "" "stage A"
phase_catalogue P7-A-catalogue "" "stage A"

# ----------------------------------------------------------------------------------------------------------
step "STAGE C — the three-way overlap, on ONE mount and ONE generation, observed on one clock"
# ----------------------------------------------------------------------------------------------------------
# THE OVERLAP OBSERVATION IS TAKEN ON THE COLD CYCLE, WHICH IS WHY THE ITEM-ID SCANS COME AFTER IT. Those
# scans are what actually reads the whole remote object through three ffprobes for the first time; running
# them first warms every window the overlap measurement is about, and the run then observes three servers
# finishing a two-entry re-scan between two ticks. Phase 3's first real run died exactly there.
if drive verify-overlap --scan "$REL/out/scan-$CATALOGUE_ROUND.json" --overlap-mode measurement \
     --results "$REL/out/drive-$CATALOGUE_ROUND.json"; then
  record P7-C-overlap-three-way-observed bool 1 "" \
    "all three observed scanning the same real-provider namespace, with a fully attributed three-way sample"
else
  record P7-C-overlap-three-way-observed bool 0 "" "the three scans were not observed to overlap" || true
  mkdir -p "$EVIDENCE_DIR" && chmod 700 "$EVIDENCE_DIR"
  if node "$REL/out/overlaptimeline.cjs" "$REL/out/scan-$CATALOGUE_ROUND.json" \
       "$REL_GATE_ROOT/evidence/overlap-timeline-$$.json"; then
    chmod 600 "$EVIDENCE_DIR/overlap-timeline-$$.json"
    echo "  the per-tick timeline is kept at $REL_GATE_ROOT/evidence/overlap-timeline-$$.json" >&2
  fi
  die "the three scans were not observed to overlap"
fi

ensure_items

# ----------------------------------------------------------------------------------------------------------
step "STAGE B — ten media-time seeks per server, through each server's OWN driver and verifier"
# ----------------------------------------------------------------------------------------------------------
for SERVER in $P7_SERVERS; do
  echo "--- $SERVER: ten seeks including backwards and beyond 90% of duration ---"
  seeks_for "$SERVER"
done

# ----------------------------------------------------------------------------------------------------------
step "STAGE B and C — five minutes of paced direct play on all THREE servers AT ONCE"
# ----------------------------------------------------------------------------------------------------------
# THIS IS BOTH STAGES AT ONCE AND THAT IS THE DESIGN RATHER THAN AN ECONOMY. Three real decoders on one mount,
# one cache and one provider lease at the same instant is the state an operator's appliance is actually in,
# and it is a strictly stronger concurrency claim than three servers taking turns.
set +e
play_all_three cold P7-B
PLAY_FAILURES=$?
set -e
record P7-C-concurrent-play-overlapped bool "$PLAY_OVERLAPPED" "" \
  "an instant existed at which all three servers' consumers were decoding the same object through the same \
mount, measured from the three progress traces rather than inferred from three launches" || true
test "$PLAY_FAILURES" -eq 0 \
  || die "stage B: $PLAY_FAILURES of the three servers failed their own driver's playback thresholds"

# ----------------------------------------------------------------------------------------------------------
step "STAGE B — a forced transcode, run and consumed for five minutes, one server at a time"
# ----------------------------------------------------------------------------------------------------------
for SERVER in $P7_SERVERS; do
  echo "--- $SERVER: a forced transcode for five minutes ---"
  transcode_for "$SERVER"
done

# THE CATALOGUE AND THE BYTES AFTER THE WHOLE PLAYBACK WINDOW. Five minutes of streaming and five of encoding
# must not have moved a single identity or a single byte.
phase_catalogue P7-C-catalogue "" "stage C"
phase_bytes P7-C-windows-after - - - "" "stage C"

# ----------------------------------------------------------------------------------------------------------
step "STAGE D — the six recovery arms, with the SAME three servers attached throughout"
# ----------------------------------------------------------------------------------------------------------
ARM_INDEX=0
for ARM in $P7_ARMS; do
  ARM_INDEX=$(( ARM_INDEX + 1 ))
  step "ARM $ARM_INDEX of $P7_ARMS_PER_RUN — $ARM"
  node "$REL/out/arm.cjs" "$ARMS_REL" "$ARM_INDEX" "$ARM"
  # THE MOUNT TOPOLOGY BEFORE THE FAULT, so "after" is a comparison rather than an absolute.
  echo "  before $ARM: $(count_our_layers) mount(s) of ours and $(count_rows_at_mountpoint) row(s) of any \
kind at the mount point, against a floor of $MOUNT_LAYER_FLOOR"
  sample
  echo "--- phase F: arm $ARM ---"
  "arm_$ARM"
  echo "--- phase V: the same bytes, catalogues, binds and topology, after the fault ---"
  verify_after_arm "$ARM"
done

# ----------------------------------------------------------------------------------------------------------
step "STAGE D — and every server plays the object AGAIN, through the bind it has held all along"
# ----------------------------------------------------------------------------------------------------------
# THE PRODUCT CLAIM RATHER THAN A DIAGNOSTIC. Six faults have been done to this mount. Nothing has been
# restarted, re-bound or re-created on the consumer side, and the question is whether a media server can still
# play the operator's object — which is what "an operator can use this" means and what no Phase 6 run asked.
set +e
play_all_three warm P7-D-play-after-recovery
PLAY_FAILURES=$?
set -e
test "$PLAY_FAILURES" -eq 0 \
  || echo "  $PLAY_FAILURES of the three could not play after the six faults; the verdicts above say which" >&2

# ----------------------------------------------------------------------------------------------------------
step "STAGE F — the SHIPPED operator command, with media consumers attached"
# ----------------------------------------------------------------------------------------------------------
# AN OPERATOR COMMAND THAT IS ONLY IDEMPOTENT WHEN NOTHING IS USING IT IS NOT IDEMPOTENT. Phase 6's install
# matrix drove this command against one unprivileged byte reader; here it is driven while three real media
# servers hold the mount it is being asked about.
#
# WHAT IT IS POINTED AT, AND WHY THAT IS SAFE. Its own environment contract, pointed at THIS RUN'S OWN
# directories and a mount point of its own — never at the subject daemon's, which is still serving three media
# servers. `preflight` and `status` are the two verbs that read; `upgrade`, `rollback` and `reset-recovery`
# are exercised against this run's own appliance directory and nothing else on the host.
# WHAT DRIVES IT IS PHASE 6's OWN INSTALL MATRIX, NOT A SECOND COPY OF IT. `deploy/projection-alpha-acceptance.sh`
# already drives every verb of the shipped command through eleven arms and asserts host cleanliness itself; a
# reimplementation here would be a second thing to keep true. What Phase 7 adds is the CONDITION it runs
# under — a live projection appliance on the same host with three real media servers reading through it — and
# the assertion, below, that those three are still reading afterwards.
#
# WHAT THIS DOES AND DOES NOT CLAIM, STATED HERE RATHER THAN IN A DOCUMENT NOBODY OPENS. The matrix drives
# the shipped command against ITS OWN appliance root, with its own pre-attached byte-reading consumer. It is
# not driven against the subject daemon, which is serving three media servers and must keep doing so. So the
# claim is "the shipped operator command is idempotent and truthful while media consumers are attached to a
# projection appliance on this host", and not "the operator command was run against the media servers' own
# appliance".
set +e
PROJECTIOND_IMAGE="$IMAGE" bash deploy/projection-alpha-acceptance.sh > "$WORK/out/alpha-matrix.txt" 2>&1
ALPHA_STATUS=$?
set -e
sed 's/^/  /' "$WORK/out/alpha-matrix.txt" | tail -40 || true
echo "  the install matrix exited $ALPHA_STATUS"
alpha_arm() { grep -qE "^  PASS  $1 " "$WORK/out/alpha-matrix.txt"; }
record P7-F-preflight-idempotent bool \
  "$( alpha_arm AA1 && alpha_arm AA3 && echo 1 || echo 0 )" "" \
  "preflight refused with no consumer attached and created nothing, and install and start are both \
idempotent against an appliance that is already running" || true
record P7-F-status-truthful bool "$( alpha_arm AA5 && echo 1 || echo 0 )" "" \
  "the operator status surface names the recovery state, reason, generation and remediation, and carries no \
URL, media identity or free-text error" || true
record P7-F-upgrade-recorded-rollback-target bool "$( alpha_arm AA8 && echo 1 || echo 0 )" "" \
  "upgrade recorded a rollback target BEFORE it changed anything" || true
record P7-F-rollback-returned bool "$( alpha_arm AA8 && echo 1 || echo 0 )" "" \
  "rollback returned to the digest upgrade recorded" || true
record P7-F-reset-recovery-idempotent bool "$( alpha_arm AA9 && echo 1 || echo 0 )" "" \
  "reset-recovery cleared the durable budget, and a second run of it is still a success" || true
record P7-F-stop-left-the-data bool "$( alpha_arm AA10 && alpha_arm AA11 && echo 1 || echo 0 )" "" \
  "stop is idempotent, the appliance is gone, its media, manifest and cache are untouched, and the host's \
container, network and volume sets are identical" || true
# AND THE THREE MEDIA SERVERS ARE STILL READING THE SUBJECT MOUNT, which is what makes the whole stage a
# statement about an operator command run on a live appliance rather than on an empty host.
phase_bytes P7-F-windows-after - - P7-F-inread "" "stage F"

# ----------------------------------------------------------------------------------------------------------
step "NO SECRET, REFERENCE OR LABEL REACHED ANYTHING THIS RUN WROTE"
# ----------------------------------------------------------------------------------------------------------
# THE NEEDLES ARRIVE AS A FILE PATH, never in argv: a needle passed to `docker run` lives in the host's
# process table and in `docker inspect .Config.Cmd` for the life of the container, which is measurably not
# "nowhere". Mode 0644 for the reason §6.0 of the acceptance plan records — a file the consuming container's
# uid cannot read is a defect Docker Desktop cannot show you.
node "$REL/out/needles.cjs" "$OBJECTS_FILE" "$REL/inputs/torbox-credential" "$REL/inputs/gate-secret" \
  "$REL/out/leak-needles.txt" "$REL/out/leak-needles-manifest.txt" \
  || die "the needle list could not be built, so no leak search could be decisive"
chmod 644 "$WORK/out/leak-needles.txt" "$WORK/out/leak-needles-manifest.txt"

leak_scan() {
  local id="$1" label="$2" dir="$3" list="${4:-/out/leak-needles.txt}"
  if docker run --rm -v "$dir:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
       sh /out/leakcheck.sh "$label" "$list"; then
    record "$id" bool 1 "" "$label"
  else
    record "$id" bool 0 "" "$label" || true
    die "$label holds a secret, a reference or the operator's label"
  fi
}
# THE MANIFEST IS SEARCHED FOR EVERYTHING EXCEPT THE ONE FIELD IT EXISTS TO CARRY, and the exception is paid
# for by the assertion below rather than waived. See `needles.cjs` for why, and §6 for the same shape already
# recorded about the CDN origin in the daemon's configuration file.
leak_scan P7-leak-manifest    "the published manifest directory" "$WORK/manifest" \
  /out/leak-needles-manifest.txt
# ...AND THE REFERENCE IS ASSERTED INTO ITS CONTRACTED FIELD. This is the stronger half of the subtraction:
# the reference at `locator.objectRef` is the manifest doing its job, and the reference anywhere else in the
# document — a path, an entry id, a label, a note, a byte identity — is a leak that the old scan could not
# have distinguished from the legitimate one, because it failed on both.
if node "$REL/out/refplacement.cjs" "$OBJECTS_FILE" "$REL/manifest"; then
  record P7-leak-manifest-ref-placement bool 1 "" \
    "every occurrence of the stable reference in the manifest IS a locator.objectRef value"
else
  record P7-leak-manifest-ref-placement bool 0 "" \
    "the stable reference appears in the manifest somewhere other than its own locator field" || true
  die "the stable reference appears in the published manifest outside locator.objectRef"
fi
leak_scan P7-leak-probe-cache "the daemon probe cache"           "$WORK/cache"
for scan_dir in jf-config plex-config emby-config; do
  docker run --rm -v "$WORK/$scan_dir:/scan:ro" -v "$WORK/out:/out:ro" "$VERIFY_IMAGE" \
    sh /out/leakcheck.sh "a media server's library state" /out/leak-needles.txt \
    || { record P7-leak-library-state bool 0 "" "a media server persisted a secret, reference or label" \
         || true; die "a media server's library state holds a secret, a reference or the operator's label"; }
done
record P7-leak-library-state bool 1 "" "all three servers' library state, searched in full"

# THE PRESERVED EVIDENCE IS SEARCHED TOO, because it is the one thing that outlives the run. It has been
# written straight into this directory from the first verdict, so there is no copy step here that could have
# failed and left the search looking at a file the run never wrote.
leak_scan P7-leak-evidence "the preserved evidence" "$EVIDENCE_DIR"

# AND THE PROVIDER REALLY WAS CONTACTED, or every search above was a search for a secret that never existed
# and every byte in this run came from somewhere the gate did not look.
RESOLUTIONS="$(resolver_resolutions)"
record P7-resolutions-happened ge "${RESOLUTIONS:-0}" 1 \
  "access material was minted against the real provider during this run" || true
test "${RESOLUTIONS:-0}" -ge 1 \
  || die "the resolver never resolved anything, so nothing here was a real-provider read"

# ----------------------------------------------------------------------------------------------------------
step "THE MOUNT TOPOLOGY AT THE END — the accumulation question, asked before anything is torn down"
# ----------------------------------------------------------------------------------------------------------
# SIX FAULTS HAVE BEEN DONE TO THIS MOUNT POINT. Phase 6 §9.7 measured that each recovery stacks over the
# corpse it found rather than removing it, so a mount point that has survived several carries several dead
# layers — and an appliance that grows one per fault eventually meets §9.6, a mount point nothing can bind,
# with no operator involved and no warning. This is the count that says whether that is still true.
#
# IT IS TAKEN BEFORE THE TEARDOWN, because a teardown removes the very layers it is asking about.
echo "  at the end of the run: $(count_our_layers) mount(s) of ours and $(count_rows_at_mountpoint) row(s) \
of any kind at the mount point, against a floor of $MOUNT_LAYER_FLOOR"
record P7-layers-at-end le "$(layers_above_floor)" "$P7_MOUNT_LAYERS_ABOVE_FLOOR_MAX_AT_END" \
  "mounts of OURS still stacked at the projected mount point after six faults, above the floor taken \
before the daemon ever mounted" || true

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
record P7-own-mountpoints-removed eq "${LEFT_MOUNTS:-1}" 0 \
  "mountpoints left under this run's own directory" || true
record P7-own-run-directory-removed bool "$( [ ! -d "$WORK" ] && echo 1 || echo 0 )" "" \
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
compare_sets P7-host-container-set-unchanged "containers" \
  "$GATE_ROOT/host-containers-before-$$.txt" "$GATE_ROOT/host-containers-after-$$.txt"
compare_sets P7-host-network-set-unchanged "networks" \
  "$GATE_ROOT/host-networks-before-$$.txt" "$GATE_ROOT/host-networks-after-$$.txt"
compare_sets P7-host-volume-set-unchanged "volumes" \
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
npx tsx src/ops/projection-phase7-cli.ts redaction-check --file "$RESULTS_REL" \
  || die "the preserved verdict log is not redaction-safe"
npx tsx src/ops/projection-phase7-cli.ts report --results "$RESULTS_REL" --arms-log "$ARMS_REL"
npx tsx src/ops/projection-phase7-cli.ts close --results "$RESULTS_REL" --arms-log "$ARMS_REL" \
  || die "the run did not satisfy the predeclared closure rule"

echo
echo "RELIABILITY LOOP gate PASSED. Exactly what was proved:"
echo "  - $P7_ARMS_PER_RUN recovery arms, in the order the contract names, each followed by the same"
echo "    byte, catalogue, churn, mount-topology and bind verification."
echo "  - FIVE MINUTES of paced direct play on all THREE servers AT ONCE, ten media-time seeks per server"
echo "    including backwards and beyond 90% of duration, and a five-minute forced transcode per server."
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
npx tsx src/ops/projection-phase7-cli.ts nonclaims
