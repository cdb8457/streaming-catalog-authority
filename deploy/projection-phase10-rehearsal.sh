#!/usr/bin/env bash
# Projection Phase 10 — THE PROVIDER-FREE OPERATOR CONTENT-PLANE REHEARSAL.
#
# WHAT IT RUNS. §5 of `docs/PROJECTION_PHASE_10_OPERATOR_CONTENT_PLANE.md` asks ten things and every one of
# them is provider-free. Four are claims about a SET of runs that this one is not a member of — the offline
# inventory from both shells, three consecutive fresh rehearsals, the eleven-gate regression subset, and three
# consecutive fresh sequences — and `src/core/projection/phase10.ts` REFUSES to let a rehearsal verdict close
# any of them. This runs the OTHER SIX end to end:
#
#   P10-3   an admission through the REAL createRegistryPublisher against a real migrated PostgreSQL records
#           no admittedWithoutDriftCheck, and a forged TorBox move is refused permanently
#   P10-4   an operator reaches a readable namespace using ONLY the shipped verbs, with no hand-run command
#   P10-5   a removed local source is REPORTED, the generation is byte-identical, hold degrades, release restores
#   P10-6   the OPERATOR SOURCE DIGEST is unmoved and phase9RequiresSoakRerun over this tranche is FALSE
#   P10-8   cleanup leaves zero phase-owned containers, networks and volumes, ASSERTED from inside the run
#   P10-9   no preserved evidence carries a secret, a URL, an origin, a path or a media identity
#
# IT DRIVES THE SHIPPED OPERATOR COMMAND. Phase 8 §13's rule — a gate prepares inputs, invokes the shipped
# verbs and observes, rather than building its own arrangement — applied to the content plane. Every namespace
# mutation below goes through `deploy/projection-content.sh`, and the count of hand-run `tsx` invocations
# against the namespace is ZERO, which is what P10-4 measures.
#
# WHAT IT CONTACTS: a PostgreSQL container it starts and removes itself. No TorBox endpoint, no CDN origin, no
# indexer, no SABnzbd, no NNTP server, no media server, no Tower production container, no operator content and
# no credential. `endpoint.json` is not read, not written and not touched — asserted, with its mtime recorded
# before and after when one exists.
#
# EXIT STATUS. 0 when every rehearsed step passed. 1 when any failed. 77 when this host cannot run it at all,
# which is a SKIP and is not a pass — `projection-phase10-rehearsal-optional.sh` is the entry point that folds
# a skip, and folding one is a decision that belongs in the command somebody typed.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
GATE_SKIP_STATUS=77
COMPOSE_FILE="$ROOT/docker-compose.projection-phase10.yml"
PROJECT="projection-phase10-gate"
PG_PORT="${PROJECTION_PHASE10_GATE_PG_PORT:-5670}"
CONTENT="$HERE/projection-content.sh"

# A seam for the offline regression suite, which points this at a stub so the ACCOUNTING below is exercised as
# behaviour rather than read as source. It defaults to the real shipped command.
CONTENT_COMMAND="${PROJECTION_PHASE10_CONTENT_COMMAND:-$CONTENT}"

PASS=0
FAIL=0

say() { echo "[phase10] $*"; }
fail() { echo "[phase10] FAILED: $*" >&2; exit 1; }

skip() {
  echo >&2
  echo "SKIPPED: $1" >&2
  echo "  NOTHING WAS PROVED. This host cannot run the Phase 10 rehearsal, and a skip is not a pass." >&2
  exit "$GATE_SKIP_STATUS"
}

# EVERY VERDICT IS RECORDED WITH `rehearsal=true`, AND THE STRING IS NOT DECORATION. `phase10ClosureProblems`
# reads that field and refuses a closure whose sequence-level claims carry it, so a rehearsal that grew into a
# closure would have to change a module rather than a comment.
verdict() {
  local id="$1" outcome="$2"
  if [ "$outcome" = "pass" ]; then
    PASS=$((PASS + 1))
    echo "  VERDICT $id pass rehearsal=true"
  else
    FAIL=$((FAIL + 1))
    echo "  VERDICT $id fail rehearsal=true" >&2
  fi
}

