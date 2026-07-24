#!/usr/bin/env bash
# Catalog Authority — assemble the consumer install bundle and its release archive, then check both the way
# a user would.
#
# The bundle's promise is "you need Docker and nothing else", so this verifies it from OUTSIDE: checksums are
# verified with sha256sum, the archive is extracted with the system tar, the extracted tree is compared
# byte-for-byte against the assembled bundle, and the Docker CLI resolves the stack with the EXTRACTED
# directory as the whole project. Then the archive is built a second time and the two digests compared,
# because a release asset nobody can reproduce cannot be checked against anything.
#
# Assembling is not publishing. Nothing here pushes, tags or uploads.
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"

OUT="${1:-dist/release-bundle}"
ARCHIVE_DIR="${2:-dist/release-archive}"
step() { printf '\n==> %s\n' "$1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

step "assemble ${OUT} and ${ARCHIVE_DIR}"
rm -rf "${ARCHIVE_DIR}"
node --import tsx src/ops/consumer-release-bundle-cli.ts --out "${OUT}" --archive-dir "${ARCHIVE_DIR}" \
  ${RELEASE_IMAGE_DIGEST:+--digest "${RELEASE_IMAGE_DIGEST}"} \
  ${RELEASE_IMAGE_TAG:+--tag "${RELEASE_IMAGE_TAG}"} \
  ${RELEASE_IMAGE_REPOSITORY:+--repository "${RELEASE_IMAGE_REPOSITORY}"}

BUNDLE_DIR="${REPO_ROOT}/${OUT}"
ARCHIVE_PATH="$(ls "${REPO_ROOT}/${ARCHIVE_DIR}"/*.tar.gz)"
ARCHIVE_FILE="$(basename "${ARCHIVE_PATH}")"

step "the bundle's own checksums verify"
(cd "${BUNDLE_DIR}" && sha256sum -c SHA256SUMS)

step "nothing in the bundle needs Node.js or a checkout"
for forbidden in package.json package-lock.json node_modules src tsconfig.json Dockerfile secrets; do
  if [ -e "${BUNDLE_DIR}/${forbidden}" ]; then fail "the bundle ships ${forbidden}"; fi
done
if ls "${BUNDLE_DIR}"/*.ts >/dev/null 2>&1; then fail "the bundle ships TypeScript"; fi
if grep -qE '^[[:space:]]*build:' "${BUNDLE_DIR}/docker-compose.yml"; then fail "the shipped Compose file builds from source"; fi
if grep -qE ':latest([^A-Za-z0-9.-]|$)' "${BUNDLE_DIR}/docker-compose.yml" "${BUNDLE_DIR}/.env"; then
  fail "the bundle points at a floating tag"
fi
echo "  no source, no manifest, no toolchain, no secrets, no floating tag"

step "the release archive's checksum verifies on its own"
(cd "${REPO_ROOT}/${ARCHIVE_DIR}" && sha256sum -c "${ARCHIVE_FILE}.sha256")

step "the archive extracts to exactly the bundle that was just checked"
EXTRACT_DIR="$(mktemp -d)"
trap 'rm -rf "${EXTRACT_DIR}"' EXIT
tar -xzf "${ARCHIVE_PATH}" -C "${EXTRACT_DIR}"
roots="$(ls "${EXTRACT_DIR}")"
[ "$(printf '%s\n' "${roots}" | wc -l)" -eq 1 ] || fail "the archive does not extract into a single directory: ${roots}"
EXTRACTED="${EXTRACT_DIR}/${roots}"
diff -r "${BUNDLE_DIR}" "${EXTRACTED}" || fail "the archive and the checked bundle differ"
echo "  extracted ${roots} is byte-identical to ${OUT}"

step "the extracted archive stands alone as a Compose project"
(cd "${EXTRACTED}" && sha256sum -c SHA256SUMS >/dev/null && docker compose config --quiet)
echo "  docker compose config: OK, with no Node.js and no checkout involved"

step "the archive is reproducible"
SECOND_DIR="${REPO_ROOT}/${ARCHIVE_DIR}-repeat"
rm -rf "${SECOND_DIR}" "${REPO_ROOT}/${OUT}-repeat"
node --import tsx src/ops/consumer-release-bundle-cli.ts --out "${OUT}-repeat" --archive-dir "${ARCHIVE_DIR}-repeat" \
  --created "$(grep '^built: ' "${BUNDLE_DIR}/VERSION" | cut -d' ' -f2-)" \
  --revision "$(grep '^source_revision: ' "${BUNDLE_DIR}/VERSION" | cut -d' ' -f2-)" \
  ${RELEASE_IMAGE_DIGEST:+--digest "${RELEASE_IMAGE_DIGEST}"} \
  ${RELEASE_IMAGE_TAG:+--tag "${RELEASE_IMAGE_TAG}"} \
  ${RELEASE_IMAGE_REPOSITORY:+--repository "${RELEASE_IMAGE_REPOSITORY}"} >/dev/null
first="$(cut -d' ' -f1 < "${REPO_ROOT}/${ARCHIVE_DIR}/${ARCHIVE_FILE}.sha256")"
second="$(cut -d' ' -f1 < "${SECOND_DIR}/${ARCHIVE_FILE}.sha256")"
[ "${first}" = "${second}" ] || fail "two builds of the same inputs produced different archives (${first} vs ${second})"
rm -rf "${SECOND_DIR}" "${REPO_ROOT}/${OUT}-repeat"
echo "  same inputs, same archive digest: ${first}"

step "the verification packet is generated, reproducible, and verifies the archive it describes"
# Phase 251. A consumer-facing packet that ships ALONGSIDE the archive: it records the archive digest, every
# bundle file's digest, a minimal SBOM built from the committed lockfile, and copy-paste verification commands.
# It is emitted with the SAME coordinates as the assembled archive (read back from VERSION so it reproduces),
# then the assembled archive is verified against it offline — a packet that does not describe what shipped is a
# hard failure here, before anything is ever attached to a release.
PACKET_PATH="${ARCHIVE_PATH}.verification.json"
BUILT="$(grep '^built: ' "${BUNDLE_DIR}/VERSION" | cut -d' ' -f2-)"
REVISION="$(grep '^source_revision: ' "${BUNDLE_DIR}/VERSION" | cut -d' ' -f2-)"
emit_packet() {
  node --import tsx src/ops/release-verification-cli.ts --emit-packet --out "$1" \
    --created "${BUILT}" --revision "${REVISION}" --generated-at "${BUILT}" \
    ${RELEASE_IMAGE_DIGEST:+--digest "${RELEASE_IMAGE_DIGEST}"} \
    ${RELEASE_IMAGE_TAG:+--tag "${RELEASE_IMAGE_TAG}"} \
    ${RELEASE_IMAGE_REPOSITORY:+--repository "${RELEASE_IMAGE_REPOSITORY}"} >/dev/null
}
emit_packet "${PACKET_PATH}"
REPEAT_PACKET="$(mktemp)"
emit_packet "${REPEAT_PACKET}"
diff "${PACKET_PATH}" "${REPEAT_PACKET}" >/dev/null || fail "two emissions of the same inputs produced different packets"
rm -f "${REPEAT_PACKET}"
node --import tsx src/ops/release-verification-cli.ts --verify \
  --archive "${ARCHIVE_PATH}" --packet "${PACKET_PATH}" >/dev/null
echo "  verification packet: reproducible and VERIFIED against ${ARCHIVE_FILE}"

printf '\nrelease bundle check: PASS (%s)\n' "${ARCHIVE_FILE}"
