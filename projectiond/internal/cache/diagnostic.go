package cache

import (
	"crypto/sha256"
	"fmt"
	"os"
	"sync"
)

// AN OPT-IN, BOUNDED, SECRET-FREE RECORD OF WHY A BLOCK WAS FETCHED TWICE.
//
// WHAT QUESTION IT EXISTS TO SETTLE. gate9 measured one 8,594,275-byte object served 38,561,281 bytes during
// a single library scan — 4.487x its own length — as thirteen clipped-block responses of 2,724,273 bytes.
// Two explanations fit that shape and they call for opposite repairs:
//
//	CHANGING GEOMETRY   the same region is requested with DIFFERENT (offset, length) each time, so every
//	                    request is a new cache key and the cache never had a chance to hit. The repair would
//	                    be in how a block is computed.
//	STABLE-KEY REFETCH  the same (offset, length) is requested every time, cached, and then DELETED before
//	                    the next open, so the key is right and the entry does not survive. The repair would
//	                    be in cache lifetime, not geometry.
//
// Aggregate counters cannot separate those: both produce N misses and N fetches. Distinguishing them needs
// the (offset, length) of each miss and the handle it belonged to, which is exactly what this records.
//
// THE ANSWER IT RETURNED, AND WHY IT IS STILL HERE. Driven through the real Reader, four sequential
// Open/Read/Release cycles produced one geometry — offset 1,048,576, length 2,724,273, four times — with a
// drop-handle between every pair. STABLE-KEY REFETCH, decided by measurement rather than by argument. The
// repair went into cache lifetime: `DropHandle` now discharges a handle's admission accounting and leaves the
// bytes addressable. This instrument stays because it is the only thing that can tell a REGRESSION of that
// repair from a change in the block plan, and those still call for opposite fixes. Against the repaired
// daemon `RefetchesAfterRelease` is zero; a nonzero value is the defect returning.
//
// WHY IT IS OFF BY DEFAULT. It keeps a per-event record, and this repository's standing rule is that the
// default telemetry surface holds cumulative counters and nothing per-request. This is a debugging
// instrument for a named question, enabled deliberately by an operator who is asking it.
//
// WHAT IT DELIBERATELY DOES NOT HOLD. No object reference, no URL, no lease, no access material, no
// timestamp and no byte contents. An object appears as a small ordinal assigned in the order the cache first
// saw it, which groups events by object without naming one.
//
// AND WHAT IT HOLDS INTERNALLY, SAID PRECISELY, BECAUSE AN EARLIER VERSION OF THIS PARAGRAPH OVERSTATED IT.
// Assigning that ordinal needs a stable per-object map key. It is NOT the identity digest: the digest is
// hashed once, on the way in, and only the first eight bytes of that hash are retained. The recorder
// therefore never stores the digest, the map cannot be read back into one, and no event ever carries either.
// A truncated one-way tag can collide in principle; a collision would merge two objects into one ordinal,
// which makes the summary less specific and never leaks anything.
//
// Offsets and lengths ARE recorded, because the question is about geometry and cannot be answered without
// them; they describe the daemon own block plan, derived from the manifest, and are not secret.
//
// WHY IT IS BOUNDED, AND WHAT HAPPENS WHEN IT FILLS. A ring of a fixed number of events with a dropped
// count. An unbounded log attached to a read path is a memory leak with a diagnostic label on it, and one
// that silently truncates is worse than one that says how much it lost.

// cacheDiagnosticEnv is the variable that turns it on. Any value other than empty or "0" enables it.
const cacheDiagnosticEnv = "PROJECTIOND_CACHE_DIAGNOSTIC"

// diagnosticCapacity is the ring size. Large enough to hold a whole library scan's misses for a handful of
// objects, small enough that leaving it enabled cannot exhaust anything.
const diagnosticCapacity = 4096

// diagnosticObjectLimit caps how many DISTINCT objects get an ordinal. Beyond it, events are recorded with
// object -1: still useful for counting, and it keeps the map from growing with the library.
const diagnosticObjectLimit = 256

// EventKind is what happened to a block.
type EventKind string

