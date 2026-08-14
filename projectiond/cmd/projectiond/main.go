//go:build linux

// Command projectiond serves a projection manifest as a read-only regular-file namespace over FUSE.
//
// IT IS A DATA PLANE AND NOTHING ELSE. It writes nothing, decides nothing about what exists, and holds no
// database. Point it at a pointer file the control plane publishes and a mount point, and it serves the last
// generation it admitted — including while the control plane is gone.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/daemon"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/fusefs"
)

// Version is stamped at build time. It appears in the status document and nowhere else.
var Version = "0.1.0-phase1"

// HOW OFTEN THE MOUNT POINT IS OBSERVED, AND HOW LONG ONE OBSERVATION IS WAITED FOR.
//
// These are the two numbers `PROJECTIOND_MOUNT_OBSERVATION` in `src/core/projection/runtime-contract.ts`
// predeclares, and `test/projection-mount-truth.ts` fails if this file and that one disagree. They are not
// flags: an operator who could widen the probe timeout could make a wedged mount look merely slow, and the
// whole value of the observation is that its bound is a property of the product rather than of a deployment.
const (
	mountSampleInterval = 1000 * time.Millisecond
	mountProbeTimeout   = 2000 * time.Millisecond
)

func main() {
	configPath := flag.String("config", "", "path to the daemon configuration file")
	mountPoint := flag.String("mount", "", "override the configured mount point")
	checkOnly := flag.Bool("check-config", false, "validate the configuration and the pointer, then exit")
	pollInterval := flag.Duration("poll", 5*time.Second, "how often to re-read the pointer file")
	debug := flag.Bool("debug-fuse", false, "log the FUSE protocol (very verbose; never logs file bytes)")
	strictMount := flag.Bool("strict-direct-mount", false,
		"refuse to fall back to the fusermount suid helper; proves the mount was made by syscall")
	refuseStale := flag.Bool("refuse-stale", false,
		"refuse to start if a stale projectiond mount exists at the mount point")
	autoRemount := flag.Bool("auto-remount", false,
		"after the FUSE serve loop dies, attempt a bounded remount instead of exiting")
	serveExitCode := flag.Int("serve-exit-code", 3,
		"exit code for a serve-loop death when --auto-remount is off or every remount attempt fails")
	autoRecover := flag.Bool("auto-recover", false,
		"act on a SUSTAINED mount fault that readiness already believes, bounded by a durable budget "+
			"(Projection Phase 6; off by default, and it never touches a mount that is not ours)")
	resetRecovery := flag.Bool("reset-recovery", false,
		"clear the durable recovery budget and exit. It constructs no daemon, opens no cache and cannot "+
			"mount. This is the only thing that clears a recovery lockout")
	healthcheck := flag.Bool("healthcheck", false,
		"read this daemon's own /readyz over loopback and exit 0 only if it is ready; this is the shipped "+
			"container healthcheck and it starts nothing")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(Version)
		return
	}
	if *configPath == "" {
		fail("a --config path is required")
	}
	cfg, err := daemon.LoadConfigFile(*configPath)
	if err != nil {
		fail("configuration refused: " + err.Error())
	}
	if *mountPoint != "" {
		cfg.MountPoint = *mountPoint
	}

	// THE SHIPPED CONTAINER HEALTHCHECK, AND IT IS THIS BINARY BECAUSE THE IMAGE HAS NOTHING ELSE.
	//
	// The runtime stage is distroless: no shell, no curl, no wget, nothing that could make an HTTP request.
	// A HEALTHCHECK therefore has to be the daemon's own binary in a mode that starts NOTHING — it reads the
	// configuration for the status address, makes one loopback request, prints a redaction-safe verdict and
	// exits. It constructs no daemon, opens no cache, and cannot mount.
	//
	// IT IS BRANCHED BEFORE `daemon.New` FOR EXACTLY THAT REASON. Constructing a daemon here would create the
	// probe-cache directory from a health probe, every interval, as root.
	if *healthcheck {
		os.Exit(runHealthcheck(cfg))
	}

	// THE ONLY THING THAT CLEARS A RECOVERY LOCKOUT, AND IT IS A HUMAN TYPING IT.
	//
	// It is branched here for the same reason the healthcheck is: it must construct no daemon, open no cache
	// and be incapable of mounting. Every automatic clearing rule that was considered — a timer, an uptime, a
	// quiet period — is a rule under which a flapping appliance eventually resumes flapping without anybody
	// having looked at it.
	if *resetRecovery {
		if err := daemon.ResetRecoveryLedger(cfg.ProbeCacheDir); err != nil {
			// THE MESSAGE CARRIES A REMEDIATION AND STILL NO OS ERROR, and a real Tower run is why it needed
			// one. The cache directory belongs to the uid the daemon runs as — root in every shipped profile,
			// because a FUSE mount needs it — while this image's DEFAULT user is `nonroot`. So a reset run as
			// `docker run <image> --reset-recovery`, without saying who to be, is refused by the filesystem
			// and the operator is told only that it failed. The one thing they need to know is said here.
			fail("the recovery ledger could not be reset; run this as the user that owns the cache " +
				"directory (the shipped profiles run the daemon as root, so: --user 0:0)")
		}
		logLine("recovery ledger reset; automatic recovery will act again when it is enabled")
		return
	}

	d, err := daemon.New(cfg)
	if err != nil {
		fail("daemon refused to start: " + err.Error())
	}
	defer d.Close()

	if *pollInterval <= 0 {
		// time.NewTicker panics on a non-positive duration, and a daemon that panics on a flag is a daemon
		// that fails in the least useful possible place.
		fail("--poll must be positive")
	}

	record := d.LoadPointer()
	if *checkOnly {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		// The machine report is REDACTION-SAFE: an admission record and a status document, both of which
		// carry codes, counts and generation numbers. The config path is deliberately absent — this output is
		// meant to be pasteable.
		_ = encoder.Encode(map[string]any{"admission": record, "status": d.Status()})
		if !record.Accepted {
			os.Exit(1)
		}
		return
	}
	if !record.Accepted {
		// Refusing to mount with nothing to serve is the honest failure. Mounting an empty namespace would
		// look exactly like a library that lost every file.
		fail("no generation could be admitted, so there is nothing to serve: " + describe(record))
	}
	if cfg.MountPoint == "" {
		fail("a mount point is required")
	}

	// THE MOUNTPOINT IS PROBED, NEVER ASSUMED. Mount() stacks over whatever is there, so one statfs and one
	// mountinfo read decide what the stack lands on. The default is to stack over anything — including a dead
	// mount, which is how recovery works (a supervisor remount stacks over the corpse). --refuse-stale turns
	// the one dangerous case, serving over a mount whose transport is gone, into an actionable refusal. The
	// echoed path is the operator's own --mount argument, the same startup exception the --config path gets.
	switch result := fusefs.ProbeMountpoint(cfg.MountPoint); result {
	case fusefs.ProbeStaleProjectiond:
		logLine("stale projectiond mount detected at " + cfg.MountPoint)
		if *refuseStale {
			fail("refusing to start: stale mount at " + cfg.MountPoint +
				" (clear it with: umount -l " + cfg.MountPoint + ")")
		}
		logLine("stacking over the stale mount (default); clear it with: umount -l " + cfg.MountPoint)
	case fusefs.ProbeLiveProjectiond:
		logLine("live projectiond mount detected at " + cfg.MountPoint)
	case fusefs.ProbeForeign:
		logLine("non-projectiond mount detected at " + cfg.MountPoint)
	case fusefs.ProbeEmpty:
		logLine("no existing mount at " + cfg.MountPoint)
	}

	// WHAT WAS AT THE MOUNT POINT BEFORE WE MOUNTED ANYTHING, taken here and nowhere else. The supervisor's
	// corpse drain may never remove below this: in a container the mount point is commonly a BIND OF A
	// PROJECTIOND MOUNT, which is indistinguishable from our own by file-system type and is not ours to
	// remove. Counted before the first mount, so it is a fact rather than an inference.
	mountsAtStartup, startupCountKnown := fusefs.CountMountsAt(cfg.MountPoint)
	if !startupCountKnown {
		// NOT FATAL, AND NOT FORGOTTEN. The daemon serves perfectly well without ever needing this number;
		// what it loses is the right to remove anything later. Said once, here, so a recovery that declines
		// to clean up is explained by a line at startup rather than looking like a new fault.
		logLine("the mount count at " + cfg.MountPoint + " could not be read; a serve-loop death will " +
			"remount WITHOUT clearing anything, because a floor that is not measured authorises nothing")
	}

	// AND WHAT THE MOUNT POINT ACTUALLY *IS*, FINGERPRINTED, BEFORE THIS PROCESS MOUNTS ANYTHING — PHASE 7 §8.4.
	//
	// The count above says HOW MANY mounts are not ours to remove. It cannot say whether the ones that are
	// there later are the SAME ones, and that is the question the whole tranche turns on: when an external
	// `umount` takes this daemon's mount out from under it, what is left at the mount point inside a container
	// is the operator's own bind, `ObserveMountpoint` answers FOREIGN, and the supervisor refuses — correctly,
	// because a supervisor that acts on a foreign mount is `--auto-remount` all over again. The ONLY thing that
	// can safely separate "the operator's own pre-existing bind, untouched" from "something new on my mount
	// point" is an identity measured BEFORE this daemon could have contributed anything to it. That is here,
	// beside the count, taken from the same mount table at the same moment, and it is held in memory for the
	// life of this process only — mount ids are the running kernel's, so a durable copy would be a comparison
	// against numbers that stopped meaning anything at the last reboot.
	startupStack, startupStackKnown := fusefs.MountStackAt(cfg.MountPoint)
	if startupStackKnown && startupCountKnown && len(startupStack) != mountsAtStartup {
		// TWO READS OF THE MOUNT TABLE THAT DISAGREE ARE ONE MEASUREMENT NEITHER OF THEM MADE. Nothing should
		// be changing this mount point at startup, so this cannot happen — and if it does, the honest answer is
		// that there is no fingerprint, which refuses every recovery that would have needed one.
		startupStackKnown = false
	}
	if !startupStackKnown {
		logLine("the mount table at " + cfg.MountPoint + " could not be fingerprinted; automatic recovery " +
			"will REFUSE any fault whose repair depends on proving the underlying mount is unchanged")
	} else {
		logLine(fmt.Sprintf("the mount point %s was fingerprinted before mounting: %d row(s), underlay %s",
			cfg.MountPoint, len(startupStack), underlayDigestOrNone(fusefs.UnderlayDigest(startupStack))))
	}
	// THE VERIFIER IS WIRED BEFORE THE FIRST MOUNT, AND IT CLOSES OVER THE FINGERPRINT RATHER THAN RE-TAKING
	// IT. A verifier that re-measured its own baseline would agree with itself for ever.
	d.SetUnderlayVerifier(newUnderlayVerifier(cfg.MountPoint, startupStack, startupStackKnown))

	// Mount returns a mount whose request loop is already running and whose INIT handshake has completed.
	mount, err := fusefs.Mount(d, cfg.MountPoint, fusefs.MountSettings{
		Debug: *debug, StrictDirectMount: *strictMount,
	})
	if err != nil {
		fail("mount refused: " + err.Error())
	}

	// WHICH ROW AT THE MOUNT POINT IS THIS PROCESS'S OWN — PROJECTION PHASE 7 §8.7, and it is taken here because
	// this is the one instant at which the answer is not a judgement: the `Mount()` above has just returned and
	// nothing has had a chance to change the stack since.
	own := &ownMountRef{}
	own.record(cfg.MountPoint, startupStack, startupStackKnown)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// WHAT IS ACTUALLY AT THE MOUNT POINT, SAMPLED OFF THE REQUEST PATH.
	//
	// `status.mounted` is a boolean this process sets when it believes it has mounted, and it is never
	// re-checked. Both of the worst failures in this product's history presented as a healthy daemon because
	// of that: a remount into a namespace with no host peer, and a cold corpse that refused every remount,
	// each with /readyz answering ready while no consumer could read a byte.
	//
	// THE PROBE CANNOT RUN ON THE REQUEST PATH, which is why it is a sampler and not a handler. It decides
	// with statfs, and statfs is the transport check precisely BECAUSE it reaches the connection — on a live
	// mount this daemon's own serve loop answers it. A /readyz that probed inline would block for exactly as
	// long as the thing it exists to report on is broken.
	d.SetMountObserver(func() string { return fusefs.ObserveMountpoint(cfg.MountPoint).String() })
	go d.MountSampleLoop(ctx, mountSampleInterval, mountProbeTimeout)

	go func() {
		if err := d.ServeStatus(ctx); err != nil {
			logLine("status server stopped: " + err.Error())
		}
	}()

	// The pointer is polled rather than watched. A poll is bounded, has no inotify queue to overflow, and
	// cannot wedge the mount if the control plane's filesystem goes away.
	go func() {
		ticker := time.NewTicker(*pollInterval)
		defer ticker.Stop()
		lastGeneration := record.Sequence
		lastRefusal := ""
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				next := d.LoadPointer()
				switch {
				case next.Unchanged:
					// The steady state. An unchanged pointer is not an event and is not logged: at one poll
					// every few seconds, logging it would be the loudest thing the daemon ever did.
				case next.Accepted && next.Sequence != lastGeneration:
					lastGeneration = next.Sequence
					logLine(fmt.Sprintf("admitted generation %d (+%d added, -%d removed)",
						next.Sequence, next.Additions, next.Deletions))
				case !next.Accepted:
					// A refusal changes nothing a media server can see. It is reported once per distinct
					// reason rather than once per poll, so a stuck producer cannot fill the log.
					reason := describe(next)
					if reason != lastRefusal {
						lastRefusal = reason
						logLine("generation refused, still serving the last admitted one: " + reason)
					}
				}
			}
		}
	}()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)

	d.SetMounted(true)
	defer d.SetMounted(false)
	logLine(fmt.Sprintf("serving generation %d", record.Sequence))

	// PROJECTION PHASE 6 — BOUNDED AUTOMATIC RECOVERY, and the wiring is where the single-flight guarantee
	// actually lives.
	//
	// EVERY MUTATION OF `mount` STAYS IN THIS ONE GOROUTINE. The recovery loop decides and REQUESTS; it never
	// mounts, never unmounts and never touches the handle. That is not tidiness — a second goroutine calling
	// `remountLoop` would race the serve-death path on one mount point, and it would also leave this select
	// waiting on a `Done()` channel belonging to a mount that had already been replaced. A channel request
	// serviced by the owner makes both impossible without a lock, and makes "exactly one recovery at a time"
	// a property of the shape rather than a discipline somebody has to keep.
	d.EnableRecovery(*autoRecover)
	recoveryRequests := make(chan recoveryRequest)
	if d.RecoveryEnabled() {
		logLine("automatic recovery is ENABLED: bounded, budgeted, and it will never unmount anything that " +
			"is not this daemon's own")
		go recoveryLoop(ctx, d, recoveryRequests)
	}

	// THE SUPERVISOR. The serve loop can die while the process lives: an external umount or a closed
	// /dev/fuse tears the connection down from underneath us. A daemon that parked on Wait() and exited 0
	// over a vanished namespace is a media server with no files, so the tail of main is a select that tells
	// the two exits apart and reacts to a serve-loop death instead of parking forever.
	for {
		select {
		case sig := <-signals:
			logLine(fmt.Sprintf("received %s, unmounting", sig))
			cancel()
			// THE IDENTITY IS ASKED FIRST AND IT GOVERNS BOTH REMOVALS — PROJECTION PHASE 7 §8.7.6.
			//
			// `Unmount()` IS `umount(2)` AGAINST THE MOUNT POINT AND IT REMOVES WHATEVER IS ON TOP, which is not
			// necessarily this daemon's own mount. The restart-topology gate's `RT5` measured a stop removing a
			// tmpfs somebody had stacked above the live mount and leaving the projectiond mount standing — the
			// `--auto-remount` defect's own shape, on the one path nothing had ever asserted about.
			currentStack, currentStackKnown := fusefs.MountStackAt(cfg.MountPoint)
			mayRemove, why := shutdownMayRemoveOwnMount(*own, currentStack, currentStackKnown)
			unmountRefused := false
			if !mayRemove {
				logLine("leaving " + cfg.MountPoint + " exactly as it is: " + why)
			} else if err := mount.Unmount(); err != nil {
				// THE POLITE FORM FIRST, ALWAYS. An ordinary unmount takes nothing away from a consumer that is
				// not holding the mount open, and it is only ever aimed at a row this process has just proved is
				// the one it made.
				unmountRefused = true
				logLine("unmount refused: " + err.Error())
			}
			// ...AND WHEN IT IS REFUSED, THE PROCESS THAT MADE THE MOUNT REMOVES ITS OWN — PROJECTION PHASE 7 §8.7.
			//
			// AN ORDINARY UNMOUNT IS REFUSED FOR EXACTLY THE REASON THIS APPLIANCE EXISTS: somebody is reading
			// through it. With three media servers holding descriptors inside the namespace that is the ordinary
			// case rather than the exceptional one, and what it used to leave behind was a corpse the NEXT daemon
			// then stacked over — one dead layer per stop, for ever, which is §11.4 #16 and the second half of the
			// rough edge Phase 6 §9.7 named. The lazy form is what the daemon's own startup message already tells
			// an operator to use on a stale mount; here it is used on a mount this process can PROVE is its own.
			//
			// AND THE EVIDENCE IS RE-TAKEN BEFORE THE DESTRUCTIVE FORM, which is §8.4.5's own rule applied here:
			// the refused unmount is an instant of its own, and something may have been stacked in it.
			afterStack, afterKnown := fusefs.MountStackAt(cfg.MountPoint)
			if detach, whyDetach := planShutdownDetach(unmountRefused, *own, afterStack, afterKnown); detach {
				logLine("detaching this process's own mount at " + cfg.MountPoint + " on the way out: " + whyDetach)
				if err := unix.Unmount(cfg.MountPoint, unix.MNT_DETACH); err != nil {
					logLine("shutdown detach refused: " + err.Error())
				}
			} else if unmountRefused {
				logLine("leaving " + cfg.MountPoint + " exactly as it is: " + whyDetach)
			}
			// THE WAIT IS BOUNDED AND THE CLEANUP ABOVE IS NOT. A lazily detached mount keeps its super-block for
			// as long as a consumer holds a descriptor inside it, so the request loop can outlive the shutdown by
			// design; the row is already gone, which is the only part an operator or the next daemon can see.
			select {
			case <-mount.Done():
			case <-time.After(shutdownServeDrainBudget):
				logLine("the request loop is still held by a consumer's open descriptor; exiting with the " +
					"mount point already released")
			}
			return
		case <-mount.Done():
			if mount.UnmountRequested() {
				// The loop only exits this way when the signal branch above asked it to. Not a death.
				return
			}
			serveErr := mount.ServeErr()
			d.SetMounted(false)
			d.RecordServeDeath(serveErr)
			logLine("serve loop died: " + describeServeDeath(serveErr))
			if !*autoRemount {
				os.Exit(*serveExitCode)
			}
			if !remountLoop(d, cfg, *debug, *strictMount, &mount, mountsAtStartup, startupCountKnown, true,
				own, startupStack, startupStackKnown) {
				logLine("serve loop died and no remount succeeded; exiting")
				os.Exit(*serveExitCode)
			}
			d.ClearServeDeath()
			d.SetMounted(true)
			logLine(fmt.Sprintf("remounted; serving generation %d", record.Sequence))
		case request := <-recoveryRequests:
			// A RECOVERY THE RECOVERY LOOP DECIDED ON AND THIS GOROUTINE PERFORMS.
			//
			// The budget is spent HERE, inside `RecoveryBeginAttempt`, and not where the decision was taken:
			// between the two the serve-death branch above may have fixed the very fault this was for, and
			// spending a budget on somebody else's repair is how three attempts become one real attempt and
			// two accidents. Begin re-checks the class and writes the ledger BEFORE anything happens, so an
			// attempt whose spend cannot be recorded never happens at all.
			granted, code := d.RecoveryBeginAttempt(request.class, time.Now())
			if !granted {
				logLine("recovery not started: " + code)
				request.reply <- false
				continue
			}
			logLine("recovery: " + code)
			// THE SAME REMOUNT THE SERVE-DEATH PATH USES, WITH THE SAME GUARDS AND NOTHING ADDED. Phase 6
			// contributes a second REASON to call this and no new behaviour inside it: `planRemountCleanup`
			// still only ever touches our own mount, and the drain still never goes below the floor counted
			// before this process mounted anything.
			ok := remountLoop(d, cfg, *debug, *strictMount, &mount, mountsAtStartup, startupCountKnown, false,
				own, startupStack, startupStackKnown)
			if ok {
				// A REMOUNT IS NOT YET A RECOVERY, WHICH IS WHY NOTHING IS CLEARED HERE BUT THE FLAG. The
				// serve-death branch above clears a death because it recorded one; this branch recorded
				// nothing, and `mounted` was never set false — the fault it is repairing is one the daemon's
				// own belief could not see. The budget is refunded only by observed, confirmed readiness.
				// THE WORDING IS "SERVING AGAIN" AND NOT "REMOUNTED", because since Phase 7 §8.5 the repair may
				// have been the drain alone with no mount syscall taken at all — and a log line that named an
				// action the supervisor deliberately did not perform is the instrument defect this tranche spent
				// two attempts on, written into the product instead.
				logLine("recovery: the mount point is serving again; readiness must still confirm it")
			} else {
				logLine("recovery: no remount succeeded")
			}
			d.RecoveryFinishAttempt(ok)
			request.reply <- ok
		}
	}
}

