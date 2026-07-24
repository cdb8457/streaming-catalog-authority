#!/usr/bin/env bash
# Catalog Authority — Phase 249 release LIFECYCLE acceptance orchestrator.
#
# Phase 248 proved a fresh release-candidate works in a real browser against a real Compose stack. This proves
# the *documented lifecycle* an ordinary self-hosted operator actually lives through: fresh setup and start,
# an authenticated UI reporting health and version, generated secrets and Postgres state that persist, a
# read-only view of the promotion records, a graceful restart, an UPGRADE from a prior version to the
# candidate, and a ROLLBACK to the prior version — all without losing secrets, data or artifacts.
#
# WHAT THE PRIOR-VERSION FIXTURE IS, AND WHAT IT IS NOT. There is no genuine prior release yet, so the "prior
# version" here is the SAME source built with a different version label (v0.9.0-fixture) and a local-only tag.
# That makes this an honest test of the LIFECYCLE MECHANICS — that changing the image pin in .env and doing
# `down` then `up` preserves the named volumes (Postgres data, keystore), the ./secrets folder and the
# ./promotion-records folder, and that the UI reports the version it is actually running. It DOES NOT, and
# cannot, prove real cross-version database SCHEMA migration compatibility: both images carry identical schema
# and migration code, so nothing is migrated. That limitation is stated in docs/PHASE_249_LIFECYCLE_ACCEPTANCE.md
# and holds until a real prior release exists to build the fixture from.
#
# It is an ACCEPTANCE gate, not a publish step: it builds only LOCAL-only image tags, never logs in to a
# registry, never pushes, never tags a release, and never uploads an asset. It runs in an ISOLATED Compose
# project (its own name, volumes, host port and directories) and can never touch an unrelated Docker resource.
#
# FAIL vs SKIP is explicit, exactly as Phase 248:
#   * REQUIRE_ACCEPTANCE=1 (what CI sets)  -> a missing prerequisite is a hard FAILURE (exit 1). CI never
#     silently skips.
#   * otherwise (a developer laptop)       -> a missing prerequisite is a SKIP (exit 3) that says this leg is
#     CI-required and was NOT executed. A skip is never a pass.
#
# Boundaries: no live provider, media server or library; no promotion, approval, execution, archival or
# deletion; nothing published, pushed, tagged, merged or deployed; no registry credentials.
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"

REQUIRE_ACCEPTANCE="${REQUIRE_ACCEPTANCE:-0}"

# ISOLATION. A distinct Compose project name (its own network + volumes), a distinct host port, distinct
# local image tags, and distinct directories — so nothing here shares state with the Phase 248 acceptance
# (catalogauthority-local) or with any real operator stack, and teardown can only ever reach these resources.
export COMPOSE_PROJECT_NAME="catalogauthority-lifecycle"
LIFECYCLE_HOST_PORT="${RC_LIFECYCLE_HOST_PORT:-8109}"
BASE_URL="http://127.0.0.1:${LIFECYCLE_HOST_PORT}"
PRIOR_IMAGE="catalog-authority-ops:lifecycle-prior"
CANDIDATE_IMAGE="catalog-authority-ops:lifecycle-candidate"
PRIOR_VERSION="v0.9.0-fixture"   # the same source, a different label — a fixture, not a real prior release

ARTIFACT_DIR="${RC_LIFECYCLE_ARTIFACT_DIR:-${REPO_ROOT}/dist/rc-lifecycle-artifacts}"
STAGING_DIR="${RC_LIFECYCLE_STAGING_DIR:-${REPO_ROOT}/dist/rc-lifecycle-staging}"
BUNDLE_DIR="${REPO_ROOT}/dist/rc-lifecycle-bundle"
ARCHIVE_DIR="${REPO_ROOT}/dist/rc-lifecycle-archive"
BROWSER_DIR="${REPO_ROOT}/deploy/ci/acceptance"
EXTRACTED=""              # set once the archive is extracted, so cleanup can find it
RC_COMPOSE_ATTEMPTED=0    # armed to 1 by rc_compose_up BEFORE `up`, so a partial-up failure still tears down
TOKEN=""                  # set once secrets exist; the cleanup trap uses it to gate artifacts

