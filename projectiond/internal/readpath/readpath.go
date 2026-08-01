// Package readpath is the orchestration between a FUSE read and an adapter: block alignment, cross-open
// single-flight, the two caches, classified retry, bounded failover, read-ahead and the absolute deadline.
//
// EVERY READ RETURNS BY ITS DEADLINE. There is no wait here that is not bounded, no goroutine that outlives
// the handle that started it, and no retry that is not counted. A hang is worse than an error.
package readpath

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/cache"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/manifest"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/source"
)

// Config is the read policy, mirrored from PROJECTIOND_READ_POLICY and PROJECTIOND_READAHEAD_POLICY.
type Config struct {
	ReadDeadline      time.Duration
	MaxAttempts       int
	BackoffInitial    time.Duration
	BackoffMax        time.Duration
	BackoffMultiplier int
	ChunkBytes        int64
	ProbeWindowBytes  int64
	// SequentialTriggerReads is how many consecutive in-order reads a handle must show before read-ahead
	// starts. A scanner opens, reads a header and closes; reading ahead for it is pure waste and it is what
	// blows the byte budget.
	SequentialTriggerReads int
	MaxReadaheadBlocks     int
}

func DefaultConfig() Config {
	return Config{
		ReadDeadline:           20 * time.Second,
		MaxAttempts:            3,
		BackoffInitial:         200 * time.Millisecond,
		BackoffMax:             4 * time.Second,
		BackoffMultiplier:      2,
		ChunkBytes:             4 * 1024 * 1024,
		ProbeWindowBytes:       1024 * 1024,
		SequentialTriggerReads: 3,
		MaxReadaheadBlocks:     4,
	}
}

// Validate refuses a configuration that would make the block arithmetic undefined. A zero chunk size is a
// division by zero on the first read; a negative deadline is a read that has already expired.
func (c Config) Validate() error {
	switch {
	case c.ReadDeadline <= 0:
		return errors.New("read deadline must be positive")
	case c.MaxAttempts < 1:
		return errors.New("max attempts must be at least one")
	case c.ChunkBytes <= 0:
		return errors.New("chunk size must be positive")
	case c.ProbeWindowBytes <= 0:
		return errors.New("probe window must be positive")
	case c.BackoffInitial < 0 || c.BackoffMax < 0:
		return errors.New("backoff must not be negative")
	case c.BackoffMultiplier < 1:
		return errors.New("backoff multiplier must be at least one")
	case c.SequentialTriggerReads < 1:
		return errors.New("sequential trigger must be at least one")
	case c.MaxReadaheadBlocks < 0:
		return errors.New("read-ahead blocks must not be negative")
	}
	return nil
}

// Router picks the adapter for a locator. The daemon owns one local adapter and one HTTP adapter per
// configured endpoint; a manifest names an endpoint, it never describes one.
type Router interface {
	AdapterFor(locator source.Locator) (source.Adapter, error)
}

// Stats are the counters the acceptance gates read.
type Stats struct {
	Reads            atomic.Int64
	BlockFetches     atomic.Int64
	SingleFlightJoin atomic.Int64
	ProbeHits        atomic.Int64
	PlaybackHits     atomic.Int64
	Retries          atomic.Int64
	DegradedRejects  atomic.Int64
	ReadaheadBlocks  atomic.Int64
	Failovers        atomic.Int64
	PrefetchDropped  atomic.Int64
}

// Reader is shared by every handle. It holds the caches and the single-flight map, which is what makes the
// flight CROSS-OPEN: twenty separate opens of one file reading the same block produce one fetch.
type Reader struct {
	cfg Config
	// router is swappable only by tests; production sets it once at construction.
	router   Router
	probe    *cache.ProbeCache
	playback *cache.PlaybackCache
	Stats    Stats

	mu     sync.Mutex
	flight map[string]*flightCall
	nextID atomic.Uint64
	sleep  func(context.Context, time.Duration)
	// onFetchComplete is a TEST SEAM, nil in production. It runs on the fetch goroutine after the transport
	// has produced bytes and before they are published, which is the exact window a duplicate fetch could
	// once slip through.
	onFetchComplete func()
}

