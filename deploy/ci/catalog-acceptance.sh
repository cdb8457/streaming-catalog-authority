#!/usr/bin/env bash
# Catalog Authority — Phase 262 catalog import-and-browse acceptance orchestrator.
#
# WHAT THIS PROVES THAT NOTHING ELSE DOES. Phase 248 proves the release starts and its diagnostics page works
# in a real browser. Phase 259 proves the import CLI is correct against an embedded database, from source.
# Phase 260 proves the catalog panel is correct against a fake DOM and an HTTP server started from source.
# None of them exercises what an operator actually does with the shipped product: extract the release, start
# it, drop a snapshot file into the folder the README names, run the two commands the page prints, and browse
# their own catalog in a browser. That path crosses the image, the read-only import mount, the migration
# one-shot, the operator token and the browser at once, and a break anywhere in it is invisible to every test
# above.
#
# It is an ACCEPTANCE gate, not a publish step. It builds an image with a local-only tag, never logs in to a
# registry, never pushes, never tags, never uploads a release asset.
#
# ISOLATION. Its own disposable Compose project name, its own loopback port and its own image tag, so it
# shares nothing with the Phase 248 stack and the two can run on one machine without colliding. Everything it
# creates is removed on every exit path, including the volumes.
#
# FIXTURES ARE LOCAL AND DETERMINISTIC. The snapshot is a file in this repository. Nothing here contacts a
# provider, a media server, a library or any network endpoint beyond 127.0.0.1.
#
# PREREQUISITES: a running Docker daemon, `node`, and the pinned acceptance harness in deploy/ci/acceptance/.
# FAIL vs SKIP is explicit and identical to Phase 248:
#   * REQUIRE_ACCEPTANCE=1 (what CI sets) -> a missing prerequisite is a hard FAILURE (exit 1). A runner that
#     cannot run this is broken, not passing.
#   * otherwise (a developer laptop)      -> a SKIP (exit 3) that says the leg is CI-required and was NOT run.
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"

REQUIRE_ACCEPTANCE="${REQUIRE_ACCEPTANCE:-0}"
LOCAL_IMAGE="${CATALOG_AUTHORITY_CATALOG_IMAGE:-catalog-authority-ops:catalog-acceptance}"
HOST_PORT="${CATALOG_ACCEPTANCE_PORT:-8098}"
BASE_URL="http://127.0.0.1:${HOST_PORT}"
# A project name of its own: the shipped compose file declares `name: catalogauthority-local`, and
# COMPOSE_PROJECT_NAME takes precedence over it, so this stack can never be confused with — or torn down
# alongside — the Phase 248 one.
export COMPOSE_PROJECT_NAME="${CATALOG_ACCEPTANCE_PROJECT:-catalogauthority-catalogacceptance}"

ARTIFACT_DIR="${CAT_ARTIFACT_DIR:-${REPO_ROOT}/dist/catalog-acceptance-artifacts}"
STAGING_DIR="${CAT_STAGING_DIR:-${REPO_ROOT}/dist/catalog-acceptance-staging}"
BUNDLE_DIR="${REPO_ROOT}/dist/catalog-acceptance-bundle"
ARCHIVE_DIR="${REPO_ROOT}/dist/catalog-acceptance-archive"
BROWSER_DIR="${REPO_ROOT}/deploy/ci/acceptance"
FIXTURE="${BROWSER_DIR}/fixtures/catalog-acceptance-snapshot.json"
EXTRACTED=""
RC_COMPOSE_ATTEMPTED=0
TOKEN=""

# The value planted in the snapshot as a provider reference. The whole point of the disclosure boundary is
# that this string reaches the database and NOTHING else — not the browser, not an API body, not a log line.
SECRET_REF="tt-acceptance-ref-value-must-never-be-shown"
RECORD_COUNT=28

# shellcheck source=deploy/ci/acceptance/rc-teardown.sh
source "${BROWSER_DIR}/rc-teardown.sh"

step() { printf '\n==> %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# A count that fails to be READ must never look like a count that did not CHANGE. Two unreadable counts
# compare equal to each other, so a broken psql would turn "browsing wrote nothing" into a vacuous pass —
# the exact shape of dishonest evidence this whole phase exists to avoid. Every counter therefore refuses to
# return anything that is not a bare number, and refusing exits the run.
#
# DEFINED HERE, WITH THE OTHER TINY HELPERS, RATHER THAN BESIDE THE COUNTERS THAT USE IT. It used to sit next
# to `count_rows` much further down, which was fine until a step ABOVE that point needed it: bash resolves a
# function name at CALL time against what has been defined SO FAR, so the call failed with
# `digits_or_die: command not found` and the gate exited 127 — on CI, because the step that calls it only
# runs against a real Docker daemon and nothing local could reach it. Defined before the first executable
# line of the run, no step added later can land above it. `test/catalog-browser-acceptance.ts` now checks
# that property for every function in this file rather than trusting it.
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
  echo "      The catalog import-and-browse acceptance was NOT executed here."
  echo "      It is CI-required and runs on Linux with a Docker daemon. Run it locally with:"
  echo "        REQUIRE_ACCEPTANCE=1 bash deploy/ci/catalog-acceptance.sh"
  echo "      once Docker is running, or rely on the CI job 'catalog-acceptance'."
  exit 3
}

