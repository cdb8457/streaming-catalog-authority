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
# ...AND THE OPTIONAL ONES, WHICH ARE A DIFFERENT LIST AND MUST BE READ FROM THE SAME BYTES.
#
# WHY THEY ARE HERE AT ALL. §13 gives the shipped command two bounded inputs — the poll interval the recovery
# budgets are derived from, and the state directory the ownership record lives in — and a comparison that
# knew only the REQUIRED list would report the gate handing over a perfectly correct optional one as "set by
# the gate and required by nothing". What A4 is for is that the gate can INVOKE the command; a name the
# command defines and validates is a name it can take.
alpha_optional_names() { awk '/^OPTIONAL_INPUTS=/,/[^\\]$/' "$ALPHA" | tr -d '\\"' | tr ' ' '\n' | grep -o 'PROJECTIOND_ALPHA_[A-Z_]*' | LC_ALL=C sort -u; }
gate_supplied_names() { awk '/^alpha\(\) \{/,/^\}$/' "$GATE_SOURCE" | grep -o 'PROJECTIOND_ALPHA_[A-Z_]*=' | tr -d '=' | LC_ALL=C sort -u; }
ALPHA_REQUIRES="$(alpha_required_names)"
ALPHA_OPTIONAL="$(alpha_optional_names)"
ALPHA_ACCEPTS="$(printf '%s\n%s\n' "$ALPHA_REQUIRES" "$ALPHA_OPTIONAL" | grep -v '^$' | LC_ALL=C sort -u)"
GATE_SUPPLIES="$(gate_supplied_names)"
test -n "$ALPHA_OPTIONAL" \
  || fail "A4 the shipped command publishes no OPTIONAL_INPUTS list, so §13's bounded inputs are undeclared"
MISSING_ENV="$(comm -23 <(printf '%s\n' "$ALPHA_REQUIRES") <(printf '%s\n' "$GATE_SUPPLIES") || true)"
UNKNOWN_ENV="$(comm -13 <(printf '%s\n' "$ALPHA_ACCEPTS") <(printf '%s\n' "$GATE_SUPPLIES") || true)"
if [ -z "$MISSING_ENV" ] && [ -z "$UNKNOWN_ENV" ]; then
  pass "A4 the gate hands the shipped operator command exactly the environment it requires, so S1, S2, S7, \
S8 and S9 can invoke it at all"
else
  [ -z "$MISSING_ENV" ] || { echo "    required by the shipped command and NOT set by the gate:" >&2
    printf '%s\n' "$MISSING_ENV" | sed 's/^/      /' >&2; }
  [ -z "$UNKNOWN_ENV" ] || { echo "    set by the gate and named by neither list in that command:" >&2
    printf '%s\n' "$UNKNOWN_ENV" | sed 's/^/      /' >&2; }
  fail "A4 the gate's environment for the shipped operator command does not match what that command \
requires, so every verb in S1, S2, S7, S8 and S9 exits REFUSED and five of the ten steps measure nothing"
  echo "    A4 AND A6 ARE ONE BLOCKER WITH TWO HALVES AND NEITHER MAY BE REPAIRED ALONE. While the names" >&2
  echo "    are wrong every verb refuses and changes nothing, which is a SAFE failure. Correcting them" >&2
  echo "    while anything else in the gate still mounts at the same path would aim a live shipped" >&2
  echo "    install and start at a mount point another daemon is already serving." >&2
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
# WHAT IT ASKS OF THE BYTES, AND IT IS THREE QUESTIONS RATHER THAN ONE, because the blocker had three halves
# and repairing any two of them would still leave a gate that measured the wrong thing:
#
#   - does the gate drive the shipped lifecycle verbs at all? (§3's S1, S2, S7, S8 and S9 ARE those verbs)
#   - does it mount anything ITSELF? Every `docker run` that binds the projected path inside a container is a
#     second owner, and the search is for the BIND rather than for a container name, because a name can be
#     renamed and a bind cannot be anything else.
#   - is the subject the container the shipped profile names? A gate driving the shipped verbs while watching
#     a container of its own would be reading one appliance's logs about another's mount.
# THE PATTERN IS A VARIABLE AND CARRIES NO DOUBLE QUOTE, and `test/custody-runtime-closure.ts` is why: it
# reads every shipped script end to end under all three line endings and cannot parse a quoted regex holding
# the other quote inside a command substitution. An unreadable line is not an empty one.
GATE_MOUNT_PATTERN='^[[:space:]]*-v .*:/mnt/projection:rshared'
GATE_MOUNTS_ITS_OWN=$(grep -cE "$GATE_MOUNT_PATTERN" "$GATE_SOURCE" || true)
GATE_DRIVES_SHIPPED="$(grep -cE '^\s*alpha (install|start|stop|upgrade|rollback)\b' "$GATE_SOURCE" || true)"
GATE_SUBJECT_IS_SHIPPED=0
grep -q '^MOUNT_CONTAINER="projection-alpha-projectiond"$' "$GATE_SOURCE" && GATE_SUBJECT_IS_SHIPPED=1
if [ "${GATE_MOUNTS_ITS_OWN:-0}" -ge 1 ]; then
  fail "A6 the gate still binds the projected path into a container of its own ($GATE_MOUNTS_ITS_OWN place(s)), \
so one mount point has two owners and the five steps §3 defines as the shipped command cannot be measured"
elif [ "${GATE_DRIVES_SHIPPED:-0}" -lt 1 ]; then
  fail "A6 the gate drives no lifecycle verb of the shipped operator command at all, so §3's S1, S2, S7, S8 \
and S9 are not the steps the contract defines"
elif [ "$GATE_SUBJECT_IS_SHIPPED" -ne 1 ]; then
  fail "A6 the gate drives the shipped verbs but its subject container is not the one the shipped compose \
profile names, so its observations are about a different appliance from the one it is driving"
else
  pass "A6 the appliance under test is the one the shipped operator command owns: $GATE_DRIVES_SHIPPED \
lifecycle invocation(s), no bind of the projected path into any container of the gate's own, and the subject \
is the container name the shipped profile fixes"
fi

