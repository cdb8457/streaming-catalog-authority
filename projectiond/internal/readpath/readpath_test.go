package readpath

import (
	"context"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/cache"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/manifest"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/source"
)

const fileSize = int64(20 * 1024 * 1024)

// countingAdapter stands in for a provider. It records exactly which blocks were fetched, which is what every
// amplification assertion here is made against.
type countingAdapter struct {
	mu       sync.Mutex
	fetches  []source.ReadRequest
	requests atomic.Int64
	fail     func(req source.ReadRequest) error
	delay    time.Duration
	// bySource counts fetches per source id, for the failover assertions.
	bySource map[string]int
}

func newCountingAdapter() *countingAdapter {
	return &countingAdapter{bySource: map[string]int{}}
}

func (a *countingAdapter) Kind() string { return "http-range" }
func (a *countingAdapter) Close() error { return nil }
func (a *countingAdapter) Count() int64 { return a.requests.Load() }
func (a *countingAdapter) Fetch(ctx context.Context, req source.ReadRequest, dst []byte) (int, error) {
	if failure := req.Valid(dst); failure != nil {
		return 0, failure
	}
	if a.delay > 0 {
		select {
		case <-time.After(a.delay):
		case <-ctx.Done():
			return 0, source.Fail(source.CondReadDeadline, source.ClassTerminal, "")
		}
	}
	a.requests.Add(1)
	a.mu.Lock()
	a.fetches = append(a.fetches, req)
	a.bySource[req.SourceID]++
	fail := a.fail
	a.mu.Unlock()
	if fail != nil {
		if err := fail(req); err != nil {
			return 0, err
		}
	}
	for i := int64(0); i < req.Length; i++ {
		dst[i] = byte((req.Offset + i) % 251)
	}
	return int(req.Length), nil
}

func (a *countingAdapter) offsets() []int64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]int64, 0, len(a.fetches))
	for _, req := range a.fetches {
		out = append(out, req.Offset)
	}
	return out
}

type staticRouter struct{ adapter source.Adapter }

func (r staticRouter) AdapterFor(source.Locator) (source.Adapter, error) { return r.adapter, nil }

func testEntry(sources ...manifest.Source) *manifest.Entry {
	if len(sources) == 0 {
		sources = []manifest.Source{{SourceID: "src_one", Kind: "http-range", SourceGeneration: 1,
			Locator: manifest.Locator{EndpointID: "fake", ObjectRef: "obj"}}}
	}
	return &manifest.Entry{
		ProjectedEntryID:   "pe_test",
		ProjectedVersionID: "pv_test",
		Path:               "Movies/A/a.mkv",
		SizeBytes:          fileSize,
		Mtime:              time.Unix(1_700_000_000, 0).UTC(),
		Mode:               0o444,
		Inode:              4242,
		Visibility:         "available",
		Sources:            sources,
	}
}

func newReader(t *testing.T, adapter source.Adapter) *Reader {
	t.Helper()
	probe, err := cache.NewProbeCache(t.TempDir(), 64<<20, 4<<20)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := NewReader(DefaultConfig(), staticRouter{adapter}, probe, cache.NewPlaybackCache(32<<20, 8<<20))
	if err != nil {
		t.Fatal(err)
	}
	return reader
}

