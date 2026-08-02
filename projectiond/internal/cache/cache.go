// Package cache holds the two caches the read path uses. They are deliberately different, because they
// answer two different questions.
//
// THE SCAN-WINDOW CACHE is small, persistent and per projected version. It holds the fixed head, middle and
// tail windows a media server's metadata pass reads, so a re-scan of an unchanged library costs zero provider
// requests.
//
// THE PLAYBACK CACHE is process-ephemeral, memory-bounded and keyed by exact byte identity. It exists to make
// sequential playback smooth and to let the next open of the same bytes reuse the last open's work, not to
// store anybody's library on the appliance's disk. It holds nothing across a restart because it holds nothing
// anywhere but memory.
//
// NEITHER EVER HOLDS A SECRET. What goes in is bytes from a byte range; a URL, a header, a lease and a token
// have no representation here at all, which is stronger than remembering not to write them.
package cache

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"
)

// Key identifies cached bytes by IMMUTABLE BYTE IDENTITY, never by path and never by source.
//
// That is what lets a failover, an access-lease refresh or a path correction keep the cache: the bytes did
// not change, so the key did not change. It is also what stops two different byte streams that briefly shared
// a path from ever reading each other's cache.
type Key struct {
	ProjectedVersionID string
	// IdentityDigest is a digest over the byte-identity proof — exact size plus the fixed-offset probe
	// digests. An entry with no proof still gets a key, derived from its size, so a single-source entry is
	// cacheable without being confusable with a different stream of the same size at the same version id.
	IdentityDigest string
	Offset         int64
	Length         int64
}

