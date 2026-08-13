package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Projection Phase 6 — the bounded recovery state machine, driven deterministically.
//
// WHY THE POLICY IS TESTED HERE AND NOT ONLY ON A HOST. Everything interesting about this machine is defined
// by the passage of time and by a budget: a fault that has not sustained, a cooldown that has not elapsed, a
// budget with one attempt left, a budget with none, and a lockout that has to survive a process. A host gate
// can produce each of those once, slowly, with a real mount and a real fault; a table with a fake clock
// produces all of them exhaustively, including both sides of every boundary, which is where an off-by-one in
// a bound actually lives.
//
// AND THE ONE PROPERTY THAT MATTERS MOST IS A NEGATIVE. Almost every case below asserts that NOTHING happens.
// A recovery supervisor is judged by what it declines to do, and a test suite for one that mostly demonstrated
// successful recoveries would be measuring the least dangerous half of it.
//
// THE GATE IS STILL WHAT PROVES IT IS WIRED UP. These tests drive `decideRecovery`, `classifyRecovery` and the
// ledger; they say nothing about whether a real remount against a real overlay clears a real fault. That is
// `deploy/projection-recovery-gate.sh`, and neither one is sufficient alone.

// rat is a fixed instant, owned by the test. A policy about elapsed time tested against the wall clock is a
// test measuring how long it took to run.
var rat = time.Date(2026, 8, 12, 3, 0, 0, 0, time.UTC)

// recoveryBaseline is an enabled supervisor looking at a sustained, actionable, un-attempted fault with the
// whole budget available. Every case states only its own difference from it, so what each case is about is
// the line it changes.
func recoveryBaseline() recoveryInputs {
	return recoveryInputs{
		now:            rat,
		enabled:        true,
		class:          RecoverActStaleMount,
		actionable:     true,
		sustainedSince: rat.Add(-RecoverySustain - time.Millisecond),
	}
}

