package cache

import (
	"bytes"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func testKey(offset, length int64) Key {
	return Key{ProjectedVersionID: "pv_test", IdentityDigest: "identity", Offset: offset, Length: length}
}

func payload(n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = byte(i % 7)
	}
	return out
}

func newProbe(t *testing.T, dir string) *ProbeCache {
	t.Helper()
	cache, err := NewProbeCache(dir, 1<<20, 1<<16)
	if err != nil {
		t.Fatal(err)
	}
	return cache
}

func TestProbeCacheRoundTrip(t *testing.T) {
	dir := t.TempDir()
	cache := newProbe(t, dir)
	key := testKey(0, 1024)
	data := payload(1024)
	if err := cache.Put(key, data); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 1024)
	if !cache.Get(key, got) {
		t.Fatal("a record just written must be readable")
	}
	if !bytes.Equal(got, data) {
		t.Fatal("the bytes came back wrong")
	}
}

// REGRESSION: the cache trusted the file name and the length. Same-length bit rot was served as MEDIA BYTES.
func TestCorruptRecordIsAMissAndIsRemoved(t *testing.T) {
	dir := t.TempDir()
	cache := newProbe(t, dir)
	key := testKey(0, 1024)
	if err := cache.Put(key, payload(1024)); err != nil {
		t.Fatal(err)
	}

	// Flip one byte of the CONTENT, leaving the file length identical.
	path := filepath.Join(dir, recordName(key))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	raw[recordHeaderSize+10] ^= 0xff
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	got := make([]byte, 1024)
	if cache.Get(key, got) {
		t.Fatal("a corrupted record must not be served")
	}
	if cache.Corrupt == 0 {
		t.Fatal("the corruption was not counted")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("a corrupted record must be removed")
	}
}

func TestTruncatedRecordIsAMiss(t *testing.T) {
	dir := t.TempDir()
	cache := newProbe(t, dir)
	key := testKey(0, 1024)
	if err := cache.Put(key, payload(1024)); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, recordName(key))
	raw, _ := os.ReadFile(path)
	if err := os.WriteFile(path, raw[:len(raw)-100], 0o600); err != nil {
		t.Fatal(err)
	}
	if cache.Get(key, make([]byte, 1024)) {
		t.Fatal("a truncated record must not be served")
	}
}

// A record whose header names a DIFFERENT key must not be served under this one, even if somebody renamed it.
func TestRecordBoundToADifferentKeyIsAMiss(t *testing.T) {
	dir := t.TempDir()
	cache := newProbe(t, dir)
	first, second := testKey(0, 1024), testKey(1024, 1024)
	if err := cache.Put(first, payload(1024)); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, recordName(first)))
	if err := os.WriteFile(filepath.Join(dir, recordName(second)), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	reopened := newProbe(t, dir)
	if reopened.Get(second, make([]byte, 1024)) {
		t.Fatal("a record carrying another key's binding must not be served")
	}
}

// Adoption accepts only strict record names and regular files. A cache directory is not a place to find a
// file the daemon did not put there.
func TestAdoptionRejectsStrangersAndSymlinks(t *testing.T) {
	dir := t.TempDir()
	cache := newProbe(t, dir)
	key := testKey(0, 512)
	if err := cache.Put(key, payload(512)); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(dir, "not-a-record.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "wip-123.tmp"), []byte("half"), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("not yours"), 0o600); err != nil {
		t.Fatal(err)
	}
	linkName := filepath.Join(dir, testKey(99, 99).String()+".pjd")
	if err := os.Symlink(outside, linkName); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	// RESTART: a fresh cache over the same directory keeps the real record and refuses everything else.
	reopened := newProbe(t, dir)
	if !reopened.Get(key, make([]byte, 512)) {
		t.Fatal("a valid record must survive a restart")
	}
	if _, err := os.Stat(filepath.Join(dir, "not-a-record.txt")); !os.IsNotExist(err) {
		t.Fatal("a stranger in the cache directory must be removed rather than adopted")
	}
	if _, err := os.Stat(filepath.Join(dir, "wip-123.tmp")); !os.IsNotExist(err) {
		t.Fatal("an unfinished write must be removed")
	}
	if _, err := os.Lstat(linkName); err == nil {
		t.Fatal("a symlink wearing a record name must be removed, never followed")
	}
	if reopened.Rejected < 2 {
		t.Fatalf("the rejections were not counted: %d", reopened.Rejected)
	}
}