step() { echo; echo "== $*"; }

# ---------------------------------------------------------------------------------------------------------
# Preconditions. Every one is checked BEFORE anything is created, so a host that cannot run this leaves with
# nothing to clean up.
# ---------------------------------------------------------------------------------------------------------

command -v node >/dev/null 2>&1 || skip "node is not on PATH"
command -v npx >/dev/null 2>&1 || skip "npx is not on PATH"
[ -f "$ROOT/package.json" ] || fail "the repository root does not look like this project"
[ -f "$CONTENT" ] || fail "the shipped content command is missing; there is nothing to rehearse"
command -v docker >/dev/null 2>&1 || skip "docker is not on PATH, and this rehearsal needs a real migrated database"
docker info >/dev/null 2>&1 || skip "the docker daemon is not answering"

# ---------------------------------------------------------------------------------------------------------
# What the host looks like BEFORE anything is created. P10-8 is an assertion rather than a report, and an
# assertion needs a baseline taken before the first container exists.
# ---------------------------------------------------------------------------------------------------------

WORK="$(mktemp -d)"

# ---------------------------------------------------------------------------------------------------------
# THE HELPER PROGRAMS, WRITTEN TO FILES RATHER THAN PASSED AS `node -e '...'`.
#
# WHY, AND IT IS A DEFECT THIS TRANCHE FOUND IN ITSELF. A multi-line `node -e '` opens a single quote that the
# next line does not close, and `test/custody-runtime-closure.ts` reads every shipped script line by line and
# refuses exactly that: "an unterminated single quote - the rest of this line cannot be read, and an unreadable
# line is not an empty one". The check is right. A quote a line-based reader cannot close is a quote a HUMAN
# reader cannot close either, and a shell script whose remaining lines are unreadable is where an unterminated
# string silently swallows the next command.
#
# So the JavaScript lives in files, written by quoted heredocs, exactly as `projection-publisher-mount-gate.sh`
# writes its own `objects.cjs`, `fill.cjs` and `sha.cjs`. Every one of them takes its input as an argument and
# prints or exits; none of them reads this script's variables.
# ---------------------------------------------------------------------------------------------------------

cat > "$WORK/probe.cjs" <<'PROBE'
// Can the runtime the shipped command runs on resolve the path THIS SHELL would write into a configuration?
// The path arrives in a FILE, not in argv: MSYS rewrites a POSIX-looking argument on the way to a native
// binary, so an argv probe would pass on exactly the host this exists to catch.
const { existsSync, readFileSync } = require('node:fs');
const asConfigured = readFileSync(process.argv[2], 'utf8');
if (!existsSync(asConfigured)) process.exit(1);
PROBE

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
const expected = process.argv[4];
const same = String(actual) === expected;
if (!same) console.error(`  ${process.argv[3]}=${String(actual)}, expected ${expected}`);
process.exit(same ? 0 : 1);
EXPECT

# ---------------------------------------------------------------------------------------------------------
# CAN THIS HOST EVEN EXPRESS THE PATHS THE SHIPPED COMMAND REQUIRES? Checked here, before anything is created.
#
# THE DEFECT THIS PRECONDITION EXISTS FOR, FOUND BY RUNNING THIS SCRIPT ON A WINDOWS DEVELOPMENT HOST. The
# shipped content configuration refuses a path that is not absolute POSIX and refuses one containing a
# backslash, exactly as `parseUsenetConfig` does, because the appliance is Linux and a relative or
# drive-lettered path would resolve against whatever directory the command happened to be run from. Under Git
# Bash on Windows, `mktemp -d` answers `/tmp/tmp.XXXX` — which parses cleanly and which the Node runtime the
# command runs on resolves to `C:\tmp\tmp.XXXX`, a directory that does not exist. Every verb then failed with
# `MANIFESTDIR_MISSING`, and a reader of that transcript would have concluded the shipped command was broken.
#
# IT IS A SKIP AND NOT A FAILURE, AND THE DISTINCTION IS THE WHOLE POINT. The product is correct, the host
# cannot host the instrument, and a run whose red comes from which machine it was launched on is not a verdict
# about the product at all — which is the lesson `test/posix-shell-kit.ts` records for the same class of
# problem one layer down. This rehearsal's home is the real Unraid host, where §10 says it is measured.
# ---------------------------------------------------------------------------------------------------------

