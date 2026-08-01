package readpath

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/cache"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/contract"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/fakeprovider"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/manifest"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/source"
)

// The amplification harness.
//
// WHAT IT MEASURES, AND WHAT IT DOES NOT. This is a SYNTHETIC scanner: it reads a small window at each of the
// three fixed probe offsets of every entry, which is the access pattern this contract has chosen to support.
// It is NOT a real media server's metadata pass, and no number it produces is evidence about one. That is a
// later gate on a real host; until it runs, the honest claim is that the daemon holds these budgets against a
// defined synthetic probe plan.
//
// THE DENOMINATORS ARE EXPLICIT. "Requests per entry" is meaningless without saying which requests, so each
// budget below names exactly what it counts:
//   - RANGE requests, against (entries x scan windows)
//   - RESOLUTION requests, against entries
//   - BYTES, against (probe window x scan windows x entries)

const amplificationEntries = 50
const amplificationSize = int64(12 * 1024 * 1024) // > 3 MiB, so the full three-window probe plan applies

type endpointRouter struct{ adapter source.Adapter }

func (r endpointRouter) AdapterFor(source.Locator) (source.Adapter, error) { return r.adapter, nil }

func amplificationEntry(index int) *manifest.Entry {
	ref := fmt.Sprintf("obj-%03d", index)
	path := fmt.Sprintf("Movies/Title %03d/Title %03d.mkv", index, index)
	sum := sha256.Sum256([]byte("amplification:" + path))
	version := "pv_" + hex.EncodeToString(sum[:])
	return &manifest.Entry{
		ProjectedEntryID:   "pe_" + hex.EncodeToString(sum[:]),
		ProjectedVersionID: version,
		Path:               path,
		SizeBytes:          amplificationSize,
		Mtime:              time.Unix(1_700_000_000, 0).UTC(),
		Mode:               0o444,
		Inode:              manifest.DeriveInode(version),
		Visibility:         "available",
		Sources: []manifest.Source{{
			SourceID:         "src_" + hex.EncodeToString(sum[:16]),
			Kind:             "http-range",
			SourceGeneration: 1,
			Locator:          manifest.Locator{EndpointID: "fake", ObjectRef: ref},
		}},
	}
}

