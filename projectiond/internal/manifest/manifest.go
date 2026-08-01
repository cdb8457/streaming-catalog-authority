// Package manifest is the Go half of the projection manifest v1 contract.
//
// THE NORMATIVE DEFINITION LIVES IN THE CONTROL PLANE. `src/core/projection/manifest-v1.ts` and
// `docs/PROJECTION_PHASE_0_PRODUCT_CONTRACT.md` decide what a manifest means; this package decides nothing.
// It re-implements the same rules in the language the data plane is written in, and the fixture corpus in
// `test/fixtures/projection-manifest-v1/` is what proves the two agree — every valid generation admits here,
// and every adversarial case is refused here with the SAME problem code the TypeScript validator emits.
//
// WHY A SECOND IMPLEMENTATION RATHER THAN A SHARED ONE. The daemon has to refuse a bad manifest without a
// Node.js runtime in the mount path, and admission is the one place where "the producer already checked" is
// not good enough: a manifest that reached the daemon may have been truncated, swapped or hand-edited. The
// corpus is the contract; two implementations that both satisfy it is the point, not an accident.
//
// WHERE THIS PACKAGE IS DELIBERATELY STRICTER. Case-folding for the path-collision check uses Unicode case
// FOLDING rather than JavaScript's `toLowerCase`. Folding collapses at least as much, so this side refuses a
// superset of what the producer refuses. Being stricter at admission is safe; being looser is not.
package manifest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

const (
	Format  = "catalog-authority.projection-manifest"
	Version = 1
)

// Limits mirror PROJECTION_LIMITS. Every one of them is a refusal, not a truncation.
const (
	MaxArtifactBytes     = 256 * 1024 * 1024
	MaxEntries           = 200_000
	MaxSourcesPerEntry   = 8
	MaxPathBytes         = 4096
	MaxPathSegmentBytes  = 255
	MaxSizeBytes         = int64(9007199254740991) // Number.MAX_SAFE_INTEGER; JSON carries no int64.
	MaxLocatorValueLen   = 512
	MaxProbesPerSource   = 3
	MaxReportedProblems  = 50
	ProbeWindowBytes     = 1_048_576
	SingleProbeBelowByte = 3 * 1_048_576
)

// Shrink guard, defense in depth on top of rules that already make an accidental deletion unreachable.
const (
	MaxDeletionsAbsolute = 50
	MaxDeletionsFraction = 0.1
)

// Closed sets. There is no fourth visibility and no "missing".
var (
	VisibilityStates  = []string{"available", "degraded", "retiring"}
	SourceKinds       = []string{"local", "http-range"}
	DegradedReasons   = []string{"source-unreachable", "source-rejected", "byte-identity-mismatch", "access-resolution-failed", "endpoint-circuit-open", "operator-hold"}
	GenerationIntents = []string{"routine", "deletion"}
	ProbePositions    = []string{"head", "middle", "tail"}
)

var (
	reHex64      = regexp.MustCompile(`^[0-9a-f]{64}$`)
	reHex32      = regexp.MustCompile(`^[0-9a-f]{32}$`)
	reUUID       = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	reSHA256     = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	reIDLabel    = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	reTimestamp  = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)
	reDecimalNum = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)
	rePrintable  = regexp.MustCompile(`^[\x21-\x7e][\x20-\x7e]*$`)
	reEntryID    = regexp.MustCompile(`^pe_[0-9a-f]{64}$`)
	reVersionID  = regexp.MustCompile(`^pv_[0-9a-f]{64}$`)
	reSourceID   = regexp.MustCompile(`^src_[0-9a-f]{32}$`)
	reGenID      = regexp.MustCompile(`^gen_[0-9a-f]{32}$`)
	reSemver     = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
)

