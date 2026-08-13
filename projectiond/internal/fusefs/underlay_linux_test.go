//go:build linux

// THE EXPECTED-UNDERLAY DECISION, DRIVEN AS A TABLE OF REAL MOUNT TABLES. Projection Phase 7 §8.4.
//
// EVERY FIXTURE BELOW IS A `/proc/self/mountinfo` IN THE MACHINE FORM THE KERNEL WRITES, and the topologies are
// the ones this appliance actually meets rather than invented ones: an Unraid container whose mount point is a
// `fuse.shfs` bind, this daemon's own mount stacked over it, a second daemon's corpse above that, a tmpfs
// overlay, a bind that was detached and reattached, and a mount table that cannot be read at all.
//
// THE PARSER IS DRIVEN THROUGH THE SEAM AND NOT AROUND IT. `mountStackAtFrom` takes the mount table's path, so
// what these tests exercise is the same code that reads `/proc/self/mountinfo` on the host, including the
// escape handling and the optional-field split — not a reimplementation of it that could agree with the test
// and disagree with the kernel.
package fusefs

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/daemon"
)

// The rows. `shfsBind` is the operator's own bind at the mount point on an Unraid host, which is the row every
// verdict in this file is about; the rest are what gets stacked over it.
const (
	shfsBind      = `41 40 0:44 /appdata/catalog-p7/run/mnt /mnt/projection rw,noatime shared:11 - fuse.shfs /dev/shfs rw,allow_other`
	ourLiveMount  = `59 41 0:97 / /mnt/projection ro,nosuid,nodev,relatime shared:59 - fuse.projectiond projectiond ro,user_id=0,group_id=0,allow_other`
	corpseAbove   = `73 41 0:104 / /mnt/projection ro,nosuid,nodev,relatime shared:73 - fuse.projectiond projectiond ro,user_id=0,group_id=0,allow_other`
	tmpfsOverlay  = `88 41 0:110 / /mnt/projection rw,relatime shared:88 - tmpfs tmpfs rw,size=1024k`
	elsewhere     = `40 33 0:44 /appdata /mnt/user rw,noatime shared:10 - fuse.shfs /dev/shfs rw,allow_other`
	beneathTarget = `45 41 0:44 /appdata/x /mnt/projection/inner rw,noatime shared:12 - fuse.shfs /dev/shfs rw,allow_other`
)

// reattachedBind is the SAME operator share, detached and mounted again: same device, same subtree, same
// source, same type — and a NEW mount id and a new peer group, because that is what the kernel does. It is the
// single most important refusal in this file, and the reason a file-system type can never be the evidence.
const reattachedBind = `52 40 0:44 /appdata/catalog-p7/run/mnt /mnt/projection rw,noatime shared:19 - fuse.shfs /dev/shfs rw,allow_other`

// writeMountInfo puts a fixture where the seam can read it and returns its path.
func writeMountInfo(t *testing.T, rows ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mountinfo")
	body := ""
	for _, row := range rows {
		body += row + "\n"
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("the fixture could not be written: %v", err)
	}
	return path
}

func stackFrom(t *testing.T, rows ...string) []MountIdentity {
	t.Helper()
	stack, known := mountStackAtFrom("/mnt/projection", writeMountInfo(t, rows...))
	if !known {
		t.Fatalf("a readable fixture answered unknown")
	}
	return stack
}

// TestTheStackAtAPathIsOrderedAndScopedToThatPath. Two properties in one table, and both have cost a real run
// somewhere in this repository: order, because the last row is the one a reader reaches, and scoping, because
// `/mnt/projection/inner` and `/mnt/user` are not `/mnt/projection` however much a prefix match would like
// them to be.
func TestTheStackAtAPathIsOrderedAndScopedToThatPath(t *testing.T) {
	stack := stackFrom(t, elsewhere, shfsBind, beneathTarget, ourLiveMount, corpseAbove)
	if len(stack) != 3 {
		t.Fatalf("want 3 rows at the mount point, got %d", len(stack))
	}
	if stack[0].FsType != "fuse.shfs" || stack[0].MountID != "41" {
		t.Fatalf("the bottom row is not the operator's bind: %+v", stack[0])
	}
	if stack[2].MountID != "73" {
		t.Fatalf("the top row is not the last one applied: %+v", stack[2])
	}
	if stack[1].Source != "projectiond" || stack[1].Root != "/" || stack[1].Propagation != "shared:59" {
		t.Fatalf("the identity fields did not survive the parse: %+v", stack[1])
	}
}

