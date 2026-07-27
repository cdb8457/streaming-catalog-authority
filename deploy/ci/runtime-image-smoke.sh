#!/usr/bin/env bash
# Catalog Authority — daemon-backed smoke for the production operator UI image.
#
# This is the check that cannot be faked by reading files: it builds Dockerfile.runtime, asserts the
# container is what it claims to be, brings the real Compose stack up, proves the UI answers on its
# authenticated route and refuses an unauthenticated one, and tears the stack down again.
#
# It needs a RUNNING Docker daemon and is therefore a CI job, not a developer's laptop habit. Run it locally
# with `npm run smoke:runtime-image` when you have Docker running.
#
# It publishes nothing, pushes nothing, tags nothing beyond a local development tag, and contacts no media
# server, provider or library.
set -euo pipefail

cd "$(dirname "$0")/../.."

IMAGE="${CATALOG_AUTHORITY_DEV_IMAGE:-catalog-authority-ops:ci}"
BASE_URL="http://127.0.0.1:8099"
# Run the stack from the image THIS script just built, with NO build override layered on. The maintainer build
# override (docker-compose.runtime.build.yml) sets `pull_policy: build`, so layering it here would make
# `compose up` REBUILD the app image WITHOUT the IMAGE_VERSION/IMAGE_REVISION build args passed below — the
# rebuilt image would then report itself as 0.0.0-dev and /api/version would disagree with the build. So the
# stack runs the single runtime compose file and is pinned to the explicitly built image through
# CATALOG_AUTHORITY_IMAGE; compose finds that local tag already present and neither pulls nor rebuilds it.
COMPOSE=(docker compose -f docker-compose.runtime.yml)
export CATALOG_AUTHORITY_IMAGE="${IMAGE}"

step() { printf '\n==> %s\n' "$1"; }

step "build ${IMAGE} from Dockerfile.runtime"
docker build \
  --file Dockerfile.runtime \
  --tag "${IMAGE}" \
  --build-arg "IMAGE_VERSION=${IMAGE_VERSION:-0.0.0-ci}" \
  --build-arg "IMAGE_REVISION=$(git rev-parse HEAD 2>/dev/null || echo unknown)" \
  .

step "the image can tell a running process what it is"
# Phase 246. The OCI labels are build metadata that the app inside the container cannot read, so the version
# is ALSO baked into the environment. This proves the build argument actually reached it: a label-only image
# would leave the UI unable to answer "what version am I running?", which is the whole defect.
baked="$(docker run --rm --entrypoint printenv "${IMAGE}" CATALOG_AUTHORITY_VERSION)"
if [ "${baked}" != "${IMAGE_VERSION:-0.0.0-ci}" ]; then
  echo "FAIL: the image reports CATALOG_AUTHORITY_VERSION as '${baked}', not the version it was built with" >&2
  exit 1
fi
docker run --rm --entrypoint printenv "${IMAGE}" CATALOG_AUTHORITY_REVISION >/dev/null
echo "  CATALOG_AUTHORITY_VERSION is baked in and matches the build argument"

step "container contract"
uid="$(docker run --rm --entrypoint id "${IMAGE}" -u)"
if [ "${uid}" = "0" ]; then echo "FAIL: the runtime image runs as root" >&2; exit 1; fi
echo "  runs as uid ${uid} (non-root)"

# The entrypoint must be the service itself: no args prints usage and exits 0, which also proves tsx can
# load the TypeScript entrypoint inside the image.
docker run --rm --entrypoint node "${IMAGE}" --import tsx src/ops/operator-ui-service-cli.ts \
  | grep -q 'Catalog Authority Operator UI Service'
echo "  entrypoint starts the operator UI CLI"

# Development dependencies must not be in a shipped image.
for forbidden in typescript embedded-postgres @types/node; do
  if docker run --rm --entrypoint test "${IMAGE}" -e "node_modules/${forbidden}"; then
    echo "FAIL: ${forbidden} is present in the runtime image" >&2
    exit 1
  fi
done
echo "  no development dependencies"

step "generate secrets and the artifact folder"
# Invoked through `bash` on purpose: this script is tracked executable (100755), but a checkout that lost the
# mode bit — a zip export, a `core.fileMode=false` clone, a Windows working tree — would otherwise fail here
# with a bare "Permission denied" instead of running. The interpreter is named, so the run does not depend on
# the checkout's mode bit at all.
bash ./deploy/local-runtime-setup.sh >/dev/null
TOKEN="$(cat ./secrets/operator_ui_token)"
# Keep the operator token out of the CI log even if a later command echoes it.
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::${TOKEN}"; fi