# ---------------------------------------------------------------------------------------------------------
# Teardown: ALWAYS runs, removes only what this project created, never masks the real failure.
# ---------------------------------------------------------------------------------------------------------
cleanup() {
  local code=$?
  step "teardown (always)"
  if [ "${RC_COMPOSE_ATTEMPTED}" = "1" ]; then
    rc_compose_down "${EXTRACTED}"
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
info "docker daemon reachable, node present"

[ -f "${BROWSER_DIR}/catalog.spec.mjs" ] || fail "the catalog acceptance spec is missing at ${BROWSER_DIR}"
[ -f "${FIXTURE}" ] || fail "the acceptance snapshot fixture is missing at ${FIXTURE}"
if [ ! -d "${BROWSER_DIR}/node_modules/@playwright/test" ]; then
  skip "the pinned browser harness is not installed (run: npm --prefix deploy/ci/acceptance ci && npx --prefix deploy/ci/acceptance playwright install --with-deps chromium)"
fi
info "pinned Playwright harness present"

rm -rf "${STAGING_DIR}" "${ARTIFACT_DIR}"
mkdir -p "${STAGING_DIR}"

# ---------------------------------------------------------------------------------------------------------
# 1. Assemble the exact consumer release bundle and archive, and extract it standalone.
# ---------------------------------------------------------------------------------------------------------
step "assemble the consumer release bundle and archive"
rm -rf "${BUNDLE_DIR}" "${ARCHIVE_DIR}"
node --import tsx src/ops/consumer-release-bundle-cli.ts --out "${BUNDLE_DIR}" --archive-dir "${ARCHIVE_DIR}" >/dev/null
ARCHIVE_PATH="$(ls "${ARCHIVE_DIR}"/*.tar.gz)"
RC_VERSION="$(grep '^version: ' "${BUNDLE_DIR}/VERSION" | cut -d' ' -f2-)"
RC_REVISION="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
[ -n "${RC_VERSION}" ] || fail "the assembled bundle declared no version"
info "assembled $(basename "${ARCHIVE_PATH}") — version ${RC_VERSION}"

step "extract the archive into a fresh standalone directory"
EXTRACTED="$(mktemp -d)"
tar -xzf "${ARCHIVE_PATH}" -C "${EXTRACTED}"
roots="$(ls "${EXTRACTED}")"
[ "$(printf '%s\n' "${roots}" | wc -l)" -eq 1 ] || fail "the archive did not extract into a single directory: ${roots}"
EXTRACTED="${EXTRACTED}/${roots}"
for forbidden in package.json node_modules src tsconfig.json Dockerfile .git; do
  [ -e "${EXTRACTED}/${forbidden}" ] && fail "the extracted release contains ${forbidden} — it is not standalone"
done
# The documented example snapshot is part of what an operator is told to use; if it is missing, the very
# first instruction in the README is broken.
[ -f "${EXTRACTED}/example-catalog-snapshot.json" ] || fail "the bundle ships no example-catalog-snapshot.json"
info "extracted standalone to a directory named ${roots}"

# ---------------------------------------------------------------------------------------------------------
# 2. Build the production image LOCALLY with a local-only tag. Never pushed, never a release.
# ---------------------------------------------------------------------------------------------------------
step "build the production image locally (local-only tag, never published)"
docker build \
  --file Dockerfile.runtime \
  --tag "${LOCAL_IMAGE}" \
  --build-arg "IMAGE_VERSION=${RC_VERSION}" \
  --build-arg "IMAGE_REVISION=${RC_REVISION}" \
  . >/dev/null
info "built ${LOCAL_IMAGE}"

step "pin the extracted stack to the local image, on its own loopback port"
tmp_env="$(mktemp)"
grep -v -e '^CATALOG_AUTHORITY_IMAGE=' -e '^OPERATOR_UI_HOST_PORT=' "${EXTRACTED}/.env" > "${tmp_env}"
printf 'CATALOG_AUTHORITY_IMAGE=%s\n' "${LOCAL_IMAGE}" >> "${tmp_env}"
printf 'OPERATOR_UI_HOST_PORT=%s\n' "${HOST_PORT}" >> "${tmp_env}"
mv "${tmp_env}" "${EXTRACTED}/.env"
info "extracted .env points at ${LOCAL_IMAGE} on 127.0.0.1:${HOST_PORT}"

# ---------------------------------------------------------------------------------------------------------
# 3. Secrets, and the snapshot placed through the SHIPPED read-only import path.
# ---------------------------------------------------------------------------------------------------------
step "generate secrets in the extracted directory (token never printed)"
( cd "${EXTRACTED}" && bash ./setup.sh >/dev/null 2>&1 ) || fail "the bundle's setup.sh failed"
TOKEN_FILE="${EXTRACTED}/secrets/operator_ui_token"
[ -s "${TOKEN_FILE}" ] || fail "setup.sh did not create an operator token"
TOKEN="$(cat "${TOKEN_FILE}")"
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::${TOKEN}"; fi
info "secrets generated; operator token read from disk and masked"

# ./import is the host side of the read-only mount the release documents (CATALOG_IMPORT_HOST_DIR). The
# snapshot goes in exactly the way the README tells an operator to put one there — a file copy, nothing else.
step "place the offline snapshot in the shipped read-only import folder"
mkdir -p "${EXTRACTED}/import"
cp "${FIXTURE}" "${EXTRACTED}/import/acceptance-snapshot.json"
cp "${EXTRACTED}/example-catalog-snapshot.json" "${EXTRACTED}/import/example-catalog-snapshot.json"
info "snapshot (${RECORD_COUNT} records) and the shipped example placed in ./import/"

# ---------------------------------------------------------------------------------------------------------
# 4. Start the stack. The compose file's one-shot `migrate` service bootstraps the schema before the app
#    exists, so "bootstrap/migrate" is the shipped behaviour rather than something this script arranges.
# ---------------------------------------------------------------------------------------------------------
step "start the extracted standalone stack (bootstrap/migrate runs first, by the shipped ordering)"
rc_compose_up "${EXTRACTED}"

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

step "wait for /healthz with bounded diagnostics"
wait_for_health "/healthz never returned 200 within the bounded wait"
info "/healthz is 200 — the migration one-shot completed and the app started behind it"

# ---------------------------------------------------------------------------------------------------------
# 4b. PHASE 263 — the LEGACY installation, repaired.
#
# The image now ships a node-owned keystore directory, so a FRESH volume is already correct and proves
# nothing about the case that matters: an installation created before that fix, whose volume Docker made
# root-owned and which no image change can reach back into. So this manufactures exactly that state on the
# volume this stack just created — root-owned, mode 0755, real key material inside it — and then proves the
# shipped startup path repairs it and the app comes back up NON-ROOT.
#
# It is manufactured with the same `chown -R` an operator would run by hand, in a throwaway root container
# that holds nothing else. Nothing here weakens the running stack: the app service is untouched.
# ---------------------------------------------------------------------------------------------------------
# THE KEYSTORE MUST HAVE CONTENT FIRST, and this is not a detail of the test — it is a fact about Docker
# that decides when the Phase 262 defect exists at all. An EMPTY named volume is re-initialised from the
# image's directory, ownership and mode included, on EVERY container start. So on an empty keystore the
# image fix alone is sufficient, and a manufactured root-owned state is wiped before anything can see it.
# The defect persists exactly when the keystore holds key material — which is every real installation.
# One authenticated catalog read constructs a FileCustodian, which creates the keystore's four directories.
#
# Without this, the manufacture below silently did nothing and the whole legacy leg passed vacuously. This
# gate caught that, on its own evidence.
step "give the keystore real content, so a legacy state can persist at all"
curl -fsS -o /dev/null -H "x-operator-ui-secret: ${TOKEN}" "${BASE_URL}/api/catalog" \
  || fail "the catalog route did not answer, so no custodian was constructed and the keystore is still empty"
keystore_entries="$( cd "${EXTRACTED}" && docker compose run --rm --user root --entrypoint sh keystore-prepare \
  -c 'ls -1 /var/lib/catalog/keystore | wc -l' | tr -d '[:space:]' )"
keystore_entries="$(digits_or_die "${keystore_entries}" "the keystore entry count")"
[ "${keystore_entries}" -ge 1 ] \
  || fail "the keystore is still empty, so a legacy state cannot persist and the leg below would pass vacuously"
info "the keystore now holds ${keystore_entries} entries, so ownership survives a container restart"


step "manufacture a LEGACY root-owned keystore, exactly as an installation from v1.1.2 has"
( cd "${EXTRACTED}" && docker compose stop >/dev/null )
( cd "${EXTRACTED}" && docker compose run --rm --user root --entrypoint sh keystore-prepare \
    -c 'chown -R root:root /var/lib/catalog/keystore && chmod 755 /var/lib/catalog/keystore && ls -la /var/lib/catalog/keystore >/dev/null' ) >/dev/null \
  || fail "could not manufacture the legacy keystore state"

# The CHECK sees it, names it, and exits non-zero — which is what makes it usable as a gate.
set +e
# The EXACT form the troubleshooting table and the documents tell an operator to run, so the gate
# exercises the documented command rather than a variant of it.
check_out="$( cd "${EXTRACTED}" && docker compose run --rm keystore-prepare ops:keystore-check 2>&1 )"
check_status=$?
set -e
printf '%s\n' "${check_out}" | grep -q 'REPAIRABLE' \
  || { printf '%s\n' "${check_out}" >&2; fail "the keystore check did not recognise a legacy root-owned keystore"; }
[ "${check_status}" -ne 0 ] || fail "the keystore check exited 0 on a keystore that needs repair"
# The report is redaction-safe: counts, uids and a mode, never a key file name.
# A COUNT, not merely the words. The first version of this asserted only that the phrase appeared, which is
# true of a keystore that is not legacy at all — so a manufacture that did nothing still "passed". This is
# the assertion that makes the leg above unable to be vacuous.
printf '%s\n' "${check_out}" | grep -qE '^ +wrongly owned +[1-9][0-9]*' \
  || { printf '%s\n' "${check_out}" >&2; fail "the keystore check found NOTHING wrongly owned — the legacy state was not manufactured, so this leg would have proved nothing"; }
info "the legacy state is recognised as REPAIRABLE and the check exits non-zero"

step "bring the stack back up: the shipped keystore-prepare one-shot must repair it"
( cd "${EXTRACTED}" && docker compose up -d >/dev/null )
wait_for_health "the stack did not become healthy after a legacy keystore was repaired"

prepare_cid="$( cd "${EXTRACTED}" && docker compose ps -aq keystore-prepare | head -1 )"
[ -n "${prepare_cid}" ] || fail "the keystore-prepare one-shot left no container to inspect — it cannot be said to have run"
prepare_exit="$( docker inspect --format '{{.State.ExitCode}}' "${prepare_cid}" )"
[ "${prepare_exit}" = "0" ] || fail "the keystore-prepare one-shot did not exit 0 (got '${prepare_exit:-nothing}')"

# ...and the long-running app is still NON-ROOT. The repair's elevated authority lived in a one-shot.
app_uid="$( cd "${EXTRACTED}" && docker compose exec -T app id -u | tr -d '[:space:]' )"
[ "${app_uid}" != "0" ] || fail "the app container is running as root"
[ -n "${app_uid}" ] || fail "could not read the app container's uid"
info "keystore-prepare exited 0 and the app is running as uid ${app_uid} (non-root)"

# The repair is IDEMPOTENT: a second check on the now-correct keystore exits 0 and reports nothing to do.
# Its output is CAPTURED rather than discarded: a failure here is a statement about the keystore, and
# the tool's own redaction-safe report is the diagnosis. Throwing it away would leave a failed gate
# saying only that it failed.
set +e
recheck_out="$( cd "${EXTRACTED}" && docker compose run --rm keystore-prepare ops:keystore-check 2>&1 )"
recheck_status=$?
set -e
if [ "${recheck_status}" -ne 0 ]; then
  echo "the keystore check still reports work to do after the repair ran; it said:" >&2
  printf "%s" "${recheck_out}" >&2
  echo >&2
  # The one-shot prints its OWN report, which says what it decided and what it changed. Without it a
  # failure here can only be guessed at, and the guess is usually wrong.
  echo "--- what the keystore-prepare one-shot itself reported ---" >&2
  ( cd "${EXTRACTED}" && docker compose logs --no-color keystore-prepare ) >&2 2>&1 || true
  echo "--- the keystore as the container sees it ---" >&2
  ( cd "${EXTRACTED}" && docker compose run --rm --user root --entrypoint sh keystore-prepare       -c 'stat -c "root: mode=%a owner=%u:%g" /var/lib/catalog/keystore; ls -lan /var/lib/catalog/keystore | head -20' ) >&2 2>&1 || true
  fail "the repair is not idempotent"
fi
info "a repeat check on the repaired keystore exits 0 — the repair is idempotent"

# And the check that PREDICTS the EACCES failure now passes, read from ops:doctor's own machine-readable
# contract rather than from its exit code — which is deliberately non-zero on other, unrelated production
# gates and would say nothing about the keystore either way.
doctor_json="$( cd "${EXTRACTED}" && docker compose exec -T app npm run --silent ops:doctor -- --json 2>/dev/null | tail -1 )"
keystore_state="$( printf '%s' "${doctor_json}" | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);const c=(r.checks||[]).find(x=>x.name==="keystore-ownership");process.stdout.write(c?c.state:"missing")}catch{process.stdout.write("unreadable")}})' )"
[ "${keystore_state}" = "pass" ] \
  || fail "ops:doctor reports keystore-ownership as '${keystore_state}' after the repair, not pass"
info "ops:doctor reports keystore-ownership: pass inside the running container"

# The migration really did run to completion: the app's own dependency is
# `migrate: service_completed_successfully`, and /healthz refuses 200 until the schema version matches.
migrate_cid="$( cd "${EXTRACTED}" && docker compose ps -aq migrate | head -1 )"
[ -n "${migrate_cid}" ] || fail "the migrate one-shot left no container to inspect — it cannot be said to have run"
migrate_exit="$( docker inspect --format '{{.State.ExitCode}}' "${migrate_cid}" )"
[ "${migrate_exit}" = "0" ] || fail "the migrate one-shot did not exit 0 (got '${migrate_exit:-nothing}')"
info "migrate one-shot exited 0"

# ---------------------------------------------------------------------------------------------------------
# 5. The import mount is READ-ONLY to the container, in the running stack.
# ---------------------------------------------------------------------------------------------------------
step "prove the import mount is read-only to the running container"
app_cid="$( cd "${EXTRACTED}" && docker compose ps -q app )"
[ -n "${app_cid}" ] || fail "could not find the app container"
if ! docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/catalog/import"}}{{.RW}}{{end}}{{end}}' "${app_cid}" | grep -q '^false$'; then
  fail "the catalog import mount is not read-only"
fi
# ...and the kernel agrees, not only the inspect metadata.
if ( cd "${EXTRACTED}" && docker compose exec -T app sh -c 'touch /var/lib/catalog/import/should-not-exist' ) >/dev/null 2>&1; then
  rm -f "${EXTRACTED}/import/should-not-exist"
  fail "the container was able to WRITE into the import folder"
fi
[ -e "${EXTRACTED}/import/should-not-exist" ] && fail "a file appeared in the import folder despite the read-only mount"
info "import mount is read-only in metadata and in fact"

# ---------------------------------------------------------------------------------------------------------
# 6. Counting helpers. The database is not published to the host, so counts are read INSIDE the stack.
# ---------------------------------------------------------------------------------------------------------

count_rows() {
  local raw
  raw="$( cd "${EXTRACTED}" && docker compose exec -T postgres psql -U postgres -d catalog -tAc "SELECT count(*) FROM ${1}" | tr -d '[:space:]' )"
  digits_or_die "${raw}" "the row count for ${1}"
}
catalog_total() {
  local raw
  raw="$( curl -fsS -H "x-operator-ui-secret: ${TOKEN}" "${BASE_URL}/api/catalog" | node -e \
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(String(JSON.parse(s).total))})' )"
  digits_or_die "${raw}" "the catalog API total"
}

# Print the stack's own logs with the operator token removed.
#
# WHY THIS EXISTS. A failing browser leg leaves Playwright traces, and a trace records the token that was
# typed into the token field — so the redaction gate (correctly) quarantines the ENTIRE artifact directory and
# uploads nothing. That is the right security answer and it leaves a failed gate with no diagnosis at all. The
# product's own log lines are redaction-safe by construction, so they are the thing to show. The token is
# removed by literal string replacement rather than `sed`, because a generated token may contain characters
# that are `sed` syntax.
dump_stack_logs() {
  echo "--- stack logs (operator token removed), last 150 lines ---" >&2
  ( cd "${EXTRACTED}" && docker compose logs --no-color 2>&1 ) \
    | CAT_TOKEN="${TOKEN}" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=process.env.CAT_TOKEN;process.stdout.write(t?s.split(t).join("<redacted>"):s)})' \
    | tail -150 >&2 || true
  echo "--- end stack logs ---" >&2
}