const (
	EventHit   EventKind = "hit"
	EventMiss  EventKind = "miss"
	EventPut   EventKind = "put"
	EventDrop  EventKind = "drop-handle"
	EventEvict EventKind = "evict"
)

// Event is one cache decision, in the terms the question needs and no others.
type Event struct {
	Seq int64 `json:"seq"`
	// Object is an ordinal assigned in the order this cache first saw the identity, or -1 past the limit.
	// It groups events by object without naming one.
	Object int       `json:"object"`
	Kind   EventKind `json:"kind"`
	Handle uint64    `json:"handle"`
	Offset int64     `json:"offset"`
	Length int64     `json:"length"`
}

// diagnostic is the recorder. A nil *diagnostic records nothing, which is how "off" is implemented: no
// branch in the hot path beyond a nil check.
type diagnostic struct {
	mu      sync.Mutex
	events  []Event
	next    int
	seq     int64
	dropped int64
	objects map[string]int
}

func newDiagnosticFromEnv() *diagnostic {
	value := os.Getenv(cacheDiagnosticEnv)
	if value == "" || value == "0" {
		return nil
	}
	return &diagnostic{
		events:  make([]Event, 0, diagnosticCapacity),
		objects: map[string]int{},
	}
}

// record appends one event. `namespace` is the cache key's OBJECT-LEVEL namespace — projected version and
// identity digest — and is used ONLY to derive a one-way ordinal tag. It is never stored in an event, never
// retained in reversible form, and never leaves this struct.
func (d *diagnostic) record(kind EventKind, namespace string, handle uint64, offset, length int64) {
	if d == nil {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()

	// AN EVENT WITH NO IDENTITY IS NOT AN OBJECT. A handle release is about a handle; giving it an ordinal
	// would spend one of the limited slots on nothing and put an empty tag in the table.
	object := -1
	if namespace != "" {
		tag := identityTag(namespace)
		known := false
		if object, known = d.objects[tag]; !known {
			if len(d.objects) >= diagnosticObjectLimit {
				object = -1
			} else {
				object = len(d.objects)
				d.objects[tag] = object
			}
		}
	}

	d.seq++
	event := Event{Seq: d.seq, Object: object, Kind: kind, Handle: handle, Offset: offset, Length: length}
	if len(d.events) < diagnosticCapacity {
		d.events = append(d.events, event)
		return
	}
	// FULL: overwrite the oldest and say so. A ring that silently forgets its beginning would make a
	// sequence of events look like it started later than it did, which is the one thing this must not do.
	d.dropped++
	d.events[d.next] = event
	d.next = (d.next + 1) % diagnosticCapacity
}

// snapshot returns the events in the order they happened, oldest first, plus how many were dropped.
func (d *diagnostic) snapshot() ([]Event, int64) {
	if d == nil {
		return nil, 0
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]Event, 0, len(d.events))
	if len(d.events) < diagnosticCapacity {
		out = append(out, d.events...)
	} else {
		out = append(out, d.events[d.next:]...)
		out = append(out, d.events[:d.next]...)
	}
	return out, d.dropped
}

// DiagnosticEvents returns the recorded events oldest first and the number dropped to the ring's bound.
// It returns nothing at all when the diagnostic is off, which is the default.
func (c *PlaybackCache) DiagnosticEvents() ([]Event, int64) {
	return c.diagnostic.snapshot()
}

// DiagnosticEnabled reports whether the diagnostic is recording, so a caller can say "off" rather than
// report an empty list as though it were an observation.
func (c *PlaybackCache) DiagnosticEnabled() bool {
	return c.diagnostic != nil
}