func TestRecoveryPrecedenceIsTheOnePhase6Predeclared(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*recoveryInputs)
		act     bool
		code    string
		state   string
		remedy  string
		refusal bool
	}{
		{
			// THE CONTROL, AND IT IS NOT OPTIONAL. Without a case that reaches an action, every case below is
			// satisfied by a supervisor that does nothing under all circumstances — which is most of them.
			name:   "a sustained fault on our own stale mount, with budget, is acted on",
			mutate: func(*recoveryInputs) {},
			act:    true, code: RecoverActStaleMount, state: RecoveryStateActing,
			remedy: RecoveryRemediationNone,
		},
		{
			name:   "disabled outranks everything, including a lockout",
			mutate: func(in *recoveryInputs) { in.enabled = false; in.lockedOut = true },
			act:    false, code: RecoveryNoActionDisabled, state: RecoveryStateDisabled,
			remedy: RecoveryRemediationNone,
		},
		{
			// SINGLE-FLIGHT OUTRANKS THE LOCKOUT because it is the more precise answer: "we are still inside
			// the last attempt" says more than "the budget that attempt spent is gone".
			name:   "an attempt in flight stops everything else, even with budget",
			mutate: func(in *recoveryInputs) { in.inFlight = true },
			act:    false, code: RecoveryNoActionInFlight, state: RecoveryStateActing,
			remedy: RecoveryRemediationNone,
		},
		{
			name: "a lockout from a spent budget asks for a reset",
			mutate: func(in *recoveryInputs) {
				in.lockedOut = true
				in.lockoutCode = RecoveryBudgetExhausted
			},
			act: false, code: RecoveryNoActionLockedOut, state: RecoveryStateLockedOut,
			remedy: RecoveryRemediationResetLedger,
		},
		{
			// A DIFFERENT LOCKOUT WITH A DIFFERENT FIRST SUSPECT. Resetting the ledger does not help when the
			// ledger is the thing that is broken, so it does not say to.
			name: "a lockout from an unusable ledger points at the cache directory instead",
			mutate: func(in *recoveryInputs) {
				in.lockedOut = true
				in.lockoutCode = RecoveryLedgerUnreadable
			},
			act: false, code: RecoveryNoActionLockedOut, state: RecoveryStateLockedOut,
			remedy: RecoveryRemediationCheckCache,
		},
		{
			// THE MOST IMPORTANT CASE IN THE FILE. Something not ours is on the mount point and the answer is
			// to name it and stop, with no attempt spent — because the likeliest foreign mount in every
			// topology this daemon ships in is the operator's own bind.
			name: "a foreign mount is refused, spends nothing, and asks a human to look",
			mutate: func(in *recoveryInputs) {
				in.class = RecoveryRefuseForeignMount
				in.actionable = false
				in.refusal = true
			},
			act: false, code: RecoveryRefuseForeignMount, state: RecoveryStateIdle,
			remedy: RecoveryRemediationInspectOwner, refusal: true,
		},
		{
			name: "an unrecognised state is refused rather than guessed at",
			mutate: func(in *recoveryInputs) {
				in.class = RecoveryRefuseUnknownState
				in.actionable = false
				in.refusal = true
			},
			act: false, code: RecoveryRefuseUnknownState, state: RecoveryStateIdle,
			remedy: RecoveryRemediationInspectOwner, refusal: true,
		},
		{
			name: "a healthy daemon does nothing and says so",
			mutate: func(in *recoveryInputs) {
				in.class = RecoveryNoActionHealthy
				in.actionable = false
			},
			act: false, code: RecoveryNoActionHealthy, state: RecoveryStateIdle,
			remedy: RecoveryRemediationNone,
		},
		{
			// A SERVE DEATH IS SOMEBODY ELSE'S, AND ACTING ON IT WOULD BE TWO REMOUNTS FOR ONE FAULT.
			name: "a serve-loop death belongs to the serve supervisor and this loop declines it",
			mutate: func(in *recoveryInputs) {
				in.class = RecoveryNoActionServeOwns
				in.actionable = false
			},
			act: false, code: RecoveryNoActionServeOwns, state: RecoveryStateIdle,
			remedy: RecoveryRemediationNone,
		},
		{
			name: "a fault that has not sustained is observed, not acted on",
			mutate: func(in *recoveryInputs) {
				in.sustainedSince = in.now.Add(-RecoverySustain + time.Millisecond)
			},
			act: false, code: RecoveryNoActionNotSustained, state: RecoveryStateObserving,
			remedy: RecoveryRemediationNone,
		},
		{
			// THE BOUNDARY, FROM THE OTHER SIDE. Exactly the sustain window is not YET the sustain window,
			// which is the direction an off-by-one here has to fail in.
			name: "a fault sustained for exactly the window is still not acted on",
			mutate: func(in *recoveryInputs) {
				in.sustainedSince = in.now.Add(-RecoverySustain)
			},
			act: false, code: RecoveryNoActionNotSustained, state: RecoveryStateObserving,
			remedy: RecoveryRemediationNone,
		},
		{
			name: "a class that has only just appeared has no sustain window at all",
			mutate: func(in *recoveryInputs) {
				in.sustainedSince = time.Time{}
			},
			act: false, code: RecoveryNoActionNotSustained, state: RecoveryStateObserving,
			remedy: RecoveryRemediationNone,
		},
		{
			name: "an attempt inside the cooldown waits",
			mutate: func(in *recoveryInputs) {
				in.attempts = 1
				in.lastAttemptAt = in.now.Add(-RecoveryCooldown + time.Millisecond)
			},
			act: false, code: RecoveryNoActionCooldown, state: RecoveryStateCoolingDown,
			remedy: RecoveryRemediationNone,
		},
		{
			name: "an attempt past the cooldown, with budget left, is acted on",
			mutate: func(in *recoveryInputs) {
				in.attempts = 1
				in.lastAttemptAt = in.now.Add(-RecoveryCooldown)
			},
			act: true, code: RecoverActStaleMount, state: RecoveryStateActing,
			remedy: RecoveryRemediationNone,
		},
		{
			// THE BUDGET IS CHECKED HERE AS WELL AS WHERE IT IS SPENT, AND THAT IS ON PURPOSE. Reaching this
			// with the lockout not already set means a crash landed between the spend and the outcome, and a
			// guard that lives only in the writer is a guard a crash removes.
			name: "a spent budget locks out even when the ledger did not record it",
			mutate: func(in *recoveryInputs) {
				in.attempts = RecoveryMaxAttempts
				in.lastAttemptAt = in.now.Add(-time.Hour)
			},
			act: false, code: RecoveryBudgetExhausted, state: RecoveryStateLockedOut,
			remedy: RecoveryRemediationResetLedger,
		},
		{
			name: "the last attempt of the budget is still allowed",
			mutate: func(in *recoveryInputs) {
				in.attempts = RecoveryMaxAttempts - 1
				in.lastAttemptAt = in.now.Add(-time.Hour)
			},
			act: true, code: RecoverActStaleMount, state: RecoveryStateActing,
			remedy: RecoveryRemediationNone,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			in := recoveryBaseline()
			testCase.mutate(&in)
			got := decideRecovery(in)
			if got.Act() != testCase.act {
				t.Fatalf("act: want %v, got %v (code %s)", testCase.act, got.Act(), got.Code())
			}
			if got.Code() != testCase.code {
				t.Fatalf("code: want %s, got %s", testCase.code, got.Code())
			}
			if got.State() != testCase.state {
				t.Fatalf("state: want %s, got %s", testCase.state, got.State())
			}
			if got.Remediation() != testCase.remedy {
				t.Fatalf("remediation: want %s, got %s", testCase.remedy, got.Remediation())
			}
			if got.IsRefusal() != testCase.refusal {
				t.Fatalf("refusal: want %v, got %v", testCase.refusal, got.IsRefusal())
			}
		})
	}
}