# AND THE CONTROL FOR A6, because a search that finds nothing has not been shown to be able to find anything.
cp "$GATE_SOURCE" "$GATE_ROOT/tamper-$$.sh"
SECOND_OWNER_LINE='    -v $WORK/mnt:/mnt/projection:rshared'
printf '%s\n' "$SECOND_OWNER_LINE" >> "$GATE_ROOT/tamper-$$.sh"
TAMPER_HITS=$(grep -cE "$GATE_MOUNT_PATTERN" "$GATE_ROOT/tamper-$$.sh" || true)
if [ "${TAMPER_HITS:-0}" -ge 1 ]; then
  pass "A6b CONTROL: the same search DOES find a second owner when one is put back"
else
  fail "A6b CONTROL: a re-introduced second-owner bind was not detected, so A6 proves nothing"
fi
rm -f "$GATE_ROOT/tamper-$$.sh"

# ----------------------------------------------------------------------------------------------------------
# A7 — THE OTHER HALF OF THE RECONCILIATION: THE PROFILE CAN EXPRESS WHAT THE BUDGETS ASSUME.
# ----------------------------------------------------------------------------------------------------------
# §12 of the previous record named this as the reason renaming the variables was not enough: "the appliance
# under test runs with the shipped profile's hard-coded `--poll=5s` and WITHOUT `--strict-direct-mount`, and
# so is not the appliance Phase 7 measured". §13 resolves it in the product rather than in the gate — the poll
# interval became a bounded, validated operator input and the strict flag became part of the profile — so
# what is checked here is that the product really can express it and that the gate really hands it over.
#
# THE PATTERNS BELOW END AT THE FLAG, NOT AT A LINE END, AND A REAL RUN IS WHY. `.gitattributes` forces LF on
# `*.sh` and `*.go` and on nothing else, so `git archive` stages this compose file to the Unraid host with
# CRLF line endings. A `$`-anchored `grep` therefore reported that the profile no longer passes
# `--strict-direct-mount` while the flag was sitting there followed by a carriage return — a rehearsal failing
# on the one host that matters, for a line ending, which is how a correct pin gets weakened by the next person.
A7_OK=1
grep -q -- '- --poll=\${PROJECTIOND_ALPHA_POLL:-5s}' docker-compose.projection-alpha.yml \
  || { A7_OK=0; echo "    the alpha profile no longer takes the poll interval as a bounded input" >&2; }