# Ask the API directly, before blaming the browser.
#
# The browser leg answers "can an operator use this?"; it cannot say whether a failure is in the page or in
# the service behind it. One authenticated request separates those, and prints the service's OWN explanation
# (which is a fixed code and sentence — never configuration) when it refuses.
require_catalog_api() {
  local body status
  body="$(mktemp)"
  status="$( curl -sS -o "${body}" -w '%{http_code}' -H "x-operator-ui-secret: ${TOKEN}" "${BASE_URL}/api/catalog" || echo 000 )"
  if [ "${status}" != "200" ]; then
    echo "FAIL: GET /api/catalog answered ${status}, not 200 — the catalog service refused before any browser was involved" >&2
    echo "      the service said: $(cat "${body}")" >&2
    rm -f "${body}"
    # The refusal tells an operator to check Setup & Diagnostics, so the gate does exactly that: the same
    # two answers a person would look at, both redaction-safe by construction.
    echo "--- GET /api/status (what Setup & Diagnostics reports) ---" >&2
    curl -sS -H "x-operator-ui-secret: ${TOKEN}" "${BASE_URL}/api/status" >&2 || true
    echo >&2
    echo "--- ops:doctor, run inside the app container ---" >&2
    ( cd "${EXTRACTED}" && docker compose exec -T app npm run ops:doctor ) >&2 2>&1 || true
    dump_stack_logs
    exit 1
  fi
  rm -f "${body}"
  info "GET /api/catalog answers 200 (${1})"
}