// Summary is what the events add up to, in the terms the question needs.
//
// A REFETCH AFTER RELEASE is a miss for an (object, offset, length) that had ALREADY been cached under a
// handle which was released in between. Counting those separated the two hypotheses when the question was
// open: if they dominate, the key was stable and the entry did not survive; if instead the misses carry
// lengths that keep changing for the same offset, the geometry is moving.
type Summary struct {
	// RefetchesAfterRelease counts misses for a block that was cached under a handle which was then RELEASED.
	//
	// A RELEASE NO LONGER DELETES ANYTHING, so on a correct daemon this is zero: the block is still there and
	// the second open hits it. It is kept, and kept named for the release, because it is the exact signature
	// of the defect that was repaired — bytes that stopped being reachable across a handle boundary — and the
	// only way to tell that regression from a moving block plan. Evictions are excluded; see below.
	RefetchesAfterRelease int `json:"refetchesAfterRelease"`
	// RefetchesAfterEviction counts the same shape where CAPACITY removed the block first. It is reported
	// separately because the repair differs: eviction pressure is a sizing question, release is a lifetime
	// question, and blaming one for the other sends the fix to the wrong place.
	RefetchesAfterEviction int `json:"refetchesAfterEviction"`
	// DistinctBlocks is how many (object, offset, length) triples were ever cached.
	DistinctBlocks int `json:"distinctBlocks"`
	// LengthsPerObjectOffset maps "object:offset" to how many DIFFERENT lengths were requested there.
	//
	// KEYED BY OBJECT AND OFFSET, NOT OFFSET ALONE. Two objects of different sizes legitimately have
	// different block lengths at the same offset, and aggregating across them would report moving geometry
	// where there is none. An earlier version did exactly that.
	LengthsPerObjectOffset map[string]int `json:"lengthsPerObjectOffset"`
	// UninterpretableEvents counts BLOCK events — miss, hit, put, evict — that arrived past the ordinal
	// limit and so carry the shared -1 label. They are EXCLUDED from every grouping above.
	//
	// A HANDLE RELEASE IS NOT ONE OF THEM. A drop carries no identity by design, so its -1 is not overflow;
	// it is a control event that marks its handle released and is counted nowhere. Counting it made every
	// ordinary release declare the report non-exhaustive.
	//
	// IT COUNTS EVENTS, NOT OBJECTS, AND THE EARLIER NAME WAS A LIE. "-1" is many distinct objects wearing
	// one label; the recorder cannot say how many, so a field claiming to count them would be inventing a
	// number. Worse, treating -1 as a group let unrelated overflow objects collide in the block maps and be
	// reported as refetches of each other — a false finding, in the direction of alarm.
	UninterpretableEvents int `json:"uninterpretableEvents"`
}

// Report is one coherent capture: the events, what the ring lost, and the summary DERIVED FROM THOSE EXACT
// EVENTS rather than from a second look at a moving recorder.
type Report struct {
	Enabled bool    `json:"enabled"`
	Events  []Event `json:"events"`
	Dropped int64   `json:"dropped"`
	// Complete is false when the ring lost events. A summary computed over a truncated window is still
	// useful, but it is not exhaustive, and a reader who cannot tell the difference will read a missing
	// refetch as evidence that none happened.
	Complete bool    `json:"complete"`
	Summary  Summary `json:"summary"`
}

// DiagnosticReport captures everything ONCE.
//
// THE DEFECT THIS CLOSES, AND IT IS THE ONE gate9 TAUGHT, REPEATED IN NEW CODE. The endpoint called
// DiagnosticEvents and Summarise separately, so under an active read it could return events from one moment
// and a summary from another — a torn snapshot, exactly the shape that made the request partition fail.
func (c *PlaybackCache) DiagnosticReport() Report {
	events, dropped := c.DiagnosticEvents()
	summary := summariseEvents(events)
	return Report{
		Enabled: c.DiagnosticEnabled(),
		Events:  events,
		Dropped: dropped,
		// COMPLETE MEANS THE SUMMARY IS EXHAUSTIVE, WHICH NEEDS BOTH THINGS. A ring that lost events is the
		// obvious way to be incomplete; ordinal overflow is the quiet one, where every event was retained
		// but some could not be grouped and so took part in no arithmetic.
		Complete: dropped == 0 && summary.UninterpretableEvents == 0,
		Summary:  summary,
	}
}

// Summarise reduces the CURRENT events to the answer. Prefer DiagnosticReport when the events themselves are
// wanted too, so the two cannot come from different moments.
func (c *PlaybackCache) Summarise() Summary {
	events, _ := c.DiagnosticEvents()
	return summariseEvents(events)
}