cleanup() { step "down"; "${COMPOSE[@]}" down -v --remove-orphans || true; }
trap cleanup EXIT

step "up"
"${COMPOSE[@]}" up -d

# Phase 253. The migration is a one-shot the app is gated on, and this is the only place that ordering can be
# proven against a real daemon rather than read off a YAML file. `up -d` returning at all means Compose was
# satisfied that `migrate` completed successfully — but "completed" is worth reading back explicitly, because
# an exit code of 0 from a container that did nothing would satisfy Compose just as well as one that migrated.
step "the one-shot migration ran to completion before the app was allowed to start"
migrate_cid="$("${COMPOSE[@]}" ps -aq migrate)"
if [ -z "${migrate_cid}" ]; then
  echo "FAIL: no migrate container exists — the app is not gated on a migration at all" >&2
  "${COMPOSE[@]}" ps -a
  exit 1
fi
migrate_exit="$(docker inspect -f '{{.State.ExitCode}}' "${migrate_cid}")"
migrate_state="$(docker inspect -f '{{.State.Status}}' "${migrate_cid}")"
if [ "${migrate_state}" != "exited" ] || [ "${migrate_exit}" != "0" ]; then
  echo "FAIL: the migration container is ${migrate_state} with exit code ${migrate_exit}, expected exited/0" >&2
  "${COMPOSE[@]}" logs --tail 100 migrate
  exit 1
fi
migrate_log="$("${COMPOSE[@]}" logs --no-color migrate 2>&1 || true)"
# THE LEAK CHECK RUNS FIRST, before any branch that might echo this log as a diagnostic. Checking it second
# would mean the one path that dumps the log — a failed assertion — is also the one path that has not yet
# established the log is safe to print, and CI logs are public. Order matters here, not just presence.
case "${migrate_log}" in
  *'postgresql://'*|*"${TOKEN}"*)
    echo "FAIL: the migration log leaked a connection string or the operator token" >&2
    echo "       (the log is deliberately NOT echoed here)" >&2
    exit 1 ;;
esac
# The step codes it prints are a stable contract an operator is told to read; a silent success is not one.
case "${migrate_log}" in
  *'runtime-verify'*) echo "  migrate exited 0 having verified the runtime connection can read the schema" ;;
  *) echo "FAIL: the migration did not report verifying the runtime connection" >&2
     echo "${migrate_log}" >&2; exit 1 ;;
esac

step "wait for the container to report healthy"
healthy=""
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "${BASE_URL}/healthz"; then healthy=yes; break; fi
  sleep 2
done
if [ -z "${healthy}" ]; then
  echo "FAIL: /healthz never returned 200" >&2
  "${COMPOSE[@]}" ps
  "${COMPOSE[@]}" logs --tail 100 app
  exit 1
fi
echo "  /healthz is 200"

step "the non-root app user can read the mounted secrets (Phase 232 secret-delivery fix)"
# The defect this proves absent: Compose bind-mounts file secrets with the HOST file's ownership and mode, so
# a 0600 host secret is unreadable by the container's non-root `node` user — the app then refused startup in a
# restart loop. /healthz being 200 already implies the operator token was read at startup; this makes it
# explicit and unmissable by reading the token as the app's OWN user, from inside the running container, and
# confirming that user is not root. It reads one byte and prints nothing, so the secret never reaches the log.
appuid="$("${COMPOSE[@]}" exec -T app id -u | tr -d '\r')"
if [ "${appuid}" = "0" ]; then echo "FAIL: the app container runs as root" >&2; exit 1; fi
for secret in operator_ui_token database_url admin_database_url completion_secret custodian_kek; do
  if ! "${COMPOSE[@]}" exec -T app sh -c "head -c1 /run/secrets/${secret} >/dev/null 2>&1"; then
    echo "FAIL: the non-root app user (uid ${appuid}) cannot read /run/secrets/${secret}" >&2
    exit 1
  fi
done
echo "  the app runs as uid ${appuid} (non-root) and can read every mounted secret it needs"

step "the authenticated route is authenticated"
code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/promotion-chain")"
if [ "${code}" != "401" ]; then echo "FAIL: unauthenticated chain read returned ${code}, expected 401" >&2; exit 1; fi
echo "  no token -> 401"

