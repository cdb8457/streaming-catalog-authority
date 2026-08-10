//go:build linux

package fusefs

import "testing"

// THE DRAIN DECIDES WHAT TO REMOVE FROM THIS, AND IT MUST READ THE TOP OF A STACK.
//
// A projection mount point is routinely a stack: every recovery in this daemon stacks over the corpse it
// found. The supervisor's corpse drain removes the mount ON TOP, so it has to be told about the top one —
// and the older helper beside this returns the FIRST line, which is the BOTTOM. Using that one removed a
// layer too many on a real host: the operator's own bind went with the corpses, the daemon remounted into a
// namespace with no host peer, /readyz answered ready, and all three media servers read nothing.
func TestTopMountFsTypeAtReadsTheTopOfAStack(t *testing.T) {
	raw := []byte(
		"20 1 0:31 / /mnt/projection rw,relatime shared:2 - fuse.shfs shfs rw\n" +
			"21 20 0:32 / /mnt/projection rw,relatime shared:3 - fuse.projectiond projectiond rw\n" +
			"22 21 0:33 / /mnt/projection rw,relatime shared:4 - fuse.projectiond projectiond rw\n" +
			"23 1 0:44 / /somewhere/else rw,relatime - fuse.projectiond projectiond rw\n")
	entries := parseMountInfo(raw)
	// The helper reads /proc/self/mountinfo, so the ordering rule it depends on is asserted here against a
	// table this test controls: the LAST matching entry is the top.
	var top string
	var found bool
	for _, entry := range entries {
		if entry.mountPoint == "/mnt/projection" {
			top = entry.fsType
			found = true
		}
	}
	if !found {
		t.Fatal("the fixture has no mount at the path, so this test proves nothing")
	}
	if top != fuseProjectiondType {
		t.Fatalf("the top of the stack read as %q, want %q — reading the FIRST entry instead of the last is "+
			"what made the corpse drain remove the operator's bind", top, fuseProjectiondType)
	}
	// ...AND THE BOTTOM IS THE BIND, which is exactly what must never be removed.
	var bottom string
	for _, entry := range entries {
		if entry.mountPoint == "/mnt/projection" {
			bottom = entry.fsType
			break
		}
	}
	if bottom == fuseProjectiondType {
		t.Fatal("the fixture's bottom entry is one of ours, so it cannot distinguish top from bottom")
	}
	if IsOurMountType(bottom) {
		t.Fatalf("the bind (%q) is classified as ours; the drain would remove it", bottom)
	}
	if !IsOurMountType(top) {
		t.Fatalf("our own mount (%q) is not classified as ours; the drain would never clear a corpse", top)
	}
}

// AND THE TYPE TEST IS THE SAME CONSTANT THE PROBE CLASSIFIES WITH, so a caller deciding what to REMOVE and
// a caller deciding what something IS cannot drift apart.
func TestIsOurMountTypeMatchesTheProbeConstant(t *testing.T) {
	if !IsOurMountType(fuseProjectiondType) {
		t.Fatal("the removal test does not accept the type the probe calls ours")
	}
	for _, foreign := range []string{"fuse.shfs", "ext4", "overlay", "tmpfs", "fuse", ""} {
		if IsOurMountType(foreign) {
			t.Fatalf("%q is treated as ours; only this daemon's own mount may ever be detached", foreign)
		}
	}
}