# A browser leg that ran NO tests is not a browser leg that passed. Playwright's own exit code covers a
# mistyped grep in current versions, but the number of tests it actually expected is the direct evidence,
# and it costs one line to read it rather than to trust it.
require_tests_ran() {
  local report="${1}/report.json"
  [ -f "${report}" ] || fail "the ${2} browser leg wrote no report — it cannot be said to have run"
  local expected
  expected="$( node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);process.stdout.write(String((r.stats&&r.stats.expected)||0))})' < "${report}" )"
  expected="$(digits_or_die "${expected}" "the ${2} browser leg test count")"
  [ "${expected}" -ge 1 ] || fail "the ${2} browser leg ran 0 tests — a filter matched nothing, which is not a pass"
  info "${2} browser leg ran ${expected} test(s)"
}

items_before="$(count_rows items)"
events_before="$(count_rows events)"
history_before="$(count_rows import_history)"
[ "${items_before}" = "0" ] || fail "a fresh installation already has ${items_before} items"
[ "${history_before}" = "0" ] || fail "a fresh installation already has ${history_before} import history entries"
info "fresh installation: ${items_before} items, ${events_before} events, ${history_before} import history entries"

# One browser leg. Every leg is run the same way, so a new one cannot be wired differently by accident.
run_leg() {
  local tag="$1" label="$2"
  mkdir -p "${STAGING_DIR}/${label}"
  set +e
  OPERATOR_UI_ACCEPTANCE_TOKEN="${TOKEN}" \
  OPERATOR_UI_ACCEPTANCE_BASE_URL="${BASE_URL}" \
  CATALOG_ACCEPTANCE_SECRET_REF="${SECRET_REF}" \
  CATALOG_ACCEPTANCE_RECORD_COUNT="${RECORD_COUNT}" \
  PLAYWRIGHT_ARTIFACT_DIR="${STAGING_DIR}/${label}" \
    npx --prefix "${BROWSER_DIR}" playwright test \
      --config "${BROWSER_DIR}/catalog.playwright.config.mjs" --grep "${tag}"
  LEG_STATUS=$?
  set -e
  # The test COUNT is read whatever the outcome: a leg that ran zero tests is not a leg that passed, and
  # that has to be caught even when the exit code was zero.
  require_tests_ran "${STAGING_DIR}/${label}" "${label}"
}

