package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/cache"
)

func configFor(t *testing.T) Config {
	t.Helper()
	base := t.TempDir()
	manifestDir := filepath.Join(base, "manifest")
	if err := os.MkdirAll(manifestDir, 0o755); err != nil {
		t.Fatal(err)
	}
	return Config{
		PointerPath:   filepath.Join(manifestDir, "pointer.json"),
		ProbeCacheDir: filepath.Join(base, "cache"),
	}
}

// REGRESSION: readiness used to mean "a generation parsed". A mount(2) object with no responding userspace
// loop is not ready, and neither is a daemon that has admitted a generation it is not serving.
func TestReadyMeansAdmittedAndMounted(t *testing.T) {
	d, err := New(configFor(t))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	if d.Status().Ready {
		t.Fatal("a daemon with no generation must not be ready")
	}
	d.SetMounted(true)
	if !d.Status().Mounted {
		t.Fatal("the mounted flag was not recorded")
	}
	// Mounted but with nothing admitted is still not ready: there is nothing to serve.
	if d.Status().Ready {
		t.Fatal("a mounted daemon with no admitted generation must not be ready")
	}
	d.SetMounted(false)
	if d.Status().Ready {
		t.Fatal("an unmounted daemon must never be ready")
	}
}

// The status document is redaction-safe: codes, counts and generation numbers, never a path.
func TestStatusCarriesNoPaths(t *testing.T) {
	cfg := configFor(t)
	d, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	record := d.LoadPointer() // there is no pointer, so this is a refusal
	if record.Accepted {
		t.Fatal("there is no pointer to admit")
	}
	if record.Refusal == "" {
		t.Fatal("a refusal must carry a closed-set reason")
	}
	for _, field := range []string{record.Refusal} {
		if filepath.IsAbs(field) || len(field) > 0 && (field[0] == '/' || field[0] == '.') {
			t.Fatalf("a refusal reason must not be a path: %q", field)
		}
	}
	if len(d.Status().RetainedGenerations) != 0 {
		t.Fatal("retained generations should start empty and deterministic")
	}
}

func TestConfigurationRefusals(t *testing.T) {
	base := t.TempDir()
	for name, mutate := range map[string]func(*Config){
		"relative cache dir":  func(c *Config) { c.ProbeCacheDir = "relative" },
		"missing cache dir":   func(c *Config) { c.ProbeCacheDir = "" },
		"relative pointer":    func(c *Config) { c.PointerPath = "relative/pointer.json" },
		"missing pointer":     func(c *Config) { c.PointerPath = "" },
		"non-loopback status": func(c *Config) { c.StatusAddr = "0.0.0.0:9000" },
		"public status":       func(c *Config) { c.StatusAddr = "192.168.1.5:9000" },
	} {
		cfg := Config{
			PointerPath:   filepath.Join(base, "manifest", "pointer.json"),
			ProbeCacheDir: filepath.Join(base, "cache"),
		}
		mutate(&cfg)
		if _, err := New(cfg); err == nil {
			t.Fatalf("%s must be refused", name)
		}
	}
}

func TestDuplicateEndpointIdsAreRefused(t *testing.T) {
	cfg := configFor(t)
	cfg.Endpoints = []EndpointConfigFile{
		{ID: "same", DirectBaseURL: "https://a.example", AllowedOrigins: []string{"https://a.example"}},
		{ID: "same", DirectBaseURL: "https://b.example", AllowedOrigins: []string{"https://b.example"}},
	}
	if _, err := New(cfg); err == nil {
		t.Fatal("a duplicate endpoint id must be refused rather than last-one-wins")
	}
}

func TestStrictDecodeRefusesUnknownFieldsAndTrailingContent(t *testing.T) {
	var pointer Pointer
	if err := strictDecode([]byte(`{"generationId":"g","sequence":1,"nope":true}`), &pointer); err == nil {
		t.Fatal("an unknown pointer field must be refused")
	}
	if err := strictDecode([]byte(`{"generationId":"g"}{"generationId":"h"}`), &pointer); err == nil {
		t.Fatal("trailing content must be refused")
	}
	good := `{"generationId":"g","sequence":1,"artifactName":"a.json","artifactBytes":2,"manifestDigest":"d"}`
	if err := strictDecode([]byte(good), &pointer); err != nil {
		t.Fatalf("a well-formed pointer must decode: %v", err)
	}
}

