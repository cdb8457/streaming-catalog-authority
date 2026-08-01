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
	"time"
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

// A HOLD MUST ACTUALLY BLOCK, AND A RELEASE MUST ACTUALLY RELEASE.
//
// This is what lets a gate prove something happened "while a library scan was running" without racing a
// scanner: the scan blocks in an uncached provider read for exactly as long as the gate holds it. If the hold
// did not block, the gate would silently go back to being a coin flip; if the release did not release, every
// later assertion would fail for an unrelated reason.
func TestHoldBlocksARangeRequestUntilReleased(t *testing.T) {
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	server.AddObject("obj-held", 8192)
	server.Hold("obj-held")

	done := make(chan int)
	go func() {
		request, _ := http.NewRequest(http.MethodGet, server.DirectURL()+"/obj-held", nil)
		request.Header.Set("Range", byteRange(0, 1023))
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			done <- 0
			return
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		done <- len(body)
	}()

	select {
	case <-done:
		t.Fatal("a held request was served without waiting for the release")
	case <-time.After(250 * time.Millisecond):
		// Still blocked, which is the point.
	}
	if held := server.Counters().HeldRequests.Load(); held != 1 {
		t.Fatalf("held requests: got %d, want 1 — a gate proves its hold was HIT by this counter", held)
	}

	server.Release("obj-held")
	select {
	case n := <-done:
		if n != 1024 {
			t.Fatalf("after release the request returned %d bytes, want 1024", n)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the release did not release")
	}
}

func TestHoldIsBoundedSoAForgottenReleaseCannotWedgeAReader(t *testing.T) {
	// A gate that crashed between Hold and Release must degrade into a slow read, not a failed one: the bound
	// is deliberately shorter than the range adapter's default request timeout.
	server, err := New(Options{MaxHold: 150 * time.Millisecond})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	server.AddObject("obj-forgotten", 4096)
	server.Hold("obj-forgotten")

	started := time.Now()
	request, _ := http.NewRequest(http.MethodGet, server.DirectURL()+"/obj-forgotten", nil)
	request.Header.Set("Range", byteRange(0, 511))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("ranged get: %v", err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if len(body) != 512 {
		t.Fatalf("a self-released hold served %d bytes, want 512", len(body))
	}
	if elapsed := time.Since(started); elapsed < 100*time.Millisecond {
		t.Fatalf("the hold did not block at all (%v)", elapsed)
	}
}

func TestReleasingSomethingNotHeldIsNotAnError(t *testing.T) {
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	server.Release("never-held")
	server.AddObject("obj-a", 1024)
	request, _ := http.NewRequest(http.MethodGet, server.DirectURL()+"/obj-a", nil)
	request.Header.Set("Range", byteRange(0, 99))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("ranged get: %v", err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if held := server.Counters().HeldRequests.Load(); held != 0 {
		t.Fatalf("an unheld request was counted as held: %d", held)
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