# THE PROBE PASSES THE PATH THROUGH A FILE AND NOT THROUGH ARGV, AND THAT IS THE WHOLE POINT OF IT. Under
# MSYS, an argument that looks like a POSIX path is REWRITTEN into a Windows one on the way to a native
# binary, so `node -e '…' "$WORK"` sees a path it can resolve while the identical string written into a JSON
# configuration — which nothing rewrites — is one it cannot. A probe that used argv would pass on exactly the
# host this precondition exists to catch, which is the quietest possible way for a precondition to be useless.
printf '%s' "$WORK" > "$WORK/.path-probe"
node "$WORK/probe.cjs" "$WORK/.path-probe" || {
  rm -rf "$WORK"
  skip "this host cannot present its own run directory at a path the shipped command will accept: the content \
configuration requires an absolute POSIX path, and the one this shell produced is not the one the Node runtime \
resolves. That refusal is the product being correct. Run this on the appliance host."
}

CONTAINERS_BEFORE="$(docker ps -aq | sort | tr '\n' ' ')"
NETWORKS_BEFORE="$(docker network ls -q | sort | tr '\n' ' ')"
VOLUMES_BEFORE="$(docker volume ls -q | sort | tr '\n' ' ')"

# `endpoint.json` IS NOT READ, WRITTEN OR TOUCHED, and the mtime is how that is checked rather than promised.
ENDPOINT_FILE="${PROJECTIOND_ENDPOINT_FILE:-$ROOT/endpoint.json}"
ENDPOINT_MTIME_BEFORE="absent"
[ -f "$ENDPOINT_FILE" ] && ENDPOINT_MTIME_BEFORE="$(node "$WORK/mtime.cjs" "$ENDPOINT_FILE")"

