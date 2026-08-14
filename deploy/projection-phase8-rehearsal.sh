#!/usr/bin/env bash
# THE PHASE 8 REHEARSAL — PROVIDER-FREE, AND IT IS §11.2's FIRST NUMBERED ITEM BUILT RATHER THAN NAMED.
#
# WHY IT EXISTS, IN THE WORDS THE CONTRACT ALREADY USED. `docs/PROJECTION_PHASE_8_OPERATOR_SOAK.md` §11.2
# refused to spend the session's last two provider-facing attempts on the first execution of 3,419 lines that
# had never run once, and named the missing instrument as the next work: "a provider-free rehearsal for this
# gate, in the shape `deploy/projection-restart-topology-gate.sh` has: the same cycle, the same inheritance
# assertion and the same operator command, against the local seed entry the setup already publishes as
# generation 1, with no provider and no approved-window checks. That is what makes a wiring defect cost
# minutes instead of an attempt."
#
# WHAT IT FOUND ON ITS OWN FIRST EXECUTION, WHICH IS THE ARGUMENT FOR IT. Eleven defects in the Phase 8 gate,
# every one of them fatal to a soak and not one of them visible to `bash -n`: three shell names the contract
# CLI never published (two of which exit the gate during SETUP, one three lines from the end of a soak in
# which everything had passed), fifteen required per-cycle ids never recorded because S5 omitted the cycle
# suffix, S3's three required per-server ids never recorded at all, a budgeted id recorded as a boolean, an
# inheritance fingerprint statting three paths the gate never creates, a recovery baseline sampled after the
# fault, a rollback target read from a path the product never writes — and the shipped operator command
# invoked with an environment contract it refuses outright. None of those would have been a product finding.
# All of them would have been discovered by a metered provider account, hours in.
#
# WHAT IT IS NOT, AND THE LIST IS THE POINT:
#
#   - IT IS NOT A SOAK AND CLOSES NOTHING. It records no `P8-` verdict, writes no evidence the closure check
#     will ever read, and cannot make Phase 8 a GO. §4.1 closes on three consecutive fresh soaks of the real
#     gate against the real provider and this is none of those things.
#   - IT CONTACTS NO PROVIDER AND COULD NOT. The daemon is configured with an empty endpoint list, the
#     operator's input directory is never read, and no credential, reference or origin is anywhere in reach.
#   - IT INVOLVES NO MEDIA SERVER AND SIMULATES NONE. Its three consumers are unprivileged `alpine`
#     containers holding the projected path exactly as the restart-topology gate's single consumer does. They
#     exist to give the gate's OWN inheritance and bind fingerprints three real subjects to compare; nothing
#     here asserts anything whatever about Plex, Jellyfin or Emby, and §4.2's refusal of simulated real-server
#     behaviour is not touched by a rehearsal that makes no server claim.
#   - IT MAKES NO TIMING, LAYER-COUNT OR RECOVERY CLAIM THAT ANY DOCUMENT MAY CITE. Every number it prints is
#     about the instrument.
#
# HOW IT IS BUILT SO THAT IT CANNOT DRIFT FROM THE GATE IT REHEARSES. Part A runs the static wiring audit over
# the gate's ACTUAL BYTES and then over a tampered copy, so a green audit is evidence rather than a no-op.
# Part C `eval`s the gate's OWN `inherit_fingerprint`, `assert_inherited`, `config_dir_for`, `container_for`
# and layer counters, lifted out of the gate file by name at run time — so a repair made to the gate is
# rehearsed here without being copied here, and a rename fails loudly instead of silently rehearsing nothing.
#
# A SKIP IS A FAILURE, exactly as it is for every other gate in this repository.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

GATE_SOURCE="deploy/projection-phase8-gate.sh"
ALPHA="deploy/projection-alpha.sh"

GATE_ROOT="$PWD/.projection-phase8-rehearsal"
REL=".projection-phase8-rehearsal/run-$$"
WORK="$GATE_ROOT/run-$$"

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"

# ITS OWN LOOPBACK PORT, DISJOINT FROM EVERY OTHER GATE'S. The restart-topology gate takes 5630 and the
# Phase 8 gate takes 5640; two gates on one port is a `port is already allocated` that reads like a defect and
# is not.
PG_PORT="${PROJECTION_PHASE8_REHEARSAL_PG_PORT:-5650}"
COMPOSE_FILE="docker-compose.projection-phase8-rehearsal.yml"
COMPOSE_PROJECT="projection-phase8-rehearsal"
NETWORK="$COMPOSE_PROJECT"

# THE CONSUMERS CARRY THIS RUN'S PID; THE APPLIANCE CANNOT, and that is the shipped command's decision rather
# than this script's. `docker-compose.projection-alpha.yml` fixes `container_name` at
# `projection-alpha-projectiond` because an operator's appliance has one name. This rehearsal therefore
# REFUSES TO RUN if that name is already taken, rather than adopting, restarting or replacing whatever is
# there — stopping somebody else's appliance to rehearse a gate is precisely the thing every contract here
# forbids.
ALPHA_CONTAINER="projection-alpha-projectiond"
ALPHA_PROJECT="projection-alpha"
JF_CONTAINER="projection-p8r-consumer-jf-$$"
PLEX_CONTAINER="projection-p8r-consumer-plex-$$"
EMBY_CONTAINER="projection-p8r-consumer-emby-$$"

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_PHASE8_REHEARSAL_PG_PORT="$PG_PORT"
export MSYS_NO_PATHCONV=1

# shellcheck source=projection-gate-cleanup.sh
. "$HERE/projection-gate-cleanup.sh"

RESULTS=0
FAILURES=0
pass() { echo "  PASS  $*"; RESULTS=$(( RESULTS + 1 )); }
fail() { echo "  FAIL  $*" >&2; RESULTS=$(( RESULTS + 1 )); FAILURES=$(( FAILURES + 1 )); }
step() { echo; echo "=== $* ==="; }
die()  { echo "REHEARSAL FAILED: $*" >&2; exit 1; }