func NewReader(cfg Config, router Router, probe *cache.ProbeCache, playback *cache.PlaybackCache) (*Reader, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &Reader{
		cfg: cfg, router: router, probe: probe, playback: playback,
		flight: map[string]*flightCall{},
		sleep: func(ctx context.Context, d time.Duration) {
			if d <= 0 {
				return
			}
			timer := time.NewTimer(d)
			defer timer.Stop()
			select {
			case <-timer.C:
			case <-ctx.Done():
			}
		},
	}, nil
}

// flightCall is one shared fetch.
//
// ITS LIFETIME IS REFCOUNTED, not owned by whoever started it. A prefetch may start a fetch that a demand
// read then joins; cancelling the prefetch must not cancel the read, and abandoning a fetch nobody is waiting
// for any more must stop it promptly rather than leaving it holding a limiter slot and pulling provider bytes
// until the read deadline. So the fetch runs under its own context, and that context is cancelled exactly
// when the last participant leaves.
type flightCall struct {
	done   chan struct{}
	data   []byte
	err    error
	ctx    context.Context
	cancel context.CancelFunc

	mu        sync.Mutex
	waiters   int
	abandoned bool
}

// tryJoin adds a participant, unless the flight has already been abandoned.
//
// A CALLER MUST NOT JOIN A CANCELLED FLIGHT. Once the last participant leaves, the fetch is cancelled and
// will fail; a newcomer that joined it anyway would inherit that failure even though nothing was wrong with
// its own request. It starts a fresh flight instead.
func (c *flightCall) tryJoin() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.abandoned {
		return false
	}
	c.waiters++
	return true
}

// leave drops one participant. The fetch is cancelled when the last one goes.
func (c *flightCall) leave() {
	c.mu.Lock()
	c.waiters--
	last := c.waiters <= 0
	if last {
		c.abandoned = true
	}
	c.mu.Unlock()
	if last {
		c.cancel()
	}
}

// Handle is one open file. It pins its generation, its entry and its source, and it keeps its own read-ahead
// state — read-ahead is a property of a stream, not of a file.
type Handle struct {
	ID    uint64
	Entry *manifest.Entry
	// Bound is the source this handle is reading. It moves only under the byte-identity rule below, and its
	// identity fields are captured at open so a swap cannot change what this handle is reading.
	GenerationID     string
	BoundSourceID    string
	SourceGeneration int64
	Inode            uint64
	SizeBytes        int64
	Mtime            time.Time

	identityDigest string

	mu sync.Mutex
	// bound is the index into Entry.Sources currently in use.
	bound int
	// candidates are the source indices this handle may fail over to: only those whose byte-identity proof is
	// identical to the source it opened against.
	candidates []int
	// lastEnd is the end offset of the previous read. Sequentiality is "this read starts where the last one
	// ended", which is what a player does and what a scanner does not.
	lastEnd    int64
	sequential int

	prefetch     chan int64
	prefetchOnce sync.Once
	// prefetchCtx is SEEK-SCOPED. A seek cancels it and installs a fresh one, so an abandoned prefetch stops
	// immediately instead of running to the read deadline. Release cancels it without replacing it.
	prefetchCtx  context.Context
	prefetchStop context.CancelFunc
	// epoch invalidates prefetch results issued before a seek or a release, so a late completion cannot
	// populate the cache for a stream that has moved on.
	epoch      atomic.Uint64
	closed     chan struct{}
	closeOnce  sync.Once
	pinnedKeys []cache.Key
	prefetchWG sync.WaitGroup
}

// Open binds a handle to an exact entry, generation, source, source generation, projected version, inode,
// size and mtime. Everything the handle will ever answer with is captured here.
func (r *Reader) Open(entry *manifest.Entry, generationID string) (*Handle, error) {
	if len(entry.Sources) == 0 {
		return nil, source.Fail(source.CondSourceRefUnknown, source.ClassTerminal, "entry has no source")
	}
	bound := &entry.Sources[0]
	h := &Handle{
		ID:               r.nextID.Add(1),
		Entry:            entry,
		GenerationID:     generationID,
		BoundSourceID:    bound.SourceID,
		SourceGeneration: bound.SourceGeneration,
		Inode:            entry.Inode,
		SizeBytes:        entry.SizeBytes,
		Mtime:            entry.Mtime,
		identityDigest:   identityDigest(entry, bound),
		closed:           make(chan struct{}),
		candidates:       failoverCandidates(entry),
	}
	h.prefetchCtx, h.prefetchStop = context.WithCancel(context.Background())
	return h, nil
}