// THE DISK CEILING IS HARD. Pinning is a preference; it is not a licence to fill the disk.
func TestPinnedRecordsAreStillEvictedUnderTheHardCeiling(t *testing.T) {
	dir := t.TempDir()
	cache, err := NewProbeCache(dir, 4096, 1024)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 12; i++ {
		key := testKey(int64(i)*1024, 1024)
		if err := cache.Put(key, payload(1024)); err != nil {
			t.Fatal(err)
		}
		cache.Pin(key) // every single one is pinned by an "active stream"
	}
	if cache.TotalBytes() > 4096 {
		t.Fatalf("the hard ceiling was exceeded by pinned records: %d bytes", cache.TotalBytes())
	}
	if cache.Evicts == 0 {
		t.Fatal("nothing was evicted, so the ceiling was not enforced")
	}
}

func TestProbeCacheRefusesAShortDestination(t *testing.T) {
	dir := t.TempDir()
	cache := newProbe(t, dir)
	key := testKey(0, 1024)
	if err := cache.Put(key, payload(1024)); err != nil {
		t.Fatal(err)
	}
	// A malformed internal request must be refused, not panic on a slice bound.
	if cache.Get(key, make([]byte, 8)) {
		t.Fatal("a destination shorter than the record must be refused")
	}
}

func TestProbeCacheRefusesOversizedRecords(t *testing.T) {
	dir := t.TempDir()
	cache, err := NewProbeCache(dir, 1<<20, 512)
	if err != nil {
		t.Fatal(err)
	}
	key := testKey(0, 4096)
	if err := cache.Put(key, payload(4096)); err != nil {
		t.Fatal(err)
	}
	if cache.TotalBytes() != 0 {
		t.Fatal("a record larger than the per-item bound must not be stored")
	}
}

// REGRESSION: an oversized chunk used to drop the handle's whole cache and then be inserted anyway, leaving
// the per-handle ceiling violated by exactly the entry that violated it.
func TestPlaybackCacheRefusesAnOversizedChunk(t *testing.T) {
	cache := NewPlaybackCache(8192, 2048)
	cache.Put(1, testKey(0, 1024), payload(1024))
	if cache.HandleBytes(1) != 1024 {
		t.Fatalf("expected 1024 bytes for the handle, got %d", cache.HandleBytes(1))
	}

	cache.Put(1, testKey(4096, 4096), payload(4096)) // larger than the per-handle ceiling
	if cache.HandleBytes(1) > 2048 {
		t.Fatalf("the per-handle ceiling was violated: %d", cache.HandleBytes(1))
	}
	if cache.Refused == 0 {
		t.Fatal("the oversized put was not refused")
	}
	// The chunk that was already there must survive: dropping it to make room for something that then never
	// fits is the worst of both.
	if !cache.Get(1, testKey(0, 1024), make([]byte, 1024)) {
		t.Fatal("an oversized put must not evict what was already cached")
	}
}

func TestPlaybackCacheHoldsItsCeilingsAcrossOperations(t *testing.T) {
	cache := NewPlaybackCache(4096, 2048)
	for handle := uint64(1); handle <= 4; handle++ {
		for i := 0; i < 6; i++ {
			cache.Put(handle, testKey(int64(handle)*100000+int64(i)*512, 512), payload(512))
			if cache.HandleBytes(handle) > 2048 {
				t.Fatalf("per-handle ceiling exceeded: %d", cache.HandleBytes(handle))
			}
			if cache.TotalBytes() > 4096 {
				t.Fatalf("total ceiling exceeded: %d", cache.TotalBytes())
			}
		}
	}
	total := cache.TotalBytes()
	cache.DropHandle(2)
	if cache.HandleBytes(2) != 0 {
		t.Fatal("dropping a handle must discharge everything it had admitted")
	}
	// AND IT FREES AN ACCOUNTING CLAIM, NOT MEMORY. The bytes stay under the global ceiling, where they are
	// ordinary LRU candidates; the total is unchanged by the release itself.
	if cache.TotalBytes() != total {
		t.Fatalf("a release deleted %d bytes; it discharges admission, not memory",
			total-cache.TotalBytes())
	}
}

