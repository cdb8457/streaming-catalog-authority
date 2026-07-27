#!/usr/bin/env bash
# Catalog Authority — Phases 266-268 Jellyfin control plane acceptance orchestrator.
#
# WHAT THIS PROVES THAT NOTHING ELSE DOES. The unit suites drive the modules against injected transports and
# an embedded database. This drives the SHIPPED PRODUCT: the release bundle, extracted; the production image;
# the migration one-shot; the operator token; a real Chromium; and a real media server on the other end of a
# real network. A break anywhere across that path — a route not wired, a switch not read, a panel that does
# not render, a secret file not mounted, a schema not migrated — is invisible to every test above.
#
# THE MEDIA SERVER IS A LOCAL FAKE, ALWAYS. `deploy/ci/acceptance/fake-jellyfin/server.mjs`, on the Compose
# network, publishing no host port, holding nothing real, thrown away with the stack. Nothing here contacts a
# provider, a real Jellyfin, an Unraid host, a media path or any endpoint beyond 127.0.0.1 and this stack's
# own network.
#
# IT IS AN ACCEPTANCE GATE, NOT A PUBLISH STEP. It builds an image with a local-only tag, never logs in to a
# registry, never pushes, never tags, never uploads a release asset.
#
# WHAT IT ESTABLISHES, IN ORDER:
#   1. DISABLED IS THE DEFAULT. The shipped stack, with no override, contacts nothing and says so.
#   2. READ-ONLY DISCOVERY. With networking on, it counts and names no media item.
#   3. ZERO-WRITE PREVIEW. A plan is computed and no row, event, ledger row or external request appears.
#   4. WRITES STAY REFUSED until the separate switch is on, even with a correct digest.
#   5. EXPLICIT QUEUE. With the switch on, the exact digest queues durable intents and sends nothing.
#   6. DURABLE EXECUTION. A reconcile pass creates the collections on the fake server.
#   7. AMBIGUOUS RECOVERY. A create whose response is LOST is adopted by token, with no duplicate.
#   8. IDEMPOTENCY. A second reconcile does nothing at all.
#   9. REVOKE. A forgotten record's external copy comes back.
#  10. RESTART PERSISTENCE. Everything survives a full stop/start.
#  11. BROWSER-ONLY VIEWING WRITES NOTHING, in the database or on the media server.
#
# PREREQUISITES: a running Docker daemon, `node`, and the pinned acceptance harness in deploy/ci/acceptance/.
# FAIL vs SKIP is explicit and identical to Phases 248 and 262:
#   * REQUIRE_ACCEPTANCE=1 (what CI sets) -> a missing prerequisite is a hard FAILURE (exit 1).
#   * otherwise (a developer laptop)      -> a SKIP (exit 3) that says the leg is CI-required and was NOT run.
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"

REQUIRE_ACCEPTANCE="${REQUIRE_ACCEPTANCE:-0}"
LOCAL_IMAGE="${CATALOG_AUTHORITY_JELLYFIN_IMAGE:-catalog-authority-ops:jellyfin-acceptance}"
HOST_PORT="${JELLYFIN_ACCEPTANCE_PORT:-8097}"
BASE_URL="http://127.0.0.1:${HOST_PORT}"
export COMPOSE_PROJECT_NAME="${JELLYFIN_ACCEPTANCE_PROJECT:-catalogauthority-jellyfinacceptance}"

ARTIFACT_DIR="${JF_ARTIFACT_DIR:-${REPO_ROOT}/dist/jellyfin-acceptance-artifacts}"
STAGING_DIR="${JF_STAGING_DIR:-${REPO_ROOT}/dist/jellyfin-acceptance-staging}"
BUNDLE_DIR="${REPO_ROOT}/dist/jellyfin-acceptance-bundle"
ARCHIVE_DIR="${REPO_ROOT}/dist/jellyfin-acceptance-archive"
BROWSER_DIR="${REPO_ROOT}/deploy/ci/acceptance"
FIXTURE="${BROWSER_DIR}/fixtures/jellyfin-acceptance-snapshot.json"
OVERRIDE="${BROWSER_DIR}/docker-compose.jellyfin-fake.yml"
EXTRACTED=""
RC_COMPOSE_ATTEMPTED=0
TOKEN=""
JELLYFIN_KEY=""