// TestClassificationIsExhaustiveOnEveryReadinessReason is the pin that stops a reason code added later from
// falling silently into whatever the last branch happens to be. Every code in the Phase 5 closed set has a
// row here, and an unknown one refuses.
func TestClassificationIsExhaustiveOnEveryReadinessReason(t *testing.T) {
	cases := []struct {
		reason     string
		observed   string
		underlay   string
		class      string
		actionable bool
		refusal    bool
	}{
		{ReadyReasonOK, MountStateLive, UnderlayCovered, RecoveryNoActionHealthy, false, false},
		{ReadyReasonMountRecovering, MountStateLive, UnderlayCovered, RecoveryNoActionConfirming, false, false},
		{ReadyReasonNoGeneration, MountStateUnchecked, UnderlayCovered, RecoveryNoActionNothingToServe, false, false},
		{ReadyReasonNotMounted, MountStateUnchecked, UnderlayExposed, RecoveryNoActionNotMounted, false, false},
		{ReadyReasonServeLoopDead, MountStateLive, UnderlayExposed, RecoveryNoActionServeOwns, false, false},
		{ReadyReasonMountNotLive, "stale-projectiond", UnderlayCovered, RecoverActStaleMount, true, false},
		{ReadyReasonMountNotLive, "empty", UnderlayExposed, RecoverActMountEmpty, true, false},
		{ReadyReasonMountNotLive, "foreign", UnderlayCovered, RecoveryRefuseForeignMount, false, true},
		{ReadyReasonMountNotLive, "foreign", UnderlayChanged, RecoveryRefuseForeignMount, false, true},
		{ReadyReasonMountNotLive, "foreign", UnderlayUnknown, RecoveryRefuseForeignMount, false, true},
		{ReadyReasonMountNotLive, "foreign", UnderlayExposed, RecoverActMountUnderlay, true, false},
		{ReadyReasonMountNotLive, "something-new", UnderlayExposed, RecoveryRefuseUnknownState, false, true},
		{ReadyReasonObservationStale, MountStateLive, UnderlayCovered, RecoverActObservationStale, true, false},
		{ReadyReasonObservationUnavailable, MountStateTimeout, UnderlayCovered,
			RecoverActObservationUnavailable, true, false},
		{"a-reason-nobody-has-written-yet", MountStateLive, UnderlayExposed, RecoveryRefuseUnknownState, false, true},
	}
	for _, testCase := range cases {
		class, actionable, refusal := classifyRecovery(testCase.reason, testCase.observed, testCase.underlay)
		if class != testCase.class || actionable != testCase.actionable || refusal != testCase.refusal {
			t.Fatalf("%s/%s/%s: want (%s,%v,%v), got (%s,%v,%v)", testCase.reason, testCase.observed,
				testCase.underlay, testCase.class, testCase.actionable, testCase.refusal,
				class, actionable, refusal)
		}
	}
}