// currentPrefetchContext returns the live seek-scoped context.
func (h *Handle) currentPrefetchContext() context.Context {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.prefetchCtx
}

// cancelPrefetchLocked stops anything the prefetcher has in flight. Called with h.mu held.
func (h *Handle) cancelPrefetchLocked(replace bool) {
	if h.prefetchStop != nil {
		h.prefetchStop()
	}
	if replace {
		h.prefetchCtx, h.prefetchStop = context.WithCancel(context.Background())
	}
}

// failoverCandidates is the ordered list of sources a handle may move to.
//
// ONLY PROVEN-IDENTICAL SOURCES. Phase 0 permits a mid-handle failover exclusively between sources carrying
// identical byte-identity proof; anything else would hand a player the middle of a different file, silently.
// A single-source entry, or a multi-source entry whose proofs differ, has exactly one candidate — itself —
// and a failure on it is a failure of the read.
func failoverCandidates(entry *manifest.Entry) []int {
	if len(entry.Sources) == 0 {
		return nil
	}
	first := entry.Sources[0].ByteIdentity
	candidates := []int{0}
	if first == nil {
		return candidates
	}
	for i := 1; i < len(entry.Sources); i++ {
		if first.Equal(entry.Sources[i].ByteIdentity) {
			candidates = append(candidates, i)
		}
	}
	return candidates
}

// Release drops the handle's caches and stops its read-ahead. After this returns there is no goroutine and no
// cached byte that belongs to it.
func (r *Reader) Release(h *Handle) {
	if h == nil {
		return
	}
	h.epoch.Add(1)
	h.closeOnce.Do(func() {
		close(h.closed)
		h.mu.Lock()
		h.cancelPrefetchLocked(false)
		h.mu.Unlock()
	})
	// Wait for the prefetch goroutine to actually be gone before reporting the handle released: "no request
	// survives release" is only true if the thing making requests has stopped.
	h.prefetchWG.Wait()
	r.playback.DropHandle(h.ID)
	h.mu.Lock()
	pinned := h.pinnedKeys
	h.pinnedKeys = nil
	h.mu.Unlock()
	for _, key := range pinned {
		r.probe.Unpin(key)
	}
}

// identityDigest folds the immutable byte identity into a cache key component. Without a byte-identity proof
// the size stands in, so a single-source entry is still cacheable and still cannot collide with a different
// stream carrying the same version id.
func identityDigest(entry *manifest.Entry, bound *manifest.Source) string {
	hasher := sha256.New()
	hasher.Write([]byte("projectiond.cacheidentity.v1\n"))
	hasher.Write([]byte(entry.ProjectedVersionID))
	hasher.Write([]byte{0})
	hasher.Write([]byte(strconv.FormatInt(entry.SizeBytes, 10)))
	if bound != nil && bound.ByteIdentity != nil {
		for _, probe := range bound.ByteIdentity.Probes {
			hasher.Write([]byte{0})
			hasher.Write([]byte(probe.Position))
			hasher.Write([]byte(strconv.FormatInt(probe.Offset, 10)))
			hasher.Write([]byte(strconv.FormatInt(probe.Length, 10)))
			hasher.Write([]byte(probe.SHA256))
		}
	}
	return hex.EncodeToString(hasher.Sum(nil))
}

type block struct {
	offset int64
	length int64
	// persistent marks a fixed scan window — head, middle or tail. Everything a metadata pass reads is one of
	// these, which is why a re-scan of an unchanged library costs no provider request at all.
	persistent bool
}