func (k Key) String() string {
	sum := sha256.Sum256([]byte(k.ProjectedVersionID + "\x00" + k.IdentityDigest + "\x00" +
		itoa(k.Offset) + "\x00" + itoa(k.Length)))
	return hex.EncodeToString(sum[:])
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	var buf [24]byte
	i := len(buf)
	neg := v < 0
	if neg {
		v = -v
	}
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

var (
	// ErrNotCached is returned by helpers that distinguish "not here" from "broken".
	ErrNotCached = errors.New("not cached")
	// ErrDestinationTooSmall refuses a malformed internal request rather than panicking on a slice bound.
	ErrDestinationTooSmall = errors.New("destination shorter than the cached record")
)

// ---------------------------------------------------------------------------------------------------------
// The on-disk record
// ---------------------------------------------------------------------------------------------------------

// A cache record is self-describing and self-verifying.
//
// WHY A CHECKSUM AND NOT JUST A LENGTH. An earlier draft trusted the file name and the byte count. Same-length
// bit rot, a truncated-then-padded file, or anything that swapped the contents would have been served to a
// media server AS MEDIA BYTES — silent corruption with a stable inode in front of it. The record carries the
// key it belongs to and a digest of its own content, and both are verified on every read.
const (
	recordMagic      = "PJDCACHE"
	recordVersion    = byte(1)
	recordHeaderSize = 8 + 1 + 32 + 8 + 32
)

var recordNamePattern = regexp.MustCompile(`^[0-9a-f]{64}\.pjd$`)

func recordName(key Key) string { return key.String() + ".pjd" }

func encodeRecord(key Key, data []byte) []byte {
	keyDigest := sha256.Sum256([]byte(key.String()))
	contentDigest := sha256.Sum256(data)
	out := make([]byte, 0, recordHeaderSize+len(data))
	out = append(out, recordMagic...)
	out = append(out, recordVersion)
	out = append(out, keyDigest[:]...)
	var length [8]byte
	binary.BigEndian.PutUint64(length[:], uint64(len(data)))
	out = append(out, length[:]...)
	out = append(out, contentDigest[:]...)
	out = append(out, data...)
	return out
}

func decodeRecord(key Key, raw []byte) ([]byte, error) {
	if len(raw) < recordHeaderSize {
		return nil, ErrNotCached
	}
	if string(raw[:8]) != recordMagic || raw[8] != recordVersion {
		return nil, ErrNotCached
	}
	keyDigest := sha256.Sum256([]byte(key.String()))
	if !bytes.Equal(raw[9:41], keyDigest[:]) {
		return nil, ErrNotCached
	}
	length := binary.BigEndian.Uint64(raw[41:49])
	if uint64(len(raw)-recordHeaderSize) != length {
		return nil, ErrNotCached
	}
	content := raw[recordHeaderSize:]
	contentDigest := sha256.Sum256(content)
	if !bytes.Equal(raw[49:81], contentDigest[:]) {
		return nil, ErrNotCached
	}
	return content, nil
}

// ---------------------------------------------------------------------------------------------------------
// Scan-window cache: persistent, on disk, bounded, verified
// ---------------------------------------------------------------------------------------------------------

type probeEntry struct {
	size     int64
	lastUsed time.Time
	pins     int
}

// ProbeCache survives a restart, which is what makes a second library scan free.
type ProbeCache struct {
	dir        string
	maxTotal   int64
	maxPerItem int64

	mu      sync.Mutex
	entries map[string]*probeEntry
	total   int64
	now     func() time.Time

	Hits     int64
	Misses   int64
	Writes   int64
	Evicts   int64
	Corrupt  int64
	Rejected int64
}

// NewProbeCache opens the cache directory and adopts what survived the last run.
//
// ADOPTION IS STRICT. Only files whose names are exactly a cache-record name are considered, and each is
// opened no-follow: a symlink, a device, a directory or a stray file in the cache directory is removed or
// ignored rather than counted or served. A cache directory is not a place to find a file the daemon did not
// put there.
func NewProbeCache(dir string, maxTotal, maxPerItem int64) (*ProbeCache, error) {
	if maxTotal <= 0 || maxPerItem <= 0 {
		return nil, errors.New("cache bounds must be positive")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	c := &ProbeCache{
		dir: dir, maxTotal: maxTotal, maxPerItem: maxPerItem,
		entries: map[string]*probeEntry{}, now: time.Now,
	}
	items, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		name := item.Name()
		path := filepath.Join(dir, name)
		if !recordNamePattern.MatchString(name) {
			// Includes the `.tmp` leftovers of a write that never completed. They were never visible under a
			// real name, so they are simply removed.
			_ = os.Remove(path)
			c.Rejected++
			continue
		}
		info, err := lstatRegular(path)
		if err != nil {
			_ = os.Remove(path)
			c.Rejected++
			continue
		}
		if info.Size() <= recordHeaderSize || info.Size() > recordHeaderSize+maxPerItem {
			_ = os.Remove(path)
			c.Rejected++
			continue
		}
		c.entries[name] = &probeEntry{size: info.Size(), lastUsed: info.ModTime()}
		c.total += info.Size()
	}
	c.mu.Lock()
	c.evictLocked()
	c.mu.Unlock()
	return c, nil
}

func (c *ProbeCache) SetClock(now func() time.Time) { c.now = now }

// Get returns the cached bytes for a key, or false.
//
// A record that fails any verification is a MISS and is removed. Half of a window served as a whole one, or
// a window whose bytes rotted, is a corrupted read with a media server's trust behind it.
func (c *ProbeCache) Get(key Key, dst []byte) bool {
	if key.Length <= 0 || int64(len(dst)) < key.Length {
		c.countMiss()
		return false
	}
	name := recordName(key)
	c.mu.Lock()
	entry, ok := c.entries[name]
	if ok {
		entry.lastUsed = c.now()
	}
	c.mu.Unlock()
	if !ok {
		c.countMiss()
		return false
	}

	raw, err := readNoFollow(filepath.Join(c.dir, name), recordHeaderSize+c.maxPerItem)
	if err != nil {
		c.removeAndCount(key, false)
		return false
	}
	content, err := decodeRecord(key, raw)
	if err != nil || int64(len(content)) != key.Length {
		c.removeAndCount(key, true)
		return false
	}
	copy(dst, content)
	c.mu.Lock()
	c.Hits++
	c.mu.Unlock()
	return true
}

func (c *ProbeCache) countMiss() {
	c.mu.Lock()
	c.Misses++
	c.mu.Unlock()
}

func (c *ProbeCache) removeAndCount(key Key, corrupt bool) {
	c.Remove(key)
	c.mu.Lock()
	c.Misses++
	if corrupt {
		c.Corrupt++
	}
	c.mu.Unlock()
}

// Put writes a record atomically: a temporary file in the same directory, fsynced, renamed, and then the
// DIRECTORY is fsynced so the rename itself is durable rather than merely visible.
func (c *ProbeCache) Put(key Key, data []byte) error {
	if int64(len(data)) != key.Length || key.Length <= 0 || key.Length > c.maxPerItem {
		return nil
	}
	encoded := encodeRecord(key, data)
	name := recordName(key)
	tmp, err := os.CreateTemp(c.dir, "wip-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		if tmpName != "" {
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := tmp.Write(encoded); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, filepath.Join(c.dir, name)); err != nil {
		return err
	}
	tmpName = ""
	syncDir(c.dir)

	c.mu.Lock()
	defer c.mu.Unlock()
	if existing, ok := c.entries[name]; ok {
		c.total -= existing.size
	}
	c.entries[name] = &probeEntry{size: int64(len(encoded)), lastUsed: c.now()}
	c.total += int64(len(encoded))
	c.Writes++
	c.evictLocked()
	return nil
}

func (c *ProbeCache) Remove(key Key) {
	name := recordName(key)
	c.mu.Lock()
	if entry, ok := c.entries[name]; ok {
		c.total -= entry.size
		delete(c.entries, name)
	}
	c.mu.Unlock()
	_ = os.Remove(filepath.Join(c.dir, name))
	syncDir(c.dir)
}

// Pin marks a record as belonging to an active stream. Pinned records are preferred for retention.
func (c *ProbeCache) Pin(key Key)   { c.adjustPin(key, 1) }
func (c *ProbeCache) Unpin(key Key) { c.adjustPin(key, -1) }

func (c *ProbeCache) adjustPin(key Key, delta int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if entry, ok := c.entries[recordName(key)]; ok {
		entry.pins += delta
		if entry.pins < 0 {
			entry.pins = 0
		}
	}
}

// evictLocked enforces the ceiling.
//
// THE DISK CEILING IS HARD. Unpinned records go first, which is what "active-stream pinning" means in
// practice — but if evicting every unpinned record still leaves the cache over its bound, pinned records are
// evicted too. A pin is a preference, not a licence to fill the disk: an appliance that ran out of space
// because a stream asked it to would be a worse failure than a cache miss.
func (c *ProbeCache) evictLocked() {
	if c.total <= c.maxTotal {
		return
	}
	names := make([]string, 0, len(c.entries))
	for name := range c.entries {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		a, b := c.entries[names[i]], c.entries[names[j]]
		if (a.pins > 0) != (b.pins > 0) {
			return a.pins == 0 // unpinned first
		}
		if !a.lastUsed.Equal(b.lastUsed) {
			return a.lastUsed.Before(b.lastUsed)
		}
		return names[i] < names[j]
	})
	for _, name := range names {
		if c.total <= c.maxTotal {
			return
		}
		entry := c.entries[name]
		c.total -= entry.size
		delete(c.entries, name)
		c.Evicts++
		_ = os.Remove(filepath.Join(c.dir, name))
	}
}

