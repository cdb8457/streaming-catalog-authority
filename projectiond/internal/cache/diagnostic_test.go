package cache

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// gate9's OBSERVED GEOMETRY, so the evidence is gathered against the real numbers rather than round ones.
const (
	gate9ObjectSize = 8_594_275 // the soak source
	gate9GapOffset  = 1_048_576 // end of the head probe window
	gate9GapLength  = 2_724_273 // head-to-middle gap: manifest.ProbeOffsetsFor(size), fixed by size
)

func gate9Key(offset, length int64) Key {
	return Key{ProjectedVersionID: "v1", IdentityDigest: "identity-of-the-soak-source",
		Offset: offset, Length: length}
}

// TestTheDiagnosticIsOffByDefault is the first thing that has to be true about a per-event recorder living
// in a read path: it costs nothing and reveals nothing unless an operator asked for it.
func TestTheDiagnosticIsOffByDefault(t *testing.T) {
	// EXPLICITLY UNSET, because a test that inherits the environment proves nothing about the default when
	// the variable happens to be set in the shell that ran it.
	t.Setenv(cacheDiagnosticEnv, "")
	cache := NewPlaybackCache(64<<20, 32<<20)
	if cache.DiagnosticEnabled() {
		t.Fatal("the diagnostic is on without the environment variable")
	}
	data := make([]byte, gate9GapLength)
	cache.Put(1, gate9Key(gate9GapOffset, gate9GapLength), data)
	cache.Get(1, gate9Key(gate9GapOffset, gate9GapLength), make([]byte, gate9GapLength))
	cache.DropHandle(1)
	if events, dropped := cache.DiagnosticEvents(); len(events) != 0 || dropped != 0 {
		t.Fatalf("a disabled diagnostic recorded %d events", len(events))
	}
}

// TestSequentialOpensReuseAStableKeyAcrossReleases EXERCISES THE CACHE, AND ONLY THAT.
//
// IT IS NOT THE EVIDENCE. It hands the cache the same key thirteen times, so the stability of the key is
// something it assumes rather than observes. What it legitimately proves is that a release no longer removes
// a stable-keyed block from reach.
//
// The real evidence is TestSequentialOpensReuseTheSameGapThroughTheRealReader in internal/readpath, where the
// READER computes the key from its own block plan and Release is the thing that used to destroy it.
func TestSequentialOpensReuseAStableKeyAcrossReleases(t *testing.T) {
	t.Setenv(cacheDiagnosticEnv, "1")
	cache := NewPlaybackCache(64<<20, 32<<20)
	if !cache.DiagnosticEnabled() {
		t.Fatal("the diagnostic did not turn on")
	}

	const opens = 13 // the number of clipped-block responses gate9 measured for this object
	key := gate9Key(gate9GapOffset, gate9GapLength)
	payload := make([]byte, gate9GapLength)
	for open := 1; open <= opens; open++ {
		handle := uint64(open)
		// A scan opens the file, reads the gap, and releases. The block plan is fixed by object size, so
		// every open computes the SAME key.
		if hit := cache.Get(handle, key, make([]byte, gate9GapLength)); !hit {
			cache.Put(handle, key, payload)
		}
		cache.DropHandle(handle)
	}

	summary := cache.Summarise()
	refetches, distinctBlocks := summary.RefetchesAfterRelease, summary.DistinctBlocks
	lengthsPerOffset := summary.LengthsPerObjectOffset

	// THE KEY IS STABLE. One block, one length ever requested at that offset — so the geometry did not move.
	if distinctBlocks != 1 {
		t.Fatalf("the same region produced %d distinct blocks; the key is not stable", distinctBlocks)
	}
	if got := lengthsPerOffset[fmt.Sprintf("%d:%d", 0, gate9GapOffset)]; got != 1 {
		t.Fatalf("offset %d was requested with %d different lengths; that would be changing geometry",
			gate9GapOffset, got)
	}
	// AND NOTHING WAS REFETCHED, because twelve releases removed twelve accounting claims and no bytes.
	if refetches != 0 {
		t.Fatalf("a release still costs a refetch: %d of them", refetches)
	}
	if cache.Misses != 1 {
		t.Fatalf("only the first open may miss: got %d misses", cache.Misses)
	}
	if cache.Hits != int64(opens-1) {
		t.Fatalf("every later open must hit: want %d, got %d", opens-1, cache.Hits)
	}
	// ONE COPY OF THE BLOCK, not thirteen: the reuse is of the entry, not of the shape.
	if cache.TotalBytes() != gate9GapLength {
		t.Fatalf("the cache should hold exactly one %d-byte block, it holds %d",
			gate9GapLength, cache.TotalBytes())
	}
	if cache.HandleBytes(opens) != 0 {
		t.Fatalf("the last handle was released and must be charged nothing, got %d", cache.HandleBytes(opens))
	}
}