// summariseEvents works on exactly the slice it is handed, distinguishing release from eviction.
func summariseEvents(events []Event) Summary {
	type block struct {
		object int
		offset int64
		length int64
	}
	cachedBy := map[block]uint64{}
	evicted := map[block]bool{}
	dropped := map[uint64]bool{}
	seen := map[block]bool{}
	lengths := map[string]map[int64]bool{}
	summary := Summary{LengthsPerObjectOffset: map[string]int{}}

	for _, event := range events {
		// OVERFLOW AND IDENTITY-FREE EVENTS TAKE PART IN NOTHING EXCEPT THE HANDLE LEDGER.
		//
		// A drop still has to mark its handle released — that is what a drop MEANS, now that it means the
		// handle's admission was discharged rather than that its bytes were deleted — but an event whose
		// object is -1 must never enter the block maps, because -1 is a label shared by every object past
		// the ordinal limit and two unrelated ones would then look like the same block.
		// A HANDLE RELEASE CARRIES NO IDENTITY BY DESIGN, so its -1 is not overflow and must not be counted
		// as unreadable data. Counting it made every ordinary release declare the report non-exhaustive,
		// which would train a reader to ignore the one flag that says the summary is incomplete.
		if event.Kind == EventDrop {
			dropped[event.Handle] = true
			continue
		}
		// A BLOCK EVENT at -1 is genuinely ungroupable: past the ordinal limit, where the label is shared by
		// every object beyond it. It takes part in nothing.
		if event.Object < 0 {
			summary.UninterpretableEvents++
			continue
		}
		key := block{event.Object, event.Offset, event.Length}
		switch event.Kind {
		case EventPut:
			cachedBy[key] = event.Handle
			delete(evicted, key)
			seen[key] = true
		case EventEvict:
			// CAPACITY REMOVED IT. The block is no longer cached, and a later miss must not be charged to
			// the handle release that happens afterwards — the entry was already gone.
			evicted[key] = true
			delete(cachedBy, key)
		case EventDrop:
			dropped[event.Handle] = true
		case EventMiss:
			shape := fmt.Sprintf("%d:%d", event.Object, event.Offset)
			if lengths[shape] == nil {
				lengths[shape] = map[int64]bool{}
			}
			lengths[shape][event.Length] = true
			if evicted[key] {
				summary.RefetchesAfterEviction++
				continue
			}
			if owner, wasCached := cachedBy[key]; wasCached && dropped[owner] {
				summary.RefetchesAfterRelease++
			}
		}
	}
	summary.DistinctBlocks = len(seen)
	for shape, set := range lengths {
		summary.LengthsPerObjectOffset[shape] = len(set)
	}
	return summary
}

// objectNamespace is the OBJECT-LEVEL part of a cache key: everything Key.String() distinguishes except the
// block geometry.
//
// THE DEFECT THIS CLOSES. The ordinal was assigned from IdentityDigest alone, but a PlaybackCache entry is
// keyed on ProjectedVersionID AND IdentityDigest. Two entries with the same byte digest under different
// projected versions are DIFFERENT cache entries — they never share storage — yet the diagnostic gave them
// one ordinal. A miss on version B for a block that version A had cached and released would then be counted
// as a stable-key refetch after release, which is a false finding in the direction of alarm, about the very
// mechanism this instrument exists to establish.
//
// The NUL separator keeps the two fields from running together: without it, ("ab", "c") and ("a", "bc")
// would produce the same namespace.
func objectNamespace(key Key) string {
	return key.ProjectedVersionID + "\x00" + key.IdentityDigest
}

// identityTag is the one-way, truncated map key the ordinal table is built on.
//
// The recorder needs something stable per object to hand out ordinals against. Using the namespace itself
// would mean the recorder RETAINED the projected version id and the identity digest, which is a larger claim
// on operator trust than a debugging instrument should make. Hashing it and keeping eight bytes gives the
// same grouping with nothing reversible held: the table cannot be turned back into either value, and no
// event carries either.
func identityTag(namespace string) string {
	sum := sha256.Sum256([]byte(namespace))
	return string(sum[:8])
}
