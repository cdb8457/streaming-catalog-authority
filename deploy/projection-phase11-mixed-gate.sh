#!/usr/bin/env bash
# Projection Phase 11 — THE MIXED-SOURCE ACCEPTANCE GATE, IN FAKE MODE.
#
# WHAT IT RUNS. §5.1 of `docs/PROJECTION_PHASE_11_MIXED_SOURCE_ACCEPTANCE.md` predeclares six arms, and this
# runs all six against a FAKE range origin and a FAKE SABnzbd-compatible worker:
#
#   P11-M1  one published generation holds a provider-backed http-range entry and a worker-produced local one
#   P11-M2  each half is readable through the ONE mount for what it is, and neither is served by the other's path
#   P11-M3  publishing a generation that adds one half leaves the other half identical in every recorded field
#   P11-M4  a failure injected into one source disturbs ZERO recorded fields of the other, which stays readable
#   P11-M5  the mixed sequence needs no hand-run command and nothing publishes implicitly
#   P11-M6  every declared arm was REACHED, cleanup left nothing, and no evidence carries an identity
#
# THE FOUR SEQUENCE-LEVEL CLAIMS AND THE FOUR TIER-TWO CLAIMS ARE NOT HERE, AND THEIR ABSENCE IS THE POINT.
# `src/core/projection/phase11.ts` publishes `PHASE11_FAKE_EMITTABLE_GATE_IDS` — the six arms and nothing else
# — and `test/projection-phase11-gate-audit.ts` checks the verdict ids in THIS FILE against it as a MULTISET.
# A run that emitted `P11-R2-three-servers-scan-and-read-both` would have claimed three real media servers it
# never contacted, and §4's third hard refusal exists because that is the easiest sentence in the world to
# write by accident.
#
# IT DRIVES THE SHIPPED COMMANDS AND OWNS NO MOUNT. Phase 8 §13's rule is that one mount point has exactly one
# owner. Every namespace mutation below goes through `deploy/projection-content.sh` and every appliance
# operation goes through `deploy/projection-alpha.sh`, with the environment contract an operator would set.
# THIS SCRIPT NEVER CALLS mount, umount OR fusermount, never writes inside the mount point, and starts no
# daemon of its own. §4's fourth hard refusal, and the audit asserts it over these bytes.
#
# WHAT IT CONTACTS: a PostgreSQL container it starts and removes itself, a fake range origin it starts and
# removes itself, a loopback listener the worker driver starts and closes itself, and the appliance the
# shipped alpha script runs. No real TorBox endpoint, no CDN origin, no indexer, no operator SABnzbd, no NNTP
# server, no media server, no Tower production container, no operator content and no credential.
# `endpoint.json` is not read, not written and not touched — asserted, with its mtime recorded before and
# after.
#
# EXIT STATUS. 0 when every arm passed. 1 when any failed. 77 when this host cannot run it at all, which is a
# SKIP and is not a pass — `projection-phase11-mixed-gate-optional.sh` is the entry point that folds a skip,
# and folding one is a decision that belongs in the command somebody typed.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
GATE_SKIP_STATUS=77
COMPOSE_FILE="$ROOT/docker-compose.projection-phase11.yml"
PROJECT="projection-phase11-gate"
PG_PORT="${PROJECTION_PHASE11_GATE_PG_PORT:-5680}"
ORIGIN_PORT="${PROJECTION_PHASE11_FAKE_ORIGIN_PORT:-8300}"
ORIGIN_CONTAINER="projection-phase11-origin-$$"
ALPHA_NETWORK="projection-alpha"
APPLIANCE="projection-alpha-projectiond"
CONSUMER_CONTAINER="projection-phase11-consumer-$$"
CONTENT="$HERE/projection-content.sh"
ALPHA="$HERE/projection-alpha.sh"
# THE SHIPPED CLEANUP, SOURCED RATHER THAN RE-IMPLEMENTED. It exists because four Jellyfin runs on the real
# Unraid host left four dangling mountpoints: a lazy unmount issued inside a container whose bind carried
# Docker's default `rprivate` propagation succeeds in a namespace thrown away a millisecond later, and the
# host's mountpoint is never touched. A plain `rm -rf` over a run directory that still carries a live FUSE
# mount is the same defect one step further on. Every other mounting gate here sources this file; this one
# did not, and on the one host §9.1 names as the closing host that is where the leak lands.
# shellcheck source=projection-gate-cleanup.sh
. "$HERE/projection-gate-cleanup.sh"
IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
GO_IMAGE="golang:1.26.5-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651"
PG_WAIT_SECONDS="${PROJECTION_PHASE11_PG_WAIT_SECONDS:-180}"
ORIGIN_OBJECT_BYTES=$((4 * 1024 * 1024))
CORPUS_BYTES=$((2 * 1024 * 1024))
ENTRY_LOCAL="Movies/Worker One (2026)/Worker One (2026).mkv"
ENTRY_REMOTE="Movies/Remote One (2026)/Remote One (2026).bin"

# A seam for the offline audit, which points these at stubs so the ACCOUNTING is exercised as behaviour
# rather than read as source. They default to the real shipped commands.
CONTENT_COMMAND="${PROJECTION_PHASE11_CONTENT_COMMAND:-$CONTENT}"
ALPHA_COMMAND="${PROJECTION_PHASE11_ALPHA_COMMAND:-$ALPHA}"

PASS=0
FAIL=0

say()  { echo "[phase11] $*"; }
fail() { echo "[phase11] FAILED: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

skip() {
  echo >&2
  echo "SKIPPED: $1" >&2
  echo "  NOTHING WAS PROVED. This host cannot run the Phase 11 mixed gate, and a skip is not a pass." >&2
  exit "$GATE_SKIP_STATUS"
}

# THE ARM MARKER, AND IT IS RECORDED AT THE START OF AN ARM RATHER THAN AT ITS END.
#
# REACHED IS NOT PASSED, and §5.4 is where that distinction is written down. An arm that ran and failed is
# evidence, and it carries its failure in its own verdict. An arm a conditional jumped over leaves no marker
# at all, and P11-M6's measured number is exactly the size of that absence — which is Phase 8's defect #11,
# a function defined and never called, wearing this tranche's clothes.
arm() {
  local id="$1"
  echo "ARM $id reached"
  echo "$id" >> "$ARMS_FILE"
}

# EVERY VERDICT IS STAMPED `fake=true`, AND THE STRING IS NOT DECORATION. `phase11ClosureProblems` reads that
# field and refuses a tier-two verdict carrying it, so a fake run that grew into a mixed-product closure would
# have to change a module rather than a comment.
verdict() {
  local id="$1" outcome="$2"
  if [ "$outcome" = "pass" ]; then
    PASS=$((PASS + 1))
    echo "  VERDICT $id pass fake=true"
  else
    FAIL=$((FAIL + 1))
    echo "  VERDICT $id fail fake=true" >&2
  fi
}

# TWO EMPTY STRINGS COMPARE EQUAL, AND "THE BYTES DID NOT MOVE" IS THE ONE ANSWER THAT MUST NEVER BE
# PRODUCIBLE BY HAVING READ NOTHING.
#
# THE DEFECT THIS REPAIRS. `consumer_sha` sends its errors to /dev/null and pipes through `awk`, so a mount
# that is not there, a consumer that lost its bind, or a daemon that stopped answering all return the EMPTY
# STRING. P11-M3 and P11-M4 each compared one of those against another, and `[ "" = "" ]` is true — so an
# appliance that had died between two arms would have reported the provider-backed half as byte-identical
# before and after, and the arm would have passed on the absence of the thing it measures. It is the same
# shape as `entry.cjs` refusing an absent entry rather than emitting an empty record, one layer out, and it
# was pinned in the helper and not at the call sites.
same_bytes() {
  local what="$1" before="$2" after="$3"
  if [ -z "$before" ] || [ -z "$after" ]; then
    echo "  $what: a digest is EMPTY, so nothing was read and no comparison can be made" >&2
    return 1
  fi
  [ "$before" = "$after" ]
}

# A COUNTER THAT DID NOT RUN REPORTS THE PASSING VALUE, AND SHELL ARITHMETIC IS WHERE THAT HAPPENS SILENTLY:
# `$(( A + B ))` with A unset or empty is ZERO, which is exactly the budget P11-M4 is measured against. So
# every derived number is asserted to BE a number before it is compared or added. §7 R3 and R4's whole
# argument is that these numbers are derived rather than declared; a derivation that failed and answered zero
# is a declaration wearing the derivation's clothes.
numeric() {
  case "${2:-}" in
    ''|*[!0-9]*)
      echo "  $1 did not produce a number, so the zero it would contribute proves nothing" >&2
      return 1 ;;
  esac
  return 0
}

# ---------------------------------------------------------------------------------------------------------
# Preconditions. EVERY ONE IS CHECKED BEFORE ANYTHING IS CREATED, so a host that cannot run this leaves with
# nothing to clean up.
# ---------------------------------------------------------------------------------------------------------

command -v node >/dev/null 2>&1 || skip "node is not on PATH"
command -v npx >/dev/null 2>&1 || skip "npx is not on PATH"
[ -f "$ROOT/package.json" ] || fail "the repository root does not look like this project"
[ -f "$CONTENT" ] || fail "the shipped content command is missing; there is nothing to drive"
[ -f "$ALPHA" ] || fail "the shipped alpha command is missing; there is no appliance to drive"
command -v docker >/dev/null 2>&1 || skip "docker is not on PATH, and this gate needs a real database and a mount"
docker info >/dev/null 2>&1 || skip "the docker daemon is not answering"
# THE READINESS AND COUNTER READS ARE HTTP, AND A HOST WITHOUT curl WOULD FAIL THEM AS THOUGH THE ORIGIN WERE
# BROKEN. P11-M2's whole distinction between the two halves is "did the origin's counters move", so a missing
# client is a skip rather than a red run about a tool.
command -v curl >/dev/null 2>&1 || skip "curl is not on PATH, and the range origin's counters are read over HTTP"

docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1 \
  || skip "no /dev/fuse is reachable from a container on this host, so no appliance can mount the namespace"

# THE APPLIANCE'S OWN NAME IS FIXED BY THE SHIPPED PROFILE, so a previous run still holding it would make
# every assertion below about somebody else's container. REFUSED rather than cleaned up: the other run's
# cleanup owns its own containers, and §4's fourth refusal is about not taking ownership of what is not ours.
if docker ps -a --format '{{.Names}}' | grep -qx "$APPLIANCE"; then
  fail "a projection-alpha appliance already exists on this host. This gate drives the shipped profile, whose \
container name is fixed, so it would be reading somebody else's mount. Stop it first."
fi

# AND THE NETWORK, FOR THE SAME REASON AND ONE THE CONTAINER CHECK DOES NOT COVER. This gate's cleanup removes
# `projection-alpha` unconditionally, because the shipped profile creates it and a run that left it behind
# would fail its own residue check. A network that was ALREADY THERE when the gate started is one somebody
# else made — an operator, a stopped deployment, another checkout — and removing it would be this gate taking
# ownership of what is not ours, which is the whole of §4's fourth refusal. REFUSED rather than adopted, and
# refused rather than cleaned up, exactly as the appliance's own name is.
if docker network ls --format '{{.Name}}' | grep -qx "$ALPHA_NETWORK"; then
  fail "a $ALPHA_NETWORK network already exists on this host. This gate's cleanup removes that network, so it \
would be destroying one it did not create. Remove it yourself first, or stop whatever owns it."
fi

# THE RUN DIRECTORY IS UNDER THE REPOSITORY, AND ON THIS TRANCHE THAT IS CORRECTNESS RATHER THAN TASTE.
#
# THE DEFECT IT REPAIRS, MEASURED ON THE HOST §9.1 NAMES AS THE CLOSING HOST. `mktemp -d` answers `/tmp/tmp.X`,
# which on that host resolves to `/` — propagation `private`. The shipped appliance profile binds its mount
# point `:rshared`, because that is what makes the namespace visible to a media server in another container,
# and Docker REFUSES an `rshared` bind whose source is not on a shared subtree. So `alpha start` would have
# failed, P11-M2 would have gone RED, and the colour would have been about which directory the run happened to
# be in. Phase 10 §11.5's seventh defect and §7 R5 both say that is a SKIP and never a failure — but the
# honest repair is not to skip on the appliance host, it is to stop putting the mount point somewhere the
# appliance cannot use. Every other mounting gate in this repository roots its run directory under the
# checkout for exactly this reason; `deploy/projection-alpha-acceptance.sh` is the closest precedent and it is
# a member of P11-S3's own regression subset.
GATE_ROOT="${PROJECTION_PHASE11_GATE_ROOT:-$ROOT/.projection-phase11-mixed-gate}"
WORK="$GATE_ROOT/run-$$"
mkdir -p "$WORK" || fail "the gate could not create its own run directory under $GATE_ROOT"
chmod 755 "$GATE_ROOT" "$WORK" 2>/dev/null || true
ARMS_FILE="$WORK/arms-reached.txt"
: > "$ARMS_FILE"

# LEAVING WITH NOTHING, ON EVERY PATH THAT LEAVES BEFORE THE TRAP IS INSTALLED. The run directory is the only
# thing that exists at this point, and a host that cannot host this gate must not keep one.
leave_with_nothing() {
  rm -rf "$WORK" 2>/dev/null || true
  rmdir "$GATE_ROOT" 2>/dev/null || true
}

# ---------------------------------------------------------------------------------------------------------
# THE HELPER PROGRAMS, WRITTEN TO FILES RATHER THAN PASSED AS `node -e '...'`.
#
# WHY, AND IT IS A DEFECT PHASE 10 FOUND IN ITSELF. A multi-line `node -e '` opens a single quote the next
# line does not close, and `test/custody-runtime-closure.ts` reads every shipped script line by line and
# refuses exactly that: "an unterminated single quote - the rest of this line cannot be read, and an
# unreadable line is not an empty one". A quote a line-based reader cannot close is a quote a HUMAN reader
# cannot close either, and it is where an unterminated string silently swallows the next command.
# ---------------------------------------------------------------------------------------------------------

cat > "$WORK/probe.cjs" <<'PROBE'
// Can the runtime the shipped commands run on resolve the path THIS SHELL would write into a configuration?
// The path arrives in a FILE, not in argv: MSYS rewrites a POSIX-looking argument on the way to a native
// binary, so an argv probe would pass on exactly the host this exists to catch.
const { existsSync, readFileSync } = require('node:fs');
if (!existsSync(readFileSync(process.argv[2], 'utf8'))) process.exit(1);
PROBE

cat > "$WORK/identity.cjs" <<'IDENTITY'
// DOES THIS HOST AGREE WITH ITSELF ABOUT WHICH FILE A DESCRIPTOR IS OPEN ON?
//
// THE DEFECT THIS PRECONDITION EXISTS FOR, FOUND BY RUNNING THE WORKER DRIVER ON A WINDOWS DEVELOPMENT HOST.
// The shipped admission proof compares a path's `lstat` against the `fstat` of the descriptor it digested,
// through `sameFile`, which compares dev, ino, size and mtime. On Windows `lstat().dev` is 0 and
// `fstat().dev` is the volume serial, so the two never agree and EVERY completed output is refused
// `output-mutated-during-digest` — a true sentence about the host and a false one about the product.
//
// IT IS A SKIP AND NOT A FAILURE. The appliance is Linux, `parseContentConfig` already refuses a non-POSIX
// path for the same reason, and a red run whose colour comes from which machine it was launched on is not a
// verdict about the product at all.
const { closeSync, fstatSync, lstatSync, openSync, writeFileSync } = require('node:fs');
const path = process.argv[2];
writeFileSync(path, Buffer.alloc(4096));
const named = lstatSync(path);
const fd = openSync(path, 'r');
const opened = fstatSync(fd);
closeSync(fd);
if (named.dev !== opened.dev || String(named.ino) !== String(opened.ino)) process.exit(1);
IDENTITY

cat > "$WORK/fill.cjs" <<'FILL'
// Synthesised bytes that are not all one value, so a probe window over them is a meaningful digest.
const { writeFileSync } = require('node:fs');
const size = Number(process.argv[3]);
const buffer = Buffer.alloc(size);
for (let i = 0; i < size; i += 1) buffer[i] = (i * 31 + 7) & 0xff;
writeFileSync(process.argv[2], buffer);
FILL

cat > "$WORK/sha.cjs" <<'SHA'
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
process.stdout.write(createHash('sha256').update(readFileSync(process.argv[2])).digest('hex'));
SHA

cat > "$WORK/mtime.cjs" <<'MTIME'
const { statSync } = require('node:fs');
try { process.stdout.write(String(statSync(process.argv[2]).mtimeMs)); }
catch { process.stdout.write('unreadable'); }
MTIME

cat > "$WORK/expect.cjs" <<'EXPECT'
// `expect.cjs <document> <dotted.field> <value>` - one assertion, named, over a document a shipped verb
// emitted. Written as data rather than as embedded JavaScript so a reader can see which field each step
// checks without parsing a program out of a shell string.
const { readFileSync } = require('node:fs');
const doc = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const actual = process.argv[3].split('.').reduce((node, key) => (node === undefined || node === null ? node : node[key]), doc);
const same = String(actual) === process.argv[4];
if (!same) console.error(`  ${process.argv[3]}=${String(actual)}, expected ${process.argv[4]}`);
process.exit(same ? 0 : 1);
EXPECT

cat > "$WORK/objects.cjs" <<'OBJECTS'
// Turns the fake origin's OWN emitted descriptor into the operator-shaped object manifest the shipped
// `add-torbox` verb takes, so fake mode drives the identical input path a real run does rather than a
// parallel one. `deploy/real-provider-objects.template.json` is the shape; this is that shape, filled in.
const { readFileSync, writeFileSync, chmodSync } = require('node:fs');
const [, , emitted, out, size, label, itemId, path] = process.argv;
const descriptor = JSON.parse(readFileSync(emitted, 'utf8'));
const list = Array.isArray(descriptor) ? descriptor : (descriptor.objects ?? []);
const first = list[0];
const ref = typeof first === 'string' ? first : (first?.ref ?? 'phase11-object-1');
writeFileSync(out, `${JSON.stringify([{ label, itemId, path, ref,
  sizeBytes: Number(size), mtime: '2026-06-01T10:00:00.000Z', sha256: null }], null, 2)}\n`);
chmodSync(out, 0o600);
OBJECTS

cat > "$WORK/entry.cjs" <<'ENTRY'
// `entry.cjs <status.json> <projected path> <out.json>` - EVERY RECORDED FIELD OF ONE ENTRY, and nothing
// else, written where a later run of `fielddiff.cjs` can compare it.
//
// IT REFUSES RATHER THAN EMITTING AN EMPTY RECORD when the entry is not there. Two empty records compare
// equal, so an absent entry would report ZERO disturbed fields — which is the one answer that must never be
// producible by the entry having vanished.
const { readFileSync, writeFileSync } = require('node:fs');
const [, , statusPath, projected, out] = process.argv;
const doc = JSON.parse(readFileSync(statusPath, 'utf8'));
const entries = Array.isArray(doc.entries) ? doc.entries : [];
const found = entries.find((entry) => entry && entry.path === projected);
if (found === undefined) {
  console.error(`  no entry at the projected path this record is about`);
  process.exit(1);
}
const record = {};
for (const key of Object.keys(found).sort()) record[key] = found[key];
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
ENTRY