grep -qE '^[[:space:]]+- --strict-direct-mount[[:space:]]*$' docker-compose.projection-alpha.yml \
  || { A7_OK=0; echo "    the alpha profile no longer passes --strict-direct-mount" >&2; }
grep -q 'PROJECTIOND_ALPHA_POLL="\$DAEMON_POLL"' "$GATE_SOURCE" \
  || { A7_OK=0; echo "    the gate does not hand the shipped command the interval its budgets assume" >&2; }
grep -q 'check_poll_shape' "$ALPHA" \
  || { A7_OK=0; echo "    the shipped command no longer validates the poll interval" >&2; }
if [ "$A7_OK" -eq 1 ]; then
  pass "A7 the shipped profile expresses the poll interval as a bounded, validated operator input and passes \
--strict-direct-mount, and the gate hands it the same interval its budgets are derived from"
else
  fail "A7 the appliance the gate would drive is not configured the way §4's budgets assume, so a soak would \
measure a differently configured daemon from the product being claimed"
fi

# ----------------------------------------------------------------------------------------------------------
# A8 — THE OWNERSHIP MARKER IS NOT INSIDE THE THING IT GOVERNS. Defect #14, asked of the bytes.
# ----------------------------------------------------------------------------------------------------------
A8_OK=1
grep -q '^MARKED_DIRS="PROJECTIOND_ALPHA_CACHE_DIR"$' "$ALPHA" \
  || { A8_OK=0; echo "    the shipped command's marked-directory list is not the cache alone" >&2; }
awk '/^install_appliance\(\) \{/,/^\}$/' "$ALPHA" | grep -q 'for name in \$MARKED_DIRS' \
  || { A8_OK=0; echo "    install still writes a marker into every OWNED directory, mount point included" >&2; }
awk '/^install_appliance\(\) \{/,/^\}$/' "$ALPHA" | grep -q 'write_ownership_record' \
  || { A8_OK=0; echo "    install writes no durable ownership record outside the projected namespace" >&2; }
grep -q 'is inside the mount point, where this appliance' "$ALPHA" \
  || { A8_OK=0; echo "    a state directory inside the mount point is no longer refused" >&2; }
if [ "$A8_OK" -eq 1 ]; then
  pass "A8 the shipped command records what it owns OUTSIDE the namespace it mounts, writes no marker into \
the mount point, and refuses a state directory placed inside one"
else
  fail "A8 the ownership marker is still governed by the filesystem that hides it, which is defect #14"
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

# ----------------------------------------------------------------------------------------------------------
step "C1a — the bounded inputs §13 adds are VALIDATED, and an invalid one is refused rather than resolved"
# ----------------------------------------------------------------------------------------------------------
# THE POSITIVE COMES FIRST AND IT IS WHAT MAKES THE REST CONTROLS RATHER THAN COINCIDENCES. `preflight`
# refuses an appliance with no consumer attached, so every one of these would exit non-zero for a reason that
# has nothing to do with the input under test if it ran before C1. It runs here, with three consumers holding
# the path, where a valid environment PASSES — and so a refusal below is attributable to the one thing changed.
alpha preflight
if [ "$ALPHA_STATUS" -eq 0 ]; then
  pass "C1a with every input valid and three consumers attached, the shipped preflight PASSES — so each \
refusal below is attributable to the single input it changes"
else
  sed 's/^/      /' "$WORK/out/alpha-preflight-pre.txt" >&2 || true
  fail "C1a the shipped preflight refused a valid environment, so none of the controls below mean anything"
fi