// TestTheWholeUnderlayDecision is the table this whole tranche turns on. Each row is a startup fingerprint, a
// present-day mount table, and the verdict — and only ONE verdict in the closed set authorises an action.
func TestTheWholeUnderlayDecision(t *testing.T) {
	cases := []struct {
		name    string
		startup []string
		now     []string
		verdict string
		field   string
	}{
		{
			// THE ARM THIS EXISTS FOR. The daemon started over the operator's bind, mounted above it, and the
			// mount was then removed from underneath a living daemon. What is left is exactly what was measured.
			name:    "the projectiond mount is gone and the operator's own bind is exposed",
			startup: []string{shfsBind},
			now:     []string{shfsBind},
			verdict: daemon.UnderlayExposed,
		},
		{
			// THE OVERWHELMINGLY COMMON ANSWER, AND IT REFUSES. This is every second of a healthy appliance.
			name:    "our own live mount is on top of it, which is the healthy steady state",
			startup: []string{shfsBind},
			now:     []string{shfsBind, ourLiveMount},
			verdict: daemon.UnderlayCovered,
		},
		{
			// R5, AND PHASE 6 CALLS IT ITS MOST IMPORTANT ROW. A foreign overlay must refuse, and it refuses on
			// the row count before any identity is compared — the tmpfs's own type is never consulted.
			name:    "a tmpfs is stacked above the live mount",
			startup: []string{shfsBind},
			now:     []string{shfsBind, ourLiveMount, tmpfsOverlay},
			verdict: daemon.UnderlayCovered,
		},
		{
			name:    "a tmpfs is stacked directly on the exposed bind",
			startup: []string{shfsBind},
			now:     []string{shfsBind, tmpfsOverlay},
			verdict: daemon.UnderlayCovered,
		},
		{
			// R2. Somebody else's corpse above our live mount is not the state that admits a mount either: the
			// drain is what deals with that, under the floor it has always had.
			name:    "a second daemon's corpse is above our live mount",
			startup: []string{shfsBind},
			now:     []string{shfsBind, ourLiveMount, corpseAbove},
			verdict: daemon.UnderlayCovered,
		},
		{
			// OUR OWN CORPSE ALONE ON THE BIND IS STILL NOT `exposed`, and it does not need to be: the
			// observation answers `stale-projectiond` there and `recover-stale-mount` has always been actionable.
			name:    "our own corpse is the only thing above the bind",
			startup: []string{shfsBind},
			now:     []string{shfsBind, corpseAbove},
			verdict: daemon.UnderlayCovered,
		},
		{
			// THE MOST IMPORTANT REFUSAL IN THE FILE. Same share, same device, same source, same type — and a
			// different attachment. Nothing but the mount id can tell these apart, which is exactly why the
			// identity and not the type is the evidence.
			name:    "the operator detached and reattached their own share",
			startup: []string{shfsBind},
			now:     []string{reattachedBind},
			verdict: daemon.UnderlayChanged,
			field:   "mount id",
		},
		{
			name:    "the bind is gone and the mount point is a plain directory",
			startup: []string{shfsBind},
			now:     []string{},
			verdict: daemon.UnderlayChanged,
			field:   "row count",
		},
		{
			name:    "the bind was replaced by something of a different type at the same mount id",
			startup: []string{shfsBind},
			now:     []string{`41 40 0:44 /appdata/catalog-p7/run/mnt /mnt/projection rw,noatime shared:11 - tmpfs tmpfs rw`},
			verdict: daemon.UnderlayChanged,
			field:   "file-system type",
		},
		{
			name:    "the bind now shows a different subtree of the same device",
			startup: []string{shfsBind},
			now:     []string{`41 40 0:44 /appdata/somebody-else /mnt/projection rw,noatime shared:11 - fuse.shfs /dev/shfs rw,allow_other`},
			verdict: daemon.UnderlayChanged,
			field:   "subtree root",
		},
		{
			// THE PROPAGATION RELATIONSHIP IS OWNERSHIP EVIDENCE, and Phase 2's worst defect is why. A remount
			// that lands in a peer group with no host peer recovers for the daemon and for nobody else, so a
			// mount point whose propagation has changed underneath us is not one to mount over.
			name:    "the bind's propagation relationship changed",
			startup: []string{shfsBind},
			now:     []string{`41 40 0:44 /appdata/catalog-p7/run/mnt /mnt/projection rw,noatime - fuse.shfs /dev/shfs rw,allow_other`},
			verdict: daemon.UnderlayChanged,
			field:   "propagation",
		},
		{
			name:    "the device beneath the bind changed",
			startup: []string{shfsBind},
			now:     []string{`41 40 0:55 /appdata/catalog-p7/run/mnt /mnt/projection rw,noatime shared:11 - fuse.shfs /dev/shfs rw,allow_other`},
			verdict: daemon.UnderlayChanged,
			field:   "device",
		},
		{
			// A DEEPER STACK AT STARTUP IS A LEGITIMATE STARTING STATE — an operator who inherited a corpse and
			// did not clear it — and the whole of it is the fingerprint, in order.
			name:    "a two-row startup stack, exposed again exactly",
			startup: []string{shfsBind, corpseAbove},
			now:     []string{shfsBind, corpseAbove},
			verdict: daemon.UnderlayExposed,
		},
		{
			name:    "a two-row startup stack with the corpse gone is CHANGED, not exposed",
			startup: []string{shfsBind, corpseAbove},
			now:     []string{shfsBind},
			verdict: daemon.UnderlayChanged,
			field:   "row count",
		},
		{
			// ORDER IS PART OF THE FINGERPRINT. The same two rows the other way up is a different stack, and it
			// must not be admitted just because the multiset matches.
			name:    "the same two rows in the other order",
			startup: []string{shfsBind, corpseAbove},
			now:     []string{corpseAbove, shfsBind},
			verdict: daemon.UnderlayChanged,
			field:   "mount id",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			startup := stackFrom(t, testCase.startup...)
			now := stackFrom(t, testCase.now...)
			verdict, field := CompareUnderlay(startup, true, now, true)
			if verdict != testCase.verdict {
				t.Fatalf("verdict: want %s, got %s", testCase.verdict, verdict)
			}
			if field != testCase.field {
				t.Fatalf("changed field: want %q, got %q", testCase.field, field)
			}
		})
	}
}

