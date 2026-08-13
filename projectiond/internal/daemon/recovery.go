// Projection Phase 6 — bounded automatic recovery. What the daemon may DO about the state Phase 5 taught it
// to REPORT, and — far more importantly — everything it may not.
//
// PHASE 5 CLOSED SAYING "IT REPORTS; IT DOES NOT ACT", AND NAMED THIS AS THE DECISION SOMEBODY WOULD HAVE TO
// TAKE. This file is that decision. It is a whole tranche rather than an `if` because an appliance that
// remounts itself is one failure away from an appliance that remounts itself forever, and a remount loop with
// no floor is strictly WORSE than a mount that stays broken and says so: the broken mount is visible, and the
// loop looks like activity.
//
// SO ALMOST EVERYTHING HERE IS ABOUT REFUSING.
//
//   - Only a fault Phase 5's policy ALREADY BELIEVED may be acted on. That falls out of reading `readyReason`
//     and nothing else: every code this file treats as actionable is a code readiness is being withheld for,
//     and inside the fault hold or the bootstrap grace the reason is `ok`, which is inert here.
//   - Only a fault that then SUSTAINS a second whole hold may be acted on, so nothing the daemon's own
//     recovery paths were about to clear is ever acted on.
//   - Only a mount that is OURS may be touched. A FOREIGN observation is refused rather than cleared — in
//     every containerised topology this daemon ships in, the likeliest foreign mount is the operator's own
//     bind, and unmounting it is the exact defect `--auto-remount` shipped once already.
//   - Only a BOUNDED number of attempts may ever be spent, and the spend is written to durable storage
//     BEFORE the attempt. A supervisor that cannot record what it is about to spend does not spend it.
//
// THE ACTION ITSELF IS NOT NEW CODE. It is the remount the serve-death supervisor has used since Phase 2,
// with the mount-identity guards Phase 3 cost nineteen gate defects to get right. Phase 6 adds a second
// REASON to call it and nothing whatever to what it does.
package daemon

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// The predeclared bounds. Every one of them is mirrored in `PROJECTIOND_MOUNT_RECOVERY` in
// `src/core/projection/runtime-contract.ts`, and `test/projection-bounded-recovery.ts` fails if the two
// disagree — the same containment Phase 5's numbers have.
const (
	// RecoveryTick is how often the decision is evaluated. DERIVED: one sample interval. The decision is a
	// pure function of the readiness verdict, and that verdict cannot change faster than the sampler feeding
	// it, so evaluating more often is polling a constant.
	RecoveryTick = 1000 * time.Millisecond
	// RecoverySustain is how long an actionable class must be reported CONTINUOUSLY before anything is done.
	// DERIVED: one whole fault hold, which is the second hold and deliberately the same length as the first.
	// Phase 5's hold proves the fault is not a sampling artefact; this one proves it is not one the daemon's
	// own serve-death remount, confirmation or next probe was about to clear.
	RecoverySustain = 6000 * time.Millisecond
	// RecoveryAttemptDeadline is the longest one attempt may take before it is ABANDONED. An abandoned
	// attempt may be inside an uninterruptible syscall — a statfs against a wedged connection returns when
	// the connection is torn down and not before — so this bounds how long the supervisor waits, counts the
	// attempt and STOPS. It never starts a second attempt over an abandoned one.
	RecoveryAttemptDeadline = 20000 * time.Millisecond
	// RecoveryCooldown is how long after an attempt before another may start. DERIVED: the whole attempt
	// deadline, because an attempt may be abandoned rather than finished and this is the only cooldown that
	// keeps two attempts from overlapping in wall-clock when it is.
	RecoveryCooldown = 20000 * time.Millisecond
	// RecoveryMaxAttempts is the budget between resets. CHOSEN: the same three the serve-death remount has
	// spent since Phase 2, so an operator who knows one bound knows both.
	RecoveryMaxAttempts = 3
	// RecoveryConfirm is how long readiness must be continuously `ok` after an attempt before the budget
	// resets. DERIVED: the recovery confirmation plus one whole worst-case sampling window, which is the
	// smallest addition that guarantees the `ok` refunding the budget was re-derived from an observation
	// taken AFTER the attempt rather than from the one that granted it.
	RecoveryConfirm = 4000 * time.Millisecond
	// RecoveryLedgerFilename is where the budget lives, inside the daemon's DURABLE cache directory.
	//
	// IT IS IN A SUBDIRECTORY OF ITS OWN, AND THAT IS NOT TIDINESS. The probe cache owns the top level of
	// that directory and sweeps out every name it does not recognise; a ledger sitting beside its records was
	// deleted on every startup, so the lockout that makes an infinite restart loop unreachable did not
	// survive a restart. `RC11` measured it on the real host. The cache no longer touches directories at all,
	// and this no longer sits where it could.
	RecoveryLedgerFilename = "recovery/recovery-ledger.json"
	// recoveryLedgerVersion is the on-disk shape. An unknown version is unreadable rather than guessed at,
	// which locks out — see loadRecoveryLedger for why that is the safe direction.
	recoveryLedgerVersion = 1
)