cat > "$WORK/fielddiff.cjs" <<'FIELDDIFF'
// `fielddiff.cjs <before.json> <after.json>` - HOW MANY RECORDED FIELDS MOVED. Prints one number.
//
// THIS IS P11-M4's MEASUREMENT AND IT IS DERIVED RATHER THAN DECLARED. Phase 10's own independent audit
// found a rehearsal that set `HAND_RUN=0` and then asserted it was zero, with no line in the file able to
// move it. A budget nothing can exceed is not a budget. A field present in one record and absent from the
// other counts, because an entry that lost a field has been disturbed as surely as one whose field changed.
const { readFileSync } = require('node:fs');
const before = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const after = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
let moved = 0;
for (const key of keys) {
  if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) moved += 1;
}
process.stdout.write(String(moved));
FIELDDIFF

cat > "$WORK/unreached.cjs" <<'UNREACHED'
// `unreached.cjs <declared.txt> <reached.txt>` - HOW MANY DECLARED ARMS THIS RUN NEVER REACHED, plus how
// many it reached that the contract never declared. Prints `<unreached> <undeclared>`.
//
// BOTH DIRECTIONS, AND THE SECOND MATTERS AS MUCH AS THE FIRST. A run that invented a seventh arm would
// raise its own denominator and could report "every arm reached" while never having run one of the six.
const { readFileSync } = require('node:fs');
const lines = (path) => readFileSync(path, 'utf8').split('\n').map((line) => line.trim()).filter((l) => l.length > 0);
const declared = lines(process.argv[2]);
const reached = new Set(lines(process.argv[3]));
const undeclared = [...reached].filter((id) => !declared.includes(id));
process.stdout.write(`${declared.filter((id) => !reached.has(id)).length} ${undeclared.length}`);
UNREACHED

cat > "$WORK/kinds.cjs" <<'KINDS'
// `kinds.cjs <status.json>` - HOW MANY PUBLISHED ENTRIES OF EACH KIND THE GENERATION HOLDS. Prints
// `<http-range count> <local count>`.
//
// THE DEFECT THIS REPLACES, AND IT WAS IN THE ARM THE TRANCHE IS NAMED FOR. P11-M1 asked
// `grep -q 'http-range'` and `grep -q '"local"'` over the WHOLE status document. Neither says which ENTRY
// carried which kind, neither says whether the entry was PUBLISHED, and `"local"` is a substring of any field
// or diagnostic that happens to spell it in a document this gate does not own the shape of. A generation
// holding TWO provider-backed entries beside the word "local" would have passed the mixed-generation check,
// which is the one answer P11-M1 exists to make impossible.
//
// The counts it prints are compared against `MIN_TORBOX_ENTRIES` and `MIN_ADMITTED_USENET_ENTRIES` READ FROM
// THE CONTRACT'S OWN MODULE by `minimums.mts`, for the reason `arms.mts` gives about P11-M6's denominator: a
// gate carrying its own copy of a number is a gate whose number can drift from the document's, silently, in
// the direction that makes the run pass.
const { readFileSync } = require('node:fs');
const doc = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const entries = Array.isArray(doc.entries) ? doc.entries : [];
const published = entries.filter((entry) => entry && entry.publication === 'published');
const of = (kind) => published.filter((e) => Array.isArray(e.kinds) && e.kinds.includes(kind)).length;
process.stdout.write(`${of('http-range')} ${of('local')}`);
KINDS

cat > "$WORK/minimums.mts" <<'MINIMUMS'
// The two mixed-generation minimums, READ FROM THE CONTRACT'S OWN MODULE rather than restated here. Both are
// Phase 9's own, imported into `PHASE11_RULES` by Phase 9's name. Prints `<provider-backed> <worker-produced>`.
const root = process.env.PHASE11_ROOT_URL as string;
const module_ = await import(`${root}src/core/projection/phase11.ts`);
const rules = module_.PHASE11_RULES as Record<string, number>;
console.log(`${rules.MIN_TORBOX_ENTRIES} ${rules.MIN_ADMITTED_USENET_ENTRIES}`);
MINIMUMS

cat > "$WORK/arms.mts" <<'ARMS'
// The six arm ids, READ FROM THE CONTRACT'S OWN MODULE rather than restated here.
//
// A gate that carried its own copy of the list would be a gate whose denominator could drift from the
// document's, silently, in the direction that makes the run pass. §5.4 predeclares the arms; this reads them.
const root = process.env.PHASE11_ROOT_URL as string;
const module_ = await import(`${root}src/core/projection/phase11.ts`);
for (const id of module_.PHASE11_ARM_GATE_IDS as readonly string[]) console.log(id);
ARMS

cat > "$WORK/worker-arm.mts" <<'WORKER'
// THE FAKE WORKER ARM, DRIVEN THROUGH THE SHIPPED TRANSPORT, CLIENT, LIFECYCLE TABLE AND PROOF PATH.
//
// WHAT IT STANDS IN FOR, AND WHAT IT THEREFORE CANNOT SAY. A real run has an operator's SABnzbd with a real
// NNTP provider behind it; this has `startFakeSabnzbd` on a loopback port. So it says nothing about a real
// article, a real repair, a real unpack, or a job that arrives incomplete — which is precisely why §5.2's
// four tier-two claims stay NOT RUN and why this file emits no verdict of any kind.
//
// IT IS NOT AN OPERATOR ACTION AND IT IS DELIBERATELY OUTSIDE P11-M5's HAND-RUN RANGE. In a real deployment
// SABnzbd is a SERVICE the operator already runs, not a command they type; counting the driver that stands in
// for it against a budget about the operator's own path would be counting the worker as an intervention.
const ROOT = process.env.PHASE11_ROOT_URL as string;
const MEDIA_ROOT = process.env.PHASE11_MEDIA_ROOT as string;
const RELATIVE_DIR = process.env.PHASE11_COMPLETE_RELATIVE as string;
const OUT = process.env.PHASE11_WORKER_OUT as string;
const BYTES = Number(process.env.PHASE11_CORPUS_BYTES as string);

const { mkdirSync, writeFileSync } = await import('node:fs');
const { startFakeSabnzbd } = await import(`${ROOT}src/core/usenet/sab-fake-service.ts`);
const { SabClient } = await import(`${ROOT}src/core/usenet/sab-client.ts`);
const { createSabHttpTransport } = await import(`${ROOT}src/core/usenet/sab-http-transport.ts`);
const { createRealOutputFileSystem } = await import(`${ROOT}src/core/usenet/output-fs.ts`);
const { proveOutput } = await import(`${ROOT}src/core/usenet/completed-output.ts`);
const { seal } = await import(`${ROOT}src/core/usenet/sealed.ts`);
const { SAB_HISTORY_STATUS_LIFECYCLE } = await import(`${ROOT}src/core/usenet/sab-contract.ts`);

const FILE_NAME = 'worker-produced.mkv';
const segments = [...RELATIVE_DIR.split('/').filter((part: string) => part.length > 0), FILE_NAME];
const absoluteDir = `${MEDIA_ROOT}/${RELATIVE_DIR}`;
const absolutePath = `${absoluteDir}/${FILE_NAME}`;

const problems: string[] = [];
const note = (ok: boolean, message: string): void => { if (!ok) problems.push(message); };

const worker = await startFakeSabnzbd({ apiKey: 'phase11fakeworkerkey' });
let result: Record<string, unknown> = {};
try {
  const client = new SabClient({
    endpoint: worker.endpoint,
    apiKey: seal('sab-api-key', 'phase11fakeworkerkey'),
    transport: createSabHttpTransport(),
  });

  note((await client.version()).ok, 'the fake worker did not answer a version through the shipped transport');

  const marker = `projection-${'b'.repeat(32)}`;
  const submitted = await client.submitUrl(seal('nzb-source', 'https://example.invalid/one.nzb'), marker);
  note(submitted.ok, 'the shipped client could not submit to the fake worker');
  note(worker.submitCount() === 1, `the submission reached the worker ${worker.submitCount()} times`);

  // THE SYNTHETIC CORPUS, WRITTEN WHERE A WORKER WOULD HAVE PUT IT, and not all one value so that a probe
  // window over it is a meaningful digest. §9.1: synthesised in the run directory, and no operator content.
  mkdirSync(absoluteDir, { recursive: true });
  const buffer = Buffer.alloc(BYTES);
  for (let index = 0; index < BYTES; index += 1) buffer[index] = (index * 31 + 7) & 0xff;
  writeFileSync(absolutePath, buffer);

  worker.complete(marker, { storagePath: absolutePath, bytes: BYTES });

  const history = await client.history();
  note(history.ok, 'the shipped client could not read the fake worker history');
  const slot = history.ok ? history.value.find((one: { marker: string | null }) => one.marker === marker) : undefined;
  note(slot !== undefined, 'the completed job is not in the history the shipped client read');
  // THE OPERATOR-VISIBLE STATE IS DERIVED FROM THE SHIPPED LIFECYCLE TABLE, not compared against a literal.
  // A literal here would be this gate's opinion about what SABnzbd's word means; the table is the contract's.
  const jobState = slot === undefined ? null : SAB_HISTORY_STATUS_LIFECYCLE[slot.status] ?? null;
  note(jobState === 'ready-to-admit', `the completed job reads as ${String(jobState)} and not ready-to-admit`);

  // THE SHIPPED PROOF PATH, NOT A RE-IMPLEMENTATION OF IT. No-follow component walk, stable-size dwell,
  // whole-file digest through one descriptor, fstat on that descriptor, and a final lstat on the name.
  const proven = await proveOutput(
    createRealOutputFileSystem(),
    { sleep: (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }) },
    MEDIA_ROOT,
    segments,
  );
  note(proven.ok, `the shipped proof path refused the worker's output: ${proven.ok ? '' : String(proven.reason)}`);

  result = {
    submitCount: worker.submitCount(),
    jobState,
    proven: proven.ok,
    sizeBytes: proven.ok ? proven.value.sizeBytes : null,
    sha256: proven.ok ? proven.value.sha256 : null,
    relativePath: segments.join('/'),
    problems,
  };
} finally {
  await worker.close();
}

writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log('worker-arm: one submission, one completed job, proved through the shipped path');
WORKER

