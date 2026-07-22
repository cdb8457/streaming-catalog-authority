#!/usr/bin/env bash
# Catalog Authority — decide, once and out loud, what tag a release publishes under.
#
# A publish step that computes its own tag inline is where `latest` gets in. This refuses anything that is
# not an immutable vX.Y.Z (optionally with a pre-release suffix), which means a branch name, a commit sha,
# `main`, `latest` or an empty ref all fail the release rather than producing a moving tag.
set -euo pipefail

TAG="${1:-}"

if [ -z "${TAG}" ]; then
  echo "FAIL: no ref given to publish from" >&2
  exit 1
fi

if [ "${TAG}" = "latest" ]; then
  echo "FAIL: 'latest' is not a release. Publish an immutable version tag." >&2
  exit 1
fi

if ! printf '%s' "${TAG}" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "FAIL: '${TAG}' is not a vX.Y.Z release tag." >&2
  exit 1
fi

echo "publishing as ${TAG}"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "tag=${TAG}" >> "${GITHUB_OUTPUT}"
fi