// recoveryRequest is one recovery the recovery loop has decided on and the mount owner will perform. The
// reply channel is BUFFERED so a requester that has already given up on its deadline cannot wedge the owner.
type recoveryRequest struct {
	class string
	reply chan bool
}

// recoveryLoop is Phase 6's supervisor. It decides and it requests; it performs nothing.
//
// IT HAS NO SURFACE. There is no socket, no route and no flag that can trigger a recovery from outside this
// process — the loop reads this daemon's own readiness verdict in memory. "Loopback-only" was the weaker
// property that was available and this is the stronger one that was cheaper.
//
// THE ATTEMPT DEADLINE IS APPLIED HERE RATHER THAN BY THE OWNER, AND THE REASON IS WHAT AN ABANDONED ATTEMPT
// IS. A remount can park in an uninterruptible `statfs` against a wedged connection, which returns when the
// connection is torn down and not before; nothing can cancel it. So the deadline bounds how long this loop
// WAITS, records the attempt as spent, and then stops for good: `RecoveryAbandonAttempt` deliberately does
// not release single-flight, because a second remount against a mount point the first one is still inside is
// the worst blast radius in this product.
func recoveryLoop(ctx context.Context, d *daemon.Daemon, requests chan<- recoveryRequest) {
	ticker := time.NewTicker(daemon.RecoveryTick)
	defer ticker.Stop()
	lastLogged := ""
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		decision := d.RecoveryDecide(time.Now())
		if !decision.Act() {
			// EVERY DECISION IS PUBLISHED ON THE STATUS SURFACE AND ONLY CHANGES ARE LOGGED. A refusal is a
			// STATE, so an operator reading /readyz a minute after a foreign overlay appeared still sees why
			// nothing is happening — while the log does not repeat itself once a second forever.
			if code := decision.Code(); code != lastLogged {
				lastLogged = code
				if decision.IsRefusal() {
					logLine("recovery refused: " + code + " (" + decision.Remediation() + ")")
				}
			}
			continue
		}
		lastLogged = decision.Code()
		reply := make(chan bool, 1)
		// A BOUNDED HANDOFF. If the owner is busy — servicing a serve-loop death, most likely — this waits
		// one tick and then abandons the decision WITHOUT SPENDING ANYTHING. The fault will still be there
		// next tick if nobody fixed it, and it will not be if somebody did.
		select {
		case requests <- recoveryRequest{class: decision.Code(), reply: reply}:
		case <-time.After(daemon.RecoveryTick):
			logLine("recovery deferred: " + daemon.RecoveryNoActionSupervisorBusy)
			continue
		case <-ctx.Done():
			return
		}
		select {
		case <-reply:
		case <-time.After(daemon.RecoveryAttemptDeadline):
			// The attempt is past its deadline. It is counted, and nothing further is ever attempted.
			d.RecoveryAbandonAttempt()
			logLine("recovery: " + daemon.RecoveryAttemptTimeout +
				"; no further attempt will be made by this process")
			return
		case <-ctx.Done():
			return
		}
	}
}