func (c *ProbeCache) TotalBytes() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.total
}

// ---------------------------------------------------------------------------------------------------------
// Playback cache: process-ephemeral, in memory, bounded, and NOT deleted by a handle release
// ---------------------------------------------------------------------------------------------------------

// A playback entry is bytes plus two SEPARABLE facts: when it was last touched, which is what the global
// bound sorts on, and whose admission budget it was charged against, which is what the per-handle bound
// counts.
//
// THE DEFECT THAT SEPARATION CLOSES. Those two used to be one field: an entry BELONGED to the handle that put
// it, and `release` deleted everything that handle had put. Four sequential opens of one object each computed
// the same block — offset 1,048,576, length 2,724,273 — cached it, and had it deleted under them before the
// next open asked; the provider served 4 x 2,724,273 bytes for bytes that had been in memory the whole time.
// The key was never wrong. The entry simply did not outlive the open that produced it.
type playbackEntry struct {
	data     []byte
	lastUsed time.Time
	// owner is the handle whose per-handle ADMISSION budget these bytes are charged against, or 0 for an
	// entry no live handle owns. Zero is INTERNAL STATE, reached only by the release of the admitting handle
	// or by a discharge; `Put` refuses it, so it is never an admission path.
	//
	// OWNERSHIP IS NOT READERSHIP. Any handle may read any entry, because the key is byte identity: bytes
	// that are right for one handle are right for every handle that asks for the same bytes of the same
	// projected version. Ownership decides only whose admission ceiling the entry is charged to and whose
	// eviction it is a first candidate for.
	owner uint64
	// key is carried so an EVICTION can be reported in the same terms as the put that preceded it. Without
	// it the diagnostic could say a block left the cache but not WHICH block, and a summariser would then
	// have to blame the later handle release for a deletion that capacity had already performed.
	key Key
}