step "the authenticated route answers with a token"
body="$(curl -s -H "X-Operator-UI-Secret: ${TOKEN}" "${BASE_URL}/api/promotion-chain")"
case "${body}" in
  *'"availability"'*) echo "  token -> a chain snapshot" ;;
  *) echo "FAIL: authenticated chain read returned no availability field" >&2; exit 1 ;;
esac

step "the readiness route is authenticated and answers inside a real container"
# Phase 246. This is the part a file-reading test cannot prove: that the secret files Compose mounts, the
# read-only records mount and the database service all resolve to the states the panel reports.
code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/installation")"
if [ "${code}" != "401" ]; then echo "FAIL: unauthenticated readiness read returned ${code}, expected 401" >&2; exit 1; fi
readiness="$(curl -s -H "X-Operator-UI-Secret: ${TOKEN}" "${BASE_URL}/api/installation")"
case "${readiness}" in
  *'"state":"READY"'*|*'"state":"READY_NO_RECORDS"'*|*'"state":"NEEDS_SETUP"'*|*'"state":"DEGRADED"'*) ;;
  *) echo "FAIL: the readiness route returned no bounded state" >&2
     echo "  observed: $(printf '%s' "${readiness}" | grep -o '"state":"[A-Z_]*"' | head -1)" >&2
     exit 1 ;;
esac
# Phase 253. This stack has real secrets, a real MIGRATED database and an empty records folder, so there is
# exactly one honest answer and the smoke asserts it rather than accepting any bounded value. "One of four"
# would have passed just as happily on the v1.1.0 behaviour this release exists to fix.
case "${readiness}" in
  *'"state":"READY_NO_RECORDS"'*) echo "  a working install with an empty records folder reports READY_NO_RECORDS" ;;
  *) echo "FAIL: a fully set-up stack with an empty records folder should report READY_NO_RECORDS" >&2
     echo "  observed: $(printf '%s' "${readiness}" | grep -o '"state":"[A-Z_]*"' | head -1)" >&2
     exit 1 ;;
esac
# And it says so as a separate fact, in words that cannot be read as a passing audit.
case "${readiness}" in
  *'"evidence":"NONE_LOADED"'*) ;;
  *) echo "FAIL: the readiness route did not report that no evidence is loaded" >&2; exit 1 ;;
esac
case "${readiness}" in
  *'not a passing audit'*'not an authorization'*) echo "  and states what an empty folder does NOT mean" ;;
  *) echo "FAIL: the readiness payload does not rule out reading an empty install as a passing audit" >&2; exit 1 ;;
esac
# The container has real secrets and a real database here, so the two components a laptop cannot exercise
# must come back satisfied rather than merely present.
case "${readiness}" in
  *'"id":"secrets","title":"Secret files","state":"OK"'*) echo "  secrets resolve to OK from the mounted Docker secrets" ;;
  *) echo "FAIL: the readiness route did not report the mounted secrets as OK" >&2; echo "${readiness}" >&2; exit 1 ;;
esac
# Phase 253 tightened this from "OK or MISSING" to "OK". MISSING means reachable-but-unmigrated, which was an
# acceptable outcome only while the stack had no migration step — it is EXACTLY the v1.1.0 first-run defect,
# and accepting it here would let that regression come back green.
case "${readiness}" in
  *'"id":"database","title":"Database","state":"OK"'*)
    echo "  the database was reached AND is migrated to the version this build requires" ;;
  *) echo "FAIL: the database is not migrated — the compose ordering did not do its job" >&2
     echo "  observed: $(printf '%s' "${readiness}" | grep -o '"id":"database"[^}]*' | head -1)" >&2
     exit 1 ;;
esac
# And no route may leak what it inspected, however real the values now are.
case "${readiness}" in
  *"${TOKEN}"*|*'/run/secrets/'*|*'postgresql://'*)
    echo "FAIL: the readiness payload leaked a secret, a path or a URL" >&2; exit 1 ;;
esac
echo "  readiness answers with a bounded state and leaks nothing"

step "the version route reports the version the image was built with"
version="$(curl -s -H "X-Operator-UI-Secret: ${TOKEN}" "${BASE_URL}/api/version")"
case "${version}" in
  *"\"version\":\"${IMAGE_VERSION:-0.0.0-ci}\""*) echo "  /api/version agrees with the build argument" ;;
  *) echo "FAIL: /api/version did not report the built version" >&2; echo "${version}" >&2; exit 1 ;;
esac

