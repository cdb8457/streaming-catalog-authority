//go:build linux

// THE ONE ROW A SHUTDOWN MAY REMOVE, AND THE SEQUENCE OF GENERATIONS THAT PROVES IT HAS TO — PROJECTION PHASE
// 7 §8.7, and §11.4 #16 is the run that made this file necessary.
//
// WHAT #16 MEASURED, IN ONE PARAGRAPH, BECAUSE EVERY ASSERTION BELOW IS SHAPED BY IT. `P7-arm-layers` measured
// **2 against a maximum of 1** at arms R3, R4 and R5 of a six-arm sequence, in BOTH namespaces, while the
// recovery supervisor demonstrably did nothing at all: `recoveryGeneration` never moved,
// `P7-R3-no-recovery-action` measured 0/0 and `P7-R3-mount-untouched` passed. Arm R3 is the only arm that
// REPLACES the daemon — the provider lease is memory-only, so the only way to drop it is to restart the
// process — and a projectiond that goes away without removing its own mount leaves a corpse at a mount point
// whose propagation is `rshared`. Destroying a mount namespace does not propagate an unmount to its peers, so
// the row survives on the host; the replacement daemon then stacks over it, because stacking over a stale
// mount is what this daemon's startup path does BY DESIGN and says so in its own log. Two of ours, for ever,
// and one more for every subsequent replacement.
//
// WHY THE REGRESSION IS A SEQUENCE AND NOT SIX INDEPENDENT CASES, WHICH IS THE HALF THE PREVIOUS ATTEMPT GOT
// WRONG. #13 was recorded as RESOLVED on the strength of a run that reached only the two arms the residual has
// never appeared in. A cold-start table cannot catch this defect: EVERY generation in isolation measures one
// layer above its OWN floor, and the whole failure is that the floor MOVES — generation 2 inherits generation
// 1's corpse and counts it as part of the underlay it may not touch. So `TestTheLayerCountSurvivesASequenceOf
// Generations` drives the shipped decisions across a run of generations against the floor the FIRST one
// measured, which is the only floor a gate or an operator ever compares against.
package main

import (
	"strings"
	"testing"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/fusefs"
)

// THE ROWS. `operatorBind` is the operator's own attachment at the mount point on an Unraid host — the row
// nothing in this product may ever remove — and the rest are what gets stacked over it. They are written as
// identities rather than parsed from a mountinfo fixture because the decision under test takes identities: a
// parser between the table and the assertion would be a second thing that could be wrong.
func row(mountID, parentID, device, fsType string) fusefs.MountIdentity {
	return fusefs.MountIdentity{
		MountID: mountID, ParentID: parentID, Device: device, Root: "/",
		MountPoint: "/mnt/projection", Propagation: "shared:" + mountID, FsType: fsType, Source: fsType,
	}
}

var (
	// The operator's own bind. `fuse.shfs` is Unraid's, and the type is NEVER what makes it safe: it is safe
	// because it is in the startup fingerprint, which is a measurement taken before this process mounted.
	operatorBind = row("41", "40", "0:44", "fuse.shfs")
	// This process's own live mount, and a SECOND one with a different mount id and device — a different
	// attachment of exactly the same shape, which is the case a count can never tell apart.
	ourFirstMount  = row("59", "41", "0:97", "fuse.projectiond")
	ourSecondMount = row("73", "59", "0:104", "fuse.projectiond")
	// A tmpfs somebody stacked on top. R5's own injector, and the row this daemon must leave exactly where it
	// is while spending nothing.
	foreignOverlay = row("88", "41", "0:110", "tmpfs")
	// The SAME operator share, detached and attached again: same device, same subtree, same source, same type,
	// and a new mount id, because that is what the kernel does.
	reattachedBind = row("52", "40", "0:44", "fuse.shfs")
)