// The closed set of decision codes. Every action, every refusal and every deliberate inaction is one of
// these; no arbitrary text is ever published as a reason. They divide into four kinds and the division is
// load-bearing: `no-action-*` is a state that is not a fault or not yet one, `refuse-*` is a fault this
// supervisor can SEE and is NOT ENTITLED to act on, `recover-*` is an action named by the fault it is taken
// for, and `recovery-*` is what became of one.
const (
	RecoveryNoActionHealthy        = "no-action-healthy"
	RecoveryNoActionDisabled       = "no-action-disabled"
	RecoveryNoActionConfirming     = "no-action-confirming"
	RecoveryNoActionNothingToServe = "no-action-nothing-to-serve"
	RecoveryNoActionNotMounted     = "no-action-not-mounted"
	RecoveryNoActionServeOwns      = "no-action-serve-supervisor-owns"
	RecoveryNoActionNotSustained   = "no-action-not-sustained"
	RecoveryNoActionCooldown       = "no-action-cooldown"
	RecoveryNoActionInFlight       = "no-action-attempt-in-flight"
	RecoveryNoActionLockedOut      = "no-action-locked-out"
	RecoveryNoActionSupervisorBusy = "no-action-supervisor-busy"

	RecoveryRefuseForeignMount = "refuse-foreign-mount"
	RecoveryRefuseUnknownState = "refuse-unknown-state"

	RecoverActStaleMount = "recover-stale-mount"
	RecoverActMountEmpty = "recover-mount-empty"
	// RecoverActMountUnderlay is PHASE 7'S ONE ADDITIVE CODE, and it is additive rather than a reuse of
	// `recover-mount-empty` because the two are not the same observation and an operator must not be told they
	// are. `recover-mount-empty` means the mount point had NOTHING on it. This one means the mount point has
	// exactly what the operator attached before this daemon first mounted, and nothing else — the projectiond
	// mount above it is gone. The ACTION is identical (mount, over the same bind, in the same order as
	// startup); the FAULT is a different one and the surface names the fault.
	RecoverActMountUnderlay          = "recover-mount-underlay"
	RecoverActObservationStale       = "recover-observation-stale"
	RecoverActObservationUnavailable = "recover-observation-unavailable"

	RecoverySucceeded        = "recovery-succeeded"
	RecoveryFailed           = "recovery-failed"
	RecoveryAttemptTimeout   = "recovery-attempt-timeout"
	RecoveryBudgetExhausted  = "recovery-budget-exhausted"
	RecoveryLedgerUnreadable = "recovery-ledger-unreadable"
	RecoveryLedgerUnwritable = "recovery-ledger-unwritable"
)

// The closed set of published states. `recoveryReason` alone cannot carry this: the same code means
// different things while acting and while cooling down.
const (
	RecoveryStateDisabled    = "disabled"
	RecoveryStateIdle        = "idle"
	RecoveryStateObserving   = "observing"
	RecoveryStateActing      = "acting"
	RecoveryStateCoolingDown = "cooling-down"
	RecoveryStateLockedOut   = "locked-out"
)

// The closed set of remediations. An operator surface that says what is wrong and not what to do about it
// sends people to the logs. They are CODES and carry no path: the operator knows their own mount point, and
// this document is meant to be pasteable into an issue.
const (
	RecoveryRemediationNone         = "none"
	RecoveryRemediationInspectOwner = "inspect-mount-owner"
	RecoveryRemediationResetLedger  = "reset-recovery-ledger"
	RecoveryRemediationCheckCache   = "check-cache-directory"
)

// The closed set of UNDERLAY VERDICTS — Phase 7 §8.4 — and it is three values of which exactly ONE admits an
// action. The verdict answers one question and only one: is the mount point, right now, in exactly the state
// that was fingerprinted BEFORE this process mounted anything?
//
// THEY LIVE IN THIS PACKAGE AND ARE COMPUTED IN `fusefs` BECAUSE THAT IS THE ONLY DIRECTION THE IMPORTS ALLOW,
// and it also puts the closed set where every other closed set this daemon publishes lives — beside the
// decision codes, under the same rule, checked by the same pin in both directions.
const (
	// UnderlayUnknown is "this could not be proved": the mount table could not be read, at startup or now, or
	// the startup measurement disagreed with itself. It refuses, which is the whole of failing closed here.
	UnderlayUnknown = "underlay-unknown"
	// UnderlayExposed IS THE ONE ADMITTING VERDICT: the mount point holds exactly the rows that were
	// fingerprinted before this process mounted anything, in the same order, each the same attachment — and
	// nothing above them. The predeclared underlay is EXPOSED because the projectiond mount that was covering
	// it is gone, which is precisely the state an external `umount` leaves behind.
	UnderlayExposed = "underlay-exposed"
	// UnderlayCovered is the NORMAL, HEALTHY, OVERWHELMINGLY COMMON answer, and it refuses. The predeclared
	// rows are all still there and unchanged, and something is mounted above them — this daemon's own live
	// mount, every second that it is serving. It is also what a stacked tmpfs, a foreign overlay and a second
	// daemon's corpse produce, and none of those is separable from the healthy case by this question, which is
	// exactly why this verdict authorises nothing.
	UnderlayCovered = "underlay-covered"
	// UnderlayChanged is "the predeclared rows themselves are not what they were": one was removed from
	// beneath us, or one is a different attachment — a re-mounted bind gets a new mount id, so an operator who
	// detached and reattached their own share lands here and is refused.
	UnderlayChanged = "underlay-changed"
)

// The closed set of attempt outcomes published beside the state.
const (
	RecoveryOutcomeNone      = "none"
	RecoveryOutcomeSucceeded = "succeeded"
	RecoveryOutcomeFailed    = "failed"
	RecoveryOutcomeRefused   = "refused"
)

// RecoveryLedger is the durable budget.
//
// IT IS ON DISK BECAUSE A BUDGET HELD IN MEMORY IS RESET BY THE THING IT EXISTS TO BOUND. `restart:
// unless-stopped` restarts a daemon that exits, so an in-memory budget of three would authorise three
// attempts PER RESTART and therefore an unbounded number of them — which is the infinite remount loop this
// whole tranche forbids. A lockout in this file is still a lockout after a crash, a restart, an upgrade and
// a host reboot.
//
// IT CARRIES COUNTS, STAMPS AND CLOSED-SET CODES AND NOTHING ELSE. No path, no mount point, no OS error.
type RecoveryLedger struct {
	Version int `json:"version"`
	// Attempts is how much of the budget is spent since the last refund or reset.
	Attempts int `json:"attempts"`
	// Generation counts every attempt this ledger has ever recorded and is never reset by a refund. It is
	// what lets an operator or a gate tell "recovered once, long ago" from "recovering right now".
	Generation int `json:"generation"`
	// LockedOut is the terminal state. Cleared by `projectiond --reset-recovery` and by nothing else.
	LockedOut bool `json:"lockedOut"`
	// LockoutCode is the closed-set code that caused it, empty while not locked out.
	LockoutCode string `json:"lockoutCode,omitempty"`
	// LastAttemptUnixNano is when the last attempt was STARTED, which is what the cooldown measures from.
	LastAttemptUnixNano int64 `json:"lastAttemptUnixNano,omitempty"`
	// LastOutcome is one of the closed-set outcomes.
	LastOutcome string `json:"lastOutcome,omitempty"`
}