func TestPlaybackCacheRefusesAShortDestination(t *testing.T) {
	cache := NewPlaybackCache(8192, 8192)
	key := testKey(0, 1024)
	cache.Put(1, key, payload(1024))
	if cache.Get(1, key, make([]byte, 4)) {
		t.Fatal("a destination shorter than the record must be refused")
	}
}

// Cache keys carry byte identity, so two different streams cannot read each other's bytes.
func TestKeysSeparateByteIdentities(t *testing.T) {
	a := Key{ProjectedVersionID: "pv_a", IdentityDigest: "one", Offset: 0, Length: 4}
	b := Key{ProjectedVersionID: "pv_a", IdentityDigest: "two", Offset: 0, Length: 4}
	c := Key{ProjectedVersionID: "pv_b", IdentityDigest: "one", Offset: 0, Length: 4}
	if a.String() == b.String() || a.String() == c.String() {
		t.Fatal("identity and version must both participate in the key")
	}
}

// ---------------------------------------------------------------------------------------------------------
// The playback cache's lifetime: what a release does, and what it must not do
// ---------------------------------------------------------------------------------------------------------

// stepClock advances one second per reading, so "least recently used" is a fact about the ORDER of operations
// rather than about the host clock's resolution. Two puts inside the same millisecond would otherwise fall to
// the name tie-break, and an eviction test decided by a tie-break proves nothing about recency.
type stepClock struct {
	mu sync.Mutex
	at time.Time
}

func newStepClock() *stepClock {
	return &stepClock{at: time.Unix(1_700_000_000, 0).UTC()}
}

func (c *stepClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at = c.at.Add(time.Second)
	return c.at
}

// auditLedgers recomputes BOTH books from the entries themselves and insists the cache agrees with them.
//
// WHY IT RECOMPUTES RATHER THAN READS. The global total and the per-handle admission ledger are two running
// numbers describing one map, and every accounting defect this file has had was a removal path that updated
// one and forgot the other. A test that asked the cache for its own totals would be asking the suspect.
func auditLedgers(t *testing.T, c *PlaybackCache) {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()

	wantTotal := int64(0)
	wantByHandle := map[uint64]int64{}
	for _, entry := range c.entries {
		size := int64(len(entry.data))
		wantTotal += size
		if entry.owner != 0 {
			wantByHandle[entry.owner] += size
		}
	}
	if c.total != wantTotal {
		t.Fatalf("the global total says %d bytes, the entries add up to %d", c.total, wantTotal)
	}
	if c.total > c.maxTotal {
		t.Fatalf("the global ceiling of %d is breached by %d bytes", c.maxTotal, c.total-c.maxTotal)
	}
	// HANDLE 0 IS NOT A HANDLE. It is the label for an entry nobody owns, and a row for it could only have
	// come from decrementing an unowned entry's phantom budget — which, once negative, silently widens the
	// admission ceiling of whatever handle is numbered 0 next.
	if bytes, ok := c.byHnd[0]; ok {
		t.Fatalf("the admission ledger holds a row for handle 0 (%d bytes); 0 means unowned", bytes)
	}
	// The balance is clamped at zero, so a double discharge cannot be seen in the ledger afterwards. This is
	// where it is seen instead.
	if c.AccountingFaults != 0 {
		t.Fatalf("%d discharges would have driven an admission balance below zero", c.AccountingFaults)
	}
	for handle, held := range c.byHnd {
		if held < 0 {
			t.Fatalf("handle %d has a negative admission balance of %d", handle, held)
		}
		if held > c.maxPerHandle {
			t.Fatalf("handle %d holds %d bytes against a ceiling of %d", handle, held, c.maxPerHandle)
		}
		if want := wantByHandle[handle]; held != want {
			t.Fatalf("handle %d is charged %d bytes but owns %d", handle, held, want)
		}
	}
	for handle, want := range wantByHandle {
		if held, ok := c.byHnd[handle]; !ok || held != want {
			t.Fatalf("handle %d owns %d bytes and the ledger says %d (present=%v)", handle, want, held, ok)
		}
	}
}

