# The cleanup every projection data-plane gate ends with, as one implementation rather than four copies.
#
# THE DEFECT THIS EXISTS FOR, AND IT WAS FOUND ON UNRAID AND NOWHERE ELSE.
#
# After four Jellyfin runs the isolated checkout carried FOUR dangling mountpoints, each reporting `Transport
# endpoint is not connected`. The gate's own comments say a stale mount is how the NEXT run inherits a
# namespace and passes for the wrong reason, so this is the failure mode the gate warns about, happening to
# the gate.
#
# WHY THE LAZY UNMOUNT DID NOT WORK, WHICH IS A PROPAGATION BUG AND NOT A TIMING ONE. The daemon binds its
# mount point `-v "$WORK/mnt:/mnt/projection:rshared"`, so the FUSE mount it creates propagates OUT of its
# container and onto the host — that is the whole reason the media server beside it can see the namespace.
# The cleanup then ran `umount -l` inside a DIFFERENT container whose bind of the gate root carried Docker's
# default propagation, `rprivate`. An unmount in a private mount namespace is invisible outside it. So the
# unmount genuinely succeeded — in a namespace that was thrown away a millisecond later — and the host
# mountpoint was never touched.
#
# On Docker Desktop the same code appears to work because the bind source lives inside Docker's own Linux VM
# and the run root is reached over a filesystem share rather than a bind of a shared host mount, so there is
# no host-side mountpoint to leak in the first place. A defect that only exists where the propagation is real.
#
# THE FIX IS TO UNMOUNT IN A NAMESPACE THAT PROPAGATES BACK: the gate root is bound `:rshared`, so the
# unmount travels the same path the mount travelled. It is attempted, then VERIFIED, then retried within a
# bounded number of attempts, because an unmount that reports success and leaves a mountpoint is exactly what
# happened before and a cleanup that cannot tell the difference is the thing being replaced.
#
# EVERY PATH IS GUARDED. Nothing here unmounts or deletes anything that is not underneath the run root it was
# given, and the run root must itself be underneath the gate root. A cleanup helper that takes a path and
# removes it is one bad variable away from removing something else.

# How many times to attempt the unmount before giving up and reporting the leak.
PROJECTION_CLEANUP_ATTEMPTS="${PROJECTION_CLEANUP_ATTEMPTS:-5}"

# Mountpoints still present under a directory, as a count. `findmnt` is Linux; on a host without it the
# question cannot be asked and the answer is the empty string rather than zero — a check that could not run is
# not a check that passed, exactly as the host preflight treats propagation.
projection_gate_mounts_under() {
  _root="$1"
  if ! command -v findmnt >/dev/null 2>&1; then
    printf ''
    return 0
  fi
  findmnt -rno TARGET 2>/dev/null | awk -v root="$_root/" 'index($0, root) == 1' | wc -l | tr -d ' '
}

# Unmount everything under a run directory WITHOUT removing it.
#
# THIS IS THE MID-GATE PATH, and it matters more than the cleanup one rather than less. The kill-and-recover
# gate SIGKILLs the daemon and must leave no stale mount answering as if nothing happened — a dead FUSE mount
# whose `stat` still answers is exactly how a remount assertion passes against a namespace that is not there.
# It carried the same `rprivate` bind as the cleanup did, so on Unraid it unmounted nothing at all.
#
#   $1 gate root (absolute)   $2 run directory (absolute, must be under the gate root)   $3 verify image
projection_gate_unmount_run() {
  _gate_root="$1"; _run="$2"; _image="$3"
  case "$_run" in
    "$_gate_root"/?*) : ;;
    *) echo "unmount refused: '$_run' is not under '$_gate_root'" >&2; return 1 ;;
  esac
  case "$_run" in
    *..*) echo "unmount refused: '$_run' contains a parent traversal" >&2; return 1 ;;
  esac
  _base="$(basename "$_run")"
  docker run --rm --privileged -v "$_gate_root:/gate:rshared" "$_image" \
    sh -c "for m in \$(awk '\$5 ~ \"^/gate/$_base/\" {print \$5}' /proc/self/mountinfo | sort -r); do umount -l \"\$m\" 2>/dev/null || true; done" \
    >/dev/null 2>&1 \
    || docker run --rm --privileged -v "$_gate_root:/gate" "$_image" \
      sh -c "umount -l /gate/$_base/mnt 2>/dev/null || true" >/dev/null 2>&1 || true
  return 0
}