// PlaybackCache holds recently read blocks, keyed by exact byte identity, for as long as its bounds allow.
//
// WHAT ITS LIFETIME IS, SAID PRECISELY. It lives in memory, in this process, and nowhere else: a new cache, a
// daemon restart or a crash starts empty, and nothing it holds is ever written to disk. Within one process an
// entry OUTLIVES the release of the handle that admitted it, because bytes identified by what they are rather
// than by who asked for them are still the right bytes for the next open. What ends an entry is memory
// pressure — maxTotal is a hard ceiling and the least recently used entry goes first — never tenure and never
// a release.
type PlaybackCache struct {
	maxTotal     int64
	maxPerHandle int64

	mu      sync.Mutex
	entries map[string]*playbackEntry
	total   int64
	// byHnd is the ADMISSION ledger: for each live handle, how many bytes it has admitted and still owns.
	// It never holds an entry for handle 0, which is the label for "owned by nobody" rather than a handle.
	byHnd map[uint64]int64
	now   func() time.Time

	Hits int64
	// HitBytes is how many bytes were SERVED FROM a hit, cumulatively.
	//
	// WHY A COUNT OF HITS IS NOT ENOUGH. A hit count says how often the cache answered; it cannot say how
	// much it answered with, and the two come apart badly at the sizes that matter — one hit on a 4 MiB
	// demand block and one on a 4 KiB read are the same number. An acceptance gate asking "was this window
	// served by the daemon rather than by something else" needs the volume, not the frequency.
	HitBytes int64
	Misses   int64
	Evicts   int64
	Refused  int64
	// AccountingFaults counts discharges that would have driven a handle's admission balance below zero. It
	// is zero on a correct cache, and it exists because the alternative was worse: the balance is clamped at
	// zero so a fault can never widen a ceiling, and a clamp that absorbed the fault SILENTLY would leave a
	// removal path that discharges twice looking exactly like one that discharges once. That is the class of
	// defect this file has had most often, and it is the one a test cannot see without this.
	AccountingFaults int64

	// OFF UNLESS AN OPERATOR TURNS IT ON. See diagnostic.go: a bounded, secret-free record of which block was
	// fetched, by which handle, when capacity reclaimed it and when a handle was released. Nil means not
	// recording, so the hot path costs one nil check.
	diagnostic *diagnostic
}

func NewPlaybackCache(maxTotal, maxPerHandle int64) *PlaybackCache {
	if maxTotal < 0 {
		maxTotal = 0
	}
	if maxPerHandle < 0 {
		maxPerHandle = 0
	}
	return &PlaybackCache{
		maxTotal: maxTotal, maxPerHandle: maxPerHandle,
		entries: map[string]*playbackEntry{}, byHnd: map[uint64]int64{}, now: time.Now,
		diagnostic: newDiagnosticFromEnv(),
	}
}