# A CHECK WHOSE SUBJECT IS AN EXIT STATUS, WRITTEN ONCE. `want_ok` and `want_fail` exist so that a control —
# a thing that MUST fail — is as short to write as an assertion, because a control that is tedious to write
# is a control that does not get written.
want_ok()   { local what="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$what"; else fail "$what (exited $?)"; fi; }
want_fail() {
  local what="$1"; shift
  if "$@" >/dev/null 2>&1; then fail "$what — IT SUCCEEDED, so the check it controls proves nothing";
  else pass "$what"; fi
}

CLEANED=0
cleanup() {
  docker rm -f "$JF_CONTAINER" "$PLEX_CONTAINER" "$EMBY_CONTAINER" >/dev/null 2>&1 || true
  if [ "${WE_OWN_THE_APPLIANCE:-0}" = "1" ]; then
    docker compose -p "$ALPHA_PROJECT" -f docker-compose.projection-alpha.yml down -v --remove-orphans \
      >/dev/null 2>&1 || true
    docker rm -f "$ALPHA_CONTAINER" >/dev/null 2>&1 || true
  fi
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  # THE FOREIGN OVERLAY THIS RUN STACKED, IF IT IS STILL THERE, AND ONLY AT THIS RUN'S OWN MOUNT POINT.
  if [ -n "${WORK:-}" ] && [ -d "$WORK/mnt" ]; then
    local n=0
    while [ "$n" -lt 8 ] && [ "$(count_rows_here 2>/dev/null || echo 0)" -gt "${MOUNT_LAYER_FLOOR_ROWS:-0}" ]; do
      umount -l "$WORK/mnt" 2>/dev/null || true
      n=$(( n + 1 )); sleep 0.5
    done
  fi
  if [ "$CLEANED" -ne 1 ] && [ -n "${WORK:-}" ]; then
    projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true
    projection_gate_report_cleanliness "$GATE_ROOT" "$WORK" || true
  fi
  rm -f "$GATE_ROOT/tamper-$$.sh" "$GATE_ROOT/verdicts-$$.jsonl" "$GATE_ROOT/cycles-$$.jsonl" \
        "$GATE_ROOT/control-$$.jsonl" "$GATE_ROOT/control-cycles-$$.jsonl" 2>/dev/null || true
}
trap cleanup EXIT

echo "PROJECTION PHASE 8 — THE PROVIDER-FREE REHEARSAL"
echo "  it closes nothing, contacts no provider, involves no media server, and asserts nothing about one."

# ----------------------------------------------------------------------------------------------------------
# PART A — THE GATE'S OWN WIRING, READ FROM ITS BYTES. NO DOCKER.
# ----------------------------------------------------------------------------------------------------------
step "A — the gate's wiring, read from its bytes"

mkdir -p "$GATE_ROOT"
chmod 755 "$GATE_ROOT"

want_ok "A1 the gate, its three-runner and its optional wrapper are syntactically valid bash" \
  bash -c 'bash -n deploy/projection-phase8-gate.sh && bash -n deploy/projection-phase8-gate-three.sh \
    && bash -n deploy/projection-phase8-gate-optional.sh'

want_ok "A2 the static wiring audit passes: every P8_ name published, every required id recorded exactly \
once with its cycle and server suffixes, every budgeted id carrying a measurement" \
  npx tsx src/ops/projection-phase8-gate-audit-cli.ts --gate "$GATE_SOURCE"

# THE CONTROL FOR A2, AND WITHOUT IT A2 IS A COMMAND THAT PRINTED SOMETHING. The tamper is the exact defect
# the audit was written for: an id recorded without the cycle suffix the closure rule requires, which is
# simultaneously fifteen absent measurements and eight ids carrying three verdicts each.
sed 's/record "P8-S5-action-ms:\$CYCLE_ID"/record "P8-S5-action-ms"/' "$GATE_SOURCE" \
  > "$GATE_ROOT/tamper-$$.sh"
if cmp -s "$GATE_SOURCE" "$GATE_ROOT/tamper-$$.sh"; then
  fail "A3 the tamper did not apply, so this control tested nothing at all"
else
  want_fail "A3 CONTROL: the same audit REFUSES a gate whose S5 id lost its cycle suffix" \
    npx tsx src/ops/projection-phase8-gate-audit-cli.ts --gate "$GATE_ROOT/tamper-$$.sh"
fi
rm -f "$GATE_ROOT/tamper-$$.sh"

# ----------------------------------------------------------------------------------------------------------
# A4 — THE ONE THE GATE'S FIRST EXECUTION WOULD HAVE DIED ON, ASKED WITHOUT DOCKER.
# ----------------------------------------------------------------------------------------------------------
# §3 DEFINES FIVE OF THE TEN STEPS AS THE SHIPPED OPERATOR COMMAND: S1 is `preflight`, S2 is
# `install`/`start`/`start`/`status`, S7 is `stop`/`start`, S8 is `reset-recovery` and S9 is
# `upgrade`/`rollback`. That command has a REQUIRED ENVIRONMENT CONTRACT it refuses to run without, and it
# names it in one place. A gate that hands it a different set of names does not measure five of its own
# steps; it records five steps' worth of failures about a command it never successfully invoked.
#
# SO THE TWO LISTS ARE COMPARED RATHER THAN READ. `REQUIRED_DIRS`, `REQUIRED_FILES` and `REQUIRED_OTHER` come
# out of the shipped command's own source; the assignments come out of the gate's own `alpha()`.
# EACH PIPELINE IS ONE LINE, because `test/custody-runtime-closure.ts` reads every shipped `.sh` end to end
# and refuses a line whose quotes do not close on it — and a quoted command substitution spanning four lines
# is exactly that. It caught this file on its first run, which is the pin doing its job.
alpha_required_names() { awk '/^REQUIRED_(DIRS|FILES|OTHER)=/,/[^\\]$/' "$ALPHA" | tr -d '\\"' | tr ' ' '\n' | grep -o 'PROJECTIOND_ALPHA_[A-Z_]*' | LC_ALL=C sort -u; }
gate_supplied_names() { awk '/^alpha\(\) \{/,/^\}$/' "$GATE_SOURCE" | grep -o 'PROJECTIOND_ALPHA_[A-Z_]*=' | tr -d '=' | LC_ALL=C sort -u; }
ALPHA_REQUIRES="$(alpha_required_names)"
GATE_SUPPLIES="$(gate_supplied_names)"
MISSING_ENV="$(comm -23 <(printf '%s\n' "$ALPHA_REQUIRES") <(printf '%s\n' "$GATE_SUPPLIES") || true)"
UNKNOWN_ENV="$(comm -13 <(printf '%s\n' "$ALPHA_REQUIRES") <(printf '%s\n' "$GATE_SUPPLIES") || true)"
if [ -z "$MISSING_ENV" ] && [ -z "$UNKNOWN_ENV" ]; then
  pass "A4 the gate hands the shipped operator command exactly the environment it requires, so S1, S2, S7, \
S8 and S9 can invoke it at all"
else
  [ -z "$MISSING_ENV" ] || { echo "    required by the shipped command and NOT set by the gate:" >&2
    printf '%s\n' "$MISSING_ENV" | sed 's/^/      /' >&2; }
  [ -z "$UNKNOWN_ENV" ] || { echo "    set by the gate and required by nothing:" >&2
    printf '%s\n' "$UNKNOWN_ENV" | sed 's/^/      /' >&2; }
  fail "A4 the gate's environment for the shipped operator command does not match what that command \
requires, so every verb in S1, S2, S7, S8 and S9 exits REFUSED and five of the ten steps measure nothing"
  echo "    AND DO NOT FIX THIS HALF ON ITS OWN — see A6. While the names are wrong every verb refuses and" >&2
  echo "    changes nothing, which is a SAFE failure. Correcting them without resolving the daemon" >&2
  echo "    ownership below would let the shipped command bring a SECOND projectiond up over a mount point" >&2
  echo "    this gate's own daemon already holds." >&2