// TestTheSummariserStillNamesARefetchAfterRelease KEEPS THE INSTRUMENT SHARP AFTER THE DEFECT IT FOUND WAS
// REPAIRED.
//
// A detector that can no longer be made to fire is indistinguishable from one that is broken. The cache no
// longer produces this shape, so the shape is fed to the summariser directly: miss, put, release, and a miss
// for the same block afterwards. That is exactly what a regression of the repair would emit, and it must
// still be counted as a refetch after RELEASE rather than after eviction — the two call for opposite fixes.
func TestTheSummariserStillNamesARefetchAfterRelease(t *testing.T) {
	events := []Event{
		{Seq: 1, Object: 0, Kind: EventMiss, Handle: 1, Offset: gate9GapOffset, Length: gate9GapLength},
		{Seq: 2, Object: 0, Kind: EventPut, Handle: 1, Offset: gate9GapOffset, Length: gate9GapLength},
		{Seq: 3, Object: -1, Kind: EventDrop, Handle: 1},
		{Seq: 4, Object: 0, Kind: EventMiss, Handle: 2, Offset: gate9GapOffset, Length: gate9GapLength},
	}

	summary := summariseEvents(events)
	if summary.RefetchesAfterRelease != 1 {
		t.Fatalf("the summariser no longer detects the defect it was built for: got %d",
			summary.RefetchesAfterRelease)
	}
	if summary.RefetchesAfterEviction != 0 {
		t.Fatalf("nothing was evicted here: got %d", summary.RefetchesAfterEviction)
	}
	if summary.UninterpretableEvents != 0 {
		t.Fatalf("every block event carries an ordinal: got %d ungroupable", summary.UninterpretableEvents)
	}
	if summary.DistinctBlocks != 1 {
		t.Fatalf("one block was ever cached, got %d", summary.DistinctBlocks)
	}
	if got := summary.LengthsPerObjectOffset[fmt.Sprintf("%d:%d", 0, gate9GapOffset)]; got != 1 {
		t.Fatalf("the geometry never moved, so one length at that offset: got %d", got)
	}
}

// TestTheDiagnosticSeparatesChangingGeometry is the negative control. If the same evidence were produced by
// a moving block plan, the summary must say so instead — otherwise the test above proves only that the
// summary always says "stable key".
func TestTheDiagnosticSeparatesChangingGeometry(t *testing.T) {
	t.Setenv(cacheDiagnosticEnv, "1")
	cache := NewPlaybackCache(64<<20, 32<<20)

	// The same offset requested with a shrinking length, as a cache-derived gapEnd would produce.
	for open := 1; open <= 5; open++ {
		length := int64(gate9GapLength - int64(open)*100_000)
		key := gate9Key(gate9GapOffset, length)
		if hit := cache.Get(uint64(open), key, make([]byte, length)); !hit {
			cache.Put(uint64(open), key, make([]byte, length))
		}
		cache.DropHandle(uint64(open))
	}

	summary := cache.Summarise()
	refetches, distinctBlocks := summary.RefetchesAfterRelease, summary.DistinctBlocks
	lengthsPerOffset := summary.LengthsPerObjectOffset
	if distinctBlocks != 5 {
		t.Fatalf("five different lengths are five different blocks, got %d", distinctBlocks)
	}
	if got := lengthsPerOffset[fmt.Sprintf("%d:%d", 0, gate9GapOffset)]; got != 5 {
		t.Fatalf("the summary must report 5 lengths at one offset, got %d", got)
	}
	if refetches != 0 {
		t.Fatalf("no block was ever refetched under a changing key, got %d", refetches)
	}
}

// TestTheDiagnosticIsBoundedAndSaysWhatItDropped. An unbounded log in a read path is a memory leak with a
// diagnostic label on it; one that silently truncates makes a sequence look like it began later than it did.
func TestTheDiagnosticIsBoundedAndSaysWhatItDropped(t *testing.T) {
	t.Setenv(cacheDiagnosticEnv, "1")
	cache := NewPlaybackCache(64<<20, 32<<20)
	const misses = diagnosticCapacity + 500
	for i := 0; i < misses; i++ {
		cache.Get(1, gate9Key(int64(i)*4096, 4096), make([]byte, 4096))
	}
	events, dropped := cache.DiagnosticEvents()
	if len(events) != diagnosticCapacity {
		t.Fatalf("the ring holds %d events, got %d", diagnosticCapacity, len(events))
	}
	if dropped != int64(misses-diagnosticCapacity) {
		t.Fatalf("it must report %d dropped, got %d", misses-diagnosticCapacity, dropped)
	}
	// OLDEST FIRST, and the oldest surviving event is the one after the dropped ones.
	if events[0].Seq != int64(misses-diagnosticCapacity+1) {
		t.Fatalf("the surviving window starts at seq %d, got %d",
			misses-diagnosticCapacity+1, events[0].Seq)
	}
	if events[len(events)-1].Seq != int64(misses) {
		t.Fatalf("and ends at the most recent event, got %d", events[len(events)-1].Seq)
	}
}