// TestAnUnreadableMountTableAuthorisesNothing is the fail-closed branch, EXECUTED on both sides. It is the
// branch that cannot be produced against the real `/proc/self/mountinfo`, which is exactly why the seam exists
// — every worst defect in this repository has arrived through a branch nothing had ever run.
func TestAnUnreadableMountTableAuthorisesNothing(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "there-is-no-mountinfo-here")
	stack, known := mountStackAtFrom("/mnt/projection", missing)
	if known {
		t.Fatalf("an unreadable mount table answered known")
	}
	if stack != nil {
		t.Fatalf("an unreadable mount table produced %d row(s)", len(stack))
	}
	good := stackFrom(t, shfsBind)
	for _, tc := range []struct {
		name                   string
		startupKnown, nowKnown bool
	}{
		{"the startup fingerprint could not be taken", false, true},
		{"the present mount table cannot be read", true, false},
		{"neither could be read", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			verdict, field := CompareUnderlay(good, tc.startupKnown, good, tc.nowKnown)
			if verdict != daemon.UnderlayUnknown {
				t.Fatalf("want %s, got %s", daemon.UnderlayUnknown, verdict)
			}
			if field != "" {
				t.Fatalf("an unknown verdict named a changed field %q", field)
			}
		})
	}
	// AND AN UNREADABLE TABLE IS NOT AN EMPTY ONE. Two empty stacks compare equal, so the whole safety property
	// here rests on the validity flag travelling with the answer rather than on the slice being nil.
	if verdict, _ := CompareUnderlay(nil, true, nil, true); verdict != daemon.UnderlayExposed {
		t.Fatalf("two KNOWN empty stacks are identical; got %s", verdict)
	}
	if verdict, _ := CompareUnderlay(nil, false, nil, false); verdict != daemon.UnderlayUnknown {
		t.Fatalf("two UNKNOWN empty stacks must refuse; got %s", verdict)
	}
}

// TestTheUnderlayDigestIsStableAndDiscriminating. It is published, so it has to be the same across two reads
// of an unchanged mount point and different for anything this file calls a different stack. A digest that
// collided would make the gate's own cross-check of the daemon's proof vacuous.
func TestTheUnderlayDigestIsStableAndDiscriminating(t *testing.T) {
	if got := UnderlayDigest(nil); got != "" {
		t.Fatalf("an empty stack has no fingerprint; got %q", got)
	}
	base := UnderlayDigest(stackFrom(t, shfsBind))
	if len(base) != 12 {
		t.Fatalf("the digest is %d characters, not 12: %q", len(base), base)
	}
	if again := UnderlayDigest(stackFrom(t, shfsBind)); again != base {
		t.Fatalf("the same stack fingerprinted twice as %q and %q", base, again)
	}
	for name, rows := range map[string][]string{
		"the reattached bind":   {reattachedBind},
		"the bind plus our own": {shfsBind, ourLiveMount},
		"a different order":     {ourLiveMount, shfsBind},
		"a tmpfs instead":       {tmpfsOverlay},
	} {
		if got := UnderlayDigest(stackFrom(t, rows...)); got == base {
			t.Fatalf("%s fingerprinted the same as the operator's own bind: %q", name, got)
		}
	}
}

// TestTheDigestCannotBeForgedByASeparatorInAField. The canonical form joins fields, so a field containing the
// separator could make two different stacks hash alike. mountinfo escapes spaces to `\040`, so the attack is
// a mount point named with one — and the NUL separator is what makes it impossible rather than unlikely.
func TestTheDigestCannotBeForgedByASeparatorInAField(t *testing.T) {
	// Two rows whose (root, source) pair differs only in where the boundary falls.
	left := MountIdentity{Root: "/a", Source: "b"}
	right := MountIdentity{Root: "/a\x00b", Source: ""}
	if UnderlayDigest([]MountIdentity{left}) == UnderlayDigest([]MountIdentity{right}) {
		t.Fatalf("two different identities fingerprinted alike")
	}
	if verdict, _ := CompareUnderlay([]MountIdentity{left}, true, []MountIdentity{right}, true); verdict !=
		daemon.UnderlayChanged {
		t.Fatalf("two different identities compared equal: %s", verdict)
	}
}