func ledgerRows(c *PlaybackCache) map[uint64]int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[uint64]int64, len(c.byHnd))
	for handle, held := range c.byHnd {
		out[handle] = held
	}
	return out
}

func entryOwner(t *testing.T, c *PlaybackCache, key Key) (uint64, bool) {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key.String()]
	if !ok {
		return 0, false
	}
	return entry.owner, true
}

// TestAReleaseRetainsTheBytesAndDischargesOnlyTheAdmission is the repair, stated at its smallest.
//
// THE DEFECT. `DropHandle` deleted every entry the handle had put. Because the key is byte identity and not
// the handle, the deleted entry was exactly what the next open would ask for — so a scan-then-analyse pass
// refetched the same block once per open. gate9 measured it through the real reader as the same block, offset
// 1,048,576 length 2,724,273, fetched four times for four opens.
func TestAReleaseRetainsTheBytesAndDischargesOnlyTheAdmission(t *testing.T) {
	c := NewPlaybackCache(64<<20, 32<<20)
	c.SetClock(newStepClock().now)
	key := testKey(1_048_576, 2_724_273)
	block := payload(2_724_273)

	c.Put(1, key, block)
	if c.HandleBytes(1) != int64(len(block)) {
		t.Fatalf("the admitting handle should be charged %d bytes, got %d", len(block), c.HandleBytes(1))
	}

	c.DropHandle(1)

	if c.HandleBytes(1) != 0 {
		t.Fatalf("a release must discharge the admission it granted, %d bytes remain", c.HandleBytes(1))
	}
	if c.TotalBytes() != int64(len(block)) {
		t.Fatalf("a release deleted %d bytes; it discharges an accounting claim, not memory",
			int64(len(block))-c.TotalBytes())
	}
	auditLedgers(t, c)
	if owner, present := entryOwner(t, c, key); !present || owner != 0 {
		t.Fatalf("the released entry must remain, unowned: present=%v owner=%d", present, owner)
	}

	// THE NEXT OPEN REUSES IT, and reuse is free.
	got := make([]byte, len(block))
	if !c.Get(2, key, got) {
		t.Fatal("the next open must hit the bytes the previous one cached")
	}
	if !bytes.Equal(got, block) {
		t.Fatal("the retained entry did not serve the bytes that were cached")
	}
	if c.Hits != 1 || c.Misses != 0 {
		t.Fatalf("one hit and no miss: got %d hits, %d misses", c.Hits, c.Misses)
	}
	if c.HandleBytes(2) != 0 {
		t.Fatalf("a hit is free reuse and must not charge the reader: handle 2 holds %d", c.HandleBytes(2))
	}
	if owner, _ := entryOwner(t, c, key); owner != 0 {
		t.Fatalf("a hit transferred ownership to the reader (owner=%d); it must transfer nothing", owner)
	}
	auditLedgers(t, c)
}

// TestANewPlaybackCacheRetainsNothing. "Retained across a release" is a claim about ONE PROCESS. Nothing here
// is written anywhere but memory, so a restart — a new cache — starts empty, and the contrast is the whole
// difference between this cache and the scan-window cache next to it.
func TestANewPlaybackCacheRetainsNothing(t *testing.T) {
	key := testKey(0, 4096)
	first := NewPlaybackCache(64<<20, 32<<20)
	first.Put(1, key, payload(4096))
	first.DropHandle(1)
	if !first.Get(2, key, make([]byte, 4096)) {
		t.Fatal("the fixture must actually retain across a release, or the contrast proves nothing")
	}

	restarted := NewPlaybackCache(64<<20, 32<<20)
	if restarted.Get(1, key, make([]byte, 4096)) {
		t.Fatal("a new cache served bytes it never held; this cache must not survive a restart")
	}
	if restarted.TotalBytes() != 0 {
		t.Fatalf("a new cache starts empty, got %d bytes", restarted.TotalBytes())
	}
}