// A locator names a configured endpoint and an opaque reference. It is never a URL and never carries a
// credential; both are refused rather than redacted.
var locatorForbiddenWords = []string{
	"token", "apikey", "api_key", "secret", "password", "passwd", "auth", "bearer",
	"signature", "session", "cookie", "credential",
}
var locatorForbiddenChars = []string{"://", "?", "&", "@", "\\"}

// ---------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------

type Problem struct {
	Code string `json:"code"`
	At   string `json:"at"`
}

func (p Problem) String() string { return p.Code + " at " + p.At }

// Codes returns just the problem codes, which is what the cross-language corpus asserts on.
func Codes(problems []Problem) []string {
	out := make([]string, 0, len(problems))
	for _, p := range problems {
		out = append(out, p.Code)
	}
	return out
}

func HasCode(problems []Problem, code string) bool {
	for _, p := range problems {
		if p.Code == code {
			return true
		}
	}
	return false
}

type ProbeDigest struct {
	Position string
	Offset   int64
	Length   int64
	SHA256   string
}

type ByteIdentity struct {
	SizeBytes        int64
	ProbeWindowBytes int64
	Probes           []ProbeDigest
}

// Equal is the byte-identity proof comparison. Two sources may share a projected version only when this is
// true of both: same exact size, same fixed probe plan, same digests.
func (b *ByteIdentity) Equal(other *ByteIdentity) bool {
	if b == nil || other == nil {
		return false
	}
	if b.SizeBytes != other.SizeBytes || b.ProbeWindowBytes != other.ProbeWindowBytes {
		return false
	}
	if len(b.Probes) != len(other.Probes) {
		return false
	}
	for i := range b.Probes {
		if b.Probes[i] != other.Probes[i] {
			return false
		}
	}
	return true
}

// Locator is the union of the two Phase 1 shapes. It is STABLE: there is no expiry, no signed URL and no
// lease here, because access material expires on the provider's schedule and the namespace must not.
type Locator struct {
	RootID       string // local
	RelativePath string // local
	EndpointID   string // http-range
	ObjectRef    string // http-range
}

type Source struct {
	SourceID         string
	Kind             string
	Preference       int
	SourceGeneration int64
	Locator          Locator
	ByteIdentity     *ByteIdentity
}

type DegradedState struct {
	Reason string
	Since  time.Time
}

type RetiringState struct {
	DeletionIntentID string
	DeclaredAt       time.Time
	GraceDeadline    time.Time
}

type Entry struct {
	ProjectedEntryID   string
	LogicalMediaID     string
	ProjectedVersionID string
	Path               string
	NodeKind           string
	SizeBytes          int64
	MtimeRaw           string
	Mtime              time.Time
	Mode               uint32
	Inode              uint64
	Visibility         string
	Degraded           *DegradedState
	Retiring           *RetiringState
	Sources            []Source
}

type Predecessor struct {
	GenerationID   string
	Sequence       int64
	ManifestDigest string
}

type Provenance struct {
	Producer                  string
	ProducerVersion           string
	ControlPlaneSchemaVersion int64
	SourceSnapshotDigest      string
	ProbeWindowBytes          int64
}

type Admission struct {
	Intent                    string
	EntryCount                int64
	Deletions                 []string
	DeletionGuardAcknowledged bool
	DeletionGuardDigest       string
}

type Generation struct {
	GenerationID string
	Sequence     int64
	CreatedAtRaw string
	CreatedAt    time.Time
	Predecessor  *Predecessor
	Provenance   Provenance
	Admission    Admission
}

type Manifest struct {
	Generation Generation
	Entries    []Entry
}

// ---------------------------------------------------------------------------------------------------------
// Primitives — all of them deterministic, all of them mirrored from the TypeScript
// ---------------------------------------------------------------------------------------------------------

