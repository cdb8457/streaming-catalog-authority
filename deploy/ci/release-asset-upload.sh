#!/usr/bin/env bash
# Catalog Authority — attach the consumer download to the release that triggered this run.
#
# This is the step that makes a release usable by someone who is not logged into GitHub Actions: an
# `upload-artifact` upload expires and lives behind the Actions UI, while a release asset is a stable URL on
# the release page. It is the last thing the publish job does, and it is deliberately narrow — it uploads two
# files to ONE release, the one named by the tested release-ref gate, and it refuses everything else.
#
# It requires `contents: write`, which is why no other job has it.
set -euo pipefail

fail() { echo "FAIL: $1" >&2; exit 1; }

cd "$(dirname "$0")/../.." || fail "cannot reach the repository root from $0"

# Every path is quoted, everywhere, so a directory a user named with a space in it is one argument rather
# than two. Both `C:/dir` and `C:\dir` reach here intact: the value arrives through argv, so bash performs no
# escape processing on it, and Git Bash resolves either spelling.
ARCHIVE_DIR="${1:-dist/release-archive}"
: "${RELEASE_TAG:?RELEASE_TAG is required — it comes from the release-ref gate, never from github.ref_name}"
: "${ARCHIVE:?ARCHIVE is required — it comes from the release-ref gate}"

# A missing directory is a stated refusal rather than a raw `cd` error, so a failed release says what to fix.
[ -d "${ARCHIVE_DIR}" ] || fail "no archive directory at ${ARCHIVE_DIR}"
cd "${ARCHIVE_DIR}" || fail "cannot enter the archive directory ${ARCHIVE_DIR}"

[ -f "${ARCHIVE}" ] || fail "no archive at ${ARCHIVE_DIR}/${ARCHIVE}"
[ -f "${ARCHIVE}.sha256" ] || fail "no checksum at ${ARCHIVE_DIR}/${ARCHIVE}.sha256"

# The asset must belong to the release being published: its filename carries the tag, and the tag came from
# the gate. A mismatch here means two different versions were resolved somewhere upstream.
case "${ARCHIVE}" in
  *"${RELEASE_TAG}"*) ;;
  *) fail "archive ${ARCHIVE} does not carry the release tag ${RELEASE_TAG}" ;;
esac

echo "==> verifying ${ARCHIVE} before it is attached to ${RELEASE_TAG}"
sha256sum -c "${ARCHIVE}.sha256"

# Only ever touch a release that already exists and already has this exact tag. This step never creates a
# release, never moves a tag and never publishes a draft.
echo "==> confirming release ${RELEASE_TAG} exists"
actual="$(gh release view "${RELEASE_TAG}" --json tagName --jq .tagName)"
[ "${actual}" = "${RELEASE_TAG}" ] || fail "gh reports the release tag as ${actual}, not ${RELEASE_TAG}"

echo "==> attaching the archive and its checksum"
gh release upload "${RELEASE_TAG}" "${ARCHIVE}" "${ARCHIVE}.sha256" --clobber

printf '\nrelease asset upload: PASS (%s attached to %s)\n' "${ARCHIVE}" "${RELEASE_TAG}"