// TestReleasedEntriesRemainBoundedByTheGlobalCeiling. Retention that is not bounded is a leak. An unowned
// entry is an ordinary LRU candidate: nobody's ceiling protects it, and the hard total is what ends it.
func TestReleasedEntriesRemainBoundedByTheGlobalCeiling(t *testing.T) {
	const block = 1024
	const kept = 4
	const admitted = 10
	c := NewPlaybackCache(block*kept, block*kept)
	c.SetClock(newStepClock().now)

	keys := make([]Key, 0, admitted)
	for handle := uint64(1); handle <= admitted; handle++ {
		key := testKey(int64(handle)*block, block)
		keys = append(keys, key)
		c.Put(handle, key, payload(block))
		c.DropHandle(handle) // every entry is unowned the instant it is cached
	}

	if c.TotalBytes() != block*kept {
		t.Fatalf("the global ceiling is %d bytes, the cache holds %d", block*kept, c.TotalBytes())
	}
	if c.Evicts != admitted-kept {
		t.Fatalf("%d entries had to be evicted to hold the ceiling, got %d", admitted-kept, c.Evicts)
	}
	if rows := ledgerRows(c); len(rows) != 0 {
		t.Fatalf("every handle was released; the admission ledger should be empty, got %v", rows)
	}
	auditLedgers(t, c)

	// AND IT IS THE OLDEST THAT WENT, by recency rather than by ownership.
	for i, key := range keys {
		want := i >= admitted-kept
		if got := c.Get(uint64(100+i), key, make([]byte, block)); got != want {
			t.Fatalf("entry %d of %d: retained=%v, want %v", i, admitted, got, want)
		}
	}
}

// TestPerHandleAdmissionIsAHardCeilingAndAHitDoesNotSpendIt.
//
// The per-handle bound governs what a handle may ADD. A handle over it evicts its OWN oldest admissions and
// nobody else's; a handle reading what another handle admitted spends none of its own budget and discharges
// none of the owner's. Charging a hit would make a second open evict its own working set to pay a second time
// for bytes already in memory — the repaired defect, reintroduced through the ledger.
func TestPerHandleAdmissionIsAHardCeilingAndAHitDoesNotSpendIt(t *testing.T) {
	const block = 1024
	const perHandle = 3 * block
	c := NewPlaybackCache(64<<20, perHandle) // a global budget far larger than any one handle's
	c.SetClock(newStepClock().now)

	own := make([]Key, 0, 4)
	for i := 0; i < 4; i++ {
		key := testKey(int64(i)*block, block)
		own = append(own, key)
		c.Put(1, key, payload(block))
		if c.HandleBytes(1) > perHandle {
			t.Fatalf("after %d puts handle 1 holds %d against a ceiling of %d", i+1, c.HandleBytes(1), perHandle)
		}
	}
	if c.HandleBytes(1) != perHandle {
		t.Fatalf("handle 1 should sit exactly at its ceiling, got %d", c.HandleBytes(1))
	}
	if c.Get(9, own[0], make([]byte, block)) {
		t.Fatal("the handle's own oldest admission must have been evicted to stay under its ceiling")
	}
	for i, key := range own[1:] {
		if !c.Get(9, key, make([]byte, block)) {
			t.Fatalf("admission %d must have survived", i+1)
		}
	}
	if c.HandleBytes(9) != 0 {
		t.Fatalf("reading another handle's entries charged the reader %d bytes", c.HandleBytes(9))
	}
	if c.HandleBytes(1) != perHandle {
		t.Fatalf("...and discharged the owner down to %d", c.HandleBytes(1))
	}

	// A SECOND LIVE HANDLE ADMITS ITS OWN, and the first handle's working set is not what pays for it.
	for i := 0; i < 3; i++ {
		c.Put(2, testKey(1_000_000+int64(i)*block, block), payload(block))
	}
	if c.HandleBytes(2) != perHandle {
		t.Fatalf("handle 2 should hold its own %d bytes, got %d", perHandle, c.HandleBytes(2))
	}
	if c.HandleBytes(1) != perHandle {
		t.Fatalf("one handle's admissions evicted another's: handle 1 is down to %d", c.HandleBytes(1))
	}
	auditLedgers(t, c)
}

