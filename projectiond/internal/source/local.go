//go:build linux

package source

import (
	"context"
	"io"
	"os"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

// LocalAdapter is the passthrough source: bytes that are already on a disk this host can see.
//
// THE DEADLINE HERE IS NOT ABSOLUTE, AND THAT LIMIT IS STATED RATHER THAN GLOSSED. `pread(2)` is a blocking
// syscall with no cancellation: the context is checked before the open and between successive preads, so a
// read is bounded by "the deadline plus at most one outstanding pread". On a local block-device-backed
// filesystem that remainder is microseconds and the guarantee is effectively absolute. On a HUNG NETWORK
// FILESYSTEM — an unresponsive NFS or SMB mount behind a configured root — a single pread can block in
// uninterruptible sleep for far longer than the read deadline, and nothing in userspace can stop it.
//
// So a configured local root MUST be genuinely local. Pointing one at a network mount trades the anti-hang
// contract for a convenience, and the contract is the more valuable of the two.
//
// IT IS ROOT-CONFINED BY CONSTRUCTION, NOT BY STRING CHECKING. Each configured root is opened once as a
// directory file descriptor, and every subsequent open walks it one component at a time with `openat` and
// `O_NOFOLLOW`. There is no point at which a path is concatenated and handed to the kernel, so there is no
// `..` to strip, no symlink to resolve, and no window in which a component is replaced between the check and
// the open. A symlink anywhere on the path is an ELOOP from the kernel, which this maps to a terminal
// failure rather than following it somewhere the operator did not intend.
type LocalAdapter struct {
	mu     sync.RWMutex
	roots  map[string]*os.File
	closed bool
}

func NewLocalAdapter(roots map[string]string) (*LocalAdapter, error) {
	a := &LocalAdapter{roots: map[string]*os.File{}}
	for id, path := range roots {
		fd, err := os.OpenFile(path, os.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
		if err != nil {
			_ = a.Close()
			return nil, Fail(CondSourceUnreachable, ClassTerminal, "root "+id+" is not an openable directory")
		}
		a.roots[id] = fd
	}
	return a, nil
}

func (a *LocalAdapter) Kind() string { return "local" }

func (a *LocalAdapter) Close() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closed = true
	for _, fd := range a.roots {
		_ = fd.Close()
	}
	a.roots = map[string]*os.File{}
	return nil
}

// dupRoot takes a private duplicate of the root descriptor while holding the lock.
//
// WHY A DUPLICATE. An earlier draft released the lock and then used root.Fd() for the whole walk. A
// concurrent Close could close that descriptor mid-walk, and the number could be handed straight back out by
// the kernel to the next open anywhere in the process — so the walk would continue against an unrelated
// file. Duplicating under the lock means the walk owns a descriptor that cannot be reused underneath it, no
// matter what Close does a microsecond later.
func (a *LocalAdapter) dupRoot(rootID string) (int, *Failure) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.closed {
		return -1, Fail(CondSourceUnreachable, ClassTerminal, "adapter closed")
	}
	root, ok := a.roots[rootID]
	if !ok {
		return -1, Fail(CondSourceRefUnknown, ClassTerminal, "unknown local root")
	}
	dup, err := unix.FcntlInt(root.Fd(), unix.F_DUPFD_CLOEXEC, 0)
	if err != nil {
		return -1, Fail(CondSourceUnreachable, ClassRetryable, "")
	}
	return dup, nil
}

// openConfined walks the relative path from a private duplicate of the root descriptor, refusing to leave it.
func (a *LocalAdapter) openConfined(rootID, relative string) (int, *Failure) {
	current, failure := a.dupRoot(rootID)
	if failure != nil {
		return -1, failure
	}
	// `current` is owned here until it is either closed or replaced by the next component's descriptor.
	defer func() {
		if current >= 0 {
			_ = unix.Close(current)
		}
	}()

	segments := strings.Split(relative, "/")
	for i, segment := range segments {
		// The manifest validator already refused `.`, `..`, empty segments and backslashes. This is the second
		// lock on the same door, on the side that actually touches the kernel.
		if segment == "" || segment == "." || segment == ".." || strings.ContainsRune(segment, 0) {
			return -1, Fail(CondSourceRefUnknown, ClassTerminal, "unsafe path segment")
		}
		last := i == len(segments)-1
		flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC
		if !last {
			flags |= unix.O_DIRECTORY
		}
		next, err := unix.Openat(current, segment, flags, 0)
		if err != nil {
			switch err {
			case unix.ENOENT, unix.ENOTDIR:
				return -1, Fail(CondSourceNotFound, ClassTerminal, "")
			case unix.ELOOP:
				// A symlink on the path. Never followed: a media server must not be able to reach anything
				// the operator did not put inside a configured root.
				return -1, Fail(CondSourceRefUnknown, ClassTerminal, "symlink on path")
			case unix.EACCES, unix.EPERM:
				return -1, Fail(CondSourceAuthRefused, ClassTerminal, "")
			default:
				return -1, Fail(CondSourceUnreachable, ClassRetryable, "")
			}
		}
		_ = unix.Close(current)
		current = next
	}
	result := current
	current = -1 // ownership passes to the caller
	return result, nil
}

// Fetch fills dst[:req.Length] from a descriptor, at an absolute offset, and returns how many bytes it
// actually produced. It never seeks a shared descriptor and never reads past the requested window.
func (a *LocalAdapter) Fetch(ctx context.Context, req ReadRequest, dst []byte) (int, error) {
	if failure := req.Valid(dst); failure != nil {
		return 0, failure
	}
	if err := ctx.Err(); err != nil {
		return 0, Fail(CondReadDeadline, ClassTerminal, "")
	}
	fd, failure := a.openConfined(req.Locator.RootID, req.Locator.RelativePath)
	if failure != nil {
		return 0, failure
	}
	defer unix.Close(fd)

	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return 0, Fail(CondSourceUnreachable, ClassRetryable, "")
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG {
		// A directory, a device or a fifo behind a projected path is not a projectable byte stream, and
		// reading one could block forever. Refused rather than opened.
		return 0, Fail(CondSourceRefUnknown, ClassTerminal, "not a regular file")
	}
	// EXACT SIZE. The manifest asserts the byte length; a backing file that disagrees is not this projected
	// version, and serving its bytes would be serving a different file under a stable inode.
	if stat.Size != req.SizeBytes {
		return 0, Fail(CondSizeDisagrees, ClassTerminal, "")
	}

	read := int64(0)
	for read < req.Length {
		if err := ctx.Err(); err != nil {
			return int(read), Fail(CondReadDeadline, ClassTerminal, "")
		}
		n, err := unix.Pread(fd, dst[read:req.Length], req.Offset+read)
		if n > 0 {
			read += int64(n)
			continue
		}
		if err == unix.EINTR {
			continue
		}
		if err == nil || err == io.EOF {
			// The file shrank under us. It is a truncation, not an EOF, because the manifest says otherwise
			// and the engine already clamped this request to the manifest size.
			return int(read), Fail(CondShortBody, ClassTerminal, "")
		}
		return int(read), Fail(CondSourceUnreachable, ClassRetryable, "")
	}
	return int(read), nil
}