// TestTheDiagnosticCarriesNoSecretMaterial. It records offsets and lengths, which describe the daemon's own
// block plan; it must never carry the identity digest, the version id, a reference, a URL or a lease.
func TestTheDiagnosticCarriesNoSecretMaterial(t *testing.T) {
	t.Setenv(cacheDiagnosticEnv, "1")
	cache := NewPlaybackCache(64<<20, 32<<20)
	key := Key{ProjectedVersionID: "a-distinctive-version-id",
		IdentityDigest: "a-distinctive-identity-digest", Offset: 4096, Length: 4096}
	cache.Get(1, key, make([]byte, 4096))
	cache.Put(7, key, make([]byte, 4096))
	cache.DropHandle(7)

	events, _ := cache.DiagnosticEvents()
	if len(events) == 0 {
		t.Fatal("nothing was recorded")
	}
	encoded, err := json.Marshal(events)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	rendered := string(encoded)
	for _, forbidden := range []string{"a-distinctive-version-id", "a-distinctive-identity-digest"} {
		if strings.Contains(rendered, forbidden) {
			t.Fatalf("the diagnostic carries %q: %s", forbidden, rendered)
		}
	}
	// The object appears only as a small ordinal, which groups without naming.
	if events[0].Object != 0 {
		t.Fatalf("the first identity seen is ordinal 0, got %d", events[0].Object)
	}
}

// TestEvictionIsNotBlamedOnTheLaterRelease. Capacity and lifetime call for different repairs — sizing versus
// cache tenure — so a refetch caused by an eviction must never be counted as one caused by a release. The
// release still happens afterwards in this test, which is exactly the sequence that used to be misread.
func TestEvictionIsNotBlamedOnTheLaterRelease(t *testing.T) {
	t.Setenv(cacheDiagnosticEnv, "1")
	// A total budget that fits one block but not two, so the second put evicts the first.
	cache := NewPlaybackCache(6000, 6000)
	first := gate9Key(0, 4000)
	second := gate9Key(8000, 4000)

	cache.Put(1, first, make([]byte, 4000))
	cache.Put(1, second, make([]byte, 4000)) // evicts `first` on capacity
	if cache.Evicts == 0 {
		t.Fatal("this fixture must actually evict, or it proves nothing")
	}
	// The block is refetched while its owning handle is STILL OPEN: capacity took it, not release.
	if cache.Get(1, first, make([]byte, 4000)) {
		t.Fatal("the evicted block should miss")
	}
	cache.DropHandle(1) // the release happens afterwards, as it does in a real scan

	summary := cache.Summarise()
	if summary.RefetchesAfterEviction != 1 {
		t.Fatalf("the refetch was caused by eviction: got %d", summary.RefetchesAfterEviction)
	}
	if summary.RefetchesAfterRelease != 0 {
		t.Fatalf("and must NOT be blamed on the later release: got %d", summary.RefetchesAfterRelease)
	}
}

// TestTwoObjectsMayShareAnOffsetWithDifferentLengths. Objects of different sizes have different block plans,
// so the same offset legitimately carries different lengths in each. Summarising geometry by offset ALONE
// reported that as a moving block plan — a false finding about the daemon, from an aggregation mistake.
func TestTwoObjectsMayShareAnOffsetWithDifferentLengths(t *testing.T) {
	t.Setenv(cacheDiagnosticEnv, "1")
	cache := NewPlaybackCache(64<<20, 32<<20)
	const offset = 1_048_576
	small := Key{ProjectedVersionID: "v", IdentityDigest: "object-a", Offset: offset, Length: 1_000_000}
	large := Key{ProjectedVersionID: "v", IdentityDigest: "object-b", Offset: offset, Length: 2_724_273}
	cache.Get(1, small, make([]byte, small.Length))
	cache.Get(2, large, make([]byte, large.Length))

	summary := cache.Summarise()
	for shape, lengths := range summary.LengthsPerObjectOffset {
		if lengths != 1 {
			t.Fatalf("%s reports %d lengths; each object has ONE length at this offset", shape, lengths)
		}
	}
	if len(summary.LengthsPerObjectOffset) != 2 {
		t.Fatalf("two objects at one offset are two shapes, got %d", len(summary.LengthsPerObjectOffset))
	}
}