// Get takes the REQUESTING handle, not merely the key.
//
// A HIT IS FREE REUSE. The entry is served to whoever matches its key, whatever handle admitted it and
// whether or not that handle still exists. Nothing transfers: the entry keeps its owner, the requesting
// handle's admission ledger is untouched, and a handle that only ever hits spends none of its own ceiling.
// Charging a hit to the reader would turn the per-handle ceiling into a limit on READING rather than on
// adding, so a second open reading blocks a first open had already paid for would evict its own entries to
// pay for them twice — which is the defect this repair exists to end, reintroduced through the ledger.
//
// THE DEFECT THE HANDLE ARGUMENT CLOSES. The diagnostic recorded a miss with handle 0 and a hit with the
// CACHE OWNER's handle, so a sequence of sequential opens all looked like one handle and the per-handle trace
// could not show which open asked for what. A cache lookup is made BY somebody; the instrument has to know
// who.
func (c *PlaybackCache) Get(handle uint64, key Key, dst []byte) bool {
	if key.Length <= 0 || int64(len(dst)) < key.Length {
		c.mu.Lock()
		c.Misses++
		c.diagnostic.record(EventMiss, objectNamespace(key), handle, key.Offset, key.Length)
		c.mu.Unlock()
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key.String()]
	if !ok || int64(len(entry.data)) != key.Length {
		c.Misses++
		c.diagnostic.record(EventMiss, objectNamespace(key), handle, key.Offset, key.Length)
		return false
	}
	entry.lastUsed = c.now()
	copy(dst, entry.data)
	c.Hits++
	c.HitBytes += int64(len(entry.data))
	c.diagnostic.record(EventHit, objectNamespace(key), handle, key.Offset, key.Length)
	return true
}

// Put ADMITS a block into the cache against a handle's own admission budget.
//
// A CHUNK LARGER THAN THE PER-HANDLE CEILING IS REFUSED, not stored after dropping everything else. The
// earlier behaviour dropped the handle's whole cache and then inserted the oversized chunk anyway, which left
// the ceiling violated by exactly the entry that violated it.
//
// THE PER-HANDLE CEILING IS AN ADMISSION CEILING, AND IT IS HARD. One handle may never own more than
// maxPerHandle bytes; when a put would take it past that, its OWN oldest entries are evicted to make room
// before the global budget is consulted at all. Entries another live handle owns are not candidates — that
// would let one stream evict another's working set to fund its own — and neither are unowned entries, which
// belong to the global cache and are reclaimed only by the global bound.
//
// HANDLE 0 IS REFUSED, BECAUSE IT IS THE UNOWNED SENTINEL AND NOT A HANDLE. Admitting under it would store
// bytes that no admission ledger counts — an unbounded side door around maxPerHandle, since every such put
// would be charged to nobody and the per-handle ceiling would bound only callers that named themselves. Being
// unowned is a state an entry REACHES, by the release of the handle that admitted it; it is not a state an
// entry may be admitted in.
func (c *PlaybackCache) Put(handle uint64, key Key, data []byte) {
	if int64(len(data)) != key.Length || key.Length <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	size := int64(len(data))
	if handle == 0 || size > c.maxPerHandle || size > c.maxTotal {
		c.Refused++
		return
	}
	name := key.String()
	if existing, ok := c.entries[name]; ok {
		// A REPLACE IS A REMOVAL FOLLOWED BY AN ADMISSION, through the one door. The previous owner may be a
		// different handle, or none at all if it has since been released; discharging it by hand here is how
		// the two ledgers drifted apart before.
		c.removeLocked(name, existing)
	}
	// Make room within this handle's own budget before spending the global one.
	for c.byHnd[handle]+size > c.maxPerHandle {
		if !c.evictOldestOwnedLocked(handle) {
			break
		}
	}
	stored := make([]byte, size)
	copy(stored, data)
	c.entries[name] = &playbackEntry{data: stored, lastUsed: c.now(), owner: handle, key: key}
	c.total += size
	c.byHnd[handle] += size
	c.diagnostic.record(EventPut, objectNamespace(key), handle, key.Offset, key.Length)
	c.evictLocked()
}