fi

# AND THE CONTROL: the comparison must notice a name that is missing. It is run against a copy of the gate's
# own `alpha()` with one assignment deleted, so a green A4 is a comparison that works rather than two empty
# lists agreeing.
CONTROL_SUPPLIES="$(printf '%s\n' "$GATE_SUPPLIES" | grep -v 'PROJECTIOND_ALPHA_IMAGE' || true)"
if [ -n "$(comm -23 <(printf '%s\n' "$ALPHA_REQUIRES") <(printf '%s\n' "$CONTROL_SUPPLIES") || true)" ]; then
  pass "A5 CONTROL: the same comparison names a required variable that has been removed"
else
  fail "A5 CONTROL: removing a required variable changed nothing, so A4 cannot detect one"
fi

# ----------------------------------------------------------------------------------------------------------
# A6 — ONE MOUNT POINT, TWO OWNERS, AND THAT IS THE OTHER HALF OF THE SAME BLOCKER.
# ----------------------------------------------------------------------------------------------------------
# THE GATE STARTS ITS OWN DAEMON. `start_daemon` runs `docker run --name "$MOUNT_CONTAINER"` with the
# `rshared` bind at `$WORK/mnt`, and every observation the gate makes — `sample`, `recovery_actions`, the
# teardown, the log tails — names that container.
#
# AND §3 SAYS FIVE OF THE TEN STEPS ARE THE SHIPPED OPERATOR COMMAND, which brings the appliance up out of
# `docker-compose.projection-alpha.yml` as `projection-alpha-projectiond`, at the SAME `$WORK/mnt`. Those are
# two different appliances competing for one mount point, and no small edit reconciles them: the gate's daemon
# runs with `--strict-direct-mount` and a poll interval derived from the contract, and the shipped profile
# hard-codes `--poll=5s` and passes no such flag, so an appliance driven by the shipped command is not the one
# Phase 7 measured. Either the gate stops running its own daemon, or §3 stops naming the shipped command —
# and §4.1 forbids the second, because a contract may not be edited into agreement with its instrument.
#
# THIS IS WHY A4 MUST NOT BE FIXED ALONE. While the variable names are wrong, every verb refuses and changes
# nothing — a safe failure. Correct only the names and the shipped `install` and `start` become live commands
# aimed at a mount point another daemon is already serving.
GATE_STARTS_ITS_OWN="$(grep -c 'docker run -d --name "\$MOUNT_CONTAINER"' "$GATE_SOURCE" || true)"
GATE_DRIVES_SHIPPED="$(grep -cE '^\s*alpha (install|start|stop|upgrade|rollback)\b' "$GATE_SOURCE" || true)"
if [ "${GATE_STARTS_ITS_OWN:-0}" -ge 1 ] && [ "${GATE_DRIVES_SHIPPED:-0}" -ge 1 ]; then
  fail "A6 the gate starts its OWN daemon container AND drives the shipped operator command's lifecycle \
verbs ($GATE_DRIVES_SHIPPED of them) at the same mount point. One mount point cannot have two owners, and \
until one of those two is removed the five steps §3 defines as the shipped command cannot be measured."
elif [ "${GATE_DRIVES_SHIPPED:-0}" -ge 1 ]; then
  pass "A6 the appliance under test is the one the shipped operator command owns, and the gate starts no \
competing daemon of its own"
else
  fail "A6 the gate drives no lifecycle verb of the shipped operator command at all, so §3's S1, S2, S7, S8 \
and S9 are not the steps the contract defines"
fi

# ----------------------------------------------------------------------------------------------------------
# PART B — THE CLOSURE, REPORT AND REDACTION PLUMBING, WITH CONTROLS. NO DOCKER.
# ----------------------------------------------------------------------------------------------------------
step "B — the closure, report and redaction plumbing, and the five ways it must refuse a soak"

want_ok "B1 the contract CLI publishes its budgets, its steps and its nonclaims" \
  bash -c 'npx tsx src/ops/projection-phase8-cli.ts budgets >/dev/null \
    && npx tsx src/ops/projection-phase8-cli.ts budgets --sh >/dev/null \
    && npx tsx src/ops/projection-phase8-cli.ts steps >/dev/null \
    && npx tsx src/ops/projection-phase8-cli.ts nonclaims >/dev/null'

