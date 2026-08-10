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
	"os"
	"os/signal"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/daemon"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/fusefs"
)

// Version is stamped at build time. It appears in the status document and nowhere else.
var Version = "0.1.0-phase1"

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

	// Mount returns a mount whose request loop is already running and whose INIT handshake has completed.
	mount, err := fusefs.Mount(d, cfg.MountPoint, fusefs.MountSettings{
		Debug: *debug, StrictDirectMount: *strictMount,
	})
	if err != nil {
		fail("mount refused: " + err.Error())
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
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

	// THE SUPERVISOR. The serve loop can die while the process lives: an external umount or a closed
	// /dev/fuse tears the connection down from underneath us. A daemon that parked on Wait() and exited 0
	// over a vanished namespace is a media server with no files, so the tail of main is a select that tells
	// the two exits apart and reacts to a serve-loop death instead of parking forever.
	for {
		select {
		case sig := <-signals:
			logLine(fmt.Sprintf("received %s, unmounting", sig))
			cancel()
			if err := mount.Unmount(); err != nil {
				logLine("unmount refused: " + err.Error())
			}
			<-mount.Done()
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
			if !remountLoop(d, cfg, *debug, *strictMount, &mount) {
				logLine("serve loop died and no remount succeeded; exiting")
				os.Exit(*serveExitCode)
			}
			d.ClearServeDeath()
			d.SetMounted(true)
			logLine(fmt.Sprintf("remounted; serving generation %d", record.Sequence))
		}
	}
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
func planRemountCleanup(probe fusefs.ProbeResult) remountCleanup {
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

func remountLoop(d *daemon.Daemon, cfg daemon.Config, debug, strictMount bool, mount **fusefs.Mounted) bool {
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
		switch plan := planRemountCleanup(probe); plan {
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
			const maxDetach = 8
			detached := 0
			stoppedAt := "nothing"
			for ; detached < maxDetach; detached++ {
				fsType, present := fusefs.TopMountFsTypeAt(cfg.MountPoint)
				if !present {
					stoppedAt = "nothing"
					break
				}
				if !fusefs.IsOurMountType(fsType) {
					stoppedAt = fsType
					break
				}
				if err := unix.Unmount(cfg.MountPoint, unix.MNT_DETACH); err != nil {
					logLine("cleanup lazy detach refused: " + err.Error())
					stoppedAt = fsType
					break
				}
			}
			logLine(fmt.Sprintf("detached %d stale mount(s) of ours at %s before remounting (now on top: %s)",
				detached, cfg.MountPoint, stoppedAt))
		default:
			logLine(fmt.Sprintf("nothing of ours at %s to clean up (%s); leaving it mounted",
				cfg.MountPoint, probe))
		}
		next, err := fusefs.Mount(d, cfg.MountPoint, fusefs.MountSettings{
			Debug: debug, StrictDirectMount: strictMount,
		})
		if err != nil {
			logLine("remount refused: " + err.Error())
			continue
		}
		*mount = next
		return true
	}
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