# Unmount everything under a run directory and remove it. Bounded, verified, and guarded.
#
#   $1 gate root (absolute)   $2 run directory (absolute, must be under the gate root)   $3 verify image
projection_gate_cleanup_run() {
  _gate_root="$1"; _run="$2"; _image="$3"

  # GUARD ONE: the run directory must be underneath the gate root, and must not BE it. `rm -rf` on a gate
  # root would take every concurrent run with it; on anything above that it does not bear describing.
  case "$_run" in
    "$_gate_root"/?*) : ;;
    *) echo "cleanup refused: '$_run' is not under '$_gate_root'" >&2; return 1 ;;
  esac
  case "$_run" in
    *..*) echo "cleanup refused: '$_run' contains a parent traversal" >&2; return 1 ;;
  esac
  _base="$(basename "$_run")"

  [ -d "$_run" ] || return 0

  _attempt=1
  while [ "$_attempt" -le "$PROJECTION_CLEANUP_ATTEMPTS" ]; do
    # THE GATE ROOT IS BOUND `:rshared` SO THE UNMOUNT PROPAGATES BACK TO THE HOST. That is the whole fix.
    # `-R` walks any nested mountpoints; a single `umount` of the top one leaves children behind.
    #
    # It falls back to an unshared bind if the daemon refuses `rshared` — on a host whose run root is not on a
    # shared mount there is no host-side propagation to undo either, so the private unmount is the right one.
    docker run --rm --privileged -v "$_gate_root:/gate:rshared" "$_image" \
      sh -c "for m in \$(awk '\$5 ~ \"^/gate/$_base/\" {print \$5}' /proc/self/mountinfo | sort -r); do umount -l \"\$m\" 2>/dev/null || true; done" \
      >/dev/null 2>&1 \
      || docker run --rm --privileged -v "$_gate_root:/gate" "$_image" \
        sh -c "umount -l /gate/$_base/mnt 2>/dev/null || true" >/dev/null 2>&1 || true

    _left="$(projection_gate_mounts_under "$_run")"
    # An empty answer means the question could not be asked on this host; do not loop on it.
    [ -z "$_left" ] && break
    [ "$_left" = "0" ] && break
    _attempt=$(( _attempt + 1 ))
    sleep 1
  done

  # The directory goes last, and from inside a privileged container as well as from the host: a run root the
  # daemon created is owned by a uid the operator may not be.
  docker run --rm --privileged -v "$_gate_root:/gate:rshared" "$_image" \
    sh -c "rm -rf /gate/$_base" >/dev/null 2>&1 \
    || docker run --rm --privileged -v "$_gate_root:/gate" "$_image" \
      sh -c "rm -rf /gate/$_base" >/dev/null 2>&1 || true
  rm -rf "$_run" >/dev/null 2>&1 || true
  return 0
}

# What a gate prints at the very end, and what a regression test reads.
#
# IT IS A REPORT, NOT AN ASSERTION, and the distinction is deliberate: this runs inside an EXIT trap, where a
# non-zero return would overwrite the gate's own exit status and turn a failing run into a passing one — or a
# passing one into a failure for a reason that has nothing to do with the data plane. The gate asserts
# cleanliness separately, where it can afford to fail.
projection_gate_report_cleanliness() {
  _gate_root="$1"; _run="$2"
  _left="$(projection_gate_mounts_under "$_run")"
  if [ -z "$_left" ]; then
    echo "  cleanup: mountpoints NOT VERIFIED on this host (no findmnt) — not a check that passed"
    return 0
  fi
  if [ "$_left" = "0" ] && [ ! -d "$_run" ]; then
    echo "  cleanup: 0 mountpoints and no run directory left under the gate root"
    return 0
  fi
  echo "  cleanup: $_left mountpoint(s) and $( [ -d "$_run" ] && echo 'a run directory' || echo 'no run directory' ) left behind" >&2
  return 0
}