// TestOrdinalOverflowIsUninterpretableRatherThanCollided is the sharp edge of the -1 label.
//
// Past the ordinal limit every object is recorded as -1. If those events took part in the block maps, two
// UNRELATED objects that happen to share an offset and length would be indistinguishable and the summary
// would report a refetch that never happened — a false finding, in the direction of alarm. They are excluded
// from every grouping instead, and counted as events rather than objects, because -1 is many objects.
func TestOrdinalOverflowIsUninterpretableRatherThanCollided(t *testing.T) {
	t.Setenv(cacheDiagnosticEnv, "1")
	cache := NewPlaybackCache(64<<20, 32<<20)

	// Fill the ordinal table, then drive TWO more distinct objects that share a block shape exactly.
	for i := 0; i < diagnosticObjectLimit; i++ {
		key := Key{ProjectedVersionID: "v", IdentityDigest: fmt.Sprintf("filler-%d", i), Offset: 0, Length: 8}
		cache.Get(uint64(i), key, make([]byte, 8))
	}
	shared := func(identity string) Key {
		return Key{ProjectedVersionID: "v", IdentityDigest: identity, Offset: 4096, Length: 4096}
	}
	// Object X caches the shape and its handle is released; object Y then asks for the SAME shape. With -1
	// grouping, Y's miss would be charged as a refetch of X's block. They are different objects.
	cache.Put(900, shared("overflow-x"), make([]byte, 4096))
	cache.DropHandle(900)
	if cache.Get(901, shared("overflow-y"), make([]byte, 4096)) {
		t.Fatal("a different object must not hit another object's block")
	}

	summary := cache.Summarise()
	if summary.RefetchesAfterRelease != 0 {
		t.Fatalf("two unrelated overflow objects were collided into a refetch: got %d",
			summary.RefetchesAfterRelease)
	}
	if summary.UninterpretableEvents == 0 {
		t.Fatal("the overflow events must be counted as uninterpretable rather than silently grouped")
	}
	for shape := range summary.LengthsPerObjectOffset {
		if strings.HasPrefix(shape, "-1:") {
			t.Fatalf("overflow objects must not appear in the geometry summary: %s", shape)
		}
	}
	// AND A DROP NEVER SPENDS AN ORDINAL, so releases cannot exhaust the table on their own.
	events, _ := cache.DiagnosticEvents()
	for _, event := range events {
		if event.Kind == EventDrop && event.Object != -1 {
			t.Fatalf("a handle release is not an object; it was given ordinal %d", event.Object)
		}
	}
}

// TestTheReportSaysWhenItIsNotExhaustive. "Complete" is the one flag a reader uses to decide whether a
// missing refetch means none happened; it has to be false in BOTH ways the summary can be partial.
func TestTheReportSaysWhenItIsNotExhaustive(t *testing.T) {
	t.Setenv(cacheDiagnosticEnv, "1")

	// ORDINARY TRAFFIC: nothing lost, nothing ungroupable.
	clean := NewPlaybackCache(64<<20, 32<<20)
	key := gate9Key(gate9GapOffset, gate9GapLength)
	clean.Get(1, key, make([]byte, gate9GapLength))
	clean.Put(1, key, make([]byte, gate9GapLength))
	clean.DropHandle(1)
	report := clean.DiagnosticReport()
	if !report.Enabled {
		t.Fatal("the report must say it is enabled")
	}
	if report.Dropped != 0 || report.Summary.UninterpretableEvents != 0 || !report.Complete {
		t.Fatalf("an ordinary miss/put/drop is exhaustive: %+v", report)
	}

	// RING LOSS.
	overflowed := NewPlaybackCache(64<<20, 32<<20)
	const misses = diagnosticCapacity + 25
	for i := 0; i < misses; i++ {
		overflowed.Get(1, gate9Key(int64(i)*4096, 4096), make([]byte, 4096))
	}
	lossy := overflowed.DiagnosticReport()
	if lossy.Dropped != int64(misses-diagnosticCapacity) {
		t.Fatalf("the ring lost %d events, reported %d", misses-diagnosticCapacity, lossy.Dropped)
	}
	if lossy.Complete {
		t.Fatal("a report that lost events is not complete")
	}

	// ORDINAL OVERFLOW, WITH NOTHING LOST FROM THE RING. The quiet way to be partial.
	crowded := NewPlaybackCache(64<<20, 32<<20)
	for i := 0; i <= diagnosticObjectLimit; i++ {
		crowded.Get(uint64(i), Key{ProjectedVersionID: "v",
			IdentityDigest: fmt.Sprintf("object-%d", i), Offset: 0, Length: 8}, make([]byte, 8))
	}
	crowdedReport := crowded.DiagnosticReport()
	if crowdedReport.Dropped != 0 {
		t.Fatalf("the ring held everything here, got %d dropped", crowdedReport.Dropped)
	}
	if crowdedReport.Summary.UninterpretableEvents == 0 {
		t.Fatal("past the ordinal limit some events cannot be grouped")
	}
	if crowdedReport.Complete {
		t.Fatal("ungroupable events make the summary non-exhaustive even with a full ring")
	}

	// AND A RELEASE ALONE NEVER MAKES A REPORT LOOK PARTIAL.
	releases := NewPlaybackCache(64<<20, 32<<20)
	for handle := uint64(1); handle <= 50; handle++ {
		releases.DropHandle(handle)
	}
	releaseReport := releases.DiagnosticReport()
	if releaseReport.Summary.UninterpretableEvents != 0 {
		t.Fatalf("handle releases are control events, not unreadable data: %+v", releaseReport.Summary)
	}
	if !releaseReport.Complete {
		t.Fatal("fifty ordinary releases must not make a report incomplete")
	}
}

