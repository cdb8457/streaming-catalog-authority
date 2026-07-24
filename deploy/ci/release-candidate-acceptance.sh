#!/usr/bin/env bash
# Catalog Authority — Phase 248 release-candidate acceptance orchestrator.
#
# This is the check that closes the last evidence gap: the operator UI's browser behaviour was proven only
# through a deterministic fake DOM (Phase 247), and the machine most of this was developed on has no Docker
# daemon. This orchestrator assembles the EXACT consumer release artifact, extracts it into a fresh directory
# with no source checkout and no Node dependency, runs a locally-built production image through the EXTRACTED
# Compose stack, and drives a REAL headless Chromium browser against it — so "the release works in a browser"
# becomes a fact rather than an inference.
#
# It is a release-candidate ACCEPTANCE gate, not a publish step. It builds an image with a local-only tag,
# never logs in to a registry, never pushes, never tags a release, and never uploads an asset. Assembling and
# running are not publishing.
#
# PREREQUISITES: a running Docker daemon, `node`, and (for the browser leg) the pinned acceptance harness in
# deploy/ci/acceptance/. FAIL vs SKIP is explicit:
#   * REQUIRE_ACCEPTANCE=1 (what CI sets)  -> a missing prerequisite is a hard FAILURE (exit 1).
#     CI must not silently skip: if the daemon or the browser is absent on a runner that is supposed to have
#     them, that is a broken runner, not a pass.
#   * otherwise (a developer laptop)       -> a missing prerequisite is a SKIP (exit 3) with a clear message
#     that this leg is CI-required and was NOT executed. It never claims to have run.
#
# Boundaries: no live provider, media server or library; no promotion, approval, execution, archival or
# deletion; nothing published, pushed, tagged, merged or deployed.
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"

REQUIRE_ACCEPTANCE="${REQUIRE_ACCEPTANCE:-0}"
LOCAL_IMAGE="${CATALOG_AUTHORITY_RC_IMAGE:-catalog-authority-ops:rc-acceptance}"
BASE_URL="http://127.0.0.1:8099"
# The directory CI uploads on failure. It is populated ONLY by promoting redaction-passed artifacts out of
# the staging directory below, so a redaction-gate failure — or a kill before the gate ran — leaves it empty
# and the upload structurally safe. It is never where the browser or the log writer put anything directly.
ARTIFACT_DIR="${RC_ARTIFACT_DIR:-${REPO_ROOT}/dist/rc-acceptance-artifacts}"
# Where the browser and the log writer actually put artifacts. Redacted, then promoted, then removed. Never
# uploaded directly.
STAGING_DIR="${RC_STAGING_DIR:-${REPO_ROOT}/dist/rc-acceptance-staging}"
BUNDLE_DIR="${REPO_ROOT}/dist/rc-acceptance-bundle"
ARCHIVE_DIR="${REPO_ROOT}/dist/rc-acceptance-archive"
BROWSER_DIR="${REPO_ROOT}/deploy/ci/acceptance"
EXTRACTED=""              # set once the archive is extracted, so cleanup can find it
RC_COMPOSE_ATTEMPTED=0    # armed to 1 by rc_compose_up BEFORE `up`, so a partial-up failure still tears down
TOKEN=""                  # set once secrets exist; the cleanup trap uses it to gate artifacts

# The teardown helpers are a sourced, separately-tested library so the arm-before-up ordering has one
# implementation. Sourcing runs nothing and touches no docker.
# shellcheck source=deploy/ci/acceptance/rc-teardown.sh
source "${BROWSER_DIR}/rc-teardown.sh"

