#!/usr/bin/env bash
# The privileged FUSE smoke run.
#
# It needs /dev/fuse and CAP_SYS_ADMIN, which is exactly why it is a separate script and a separate Compose
# service rather than something the ordinary gates inherit. It SKIPS with an explicit reason where the
# capability is genuinely absent, and it is bounded so a hang fails the gate rather than occupying the host.
set -euo pipefail

if [ ! -e /dev/fuse ]; then
  echo "SKIP: this host has no /dev/fuse, so a mount cannot be exercised here." >&2
  echo "      Contract, unit and fake-Range gates still ran; mount behaviour is unproven on this machine." >&2
  exit 0
fi

echo "=== projectiond FUSE smoke (privileged, bounded) ==="
timeout 300 docker compose -f docker-compose.projectiond.yml run --rm -T fuse-smoke
