//go:build linux

// THE EXPECTED UNDERLYING ATTACHMENT. Projection Phase 7 §8.4.
//
// WHAT THIS FILE EXISTS FOR, IN ONE PARAGRAPH. When this daemon's own FUSE mount is removed from beneath it —
// an external `umount`, which is the single most likely operator-side accident on this appliance — what is
// left at the mount point INSIDE A CONTAINER is the operator's own bind, and on an Unraid host that bind's
// file-system type is the host's `fuse.shfs`. `ObserveMountpoint` answers FOREIGN, correctly, and the recovery
// supervisor refuses, also correctly: unmounting something that is not ours is the exact defect
// `--auto-remount` shipped once already. The result, measured twice on the real host, is that the one fault
// `recover-mount-empty` exists for is unreachable in the topology the alpha ships in.
//
// THE DISTINCTION THIS FILE DRAWS IS NARROW AND IT IS THE ONLY SAFE ONE. It is NOT "trust `fuse.shfs`", and it
// is not "trust anything foreign that looks like a bind": both of those would hand the supervisor exactly the
// licence Phase 6 §3.2 refuses it. It is:
//
//	IS THE MOUNT POINT, RIGHT NOW, IN EXACTLY THE STATE IT WAS IN BEFORE THIS PROCESS EVER MOUNTED ANYTHING?
//
// The whole ordered stack of mount rows at that path is fingerprinted ONCE, at startup, BEFORE the first
// `Mount()` — so it is a measurement of what the operator attached, taken before this daemon could have
// contributed anything to it. A later verdict of `underlay-exposed` therefore means: nothing of ours is
// there, nothing has been stacked on top of us, nothing has been swapped underneath us, and every row is the
// same ATTACHMENT it was — same mount id, same parent, same device, same subtree root, same source, same
// file-system type, same propagation relationship. Under that condition, and only under it, mounting is not a
// new destructive capability: it is byte-for-byte the startup path, over the same bind, in the same order.
//
// EVERYTHING ELSE FAILS CLOSED, AND THE LIST IS DELIBERATELY LONGER THAN THE ADMITTING CASE:
//
//   - a mount table that cannot be read, at startup or now — `underlay-unknown`;
//   - ANYTHING AT ALL STACKED ABOVE the predeclared rows — `underlay-covered`, which is what this daemon's own
//     live mount produces every second it serves, and equally what a tmpfs, an overlay or a second daemon's
//     corpse produces. The verdict cannot separate those and so it authorises nothing;
//   - a row removed from underneath, or any identity field differing on any predeclared row —
//     `underlay-changed`. A re-mounted bind gets a NEW mount id, so an operator who detached and reattached
//     their own share is refused.
//
// AND IT IS SCOPED. The fingerprint is taken at ONE path — this daemon's own configured mount point — it is
// held in memory for the life of THIS process only, and it is never written down. A durable copy would be
// wrong on its face: mount ids are assigned by the running kernel, so a fingerprint that survived a reboot
// would authorise a comparison against numbers that mean nothing any more.
package fusefs

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/daemon"
)

// MountIdentity is the identity of ONE mount row, as `/proc/self/mountinfo` reports it.
//
// WHAT IS IN IT AND WHY EACH FIELD IS THERE. mountinfo's first five fields are the kernel's own answer to
// "which attachment is this": the mount id is unique among live mounts, the parent id fixes it in the tree,
// the device is the file system it is a view of, the root is WHICH SUBTREE of that file system, and the mount
// point is where it is attached. The optional fields carry the propagation relationship — shared, master,
// propagate_from, unbindable — which is the property that decides whether anything the daemon mounts here is
// visible to the media servers at all; Phase 2's worst defect was a remount that landed in a peer group with
// no host peer. The type and the source name what is attached.
//
// WHAT IS DELIBERATELY NOT IN IT, STATED SO THE OMISSION IS A DECISION RATHER THAN AN OVERSIGHT: the per-mount
// option string and the super-block option string. Those are FLAGS, not identity — `ro` becoming `rw` does not
// make a different file system, and no change in them can let a different attachment masquerade as the
// expected one while every field above still matches. Including them would buy nothing and would make an
// unrelated `mount -o remount` on the operator's own share refuse a recovery.
type MountIdentity struct {
	MountID     string
	ParentID    string
	Device      string
	Root        string
	MountPoint  string
	Propagation string
	FsType      string
	Source      string
}