// blockFor decides the fetch unit for an offset.
//
// THE THREE SCAN WINDOWS ARE THEIR OWN BLOCKS. A media server's metadata pass does not only read the first
// megabyte: it reads a header, it reads near the middle, and it reads the tail looking for an index. An
// earlier draft made only `offset < probeWindow` persistent, which meant the middle and tail probes landed in
// ephemeral 4 MiB chunks that were dropped on release — so a second scan re-fetched them and "zero provider
// requests on re-scan" was unachievable by construction.
//
// The windows are exactly the manifest's own fixed probe plan, so they are the same three windows the control
// plane proved byte identity over. Between them, reads fall into ordinary chunk-aligned blocks that never
// straddle a window boundary.
func (r *Reader) blockFor(offset, size int64) block {
	windows := manifest.ProbeOffsetsFor(size)
	// Inside a window: the window itself is the block.
	for _, w := range windows {
		if offset >= w.Offset && offset < w.Offset+w.Length {
			length := w.Length
			if w.Offset+length > size {
				length = size - w.Offset
			}
			return block{offset: w.Offset, length: length, persistent: true}
		}
	}
	// Otherwise: the gap between the surrounding windows, chunked.
	gapStart := int64(0)
	gapEnd := size
	for _, w := range windows {
		end := w.Offset + w.Length
		if end <= offset && end > gapStart {
			gapStart = end
		}
		if w.Offset > offset && w.Offset < gapEnd {
			gapEnd = w.Offset
		}
	}
	index := (offset - gapStart) / r.cfg.ChunkBytes
	start := gapStart + index*r.cfg.ChunkBytes
	length := r.cfg.ChunkBytes
	if start+length > gapEnd {
		length = gapEnd - start
	}
	return block{offset: start, length: length}
}

func (h *Handle) key(b block) cache.Key {
	return cache.Key{
		ProjectedVersionID: h.Entry.ProjectedVersionID,
		IdentityDigest:     h.identityDigest,
		Offset:             b.offset,
		Length:             b.length,
	}
}

// Read fills dst from the handle at offset, returning the number of bytes read.
func (r *Reader) Read(parent context.Context, h *Handle, dst []byte, offset int64) (int, error) {
	r.Stats.Reads.Add(1)

	if offset < 0 {
		return 0, source.Fail(source.CondRangeMismatch, source.ClassTerminal, "negative offset")
	}
	// A DEGRADED ENTRY IS PRESENT AND FAILS FAST, FROM LOCAL STATE, WITH ZERO PROVIDER TRAFFIC. It keeps its
	// inode, its size and its mtime, so a media server sees a file it already knows that happens to be
	// unreadable right now — which it retries — rather than a file that vanished.
	if h.Entry.Visibility == "degraded" {
		r.Stats.DegradedRejects.Add(1)
		return 0, source.Fail(source.CondEntryDegraded, source.ClassTerminal, "")
	}
	if offset >= h.SizeBytes {
		return 0, io.EOF
	}
	// A ZERO-LENGTH READ PRODUCES NOTHING AND RECORDS NOTHING. Letting it reach the sequential bookkeeping
	// would eventually compute blockFor(end-1) with end equal to start, which at offset zero is a negative
	// offset and undefined block arithmetic.
	if len(dst) == 0 {
		return 0, nil
	}

	// THE SEEK IS NOTICED BEFORE THE READ, NOT AFTER IT. Detecting it afterwards meant an abandoned prefetch
	// kept running for as long as the seeking read itself took — which, against a slow source, is the whole
	// read deadline. The offset is known now, so the decision is made now.
	r.noteReadStart(h, offset)

	ctx, cancel := context.WithTimeout(parent, r.cfg.ReadDeadline)
	defer cancel()

	want := int64(len(dst))
	if offset+want > h.SizeBytes {
		want = h.SizeBytes - offset
	}
	written := int64(0)
	for written < want {
		current := offset + written
		b := r.blockFor(current, h.SizeBytes)
		if b.length <= 0 {
			break
		}
		data, err := r.blockBytes(ctx, h, b)
		if err != nil {
			if written > 0 {
				// Some bytes were already produced for this call; hand them back as a SHORT READ rather than
				// discarding them. A short read is a thing every caller already understands.
				r.noteReadEnd(h, offset, offset+written)
				return int(written), nil
			}
			return 0, err
		}
		within := current - b.offset
		if within < 0 || within >= int64(len(data)) {
			return int(written), source.Fail(source.CondRangeMismatch, source.ClassTerminal, "block arithmetic")
		}
		n := int64(copy(dst[written:want], data[within:]))
		if n == 0 {
			break
		}
		written += n
	}

	r.noteReadEnd(h, offset, offset+written)
	return int(written), nil
}

