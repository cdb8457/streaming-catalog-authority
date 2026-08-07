//go:build linux && fusesmoke

// The probe against a REAL kernel: a live projectiond mount probes live, and a projectiond mount whose process
// died WITHOUT unmounting probes stale — the exact state --refuse-stale exists to name. The stale case needs a
// mount whose daemon is gone, which this suite produces by re-executing itself: the child mounts and exits
// without unmounting, and the kernel marks the transport dead.
package fusefs

import (
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/daemon"
)

func TestFUSEMountProbeReportsLiveThenEmpty(t *testing.T) {
	if os.Getenv("PROJECTIOND_FUSE_SMOKE") == "" {
		t.Skip("set PROJECTIOND_FUSE_SMOKE=1 and run with /dev/fuse to exercise the mount")
	}
	if _, err := os.Stat("/dev/fuse"); err != nil {
		t.Skipf("no /dev/fuse on this host: %v", err)
	}

	mountPoint, _, mount := mountEmptyNamespace(t)

	// A mount answering statfs is live. This also pins the one string the probe depends on: go-fuse names the
	// file system fuse.projectiond, and if that ever changes, a live mount stops probing as live.
	if got := ProbeMountpoint(mountPoint); got != ProbeLiveProjectiond {
		t.Fatalf("a live projectiond mount must probe live, got %v", got)
	}

	if err := mount.Unmount(); err != nil {
		t.Fatal(err)
	}
	<-mount.Done()
	if got := ProbeMountpoint(mountPoint); got != ProbeEmpty {
		t.Fatalf("after unmount the mount point must probe empty, got %v", got)
	}
}

func TestFUSEMountProbeReportsStaleAfterChildDeath(t *testing.T) {
	if os.Getenv("PROJECTIOND_FUSE_SMOKE") == "" {
		t.Skip("set PROJECTIOND_FUSE_SMOKE=1 and run with /dev/fuse to exercise the mount")
	}
	if _, err := os.Stat("/dev/fuse"); err != nil {
		t.Skipf("no /dev/fuse on this host: %v", err)
	}

	base := t.TempDir()
	mountPoint := filepath.Join(base, "mnt")
	if err := os.MkdirAll(mountPoint, 0o755); err != nil {
		t.Fatal(err)
	}
	readyFile := filepath.Join(base, "ready")

	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestFUSEMountProbeHelperMountAndExit$")
	cmd.Env = append(os.Environ(),
		"PROJECTIOND_PROBE_HELPER=1",
		"PROJECTIOND_PROBE_MOUNTPOINT="+mountPoint,
		"PROJECTIOND_PROBE_READY_FILE="+readyFile,
	)
	// The child parks on stdin once its mount is live; closing the pipe releases it to exit WITHOUT
	// unmounting. That handshake is what makes the live assertion below deterministic instead of racing the
	// child's exit.
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	t.Cleanup(func() {
		// The child leaves a stale projectiond mount behind BY DESIGN; unmount it so the temp dir can go.
		if err := syscall.Unmount(mountPoint, 0); err != nil && !errors.Is(err, syscall.EINVAL) {
			t.Logf("cleanup unmount of the stale mount: %v", err)
		}
		if !waited {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	})

	if !waitForFile(t, readyFile, 30*time.Second) {
		t.Fatalf("the child never reported its mount; output:\n%s", output.String())
	}
	// The child is parked and its serve loop is running, so the mount is deterministically live.
	if got := ProbeMountpoint(mountPoint); got != ProbeLiveProjectiond {
		t.Fatalf("a live child mount must probe live, got %v", got)
	}

	// Release the child so it exits WITHOUT unmounting; the kernel turns the transport dead.
	if err := stdin.Close(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatalf("the child failed; output:\n%s", output.String())
	}
	waited = true

	deadline := time.Now().Add(10 * time.Second)
	for {
		if got := ProbeMountpoint(mountPoint); got == ProbeStaleProjectiond {
			break
		}
		if time.Now().After(deadline) {
			// A failure here is a kernel-behaviour surprise, so the report carries the raw syscall results
			// rather than just the probe's verdict.
			var st syscall.Statfs_t
			_, statErr := os.Stat(mountPoint)
			statfsErr := syscall.Statfs(mountPoint, &st)
			t.Fatalf("the dead child's mount never probed stale; output:\n%s\n"+
				"final probe=%v statErr=%v statfsErr=%v mountinfo=%+v",
				output.String(), ProbeMountpoint(mountPoint), statErr, statfsErr, mountInfoEntryAt(mountPoint))
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// TestFUSEMountProbeHelperMountAndExit is not a test in its own right: it is the CHILD of the stale probe,
// re-executed with PROJECTIOND_PROBE_HELPER=1. It mounts a namespace and then exits WITHOUT unmounting —
// exactly what a killed daemon does. The kernel keeps the mount and marks the transport dead, and the parent
// sees ProbeStaleProjectiond.
func TestFUSEMountProbeHelperMountAndExit(t *testing.T) {
	if os.Getenv("PROJECTIOND_PROBE_HELPER") != "1" {
		return
	}
	mountPoint := os.Getenv("PROJECTIOND_PROBE_MOUNTPOINT")
	readyFile := os.Getenv("PROJECTIOND_PROBE_READY_FILE")
	if mountPoint == "" || readyFile == "" {
		t.Fatal("helper environment is incomplete")
	}
	base := t.TempDir()
	manifestDir := filepath.Join(base, "manifest")
	cacheDir := filepath.Join(base, "cache")
	for _, dir := range []string{manifestDir, cacheDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	publish(t, manifestDir, "generation-1.json", buildManifest(1, "gen-one", nil, nil))
	d, err := daemon.New(daemon.Config{
		MountPoint:    mountPoint,
		PointerPath:   filepath.Join(manifestDir, "pointer.json"),
		ProbeCacheDir: cacheDir,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if record := d.LoadPointer(); !record.Accepted {
		t.Fatalf("the generation was not admitted: %+v", record)
	}
	if _, err := Mount(d, mountPoint, MountSettings{StrictDirectMount: true}); err != nil {
		t.Fatalf("child mount failed: %v", err)
	}
	// The mount is live. Tell the parent, then PARK on stdin: the parent probes the live state and then
	// releases this process by closing the pipe. Returning immediately would race the parent's live
	// assertion against this process exiting and turning the mount stale underneath it.
	if err := os.WriteFile(readyFile, []byte("live"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(os.Stdin, make([]byte, 1)); err != nil && !errors.Is(err, io.EOF) {
		t.Fatalf("waiting for the parent to release the helper: %v", err)
	}
	// Return: the process exits WITHOUT unmounting, and the kernel turns this mount stale.
}

func waitForFile(t *testing.T, path string, timeout time.Duration) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if _, err := os.Stat(path); err == nil {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(50 * time.Millisecond)
	}
}