step() { printf '\n==> %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# SKIP path: distinct exit code 3, an unmistakable message, and NEVER under REQUIRE_ACCEPTANCE.
skip() {
  if [ "${REQUIRE_ACCEPTANCE}" = "1" ]; then
    fail "$1 (REQUIRE_ACCEPTANCE=1 — a CI runner that cannot run this is broken, not passing)"
  fi
  echo
  echo "SKIP: ${1}."
  echo "      The release-candidate browser+Compose acceptance was NOT executed here."
  echo "      It is CI-required and runs on Linux with a Docker daemon. Run it locally with:"
  echo "        REQUIRE_ACCEPTANCE=1 bash deploy/ci/release-candidate-acceptance.sh"
  echo "      once Docker is running, or rely on the CI job 'release-candidate'."
  exit 3
}

# ---------------------------------------------------------------------------------------------------------
# Teardown: ALWAYS runs, tears down only what we started, and never lets a cleanup error mask a real failure.
# ---------------------------------------------------------------------------------------------------------
cleanup() {
  local code=$?
  step "teardown (always)"
  # Tear the stack down whenever `up` was ATTEMPTED — armed before `up`, so a partial-up failure still gets
  # here. rc_compose_down is idempotent and scoped to the extracted project, so it can never touch anything
  # else and is safe even if `up` created nothing.
  if [ "${RC_COMPOSE_ATTEMPTED}" = "1" ]; then
    rc_compose_down "${EXTRACTED}"
    info "compose stack torn down (down -v), volumes removed"
  fi
  # The locally-built acceptance image is never pushed and is not a release artifact; remove it.
  docker image rm -f "${LOCAL_IMAGE}" >/dev/null 2>&1 || true

  # Gate then PROMOTE artifacts. The upload directory (ARTIFACT_DIR) is populated ONLY here, ONLY from staging
  # that passed the redaction gate. If the gate fails, or if we were killed before reaching it, nothing is
  # promoted and the upload directory stays empty — the upload is structurally safe, not merely scrubbed.
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
  rm -rf "${STAGING_DIR}" "${BUNDLE_DIR}" "${ARCHIVE_DIR}" "${BUNDLE_DIR}-repeat" "${ARCHIVE_DIR}-repeat" 2>/dev/null || true
  info "temporary bundle, staging and extraction directories removed"
  exit "${code}"
}
# The EXIT trap does the work. INT/TERM (a cancelled CI job, or Ctrl-C) re-exit so the EXIT trap runs once —
# best-effort local cleanup; CI's `if: always()` step is the outer net.
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

[ -f "${BROWSER_DIR}/operator-ui.spec.mjs" ] || fail "the acceptance spec is missing at ${BROWSER_DIR}"
if [ ! -d "${BROWSER_DIR}/node_modules/@playwright/test" ]; then
  skip "the pinned browser harness is not installed (run: npm --prefix deploy/ci/acceptance ci && npx --prefix deploy/ci/acceptance playwright install --with-deps chromium)"
fi
info "pinned Playwright harness present"

# Start from a clean staging directory; the upload directory is created only when artifacts pass redaction.
rm -rf "${STAGING_DIR}" "${ARTIFACT_DIR}"
mkdir -p "${STAGING_DIR}"

# ---------------------------------------------------------------------------------------------------------
# 1. Assemble the exact consumer release bundle and archive, from source, the way the release does.
# ---------------------------------------------------------------------------------------------------------
step "assemble the consumer release bundle and archive"
rm -rf "${BUNDLE_DIR}" "${ARCHIVE_DIR}"
node --import tsx src/ops/consumer-release-bundle-cli.ts --out "${BUNDLE_DIR}" --archive-dir "${ARCHIVE_DIR}" >/dev/null
ARCHIVE_PATH="$(ls "${ARCHIVE_DIR}"/*.tar.gz)"
info "assembled $(basename "${ARCHIVE_PATH}")"

RC_VERSION="$(grep '^version: ' "${BUNDLE_DIR}/VERSION" | cut -d' ' -f2-)"
RC_REVISION="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
[ -n "${RC_VERSION}" ] || fail "the assembled bundle declared no version"
info "release-candidate version ${RC_VERSION}, revision ${RC_REVISION}"

# ---------------------------------------------------------------------------------------------------------
# 2. Extract into a fresh directory that has NO source checkout and NO Node dependency — the standalone test.
# ---------------------------------------------------------------------------------------------------------
step "extract the archive into a fresh standalone directory"
EXTRACTED="$(mktemp -d)"
tar -xzf "${ARCHIVE_PATH}" -C "${EXTRACTED}"
roots="$(ls "${EXTRACTED}")"
[ "$(printf '%s\n' "${roots}" | wc -l)" -eq 1 ] || fail "the archive did not extract into a single directory: ${roots}"
EXTRACTED="${EXTRACTED}/${roots}"
info "extracted to a directory named ${roots}"

for forbidden in package.json package-lock.json node_modules src tsconfig.json Dockerfile Dockerfile.runtime .git; do
  [ -e "${EXTRACTED}/${forbidden}" ] && fail "the extracted release contains ${forbidden} — it is not standalone"
done
if ls "${EXTRACTED}"/*.ts >/dev/null 2>&1; then fail "the extracted release ships TypeScript"; fi
info "no package.json, no src, no node_modules, no toolchain in the extracted release"

# ---------------------------------------------------------------------------------------------------------
# 3. Build the production image LOCALLY with a local-only tag. Controlled, never pushed, never a release.
# ---------------------------------------------------------------------------------------------------------
step "build the production image locally (local-only tag, never published)"
docker build \
  --file Dockerfile.runtime \
  --tag "${LOCAL_IMAGE}" \
  --build-arg "IMAGE_VERSION=${RC_VERSION}" \
  --build-arg "IMAGE_REVISION=${RC_REVISION}" \
  . >/dev/null
info "built ${LOCAL_IMAGE} with version=${RC_VERSION}"

# Point the EXTRACTED bundle's .env at the locally built image so the standalone stack runs a prebuilt image
# with no registry pull and no source. The bundle's own version declaration is left exactly as shipped, so
# the UI's image-vs-bundle agreement is a real comparison.
step "pin the extracted stack to the local image"
tmp_env="$(mktemp)"
grep -v '^CATALOG_AUTHORITY_IMAGE=' "${EXTRACTED}/.env" > "${tmp_env}"
printf 'CATALOG_AUTHORITY_IMAGE=%s\n' "${LOCAL_IMAGE}" >> "${tmp_env}"
mv "${tmp_env}" "${EXTRACTED}/.env"
info "extracted .env points at ${LOCAL_IMAGE}; CATALOG_AUTHORITY_BUNDLE_VERSION left as shipped"

# ---------------------------------------------------------------------------------------------------------
# 4. Generate secrets INSIDE the extracted directory, and read the token WITHOUT printing it.
# ---------------------------------------------------------------------------------------------------------
step "generate secrets in the extracted directory (token never printed)"
( cd "${EXTRACTED}" && bash ./setup.sh >/dev/null 2>&1 ) || fail "the bundle's setup.sh failed"
TOKEN_FILE="${EXTRACTED}/secrets/operator_ui_token"
[ -s "${TOKEN_FILE}" ] || fail "setup.sh did not create an operator token"
TOKEN="$(cat "${TOKEN_FILE}")"
# Keep the fixture token out of the CI log even if something later echoes it.
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::${TOKEN}"; fi
info "secrets generated; operator token read from disk and masked"

# A hostile promotion record, so the real browser proves a displayed hostile string is never executed. It is
# written to the read-only-mounted records folder BEFORE the stack starts.
mkdir -p "${EXTRACTED}/promotion-records"
printf '%s' '{"phase":231,"note":"<img src=x onerror=window.__xss=1><script>window.__xss=1</script>"}' \
  > "${EXTRACTED}/promotion-records/phase-231-hostile.json"
info "planted a hostile-string record for the browser to render safely"

# ---------------------------------------------------------------------------------------------------------
# 5. Start the EXTRACTED stack. Standalone: one compose file, no override, no source.
# ---------------------------------------------------------------------------------------------------------
step "start the extracted standalone stack"
# rc_compose_up ARMS teardown (RC_COMPOSE_ATTEMPTED=1) BEFORE `up`, so a partial-up failure still tears down.
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
info "/healthz is 200"

# ---------------------------------------------------------------------------------------------------------
# 6. The standalone container contract, from outside the browser.
# ---------------------------------------------------------------------------------------------------------
step "prove the standalone container contract"
app_cid="$( cd "${EXTRACTED}" && docker compose ps -q app )"
[ -n "${app_cid}" ] || fail "could not find the app container"

inspect() { docker inspect --format "$1" "${app_cid}"; }
[ "$(inspect '{{.HostConfig.ReadonlyRootfs}}')" = "true" ] || fail "the app container is not read-only"
[ "$(inspect '{{.Config.User}}')" = "node" ] || fail "the app container does not run as the non-root node user"
[ "$(inspect '{{.HostConfig.SecurityOpt}}')" = "[no-new-privileges:true]" ] || fail "no-new-privileges is not set"
case "$(inspect '{{.HostConfig.CapDrop}}')" in *ALL*) ;; *) fail "the app container does not drop ALL capabilities" ;; esac
# No Docker socket may be mounted into any container in this stack.
if ( cd "${EXTRACTED}" && docker compose ps -q ) | xargs -r -n1 docker inspect --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' | grep -q 'docker.sock'; then
  fail "a container mounts the Docker socket"
fi
# The record mount is read-only.
if ! inspect '{{range .Mounts}}{{if eq .Destination "/var/lib/catalog/promotion-records"}}{{.RW}}{{end}}{{end}}' | grep -q '^false$'; then
  fail "the promotion-records mount is not read-only"
fi
# The database is not published to the host — asserted over the container's ACTUAL host bindings. Note that
# `docker compose ps --format '{{.Publishers}}'` reports the container TARGET port (5432) even when nothing is
# bound to a host interface, so grepping it cannot distinguish an exposed-only port from a published one; the
# container's own NetworkSettings.Ports is the authoritative source, and the tested predicate reads exactly it.
pg_cid="$( cd "${EXTRACTED}" && docker compose ps -q postgres )"
[ -n "${pg_cid}" ] || fail "could not find the postgres container"
if ! docker inspect --format '{{json .NetworkSettings.Ports}}' "${pg_cid}" \
     | ( cd "${REPO_ROOT}" && node --import tsx src/ops/container-port-publication-cli.ts --port 5432/tcp ) >/dev/null; then
  fail "the database port is published to the host"
fi
info "read-only rootfs, non-root, no-new-privileges, cap-drop ALL, no docker socket, ro record mount, unpublished db"

# ---------------------------------------------------------------------------------------------------------
# 7. Drive a REAL headless Chromium browser against the running stack.
# ---------------------------------------------------------------------------------------------------------
step "real-browser acceptance (headless Chromium)"
# The browser writes into STAGING, never the upload directory. Its artifacts reach the upload directory only
# after the redaction gate passes, in cleanup.
set +e
OPERATOR_UI_ACCEPTANCE_TOKEN="${TOKEN}" \
OPERATOR_UI_ACCEPTANCE_BASE_URL="${BASE_URL}" \
OPERATOR_UI_ACCEPTANCE_VERSION="${RC_VERSION}" \
PLAYWRIGHT_ARTIFACT_DIR="${STAGING_DIR}" \
  npx --prefix "${BROWSER_DIR}" playwright test \
    --config "${BROWSER_DIR}/playwright.config.mjs"
browser_status=$?
set -e

# ---------------------------------------------------------------------------------------------------------
# 8. Server logs must not contain the token, whatever the browser did.
# ---------------------------------------------------------------------------------------------------------
step "server logs carry no token"
( cd "${EXTRACTED}" && docker compose logs --no-color > "${STAGING_DIR}/server-logs.txt" 2>&1 ) || true
if grep -qF "${TOKEN}" "${STAGING_DIR}/server-logs.txt"; then
  # An early, loud failure. The redaction gate in cleanup is the backstop; this makes the cause explicit.
  rm -f "${STAGING_DIR}/server-logs.txt"
  fail "the operator token appeared in the server logs"
fi
info "no token in server logs"

# ---------------------------------------------------------------------------------------------------------
# 9. Graceful restart and persistence of safe local state (the generated secrets survive).
# ---------------------------------------------------------------------------------------------------------
step "graceful restart and persistence"
before="$(cat "${TOKEN_FILE}")"
( cd "${EXTRACTED}" && docker compose restart app >/dev/null )
healthy=""
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "${BASE_URL}/healthz"; then healthy=yes; break; fi
  sleep 2
done
[ -n "${healthy}" ] || fail "the stack did not come back healthy after a restart"
after="$(cat "${TOKEN_FILE}")"
[ "${before}" = "${after}" ] || fail "the operator token did not persist across a restart"
info "restarted cleanly; operator token persisted"

# The artifacts are gated and promoted by the always-cleanup trap, which runs after this point on every exit
# path — a failed browser run has its staged artifacts redacted, and only the survivors reach the upload
# directory.
if [ "${browser_status}" -ne 0 ]; then
  fail "the real-browser acceptance reported failures (sanitized diagnostics will be in ${ARTIFACT_DIR})"
fi

printf '\nrelease-candidate acceptance: PASS (version %s)\n' "${RC_VERSION}"