refuses_with() {
  local what="$1" name="$2" value="$3"
  if env "$name=$value" bash "$ALPHA" preflight >/dev/null 2>&1; then
    fail "$what — IT WAS ACCEPTED, so the validation it controls proves nothing"
  else
    pass "$what"
  fi
}
refuses_with "C1a PROJECTIOND_ALPHA_POLL that is not a duration is REFUSED" PROJECTIOND_ALPHA_POLL "abc"
refuses_with "C1a PROJECTIOND_ALPHA_POLL of 0s is REFUSED" PROJECTIOND_ALPHA_POLL "0s"
refuses_with "C1a PROJECTIOND_ALPHA_POLL above the ceiling is REFUSED" PROJECTIOND_ALPHA_POLL "600s"
refuses_with "C1a PROJECTIOND_ALPHA_POLL in milliseconds is REFUSED" PROJECTIOND_ALPHA_POLL "1500ms"
refuses_with "C1a a relative PROJECTIOND_ALPHA_STATE_DIR is REFUSED" PROJECTIOND_ALPHA_STATE_DIR "state"
refuses_with "C1a a PROJECTIOND_ALPHA_STATE_DIR INSIDE the mount point is REFUSED — defect #14 as a rule" \
  PROJECTIOND_ALPHA_STATE_DIR "$WORK/mnt/state"
refuses_with "C1a a PROJECTIOND_ALPHA_STATE_DIR inside the operator's media root is REFUSED" \
  PROJECTIOND_ALPHA_STATE_DIR "$WORK/media/state"

# AND THE OWNERSHIP RECORD ITSELF: A FOREIGN ONE IS REFUSED, NOT ADOPTED AND NOT OVERWRITTEN.
#
# This is the state an operator reaches by pointing a second appliance's state directory at the first one's,
# or by moving a cache between installations. "Not ours" and "nobody's" are different answers and only the
# second may be adopted; a command that collapsed them would put its name on another appliance's directories.
FOREIGN_STATE="$WORK/foreign-state"
mkdir -p "$FOREIGN_STATE"
printf 'version 2\nmount /somewhere/else/mnt\ncache /somewhere/else/cache\n' > "$FOREIGN_STATE/owned"
refuses_with "C1a an ownership record naming a DIFFERENT installation is REFUSED rather than adopted" \
  PROJECTIOND_ALPHA_STATE_DIR "$FOREIGN_STATE"
printf 'version 99\nmount %s\ncache %s\n' "$WORK/mnt" "$WORK/cache" > "$FOREIGN_STATE/owned"
refuses_with "C1a an ownership record this version cannot read is REFUSED rather than guessed at" \
  PROJECTIOND_ALPHA_STATE_DIR "$FOREIGN_STATE"
printf 'version 2\nmount %s\ncache %s\n' "$WORK/mnt" "$WORK/cache" > "$FOREIGN_STATE/owned"
if env "PROJECTIOND_ALPHA_STATE_DIR=$FOREIGN_STATE" bash "$ALPHA" preflight >/dev/null 2>&1; then
  pass "C1a CONTROL: the SAME record naming THIS installation is accepted, so the two refusals above are \
about whose record it is rather than about there being one"
else
  fail "C1a CONTROL: a correct ownership record was refused, so the refusals above prove nothing"
fi
rm -rf "$FOREIGN_STATE"

# THE COVERED v1 MARKER — THE EXACT SHAPE AN OPERATOR UPGRADING FROM THE PREVIOUS VERSION ARRIVES IN.
#
# A v1 installation wrote `.projection-alpha/owned` INTO the mount point while it was still a plain directory.
# This puts one there before anything has ever mounted, so the cycles below run over an installation that
# already carries one — and the mount that covers it must not turn a working appliance into an `install` that
# fails forever.
mkdir -p "$WORK/mnt/.projection-alpha"
printf 'projection-alpha owns this directory. Removing this file does not remove the data.\n' \
  > "$WORK/mnt/.projection-alpha/owned"