// TestPlanShutdownDetachRemovesOnlyTheRowThisProcessMade is the table the whole fix rests on, and it is
// exhaustive on every way the answer can be NO rather than on the one way it can be yes.
func TestPlanShutdownDetachRemovesOnlyTheRowThisProcessMade(t *testing.T) {
	known := ownMountRef{row: ourFirstMount, known: true}
	unproved := ownMountRef{}
	for _, tc := range []struct {
		name            string
		unmountRefused  bool
		own             ownMountRef
		current         []fusefs.MountIdentity
		currentKnown    bool
		want            bool
		wantReasonSaysd string
	}{
		{
			name: "the ordinary unmount worked, so there is nothing left to do",
			// THE POLITE FORM IS TRIED FIRST ON EVERY PATH AND THIS BRANCH IS WHY THE FIX COSTS NOTHING WHEN IT
			// SUCCEEDS: a stop with no consumer holding the mount never reaches the detach at all.
			unmountRefused: false, own: known,
			current: []fusefs.MountIdentity{operatorBind}, currentKnown: true,
			want: false, wantReasonSaysd: "not refused",
		},
		{
			name:           "this process never proved which row was its own",
			unmountRefused: true, own: unproved,
			current: []fusefs.MountIdentity{operatorBind, ourFirstMount}, currentKnown: true,
			want: false, wantReasonSaysd: "never proved",
		},
		{
			name:           "the mount table cannot be read now",
			unmountRefused: true, own: known,
			current: nil, currentKnown: false,
			want: false, wantReasonSaysd: "unreadable mount table",
		},
		{
			name:           "the mount point is already empty",
			unmountRefused: true, own: known,
			current: nil, currentKnown: true,
			want: false, wantReasonSaysd: "nothing is mounted",
		},
		{
			name:           "a FOREIGN overlay is on top — R5's own row, and it is left exactly where it is",
			unmountRefused: true, own: known,
			current: []fusefs.MountIdentity{operatorBind, ourFirstMount, foreignOverlay}, currentKnown: true,
			want: false, wantReasonSaysd: "not the attachment this process created",
		},
		{
			name: "ANOTHER MOUNT OF OURS is on top — same type, same shape, different attachment",
			// The case a file-system type cannot answer and a count cannot answer. The row on top is a
			// `fuse.projectiond` mount above the floor, and it is not the one this process made.
			unmountRefused: true, own: known,
			current: []fusefs.MountIdentity{operatorBind, ourFirstMount, ourSecondMount}, currentKnown: true,
			want: false, wantReasonSaysd: "not the attachment this process created",
		},
		{
			name:           "the OPERATOR'S OWN BIND is the only thing there — our mount is already gone",
			unmountRefused: true, own: known,
			current: []fusefs.MountIdentity{operatorBind}, currentKnown: true,
			want: false, wantReasonSaysd: "not the attachment this process created",
		},
		{
			name:           "the operator detached and re-attached their share, so nothing here is what was measured",
			unmountRefused: true, own: known,
			current: []fusefs.MountIdentity{reattachedBind}, currentKnown: true,
			want: false, wantReasonSaysd: "not the attachment this process created",
		},
		{
			name:           "THE ONE ADMITTING CASE: the row on top is byte-for-byte the one this process made",
			unmountRefused: true, own: known,
			current: []fusefs.MountIdentity{operatorBind, ourFirstMount}, currentKnown: true,
			want: true, wantReasonSaysd: "byte-for-byte",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, why := planShutdownDetach(tc.unmountRefused, tc.own, tc.current, tc.currentKnown)
			if got != tc.want {
				t.Fatalf("want detach=%v, got %v (%s)", tc.want, got, why)
			}
			if !strings.Contains(why, tc.wantReasonSaysd) {
				t.Fatalf("the reason must say %q so an operator can read it; it said %q", tc.wantReasonSaysd, why)
			}
		})
	}
}

