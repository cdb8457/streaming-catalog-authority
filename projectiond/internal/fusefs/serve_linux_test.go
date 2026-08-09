//go:build linux

// The supervision contract of a Mounted handle, WITHOUT a kernel.
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE SMOKE. The serve-death gate proves the whole path on a host that
// has /dev/fuse: an external umount, a dead serve loop, exit 3 or a remount. That gate needs the host, and it
// is the only thing that can prove the kernel's half. What does NOT need a host is the decision the daemon
// makes once the loop has exited — whether that exit was a death or a shutdown — and a supervisor branches on
// exactly that. So it is pinned here, in seconds, everywhere.
//
// AND IT DRIVES THE SHIPPED FUNCTION. recordServeExit is a method rather than three lines inside Mount's
// goroutine for this reason alone: a test that instead wrote `serveErr = ...; close(served)` by hand would
// pass just as green with the product's own classification inverted, which is a test of the test.
//
// WHAT IT DOES NOT PROVE, stated rather than implied: that Unmount stores the flag BEFORE it asks the kernel
// to detach. That ordering is only observable against a real serve loop, and the serve-death gate's phase A
// — a clean SIGTERM that must exit 0 rather than being reported as a death — is what fails if it inverts.
package fusefs

import (
	"testing"
	"time"
)

// A serve loop that exits with no unmount having been requested is a DEATH. This is the case the supervisor
// reacts to, and the one that must never be reported as a clean shutdown: a daemon that called this graceful
// would exit 0 over a namespace that had vanished, which is a media server with no files and a green log.
func TestServeExitWithoutARequestedUnmountIsADeath(t *testing.T) {
	m := &Mounted{served: make(chan struct{})}

	if m.UnmountRequested() {
		t.Fatal("a fresh handle must not report an unmount request")
	}
	select {
	case <-m.Done():
		t.Fatal("a fresh handle must not be done")
	default:
	}

	m.recordServeExit()
	close(m.served)

	if m.UnmountRequested() {
		t.Fatal("nothing asked for an unmount, so UnmountRequested must stay false")
	}
	if m.ServeErr() == nil {
		t.Fatal("a serve loop that exited without a requested unmount is a death and must name itself")
	}
}

// The other half, and the reason the flag rather than the error is the discriminator: after Unmount has been
// asked for, the very same exit is a shutdown and carries nothing to report. Inverting this turns every
// SIGTERM into a serve-loop death, and with --serve-exit-code into a failing exit status on a clean stop.
func TestServeExitAfterARequestedUnmountIsNotADeath(t *testing.T) {
	m := &Mounted{served: make(chan struct{})}

	// Exactly what Unmount does before it touches the kernel.
	m.graceful.Store(true)

	m.recordServeExit()
	close(m.served)

	if !m.UnmountRequested() {
		t.Fatal("UnmountRequested must reflect the request")
	}
	if err := m.ServeErr(); err != nil {
		t.Fatalf("a requested unmount is not a death, got %v", err)
	}
}

// ServeErr BLOCKS until the loop has exited, and that is not a convenience: main reads it immediately after
// Done closes, and a version that answered early would hand the log a nil for a death that had a reason. The
// same close is what Done and Wait answer on, so all three agree on one event rather than three.
func TestServeErrWaitsForTheServeLoopAndAgreesWithDoneAndWait(t *testing.T) {
	m := &Mounted{served: make(chan struct{})}

	answered := make(chan error, 1)
	go func() { answered <- m.ServeErr() }()
	select {
	case err := <-answered:
		t.Fatalf("ServeErr answered %v before the serve loop had exited", err)
	case <-time.After(100 * time.Millisecond):
	}

	m.recordServeExit()
	close(m.served)

	select {
	case err := <-answered:
		if err == nil {
			t.Fatal("ServeErr must report the death it recorded")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ServeErr must answer once the serve loop has exited")
	}
	select {
	case <-m.Done():
	default:
		t.Fatal("Done must be closed once the serve loop has exited")
	}
	returned := make(chan struct{})
	go func() { m.Wait(); close(returned) }()
	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("Wait must return once the serve loop has exited")
	}
}