# ---------------------------------------------------------------------------------------------------------
# 7. LEG 1 — the empty installation, in a real browser.
# ---------------------------------------------------------------------------------------------------------
require_catalog_api "empty installation"

step "real-browser acceptance: the EMPTY installation and the Import panel"
run_leg "@empty" "empty"
[ "${LEG_STATUS}" -eq 0 ] || { dump_stack_logs; fail "the empty-state browser leg reported failures"; }
info "empty-state guidance and import discovery verified in a real browser"

# ---------------------------------------------------------------------------------------------------------
# 8. PREVIEW — twice, through both surfaces, and the proof that neither writes anything.
# ---------------------------------------------------------------------------------------------------------
step "preview the import from the COMMAND LINE (nothing may be written)"
preview_out="$( cd "${EXTRACTED}" && docker compose exec -T app npm run ops:catalog-import -- --file acceptance-snapshot.json )" \
  || fail "the import preview exited non-zero"
printf '%s\n' "${preview_out}" | grep -qF 'PREVIEW (nothing was written)' || fail "the preview did not announce itself as a preview"
printf '%s\n' "${preview_out}" | grep -qE "^ +create +${RECORD_COUNT}$" || fail "the preview did not plan ${RECORD_COUNT} creates"
# A report that echoed content would be a disclosure defect in itself.
if printf '%s\n' "${preview_out}" | grep -qF "${SECRET_REF}"; then fail "the preview report echoed a provider reference value"; fi
if printf '%s\n' "${preview_out}" | grep -qF 'Acceptance Fixture'; then fail "the preview report echoed a title"; fi

