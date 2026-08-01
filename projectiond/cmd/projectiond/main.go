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

	// Mount returns a mount whose request loop is already running and whose INIT handshake has completed.
	mount, err := fusefs.Mount(d, cfg.MountPoint, *debug)
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
	go func() {
		<-signals
		logLine("unmounting")
		cancel()
		if err := mount.Unmount(); err != nil {
			logLine("unmount refused: " + err.Error())
		}
	}()

	d.SetMounted(true)
	logLine(fmt.Sprintf("serving generation %d", record.Sequence))
	mount.Wait()
	d.SetMounted(false)
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