# ---------------------------------------------------------------------------------------------------------
# CAN THIS HOST EVEN EXPRESS WHAT THE SHIPPED COMMANDS REQUIRE? Both probes run here, before anything is
# created, and both SKIP rather than fail. See `identity.cjs` and `probe.cjs` for what each one is about.
# ---------------------------------------------------------------------------------------------------------

printf '%s' "$WORK" > "$WORK/.path-probe"
node "$WORK/probe.cjs" "$WORK/.path-probe" || {
  leave_with_nothing
  skip "this host cannot present its own run directory at a path the shipped commands will accept: the \
content configuration requires an absolute POSIX path, and the one this shell produced is not the one the \
Node runtime resolves. That refusal is the product being correct. Run this on the appliance host."
}

node "$WORK/identity.cjs" "$WORK/.identity-probe" || {
  leave_with_nothing
  skip "this host does not agree with itself about which file a descriptor is open on: an lstat and an fstat \
of the same path report different device numbers, so the shipped admission proof refuses every completed \
output as mutated. That is a fact about this filesystem and not about the product. Run this on the appliance \
host."
}

# CAN A MOUNT MADE INSIDE THE APPLIANCE REACH THIS HOST'S OWN NAMESPACE? THE THIRD PROBE, AND THE ONE THIS
# TRANCHE NEVER ASKED.
#
# The shipped profile binds the mount point `:rshared` and the consumer below binds it `:rslave`; both require
# the run directory to sit on a subtree whose propagation is shared. Docker refuses the bind outright when it
# does not, so without this probe the answer arrives as a RED P11-M2 that is a fact about the directory rather
# than about the two halves. §7 R5's design rule: a red run caused by which machine it was launched on is not
# a verdict about the product.
#
# IT IS ASKED AFTER THE OTHER TWO ON PURPOSE. `findmnt` is Linux, and on a development host the path probe
# above has already skipped for a reason that is upstream of this one — so a host reaching this line and
# lacking `findmnt` is a host where the question genuinely cannot be asked, and a check that could not run is
# not a check that passed. `deploy/projection-gate-cleanup.sh` takes the same position about the same tool.
command -v findmnt >/dev/null 2>&1 || {
  leave_with_nothing
  skip "findmnt is not on this host, so whether the appliance's shared bind of the run directory can be \
created cannot be asked, and a check that could not run is not a check that passed"
}
case "$(findmnt -no PROPAGATION -T "$WORK" 2>/dev/null | head -1)" in
  *shared*) : ;;
  *)
    PROPAGATION_IS="$(findmnt -no TARGET,PROPAGATION -T "$WORK" 2>/dev/null | head -1)"
    leave_with_nothing
    skip "the run directory sits on a subtree whose propagation is not shared ($PROPAGATION_IS), so the \
shipped appliance profile's shared bind of the mount point cannot be created and no media server in another \
container could see the namespace. Set PROJECTION_PHASE11_GATE_ROOT to a directory on a shared subtree, or \
run this from a checkout on one. That is a fact about this host's mount table and not about the product."
    ;;
esac

CONTAINERS_BEFORE="$(docker ps -aq | sort | tr '\n' ' ')"
NETWORKS_BEFORE="$(docker network ls -q | sort | tr '\n' ' ')"
VOLUMES_BEFORE="$(docker volume ls -q | sort | tr '\n' ' ')"

# `endpoint.json` IS NOT READ, WRITTEN OR TOUCHED, and the mtime is how that is checked rather than promised.
ENDPOINT_FILE="${PROJECTIOND_ENDPOINT_FILE:-$ROOT/endpoint.json}"
ENDPOINT_MTIME_BEFORE="absent"
[ -f "$ENDPOINT_FILE" ] && ENDPOINT_MTIME_BEFORE="$(node "$WORK/mtime.cjs" "$ENDPOINT_FILE")"

cleanup() {
  local status=$?
  bash "$ALPHA_COMMAND" stop >/dev/null 2>&1 || true
  docker rm -f "$CONSUMER_CONTAINER" "$ORIGIN_CONTAINER" >/dev/null 2>&1 || true
  docker compose -p "$ALPHA_NETWORK" -f "$ROOT/docker-compose.projection-alpha.yml" down --remove-orphans \
    >/dev/null 2>&1 || true
  docker rm -f "$APPLIANCE" >/dev/null 2>&1 || true
  docker network rm "$ALPHA_NETWORK" >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_FILE" -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
  # THE RUN DIRECTORY GOES THROUGH THE SHIPPED CLEANUP RATHER THAN THROUGH `rm -rf`. On the failure paths this
  # trap exists for, the appliance's FUSE mount may still be standing at `$WORK/mnt`: `rm -rf` over a live
  # mount leaves the mountpoint behind at best, and the next run inherits a namespace and passes for the wrong
  # reason. The helper removes the mount in a namespace that PROPAGATES BACK, verifies it went, retries within
  # a bounded count, and only then removes the directory. It refuses any path that is not under the gate root.
  projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true
  projection_gate_report_cleanliness "$GATE_ROOT" "$WORK" || true
  rmdir "$GATE_ROOT" 2>/dev/null || true
  return "$status"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------------------------------------
step "the Phase 11 offline suites"
# ---------------------------------------------------------------------------------------------------------
# THEY RUN FIRST, AND THE ORDER IS THE POINT. Phase 9's rehearsal learned this the hard way: running the
# suites afterwards meant the driver had already claimed them while nothing had been measured.

( cd "$ROOT" && npx tsx src/ops/test-runner-cli.ts --group offline --filter phase11 ) \
  || fail "the Phase 11 offline suites did not pass"

# ---------------------------------------------------------------------------------------------------------
# THE TWO COUNTERS THIS RUN'S MEASURED CLAIMS DEPEND ON, PROVED TO COUNT BEFORE THEY ARE TRUSTED.
#
# A `grep -c` that matched nothing for the wrong reason reports the same zero as a section that had none, and
# a field diff over two records that failed to load reports the same zero as two records that agree. Phase
# 10's audit found exactly this shape as its seventh defect, and these are the controls that answer it.
# ---------------------------------------------------------------------------------------------------------

HAND_RUN_CONTROL="$(printf '%s\n' 'npx tsx src/ops/projection-register-cli.ts --root media' \
  | grep -cE 'npx tsx|npm run ops:')"
[ "$HAND_RUN_CONTROL" -eq 1 ] \
  || fail "the hand-run counter cannot count, so the zero it would report proves nothing"

printf '%s\n' '{"path":"a","size":1}' > "$WORK/control-before.json"
printf '%s\n' '{"path":"a","size":2}' > "$WORK/control-after.json"
FIELD_CONTROL="$(node "$WORK/fielddiff.cjs" "$WORK/control-before.json" "$WORK/control-after.json")"
[ "$FIELD_CONTROL" -eq 1 ] \
  || fail "the field-difference counter cannot count, so the zero P11-M4 would report proves nothing"

# THE REPOSITORY AS A URL THE NODE RUNTIME CAN IMPORT FROM, and `pwd -W` is what makes it right on both
# platforms rather than nearly right on one. MSYS answers the Windows spelling; every other shell does not
# have the switch and the POSIX path is already correct. The earlier form rewrote a leading `/x/` into `x:/`
# with a regular expression, which is correct under Git Bash and WRONG on a Linux host whose repository sits
# under a single-letter top-level directory — a defect that would have appeared only on the appliance.
ROOT_NATIVE="$( (cd "$ROOT" && pwd -W) 2>/dev/null || printf '%s' "$ROOT" )"
ROOT_URL="file:///$(printf '%s' "$ROOT_NATIVE" | sed 's|^/||')/"
( cd "$ROOT" && PHASE11_ROOT_URL="$ROOT_URL" npx tsx "$WORK/arms.mts" > "$WORK/arms-declared.txt" ) \
  || fail "the contract's own arm list could not be read, so P11-M6 has no denominator"
DECLARED_COUNT="$(grep -c . "$WORK/arms-declared.txt")"
[ "$DECLARED_COUNT" -eq 6 ] || fail "the contract declares $DECLARED_COUNT arms and §5.4 predeclares six"

printf '%s\n' 'P11-M1-mixed-generation-assembled' > "$WORK/control-reached.txt"
ARM_CONTROL="$(node "$WORK/unreached.cjs" "$WORK/arms-declared.txt" "$WORK/control-reached.txt" | cut -d' ' -f1)"
[ "$ARM_CONTROL" -eq 5 ] \
  || fail "the unreached-arm counter cannot count, so the zero P11-M6 would report proves nothing"

# P11-M1's TWO MINIMUMS, READ OUT OF THE CONTRACT'S OWN MODULE BEFORE THE OPERATOR PATH BEGINS — the same
# arrangement `arms-declared.txt` makes for P11-M6's denominator, and for the same reason.
( cd "$ROOT" && PHASE11_ROOT_URL="$ROOT_URL" npx tsx "$WORK/minimums.mts" > "$WORK/mixed-minimums.txt" ) \
  || fail "the contract's own mixed-generation minimums could not be read, so P11-M1 has nothing to measure"
MIN_REMOTE="$(cut -d' ' -f1 "$WORK/mixed-minimums.txt" | tr -d '\n\r ')"
MIN_LOCAL="$(cut -d' ' -f2 "$WORK/mixed-minimums.txt" | tr -d '\n\r ')"
numeric "the provider-backed entry minimum" "$MIN_REMOTE" || fail "the contract's minimums are not numbers"
numeric "the worker-produced entry minimum" "$MIN_LOCAL" || fail "the contract's minimums are not numbers"
[ "$MIN_REMOTE" -ge 1 ] && [ "$MIN_LOCAL" -ge 1 ] \
  || fail "a mixed-generation minimum is below one, so a generation holding a single kind would satisfy it"

# AND THE KIND COUNTER IS PROVED TO COUNT BEFORE IT IS TRUSTED, exactly as the hand-run, field-difference and
# unreached-arm counters are. The control document holds one published entry of each kind and one UNPUBLISHED
# local entry, so an answer of `1 1` proves both that the kinds are read per entry and that an admitted entry
# nobody published is not counted as part of the published generation.
printf '%s\n' '{"entries":[{"path":"a","kinds":["http-range"],"publication":"published"},{"path":"b","kinds":["local"],"publication":"admitted-not-published"},{"path":"c","kinds":["local"],"publication":"published"}]}' \
  > "$WORK/control-status.json"
KIND_CONTROL="$(node "$WORK/kinds.cjs" "$WORK/control-status.json")"
[ "$KIND_CONTROL" = "1 1" ] \
  || fail "the kind counter cannot count, so the mixture P11-M1 would report proves nothing (it said '$KIND_CONTROL')"

# ---------------------------------------------------------------------------------------------------------
step "a throwaway PostgreSQL on 127.0.0.1:$PG_PORT, migrated"
# ---------------------------------------------------------------------------------------------------------

# `--wait-timeout` IS THE DIFFERENCE BETWEEN A GATE THAT FAILS AND A GATE THAT HANGS. `--wait` on its own has
# no bound, so a database that never reports healthy — an image that will not pull, a port already held, a
# host under load — leaves this command waiting with no output and nothing to read. Every other wait in this
# script is bounded by an attempt count; this one was not.
PROJECTION_PHASE11_GATE_PG_PORT="$PG_PORT" \
  docker compose -f "$COMPOSE_FILE" -p "$PROJECT" up -d --wait --wait-timeout "$PG_WAIT_SECONDS" \
  || fail "the throwaway PostgreSQL did not become healthy within ${PG_WAIT_SECONDS}s"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
( cd "$ROOT" && npx tsx src/ops/migrate-cli.ts >"$WORK/migrate.txt" 2>&1 ) || {
  tail -20 "$WORK/migrate.txt" >&2
  fail "the throwaway database could not be migrated"
}
say "migrated"

# ---------------------------------------------------------------------------------------------------------
step "the fake range origin, and the operator-shaped inputs it implies"
# ---------------------------------------------------------------------------------------------------------
# THE FAKE ORIGIN IS THE PRODUCT'S OWN AND IT IS BUILT THE WAY EVERY OTHER GATE BUILDS IT: `go run
# ./cmd/fakerange` inside the pinned Go toolchain image, with the repository bind-mounted. It is deliberately
# NOT in the projectiond image — the production artifact ships one binary, and a fault injector does not
# belong in what an operator deploys.

mkdir -p "$WORK/origin-out" "$WORK/origin-in" "$WORK/media" "$WORK/manifest" "$WORK/cache" "$WORK/mnt" \
  "$WORK/secrets"
chmod 777 "$WORK/cache" "$WORK/mnt" 2>/dev/null || true
printf '%s' 'phase11-fake-origin-token' > "$WORK/origin-in/credential"
chmod 600 "$WORK/origin-in/credential" 2>/dev/null || true
cp "$WORK/origin-in/credential" "$WORK/secrets/origin-token"
chmod 600 "$WORK/secrets/origin-token" 2>/dev/null || true

docker run -d --name "$ORIGIN_CONTAINER" -p "127.0.0.1:${ORIGIN_PORT}:8099" \
  -v "$ROOT:/workspace" -w /workspace/projectiond \
  -v "$WORK/origin-in:/inputs:ro" -v "$WORK/origin-out:/out" \
  -e GOFLAGS=-buildvcs=false -e GOTOOLCHAIN=local -e CGO_ENABLED=0 \
  "$GO_IMAGE" go run ./cmd/fakerange --addr 0.0.0.0:8099 \
  --object "phase11-object-1:${ORIGIN_OBJECT_BYTES}" \
  --token-file /inputs/credential --emit /out/objects.json >/dev/null \
  || skip "the fake range origin did not start, and a Go toolchain image this host cannot pull is a fact \
about the host rather than about the product"

# WAITING FOR THE ORIGIN IS A FUNCTION BECAUSE IT IS NEEDED TWICE, and the second time is the one that would
# otherwise be forgotten: P11-M4 STOPS this container and starts it again, and a `go run` process that has to
# come back up is not ready the instant `docker start` returns. Reading the other half before it was would
# have failed the arm for a reason that has nothing to do with what the arm measures.
await_origin() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    # LIVENESS IS `/counters`, NOT A RANGED GET. A readiness loop that sent a ranged request would be real
    # object traffic: it would serve bytes and be counted, dozens of times on a slow host, before this gate
    # had asserted anything about which reads moved the counters.
    if curl -fsS "http://127.0.0.1:${ORIGIN_PORT}/counters" >/dev/null 2>&1; then return 0; fi
    say "waiting for the fake range origin (attempt $attempt)"
    sleep 2
  done
  return 1
}

