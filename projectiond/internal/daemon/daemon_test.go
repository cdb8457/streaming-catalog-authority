package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
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
