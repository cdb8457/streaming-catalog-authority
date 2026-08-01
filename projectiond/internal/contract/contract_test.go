package contract

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/cache"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/manifest"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/readpath"
)

// The embedded export must be the file the control plane rendered, byte for byte. If somebody edits the copy
// in the daemon instead of the frozen contract, this is where it stops.
func TestEmbeddedExportMatchesTheCommittedFile(t *testing.T) {
	path, err := filepath.Abs(filepath.Join("..", "..", "..", "projectiond", "internal", "contract", "contract.generated.json"))
	if err != nil {
		t.Fatal(err)
	}
	onDisk, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the committed export is missing: %v", err)
	}
	if string(onDisk) != string(Raw()) {
		t.Fatal("the embedded export and the committed file disagree; run npm run ops:projection-contract-export")
	}
}

// Every Go constant that mirrors a frozen contract value is checked against the export. Neither language can
// drift without a gate failing: the TypeScript suite refuses a stale file from the other side.
func TestGoConstantsAgreeWithTheControlPlane(t *testing.T) {
	export := Load()

	if export.Manifest.Format != manifest.Format {
		t.Fatalf("manifest format: %q vs %q", export.Manifest.Format, manifest.Format)
	}
	if export.Manifest.Version != manifest.Version {
		t.Fatalf("manifest version: %d vs %d", export.Manifest.Version, manifest.Version)
	}

	limits := export.Manifest.Limits
	for _, check := range []struct {
		name       string
		want, have int64
	}{
		{"MAX_ARTIFACT_BYTES", limits.MaxArtifactBytes, manifest.MaxArtifactBytes},
		{"MAX_ENTRIES", limits.MaxEntries, manifest.MaxEntries},
		{"MAX_SOURCES_PER_ENTRY", int64(limits.MaxSourcesPerEntry), manifest.MaxSourcesPerEntry},
		{"MAX_PATH_BYTES", int64(limits.MaxPathBytes), manifest.MaxPathBytes},
		{"MAX_PATH_SEGMENT_BYTES", int64(limits.MaxPathSegmentBytes), manifest.MaxPathSegmentBytes},
		{"MAX_SIZE_BYTES", limits.MaxSizeBytes, manifest.MaxSizeBytes},
		{"MAX_LOCATOR_VALUE_LENGTH", int64(limits.MaxLocatorValueLen), manifest.MaxLocatorValueLen},
		{"MAX_PROBES_PER_SOURCE", int64(limits.MaxProbesPerSource), manifest.MaxProbesPerSource},
		{"MAX_REPORTED_PROBLEMS", int64(limits.MaxReportedProblems), manifest.MaxReportedProblems},
		{"WINDOW_BYTES", export.Manifest.ProbePlan.WindowBytes, manifest.ProbeWindowBytes},
		{"SINGLE_PROBE_BELOW_BYTES", export.Manifest.ProbePlan.SingleProbeBelowBytes, manifest.SingleProbeBelowByte},
		{"MAX_DELETIONS_ABSOLUTE", int64(export.Manifest.ShrinkGuard.MaxDeletionsAbsolute), manifest.MaxDeletionsAbsolute},
	} {
		if check.want != check.have {
			t.Errorf("%s: control plane says %d, daemon says %d", check.name, check.want, check.have)
		}
	}
	if export.Manifest.ShrinkGuard.MaxDeletionsFraction != manifest.MaxDeletionsFraction {
		t.Errorf("MAX_DELETIONS_FRACTION: %v vs %v",
			export.Manifest.ShrinkGuard.MaxDeletionsFraction, manifest.MaxDeletionsFraction)
	}

	assertSameSet(t, "visibilityStates", export.Manifest.VisibilityStates, manifest.VisibilityStates)
	assertSameSet(t, "sourceKinds", export.Manifest.SourceKinds, manifest.SourceKinds)
	assertSameSet(t, "degradedReasons", export.Manifest.DegradedReasons, manifest.DegradedReasons)
	assertSameSet(t, "generationIntents", export.Manifest.GenerationIntents, manifest.GenerationIntents)
	assertSameSet(t, "probeOffsets", export.Manifest.ProbePlan.Offsets, manifest.ProbePositions)
}

func assertSameSet(t *testing.T, name string, want, have []string) {
	t.Helper()
	if len(want) != len(have) {
		t.Fatalf("%s: control plane has %d entries, daemon has %d", name, len(want), len(have))
	}
	for i := range want {
		if want[i] != have[i] {
			t.Fatalf("%s[%d]: %q vs %q", name, i, want[i], have[i])
		}
	}
}

