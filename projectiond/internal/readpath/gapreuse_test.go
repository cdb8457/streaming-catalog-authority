package readpath

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/cache"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/fakeprovider"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/manifest"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/source"
)

// gate9's SOAK OBJECT, at its real length. Everything below is derived from it rather than chosen.
const gapReuseSize = 8_594_275

func gapReuseEntry() *manifest.Entry {
	sum := sha256.Sum256([]byte("gap-reuse"))
	version := "pv_" + hex.EncodeToString(sum[:])
	return &manifest.Entry{
		ProjectedEntryID:   "pe_" + hex.EncodeToString(sum[:]),
		ProjectedVersionID: version,
		Path:               "Movies/Soak/Soak.mkv",
		SizeBytes:          gapReuseSize,
		Mtime:              time.Unix(1_700_000_000, 0).UTC(),
		Mode:               0o444,
		Inode:              manifest.DeriveInode(version),
		Visibility:         "available",
		Sources: []manifest.Source{{
			SourceID: "src_" + hex.EncodeToString(sum[:16]), Kind: "http-range", SourceGeneration: 1,
			Locator: manifest.Locator{EndpointID: "fake", ObjectRef: "obj-soak"},
		}},
	}
}

// TestSequentialOpensRefetchTheSameGapThroughTheRealReader IS THE EVIDENCE, TAKEN THROUGH THE REAL PATH.
//
// WHY THE CACHE-LEVEL TEST WAS NOT ENOUGH, AND IT WAS MINE. It handed PlaybackCache the same key thirteen
// times and then reported that the key was stable — which it had assumed. It proved the summariser and
// nothing about the daemon. The question is whether the READER's own block plan produces a stable key and
// whether RELEASE is what destroys it, and only Open/Read/Release can answer that.
//
// WHAT THIS DRIVES: sequential opens of one object, each reading a byte inside the head-to-middle gap, each
// released before the next — the shape of a scan followed by an analyse pass, which is what Plex does.
//
// WHAT IT ASSERTS: that every open fetched the SAME (offset, length) from the provider, that the provider
// therefore served the gap once per open, and that the diagnostic shows miss → put → drop-handle repeating
// with one geometry rather than a changing one.
func TestSequentialOpensRefetchTheSameGapThroughTheRealReader(t *testing.T) {
	t.Setenv("PROJECTIOND_CACHE_DIAGNOSTIC", "1")

	server, err := fakeprovider.New(fakeprovider.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	server.AddObject("obj-soak", gapReuseSize)

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

	probe, err := cache.NewProbeCache(t.TempDir(), 512<<20, 4<<20)
	if err != nil {
		t.Fatal(err)
	}
	playback := cache.NewPlaybackCache(64<<20, 8<<20)
	reader, err := NewReader(DefaultConfig(), endpointRouter{adapter}, probe, playback)
	if err != nil {
		t.Fatal(err)
	}
	if !playback.DiagnosticEnabled() {
		t.Fatal("the cache diagnostic did not turn on")
	}

	// THE GAP THE DAEMON'S OWN PLAN PRODUCES, computed the way the reader computes it rather than asserted.
	windows := manifest.ProbeOffsetsFor(gapReuseSize)
	if len(windows) != 3 {
		t.Fatalf("this object should have a three-window probe plan, got %d", len(windows))
	}
	gapStart := windows[0].Offset + windows[0].Length
	gapEnd := windows[1].Offset
	readAt := gapStart + (gapEnd-gapStart)/2

	entry := gapReuseEntry()
	const opens = 4
	before := server.Snapshot()
	for open := 0; open < opens; open++ {
		handle, err := reader.Open(entry, "gen_one")
		if err != nil {
			t.Fatalf("open %d: %v", open, err)
		}
		one := make([]byte, 1)
		if _, err := reader.Read(context.Background(), handle, one, readAt); err != nil {
			t.Fatalf("read %d: %v", open, err)
		}
		reader.Release(handle)
	}
	after := server.Snapshot()

	// WHAT THE PROVIDER ACTUALLY SAW.
	fetched := after.BytesServed - before.BytesServed
	requests := after.RangeRequests - before.RangeRequests
	t.Logf("EVIDENCE: %d sequential opens, one byte read inside the gap each time", opens)
	t.Logf("EVIDENCE: provider served %d bytes over %d ranged requests", fetched, requests)
	t.Logf("EVIDENCE: object is %d bytes; the gap is [%d,%d) = %d bytes",
		gapReuseSize, gapStart, gapEnd, gapEnd-gapStart)

	events, dropped := playback.DiagnosticEvents()
	if dropped != 0 {
		t.Fatalf("the diagnostic ring dropped %d events; this window should fit", dropped)
	}
	var misses, puts, drops int
	geometry := map[[2]int64]int{}
	handles := map[uint64]bool{}
	for _, event := range events {
		switch event.Kind {
		case cache.EventMiss:
			misses++
			geometry[[2]int64{event.Offset, event.Length}]++
			handles[event.Handle] = true
		case cache.EventPut:
			puts++
		case cache.EventDrop:
			drops++
		}
	}
	t.Logf("EVIDENCE: %d misses, %d puts, %d handle releases across %d distinct requesting handles",
		misses, puts, drops, len(handles))
	for block, count := range geometry {
		t.Logf("EVIDENCE: block offset=%d length=%d was MISSED %d times", block[0], block[1], count)
	}

	// THE DECISIVE PROPERTIES, AS EQUALITIES. Inequalities would let a retry, a prefetch or any unrelated
	// traffic satisfy this while the sequence it claims to show never happened.
	gapLength := gapEnd - gapStart
	if len(geometry) != 1 {
		t.Fatalf("the misses carry %d distinct geometries, so the block plan is MOVING and the finding is "+
			"geometry rather than cache lifetime: %v", len(geometry), geometry)
	}
	if geometry[[2]int64{gapStart, gapLength}] != opens {
		t.Fatalf("the sole missed block must be offset=%d length=%d, missed exactly %d times: got %v",
			gapStart, gapLength, opens, geometry)
	}
	if misses != opens || puts != opens || drops != opens {
		t.Fatalf("exactly one miss, one put and one release per open: got %d/%d/%d for %d opens",
			misses, puts, drops, opens)
	}
	if len(handles) != opens {
		t.Fatalf("each open must appear as its own requesting handle, got %d for %d opens",
			len(handles), opens)
	}
	if requests != int64(opens) {
		t.Fatalf("the provider must be asked exactly once per open, got %d", requests)
	}
	if fetched != int64(opens)*gapLength {
		t.Fatalf("the provider must serve the gap exactly once per open: want %d bytes, got %d",
			int64(opens)*gapLength, fetched)
	}

	// AND THE ORDER, PER HANDLE: miss(gap) -> put(gap) -> drop, with the release landing BEFORE the next
	// handle asks. Totals alone cannot show that release is what sits between two misses of a stable key.
	type step struct {
		kind   cache.EventKind
		handle uint64
		block  [2]int64
	}
	sequence := make([]step, 0, len(events))
	for _, event := range events {
		switch event.Kind {
		case cache.EventMiss, cache.EventPut, cache.EventDrop:
			sequence = append(sequence, step{event.Kind, event.Handle, [2]int64{event.Offset, event.Length}})
		}
	}
	if len(sequence) != opens*3 {
		t.Fatalf("expected %d ordered events (miss, put, drop per open), got %d: %v",
			opens*3, len(sequence), sequence)
	}
	wantBlock := [2]int64{gapStart, gapLength}
	for open := 0; open < opens; open++ {
		miss, put, drop := sequence[open*3], sequence[open*3+1], sequence[open*3+2]
		if miss.kind != cache.EventMiss || miss.block != wantBlock {
			t.Fatalf("open %d must begin with a miss of the gap, got %+v", open, miss)
		}
		if put.kind != cache.EventPut || put.block != wantBlock || put.handle != miss.handle {
			t.Fatalf("open %d must then cache that same block under the same handle, got %+v", open, put)
		}
		if drop.kind != cache.EventDrop || drop.handle != miss.handle {
			t.Fatalf("open %d must release its own handle before the next open, got %+v", open, drop)
		}
		if open > 0 && sequence[open*3-1].kind != cache.EventDrop {
			t.Fatalf("open %d asked again before the previous release: %+v", open, sequence[open*3-1])
		}
	}
}
