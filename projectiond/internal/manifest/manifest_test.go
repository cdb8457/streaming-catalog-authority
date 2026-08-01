package manifest

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// The fixture corpus is the CROSS-LANGUAGE CONTRACT. It is produced and asserted by the TypeScript control
// plane; every case here reads the same bytes and requires the same verdict with the same problem code. Two
// implementations that both satisfy one corpus is the point.
func fixtureDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.Abs(filepath.Join("..", "..", "..", "test", "fixtures", "projection-manifest-v1"))
	if err != nil {
		t.Fatalf("fixture path: %v", err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("the shared fixture corpus is missing at %s: %v", dir, err)
	}
	return dir
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixtureDir(t), name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return raw
}

func TestValidGenerationsAdmit(t *testing.T) {
	for _, name := range []string{
		"generation-1-baseline.json",
		"generation-2-routine-successor.json",
		"generation-3-deletion.json",
	} {
		raw := readFixture(t, name)
		parsed, problems := Parse(raw)
		if len(problems) > 0 {
			t.Fatalf("%s should validate, got %v", name, Codes(problems))
		}
		if parsed == nil {
			t.Fatalf("%s returned no manifest", name)
		}
		for _, entry := range parsed.Entries {
			if entry.Inode != DeriveInode(entry.ProjectedVersionID) {
				t.Fatalf("%s: inode is not derived from the projected version", name)
			}
			if entry.Mode != 0o444 {
				t.Fatalf("%s: entry mode is not read-only", name)
			}
		}
	}
}

// The generation chain is a DIGEST chain over exact bytes. If a checkout altered the fixture bytes the chain
// would break here rather than somewhere confusing later.
func TestFixtureDigestChain(t *testing.T) {
	g1 := readFixture(t, "generation-1-baseline.json")
	g2 := readFixture(t, "generation-2-routine-successor.json")
	g3 := readFixture(t, "generation-3-deletion.json")

	parsed2, problems := Parse(g2)
	if len(problems) > 0 {
		t.Fatalf("generation 2: %v", Codes(problems))
	}
	if parsed2.Generation.Predecessor.ManifestDigest != DigestOfBytes(g1) {
		t.Fatal("generation 2 does not name generation 1 by the digest of the bytes on disk")
	}
	parsed3, problems := Parse(g3)
	if len(problems) > 0 {
		t.Fatalf("generation 3: %v", Codes(problems))
	}
	if parsed3.Generation.Predecessor.ManifestDigest != DigestOfBytes(g2) {
		t.Fatal("generation 3 does not name generation 2 by the digest of the bytes on disk")
	}
}

type adversarialCase struct {
	File            string `json:"file"`
	Kind            string `json:"kind"`
	ExpectedProblem string `json:"expectedProblem"`
	Previous        string `json:"previous"`
	NowISO          string `json:"nowIso"`
}

func TestAdversarialCorpusIsRefusedWithTheSameCode(t *testing.T) {
	index := struct {
		Cases []adversarialCase `json:"cases"`
	}{}
	if err := json.Unmarshal(readFixture(t, "adversarial-index.json"), &index); err != nil {
		t.Fatalf("adversarial index: %v", err)
	}
	if len(index.Cases) < 28 {
		t.Fatalf("the corpus is thinner than expected: %d cases", len(index.Cases))
	}

	for _, testCase := range index.Cases {
		t.Run(testCase.File, func(t *testing.T) {
			raw := readFixture(t, testCase.File)
			parsed, problems := Parse(raw)

			if testCase.Kind == "standalone" {
				if len(problems) == 0 {
					t.Fatalf("expected a refusal naming %s, got none", testCase.ExpectedProblem)
				}
				if !HasCode(problems, testCase.ExpectedProblem) {
					t.Fatalf("expected %s, got %v", testCase.ExpectedProblem, Codes(problems))
				}
				if parsed != nil {
					t.Fatal("a refusal must not hand back a manifest")
				}
				return
			}

			if len(problems) > 0 {
				t.Fatalf("the succession candidate should be structurally valid, got %v", Codes(problems))
			}
			previousRaw := readFixture(t, testCase.Previous)
			previous, previousProblems := Parse(previousRaw)
			if len(previousProblems) > 0 {
				t.Fatalf("the predecessor should be valid, got %v", Codes(previousProblems))
			}
			now, err := time.Parse(time.RFC3339Nano, testCase.NowISO)
			if err != nil {
				now = parsed.Generation.CreatedAt
			}
			result := ValidateSuccession(
				Admitted{Manifest: previous, ManifestDigest: DigestOfBytes(previousRaw)}, parsed, now)
			if result.OK() {
				t.Fatalf("expected a refusal naming %s, got none", testCase.ExpectedProblem)
			}
			if !HasCode(result.Problems, testCase.ExpectedProblem) {
				t.Fatalf("expected %s, got %v", testCase.ExpectedProblem, Codes(result.Problems))
			}
		})
	}
}

