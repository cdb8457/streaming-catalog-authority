package fakeprovider

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// A FILE-BACKED OBJECT MUST SERVE THE FILE, EXACTLY.
//
// The synthetic content function is what every other gate here wants. It is useless to one whose reader has to
// DECODE what it fetched, because pseudo-random bytes have no container header — so the media-server data-plane
// gate serves a file it generated. The failure this guards against is the quiet one: a file-backed object that
// silently fell back to synthetic bytes would serve a perfectly well-formed 206 whose body is not the file, and
// the only symptom would be a media server refusing to play something the gate says it published.

func writeTestFile(t *testing.T, size int) (string, []byte) {
	t.Helper()
	content := make([]byte, size)
	for i := range content {
		content[i] = byte((i*7 + 3) % 251)
	}
	path := filepath.Join(t.TempDir(), "object.bin")
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return path, content
}

func TestFileObjectServesTheFilesOwnBytes(t *testing.T) {
	path, content := writeTestFile(t, 40_000)
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()

	size, err := server.AddFileObject("obj-file", path)
	if err != nil {
		t.Fatalf("add file object: %v", err)
	}
	if size != int64(len(content)) {
		t.Fatalf("size is the file's own: got %d, want %d", size, len(content))
	}

	for _, window := range []struct{ offset, length int64 }{
		{0, 1024}, {12_345, 4096}, {int64(len(content)) - 100, 100},
	} {
		request, _ := http.NewRequest(http.MethodGet, server.DirectURL()+"/obj-file", nil)
		request.Header.Set("Range", byteRange(window.offset, window.offset+window.length-1))
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("ranged get: %v", err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != http.StatusPartialContent {
			t.Fatalf("status: got %d, want 206", response.StatusCode)
		}
		want := content[window.offset : window.offset+window.length]
		if string(body) != string(want) {
			t.Fatalf("body at %d+%d is not the file's bytes", window.offset, window.length)
		}
		// And it is NOT the synthetic function, which is the whole point of the mode existing.
		if string(body) == string(ObjectBytes("obj-file", window.offset, window.length)) {
			t.Fatalf("a file-backed object fell back to the deterministic content function")
		}
	}
}

func TestFileObjectDigestsDescribeWhatAReaderGets(t *testing.T) {
	path, content := writeTestFile(t, 20_000)
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	if _, err := server.AddFileObject("obj-file", path); err != nil {
		t.Fatalf("add file object: %v", err)
	}
	object, ok := server.ObjectFor("obj-file")
	if !ok {
		t.Fatal("the object is not registered")
	}
	whole, err := server.BytesOf(object, 0, object.Size)
	if err != nil {
		t.Fatalf("bytes of: %v", err)
	}
	expected := sha256.Sum256(content)
	actual := sha256.Sum256(whole)
	if hex.EncodeToString(actual[:]) != hex.EncodeToString(expected[:]) {
		t.Fatal("the whole-object digest is not the file's digest")
	}
}

func TestAddFileObjectRefusesWhatItCannotServe(t *testing.T) {
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()

	if _, err := server.AddFileObject("missing", filepath.Join(t.TempDir(), "nope.bin")); err == nil {
		t.Fatal("a missing file was accepted")
	}
	// An EMPTY file would register a zero-byte object, which every size check downstream would then have to
	// special-case. Refusing it at the door is one rule instead of several.
	empty := filepath.Join(t.TempDir(), "empty.bin")
	if err := os.WriteFile(empty, nil, 0o644); err != nil {
		t.Fatalf("write empty: %v", err)
	}
	if _, err := server.AddFileObject("empty", empty); err == nil {
		t.Fatal("an empty file was accepted")
	}
	if _, err := server.AddFileObject("dir", t.TempDir()); err == nil {
		t.Fatal("a directory was accepted")
	}
}

// THE COUNTERS SURFACE MUST NOT PERTURB THE COUNTERS IT REPORTS. A gate reads it repeatedly while a budget is
// being measured; if reading it cost a range request, every budget would grow with the number of times
// somebody looked, and the gate would eventually be loosened to accommodate its own instrumentation.
func TestCountersEndpointIsNotItselfCounted(t *testing.T) {
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	server.AddObject("obj-a", 8192)

	request, _ := http.NewRequest(http.MethodGet, server.DirectURL()+"/obj-a", nil)
	request.Header.Set("Range", byteRange(0, 1023))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("ranged get: %v", err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()

	read := func() CountersSnapshot {
		resp, err := http.Get(server.BaseURL() + "/counters")
		if err != nil {
			t.Fatalf("counters: %v", err)
		}
		defer resp.Body.Close()
		var snapshot CountersSnapshot
		if err := json.NewDecoder(resp.Body).Decode(&snapshot); err != nil {
			t.Fatalf("decode counters: %v", err)
		}
		return snapshot
	}

	first := read()
	if first.RangeRequests != 1 {
		t.Fatalf("range requests: got %d, want 1", first.RangeRequests)
	}
	if first.BytesServed != 1024 {
		t.Fatalf("bytes served: got %d, want 1024", first.BytesServed)
	}
	for i := 0; i < 5; i++ {
		again := read()
		if again.RangeRequests != first.RangeRequests || again.Resolutions != first.Resolutions {
			t.Fatalf("reading the counters moved them: %+v then %+v", first, again)
		}
	}
	// The snapshot and the atomics agree, so a gate reading over HTTP and a test reading in process are
	// asserting on the same numbers rather than two that happen to look alike.
	if first.RangeRequests != server.Counters().RangeRequests.Load() {
		t.Fatal("the snapshot disagrees with the counters it was taken from")
	}
}

func byteRange(start, end int64) string {
	return "bytes=" + itoa(start) + "-" + itoa(end)
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	digits := ""
	for v > 0 {
		digits = string(rune('0'+v%10)) + digits
		v /= 10
	}
	return digits
}