# The provider reference value planted in the snapshot. The whole point of the disclosure boundary is that
# this string reaches the database and the fake server's own fixture list, and NOTHING else — not a browser,
# not an API body, not a log line.
SECRET_REF="tt-jellyfin-acceptance-ref-1"
RECORD_COUNT=4
# Records the plan selects (the three named "Acceptance Collection ..."), of which two carry a reference the
# fake server can match and one does not.
PLAN_CREATES=2

# shellcheck source=deploy/ci/acceptance/rc-teardown.sh
source "${BROWSER_DIR}/rc-teardown.sh"

step() { printf '\n==> %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# A count that fails to be READ must never look like a count that did not CHANGE: two unreadable counts
# compare equal to each other, which would turn "previewing wrote nothing" into a vacuous pass. Every counter
# refuses to return anything that is not a bare number, and refusing exits the run. Defined before the first
# executable line so no step added later can land above it.
digits_or_die() {
  case "${1}" in
    ''|*[!0-9]*) echo "FAIL: ${2} did not return a number — the measurement failed, so nothing may be concluded from it" >&2; exit 1 ;;
  esac
  printf '%s' "${1}"
}

skip() {
  if [ "${REQUIRE_ACCEPTANCE}" = "1" ]; then
    fail "$1 (REQUIRE_ACCEPTANCE=1 — a CI runner that cannot run this is broken, not passing)"
  fi
  echo
  echo "SKIP: ${1}."
  echo "      The Jellyfin control plane acceptance was NOT executed here."
  echo "      It is CI-required and runs on Linux with a Docker daemon. Run it locally with:"
  echo "        REQUIRE_ACCEPTANCE=1 bash deploy/ci/jellyfin-control-acceptance.sh"
  echo "      once Docker is running, or rely on the CI job 'jellyfin-acceptance'."
  exit 3
}

# The compose invocation for this stack: the bundle's own file PLUS the acceptance override. Every call goes
# through here so the override can never be forgotten on one of them — a stack brought up without it would
# have no fake server and would silently prove nothing.
jf_compose() {
  ( cd "${EXTRACTED}" && docker compose -f docker-compose.yml -f docker-compose.jellyfin-fake.yml "$@" )
}