step "real-browser acceptance: PREVIEW through the Import panel (nothing may be written)"
run_leg "@preview" "preview"
[ "${LEG_STATUS}" -eq 0 ] || { dump_stack_logs; fail "the preview browser leg reported failures"; }

items_after_preview="$(count_rows items)"
events_after_preview="$(count_rows events)"
history_after_preview="$(count_rows import_history)"
[ "${items_after_preview}" = "${items_before}" ] || fail "a preview created rows (${items_before} -> ${items_after_preview})"
[ "${events_after_preview}" = "${events_before}" ] || fail "a preview appended events (${events_before} -> ${events_after_preview})"
[ "${history_after_preview}" = "${history_before}" ] || fail "a preview wrote an import history entry"
[ "$(catalog_total)" = "0" ] || fail "the catalog is not empty after a preview"
info "both previews wrote nothing: items, events and import history all unchanged"

# ---------------------------------------------------------------------------------------------------------
# 9. APPLY — the real import, through the BROWSER, bound to the exact previewed bytes.
# ---------------------------------------------------------------------------------------------------------
step "real-browser acceptance: APPLY the previewed import"
run_leg "@apply" "apply"
[ "${LEG_STATUS}" -eq 0 ] || { dump_stack_logs; fail "the apply browser leg reported failures"; }

items_after_apply="$(count_rows items)"
events_after_apply="$(count_rows events)"
history_after_apply="$(count_rows import_history)"
[ "${items_after_apply}" = "${RECORD_COUNT}" ] || fail "expected ${RECORD_COUNT} items after the import, got ${items_after_apply}"
[ "$(catalog_total)" = "${RECORD_COUNT}" ] || fail "the catalog API does not report ${RECORD_COUNT} records"
[ "${history_after_apply}" = "1" ] || fail "the browser apply did not write exactly one import history entry (got ${history_after_apply})"
info "imported ${items_after_apply} records from the browser; the catalog API and the import history agree"

