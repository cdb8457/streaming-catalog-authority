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
COMPOSE=(docker compose -f docker-compose.runtime.yml -f docker-compose.runtime.build.yml)
export CATALOG_AUTHORITY_DEV_IMAGE="${IMAGE}"

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
./deploy/local-runtime-setup.sh >/dev/null
TOKEN="$(cat ./secrets/operator_ui_token)"
# Keep the operator token out of the CI log even if a later command echoes it.
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::${TOKEN}"; fi

cleanup() { step "down"; "${COMPOSE[@]}" down -v --remove-orphans || true; }
trap cleanup EXIT

step "up"
"${COMPOSE[@]}" up -d

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
  *'"state":"READY"'*|*'"state":"NEEDS_SETUP"'*|*'"state":"DEGRADED"'*) ;;
  *) echo "FAIL: the readiness route returned no bounded state" >&2; exit 1 ;;
esac
# The container has real secrets and a real database here, so the two components a laptop cannot exercise
# must come back satisfied rather than merely present.
case "${readiness}" in
  *'"id":"secrets","title":"Secret files","state":"OK"'*) echo "  secrets resolve to OK from the mounted Docker secrets" ;;
  *) echo "FAIL: the readiness route did not report the mounted secrets as OK" >&2; echo "${readiness}" >&2; exit 1 ;;
esac
case "${readiness}" in
  *'"id":"database","title":"Database","state":"OK"'*|*'"id":"database","title":"Database","state":"MISSING"'*)
    echo "  the database was reached" ;;
  *) echo "FAIL: the readiness route could not reach the database in the compose stack" >&2; exit 1 ;;
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
printf '%s' "${shell}" | grep -q 'Promotion Record Chain'
printf '%s' "${shell}" | grep -q 'Setup &amp; Diagnostics'
printf '%s' "${shell}" | grep -q 'First-run checklist'
if printf '%s' "${shell}" | grep -qF "${TOKEN}"; then
  echo "FAIL: the served page contains the operator token" >&2
  exit 1
fi
echo "  the promotion chain, setup and checklist panels are present, with no token in the HTML"

step "graceful stop"
# `docker compose stop` sends SIGTERM. A container that needed to be killed took the full timeout; one that
# handles its signals is gone in well under it.
start="$(date +%s)"
"${COMPOSE[@]}" stop -t 20 app
elapsed=$(( $(date +%s) - start ))
if [ "${elapsed}" -ge 20 ]; then echo "FAIL: the app ignored SIGTERM and had to be killed" >&2; exit 1; fi
echo "  stopped in ${elapsed}s"

printf '\nruntime image smoke: PASS\n'
