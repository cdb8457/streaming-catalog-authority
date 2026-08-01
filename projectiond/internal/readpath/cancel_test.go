package readpath

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/cache"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/manifest"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/source"
)

// gatedAdapter serves reads below a threshold immediately and PARKS everything at or above it, recording
// whether the request context was cancelled while parked. That is the only way to prove a cancellation
// actually reached the transport rather than merely being noted in the reader's own bookkeeping.
type gatedAdapter struct {
	parkAtOrAbove int64
	parked        chan struct{}
	release       chan struct{}
	parkOnce      sync.Once
	cancelled     atomic.Int64
	completed     atomic.Int64
}

func newGatedAdapter(parkAtOrAbove int64) *gatedAdapter {
	return &gatedAdapter{
		parkAtOrAbove: parkAtOrAbove,
		parked:        make(chan struct{}),
		release:       make(chan struct{}),
	}
}

func (a *gatedAdapter) Kind() string { return "http-range" }
func (a *gatedAdapter) Close() error { return nil }

func (a *gatedAdapter) fill(req source.ReadRequest, dst []byte) int {
	for i := int64(0); i < req.Length; i++ {
		dst[i] = byte((req.Offset + i) % 251)
	}
	return int(req.Length)
}

func (a *gatedAdapter) Fetch(ctx context.Context, req source.ReadRequest, dst []byte) (int, error) {
	if req.Offset < a.parkAtOrAbove {
		a.completed.Add(1)
		return a.fill(req, dst), nil
	}
	a.parkOnce.Do(func() { close(a.parked) })
	select {
	case <-ctx.Done():
		a.cancelled.Add(1)
		return 0, source.Fail(source.CondReadDeadline, source.ClassTerminal, "")
	case <-a.release:
		a.completed.Add(1)
		return a.fill(req, dst), nil
	}
}

func newBlockingReader(t *testing.T, adapter source.Adapter) *Reader {
	t.Helper()
	probe, err := cache.NewProbeCache(t.TempDir(), 64<<20, 4<<20)
	if err != nil {
		t.Fatal(err)
	}
	cfg := DefaultConfig()
	cfg.ReadDeadline = 10 * time.Second // long, so a pass cannot come from the deadline firing
	reader, err := NewReader(cfg, staticRouter{adapter}, probe, cache.NewPlaybackCache(32<<20, 8<<20))
	if err != nil {
		t.Fatal(err)
	}
	return reader
}

