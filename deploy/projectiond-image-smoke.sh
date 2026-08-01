#!/usr/bin/env bash
# Build the projectiond image and prove the image OPERATORS WILL RUN can actually serve a mount.
#
# TWO SHAPES, TESTED SEPARATELY, BECAUSE THEY NEED DIFFERENT AUTHORITY.
#
#   1. CONFIG/VERSION shape — non-root, read-only root filesystem, every capability dropped, no network. This
#      is what the image does when it is not mounting, and it needs nothing at all.
#
#   2. MOUNT shape — the same built image and the same binary, given exactly the narrow authority a FUSE mount
#      requires: /dev/fuse, CAP_SYS_ADMIN, and root inside the container. That authority is real, and it is
#      documented rather than hidden; this is an experimental Phase 1 image and the mount is the point of it.
#      A second, ordinary container then reads the mount through bind propagation, which is what a media
#      server on the same host would do.
#
# Everything is bounded: a hang fails the gate rather than occupying the machine.
set -euo pipefail
export MSYS_NO_PATHCONV=1

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
GO_IMAGE="golang:1.26.5-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
# Per-run, so a crashed earlier gate or a parallel run cannot collide with this one.
MOUNT_CONTAINER="projectiond-image-mount-gate-$$"
# The work directory lives beside the repository rather than in /tmp. Bind propagation requires the host path
# to be on a shared mount, and on Docker Desktop the shared-folder path is the one that qualifies; a Git Bash
# /tmp resolves inside the Linux VM, where it is not shared.
# A UNIQUE directory per run. Docker Desktop caches bind-source state in its VM, and reusing a path that
# previously held a FUSE mount makes the next run fail with a bare "mkdir: file exists" that has nothing to do
# with the daemon. The parent is removed on the way out; the run-specific child is what gets bound.
GATE_ROOT="$PWD/.projectiond-image-gate"
WORK="$GATE_ROOT/run-$$"