await_origin || skip "the fake range origin never came up on this host"
[ -s "$WORK/origin-out/objects.json" ] || fail "the fake range origin started and emitted no descriptor"

node "$WORK/objects.cjs" "$WORK/origin-out/objects.json" "$WORK/torbox-objects.json" \
  "$ORIGIN_OBJECT_BYTES" 'remote-one' '22222222-2222-4222-8222-222222222222' "$ENTRY_REMOTE" \
  || fail "the fake origin's descriptor could not be turned into the operator's object manifest"

# ---------------------------------------------------------------------------------------------------------
step "the fake SABnzbd worker, and the synthetic corpus it completes"
# ---------------------------------------------------------------------------------------------------------

WORKER_RELATIVE="complete/projection/worker-one"
( cd "$ROOT" && PHASE11_ROOT_URL="$ROOT_URL" PHASE11_MEDIA_ROOT="$WORK/media" \
  PHASE11_COMPLETE_RELATIVE="$WORKER_RELATIVE" PHASE11_WORKER_OUT="$WORK/worker.json" \
  PHASE11_CORPUS_BYTES="$CORPUS_BYTES" npx tsx "$WORK/worker-arm.mts" >"$WORK/worker.txt" 2>&1 ) || {
  tail -20 "$WORK/worker.txt" >&2
  fail "the fake worker arm did not complete a job the shipped proof path would accept"
}
say "$(head -1 "$WORK/worker.txt")"
node "$WORK/expect.cjs" "$WORK/worker.json" submitCount 1 || fail "the submission did not reach the worker once"
node "$WORK/expect.cjs" "$WORK/worker.json" proven true || fail "the worker's output was not proved"

cat > "$WORK/local-objects.json" <<OBJECTSJSON
[
  { "label": "worker-one",
    "itemId": "11111111-1111-4111-8111-111111111111",
    "path": "$ENTRY_LOCAL",
    "relativePath": "$WORKER_RELATIVE/worker-produced.mkv" }
]
OBJECTSJSON

CONFIG_FILE="$WORK/content.json"
cat > "$CONFIG_FILE" <<CONFIGJSON
{
  "manifestDir": "$WORK/manifest",
  "mediaRoot": "$WORK/media",
  "rootId": "media",
  "endpointId": "vault"
}
CONFIGJSON

# THE APPLIANCE'S OWN CONFIGURATION, IN THE IN-CONTAINER PATHS THE SHIPPED COMPOSE FILE BINDS.
#
# `statusAddr` IS HERE BECAUSE THE SHIPPED PREFLIGHT REFUSES WITHOUT IT, AND THIS GATE OMITTED IT.
#
# PHASE 12 §11 D8, FOUND BY THE FIRST RUN THAT EVER REACHED AN ARM. `projection-alpha.sh preflight` counts a
# configuration with no usable `statusAddr` as a FAILED CHECK — "status and the healthcheck cannot work" — so
# preflight, install and start all refused, the appliance never came up, no mount ever existed, and P11-M2,
# P11-M3 and P11-M4 failed on reads of a namespace that was never there. The refusal is the shipped script
# being right; the gate was handing it a configuration an operator would not.
#
# 9010 IS ITS OWN, and `test/projection-phase11.ts` cross-checks it against every other deploy script and
# compose file rather than trusting this comment. 9000 is `projection-alpha-acceptance.sh`'s, 9099 is another
# gate's, and two appliances answering on one status port would be two gates lending each other a healthcheck.
cat > "$WORK/config.json" <<'DAEMONJSON'
{
  "mountPoint": "/mnt/projection",
  "pointerPath": "/var/lib/projectiond/manifest/pointer.json",
  "probeCacheDir": "/var/lib/projectiond/cache",
  "statusAddr": "127.0.0.1:9010",
  "localRoots": { "media": "/var/lib/projectiond/media" },
  "endpoints": [
    {
      "id": "vault",
      "directBaseUrl": "http://fakerange:8099/direct",
      "allowedOrigins": ["http://fakerange:8099"],
      "tokenFile": "/run/secrets/origin-token",
      "allowInsecureHttp": true,
      "allowPrivateAddresses": true,
      "maxConnections": 2
    }
  ]
}
DAEMONJSON

content() { bash "$CONTENT_COMMAND" "$@" --config "$CONFIG_FILE" --database-url "$DATABASE_URL"; }
alpha()   { bash "$ALPHA_COMMAND" "$@"; }

export PROJECTIOND_ALPHA_IMAGE="$IMAGE"
export PROJECTIOND_ALPHA_MANIFEST_DIR="$WORK/manifest"
export PROJECTIOND_ALPHA_MEDIA_ROOT="$WORK/media"
export PROJECTIOND_ALPHA_CACHE_DIR="$WORK/cache"
export PROJECTIOND_ALPHA_MOUNT="$WORK/mnt"
export PROJECTIOND_ALPHA_CONFIG="$WORK/config.json"
export PROJECTIOND_ALPHA_SECRETS_DIR="$WORK/secrets"

