#!/usr/bin/env bash
# Catalog Authority — assemble the consumer install bundle and check it the way a user would.
#
# The bundle's promise is "you need Docker and nothing else", so this verifies it from OUTSIDE: the
# checksums are verified with sha256sum, the Compose file is resolved by the Docker CLI with the bundle as
# the only project directory, and the bundle is searched for anything that would drag a user back to a
# source checkout or leak a secret.
#
# Assembling is not publishing. Nothing here pushes, tags or uploads.
set -euo pipefail

cd "$(dirname "$0")/../.."

OUT="${1:-dist/release-bundle}"
step() { printf '\n==> %s\n' "$1"; }

step "assemble ${OUT}"
node --import tsx src/ops/consumer-release-bundle-cli.ts --out "${OUT}" \
  ${RELEASE_IMAGE_DIGEST:+--digest "${RELEASE_IMAGE_DIGEST}"} \
  ${RELEASE_IMAGE_TAG:+--tag "${RELEASE_IMAGE_TAG}"}

cd "${OUT}"

step "checksums verify with the tool a user would reach for"
sha256sum -c SHA256SUMS

step "nothing here needs Node.js or a checkout"
for forbidden in package.json package-lock.json node_modules src tsconfig.json Dockerfile; do
  if [ -e "${forbidden}" ]; then echo "FAIL: the bundle ships ${forbidden}" >&2; exit 1; fi
done
if ls ./*.ts >/dev/null 2>&1; then echo "FAIL: the bundle ships TypeScript" >&2; exit 1; fi
echo "  no source, no manifest, no toolchain"

step "no secrets and no build"
if [ -e secrets ]; then echo "FAIL: the bundle ships a secrets directory" >&2; exit 1; fi
if grep -RIlqE '^[[:space:]]*build:' docker-compose.yml; then
  echo "FAIL: the shipped Compose file builds from source" >&2
  exit 1
fi
if grep -RIqE ':latest([^A-Za-z0-9.-]|$)' docker-compose.yml .env; then
  echo "FAIL: the bundle points at a floating tag" >&2
  exit 1
fi
echo "  no secrets, no build, no floating tag"

step "the Docker CLI resolves the stack with the bundle as the whole project"
docker compose config --quiet
echo "  docker compose config: OK"

printf '\nrelease bundle check: PASS\n'
