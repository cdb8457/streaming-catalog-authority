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

step "wait for /healthz with bounded diagnostics"
healthy=""
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "${BASE_URL}/healthz"; then healthy=yes; break; fi
  sleep 2
done
if [ -z "${healthy}" ]; then
  echo "the stack never became healthy; diagnostics follow:" >&2
  ( cd "${EXTRACTED}" && docker compose ps && docker compose logs --tail 120 ) >&2 || true
  fail "/healthz never returned 200 within the bounded wait"
fi
info "/healthz is 200 — the migration one-shot completed and the app started behind it"

# The migration really did run to completion: the app's own dependency is
# `migrate: service_completed_successfully`, and /healthz refuses 200 until the schema version matches.
migrate_exit="$( cd "${EXTRACTED}" && docker compose ps -a --format '{{.Service}} {{.ExitCode}}' | awk '$1=="migrate"{print $2}' | head -1 )"
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
  ( cd "${EXTRACTED}" && docker compose exec -T postgres psql -U postgres -d catalog -tAc "SELECT count(*) FROM ${1}" ) | tr -d '[:space:]'
}
catalog_total() {
  curl -fsS -H "x-operator-ui-secret: ${TOKEN}" "${BASE_URL}/api/catalog" | node -e \
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(String(JSON.parse(s).total))})'
}

items_before="$(count_rows items)"
events_before="$(count_rows events)"
[ "${items_before}" = "0" ] || fail "a fresh installation already has ${items_before} items"
info "fresh installation: ${items_before} items, ${events_before} events"

# ---------------------------------------------------------------------------------------------------------
# 7. LEG 1 — the empty installation, in a real browser.
# ---------------------------------------------------------------------------------------------------------
step "real-browser acceptance: the EMPTY installation"
mkdir -p "${STAGING_DIR}/empty"
set +e
OPERATOR_UI_ACCEPTANCE_TOKEN="${TOKEN}" \
OPERATOR_UI_ACCEPTANCE_BASE_URL="${BASE_URL}" \
CATALOG_ACCEPTANCE_SECRET_REF="${SECRET_REF}" \
CATALOG_ACCEPTANCE_RECORD_COUNT="${RECORD_COUNT}" \
PLAYWRIGHT_ARTIFACT_DIR="${STAGING_DIR}/empty" \
  npx --prefix "${BROWSER_DIR}" playwright test \
    --config "${BROWSER_DIR}/catalog.playwright.config.mjs" --grep "@empty"
empty_status=$?
set -e
[ "${empty_status}" -eq 0 ] || fail "the empty-state browser leg reported failures"
info "empty-state guidance verified in a real browser"

# ---------------------------------------------------------------------------------------------------------
# 8. PREVIEW — and the proof that a preview writes NOTHING.
# ---------------------------------------------------------------------------------------------------------
step "preview the import (nothing may be written)"
preview_out="$( cd "${EXTRACTED}" && docker compose exec -T app npm run ops:catalog-import -- --file acceptance-snapshot.json )" \
  || fail "the import preview exited non-zero"
printf '%s\n' "${preview_out}" | grep -qF 'PREVIEW (nothing was written)' || fail "the preview did not announce itself as a preview"
printf '%s\n' "${preview_out}" | grep -qE "^ +create +${RECORD_COUNT}$" || fail "the preview did not plan ${RECORD_COUNT} creates"
# A report that echoed content would be a disclosure defect in itself.
if printf '%s\n' "${preview_out}" | grep -qF "${SECRET_REF}"; then fail "the preview report echoed a provider reference value"; fi
if printf '%s\n' "${preview_out}" | grep -qF 'Acceptance Fixture'; then fail "the preview report echoed a title"; fi

items_after_preview="$(count_rows items)"
events_after_preview="$(count_rows events)"
[ "${items_after_preview}" = "${items_before}" ] || fail "the preview created rows (${items_before} -> ${items_after_preview})"
[ "${events_after_preview}" = "${events_before}" ] || fail "the preview appended events (${events_before} -> ${events_after_preview})"
[ "$(catalog_total)" = "0" ] || fail "the catalog is not empty after a preview"
info "preview wrote nothing: items and events both unchanged"

# ---------------------------------------------------------------------------------------------------------
# 9. APPLY — the real import, through the shipped CLI, from the read-only mount.
# ---------------------------------------------------------------------------------------------------------
step "apply the import"
( cd "${EXTRACTED}" && docker compose exec -T app npm run ops:catalog-import -- --file acceptance-snapshot.json --apply ) \
  || fail "the import apply exited non-zero"