// RecoverySnapshot is what the status surface publishes. Every field is a closed-set code, a number, or —
// in exactly one case — a short digest that is not reversible into anything.
type RecoverySnapshot struct {
	State       string `json:"recoveryState"`
	Reason      string `json:"recoveryReason"`
	Attempts    int    `json:"recoveryAttempts"`
	Generation  int    `json:"recoveryGeneration"`
	LastOutcome string `json:"recoveryLastOutcome"`
	Remediation string `json:"recoveryRemediation"`
	// Underlay is the closed-set verdict on the mount point's pre-mount state, from the last decision.
	//
	// IT IS PUBLISHED BECAUSE A REFUSAL THAT DOES NOT SAY WHAT IT COULD NOT PROVE SENDS PEOPLE TO THE LOGS.
	// `refuse-foreign-mount` beside `underlay-mismatch` tells an operator that something is stacked on their
	// mount point; the same refusal beside `underlay-unknown` tells them the daemon could not read the mount
	// table at all, which is a completely different afternoon.
	Underlay string `json:"recoveryUnderlay"`
	// UnderlayDigest fingerprints the attachment the verdict was taken against, or is empty when there was
	// none. A gate can assert from outside the process that the thing the daemon proved identical across a
	// recovery really was identical; a sha256 prefix carries no path back out.
	UnderlayDigest string `json:"recoveryUnderlayDigest"`
}

// recoveryState is the daemon's live recovery bookkeeping. It is guarded by its own mutex rather than folded
// into the daemon's, because the readiness path must never wait on a ledger write.
type recoveryState struct {
	mu sync.Mutex
	// enabled is `--auto-recover`. Off by default: Phase 6 changes nothing for an operator who does not ask
	// for it, which is the only form of a self-acting feature that is safe to ship in an alpha.
	enabled bool
	// ledgerPath is empty when there is nowhere durable to write, which locks out rather than proceeding.
	ledgerPath string
	ledger     RecoveryLedger
	// sustainClass is the actionable class currently being timed, and sustainSince is when it started. Any
	// change of class restarts the window: "something has been wrong for six seconds" is not the same fact
	// as "this has been wrong for six seconds", and only the second one authorises an action.
	sustainClass string
	sustainSince time.Time
	// inFlight is single-flight. It is deliberately NOT cleared by the attempt deadline: an abandoned attempt
	// may still be inside an uninterruptible syscall, and starting a second remount over it is the race this
	// tranche exists to make impossible.
	inFlight bool
	// healthySince is when readiness last became `ok`, zero while it is not. The refund is measured from it.
	healthySince time.Time
	// reason, state and remediation are the last published decision. THEY ARE STORED RATHER THAN RE-DERIVED
	// BY THE STATUS SURFACE: a status document that recomputed the state from the same inputs a moment later
	// would be a second state machine, and two state machines with one name is how a surface starts
	// disagreeing with the thing it reports on.
	reason      string
	state       string
	remediation string
	// underlay and underlayDigest are the evidence the last decision was taken against, stored here for the
	// same reason and published from here for the same reason.
	underlay       string
	underlayDigest string
}

// recoveryInputs is everything the decision reads, gathered ONCE, for the same reason `readinessInputs` is:
// a verdict assembled from three different instants is a verdict about an instant that never existed.
type recoveryInputs struct {
	now     time.Time
	enabled bool
	// class is the classification of the readiness verdict, from classifyRecovery.
	class string
	// actionable and refusal partition the classes. A class is at most one of them.
	actionable bool
	refusal    bool
	// sustainedSince is when the current class started being reported, zero when it has just changed.
	sustainedSince time.Time
	inFlight       bool
	lockedOut      bool
	lockoutCode    string
	attempts       int
	lastAttemptAt  time.Time
}

// recoveryDecision is the verdict: whether to act, what to publish, and what to tell an operator to do.
//
// THE TYPE IS UNEXPORTED AND ITS ACCESSORS ARE NOT, WHICH IS DELIBERATE. `cmd/projectiond` needs to read a
// decision and can; nothing outside this package can CONSTRUCT one, so there is no way to hand the mount
// owner a recovery that this state machine did not decide on.
type recoveryDecision struct {
	act         bool
	code        string
	state       string
	remediation string
	refusal     bool
}

// Act reports whether this decision authorises an attempt.
func (r recoveryDecision) Act() bool { return r.act }

// Code is the closed-set decision code.
func (r recoveryDecision) Code() string { return r.code }

// State is the closed-set recovery state this decision leaves the daemon in.
func (r recoveryDecision) State() string { return r.state }

// Remediation is the closed-set thing an operator should do about it, `none` when there is nothing.
func (r recoveryDecision) Remediation() string { return r.remediation }

// IsRefusal reports whether this is a fault the supervisor can see and is not entitled to act on.
func (r recoveryDecision) IsRefusal() bool { return r.refusal }