counters() { curl -fsS "http://127.0.0.1:${ORIGIN_PORT}/counters" 2>/dev/null | tr -d '\n '; }
#
# THE DEFECT THIS REPAIRS. `consumer_sha` sends its errors to /dev/null and pipes through `awk`, so a mount
# that is not there, a consumer that lost its bind, or a daemon that stopped answering all return the EMPTY
# STRING. P11-M3 and P11-M4 each compared one of those against another, and `[ "" = "" ]` is true — so an
# appliance that had died between two arms would have reported the provider-backed half as byte-identical
# before and after, three times, and the arm would have passed on the absence of the thing it measures. It is
# the same shape as `entry.cjs` refusing an absent entry rather than emitting an empty record, one layer out,
# and it was pinned in the helper and not at the call sites.
same_bytes() {
  local what="$1" before="$2" after="$3"
  if [ -z "$before" ] || [ -z "$after" ]; then
    echo "  $what: a digest is EMPTY, so nothing was read and no comparison can be made" >&2
    return 1
  fi
  [ "$before" = "$after" ]
}

# A COUNTER THAT DID NOT RUN REPORTS THE PASSING VALUE, AND SHELL ARITHMETIC IS WHERE THAT HAPPENS SILENTLY:
# `$(( A + B ))` with A unset or empty is ZERO, which is exactly the budget P11-M4 is measured against. So
# every derived number is asserted to BE a number before it is compared or added. §7 R3 and R4's whole
# argument is that these numbers are derived rather than declared; a derivation that failed and answered zero
# is a declaration wearing the derivation's clothes.
numeric() {
  case "${2:-}" in
    ''|*[!0-9]*)
      echo "  $1 did not produce a number, so the zero it would contribute proves nothing" >&2
      return 1 ;;
  esac
  return 0
}

# P11-M5's MEASUREMENT, DERIVED FROM THE RUN RATHER THAN DECLARED, and computed HERE so that the pattern
# which finds a hand-run invocation is not itself inside the range it searches. The range markers are the two
# comment lines below; the worker driver and the offline suites are deliberately OUTSIDE it, because a
# stand-in for a service an operator already runs is not a command the operator typed.
HAND_RUN="$(sed -n '/^# HAND-RUN RANGE BEGIN/,/^# HAND-RUN RANGE END/p' "$0" | grep -cE 'npx tsx|npm run ops:')"

# HAND-RUN RANGE BEGIN
# ---------------------------------------------------------------------------------------------------------
step "P11-M1 — one generation, both kinds, through the SHIPPED verbs only"
# ---------------------------------------------------------------------------------------------------------

arm P11-M1-mixed-generation-assembled
M1=pass

content preflight >"$WORK/preflight.txt" 2>&1 || { cat "$WORK/preflight.txt" >&2; M1=fail; }

content add-torbox --file "$WORK/torbox-objects.json" >"$WORK/add-torbox.txt" 2>&1 \
  || { cat "$WORK/add-torbox.txt" >&2; M1=fail; }

# NOTHING IS PUBLISHED YET, AND THE POINTER IS HOW THAT IS CHECKED rather than the command's own word for it.
[ -e "$WORK/manifest/pointer.json" ] \
  && { echo "add-torbox published a generation, which no verb but publish may do" >&2; M1=fail; }

content add-local --file "$WORK/local-objects.json" --publish >"$WORK/add-local.txt" 2>&1 \
  || { cat "$WORK/add-local.txt" >&2; M1=fail; }
[ -e "$WORK/manifest/pointer.json" ] || { echo "an explicit --publish minted no pointer" >&2; M1=fail; }

content status --json >"$WORK/status-1.json" 2>&1 || { cat "$WORK/status-1.json" >&2; M1=fail; }
node "$WORK/expect.cjs" "$WORK/status-1.json" counts.registered 2 || M1=fail
node "$WORK/expect.cjs" "$WORK/status-1.json" counts.published 2 || M1=fail
node "$WORK/expect.cjs" "$WORK/status-1.json" agrees true || M1=fail

# THE GENERATION IS MIXED, AND BOTH MINIMUMS ARE PHASE 9'S OWN, READ FROM THE CONTRACT'S MODULE. A generation
# holding two entries of one kind is not a mixed generation, and calling one that is the only way this arm
# could pass having composed nothing. COUNTED PER ENTRY AND OVER THE PUBLISHED SET, not grepped for as two
# substrings of a document this gate does not own the shape of.
MIXED_COUNTS="$(node "$WORK/kinds.cjs" "$WORK/status-1.json")"
REMOTE_ENTRIES="$(printf '%s' "$MIXED_COUNTS" | cut -d' ' -f1)"
LOCAL_ENTRIES="$(printf '%s' "$MIXED_COUNTS" | cut -d' ' -f2)"
say "published entries by kind: $REMOTE_ENTRIES provider-backed, $LOCAL_ENTRIES worker-produced \
(minimums $MIN_REMOTE and $MIN_LOCAL, from the contract's own module)"
numeric "the provider-backed entry count" "$REMOTE_ENTRIES" || M1=fail
numeric "the worker-produced entry count" "$LOCAL_ENTRIES" || M1=fail
[ "${REMOTE_ENTRIES:-0}" -ge "${MIN_REMOTE:-1}" ] 2>/dev/null \
  || { echo "the published generation holds $REMOTE_ENTRIES provider-backed entries and §5.1 requires \
$MIN_REMOTE, so it is not a mixed generation" >&2; M1=fail; }
[ "${LOCAL_ENTRIES:-0}" -ge "${MIN_LOCAL:-1}" ] 2>/dev/null \
  || { echo "the published generation holds $LOCAL_ENTRIES worker-produced local entries and §5.1 requires \
$MIN_LOCAL, so it is not a mixed generation" >&2; M1=fail; }

verdict P11-M1-mixed-generation-assembled "$M1"

# ---------------------------------------------------------------------------------------------------------
step "P11-M2 — both halves readable through the ONE mount the appliance owns"
# ---------------------------------------------------------------------------------------------------------
# THE APPLIANCE IS THE SHIPPED SCRIPT'S, AND SO IS THE MOUNT. §4's fourth hard refusal: this gate never
# mounts, binds, unmounts or writes inside the mount point, and the consumer attaches BEFORE anything is ever
# mounted there — Phase 0 §11's rule, because a bind taken afterwards is stranded by the first recovery.

arm P11-M2-both-halves-readable-through-one-mount
M2=pass

docker run -d --name "$CONSUMER_CONTAINER" --user 1000:1000 \
  -v "$WORK/mnt:/media/projection:rslave" "$VERIFY_IMAGE" \
  sh -c 'while :; do sleep 3600; done' >/dev/null \
  || fail "the consumer could not attach, so nothing below would be reading through a shared mount"

alpha preflight >"$WORK/alpha-preflight.txt" 2>&1 || { tail -20 "$WORK/alpha-preflight.txt" >&2; M2=fail; }
alpha install >"$WORK/alpha-install.txt" 2>&1 || { tail -20 "$WORK/alpha-install.txt" >&2; M2=fail; }
alpha start >"$WORK/alpha-start.txt" 2>&1 || { tail -20 "$WORK/alpha-start.txt" >&2; M2=fail; }

# THE FAKE ORIGIN JOINS THE APPLIANCE'S OWN NETWORK UNDER THE NAME ITS CONFIGURATION USES. The network is the
# shipped profile's; this gate adds one alias to it and removes it again, and creates no network of its own.
docker network connect --alias fakerange "$ALPHA_NETWORK" "$ORIGIN_CONTAINER" >/dev/null 2>&1 \
  || { echo "the fake origin could not join the appliance network" >&2; M2=fail; }

consumer_sha() { docker exec -u 1000:1000 "$CONSUMER_CONTAINER" \
  sh -c "sha256sum '/media/projection/$1'" 2>/dev/null | awk '{print $1}'; }

# THE LOCAL HALF IS SERVED FROM DISK, and the fake origin's counters must not move for it. A local entry that
# reached the network would be an entry served by the other half's path, which is the failure this arm names.
# THE ORIGIN MUST BE QUIESCENT BEFORE ANYTHING IS ATTRIBUTED TO A READ, and this is the difference between a
# measurement and a coincidence. P11-M2's whole distinction is "the local read moved no range traffic" — and
# a daemon that was still warming a probe cache in the background would move the counters underneath the
# local read and fail the arm for something the local read did not do. So the counters are sampled until two
# consecutive samples agree; if they never do, the arm CANNOT ATTRIBUTE and says so rather than guessing in
# either direction.
await_quiet_origin() {
  local attempt first second
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    first="$(counters)"
    sleep 3
    second="$(counters)"
    if [ "$first" = "$second" ] && [ -n "$first" ]; then return 0; fi
    say "the range origin is still serving on its own (attempt $attempt); waiting to attribute a read to it"
  done
  return 1
}

await_quiet_origin \
  || { echo "the range origin never went quiet, so no read can be attributed to either half" >&2; M2=fail; }

COUNTERS_BEFORE_LOCAL="$(counters)"
LOCAL_THROUGH_MOUNT="$(consumer_sha "$ENTRY_LOCAL")"
COUNTERS_AFTER_LOCAL="$(counters)"
LOCAL_ON_DISK="$(node "$WORK/sha.cjs" "$WORK/media/$WORKER_RELATIVE/worker-produced.mkv")"
same_bytes "the worker-produced half through the mount against its own bytes on disk" \
  "$LOCAL_THROUGH_MOUNT" "$LOCAL_ON_DISK" \
  || { echo "the worker-produced entry did not read back through the mount as its own bytes" >&2; M2=fail; }
[ "$COUNTERS_BEFORE_LOCAL" = "$COUNTERS_AFTER_LOCAL" ] \
  || { echo "reading the local half moved the range origin's counters" >&2; M2=fail; }