// The pointer may not name a file outside the manifest directory, however it spells it.
func TestPointerCannotEscapeTheManifestDirectory(t *testing.T) {
	cfg := configFor(t)
	d, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	for _, name := range []string{"../escape.json", "/etc/passwd", "sub/dir.json", "..", ".", `back\slash.json`} {
		// Marshalled rather than concatenated, so a name containing a backslash reaches the check as a NAME
		// rather than as malformed JSON.
		body, err := json.Marshal(Pointer{
			GenerationID: "gen_" + repeatChar('a', 32), Sequence: 1, ArtifactName: name,
			ArtifactBytes: 10, ManifestDigest: "sha256:" + repeatChar('a', 64),
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(cfg.PointerPath, body, 0o600); err != nil {
			t.Fatal(err)
		}
		record := d.LoadPointer()
		if record.Accepted {
			t.Fatalf("artifact name %q must be refused", name)
		}
		if record.Refusal != RefusalArtifactEscapes {
			t.Fatalf("artifact name %q was refused for the wrong reason: %s", name, record.Refusal)
		}
	}
}

func TestPointerLengthMustMatchTheArtifactExactly(t *testing.T) {
	cfg := configFor(t)
	d, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	dir := filepath.Dir(cfg.PointerPath)
	if err := os.WriteFile(filepath.Join(dir, "artifact.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	body := `{"generationId":"gen_` + repeatChar('a', 32) + `","sequence":1,"artifactName":"artifact.json",` +
		`"artifactBytes":9999,"manifestDigest":"sha256:` + repeatChar('a', 64) + `"}`
	if err := os.WriteFile(cfg.PointerPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if record := d.LoadPointer(); record.Refusal != RefusalArtifactLength {
		t.Fatalf("a length disagreement must be refused by name, got %q", record.Refusal)
	}
}

// A symlinked pointer is a pointer somebody else chose.
func TestSymlinkedPointerIsRefused(t *testing.T) {
	cfg := configFor(t)
	d, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	elsewhere := filepath.Join(t.TempDir(), "real-pointer.json")
	if err := os.WriteFile(elsewhere, []byte(`{"generationId":"g"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(elsewhere, cfg.PointerPath); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if record := d.LoadPointer(); record.Refusal != RefusalPointerUnreadable {
		t.Fatalf("a symlinked pointer must be refused, got %q", record.Refusal)
	}
}

func repeatChar(c byte, n int) string {
	out := make([]byte, n)
	for i := range out {
		out[i] = c
	}
	return string(out)
}

// TestTheCacheDiagnosticRouteIsAbsentUnlessEnabled. A route that exists in every build is a route somebody
// can probe; one that is never registered cannot even reveal that the daemon has a diagnostic.
func TestTheCacheDiagnosticRouteIsAbsentUnlessEnabled(t *testing.T) {
	// EXPLICITLY UNSET. A default-off test that inherits the environment proves nothing about the default.
	t.Setenv("PROJECTIOND_CACHE_DIAGNOSTIC", "")
	playback := cache.NewPlaybackCache(1<<20, 1<<20)
	if playback.DiagnosticEnabled() {
		t.Fatal("the diagnostic is on without the environment variable")
	}
	d := &Daemon{Playback: playback, cfg: Config{StatusAddr: "127.0.0.1:0"}, startedAt: time.Now()}
	mux := d.statusMux()

	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/debug/cache-diagnostic", nil)
	request.RemoteAddr = "127.0.0.1:5555"
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("a disabled diagnostic must not answer: got %d", recorder.Code)
	}
}

// TestTheCacheDiagnosticRouteIsLoopbackGetAndRedactionSafe covers the enabled surface.
func TestTheCacheDiagnosticRouteIsLoopbackGetAndRedactionSafe(t *testing.T) {
	t.Setenv("PROJECTIOND_CACHE_DIAGNOSTIC", "1")
	playback := cache.NewPlaybackCache(1<<20, 1<<20)
	if !playback.DiagnosticEnabled() {
		t.Fatal("the diagnostic did not turn on")
	}
	key := cache.Key{ProjectedVersionID: "a-distinctive-version", IdentityDigest: "a-distinctive-digest",
		Offset: 4096, Length: 4096}
	playback.Get(3, key, make([]byte, 4096))
	playback.Put(3, key, make([]byte, 4096))
	playback.DropHandle(3)

	d := &Daemon{Playback: playback, cfg: Config{StatusAddr: "127.0.0.1:0"}, startedAt: time.Now()}
	mux := d.statusMux()

	// A REMOTE CALLER GETS NOTHING, and gets it as a 404 rather than a 403: the surface does not confirm
	// its own existence to somebody who should not see it.
	remote := httptest.NewRequest(http.MethodGet, "http://10.0.0.7/debug/cache-diagnostic", nil)
	remote.RemoteAddr = "10.0.0.7:5555"
	remoteRecorder := httptest.NewRecorder()
	mux.ServeHTTP(remoteRecorder, remote)
	if remoteRecorder.Code != http.StatusNotFound {
		t.Fatalf("a non-loopback caller must get 404: got %d", remoteRecorder.Code)
	}

	// ANYTHING BUT GET IS REFUSED VISIBLY.
	post := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/debug/cache-diagnostic", nil)
	post.RemoteAddr = "127.0.0.1:5555"
	postRecorder := httptest.NewRecorder()
	mux.ServeHTTP(postRecorder, post)
	if postRecorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("a POST must be refused with 405: got %d", postRecorder.Code)
	}

	// AND A LOOPBACK GET RETURNS A COHERENT, REDACTION-SAFE REPORT.
	local := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/debug/cache-diagnostic", nil)
	local.RemoteAddr = "127.0.0.1:5555"
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, local)
	if recorder.Code != http.StatusOK {
		t.Fatalf("a loopback GET must answer: got %d", recorder.Code)
	}
	if store := recorder.Header().Get("Cache-Control"); store != "no-store" {
		t.Fatalf("a point-in-time view must not be cached: Cache-Control %q", store)
	}
	body := recorder.Body.String()
	for _, forbidden := range []string{"a-distinctive-version", "a-distinctive-digest"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("the endpoint leaked %q: %s", forbidden, body)
		}
	}
	var report cache.Report
	if err := json.Unmarshal([]byte(body), &report); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !report.Enabled || !report.Complete || report.Dropped != 0 {
		t.Fatalf("this window lost nothing, so it must report complete: %+v", report)
	}
	if len(report.Events) == 0 {
		t.Fatal("the events were recorded and must be reported")
	}
	// The summary describes THESE events: one miss, cached, then released.
	if report.Summary.DistinctBlocks != 1 {
		t.Fatalf("one block was cached, got %d", report.Summary.DistinctBlocks)
	}
}

// TestTheCacheDiagnosticEndpointIsBoundedAndSaysWhatItLost drives more events than the ring holds THROUGH
// THE MUX, because "bounded" is a property of what the endpoint returns and a three-event fixture cannot
// show it. It also re-checks redaction at scale: a payload is easy to keep clean when it is nearly empty.
func TestTheCacheDiagnosticEndpointIsBoundedAndSaysWhatItLost(t *testing.T) {
	t.Setenv("PROJECTIOND_CACHE_DIAGNOSTIC", "1")
	playback := cache.NewPlaybackCache(1<<20, 1<<20)

	const misses = 4096 + 300
	for i := 0; i < misses; i++ {
		key := cache.Key{ProjectedVersionID: "a-distinctive-version",
			IdentityDigest: "a-distinctive-digest", Offset: int64(i) * 4096, Length: 4096}
		playback.Get(uint64(i), key, make([]byte, 4096))
	}

	d := &Daemon{Playback: playback, cfg: Config{StatusAddr: "127.0.0.1:0"}, startedAt: time.Now()}
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/debug/cache-diagnostic", nil)
	request.RemoteAddr = "127.0.0.1:5555"
	recorder := httptest.NewRecorder()
	d.statusMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("a loopback GET must answer: got %d", recorder.Code)
	}

	var report cache.Report
	if err := json.Unmarshal(recorder.Body.Bytes(), &report); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(report.Events) != 4096 {
		t.Fatalf("the endpoint must return exactly the ring: got %d events", len(report.Events))
	}
	if report.Dropped != int64(misses-4096) {
		t.Fatalf("it must report %d dropped, got %d", misses-4096, report.Dropped)
	}
	if report.Complete {
		t.Fatal("a truncated window must not be reported as complete")
	}
	// REDACTION AT SCALE, over the whole payload rather than a sample of it.
	body := recorder.Body.String()
	for _, forbidden := range []string{"a-distinctive-version", "a-distinctive-digest"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("the endpoint leaked %q at scale", forbidden)
		}
	}
}