# THE SYNTHETIC DOCUMENT IS DERIVED FROM THE GATE'S OWN EMISSIONS, not written out here. Its ids, its
# comparisons and its budgets come from the same audit model Part A ran, so a document that closes here is a
# document shaped like the one the gate would actually write — and if the gate stops writing one of them,
# this stops being able to build it.
VERDICTS="$GATE_ROOT/verdicts-$$.jsonl"
CYCLES="$GATE_ROOT/cycles-$$.jsonl"
if npx tsx src/ops/projection-phase8-gate-audit-cli.ts --gate "$GATE_SOURCE" \
     --synthesize "$VERDICTS" --synthesize-cycles "$CYCLES" >/dev/null 2>&1; then
  pass "B2 a complete soak's verdict document can be synthesised from the gate's own emissions"
else
  fail "B2 the synthetic verdict document could not be built from the gate's emissions"
fi

close_it() {
  npx tsx src/ops/projection-phase8-cli.ts close --results "$1" --cycles-log "$2"
}
if [ -s "$VERDICTS" ] && [ -s "$CYCLES" ]; then
  want_ok "B3 a complete soak in which every required id passes satisfies the predeclared closure rule" \
    close_it "$VERDICTS" "$CYCLES"

  # THE FIVE CONTROLS. Each removes exactly one property the closure rule depends on, and each must be
  # refused for its own reason. A closure check that accepts any of these is one that would have accepted a
  # soak that did not happen.
  ctl() { cp "$VERDICTS" "$GATE_ROOT/control-$$.jsonl"; cp "$CYCLES" "$GATE_ROOT/control-cycles-$$.jsonl"; }

  ctl; grep -v '"P8-S6-layers:C2"' "$VERDICTS" > "$GATE_ROOT/control-$$.jsonl" || true
  want_fail "B4 CONTROL: a required measurement that is ABSENT is not a passing one" \
    close_it "$GATE_ROOT/control-$$.jsonl" "$CYCLES"

  ctl; grep '"P8-S6-layers:C2"' "$VERDICTS" >> "$GATE_ROOT/control-$$.jsonl" || true
  want_fail "B5 CONTROL: one id carrying TWO verdicts is refused rather than the later one winning" \
    close_it "$GATE_ROOT/control-$$.jsonl" "$CYCLES"

  ctl; sed -i 's/"P8-S6-layers:C2","verdict":"pass"/"P8-S6-layers:C2","verdict":"skip"/' \
    "$GATE_ROOT/control-$$.jsonl"
  grep -q '"verdict":"skip"' "$GATE_ROOT/control-$$.jsonl" \
    || fail "B6 the skip tamper did not apply, so this control tested nothing"
  want_fail "B6 CONTROL: a SKIP is a failure, because this gate has no optional steps" \
    close_it "$GATE_ROOT/control-$$.jsonl" "$CYCLES"

  ctl; sed -i 's/\("gate":"P8-S6-layers:C2"[^}]*"budget":\)[0-9]*/\19999/' \
    "$GATE_ROOT/control-$$.jsonl" 2>/dev/null || true
  want_fail "B7 CONTROL: a budget the SOAK supplied for itself is refused, however good the measurement" \
    close_it "$GATE_ROOT/control-$$.jsonl" "$CYCLES"

  head -2 "$CYCLES" > "$GATE_ROOT/control-cycles-$$.jsonl"
  want_fail "B8 CONTROL: a soak that ran two cycles instead of three is not a soak that passed" \
    close_it "$VERDICTS" "$GATE_ROOT/control-cycles-$$.jsonl"

  want_ok "B9 the report renders from the same document the closure check judged" \
    npx tsx src/ops/projection-phase8-cli.ts report --results "$VERDICTS" --cycles-log "$CYCLES"

  want_ok "B10 the preserved verdict log is redaction-safe" \
    npx tsx src/ops/projection-phase8-cli.ts redaction-check --file "$VERDICTS"

  # THE REDACTION CONTROL. A check that passes over a clean file has not been shown to look at anything.
  cp "$VERDICTS" "$GATE_ROOT/control-$$.jsonl"
  printf '%s\n' '{"gate":"P8-leaky","verdict":"pass","note":"https://cdn.example.invalid/a/b?token=x"}' \
    >> "$GATE_ROOT/control-$$.jsonl"
  want_fail "B11 CONTROL: the redaction check REFUSES a verdict log carrying a URL" \
    npx tsx src/ops/projection-phase8-cli.ts redaction-check --file "$GATE_ROOT/control-$$.jsonl"
else
  fail "B3-B11 no synthetic document was produced, so none of the closure plumbing was exercised"
fi
rm -f "$VERDICTS" "$CYCLES" "$GATE_ROOT/control-$$.jsonl" "$GATE_ROOT/control-cycles-$$.jsonl"

# ----------------------------------------------------------------------------------------------------------
# PART C — THE LIVE HALF: THE SHIPPED OPERATOR COMMAND, PROVIDER-FREE, OVER A LOCAL SEED ENTRY
# ----------------------------------------------------------------------------------------------------------
step "C — the shipped operator command over one local entry, with three consumers attached first"

GATE_SKIP_STATUS="${GATE_SKIP_STATUS:-77}"
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no /dev/fuse is reachable from a container on this host." >&2
  exit "$GATE_SKIP_STATUS"
fi

# THE APPLIANCE'S NAME IS THE OPERATOR'S, NOT THIS RUN'S, SO IT IS CHECKED BEFORE IT IS TAKEN.
if docker ps -a --format '{{.Names}}' | grep -qx "$ALPHA_CONTAINER"; then
  die "an appliance is already installed on this host as '$ALPHA_CONTAINER'. This rehearsal drives the \
shipped operator command, whose container name is fixed, and it will not stop, replace or adopt somebody \
else's appliance to rehearse a gate. Remove or stop that appliance deliberately first."
fi

mkdir -p "$WORK/manifest" "$WORK/media" "$WORK/cache" "$WORK/mnt" "$WORK/out" "$WORK/secrets" \
         "$WORK/jf-config" "$WORK/plex-config" "$WORK/emby-config"
chmod 755 "$WORK"
chmod 777 "$WORK/cache" "$WORK/mnt" "$WORK/out" "$WORK/jf-config" "$WORK/plex-config" "$WORK/emby-config"
chmod 700 "$WORK/secrets"