# THE PROVIDER-BACKED HALF IS SERVED BY RANGE, and the counters must move for it.
#
# AND THE ORIGIN IS QUIESCED AGAIN FIRST, WHICH IS §7 R8's OWN ARGUMENT APPLIED IN THE DIRECTION IT WAS NOT.
# The tranche quiesced before the LOCAL read, because there the risk is counters moving underneath a read that
# should not have moved them. The remote read's risk is the mirror image and it is the one that produces a
# FALSE PASS: "the counters moved" is satisfied by any traffic at all, including a probe cache the daemon was
# warming on its own — so an appliance that never served the range read would still have reported that it did.
# Attribution has to hold in both directions or it is not attribution.
await_quiet_origin \
  || { echo "the range origin never went quiet before the provider-backed read, so no traffic can be \
attributed to it" >&2; M2=fail; }
COUNTERS_BEFORE_REMOTE="$(counters)"
REMOTE_THROUGH_MOUNT="$(consumer_sha "$ENTRY_REMOTE")"
COUNTERS_AFTER_REMOTE="$(counters)"
[ -n "$REMOTE_THROUGH_MOUNT" ] \
  || { echo "the provider-backed entry did not read back through the mount at all" >&2; M2=fail; }
[ "$COUNTERS_BEFORE_REMOTE" != "$COUNTERS_AFTER_REMOTE" ] \
  || { echo "reading the provider-backed half moved no range traffic, so it was not served as one" >&2; M2=fail; }

verdict P11-M2-both-halves-readable-through-one-mount "$M2"

# ---------------------------------------------------------------------------------------------------------
step "P11-M3 — publishing one half moves no field of the other"
# ---------------------------------------------------------------------------------------------------------

arm P11-M3-publish-does-not-move-the-other-half
M3=pass

node "$WORK/entry.cjs" "$WORK/status-1.json" "$ENTRY_REMOTE" "$WORK/remote-before-publish.json" || M3=fail

# A SECOND LOCAL ENTRY, ADDED AND PUBLISHED, so the generation genuinely changes around the half under test.
node "$WORK/fill.cjs" "$WORK/media/$WORKER_RELATIVE/second.mkv" "$CORPUS_BYTES" \
  || fail "the second local object could not be synthesised"
cat > "$WORK/local-objects-2.json" <<OBJECTSTWO
[
  { "label": "worker-two",
    "itemId": "33333333-3333-4333-8333-333333333333",
    "path": "Movies/Worker Two (2026)/Worker Two (2026).mkv",
    "relativePath": "$WORKER_RELATIVE/second.mkv" }
]
OBJECTSTWO

content add-local --file "$WORK/local-objects-2.json" --publish >"$WORK/add-local-2.txt" 2>&1 \
  || { cat "$WORK/add-local-2.txt" >&2; M3=fail; }
content status --json >"$WORK/status-2.json" 2>&1 || M3=fail
node "$WORK/expect.cjs" "$WORK/status-2.json" counts.registered 3 || M3=fail
node "$WORK/entry.cjs" "$WORK/status-2.json" "$ENTRY_REMOTE" "$WORK/remote-after-publish.json" || M3=fail

M3_MOVED="$(node "$WORK/fielddiff.cjs" "$WORK/remote-before-publish.json" "$WORK/remote-after-publish.json")"
say "fields of the provider-backed entry moved by a publish of the other half: $M3_MOVED"
numeric "the publish-time field difference" "$M3_MOVED" || M3=fail
[ "${M3_MOVED:-1}" = "0" ] || M3=fail

# AND ITS BYTES DID NOT MOVE EITHER. A record that agrees while the bytes changed is a record that is
# describing something other than what a media server reads.
REMOTE_AFTER_PUBLISH="$(consumer_sha "$ENTRY_REMOTE")"
same_bytes "the provider-backed half before and after a publish of the other" \
  "$REMOTE_THROUGH_MOUNT" "$REMOTE_AFTER_PUBLISH" \
  || { echo "the provider-backed half read back differently after the other half was published" >&2; M3=fail; }

verdict P11-M3-publish-does-not-move-the-other-half "$M3"

# ---------------------------------------------------------------------------------------------------------
step "P11-M4 — one source fails, and the other is not disturbed"
# ---------------------------------------------------------------------------------------------------------
# THIS IS THE ARM THE TRANCHE EXISTS FOR, AND ITS NUMBER IS DIFFED RATHER THAN DECLARED. Two injections, in
# both directions, because "the Usenet half cannot touch the TorBox half" and "the TorBox half cannot touch
# the Usenet half" are two claims and a run that made one of them has made one of them.

arm P11-M4-one-source-failing-disturbs-nothing-of-the-other
M4=pass

# INJECTION A — the range origin stops. The worker-produced half must be untouched and still readable.
node "$WORK/entry.cjs" "$WORK/status-2.json" "$ENTRY_LOCAL" "$WORK/local-before-outage.json" || M4=fail
docker stop "$ORIGIN_CONTAINER" >/dev/null 2>&1 || { echo "the range origin could not be stopped" >&2; M4=fail; }
content status --json >"$WORK/status-3.json" 2>&1 || M4=fail
node "$WORK/entry.cjs" "$WORK/status-3.json" "$ENTRY_LOCAL" "$WORK/local-after-outage.json" || M4=fail
M4_A="$(node "$WORK/fielddiff.cjs" "$WORK/local-before-outage.json" "$WORK/local-after-outage.json")"
LOCAL_DURING_OUTAGE="$(consumer_sha "$ENTRY_LOCAL")"
same_bytes "the worker-produced half during the range-origin outage" \
  "$LOCAL_DURING_OUTAGE" "$LOCAL_ON_DISK" \
  || { echo "a range-origin outage made the worker-produced half unreadable" >&2; M4=fail; }
docker start "$ORIGIN_CONTAINER" >/dev/null 2>&1 || true
await_origin || { echo "the range origin did not come back after the injected outage" >&2; M4=fail; }

# INJECTION B — the worker's completed file is removed. The provider-backed half must be untouched and still
# readable, and nothing may degrade itself: Phase 10 §4's second refusal is imported unchanged.
node "$WORK/entry.cjs" "$WORK/status-3.json" "$ENTRY_REMOTE" "$WORK/remote-before-loss.json" || M4=fail
rm -f "$WORK/media/$WORKER_RELATIVE/worker-produced.mkv"
content reconcile >"$WORK/reconcile.txt" 2>&1
grep -q "local-source-file-absent" "$WORK/reconcile.txt" \
  || { echo "a removed worker output was not reported" >&2; M4=fail; }
content status --json >"$WORK/status-4.json" 2>&1 || M4=fail
node "$WORK/expect.cjs" "$WORK/status-4.json" counts.degraded 0 || M4=fail
node "$WORK/entry.cjs" "$WORK/status-4.json" "$ENTRY_REMOTE" "$WORK/remote-after-loss.json" || M4=fail
M4_B="$(node "$WORK/fielddiff.cjs" "$WORK/remote-before-loss.json" "$WORK/remote-after-loss.json")"

# AND ITS BYTES DID NOT MOVE EITHER. §5.1: the record deliberately carries no locator, because §4's ninth
# refusal keeps a provider object reference out of every emitted document — so what a moved locator would
# actually break is checked directly, by reading the half back through the mount a media server reads.
REMOTE_AFTER_LOSS="$(consumer_sha "$ENTRY_REMOTE")"
same_bytes "the provider-backed half before and after the worker output was lost" \
  "$REMOTE_AFTER_LOSS" "$REMOTE_THROUGH_MOUNT" \
  || { echo "losing the worker output changed what the provider-backed half reads back as" >&2; M4=fail; }

# THE TWO HALVES OF THE MEASUREMENT ARE ASSERTED TO BE NUMBERS BEFORE THEY ARE ADDED, because `$(( A + B ))`
# with either one empty is ZERO — which is the budget. A field diff that failed to run would otherwise have
# reported the passing answer, and the whole of §7 R4 is that this number is derived rather than declared.
numeric "the origin-outage field difference" "$M4_A" || { M4=fail; M4_A=99; }
numeric "the worker-loss field difference" "$M4_B" || { M4=fail; M4_B=99; }
M4_MOVED=$((M4_A + M4_B))
say "cross-source fields disturbed: $M4_A by the origin outage, $M4_B by the worker loss, $M4_MOVED total (budget 0)"
[ "$M4_MOVED" -eq 0 ] || M4=fail

verdict P11-M4-one-source-failing-disturbs-nothing-of-the-other "$M4"

# ---------------------------------------------------------------------------------------------------------
step "P11-M5 — shipped verbs only, and nothing publishes implicitly"
# ---------------------------------------------------------------------------------------------------------

arm P11-M5-shipped-verbs-only-and-nothing-implicit
M5=pass

POINTER_BEFORE="$(node "$WORK/sha.cjs" "$WORK/manifest/pointer.json")"
node "$WORK/fill.cjs" "$WORK/media/$WORKER_RELATIVE/third.mkv" "$CORPUS_BYTES" \
  || fail "the third local object could not be synthesised"
cat > "$WORK/local-objects-3.json" <<OBJECTSTHREE
[
  { "label": "worker-three",
    "itemId": "44444444-4444-4444-8444-444444444444",
    "path": "Movies/Worker Three (2026)/Worker Three (2026).mkv",
    "relativePath": "$WORKER_RELATIVE/third.mkv" }
]
OBJECTSTHREE

# AN `add` WITHOUT `--publish` MINTS NOTHING, and the pointer's digest is how that is checked.
content add-local --file "$WORK/local-objects-3.json" >"$WORK/add-local-3.txt" 2>&1 \
  || { cat "$WORK/add-local-3.txt" >&2; M5=fail; }
POINTER_AFTER="$(node "$WORK/sha.cjs" "$WORK/manifest/pointer.json")"
same_bytes "the published pointer across an add without --publish" "$POINTER_BEFORE" "$POINTER_AFTER" \
  || { echo "an add without --publish moved the published generation" >&2; M5=fail; }

content status --json >"$WORK/status-5.json" 2>&1 || M5=fail
node "$WORK/expect.cjs" "$WORK/status-5.json" counts.admittedNotPublished 1 || M5=fail

say "hand-run invocations on the operator path: $HAND_RUN (budget 0)"
[ "$HAND_RUN" -eq 0 ] || M5=fail