# ---------------------------------------------------------------------------------------------------------
# Teardown: ALWAYS runs, removes only what this project created, never masks the real failure.
# ---------------------------------------------------------------------------------------------------------
cleanup() {
  local code=$?
  step "teardown (always)"
  if [ "${RC_COMPOSE_ATTEMPTED}" = "1" ] && [ -n "${EXTRACTED}" ] && [ -d "${EXTRACTED}" ]; then
    jf_compose down -v --remove-orphans >/dev/null 2>&1 || true
    info "compose stack torn down (down -v), volumes removed"
  fi
  docker image rm -f "${LOCAL_IMAGE}" >/dev/null 2>&1 || true

  # Gate then PROMOTE. The upload directory is populated ONLY from staging that passed the redaction gate, so
  # a gate failure — or a kill before the gate ran — leaves it empty rather than merely scrubbed.
  if [ -d "${STAGING_DIR}" ] && [ -n "${TOKEN}" ] && [ -f "${BROWSER_DIR}/redact-artifacts.sh" ]; then
    if OPERATOR_UI_ACCEPTANCE_TOKEN="${TOKEN}" bash "${BROWSER_DIR}/redact-artifacts.sh" "${STAGING_DIR}"; then
      mkdir -p "${ARTIFACT_DIR}"
      ( shopt -s dotglob nullglob; mv "${STAGING_DIR}"/* "${ARTIFACT_DIR}/" 2>/dev/null ) || true
      info "acceptance artifacts passed redaction and were promoted for upload"
    else
      echo "artifact redaction gate failed — quarantining all acceptance artifacts, nothing will be uploaded" >&2
      rm -rf "${ARTIFACT_DIR}"
      [ "${code}" = "0" ] && code=1
    fi
  fi

  if [ -n "${EXTRACTED}" ] && [ -d "${EXTRACTED}" ]; then rm -rf "${EXTRACTED}"; fi
  rm -rf "${STAGING_DIR}" "${BUNDLE_DIR}" "${ARCHIVE_DIR}" 2>/dev/null || true
  info "temporary bundle, staging and extraction directories removed"
  exit "${code}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------------------------------------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------------------------------------
step "prerequisites"
command -v node >/dev/null 2>&1 || skip "node is not installed"
command -v docker >/dev/null 2>&1 || skip "the docker CLI is not installed"
docker info >/dev/null 2>&1 || skip "the Docker daemon is not reachable"
[ -f "${BROWSER_DIR}/jellyfin.spec.mjs" ] || fail "the Jellyfin acceptance spec is missing at ${BROWSER_DIR}"
[ -f "${FIXTURE}" ] || fail "the acceptance snapshot fixture is missing at ${FIXTURE}"
[ -f "${OVERRIDE}" ] || fail "the fake-Jellyfin compose override is missing at ${OVERRIDE}"
[ -f "${BROWSER_DIR}/fake-jellyfin/server.mjs" ] || fail "the fake Jellyfin server is missing"
if [ ! -d "${BROWSER_DIR}/node_modules/@playwright/test" ]; then
  skip "the pinned browser harness is not installed (run: npm --prefix deploy/ci/acceptance ci && npx --prefix deploy/ci/acceptance playwright install --with-deps chromium)"
fi
info "docker daemon reachable, node present, pinned Playwright harness present"

rm -rf "${STAGING_DIR}" "${ARTIFACT_DIR}"
mkdir -p "${STAGING_DIR}"

# ---------------------------------------------------------------------------------------------------------
# 1. Assemble the exact consumer release bundle and extract it standalone.
# ---------------------------------------------------------------------------------------------------------
step "assemble the consumer release bundle and extract it"
rm -rf "${BUNDLE_DIR}" "${ARCHIVE_DIR}"
node --import tsx src/ops/consumer-release-bundle-cli.ts --out "${BUNDLE_DIR}" --archive-dir "${ARCHIVE_DIR}" >/dev/null
ARCHIVE_PATH="$(ls "${ARCHIVE_DIR}"/*.tar.gz)"
RC_VERSION="$(grep '^version: ' "${BUNDLE_DIR}/VERSION" | cut -d' ' -f2-)"
RC_REVISION="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
[ -n "${RC_VERSION}" ] || fail "the assembled bundle declared no version"
EXTRACTED="$(mktemp -d)"
tar -xzf "${ARCHIVE_PATH}" -C "${EXTRACTED}"
roots="$(ls "${EXTRACTED}")"
[ "$(printf '%s\n' "${roots}" | wc -l)" -eq 1 ] || fail "the archive did not extract into a single directory: ${roots}"
EXTRACTED="${EXTRACTED}/${roots}"
info "extracted ${RC_VERSION} standalone to a directory named ${roots}"

# THE SHIPPED BUNDLE MUST CARRY NO JELLYFIN WIRING AT ALL. Everything below is an OVERRIDE this script adds;
# what a consumer downloads has the switches off and no address configured, and that is asserted here rather
# than assumed — a bundle that shipped a pre-configured media server would be a very different product.
step "the shipped bundle wires no media server and turns no switch on"
if grep -RIl 'JELLYFIN_' "${EXTRACTED}" >/dev/null 2>&1; then
  grep -RIn 'JELLYFIN_' "${EXTRACTED}" >&2 || true
  fail "the shipped release bundle mentions JELLYFIN_ configuration — it must ship with none"
fi
info "the shipped bundle names no JELLYFIN_ setting anywhere"

# ---------------------------------------------------------------------------------------------------------
# 2. Build the production image LOCALLY with a local-only tag. Never pushed, never a release.
# ---------------------------------------------------------------------------------------------------------
step "build the production image locally (local-only tag, never published)"
docker build --file Dockerfile.runtime --tag "${LOCAL_IMAGE}" \
  --build-arg "IMAGE_VERSION=${RC_VERSION}" --build-arg "IMAGE_REVISION=${RC_REVISION}" . >/dev/null
info "built ${LOCAL_IMAGE}"

step "pin the extracted stack to the local image, on its own loopback port"
tmp_env="$(mktemp)"
grep -v -e '^CATALOG_AUTHORITY_IMAGE=' -e '^OPERATOR_UI_HOST_PORT=' "${EXTRACTED}/.env" > "${tmp_env}"
printf 'CATALOG_AUTHORITY_IMAGE=%s\n' "${LOCAL_IMAGE}" >> "${tmp_env}"
printf 'OPERATOR_UI_HOST_PORT=%s\n' "${HOST_PORT}" >> "${tmp_env}"
mv "${tmp_env}" "${EXTRACTED}/.env"
info "extracted .env points at ${LOCAL_IMAGE} on 127.0.0.1:${HOST_PORT}"

# ---------------------------------------------------------------------------------------------------------
# 3. Secrets, the snapshot, and the acceptance override.
# ---------------------------------------------------------------------------------------------------------
step "generate secrets in the extracted directory (no secret is ever printed)"
( cd "${EXTRACTED}" && bash ./setup.sh >/dev/null 2>&1 ) || fail "the bundle's setup.sh failed"
TOKEN_FILE="${EXTRACTED}/secrets/operator_ui_token"
[ -s "${TOKEN_FILE}" ] || fail "setup.sh did not create an operator token"
TOKEN="$(cat "${TOKEN_FILE}")"
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::${TOKEN}"; fi

# The Jellyfin API key is generated HERE and written as a FILE, because the control plane refuses an inline
# one. It is masked in CI exactly like the operator token.
JELLYFIN_KEY="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')"
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::${JELLYFIN_KEY}"; fi
printf '%s\n' "${JELLYFIN_KEY}" > "${EXTRACTED}/secrets/jellyfin_api_key"
chmod 600 "${EXTRACTED}/secrets/jellyfin_api_key"
info "secrets generated; operator token and Jellyfin API key written to files and masked"

step "place the offline snapshot in the shipped read-only import folder"
mkdir -p "${EXTRACTED}/import"
cp "${FIXTURE}" "${EXTRACTED}/import/jellyfin-acceptance-snapshot.json"
info "snapshot (${RECORD_COUNT} records) placed in ./import/"

# ---------------------------------------------------------------------------------------------------------
# 4. LEG ZERO — the SHIPPED stack, with no override at all. Nothing may be contacted.
# ---------------------------------------------------------------------------------------------------------
step "start the SHIPPED stack with no Jellyfin wiring at all"
RC_COMPOSE_ATTEMPTED=1
( cd "${EXTRACTED}" && docker compose up -d >/dev/null )

wait_for_health() {
  healthy=""
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "${BASE_URL}/healthz"; then healthy=yes; break; fi
    sleep 2
  done
  if [ -z "${healthy}" ]; then
    echo "the stack never became healthy; diagnostics follow:" >&2
    ( cd "${EXTRACTED}" && docker compose ps && docker compose logs --tail 120 ) >&2 || true
    fail "${1}"
  fi
}
wait_for_health "/healthz never returned 200 within the bounded wait"
info "/healthz is 200 — the migration one-shot completed and the app started behind it"

api() { curl -sS -H "x-operator-ui-secret: ${TOKEN}" "${BASE_URL}$1"; }
api_field() {
  local raw
  raw="$(api "$1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const r=JSON.parse(s);const v=$2;process.stdout.write(String(v))}catch(e){process.stdout.write('UNREADABLE')}})")"
  printf '%s' "${raw}"
}

step "with no configuration, the control plane is DISABLED and contacts nothing"
[ "$(api_field /api/jellyfin/status 'r.connection.networkEnabled')" = "false" ] || fail "networking is not off by default"
[ "$(api_field /api/jellyfin/status 'r.contacted')" = "nothing" ] || fail "the status route claims to have contacted something"
[ "$(api_field /api/jellyfin/discovery 'r.state')" = "DISABLED" ] || fail "discovery is not DISABLED by default"
[ "$(api_field /api/jellyfin/discovery 'r.contacted')" = "nothing" ] || fail "discovery claims to have contacted something"
[ "$(api_field /api/collections/status 'r.writesEnabled')" = "false" ] || fail "writes are not off by default"
info "a shipped installation with no configuration reports DISABLED and contacted nothing"

# ---------------------------------------------------------------------------------------------------------
# 5. Import the catalog, then bring the stack up WITH the fake server and the read-only switches.
# ---------------------------------------------------------------------------------------------------------
step "import the snapshot from the command line"
import_out="$( cd "${EXTRACTED}" && docker compose exec -T app npm run ops:catalog-import -- --file jellyfin-acceptance-snapshot.json --apply )" \
  || fail "the import exited non-zero"
printf '%s\n' "${import_out}" | grep -qE "^ +create +${RECORD_COUNT}$" || fail "the import did not create ${RECORD_COUNT} records"
if printf '%s\n' "${import_out}" | grep -qF "${SECRET_REF}"; then fail "the import report echoed a provider reference value"; fi
info "imported ${RECORD_COUNT} records"

step "restart the stack WITH the local fake Jellyfin, networking on and writes OFF"
cp "${OVERRIDE}" "${EXTRACTED}/docker-compose.jellyfin-fake.yml"
mkdir -p "${EXTRACTED}/fake-jellyfin"
cp "${BROWSER_DIR}/fake-jellyfin/server.mjs" "${EXTRACTED}/fake-jellyfin/server.mjs"
( cd "${EXTRACTED}" && docker compose down >/dev/null 2>&1 ) || true
JELLYFIN_ALLOW_COLLECTION_WRITES=false PUBLISH_EXTERNAL_IDENTITY=deny jf_compose up -d >/dev/null
wait_for_health "the stack did not become healthy with the fake Jellyfin attached"
info "the stack is up with a fake Jellyfin on the compose network and no host port"

count_rows() {
  local raw
  raw="$( jf_compose exec -T postgres psql -U postgres -d catalog -tAc "SELECT count(*) FROM ${1}" | tr -d '[:space:]' )"
  digits_or_die "${raw}" "the row count for ${1}"
}
# What the fake server holds, read from inside the fake container itself (it publishes no host port).
# This measurement must not depend on the app container's DNS being ready in the same instant Compose reports
# both containers started; the product's own discovery request below is the end-to-end DNS/network proof.
fake_collection_count() {
  local raw
  raw="$( jf_compose exec -T jellyfin-fake node -e "fetch('http://127.0.0.1:8096/_control/state').then(r=>r.json()).then(s=>process.stdout.write(String(s.collections.length)))" | tr -d '[:space:]' )"
  digits_or_die "${raw}" "the fake server collection count"
}

items_before="$(count_rows items)"
events_before="$(count_rows events)"
ledger_before="$(count_rows publish_ledger)"
[ "${ledger_before}" = "0" ] || fail "a fresh installation already has ${ledger_before} publish ledger rows"
[ "$(fake_collection_count)" = "0" ] || fail "the fake media server already holds collections"
info "baseline: ${items_before} items, ${events_before} events, 0 ledger rows, 0 external collections"

# ---------------------------------------------------------------------------------------------------------
# 6. The browser legs. Each is run the same way, so a new one cannot be wired differently by accident.
# ---------------------------------------------------------------------------------------------------------
run_leg() {
  local tag="$1" label="$2"
  mkdir -p "${STAGING_DIR}/${label}"
  set +e
  OPERATOR_UI_ACCEPTANCE_TOKEN="${TOKEN}" \
  OPERATOR_UI_ACCEPTANCE_BASE_URL="${BASE_URL}" \
  CATALOG_ACCEPTANCE_SECRET_REF="${SECRET_REF}" \
  PLAYWRIGHT_ARTIFACT_DIR="${STAGING_DIR}/${label}" \
    npx --prefix "${BROWSER_DIR}" playwright test \
      --config "${BROWSER_DIR}/jellyfin.playwright.config.mjs" --grep "${tag}"
  LEG_STATUS=$?
  set -e
  # The test COUNT is read whatever the outcome: a leg that ran zero tests is not a leg that passed.
  local report="${STAGING_DIR}/${label}/report.json"
  [ -f "${report}" ] || fail "the ${label} browser leg wrote no report — it cannot be said to have run"
  local expected
  expected="$( node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);process.stdout.write(String((r.stats&&r.stats.expected)||0))})' < "${report}" )"
  expected="$(digits_or_die "${expected}" "the ${label} browser leg test count")"
  [ "${expected}" -ge 1 ] || fail "the ${label} browser leg ran 0 tests — a filter matched nothing, which is not a pass"
  info "${label} browser leg ran ${expected} test(s)"
}

dump_stack_logs() {
  echo "--- stack logs (secrets removed), last 150 lines ---" >&2
  jf_compose logs --no-color 2>&1 \
    | CAT_TOKEN="${TOKEN}" CAT_KEY="${JELLYFIN_KEY}" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let o=s;for(const k of [process.env.CAT_TOKEN,process.env.CAT_KEY])if(k)o=o.split(k).join("<redacted>");process.stdout.write(o)})' \
    | tail -150 >&2 || true
  echo "--- end stack logs ---" >&2
}

step "real-browser acceptance: the panel, read-only discovery, and a zero-write preview"
run_leg "@jf-disabled" "disabled"
[ "${LEG_STATUS}" -eq 0 ] || { dump_stack_logs; fail "the disabled-state browser leg reported failures"; }
run_leg "@jf-discovery" "discovery"
[ "${LEG_STATUS}" -eq 0 ] || { dump_stack_logs; fail "the discovery browser leg reported failures"; }
run_leg "@jf-plan" "plan"
[ "${LEG_STATUS}" -eq 0 ] || { dump_stack_logs; fail "the plan browser leg reported failures"; }
run_leg "@jf-refused" "refused"
[ "${LEG_STATUS}" -eq 0 ] || { dump_stack_logs; fail "the refused-write browser leg reported failures"; }

step "discovery and planning wrote NO row, NO event and NO ledger entry, and created nothing externally"
[ "$(count_rows items)" = "${items_before}" ] || fail "discovery or planning created a record"
[ "$(count_rows events)" = "${events_before}" ] || fail "discovery or planning appended an event"
[ "$(count_rows publish_ledger)" = "0" ] || fail "discovery or planning queued an intent"
[ "$(fake_collection_count)" = "0" ] || fail "discovery or planning created a collection on the media server"
# The PLAN history is the one thing that grows, and it grows on purpose.
plans_recorded="$(count_rows collection_control_history)"
[ "${plans_recorded}" -ge 1 ] || fail "no plan preview was recorded in the durable history"
info "no row, event, ledger entry or external collection; ${plans_recorded} preview(s) recorded"

# ---------------------------------------------------------------------------------------------------------
# 7. Turn the write switches on, and queue the exact plan from the browser.
# ---------------------------------------------------------------------------------------------------------
step "restart with the collection-write switch and publish consent ON"
JELLYFIN_ALLOW_COLLECTION_WRITES=true PUBLISH_EXTERNAL_IDENTITY=allow jf_compose up -d >/dev/null
wait_for_health "the stack did not become healthy with writes enabled"
[ "$(api_field /api/collections/status 'r.writesEnabled')" = "true" ] || fail "writes are still refused after turning the switches on"
info "all four switches are on for this run"

step "real-browser acceptance: queue the exact plan by typing its own digest"
run_leg "@jf-queue" "queue"
[ "${LEG_STATUS}" -eq 0 ] || { dump_stack_logs; fail "the queue browser leg reported failures"; }
queued_rows="$(count_rows publish_ledger)"
[ "${queued_rows}" = "${PLAN_CREATES}" ] || fail "expected ${PLAN_CREATES} queued intents, got ${queued_rows}"
[ "$(fake_collection_count)" = "0" ] || fail "queuing sent something to the media server — it must only write durable intents"
info "queued ${queued_rows} durable intents and sent nothing"

# ---------------------------------------------------------------------------------------------------------
# 8. AMBIGUOUS RECOVERY, then the ordinary reconcile. The lost response comes FIRST, deliberately.
# ---------------------------------------------------------------------------------------------------------
step "make the next create lose its response, then reconcile"
jf_compose exec -T jellyfin-fake node -e "fetch('http://127.0.0.1:8096/_control/lose-next-create',{method:'POST'}).then(()=>process.exit(0))" >/dev/null \
  || fail "could not arm the lost-response case on the fake server"
first_json="$(curl -sS -X POST -H "x-operator-ui-secret: ${TOKEN}" -H 'content-type: application/json' -d '{}' "${BASE_URL}/api/collections/reconcile")"
printf '%s' "${first_json}" | grep -q '"code":"OPERATOR_UI_COLLECTION_RECONCILED"' \
  || { echo "${first_json}" >&2; dump_stack_logs; fail "the first reconcile did not run"; }
after_first="$(fake_collection_count)"
[ "${after_first}" -ge 1 ] || fail "the fake server created nothing, so the lost-response case was not exercised"
info "the first pass left ${after_first} collection(s) on the server, at least one of them un-adopted"

step "the recovery pass adopts the lost artifact BY ITS TOKEN, and creates no duplicate"
second_json="$(curl -sS -X POST -H "x-operator-ui-secret: ${TOKEN}" -H 'content-type: application/json' -d '{}' "${BASE_URL}/api/collections/reconcile")"
printf '%s' "${second_json}" | grep -q '"code":"OPERATOR_UI_COLLECTION_RECONCILED"' \
  || { echo "${second_json}" >&2; dump_stack_logs; fail "the recovery reconcile did not run"; }
external_total="$(fake_collection_count)"
[ "${external_total}" = "${PLAN_CREATES}" ] \
  || { echo "${second_json}" >&2; dump_stack_logs; fail "expected exactly ${PLAN_CREATES} external collections, got ${external_total} — a lost response produced a duplicate"; }
published="$( jf_compose exec -T postgres psql -U postgres -d catalog -tAc "SELECT count(*) FROM publish_ledger WHERE status = 'published'" | tr -d '[:space:]' )"
[ "$(digits_or_die "${published}" "the published intent count")" = "${PLAN_CREATES}" ] || fail "not every intent settled as published"
info "exactly ${external_total} external collections exist and ${published} intents are published — no duplicate"

step "IDEMPOTENCY: a third reconcile does nothing at all"
third_json="$(curl -sS -X POST -H "x-operator-ui-secret: ${TOKEN}" -H 'content-type: application/json' -d '{}' "${BASE_URL}/api/collections/reconcile")"
printf '%s' "${third_json}" | grep -q '"created":0' || { echo "${third_json}" >&2; fail "a repeat reconcile created something"; }
printf '%s' "${third_json}" | grep -q '"adopted":0' || { echo "${third_json}" >&2; fail "a repeat reconcile adopted something"; }
[ "$(fake_collection_count)" = "${PLAN_CREATES}" ] || fail "a repeat reconcile changed the media server"
info "a repeat reconcile created nothing, adopted nothing and changed nothing"

step "real-browser acceptance: driving a reconcile from the panel is also a no-op once everything is settled"
run_leg "@jf-reconcile" "reconcile"
[ "${LEG_STATUS}" -eq 0 ] || { dump_stack_logs; fail "the reconcile browser leg reported failures"; }
[ "$(fake_collection_count)" = "${PLAN_CREATES}" ] || fail "the browser reconcile changed the media server"

# ---------------------------------------------------------------------------------------------------------
# 9. RESTART PERSISTENCE.
# ---------------------------------------------------------------------------------------------------------
step "restart the whole stack and re-check (persistence)"
history_before_restart="$(count_rows collection_control_history)"
jf_compose stop >/dev/null
JELLYFIN_ALLOW_COLLECTION_WRITES=true PUBLISH_EXTERNAL_IDENTITY=allow jf_compose up -d >/dev/null
wait_for_health "the stack did not come back healthy after a restart"
[ "$(count_rows publish_ledger)" = "${PLAN_CREATES}" ] || fail "the queued work did not survive a restart"
[ "$(count_rows collection_control_history)" = "${history_before_restart}" ] || fail "the plan history did not survive a restart"
[ "$(count_rows items)" = "${items_before}" ] || fail "the catalog did not survive a restart"
info "the ledger, the plan history and the catalog all survived a full stop/start"

step "real-browser acceptance: the history is still there after the restart"
run_leg "@jf-history" "history"
history_status="${LEG_STATUS}"
if [ "${history_status}" -ne 0 ]; then dump_stack_logs; fi

# ---------------------------------------------------------------------------------------------------------
# 10. REVOKE: an erasure reaches outside.
# ---------------------------------------------------------------------------------------------------------
step "forget a published record, and prove its external copy comes back"
forget_id="$( jf_compose exec -T postgres psql -U postgres -d catalog -tAc "SELECT item_id FROM publish_ledger WHERE status = 'published' ORDER BY id LIMIT 1" | tr -d '[:space:]' )"
[ -n "${forget_id}" ] || fail "there is no published row to forget"
# `cat_forget_begin` is the first half of an erasure: it marks the record forgotten and starts the shred. That
# is exactly the state that must compel an external copy to come back, and driving it directly is honest —
# this gate is about what the CONTROL PLANE does about an erasure, not about the erasure machinery itself,
# which Phase 2's own suites cover.
jf_compose exec -T postgres psql -U postgres -d catalog -c "SELECT cat_forget_begin('${forget_id}')" >/dev/null \
  || fail "could not begin forgetting the record"
revoke_json="$(curl -sS -X POST -H "x-operator-ui-secret: ${TOKEN}" -H 'content-type: application/json' -d '{}' "${BASE_URL}/api/collections/revoke")"
printf '%s' "${revoke_json}" | grep -q '"code":"OPERATOR_UI_COLLECTION_REVOKED"' \
  || { echo "${revoke_json}" >&2; dump_stack_logs; fail "the revoke pass did not run"; }
remaining="$(fake_collection_count)"
[ "${remaining}" -lt "${PLAN_CREATES}" ] \
  || { echo "${revoke_json}" >&2; dump_stack_logs; fail "the forgotten record's external copy is still on the media server"; }
info "the forgotten record's external copy was removed; ${remaining} collection(s) remain"

# ---------------------------------------------------------------------------------------------------------
# 11. BROWSER-ONLY VIEWING CHANGES NOTHING, in the database or on the media server.
# ---------------------------------------------------------------------------------------------------------
step "a whole viewing session writes no row, no event, no ledger entry and no external collection"
items_v="$(count_rows items)"
events_v="$(count_rows events)"
ledger_v="$(count_rows publish_ledger)"
history_v="$(count_rows collection_control_history)"
external_v="$(fake_collection_count)"
for path in / /api/jellyfin/status /api/jellyfin/discovery /api/collections/status /api/collections/history /api/catalog /api/logs /api/status; do
  curl -fsS -o /dev/null -H "x-operator-ui-secret: ${TOKEN}" "${BASE_URL}${path}" || true
done
run_leg "@jf-discovery" "viewing"
[ "${LEG_STATUS}" -eq 0 ] || { dump_stack_logs; fail "the viewing browser leg reported failures"; }
[ "$(count_rows items)" = "${items_v}" ] || fail "viewing created a record"
[ "$(count_rows events)" = "${events_v}" ] || fail "viewing appended an event"
[ "$(count_rows publish_ledger)" = "${ledger_v}" ] || fail "viewing queued an intent"
[ "$(count_rows collection_control_history)" = "${history_v}" ] || fail "viewing wrote a plan history row"
[ "$(fake_collection_count)" = "${external_v}" ] || fail "viewing changed the media server"
info "an entire viewing session changed nothing, anywhere"

# ---------------------------------------------------------------------------------------------------------
# 12. Nothing disclosed a secret or a reference value, anywhere.
# ---------------------------------------------------------------------------------------------------------
step "logs and API responses carry no secret, no reference value and no Jellyfin id"
jf_compose logs --no-color > "${STAGING_DIR}/server-logs.txt" 2>&1 || true
for forbidden in "${TOKEN}" "${JELLYFIN_KEY}" "${SECRET_REF}" 'jf-item-' 'jf-col-' 'Acceptance Collection One'; do
  if grep -qF "${forbidden}" "${STAGING_DIR}/server-logs.txt"; then
    rm -f "${STAGING_DIR}/server-logs.txt"
    fail "the stack logs disclosed something they must not"
  fi
done
rm -f "${STAGING_DIR}/server-logs.txt"
for path in /api/jellyfin/status /api/jellyfin/discovery /api/collections/status /api/collections/history; do
  body="$(api "${path}")"
  for forbidden in "${TOKEN}" "${JELLYFIN_KEY}" "${SECRET_REF}" 'jellyfin-fake' 'jf-item-' 'jf-col-' 'fake-server-id' 'Somebody elses'; do
    case "${body}" in *"${forbidden}"*) fail "${path} disclosed something it must not";; esac
  done
done
info "no secret, address, reference value or Jellyfin id in any log line or response"

[ "${history_status}" -eq 0 ] || fail "the history acceptance leg reported failures (sanitized diagnostics will be in ${ARTIFACT_DIR})"

printf '\nJellyfin control plane acceptance: PASS (version %s, %s records, %s external collections)\n' \
  "${RC_VERSION}" "${RECORD_COUNT}" "${external_total}"