cat > "$WORK/out/sha.cjs" <<'SHA'
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
console.log(createHash('sha256').update(readFileSync(process.argv[2])).digest('hex'));
SHA
cat > "$WORK/out/jq.cjs" <<'JQ'
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const value = JSON.parse(raw)[process.argv[2]];
  console.log(value === undefined ? '' : String(value));
});
JQ

CONTAINERS_BEFORE="$(docker ps -a --format '{{.Names}}' | LC_ALL=C sort)"
NETWORKS_BEFORE="$(docker network ls --format '{{.Name}}' | LC_ALL=C sort)"
VOLUMES_BEFORE="$(docker volume ls --format '{{.Name}}' | LC_ALL=C sort)"

step "C0 — a real PostgreSQL, one LOCAL entry, and a daemon configuration with NO endpoint at all"
docker build -t "$IMAGE" ./projectiond
docker compose -f "$COMPOSE_FILE" up -d --wait postgres
npx tsx src/ops/migrate-cli.ts
docker network create "$NETWORK" >/dev/null 2>&1 || true

SUBJECT_FILE="phase8-rehearsal-subject.bin"
SUBJECT_SIZE=$((4 * 1024 * 1024))
head -c "$SUBJECT_SIZE" /dev/urandom > "$WORK/media/$SUBJECT_FILE"
SUBJECT_SHA="$(node "$REL/out/sha.cjs" "$REL/media/$SUBJECT_FILE")"
SEED_PATH="Movies/Projection Seed (2026)/Projection Seed (2026).bin"

npx tsx src/ops/projection-register-cli.ts root --id media --kind local
npx tsx src/ops/projection-register-cli.ts version --key phase8-rehearsal --size "$SUBJECT_SIZE" \
  --mtime 2026-06-01T10:00:00.000Z
npx tsx src/ops/projection-register-cli.ts entry \
  --item "dddddddd-4444-4444-8444-dddddddddddd" --version-key phase8-rehearsal \
  --path "$SEED_PATH" --source "local:media:${SUBJECT_FILE}"
npx tsx src/ops/projection-publish-cli.ts --manifest-dir "$REL/manifest" > "$WORK/out/publish-1.json"
test "$(node "$REL/out/jq.cjs" outcome < "$WORK/out/publish-1.json")" = "published" \
  || die "generation 1 was not published, so there is nothing for the appliance to serve"
echo "  generation 1 published; the local subject is $SUBJECT_SIZE bytes and no endpoint is configured"

cat > "$WORK/config.json" <<'JSON'
{
  "mountPoint": "/mnt/projection",
  "pointerPath": "/var/lib/projectiond/manifest/pointer.json",
  "probeCacheDir": "/var/lib/projectiond/cache",
  "statusAddr": "127.0.0.1:9000",
  "localRoots": { "media": "/var/lib/projectiond/media" },
  "endpoints": []
}
JSON

# THE IMAGE AS AN IMMUTABLE REFERENCE. A locally built image has no repository digest; its ID is still exact
# bytes on this host, which is what the shipped command asks for and what `upgrade` records.
IMAGE_REF="$(docker inspect -f '{{.Id}}' "$IMAGE")"
test -n "$IMAGE_REF" || die "the built image has no id, so nothing pinned could be run"

# THE ENVIRONMENT CONTRACT, IN FULL, EXACTLY AS THE SHIPPED COMMAND DEFINES IT.
export PROJECTIOND_ALPHA_MANIFEST_DIR="$WORK/manifest"
export PROJECTIOND_ALPHA_MEDIA_ROOT="$WORK/media"
export PROJECTIOND_ALPHA_CACHE_DIR="$WORK/cache"
export PROJECTIOND_ALPHA_MOUNT="$WORK/mnt"
export PROJECTIOND_ALPHA_SECRETS_DIR="$WORK/secrets"
export PROJECTIOND_ALPHA_CONFIG="$WORK/config.json"
export PROJECTIOND_ALPHA_IMAGE="$IMAGE_REF"

ALPHA_STATUS=0
alpha() {
  local verb="$1"
  set +e
  bash "$ALPHA" "$verb" > "$WORK/out/alpha-$verb-${CYCLE_ID:-pre}.txt" 2>&1
  ALPHA_STATUS=$?
  set -e
  return 0
}

step "C1 — three consumers attach BEFORE anything has ever been mounted at the path"
# BEFORE, because §11 of the Phase 0 product contract says a bind taken while the path is a plain directory
# is a slave of the parent's peer group and follows every later mount there. The shipped `install` refuses an
# appliance with no consumer attached, so this is also what makes the next step possible at all.
for spec in "jf:$JF_CONTAINER:$WORK/jf-config" "plex:$PLEX_CONTAINER:$WORK/plex-config" \
            "emby:$EMBY_CONTAINER:$WORK/emby-config"; do
  name="${spec#*:}"; config="${name#*:}"; name="${name%%:*}"
  docker run -d --name "$name" --user 1000:1000 --network "$NETWORK" \
    -v "$WORK/mnt:/media/projection:rslave" -v "$config:/config" \
    "$VERIFY_IMAGE" sh -c 'while :; do sleep 3600; done' >/dev/null
done
echo "  three unprivileged consumers hold the projected path; none of them is a media server and none is \
asked to behave like one"

# THE GATE'S OWN FUNCTIONS, LIFTED OUT OF THE GATE'S OWN BYTES AT RUN TIME.
#
# THIS IS WHAT MAKES THE REHEARSAL A REHEARSAL RATHER THAN A SECOND IMPLEMENTATION. A copy of
# `inherit_fingerprint` kept here would agree with itself for ever; these are the gate's, so a repair made
# there is exercised here and a rename fails loudly below instead of quietly rehearsing nothing.
lift() {
  local name="$1" body
  # ONE LINE, for the reason the gate's own `count_our_layers` states about itself: a quoted program split
  # over two is one `test/custody-runtime-closure.ts` cannot parse.
  body="$(awk -v fn="$name" '$0 ~ "^" fn "\\(\\) \\{" { inside = 1 } inside { print } inside && /^\}$/ { exit }' "$GATE_SOURCE")"
  case "$body" in
    "$name() {"*) : ;;
    *) die "could not lift $name() out of $GATE_SOURCE; the gate has renamed or reshaped it, and a \
rehearsal that silently skipped it would be rehearsing nothing" ;;
  esac
  eval "$body"
}
P8_SERVERS='emby jellyfin plex'
for fn in count_our_layers count_rows_at_mountpoint layers_above_floor container_for config_dir_for \
          bind_fingerprint inherit_fingerprint assert_inherited intervened; do
  lift "$fn"