func TestReadReturnsTheRightBytes(t *testing.T) {
	adapter := newCountingAdapter()
	reader := newReader(t, adapter)
	handle, err := reader.Open(testEntry(), "gen_one")
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Release(handle)

	buf := make([]byte, 4096)
	n, err := reader.Read(context.Background(), handle, buf, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if n != 4096 {
		t.Fatalf("expected 4096 bytes, got %d", n)
	}
	for i := range buf {
		if buf[i] != byte((1000+int64(i))%251) {
			t.Fatalf("byte %d is wrong", i)
		}
	}
}

// A DEGRADED ENTRY IS PRESENT AND COSTS THE PROVIDER NOTHING. This is the rule that keeps an outage from
// looking like a deletion, and it must not be payable in provider requests.
func TestDegradedEntryFailsLocallyWithZeroProviderTraffic(t *testing.T) {
	adapter := newCountingAdapter()
	reader := newReader(t, adapter)
	entry := testEntry()
	entry.Visibility = "degraded"
	handle, err := reader.Open(entry, "gen_one")
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Release(handle)

	for i := 0; i < 50; i++ {
		if _, err := reader.Read(context.Background(), handle, make([]byte, 4096), int64(i)*4096); err == nil {
			t.Fatal("a degraded entry must fail")
		} else if source.AsFailure(err).Cond != source.CondEntryDegraded {
			t.Fatalf("expected the degraded condition, got %v", err)
		}
	}
	if adapter.Count() != 0 {
		t.Fatalf("a degraded entry cost %d provider requests", adapter.Count())
	}
}

// CROSS-OPEN SINGLE-FLIGHT: twenty separate opens reading the same block produce exactly one fetch.
func TestTwentyConcurrentReadsOfOneBlockCostOneFetch(t *testing.T) {
	adapter := newCountingAdapter()
	adapter.delay = 40 * time.Millisecond // hold the flight open long enough for everybody to join
	reader := newReader(t, adapter)

	var wg sync.WaitGroup
	var failures atomic.Int64
	start := make(chan struct{})
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			handle, err := reader.Open(testEntry(), "gen_one")
			if err != nil {
				failures.Add(1)
				return
			}
			defer reader.Release(handle)
			<-start
			if _, err := reader.Read(context.Background(), handle, make([]byte, 4096), 0); err != nil {
				failures.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()

	if failures.Load() != 0 {
		t.Fatalf("%d readers failed", failures.Load())
	}
	if got := adapter.Count(); got != 1 {
		t.Fatalf("twenty identical concurrent reads must cost one fetch, got %d", got)
	}
	if reader.Stats.SingleFlightJoin.Load() == 0 {
		t.Fatal("nobody joined the flight, so the test proved nothing")
	}
}

// REGRESSION: the persistent cache used to cover only offset < 1 MiB, so the middle and tail probes a real
// scanner makes landed in ephemeral chunks that were dropped on release — and a second scan re-fetched them.
func TestSecondScanOfEveryProbeWindowCostsZeroProviderRequests(t *testing.T) {
	adapter := newCountingAdapter()
	reader := newReader(t, adapter)

	// The offsets a metadata pass actually touches: a header, something near the middle, and the tail.
	windows := manifest.ProbeOffsetsFor(fileSize)
	if len(windows) != 3 {
		t.Fatalf("expected three scan windows, got %d", len(windows))
	}
	scan := func() {
		handle, err := reader.Open(testEntry(), "gen_one")
		if err != nil {
			t.Fatal(err)
		}
		for _, window := range windows {
			// A scanner reads a little at each window, not the whole window.
			if _, err := reader.Read(context.Background(), handle, make([]byte, 65536), window.Offset); err != nil {
				t.Fatalf("scan read at %d: %v", window.Offset, err)
			}
		}
		reader.Release(handle)
	}

	scan()
	firstScan := adapter.Count()
	if firstScan != 3 {
		t.Fatalf("a first scan should fetch exactly the three windows, got %d fetches at %v",
			firstScan, adapter.offsets())
	}

	scan()
	if got := adapter.Count(); got != firstScan {
		t.Fatalf("a second scan must cost zero provider requests, got %d more", got-firstScan)
	}
	if reader.Stats.ProbeHits.Load() < 3 {
		t.Fatalf("the second scan did not come from the persistent cache: %d hits", reader.Stats.ProbeHits.Load())
	}
}

// A read inside a scan window fetches THAT WINDOW and nothing more — a 64 KiB header probe must not drag a
// 4 MiB chunk with it, or the byte budget is gone on the first entry.
func TestScanReadFetchesExactlyOneWindow(t *testing.T) {
	adapter := newCountingAdapter()
	reader := newReader(t, adapter)
	handle, _ := reader.Open(testEntry(), "gen_one")
	defer reader.Release(handle)

	if _, err := reader.Read(context.Background(), handle, make([]byte, 65536), 0); err != nil {
		t.Fatal(err)
	}
	adapter.mu.Lock()
	defer adapter.mu.Unlock()
	if len(adapter.fetches) != 1 {
		t.Fatalf("expected one fetch, got %d", len(adapter.fetches))
	}
	if adapter.fetches[0].Length != manifest.ProbeWindowBytes {
		t.Fatalf("a scan read should fetch one probe window, got %d bytes", adapter.fetches[0].Length)
	}
}

// REGRESSION: read-ahead was inert. noteSequential compared the END of this read to the end of the previous
// one, which is never equal for a non-empty read, so the counter never advanced and nothing ever prefetched.
func TestReadAheadStartsOnlyAfterSequentialEvidence(t *testing.T) {
	adapter := newCountingAdapter()
	reader := newReader(t, adapter)
	handle, _ := reader.Open(testEntry(), "gen_one")
	defer reader.Release(handle)

	// Read sequentially past the head window so read-ahead is not suppressed.
	offset := int64(manifest.ProbeWindowBytes)
	for i := 0; i < DefaultConfig().SequentialTriggerReads+1; i++ {
		n, err := reader.Read(context.Background(), handle, make([]byte, 1<<20), offset)
		if err != nil {
			t.Fatal(err)
		}
		offset += int64(n)
	}
	deadline := time.Now().Add(3 * time.Second)
	for reader.Stats.ReadaheadBlocks.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if reader.Stats.ReadaheadBlocks.Load() == 0 {
		t.Fatal("sequential reads must eventually trigger read-ahead")
	}
}

func TestRandomAccessDoesNotTriggerReadAhead(t *testing.T) {
	adapter := newCountingAdapter()
	reader := newReader(t, adapter)
	handle, _ := reader.Open(testEntry(), "gen_one")
	defer reader.Release(handle)

	// Jump around: a transcode probing positions must not prefetch everything it skipped.
	for _, offset := range []int64{5 << 20, 12 << 20, 2 << 20, 15 << 20, 7 << 20} {
		if _, err := reader.Read(context.Background(), handle, make([]byte, 65536), offset); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(200 * time.Millisecond)
	if reader.Stats.ReadaheadBlocks.Load() != 0 {
		t.Fatalf("random access triggered %d read-ahead blocks", reader.Stats.ReadaheadBlocks.Load())
	}
}

// REGRESSION: release closed a channel but did not cancel or wait for an in-flight prefetch, so a goroutine
// and its provider request could outlive the handle.
func TestReleaseStopsEveryPrefetchGoroutine(t *testing.T) {
	before := runtime.NumGoroutine()
	adapter := newCountingAdapter()
	adapter.delay = 30 * time.Millisecond
	reader := newReader(t, adapter)

	for round := 0; round < 10; round++ {
		handle, _ := reader.Open(testEntry(), "gen_one")
		offset := int64(manifest.ProbeWindowBytes)
		for i := 0; i < 5; i++ {
			n, err := reader.Read(context.Background(), handle, make([]byte, 1<<20), offset)
			if err != nil {
				t.Fatal(err)
			}
			offset += int64(n)
		}
		reader.Release(handle)
	}
	// Release waits for the prefetch goroutine, so there is nothing to settle.
	after := runtime.NumGoroutine()
	if after > before+2 {
		t.Fatalf("prefetch goroutines survived release: %d before, %d after", before, after)
	}
}

// A handle may fail over ONLY between sources carrying identical byte-identity proof.
func TestFailoverOnlyBetweenProvenIdenticalSources(t *testing.T) {
	identity := &manifest.ByteIdentity{
		SizeBytes: fileSize, ProbeWindowBytes: manifest.ProbeWindowBytes,
		Probes: []manifest.ProbeDigest{{Position: "head", Offset: 0, Length: manifest.ProbeWindowBytes, SHA256: "aa"}},
	}
	different := &manifest.ByteIdentity{
		SizeBytes: fileSize, ProbeWindowBytes: manifest.ProbeWindowBytes,
		Probes: []manifest.ProbeDigest{{Position: "head", Offset: 0, Length: manifest.ProbeWindowBytes, SHA256: "bb"}},
	}

	t.Run("proven identical mirror is used", func(t *testing.T) {
		adapter := newCountingAdapter()
		adapter.fail = func(req source.ReadRequest) error {
			if req.SourceID == "src_primary" {
				return source.Fail(source.CondSourceRefUnknown, source.ClassTerminal, "")
			}
			return nil
		}
		reader := newReader(t, adapter)
		entry := testEntry(
			manifest.Source{SourceID: "src_primary", Kind: "http-range", SourceGeneration: 1, ByteIdentity: identity},
			manifest.Source{SourceID: "src_mirror", Kind: "http-range", SourceGeneration: 1, ByteIdentity: identity},
		)
		handle, _ := reader.Open(entry, "gen_one")
		defer reader.Release(handle)

		if _, err := reader.Read(context.Background(), handle, make([]byte, 4096), 0); err != nil {
			t.Fatalf("a proven-identical mirror should have served the read: %v", err)
		}
		adapter.mu.Lock()
		mirrorFetches := adapter.bySource["src_mirror"]
		adapter.mu.Unlock()
		if mirrorFetches == 0 {
			t.Fatal("the mirror was never tried")
		}
		if reader.Stats.Failovers.Load() == 0 {
			t.Fatal("the failover was not recorded")
		}
		// The handle's identity does not move with it.
		if handle.Inode != 4242 || handle.SizeBytes != fileSize {
			t.Fatal("a failover changed the handle's identity")
		}
	})

	t.Run("unproven source is never used", func(t *testing.T) {
		adapter := newCountingAdapter()
		adapter.fail = func(req source.ReadRequest) error {
			if req.SourceID == "src_primary" {
				return source.Fail(source.CondSourceRefUnknown, source.ClassTerminal, "")
			}
			return nil
		}
		reader := newReader(t, adapter)
		entry := testEntry(
			manifest.Source{SourceID: "src_primary", Kind: "http-range", SourceGeneration: 1, ByteIdentity: identity},
			manifest.Source{SourceID: "src_other", Kind: "http-range", SourceGeneration: 1, ByteIdentity: different},
		)
		handle, _ := reader.Open(entry, "gen_one")
		defer reader.Release(handle)

		if _, err := reader.Read(context.Background(), handle, make([]byte, 4096), 0); err == nil {
			t.Fatal("a read must fail rather than move to a source nobody proved identical")
		}
		adapter.mu.Lock()
		otherFetches := adapter.bySource["src_other"]
		adapter.mu.Unlock()
		if otherFetches != 0 {
			t.Fatalf("an unproven source was contacted %d times", otherFetches)
		}
	})
}

func TestRetryableFailuresAreBoundedAndTerminalOnesAreNot(t *testing.T) {
	adapter := newCountingAdapter()
	adapter.fail = func(source.ReadRequest) error {
		return source.Fail(source.CondSourceUnreachable, source.ClassRetryable, "")
	}
	cfg := DefaultConfig()
	cfg.BackoffInitial = time.Millisecond
	cfg.BackoffMax = 2 * time.Millisecond
	probe, err := cache.NewProbeCache(t.TempDir(), 1<<20, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := NewReader(cfg, staticRouter{adapter}, probe, cache.NewPlaybackCache(1<<20, 1<<20))
	if err != nil {
		t.Fatal(err)
	}
	handle, _ := reader.Open(testEntry(), "gen_one")
	defer reader.Release(handle)

	if _, err := reader.Read(context.Background(), handle, make([]byte, 4096), 0); err == nil {
		t.Fatal("expected the read to fail")
	}
	if got := adapter.Count(); got != int64(cfg.MaxAttempts) {
		t.Fatalf("a retryable failure should be attempted %d times, got %d", cfg.MaxAttempts, got)
	}
}

func TestNegativeOffsetAndBadConfigAreRefusedWithoutPanicking(t *testing.T) {
	adapter := newCountingAdapter()
	reader := newReader(t, adapter)
	handle, _ := reader.Open(testEntry(), "gen_one")
	defer reader.Release(handle)

	if _, err := reader.Read(context.Background(), handle, make([]byte, 16), -1); err == nil {
		t.Fatal("a negative offset must be refused")
	}
	if _, err := reader.Read(context.Background(), handle, make([]byte, 16), fileSize+1); err == nil {
		t.Fatal("a read past EOF must report EOF")
	}

	for _, bad := range []func(*Config){
		func(c *Config) { c.ChunkBytes = 0 },
		func(c *Config) { c.ProbeWindowBytes = 0 },
		func(c *Config) { c.ReadDeadline = 0 },
		func(c *Config) { c.MaxAttempts = 0 },
		func(c *Config) { c.SequentialTriggerReads = 0 },
		func(c *Config) { c.BackoffMultiplier = 0 },
	} {
		cfg := DefaultConfig()
		bad(&cfg)
		if err := cfg.Validate(); err == nil {
			t.Fatal("an unusable configuration must be refused at construction")
		}
	}
}

// The block planner must never produce a zero or negative length, whatever offset it is asked about.
func TestBlockPlannerIsTotal(t *testing.T) {
	adapter := newCountingAdapter()
	reader := newReader(t, adapter)
	for _, size := range []int64{1, 1023, manifest.ProbeWindowBytes, manifest.SingleProbeBelowByte,
		manifest.SingleProbeBelowByte + 1, fileSize, 1 << 33} {
		for offset := int64(0); offset < size; offset += size/97 + 1 {
			b := reader.blockFor(offset, size)
			if b.length <= 0 {
				t.Fatalf("size=%d offset=%d produced a non-positive block length %d", size, offset, b.length)
			}
			if b.offset > offset || b.offset+b.length <= offset {
				t.Fatalf("size=%d offset=%d produced a block that does not contain it: %+v", size, offset, b)
			}
			if b.offset+b.length > size {
				t.Fatalf("size=%d offset=%d produced a block past EOF: %+v", size, offset, b)
			}
		}
	}
}