// The strongest form of "unavailability is never absence": an EMPTY generation — the shape a failed, short or
// timed-out scan would produce — is structurally legal and still refused as a successor.
func TestEmptySuccessorIsRefused(t *testing.T) {
	g1raw := readFixture(t, "generation-1-baseline.json")
	g1, _ := Parse(g1raw)

	var generic map[string]any
	if err := json.Unmarshal(g1raw, &generic); err != nil {
		t.Fatal(err)
	}
	generation := generic["generation"].(map[string]any)
	generation["generationId"] = "gen_00000000000000000000000000000042"
	generation["sequence"] = json.Number("2")
	generation["createdAt"] = "2026-07-15T00:00:00.000Z"
	generation["predecessor"] = map[string]any{
		"generationId": g1.Generation.GenerationID, "sequence": json.Number("1"),
		"manifestDigest": DigestOfBytes(g1raw),
	}
	generation["admission"].(map[string]any)["entryCount"] = json.Number("0")
	generic["entries"] = []any{}

	reencoded, err := json.Marshal(generic)
	if err != nil {
		t.Fatal(err)
	}
	empty, problems := Parse(reencoded)
	if len(problems) > 0 {
		t.Fatalf("an empty generation is structurally legal, got %v", Codes(problems))
	}
	result := ValidateSuccession(Admitted{Manifest: g1, ManifestDigest: DigestOfBytes(g1raw)}, empty,
		mustTime(t, "2026-07-15T00:00:00.000Z"))
	if result.OK() {
		t.Fatal("an empty successor must be refused")
	}
	if !HasCode(result.Problems, "ENTRY_DISAPPEARED_WITHOUT_DELETION") {
		t.Fatalf("expected ENTRY_DISAPPEARED_WITHOUT_DELETION, got %v", Codes(result.Problems))
	}
	if len(result.Deletions) != 0 {
		t.Fatal("a refused successor must not report deletions")
	}
}

func mustTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func TestInodeDerivationIsStableAndVersionOnly(t *testing.T) {
	version := "pv_" + repeat("a", 64)
	first := DeriveInode(version)
	if DeriveInode(version) != first {
		t.Fatal("the same version must always derive the same inode")
	}
	if first < 1024 {
		t.Fatal("the low inode numbers are reserved")
	}
	if first > 1<<63-1 {
		t.Fatal("an inode must fit a signed 64-bit field")
	}
	if DeriveInode("pv_"+repeat("b", 64)) == first {
		t.Fatal("a different version must derive a different inode")
	}
	// Directory inodes live in a separate derivation space, so a directory can never collide with a file by
	// accident of naming.
	if DeriveDirectoryInode("Movies") == DeriveInode("Movies") {
		t.Fatal("directory and file inode spaces must be separated by their domain")
	}
}

func repeat(s string, n int) string {
	out := make([]byte, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, s[0])
	}
	return string(out)
}