// classifyRecovery maps a readiness verdict to a recovery class. It is a pure table and it is EXHAUSTIVE ON
// THE READINESS REASON rather than a chain of conditions, so a reason code added later shows up here as an
// unrecognised state — which refuses — instead of falling through to whatever the last branch happened to be.
//
// IT READS `readyReason` AND THE OBSERVATION AND NOTHING ELSE, AND THAT IS WHAT MAKES THE FIRST BOUND FREE.
// Every code below that is actionable is a code readiness is being WITHHELD for: inside the fault hold, and
// inside the bootstrap grace, Phase 5's policy publishes `ok`. So "never act on a fault readiness did not
// already believe" is not a check this file performs — it is a property of reading this field.
// THE THIRD ARGUMENT IS PHASE 7'S WHOLE CHANGE AND IT IS READ ON EXACTLY ONE ROW. `underlay` is the closed-set
// verdict from `fusefs.CompareUnderlay` — whether the mount point is, right now, in exactly the state it was
// measured in BEFORE this process mounted anything. It is consulted only inside `mount-observed-not-live` +
// `foreign`, and there it can only ever turn a refusal into an action; no other row reads it, and no value of
// it can turn an action into a refusal or a refusal into a different refusal.
func classifyRecovery(readyReason, observed, underlay string) (class string, actionable bool, refusal bool) {
	switch readyReason {
	case ReadyReasonOK:
		return RecoveryNoActionHealthy, false, false
	case ReadyReasonMountRecovering:
		// The daemon's own confirmation is running. Acting here would abort a recovery in order to start one.
		return RecoveryNoActionConfirming, false, false
	case ReadyReasonNoGeneration:
		// A control-plane problem. No remount produces a generation, so a remount is not a fix, it is noise.
		return RecoveryNoActionNothingToServe, false, false
	case ReadyReasonNotMounted:
		// Startup or shutdown, with no death recorded — a death outranks this code, so reaching it means the
		// supervisor has not mounted yet or is on its way out. The first mount is not this loop's to make.
		return RecoveryNoActionNotMounted, false, false
	case ReadyReasonServeLoopDead:
		// THE SERVE SUPERVISOR OWNS THIS AND THIS LOOP MUST NOT ALSO ACT. A death is direct evidence, already
		// handled by the path that observed it. A second supervisor reacting to the late sample of the same
		// event is how one fault becomes two remounts racing on one mount point.
		return RecoveryNoActionServeOwns, false, false
	case ReadyReasonMountNotLive:
		// We looked and it is not live. WHICH not-live decides everything.
		switch observed {
		case "stale-projectiond":
			return RecoverActStaleMount, true, false
		case "empty":
			return RecoverActMountEmpty, true, false
		case "foreign":
			// THE MOST IMPORTANT LINE IN THIS FILE. Something that is not ours is on the mount point, and in
			// every containerised topology this daemon ships in the likeliest candidate is the operator's own
			// bind — the one mount that must survive for any recovery to be visible to anybody. Unmounting it
			// is the exact defect `--auto-remount` shipped once already. A supervisor that cannot tell those
			// apart does nothing, and says which.
			//
			// AND THERE IS EXACTLY ONE FOREIGN MOUNT IT CAN TELL APART, WHICH IS PHASE 7 §8.4. If the mount
			// point is in EXACTLY the state that was fingerprinted before this process mounted anything — the
			// same rows, in the same order, each the same attachment by mount id, parent, device, subtree
			// root, source, type and propagation — then nothing of ours is there, nothing has been stacked on
			// us, nothing has been swapped underneath us, and the projectiond mount that used to be on top is
			// simply GONE. That is the state an external `umount` leaves, it is the single most likely
			// operator-side accident on this appliance, and the repair is not a new capability: it is the
			// startup path, mounting over the operator's own bind exactly as this daemon does every time it
			// starts.
			//
			// NOTHING HERE MAKES A FILE-SYSTEM TYPE TRUSTED. `fuse.shfs` is not admitted, `tmpfs` is not
			// refused: the type is not consulted at all. What is consulted is whether the mount point is the
			// exact attachment measured at startup with NOTHING on top of it, and a tmpfs stacked above a live
			// mount answers `underlay-covered` on the row count before any identity is compared. All three
			// refusing verdicts land on the line below, unchanged, which is Phase 6's own rule doing its own
			// job on every case but the one narrow state that is provably the startup state.
			if underlay == UnderlayExposed {
				return RecoverActMountUnderlay, true, false
			}
			return RecoveryRefuseForeignMount, false, true
		default:
			return RecoveryRefuseUnknownState, false, true
		}
	case ReadyReasonObservationStale:
		// The verdict says live and has STOPPED ADVANCING: the wedged-mount signature, and the single most
		// dangerous state there is, because every consumer hangs on it.
		return RecoverActObservationStale, true, false
	case ReadyReasonObservationUnavailable:
		// No observation has ever completed and both the grace and the hold are spent. It is the state we
		// know least about, which is why it is last and why it is still bounded by everything below.
		return RecoverActObservationUnavailable, true, false
	default:
		return RecoveryRefuseUnknownState, false, true
	}
}

