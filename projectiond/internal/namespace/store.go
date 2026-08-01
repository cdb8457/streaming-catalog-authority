package namespace

import (
	"errors"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/manifest"
)

// Snapshot is one admitted generation: its manifest, its digest, and the immutable tree built from it.
type Snapshot struct {
	Manifest *manifest.Manifest
	Digest   string
	Tree     *Tree

	// refs counts the open handles pinned to this generation, plus one for being current.
	refs atomic.Int64
}

func (s *Snapshot) GenerationID() string { return s.Manifest.Generation.GenerationID }
func (s *Snapshot) Sequence() int64      { return s.Manifest.Generation.Sequence }

// Refs is exported for tests and for the status surface: "how many handles still pin this generation".
func (s *Snapshot) Refs() int64 { return s.refs.Load() }

var (
	// ErrArtifactTooLarge is refused before the bytes are parsed, so a hostile artifact cannot be parsed at all.
	ErrArtifactTooLarge = errors.New("manifest artifact exceeds the configured bound")
	// ErrDigestMismatch means the pointer and the artifact disagree. The admitted generation is untouched.
	ErrDigestMismatch = errors.New("manifest artifact does not match the pointer digest")
	// ErrGenerationMismatch means the pointer and the artifact disagree about which generation this is. The
	// digest alone is not enough: a pointer that names generation 9 while carrying generation 4's bytes is a
	// pointer nobody should act on, even though both halves are internally consistent.
	ErrGenerationMismatch = errors.New("pointer and artifact disagree about the generation")
	// ErrSameGenerationDifferentBytes is tampering, or a producer that reused a generation id. Either way the
	// admitted generation is left exactly where it is.
	ErrSameGenerationDifferentBytes = errors.New("a generation already admitted was re-offered with different bytes")
)

// AdmissionResult records exactly what happened, so a refusal can be reported without guessing.
type AdmissionResult struct {
	Admitted   *Snapshot
	Problems   []manifest.Problem
	Err        error
	Succession manifest.Succession
	Digest     string
	// Unchanged is true when the offered artifact is byte-identical to the generation already admitted. It is
	// a no-op, not a refusal: re-reading an unchanged pointer is the normal steady state.
	Unchanged bool
}

func (r AdmissionResult) OK() bool { return r.Err == nil && len(r.Problems) == 0 }

// Store holds the currently admitted generation and every prior generation an open handle still pins.
//
// A GENERATION IS NEVER RECLAIMED WHILE A HANDLE IS READING IT. That is what makes a swap invisible to a
// player: the handle keeps the tree, the entry and the source it opened against, and the new generation only
// affects lookups that start after the swap.
type Store struct {
	// admitMu serializes the WHOLE admission transaction — compare, validate, build and swap. Validating
	// outside it would let two admissions both check themselves against generation n, both conclude they are
	// n+1, and then race to install; the loser's predecessor chain would silently be a lie.
	//
	// It is deliberately a different lock from mu: a long validation must not block a handle release.
	admitMu sync.Mutex

	mu       sync.Mutex
	current  atomic.Pointer[Snapshot]
	retained map[string]*Snapshot
}

func NewStore() *Store {
	return &Store{retained: map[string]*Snapshot{}}
}

// Current returns the admitted generation WITHOUT pinning it. Metadata operations use this: they complete
// before they return, so there is nothing to pin.
func (s *Store) Current() *Snapshot { return s.current.Load() }

// Acquire pins the current generation and returns it.
func (s *Store) Acquire() *Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	snap := s.current.Load()
	if snap == nil {
		return nil
	}
	snap.refs.Add(1)
	return snap
}

// AcquirePinned pins a SPECIFIC snapshot, and reports whether it is still alive.
//
// THIS IS WHAT MAKES AN OPEN ATOMIC WITH ITS LOOKUP. A caller that resolved a node from generation n must pin
// generation n, not "whatever is current by the time open runs" — otherwise the handle would read n's entry
// while claiming n+1, and the two could disagree about the source, the size or the existence of the file.
func (s *Store) AcquirePinned(snap *Snapshot) bool {
	if snap == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current.Load() != snap && s.retained[snap.GenerationID()] != snap {
		return false // already reclaimed; the caller must fall back to the current generation
	}
	snap.refs.Add(1)
	return true
}

