package daemon

import (
	"context"
	"testing"
	"time"
)

// The mount observation, driven deterministically.
//
// WHY THESE TESTS EXIST RATHER THAN A HOST GATE ALONE. The states that matter most are the ones a real FUSE
// mount can only be pushed into on a host with /dev/fuse and a cooperating corpse — and the one that matters
// MOST, a probe that never returns, cannot be produced on demand at all. Injecting the observer makes every
// one of them a two-line fixture, so the host gate is left to prove the wiring rather than the logic.

// newTestDaemon builds a real daemon rather than a zero value. A bare &Daemon{} panics in Status(), which is
// worth knowing: the status surface reaches into the store and both caches, so "it compiled" is not evidence
// that a field on it can be read.
func newTestDaemon(t *testing.T) *Daemon {
	t.Helper()
	d, err := New(configFor(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d
}

func TestStatusReportsUncheckedWhenNothingIsWired(t *testing.T) {
	d := newTestDaemon(t)
	// AN ABSENT OBSERVER IS NOT A NEGATIVE RESULT. "nothing looked" reported as "it is not live" is the
	// did-not-look reading of a zero, which is the failure shape this repository keeps finding.
	if got := d.Status().MountObserved; got != MountStateUnchecked {
		t.Fatalf("an unwired observer reported %q rather than %q", got, MountStateUnchecked)
	}
	// ...and sampling with no observer must not invent one either.
	d.SampleMount(time.Second)
	if got := d.Status().MountObserved; got != MountStateUnchecked {
		t.Fatalf("sampling with no observer reported %q", got)
	}
}

func TestStatusReportsWhatTheObserverSaw(t *testing.T) {
	for _, state := range []string{"live-projectiond", "stale-projectiond", "empty", "foreign"} {
		d := newTestDaemon(t)
		d.SetMountObserver(func() string { return state })
		d.SampleMount(time.Second)
		if got := d.Status().MountObserved; got != state {
			t.Fatalf("the observer said %q and the status said %q", state, got)
		}
	}
}

// THE OBSERVATION IS ADDITIVE, AND THIS IS THE TEST THAT SAYS SO. Three closed phases were measured against
// `ready` and `mounted`; if a later edit folded the observation into either, every one of those gates would
// be measuring something it was never measured against.
func TestObservationDoesNotChangeReadyOrMounted(t *testing.T) {
	d := newTestDaemon(t)
	d.SetMounted(true)
	d.SetMountObserver(func() string { return "stale-projectiond" })
	d.SampleMount(time.Second)
	status := d.Status()
	if !status.Mounted {
		t.Fatal("a stale observation changed status.mounted, which three closed phases were measured against")
	}
	if status.MountObserved != "stale-projectiond" {
		t.Fatalf("the divergence was not reported: mountObserved=%q", status.MountObserved)
	}
	// `ready` additionally requires an admitted generation, which this bare daemon has none of; what matters
	// here is only that the observation did not participate in deciding it.
	if status.Ready {
		t.Fatal("ready became true without an admitted generation")
	}
}

// A PROBE THAT NEVER RETURNS MUST AGE THE SAMPLE, NOT HANG THE CALLER, and must not erase what was last
// actually known. This is the whole reason the endpoint answers from a stored sample.
func TestABlockedProbeAgesTheSampleInsteadOfBlocking(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	d := newTestDaemon(t)
	calls := 0
	d.SetMountObserver(func() string {
		calls++
		if calls == 1 {
			return "live-projectiond"
		}
		<-release // every probe after the first is wedged, exactly as a statfs on a dead connection is
		return "live-projectiond"
	})

	d.SampleMount(time.Second)
	if got := d.Status().MountObserved; got != "live-projectiond" {
		t.Fatalf("the first sample did not land: %q", got)
	}

	started := time.Now()
	d.SampleMount(50 * time.Millisecond)
	waited := time.Since(started)
	// IT RETURNED, and it returned on the timeout rather than on the probe.
	if waited > time.Second {
		t.Fatalf("a wedged probe held the sampler for %s", waited)
	}
	status := d.Status()
	// THE LAST GOOD SAMPLE SURVIVES. Replacing it with `timeout` would erase the last thing actually known
	// about the mount in exchange for saying that one probe was slow.
	if status.MountObserved != "live-projectiond" {
		t.Fatalf("a slow probe erased the last completed observation: %q", status.MountObserved)
	}
	// ...AND THE AGE IS WHAT CARRIES THE BAD NEWS. Without it, a minutes-old `live` reads as current.
	if status.MountObservedAgeMs < 50 {
		t.Fatalf("the sample did not age across a wedged probe: %dms", status.MountObservedAgeMs)
	}
}

// WITH NOTHING EVER HAVING COMPLETED, `timeout` is the most that can honestly be said — and it is still not
// the same word as a negative result.
func TestAFirstProbeThatBlocksReportsTimeoutRatherThanAVerdict(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	d := newTestDaemon(t)
	d.SetMountObserver(func() string { <-release; return "live-projectiond" })
	d.SampleMount(50 * time.Millisecond)
	if got := d.Status().MountObserved; got != MountStateTimeout {
		t.Fatalf("a first probe that never answered reported %q rather than %q", got, MountStateTimeout)
	}
}

// THE LOOP IS SEQUENTIAL, WHICH IS WHAT BOUNDS A WEDGED MOUNT TO ONE STUCK GOROUTINE. If it ever started a
// probe per tick regardless, a mount that stayed wedged would accumulate one for every interval it stayed
// that way — and the symptom would be a daemon that slowly stops being able to make goroutines.
func TestTheSampleLoopKeepsExactlyOneProbeOutstanding(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{}, 32)
	d := newTestDaemon(t)
	d.SetMountObserver(func() string {
		entered <- struct{}{}
		<-release
		return "live"
	})
	ctx, cancel := context.WithCancel(context.Background())
	go d.MountSampleLoop(ctx, 10*time.Millisecond, 20*time.Millisecond)
	// Long enough for many ticks to have fired if the loop started a probe on each of them.
	time.Sleep(300 * time.Millisecond)
	cancel()
	close(release)
	if got := len(entered); got != 1 {
		t.Fatalf("the loop had %d probes outstanding against a wedged observer; single-flight is not holding", got)
	}
}

func TestTheSampleLoopStopsWhenItsContextDoes(t *testing.T) {
	d := newTestDaemon(t)
	d.SetMountObserver(func() string { return "live-projectiond" })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { d.MountSampleLoop(ctx, 10*time.Millisecond, time.Second); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the sample loop outlived its context")
	}
}