// noteReadStart cancels read-ahead the moment a non-sequential read arrives.
//
// A transcode's probing must not turn into a prefetch of everything it skipped past, and an already-issued
// prefetch must stop holding a limiter slot and pulling provider bytes the instant nobody wants it.
func (r *Reader) noteReadStart(h *Handle, start int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.lastEnd == 0 || start == h.lastEnd || h.sequential == 0 {
		return
	}
	h.sequential = 0
	h.epoch.Add(1)
	h.cancelPrefetchLocked(true)
	r.Stats.PrefetchDropped.Add(1)
}

// noteReadEnd records progress and arms read-ahead.
//
// SEQUENTIAL MEANS "THIS READ STARTS WHERE THE LAST ONE ENDED". An earlier draft compared the END of this
// read to the end of the previous one, which is never equal for a non-empty read — so the counter never
// advanced and read-ahead was dead code that no test noticed, because it silently did nothing.
func (r *Reader) noteReadEnd(h *Handle, start, end int64) {
	h.mu.Lock()
	if h.lastEnd != 0 && start == h.lastEnd {
		h.sequential++
	}
	h.lastEnd = end
	sequential := h.sequential
	h.mu.Unlock()

	if sequential < r.cfg.SequentialTriggerReads || r.cfg.MaxReadaheadBlocks == 0 || end <= 0 {
		return
	}
	current := r.blockFor(end-1, h.SizeBytes)
	next := current.offset + current.length
	if next >= h.SizeBytes {
		return
	}
	h.prefetchOnce.Do(func() {
		h.prefetch = make(chan int64, 1)
		h.prefetchWG.Add(1)
		go r.prefetchLoop(h)
	})
	select {
	case h.prefetch <- next:
	default: // a prefetch is already queued; one outstanding at a time is the bound
	}
}

// prefetchLoop is the ONE goroutine a handle may own. It ends when the handle is released, so the number of
// goroutines is bounded by the number of open files rather than by the number of reads.
func (r *Reader) prefetchLoop(h *Handle) {
	defer h.prefetchWG.Done()
	for {
		select {
		case <-h.closed:
			return
		case start := <-h.prefetch:
			epoch := h.epoch.Load()
			for i := 0; i < r.cfg.MaxReadaheadBlocks; i++ {
				select {
				case <-h.closed:
					return
				default:
				}
				h.mu.Lock()
				stillSequential := h.sequential >= r.cfg.SequentialTriggerReads
				h.mu.Unlock()
				if !stillSequential || start >= h.SizeBytes || h.epoch.Load() != epoch {
					break
				}
				b := r.blockFor(start, h.SizeBytes)
				if b.length <= 0 {
					break
				}
				// The prefetch context is cancelled by Release and by a seek, so an abandoned prefetch stops
				// making requests rather than finishing into a cache nobody wants.
				ctx, cancel := context.WithTimeout(h.currentPrefetchContext(), r.cfg.ReadDeadline)
				_, err := r.blockBytesEpoch(ctx, h, b, epoch)
				cancel()
				if err == nil {
					r.Stats.ReadaheadBlocks.Add(1)
				}
				start = b.offset + b.length
			}
		}
	}
}

// blockBytes is the caching, single-flighting core.
func (r *Reader) blockBytes(ctx context.Context, h *Handle, b block) ([]byte, error) {
	return r.blockBytesEpoch(ctx, h, b, h.epoch.Load())
}