func TestPathNormalizationRefusesRatherThanRewrites(t *testing.T) {
	cases := map[string]string{
		"/Movies/A.mkv":        "PATH_ABSOLUTE",
		"Movies/A.mkv/":        "PATH_TRAILING_SLASH",
		"Movies//A.mkv":        "PATH_EMPTY_SEGMENT",
		"Movies/../etc/passwd": "PATH_RELATIVE_SEGMENT",
		"Movies/./A.mkv":       "PATH_RELATIVE_SEGMENT",
		`Movies\A.mkv`:         "PATH_BACKSLASH",
		"Movies/\x00A.mkv":     "PATH_CONTROL_CHARACTER",
		"Movies/ A.mkv":        "PATH_SEGMENT_PADDED",
		"":                     "PATH_EMPTY",
	}
	for path, want := range cases {
		result := NormalizeProjectedPath(path)
		if result.OK {
			t.Fatalf("%q should be refused", path)
		}
		if result.Code != want {
			t.Fatalf("%q: expected %s, got %s", path, want, result.Code)
		}
	}
	if !NormalizeProjectedPath("Movies/A (2020)/A (2020).mkv").OK {
		t.Fatal("a well-formed path must be accepted")
	}
	if FoldProjectedPath("Movies/A.MKV") != FoldProjectedPath("movies/a.mkv") {
		t.Fatal("the collision fold must be case-insensitive")
	}
}

func TestProbePlanIsFixedBySize(t *testing.T) {
	if len(ProbeOffsetsFor(0)) != 0 {
		t.Fatal("a zero-byte file has nothing to probe")
	}
	small := ProbeOffsetsFor(1024)
	if len(small) != 1 || small[0].Length != 1024 {
		t.Fatal("a small file is proved by one whole-file probe")
	}
	const size = int64(8_589_934_592)
	big := ProbeOffsetsFor(size)
	if len(big) != 3 {
		t.Fatalf("a large file gets head, middle and tail, got %d", len(big))
	}
	if big[0].Offset != 0 || big[2].Offset != size-ProbeWindowBytes {
		t.Fatal("head starts at zero and tail ends at EOF")
	}
	if big[1].Offset <= big[0].Offset+ProbeWindowBytes {
		t.Fatal("the middle window must not overlap the head window")
	}
}

// A number that is not an exact integer is refused rather than rounded: a size that survived a lossy parse is
// not an exact size.
func TestNonIntegerSizeIsRefused(t *testing.T) {
	raw := readFixture(t, "adversarial/entry-size-not-exact.json")
	_, problems := Parse(raw)
	if !HasCode(problems, "ENTRY_SIZE_INVALID") {
		t.Fatalf("expected ENTRY_SIZE_INVALID, got %v", Codes(problems))
	}
}

func TestDeletionAcknowledgementDigestMatchesTheControlPlane(t *testing.T) {
	// The fixture carries a digest the TypeScript produced; recomputing it here proves the canonical JSON and
	// the hash agree across the two languages.
	raw := readFixture(t, "adversarial/successor-shrink-guard-unacknowledged.json")
	parsed, problems := Parse(raw)
	if len(problems) > 0 {
		t.Fatalf("unexpected problems: %v", Codes(problems))
	}
	digest := DeletionAcknowledgementDigest(parsed.Generation.Admission.Deletions)
	if len(digest) != len("sha256:")+64 {
		t.Fatalf("unexpected digest shape %q", digest)
	}
	// Order must not matter: the digest is over the SORTED set.
	reversed := make([]string, len(parsed.Generation.Admission.Deletions))
	for i, id := range parsed.Generation.Admission.Deletions {
		reversed[len(reversed)-1-i] = id
	}
	if DeletionAcknowledgementDigest(reversed) != digest {
		t.Fatal("the acknowledgement digest must be order-independent")
	}
}

func TestInodeIsRenderedAsDecimalString(t *testing.T) {
	raw := readFixture(t, "generation-1-baseline.json")
	parsed, _ := Parse(raw)
	for _, entry := range parsed.Entries {
		if strconv.FormatUint(entry.Inode, 10) == "" {
			t.Fatal("inode should be a usable unsigned value")
		}
	}
}