// TestTheUnderlayVerdictIsREADONLYONTHEFOREIGNROW is Phase 7 §8.4's containment, asserted rather than
// described. The new argument is a licence to act, so the thing that has to be proved is not that it works —
// the row above proves that — but that it CANNOT REACH ANY OTHER ROW. Every readiness reason and every
// observation is driven against all four verdicts, and only the foreign row is allowed to move.
//
// WITHOUT THIS THE ARGUMENT WOULD BE "we only read it in one place, look at the code". That is the same
// argument every widened condition in this repository's history was shipped on.
func TestTheUnderlayVerdictIsReadOnlyOnTheForeignRow(t *testing.T) {
	reasons := []string{
		ReadyReasonOK, ReadyReasonMountRecovering, ReadyReasonNoGeneration, ReadyReasonNotMounted,
		ReadyReasonServeLoopDead, ReadyReasonMountNotLive, ReadyReasonObservationStale,
		ReadyReasonObservationUnavailable, "a-reason-nobody-has-written-yet",
	}
	observations := []string{MountStateLive, MountStateTimeout, MountStateUnchecked,
		"stale-projectiond", "empty", "foreign", "something-new"}
	verdicts := []string{UnderlayExposed, UnderlayCovered, UnderlayChanged, UnderlayUnknown, "a-verdict-from-nowhere"}
	for _, reason := range reasons {
		for _, observed := range observations {
			baseClass, baseActionable, baseRefusal := classifyRecovery(reason, observed, UnderlayUnknown)
			for _, verdict := range verdicts {
				class, actionable, refusal := classifyRecovery(reason, observed, verdict)
				foreignRow := reason == ReadyReasonMountNotLive && observed == "foreign"
				if foreignRow {
					// THE FOREIGN ROW IS ASSERTED ABSOLUTELY AND NOT AGAINST A BASELINE, and a tamper is why.
					// Widening the condition to `underlay != ""` moved the BASELINE too — every verdict admitted,
					// including the one this loop was using as its reference — so an invariance check alone
					// passed a change that had made every foreign mount actionable. Both halves are now stated as
					// what they must be rather than as what they must equal.
					if verdict == UnderlayExposed {
						if class != RecoverActMountUnderlay || !actionable || refusal {
							t.Fatalf("the foreign row with a PROVED underlay is not actionable: (%s,%v,%v)",
								class, actionable, refusal)
						}
					} else if class != RecoveryRefuseForeignMount || actionable || !refusal {
						t.Fatalf("the foreign row with verdict %s is not a refusal: (%s,%v,%v)",
							verdict, class, actionable, refusal)
					}
					continue
				}
				if class != baseClass || actionable != baseActionable || refusal != baseRefusal {
					t.Fatalf("%s/%s moved when the underlay verdict became %s: (%s,%v,%v) not (%s,%v,%v)",
						reason, observed, verdict, class, actionable, refusal,
						baseClass, baseActionable, baseRefusal)
				}
			}
		}
	}
}

// TestAnUnwiredUnderlayVerifierRefuses is the fail-closed branch, EXECUTED. A daemon whose verifier was never
// wired — an older `main`, a test, a future caller who forgot — must answer the verdict that refuses, not the
// one that admits, and it must not answer the empty string either: the status surface publishes this.
func TestAnUnwiredUnderlayVerifierRefuses(t *testing.T) {
	d := &Daemon{}
	verdict, digest := d.underlayEvidence()
	if verdict != UnderlayUnknown {
		t.Fatalf("an unwired verifier answered %q, not %q", verdict, UnderlayUnknown)
	}
	if digest != "" {
		t.Fatalf("an unwired verifier produced a digest %q out of nothing", digest)
	}
	class, actionable, refusal := classifyRecovery(ReadyReasonMountNotLive, "foreign", verdict)
	if class != RecoveryRefuseForeignMount || actionable || refusal != true {
		t.Fatalf("an unwired verifier admitted a foreign mount: (%s,%v,%v)", class, actionable, refusal)
	}
}

// TestAVerdictOutsideTheClosedSetIsNotAVerdict drives the guard in `underlayEvidence` that exists precisely
// because nothing can currently reach it.
func TestAVerdictOutsideTheClosedSetIsNotAVerdict(t *testing.T) {
	for _, answer := range []string{"", "underlay", "expected", "underlay-exposed-ish", "UNDERLAY-EXPOSED"} {
		d := &Daemon{}
		d.SetUnderlayVerifier(func() (string, string) { return answer, "abcdef123456" })
		verdict, digest := d.underlayEvidence()
		if verdict != UnderlayUnknown {
			t.Fatalf("the verifier answered %q and the daemon published %q", answer, verdict)
		}
		// THE DIGEST SURVIVES AND THE VERDICT DOES NOT, deliberately: the digest is evidence for a human and
		// authorises nothing, so throwing it away would remove the only clue about what went wrong.
		if digest != "abcdef123456" {
			t.Fatalf("the digest was discarded: %q", digest)
		}
	}
	for _, answer := range []string{UnderlayExposed, UnderlayCovered, UnderlayChanged, UnderlayUnknown} {
		d := &Daemon{}
		d.SetUnderlayVerifier(func() (string, string) { return answer, "" })
		if verdict, _ := d.underlayEvidence(); verdict != answer {
			t.Fatalf("the closed-set verdict %q was rewritten to %q", answer, verdict)
		}
	}
}