// REGRESSION: a seek said it cancelled read-ahead but only reset a counter and bumped an epoch. The prefetch
// itself ran on a context only Release could cancel, so an abandoned prefetch kept a limiter slot and kept
// pulling provider bytes for the whole read deadline. Worse, the seek was noticed only AFTER the seeking read
// completed, so against a slow source the cancellation waited on the very thing it was meant to make room for.
func TestSeekCancelsAnInFlightPrefetchPromptly(t *testing.T) {
	// Demand reads stay inside the first few megabytes; the block read-ahead reaches for is past the gate.
	const gate = int64(8 << 20)
	adapter := newGatedAdapter(gate)
	reader := newBlockingReader(t, adapter)
	handle, err := reader.Open(testEntry(), "gen_one")
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Release(handle)

	// Sequential demand reads, all served immediately, arming read-ahead. The prefetch that follows them
	// reaches past the gate and parks.
	offset := int64(manifest.ProbeWindowBytes)
	for i := 0; i < DefaultConfig().SequentialTriggerReads+2; i++ {
		n, err := reader.Read(context.Background(), handle, make([]byte, 1<<20), offset)
		if err != nil {
			t.Fatalf("demand read at %d: %v", offset, err)
		}
		offset += int64(n)
	}

	select {
	case <-adapter.parked:
	case <-time.After(5 * time.Second):
		t.Fatal("read-ahead never reached past the gate, so there was nothing to cancel")
	}
	if adapter.cancelled.Load() != 0 {
		t.Fatal("something was cancelled before the seek")
	}

	// THE SEEK. A read that does not continue where the last one ended must cancel the prefetch NOW — before
	// the seeking read itself completes. This one is served immediately, but the cancellation must not have
	// depended on that.
	start := time.Now()
	if _, err := reader.Read(context.Background(), handle, make([]byte, 4096), 1<<20); err != nil {
		t.Fatalf("the seeking read failed: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for adapter.cancelled.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if adapter.cancelled.Load() == 0 {
		t.Fatal("a seek did not cancel the in-flight prefetch")
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("the cancellation was not prompt: %v", elapsed)
	}
	if reader.Stats.PrefetchDropped.Load() == 0 {
		t.Fatal("the abandoned prefetch was not recorded")
	}
	close(adapter.release)
}

// A demand read that JOINS a fetch must not be cancelled by another participant leaving. Single-flight is
// only correct if the shared fetch outlives whoever started it for as long as somebody still wants it.
func TestSharedFetchSurvivesOneParticipantLeaving(t *testing.T) {
	adapter := newGatedAdapter(0) // every fetch parks
	reader := newBlockingReader(t, adapter)

	first, err := reader.Open(testEntry(), "gen_one")
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Release(first)
	second, err := reader.Open(testEntry(), "gen_one")
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Release(second)

	// The first reader starts the fetch and then gives up on it.
	leaving, cancelLeaving := context.WithCancel(context.Background())
	leftEarly := make(chan struct{})
	go func() {
		defer close(leftEarly)
		_, _ = reader.Read(leaving, first, make([]byte, 4096), 0)
	}()
	select {
	case <-adapter.parked:
	case <-time.After(3 * time.Second):
		t.Fatal("the fetch never started")
	}

	// The second reader joins the same block.
	joined := make(chan error, 1)
	go func() {
		_, err := reader.Read(context.Background(), second, make([]byte, 4096), 0)
		joined <- err
	}()
	time.Sleep(100 * time.Millisecond) // let it join

	cancelLeaving()
	<-leftEarly

	// The fetch must still be alive for the participant that is still waiting.
	close(adapter.release)
	select {
	case err := <-joined:
		if err != nil {
			t.Fatalf("a joined reader was cancelled by another participant leaving: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the shared fetch was abandoned while a reader still wanted it")
	}
	if adapter.cancelled.Load() != 0 {
		t.Fatal("the shared fetch was cancelled while a participant was still waiting")
	}
}

// REGRESSION: a zero-length read reached the sequential bookkeeping, which once the threshold was met
// computed blockFor(end-1) — a negative offset at offset zero, and undefined block arithmetic.
func TestZeroLengthReadIsANoOp(t *testing.T) {
	adapter := newCountingAdapter()
	reader := newReader(t, adapter)
	handle, err := reader.Open(testEntry(), "gen_one")
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Release(handle)

	// Establish sequentiality first, so the trigger is armed when the empty read arrives.
	offset := int64(manifest.ProbeWindowBytes)
	for i := 0; i < DefaultConfig().SequentialTriggerReads+1; i++ {
		n, err := reader.Read(context.Background(), handle, make([]byte, 1<<20), offset)
		if err != nil {
			t.Fatal(err)
		}
		offset += int64(n)
	}

	for _, at := range []int64{0, 1, offset, fileSize - 1} {
		n, err := reader.Read(context.Background(), handle, nil, at)
		if err != nil {
			t.Fatalf("a zero-length read at %d must be a no-op, got %v", at, err)
		}
		if n != 0 {
			t.Fatalf("a zero-length read produced %d bytes", n)
		}
		n, err = reader.Read(context.Background(), handle, make([]byte, 0), at)
		if err != nil || n != 0 {
			t.Fatalf("a zero-length buffer at %d must be a no-op, got %d %v", at, n, err)
		}
	}
}