// canonical is the identity as one unambiguous string. The separator is NUL because it cannot occur in any
// mountinfo field: a separator that can appear in the data makes two different stacks hash the same.
func (m MountIdentity) canonical() string {
	return strings.Join([]string{
		m.MountID, m.ParentID, m.Device, m.Root, m.MountPoint, m.Propagation, m.FsType, m.Source,
	}, "\x00")
}

// SameAttachment reports whether two rows are the SAME attachment, on every field that identifies one.
//
// IT IS THE ONLY WAY A CALLER OUTSIDE THIS PACKAGE MAY COMPARE TWO ROWS, and it exists so that a decision to
// REMOVE something can be made on identity rather than on shape — PROJECTION PHASE 7 §8.7. `CompareUnderlay`
// answers a question about a whole stack against a predeclared baseline; this answers the narrower one a
// shutdown has to ask, which is "is the row on top of the mount point, right now, byte-for-byte the row this
// process created?".
//
// IT REUSES `canonical` RATHER THAN RE-LISTING THE FIELDS, deliberately. A second field list is a second
// place to forget one, and the whole safety of every decision built on this is that the comparison is
// EXHAUSTIVE: mount id, parent mount id, device, subtree root, mount point, propagation, file-system type and
// source. A mount id is unique among live mounts, so a re-mounted attachment of the same share compares
// unequal — which is the property that makes "this is the one I made" mean something.
func (m MountIdentity) SameAttachment(other MountIdentity) bool {
	return m.canonical() == other.canonical()
}

// MountStackAt returns the identities of every mount row at EXACTLY this path, bottom first, and whether the
// mount table could be read at all.
//
// THE SECOND RETURN IS THE SAFETY PROPERTY, EXACTLY AS IT IS ON CountMountsAt. An empty slice has two
// completely different meanings — nothing is mounted here, or the question could not be asked — and a caller
// that cannot tell those apart would compare "nothing" against "nothing" and call it a match. That is the
// shape of defect this repository keeps finding, and it is why the validity travels with the answer.
//
// BOTTOM FIRST, BECAUSE ORDER IS PART OF THE FINGERPRINT. mountinfo lists mounts in the order they were
// applied, so the last row at a path is the one a reader reaches. A stack with the same rows in a different
// order is not the same stack.
func MountStackAt(path string) ([]MountIdentity, bool) {
	return mountStackAtFrom(path, procSelfMountInfo)
}

// mountStackAtFrom is MountStackAt with the mount table as a parameter, and it exists for the same reason
// countMountsAtFrom does: the FAIL-CLOSED branch has to be EXECUTED by a test rather than merely written
// down. There is no way to make the real `/proc/self/mountinfo` unreadable from a test.
func mountStackAtFrom(path, mountInfoPath string) ([]MountIdentity, bool) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, false
	}
	abs = filepath.Clean(abs)
	raw, err := os.ReadFile(mountInfoPath)
	if err != nil {
		return nil, false
	}
	var stack []MountIdentity
	for _, entry := range parseMountInfo(raw) {
		if entry.mountPoint != abs {
			continue
		}
		stack = append(stack, MountIdentity{
			MountID:     entry.mountID,
			ParentID:    entry.parentID,
			Device:      entry.device,
			Root:        entry.root,
			MountPoint:  entry.mountPoint,
			Propagation: entry.propagation,
			FsType:      entry.fsType,
			Source:      entry.source,
		})
	}
	return stack, true
}