// TestTheStatusSurfaceNeverPublishesABlankUnderlayVerdict — a surface field that is sometimes absent is a
// field every consumer has to guess about, and the guess that matters here is the unsafe one.
func TestTheStatusSurfaceNeverPublishesABlankUnderlayVerdict(t *testing.T) {
	d := &Daemon{}
	if got := d.RecoveryStatus().Underlay; got != UnderlayUnknown {
		t.Fatalf("a daemon that has taken no decision publishes %q", got)
	}
	d.EnableRecovery(false)
	if got := d.RecoveryStatus().Underlay; got != UnderlayUnknown {
		t.Fatalf("a disabled daemon publishes %q", got)
	}
}

// TestNoActionableClassIsEverAlsoARefusal is a shape check rather than a behaviour one, and it is here
// because the two flags are read independently by `decideRecovery`. A class that was both would take the
// refusal branch and never act, silently, which is a feature disappearing rather than failing.
func TestNoActionableClassIsEverAlsoARefusal(t *testing.T) {
	reasons := []string{
		ReadyReasonOK, ReadyReasonMountRecovering, ReadyReasonNoGeneration, ReadyReasonNotMounted,
		ReadyReasonServeLoopDead, ReadyReasonMountNotLive, ReadyReasonObservationStale,
		ReadyReasonObservationUnavailable,
	}
	observations := []string{MountStateLive, MountStateTimeout, MountStateUnchecked,
		"stale-projectiond", "empty", "foreign"}
	for _, reason := range reasons {
		for _, observed := range observations {
			for _, underlay := range []string{UnderlayExposed, UnderlayCovered, UnderlayChanged, UnderlayUnknown} {
				_, actionable, refusal := classifyRecovery(reason, observed, underlay)
				if actionable && refusal {
					t.Fatalf("%s/%s/%s is both actionable and a refusal", reason, observed, underlay)
				}
			}
		}
	}
}

// TestAbsentLedgerIsAFreshBudgetAndAnUnreadableOneLocksOut is the whole of failing closed on this path, and
// the two halves are genuinely different facts: a supervisor that has never had a budget has spent none of
// it, and a supervisor that cannot see how much it has spent must not spend more.
func TestAbsentLedgerIsAFreshBudgetAndAnUnreadableOneLocksOut(t *testing.T) {
	dir := t.TempDir()
	d := &Daemon{cfg: Config{ProbeCacheDir: dir}}

	d.EnableRecovery(true)
	if d.recovery.ledger.LockedOut || d.recovery.ledger.Attempts != 0 {
		t.Fatalf("an absent ledger should be a fresh budget, got %+v", d.recovery.ledger)
	}

	if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, RecoveryLedgerFilename)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, RecoveryLedgerFilename), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	other := &Daemon{cfg: Config{ProbeCacheDir: dir}}
	other.EnableRecovery(true)
	if !other.recovery.ledger.LockedOut ||
		other.recovery.ledger.LockoutCode != RecoveryLedgerUnreadable {
		t.Fatalf("an unreadable ledger must lock out, got %+v", other.recovery.ledger)
	}
}

// TestAFutureLedgerVersionIsUnreadableRatherThanGuessedAt. Reading a shape we do not know as though it were
// ours could report a lockout as absent, and that is the one direction that must never happen by accident.
func TestAFutureLedgerVersionIsUnreadableRatherThanGuessedAt(t *testing.T) {
	dir := t.TempDir()
	raw, err := json.Marshal(RecoveryLedger{Version: recoveryLedgerVersion + 1, LockedOut: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, RecoveryLedgerFilename)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, RecoveryLedgerFilename), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	d := &Daemon{cfg: Config{ProbeCacheDir: dir}}
	d.EnableRecovery(true)
	if !d.recovery.ledger.LockedOut || d.recovery.ledger.LockoutCode != RecoveryLedgerUnreadable {
		t.Fatalf("a future ledger version must be unreadable, got %+v", d.recovery.ledger)
	}
}