// decideRecovery is the whole state machine, and the order of its clauses IS the precedence. It contacts
// nothing, takes no probe, writes nothing and blocks on nothing — every effect it authorises is performed by
// the caller, which is what lets a table test drive the shipped decision across every boundary.
func decideRecovery(in recoveryInputs) recoveryDecision {
	// 1. Disabled outranks everything, including a lockout. A daemon nobody asked to act reports the fact
	//    that it will not act, and never reports a budget it is not spending as though it mattered.
	if !in.enabled {
		return recoveryDecision{code: RecoveryNoActionDisabled, state: RecoveryStateDisabled,
			remediation: RecoveryRemediationNone}
	}
	// 2. Single-flight. An attempt in flight may be ABANDONED rather than running, and the answer is the same
	//    either way: nothing else starts. This is ahead of the lockout because "we are still inside the last
	//    attempt" is more precise than "the budget that attempt spent is gone".
	if in.inFlight {
		return recoveryDecision{code: RecoveryNoActionInFlight, state: RecoveryStateActing,
			remediation: RecoveryRemediationNone}
	}
	// 3. The lockout. Terminal, durable, and cleared by a human. Note what it is NOT: the daemon keeps
	//    serving and keeps reporting; what it has stopped doing is acting.
	if in.lockedOut {
		remediation := RecoveryRemediationResetLedger
		if in.lockoutCode == RecoveryLedgerUnreadable || in.lockoutCode == RecoveryLedgerUnwritable {
			remediation = RecoveryRemediationCheckCache
		}
		return recoveryDecision{code: RecoveryNoActionLockedOut, state: RecoveryStateLockedOut,
			remediation: remediation}
	}
	// 4. A refusal. It is published every tick rather than once, because it is a STATE and not an event: an
	//    operator who reads the surface a minute after the overlay appeared must still see why nothing is
	//    happening. The log is deduplicated; the surface is not.
	if in.refusal {
		return recoveryDecision{code: in.class, state: RecoveryStateIdle, refusal: true,
			remediation: RecoveryRemediationInspectOwner}
	}
	// 5. Nothing actionable.
	if !in.actionable {
		return recoveryDecision{code: in.class, state: RecoveryStateIdle,
			remediation: RecoveryRemediationNone}
	}
	// 6. Actionable, and now the two windows. THE SUSTAIN IS FIRST because it is about the fault and the
	//    cooldown is about us: a fault that has not sustained is not one we are declining to act on, it is
	//    one we have not finished looking at.
	// THE WINDOW MUST BE OUTLASTED AND NOT MERELY REACHED, WHICH IS THE COMPARISON PHASE 5'S FAULT HOLD
	// ALREADY USES (`sinceLive > MountFaultHold`). Writing this one as `<` made a fault sustained for EXACTLY
	// the window actionable, so the two holds either side of one decision would have disagreed about what
	// their own length meant by one tick. Caught by the boundary row in the table before any host saw it.
	if in.sustainedSince.IsZero() || in.now.Sub(in.sustainedSince) <= RecoverySustain {
		return recoveryDecision{code: RecoveryNoActionNotSustained, state: RecoveryStateObserving,
			remediation: RecoveryRemediationNone}
	}
	if !in.lastAttemptAt.IsZero() && in.now.Sub(in.lastAttemptAt) < RecoveryCooldown {
		return recoveryDecision{code: RecoveryNoActionCooldown, state: RecoveryStateCoolingDown,
			remediation: RecoveryRemediationNone}
	}
	// 7. The budget. Reaching it without the lockout already being set means the last attempt's bookkeeping
	//    did not run — a crash between the spend and the outcome — so it is checked here as well as recorded
	//    there. A guard that is only in the writer is a guard a crash removes.
	if in.attempts >= RecoveryMaxAttempts {
		return recoveryDecision{code: RecoveryBudgetExhausted, state: RecoveryStateLockedOut,
			remediation: RecoveryRemediationResetLedger}
	}
	// 8. Act, and the code that is published is the FAULT the action is being taken for rather than the word
	//    "recovering". An operator reading `recover-observation-stale` knows which failure they had.
	return recoveryDecision{act: true, code: in.class, state: RecoveryStateActing,
		remediation: RecoveryRemediationNone}
}

// SetUnderlayVerifier wires the thing that answers whether the mount point is in exactly its pre-mount state,
// and the digest of the attachment it compared against. Wiring is optional and its ABSENCE IS A REFUSAL: an
// unwired daemon answers `underlay-unknown` for ever, which is the state a supervisor may not act in.
//
// IT IS INJECTED FOR THE SAME REASON `SetMountObserver` IS — the mount table reader is linux-only and this
// package is not — and it is a SECOND function rather than a second return value on the observer because the
// two answers are not alike. The observation costs a `statfs`, which is uninterruptible and can park for as
// long as a wedged connection stays wedged, and that is the whole reason it is sampled on its own cadence and
// read from a store. This one reads `/proc/self/mountinfo` and nothing else: procfs cannot be blocked by a
// FUSE connection, so it is taken FRESH at the instant of the decision, which is the only instant at which
// evidence that authorises an action is worth anything.
func (d *Daemon) SetUnderlayVerifier(verify func() (verdict string, digest string)) {
	d.underlayVerifier = verify
}

// underlayEvidence is the verdict and the digest, taken now, with an unwired verifier failing closed.
func (d *Daemon) underlayEvidence() (string, string) {
	verify := d.underlayVerifier
	if verify == nil {
		return UnderlayUnknown, ""
	}
	verdict, digest := verify()
	switch verdict {
	case UnderlayExposed, UnderlayCovered, UnderlayChanged, UnderlayUnknown:
		return verdict, digest
	default:
		// A VERDICT FROM OUTSIDE THE CLOSED SET IS NOT ONE. Nothing in this repository can construct one — the
		// verifier is wired from `cmd/projectiond` and returns `fusefs.CompareUnderlay` — and that is exactly
		// why the branch is here: the one guard that has never been needed is the one a later caller removes.
		return UnderlayUnknown, digest
	}
}