// removeLocked is THE ONLY WAY AN ENTRY LEAVES THE CACHE. Replace, per-handle admission eviction and global
// eviction all go through it, so the global total and the per-handle admission ledger cannot disagree about
// what is present. Every earlier accounting defect in this file came from a second removal path that
// remembered one of the two and forgot the other.
func (c *PlaybackCache) removeLocked(name string, entry *playbackEntry) {
	size := int64(len(entry.data))
	c.total -= size
	c.dischargeOwnershipLocked(entry, size)
	delete(c.entries, name)
}

// dischargeOwnershipLocked returns an entry's bytes to its owner's admission budget and marks it unowned.
//
// AN UNOWNED ENTRY HAS NOTHING TO DISCHARGE, and handle 0 has no ledger row. Decrementing byHnd[0] would
// invent a phantom handle whose balance only ever falls; the clamp below would then absorb every one of those
// decrements as a counted fault, which is the loud form of a bug rather than the quiet one, but the guard is
// what keeps it from being a bug at all.
func (c *PlaybackCache) dischargeOwnershipLocked(entry *playbackEntry, size int64) {
	if entry.owner == 0 {
		return
	}
	remaining := c.byHnd[entry.owner] - size
	if remaining < 0 {
		// IMPOSSIBLE ON A CORRECT CACHE, AND COUNTED RATHER THAN MERELY SURVIVED. Every entry's size is added
		// to its owner's row when it is admitted and taken off exactly once, because removal clears the owner.
		// A negative balance therefore means some path discharged twice; clamping keeps that from widening a
		// ceiling, and the counter keeps it from being invisible.
		c.AccountingFaults++
		remaining = 0
	}
	if remaining == 0 {
		// Zero is the ordinary end of a row, and the row goes rather than lingering.
		delete(c.byHnd, entry.owner)
	} else {
		c.byHnd[entry.owner] = remaining
	}
	entry.owner = 0
}

// evictOldestOwnedLocked evicts the least recently used entry THIS HANDLE OWNS, and reports whether it found
// one. Name breaks a tie, so the choice does not depend on map iteration order or on a clock too coarse to
// separate two puts.
func (c *PlaybackCache) evictOldestOwnedLocked(handle uint64) bool {
	var oldestName string
	var oldest *playbackEntry
	for name, entry := range c.entries {
		if entry.owner != handle {
			continue
		}
		if oldest == nil || entry.lastUsed.Before(oldest.lastUsed) ||
			(entry.lastUsed.Equal(oldest.lastUsed) && name < oldestName) {
			oldestName, oldest = name, entry
		}
	}
	if oldest == nil {
		return false
	}
	c.evictOneLocked(oldestName, oldest)
	return true
}

// evictOneLocked removes an entry AND records it as an eviction, which is the distinction the diagnostic
// exists to draw. The owner and key are read before removal, because removal is what clears the owner.
func (c *PlaybackCache) evictOneLocked(name string, entry *playbackEntry) {
	owner, key := entry.owner, entry.key
	c.removeLocked(name, entry)
	c.Evicts++
	c.diagnostic.record(EventEvict, objectNamespace(key), owner, key.Offset, key.Length)
}

// DropHandle is what `release` calls, and it releases an ACCOUNTING CLAIM rather than bytes.
//
// WHAT IT USED TO DO, AND WHY THAT WAS THE DEFECT. It deleted every entry the handle had put, on the theory
// that the playback cache is a property of an open file and goes when the file does. That is tidy and wrong.
// The entries are keyed by byte identity, so the bytes a released handle cached are precisely the bytes the
// next open of the same object will ask for — and a media server's scan-then-analyse pass is exactly that:
// open, read, release, open again. Deleting on release turned each of those opens into a provider fetch of a
// block that was still in memory a moment earlier.
//
// WHAT IT DOES NOW. Every entry this handle owned becomes UNOWNED — the bytes stay, addressable by exactly
// the key that found them before — and the handle's admission accounting is discharged in full, so a
// departed handle's ceiling is held against nobody. An unowned entry is an ordinary global-LRU candidate,
// which is what bounds the retention: it lives until recency or the hard total ceiling takes it, and no
// longer. Nothing here makes an entry immortal; it makes it outlive one open.
func (c *PlaybackCache) DropHandle(handle uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.dropHandleLocked(handle)
}