// TestNoDurableDirectoryIsALockoutRatherThanALicence. A budget that cannot be persisted is a budget the next
// restart refunds, and a refundable budget bounds nothing at all.
func TestNoDurableDirectoryIsALockoutRatherThanALicence(t *testing.T) {
	d := &Daemon{cfg: Config{}}
	d.EnableRecovery(true)
	if !d.recovery.ledger.LockedOut || d.recovery.ledger.LockoutCode != RecoveryLedgerUnwritable {
		t.Fatalf("no cache directory must lock out, got %+v", d.recovery.ledger)
	}
}

// TestTheLockoutSurvivesTheProcess is the property that makes an infinite restart loop unreachable. Docker
// restarts a daemon that exits; an in-memory budget of three would therefore authorise three attempts PER
// RESTART, which is not a bound.
func TestTheLockoutSurvivesTheProcess(t *testing.T) {
	dir := t.TempDir()
	first := &Daemon{cfg: Config{ProbeCacheDir: dir}}
	first.EnableRecovery(true)
	first.recovery.ledger.Attempts = RecoveryMaxAttempts
	first.recovery.ledger.LockedOut = true
	first.recovery.ledger.LockoutCode = RecoveryBudgetExhausted
	first.recovery.mu.Lock()
	if err := first.persistLedgerLocked(); err != nil {
		first.recovery.mu.Unlock()
		t.Fatal(err)
	}
	first.recovery.mu.Unlock()

	// A DIFFERENT PROCESS, WHICH IS WHAT A RESTART IS.
	second := &Daemon{cfg: Config{ProbeCacheDir: dir}}
	second.EnableRecovery(true)
	if !second.recovery.ledger.LockedOut {
		t.Fatal("a lockout did not survive a restart, so the budget is not a bound")
	}
	if got := second.RecoveryStatus(); got.State != RecoveryStateLockedOut {
		t.Fatalf("the restarted daemon should publish locked-out, got %s", got.State)
	}

	// ...AND A HUMAN IS THE ONLY THING THAT CLEARS IT.
	if err := ResetRecoveryLedger(dir); err != nil {
		t.Fatal(err)
	}
	third := &Daemon{cfg: Config{ProbeCacheDir: dir}}
	third.EnableRecovery(true)
	if third.recovery.ledger.LockedOut || third.recovery.ledger.Attempts != 0 {
		t.Fatalf("the reset did not clear the lockout, got %+v", third.recovery.ledger)
	}
	// A SECOND RESET IS A SUCCESSFUL ONE. The post-condition is "there is no spent budget here".
	if err := ResetRecoveryLedger(dir); err != nil {
		t.Fatalf("resetting an already-clear ledger should succeed: %v", err)
	}
}

// TestTheProbeCacheDoesNotEATTheLedger is the regression for the defect `RC11` found on the real host, and
// it is the most serious one this tranche has produced.
//
// The ledger lives inside the daemon's DURABLE cache directory, which is the one place the operator contract
// already requires to be durable and writable. The probe cache owns the top level of that directory and
// sweeps out every name it does not recognise — so the ledger was deleted on EVERY startup, and the lockout
// that exists to make an infinite restart loop unreachable did not survive a restart. Measured on Tower as
// `stateAfterRestart=idle attempts=0`, with the daemon cheerfully ready.
//
// THE TEST DRIVES THE REAL CONSTRUCTOR, not an imitation of the sweep. `daemon.New` builds the probe cache
// exactly as a starting daemon does, so this fails against a cache that removes what it does not recognise
// and passes against one that leaves directories alone.
func TestTheProbeCacheDoesNotEatTheLedger(t *testing.T) {
	dir := t.TempDir()
	first := &Daemon{cfg: Config{ProbeCacheDir: dir}}
	first.EnableRecovery(true)
	first.recovery.mu.Lock()
	first.recovery.ledger.Attempts = RecoveryMaxAttempts
	first.recovery.ledger.LockedOut = true
	first.recovery.ledger.LockoutCode = RecoveryBudgetExhausted
	err := first.persistLedgerLocked()
	first.recovery.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}

	// A DAEMON STARTING FROM NOTHING, which is what a container restart is. `New` constructs the probe cache
	// against the same directory before anything reads the ledger.
	restarted, err := New(Config{
		ProbeCacheDir: dir,
		MountPoint:    filepath.Join(dir, "mnt"),
		PointerPath:   filepath.Join(dir, "manifest", "pointer.json"),
		StatusAddr:    "127.0.0.1:0",
	})
	if err != nil {
		t.Fatalf("a daemon could not be constructed against the ledger's own directory: %v", err)
	}
	defer func() { _ = restarted.Close() }()
	restarted.EnableRecovery(true)
	if !restarted.recovery.ledger.LockedOut {
		t.Fatal("the lockout did not survive a daemon construction, so the budget is not a bound")
	}
	if restarted.recovery.ledger.Attempts != RecoveryMaxAttempts {
		t.Fatalf("the spent budget did not survive: %+v", restarted.recovery.ledger)
	}
}

