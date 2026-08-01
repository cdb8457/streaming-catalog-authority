package namespace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/manifest"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	dir, err := filepath.Abs(filepath.Join("..", "..", "..", "test", "fixtures", "projection-manifest-v1"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return raw
}

func claimFor(t *testing.T, raw []byte) PointerClaim {
	t.Helper()
	parsed, problems := manifest.Parse(raw)
	if len(problems) > 0 {
		t.Fatalf("fixture does not parse: %v", manifest.Codes(problems))
	}
	return PointerClaim{
		GenerationID: parsed.Generation.GenerationID,
		Sequence:     parsed.Generation.Sequence,
		Digest:       manifest.DigestOfBytes(raw),
	}
}

func admitBaseline(t *testing.T) (*Store, []byte) {
	t.Helper()
	store := NewStore()
	raw := fixture(t, "generation-1-baseline.json")
	result := store.Admit(raw, claimFor(t, raw), time.Now())
	if !result.OK() {
		t.Fatalf("baseline admission failed: %v %v", manifest.Codes(result.Problems), result.Err)
	}
	return store, raw
}

// REGRESSION: two concurrent admissions based on the same predecessor must not both install.
//
// The whole compare/validate/build/swap transaction is serialized. Before it was, both could validate
// themselves as n+1 against generation n and then race to store — and the loser's predecessor chain would
// have been a lie the store had already accepted.
func TestConcurrentAdmissionsCannotBothWin(t *testing.T) {
	store, _ := admitBaseline(t)
	successor := fixture(t, "generation-2-routine-successor.json")
	claim := claimFor(t, successor)

	const racers = 8
	var wg sync.WaitGroup
	results := make([]AdmissionResult, racers)
	start := make(chan struct{})
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			results[index] = store.Admit(successor, claim, time.Now())
		}(i)
	}
	close(start)
	wg.Wait()

	installs, unchanged := 0, 0
	for _, result := range results {
		switch {
		case result.Unchanged:
			unchanged++
		case result.OK() && result.Admitted != nil:
			installs++
		}
	}
	if installs != 1 {
		t.Fatalf("exactly one admission may install the successor, got %d (unchanged=%d)", installs, unchanged)
	}
	if unchanged != racers-1 {
		t.Fatalf("every loser must see the steady state, got %d", unchanged)
	}
	if store.Current().Sequence() != 2 {
		t.Fatalf("the chain must be at sequence 2, got %d", store.Current().Sequence())
	}
}

// REGRESSION: a chain cannot regress. An older generation offered after a newer one is refused.
func TestChainCannotRegress(t *testing.T) {
	store, baseline := admitBaseline(t)
	successor := fixture(t, "generation-2-routine-successor.json")
	if !store.Admit(successor, claimFor(t, successor), time.Now()).OK() {
		t.Fatal("successor should admit")
	}
	result := store.Admit(baseline, claimFor(t, baseline), time.Now())
	if result.OK() {
		t.Fatal("re-offering the older generation must be refused")
	}
	if store.Current().Sequence() != 2 {
		t.Fatal("a refusal must leave the admitted generation exactly where it was")
	}
}

// REGRESSION: an unchanged pointer is a NO-OP, not a refusal. The poll loop reads it every few seconds; if it
// ran through succession it would fail SUCCESSION_SEQUENCE_NOT_NEXT and log forever.
func TestUnchangedArtifactIsANoOp(t *testing.T) {
	store, raw := admitBaseline(t)
	claim := claimFor(t, raw)
	for i := 0; i < 50; i++ {
		result := store.Admit(raw, claim, time.Now())
		if !result.Unchanged {
			t.Fatalf("poll %d should be a no-op, got problems=%v err=%v", i, manifest.Codes(result.Problems), result.Err)
		}
		if len(result.Problems) != 0 || result.Err != nil {
			t.Fatal("a no-op must not report a refusal")
		}
	}
}

// ...but the SAME generation with DIFFERENT bytes is tampering, and is refused rather than admitted.
func TestSameGenerationDifferentBytesIsRefused(t *testing.T) {
	store, raw := admitBaseline(t)
	var generic map[string]any
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatal(err)
	}
	// Change something harmless so the bytes differ while the generation id does not.
	generic["generation"].(map[string]any)["provenance"].(map[string]any)["producerVersion"] = "9.9.9"
	tampered, err := json.Marshal(generic)
	if err != nil {
		t.Fatal(err)
	}
	claim := claimFor(t, raw)
	claim.Digest = manifest.DigestOfBytes(tampered)
	result := store.Admit(tampered, claim, time.Now())
	if result.Err == nil {
		t.Fatal("a reused generation id with different bytes must be refused")
	}
	if store.Current().Digest != manifest.DigestOfBytes(raw) {
		t.Fatal("the admitted generation must be untouched")
	}
}

func TestPointerGenerationMustMatchTheArtifact(t *testing.T) {
	store := NewStore()
	raw := fixture(t, "generation-1-baseline.json")
	claim := claimFor(t, raw)
	claim.Sequence = 12
	result := store.Admit(raw, claim, time.Now())
	if result.Err == nil {
		t.Fatal("a pointer that disagrees with its artifact about the sequence must be refused")
	}
	if store.Current() != nil {
		t.Fatal("nothing may be admitted from a mismatched pointer")
	}
}

