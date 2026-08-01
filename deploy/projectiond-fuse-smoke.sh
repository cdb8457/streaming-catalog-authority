#!/usr/bin/env bash
# The privileged FUSE smoke run.
#
# It needs /dev/fuse and CAP_SYS_ADMIN, which is exactly why it is a separate script and a separate Compose
# service rather than something the ordinary gates inherit. It SKIPS with an explicit reason where the
# capability is genuinely absent, and it is bounded so a hang fails the gate rather than occupying the host.
set -euo pipefail

# THE CAPABILITY IS PROBED INSIDE A CONTAINER. Testing the HOST path would falsely skip on Docker Desktop,
# where /dev/fuse exists in the Linux VM but never on the Windows host — so this gate would have reported a
# green skip for the exact mount it is able to prove.
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
if ! MSYS_NO_PATHCONV=1 docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" \
    test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIP: no /dev/fuse is reachable from a container on this host, so a mount cannot be exercised." >&2
  echo "      Contract, unit and fake-Range gates still ran; mount behaviour is unproven on this machine." >&2
  exit 0
fi

echo "=== projectiond FUSE smoke (privileged, bounded) ==="
timeout 300 docker compose -f docker-compose.projectiond.yml run --rm -T fuse-smoke