done
pass "C2 the gate's own inheritance, bind and mount-layer functions were lifted out of its bytes and are \
what the cycles below run"
count_rows_here() { count_rows_at_mountpoint; }

MOUNT_LAYER_FLOOR="$(count_our_layers)"
MOUNT_LAYER_FLOOR_ROWS="$(count_rows_at_mountpoint)"
OPERATOR_INTERVENTIONS=0
echo "  the floor, taken before the appliance has ever mounted, is $MOUNT_LAYER_FLOOR of ours and \
$MOUNT_LAYER_FLOOR_ROWS row(s) of any kind"

bind_fingerprint "$WORK/out/binds-before.txt"
INHERIT_BASELINE="$WORK/out/inherit-before.txt"
WE_OWN_THE_APPLIANCE=1

# ----------------------------------------------------------------------------------------------------------
step "C3 — three inheriting cycles of the shipped operator command, with NOTHING recreated between them"
# ----------------------------------------------------------------------------------------------------------
# THE CYCLE IS §3's, MINUS EVERY STEP THAT NEEDS A PROVIDER OR A MEDIA SERVER. S3's four approved windows and
# S4's playback are provider-facing by definition and are not rehearsed; S5's injected recovery is rehearsed
# as the ordinary path only. What is left is exactly the part §11.2 named: the same cycle, the same
# inheritance assertion, and the same operator command, against the local seed entry.
CYCLES_RUN=0
readable() {
  docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
    dd "if=/mnt/$SEED_PATH" of=/dev/null bs=1 count=1 >/dev/null 2>&1
}
await_readable() {
  local n=0
  while [ "$n" -lt "${1:-240}" ]; do
    if readable; then return 0; fi
    n=$((n + 1)); sleep 0.5
  done
  return 1
}

