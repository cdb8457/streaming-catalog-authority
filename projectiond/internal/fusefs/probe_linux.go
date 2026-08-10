//go:build linux

// THE MOUNTPOINT PROBE. Mount() stacks over whatever is at the target path, so the one place where a decision
// beats a stack is the start: is the thing under us one of our own mounts, live or dead, or somebody else's
// filesystem?
//
// The probe is BOUNDED BY CONSTRUCTION: one statfs and one read of /proc/self/mountinfo, and nothing else —
// no providers, no databases, no second daemon, no wait. The whole decision is a pure table (classify) that
// cannot touch the kernel, and the kernel-touching part is one function with nothing to hang on.
package fusefs

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// fuseProjectiondType is what the kernel names a projectiond mount in /proc/self/mountinfo. go-fuse mounts
// with "fuse."+opts.Name, and Mount names this daemon's file system projectiond, so the type is
// fuse.projectiond. That exact string is the probe's one dependency on the mount implementation, and the
// fusesmoke run locks it down: a live projectiond mount must probe as live, or the smoke fails.
const fuseProjectiondType = "fuse.projectiond"

// ProbeResult names what the probe found at a mount point.
type ProbeResult int

const (
	// ProbeEmpty means there is nothing there that would stop us: a plain directory, or no path at all.
	ProbeEmpty ProbeResult = iota
	// ProbeStaleProjectiond means our own mount is there but its transport is gone — a dead daemon's corpse.
	ProbeStaleProjectiond
	// ProbeLiveProjectiond means our own mount is there and answering stat.
	ProbeLiveProjectiond
	// ProbeForeign means something is there that is not ours.
	ProbeForeign
)

func (p ProbeResult) String() string {
	switch p {
	case ProbeEmpty:
		return "empty"
	case ProbeStaleProjectiond:
		return "stale-projectiond"
	case ProbeLiveProjectiond:
		return "live-projectiond"
	case ProbeForeign:
		return "foreign"
	default:
		return fmt.Sprintf("probe-result-%d", int(p))
	}
}

// mountInfoEntry is the slice of a /proc/self/mountinfo line that the probe cares about. mountPoint is the
// mount's escape-unescaped path; fsType and source identify the file system sitting on it.
type mountInfoEntry struct {
	mountPoint string
	fsType     string
	source     string
}

// mountInfoEntryAt finds the mount whose mount point is path, or nil. path is normalized to an absolute
// cleaned path, the same shape mountinfo carries.
func mountInfoEntryAt(path string) *mountInfoEntry {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil
	}
	abs = filepath.Clean(abs)
	raw, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return nil
	}
	for _, entry := range parseMountInfo(raw) {
		if entry.mountPoint == abs {
			return &entry
		}
	}
	return nil
}

// parseMountInfo reads the machine form of /proc/self/mountinfo: one mount per line, fields separated by
// spaces, the optional fields separated from the file-system identity by " - ". A line that does not carry at
// least the mount point and the file-system type is not a mount the probe can say anything about, so it is
// skipped rather than half-read.
func parseMountInfo(raw []byte) []mountInfoEntry {
	var entries []mountInfoEntry
	for _, line := range strings.Split(string(raw), "\n") {
		if line == "" {
			continue
		}
		fields := strings.Split(line, " - ")
		if len(fields) != 2 {
			continue
		}
		before := strings.Fields(fields[0])
		after := strings.Fields(fields[1])
		if len(before) < 6 || len(after) < 2 {
			continue
		}
		entries = append(entries, mountInfoEntry{
			mountPoint: unescapeMountInfo(before[4]),
			fsType:     after[0],
			source:     after[1],
		})
	}
	return entries
}

// unescapeMountInfo undoes the four escapes mountinfo(5) applies to a mount point's path: \040 for space,
// \011 for tab, \012 for newline and \134 for backslash. An escape this function does not know is left in
// place rather than mangled.
func unescapeMountInfo(field string) string {
	var out strings.Builder
	out.Grow(len(field))
	for i := 0; i < len(field); i++ {
		if field[i] != '\\' || i+3 >= len(field) {
			out.WriteByte(field[i])
			continue
		}
		switch field[i+1 : i+4] {
		case "040":
			out.WriteByte(' ')
		case "011":
			out.WriteByte('\t')
		case "012":
			out.WriteByte('\n')
		case "134":
			out.WriteByte('\\')
		default:
			out.WriteByte(field[i]) // an escape the probe does not know: keep the backslash
			continue
		}
		i += 3
	}
	return out.String()
}

// classify is the probe's whole decision, made pure so it can be table-tested without a kernel. statfsErr is
// what syscall.Statfs returned for the target path; entry is the mountinfo entry for it, or nil. The rules:
//
//   - A path that does not exist, and a path whose statfs answers over no mount, are both EMPTY: nothing is
//     stacked under us. This is the unremarkable case.
//   - A path whose statfs succeeds over our own file system is LIVE. A hung-but-connected mount also answers
//     statfs from the daemon's map read, so a hung mount is called live here: proving death requires waiting,
//     and this probe never waits.
//   - A path whose statfs answers ENOTCONN over our own file system is STALE: the mountpoint exists but the
//     transport is gone, which is exactly what a killed daemon leaves behind.
//   - Everything else is FOREIGN: a statfs error that cannot be explained, or a mount that is not ours.
func classify(statfsErr error, entry *mountInfoEntry) ProbeResult {
	switch {
	case statfsErr == nil && entry == nil:
		return ProbeEmpty
	case statfsErr == nil && entry.fsType == fuseProjectiondType:
		return ProbeLiveProjectiond
	case statfsErr == nil:
		return ProbeForeign
	case errors.Is(statfsErr, syscall.ENOENT):
		return ProbeEmpty
	case errors.Is(statfsErr, syscall.ENOTCONN) && entry != nil && entry.fsType == fuseProjectiondType:
		return ProbeStaleProjectiond
	default:
		return ProbeForeign
	}
}