cleanup() {
  docker rm -f "$MOUNT_CONTAINER" >/dev/null 2>&1 || true
  # A FUSE mount left behind by a killed run would make the directory unremovable from the host, so it is
  # detached from inside a container first. Both paths are confined to this run's own directory.
  if [ -n "${WORK:-}" ] && [ -d "$WORK" ]; then
    docker run --rm --privileged -v "$GATE_ROOT:/gate" "$VERIFY_IMAGE"       sh -c "umount -l /gate/$(basename "$WORK")/mnt 2>/dev/null; rm -rf /gate/$(basename "$WORK")" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== building $IMAGE ==="
docker build -t "$IMAGE" ./projectiond

# ----------------------------------------------------------------------------------------------------------
# 1. The shape that needs no authority at all.
# ----------------------------------------------------------------------------------------------------------
echo "=== version, as non-root on a read-only filesystem with no capabilities and no network ==="
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  --network none --user 65532:65532 "$IMAGE" --version

echo "=== a configuration it cannot serve is refused, not mounted ==="
if docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
    --network none --user 65532:65532 "$IMAGE" --config /nonexistent.json --check-config; then
  echo "the daemon accepted a configuration it cannot read" >&2
  exit 1
fi

# ----------------------------------------------------------------------------------------------------------
# 2. The mount shape: the same image, the narrow authority a mount needs, verified from outside.
# ----------------------------------------------------------------------------------------------------------
# The capability is probed INSIDE a container. Checking the host path would falsely skip on Docker Desktop,
# where /dev/fuse exists in the Linux VM but not on the Windows host.
if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIP: no /dev/fuse is reachable from a container on this host, so the MOUNT shape is UNPROVEN here." >&2
  echo "      The config/version shape above still passed." >&2
  exit 0
fi

mkdir -p "$WORK/manifest" "$WORK/media" "$WORK/cache" "$WORK/mnt"
chmod 777 "$WORK/cache" "$WORK/mnt"

echo "=== seeding a manifest generation and its backing media ==="
# mkfixture is a gate tool built from the same module. The production image contains no way to author a
# manifest, deliberately: a data plane that can write one is a data plane that can disagree with the control
# plane.
docker run --rm -v "$PWD:/workspace" -w /workspace/projectiond \
  -v "$WORK:/work" -e GOFLAGS=-buildvcs=false -e GOTOOLCHAIN=local -e CGO_ENABLED=0 \
  "$GO_IMAGE" go run ./cmd/mkfixture --manifest-dir /work/manifest --media-dir /work/media --entries 3

cat > "$WORK/config.json" <<'JSON'
{
  "mountPoint": "/mnt/projection",
  "pointerPath": "/var/lib/projectiond/manifest/pointer.json",
  "probeCacheDir": "/var/lib/projectiond/cache",
  "localRoots": { "media": "/var/lib/projectiond/media" }
}
JSON

# --strict-direct-mount REFUSES the fusermount suid helper, so a pass here proves the shipped image mounted
# BY SYSCALL. The image contains no helper at all, so without the flag a silent fallback would fail later and
# far less clearly — which is exactly what happened before the mount flags were corrected.
echo "=== mounting with the production image (root + CAP_SYS_ADMIN + /dev/fuse, strict direct mount) ==="
docker run -d --name "$MOUNT_CONTAINER" \
  --user 0:0 \
  --cap-drop ALL --cap-add SYS_ADMIN \
  --security-opt apparmor:unconfined \
  --device /dev/fuse:/dev/fuse \
  --network none \
  -v "$WORK/manifest:/var/lib/projectiond/manifest:ro" \
  -v "$WORK/media:/var/lib/projectiond/media:ro" \
  -v "$WORK/cache:/var/lib/projectiond/cache" \
  -v "$WORK/config.json:/etc/projectiond/config.json:ro" \
  -v "$WORK/mnt:/mnt/projection:rshared" \
  "$IMAGE" --config /etc/projectiond/config.json --poll 5s --strict-direct-mount >/dev/null

# Wait for the namespace to appear THROUGH PROPAGATION, which is the property a media server depends on.
echo "=== waiting for the mount to become visible to another container ==="
ready=0
for _ in $(seq 1 40); do
  if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" test -d /mnt/Movies >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "the mount never became visible to another container. Daemon output:" >&2
  docker logs "$MOUNT_CONTAINER" 2>&1 | tail -20 >&2
  exit 1
fi

# NON-ROOT, NO CAPABILITIES — which is how a media server actually runs. A mount only root can read is a
# mount the product cannot use, and it would pass a root-only verifier happily.
#
# The verifier lives in its own file rather than in a multi-line quoted argument: this repository's script
# gate parses every shipped script line by line, and an argument whose quote spans lines is unreadable to it.
cat > "$WORK/verify.sh" <<'VERIFY'
set -eu
echo "--- running as uid $(id -u), gid $(id -g)"
test "$(id -u)" != "0" || { echo "the verifier is root; that proves nothing about a media server" >&2; exit 1; }

echo "--- listing"
ls -l /mnt/Movies
target="$(find /mnt/Movies -name "*.bin" | head -n 1)"
test -n "$target" || { echo "no projected file found" >&2; exit 1; }

echo "--- stat"
stat -c "size=%s mode=%a links=%h" "$target"
test "$(stat -c %a "$target")" = "444" || { echo "the namespace is not read-only" >&2; exit 1; }
test ! -L "$target" || { echo "a media server can see a symlink" >&2; exit 1; }

echo "--- full read, hashed against a digest recorded outside the mount"
bytes="$(wc -c < "$target")"
test "$bytes" = "$(stat -c %s "$target")" || { echo "a full read did not match the declared size" >&2; exit 1; }
actual="$(sha256sum "$target" | cut -d" " -f1)"
echo "actual $actual"
if ! grep -q "^$actual  " /expected/expected-sha256.txt; then
  echo "the bytes read through the mount match no expected digest" >&2
  exit 1
fi
echo "matched an expected digest"

echo "--- seek"
dd if="$target" bs=1024 skip=64 count=1 2>/dev/null | wc -c

echo "--- mutations must be refused"
# Each attempt runs in a SUBSHELL. A redirection failure on a POSIX special builtin is fatal to the shell even
# inside an if-condition, so testing inline would abort the verifier on the first correct refusal.
( true > "$target" ) 2>/dev/null && { echo "truncate succeeded" >&2; exit 1; }
( rm -f "$target" ) 2>/dev/null && test ! -e "$target" && { echo "unlink succeeded" >&2; exit 1; }
( mkdir /mnt/newdir ) 2>/dev/null && { echo "mkdir succeeded" >&2; exit 1; }
( echo x > /mnt/newfile ) 2>/dev/null && { echo "create succeeded" >&2; exit 1; }
( ln -s /etc/passwd /mnt/link ) 2>/dev/null && { echo "symlink succeeded" >&2; exit 1; }
test -e "$target" || { echo "the file disappeared during the mutation attempts" >&2; exit 1; }
echo "--- every mutation refused, and the file is intact"
VERIFY

echo "=== reading it from an ordinary NON-ROOT container, as a media server would ==="
docker run --rm --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges   -v "$WORK/mnt:/mnt:rslave"   -v "$WORK/manifest:/expected:ro"   -v "$WORK/verify.sh:/verify.sh:ro"   "$VERIFY_IMAGE" sh /verify.sh

echo "=== unmounting ==="
docker stop -t 15 "$MOUNT_CONTAINER" >/dev/null
if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" test -d /mnt/Movies >/dev/null 2>&1; then
  echo "the namespace is still visible after the daemon stopped" >&2
  exit 1
fi

echo
echo "projectiond image smoke PASSED. Exactly what was proved, and with exactly what authority:"
echo "  - config/version shape: non-root (65532), read-only rootfs, ALL capabilities dropped, no network."
echo "  - mount shape, SAME image and binary: root INSIDE the container (uid 0), ALL capabilities dropped"
echo "    except CAP_SYS_ADMIN, --device /dev/fuse, --security-opt apparmor:unconfined, no network."
echo "    The mount was made by syscall (--strict-direct-mount refuses the fusermount helper, which this"
echo "    image does not contain)."
echo "  - the namespace was then listed, stat-ed, fully read and hashed against a digest recorded outside"
echo "    the mount, and seeked, by an ORDINARY NON-ROOT container (uid 65534, all capabilities dropped),"
echo "    which is how a media server actually runs. Every mutation was refused."