# ---------------------------------------------------------------------------------------------------------
# 10. LEG 2 — browsing the imported catalog in a real browser, and the Phase 265 workspace.
# ---------------------------------------------------------------------------------------------------------
require_catalog_api "imported catalog"

step "real-browser acceptance: browsing the IMPORTED catalog"
run_leg "@imported" "imported"
browse_status="${LEG_STATUS}"
if [ "${browse_status}" -ne 0 ]; then dump_stack_logs; fi

step "real-browser acceptance: the WORKSPACE — export, history, paging bounds and the write boundary"
run_leg "@workspace" "workspace"
workspace_status="${LEG_STATUS}"
if [ "${workspace_status}" -ne 0 ]; then dump_stack_logs; fi

# ---------------------------------------------------------------------------------------------------------
# 11. Browsing and exporting are READ-ONLY: no row, no event and no history entry was written by any of it.
# ---------------------------------------------------------------------------------------------------------
step "browsing and exporting wrote no database, event or history state"
items_after_browse="$(count_rows items)"
events_after_browse="$(count_rows events)"
history_after_browse="$(count_rows import_history)"
[ "${items_after_browse}" = "${items_after_apply}" ] || fail "browsing changed the item count (${items_after_apply} -> ${items_after_browse})"
[ "${events_after_browse}" = "${events_after_apply}" ] || fail "browsing appended events (${events_after_apply} -> ${events_after_browse})"
[ "${history_after_browse}" = "${history_after_apply}" ] || fail "browsing or exporting wrote an import history entry"
info "items, events and import history unchanged by an entire browsing and exporting session"

# ---------------------------------------------------------------------------------------------------------
# 11b. The EXPORT, asked for directly, discloses nothing it must not.
# ---------------------------------------------------------------------------------------------------------
step "the export API is a sanitized, attachment-safe snapshot"
export_headers="$(mktemp)"
export_body="$(mktemp)"
export_status="$( curl -sS -D "${export_headers}" -o "${export_body}" -w '%{http_code}' \
  -H "x-operator-ui-secret: ${TOKEN}" "${BASE_URL}/api/catalog/export" || echo 000 )"
[ "${export_status}" = "200" ] || { cat "${export_body}" >&2; rm -f "${export_headers}" "${export_body}"; fail "GET /api/catalog/export answered ${export_status}, not 200"; }
grep -qi '^content-disposition: attachment; filename="catalog-export-[a-z0-9][a-z0-9._-]*\.json"' "${export_headers}" \
  || { cat "${export_headers}" >&2; rm -f "${export_headers}" "${export_body}"; fail "the export did not carry a safe attachment filename"; }
grep -qi '^x-content-type-options: nosniff' "${export_headers}" || { rm -f "${export_headers}" "${export_body}"; fail "the export can be sniffed"; }
if grep -qF "${SECRET_REF}" "${export_body}"; then rm -f "${export_headers}" "${export_body}"; fail "the export disclosed a provider reference value"; fi
if grep -qF "${TOKEN}" "${export_body}"; then rm -f "${export_headers}" "${export_body}"; fail "the export carried the operator token"; fi
if grep -qF 'providerRefs' "${export_body}"; then rm -f "${export_headers}" "${export_body}"; fail "the export carried a provider reference structure"; fi
export_count="$( node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(String(JSON.parse(s).items.length))})' < "${export_body}" )"
[ "$(digits_or_die "${export_count}" "the export record count")" = "${RECORD_COUNT}" ] \
  || { rm -f "${export_headers}" "${export_body}"; fail "the export carried ${export_count} records, not ${RECORD_COUNT}"; }
rm -f "${export_headers}" "${export_body}"
info "the export carries ${RECORD_COUNT} records, a safe attachment name, and no reference value"

# ---------------------------------------------------------------------------------------------------------
# 12. The logs disclose neither the token nor any content.
# ---------------------------------------------------------------------------------------------------------
step "server logs carry no token and no catalog content"
( cd "${EXTRACTED}" && docker compose logs --no-color > "${STAGING_DIR}/server-logs.txt" 2>&1 ) || true
if grep -qF "${TOKEN}" "${STAGING_DIR}/server-logs.txt"; then
  rm -f "${STAGING_DIR}/server-logs.txt"
  fail "the operator token appeared in the server logs"
fi
for forbidden in "${SECRET_REF}" 'Acceptance Fixture' 'onerror=window.__catXss'; do
  if grep -qF "${forbidden}" "${STAGING_DIR}/server-logs.txt"; then
    rm -f "${STAGING_DIR}/server-logs.txt"
    fail "catalog content appeared in the server logs"
  fi
done
info "no token and no catalog content in the logs"