// TestTheOwnMountIdentityIsOnlyKnownWhenItCanBePROVED. The identity is what authorises the removal, so every
// state in which it cannot be established has to answer UNKNOWN — and unknown removes nothing, anywhere.
func TestTheOwnMountIdentityIsOnlyKnownWhenItCanBePROVED(t *testing.T) {
	startup := []fusefs.MountIdentity{operatorBind}
	for _, tc := range []struct {
		name         string
		current      []fusefs.MountIdentity
		currentKnown bool
		startup      []fusefs.MountIdentity
		startupKnown bool
		wantKnown    bool
		wantRow      fusefs.MountIdentity
	}{
		{
			name:    "the underlay plus exactly one of ours on top",
			current: []fusefs.MountIdentity{operatorBind, ourFirstMount}, currentKnown: true,
			startup: startup, startupKnown: true,
			wantKnown: true, wantRow: ourFirstMount,
		},
		{
			name: "the startup fingerprint was never taken",
			// §8.4's own rule, applied here without exception: a daemon that could not fingerprint its mount
			// point refuses everything that depends on proving the mount point unchanged, and this is one.
			current: []fusefs.MountIdentity{operatorBind, ourFirstMount}, currentKnown: true,
			startup: nil, startupKnown: false,
			wantKnown: false,
		},
		{
			name:    "the mount table cannot be read now",
			current: nil, currentKnown: false,
			startup: startup, startupKnown: true,
			wantKnown: false,
		},
		{
			name: "TWO of ours are on top, so which one is this process's cannot be told from the stack",
			// This is the state #16 leaves behind, seen from the daemon that INHERITED it. It answers unknown,
			// which is why a daemon that starts into the defect removes nothing on the way out either — it fails
			// closed rather than guessing, and the layer is cleared by the operator remediation that is shipped.
			current: []fusefs.MountIdentity{operatorBind, ourFirstMount, ourSecondMount}, currentKnown: true,
			startup: startup, startupKnown: true,
			wantKnown: false,
		},
		{
			name:    "a foreign overlay is on top, so the top row is not ours",
			current: []fusefs.MountIdentity{operatorBind, foreignOverlay}, currentKnown: true,
			startup: startup, startupKnown: true,
			wantKnown: false,
		},
		{
			name: "the underlay CHANGED underneath — a re-attached bind of the same share",
			// `CompareUnderlay` answers `underlay-changed` on the new mount id, and a stack whose bottom is not
			// the one that was measured is not a stack this process can claim a row in.
			current: []fusefs.MountIdentity{reattachedBind, ourFirstMount}, currentKnown: true,
			startup: startup, startupKnown: true,
			wantKnown: false,
		},
		{
			name:    "nothing is on top at all",
			current: []fusefs.MountIdentity{operatorBind}, currentKnown: true,
			startup: startup, startupKnown: true,
			wantKnown: false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, known := identifyOwnMount(tc.current, tc.currentKnown, tc.startup, tc.startupKnown)
			if known != tc.wantKnown {
				t.Fatalf("want known=%v, got %v", tc.wantKnown, known)
			}
			if known && !got.SameAttachment(tc.wantRow) {
				t.Fatalf("the identity names the wrong row: %+v", got)
			}
		})
	}
}

// TestTheLayerCountSurvivesASequenceOfGENERATIONS is the regression #16 exists for, and it is deliberately not
// six independent cases.
//
// EACH GENERATION IS A WHOLE PROCESS LIFETIME: it fingerprints whatever is at the mount point, mounts on top,
// identifies its own row, and is then replaced. The count is asserted against the floor THE FIRST GENERATION
// MEASURED, because that is the only floor a gate — or an operator watching their own mount point — ever
// compares against. Against its own floor every generation looks perfect, which is exactly why the defect
// survived two six-arm runs and a document that recorded it as resolved.
func TestTheLayerCountSurvivesASequenceOfGENERATIONS(t *testing.T) {
	for _, tc := range []struct {
		name          string
		detachOnStop  bool
		wantFinalRows int
		why           string
	}{
		{
			name:          "WITHOUT the shutdown detach, every replacement leaves one more of ours behind",
			detachOnStop:  false,
			wantFinalRows: 4,
			why: "this is #16: one corpse per stop, and the replacement stacks over it because stacking over " +
				"a stale mount is the shipped startup path",
		},
		{
			name:          "WITH it, the mount point is back to the operator's own bind before the next start",
			detachOnStop:  true,
			wantFinalRows: 2,
			why:           "the underlay plus exactly one live mount, at every generation, for ever",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// THE FLOOR IS TAKEN ONCE, BY THE FIRST GENERATION, AND NEVER RE-TAKEN. That is the whole point.
			stack := []fusefs.MountIdentity{operatorBind}
			runFloor := len(stack)
			const generations = 3
			for generation := 1; generation <= generations; generation++ {
				// A NEW PROCESS: it fingerprints what is there now, which for generation 2 and later may already
				// carry its predecessor's corpse.
				startup := append([]fusefs.MountIdentity(nil), stack...)
				mounted := row("100"+string(rune('0'+generation)), "41", "0:20"+string(rune('0'+generation)),
					"fuse.projectiond")
				stack = append(stack, mounted)
				own := ownMountRef{}
				own.row, own.known = identifyOwnMount(stack, true, startup, true)

				// ...AND THEN IT IS REPLACED, with a consumer holding the mount open so the ordinary unmount is
				// refused. That is the ordinary case in this topology and not the exceptional one.
				if generation == generations {
					break
				}
				if !tc.detachOnStop {
					continue
				}
				if detach, why := planShutdownDetach(true, own, stack, true); detach {
					stack = stack[:len(stack)-1]
				} else if generation == 1 {
					t.Fatalf("the first generation must be able to prove its own row; it said %q", why)
				}
			}
			if len(stack) != tc.wantFinalRows {
				t.Fatalf("after %d generations want %d row(s), got %d — %s",
					generations, tc.wantFinalRows, len(stack), tc.why)
			}
			above := len(stack) - runFloor
			if tc.detachOnStop && above > 1 {
				t.Fatalf("MOUNT_LAYERS_ABOVE_FLOOR_MAX is 1 and this measured %d against the floor the first "+
					"generation took", above)
			}
			if !tc.detachOnStop && above <= 1 {
				t.Fatal("the control must reproduce the defect, or it is not evidence that the fix is what " +
					"removes it")
			}
		})
	}
}