// EnableRecovery turns the loop on and loads the durable budget. It is called once, before the loop starts.
//
// AN ABSENT LEDGER IS A FIRST RUN; AN UNREADABLE ONE IS A LOCKOUT. The difference is the whole of failing
// closed here: a supervisor that cannot see how much of its budget is already spent must not spend more, and
// a supervisor that has never had a budget has spent none of it.
func (d *Daemon) EnableRecovery(enabled bool) {
	d.recovery.mu.Lock()
	defer d.recovery.mu.Unlock()
	d.recovery.enabled = enabled
	d.recovery.reason = RecoveryNoActionDisabled
	d.recovery.state = RecoveryStateDisabled
	d.recovery.remediation = RecoveryRemediationNone
	if !enabled {
		return
	}
	d.recovery.reason = RecoveryNoActionHealthy
	d.recovery.state = RecoveryStateIdle
	if d.cfg.ProbeCacheDir == "" {
		// NOWHERE DURABLE TO WRITE IS A LOCKOUT, NOT A LICENCE. A budget that cannot be persisted is a budget
		// the next restart refunds, and a refundable budget bounds nothing at all.
		d.recovery.ledger = RecoveryLedger{Version: recoveryLedgerVersion, LockedOut: true,
			LockoutCode: RecoveryLedgerUnwritable}
		d.publishLockoutLocked()
		return
	}
	d.recovery.ledgerPath = filepath.Join(d.cfg.ProbeCacheDir, RecoveryLedgerFilename)
	ledger, err := loadRecoveryLedger(d.recovery.ledgerPath)
	if err != nil {
		d.recovery.ledger = RecoveryLedger{Version: recoveryLedgerVersion, LockedOut: true,
			LockoutCode: RecoveryLedgerUnreadable}
		d.publishLockoutLocked()
		return
	}
	d.recovery.ledger = ledger
	// A LOCKOUT LOADED FROM DISK IS PUBLISHED IMMEDIATELY AND NOT AT THE FIRST TICK.
	//
	// It was not, and a test found it: a restarted daemon carrying an inherited lockout reported `idle` for
	// the whole first second of its life. That is the single most misleading answer this surface could give,
	// because the operator most likely to be reading it is the one who just restarted the container hoping
	// the lockout was in memory.
	if ledger.LockedOut {
		d.publishLockoutLocked()
	}
}

// publishLockoutLocked puts a lockout on the surface with the remediation its cause deserves. The caller
// holds the mutex.
func (d *Daemon) publishLockoutLocked() {
	d.recovery.reason = RecoveryNoActionLockedOut
	d.recovery.state = RecoveryStateLockedOut
	d.recovery.remediation = RecoveryRemediationResetLedger
	if d.recovery.ledger.LockoutCode == RecoveryLedgerUnreadable ||
		d.recovery.ledger.LockoutCode == RecoveryLedgerUnwritable {
		d.recovery.remediation = RecoveryRemediationCheckCache
	}
}

// RecoveryEnabled reports whether the loop is on. main uses it to decide whether to start the goroutine at
// all, so a disabled daemon has no recovery ticker in it rather than one that decides to do nothing.
func (d *Daemon) RecoveryEnabled() bool {
	d.recovery.mu.Lock()
	defer d.recovery.mu.Unlock()
	return d.recovery.enabled
}

// loadRecoveryLedger reads the budget. A MISSING file is a fresh budget; anything else that goes wrong is an
// error, and the caller turns an error into a lockout.
func loadRecoveryLedger(path string) (RecoveryLedger, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return RecoveryLedger{Version: recoveryLedgerVersion}, nil
	}
	if err != nil {
		return RecoveryLedger{}, err
	}
	var ledger RecoveryLedger
	if err := json.Unmarshal(raw, &ledger); err != nil {
		return RecoveryLedger{}, err
	}
	if ledger.Version != recoveryLedgerVersion {
		// AN UNKNOWN VERSION IS UNREADABLE RATHER THAN GUESSED AT. A future shape read as this one could
		// silently report a lockout as absent, which is the one direction that must never happen by accident.
		return RecoveryLedger{}, fmt.Errorf("recovery ledger version %d is not %d",
			ledger.Version, recoveryLedgerVersion)
	}
	return ledger, nil
}

// writeRecoveryLedger persists the budget atomically: a temporary file in the same directory, then a rename.
//
// ATOMIC BECAUSE A TORN LEDGER IS AN UNREADABLE ONE AND AN UNREADABLE ONE LOCKS OUT. A crash in the middle of
// a plain write would therefore turn a recoverable appliance into one that needs a human, which is exactly
// the outcome the persistence exists to avoid on every other path.
func writeRecoveryLedger(path string, ledger RecoveryLedger) error {
	ledger.Version = recoveryLedgerVersion
	raw, err := json.Marshal(ledger)
	if err != nil {
		return err
	}
	// THE DIRECTORY IS CREATED HERE AND NOT AT STARTUP, because a supervisor that has never spent anything
	// has nothing to record and should leave no trace at all.
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temp := path + ".tmp"
	if err := os.WriteFile(temp, raw, 0o600); err != nil {
		return err
	}
	if err := os.Rename(temp, path); err != nil {
		_ = os.Remove(temp)
		return err
	}
	return nil
}