echo "  a v1 ownership marker has been left inside the mount point, so the cycles below are a MIGRATION \
rather than a first install"

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
    pass "C3.$CYCLE_INDEX S2 the shipped install and start succeeded with three consumers holding the mount\
$( [ "$CYCLE_INDEX" -gt 1 ] && printf '%s' ", and this install ran over an appliance that was already SERVING, which is defect #14" )"
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

  # SOLE OWNERSHIP, ASSERTED RATHER THAN ASSUMED, AND IT IS THE WHOLE OF §13 IN TWO NUMBERS.
  #
  # ONE container serving this mount point, and it is the one the shipped profile names; ONE row of ours at
  # the path, above the floor taken before anything mounted. Two owners show up as two of either, and the
  # blocker this redesign exists to remove was exactly that state written into the instrument.
  OWNERS="$(docker ps --format '{{.Names}}' --filter "name=^${ALPHA_CONTAINER}$" | grep -c . || true)"
  FOREIGN_OWNERS=0
  for other in $(docker ps --format '{{.Names}}' | grep -v "^${ALPHA_CONTAINER}$" || true); do
    if docker inspect -f '{{range .Mounts}}{{.Destination}}{{println}}{{end}}' "$other" 2>/dev/null \
         | grep -qx '/mnt/projection'; then
      FOREIGN_OWNERS=$(( FOREIGN_OWNERS + 1 ))
    fi
  done
  OURS_NOW="$(count_our_layers)"
  if [ "$OWNERS" -eq 1 ] && [ "$FOREIGN_OWNERS" -eq 0 ] \
     && [ "$OURS_NOW" -eq $(( MOUNT_LAYER_FLOOR + 1 )) ]; then
    pass "C3.$CYCLE_INDEX SOLE OWNERSHIP: exactly one appliance container serves this mount point, no other \
container on the host projects at it, and there is exactly one layer of ours above the floor"
  else
    fail "C3.$CYCLE_INDEX SOLE OWNERSHIP: $OWNERS appliance container(s), $FOREIGN_OWNERS other \
projecting container(s), and $OURS_NOW layer(s) of ours against a floor of $MOUNT_LAYER_FLOOR"
  fi

  # THE OWNERSHIP RECORD IS WHERE §13 PUTS IT, AND NOTHING WAS WRITTEN UNDER THE MOUNT.
  RECORD="$WORK/cache/.projection-alpha-state/owned"
  RECORD_PERMS="$(stat -c '%a' "$RECORD" 2>/dev/null || echo absent)"
  RECORD_DIR_PERMS="$(stat -c '%a' "$WORK/cache/.projection-alpha-state" 2>/dev/null || echo absent)"
  RECORD_MOUNT="$(sed -n 's/^mount //p' "$RECORD" 2>/dev/null | head -1 || true)"
  if [ "$RECORD_MOUNT" = "$WORK/mnt" ] && [ "$RECORD_PERMS" = "600" ] && [ "$RECORD_DIR_PERMS" = "700" ]; then
    pass "C3.$CYCLE_INDEX the ownership record names this mount point exactly, at 0600 inside a 0700 \
directory, OUTSIDE the namespace it governs"
  else
    fail "C3.$CYCLE_INDEX the ownership record is '${RECORD_MOUNT:-absent}' at mode ${RECORD_PERMS} inside a \
directory at mode ${RECORD_DIR_PERMS}"
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
step "C8 — the appliance is REACHABLE BY NAME from the network its own profile declares"
# ----------------------------------------------------------------------------------------------------------
# THIS IS A WIRING ASSERTION AND IT IS HERE BECAUSE §13 MOVED THE SUBJECT ONTO A DIFFERENT NETWORK.
#
# The soak proves the TorBox resolver is loopback-only by trying to reach it from a sibling container and
# requiring a REFUSAL at the transport. `probe-reachable.cjs` distinguishes three outcomes: connected (0),
# refused or timed out (1), and **the host could not be resolved at all (2)** — and the gate treats 2 as
# fatal, because a probe that could not find its target has measured nothing. While the gate ran a daemon of
# its own on the gate network, the name resolved there. It no longer does: the appliance is on the network
# `docker-compose.projection-alpha.yml` declares. **A soak would have died in setup, on a name lookup,
# having measured nothing** — which is the exact shape of five entries in §11.3's ledger.
#
# SO WHAT IS ASSERTED IS THE DISTINCTION ITSELF: from the appliance's own network, its name RESOLVES (not 2)
# and a port nothing is listening on is REFUSED (1). No resolver is involved and none is simulated; this is
# about whether the question can be asked at all.
PROBE_CJS="$WORK/out/probe-reachable.cjs"
awk '/^cat > "\$WORK\/out\/probe-reachable.cjs" <<.PROBEREACHABLE.$/{inside=1;next} inside&&/^PROBEREACHABLE$/{exit} inside{print}' \
  "$GATE_SOURCE" > "$PROBE_CJS"