// DeriveInode derives an inode from the projected-version id and from NOTHING else — never the path, never
// the active source, never a provider identifier. That is the whole reason a source failover or an access
// lease refresh cannot make a media server treat a file it already knows as a new one.
func DeriveInode(projectedVersionID string) uint64 {
	sum := sha256.Sum256([]byte("projectiond.ino.v1\n" + projectedVersionID))
	v := beUint64(sum[:8]) & 0x7fff_ffff_ffff_ffff
	if v < 1024 {
		v += 1024
	}
	return v
}

// DeriveDirectoryInode gives a derived directory node its own inode. Directories are not manifest rows: they
// have no byte stream and therefore no projected version, so there is nothing else to derive from. A separate
// domain separator keeps the two spaces from ever colliding by construction, and the namespace builder still
// refuses an observed collision rather than trusting that.
func DeriveDirectoryInode(dirPath string) uint64 {
	sum := sha256.Sum256([]byte("projectiond.ino.dir.v1\n" + dirPath))
	v := beUint64(sum[:8]) & 0x7fff_ffff_ffff_ffff
	if v < 1024 {
		v += 1024
	}
	return v
}

func beUint64(b []byte) uint64 {
	var v uint64
	for _, c := range b[:8] {
		v = v<<8 | uint64(c)
	}
	return v
}

type ProbeSlot struct {
	Position string
	Offset   int64
	Length   int64
}

// ProbeOffsetsFor is the FIXED probe plan. The offsets are a function of the size, not a choice the producer
// makes, because "the producer picked the offsets" is not a proof a verifier can re-run.
func ProbeOffsetsFor(sizeBytes int64) []ProbeSlot {
	if sizeBytes <= 0 {
		return nil
	}
	if sizeBytes < SingleProbeBelowByte {
		return []ProbeSlot{{Position: "head", Offset: 0, Length: sizeBytes}}
	}
	middle := sizeBytes/2 - ProbeWindowBytes/2
	return []ProbeSlot{
		{Position: "head", Offset: 0, Length: ProbeWindowBytes},
		{Position: "middle", Offset: middle, Length: ProbeWindowBytes},
		{Position: "tail", Offset: sizeBytes - ProbeWindowBytes, Length: ProbeWindowBytes},
	}
}

// DigestOfBytes is `sha256:<hex>` over the EXACT artifact bytes. This is what a pointer carries and what
// chains one generation to the next.
func DigestOfBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// DeletionAcknowledgementDigest binds a shrink-guard acknowledgement to the exact id set it removes. It must
// agree byte for byte with the TypeScript, so the canonical JSON is produced with HTML escaping off.
func DeletionAcknowledgementDigest(deletions []string) string {
	sorted := append([]string(nil), deletions...)
	sort.Strings(sorted)
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(sorted); err != nil {
		return ""
	}
	sum := sha256.Sum256(bytes.TrimRight(buf.Bytes(), "\n"))
	return "sha256:" + hex.EncodeToString(sum[:])
}

type PathResult struct {
	OK   bool
	Path string
	Code string
}

// NormalizeProjectedPath is a REFUSAL, never a rewrite. A producer emitting `a//b` does not have a stable
// rule for that path, and repairing it here would make the daemon's namespace disagree with the control
// plane's idea of it.
func NormalizeProjectedPath(v any) PathResult {
	raw, ok := v.(string)
	if !ok {
		return PathResult{Code: "PATH_NOT_A_STRING"}
	}
	if raw == "" {
		return PathResult{Code: "PATH_EMPTY"}
	}
	if len(raw) > MaxPathBytes {
		return PathResult{Code: "PATH_TOO_LONG"}
	}
	if !utf8.ValidString(raw) {
		return PathResult{Code: "PATH_NOT_NFC"}
	}
	if norm.NFC.String(raw) != raw {
		return PathResult{Code: "PATH_NOT_NFC"}
	}
	if strings.Contains(raw, "\\") {
		return PathResult{Code: "PATH_BACKSLASH"}
	}
	if strings.HasPrefix(raw, "/") {
		return PathResult{Code: "PATH_ABSOLUTE"}
	}
	if strings.HasSuffix(raw, "/") {
		return PathResult{Code: "PATH_TRAILING_SLASH"}
	}
	for _, r := range raw {
		if r < 0x20 || r == 0x7f {
			return PathResult{Code: "PATH_CONTROL_CHARACTER"}
		}
	}
	for _, segment := range strings.Split(raw, "/") {
		if segment == "" {
			return PathResult{Code: "PATH_EMPTY_SEGMENT"}
		}
		if segment == "." || segment == ".." {
			return PathResult{Code: "PATH_RELATIVE_SEGMENT"}
		}
		if segment != strings.TrimSpace(segment) {
			return PathResult{Code: "PATH_SEGMENT_PADDED"}
		}
		if len(segment) > MaxPathSegmentBytes {
			return PathResult{Code: "PATH_SEGMENT_TOO_LONG"}
		}
	}
	return PathResult{OK: true, Path: raw}
}

