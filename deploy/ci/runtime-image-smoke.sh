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

step "the UI shell is served"
curl -fsS "${BASE_URL}/" | grep -q 'Promotion Record Chain'
echo "  the promotion chain panel is present"

step "graceful stop"
# `docker compose stop` sends SIGTERM. A container that needed to be killed took the full timeout; one that
# handles its signals is gone in well under it.
start="$(date +%s)"
"${COMPOSE[@]}" stop -t 20 app
elapsed=$(( $(date +%s) - start ))
if [ "${elapsed}" -ge 20 ]; then echo "FAIL: the app ignored SIGTERM and had to be killed" >&2; exit 1; fi
echo "  stopped in ${elapsed}s"

printf '\nruntime image smoke: PASS\n'
