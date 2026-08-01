#!/usr/bin/env bash
# Build the projectiond image and prove it runs with production-shaped defaults.
#
# WHAT THIS ASSERTS. The binary starts as a NON-ROOT user with a READ-ONLY root filesystem and no capabilities
# at all, answers --version, and refuses a configuration it cannot serve. It deliberately does NOT mount:
# mounting needs /dev/fuse and CAP_SYS_ADMIN, and an image that could mount without them would be an image
# that had been granted something it did not need.
set -euo pipefail
# Git Bash on Windows rewrites container-absolute paths; this stops it mangling the argument below.
export MSYS_NO_PATHCONV=1

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"

echo "=== building $IMAGE ==="
docker build -t "$IMAGE" ./projectiond

echo "=== version, as non-root on a read-only filesystem with no capabilities ==="
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  --network none --user 65532:65532 "$IMAGE" --version

echo "=== a configuration it cannot serve is refused, not mounted ==="
if docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
    --network none --user 65532:65532 "$IMAGE" --config /nonexistent.json --check-config; then
  echo "the daemon accepted a configuration it cannot read" >&2
  exit 1
fi

echo "projectiond image smoke passed"
