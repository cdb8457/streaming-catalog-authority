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
//
// WHAT PROJECTION PHASE 3 CHANGED, AND IT IS EXACTLY ONE ROW. The decision used to be a boolean — "should I
// unmount this?" — and for OUR OWN STALE mount the answer was yes, an ORDINARY unmount, on the stated
// reasoning that "leaving it would make the remount a stack over a dead mount". A real run disproved that
// reasoning. With three real media servers holding the mount and the connection aborted under them, the
// ordinary unmount returned WITHOUT REMOVING ANYTHING — an ordinary unmount cannot remove a mount somebody
// is holding — and the mount syscall that followed could not resolve a path through the corpse:
//
//	serve loop died: the FUSE serve loop exited without a requested unmount
//	remount attempt 1/3
//	remount refused: transport endpoint is not connected
//
// So the recovery path never recovered, in precisely the situation it exists for. That one row is now a LAZY
// detach, which is what this daemon's own startup message already tells an operator to do about a stale
// mount ("clear it with: umount -l"). Every other row is unchanged, and the reasons they give are the
// reasons they have always given.
package main

import (
	"testing"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/fusefs"
)

// THE TABLE IS EXHAUSTIVE ON ProbeResult ON PURPOSE. The original defect was not a wrong branch, it was the
// ABSENCE of a branch — so the test that prevents its return has to say something about every value the probe
// can return, including one it cannot yet.
func TestPlanRemountCleanupOnlyEverTouchesOurOwnMount(t *testing.T) {
	for _, tc := range []struct {
		probe fusefs.ProbeResult
		want  remountCleanup
		why   string
	}{
		{fusefs.ProbeLiveProjectiond, remountCleanupUnmount,
			"our own live mount is ours to remove before remounting over it, and it goes the ORDINARY way: " +
				"lazily detaching a live mount takes it away from every consumer holding it"},
		{fusefs.ProbeStaleProjectiond, remountCleanupLazyDetach,
			"our own corpse is ours to remove, and an ORDINARY unmount cannot remove one a consumer is " +
				"holding — measured on the real host, where it returned having removed nothing and the " +
				"remount then failed with ENOTCONN. A corpse costs a consumer nothing to detach: every read " +
				"through a dead connection already fails"},
		{fusefs.ProbeForeign, remountCleanupNone,
			"a foreign mount is the operator's bind in every containerised topology, and unmounting it is " +
				"what made --auto-remount recover for the daemon and for nobody else"},
		{fusefs.ProbeEmpty, remountCleanupNone,
			"there is nothing of ours here; touching it would act on whatever is underneath"},
	} {
		if got := planRemountCleanup(tc.probe, tc.probe); got != tc.want {
			t.Errorf("planRemountCleanup(%s) = %v, want %v — %s", tc.probe, got, tc.want, tc.why)
		}
	}
}

// AND AN UNRECOGNISED RESULT IS NOT A LICENCE TO TOUCH ANYTHING. If ProbeResult gains a value, the safe
// default is to leave the mount point alone: the cost of not cleaning up is a failed remount attempt that
// logs and retries, and the cost of cleaning up the wrong thing is a recovery nobody can see.
func TestPlanRemountCleanupRefusesAnUnknownProbeResult(t *testing.T) {
	unknown := fusefs.ProbeResult(len([...]fusefs.ProbeResult{
		fusefs.ProbeEmpty, fusefs.ProbeStaleProjectiond, fusefs.ProbeLiveProjectiond, fusefs.ProbeForeign,
	}) + 41)
	if got := planRemountCleanup(unknown, unknown); got != remountCleanupNone {
		t.Fatalf("an unrecognised probe result (%s) was planned as %v; it must authorise nothing",
			unknown, got)
	}
}

// THE TWO CASES THAT ARE BOTH "OURS" MUST NOT COLLAPSE BACK INTO ONE ACTION.
//
// This is the regression in one assertion. Before Phase 3 both our-own cases took the same ordinary unmount,
// and that is the whole defect: the action that is right for a mount we are still serving is the action that
// cannot remove one that is dead and held. A future edit that unifies them fails here with the reason.
func TestOurLiveMountAndOurCorpseAreNotCleanedUpTheSameWay(t *testing.T) {
	stale := planRemountCleanup(fusefs.ProbeStaleProjectiond, fusefs.ProbeStaleProjectiond)
	live := planRemountCleanup(fusefs.ProbeLiveProjectiond, fusefs.ProbeLiveProjectiond)
	if stale == live {
		t.Fatalf("a corpse and a live mount are both planned as %v; an ordinary unmount cannot remove a "+
			"corpse a consumer is holding, which is why --auto-remount could not recover from a connection "+
			"abort with three media servers attached", stale)
	}
	if stale != remountCleanupLazyDetach {
		t.Fatalf("our own corpse is planned as %v, not a lazy detach; the ordinary unmount is the one that "+
			"was measured returning without removing anything", stale)
	}
	if live != remountCleanupUnmount {
		t.Fatalf("our own live mount is planned as %v; lazily detaching a live mount takes it away from "+
			"every consumer holding it", live)
	}
}