func (r *Reader) blockBytesEpoch(ctx context.Context, h *Handle, b block, epoch uint64) ([]byte, error) {
	key := h.key(b)
	name := key.String()

	buf := make([]byte, b.length)
	if b.persistent {
		if r.probe.Get(key, buf) {
			r.Stats.ProbeHits.Add(1)
			return buf, nil
		}
	} else if r.playback.Get(key, buf) {
		r.Stats.PlaybackHits.Add(1)
		return buf, nil
	}

	// CROSS-OPEN SINGLE-FLIGHT. The key is the byte identity and the block, not the handle, so two different
	// opens of the same file asking for the same block share one fetch.
	r.mu.Lock()
	call, joined := r.flight[name]
	if joined && call.tryJoin() {
		r.mu.Unlock()
		r.Stats.SingleFlightJoin.Add(1)
	} else {
		// Either there was no flight, or the one there had been abandoned by its last participant and is on
		// its way out. Replace it rather than waiting on a fetch that is already cancelled.
		call = &flightCall{done: make(chan struct{}), waiters: 1}
		// The fetch runs under its OWN deadline rather than any one participant's, and is cancelled when the
		// last participant leaves. That is one goroutine per in-flight distinct block: bounded by the kernel's
		// outstanding-request limit plus at most one prefetch per open handle.
		call.ctx, call.cancel = context.WithTimeout(context.Background(), r.cfg.ReadDeadline)
		started := call
		r.flight[name] = call
		r.mu.Unlock()
		go func() {
			data, err := r.fetchWithRetries(started.ctx, h, b)
			if r.onFetchComplete != nil {
				r.onFetchComplete()
			}
			// PUBLISHED BEFORE IT LEAVES THE MAP. An earlier draft deleted the flight, unlocked, and only then
			// let a waiter wake up and populate the cache. A read arriving in that window found neither a
			// flight to join nor a cache to read, and started a duplicate provider request — so "exactly one
			// fetch" held only when nobody arrived at precisely the wrong moment.
			if err == nil {
				r.publish(h, b, key, data)
			}
			started.data, started.err = data, err
			r.mu.Lock()
			// Only remove THIS flight: a newcomer may already have installed a replacement.
			if r.flight[name] == started {
				delete(r.flight, name)
			}
			r.mu.Unlock()
			close(started.done)
		}()
	}

	var data []byte
	var err error
	select {
	case <-call.done:
		data, err = call.data, call.err
	case <-ctx.Done():
		// This participant is gone. If it was the only one, the fetch is cancelled now rather than running on.
		call.leave()
		return nil, source.Fail(source.CondReadDeadline, source.ClassTerminal, "waiting on a shared fetch")
	}
	call.leave()

	if err != nil {
		return nil, err
	}
	// The bytes are already in the cache; what remains is this HANDLE's own pin, which is per-participant
	// rather than per-fetch. A handle that has been released or has seeked away pins nothing.
	select {
	case <-h.closed:
		return data, nil
	default:
	}
	if h.epoch.Load() != epoch {
		r.Stats.PrefetchDropped.Add(1)
		return data, nil
	}
	if b.persistent {
		r.probe.Pin(key)
		h.mu.Lock()
		h.pinnedKeys = append(h.pinnedKeys, key)
		h.mu.Unlock()
	}
	return data, nil
}

// publish puts a completed block in the cache it belongs to.
//
// It runs on the fetch goroutine, BEFORE the flight leaves the map, so there is no instant at which a block
// is neither in flight nor cached. A released handle still publishes to the persistent scan cache — those
// bytes are keyed by byte identity and are useful to everyone — but not to the ephemeral playback cache,
// whose entries belong to a handle that no longer exists.
func (r *Reader) publish(h *Handle, b block, key cache.Key, data []byte) {
	if b.persistent {
		_ = r.probe.Put(key, data)
		return
	}
	select {
	case <-h.closed:
		return
	default:
	}
	r.playback.Put(h.ID, key, data)
}