if [ ! -s "$PROBE_CJS" ]; then
  fail "C8 the gate's own reachability probe could not be lifted out of its bytes, so nothing was rehearsed"
else
  NODE_IMAGE_REHEARSAL="node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32"
  set +e
  docker run --rm --network "$ALPHA_PROJECT" -v "$WORK/out:/out:ro" \
    -e npm_config_update_notifier=false "$NODE_IMAGE_REHEARSAL" \
    node /out/probe-reachable.cjs "$ALPHA_CONTAINER" 9. >/dev/null 2>&1
  PROBE_BAD_PORT=$?
  docker run --rm --network "$ALPHA_PROJECT" -v "$WORK/out:/out:ro" \
    -e npm_config_update_notifier=false "$NODE_IMAGE_REHEARSAL" \
    node /out/probe-reachable.cjs "$ALPHA_CONTAINER" 8292 >/dev/null 2>&1
  PROBE_CLOSED=$?
  docker run --rm --network "$ALPHA_PROJECT" -v "$WORK/out:/out:ro" \
    -e npm_config_update_notifier=false "$NODE_IMAGE_REHEARSAL" \
    node /out/probe-reachable.cjs "no-such-appliance-$$" 8292 >/dev/null 2>&1
  PROBE_UNKNOWN=$?
  set -e
  if [ "$PROBE_CLOSED" -eq 1 ]; then
    pass "C8 the appliance resolves by name from its own network and a closed port is REFUSED at the \
transport, which is the outcome the soak's loopback-only assertion requires"
  else
    fail "C8 probing a closed port on the appliance from its own network returned $PROBE_CLOSED, where 1 is \
'refused' and 2 is 'the name could not be resolved and nothing was measured'"
  fi
  if [ "$PROBE_UNKNOWN" -eq 2 ]; then
    pass "C8 CONTROL: a name that does not exist returns 2 — 'nothing was measured' — so the check above is \
a resolution that worked rather than a probe that cannot tell the difference"
  else
    fail "C8 CONTROL: an unknown container name returned $PROBE_UNKNOWN instead of 2, so C8 cannot \
distinguish a refusal from a failed lookup"
  fi
  echo "  (a malformed port returned $PROBE_BAD_PORT; it is reported and asserted on by nothing)"
fi

# ----------------------------------------------------------------------------------------------------------
step "C9 — S5's ONE injected fault, against the SHIPPED appliance, provider-free"
# ----------------------------------------------------------------------------------------------------------
# WHY THIS IS HERE AND WHY IT IS NEW. §3's S5 is the only fault a cycle injects: the mount removed from
# beneath a LIVING daemon. Phase 7 measured that arm against a daemon THAT GATE ran; §13 makes the subject the
# appliance the shipped compose profile brings up, and that profile differs in ways the recovery path could
# plausibly care about — `read_only: true`, a tmpfs `/tmp`, and `restart: unless-stopped`, which is a policy
# no gate-owned daemon has ever carried. **If the shipped appliance answers this fault by having Docker
# restart the container rather than by recovering in place, a soak fails at S5 of cycle 1** — and finding that
# out here costs minutes rather than a provider-facing attempt.
#
# IT IS THE LOCAL SEED ENTRY THROUGHOUT, so no provider is involved and none could be.
#
# AND IT MAKES NO TIMING CLAIM ANY DOCUMENT MAY CITE. The elapsed milliseconds are printed because a number
# nobody can see is a number nobody can act on; §11.6 of the contract governs what may be said about them,
# and what is ASSERTED here is the shape of the recovery, not its speed.
#
# AND ONE CONSUMER MUST HOLD AN OPEN DESCRIPTOR, WHICH IS THE DIFFERENCE BETWEEN REHEARSING S5 AND REHEARSING
# SOMETHING ELSE — measured here, the first time this step ran, rather than assumed.
#
# `umount -l` DETACHES THE MOUNT AND LEAVES THE FUSE SUPERBLOCK ALIVE ONLY WHILE SOMETHING REFERENCES IT.
# Phase 7's R1 relies on three REAL media servers to be that something: with them holding it, the serve loop
# never notices, the daemon observes a mount point that is no longer its own, and the RECOVERY SUPERVISOR is
# what acts — `recover-mount-underlay`, which is the assertion the arm turns on. This rehearsal's consumers
# are three `alpine` containers holding a bind and nothing else, so the first run of this step detached the
# superblock completely: the serve loop died, `--auto-remount` put it back in **1,192 ms**, and the recovery
# supervisor spent **zero** actions. Both are correct product behaviour and they are DIFFERENT MECHANISMS —
# and the one S5 measures is the second.
#
# SO A CONSUMER IS ASKED TO HOLD A FILE OPEN FIRST, which is what a media server holds while it is playing.
# Phase 6 §11.9 reached the same conclusion about the recovery gate's own injector, for the same reason.
C9_HOLD_SECONDS=180
docker exec -d "$JF_CONTAINER" sh -c "exec 9< \"/media/projection/$SEED_PATH\"; sleep $C9_HOLD_SECONDS" \
  >/dev/null 2>&1 || true