// TestADisabledDaemonPublishesDisabledAndSpendsNothing. Phase 6 changes nothing at all for an operator who
// did not ask for it, and the surface says so rather than leaving it to be inferred from a zero.
func TestADisabledDaemonPublishesDisabledAndSpendsNothing(t *testing.T) {
	d := &Daemon{cfg: Config{ProbeCacheDir: t.TempDir()}}
	d.EnableRecovery(false)
	got := d.RecoveryStatus()
	if got.State != RecoveryStateDisabled || got.Reason != RecoveryNoActionDisabled {
		t.Fatalf("a disabled supervisor should say so, got %+v", got)
	}
	if got.Attempts != 0 || got.Generation != 0 || got.LastOutcome != RecoveryOutcomeNone {
		t.Fatalf("a disabled supervisor should have spent nothing, got %+v", got)
	}
	if d.RecoveryEnabled() {
		t.Fatal("RecoveryEnabled disagrees with EnableRecovery(false)")
	}
}

// TestTheGenerationCountsEveryAttemptAndIsNeverRefunded. The attempt count is a budget and is refunded; the
// generation is a history and is not. Without the second, "recovered once, an hour ago" and "recovering right
// now" look identical to anything reading the surface.
func TestTheGenerationCountsEveryAttemptAndIsNeverRefunded(t *testing.T) {
	dir := t.TempDir()
	d := &Daemon{cfg: Config{ProbeCacheDir: dir}}
	d.EnableRecovery(true)

	d.recovery.mu.Lock()
	d.recovery.ledger.Attempts = 2
	d.recovery.ledger.Generation = 5
	d.recovery.ledger.Attempts = 0
	if err := d.persistLedgerLocked(); err != nil {
		d.recovery.mu.Unlock()
		t.Fatal(err)
	}
	d.recovery.mu.Unlock()

	reloaded := &Daemon{cfg: Config{ProbeCacheDir: dir}}
	reloaded.EnableRecovery(true)
	if reloaded.recovery.ledger.Generation != 5 {
		t.Fatalf("the generation should survive a refund and a restart, got %d",
			reloaded.recovery.ledger.Generation)
	}
}

// TestTheLedgerIsWrittenAtomically. A torn ledger is an unreadable one and an unreadable one locks out, so a
// crash mid-write would turn a recoverable appliance into one that needs a human — the outcome the
// persistence exists to avoid everywhere else. The temporary file must not be left behind either.
func TestTheLedgerIsWrittenAtomically(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, RecoveryLedgerFilename)
	if err := writeRecoveryLedger(path, RecoveryLedger{Attempts: 1, Generation: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("the temporary ledger file was left behind")
	}
	back, err := loadRecoveryLedger(path)
	if err != nil {
		t.Fatal(err)
	}
	if back.Attempts != 1 || back.Version != recoveryLedgerVersion {
		t.Fatalf("the ledger did not round-trip, got %+v", back)
	}
}