# ---------------------------------------------------------------------------------------------------------
# 13. IDEMPOTENCY — the same snapshot applied twice changes nothing, through BOTH surfaces.
# ---------------------------------------------------------------------------------------------------------
step "re-apply the same snapshot from the BROWSER (idempotency)"
run_leg "@reapply" "reapply"
reapply_status="${LEG_STATUS}"
if [ "${reapply_status}" -ne 0 ]; then dump_stack_logs; fi
[ "$(count_rows items)" = "${RECORD_COUNT}" ] || fail "the repeat browser import changed the item count"
[ "$(count_rows events)" = "${events_after_apply}" ] || fail "the repeat browser import appended events"
# The HISTORY does grow: "I ran an import and it changed nothing" is a fact worth keeping.
[ "$(count_rows import_history)" = "2" ] || fail "the repeat browser import was not recorded in the history"
info "re-applying from the browser created nothing, appended nothing, and was still recorded"

step "re-apply the same snapshot from the COMMAND LINE (idempotency, and both surfaces agree)"
repeat_out="$( cd "${EXTRACTED}" && docker compose exec -T app npm run ops:catalog-import -- --file acceptance-snapshot.json --apply )" \
  || fail "the repeat import exited non-zero"
printf '%s\n' "${repeat_out}" | grep -qE '^ +create +0$' || fail "the repeat import planned creates; it is not idempotent"
printf '%s\n' "${repeat_out}" | grep -qE "^ +already present +${RECORD_COUNT}$" || fail "the repeat import did not recognise every record as already present"
[ "$(count_rows items)" = "${RECORD_COUNT}" ] || fail "the repeat import changed the item count"
[ "$(count_rows events)" = "${events_after_apply}" ] || fail "the repeat import appended events"
[ "$(count_rows import_history)" = "3" ] || fail "the command-line import did not write to the same history"
info "re-applying from the command line created nothing, appended nothing, and wrote to the SAME history"

# ---------------------------------------------------------------------------------------------------------
# 14. RESTART PERSISTENCE — the catalog and the import history survive a full stop/start.
# ---------------------------------------------------------------------------------------------------------
step "restart the whole stack and re-check (persistence)"
token_before="$(cat "${TOKEN_FILE}")"
history_before_restart="$(count_rows import_history)"
( cd "${EXTRACTED}" && docker compose stop >/dev/null )
( cd "${EXTRACTED}" && docker compose up -d >/dev/null )
wait_for_health "the stack did not come back healthy after a restart"
[ "$(cat "${TOKEN_FILE}")" = "${token_before}" ] || fail "the operator token did not persist across a restart"
[ "$(count_rows items)" = "${RECORD_COUNT}" ] || fail "the imported records did not survive a restart"
[ "$(catalog_total)" = "${RECORD_COUNT}" ] || fail "the catalog API does not report the records after a restart"
[ "$(count_rows events)" = "${events_after_apply}" ] || fail "the restart appended events"
[ "$(count_rows import_history)" = "${history_before_restart}" ] || fail "the import history did not survive a restart"
info "records, token, event log and import history all survived a full stop/start unchanged"

step "real-browser acceptance: the records and the history are still there after the restart"
run_leg "@survived" "survived"
survived_status="${LEG_STATUS}"
if [ "${survived_status}" -ne 0 ]; then dump_stack_logs; fi

# ---------------------------------------------------------------------------------------------------------
# 15. The import mount is STILL read-only, after everything above.
# ---------------------------------------------------------------------------------------------------------
step "the import mount is still read-only after an entire import workflow"
app_cid="$( cd "${EXTRACTED}" && docker compose ps -q app )"
[ -n "${app_cid}" ] || fail "could not find the app container after the restart"
docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/catalog/import"}}{{.RW}}{{end}}{{end}}' "${app_cid}" \
  | grep -q '^false$' || fail "the catalog import mount is no longer read-only"
if ( cd "${EXTRACTED}" && docker compose exec -T app sh -c 'touch /var/lib/catalog/import/still-should-not-exist' ) >/dev/null 2>&1; then
  rm -f "${EXTRACTED}/import/still-should-not-exist"
  fail "the container was able to WRITE into the import folder after importing from it"
fi
[ -e "${EXTRACTED}/import/still-should-not-exist" ] && fail "a file appeared in the import folder despite the read-only mount"
info "the import folder is still read-only in metadata and in fact"

# The browser verdicts are reported last so every check above still runs and reports its own diagnosis first.
for leg_result in "browsing:${browse_status}" "workspace:${workspace_status}" "reapply:${reapply_status}" "survived:${survived_status}"; do
  if [ "${leg_result#*:}" -ne 0 ]; then
    fail "the ${leg_result%%:*} acceptance leg reported failures (sanitized diagnostics will be in ${ARTIFACT_DIR})"
  fi
done

printf '\ncatalog import-and-browse acceptance: PASS (version %s, %s records)\n' "${RC_VERSION}" "${RECORD_COUNT}"