items_after_apply="$(count_rows items)"
events_after_apply="$(count_rows events)"
[ "${items_after_apply}" = "${RECORD_COUNT}" ] || fail "expected ${RECORD_COUNT} items after the import, got ${items_after_apply}"
[ "$(catalog_total)" = "${RECORD_COUNT}" ] || fail "the catalog API does not report ${RECORD_COUNT} records"
info "imported ${items_after_apply} records; the catalog API agrees"

# ---------------------------------------------------------------------------------------------------------
# 10. LEG 2 — browsing the imported catalog in a real browser.
# ---------------------------------------------------------------------------------------------------------
step "real-browser acceptance: browsing the IMPORTED catalog"
mkdir -p "${STAGING_DIR}/imported"
set +e
OPERATOR_UI_ACCEPTANCE_TOKEN="${TOKEN}" \
OPERATOR_UI_ACCEPTANCE_BASE_URL="${BASE_URL}" \
CATALOG_ACCEPTANCE_SECRET_REF="${SECRET_REF}" \
CATALOG_ACCEPTANCE_RECORD_COUNT="${RECORD_COUNT}" \
PLAYWRIGHT_ARTIFACT_DIR="${STAGING_DIR}/imported" \
  npx --prefix "${BROWSER_DIR}" playwright test \
    --config "${BROWSER_DIR}/catalog.playwright.config.mjs" --grep "@imported"
browse_status=$?
set -e

# ---------------------------------------------------------------------------------------------------------
# 11. Browsing is READ-ONLY: no row and no event was written by any of it.
# ---------------------------------------------------------------------------------------------------------
step "browsing wrote no database or event state"
items_after_browse="$(count_rows items)"
events_after_browse="$(count_rows events)"
[ "${items_after_browse}" = "${items_after_apply}" ] || fail "browsing changed the item count (${items_after_apply} -> ${items_after_browse})"
[ "${events_after_browse}" = "${events_after_apply}" ] || fail "browsing appended events (${events_after_apply} -> ${events_after_browse})"
info "items and events unchanged by an entire browsing session"

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
# 13. IDEMPOTENCY — the same snapshot applied twice changes nothing.
# ---------------------------------------------------------------------------------------------------------
step "re-apply the same snapshot (idempotency)"
repeat_out="$( cd "${EXTRACTED}" && docker compose exec -T app npm run ops:catalog-import -- --file acceptance-snapshot.json --apply )" \
  || fail "the repeat import exited non-zero"
printf '%s\n' "${repeat_out}" | grep -qE '^ +create +0$' || fail "the repeat import planned creates; it is not idempotent"
printf '%s\n' "${repeat_out}" | grep -qE "^ +already present +${RECORD_COUNT}$" || fail "the repeat import did not recognise every record as already present"
[ "$(count_rows items)" = "${RECORD_COUNT}" ] || fail "the repeat import changed the item count"
[ "$(count_rows events)" = "${events_after_apply}" ] || fail "the repeat import appended events"
info "re-applying the same snapshot created nothing and appended nothing"

# ---------------------------------------------------------------------------------------------------------
# 14. RESTART PERSISTENCE — the catalog survives a full stop/start, and the migration is idempotent.
# ---------------------------------------------------------------------------------------------------------
step "restart the whole stack and re-check (persistence)"
token_before="$(cat "${TOKEN_FILE}")"
( cd "${EXTRACTED}" && docker compose stop >/dev/null )
( cd "${EXTRACTED}" && docker compose up -d >/dev/null )
healthy=""
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "${BASE_URL}/healthz"; then healthy=yes; break; fi
  sleep 2
done
[ -n "${healthy}" ] || fail "the stack did not come back healthy after a restart"
[ "$(cat "${TOKEN_FILE}")" = "${token_before}" ] || fail "the operator token did not persist across a restart"
[ "$(count_rows items)" = "${RECORD_COUNT}" ] || fail "the imported records did not survive a restart"
[ "$(catalog_total)" = "${RECORD_COUNT}" ] || fail "the catalog API does not report the records after a restart"
[ "$(count_rows events)" = "${events_after_apply}" ] || fail "the restart appended events"
info "records, token and event log all survived a full stop/start unchanged"

# The browser verdict is reported last so the checks above still run and report their own diagnosis first.
if [ "${browse_status}" -ne 0 ]; then
  fail "the catalog browsing acceptance reported failures (sanitized diagnostics will be in ${ARTIFACT_DIR})"
fi

printf '\ncatalog import-and-browse acceptance: PASS (version %s, %s records)\n' "${RC_VERSION}" "${RECORD_COUNT}"