// healthcheckClientTimeout bounds the one loopback request the healthcheck makes.
//
// IT IS STRICTLY UNDER THE SHIPPED HEALTHCHECK'S OWN TIMEOUT, so a daemon that cannot answer produces a
// PROBE THAT REPORTS rather than one Docker kills: the difference is a health log that says why and one that
// says nothing. And it is far above `/readyz`'s latency budget, so an endpoint answering inside its contract
// can never be recorded as a timeout.
const healthcheckClientTimeout = 4 * time.Second

// runHealthcheck reads this daemon's own /readyz over loopback and returns the process exit status.
//
// IT FAILS CLOSED, EVERYWHERE. No status address, an unreachable endpoint, an unreadable body, a status that
// is not 200 — every one of them is exit 1. "I could not ask" is not "yes", and a healthcheck that answered
// healthy when it could not reach the daemon would be worse than having none: it would be a green light
// wired to nothing, which is the exact shape of failure this whole tranche exists to remove.
//
// WHAT IT PRINTS IS THE REASON CODE AND NOTHING ELSE. Docker keeps healthcheck output in the container's
// health log, so this is the one place the closed-set reason reaches an operator without them having to go
// and read /readyz themselves. It is a code from a fixed list — no path, no origin, no OS string.
func runHealthcheck(cfg daemon.Config) int {
	if cfg.StatusAddr == "" {
		fmt.Fprintln(os.Stderr, "healthcheck: no statusAddr is configured, so readiness cannot be read")
		return 1
	}
	client := &http.Client{Timeout: healthcheckClientTimeout}
	response, err := client.Get("http://" + cfg.StatusAddr + "/readyz")
	if err != nil {
		// The error is not echoed: it carries the address that was dialled, and this output is a document an
		// operator pastes. That the endpoint could not be reached is the whole of what matters here.
		fmt.Fprintln(os.Stderr, "healthcheck: the status surface could not be reached")
		return 1
	}
	defer response.Body.Close()
	// BOUNDED. The body is this daemon's own status document, but a healthcheck that could be made to read an
	// unbounded stream is a healthcheck that can be made to hang.
	var report struct {
		Ready       bool   `json:"ready"`
		ReadyReason string `json:"readyReason"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&report); err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck: the status document could not be read")
		return 1
	}
	reason := report.ReadyReason
	if reason == "" {
		reason = "unreported"
	}
	if response.StatusCode != http.StatusOK || !report.Ready {
		fmt.Fprintln(os.Stderr, "healthcheck: not ready: "+reason)
		return 1
	}
	fmt.Println("healthcheck: ready: " + reason)
	return 0
}

// remountLoop re-establishes the mount after a serve-loop death. It is bounded: three attempts with linear
// backoff, so a dying host does not burn CPU remounting forever. Each attempt first does a best-effort
// unmount of the dead handle, because a serve-loop death can leave the mountpoint half-attached and the next
// Mount() is a stack over whatever is there. On success the caller's handle is replaced and it returns true.
// shouldUnmountBeforeRemount reports whether the remount loop's cleanup unmount is allowed to run, given what
// the probe found at the mount point.
//
// IT IS A NAMED FUNCTION RATHER THAN AN `if` INSIDE THE LOOP so that a test can drive the shipped decision
// instead of an imitation of it, and so the table below is exhaustive on ProbeResult rather than being a
// condition somebody widens later. The rule is one sentence: unmount only what is ours.
//
//   - ProbeLiveProjectiond / ProbeStaleProjectiond — ours, alive or a corpse. Ours to remove.
//   - ProbeForeign — somebody else's, and in every containerised topology it is the OPERATOR'S BIND, the one
//     thing that must survive for the remount to be visible to anyone. Unmounting it is the defect.
//   - ProbeEmpty — nothing to unmount; calling unmount would act on whatever is underneath.
//
// remountCleanup is what the supervisor does with whatever is at the mount point before it mounts again.
type remountCleanup int

const (
	// Leave it alone. Anything that is not ours, and anything that is not there.
	remountCleanupNone remountCleanup = iota
	// An ordinary unmount. Our own LIVE mount, which a lazy detach would take away from every consumer
	// holding it — the hazard a media-server data-plane gate recorded in its own words, after a real run.
	remountCleanupUnmount
	// A lazy detach. Our own DEAD mount, which is a corpse and costs a consumer nothing to remove.
	remountCleanupLazyDetach
)

func (c remountCleanup) String() string {
	switch c {
	case remountCleanupUnmount:
		return "unmount"
	case remountCleanupLazyDetach:
		return "lazy detach"
	default:
		return "nothing"
	}
}

// underlayDigestOrNone renders a fingerprint for a log line, and says `none` rather than printing nothing when
// there was no stack to fingerprint. A blank in a log line is indistinguishable from a field somebody forgot.
func underlayDigestOrNone(digest string) string {
	if digest == "" {
		return "none"
	}
	return digest
}

// newUnderlayVerifier builds the thing the recovery supervisor asks "is the mount point in exactly the state
// you measured before I mounted anything?" — PHASE 7 §8.4.
//
// IT CLOSES OVER THE STARTUP FINGERPRINT AND RE-READS ONLY THE PRESENT. The baseline is the one taken before
// the first `Mount()`; nothing here can refresh it, which is the property that makes the answer mean anything.
//
// IT READS `/proc/self/mountinfo` AND NOTHING ELSE, so it cannot block: procfs is not served by a FUSE
// connection, and the whole reason the mount OBSERVATION is sampled on its own cadence is the `statfs` that
// this deliberately does not take. That is what allows the verdict to be taken fresh at the instant of the
// decision instead of read from a store that may be a second old.
//
// AND IT LOGS THE CHANGES ONLY, WITH FIELD NAMES AND NEVER VALUES. The first measured run of this decision is
// the thing that matters, and a run that REFUSES is only useful if it says which evidence failed. A field name
// is a closed-set word; the values behind it are mount sources and subtree roots, which this daemon's log is
// forbidden to carry.
func newUnderlayVerifier(mountPoint string, startup []fusefs.MountIdentity,
	startupKnown bool) func() (string, string) {
	var mu sync.Mutex
	lastLogged := ""
	baseline := fusefs.UnderlayDigest(startup)
	return func() (string, string) {
		current, currentKnown := fusefs.MountStackAt(mountPoint)
		verdict, changedField := fusefs.CompareUnderlay(startup, startupKnown, current, currentKnown)
		// THE DIGEST PUBLISHED IS ALWAYS THE ONE THE VERDICT IS ABOUT: the predeclared underlay. It does not
		// move — that is the point of it — so a gate can assert that the attachment the daemon mounted over
		// after a recovery is the one it fingerprinted before the first mount, from outside the process.
		digest := baseline
		mu.Lock()
		defer mu.Unlock()
		line := verdict
		if changedField != "" {
			line = verdict + " (" + changedField + ")"
		}
		if line != lastLogged {
			lastLogged = line
			logLine("the mount point " + mountPoint + " is " + line + "; underlay " +
				underlayDigestOrNone(digest))
		}
		return verdict, digest
	}
}

// planRemountCleanup decides what the supervisor may do to the mount point before remounting over it.
//
// WHY A STALE MOUNT OF OURS NEEDS THE LAZY FORM, AND A REAL RUN IS WHY. An ordinary unmount cannot remove a
// mount that somebody is holding, and after a connection abort the consumers ARE holding it — three media
// servers with open handles. Measured on the real Unraid host: the ordinary unmount returned without
// removing anything, the mount syscall that followed could not resolve a path through the corpse and failed
// with ENOTCONN, and the supervisor never recovered. `umount -l` is exactly what this daemon's own startup
// message tells an operator to do about a stale mount ("clear it with: umount -l"); the recovery path now
// does what it advises instead of trying something it has just been shown cannot work.
//
// A CORPSE COSTS A CONSUMER NOTHING TO REMOVE, WHICH IS WHY THE LAZY FORM IS SAFE HERE AND ONLY HERE. Every
// read through a dead connection already fails; detaching it takes away nothing that worked. Doing the same
// to a LIVE mount is the opposite — that is the hazard the data-plane gates record, where removing the mount
// is what breaks recovery — so a live mount keeps the ordinary unmount it has always had.
//
// FOREIGN SAFETY IS UNCHANGED AND IS THE WHOLE REASON THIS FUNCTION EXISTS. Anything that is not ours, and
// anything unrecognised, is still left strictly alone: `--auto-remount` once unmounted the operator's own
// bind and recovered for the daemon and for nobody else, and no case below may ever reopen that.
// PROJECTION PHASE 7 ADDS EXACTLY ONE ROW, AND IT IS THE ONE PHASE 6 §9.7 NAMED AS NEXT WORK.
//
// `probe` is `ProbeMountpoint`, which classifies by the BOTTOM entry of the mount stack — right for the
// startup question it was written for ("is the thing I am about to stack over one of my own corpses?") and
// WRONG for this one. In every containerised topology this daemon ships in, the bottom entry at the mount
// point is the operator's own bind, and on Unraid that bind's file-system type is the host's `fuse.shfs`.
// So after a serve-loop death the bottom probe sees `statfs`=ENOTCONN over a mount whose type is not ours
// and answers FOREIGN — the safest possible answer, and the reason the drain below never ran on the real
// host. Phase 6 measured that and recorded it: "a recovery usually STACKS OVER the corpse rather than
// removing it", so a mount point that has survived several recoveries carries several dead layers.
//
// `observed` is `ObserveMountpoint`, which classifies by the TOP of the stack — the mount a reader actually
// reaches, and the one a drain would remove. When the top is OUR OWN DEAD MOUNT, draining is exactly the
// right thing and the drain is already written for it.
//
// WHY THIS IS SAFE, AND WHY IT IS A NEW ROW RATHER THAN A REPLACEMENT. Every other case is byte-for-byte the
// decision it has always been: this clause can only ever ADD a lazy detach, and only when the top of the
// stack is a `fuse.projectiond` mount whose transport is gone. What it authorises is bounded by the drain
// itself, which has not changed: the drain removes only mounts whose TOP type is ours, never goes below
// `mountsAtStartup` — the count taken before this process mounted anything, so the operator's bind is out of
// reach by construction rather than by inspection — refuses to act at all on an unmeasured floor or an
// unreadable mount table, and stops at a cap. A foreign mount on top still returns NOTHING here, which is the
// `--auto-remount` defect's own rule and no case may reopen it.
func planRemountCleanup(probe, observed fusefs.ProbeResult) remountCleanup {
	if observed == fusefs.ProbeStaleProjectiond {
		return remountCleanupLazyDetach
	}
	switch probe {
	case fusefs.ProbeStaleProjectiond:
		return remountCleanupLazyDetach
	case fusefs.ProbeLiveProjectiond:
		return remountCleanupUnmount
	case fusefs.ProbeForeign, fusefs.ProbeEmpty:
		return remountCleanupNone
	default:
		// An unrecognised result is not a licence to touch something unidentified.
		return remountCleanupNone
	}
}

// drainAloneRepairedIt reports whether the corpse drain has already put the mount point back into service, so
// that no mount syscall is needed — PHASE 7 §8.5, and the residual §11.4.2 measured in the daemon's own
// numbers as the layer count going `now 3` → `now 4` across successive faults.
//
// ALL FIVE CONDITIONS ARE NECESSARY AND THE FUNCTION IS EXHAUSTIVE ON THEM RATHER THAN A CHAIN SOMEBODY CAN
// EXTEND:
//
//   - the drain removed something, so this can never fire on a path that changed nothing;
//   - the serve loop did NOT die — a fact about which supervisor called, not a claim about the mount. After a
//     death our own mount is gone by definition and a remount is the only repair there is;
//   - the mount point observes as OUR OWN LIVE MOUNT. `ObserveMountpoint` reads the TOP of the stack and its
//     `statfs` is answered by this daemon's own serve loop, so this is the one condition that is evidence of
//     service rather than of shape;
//   - the row count is a MEASUREMENT, and an unmeasured one authorises nothing here exactly as it authorises
//     no detach;
//   - and that count is at or under one layer above the measured startup floor, which is
//     `MOUNT_LAYERS_ABOVE_FLOOR_MAX`. If more than one of ours is still up there, a remount is not what would
//     fix it and skipping would hide it.
func drainAloneRepairedIt(detached int, serveLoopDied bool, observed fusefs.ProbeResult,
	current int, currentKnown bool, mountsAtStartup int, startupCountKnown bool) bool {
	if detached <= 0 || serveLoopDied {
		return false
	}
	if observed != fusefs.ProbeLiveProjectiond {
		return false
	}
	if !currentKnown || !startupCountKnown {
		return false
	}
	return current <= mountsAtStartup+1
}

// ownMountRef is the identity of the mount row THIS PROCESS put at the mount point — PROJECTION PHASE 7 §8.7.
//
// WHY A DAEMON NEEDS TO KNOW WHICH ROW IS ITS OWN, AND WHY NOTHING ELSE IT ALREADY HAD COULD SAY. Every other
// fact this daemon holds about the mount point describes a SHAPE: `mountsAtStartup` is a count, `IsOurMountType`
// is a file-system type that a bind of somebody else's projectiond mount answers to as well, and
// `ObserveMountpoint` is a transport answer about whatever happens to be on top. Each of them was tried, and
// each of them was found to describe two different mounts at once — §11.4 #5 is the run where "above the floor
// and of our type" removed this daemon's own live mount, and §8.4.1 is why a count cannot tell an attachment
// from a different attachment of the same shape. THE ONLY THING THAT CAN IS THE ROW ITSELF.
//
// SO IT IS RECORDED AT THE ONE MOMENT IT IS UNAMBIGUOUS: immediately after a `Mount()` this process performed
// returned success, when the row on top of the fingerprinted underlay is the row that call just created and
// nothing else has had an instant in which to change it.
//
// AND IT IS "KNOWN" ONLY UNDER THE SAME EVIDENCE §8.4 ADMITS ANYTHING ON. If the mount table cannot be read,
// if the startup fingerprint was never taken, if the stack is not the predeclared underlay with EXACTLY ONE
// row above it, or if that row is not one of ours, then this process cannot prove which row it made and the
// identity stays UNKNOWN — which authorises nothing anywhere. It is held in memory for the life of one
// process and is never written down, for the same reason the underlay fingerprint is not: mount ids belong to
// the running kernel.
type ownMountRef struct {
	row   fusefs.MountIdentity
	known bool
}

// record re-measures which row this process owns, and is called after EVERY successful mount rather than once.
// A recovery replaces the mount, so an identity that was taken once would name a row that no longer exists —
// and a stale identity is worse than none, because it can never match and would silently refuse for ever.
func (o *ownMountRef) record(mountPoint string, startup []fusefs.MountIdentity, startupKnown bool) {
	o.row, o.known = fingerprintOwnMount(mountPoint, startup, startupKnown)
	if o.known {
		logLine("this process owns exactly one row at " + mountPoint + ", above the underlay it fingerprinted")
		return
	}
	// SAID ONCE, AT THE MOMENT IT BECOMES TRUE, so a shutdown that later declines to clean up is explained by a
	// line taken when the evidence was missing rather than looking like a new fault.
	logLine("this process cannot prove which row at " + mountPoint + " is its own, so it will remove nothing " +
		"there on the way out")
}

// fingerprintOwnMount answers which row at the mount point this process just created, and whether that can be
// PROVED rather than assumed.
//
// IT IS PURE OF EVERYTHING BUT THE MOUNT TABLE. It takes one read of `/proc/self/mountinfo`, which cannot
// block — procfs is not served by a FUSE connection — so it can be called on the mount path and on the way
// out, neither of which may ever wait on the thing they are reporting about.
//
// THE FOUR CONDITIONS ARE ALL NECESSARY AND EACH ONE FAILS CLOSED:
//
//   - the startup fingerprint exists, because without it there is no baseline to be "above";
//   - the mount table reads now, because a stack that cannot be read is not a stack anybody has identified;
//   - the stack is the predeclared underlay with EXACTLY ONE row above it — `underlay-covered` on identity,
//     not merely on a count, so every row beneath is the same attachment §8.4 measured before the first mount;
//   - and that one row is of our own file-system type. This is the WEAKEST of the four and it is last on
//     purpose: it is a necessary check and never a sufficient one, exactly as `IsOurMountType` says.
func fingerprintOwnMount(mountPoint string, startup []fusefs.MountIdentity,
	startupKnown bool) (fusefs.MountIdentity, bool) {
	current, currentKnown := fusefs.MountStackAt(mountPoint)
	return identifyOwnMount(current, currentKnown, startup, startupKnown)
}

// identifyOwnMount is the whole of that decision as a TOTAL function of two measurements, so the table that
// drives it can be exhaustive without a kernel — the same separation `planRemountCleanup` and
// `drainAloneRepairedIt` have, and for the same reason: the branch that must never be reached has to be
// EXECUTED by a test rather than merely written down.
func identifyOwnMount(current []fusefs.MountIdentity, currentKnown bool,
	startup []fusefs.MountIdentity, startupKnown bool) (fusefs.MountIdentity, bool) {
	if !startupKnown || !currentKnown {
		return fusefs.MountIdentity{}, false
	}
	if len(current) != len(startup)+1 {
		return fusefs.MountIdentity{}, false
	}
	if verdict, _ := fusefs.CompareUnderlay(startup, startupKnown, current, currentKnown); verdict != daemon.UnderlayCovered {
		return fusefs.MountIdentity{}, false
	}
	top := current[len(current)-1]
	if !fusefs.IsOurMountType(top.FsType) {
		return fusefs.MountIdentity{}, false
	}
	return top, true
}

// planShutdownDetach decides whether the shutdown path may detach the mount THIS PROCESS made, after an
// ordinary unmount of it has already been refused — PROJECTION PHASE 7 §8.7.
//
// WHAT THIS EXISTS FOR, AS A MEASUREMENT RATHER THAN A THEORY. §11.4 #16: the layer count at the projected
// mount point went from 1 to 2 across arm R3 and stayed there through R4 and R5, in BOTH namespaces, while the
// recovery supervisor demonstrably did nothing. R3 replaces the daemon on purpose — it is the only way to drop
// a memory-only lease — and a projectiond process that goes away without removing its own mount leaves a
// CORPSE at a mount point whose propagation is `rshared`: destroying a mount namespace does not propagate an
// unmount to its peers, so the row survives on the host, and the replacement daemon stacks over it because
// stacking over a stale mount is what this daemon's startup path does by design. Two of ours, permanently, for
// every stop the ordinary unmount could not complete — and with three media servers holding open descriptors
// inside the mount, the ordinary unmount is exactly what cannot complete.
//
// SO THE REPAIR IS AT THE ONE END WHERE OWNERSHIP IS NOT A JUDGEMENT: the process that MADE the mount removes
// it. Every other place this could be repaired was considered and each is worse, and saying so is the point:
//
//   - a drain at STARTUP would be a new process removing a row it never made, and inside a container it would
//     remove the OPERATOR'S OWN BIND — after a hard kill the bind Docker sets up IS the corpse, so detaching it
//     strands the mount point in the container's own root with no host peer, which is Phase 2's worst defect
//     reached from the other direction;
//   - a drain by the shipped operator command was refused, deliberately and in writing, before this tranche:
//     `deploy/projection-alpha.sh` preflight says what is there and prints `clear-stale-mount`, because
//     "unmounting something at the operator's mount point is the one action this whole tranche refuses to take
//     automatically";
//   - and widening the recovery drain would hand it a licence over rows nobody has identified, which is §11.4
//     #5 exactly.
//
// THE PROOF OF OWNERSHIP IS AN IDENTITY AND NOT A SHAPE. The row on top of the mount point must be
// BYTE-FOR-BYTE the row `fingerprintOwnMount` recorded when this process's own `Mount()` returned: same mount
// id, same parent, same device, same subtree root, same mount point, same propagation, same type, same source.
// A mount id is unique among live mounts, so nothing that is not that exact attachment can match — not a
// re-mounted bind of the same share, not a second daemon's mount of the same namespace, not a tmpfs, and not
// the operator's own bind.
//
// AND IT IS ONLY EVER REACHED WHEN THE ORDINARY UNMOUNT HAS ALREADY BEEN REFUSED, so on every path where the
// polite form works this decision changes nothing at all.
//
// WHAT IT CANNOT DO, WHICH IS THE HALF THAT MAKES IT SAFE: it never removes more than one row, never removes a
// row it did not make, never touches the underlay, never consults a file-system type on its own, and refuses
// outright on an unreadable mount table or an unproved identity. A daemon that is killed outright still leaves
// its mount behind — nothing inside a process can clean up after a `SIGKILL` — and §8.7 says so rather than
// implying otherwise.
func planShutdownDetach(unmountRefused bool, own ownMountRef,
	current []fusefs.MountIdentity, currentKnown bool) (bool, string) {
	if !unmountRefused {
		return false, "the ordinary unmount was not refused, so there is nothing left to detach"
	}
	return shutdownMayRemoveOwnMount(own, current, currentKnown)
}

// shutdownMayRemoveOwnMount is the identity question on its own, asked BEFORE the ordinary unmount as well as
// before the lazy one — PROJECTION PHASE 7 §8.7.6, and a measured run is why it is asked twice.
//
// WHAT `Unmount()` ACTUALLY DOES, WHICH IS NOT WHAT ITS NAME SUGGESTS. It is `umount(2)` against the mount
// POINT, and `umount(2)` removes whatever is on TOP of that path — not the mount the caller happens to be
// serving. Every version of this daemon has called it unconditionally on `SIGTERM`, and for the whole of that
// time it has been true that anything stacked above this daemon's mount would be removed by a stop instead of
// this daemon's own mount. **`deploy/projection-restart-topology-gate.sh` measured it on its first run**, at
// `RT5`: a tmpfs stacked above the live mount, a `docker stop`, and afterwards the tmpfs was gone and the
// projectiond mount was still there. The propagation made it worse rather than better — the mount point is
// `rshared`, so the removal propagated straight back out to the host.
//
// THAT IS THE `--auto-remount` DEFECT'S OWN SHAPE, ON A PATH NOBODY HAD LOOKED AT. Phase 6 `AA6` and `RC5`
// assert that a foreign overlay is left exactly where it is, and both of them assert it of the RECOVERY path.
// The shutdown path had no such assertion and no such guard, and §8.7's own safety contract only ever covered
// the detach it added.
//
// SO THE SAME EVIDENCE NOW AUTHORISES BOTH REMOVALS, AND THERE IS ONLY ONE OF IT. The row on top of the mount
// point must be byte-for-byte the row this process recorded creating. Anything else — a foreign overlay, a
// second projectiond mount of a different attachment, an unreadable mount table, an unproved identity, an
// empty mount point — and this daemon touches NOTHING on the way out and says so.
//
// WHAT IT COSTS, STATED RATHER THAN GLOSSED: when something is stacked above us we now leave our own mount
// standing, because it cannot be removed from underneath the thing on top of it without removing that too.
// That is the trade §8.7.2 already names for the hard-kill case, it is what the shipped `preflight`'s
// `clear-stale-mount` remediation exists for, and it is strictly better than the alternative, which is an
// appliance that silently unmounts whatever an operator put at its mount point every time it stops.
func shutdownMayRemoveOwnMount(own ownMountRef, current []fusefs.MountIdentity,
	currentKnown bool) (bool, string) {
	if !own.known {
		return false, "this process never proved which row it mounted, which authorises removing nothing"
	}
	if !currentKnown {
		return false, "an unreadable mount table, which authorises removing nothing"
	}
	if len(current) == 0 {
		return false, "nothing is mounted at the mount point any more"
	}
	if !current[len(current)-1].SameAttachment(own.row) {
		return false, "the row on top of the mount point is not the attachment this process created"
	}
	return true, "the row on top is byte-for-byte the attachment this process created"
}

// shutdownServeDrainBudget bounds how long a shutdown waits for the request loop after the mount has been
// dealt with.
//
// IT IS A BOUND ON WAITING AND NEVER ON CLEANING UP, and the order matters: the mount is removed FIRST and
// this only decides how long the process then lingers. A lazily detached FUSE mount keeps its super-block
// alive for as long as anything holds a descriptor inside it — which, with three media servers reading, can
// be indefinitely — so a shutdown that waited for the loop would be a shutdown that never returned, and the
// container runtime would kill it. It did exactly that before this bound existed. The row is already gone by
// then, so what this budget trades away is a tidy log line and nothing an operator can observe at the mount.
const shutdownServeDrainBudget = 5 * time.Second

// `serveLoopDied` IS A FACT ABOUT WHICH SUPERVISOR IS CALLING AND NOT A CLAIM ABOUT THE MOUNT. The serve-death
// branch of main's select passes true — its own mount is gone, that is what woke it — and the recovery branch
// passes false, because a recovery request is only ever serviced when no death has been observed. It is read in
// exactly one place: the drain-alone repair above, where "our own mount was never broken" is the whole premise.
func remountLoop(d *daemon.Daemon, cfg daemon.Config, debug, strictMount bool, mount **fusefs.Mounted,
	mountsAtStartup int, startupCountKnown, serveLoopDied bool,
	own *ownMountRef, startupStack []fusefs.MountIdentity, startupStackKnown bool) bool {
	const attempts = 3
	for attempt := 1; attempt <= attempts; attempt++ {
		time.Sleep(time.Duration(attempt) * time.Second)
		logLine(fmt.Sprintf("remount attempt %d/%d", attempt, attempts))
		// THE CLEANUP UNMOUNT MAY ONLY EVER TOUCH OUR OWN MOUNT, AND WITHOUT THIS GUARD IT TOOK SOMEBODY
		// ELSE'S — WHICH MADE --auto-remount RECOVER FOR THE DAEMON AND FOR NOBODY ELSE.
		//
		// A serve-loop death means the FUSE mount is ALREADY gone; that is what killed the loop. What is left
		// at the mount point is whatever was underneath it, and in every containerised topology this daemon
		// ships in that is the bind the operator mounted the directory through — the mount that carries the
		// namespace out to the host and to the media servers. Unconditionally unmounting here removed it.
		//
		// Measured on the real Unraid host, in the serve-death gate's phase B: before the remount the
		// daemon's namespace had `/mnt/projection … shared:11 - fuse.shfs` (the bind, peered with the host);
		// after it, that line was gone and only `fuse.projectiond … shared:59` remained. The remount had
		// landed on a plain directory in the container's own root, in a fresh peer group with no host peer.
		// The daemon logged "remounted; serving generation 1", /readyz answered ready, the process stayed
		// alive — and no consumer outside the container could see a single file. Every assertion the daemon
		// makes about itself was true and the recovery was worthless.
		//
		// So the probe decides. It is one statfs and one read of mountinfo, it never waits, and it answers
		// the only question that matters here: is the thing at this path OURS to unmount?
		probe := fusefs.ProbeMountpoint(cfg.MountPoint)
		// AND WHAT IS ON TOP OF THE STACK, WHICH IS A DIFFERENT QUESTION AND IS THE ONE A DRAIN ANSWERS TO.
		// It costs one more statfs and one more read of the mount table, neither of which waits.
		observed := fusefs.ObserveMountpoint(cfg.MountPoint)
		switch plan := planRemountCleanup(probe, observed); plan {
		case remountCleanupUnmount:
			if err := (*mount).Unmount(); err != nil {
				logLine("cleanup unmount refused: " + err.Error())
			}
		case remountCleanupLazyDetach:
			// THE CORPSES GO — ALL OF OURS, NOT THE TOP ONE — AND THEY GO THE ONE WAY THAT WORKS WHILE
			// SOMEBODY IS HOLDING THEM.
			//
			// An ordinary unmount returns without removing a busy mount, and the mount syscall that follows
			// cannot resolve a path through the corpse: ENOTCONN. A single lazy detach fixes that for ONE
			// layer, and a real run showed one layer is not enough — the daemon detached, tried, and was
			// refused with ENOTCONN again, because the mount point carried a STACK of our own dead mounts.
			// It legitimately does: every recovery in this daemon's design stacks over the corpse it found,
			// so a mount point that has survived two deaths has two corpses under the live one.
			//
			// So it drains, re-probing between each one, and it never removes anything the probe does not
			// call OUR OWN STALE MOUNT — a foreign mount or an empty path ends the loop untouched, which is
			// the rule the whole table exists to keep. The bound is small and finite because a mount point
			// that still answers "stale" after this many detaches is not a stack, it is a fault, and a
			// supervisor that spins on it is worse than one that reports it.
			// THE DRAIN DECIDES ON IDENTITY, NOT ON LIVENESS, AND THE DIFFERENCE TOOK THE OPERATOR'S BIND.
			//
			// A first version looped on the PROBE, which answers a question about the transport — and while a
			// stack is coming apart that answer is exactly what cannot be trusted. It also reads the BOTTOM
			// entry of a stacked mount point. Between them the loop removed one layer too many: the daemon
			// logged "detached 2 stale mount(s) ... (now empty)" and remounted into its own namespace with no
			// host peer, /readyz said ready, and all three media servers read nothing. That is the failure
			// --auto-remount was fixed for once already, reached from the other direction, and Phase 2's
			// gates cannot catch it because none of them has a consumer attached.
			//
			// So the loop asks only: is the mount ON TOP one of OURS? Nothing else is ever removed — the
			// operator's bind is not a `fuse.projectiond` mount and the loop stops the moment it surfaces.
			// ...AND IT NEVER GOES BELOW WHAT WAS ALREADY THERE WHEN THIS PROCESS STARTED.
			//
			// THE FILE-SYSTEM TYPE IS NOT ENOUGH, AND FINDING THAT OUT COST A RUN. In a container the mount
			// point is commonly a BIND OF A PROJECTIOND MOUNT — the operator binds a host path a previous
			// daemon already mounted — so the bind answers `fuse.projectiond` exactly as our own mount does.
			// A drain keyed only on the type removed it: "detached 2 stale mount(s) ... (now on top:
			// nothing)", a remount into a namespace with no host peer, /readyz ready, and all three media
			// servers reading nothing.
			//
			// `mountsAtStartup` is taken BEFORE this process mounted anything, so it is the count of mounts
			// that are not ours by construction rather than by inspection. The drain may only ever remove
			// what is stacked ABOVE it.
			// AN UNMEASURED FLOOR AUTHORISES NOTHING. A count of zero used to mean both "nothing is mounted
			// here" and "the question could not be asked", so a `/proc/self/mountinfo` that could not be read
			// would have set the floor to zero and licensed the drain to remove EVERYTHING — the operator's
			// bind included. The count now carries its own validity and this is where that is spent.
			const maxDetach = 8
			detached := 0
			stoppedAt := "nothing"
			if !startupCountKnown {
				stoppedAt = "an unmeasured startup floor, which authorises no detach at all"
			}
			for ; startupCountKnown && detached < maxDetach; detached++ {
				current, currentKnown := fusefs.CountMountsAt(cfg.MountPoint)
				if !currentKnown {
					stoppedAt = "an unreadable mount table, which authorises no further detach"
					break
				}
				if current <= mountsAtStartup {
					stoppedAt = fmt.Sprintf("the startup floor (%d at the floor, %d now)",
						mountsAtStartup, current)
					break
				}
				fsType, present := fusefs.TopMountFsTypeAt(cfg.MountPoint)
				if !present {
					stoppedAt = "nothing"
					break
				}
				if !fusefs.IsOurMountType(fsType) {
					stoppedAt = fsType
					break
				}
				// ...AND IT MUST BE DEAD. THE TYPE SAYS WHOSE IT IS AND SAYS NOTHING ABOUT WHETHER IT IS
				// STILL SERVING ANYBODY, AND THAT DISTINCTION COST THE FIRST REGRESSION RUN OF PHASE 7.
				//
				// Measured, on the real host, in the recovery gate's own RC8: the mount point held
				// [operator bind][THIS DAEMON'S LIVE MOUNT][a second daemon's corpse]. The drain removed the
				// corpse — correct — then found another `fuse.projectiond` mount above the floor and removed
				// THAT TOO, which was the live one this process was serving through. Its own log:
				//
				//	detaching one of ours at /mnt/projection: floor 1, now 3, on top fuse.projectiond
				//	detaching one of ours at /mnt/projection: floor 1, now 2, on top fuse.projectiond
				//	serve loop died: the FUSE serve loop exited without a requested unmount
				//
				// The floor is not enough on its own, because OUR OWN LIVE MOUNT IS ALSO ABOVE IT. What
				// separates the two is the transport, and that is the one question a corpse answers
				// instantly and unambiguously: FUSE caches nothing for `statfs`, so a dead connection
				// answers ENOTCONN immediately while a live one is answered by this daemon's own serve loop.
				//
				// SO THE DRAIN REMOVES ONLY WHAT IT HAS JUST CONFIRMED IS DEAD. Three conditions now stand
				// between a mount and a detach — above the measured startup floor, of our own type, and with
				// its transport gone — and a live mount of ours ends the loop untouched, which is the state
				// that was being destroyed.
				if observedTop := fusefs.ObserveMountpoint(cfg.MountPoint); observedTop != fusefs.ProbeStaleProjectiond {
					stoppedAt = fmt.Sprintf("%s (%s), which is not a corpse and is not ours to remove",
						fsType, observedTop)
					break
				}
				// THE EVIDENCE A DIAGNOSTIC NEEDS, AT THE MOMENT THE DECISION IS MADE. Counts and a
				// file-system type: no path beyond the operator's own mount point, no identity, no bytes.
				logLine(fmt.Sprintf("detaching one of ours at %s: floor %d, now %d, on top %s",
					cfg.MountPoint, mountsAtStartup, current, fsType))
				if err := unix.Unmount(cfg.MountPoint, unix.MNT_DETACH); err != nil {
					logLine("cleanup lazy detach refused: " + err.Error())
					stoppedAt = fsType
					break
				}
			}
			// THE CAP IS A STOPPING REASON LIKE ANY OTHER, AND IT USED TO BE INDISTINGUISHABLE FROM A CLEAN
			// DRAIN. Reaching `maxDetach` leaves `stoppedAt` at its initial "nothing", so a supervisor that
			// had removed eight layers and was STILL above the floor logged the same sentence as one that had
			// tidied the mount point completely. That is the reporting failure this repository keeps finding:
			// a default value being read as a measurement.
			//
			// IT IS REPORTED RATHER THAN TREATED AS FATAL, and the reason is that stacking over residual
			// layers WORKS — it is what the daemon does at startup over every corpse it inherits. Refusing to
			// remount here would turn a state the product recovers from into an outage, so the remount goes
			// ahead and the anomaly is named: a mount point that still has our own dead layers on it after
			// eight detaches is a fault to investigate, not a reason to stop serving.
			if startupCountKnown && detached == maxDetach {
				stoppedAt = fmt.Sprintf("the detach cap of %d, WITH LAYERS OF OURS STILL ABOVE THE FLOOR; "+
					"the remount will stack over them", maxDetach)
			}
			logLine(fmt.Sprintf("detached %d stale mount(s) of ours at %s before remounting (now on top: %s)",
				detached, cfg.MountPoint, stoppedAt))
			// AND IF THE DRAIN ALONE FIXED IT, THERE IS NOTHING LEFT TO MOUNT — PHASE 7 §8.5.
			//
			// THIS IS THE SECOND RESIDUAL PHASE 7 §11.4.2 MEASURED, IN THE DAEMON'S OWN NUMBERS: the layer count
			// at the mount point went `now 3` → `now 4` across successive faults once the drain was reachable.
			// The dead layers go; what accumulated was a LIVE one. When the fault was SOMEBODY ELSE'S corpse
			// stacked above us, this daemon's own mount was never broken — the drain removes the corpse, the
			// mount point is serving again, and a remount then stacks a second live layer over a first that is
			// still connected. Two live mounts of ours at one mount point is a bound on nothing: only the top
			// one is read, and the one underneath is a namespace nobody can reach that this process is still
			// answering requests for.
			//
			// THE CONDITIONS ARE ALL FOUR NECESSARY AND THE ORDER IS THE CHEAPEST FIRST:
			//
			//   - the drain actually removed something, so this cannot fire on a path that changed nothing;
			//   - THE SERVE LOOP DID NOT DIE. That is a fact about which supervisor called this, not a claim
			//     about the mount: after a death our own mount is gone by definition and a remount is the only
			//     repair there is;
			//   - the mount point observes as OUR OWN LIVE MOUNT — the same `ObserveMountpoint` the drain just
			//     stopped on, which reads the TOP of the stack and answers from this daemon's own serve loop;
			//   - and the count is at or under one layer above the measured startup floor, which is the
			//     `MOUNT_LAYERS_ABOVE_FLOOR_MAX` this tranche predeclared. If there is still more than one of
			//     ours up there, the remount is not what would fix it and skipping would hide it.
			//
			// SKIPPING A MOUNT CANNOT DESTROY ANYTHING, which is what makes this the safe direction to be wrong
			// in. If the observation is wrong and the mount point is not really serving, readiness withholds on
			// the very next sample, the fault has not been cleared, and the supervisor comes back for it with
			// its budget intact.
			//
			// THE DECISION IS A NAMED FUNCTION AND NOT THESE FOUR CONDITIONS INLINE, for the same reason
			// `planRemountCleanup` is one: a table can then drive the SHIPPED decision instead of an imitation
			// of it, and the conditions cannot be widened later by somebody who only reads the `if`.
			observedAfterDrain := fusefs.ObserveMountpoint(cfg.MountPoint)
			currentAfterDrain, currentKnown := fusefs.CountMountsAt(cfg.MountPoint)
			if drainAloneRepairedIt(detached, serveLoopDied, observedAfterDrain, currentAfterDrain,
				currentKnown, mountsAtStartup, startupCountKnown) {
				logLine(fmt.Sprintf("the drain alone repaired %s: %d row(s) against a floor of %d, and the "+
					"one on top is this daemon's own live mount; NOT stacking another over it",
					cfg.MountPoint, currentAfterDrain, mountsAtStartup))
				// THE SURVIVING ROW IS RE-IDENTIFIED EVEN THOUGH NOTHING WAS MOUNTED, because the drain moved the
				// stack: rows came off it, and an identity taken before that describes a mount point that no
				// longer exists. Re-measuring is the only thing that can be right here, and if the drain left a
				// shape this cannot prove, the identity goes UNKNOWN and the shutdown removes nothing.
				own.record(cfg.MountPoint, startupStack, startupStackKnown)
				return true
			}
		default:
			logLine(fmt.Sprintf("nothing of ours at %s to clean up (bottom %s, top %s); leaving it mounted",
				cfg.MountPoint, probe, observed))
		}
		// THE MOUNT CALL IS BRACKETED, BECAUSE A REAL RUN SHOWED THIS LOOP PROMISING THREE ATTEMPTS AND
		// DELIVERING ONE. The daemon logged "remount attempt 1/3" and "remount refused: transport endpoint is
		// not connected" and then nothing at all — no attempt 2, no "no remount succeeded; exiting" — while
		// the process stayed alive for the next two minutes, its `/proc/<pid>/mountinfo` still readable. So
		// `remountLoop` never returned, and the only calls it can be inside are these. `logLine` writes to
		// unbuffered stderr, so a missing line is a call that has not come back rather than output lost.
		logLine(fmt.Sprintf("remount attempt %d/%d: calling mount", attempt, attempts))
		next, err := fusefs.Mount(d, cfg.MountPoint, fusefs.MountSettings{
			Debug: debug, StrictDirectMount: strictMount,
		})
		if err != nil {
			logLine("remount refused: " + err.Error())
			logLine(fmt.Sprintf("remount attempt %d/%d: returned, will retry after backoff", attempt, attempts))
			continue
		}
		*mount = next
		logLine(fmt.Sprintf("remount attempt %d/%d: mounted", attempt, attempts))
		// AND WHICH ROW IS NOW OURS, RE-MEASURED RATHER THAN CARRIED OVER. The mount this process owned a moment
		// ago has been replaced; carrying its identity forward would name a row that no longer exists.
		own.record(cfg.MountPoint, startupStack, startupStackKnown)
		return true
	}
	logLine("remount attempts exhausted")
	return false
}

// describeServeDeath renders a serve-loop death for the log. ServeErr is non-nil for a death (the serve
// goroutine reconstructs it), but the nil branch is kept as a guard: a death with nothing to say is still a
// death worth reporting, not a silence.
func describeServeDeath(err error) string {
	if err == nil {
		return "the serve loop exited without an error (external unmount or closed connection)"
	}
	return err.Error()
}

func describe(record daemon.AdmitRecord) string {
	if record.Refusal != "" {
		return record.Refusal
	}
	if len(record.Problems) == 0 {
		return "no problem reported"
	}
	out := record.Problems[0]
	if len(record.Problems) > 1 {
		out += fmt.Sprintf(" (and %d more)", len(record.Problems)-1)
	}
	return out
}

// logLine writes to stderr.
//
// NOTHING HERE CARRIES A PROVIDER PATH, a media path, a token, a URL, a header, an object reference or a byte
// of file content. The running daemon's whole log vocabulary is generation numbers, counts and closed-set
// codes.
//
// The precise exception, stated rather than glossed: a STARTUP failure may echo the operator's own --config
// argument, because they just typed it and cannot fix the problem without knowing which file was refused.
// The MACHINE report (--check-config) carries no path at all, and --debug-fuse — the one verbose mode — is
// explicit, off by default, and a development switch rather than a production one.
func logLine(message string) {
	fmt.Fprintf(os.Stderr, "projectiond: %s\n", message)
}

func fail(message string) {
	logLine(message)
	os.Exit(1)
}
