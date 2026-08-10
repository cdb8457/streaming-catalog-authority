//go:build linux

package fusefs

import (
	"os"
	"path/filepath"
	"testing"
)

// A ZERO THAT MEANS "DID NOT LOOK" IS NOT A ZERO THAT MEANS "NOTHING THERE".
//
// The supervisor's corpse drain takes a floor from this count and may only remove what is stacked above it.
// The first version returned a bare int and answered 0 for BOTH a mount point with nothing on it and a
// `/proc/self/mountinfo` it could not read — so an unreadable mount table would have set the floor to zero
// and authorised the drain to detach everything at the mount point, the operator's bind included. That is
// the very defect the floor exists to prevent, hiding one layer underneath it.
func TestCountMountsAtReportsWhetherItCouldMeasure(t *testing.T) {
	// A path that certainly exists and certainly has no mount of its own.
	dir := t.TempDir()
	count, known := CountMountsAt(dir)
	if !known {
		t.Fatalf("a readable mount table reported the count as unknown; the drain would refuse to clean up")
	}
	if count != 0 {
		t.Fatalf("a temporary directory reported %d mounts at it, want 0", count)
	}

	// AND A MOUNT TABLE THAT CANNOT BE READ IS UNKNOWN, NOT ZERO. This is the branch that used to answer with
	// a licence to unmount everything, and it is executed here rather than described.
	missing := filepath.Join(dir, "there-is-no-mountinfo-here")
	if got, ok := countMountsAtFrom(dir, missing); ok {
		t.Fatalf("an unreadable mount table reported a MEASURED count of %d; unknown and zero must not be "+
			"the same answer, because the drain spends that zero as a floor", got)
	}

	// ...AND A READABLE ONE IS KNOWN, so the check above is not passing because everything is unknown.
	table := filepath.Join(dir, "mountinfo")
	if err := os.WriteFile(table, []byte("20 1 0:31 / "+dir+" rw - fuse.projectiond projectiond rw\n"), 0o600); err != nil {
		t.Fatalf("could not write the fixture mount table: %v", err)
	}
	got, ok := countMountsAtFrom(dir, table)
	if !ok {
		t.Fatal("a readable fixture mount table reported the count as unknown")
	}
	if got != 1 {
		t.Fatalf("counted %d mounts at the path, want 1", got)
	}
}

// THE ROOT MOUNT IS A COUNT THIS TEST CAN PREDICT WITHOUT KNOWING THE HOST, which is what makes the positive
// case worth asserting at all: a helper that always answered zero-and-known would pass the test above.
func TestCountMountsAtCountsAMountThatIsReallyThere(t *testing.T) {
	count, known := CountMountsAt("/")
	if !known {
		t.Fatal("the mount table could not be read at all, so this test proves nothing")
	}
	if count < 1 {
		t.Fatalf("the root mount point reported %d mounts; every Linux host has at least one", count)
	}
}

// AND THE PARSE IS THE SAME ONE THE PROBE USES, over a table this test controls, so the counting rule is
// pinned without depending on the host's own mounts.
func TestCountingRuleIsExactPathMatch(t *testing.T) {
	raw := []byte(
		"20 1 0:31 / /mnt/projection rw - fuse.shfs shfs rw\n" +
			"21 20 0:32 / /mnt/projection rw - fuse.projectiond projectiond rw\n" +
			"22 1 0:33 / /mnt/projection-other rw - fuse.projectiond projectiond rw\n" +
			"23 1 0:34 / /mnt/projection/nested rw - fuse.projectiond projectiond rw\n")
	got := 0
	for _, entry := range parseMountInfo(raw) {
		if entry.mountPoint == filepath.Clean("/mnt/projection") {
			got++
		}
	}
	if got != 2 {
		t.Fatalf("counted %d mounts at the mount point, want 2 — a prefix collision or a nested mount is "+
			"not a mount AT the path, and counting one would move the floor", got)
	}
	if _, err := os.Stat("/proc/self/mountinfo"); err != nil {
		t.Skipf("no /proc/self/mountinfo on this host: %v", err)
	}
}