// fetchWithRetries is the classified retry loop with bounded, proof-gated failover.
//
// ONLY retryable failures are retried on the same source; a terminal classification moves to the next PROVEN
// BYTE-IDENTICAL candidate, and when those run out the read fails. That is how one broken link stays a
// handful of requests instead of becoming a hundred, without ever handing back bytes from a stream nobody
// proved was the same.
func (r *Reader) fetchWithRetries(ctx context.Context, h *Handle, b block) ([]byte, error) {
	h.mu.Lock()
	candidates := append([]int(nil), h.candidates...)
	startAt := h.bound
	h.mu.Unlock()

	// Try the currently bound source first, then the remaining proven-identical candidates in order.
	ordered := make([]int, 0, len(candidates))
	for _, idx := range candidates {
		if idx == startAt {
			ordered = append(ordered, idx)
		}
	}
	for _, idx := range candidates {
		if idx != startAt {
			ordered = append(ordered, idx)
		}
	}

	var last error
	for position, idx := range ordered {
		if idx < 0 || idx >= len(h.Entry.Sources) {
			continue
		}
		src := &h.Entry.Sources[idx]
		data, err := r.fetchFromSource(ctx, h, b, src)
		if err == nil {
			if position > 0 {
				// The handle moves to the source that worked. Its identity fields do not move with it: the
				// bytes are proven identical, so the projected version, inode, size and mtime are unchanged.
				h.mu.Lock()
				h.bound = idx
				h.mu.Unlock()
				r.Stats.Failovers.Add(1)
			}
			return data, nil
		}
		last = err
		failure := source.AsFailure(err)
		if failure.Cond == source.CondReadDeadline || ctx.Err() != nil {
			// The deadline is absolute. Trying another source past it would be a hang wearing a retry's hat.
			return nil, failure
		}
	}
	if last == nil {
		last = source.Fail(source.CondSourceUnreachable, source.ClassTerminal, "")
	}
	return nil, source.AsFailure(last)
}

func (r *Reader) fetchFromSource(ctx context.Context, h *Handle, b block, src *manifest.Source) ([]byte, error) {
	adapter, err := r.router.AdapterFor(locatorOf(src))
	if err != nil {
		return nil, err
	}
	req := source.ReadRequest{
		EntryPath:          h.Entry.Path,
		ProjectedVersionID: h.Entry.ProjectedVersionID,
		SourceID:           src.SourceID,
		SourceGeneration:   src.SourceGeneration,
		SizeBytes:          h.SizeBytes,
		Offset:             b.offset,
		Length:             b.length,
		Locator:            locatorOf(src),
	}
	if failure := req.Valid(make([]byte, b.length)); failure != nil {
		return nil, failure
	}

	backoff := r.cfg.BackoffInitial
	var last error
	for attempt := 0; attempt < r.cfg.MaxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, source.Fail(source.CondReadDeadline, source.ClassTerminal, "")
		}
		buf := make([]byte, b.length)
		r.Stats.BlockFetches.Add(1)
		n, err := adapter.Fetch(ctx, req, buf)
		if err == nil {
			if int64(n) != b.length {
				return nil, source.Fail(source.CondShortBody, source.ClassTerminal, "adapter produced a short block")
			}
			return buf, nil
		}
		last = err
		failure := source.AsFailure(err)
		if failure.Class != source.ClassRetryable {
			return nil, failure
		}
		if attempt == r.cfg.MaxAttempts-1 {
			break
		}
		r.Stats.Retries.Add(1)
		r.sleep(ctx, backoff)
		backoff *= time.Duration(r.cfg.BackoffMultiplier)
		if backoff > r.cfg.BackoffMax {
			backoff = r.cfg.BackoffMax
		}
	}
	if last == nil {
		last = source.Fail(source.CondSourceUnreachable, source.ClassTerminal, "")
	}
	return nil, source.AsFailure(last)
}

func locatorOf(s *manifest.Source) source.Locator {
	return source.Locator{
		Kind:         s.Kind,
		RootID:       s.Locator.RootID,
		RelativePath: s.Locator.RelativePath,
		EndpointID:   s.Locator.EndpointID,
		ObjectRef:    s.Locator.ObjectRef,
	}
}

// ErrNoAdapter is what a Router returns for a locator no configured adapter can serve.
var ErrNoAdapter = errors.New("no adapter configured for this locator")

// BoundSource reports which source index the handle is currently reading, for tests and status.
func (h *Handle) BoundSource() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.bound
}

// Describe is a redaction-safe summary of a handle: counts and identifiers the contract already treats as
// non-secret, never a path or a locator.
func (h *Handle) Describe() string {
	return fmt.Sprintf("handle=%d generation=%s ino=%d size=%d", h.ID, h.GenerationID, h.Inode, h.SizeBytes)
}
