//go:build linux

// The remount loop's ONE destructive decision, pinned without a kernel.
//
// WHY THIS FILE EXISTS. `--auto-remount` shipped with an unconditional cleanup unmount, and the first real
// execution of the serve-death gate — on the Unraid host, phase B — showed what that cost. A serve-loop death
// means the FUSE mount is already gone, so the unmount took the mount that was UNDERNEATH it: the operator's
// bind, the one carrying the namespace out of the container. The daemon then remounted onto a plain directory
// in its own root, logged "remounted; serving generation 1", answered /readyz with ready:true, and served a
// namespace that no media server could see. Every claim the daemon made about itself was true.
//
// The gate is what caught it and the gate needs a host. This decision does not: it is a pure function of what
// the probe found, so it is pinned here, in microseconds, everywhere.
package main

import (
	"testing"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/fusefs"
)

// THE TABLE IS EXHAUSTIVE ON ProbeResult ON PURPOSE. The defect was not a wrong branch, it was the ABSENCE of
// a branch — so the test that prevents its return has to say something about every value the probe can
// return, including one it cannot yet.
func TestShouldUnmountBeforeRemountOnlyEverTouchesOurOwnMount(t *testing.T) {
	for _, tc := range []struct {
		probe fusefs.ProbeResult
		want  bool
		why   string
	}{
		{fusefs.ProbeLiveProjectiond, true,
			"our own live mount is ours to remove before remounting over it"},
		{fusefs.ProbeStaleProjectiond, true,
			"our own corpse is ours to remove; leaving it would make the remount a stack over a dead mount"},
		{fusefs.ProbeForeign, false,
			"a foreign mount is the operator's bind in every containerised topology, and unmounting it is " +
				"what made --auto-remount recover for the daemon and for nobody else"},
		{fusefs.ProbeEmpty, false,
			"there is nothing of ours here; unmounting would act on whatever is underneath"},
	} {
		if got := shouldUnmountBeforeRemount(tc.probe); got != tc.want {
			t.Errorf("shouldUnmountBeforeRemount(%s) = %v, want %v — %s", tc.probe, got, tc.want, tc.why)
		}
	}
}

// AND AN UNRECOGNISED RESULT IS NOT A LICENCE TO UNMOUNT. If ProbeResult gains a value, the safe default is
// to leave the mount point alone: the cost of not cleaning up is a failed remount attempt that logs and
// retries, and the cost of cleaning up the wrong thing is a recovery nobody can see.
func TestShouldUnmountBeforeRemountRefusesAnUnknownProbeResult(t *testing.T) {
	unknown := fusefs.ProbeResult(len([...]fusefs.ProbeResult{
		fusefs.ProbeEmpty, fusefs.ProbeStaleProjectiond, fusefs.ProbeLiveProjectiond, fusefs.ProbeForeign,
	}) + 41)
	if shouldUnmountBeforeRemount(unknown) {
		t.Fatalf("an unrecognised probe result (%s) must not authorise an unmount", unknown)
	}
}
