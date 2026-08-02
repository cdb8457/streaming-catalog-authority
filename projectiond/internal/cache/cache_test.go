package cache

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
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
	cache.DropHandle(2)
	if cache.HandleBytes(2) != 0 {
		t.Fatal("dropping a handle must free everything it held")
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