// TestAFreshVerdictIsNEVERPAIREDWithAStaleObservation — PROJECTION PHASE 7 §8.4.5, and it is a regression test
// for a defect a REAL HOST found on the first run of the arm it was written for.
//
// WHAT HAPPENED. The classification took the observation from the sampler's store and the underlay verdict from
// a FRESH read. The instant a recovery's remount landed, the fresh verdict became `underlay-covered` — this
// daemon's own new mount was now on top of the operator's bind — while the last COMPLETED observation was still
// the `foreign` one that had authorised the recovery. The pair `mount-observed-not-live` + `foreign` +
// `underlay-covered` is a refusal, so the surface published `refuse-foreign-mount` with remediation
// `inspect-mount-owner` about a mount point the daemon had just repaired. Nothing was spent and nothing was
// done — it was a REPORTING defect — and this surface's whole value is that it can be read at any instant.
// `P7-R1-remediation` caught it: `'inspect-mount-owner'` where the contract allows only `none` or
// `reset-recovery-ledger`.
//
// THE TEST DRIVES THE STORE, NOT THE CLOCK. It stores exactly the sample the sampler stores at that moment and
// asserts what the decision does with it, so it fails against a decision that reaches past the sample.
func TestAFreshVerdictIsNeverPairedWithAStaleObservation(t *testing.T) {
	d := &Daemon{}
	// The verifier answers what the mount point looks like NOW: our own recovery mount is back on top.
	d.SetUnderlayVerifier(func() (string, string) { return UnderlayCovered, "cccccccccccc" })
	// ...and the last COMPLETED observation is the one that authorised the recovery, taken while the mount was
	// gone: `foreign`, with the underlay EXPOSED at that same instant.
	d.storeObservation("foreign", UnderlayExposed, "eeeeeeeeeeee", time.Now())

	underlay, digest := d.sampledUnderlay()
	if underlay != UnderlayExposed {
		t.Fatalf("the sampled verdict is %q; the decision would be reasoning about a different instant",
			underlay)
	}
	if digest != "eeeeeeeeeeee" {
		t.Fatalf("the sampled digest is %q, not the one taken with the observation", digest)
	}
	class, actionable, refusal := classifyRecovery(ReadyReasonMountNotLive, "foreign", underlay)
	if class == RecoveryRefuseForeignMount {
		t.Fatalf("the class is a refusal on a mount point the daemon has just repaired — this is the "+
			"transient P7-R1-remediation measured, with remediation %q", RecoveryRemediationInspectOwner)
	}
	if class != RecoverActMountUnderlay || !actionable || refusal {
		t.Fatalf("the sampled pair no longer names the recovery it authorised: (%s,%v,%v)",
			class, actionable, refusal)
	}
	// AND THE FRESHNESS IS NOT LOST, IT MOVED: the ACT is refused because the LIVE verdict has changed. The
	// decision that does that is its own function so a table can drive the shipped one, and every class that is
	// not this one passes through it untouched.
	for _, notThisClass := range []string{RecoverActStaleMount, RecoverActMountEmpty, RecoverActObservationStale,
		RecoverActObservationUnavailable} {
		for _, live := range []string{UnderlayExposed, UnderlayCovered, UnderlayChanged, UnderlayUnknown} {
			if !underlayStillAdmitsTheAct(notThisClass, live) {
				t.Fatalf("%s was blocked by a live verdict of %s, which is not evidence about it", notThisClass, live)
			}
		}
	}
	if !underlayStillAdmitsTheAct(RecoverActMountUnderlay, UnderlayExposed) {
		t.Fatalf("a live verdict of %s no longer authorises the act it names", UnderlayExposed)
	}
	for _, live := range []string{UnderlayCovered, UnderlayChanged, UnderlayUnknown, "", "underlay-exposed-ish"} {
		if underlayStillAdmitsTheAct(RecoverActMountUnderlay, live) {
			t.Fatalf("a live verdict of %q authorised mounting over a mount point that is not the measured one", live)
		}
	}
}

// TestTheSampledVerdictFailsClosedBeforeAnythingHasBeenSampled — the store starts empty, and an empty store
// must not be readable as a licence. It also covers a sample written by an older shape, whose verdict field is
// the zero string.
func TestTheSampledVerdictFailsClosedBeforeAnythingHasBeenSampled(t *testing.T) {
	d := &Daemon{}
	if verdict, digest := d.sampledUnderlay(); verdict != UnderlayUnknown || digest != "" {
		t.Fatalf("an unsampled daemon answers %q/%q", verdict, digest)
	}
	d.storeObservation("foreign", "", "", time.Now())
	if verdict, _ := d.sampledUnderlay(); verdict != UnderlayUnknown {
		t.Fatalf("a sample with no verdict answers %q, not the one that refuses", verdict)
	}
	class, actionable, _ := classifyRecovery(ReadyReasonMountNotLive, "foreign", UnderlayUnknown)
	if class != RecoveryRefuseForeignMount || actionable {
		t.Fatalf("a sample with no verdict authorised %s", class)
	}
	// AND A PROBE THAT NEVER COMPLETED IS THE SAME ANSWER. `noteProbeUnfinished` writes the only sample a
	// daemon that has never observed anything has, and it may not carry a licence either.
	fresh := &Daemon{}
	fresh.noteProbeUnfinished()
	if verdict, _ := fresh.sampledUnderlay(); verdict != UnderlayUnknown {
		t.Fatalf("the first-ever unfinished probe stored the verdict %q", verdict)
	}
}