// ResetRecoveryLedger removes the durable budget. It is what `projectiond --reset-recovery` runs, and it is
// the only thing in this product that clears a lockout.
//
// A MISSING LEDGER IS A SUCCESSFUL RESET. The post-condition is "there is no spent budget here", and that is
// already true.
func ResetRecoveryLedger(probeCacheDir string) error {
	if probeCacheDir == "" {
		return errors.New("no cache directory is configured, so there is no recovery ledger to reset")
	}
	path := filepath.Join(probeCacheDir, RecoveryLedgerFilename)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// RecoveryDecide takes one tick's decision. It updates only the bookkeeping the decision itself needs — the
// sustain window, the refund clock and the published reason — and performs NO action: `act` being true is a
// request the caller carries to the one goroutine that owns the mount.
func (d *Daemon) RecoveryDecide(now time.Time) recoveryDecision {
	status := d.Status()
	// THE UNDERLAY EVIDENCE IS TAKEN OUTSIDE THE MUTEX AND BEFORE THE DECISION, for the same reason
	// `recoveryInputs` is gathered once: a verdict assembled from two different instants is a verdict about an
	// instant that never existed. It reads procfs and cannot block, so taking it on this path costs a tick
	// nothing and never holds the ledger's lock across a syscall.
	underlay, underlayDigest := d.underlayEvidence()
	class, actionable, refusal := classifyRecovery(status.ReadyReason, status.MountObserved, underlay)

	d.recovery.mu.Lock()
	defer d.recovery.mu.Unlock()
	d.recovery.underlay = underlay
	d.recovery.underlayDigest = underlayDigest

	// THE SUSTAIN WINDOW RESTARTS ON ANY CHANGE OF CLASS. "Something has been wrong for six seconds" is not
	// the same fact as "THIS has been wrong for six seconds", and only the second one authorises an action:
	// a mount point that cycled through empty, foreign and stale is a mount point somebody is working on.
	if class != d.recovery.sustainClass {
		d.recovery.sustainClass = class
		d.recovery.sustainSince = now
	}

	// The refund clock. It runs only while readiness is `ok`, and any other verdict stops it — a budget
	// refunded by a daemon that is merely no longer reporting the same fault is not a refund, it is amnesia.
	if class == RecoveryNoActionHealthy {
		if d.recovery.healthySince.IsZero() {
			d.recovery.healthySince = now
		}
	} else {
		d.recovery.healthySince = time.Time{}
	}

	decision := decideRecovery(recoveryInputs{
		now:            now,
		enabled:        d.recovery.enabled,
		class:          class,
		actionable:     actionable,
		refusal:        refusal,
		sustainedSince: d.recovery.sustainSince,
		inFlight:       d.recovery.inFlight,
		lockedOut:      d.recovery.ledger.LockedOut,
		lockoutCode:    d.recovery.ledger.LockoutCode,
		attempts:       d.recovery.ledger.Attempts,
		lastAttemptAt:  unixNanoTime(d.recovery.ledger.LastAttemptUnixNano),
	})

	// THE REFUND, AND IT IS DELIBERATELY NOT PART OF THE DECISION. It is a side effect of being well for long
	// enough, not a verdict about what to do, so it is applied here where the bookkeeping lives and the pure
	// function stays a pure function of a moment.
	if d.recovery.enabled && !d.recovery.ledger.LockedOut && d.recovery.ledger.Attempts > 0 &&
		!d.recovery.healthySince.IsZero() && now.Sub(d.recovery.healthySince) >= RecoveryConfirm {
		d.recovery.ledger.Attempts = 0
		d.recovery.ledger.LastOutcome = RecoveryOutcomeSucceeded
		if err := d.persistLedgerLocked(); err != nil {
			// AN UNWRITABLE LEDGER IS A LOCKOUT EVEN WHEN THE NEWS IS GOOD. The in-memory refund would
			// otherwise be a budget the next restart cannot see, which is a budget that is not durable.
			d.recovery.ledger.LockedOut = true
			d.recovery.ledger.LockoutCode = RecoveryLedgerUnwritable
			decision.state = RecoveryStateLockedOut
			decision.remediation = RecoveryRemediationCheckCache
		}
		decision.code = RecoverySucceeded
	}

	d.recovery.reason = decision.code
	d.recovery.state = decision.state
	d.recovery.remediation = decision.remediation
	return decision
}

// RecoveryBeginAttempt is called by the goroutine that owns the mount, immediately before it acts. It is the
// point at which the budget is SPENT, and it is deliberately not the point at which the decision was taken.
//
// THE SPEND IS WRITTEN BEFORE THE ATTEMPT AND THAT ORDER IS THE WHOLE GUARANTEE. An attempt whose spend is
// recorded afterwards is an attempt a crash refunds, and a budget a crash refunds is not a bound. So a ledger
// that cannot be written refuses the attempt outright and locks out: the alternative is acting with no
// record, which is the unbounded case wearing the clothes of the bounded one.
//
// IT ALSO RE-CHECKS THE CLASS. Between the decision and this call the serve-death supervisor may have fixed
// the very fault this was for, and spending a budget on a fault somebody else already cleared is how three
// attempts become one real attempt and two accidents.
func (d *Daemon) RecoveryBeginAttempt(class string, now time.Time) (bool, string) {
	status := d.Status()
	// AND THE UNDERLAY EVIDENCE IS RE-TAKEN HERE, WHICH IS THE POINT OF THIS FUNCTION APPLIED TO PHASE 7'S OWN
	// ROW. Between the decision and this call somebody may have stacked something on the mount point; the
	// re-classification below then answers `refuse-foreign-mount`, which is not the class this was sent for,
	// and nothing is spent and nothing is done. A recovery authorised by evidence taken a tick ago is a
	// recovery authorised by evidence.
	underlay, underlayDigest := d.underlayEvidence()
	current, actionable, _ := classifyRecovery(status.ReadyReason, status.MountObserved, underlay)

	d.recovery.mu.Lock()
	defer d.recovery.mu.Unlock()
	d.recovery.underlay = underlay
	d.recovery.underlayDigest = underlayDigest

	if !d.recovery.enabled {
		return false, RecoveryNoActionDisabled
	}
	if d.recovery.inFlight {
		return false, RecoveryNoActionInFlight
	}
	if d.recovery.ledger.LockedOut {
		return false, RecoveryNoActionLockedOut
	}
	if !actionable || current != class {
		// Not the fault we were sent for any more. Nothing spent, nothing published as an attempt.
		return false, RecoveryNoActionSupervisorBusy
	}
	if d.recovery.ledger.Attempts >= RecoveryMaxAttempts {
		d.recovery.ledger.LockedOut = true
		d.recovery.ledger.LockoutCode = RecoveryBudgetExhausted
		d.recovery.reason = RecoveryBudgetExhausted
		d.recovery.state = RecoveryStateLockedOut
		d.recovery.remediation = RecoveryRemediationResetLedger
		_ = d.persistLedgerLocked()
		return false, RecoveryBudgetExhausted
	}
	d.recovery.ledger.Attempts++
	d.recovery.ledger.Generation++
	d.recovery.ledger.LastAttemptUnixNano = now.UnixNano()
	d.recovery.ledger.LastOutcome = RecoveryOutcomeNone
	if err := d.persistLedgerLocked(); err != nil {
		d.recovery.ledger.LockedOut = true
		d.recovery.ledger.LockoutCode = RecoveryLedgerUnwritable
		d.recovery.reason = RecoveryLedgerUnwritable
		d.recovery.state = RecoveryStateLockedOut
		d.recovery.remediation = RecoveryRemediationCheckCache
		return false, RecoveryLedgerUnwritable
	}
	d.recovery.inFlight = true
	d.recovery.reason = class
	d.recovery.state = RecoveryStateActing
	return true, class
}

// RecoveryFinishAttempt records what became of an attempt and releases single-flight.
//
// IT IS NEVER CALLED FOR AN ABANDONED ATTEMPT. An attempt past its deadline may still be inside an
// uninterruptible syscall, so `inFlight` stays true for the life of the process and nothing else is ever
// started — see RecoveryAbandonAttempt, which records the outcome and deliberately does NOT release it.
func (d *Daemon) RecoveryFinishAttempt(succeeded bool) {
	d.recovery.mu.Lock()
	defer d.recovery.mu.Unlock()
	d.recovery.inFlight = false
	d.recovery.state = RecoveryStateCoolingDown
	if succeeded {
		d.recovery.ledger.LastOutcome = RecoveryOutcomeSucceeded
		d.recovery.reason = RecoverySucceeded
		// THE BUDGET IS NOT REFUNDED HERE. A mount syscall returning is not a recovery — that is the exact
		// mistake Phase 2's `--auto-remount` made, where the daemon logged success and no consumer could read
		// a byte. The refund waits for `RecoveryConfirm` of observed, confirmed readiness.
		_ = d.persistLedgerLocked()
		return
	}
	d.recovery.ledger.LastOutcome = RecoveryOutcomeFailed
	d.recovery.reason = RecoveryFailed
	if d.recovery.ledger.Attempts >= RecoveryMaxAttempts {
		d.recovery.ledger.LockedOut = true
		d.recovery.ledger.LockoutCode = RecoveryBudgetExhausted
		d.recovery.reason = RecoveryBudgetExhausted
		d.recovery.state = RecoveryStateLockedOut
		d.recovery.remediation = RecoveryRemediationResetLedger
	}
	_ = d.persistLedgerLocked()
}

// RecoveryAbandonAttempt records an attempt that did not return within its deadline. The spend is already in
// the ledger; what this adds is the outcome and the fact that single-flight is now held FOREVER.
//
// HOLDING IT FOREVER IS THE SAFE DIRECTION AND IT IS A CHOICE, NOT AN OVERSIGHT. The abandoned goroutine may
// be parked in a statfs that returns only when the connection is torn down. Releasing the flag would let a
// second remount run against a mount point the first one is still inside, and two remounts racing on one
// mount point is the failure mode with the worst possible blast radius in this product.
func (d *Daemon) RecoveryAbandonAttempt() {
	d.recovery.mu.Lock()
	defer d.recovery.mu.Unlock()
	d.recovery.ledger.LastOutcome = RecoveryOutcomeFailed
	d.recovery.reason = RecoveryAttemptTimeout
	// THE STATE STAYS `acting`, AND IT IS NOT A BUG. Single-flight is still held — deliberately, forever —
	// so the honest answer to "what is this daemon doing" is that an attempt of its is still outstanding.
	// Reporting `locked-out` would be tidier and would tell an operator the wrong thing about what is
	// running inside the process.
	d.recovery.state = RecoveryStateActing
	d.recovery.remediation = RecoveryRemediationResetLedger
	if d.recovery.ledger.Attempts >= RecoveryMaxAttempts {
		d.recovery.ledger.LockedOut = true
		d.recovery.ledger.LockoutCode = RecoveryBudgetExhausted
	}
	_ = d.persistLedgerLocked()
}

// persistLedgerLocked writes the ledger. The caller holds the mutex.
func (d *Daemon) persistLedgerLocked() error {
	if d.recovery.ledgerPath == "" {
		return errors.New("no recovery ledger path")
	}
	return writeRecoveryLedger(d.recovery.ledgerPath, d.recovery.ledger)
}

// RecoveryStatus is what /readyz publishes. It reads the last decision rather than taking a new one, for the
// same reason /readyz reads the mount observation rather than taking a probe: a status surface that computes
// is a status surface that can be made slow by the thing it is reporting on.
func (d *Daemon) RecoveryStatus() RecoverySnapshot {
	d.recovery.mu.Lock()
	defer d.recovery.mu.Unlock()
	snapshot := RecoverySnapshot{
		State:          d.recovery.state,
		Reason:         d.recovery.reason,
		Attempts:       d.recovery.ledger.Attempts,
		Generation:     d.recovery.ledger.Generation,
		LastOutcome:    d.recovery.ledger.LastOutcome,
		Remediation:    d.recovery.remediation,
		Underlay:       d.recovery.underlay,
		UnderlayDigest: d.recovery.underlayDigest,
	}
	if snapshot.Underlay == "" {
		// NO DECISION HAS BEEN TAKEN YET, and the honest word for that is the one that refuses. A surface that
		// answered `underlay-expected` before anything had looked would be a green light wired to nothing.
		snapshot.Underlay = UnderlayUnknown
	}
	if snapshot.State == "" {
		snapshot.State = RecoveryStateDisabled
	}
	if snapshot.Reason == "" {
		snapshot.Reason = RecoveryNoActionDisabled
	}
	if snapshot.LastOutcome == "" {
		snapshot.LastOutcome = RecoveryOutcomeNone
	}
	if snapshot.Remediation == "" {
		snapshot.Remediation = RecoveryRemediationNone
	}
	return snapshot
}