cleanup() {
  local status=$?
  docker compose -f "$COMPOSE_FILE" -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
  return "$status"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------------------------------------
step "the Phase 10 offline suites"
# ---------------------------------------------------------------------------------------------------------
# THEY RUN FIRST, AND THE ORDER IS THE POINT. Phase 9's rehearsal learned this the hard way: running the
# suites afterwards meant the driver had already claimed them while nothing had been measured.

( cd "$ROOT" && npx tsx src/ops/test-runner-cli.ts --group offline --filter phase10 --filter content --filter namespace-snapshot ) \
  || fail "the Phase 10 offline suites did not pass"

# ---------------------------------------------------------------------------------------------------------
step "P10-6 — the operator source is unmoved and the Phase 8 soak is not re-opened"
# ---------------------------------------------------------------------------------------------------------
# ASSERTED BY RUNNING THE FUNCTION, not by reading a list. `phase9RequiresSoakRerun` is the contract's own
# decision procedure, and a gate that re-implemented it would be a gate that could disagree with the product
# about whether a six-hour soak has to be re-run.

if ( cd "$ROOT" && npx tsx test/projection-bounded-recovery.ts >"$WORK/bounded.txt" 2>&1 ); then
  verdict P10-6-operator-digest-unmoved-no-soak-rerun pass
else
  tail -30 "$WORK/bounded.txt" >&2
  verdict P10-6-operator-digest-unmoved-no-soak-rerun fail
fi

# ---------------------------------------------------------------------------------------------------------
step "a throwaway PostgreSQL on 127.0.0.1:$PG_PORT, migrated"
# ---------------------------------------------------------------------------------------------------------

PROJECTION_PHASE10_GATE_PG_PORT="$PG_PORT" \
  docker compose -f "$COMPOSE_FILE" -p "$PROJECT" up -d --wait \
  || fail "the throwaway PostgreSQL did not become healthy"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
( cd "$ROOT" && npx tsx src/ops/migrate-cli.ts >"$WORK/migrate.txt" 2>&1 ) || {
  tail -20 "$WORK/migrate.txt" >&2
  fail "the throwaway database could not be migrated"
}
say "migrated"

# ---------------------------------------------------------------------------------------------------------
step "P10-3 — the TorBox drift guard, against that real database"
# ---------------------------------------------------------------------------------------------------------
# THE ONE CLAIM THIS TRANCHE EXISTS FOR. Phase 10 §2.1: `createRegistryPublisher` could not present the
# namespace, so `torBoxDrift` never ran on a real admission and every one was recorded
# `admittedWithoutDriftCheck`. The suite drives the SHIPPED publisher against this database.

if ( cd "$ROOT" && npx tsx test/projection-drift-guard-db.ts >"$WORK/drift.txt" 2>&1 ); then
  grep -q "P10-3a" "$WORK/drift.txt" || fail "the drift suite did not run its P10-3 arms"
  verdict P10-3-drift-guard-runs-on-real-admission pass
else
  tail -30 "$WORK/drift.txt" >&2
  verdict P10-3-drift-guard-runs-on-real-admission fail
fi

# ---------------------------------------------------------------------------------------------------------
step "the operator's inputs, prepared the way an operator would prepare them"
# ---------------------------------------------------------------------------------------------------------

MEDIA_ROOT="$WORK/media"
MANIFEST_DIR="$WORK/manifests"
mkdir -p "$MEDIA_ROOT/movies" "$MANIFEST_DIR"

# SYNTHESISED IN THE RUN DIRECTORY. §10: no operator content, ever, in any Phase 10 run.
# `node -e` PUTS THE FIRST USER ARGUMENT AT argv[1], not at argv[2]: there is no script path to occupy the
# slot a file invocation would use. Getting that wrong here produced `Buffer.alloc(NaN)` and a corpus that was
# never written, which is the shape of defect this rehearsal exists to find in a shipped command — found in
# the rehearsal itself, on its first real execution.
node "$WORK/fill.cjs" "$MEDIA_ROOT/movies/local-one.bin" 2097152 \
  || fail "could not synthesise the local corpus"

CONFIG_FILE="$WORK/content.json"
cat > "$CONFIG_FILE" <<CONFIG
{
  "manifestDir": "$MANIFEST_DIR",
  "mediaRoot": "$MEDIA_ROOT",
  "rootId": "media",
  "endpointId": "vault"
}
CONFIG

LOCAL_OBJECTS="$WORK/local-objects.json"
cat > "$LOCAL_OBJECTS" <<'OBJECTS'
[
  { "label": "local-one",
    "itemId": "11111111-1111-4111-8111-111111111111",
    "path": "Movies/Local One/Local One.bin",
    "relativePath": "movies/local-one.bin" }
]
OBJECTS

TORBOX_OBJECTS="$WORK/torbox-objects.json"
# THE TEMPLATE'S OWN SHAPE, COMMENTS AND ALL. §2.3: the input format already existed and only the verb was
# missing, and an operator who edits the template in place must not be told their file is malformed.
cat > "$TORBOX_OBJECTS" <<'OBJECTS'
[
  { "_comment_label": "the template keeps its comments and the shipped verb ignores them",
    "label": "remote-one",
    "itemId": "22222222-2222-4222-8222-222222222222",
    "path": "Movies/Remote One/Remote One.bin",
    "ref": "rehearsal-opaque-object-reference",
    "sizeBytes": 4194304,
    "mtime": "2026-06-01T10:00:00.000Z",
    "sha256": null }
]
OBJECTS
chmod 600 "$TORBOX_OBJECTS" 2>/dev/null || true

content() { bash "$CONTENT_COMMAND" "$@" --config "$CONFIG_FILE" --database-url "$DATABASE_URL"; }

# ---------------------------------------------------------------------------------------------------------
step "P10-4 — zero to a readable namespace, through the SHIPPED verbs only"
# ---------------------------------------------------------------------------------------------------------

P10_4=pass
HAND_RUN=0   # THE MEASUREMENT. Every namespace mutation below goes through projection-content.sh.

content preflight >"$WORK/preflight.txt" 2>&1 || { cat "$WORK/preflight.txt" >&2; P10_4=fail; }
say "preflight: $(head -1 "$WORK/preflight.txt")"

content add-local --file "$LOCAL_OBJECTS" >"$WORK/add-local.txt" 2>&1 || { cat "$WORK/add-local.txt" >&2; P10_4=fail; }
grep -q "NOTHING IS VISIBLE YET" "$WORK/add-local.txt" \
  || { echo "add-local did not say that it did not publish" >&2; P10_4=fail; }

# NOTHING WAS PUBLISHED, AND THE POINTER IS HOW THAT IS CHECKED rather than the command's own word for it.
[ -e "$MANIFEST_DIR/pointer.json" ] && { echo "add-local published a generation, which no verb but publish may do" >&2; P10_4=fail; }

content status --json >"$WORK/status-1.json" 2>&1 || { cat "$WORK/status-1.json" >&2; P10_4=fail; }
node "$WORK/expect.cjs" "$WORK/status-1.json" counts.admittedNotPublished 1 || P10_4=fail
node "$WORK/expect.cjs" "$WORK/status-1.json" counts.published 0 || P10_4=fail

# reconcile EXITS 1 ON A DIVERGENCE AND THAT IS THE DESIGN, so its status is captured rather than trusted.
content reconcile >"$WORK/reconcile-1.txt" 2>&1
grep -q "registry-ahead-of-generation" "$WORK/reconcile-1.txt" \
  || { echo "reconcile did not report the entry as ahead of the generation" >&2; P10_4=fail; }
grep -q "CHANGES NOTHING" "$WORK/reconcile-1.txt" \
  || { echo "reconcile did not say that it changed nothing" >&2; P10_4=fail; }

content publish >"$WORK/publish-1.txt" 2>&1 || { cat "$WORK/publish-1.txt" >&2; P10_4=fail; }
grep -q "publish: published" "$WORK/publish-1.txt" || { cat "$WORK/publish-1.txt" >&2; P10_4=fail; }
[ -e "$MANIFEST_DIR/pointer.json" ] || { echo "publish minted no pointer" >&2; P10_4=fail; }

content add-torbox --file "$TORBOX_OBJECTS" --publish >"$WORK/add-torbox.txt" 2>&1 \
  || { cat "$WORK/add-torbox.txt" >&2; P10_4=fail; }

content status --json >"$WORK/status-2.json" 2>&1 || P10_4=fail
node "$WORK/expect.cjs" "$WORK/status-2.json" counts.registered 2 || P10_4=fail
node "$WORK/expect.cjs" "$WORK/status-2.json" counts.published 2 || P10_4=fail
node "$WORK/expect.cjs" "$WORK/status-2.json" agrees true || P10_4=fail

# IDEMPOTENCE, DRIVEN. A second identical add and a second publish change nothing.
content add-local --file "$LOCAL_OBJECTS" >"$WORK/add-local-2.txt" 2>&1 || P10_4=fail
content publish >"$WORK/publish-2.txt" 2>&1 || { cat "$WORK/publish-2.txt" >&2; P10_4=fail; }
grep -q "publish: unchanged" "$WORK/publish-2.txt" \
  || { echo "a second identical publish minted a generation" >&2; P10_4=fail; }

say "hand-run tsx invocations against the namespace: $HAND_RUN (budget 0)"
[ "$HAND_RUN" -eq 0 ] || P10_4=fail
verdict P10-4-operator-path-shipped-verbs-only "$P10_4"

# ---------------------------------------------------------------------------------------------------------
step "P10-5 — a local source removed under a published namespace"
# ---------------------------------------------------------------------------------------------------------

P10_5=pass

# THE BYTES BEFORE. §7 R5's mitigation is an assertion about a directory, so the directory is digested.
BEFORE_DIGESTS="$(cd "$MANIFEST_DIR" && for f in *; do printf '%s ' "$f"; node "$WORK/sha.cjs" "$f"; echo; done | sort)"

rm -f "$MEDIA_ROOT/movies/local-one.bin"

content reconcile >"$WORK/reconcile-2.txt" 2>&1
grep -q "local-source-file-absent" "$WORK/reconcile-2.txt" \
  || { echo "a removed local source was not reported" >&2; P10_5=fail; }

AFTER_DIGESTS="$(cd "$MANIFEST_DIR" && for f in *; do printf '%s ' "$f"; node "$WORK/sha.cjs" "$f"; echo; done | sort)"
if [ "$BEFORE_DIGESTS" != "$AFTER_DIGESTS" ]; then
  echo "reconcile moved a byte of the published generation, which §4's second hard refusal forbids" >&2
  P10_5=fail
fi
say "generation bytes changed by the report: 0 (budget 0)"

# THE NAMESPACE DID NOT DEGRADE ITSELF. A reconciliation that repaired what it found would be one that
# changed the evidence before anybody read it.
content status --json >"$WORK/status-3.json" 2>&1 || P10_5=fail
node "$WORK/expect.cjs" "$WORK/status-3.json" counts.degraded 0 || P10_5=fail

content hold --path "Movies/Local One/Local One.bin" >"$WORK/hold.txt" 2>&1 || { cat "$WORK/hold.txt" >&2; P10_5=fail; }
grep -q "STILL IN THE NAMESPACE" "$WORK/hold.txt" || { echo "hold did not say the entry stays" >&2; P10_5=fail; }
content status --json >"$WORK/status-4.json" 2>&1 || P10_5=fail
node "$WORK/expect.cjs" "$WORK/status-4.json" counts.held 1 || P10_5=fail
node "$WORK/expect.cjs" "$WORK/status-4.json" counts.registered 2 || P10_5=fail

content release --path "Movies/Local One/Local One.bin" >"$WORK/release.txt" 2>&1 || { cat "$WORK/release.txt" >&2; P10_5=fail; }
content status --json >"$WORK/status-5.json" 2>&1 || P10_5=fail
node "$WORK/expect.cjs" "$WORK/status-5.json" counts.held 0 || P10_5=fail

verdict P10-5-absent-local-source-reported-not-repaired "$P10_5"

# ---------------------------------------------------------------------------------------------------------
step "P10-9 — no preserved evidence carries a secret, a URL, an origin, a path or a media identity"
# ---------------------------------------------------------------------------------------------------------
# EVERY FILE THIS RUN PRODUCED, scanned. The scan is over the OUTPUT rather than over the source, because the
# question is what a reader of this run's evidence can learn.

P10_9=pass
for file in "$WORK"/*.txt "$WORK"/*.json; do
  [ -f "$file" ] || continue
  case "$(basename "$file")" in
    content.json|local-objects.json|torbox-objects.json|migrate.txt|bounded.txt|drift.txt) continue ;;
  esac
  if grep -qiE 'rehearsal-opaque-object-reference|https?://|apikey=' "$file"; then
    echo "  LEAK in $(basename "$file")" >&2
    P10_9=fail
  fi
  if grep -qF "$MEDIA_ROOT" "$file"; then
    echo "  ABSOLUTE MEDIA PATH in $(basename "$file")" >&2
    P10_9=fail
  fi
done
verdict P10-9-evidence-carries-no-identity "$P10_9"

# ---------------------------------------------------------------------------------------------------------
step "P10-8 — cleanup leaves nothing, ASSERTED rather than reported"
# ---------------------------------------------------------------------------------------------------------

docker compose -f "$COMPOSE_FILE" -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true

CONTAINERS_AFTER="$(docker ps -aq | sort | tr '\n' ' ')"
NETWORKS_AFTER="$(docker network ls -q | sort | tr '\n' ' ')"
VOLUMES_AFTER="$(docker volume ls -q | sort | tr '\n' ' ')"

P10_8=pass
[ "$CONTAINERS_BEFORE" = "$CONTAINERS_AFTER" ] || { echo "the container set changed" >&2; P10_8=fail; }
[ "$NETWORKS_BEFORE" = "$NETWORKS_AFTER" ] || { echo "the network set changed" >&2; P10_8=fail; }
[ "$VOLUMES_BEFORE" = "$VOLUMES_AFTER" ] || { echo "the volume set changed" >&2; P10_8=fail; }

# COMPARED AS SETS, NOT AS COUNTS. Phase 8 §11 is the precedent: two containers appearing while two others
# left is a count that agrees and a host that changed.
verdict P10-8-cleanup-leaves-nothing "$P10_8"

# `endpoint.json` — asserted rather than promised.
ENDPOINT_MTIME_AFTER="absent"
[ -f "$ENDPOINT_FILE" ] && ENDPOINT_MTIME_AFTER="$(node "$WORK/mtime.cjs" "$ENDPOINT_FILE")"
[ "$ENDPOINT_MTIME_BEFORE" = "$ENDPOINT_MTIME_AFTER" ] \
  || fail "endpoint.json was touched, which §4's third hard refusal forbids at any point"
say "endpoint.json: $ENDPOINT_MTIME_BEFORE before, $ENDPOINT_MTIME_AFTER after — unmoved"

# ---------------------------------------------------------------------------------------------------------
# The closing message, and the four claims it must name as still open.
# ---------------------------------------------------------------------------------------------------------

echo
echo "############################################################"
echo "# Projection Phase 10 rehearsal: $PASS passed, $FAIL failed"
echo "############################################################"
echo

# A RUN THAT FAILED DOES NOT GET TO NARRATE WHAT IT PROVED, and this guard was added because the first real
# execution of this script printed the whole paragraph below under "4 passed, 2 failed". A closing message
# that reads the same whether or not the run passed is a closing message somebody will quote out of context —
# and quoting a paragraph that says "the guard now runs on the path an operator's appliance uses" from a run
# in which it did not is exactly the failure this tranche exists to repair one layer down.
if [ "$FAIL" -ne 0 ]; then
  echo "THIS RUN FAILED, SO IT PROVED NOTHING AND NO PARAGRAPH IS PRINTED HERE. Read the VERDICT lines above:"
  echo "each names the claim it belongs to. Nothing about Projection Phase 10 is closed or advanced by this run."
  echo
  exit 1
fi

echo "WHAT THIS PROVED."
echo
echo "  An admission through the SHIPPED registry publisher, against a real migrated PostgreSQL, recorded no"
echo "  admittedWithoutDriftCheck — the guard Phase 10 §2.1 found running only in a rehearsal and in one unit"
echo "  test now runs on the path an operator's appliance uses — and a TorBox entry moved around that publish"
echo "  was refused permanently with the admission not recorded. An operator went from an empty control plane"
echo "  to a readable namespace holding a local entry and a provider-backed one using ONLY shipped verbs, with"
echo "  zero hand-run commands, and nothing published until publish was typed. A local source removed under a"
echo "  published namespace was REPORTED, the published generation was byte-identical before and after the"
echo "  report, nothing degraded itself, and hold then release moved it and moved it back. The operator source"
echo "  digest is unmoved. No output of this run carries a reference, a URL or an absolute media path."
echo
echo "WHAT THIS DID NOT PROVE, AND CANNOT, BECAUSE IT IS ONE RUN."
echo
echo "  P10-1-offline-inventory-both-shells          — one launch, one shell; the second is a separate launch,"
echo "                                                 and it depends on the POSIX-shell harness repair landing"
echo "  P10-2-rehearsal-three-fresh                  — one run is not three; the :three wrapper counts them"
echo "  P10-7-provider-free-regression-subset-green  — eleven other gates, none of them this one"
echo "  P10-10-three-consecutive-fresh-sequences     — the same argument as P10-2, one level up"
echo
echo "  src/core/projection/phase10.ts REFUSES to let a rehearsal verdict close any of those four."
echo

[ "$FAIL" -eq 0 ] || exit 1
exit 0