// TestEvictingAReleasedEntryLeavesNoNegativeAccounting. An unowned entry has no admission to give back. The
// removal path must recognise that rather than decrementing a row for handle 0, which would run negative and
// hand the next handle numbered 0 a ceiling wider than the one it was given.
func TestEvictingAReleasedEntryLeavesNoNegativeAccounting(t *testing.T) {
	const block = 1024
	c := NewPlaybackCache(2*block, 2*block)
	c.SetClock(newStepClock().now)

	c.Put(1, testKey(0, block), payload(block))
	c.Put(1, testKey(block, block), payload(block))
	c.DropHandle(1)

	// A LIVE HANDLE NOW ADMITS OVER THE GLOBAL CEILING, so what capacity reclaims is an entry nobody owns.
	c.Put(2, testKey(9*block, block), payload(block))

	if c.Evicts != 1 {
		t.Fatalf("exactly one unowned entry had to go, got %d evictions", c.Evicts)
	}
	if c.HandleBytes(0) != 0 {
		t.Fatalf("an unowned eviction was charged to handle 0: %d", c.HandleBytes(0))
	}
	if c.AccountingFaults != 0 {
		t.Fatalf("an unowned entry has no admission to give back; %d discharges tried anyway",
			c.AccountingFaults)
	}
	if c.HandleBytes(1) != 0 {
		t.Fatalf("a released handle's ledger row came back holding %d bytes", c.HandleBytes(1))
	}
	if c.HandleBytes(2) != block {
		t.Fatalf("the admitting handle should be charged %d, got %d", block, c.HandleBytes(2))
	}
	if rows := ledgerRows(c); len(rows) != 1 {
		t.Fatalf("only the live handle should have a ledger row, got %v", rows)
	}
	auditLedgers(t, c)
}

// TestTheUnownedSentinelIsNotAnAdmissionPath.
//
// Handle 0 labels an entry no live handle owns. If `Put` accepted it, those bytes would sit in the cache
// counted by no admission ledger — a side door around maxPerHandle, open to any caller, through which the
// per-handle ceiling would bound only callers that named themselves. Unowned is a state an entry REACHES by
// the release of its admitting handle; it is not a state an entry may be admitted in.
func TestTheUnownedSentinelIsNotAnAdmissionPath(t *testing.T) {
	const block = 1024
	c := NewPlaybackCache(64<<20, block)

	c.Put(0, testKey(0, block), payload(block))
	if c.Refused != 1 {
		t.Fatalf("an admission under the unowned sentinel must be refused: %d refusals", c.Refused)
	}
	if c.TotalBytes() != 0 {
		t.Fatalf("and must store nothing, %d bytes stored", c.TotalBytes())
	}
	if c.Get(1, testKey(0, block), make([]byte, block)) {
		t.Fatal("nothing was admitted, so nothing may be served")
	}

	// AND IT CANNOT BE USED TO EXCEED THE PER-HANDLE CEILING IN AGGREGATE, which is the reason it is refused
	// rather than merely undefined.
	for i := 0; i < 8; i++ {
		c.Put(0, testKey(int64(i)*block, block), payload(block))
	}
	if c.TotalBytes() != 0 {
		t.Fatalf("the sentinel admitted %d unaccounted bytes past a %d-byte per-handle ceiling",
			c.TotalBytes(), int64(block))
	}
	auditLedgers(t, c)
}