sleep 2
if docker exec "$JF_CONTAINER" sh -c "ls -l /proc/*/fd/9 2>/dev/null | grep -q projection"; then
  pass "C9 a consumer holds an OPEN DESCRIPTOR on a file inside the mount, which is what a media server holds \
while it is playing and what makes this S5's fault rather than a different one"
else
  fail "C9 no consumer holds an open descriptor, so the lazy detach below would tear the connection down and \
this step would measure --auto-remount instead of the recovery supervisor"
fi
C9_SERVE_DEATHS_BEFORE="$(docker logs "$ALPHA_CONTAINER" 2>&1 | grep -c 'serve loop died' || true)"
C9_ID_BEFORE="$(docker inspect -f '{{.Id}}' "$ALPHA_CONTAINER" 2>/dev/null || true)"
C9_RESTARTS_BEFORE="$(docker inspect -f '{{.RestartCount}}' "$ALPHA_CONTAINER" 2>/dev/null || echo x)"
C9_ACTIONS_BEFORE="$(docker logs "$ALPHA_CONTAINER" 2>&1 | grep -cE 'projectiond: recovery: recover-' || true)"
C9_LAYERS_BEFORE="$(count_our_layers)"
C9_STARTED="$(date +%s%3N)"
umount -l "$WORK/mnt" 2>/dev/null || true
C9_GONE=0
n=0
while [ "$n" -lt 40 ]; do
  if [ "$(count_our_layers)" -lt "$C9_LAYERS_BEFORE" ]; then C9_GONE=1; break; fi
  n=$(( n + 1 )); sleep 0.5
done
if [ "$C9_GONE" -eq 1 ]; then
  pass "C9 the fault landed: the appliance's own mount is no longer at the mount point and its process was \
never signalled"
else
  fail "C9 the fault did not land — the mount is still there, so nothing below measures a recovery"
fi
# THE SUPERVISOR IS WAITED FOR, RATHER THAN SAMPLED ONCE. Its own budget is a contract number and this is a
# rehearsal, so what is used here is a generous bound: a wait that ended early would report a supervisor that
# had not yet acted as one that never would.
C9_WAIT=0
while [ "$C9_WAIT" -lt 80 ]; do
  if [ "$(docker logs "$ALPHA_CONTAINER" 2>&1 | grep -cE 'projectiond: recovery: recover-' || true)" \
       -gt "$C9_ACTIONS_BEFORE" ]; then break; fi
  C9_WAIT=$(( C9_WAIT + 1 )); sleep 0.5
done
C9_READABLE=0
await_readable 240 && C9_READABLE=1
C9_READY_MS=$(( $(date +%s%3N) - C9_STARTED ))
C9_ACTIONS_AFTER="$(docker logs "$ALPHA_CONTAINER" 2>&1 | grep -cE 'projectiond: recovery: recover-' || true)"
C9_SERVE_DEATHS_AFTER="$(docker logs "$ALPHA_CONTAINER" 2>&1 | grep -c 'serve loop died' || true)"
C9_LAST="$(docker logs "$ALPHA_CONTAINER" 2>&1 | grep -oE 'projectiond: recovery: recover-[a-z-]+' | tail -1 || true)"
C9_ID_AFTER="$(docker inspect -f '{{.Id}}' "$ALPHA_CONTAINER" 2>/dev/null || true)"
C9_RESTARTS_AFTER="$(docker inspect -f '{{.RestartCount}}' "$ALPHA_CONTAINER" 2>/dev/null || echo y)"
if [ "$C9_READABLE" -eq 1 ]; then
  pass "C9 a sibling container reads a byte through the mount again after the fault (${C9_READY_MS} ms, \
which is an instrument reading and not a claim about the appliance)"
else
  fail "C9 the mount never became readable again ${C9_READY_MS} ms after the fault"