verdict P11-M5-shipped-verbs-only-and-nothing-implicit "$M5"
# HAND-RUN RANGE END

# ---------------------------------------------------------------------------------------------------------
step "P11-M6 — every arm reached, cleanup leaves nothing, and no evidence carries an identity"
# ---------------------------------------------------------------------------------------------------------

arm P11-M6-arms-reached-cleanup-and-redaction
M6=pass

# THE REDACTION SCAN IS OVER THE OUTPUT RATHER THAN OVER THE SOURCE, because the question is what a reader of
# this run's evidence can learn. IT IS TWO SCANS OVER TWO DIFFERENT SETS, and the split is a decision rather
# than a convenience.
#
# THE SECRETS SCAN COVERS EVERY PRESERVED FILE, INCLUDING THE APPLIANCE'S OWN. Nothing this run produced may
# carry the object reference, the worker key or the origin token, whoever wrote it. ANY URI SCHEME, not
# `https?` alone: every content invocation is handed a DATABASE URL with a password in it, and §4's ninth
# refusal is about credentials before it is about origins.
#
# THE RUN-PATH SCAN COVERS ONLY WHAT THIS TRANCHE'S OWN COMMANDS EMITTED, and the exclusion is `deploy/
# projection-alpha.sh`'s output. That script is the OPERATOR'S appliance surface and it names the operator's
# own directories on purpose — telling somebody where their manifest directory is, is the whole job of
# `status`. Failing P11-M6 on it would be this tranche asserting a redaction rule against a shipped surface
# it does not own and §6.3 forbids it to edit. The files are still scanned for secrets above.
SECRETS_SHAPE='phase11-object-1|phase11fakeworkerkey|phase11-fake-origin-token|[a-z][a-z0-9+.-]*://|apikey='
for file in "$WORK"/*.txt "$WORK"/*.json; do
  [ -f "$file" ] || continue
  case "$(basename "$file")" in
    # THE INPUTS THIS RUN WROTE FOR THE SHIPPED COMMANDS TO READ. They are not evidence; they are the
    # operator's own configuration and object files, and they carry a reference because that is their shape.
    # `worker.json` IS NOT ON THIS LIST AND USED TO BE, WHICH WAS A MIS-FILING RATHER THAN A DECISION. This
    # list is "the inputs this run wrote for the shipped commands to READ"; `worker.json` is an OUTPUT the
    # worker driver produced, and an output is exactly what this scan exists to read. Everything in it — a
    # submission count, a lifecycle word, a digest, a RELATIVE path and the driver's own composed problems —
    # is scannable, so it is scanned by both halves like every other piece of this run's evidence.
    content.json|config.json|torbox-objects.json) continue ;;
    local-objects.json|local-objects-2.json|local-objects-3.json) continue ;;
    control-before.json|control-after.json|control-reached.txt|arms-declared.txt|arms-reached.txt) continue ;;
  esac
  if grep -qiE "$SECRETS_SHAPE" "$file"; then
    echo "  LEAK in $(basename "$file")" >&2
    M6=fail
  fi
  case "$(basename "$file")" in
    migrate.txt|alpha-preflight.txt|alpha-install.txt|alpha-start.txt|alpha-stop.txt) continue ;;
  esac
  # THE WHOLE RUN DIRECTORY, not the media root alone: the manifest directory sits beside it and is the path
  # a diagnostic from these commands is likeliest to name.
  if grep -qF "$WORK" "$file"; then
    echo "  ABSOLUTE RUN PATH in $(basename "$file")" >&2
    M6=fail
  fi
done

# THE APPLIANCE AND EVERY TRANSIENT CONTAINER GO DOWN THROUGH THE SHIPPED VERB AND THE DOCKER CLI, and the
# host's sets are compared afterwards. Phase 8 §11's precedent: compared as SETS, not as counts, because two
# containers appearing while two others left is a count that agrees and a host that changed.
alpha stop >"$WORK/alpha-stop.txt" 2>&1 || { tail -20 "$WORK/alpha-stop.txt" >&2; M6=fail; }
docker rm -f "$CONSUMER_CONTAINER" "$ORIGIN_CONTAINER" >/dev/null 2>&1 || true
docker compose -p "$ALPHA_NETWORK" -f "$ROOT/docker-compose.projection-alpha.yml" down --remove-orphans \
  >/dev/null 2>&1 || true
docker network rm "$ALPHA_NETWORK" >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true

CONTAINERS_AFTER="$(docker ps -aq | sort | tr '\n' ' ')"
NETWORKS_AFTER="$(docker network ls -q | sort | tr '\n' ' ')"
VOLUMES_AFTER="$(docker volume ls -q | sort | tr '\n' ' ')"
[ "$CONTAINERS_BEFORE" = "$CONTAINERS_AFTER" ] || { echo "the container set changed" >&2; M6=fail; }
[ "$NETWORKS_BEFORE" = "$NETWORKS_AFTER" ] || { echo "the network set changed" >&2; M6=fail; }
[ "$VOLUMES_BEFORE" = "$VOLUMES_AFTER" ] || { echo "the volume set changed" >&2; M6=fail; }

# THE MEASUREMENT, READ BACK OUT OF THE RUN. `arms-declared.txt` came from the contract's own module and
# `arms-reached.txt` was appended to by `arm` at the START of each arm, so an arm a conditional jumped over
# leaves no marker and this number moves.
ARM_ACCOUNTING="$(node "$WORK/unreached.cjs" "$WORK/arms-declared.txt" "$ARMS_FILE")"
UNREACHED="$(printf '%s' "$ARM_ACCOUNTING" | cut -d' ' -f1)"
UNDECLARED="$(printf '%s' "$ARM_ACCOUNTING" | cut -d' ' -f2)"
say "declared arms unreached: $UNREACHED (budget 0); arms reached that the contract never declared: $UNDECLARED"
numeric "the unreached-arm count" "$UNREACHED" || M6=fail
numeric "the undeclared-arm count" "$UNDECLARED" || M6=fail
[ "${UNREACHED:-1}" = "0" ] || M6=fail
[ "${UNDECLARED:-1}" = "0" ] || M6=fail

verdict P11-M6-arms-reached-cleanup-and-redaction "$M6"

# `endpoint.json` — asserted rather than promised.
ENDPOINT_MTIME_AFTER="absent"
[ -f "$ENDPOINT_FILE" ] && ENDPOINT_MTIME_AFTER="$(node "$WORK/mtime.cjs" "$ENDPOINT_FILE")"
[ "$ENDPOINT_MTIME_BEFORE" = "$ENDPOINT_MTIME_AFTER" ] \
  || fail "endpoint.json was touched, which §4's seventh hard refusal forbids at any point"
say "endpoint.json: $ENDPOINT_MTIME_BEFORE before, $ENDPOINT_MTIME_AFTER after — unmoved"

# ---------------------------------------------------------------------------------------------------------
# The closing message, and the eight claims it must name as still open.
# ---------------------------------------------------------------------------------------------------------

echo
echo "############################################################"
echo "# Projection Phase 11 mixed gate: $PASS passed, $FAIL failed"
echo "############################################################"
echo

# A RUN THAT FAILED DOES NOT GET TO NARRATE WHAT IT PROVED. Phase 10's rehearsal printed its whole closing
# paragraph under "4 passed, 2 failed" on its first real execution, and a closing message that reads the same
# whether or not the run passed is one somebody will quote out of context.
if [ "$FAIL" -ne 0 ]; then
  echo "THIS RUN FAILED, SO IT PROVED NOTHING AND NO PARAGRAPH IS PRINTED HERE. Read the VERDICT lines above:"
  echo "each names the arm it belongs to. Nothing about Projection Phase 11 is closed or advanced by this run."
  echo
  exit 1
fi

echo "WHAT THIS PROVED, AND IT IS A STATEMENT ABOUT THE INSTRUMENT."
echo
echo "  One published generation held a provider-backed http-range entry and a local entry a worker produced,"
echo "  assembled through the shipped content verbs alone, with nothing published until publish was asked for."
echo "  Both halves read back through the one mount the shipped alpha script owns, each for what it is: the"
echo "  local half from disk with the range origin's counters unmoved, the provider-backed half by range with"
echo "  them moved. Publishing a third entry moved no field and no byte of the provider-backed half. A range"
echo "  origin stopped underneath the namespace disturbed nothing of the worker-produced half, and a worker"
echo "  output removed underneath it disturbed nothing of the provider-backed one — reported, never repaired,"
echo "  and nothing degraded itself. Every one of the six predeclared arms was REACHED, cleanup left the"
echo "  host's container, network and volume sets identical, and no preserved evidence carries a reference,"
echo "  a URL, a credential or an absolute path."
echo
echo "WHAT THIS DID NOT PROVE, AND CANNOT."
echo
echo "  P11-S1-offline-inventory-both-shells                        — one launch, one shell"
echo "  P11-S2-mixed-gate-three-fresh                               — one run is not three"
echo "  P11-S3-provider-free-regression-subset-green                — other gates, none of them this one"
echo "  P11-S4-three-consecutive-fresh-sequences                    — the same argument, one level up"
echo
echo "  AND THE WHOLE OF TIER TWO, WHICH IS THE MIXED PRODUCT ITSELF:"
echo
echo "  P11-R1-real-mixed-generation-on-the-appliance                — no real provider object, no real NZB"
echo "  P11-R2-three-servers-scan-and-read-both                      — no media server was contacted, and"
echo "                                                                 none was simulated"
echo "  P11-R3-real-provider-outage-leaves-the-other-half-readable   — a fake origin stopping is not an outage"
echo "  P11-R4-three-consecutive-fresh-real-sequences                — none of the above happened once"
echo
echo "  A tier-one GO is a GO on the INSTRUMENT: it says the gate exists, can fail, and reached every arm in"
echo "  fake mode. It closes nothing about the mixed product, and what is missing is a run rather than a gate."
echo "  src/core/projection/phase11.ts REFUSES to let a fake verdict close any tier-two claim."
echo

exit 0