// TestGlobalEvictionReclaimsByRecencyEvenFromALiveHandle. Retaining released entries only stays bounded if
// the global ceiling outranks ownership. It takes the least recently used entry whether or not an open handle
// admitted it — the same reason the scan cache evicts pinned records rather than exceed its disk bound. A
// ceiling that yields to a live stream is not a ceiling, and unowned entries would otherwise be the only
// thing ever reclaimed while an active handle's stale block sat there forever.
func TestGlobalEvictionReclaimsByRecencyEvenFromALiveHandle(t *testing.T) {
	const block = 1024
	c := NewPlaybackCache(2*block, 2*block)
	c.SetClock(newStepClock().now)

	oldest := testKey(0, block)
	c.Put(1, oldest, payload(block)) // handle 1 stays open and never releases
	c.Put(2, testKey(block, block), payload(block))
	c.Put(3, testKey(2*block, block), payload(block))

	if c.Evicts != 1 {
		t.Fatalf("the third admission had to reclaim exactly one entry, got %d", c.Evicts)
	}
	if c.Get(1, oldest, make([]byte, block)) {
		t.Fatal("the least recently used entry must go even though its owner is still open")
	}
	if c.HandleBytes(1) != 0 {
		t.Fatalf("and its owner's admission must be discharged with it, %d remains", c.HandleBytes(1))
	}
	if c.HandleBytes(2) != block || c.HandleBytes(3) != block {
		t.Fatalf("the two newer admissions stand: %d and %d", c.HandleBytes(2), c.HandleBytes(3))
	}
	auditLedgers(t, c)
}

// TestRetainedBytesStayIsolatedByIdentityAndVersion. Retention widens WHO may read an entry — anybody asking
// for the same bytes — and must not widen WHICH bytes count as the same. The key is unchanged: projected
// version, byte identity, offset and length, all four.
func TestRetainedBytesStayIsolatedByIdentityAndVersion(t *testing.T) {
	c := NewPlaybackCache(64<<20, 32<<20)
	base := Key{ProjectedVersionID: "pv_a", IdentityDigest: "identity-a", Offset: 4096, Length: 4096}
	c.Put(1, base, payload(4096))
	c.DropHandle(1)

	strangers := []struct {
		what string
		key  Key
	}{
		{"a different projected version",
			Key{ProjectedVersionID: "pv_b", IdentityDigest: "identity-a", Offset: 4096, Length: 4096}},
		{"a different byte identity",
			Key{ProjectedVersionID: "pv_a", IdentityDigest: "identity-b", Offset: 4096, Length: 4096}},
		{"a different offset",
			Key{ProjectedVersionID: "pv_a", IdentityDigest: "identity-a", Offset: 8192, Length: 4096}},
		{"a different length",
			Key{ProjectedVersionID: "pv_a", IdentityDigest: "identity-a", Offset: 4096, Length: 2048}},
	}
	for _, stranger := range strangers {
		if c.Get(2, stranger.key, make([]byte, stranger.key.Length)) {
			t.Fatalf("%s read the retained entry", stranger.what)
		}
	}

	got := make([]byte, 4096)
	if !c.Get(2, base, got) || !bytes.Equal(got, payload(4096)) {
		t.Fatal("the exact key must still hit, and with the exact bytes")
	}
}

// TestConcurrentReleaseGetAndPutKeepBothLedgersConsistent drives the three operations that now mutate
// ownership against each other, under caps tight enough that both eviction paths run throughout. What it
// asserts is not a count — under a race there is no deterministic count — but that the two ledgers still
// describe the map when the noise stops.
func TestConcurrentReleaseGetAndPutKeepBothLedgersConsistent(t *testing.T) {
	const block = 512
	c := NewPlaybackCache(16*block, 4*block)

	const workers = 8
	const rounds = 200
	var wg sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for round := 0; round < rounds; round++ {
				// Handle numbering is disjoint per worker, so a release only ever ends a handle its own
				// goroutine owns; the keys deliberately overlap, so replaces cross handles.
				handle := uint64(worker*1000 + round%7 + 1)
				key := testKey(int64((worker*13+round)%40)*block, block)
				c.Put(handle, key, payload(block))
				c.Get(handle, key, make([]byte, block))
				c.Get(uint64(workers*1000+worker+1), key, make([]byte, block))
				c.DropHandle(handle)
			}
		}(worker)
	}
	wg.Wait()

	auditLedgers(t, c)
	// EVERY HANDLE WAS RELEASED AFTER ITS LAST ADMISSION, so nothing may still be charged to anybody.
	if rows := ledgerRows(c); len(rows) != 0 {
		t.Fatalf("released handles left %d admission rows behind: %v", len(rows), rows)
	}
	if c.Evicts == 0 {
		t.Fatal("the caps were meant to keep both eviction paths busy; nothing was evicted")
	}
}