// TestFiftyEntryScanHoldsItsAmplificationBudgets is the Phase 1 amplification gate.
func TestFiftyEntryScanHoldsItsAmplificationBudgets(t *testing.T) {
	budgets := contract.Load().Runtime.Phase1Budgets
	windows := int64(budgets.ScanWindowsPerEntry)
	if windows <= 0 {
		t.Fatal("the contract does not say how many scan windows an entry has")
	}

	server, err := fakeprovider.New(fakeprovider.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	entries := make([]*manifest.Entry, 0, amplificationEntries)
	for i := 0; i < amplificationEntries; i++ {
		server.AddObject(fmt.Sprintf("obj-%03d", i), amplificationSize)
		entries = append(entries, amplificationEntry(i))
	}

	limiter := source.NewLimiter(8, 4, 5*time.Second)
	adapter, err := source.NewHTTPRangeAdapter(source.EndpointConfig{
		ID: "fake", ResolverURL: server.ResolveURL(), AllowedOrigins: []string{server.BaseURL()},
		AllowInsecureHTTP: true, AllowPrivateAddresses: true, MaxConnections: 4,
		RequestTimeout: 10 * time.Second, RefreshCooldown: 30 * time.Second,
	}, nil, source.NewBreaker(50, time.Minute, time.Minute, 1), limiter)
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.Close()

	probeDir := t.TempDir()
	probe, err := cache.NewProbeCache(probeDir, 512<<20, 4<<20)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := NewReader(DefaultConfig(), endpointRouter{adapter}, probe, cache.NewPlaybackCache(64<<20, 8<<20))
	if err != nil {
		t.Fatal(err)
	}

	// One "scan": for every entry, open, read a little at each fixed window, close. Four at a time, which is
	// roughly what a media server's scanner does.
	scan := func() {
		var wg sync.WaitGroup
		var failures atomic.Int64
		gate := make(chan struct{}, 4)
		for _, entry := range entries {
			wg.Add(1)
			go func(entry *manifest.Entry) {
				defer wg.Done()
				gate <- struct{}{}
				defer func() { <-gate }()
				handle, err := reader.Open(entry, "gen_one")
				if err != nil {
					failures.Add(1)
					return
				}
				defer reader.Release(handle)
				for _, window := range manifest.ProbeOffsetsFor(entry.SizeBytes) {
					if _, err := reader.Read(context.Background(), handle, make([]byte, 65536), window.Offset); err != nil {
						failures.Add(1)
						return
					}
				}
			}(entry)
		}
		wg.Wait()
		if failures.Load() != 0 {
			t.Fatalf("%d entries failed to scan", failures.Load())
		}
	}

	scan()

	counters := server.Counters()
	rangeRequests := counters.RangeRequests.Load()
	resolutions := counters.Resolutions.Load()
	bytesServed := counters.BytesServed.Load()
	served429 := counters.Served429.Load()
	peakConcurrent := counters.PeakConcurrent.Load()
	peakConns := counters.PeakConns.Load()
	globalPeak, endpointPeak := limiter.Peak("fake")

	// The evidence goes into the gate output, so a run is readable without re-deriving it.
	t.Logf("FIRST SCAN over %d entries of %d bytes:", amplificationEntries, amplificationSize)
	t.Logf("  range requests      %d  (budget %.1f x entries x windows = %.0f)",
		rangeRequests, budgets.MaxRangeRequestMultiplier,
		budgets.MaxRangeRequestMultiplier*float64(amplificationEntries*int(windows)))
	t.Logf("  resolution requests %d  (budget %.1f x entries = %.0f)",
		resolutions, budgets.MaxResolutionRequestMultiplier,
		budgets.MaxResolutionRequestMultiplier*float64(amplificationEntries))
	t.Logf("  bytes served        %d  (budget %.1f x window x windows x entries = %.0f)",
		bytesServed, budgets.MaxByteMultiplier,
		budgets.MaxByteMultiplier*float64(manifest.ProbeWindowBytes*windows*amplificationEntries))
	t.Logf("  429 responses       %d  (budget %d)", served429, budgets.MaxHTTP429)
	t.Logf("  peak concurrent     %d requests, %d connections (endpoint cap 4)", peakConcurrent, peakConns)
	t.Logf("  limiter peak        %d global, %d per endpoint (caps 8 / 4)", globalPeak, endpointPeak)

	maxRange := int64(budgets.MaxRangeRequestMultiplier * float64(amplificationEntries) * float64(windows))
	if rangeRequests > maxRange {
		t.Fatalf("range requests %d exceed the budget of %d", rangeRequests, maxRange)
	}
	maxResolutions := int64(budgets.MaxResolutionRequestMultiplier * float64(amplificationEntries))
	if resolutions > maxResolutions {
		t.Fatalf("resolution requests %d exceed the budget of %d", resolutions, maxResolutions)
	}
	maxBytes := int64(budgets.MaxByteMultiplier * float64(manifest.ProbeWindowBytes*windows*amplificationEntries))
	if bytesServed > maxBytes {
		t.Fatalf("bytes served %d exceed the budget of %d", bytesServed, maxBytes)
	}
	if served429 > int64(budgets.MaxHTTP429) {
		t.Fatalf("the endpoint rate limited a correctly bounded client %d times", served429)
	}
	if peakConcurrent > 4 || endpointPeak > 4 || globalPeak > 8 {
		t.Fatalf("a concurrency cap was exceeded: peak=%d endpoint=%d global=%d",
			peakConcurrent, endpointPeak, globalPeak)
	}

	// SECOND SCAN. Everything a metadata pass reads is in the persistent scan-window cache, so it must cost
	// nothing at all — no range request and no resolution.
	scan()
	t.Logf("SECOND SCAN: %d further range requests, %d further resolutions",
		counters.RangeRequests.Load()-rangeRequests, counters.Resolutions.Load()-resolutions)
	if extra := counters.RangeRequests.Load() - rangeRequests; extra > 0 {
		t.Fatalf("a re-scan cost %d range requests; the budget is zero", extra)
	}
	if extra := counters.Resolutions.Load() - resolutions; extra > 0 {
		t.Fatalf("a re-scan cost %d resolutions; the budget is zero", extra)
	}

	// ...and it survives a restart, which is what "persistent" has to mean.
	reopened, err := cache.NewProbeCache(probeDir, 512<<20, 4<<20)
	if err != nil {
		t.Fatal(err)
	}
	restarted, err := NewReader(DefaultConfig(), endpointRouter{adapter}, reopened, cache.NewPlaybackCache(64<<20, 8<<20))
	if err != nil {
		t.Fatal(err)
	}
	before := counters.RangeRequests.Load()
	for _, entry := range entries[:5] {
		handle, err := restarted.Open(entry, "gen_one")
		if err != nil {
			t.Fatal(err)
		}
		for _, window := range manifest.ProbeOffsetsFor(entry.SizeBytes) {
			if _, err := restarted.Read(context.Background(), handle, make([]byte, 65536), window.Offset); err != nil {
				t.Fatalf("post-restart read: %v", err)
			}
		}
		restarted.Release(handle)
	}
	t.Logf("AFTER RESTART: %d further range requests for 5 entries", counters.RangeRequests.Load()-before)
	if extra := counters.RangeRequests.Load() - before; extra > 0 {
		t.Fatalf("the scan cache did not survive a restart: %d range requests", extra)
	}
}

// The budget arithmetic has to be satisfiable by the implementation it governs. A per-entry request budget of
// 1.2 against an implementation that necessarily makes one request per scan WINDOW is a gate that can never
// pass, and stating it would be worse than having none.
func TestAmplificationBudgetsAreArithmeticallyReachable(t *testing.T) {
	budgets := contract.Load().Runtime.Phase1Budgets
	windows := budgets.ScanWindowsPerEntry
	if windows != len(manifest.ProbeOffsetsFor(amplificationSize)) {
		t.Fatalf("the contract says %d scan windows, the probe plan produces %d",
			windows, len(manifest.ProbeOffsetsFor(amplificationSize)))
	}
	// One range request per window per entry is the floor for a first scan.
	floor := float64(amplificationEntries * windows)
	allowed := budgets.MaxRangeRequestMultiplier * float64(amplificationEntries) * float64(windows)
	if allowed < floor {
		t.Fatalf("the range-request budget (%.0f) is below the arithmetic floor (%.0f)", allowed, floor)
	}
	// One resolution per entry is the floor, since each entry has its own source identity.
	if budgets.MaxResolutionRequestMultiplier < 1 {
		t.Fatalf("the resolution budget %.2f is below one per entry", budgets.MaxResolutionRequestMultiplier)
	}
	if budgets.MaxByteMultiplier < 1 {
		t.Fatalf("the byte budget %.2f is below the bytes a scan must actually read", budgets.MaxByteMultiplier)
	}
	_ = strconv.Itoa(windows)
}