// AND EVERY PLAN HAS A NAME FOR THE LOG, because a supervisor that says what it did is the only reason this
// defect was locatable at all: "remount refused: transport endpoint is not connected" is the sentence that
// found it.
func TestRemountCleanupNames(t *testing.T) {
	for plan, want := range map[remountCleanup]string{
		remountCleanupNone:       "nothing",
		remountCleanupUnmount:    "unmount",
		remountCleanupLazyDetach: "lazy detach",
	} {
		if got := plan.String(); got != want {
			t.Fatalf("remountCleanup(%d).String() = %q, want %q", int(plan), got, want)
		}
	}
}

// PROJECTION PHASE 7 — THE CORPSE THAT WAS NEVER DRAINED, PINNED WITHOUT A KERNEL.
//
// PHASE 6 §9.7 MEASURED THIS ON THE REAL HOST AND NAMED IT AS NEXT WORK: "a recovery usually STACKS OVER the
// corpse rather than removing it", so a mount point that has survived several recoveries carries several of
// this daemon's dead layers. The cause is not the drain — the drain is careful, floored and capped — it is
// that the drain was never reached, because the decision in front of it asked the BOTTOM of the stack.
//
// In every containerised topology this daemon ships in, the bottom entry at the mount point is the operator's
// own bind, and on an Unraid host that bind's file-system type is `fuse.shfs`. So the state after a serve-loop
// death is: `statfs` answers ENOTCONN (it resolves to the TOP mount, which is our dead one), and the bottom
// mountinfo entry is somebody else's type. `classify` has exactly one answer for that pair, and it is FOREIGN
// — the safest answer available, and the reason nothing was ever drained.
//
// THIS TEST IS THE STATE ITSELF RATHER THAN A DESCRIPTION OF IT, and it fails against the previous signature
// and the previous body: with only the bottom probe there is no argument that can express "the top of the
// stack is my own corpse".
func TestADeadLayerOnTopIsDrainedEvenWhenTheBottomOfTheStackIsNotOurs(t *testing.T) {
	// The exact pair the real host produces after a connection abort inside a container.
	got := planRemountCleanup(fusefs.ProbeForeign, fusefs.ProbeStaleProjectiond)
	if got != remountCleanupLazyDetach {
		t.Fatalf("bottom=foreign top=stale-projectiond planned as %v; that is the shape Phase 6 §9.7 measured "+
			"on the real host — the operator's bind underneath and this daemon's own corpse on top — and "+
			"planning NOTHING for it is what left a dead layer behind on every recovery", got)
	}
	// ...and the same for an EMPTY bottom, which is what a mount point with no bind under it looks like.
	if got := planRemountCleanup(fusefs.ProbeEmpty, fusefs.ProbeStaleProjectiond); got != remountCleanupLazyDetach {
		t.Fatalf("bottom=empty top=stale-projectiond planned as %v, not a drain", got)
	}
}

// AND THE ROW THE WHOLE DESIGN RESTS ON IS UNMOVED: A FOREIGN MOUNT ON TOP IS NEVER TOUCHED.
//
// The likeliest foreign mount at a projection mount point is the operator's own bind — the one mount that has
// to survive for any recovery to be visible to anybody. `--auto-remount` removed it once already, logged
// success, and recovered for the daemon and for nobody else. Phase 7 widens what may be drained and this is
// the assertion that says the widening did not reach that.
func TestAForeignMountOnTopIsStillNeverTouched(t *testing.T) {
	for _, bottom := range []fusefs.ProbeResult{
		fusefs.ProbeEmpty, fusefs.ProbeForeign,
	} {
		if got := planRemountCleanup(bottom, fusefs.ProbeForeign); got != remountCleanupNone {
			t.Fatalf("bottom=%s top=foreign planned as %v; a foreign mount on top is the operator's bind and "+
				"nothing may ever plan an action against it", bottom, got)
		}
	}
	// An unrecognised observation is not a foreign mount and is not ours either: it authorises nothing.
	unknown := fusefs.ProbeResult(97)
	if got := planRemountCleanup(fusefs.ProbeEmpty, unknown); got != remountCleanupNone {
		t.Fatalf("an unrecognised observation (%s) on top planned as %v; it must authorise nothing", unknown, got)
	}
}

// A LIVE MOUNT ON TOP KEEPS THE ORDINARY UNMOUNT, AND IT IS NOT PROMOTED TO A DETACH.
//
// Lazily detaching a mount that is being served takes it away from every consumer holding it, which is the
// opposite of what a recovery is for. The new clause fires on `stale-projectiond` and on nothing else, and
// this is that stated as an assertion rather than as a comment.
func TestALiveMountOnTopIsNeverLazilyDetached(t *testing.T) {
	if got := planRemountCleanup(fusefs.ProbeForeign, fusefs.ProbeLiveProjectiond); got == remountCleanupLazyDetach {
		t.Fatalf("top=live-projectiond planned as a lazy detach; detaching a live mount takes it away from " +
			"every consumer holding it")
	}
	if got := planRemountCleanup(fusefs.ProbeLiveProjectiond, fusefs.ProbeLiveProjectiond); got != remountCleanupUnmount {
		t.Fatalf("our own live mount, top and bottom, planned as %v", got)
	}
}