// ProbeMountpoint answers what is at path without touching the daemon: one statfs and one read of
// /proc/self/mountinfo, and the pure classify table. It never waits and never modifies anything.
//
// STATFS, NOT STAT, IS THE TRANSPORT CHECK. stat() on the mount ROOT is answered from the kernel's attribute
// cache for up to attrTimeout after a connection dies — a dead mount keeps "statting fine" while its cache is
// warm, which would classify a corpse as live. FUSE caches nothing for statfs: every statfs reaches the
// connection, so a dead connection answers ENOTCONN immediately and a live one answers from the daemon's map
// read. Only a hung-but-connected mount could block statfs, and it could block stat the same way — proving
// that state dead requires a timeout, and this probe never waits.
// TopMountFsTypeAt reports the file-system type of the mount that is actually ON TOP at path, and whether
// there is one at all.
//
// WHY IT IS NOT `mountInfoEntryAt`, AND WHY THAT DISTINCTION COST A REAL RUN. `mountInfoEntryAt` returns the
// FIRST line matching the mount point, which is the BOTTOM of a stack — and a projection mount point is
// routinely a stack, because every recovery in this daemon stacks over the corpse it found. A supervisor
// draining corpses has to know what it is about to remove, and the thing it removes is the one on top. Using
// the bottom entry there took the operator's own bind: the daemon logged a successful remount, /readyz
// answered ready, and no consumer could see a file — the same failure `--auto-remount` was fixed for once
// already, arrived at from the other direction.
//
// IT READS THE MOUNT TABLE AND NOTHING ELSE. No statfs, no liveness question: a drain must decide on
// IDENTITY, because the transport check is exactly the thing that is unreliable while a stack is coming
// apart. `mountinfo` lists mounts in the order they were applied, so the last matching line is the top.
func TopMountFsTypeAt(path string) (string, bool) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", false
	}
	abs = filepath.Clean(abs)
	raw, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return "", false
	}
	fsType := ""
	found := false
	for _, entry := range parseMountInfo(raw) {
		if entry.mountPoint == abs {
			fsType = entry.fsType
			found = true
		}
	}
	return fsType, found
}

// IsOurMountType reports whether a file-system type is this daemon's own FUSE mount. It exists so a caller
// deciding what to REMOVE compares against the same constant the probe classifies with, rather than a
// second spelling of it that can drift.
//
// IT IS NECESSARY AND IT IS NOT SUFFICIENT, which cost a real run. In a container the mount point is
// commonly a BIND OF A PROJECTIOND MOUNT — the operator binds a host path that a previous daemon already
// mounted — so the bind's own file-system type is `fuse.projectiond` too. Anything deciding what to detach
// must ALSO know what predates it; see CountMountsAt.
func IsOurMountType(fsType string) bool { return fsType == fuseProjectiondType }

// CountMountsAt reports how many mounts are stacked at exactly this path.
//
// WHY A COUNT, AND WHY IT IS TAKEN BEFORE THE FIRST MOUNT. A supervisor clearing its own corpses has to stop
// somewhere, and every property of the mount itself has now been tried and found insufficient: the transport
// answer is unreliable while a stack is coming apart, and the file-system type cannot tell this daemon's own
// mount from a BIND of somebody else's projectiond mount, which is exactly what a containerised deployment
// hands it. What is left is arithmetic: whatever was at the mount point before this process mounted anything
// is not this process's to remove, however much it looks like ours.
// IT RETURNS VALIDITY BESIDE THE COUNT, AND THAT SECOND VALUE IS THE WHOLE SAFETY PROPERTY.
//
// A count of zero has two completely different meanings: nothing is mounted here, or the question could not
// be asked. The first version returned a bare int and answered 0 for both — so a `/proc/self/mountinfo` that
// could not be read would have set the drain's startup floor to zero and authorised it to detach EVERYTHING
// at the mount point, including the operator's bind. That is the same defect this floor exists to prevent,
// hiding one layer beneath it, and it is the shape this repository keeps finding: a zero that means "did not
// look" being spent as a zero that means "nothing there".
//
// So the caller is told whether the number is a measurement, and a caller that cannot get one is required to
// do nothing at all.
func CountMountsAt(path string) (int, bool) {
	return countMountsAtFrom(path, procSelfMountInfo)
}

// procSelfMountInfo is where the real mount table lives. It is a constant with a name so the seam below
// reads as a seam rather than as a magic string.
const procSelfMountInfo = "/proc/self/mountinfo"

// countMountsAtFrom is CountMountsAt with the mount table as a parameter, and it exists so the FAIL-CLOSED
// branch can be EXECUTED by a test instead of merely written down.
//
// The interesting case is a mount table that cannot be read, and there is no way to induce that against the
// real `/proc/self/mountinfo` from a test. Without this seam the branch that decides whether the drain may
// remove anything would be the one branch nothing had ever run — which is exactly how this repository's
// worst defects have all arrived.
func countMountsAtFrom(path, mountInfoPath string) (int, bool) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return 0, false
	}
	abs = filepath.Clean(abs)
	raw, err := os.ReadFile(mountInfoPath)
	if err != nil {
		return 0, false
	}
	count := 0
	for _, entry := range parseMountInfo(raw) {
		if entry.mountPoint == abs {
			count++
		}
	}
	return count, true
}

func ProbeMountpoint(path string) ProbeResult {
	var stat syscall.Statfs_t
	return classify(syscall.Statfs(path, &stat), mountInfoEntryAt(path))
}