// Release drops one pin. When the last pin on a non-current generation goes, the generation is reclaimed.
func (s *Store) Release(snap *Snapshot) {
	if snap == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if snap.refs.Add(-1) > 0 {
		return
	}
	if s.current.Load() == snap {
		return
	}
	delete(s.retained, snap.GenerationID())
}

// Retained lists the prior generations still pinned by at least one handle, in a deterministic order.
func (s *Store) Retained() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.retained))
	for id := range s.retained {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// PointerClaim is what the pointer file asserts about the artifact it names. The artifact has to agree with
// all of it, not just with the digest.
type PointerClaim struct {
	GenerationID string
	Sequence     int64
	Digest       string
}

// Admit runs the whole admission sequence and, only if every check passes, swaps atomically.
//
// A FAILED ADMISSION CHANGES NOTHING. Not the tree, not the current pointer, not a single entry's visibility.
// The daemon goes on serving the last generation it admitted, which is the same thing it does when the
// control plane is unreachable — because from the mount's point of view those are the same event.
func (s *Store) Admit(raw []byte, claim PointerClaim, now time.Time) AdmissionResult {
	// The whole transaction is serialized. Nothing between here and the swap can observe a different
	// predecessor than the one it validated against.
	s.admitMu.Lock()
	defer s.admitMu.Unlock()

	if len(raw) > manifest.MaxArtifactBytes {
		return AdmissionResult{Err: ErrArtifactTooLarge}
	}
	digest := manifest.DigestOfBytes(raw)
	if claim.Digest != "" && claim.Digest != digest {
		return AdmissionResult{Err: ErrDigestMismatch, Digest: digest}
	}

	previous := s.current.Load()
	if previous != nil {
		// STEADY STATE IS A NO-OP, NOT A REFUSAL. Re-reading an unchanged pointer is what the poll loop does
		// every few seconds; running it through succession would fail SUCCESSION_SEQUENCE_NOT_NEXT and log a
		// refusal forever.
		if previous.Digest == digest {
			return AdmissionResult{Digest: digest, Unchanged: true, Admitted: previous}
		}
		// ...but the same generation with DIFFERENT bytes is not steady state, it is tampering or a producer
		// reusing an id, and it is refused rather than admitted as a successor.
		if claim.GenerationID != "" && claim.GenerationID == previous.GenerationID() {
			return AdmissionResult{Err: ErrSameGenerationDifferentBytes, Digest: digest}
		}
	}

	parsed, problems := manifest.Parse(raw)
	if len(problems) > 0 {
		return AdmissionResult{Problems: problems, Digest: digest}
	}
	// The pointer's own claims are checked against the artifact it named. A pointer that says "generation 9,
	// sequence 12" while carrying generation 4 is not something to act on.
	if claim.GenerationID != "" && claim.GenerationID != parsed.Generation.GenerationID {
		return AdmissionResult{Err: ErrGenerationMismatch, Digest: digest}
	}
	if claim.Sequence != 0 && claim.Sequence != parsed.Generation.Sequence {
		return AdmissionResult{Err: ErrGenerationMismatch, Digest: digest}
	}

	result := AdmissionResult{Digest: digest}
	if previous != nil {
		if previous.GenerationID() == parsed.Generation.GenerationID {
			result.Err = ErrSameGenerationDifferentBytes
			return result
		}
		result.Succession = manifest.ValidateSuccession(
			manifest.Admitted{Manifest: previous.Manifest, ManifestDigest: previous.Digest}, parsed, now)
		if !result.Succession.OK() {
			result.Problems = result.Succession.Problems
			return result
		}
	}

	tree, treeProblems := Build(parsed)
	if len(treeProblems) > 0 {
		result.Problems = treeProblems
		return result
	}

	snap := &Snapshot{Manifest: parsed, Digest: digest, Tree: tree}
	snap.refs.Store(1) // the pin for being current

	s.mu.Lock()
	old := s.current.Load()
	s.current.Store(snap)
	if old != nil {
		// Drop the "is current" pin. If a handle still holds one, the generation is retained until it goes.
		if old.refs.Add(-1) > 0 {
			s.retained[old.GenerationID()] = old
		}
	}
	s.mu.Unlock()

	result.Admitted = snap
	return result
}