// REGRESSION: directory metadata is generation-independent.
//
// A derived directory used to inherit the mtime of whichever entry happened to need it first, so reordering
// the manifest, adding a different first child or deleting that child moved a directory's mtime while its
// path was unchanged. Media servers re-scan on directory mtime, so that is a churn generator.
func TestDirectoryMetadataIsStableAcrossReorderAndSwap(t *testing.T) {
	raw := fixture(t, "generation-1-baseline.json")
	parsed, problems := manifest.Parse(raw)
	if len(problems) > 0 {
		t.Fatalf("%v", manifest.Codes(problems))
	}
	first, treeProblems := Build(parsed)
	if len(treeProblems) > 0 {
		t.Fatalf("%v", manifest.Codes(treeProblems))
	}

	// Reverse the entry order. Every directory must report exactly the same inode and mtime.
	reordered := *parsed
	reordered.Entries = make([]manifest.Entry, len(parsed.Entries))
	for i, entry := range parsed.Entries {
		reordered.Entries[len(parsed.Entries)-1-i] = entry
	}
	second, treeProblems := Build(&reordered)
	if len(treeProblems) > 0 {
		t.Fatalf("%v", manifest.Codes(treeProblems))
	}

	for path, node := range first.ByPath {
		if !node.IsDir {
			continue
		}
		other, ok := second.ByPath[path]
		if !ok {
			t.Fatalf("directory %q disappeared when the entries were reordered", path)
		}
		if other.Ino != node.Ino {
			t.Fatalf("directory %q changed inode on reorder", path)
		}
		if !other.Mtime.Equal(node.Mtime) {
			t.Fatalf("directory %q changed mtime on reorder: %v vs %v", path, node.Mtime, other.Mtime)
		}
		if !node.Mtime.Equal(DirectoryEpoch) {
			t.Fatalf("directory %q does not carry the fixed epoch", path)
		}
	}
	if !first.Root.Mtime.Equal(DirectoryEpoch) {
		t.Fatal("the mount root must carry the fixed epoch too")
	}
	if first.Root.Mtime.Unix() < 0 {
		t.Fatal("a negative epoch would convert to an absurd unsigned timestamp")
	}

	// And across a real generation swap, with an addition.
	successor := fixture(t, "generation-2-routine-successor.json")
	successorParsed, _ := manifest.Parse(successor)
	third, treeProblems := Build(successorParsed)
	if len(treeProblems) > 0 {
		t.Fatalf("%v", manifest.Codes(treeProblems))
	}
	for path, node := range first.ByPath {
		if !node.IsDir {
			continue
		}
		if other, ok := third.ByPath[path]; ok {
			if other.Ino != node.Ino || !other.Mtime.Equal(node.Mtime) {
				t.Fatalf("directory %q moved across a generation swap", path)
			}
		}
	}
}

// A generation is not reclaimed while a handle pins it, and IS reclaimed when the last one goes.
func TestPriorGenerationLivesUntilItsHandlesRelease(t *testing.T) {
	store, _ := admitBaseline(t)
	pinned := store.Acquire()
	if pinned == nil {
		t.Fatal("acquire should pin the current generation")
	}
	successor := fixture(t, "generation-2-routine-successor.json")
	if !store.Admit(successor, claimFor(t, successor), time.Now()).OK() {
		t.Fatal("successor should admit")
	}
	retained := store.Retained()
	if len(retained) != 1 || retained[0] != pinned.GenerationID() {
		t.Fatalf("the pinned generation must be retained, got %v", retained)
	}
	// A handle that already holds it can still pin it again; a swap does not invalidate it.
	if !store.AcquirePinned(pinned) {
		t.Fatal("a retained generation must still be pinnable by a handle that holds it")
	}
	store.Release(pinned)
	if len(store.Retained()) != 1 {
		t.Fatal("one pin remains, so the generation must still be retained")
	}
	store.Release(pinned)
	if len(store.Retained()) != 0 {
		t.Fatalf("the last release must reclaim the generation, got %v", store.Retained())
	}
	// And once reclaimed it cannot be pinned again — which is what forces the FUSE layer to fall back to the
	// current generation rather than reading something nobody is holding.
	if store.AcquirePinned(pinned) {
		t.Fatal("a reclaimed generation must not be pinnable")
	}
}

func TestFailedAdmissionLeavesTheLastGoodSnapshotServing(t *testing.T) {
	store, raw := admitBaseline(t)
	before := store.Current()
	bad := fixture(t, "adversarial/entry-inode-not-derived.json")
	result := store.Admit(bad, PointerClaim{Digest: manifest.DigestOfBytes(bad)}, time.Now())
	if result.OK() {
		t.Fatal("a malformed generation must be refused")
	}
	if store.Current() != before {
		t.Fatal("a refusal must not disturb the admitted generation")
	}
	if store.Current().Digest != manifest.DigestOfBytes(raw) {
		t.Fatal("the serving snapshot changed under a refusal")
	}
}