fi
# THE PART THE SHIPPED PROFILE PUT AT RISK, AND IT IS THE WHOLE REASON THIS STEP EXISTS.
if [ -n "$C9_ID_BEFORE" ] && [ "$C9_ID_BEFORE" = "$C9_ID_AFTER" ] \
   && [ "$C9_RESTARTS_BEFORE" = "$C9_RESTARTS_AFTER" ]; then
  # NO BACKTICKS IN THIS STRING, AND IT IS NOT A STYLE RULE. Inside a double-quoted shell string a backtick
  # opens a command substitution, so quoting the policy name the way the prose everywhere else does would
  # have this line try to EXECUTE it. `bash -n` cannot see that; a run would.
  pass "C9 the SAME container recovered IN PLACE: the appliance restart policy did not fire, because a lost \
mount is not a crash and the supervisor inside the process is what acts"
else
  fail "C9 the appliance container changed identity or was restarted by Docker across the fault \
(restartCount ${C9_RESTARTS_BEFORE} then ${C9_RESTARTS_AFTER}); the recovery a soak would measure would not \
be the one the contract names"
fi
C9_TAKEN=$(( C9_ACTIONS_AFTER - C9_ACTIONS_BEFORE ))
C9_DEATHS=$(( C9_SERVE_DEATHS_AFTER - C9_SERVE_DEATHS_BEFORE ))
if [ "$C9_TAKEN" -eq 1 ]; then
  pass "C9 the supervisor spent exactly ONE recovery action on one fault, which is single-flight (serve-loop \
deaths across the fault: $C9_DEATHS)"
else
  fail "C9 the supervisor started $C9_TAKEN recovery action(s) for one fault, with $C9_DEATHS serve-loop \
death(s) across it — a death here means the descriptor was not held and --auto-remount repaired it first, \
which is a DIFFERENT mechanism from the one S5 measures"
fi
if [ "$C9_LAST" = "projectiond: recovery: recover-mount-underlay" ]; then
  pass "C9 and the action it took is the one §8.4 predeclares for a mount removed beneath it: \
recover-mount-underlay"
else
  fail "C9 the action taken was '${C9_LAST:-none}', not recover-mount-underlay"
fi
# AND THE TOPOLOGY DID NOT GROW, which is §8.1's whole subject asked once at the point it is most at risk.
C9_AFTER_LAYERS="$(count_our_layers)"
if [ "$C9_AFTER_LAYERS" -eq $(( MOUNT_LAYER_FLOOR + 1 )) ]; then
  pass "C9 exactly one layer of ours above the floor after the recovery — the recovery did not stack"
else
  fail "C9 $C9_AFTER_LAYERS layer(s) of ours against a floor of $MOUNT_LAYER_FLOOR after the recovery"
fi
# THE LEDGER IS SPENT AND THE SHIPPED RESET IS WHAT CLEARS IT, which is also what leaves the appliance in the
# state C6 below expects rather than one carrying a used budget into a shutdown assertion.
alpha reset-recovery
if [ "$ALPHA_STATUS" -eq 0 ]; then
  pass "C9 the shipped reset-recovery cleared the budget the recovery spent"
else
  fail "C9 the shipped reset-recovery exited $ALPHA_STATUS after a real recovery"
fi
# AND THE HOLDER IS RELEASED, because an open descriptor left inside a consumer would block the shutdown C6
# is about and turn a safety assertion into a timeout.
docker exec "$JF_CONTAINER" sh -c "pkill -f 'sleep $C9_HOLD_SECONDS'" >/dev/null 2>&1 || true
sleep 1

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