// TestTheShutdownPathTriesThePoliteFormFirstAndNeverAbortsAConnection. Two source properties no pure function
// can state about itself, and both are safety clauses rather than tidiness.
//
// THE ORDINARY UNMOUNT IS FIRST because it takes nothing away from a consumer that is not holding the mount
// open, and the detach is reached only when it has been REFUSED.
//
// AND NOTHING HERE ABORTS A FUSE CONNECTION. Phase 7 §8.2 records the abort-first cleanup as a NEW DESTRUCTIVE
// CAPABILITY this tranche does not ship unless a measured run requires one, and no run has. A shutdown that
// wrote to `/sys/fs/fuse/connections/<n>/abort` would tear the transport out from under every consumer still
// reading, which is the opposite of what a lazy detach does — so its absence is pinned rather than assumed.
func TestTheShutdownPathTriesThePoliteFormFirstAndNeverAbortsAConnection(t *testing.T) {
	source := readMainSource(t)
	signalBranch := source[strings.Index(source, "case sig := <-signals:"):]
	if end := strings.Index(signalBranch, "case <-mount.Done():"); end > 0 {
		signalBranch = signalBranch[:end]
	}
	unmountAt := strings.Index(signalBranch, "mount.Unmount()")
	detachAt := strings.Index(signalBranch, "planShutdownDetach(")
	if unmountAt < 0 || detachAt < 0 {
		t.Fatal("the shutdown path must try the ordinary unmount and then ask planShutdownDetach")
	}
	if unmountAt > detachAt {
		t.Fatal("the ordinary unmount must be attempted BEFORE anything is detached")
	}
	if !strings.Contains(signalBranch, "unix.MNT_DETACH") {
		t.Fatal("the shutdown detach must be the lazy form, which is what removes a mount somebody is holding")
	}
	for _, forbidden := range []string{"fuse/connections", "FUSE_DEV_IOC", "/abort"} {
		if strings.Contains(source, forbidden) {
			t.Fatalf("the shipped supervisor names %q; Phase 7 §8.2 does not ship an abort-first capability",
				forbidden)
		}
	}
}

// TestTheOwnMountIdentityIsReMeasuredAfterEveryMount. A stale identity is worse than none: it names a row that
// no longer exists, so it can never match and the shutdown would silently leave a corpse for ever. Every place
// this process changes what is at its mount point has to re-take it, and there are exactly three.
func TestTheOwnMountIdentityIsReMeasuredAfterEveryMount(t *testing.T) {
	source := readMainSource(t)
	if got := strings.Count(source, "own.record("); got != 3 {
		t.Fatalf("want 3 own.record( call sites — the first mount, the remount, and the drain-alone repair "+
			"that changes the stack without mounting — got %d", got)
	}
	if !strings.Contains(source, "func (o *ownMountRef) record(") {
		t.Fatal("the identity must be re-measured through one named method, not re-derived at each call site")
	}
}