// The read policy the daemon actually runs on must be the one the contract froze.
func TestReadPolicyMatchesTheContract(t *testing.T) {
	export := Load()
	cfg := readpath.DefaultConfig()

	if got := int64(cfg.ReadDeadline / time.Millisecond); got != export.Runtime.ReadPolicy.ReadDeadlineMs {
		t.Errorf("read deadline: contract %d ms, daemon %d ms", export.Runtime.ReadPolicy.ReadDeadlineMs, got)
	}
	if cfg.MaxAttempts != export.Runtime.ReadPolicy.MaxAttemptsPerRead {
		t.Errorf("max attempts: contract %d, daemon %d", export.Runtime.ReadPolicy.MaxAttemptsPerRead, cfg.MaxAttempts)
	}
	if got := int64(cfg.BackoffInitial / time.Millisecond); got != export.Runtime.ReadPolicy.BackoffInitialMs {
		t.Errorf("backoff initial: contract %d ms, daemon %d ms", export.Runtime.ReadPolicy.BackoffInitialMs, got)
	}
	if got := int64(cfg.BackoffMax / time.Millisecond); got != export.Runtime.ReadPolicy.BackoffMaxMs {
		t.Errorf("backoff max: contract %d ms, daemon %d ms", export.Runtime.ReadPolicy.BackoffMaxMs, got)
	}
	if cfg.BackoffMultiplier != export.Runtime.ReadPolicy.BackoffMultiplier {
		t.Errorf("backoff multiplier: contract %d, daemon %d",
			export.Runtime.ReadPolicy.BackoffMultiplier, cfg.BackoffMultiplier)
	}
	if cfg.ChunkBytes != export.Runtime.ReadPolicy.ChunkBytes {
		t.Errorf("chunk bytes: contract %d, daemon %d", export.Runtime.ReadPolicy.ChunkBytes, cfg.ChunkBytes)
	}
	if cfg.ProbeWindowBytes != export.Manifest.ProbePlan.WindowBytes {
		t.Errorf("probe window: contract %d, daemon %d", export.Manifest.ProbePlan.WindowBytes, cfg.ProbeWindowBytes)
	}
	if cfg.SequentialTriggerReads != export.Runtime.ReadaheadPolicy.SequentialTriggerReads {
		t.Errorf("sequential trigger: contract %d, daemon %d",
			export.Runtime.ReadaheadPolicy.SequentialTriggerReads, cfg.SequentialTriggerReads)
	}
	if cfg.MaxReadaheadBlocks != export.Runtime.ReadaheadPolicy.MaxReadaheadChunks {
		t.Errorf("read-ahead blocks: contract %d, daemon %d",
			export.Runtime.ReadaheadPolicy.MaxReadaheadChunks, cfg.MaxReadaheadBlocks)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("the default configuration must be valid: %v", err)
	}
}

// The amended scan-window policy: three fixed windows per version, and the persistent cache sized for them.
func TestScanWindowPolicyIsCoherent(t *testing.T) {
	export := Load()
	windows := int64(len(export.Manifest.ProbePlan.Offsets))
	want := export.Manifest.ProbePlan.WindowBytes * windows
	if export.Runtime.CachePolicy.ProbePrefix.BytesPerVersion != want {
		t.Fatalf("the scan cache should hold %d bytes per version, contract says %d",
			want, export.Runtime.CachePolicy.ProbePrefix.BytesPerVersion)
	}
	// The block planner must agree: a read anywhere inside a fixed window fetches that window and nothing more.
	const size = int64(8_589_934_592)
	for _, slot := range manifest.ProbeOffsetsFor(size) {
		if slot.Length > export.Manifest.ProbePlan.WindowBytes {
			t.Fatalf("a scan window is larger than the contract's window: %d", slot.Length)
		}
	}
}

// Nothing here should be able to reach a cache key without a byte identity in it.
func TestCacheKeysCarryByteIdentity(t *testing.T) {
	a := cache.Key{ProjectedVersionID: "pv_a", IdentityDigest: "one", Offset: 0, Length: 16}
	b := cache.Key{ProjectedVersionID: "pv_a", IdentityDigest: "two", Offset: 0, Length: 16}
	if a.String() == b.String() {
		t.Fatal("two different byte identities must not share a cache key")
	}
	if Load().Runtime.CachePolicy.ProbePrefix.Key != "projected-version-id" {
		t.Fatal("the contract's cache key must be the projected version, never a path or a source")
	}
}