var caseFolder = cases.Fold()

// FoldProjectedPath is the comparison two paths are checked for collision under. Unraid shares, macOS clients
// and SMB all reach this namespace, and on any of them `A.mkv` and `a.mkv` are one file.
func FoldProjectedPath(p string) string {
	return caseFolder.String(norm.NFC.String(p))
}

// ---------------------------------------------------------------------------------------------------------
// Generic decoding helpers. Everything is validated from a generic tree so the problem codes can match the
// TypeScript exactly, then a typed manifest is built from the tree that already passed.
// ---------------------------------------------------------------------------------------------------------

var errTrailingContent = errors.New("trailing content after the manifest document")

func decodeGeneric(b []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var v any
	if err := d.Decode(&v); err != nil {
		return nil, err
	}
	if d.More() {
		return nil, errTrailingContent
	}
	return v, nil
}

func asObject(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok
}

func asArray(v any) ([]any, bool) {
	a, ok := v.([]any)
	return a, ok
}

func asString(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok
}

// asInteger accepts only an exact integer within range. `1073741824.5` is refused rather than rounded, and so
// is anything in exponent notation, because a size that survived a lossy parse is not an exact size.
func asInteger(v any, min, max int64) (int64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	s := n.String()
	if strings.ContainsAny(s, ".eE") {
		return 0, false
	}
	i, err := strconv.ParseInt(s, 10, 64)
	if err != nil || i < min || i > max {
		return 0, false
	}
	return i, true
}

func integerEquals(v any, want int64) bool {
	got, ok := asInteger(v, -1<<62, 1<<62)
	return ok && got == want
}

func isTimestamp(v any) (time.Time, bool) {
	s, ok := v.(string)
	if !ok || !reTimestamp.MatchString(s) {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}, false
	}
	return t.UTC(), true
}

func inSet(v any, set []string) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	for _, item := range set {
		if item == s {
			return true
		}
	}
	return false
}

func matches(v any, re *regexp.Regexp) bool {
	s, ok := v.(string)
	return ok && re.MatchString(s)
}

type problemList struct {
	list []Problem
}

func (p *problemList) add(code, at string) {
	if len(p.list) < MaxReportedProblems {
		p.list = append(p.list, Problem{Code: code, At: at})
	}
}

func (p *problemList) any() bool { return len(p.list) > 0 }

// checkNoUnknownKeys walks the keys in sorted order. Go randomises map iteration, and a problem list whose
// contents depend on that would make a refusal report differ between two runs over the same bytes.
func (p *problemList) checkNoUnknownKeys(m map[string]any, allowed []string, at string) {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		known := false
		for _, a := range allowed {
			if a == key {
				known = true
				break
			}
		}
		if !known {
			p.add("UNKNOWN_FIELD", joinAt(at, key))
		}
	}
}

func joinAt(at, key string) string {
	if at == "" {
		return key
	}
	return at + "." + key
}

func indexAt(at string, i int) string { return fmt.Sprintf("%s[%d]", at, i) }