step "the support report is produceable from inside the container"
"${COMPOSE[@]}" exec -T app npm run --silent ops:support-report >/tmp/support-report.json
grep -q 'phase-246-operator-support-report' /tmp/support-report.json
if grep -qE 'postgres(ql)?://|/run/secrets/' /tmp/support-report.json; then
  echo "FAIL: the support report contains a URL or a secret path" >&2
  exit 1
fi
echo "  support report produced, with no URL and no secret path in it"

step "the UI shell is served"
shell="$(curl -fsS "${BASE_URL}/")"
grep -q 'Promotion Record Chain' <<<"${shell}"
grep -q 'Setup &amp; Diagnostics' <<<"${shell}"
grep -q 'First-run checklist' <<<"${shell}"
if grep -qF "${TOKEN}" <<<"${shell}"; then
  echo "FAIL: the served page contains the operator token" >&2
  exit 1
fi
echo "  the promotion chain, setup and checklist panels are present, with no token in the HTML"

# Phase 247. The hardening a file-reading test cannot prove: that a REAL browser fetching this page would be
# told, by the header the real server sent, to run only same-origin scripts and styles — and that the two
# assets those references point at are actually served, with the right type, from inside the built image.
step "the Content-Security-Policy is hardened and carries no unsafe-inline"
csp="$(curl -fsS -D - -o /dev/null "${BASE_URL}/" | tr -d '\r' | grep -i '^content-security-policy:')"
for token in "script-src 'self'" "style-src 'self'" "default-src 'none'" "object-src 'none'" "base-uri 'none'" "frame-ancestors 'none'"; do
  case "${csp}" in
    *"${token}"*) ;;
    *) echo "FAIL: the CSP is missing ${token}" >&2; echo "${csp}" >&2; exit 1 ;;
  esac
done
case "${csp}" in
  *unsafe-inline*|*unsafe-eval*) echo "FAIL: the CSP still allows unsafe-inline/unsafe-eval" >&2; echo "${csp}" >&2; exit 1 ;;
esac
# The shell must carry no inline script body and no inline style block — everything is external.
if grep -qiE '<style|<script>[^<]' <<<"${shell}"; then
  echo "FAIL: the shell still carries an inline script or style" >&2
  exit 1
fi
grep -q '<script src="/assets/app.js" defer></script>' <<<"${shell}"
grep -q '<link rel="stylesheet" href="/assets/app.css">' <<<"${shell}"
echo "  script-src/style-src are 'self', no unsafe-inline, and the shell references only external assets"

step "the static assets are served with the right type and no token"
js_type="$(curl -fsS -D - -o /dev/null "${BASE_URL}/assets/app.js" | tr -d '\r' | grep -i '^content-type:')"
css_type="$(curl -fsS -D - -o /dev/null "${BASE_URL}/assets/app.css" | tr -d '\r' | grep -i '^content-type:')"
case "${js_type}" in *text/javascript*) ;; *) echo "FAIL: app.js has the wrong content type: ${js_type}" >&2; exit 1 ;; esac
case "${css_type}" in *text/css*) ;; *) echo "FAIL: app.css has the wrong content type: ${css_type}" >&2; exit 1 ;; esac
if curl -fsS "${BASE_URL}/assets/app.js" | grep -qF "${TOKEN}"; then echo "FAIL: app.js contains the token" >&2; exit 1; fi
# A missing asset is a plain 404, not a directory listing or a served file from elsewhere.
miss="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/assets/nope.js")"
if [ "${miss}" != "404" ]; then echo "FAIL: an unknown asset returned ${miss}, expected 404" >&2; exit 1; fi
echo "  app.js is text/javascript, app.css is text/css, no token in either, unknown asset is 404"
# NOTE: a real headless-browser CSP-violation observer (e.g. Playwright reading the Reporting API) is the
# next rung of assurance above this. It is deliberately NOT added to the toolchain here — the runtime
# dependency closure is pinned to pg and tsx — and is called out as an explicit future CI extension rather
# than faked. The checks above assert, against a real browser-shaped request to the real image, every input
# a browser's CSP engine acts on.

step "graceful stop"
# `docker compose stop` sends SIGTERM. A container that needed to be killed took the full timeout; one that
# handles its signals is gone in well under it.
start="$(date +%s)"
"${COMPOSE[@]}" stop -t 20 app
elapsed=$(( $(date +%s) - start ))
if [ "${elapsed}" -ge 20 ]; then echo "FAIL: the app ignored SIGTERM and had to be killed" >&2; exit 1; fi
echo "  stopped in ${elapsed}s"

printf '\nruntime image smoke: PASS\n'
