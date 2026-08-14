#!/usr/bin/env bash
# THE MECHANISM BEHIND PROJECTION PHASE 7 §11.4 #16, MEASURED WITHOUT A DAEMON, A PROVIDER OR A MEDIA SERVER.
#
# WHY THIS EXISTS. §8.7.1 makes one load-bearing claim about the kernel, and every other sentence in that
# section rests on it: at a mount point whose propagation is `rshared`, a mount made inside a container
# SURVIVES the destruction of that container's mount namespace — because tearing a namespace down is not an
# unmount and does not propagate one — while a mount the process removes ITSELF, with `MNT_DETACH`, before it
# exits, is removed from the host too. The first half is why stopping the daemon left a layer; the second half
# is why the repair works. Both were previously arguments about the kernel supported by one measurement from a
# three-hour provider-facing run, and an argument about the kernel should be a program.
#
# WHAT IT IS NOT. It is not a Phase 7 arm, it is not evidence about the product, and it proves nothing about
# `projectiond` — it uses `tmpfs`, deliberately, because the claim is about MOUNT PROPAGATION and a FUSE
# filesystem would add a transport, a serve loop and a corpse to a measurement that needs none of them. The
# product-level assertion is `P7-R3-restart-left-no-layer` in the Phase 7 gate, on the real topology, with
# three real media servers attached. This is the thing that says WHY that assertion is the right one.
#
# NOTHING OUTSIDE THE THROWAWAY CONTAINER IS TOUCHED. Every mount it makes is on a `tmpfs` created inside the
# container, so the "host" in the measurement below is the container's own root namespace and the real host's
# mount table is never written to. The one bind it takes is this probe's own run directory, READ-ONLY, holding
# nothing but the program below. It reaches no network after the image is present and holds no operator input.
set -euo pipefail

export MSYS_NO_PATHCONV=1

# PINNED BY DIGEST, like every other image these gates start. util-linux is what carries an `unshare` that can
# leave propagation ALONE — busybox's makes the new namespace private, which silently turns this measurement
# into one about a namespace nothing propagates to, and a private namespace passes the control for the wrong
# reason.
PROBE_IMAGE="debian@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241"
GATE_SKIP_STATUS="${GATE_SKIP_STATUS:-77}"
GATE_ROOT="${PROJECTION_PROPAGATION_PROBE_ROOT:-.projection-mount-propagation-probe}"
WORK="$GATE_ROOT/run-$$"

cleanup() { rm -rf "$WORK" 2>/dev/null || true; rmdir "$GATE_ROOT" 2>/dev/null || true; }
trap cleanup EXIT

mkdir -p "$WORK"
chmod 700 "$GATE_ROOT" "$WORK"

echo "=== projection mount-propagation probe (Phase 7 §8.7.1) ==="

# THE EMBEDDED PROGRAM IS A FILE IN A QUOTED HEREDOC AND NOT AN INLINE `sh -c "..."` SPANNING LINES. Phase 7
# §11.4 #3 is a run that died two hours in because a quoted program was split across lines and could not be
# read; `test/custody-runtime-closure.ts` refuses exactly that construction in every shipped script here.
cat > "$WORK/probe.sh" <<'PROBE'
set -e
rows() { awk -v t=/probe/mnt '$5==t' /proc/self/mountinfo | wc -l; }
mkdir -p /probe
mount -t tmpfs tmpfs /probe
mkdir -p /probe/mnt
# THE OPERATOR SIDE OF THE ARRANGEMENT: a bind at the mount point, made shared, which is exactly what
# `-v <host path>:/mnt/projection:rshared` produces for the daemon's own mount point.
mount --bind /probe/mnt /probe/mnt
mount --make-rshared /probe/mnt
echo "floor=$(rows)"
# THE CONTROL — what `docker rm -f` does to a daemon. A mount made inside a child mount namespace, whose
# namespace is then destroyed with the mount still standing.
unshare --mount --propagation unchanged sh -c 'mount -t tmpfs -o size=1m corpse /probe/mnt'
echo "afterNamespaceDestroyed=$(rows)"
# THE REPAIR — what the daemon now does on a shutdown whose ordinary unmount was refused. The same mount,
# removed by the process that made it, with MNT_DETACH, before that process exits.
unshare --mount --propagation unchanged sh -c 'mount -t tmpfs -o size=1m mine /probe/mnt; umount -l /probe/mnt'
echo "afterSelfDetach=$(rows)"
PROBE
chmod 600 "$WORK/probe.sh"

# THE ONE SKIP CONDITION, AND IT IS THE ABILITY TO MOUNT AT ALL. A host that cannot run a privileged container
# cannot host this measurement, and the honest answer there is "nothing was proved" rather than a green tick.
if ! docker run --rm --privileged "$PROBE_IMAGE" sh -c 'mkdir -p /probe; mount -t tmpfs tmpfs /probe' >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no privileged container on this host can mount a tmpfs, so mount propagation cannot be exercised here." >&2
  exit "$GATE_SKIP_STATUS"
fi

OUT="$(docker run --rm --privileged -v "$PWD/$WORK:/probe-in:ro" "$PROBE_IMAGE" sh /probe-in/probe.sh 2>&1)"
echo "$OUT" | sed 's/^/  /'

value() { echo "$OUT" | sed -n "s/^$1=//p" | tail -1; }
FLOOR="$(value floor)"
AFTER_DESTROY="$(value afterNamespaceDestroyed)"
AFTER_DETACH="$(value afterSelfDetach)"

fail() { echo "PROBE FAILED: $*" >&2; exit 1; }
if [ -z "$FLOOR" ] || [ -z "$AFTER_DESTROY" ] || [ -z "$AFTER_DETACH" ]; then
  fail "the probe produced no counts at all, so nothing was measured"
fi
if [ "$FLOOR" -ne 1 ]; then
  fail "the mount point does not start as exactly the operator's own bind ($FLOOR row(s))"
fi

# THE CONTROL HAS TO REPRODUCE THE DEFECT, OR A GREEN RESULT MEANS THE SCENARIO STOPPED BEING MODELLED. It is
# the same rule the Go regression's own control arm follows, and the reason #13 was recorded as resolved.
if [ "$AFTER_DESTROY" -ne $(( FLOOR + 1 )) ]; then
  fail "the CONTROL did not leave a surviving mount ($AFTER_DESTROY against a floor of $FLOOR): destroying a mount namespace apparently DOES remove the peer on this kernel, so §8.7.1's mechanism is wrong about this host"
fi
if [ "$AFTER_DETACH" -ne "$AFTER_DESTROY" ]; then
  fail "a process that removed its OWN mount with MNT_DETACH still left one behind ($AFTER_DETACH against $AFTER_DESTROY), so §8.7.2's repair does not propagate on this kernel"
fi

echo "  MEASURED: a mount whose namespace is destroyed SURVIVES on the host ($FLOOR -> $AFTER_DESTROY)."
echo "  MEASURED: a mount its own process detaches lazily is REMOVED from the host ($AFTER_DESTROY unchanged)."
echo "PROBE PASSED — §8.7.1's mechanism and §8.7.2's repair both hold on this kernel."
