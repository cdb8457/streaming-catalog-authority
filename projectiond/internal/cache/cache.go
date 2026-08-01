// Package cache holds the two caches the read path uses. They are deliberately different, because they
// answer two different questions.
//
// THE SCAN-WINDOW CACHE is small, persistent and per projected version. It holds the fixed head, middle and
// tail windows a media server's metadata pass reads, so a re-scan of an unchanged library costs zero provider
// requests.
//
// THE PLAYBACK CACHE is ephemeral, memory-bounded and dropped on release. It exists to make sequential
// playback smooth, not to store anybody's library on the appliance's disk.
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
// Playback cache: ephemeral, in memory, bounded, dropped on release
// ---------------------------------------------------------------------------------------------------------

type playbackEntry struct {
	data     []byte
	lastUsed time.Time
	handle   uint64
}

// PlaybackCache holds recently read chunks for open handles. It is not persisted and it does not outlive the
// handles that filled it.
type PlaybackCache struct {
	maxTotal     int64
	maxPerHandle int64

	mu      sync.Mutex
	entries map[string]*playbackEntry
	total   int64
	byHnd   map[uint64]int64
	now     func() time.Time

	Hits    int64
	Misses  int64
	Evicts  int64
	Refused int64
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
	}
}

func (c *PlaybackCache) Get(key Key, dst []byte) bool {
	if key.Length <= 0 || int64(len(dst)) < key.Length {
		c.mu.Lock()
		c.Misses++
		c.mu.Unlock()
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key.String()]
	if !ok || int64(len(entry.data)) != key.Length {
		c.Misses++
		return false
	}
	entry.lastUsed = c.now()
	copy(dst, entry.data)
	c.Hits++
	return true
}

// Put stores a chunk for a handle.
//
// A CHUNK LARGER THAN THE PER-HANDLE CEILING IS REFUSED, not stored after dropping everything else. The
// earlier behaviour dropped the handle's whole cache and then inserted the oversized chunk anyway, which left
// the ceiling violated by exactly the entry that violated it.
func (c *PlaybackCache) Put(handle uint64, key Key, data []byte) {
	if int64(len(data)) != key.Length || key.Length <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	size := int64(len(data))
	if size > c.maxPerHandle || size > c.maxTotal {
		c.Refused++
		return
	}
	name := key.String()
	if existing, ok := c.entries[name]; ok {
		c.total -= int64(len(existing.data))
		c.byHnd[existing.handle] -= int64(len(existing.data))
		delete(c.entries, name)
	}
	// Make room within this handle's own budget before spending the global one.
	for c.byHnd[handle]+size > c.maxPerHandle {
		if !c.evictOldestForHandleLocked(handle) {
			break
		}
	}
	stored := make([]byte, size)
	copy(stored, data)
	c.entries[name] = &playbackEntry{data: stored, lastUsed: c.now(), handle: handle}
	c.total += size
	c.byHnd[handle] += size
	c.evictLocked()
}

func (c *PlaybackCache) evictOldestForHandleLocked(handle uint64) bool {
	var oldestName string
	var oldest *playbackEntry
	for name, entry := range c.entries {
		if entry.handle != handle {
			continue
		}
		if oldest == nil || entry.lastUsed.Before(oldest.lastUsed) {
			oldestName, oldest = name, entry
		}
	}
	if oldest == nil {
		return false
	}
	c.total -= int64(len(oldest.data))
	c.byHnd[handle] -= int64(len(oldest.data))
	delete(c.entries, oldestName)
	c.Evicts++
	return true
}

// DropHandle is what `release` calls. The playback cache is a property of an open file, and it goes when the
// file does.
func (c *PlaybackCache) DropHandle(handle uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.dropHandleLocked(handle)
}

func (c *PlaybackCache) dropHandleLocked(handle uint64) {
	for name, entry := range c.entries {
		if entry.handle == handle {
			c.total -= int64(len(entry.data))
			delete(c.entries, name)
		}
	}
	delete(c.byHnd, handle)
}

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
		entry := c.entries[name]
		c.total -= int64(len(entry.data))
		c.byHnd[entry.handle] -= int64(len(entry.data))
		delete(c.entries, name)
		c.Evicts++
	}
}

func (c *PlaybackCache) TotalBytes() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.total
}

// HandleBytes reports one handle's current usage, so a test can assert the per-handle ceiling directly.
func (c *PlaybackCache) HandleBytes(handle uint64) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.byHnd[handle]
}