// UnderlayDigest is a short, redaction-safe fingerprint of a whole stack.
//
// IT IS PUBLISHED AND THE SOURCE PATHS IT COVERS ARE NOT. A mountinfo source can be an operator's own share
// path; a sha256 prefix of it cannot be read back, cannot match a leak-scan needle, and is still enough for a
// gate to assert from OUTSIDE the process that the attachment the daemon proved identical really was
// identical — before an arm and after it. An empty stack has no fingerprint and answers the empty string,
// which is not the digest of anything.
func UnderlayDigest(stack []MountIdentity) string {
	if len(stack) == 0 {
		return ""
	}
	hash := sha256.New()
	for _, row := range stack {
		_, _ = hash.Write([]byte(row.canonical()))
		_, _ = hash.Write([]byte("\n"))
	}
	return hex.EncodeToString(hash.Sum(nil))[:12]
}

// CompareUnderlay is the whole decision, and it is a pure, TOTAL function of two measurements so the table
// that drives it can be exhaustive without a kernel.
//
// IT ADMITS ON EXACT IDENTITY AND NOTHING ELSE — `underlay-exposed` requires the same number of rows, in the
// same order, each the same attachment. The other three verdicts all refuse, and they are told apart because
// they mean three different afternoons to an operator: `underlay-unknown` is "I could not look",
// `underlay-covered` is "your mount point is intact and something is on top of it" — which is what a serving
// daemon reports every second of its life, and equally what a stacked tmpfs reports — and `underlay-changed`
// is "the thing I measured at startup is not there any more".
//
// THE SECOND RETURN IS FOR A LOG LINE AND IT NAMES THE FIELD, NEVER THE VALUE. A run that refuses is only
// useful if it says which evidence failed; the values behind these names are mount sources and subtree roots,
// which this daemon's log is forbidden to carry. It is empty for every verdict but `underlay-changed`.
func CompareUnderlay(startup []MountIdentity, startupKnown bool,
	current []MountIdentity, currentKnown bool) (verdict string, changedField string) {
	if !startupKnown || !currentKnown {
		return daemon.UnderlayUnknown, ""
	}
	if len(current) < len(startup) {
		// SOMETHING WAS REMOVED FROM UNDERNEATH US. Whatever else is true, this is not the mount point that was
		// measured, and mounting over it would be mounting over something nobody has identified.
		return daemon.UnderlayChanged, "row count"
	}
	// THE PREDECLARED ROWS ARE COMPARED WHERE THEY WERE MEASURED — AT THE BOTTOM, IN ORDER. mountinfo lists
	// mounts in the order they were applied, so everything this daemon or anybody else has added since is above
	// them. A row that has MOVED inside the stack is a different stack and fails on identity here.
	for i := range startup {
		if startup[i].canonical() == current[i].canonical() {
			continue
		}
		return daemon.UnderlayChanged, firstDifferingField(startup[i], current[i])
	}
	if len(current) == len(startup) {
		return daemon.UnderlayExposed, ""
	}
	return daemon.UnderlayCovered, ""
}

// firstDifferingField names the first identity field on which two rows disagree, for a log line, and it names
// the FIELD and never the VALUE.
//
// IT IS ONLY EVER CALLED ON TWO ROWS ALREADY KNOWN TO DIFFER, so the final branch is unreachable in practice —
// and it is still not a panic. Nothing about the shape of a mount point is worth crashing a data plane over.
func firstDifferingField(was, now MountIdentity) string {
	switch {
	case was.MountID != now.MountID:
		return "mount id"
	case was.ParentID != now.ParentID:
		return "parent mount id"
	case was.Device != now.Device:
		return "device"
	case was.Root != now.Root:
		return "subtree root"
	case was.MountPoint != now.MountPoint:
		return "mount point"
	case was.Propagation != now.Propagation:
		return "propagation"
	case was.FsType != now.FsType:
		return "file-system type"
	case was.Source != now.Source:
		return "source"
	default:
		return "identity"
	}
}