for CYCLE_INDEX in 1 2 3; do
  CYCLE_ID="C$CYCLE_INDEX"
  echo
  echo "  ---------- cycle $CYCLE_INDEX ----------"

  # THE INHERITANCE, ASSERTED BY THE GATE'S OWN FUNCTION. `assert_inherited` calls `record`, which this
  # rehearsal does not have and must not have — it writes no verdict any closure check will read — so the
  # comparison is driven directly and reported as this script's own assertion.
  NOW="$WORK/out/inherit-$CYCLE_ID.txt"
  if ! inherit_fingerprint "$NOW"; then
    echo "    what could not be read:" >&2; grep UNREADABLE "$NOW" | sed 's/^/      /' >&2 || true
    fail "C3.$CYCLE_INDEX the gate's own inheritance fingerprint could not read something it must compare"
  elif [ "$CYCLE_INDEX" -eq 1 ]; then
    cp "$NOW" "$INHERIT_BASELINE"
    pass "C3.1 the first cycle established the inheritance baseline the later ones must find unchanged"
  elif cmp -s "$INHERIT_BASELINE" "$NOW"; then
    pass "C3.$CYCLE_INDEX the same cache, ledger, manifest, consumer configuration directories, container \
ids and mount point as cycle 1 — this cycle inherited rather than started over"
  else
    diff "$INHERIT_BASELINE" "$NOW" >&2 || true
    fail "C3.$CYCLE_INDEX something this cycle should have inherited is a DIFFERENT object"
  fi

  # S1 — PREFLIGHT, against a mount point that on cycles 2 and 3 has been mounted before.
  alpha preflight
  DEAD=0
  if [ -e "$WORK/mnt" ] && ! ls "$WORK/mnt" >/dev/null 2>&1; then DEAD=1; fi
  REFUSED=0
  [ "$ALPHA_STATUS" -eq 0 ] || REFUSED=1
  if [ "$DEAD" -eq "$REFUSED" ]; then
    pass "C3.$CYCLE_INDEX S1 preflight exited $ALPHA_STATUS and the mount point is \
$( [ "$DEAD" -eq 1 ] && echo DEAD || echo readable ) — it refuses when and only when there is something to refuse"
  else
    sed 's/^/      /' "$WORK/out/alpha-preflight-$CYCLE_ID.txt" >&2 || true
    fail "C3.$CYCLE_INDEX S1 preflight exited $ALPHA_STATUS over a mount point that is \
$( [ "$DEAD" -eq 1 ] && echo DEAD || echo readable )"
  fi
  if [ "$DEAD" -eq 1 ]; then
    intervened "the mount point was a dead mount and preflight's own remediation had to be applied"
    umount -l "$WORK/mnt" 2>/dev/null || true
  fi

  # S2 — INSTALL, START, START AGAIN, STATUS, with three consumers holding the path.
  alpha install; INSTALLED="$ALPHA_STATUS"
  alpha start;   FIRST="$ALPHA_STATUS"
  alpha start;   SECOND="$ALPHA_STATUS"
  if [ "$INSTALLED" -eq 0 ] && [ "$FIRST" -eq 0 ]; then
    pass "C3.$CYCLE_INDEX S2 the shipped install and start succeeded with three consumers holding the mount"
  else
    sed 's/^/      /' "$WORK/out/alpha-install-$CYCLE_ID.txt" >&2 || true
    sed 's/^/      /' "$WORK/out/alpha-start-$CYCLE_ID.txt" >&2 || true
    fail "C3.$CYCLE_INDEX S2 install exited $INSTALLED and start exited $FIRST"
  fi
  if [ "$SECOND" -eq 0 ]; then
    pass "C3.$CYCLE_INDEX S2 a SECOND start over a running appliance also exited 0, which is what idempotent means"
  else
    fail "C3.$CYCLE_INDEX S2 a second start over a running appliance exited $SECOND, so start is not idempotent"
  fi
  alpha status
  SAYS_RUNNING=0
  grep -q "container  *running" "$WORK/out/alpha-status-$CYCLE_ID.txt" && SAYS_RUNNING=1
  READS=0
  await_readable 240 && READS=1
  if [ "$SAYS_RUNNING" -eq "$READS" ]; then
    pass "C3.$CYCLE_INDEX S2 the operator surface (running=$SAYS_RUNNING) agrees with what a sibling \
container can actually read (=$READS)"
  else
    fail "C3.$CYCLE_INDEX S2 the surface says running=$SAYS_RUNNING and a sibling container reads=$READS"
  fi

  # S3 (provider-free form) — all three consumers read the LOCAL seed entry, in their own containers.
  HOLDING=0
  for consumer in "$JF_CONTAINER" "$PLEX_CONTAINER" "$EMBY_CONTAINER"; do
    GOT="$(docker exec -u 1000:1000 "$consumer" sh -c "sha256sum '/media/projection/$SEED_PATH'" 2>/dev/null \
      | awk '{print $1}')"
    [ "$GOT" = "$SUBJECT_SHA" ] && HOLDING=$(( HOLDING + 1 ))
  done
  if [ "$HOLDING" -eq 3 ]; then
    pass "C3.$CYCLE_INDEX S3 all three consumers read the identical bytes through the same mount, in their \
own containers as their own uid, without having been restarted or re-bound"
  else
    fail "C3.$CYCLE_INDEX S3 only $HOLDING of 3 consumers read the expected bytes"
  fi

  # S6 — THE LAYER COUNT, against the floor taken before the FIRST cycle mounted anything.
  ABOVE="$(layers_above_floor)"
  if [ -n "$ABOVE" ] && [ "$ABOVE" -le 1 ]; then
    pass "C3.$CYCLE_INDEX S6 $ABOVE layer(s) of ours above the floor of $MOUNT_LAYER_FLOOR, measured against \
the floor taken before the FIRST cycle mounted rather than one re-measured per cycle"
  else
    fail "C3.$CYCLE_INDEX S6 ${ABOVE:-no} layer(s) above the floor of $MOUNT_LAYER_FLOOR"
  fi

  # S7 — STOP AND START, with the three consumers untouched.
  alpha stop
  SETTLE=0
  while [ "$SETTLE" -lt 40 ] && [ "$(count_our_layers)" -gt "$MOUNT_LAYER_FLOOR" ]; do
    sleep 0.5; SETTLE=$(( SETTLE + 1 ))
  done
  AFTER_STOP="$(count_our_layers)"
  if [ "$AFTER_STOP" -eq "$MOUNT_LAYER_FLOOR" ]; then
    pass "C3.$CYCLE_INDEX S7 the shipped stop left NOTHING of ours at the mount point"
  else
    fail "C3.$CYCLE_INDEX S7 the shipped stop left $AFTER_STOP of ours against a floor of $MOUNT_LAYER_FLOOR"
  fi
  alpha start
  if await_readable 240; then
    pass "C3.$CYCLE_INDEX S7 a sibling container reads a byte through the mount again after the shipped start"
  else
    fail "C3.$CYCLE_INDEX S7 the mount never became readable again after the shipped start"
  fi
  bind_fingerprint "$WORK/out/binds-s7-$CYCLE_ID.txt"
  if cmp -s "$WORK/out/binds-before.txt" "$WORK/out/binds-s7-$CYCLE_ID.txt"; then
    pass "C3.$CYCLE_INDEX S7 the same three containers, started at the same instants, holding the same \
mounts across the stop and the start"
  else
    diff "$WORK/out/binds-before.txt" "$WORK/out/binds-s7-$CYCLE_ID.txt" >&2 || true
    fail "C3.$CYCLE_INDEX S7 a consumer container or one of its mounts changed across the stop and start"
  fi

  # S8 — THE DURABLE LEDGER AND THE RESET THAT CLEARS IT.
  alpha reset-recovery
  if [ "$ALPHA_STATUS" -eq 0 ]; then
    pass "C3.$CYCLE_INDEX S8 the shipped reset-recovery ran against the durable ledger and exited 0"
  else
    sed 's/^/      /' "$WORK/out/alpha-reset-recovery-$CYCLE_ID.txt" >&2 || true
    fail "C3.$CYCLE_INDEX S8 the shipped reset-recovery exited $ALPHA_STATUS"
  fi

  # S9 — UPGRADE RECORDS A ROLLBACK TARGET BEFORE IT CHANGES ANYTHING, AND ROLLBACK HONOURS IT.
  ROLLBACK_TARGET="$WORK/cache/.projection-alpha-previous-image"
  rm -f "$ROLLBACK_TARGET"
  alpha upgrade; UPGRADED="$ALPHA_STATUS"
  TARGET_AFTER=""
  [ -s "$ROLLBACK_TARGET" ] && TARGET_AFTER="$(head -1 "$ROLLBACK_TARGET")"
  if [ "$UPGRADED" -eq 0 ] && [ -n "$TARGET_AFTER" ]; then
    pass "C3.$CYCLE_INDEX S9 upgrade recorded a rollback target at the path the shipped command owns, \
before it changed anything"
  else
    sed 's/^/      /' "$WORK/out/alpha-upgrade-$CYCLE_ID.txt" >&2 || true
    fail "C3.$CYCLE_INDEX S9 upgrade exited $UPGRADED and the recorded rollback target is \
'${TARGET_AFTER:-absent}'"
  fi
  alpha rollback; ROLLED="$ALPHA_STATUS"
  if [ "$ROLLED" -eq 0 ] && await_readable 240; then
    pass "C3.$CYCLE_INDEX S9 rollback honoured the recorded target and the mount is readable again"
  else
    sed 's/^/      /' "$WORK/out/alpha-rollback-$CYCLE_ID.txt" >&2 || true
    fail "C3.$CYCLE_INDEX S9 rollback exited $ROLLED or the mount never came back"
  fi

  CYCLES_RUN=$(( CYCLES_RUN + 1 ))
done

