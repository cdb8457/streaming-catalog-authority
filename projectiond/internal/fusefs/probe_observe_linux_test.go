//go:build linux

package fusefs

import (
	"syscall"
	"testing"
)

// THE OBSERVATION READS THE TOP OF THE STACK, AND A REAL HOST IS WHY.
//
// The first run of the mount-truth gate on Unraid reported `foreign` for a mount that was live, readable and
// digest-matching at that same instant. The cause is that a projection mount point is a STACK and the older
// helper reads the BOTTOM of one: in a container the mount point IS the operator's bind, and on a host whose
// storage is itself FUSE the bind's file-system type is the host's. So a healthy stack is
// bottom=fuse.shfs / top=fuse.projectiond, and classifying by the bottom calls it somebody else's.
//
// NONE OF THE INJECTED-OBSERVER TESTS COULD HAVE CAUGHT THIS. They drive the sampler with a fake observer to
// prove the sampler's own logic; what was wrong was the thing being injected. That is the division of labour
// working — the unit tests proved the mechanism, and the host gate proved the wiring.

const (
	hostBindType = "fuse.shfs" // what a bind of Unraid's own storage reports; not ours, and normally present
	foreignType  = "ext4"
)

func TestObservationClassifiesByTheTopOfTheStack(t *testing.T) {
	// THE CASE THAT FAILED ON THE REAL HOST. Bottom is the operator's bind, top is ours, statfs answers.
	if got := classifyObserved(nil, fuseProjectiondType, true); got != ProbeLiveProjectiond {
		t.Fatalf("a live mount stacked on the operator's bind classified as %v, want %v",
			got, ProbeLiveProjectiond)
	}
	// ...and the bottom-entry reading is what the older helper would have produced for that same stack. This
	// asserts the two really do disagree, so the fix cannot be silently reverted into a no-op.
	if got := classify(nil, &mountInfoEntry{mountPoint: "/mnt/projection", fsType: hostBindType}); got !=
		ProbeForeign {
		t.Fatalf("the bottom-entry reading of the failing stack gave %v; this test no longer reproduces the "+
			"disagreement it exists to pin", got)
	}
}

func TestObservationStillNamesACorpseAndAStranger(t *testing.T) {
	// A corpse: the transport is gone and the top of the stack is still ours.
	if got := classifyObserved(syscall.ENOTCONN, fuseProjectiondType, true); got != ProbeStaleProjectiond {
		t.Fatalf("a corpse classified as %v, want %v", got, ProbeStaleProjectiond)
	}
	// SOMEBODY ELSE'S MOUNT IS STILL SOMEBODY ELSE'S. Reading the top must not turn every stack into ours.
	if got := classifyObserved(nil, foreignType, true); got != ProbeForeign {
		t.Fatalf("a foreign mount classified as %v, want %v", got, ProbeForeign)
	}
	// ENOTCONN over something that is NOT ours is not our corpse to name.
	if got := classifyObserved(syscall.ENOTCONN, foreignType, true); got != ProbeForeign {
		t.Fatalf("somebody else's dead mount classified as %v, want %v", got, ProbeForeign)
	}
	// Nothing mounted, and a path that does not exist, are both empty rather than a negative verdict.
	if got := classifyObserved(nil, "", false); got != ProbeEmpty {
		t.Fatalf("an unmounted path classified as %v, want %v", got, ProbeEmpty)
	}
	if got := classifyObserved(syscall.ENOENT, "", false); got != ProbeEmpty {
		t.Fatalf("a missing path classified as %v, want %v", got, ProbeEmpty)
	}
}

// AND THE STACK ORDERING THE OBSERVATION DEPENDS ON IS THE ONE `parseMountInfo` ACTUALLY PRODUCES. Asserting
// the classifier against a hand-supplied "top" would prove nothing about which entry is the top.
func TestTheObservedTopIsTheLastMatchingMountInfoEntry(t *testing.T) {
	raw := []byte(
		"20 1 0:31 / /mnt/projection rw,relatime shared:2 - " + hostBindType + " shfs rw\n" +
			"21 20 0:32 / /mnt/projection rw,relatime shared:3 - fuse.projectiond projectiond rw\n")
	var top string
	var found bool
	for _, entry := range parseMountInfo(raw) {
		if entry.mountPoint == "/mnt/projection" {
			top = entry.fsType
			found = true
		}
	}
	if !found || top != fuseProjectiondType {
		t.Fatalf("the top of the failing stack read as %q (found=%v), want %q", top, found, fuseProjectiondType)
	}
	if got := classifyObserved(nil, top, found); got != ProbeLiveProjectiond {
		t.Fatalf("the real top of the real stack still classified as %v", got)
	}
}