// TestTwoProjectedVersionsOfOneDigestAreDistinctObjects.
//
// THE DEFECT THIS CLOSES. A PlaybackCache entry is keyed on ProjectedVersionID AND IdentityDigest — the two
// together are what Key.String() distinguishes — but the diagnostic assigned its ordinal from the digest
// alone. Two entries with the same byte digest under different projected versions are DIFFERENT cache
// entries that never share storage, yet they collapsed into one diagnostic object. A miss on version B for
// a block version A had cached and released was then counted as a stable-key refetch after release: a false
// finding, in the direction of alarm, about the exact mechanism this instrument exists to establish.
func TestTwoProjectedVersionsOfOneDigestAreDistinctObjects(t *testing.T) {
	t.Setenv(cacheDiagnosticEnv, "1")
	cache := NewPlaybackCache(64<<20, 32<<20)

	const digest = "one-identity-digest"
	const offset, length = 4096, 4096
	versionA := Key{ProjectedVersionID: "pv_A", IdentityDigest: digest, Offset: offset, Length: length}
	versionB := Key{ProjectedVersionID: "pv_B", IdentityDigest: digest, Offset: offset, Length: length}

	// Version A caches the block and its handle is released.
	cache.Put(1, versionA, make([]byte, length))
	cache.DropHandle(1)
	// Version B asks for the same geometry. It is a different cache entry and must genuinely miss.
	if cache.Get(2, versionB, make([]byte, length)) {
		t.Fatal("a different projected version must not hit another version's entry")
	}

	summary := cache.Summarise()
	if summary.RefetchesAfterRelease != 0 {
		t.Fatalf("version B's miss is not a refetch of version A's released block: got %d",
			summary.RefetchesAfterRelease)
	}
	if summary.RefetchesAfterEviction != 0 {
		t.Fatalf("and nothing was evicted: got %d", summary.RefetchesAfterEviction)
	}

	// THE TWO MUST CARRY DIFFERENT ORDINALS, which is what keeps them apart in every grouping.
	events, _ := cache.DiagnosticEvents()
	ordinals := map[int]bool{}
	for _, event := range events {
		if event.Kind == EventDrop {
			continue // a release carries no identity by design
		}
		ordinals[event.Object] = true
	}
	if len(ordinals) != 2 {
		t.Fatalf("two projected versions are two objects, got ordinals %v", ordinals)
	}
	for ordinal := range ordinals {
		if ordinal < 0 {
			t.Fatalf("neither version is ungroupable, got ordinal %d", ordinal)
		}
	}
	// AND THE GEOMETRY SUMMARY KEEPS THEM SEPARATE, one length each rather than one shape with two.
	if len(summary.LengthsPerObjectOffset) != 1 {
		// Only version B missed, so only version B has a geometry entry; version A was a put.
		t.Fatalf("only the missing version has a geometry shape, got %v", summary.LengthsPerObjectOffset)
	}

	// AND NEITHER VALUE IS RETAINED OR EXPORTED.
	encoded, err := json.Marshal(events)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, forbidden := range []string{"pv_A", "pv_B", digest} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("the diagnostic exported %q: %s", forbidden, encoded)
		}
	}
}