func (c *PlaybackCache) dropHandleLocked(handle uint64) {
	c.diagnostic.record(EventDrop, "", handle, 0, 0)
	// Handle 0 already means unowned, so there is nothing to disown and no ledger row to delete. Guarding it
	// keeps "byHnd never has a row for 0" true by construction rather than by luck of the caller.
	if handle == 0 {
		return
	}
	for _, entry := range c.entries {
		if entry.owner == handle {
			entry.owner = 0
		}
	}
	delete(c.byHnd, handle)
}

// evictLocked enforces the GLOBAL ceiling by pure recency.
//
// IT DOES NOT CARE WHO OWNS WHAT. An entry an open handle still owns is as evictable as one nobody owns, and
// for the same reason the probe cache evicts pinned records under its hard bound: a ceiling that yields to a
// stream is not a ceiling, and an appliance that ran out of memory because a handle asked it to would be a
// worse failure than a cache miss. Ownership decides admission, not survival.
func (c *PlaybackCache) evictLocked() {
	if c.total <= c.maxTotal {
		return
	}
	names := make([]string, 0, len(c.entries))
	for name := range c.entries {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		a, b := c.entries[names[i]], c.entries[names[j]]
		if !a.lastUsed.Equal(b.lastUsed) {
			return a.lastUsed.Before(b.lastUsed)
		}
		return names[i] < names[j]
	})
	for _, name := range names {
		if c.total <= c.maxTotal {
			return
		}
		c.evictOneLocked(name, c.entries[name])
	}
}

// PlaybackCounters is what the playback cache did, as a number an operator or an acceptance gate can subtract
// one reading of from another.
//
// EVERY FIELD IS CUMULATIVE EXCEPT TotalBytes, which is a level. That distinction is the whole usefulness of
// the document: a difference of two cumulative readings is what happened BETWEEN them, and a difference of two
// levels is not. A reading whose cumulative fields went DOWN did not come from the same process as the one
// before it, and a caller that subtracts across a restart must be able to see that rather than compute a
// negative and call it zero.
type PlaybackCounters struct {
	Hits       int64 `json:"hits"`
	HitBytes   int64 `json:"hitBytes"`
	Misses     int64 `json:"misses"`
	TotalBytes int64 `json:"totalBytes"`
}

// Counters returns all of them AT ONE MOMENT, under one lock.
//
// WHY A SNAPSHOT RATHER THAN FOUR ACCESSORS. Four separate reads under an active stream return four different
// moments, and a caller that divides bytes by hits, or reasons about the two together at all, would be
// combining numbers that were never simultaneously true. That is the torn-snapshot defect gate9 found in the
// request partition and this file has no business reintroducing at the point the numbers are published.
func (c *PlaybackCache) Counters() PlaybackCounters {
	c.mu.Lock()
	defer c.mu.Unlock()
	return PlaybackCounters{Hits: c.Hits, HitBytes: c.HitBytes, Misses: c.Misses, TotalBytes: c.total}
}

// SetClock replaces the recency clock, so a test can assert WHICH entry the LRU takes rather than hoping the
// wall clock separated two puts. A real clock whose resolution is coarser than a put would leave the order to
// the tie-break, and an eviction test that passes on tie-break order proves nothing about recency.
func (c *PlaybackCache) SetClock(now func() time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = now
}

func (c *PlaybackCache) TotalBytes() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.total
}

// HandleBytes reports how many bytes one handle has ADMITTED AND STILL OWNS, so a test can assert the
// per-handle ceiling directly. It is not how much that handle can read: after a release it is zero while the
// bytes themselves are still cached and still hit.
func (c *PlaybackCache) HandleBytes(handle uint64) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.byHnd[handle]
}
