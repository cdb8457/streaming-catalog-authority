//go:build linux

// MOUNTING OVER OUR OWN CORPSE WITHOUT ASKING IT ANYTHING.
//
// THE DEFECT THIS FILE EXISTS FOR, AND IT IS A PRODUCT DEFECT RATHER THAN A TEST ARTEFACT. A daemon that has
// ever restarted over a corpse can never auto-remount again, permanently, after about a minute. Measured on
// the real Unraid host with three media servers attached: the connection was aborted, the serve loop died,
// the supervisor drained its own dead layer down to the startup floor exactly as designed — and then every
// remount attempt was refused with "transport endpoint is not connected", while the same daemon had mounted
// over that same corpse minutes earlier at startup.
//
// THE MECHANISM, READ OUT OF THE DEPENDENCY RATHER THAN GUESSED. go-fuse's `mountDirect`
// (fuse/mount_linux.go, v2.10.1) does this before it mounts:
//
//	var st syscall.Stat_t
//	err = syscall.Stat(mountPoint, &st)
//	if err != nil { return }
//
// and it wants exactly one thing from the answer: `rootmode=%o` from `st.Mode & S_IFMT`. With
// DirectMountStrict there is no fallback, so that error IS the mount error the supervisor reports.
//
// `stat` on the root of a FUSE mount is answered from the kernel's attribute cache while the cache is warm
// and reaches the connection once it is not — and this daemon sets `attrTimeout` to 60 seconds. So stacking
// over a corpse works for the first minute of its death and never afterwards. That is the whole difference
// between the startup that succeeded and the recovery that could not: A2 kills the daemon and restarts it
// within seconds, and A3 fires minutes later.
//
// WHY THE CORPSE CANNOT SIMPLY BE REMOVED INSTEAD, which is the fix a reader reaches for first. In every
// containerised topology this daemon ships in, the mount point IS the operator's bind, and a bind of a path
// that a previous daemon mounted carries that daemon's dead superblock. It is simultaneously a corpse and
// the propagation anchor: the peer group that carries mounts out to the host and to the media servers.
// Removing it does not free the mount point, it disconnects it — a new mount lands with the CONTAINER's root
// as its parent, in a peer group with no host peer. That was measured too: /readyz answered ready, the
// daemon logged a successful remount, and all three media servers read nothing.
//
// SO THE MOUNT MUST GO OVER THE ANCHOR WITHOUT ASKING THE ANCHOR ANYTHING. Nothing in the mount syscall
// needs the corpse to answer: attaching a mount resolves the path through the dentry cache and never issues
// a getattr. The only reason go-fuse asks is to fill in `rootmode`, and the mount point of this daemon is a
// directory by contract — checked at startup, and a file could not have been mounted over in the first
// place. So this file supplies `rootmode=S_IFDIR` from what is already known, performs the mount itself, and
// hands go-fuse the resulting connection through its documented `/dev/fd/N` mount point.
package fusefs

import (
	"fmt"
	"os"
	"strings"
	"syscall"
)

// selfMountOptions builds the FUSE mount data for a connection this process opened itself.
//
// IT IS A PURE FUNCTION BECAUSE IT IS THE PART THAT CAN BE WRONG WITHOUT FAILING. A mount with the wrong
// option string does not refuse; it succeeds and behaves differently — `allow_other` missing hands every
// media server EACCES, `default_permissions` missing moves permission enforcement out of the kernel and into
// this process. Both are silent, and both are exactly the kind of thing that is discovered on a host at two
// in the morning. So the string is built where a table test can read it.
//
// IT DELIBERATELY MIRRORS `mountDirect`, MINUS TWO THINGS.
//
//   - `rootmode` comes from S_IFDIR rather than from a stat of the mount point. That is the entire fix.
//   - `max_read` is not sent. go-fuse sends `max_read=MaxWrite` "as fusermount does", from a value that
//     `NewServer` fills in from the kernel's own limit AFTER this process would have to guess it. Guessing it
//     would cap reads at whatever this file said rather than at what the kernel allows, and getting that
//     wrong is a throughput regression that no assertion here would catch. Omitted, the kernel applies its
//     own default and the read size is negotiated in INIT, where go-fuse negotiates it anyway.
//
// nosuid, nodev and noexec are NOT in this list on purpose: the kernel takes those as mount FLAGS, and
// passing them as filesystem data is how a direct mount earns EINVAL. They are in flags, with ro and
// noatime, at the call site.
func selfMountOptions(fd int, allowOther, defaultPermissions bool) string {
	options := []string{
		fmt.Sprintf("fd=%d", fd),
		// THE MOUNT POINT IS A DIRECTORY, WHICH IS WHY THIS CAN BE KNOWN RATHER THAN ASKED. A mount point
		// that was not a directory could not have been mounted over by the mount this one is replacing.
		fmt.Sprintf("rootmode=%o", syscall.S_IFDIR),
		fmt.Sprintf("user_id=%d", os.Geteuid()),
		fmt.Sprintf("group_id=%d", os.Getegid()),
	}
	if defaultPermissions {
		options = append(options, "default_permissions")
	}
	if allowOther {
		options = append(options, "allow_other")
	}
	return strings.Join(options, ",")
}

// selfMount opens /dev/fuse and mounts it at mountpoint itself, returning the connection file descriptor.
//
// THE FD IS CLOSED ON EVERY FAILING PATH, which is not merely tidy. The upstream function this replaces does
// NOT do that — `mountDirect` returns its open descriptor alongside the stat error and its caller drops it —
// so every refused remount there leaks one /dev/fuse descriptor for the life of the process. A supervisor
// retrying three times per death, over a daemon that is meant to run for months, is exactly the shape that
// turns a leak into an outage.
func selfMount(mountpoint, source, fsType string, flags uintptr, allowOther, defaultPermissions bool) (int, error) {
	fd, err := syscall.Open("/dev/fuse", syscall.O_RDWR, 0)
	if err != nil {
		return -1, fmt.Errorf("opening /dev/fuse: %w", err)
	}
	if err := syscall.Mount(source, mountpoint, fsType, flags,
		selfMountOptions(fd, allowOther, defaultPermissions)); err != nil {
		_ = syscall.Close(fd)
		return -1, fmt.Errorf("mounting %s at %s: %w", fsType, mountpoint, err)
	}
	return fd, nil
}

// fuseFdMountpoint is go-fuse's documented way to be handed a connection somebody else mounted: a mount
// point of the form /dev/fd/N is not opened as a path at all, it is parsed for the descriptor.
//
// THE TWO THINGS IT COSTS ARE HANDLED AT THE CALL SITE, and both are silent if they are not. `Server.Unmount`
// refuses on a magic mount point because go-fuse no longer knows the real path, so `Mounted` keeps the path
// and unmounts by syscall. `Server.WaitMount` skips its poll hack for the same reason, so the caller must
// force the INIT handshake itself before returning a mount it has promised is live.
func fuseFdMountpoint(fd int) string { return fmt.Sprintf("/dev/fd/%d", fd) }