# Reuse the Phase 248 teardown library: arm-before-up (rc_compose_up) and scoped, idempotent down -v
# (rc_compose_down). One implementation, already tested against an injected compose failure.
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
  echo "      The release LIFECYCLE acceptance (real Docker Compose) was NOT executed here."
  echo "      It is CI-required and runs on Linux with a Docker daemon. Run it locally with:"
  echo "        REQUIRE_ACCEPTANCE=1 bash deploy/ci/release-lifecycle-acceptance.sh"
  echo "      once Docker is running, or rely on the CI job 'lifecycle'."
  exit 3
}

# ---------------------------------------------------------------------------------------------------------
# Teardown: ALWAYS runs; scoped to THIS isolated project and THESE image tags; never masks a real failure.
# ---------------------------------------------------------------------------------------------------------
cleanup() {
  local code=$?
  step "teardown (always)"
  # Tear the stack down whenever `up` was ATTEMPTED — armed before `up`, so a partial-up at ANY lifecycle
  # phase still gets here. rc_compose_down is `down -v`, idempotent, and scoped to the isolated project.
  if [ "${RC_COMPOSE_ATTEMPTED}" = "1" ]; then
    rc_compose_down "${EXTRACTED}"
    info "isolated lifecycle stack torn down (down -v), volumes removed"
  fi
  # The locally-built fixture images are never pushed and are not release artifacts; remove both by exact tag.
  docker image rm -f "${PRIOR_IMAGE}" "${CANDIDATE_IMAGE}" >/dev/null 2>&1 || true

  # Gate then PROMOTE artifacts, exactly as Phase 248: the upload directory is populated ONLY from staging
  # that passed the redaction gate, so a gate failure — or a kill before the gate — leaves it empty.
  if [ -d "${STAGING_DIR}" ] && [ -n "${TOKEN}" ] && [ -f "${BROWSER_DIR}/redact-artifacts.sh" ]; then
    if OPERATOR_UI_ACCEPTANCE_TOKEN="${TOKEN}" bash "${BROWSER_DIR}/redact-artifacts.sh" "${STAGING_DIR}"; then
      mkdir -p "${ARTIFACT_DIR}"
      ( shopt -s dotglob nullglob; mv "${STAGING_DIR}"/* "${ARTIFACT_DIR}/" 2>/dev/null ) || true
      info "lifecycle artifacts passed redaction and were promoted for upload"
    else
      echo "artifact redaction gate failed — quarantining all lifecycle artifacts, nothing will be uploaded" >&2
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

# A lifecycle `down` BETWEEN phases: remove containers and the network but KEEP the named volumes — exactly
# the documented `docker compose down` an operator runs to upgrade or roll back. Teardown (down -v) is the
# cleanup trap's job; this is a normal lifecycle step and creates nothing.
keep_volumes_down() {
  ( cd "${EXTRACTED}" && docker compose down --remove-orphans >/dev/null 2>&1 )
}

# Point the extracted .env at a given local image and declare the matching bundle version, so the UI's
# image-vs-bundle agreement is a real comparison for whichever version is running.
write_env() {
  local image="$1" version="$2" tmp
  tmp="$(mktemp)"
  grep -vE '^(CATALOG_AUTHORITY_IMAGE|CATALOG_AUTHORITY_BUNDLE_VERSION|OPERATOR_UI_HOST_PORT)=' "${EXTRACTED}/.env" > "${tmp}"
  {
    printf 'CATALOG_AUTHORITY_IMAGE=%s\n' "${image}"
    printf 'CATALOG_AUTHORITY_BUNDLE_VERSION=%s\n' "${version}"
    printf 'OPERATOR_UI_HOST_PORT=%s\n' "${LIFECYCLE_HOST_PORT}"
  } >> "${tmp}"
  mv "${tmp}" "${EXTRACTED}/.env"
}

wait_health() {
  local ok=""
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "${BASE_URL}/healthz"; then ok=yes; break; fi
    sleep 2
  done
  if [ -z "${ok}" ]; then
    echo "the stack never became healthy; diagnostics follow:" >&2
    ( cd "${EXTRACTED}" && docker compose ps && docker compose logs --tail 120 ) >&2 || true
    fail "/healthz never returned 200 within the bounded wait ($1)"
  fi
}

# An authenticated GET; the token travels only in the header. Never logged.
api_get() { curl -fsS -H "X-Operator-UI-Secret: ${TOKEN}" "${BASE_URL}$1"; }

# Assert the UI reports the exact version it is running, and that image and bundle AGREE. Parsed with node
# (a prerequisite on the host) so the check is on the real JSON, not a fragile string match.
assert_version() {
  local expected="$1"
  api_get /api/version | node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const v = (d && d.version) || {};
    if (v.version !== process.argv[1]) { console.error("reported version " + JSON.stringify(v.version) + ", expected " + JSON.stringify(process.argv[1])); process.exit(1); }
    if (v.agreement !== "AGREES") { console.error("image/bundle agreement is " + JSON.stringify(v.agreement) + ", expected AGREES"); process.exit(1); }
  ' "${expected}" || fail "the UI did not report version ${expected} in agreement"
}

# Assert the mounted promotion-records folder is VISIBLE and readable to the app (not MISSING/UNREADABLE).
assert_records_visible() {
  api_get /api/installation | node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const c = ((d.readiness && d.readiness.components) || []).find((x) => x.id === "promotion-records");
    if (!c) { console.error("no promotion-records component in the installation report"); process.exit(1); }
    if (c.state === "MISSING" || c.state === "UNREADABLE") { console.error("records folder state is " + c.state); process.exit(1); }
  ' || fail "the app cannot see the read-only promotion-records folder"
}

# Run one SQL statement in the isolated Postgres over the local socket (trust auth for the postgres user).
pg_exec() { ( cd "${EXTRACTED}" && docker compose exec -T postgres psql -U postgres -d catalog -tAc "$1" ); }

# ---------------------------------------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------------------------------------
step "prerequisites"
command -v node >/dev/null 2>&1 || skip "node is not installed"
command -v docker >/dev/null 2>&1 || skip "the docker CLI is not installed"
command -v curl >/dev/null 2>&1 || skip "curl is not installed"
docker info >/dev/null 2>&1 || skip "the Docker daemon is not reachable"
info "docker daemon reachable, node and curl present"

# Start from a clean staging directory; the upload directory is created only when artifacts pass redaction.
rm -rf "${STAGING_DIR}" "${ARTIFACT_DIR}"
mkdir -p "${STAGING_DIR}"

# ---------------------------------------------------------------------------------------------------------
# 1. Assemble the exact consumer release bundle and archive (the candidate).
# ---------------------------------------------------------------------------------------------------------
step "assemble the consumer release bundle and archive (candidate)"
rm -rf "${BUNDLE_DIR}" "${ARCHIVE_DIR}"
node --import tsx src/ops/consumer-release-bundle-cli.ts --out "${BUNDLE_DIR}" --archive-dir "${ARCHIVE_DIR}" >/dev/null
ARCHIVE_PATH="$(ls "${ARCHIVE_DIR}"/*.tar.gz)"
CANDIDATE_VERSION="$(grep '^version: ' "${BUNDLE_DIR}/VERSION" | cut -d' ' -f2-)"
RC_REVISION="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
[ -n "${CANDIDATE_VERSION}" ] || fail "the assembled bundle declared no version"
info "candidate version ${CANDIDATE_VERSION}; prior fixture version ${PRIOR_VERSION}; revision ${RC_REVISION}"

# ---------------------------------------------------------------------------------------------------------
# 2. Extract into a fresh, isolated, standalone directory (no source, no Node dependency).
# ---------------------------------------------------------------------------------------------------------
step "extract the archive into a fresh standalone directory"
EXTRACTED="$(mktemp -d)"
tar -xzf "${ARCHIVE_PATH}" -C "${EXTRACTED}"
roots="$(ls "${EXTRACTED}")"
[ "$(printf '%s\n' "${roots}" | wc -l)" -eq 1 ] || fail "the archive did not extract into a single directory: ${roots}"
EXTRACTED="${EXTRACTED}/${roots}"
for forbidden in package.json package-lock.json node_modules src tsconfig.json Dockerfile Dockerfile.runtime .git; do
  [ -e "${EXTRACTED}/${forbidden}" ] && fail "the extracted release contains ${forbidden} — it is not standalone"
done
info "extracted a standalone bundle to a directory named ${roots}"

# ---------------------------------------------------------------------------------------------------------
# 3. Build BOTH images locally: a prior-version fixture and the candidate. Local-only tags, never published.
# ---------------------------------------------------------------------------------------------------------
step "build the prior-version fixture and the candidate image (local-only tags)"
docker build --file Dockerfile.runtime --tag "${PRIOR_IMAGE}" \
  --build-arg "IMAGE_VERSION=${PRIOR_VERSION}" --build-arg "IMAGE_REVISION=${RC_REVISION}" . >/dev/null
docker build --file Dockerfile.runtime --tag "${CANDIDATE_IMAGE}" \
  --build-arg "IMAGE_VERSION=${CANDIDATE_VERSION}" --build-arg "IMAGE_REVISION=${RC_REVISION}" . >/dev/null
info "built ${PRIOR_IMAGE} (${PRIOR_VERSION}) and ${CANDIDATE_IMAGE} (${CANDIDATE_VERSION})"

# ---------------------------------------------------------------------------------------------------------
# 4. Fresh setup: generate secrets once. Read the operator token WITHOUT printing it.
# ---------------------------------------------------------------------------------------------------------
step "fresh setup — generate secrets in the extracted directory (token never printed)"
( cd "${EXTRACTED}" && bash ./setup.sh >/dev/null 2>&1 ) || fail "the bundle's setup.sh failed"
TOKEN_FILE="${EXTRACTED}/secrets/operator_ui_token"
[ -s "${TOKEN_FILE}" ] || fail "setup.sh did not create an operator token"
TOKEN="$(cat "${TOKEN_FILE}")"
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::${TOKEN}"; fi
info "secrets generated; operator token read from disk and masked"

# A benign promotion record, so read-only visibility is exercised against a non-empty folder.
mkdir -p "${EXTRACTED}/promotion-records"
printf '%s' '{"phase":231,"note":"phase249 lifecycle visibility record"}' \
  > "${EXTRACTED}/promotion-records/phase-231-lifecycle.json"

# ---------------------------------------------------------------------------------------------------------
# Phase A — fresh install and start, on the PRIOR version.
# ---------------------------------------------------------------------------------------------------------
step "Phase A: fresh start on the prior version ${PRIOR_VERSION}"
write_env "${PRIOR_IMAGE}" "${PRIOR_VERSION}"
rc_compose_up "${EXTRACTED}"          # arms teardown BEFORE up
wait_health "prior first start"
assert_version "${PRIOR_VERSION}"
assert_records_visible
# The record mount must be read-only.
app_cid="$( cd "${EXTRACTED}" && docker compose ps -q app )"
[ -n "${app_cid}" ] || fail "could not find the app container"
docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/catalog/promotion-records"}}{{.RW}}{{end}}{{end}}' "${app_cid}" \
  | grep -q '^false$' || fail "the promotion-records mount is not read-only"
# The database is not published to the host.
if ( cd "${EXTRACTED}" && docker compose ps --format '{{.Publishers}}' postgres 2>/dev/null | grep -q ':5432->'); then
  fail "the database port is published to the host"
fi
info "prior version healthy, version agrees, records visible read-only, db unpublished"

step "Phase A: seed persisted Postgres state and record the generated token"
for _ in $(seq 1 15); do pg_exec "SELECT 1" >/dev/null 2>&1 && break; sleep 2; done
pg_exec "CREATE TABLE IF NOT EXISTS lifecycle_marker (id int primary key, note text);" >/dev/null
pg_exec "INSERT INTO lifecycle_marker VALUES (1, 'phase249-marker') ON CONFLICT (id) DO NOTHING;" >/dev/null
marker="$(pg_exec "SELECT note FROM lifecycle_marker WHERE id=1;" | tr -d '[:space:]')"
[ "${marker}" = "phase249-marker" ] || fail "could not seed a persisted Postgres marker (got '${marker}')"
token_before="$(cat "${TOKEN_FILE}")"
info "seeded lifecycle_marker in Postgres; captured the generated operator token"

# ---------------------------------------------------------------------------------------------------------
# Graceful restart on the prior version — the token and the seeded state survive.
# ---------------------------------------------------------------------------------------------------------
step "graceful restart on the prior version"
( cd "${EXTRACTED}" && docker compose restart app >/dev/null )
wait_health "prior restart"
[ "$(cat "${TOKEN_FILE}")" = "${token_before}" ] || fail "the operator token changed across a restart"
[ "$(pg_exec "SELECT note FROM lifecycle_marker WHERE id=1;" | tr -d '[:space:]')" = "phase249-marker" ] \
  || fail "the Postgres marker did not survive a restart"
info "restarted cleanly; token and Postgres state persisted"

# ---------------------------------------------------------------------------------------------------------
# Phase B — UPGRADE to the candidate: down (keep volumes) -> re-pin -> up. Nothing is lost.
# ---------------------------------------------------------------------------------------------------------
step "Phase B: upgrade to the candidate ${CANDIDATE_VERSION} (down keeps volumes, re-pin, up)"
keep_volumes_down
write_env "${CANDIDATE_IMAGE}" "${CANDIDATE_VERSION}"
rc_compose_up "${EXTRACTED}"
wait_health "candidate after upgrade"
assert_version "${CANDIDATE_VERSION}"
assert_records_visible
[ "$(cat "${TOKEN_FILE}")" = "${token_before}" ] || fail "the operator token was lost across the upgrade"
[ "$(pg_exec "SELECT note FROM lifecycle_marker WHERE id=1;" | tr -d '[:space:]')" = "phase249-marker" ] \
  || fail "the persisted Postgres state was lost across the upgrade"
info "upgraded to the candidate; version now reports the candidate; token, data and records all intact"

# ---------------------------------------------------------------------------------------------------------
# Phase C — ROLLBACK to the prior version: down (keep volumes) -> re-pin -> up. Still nothing is lost.
# ---------------------------------------------------------------------------------------------------------
step "Phase C: rollback to the prior version ${PRIOR_VERSION}"
keep_volumes_down
write_env "${PRIOR_IMAGE}" "${PRIOR_VERSION}"
rc_compose_up "${EXTRACTED}"
wait_health "prior after rollback"
assert_version "${PRIOR_VERSION}"
assert_records_visible
[ "$(cat "${TOKEN_FILE}")" = "${token_before}" ] || fail "the operator token was lost across the rollback"
[ "$(pg_exec "SELECT note FROM lifecycle_marker WHERE id=1;" | tr -d '[:space:]')" = "phase249-marker" ] \
  || fail "the persisted Postgres state was lost across the rollback"
info "rolled back to the prior version; version reports the prior; token, data and records all intact"

# ---------------------------------------------------------------------------------------------------------
# Server logs must not contain the token, whatever happened above.
# ---------------------------------------------------------------------------------------------------------
step "server logs carry no token"
( cd "${EXTRACTED}" && docker compose logs --no-color > "${STAGING_DIR}/server-logs.txt" 2>&1 ) || true
if grep -qF "${TOKEN}" "${STAGING_DIR}/server-logs.txt"; then
  rm -f "${STAGING_DIR}/server-logs.txt"
  fail "the operator token appeared in the server logs"
fi
info "no token in server logs"

printf '\nrelease lifecycle acceptance: PASS (prior %s -> candidate %s -> rollback %s)\n' \
  "${PRIOR_VERSION}" "${CANDIDATE_VERSION}" "${PRIOR_VERSION}"