if [ "$OPERATOR_INTERVENTIONS" -eq 0 ]; then
  pass "C4 nothing between two cycles required a human: $OPERATOR_INTERVENTIONS operator intervention(s)"
else
  fail "C4 $OPERATOR_INTERVENTIONS operator intervention(s) were needed between cycles"
fi
if [ "$CYCLES_RUN" -eq 3 ]; then
  pass "C5 all three cycles ran to completion against the same cache, ledger, manifest and mount point"
else
  fail "C5 only $CYCLES_RUN cycle(s) completed"
fi

# ----------------------------------------------------------------------------------------------------------
step "C6 — a FOREIGN overlay on top is refused at shutdown, left mounted and byte-unmodified"
# ----------------------------------------------------------------------------------------------------------
# THE SAFETY BOUNDARY, REHEARSED IN THE ORDINARY PATH. §8.7's removal is authorised by an IDENTITY: the one
# row this process recorded creating, and nothing else. The likeliest thing that is not that row is somebody
# else's mount, and the shutdown must leave it exactly as it found it.
OVERLAY_TAG="phase8-rehearsal-foreign-$$"
if mount -t tmpfs -o size=1m,nr_inodes=64 "$OVERLAY_TAG" "$WORK/mnt" 2>/dev/null; then
  CANARY="$WORK/mnt/foreign-canary.txt"
  echo "$OVERLAY_TAG" > "$CANARY"
  CANARY_BEFORE="$(cat "$CANARY")"
  alpha stop
  sleep 2
  TOP_FS="$(awk -v target="$WORK/mnt" '{ sep = 0; for (i = 1; i <= NF; i++) { if ($i == "-") { sep = i; break } } if ($5 == target && sep > 0) t = $(sep + 1) } END { print t }' /proc/self/mountinfo)"
  CANARY_AFTER="$(cat "$CANARY" 2>/dev/null || echo "")"
  if [ "$TOP_FS" = "tmpfs" ] && [ -n "$CANARY_BEFORE" ] && [ "$CANARY_BEFORE" = "$CANARY_AFTER" ]; then
    pass "C6 the foreign overlay is STILL the top of the stack and byte-unmodified after the shipped stop"
  else
    fail "C6 the foreign overlay was disturbed by the shutdown (the top is now '$TOP_FS')"
  fi
  rm -f "$CANARY" 2>/dev/null || true
  n=0
  while [ "$n" -lt 8 ] && [ "$(count_rows_at_mountpoint)" -gt "$MOUNT_LAYER_FLOOR_ROWS" ]; do
    umount -l "$WORK/mnt" 2>/dev/null || true
    n=$(( n + 1 )); sleep 0.5
  done
  if [ "$(count_our_layers)" -eq "$MOUNT_LAYER_FLOOR" ]; then
    pass "C6 and this rehearsal removed its OWN overlay and only that, back to the floor"
  else
    fail "C6 the mount point could not be returned to the floor after the overlay was removed"
  fi
else
  fail "C6 a tmpfs could not be stacked above the mount point, so nothing could be refused and this \
assertion measured nothing"
fi

# ----------------------------------------------------------------------------------------------------------
step "C7 — the host is as it was found, asserted rather than reported"
# ----------------------------------------------------------------------------------------------------------
docker compose -p "$ALPHA_PROJECT" -f docker-compose.projection-alpha.yml down -v --remove-orphans \
  >/dev/null 2>&1 || true
docker rm -f "$ALPHA_CONTAINER" >/dev/null 2>&1 || true
WE_OWN_THE_APPLIANCE=0
docker rm -f "$JF_CONTAINER" "$PLEX_CONTAINER" "$EMBY_CONTAINER" >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
docker network rm "$NETWORK" >/dev/null 2>&1 || true
projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true
CLEANED=1

LEFT_MOUNTS="$(projection_gate_mounts_under "$WORK")"
if [ "${LEFT_MOUNTS:-1}" -eq 0 ]; then
  pass "C7 no mountpoint is left under this run's own directory"
else
  fail "C7 $LEFT_MOUNTS mountpoint(s) are left under this run's own directory"
fi
if [ ! -d "$WORK" ]; then
  pass "C7 this run's own directory is gone, asserted rather than reported"
else
  fail "C7 this run's own directory is still on the host"
fi

SETS_OK=1
for what in containers networks volumes; do
  case "$what" in
    containers) before="$CONTAINERS_BEFORE"; after="$(docker ps -a --format '{{.Names}}' | LC_ALL=C sort)" ;;
    networks)   before="$NETWORKS_BEFORE";   after="$(docker network ls --format '{{.Name}}' | LC_ALL=C sort)" ;;
    volumes)    before="$VOLUMES_BEFORE";    after="$(docker volume ls --format '{{.Name}}' | LC_ALL=C sort)" ;;
  esac
  if [ "$before" != "$after" ]; then
    SETS_OK=0
    echo "  the $what SET differs:" >&2
    diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | head -8 >&2 || true
  fi
done
if [ "$SETS_OK" -eq 1 ]; then
  pass "C7 the container, network and volume SETS are identical before and after, compared as sets"
else
  fail "C7 this run changed the host's container, network or volume set"
fi

# ----------------------------------------------------------------------------------------------------------
echo
echo "PHASE 8 REHEARSAL: $(( RESULTS - FAILURES )) pass, $FAILURES fail, of $RESULTS assertions."
echo "WHAT THIS REHEARSAL DOES NOT PROVE, AND WILL NOT BE PRESENTED AS PROVING:"
echo "  - It closes nothing. Phase 8 closes on three consecutive fresh soaks of the real gate against the"
echo "    real provider, and this is none of those things."
echo "  - No provider was contacted and none could be: the daemon is configured with no endpoint at all."
echo "  - No media server was involved and none was simulated. The three consumers are unprivileged"
echo "    containers holding the path; nothing here asserts anything about Plex, Jellyfin or Emby."
echo "  - It makes no timing, layer-count or recovery claim any document may cite as evidence about the"
echo "    appliance. Every number above is about the instrument."
if [ "$FAILURES" -ne 0 ]; then
  exit 1
fi
echo "RESULT: PASSED"
