package readpath

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sync"
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

// TestSequentialOpensReuseTheSameGapThroughTheRealReader IS THE EVIDENCE, TAKEN THROUGH THE REAL PATH.
//
// WHY THE CACHE-LEVEL TEST WAS NOT ENOUGH, AND IT WAS MINE. It handed PlaybackCache the same key thirteen
// times and then reported that the key was stable — which it had assumed. It proved the summariser and
// nothing about the daemon. The question is whether the READER's own block plan produces a stable key and
// whether RELEASE is what destroys it, and only Open/Read/Release can answer that.
//
// WHAT IT MEASURED BEFORE THE REPAIR. Four sequential opens, each reading one byte inside the head-to-middle
// gap and releasing before the next: four misses of the identical block — offset 1,048,576, length 2,724,273
// — four puts, four releases, four provider requests, 4 x 2,724,273 bytes. One geometry, so the block plan
// was never moving; the entry simply did not outlive the handle that cached it.
//
// WHAT IT ASSERTS NOW, AS EQUALITIES. The same four opens compute the same block, and the provider is asked
// for it EXACTLY ONCE: one miss and one put on the first open, a hit on each of the other three, a release
// after every one, still one geometry, and zero refetches after release. Inequalities would let a retry, a
// prefetch or any unrelated traffic satisfy this while the sequence it claims to show never happened.
//
// AND THE RETENTION IS PROCESS-SCOPED. A fresh playback cache — what a restart is — fetches the gap again.
func TestSequentialOpensReuseTheSameGapThroughTheRealReader(t *testing.T) {
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
	handleIDs := make([]uint64, 0, opens)
	for open := 0; open < opens; open++ {
		handle, err := reader.Open(entry, "gen_one")
		if err != nil {
			t.Fatalf("open %d: %v", open, err)
		}
		handleIDs = append(handleIDs, handle.ID)
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
	var misses, hits, puts, drops int
	geometry := map[[2]int64]int{}
	handles := map[uint64]bool{}
	for _, event := range events {
		switch event.Kind {
		case cache.EventMiss:
			misses++
			geometry[[2]int64{event.Offset, event.Length}]++
			handles[event.Handle] = true
		case cache.EventHit:
			hits++
			geometry[[2]int64{event.Offset, event.Length}]++
			handles[event.Handle] = true
		case cache.EventPut:
			puts++
		case cache.EventDrop:
			drops++
		case cache.EventEvict:
			t.Fatalf("nothing should have been evicted here: %+v", event)
		}
	}
	t.Logf("EVIDENCE: %d misses, %d hits, %d puts, %d handle releases across %d distinct requesting handles",
		misses, hits, puts, drops, len(handles))
	for block, count := range geometry {
		t.Logf("EVIDENCE: block offset=%d length=%d was LOOKED UP %d times", block[0], block[1], count)
	}

	// THE DECISIVE PROPERTIES, AS EQUALITIES.
	gapLength := gapEnd - gapStart
	if len(geometry) != 1 {
		t.Fatalf("the lookups carry %d distinct geometries, so the block plan is MOVING and the finding "+
			"would be geometry rather than cache lifetime: %v", len(geometry), geometry)
	}
	if geometry[[2]int64{gapStart, gapLength}] != opens {
		t.Fatalf("the sole block must be offset=%d length=%d, looked up exactly %d times: got %v",
			gapStart, gapLength, opens, geometry)
	}
	if misses != 1 || puts != 1 {
		t.Fatalf("exactly one open may miss and cache the gap: got %d misses and %d puts", misses, puts)
	}
	if hits != opens-1 {
		t.Fatalf("every later open must reuse it: want %d hits, got %d", opens-1, hits)
	}
	if drops != opens {
		t.Fatalf("every open must still release its handle: got %d for %d opens", drops, opens)
	}
	if len(handles) != opens {
		t.Fatalf("each open must appear as its own requesting handle, got %d for %d opens",
			len(handles), opens)
	}
	if requests != 1 {
		t.Fatalf("the provider must be asked exactly once for all %d opens, got %d", opens, requests)
	}
	if fetched != gapLength {
		t.Fatalf("the provider must serve the gap exactly once: want %d bytes, got %d", gapLength, fetched)
	}
	if got := reader.Stats.PlaybackHits.Load(); got != int64(opens-1) {
		t.Fatalf("the reader must count %d playback hits, got %d", opens-1, got)
	}
	if got := reader.Stats.BlockFetches.Load(); got != 1 {
		t.Fatalf("exactly one block fetch reached a source, got %d", got)
	}

	// THE SUMMARISER, ON ITS OWN QUESTION. Zero refetches after release is the repair; zero after eviction
	// says nothing here was reclaimed for capacity either, so the zero above is not an eviction in disguise.
	summary := playback.Summarise()
	if summary.RefetchesAfterRelease != 0 {
		t.Fatalf("a release still costs a refetch of a stable key: %d of them", summary.RefetchesAfterRelease)
	}
	if summary.RefetchesAfterEviction != 0 {
		t.Fatalf("nothing should have been evicted: %d refetches after eviction",
			summary.RefetchesAfterEviction)
	}

	// AND THE BYTES ARE HELD ONCE, OWNED BY NOBODY. Every handle is gone; the entry is not.
	if got := playback.TotalBytes(); got != gapLength {
		t.Fatalf("the cache should hold exactly one %d-byte block, it holds %d", gapLength, got)
	}
	for open, id := range handleIDs {
		if got := playback.HandleBytes(id); got != 0 {
			t.Fatalf("released handle %d (open %d) is still charged %d bytes", id, open, got)
		}
	}

	// AND THE ORDER, PER HANDLE: miss(gap) -> put(gap) -> drop for the first open, then hit(gap) -> drop for
	// each later one, with the release landing BEFORE the next handle asks. Totals alone cannot show that a
	// release is what sits between two lookups of a stable key.
	type step struct {
		kind   cache.EventKind
		handle uint64
		block  [2]int64
	}
	sequence := make([]step, 0, len(events))
	for _, event := range events {
		switch event.Kind {
		case cache.EventMiss, cache.EventHit, cache.EventPut, cache.EventDrop:
			sequence = append(sequence, step{event.Kind, event.Handle, [2]int64{event.Offset, event.Length}})
		}
	}
	wantBlock := [2]int64{gapStart, gapLength}
	if len(sequence) != 3+(opens-1)*2 {
		t.Fatalf("expected %d ordered events (miss, put, drop then hit, drop per later open), got %d: %v",
			3+(opens-1)*2, len(sequence), sequence)
	}
	if sequence[0].kind != cache.EventMiss || sequence[0].block != wantBlock {
		t.Fatalf("the first open must begin with a miss of the gap, got %+v", sequence[0])
	}
	if sequence[1].kind != cache.EventPut || sequence[1].block != wantBlock ||
		sequence[1].handle != sequence[0].handle {
		t.Fatalf("the first open must then cache that block under its own handle, got %+v", sequence[1])
	}
	if sequence[2].kind != cache.EventDrop || sequence[2].handle != sequence[0].handle {
		t.Fatalf("the first open must release its own handle, got %+v", sequence[2])
	}
	for open := 1; open < opens; open++ {
		hit, drop := sequence[3+(open-1)*2], sequence[3+(open-1)*2+1]
		if hit.kind != cache.EventHit || hit.block != wantBlock {
			t.Fatalf("open %d must hit the retained gap, got %+v", open, hit)
		}
		if hit.handle == sequence[0].handle {
			t.Fatalf("open %d reused the first open's handle id, so this proves nothing about reuse "+
				"across handles: %+v", open, hit)
		}
		if drop.kind != cache.EventDrop || drop.handle != hit.handle {
			t.Fatalf("open %d must release its own handle before the next open, got %+v", open, drop)
		}
	}

	// A RESTART IS A NEW CACHE. The retention is memory-resident and process-scoped; nothing about it is
	// persistence, and the gap is not a scan window, so a fresh cache must pay for it again.
	restartBefore := server.Snapshot()
	restarted, err := NewReader(DefaultConfig(), endpointRouter{adapter}, probe,
		cache.NewPlaybackCache(64<<20, 8<<20))
	if err != nil {
		t.Fatal(err)
	}
	handle, err := restarted.Open(entry, "gen_one")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.Read(context.Background(), handle, make([]byte, 1), readAt); err != nil {
		t.Fatalf("post-restart read: %v", err)
	}
	restarted.Release(handle)
	restartAfter := server.Snapshot()
	if got := restartAfter.RangeRequests - restartBefore.RangeRequests; got != 1 {
		t.Fatalf("a restarted daemon must fetch the gap again exactly once, got %d requests", got)
	}
	if got := restartAfter.BytesServed - restartBefore.BytesServed; got != gapLength {
		t.Fatalf("and serve exactly the gap: want %d bytes, got %d", gapLength, got)
	}
}

// TestAClosedHandleAdmitsNothingToThePlaybackCache.
//
// The rule survives the repair, and its reason changed. It is no longer that playback entries die with their
// handle — they do not. It is that a playback put is an ADMISSION charged to a handle's ceiling: charging one
// to a handle that has already been released would leave a ledger row nothing will ever discharge, and a
// ceiling that only ever fills is a cache that eventually refuses everything.
//
// The seam pauses on the fetch goroutine after the transport produced bytes and before they are published,
// which is the only window in which a handle can be released while a publish for it is still to come.
func TestAClosedHandleAdmitsNothingToThePlaybackCache(t *testing.T) {
	adapter := newCountingAdapter()
	probe, err := cache.NewProbeCache(t.TempDir(), 64<<20, 4<<20)
	if err != nil {
		t.Fatal(err)
	}
	playback := cache.NewPlaybackCache(32<<20, 8<<20)
	reader, err := NewReader(DefaultConfig(), staticRouter{adapter}, probe, playback)
	if err != nil {
		t.Fatal(err)
	}

	handle, err := reader.Open(testEntry(), "gen_one")
	if err != nil {
		t.Fatal(err)
	}
	released := make(chan struct{})
	var once sync.Once
	reader.onFetchComplete = func() {
		once.Do(func() {
			reader.Release(handle)
			close(released)
		})
	}

	// A NON-PERSISTENT BLOCK: past the head scan window, so the playback cache is the one that would take it.
	windows := manifest.ProbeOffsetsFor(fileSize)
	offset := windows[0].Offset + windows[0].Length + 4096
	got, err := reader.Read(context.Background(), handle, make([]byte, 4096), offset)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if got != 4096 {
		t.Fatalf("the read must still return its bytes to the caller, got %d", got)
	}
	<-released

	if total := playback.TotalBytes(); total != 0 {
		t.Fatalf("a released handle admitted %d bytes to the playback cache", total)
	}
	if charged := playback.HandleBytes(handle.ID); charged != 0 {
		t.Fatalf("a released handle was left holding an admission of %d bytes that nothing will discharge",
			charged)
	}
}

// TestAReleaseCannotSlipBetweenThePublishCheckAndTheAdmission.
//
// THE DEFECT THIS CLOSES, AND THE TEST ABOVE COULD NOT SEE IT. `publish` tested h.closed and then called Put
// with nothing held, and the closed-handle test releases on the publishing goroutine itself — so it proves the
// test exists and can never exercise the interval between the test and the admission. A demand read already
// past the check could be descheduled there. Release waits on the PREFETCH goroutine and never on a demand
// read, so it would close the handle, discharge it, and return; the late Put would then charge a handle that
// no longer exists, leaving an admission row nothing discharges. That row is permanent: it counts against a
// per-handle ceiling belonging to nobody, and it is exactly how a cache stops admitting.
//
// IT IS DETERMINISTIC RATHER THAN A RACE-DETECTOR HOPE. The seam parks inside the publish critical section, at
// the one instruction the defect lived between, and the release is issued while it is parked.
func TestAReleaseCannotSlipBetweenThePublishCheckAndTheAdmission(t *testing.T) {
	adapter := newCountingAdapter()
	probe, err := cache.NewProbeCache(t.TempDir(), 64<<20, 4<<20)
	if err != nil {
		t.Fatal(err)
	}
	playback := cache.NewPlaybackCache(32<<20, 8<<20)
	reader, err := NewReader(DefaultConfig(), staticRouter{adapter}, probe, playback)
	if err != nil {
		t.Fatal(err)
	}

	handle, err := reader.Open(testEntry(), "gen_one")
	if err != nil {
		t.Fatal(err)
	}

	inside := make(chan struct{})
	proceed := make(chan struct{})
	var once sync.Once
	reader.onPublishAdmit = func() {
		once.Do(func() {
			close(inside)
			<-proceed
		})
	}

	windows := manifest.ProbeOffsetsFor(fileSize)
	offset := windows[0].Offset + windows[0].Length + 4096
	readDone := make(chan error, 1)
	go func() {
		_, err := reader.Read(context.Background(), handle, make([]byte, 4096), offset)
		readDone <- err
	}()

	select {
	case <-inside:
	case <-time.After(3 * time.Second):
		t.Fatal("the publish never reached its admission point")
	}

	// THE RELEASE ARRIVES IN EXACTLY THE WINDOW. It must not be able to discharge the handle while an
	// admission that would have to be discharged is still to come.
	releaseDone := make(chan struct{})
	go func() {
		reader.Release(handle)
		close(releaseDone)
	}()
	releasedEarly := false
	select {
	case <-releaseDone:
		releasedEarly = true
	case <-time.After(250 * time.Millisecond):
	}

	// Unwind before asserting, so a failure does not leave a goroutine parked holding the handle's lock.
	close(proceed)
	select {
	case <-releaseDone:
	case <-time.After(3 * time.Second):
		t.Fatal("the release never completed after the publish finished")
	}
	if err := <-readDone; err != nil {
		t.Fatalf("read: %v", err)
	}

	if releasedEarly {
		t.Fatal("the release discharged the handle while a publish was mid-admission; the admission that " +
			"followed charges a handle that no longer exists and nothing will ever discharge it")
	}
	// BOTH HALVES MATTER. A charge nothing discharges is the leak this closes; a discharge that took the bytes
	// with it is the original defect.
	if charged := playback.HandleBytes(handle.ID); charged != 0 {
		t.Fatalf("the released handle is still charged %d bytes", charged)
	}
	if total := playback.TotalBytes(); total == 0 {
		t.Fatal("the admission that won the ordering must still be cached, unowned")
	}
}
