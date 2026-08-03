package fakeprovider

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

// THE GAUGE MUST TRACK WHO IS BLOCKED RIGHT NOW, not who was ever blocked.
//
// A lifetime counter cannot support "a request was still blocked while the successor was published": the
// waiter may have stopped being blocked long before, because maxHold fires and the request proceeds while the
// hold entry is still in the map. Only a live gauge answers the present-tense question, and only a timeout
// counter shows that the window had a gap in it.
func TestCurrentHeldWaitersTracksLiveWaitersAndReturnsToZero(t *testing.T) {
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	server.AddObject("obj-gauge", 8192)
	server.Hold("obj-gauge")

	const waiters = 3
	done := make(chan error, waiters)
	for i := 0; i < waiters; i++ {
		go func() {
			request, _ := http.NewRequest(http.MethodGet, server.DirectURL()+"/obj-gauge", nil)
			request.Header.Set("Range", byteRange(0, 255))
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				done <- err
				return
			}
			io.Copy(io.Discard, response.Body)
			response.Body.Close()
			done <- nil
		}()
	}

	// Wait, boundedly, for all three to be blocked at once.
	deadline := time.Now().Add(5 * time.Second)
	for server.Counters().CurrentHeldWaiters.Load() < waiters {
		if time.Now().After(deadline) {
			t.Fatalf("only %d of %d waiters ever blocked", server.Counters().CurrentHeldWaiters.Load(), waiters)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if timeouts := server.Counters().HoldTimeouts.Load(); timeouts != 0 {
		t.Fatalf("a hold timed out while it was supposed to be holding: %d", timeouts)
	}

	server.Release("obj-gauge")
	for i := 0; i < waiters; i++ {
		if err := <-done; err != nil {
			t.Fatalf("a released waiter failed: %v", err)
		}
	}
	// THE GAUGE MUST COME BACK DOWN, or every later assertion built on it is reading a leak.
	deadline = time.Now().Add(5 * time.Second)
	for server.Counters().CurrentHeldWaiters.Load() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("the gauge did not return to zero: %d", server.Counters().CurrentHeldWaiters.Load())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if held := server.Counters().HeldRequests.Load(); held != waiters {
		t.Fatalf("lifetime held requests: got %d, want %d", held, waiters)
	}
	if timeouts := server.Counters().HoldTimeouts.Load(); timeouts != 0 {
		t.Fatalf("a released hold must not be counted as a timeout: %d", timeouts)
	}
}

// A LAPSED HOLD IS COUNTED, AND THE GAUGE DROPS EVEN THOUGH NOBODY RELEASED IT.
//
// This is the exact shape the gate has to be able to detect: the counter that says "a request entered a hold"
// stays up, while the request is no longer blocked at all. Without HoldTimeouts and the gauge, a gate could
// print that a provider request was blocked across a publish when the block had already lapsed.
func TestAHoldThatLapsesIsCountedAndFreesItsWaiter(t *testing.T) {
	server, err := New(Options{MaxHold: 120 * time.Millisecond})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	server.AddObject("obj-lapse", 4096)
	server.Hold("obj-lapse")

	request, _ := http.NewRequest(http.MethodGet, server.DirectURL()+"/obj-lapse", nil)
	request.Header.Set("Range", byteRange(0, 511))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("ranged get: %v", err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()

	if timeouts := server.Counters().HoldTimeouts.Load(); timeouts != 1 {
		t.Fatalf("hold timeouts: got %d, want 1 — a lapsed hold must be visible", timeouts)
	}
	if live := server.Counters().CurrentHeldWaiters.Load(); live != 0 {
		t.Fatalf("current waiters after a lapse: got %d, want 0", live)
	}
	// And the lifetime counter is still up, which is precisely why it cannot be the evidence on its own.
	if held := server.Counters().HeldRequests.Load(); held != 1 {
		t.Fatalf("lifetime held requests: got %d, want 1", held)
	}
	// THE HOLD ENTRY IS STILL IN THE MAP after a lapse, so a later request blocks again rather than the hold
	// silently evaporating. A gate that released and re-checked would otherwise see an inconsistent world.
	server.Release("obj-lapse")
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

// TestRequestShapeBucketsClassifyEverySizeExactlyOnce drives the four request-shape buckets over every
// boundary that separates them, and holds them to the one property that makes them trustworthy: they
// partition.
//
// WHY THIS TELEMETRY EXISTS. A gate measured 32,505,856 bytes over 10 ranged requests for one object and
// could say nothing about the mix — 7.75 demand blocks is not a whole number of anything. Without the shape,
// the only way to turn that total into a budget is to pick a multiplier that clears it, which records the
// observation instead of constraining it.
//
// WHY FOUR BUCKETS, AND WHY EVERY BOUNDARY IS DRIVEN FROM BOTH SIDES. The middle used to be one "other"
// bucket. gate7's corpus scan produced thirteen of them and failed a budget asserting they could not exist —
// but they were legitimate: `readpath.demandBlock` clips a block to the gap between cached probe windows, so
// a read bounded by cached data returns something between a window and a block. A body ABOVE a demand block
// is a different thing entirely and still must never occur. One bucket could not admit the first without
// admitting the second, so the boundaries below are asserted at exactly the byte where they change.
func TestRequestShapeBucketsClassifyEverySizeExactlyOnce(t *testing.T) {
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	server.AddObject("obj-shape", 64*1024*1024)

	const window = 1024 * 1024
	const block = 4 * 1024 * 1024

	get := func(from, to int64) {
		request, _ := http.NewRequest(http.MethodGet, server.DirectURL()+"/obj-shape", nil)
		request.Header.Set("Range", byteRange(from, to))
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("ranged get: %v", err)
		}
		if _, err := io.Copy(io.Discard, response.Body); err != nil {
			t.Fatalf("reading the body: %v", err)
		}
		response.Body.Close()
	}
	// getSize requests exactly n bytes starting at a distinct offset, so no two reads overlap.
	var cursor int64
	getSize := func(n int64) {
		get(cursor, cursor+n-1)
		cursor += n
	}

	// EVERY BOUNDARY, FROM BOTH SIDES.
	getSize(4096)       // small: well under a window
	getSize(window)     // small: EXACTLY one probe window, the closed end of the small bucket
	getSize(window + 1) // partial: one byte more is no longer small
	getSize(block - 1)  // partial: one byte short of a block is still partial
	getSize(block)      // chunk: EXACTLY one demand block
	getSize(block + 1)  // oversized: one byte more is no longer a block
	getSize(2 * block)  // oversized: and so is anything larger

	snapshot := server.Snapshot()

	if snapshot.ChunkResponses != 1 || snapshot.ChunkBytes != block {
		t.Fatalf("chunk bucket: got %d responses / %d bytes, want 1 / %d",
			snapshot.ChunkResponses, snapshot.ChunkBytes, block)
	}
	if snapshot.SmallResponses != 2 || snapshot.SmallBytes != 4096+window {
		t.Fatalf("small bucket: got %d responses / %d bytes, want 2 / %d — a body of EXACTLY one probe "+
			"window is small, not partial", snapshot.SmallResponses, snapshot.SmallBytes, 4096+window)
	}
	if snapshot.PartialResponses != 2 || snapshot.PartialBytes != (window+1)+(block-1) {
		t.Fatalf("partial bucket: got %d responses / %d bytes, want 2 / %d — one byte over a window and one "+
			"byte under a block are both partial", snapshot.PartialResponses, snapshot.PartialBytes,
			(window+1)+(block-1))
	}
	if snapshot.OversizedResponses != 2 || snapshot.OversizedBytes != (block+1)+2*block {
		t.Fatalf("oversized bucket: got %d responses / %d bytes, want 2 / %d — one byte over a block is "+
			"oversized", snapshot.OversizedResponses, snapshot.OversizedBytes, (block+1)+2*block)
	}

	// THE TWO PARTITION PROPERTIES, which are what make the buckets usable as evidence.
	//
	// BYTES: every served byte is in exactly one bucket.
	sum := snapshot.ChunkBytes + snapshot.SmallBytes + snapshot.PartialBytes + snapshot.OversizedBytes
	if sum != snapshot.BytesServed {
		t.Fatalf("the byte buckets do not partition: %d + %d + %d + %d = %d, but %d bytes were served",
			snapshot.ChunkBytes, snapshot.SmallBytes, snapshot.PartialBytes, snapshot.OversizedBytes,
			sum, snapshot.BytesServed)
	}
	// REQUESTS: and every ranged request lands in exactly one bucket, bodyless ones included. This is the
	// property bytes alone cannot give — two responses filed as one leave the byte total intact and the
	// count wrong, and the count is what a request geometry is derived from.
	count := snapshot.ChunkResponses + snapshot.SmallResponses +
		snapshot.PartialResponses + snapshot.OversizedResponses
	if total := count + snapshot.BodylessResponses; total != snapshot.AccountedResponses {
		t.Fatalf("the response buckets do not partition: %d classified + %d bodyless = %d, but %d ranged requests arrived",
			count, snapshot.BodylessResponses, total, snapshot.AccountedResponses)
	}
	if count != 7 || snapshot.BodylessResponses != 0 {
		t.Fatalf("seven bodies were served and none refused, but %d classified / %d bodyless",
			count, snapshot.BodylessResponses)
	}
}

// TestAFullBodyAnsweringARangedRequestIsCountedOversized is the case the oversized bucket exists for.
//
// A 200 with the whole object, in answer to a ranged request, is the most expensive protocol failure this
// endpoint can inject — the daemon downloading a file to answer a probe. Before the split it landed in the
// same bucket as a harmless clipped block, so no budget could refuse one without also refusing the other.
func TestAFullBodyAnsweringARangedRequestIsCountedOversized(t *testing.T) {
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	const size = 40 * 1024 * 1024
	server.AddObject("obj-full", size)
	server.InjectFault("obj-full", FaultFullBodyOnRange, 1)

	request, _ := http.NewRequest(http.MethodGet, server.DirectURL()+"/obj-full", nil)
	request.Header.Set("Range", byteRange(0, 1024*1024-1))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("ranged get: %v", err)
	}
	read, err := io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatalf("reading the body: %v", err)
	}
	if read != size {
		t.Fatalf("the fault should have served the whole %d-byte object, served %d", size, read)
	}

	snapshot := server.Snapshot()
	if snapshot.OversizedResponses != 1 || snapshot.OversizedBytes != size {
		t.Fatalf("a whole-object answer to a ranged request must be OVERSIZED: got %d responses / %d bytes",
			snapshot.OversizedResponses, snapshot.OversizedBytes)
	}
	if snapshot.PartialResponses != 0 {
		t.Fatalf("and it must not be filed as a clipped block: partial=%d", snapshot.PartialResponses)
	}
	if snapshot.FullBodyServed != 1 {
		t.Fatalf("the dedicated full-body counter still counts it too: %d", snapshot.FullBodyServed)
	}
}

// TestAClippedBlockIsPartialAndNotOversized covers the shape gate7 actually met: a demand block clipped by
// the end of the object, which is what a read near EOF produces.
func TestAClippedBlockIsPartialAndNotOversized(t *testing.T) {
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	// 13,981,407 bytes: the anchor fixture's real length. Its last aligned block is 1,398,495 bytes — over a
	// probe window, under a demand block — which is exactly the class gate7 measured thirteen of.
	const size = 13_981_407
	server.AddObject("obj-anchor", size)

	const block = 4 * 1024 * 1024
	request, _ := http.NewRequest(http.MethodGet, server.DirectURL()+"/obj-anchor", nil)
	request.Header.Set("Range", byteRange(3*block, size-1))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("ranged get: %v", err)
	}
	read, err := io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatalf("reading the body: %v", err)
	}

	want := int64(size - 3*block)
	if read != want {
		t.Fatalf("the clipped block should be %d bytes, served %d", want, read)
	}
	snapshot := server.Snapshot()
	if snapshot.PartialResponses != 1 || snapshot.PartialBytes != want {
		t.Fatalf("a block clipped by EOF is PARTIAL: got %d responses / %d bytes, want 1 / %d",
			snapshot.PartialResponses, snapshot.PartialBytes, want)
	}
	if snapshot.OversizedResponses != 0 || snapshot.ChunkResponses != 0 {
		t.Fatalf("and it is neither oversized nor a full block: oversized=%d chunk=%d",
			snapshot.OversizedResponses, snapshot.ChunkResponses)
	}
}

// TestEveryBodylessReturnIsCounted drives the request partition across the no-body paths that broke the first
// version of it, and it is deliberately broad rather than a single 429.
//
// THE DEFECT THIS CLOSES. The reconciliation originally added back only Served429 and ExpiredRejected, and
// this endpoint returns without a body in a dozen other places. Every one of them made the partition short
// while the gate asserting it claimed to account for every ranged request. The counter is now incremented by
// a deferred check rather than by each branch remembering, so this test's job is to prove the check fires on
// paths that have nothing in common except serving nothing.
func TestEveryBodylessReturnIsCounted(t *testing.T) {
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	server.AddObject("obj-partition", 8*1024*1024)

	// A TRANSPORT ERROR HERE IS FATAL, and the first draft of this helper swallowed one with a comment
	// claiming the request had still been counted. That is not guaranteed: a transport failure can happen
	// before `serveRange` runs at all, which would leave the endpoint's counters one short and make the
	// expected totals below pass or fail for a reason that has nothing to do with the partition. Every
	// branch this test exercises answers with an HTTP response, so there is no legitimate transport error.
	get := func(ref, rangeHeader string) {
		t.Helper()
		request, _ := http.NewRequest(http.MethodGet, server.DirectURL()+"/"+ref, nil)
		if rangeHeader != "" {
			request.Header.Set("Range", rangeHeader)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("ranged get %q: %v", ref, err)
		}
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
	}

	// One good body, so the classified side is non-zero and the equation is not trivially satisfied.
	get("obj-partition", byteRange(0, 1023))

	// ...and then every shape of bodyless return that does not need a clock: an unknown object, a malformed
	// Range header, and four injected status refusals. Each is a different branch of serveRange.
	get("obj-does-not-exist", byteRange(0, 1023))
	get("obj-partition", "not-a-range-header")
	for _, fault := range []Fault{Fault401, Fault403, Fault410, Fault429, Fault503} {
		server.InjectFault("obj-partition", fault, 1)
		get("obj-partition", byteRange(0, 1023))
	}

	snapshot := server.Snapshot()
	classified := snapshot.ChunkResponses + snapshot.SmallResponses +
		snapshot.PartialResponses + snapshot.OversizedResponses
	if classified != 1 {
		t.Fatalf("exactly one request served a body, but %d were classified", classified)
	}
	if snapshot.BodylessResponses != 7 {
		t.Fatalf("seven requests should have served no body, got %d", snapshot.BodylessResponses)
	}
	// THE EQUATION THE GATES ASSERT. If either side changes, this breaks here rather than in a thirty-minute
	// Docker run.
	if total := classified + snapshot.BodylessResponses; total != snapshot.AccountedResponses {
		t.Fatalf("partition: %d classified + %d bodyless = %d, but %d ranged requests arrived",
			classified, snapshot.BodylessResponses, total, snapshot.AccountedResponses)
	}
	// ...and none of the bodyless returns contributed bytes to any bucket.
	bucketed := snapshot.ChunkBytes + snapshot.SmallBytes + snapshot.PartialBytes + snapshot.OversizedBytes
	if bucketed != snapshot.BytesServed {
		t.Fatalf("byte buckets %d do not match bytes served %d", bucketed, snapshot.BytesServed)
	}
	if snapshot.BytesServed != 1024 {
		t.Fatalf("only the one good request should have served bytes, got %d", snapshot.BytesServed)
	}
}

// TestRequestShapeCountersCarryNothingIdentifying is a redaction assertion over a telemetry surface.
//
// The gates print provider counters into their logs. A shape counter that had grown a per-request record —
// an offset, a reference, a lease — would put exactly the material this product promises never to persist
// into the one place nobody thinks to check. The wire shape is asserted to be flat integers and nothing else.
func TestRequestShapeCountersCarryNothingIdentifying(t *testing.T) {
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	server.AddObject("obj-secret-reference", 4096)

	request, _ := http.NewRequest(http.MethodGet, server.DirectURL()+"/obj-secret-reference", nil)
	request.Header.Set("Range", byteRange(0, 4095))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("ranged get: %v", err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()

	resp, err := http.Get(server.BaseURL() + "/counters")
	if err != nil {
		t.Fatalf("counters: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read counters: %v", err)
	}
	text := string(body)
	for _, forbidden := range []string{"obj-secret-reference", "Range", "bytes=", "http://", "offset"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("the counters payload contains %q: %s", forbidden, text)
		}
	}
	// Every value is a number. A string anywhere in here would be something that came from a request.
	var generic map[string]any
	if err := json.Unmarshal(body, &generic); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for key, value := range generic {
		if _, ok := value.(float64); ok {
			continue
		}
		// The one non-scalar is the per-object byte array, and the rule holds inside it: every ELEMENT must
		// be a number too. An array of numbers carries no reference, URL, lease, offset or per-request
		// sequence — its index is the registration order of objects, which is a deliberate part of the
		// contract rather than a leak. An array
		// containing anything else would be a request record in disguise.
		elements, isArray := value.([]any)
		// The array-valued counters are the ordinal-aligned per-object columns. The rule holds INSIDE each of
		// them: every element must be a number, so an array of numbers carries no reference, URL, lease, offset
		// or per-request sequence — only the registration ordering the contract documents.
		perObjectColumns := map[string]bool{
			"objectBytes": true, "objectObserved": true, "objectSizes": true, "objectChunk": true,
			"objectSmall": true, "objectPartial": true, "objectOversized": true,
		}
		if !isArray || !perObjectColumns[key] {
			t.Fatalf("counter %q is not a number: %#v", key, value)
		}
		for index, element := range elements {
			if _, ok := element.(float64); !ok {
				t.Fatalf("%s[%d] is not a number: %#v", key, index, element)
			}
		}
	}
}

// TestAResponseIsCountedBeforeItsBytesLeave pins the ORDER of counting and writing, which is what makes a
// counter snapshot taken at a phase boundary trustworthy.
//
// THE DEFECT THIS CLOSES. Every body-serving branch used to write the body and then record it. A client that
// read its response to completion could therefore snapshot the counters BEFORE the handler had counted the
// very response it had just finished reading. It surfaced as a "flaky" shape test under `-race` with a
// second package running alongside — the fourth response was still uncounted and the "other" bucket read
// zero — but the flake was the honest signal. A gate takes its counter snapshot immediately after a phase,
// so the last response of a scan could be attributed to the NEXT window: one budget cheaper, the next
// dearer, and the totals still summing correctly so nothing else would notice.
//
// WITH THE INCREMENT AHEAD OF THE WRITE THIS IS NO LONGER A RACE THE TEST HAS TO CATCH IN THE ACT. The bytes
// cannot reach the client before the counter has moved, so "read the body, then snapshot" must agree every
// time. That is asserted per request rather than in aggregate, because an aggregate at the end would pass
// even if every individual observation had been late.
func TestAResponseIsCountedBeforeItsBytesLeave(t *testing.T) {
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	server.AddObject("obj-order", 64*1024*1024)

	// One of each size class, so the ordering is pinned on every branch a scan actually exercises.
	sizes := []int64{4 * 1024 * 1024, 1024 * 1024, 4096, 2 * 1024 * 1024}
	var offset int64
	for round := 0; round < 6; round++ {
		for _, size := range sizes {
			request, _ := http.NewRequest(http.MethodGet, server.DirectURL()+"/obj-order", nil)
			request.Header.Set("Range", byteRange(offset, offset+size-1))
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatalf("ranged get: %v", err)
			}
			read, err := io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if err != nil {
				t.Fatalf("reading the body: %v", err)
			}
			if read != size {
				t.Fatalf("wanted %d bytes, read %d", size, read)
			}
			offset += size

			// THE ASSERTION: the response this client has just finished reading is already counted.
			snapshot := server.Snapshot()
			if snapshot.BytesServed != offset {
				t.Fatalf("round %d, %d-byte read: %d bytes served but only %d counted -- the body reached "+
					"the client before the counter moved", round, size, offset, snapshot.BytesServed)
			}
			classified := snapshot.ChunkResponses + snapshot.SmallResponses +
				snapshot.PartialResponses + snapshot.OversizedResponses
			if classified+snapshot.BodylessResponses != snapshot.AccountedResponses {
				t.Fatalf("round %d: %d classified + %d bodyless != %d requests, so a response is in flight "+
					"between the two halves of the partition",
					round, classified, snapshot.BodylessResponses, snapshot.AccountedResponses)
			}
		}
	}
}

// TestTheCountingWriterIsTheOnlyWayABodyLeavesServeRange asserts the ordering STRUCTURALLY, because the
// behavioural test above cannot be trusted to catch a regression in the act.
//
// WHY A SOURCE ASSERTION AND NOT A TIMING ONE. The window between writing a body and counting it is
// sub-microsecond. Reordering the two and re-running the behavioural test passes: the flake that exposed
// this originally needed a second package running under `-race` to widen the gap. A test that only fails
// when the machine is busy is not a regression test, it is a lottery ticket. The invariant is a property of
// the code — every body goes through one closure, and that closure counts before it writes — so it is
// asserted where it can be asserted deterministically.
func TestTheCountingWriterIsTheOnlyWayABodyLeavesServeRange(t *testing.T) {
	source, err := os.ReadFile("fakeprovider.go")
	if err != nil {
		t.Fatalf("reading the endpoint source: %v", err)
	}
	text := string(source)
	start := strings.Index(text, "func (s *Server) serveRange(")
	if start < 0 {
		t.Fatal("serveRange is not where this test expects it; the assertion below would be vacuous")
	}
	end := strings.Index(text[start+1:], "\nfunc ")
	if end < 0 {
		t.Fatal("could not find the end of serveRange")
	}
	body := text[start : start+1+end]

	// COMMENTS ARE STRIPPED BEFORE ANY OF THE COUNTS BELOW, and finding that out cost a test run. The prose in
	// this closure NAMES the discarded-write shape it exists to refuse, so a raw text count sees two writes
	// where there is one, and the `_, _ =` check matches its own historical note. A rule that catches its own
	// history is the accidental scoping this repository keeps having to correct.
	code := func(in string) string {
		out := make([]string, 0, 64)
		for _, line := range strings.Split(in, "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "//") {
				continue
			}
			out = append(out, line)
		}
		return strings.Join(out, "\n")
	}
	body = code(body)

	// ONE WRITER. Every body-producing branch routes through the closure; a branch that wrote directly would
	// be counted late, or not at all.
	if writes := strings.Count(body, "w.Write("); writes != 1 {
		t.Fatalf("serveRange contains %d body writes, want exactly 1 (the counting closure). A branch that "+
			"writes its own body is counted after its bytes have left, or not counted at all", writes)
	}

	closure := strings.Index(body, "serveBody := func(payload []byte) {")
	if closure < 0 {
		t.Fatal("the counting closure is not shaped as this test expects")
	}
	tail := body[closure:]
	counted := strings.Index(tail, "recordShape(")
	bytesAdded := strings.Index(tail, "BytesServed.Add(")
	written := strings.Index(tail, "w.Write(")
	if counted < 0 || bytesAdded < 0 || written < 0 {
		t.Fatal("the closure no longer both counts and writes")
	}
	// COUNT FIRST. This is the whole invariant: the increment must happen-before the bytes are observable,
	// so a client that has read its response cannot then read counters that omit it.
	if !(counted < written && bytesAdded < written) {
		t.Fatal("the body is written before it is counted, so a client can observe the counters without its " +
			"own response in them -- at a phase boundary that misattributes the response to the next window")
	}

	// ...AND OBSERVE AFTER, WHICH IS THE OTHER HALF AND THE ONE THAT WAS MISSING. The committed length is
	// counted before the write; what the write RETURNED can only be counted after it. A file where the
	// observed add sits before the write would be recording the promise twice under two names.
	observedAdded := strings.Index(tail, "ObservedBytes.Add(")
	if observedAdded < 0 {
		t.Fatal("the closure does not record what Write returned; the only byte figure would be the promise")
	}
	if observedAdded < written {
		t.Fatal("the observed-byte add sits before the write, so it cannot be recording the write's own return")
	}
	// AND THE RETURN IS ACTUALLY USED. `_, _ = w.Write(payload)` is exactly the shape this whole remediation
	// exists to remove, in this file and in internal/fakewebdav.
	if strings.Contains(tail, "_, _ = w.Write(") {
		t.Fatal("the write's count and error are discarded again; every delivery-shaped claim built on this " +
			"endpoint would be unsupported")
	}
}

// A CLIENT THAT CLOSES EARLY MAKES COMMITTED AND OBSERVED COME APART, and the endpoint must say so.
//
// THE DEFECT THIS REFUSES, WHICH SHIPPED IN THIS FILE AND IN internal/fakewebdav. Every body-producing branch
// ended `_, _ = w.Write(payload)`, discarding the count and the error, so the only byte figure was the
// COMMITTED payload length. A report built on that in the sibling package concluded something about delivery
// that its instrument could not support.
func TestAnEarlyClientCloseMakesCommittedAndObservedDiverge(t *testing.T) {
	// THE BODY HAS TO BE BIGGER THAN A SOCKET BUFFER. A small payload is handed to the HTTP stack in full
	// before the peer's close is noticed, and observed then legitimately equals committed — that is not the
	// endpoint being wrong, it is a small body genuinely being written. Divergence needs a write that blocks.
	const size = 8 << 20
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("starting the endpoint: %v", err)
	}
	defer func() { _ = server.Close() }()
	server.AddObject("obj-large", size)

	// KEEP-ALIVES OFF so closing the body closes the connection rather than returning it to a pool after a
	// background drain — a pooled connection would let Go read the remainder and the test would prove nothing.
	transport := &http.Transport{DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	request, err := http.NewRequest(http.MethodGet, server.DirectURL()+"/obj-large", nil)
	if err != nil {
		t.Fatalf("building the request: %v", err)
	}
	request.Header.Set("Range", byteRange(0, size-1))
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("issuing the request: %v", err)
	}
	buffer := make([]byte, 512)
	if _, err := io.ReadFull(response.Body, buffer); err != nil {
		t.Fatalf("reading the first bytes: %v", err)
	}
	_ = response.Body.Close()

	if !server.WaitForSettlement(5 * time.Second) {
		t.Fatal("a body was still writing after five seconds; no observed figure can be read")
	}
	snapshot := server.Snapshot()
	if snapshot.BodiesInFlight != 0 {
		t.Fatalf("the gauge says %d bodies are still writing", snapshot.BodiesInFlight)
	}
	if snapshot.BytesServed != size {
		t.Fatalf("the committed length must still be the whole range: %d", snapshot.BytesServed)
	}
	if snapshot.ObservedBytes >= snapshot.BytesServed {
		t.Fatalf("observed (%d) did not come apart from committed (%d); the write's return is being "+
			"discarded again", snapshot.ObservedBytes, snapshot.BytesServed)
	}
	if snapshot.TruncatedBodies != 1 || snapshot.CompletedBodies != 0 {
		t.Fatalf("an abandoned body must be recorded as truncated: %d truncated, %d completed",
			snapshot.TruncatedBodies, snapshot.CompletedBodies)
	}
	if len(snapshot.ObjectObserved) != 1 || snapshot.ObjectObserved[0] != snapshot.ObservedBytes {
		t.Fatalf("the observed column is not attributed per object: %v against %d",
			snapshot.ObjectObserved, snapshot.ObservedBytes)
	}
	if snapshot.ObjectBytes[0] != size {
		t.Fatalf("the per-object committed column is not the whole range: %d", snapshot.ObjectBytes[0])
	}
}

// THE CONTROL FOR THE TEST ABOVE. If observed were simply always lower — a miscount, a missing final chunk —
// the divergence assertion would pass for the wrong reason and every figure would be understated instead of
// overstated. A client that reads to the end must see the two agree exactly.
func TestAFullyConsumedBodyObservesExactlyWhatItCommitted(t *testing.T) {
	const size = 4096
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("starting the endpoint: %v", err)
	}
	defer func() { _ = server.Close() }()
	server.AddObject("obj-small", size)

	request, err := http.NewRequest(http.MethodGet, server.DirectURL()+"/obj-small", nil)
	if err != nil {
		t.Fatalf("building the request: %v", err)
	}
	request.Header.Set("Range", byteRange(0, size-1))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("issuing the request: %v", err)
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || len(body) != size {
		t.Fatalf("the whole body was not received: %d bytes, err %v", len(body), err)
	}

	if !server.WaitForSettlement(5 * time.Second) {
		t.Fatal("a fully consumed body did not settle")
	}
	snapshot := server.Snapshot()
	if snapshot.ObservedBytes != snapshot.BytesServed || snapshot.ObservedBytes != size {
		t.Fatalf("a fully consumed body must observe exactly what it committed: %d against %d",
			snapshot.ObservedBytes, snapshot.BytesServed)
	}
	if snapshot.CompletedBodies != 1 || snapshot.TruncatedBodies != 0 {
		t.Fatalf("a fully consumed body is completed, not truncated: %d/%d",
			snapshot.CompletedBodies, snapshot.TruncatedBodies)
	}
	if snapshot.CompletedBodies+snapshot.TruncatedBodies != 1 {
		t.Fatal("the outcome partition does not account for the one body served")
	}
}

// A BODYLESS RESPONSE MOVES NEITHER BYTE COLUMN AND NEITHER OUTCOME, so the outcome partition is over BODIES
// rather than over responses. Without this the partition would silently drift every time a refusal was added.
func TestABodylessResponseTouchesNoByteOrOutcomeCounter(t *testing.T) {
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("starting the endpoint: %v", err)
	}
	defer func() { _ = server.Close() }()
	server.AddObject("obj-refused", 4096)
	server.InjectFault("obj-refused", Fault429, 1)

	request, err := http.NewRequest(http.MethodGet, server.DirectURL()+"/obj-refused", nil)
	if err != nil {
		t.Fatalf("building the request: %v", err)
	}
	request.Header.Set("Range", byteRange(0, 1023))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("issuing the request: %v", err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()

	if !server.WaitForSettlement(5 * time.Second) {
		t.Fatal("a bodyless response left something in flight")
	}
	snapshot := server.Snapshot()
	if snapshot.BytesServed != 0 || snapshot.ObservedBytes != 0 {
		t.Fatalf("a refusal moved a byte column: %d committed, %d observed",
			snapshot.BytesServed, snapshot.ObservedBytes)
	}
	if snapshot.CompletedBodies != 0 || snapshot.TruncatedBodies != 0 {
		t.Fatalf("a refusal moved an outcome counter: %d/%d",
			snapshot.CompletedBodies, snapshot.TruncatedBodies)
	}
	if snapshot.BodylessResponses != 1 {
		t.Fatalf("the refusal was not counted as bodiless: %d", snapshot.BodylessResponses)
	}
}

// THE GAUGE MUST RISE WHILE A BODY IS BETWEEN ITS COMMIT AND ITS OBSERVATION, or an unsettled snapshot cannot
// be told from a settled one and the refusal built on it is decorative.
func TestTheInFlightGaugeRisesWhileABodyIsWritingAndReturnsToZero(t *testing.T) {
	const size = 8 << 20
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("starting the endpoint: %v", err)
	}
	defer func() { _ = server.Close() }()
	server.AddObject("obj-slow", size)

	request, err := http.NewRequest(http.MethodGet, server.DirectURL()+"/obj-slow", nil)
	if err != nil {
		t.Fatalf("building the request: %v", err)
	}
	request.Header.Set("Range", byteRange(0, size-1))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("issuing the request: %v", err)
	}
	// Read a little and then STOP, leaving the handler blocked mid-write with the socket buffer full.
	buffer := make([]byte, 512)
	if _, err := io.ReadFull(response.Body, buffer); err != nil {
		t.Fatalf("reading the first bytes: %v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	rose := false
	for time.Now().Before(deadline) {
		if server.Snapshot().BodiesInFlight == 1 {
			rose = true
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !rose {
		t.Fatal("the gauge never rose while a body was demonstrably mid-write")
	}
	// A snapshot taken HERE has the committed length counted and the observed length not. That is the state
	// the gauge exists to describe, and the TS analysis refuses such a snapshot rather than quoting it.
	mid := server.Snapshot()
	if mid.ObservedBytes >= mid.BytesServed {
		t.Fatalf("a mid-write snapshot should show the deficit the gauge warns about: %d against %d",
			mid.ObservedBytes, mid.BytesServed)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if !server.WaitForSettlement(10 * time.Second) {
		t.Fatal("the gauge never returned to zero")
	}
}

// TestPerObjectBytesAttributeEveryServedByte is the counter that turns an aggregate budget into a per-object
// one, and the property that makes it usable: it partitions.
//
// WHY IT EXISTS. gate8's corpus window exceeded its byte ceiling by 47,065 bytes and the telemetry could not
// say which of forty objects spent them — one large object reading itself twice over looks exactly like
// thirty-eight small ones taking an extra pass. A budget that cannot attribute cannot diagnose.
func TestPerObjectBytesAttributeEveryServedByte(t *testing.T) {
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	// Registration order IS the array order, which is the whole indexing contract.
	server.AddObject("obj-a", 8*1024*1024)
	server.AddObject("obj-b", 2*1024*1024)
	server.AddObject("obj-c", 64*1024)

	get := func(ref string, from, to int64) {
		request, _ := http.NewRequest(http.MethodGet, server.DirectURL()+"/"+ref, nil)
		request.Header.Set("Range", byteRange(from, to))
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("ranged get: %v", err)
		}
		if _, err := io.Copy(io.Discard, response.Body); err != nil {
			t.Fatalf("reading the body: %v", err)
		}
		response.Body.Close()
	}

	// Deliberately lopsided: one object is read many times over, the others once. That is the shape the
	// aggregate cannot distinguish, so it is the shape this test asserts on.
	for i := 0; i < 4; i++ {
		get("obj-a", 0, 4*1024*1024-1)
	}
	get("obj-b", 0, 1024*1024-1)
	get("obj-c", 0, 64*1024-1)

	snapshot := server.Snapshot()
	if len(snapshot.ObjectBytes) != 3 {
		t.Fatalf("one entry per registered object, want 3, got %d", len(snapshot.ObjectBytes))
	}
	if want := int64(4 * 4 * 1024 * 1024); snapshot.ObjectBytes[0] != want {
		t.Fatalf("obj-a was read four times over: want %d bytes attributed, got %d",
			want, snapshot.ObjectBytes[0])
	}
	if want := int64(1024 * 1024); snapshot.ObjectBytes[1] != want {
		t.Fatalf("obj-b: want %d, got %d", want, snapshot.ObjectBytes[1])
	}
	if want := int64(64 * 1024); snapshot.ObjectBytes[2] != want {
		t.Fatalf("obj-c: want %d, got %d", want, snapshot.ObjectBytes[2])
	}

	// THE PARTITION. Every served byte is attributed to exactly one object; a shortfall means a body went
	// out for a reference that was never registered, which is the only way attribution can go missing.
	var attributed int64
	for _, bytes := range snapshot.ObjectBytes {
		attributed += bytes
	}
	if attributed != snapshot.BytesServed {
		t.Fatalf("per-object attribution does not partition: %d attributed, %d served",
			attributed, snapshot.BytesServed)
	}

	// AND THE RATIO THE BUDGET CARES ABOUT IS NOW COMPUTABLE PER OBJECT. obj-a read 2x its own length while
	// the aggregate over all three is only 1.55x — the exact confusion that failed gate8 undiagnosed.
	if ratio := float64(snapshot.ObjectBytes[0]) / float64(8*1024*1024); ratio != 2.0 {
		t.Fatalf("obj-a's own ratio is computable and is 2.0, got %v", ratio)
	}
	aggregate := float64(snapshot.BytesServed) / float64(8*1024*1024+2*1024*1024+64*1024)
	if aggregate >= 2.0 {
		t.Fatalf("and the aggregate ratio %v hides it by staying under 2.0, which is the point", aggregate)
	}
}

// TestPerObjectBytesCarryNothingIdentifying is a redaction assertion over the new telemetry surface.
//
// The array is bytes-per-object indexed by registration order. It must never acquire a reference, a URL, a
// lease, an offset, a status or an ordering — the moment it does, it is a request log wearing a counter's
// name, and this endpoint serves media for a product whose whole argument is about not leaking access
// material.
func TestPerObjectBytesCarryNothingIdentifying(t *testing.T) {
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	server.AddObject("a-very-distinctive-reference-name", 1024)

	request, _ := http.NewRequest(http.MethodGet, server.DirectURL()+"/a-very-distinctive-reference-name", nil)
	request.Header.Set("Range", byteRange(0, 1023))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("ranged get: %v", err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()

	// THE WHOLE PAYLOAD, NOT JUST THE ARRAY. A previous version marshalled ObjectBytes alone, which cannot
	// catch a reference leaking into some field added beside it. What a gate publishes is the whole snapshot,
	// so the whole snapshot is what gets checked.
	encoded, err := json.Marshal(server.Snapshot())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	rendered := string(encoded)
	if strings.Contains(rendered, "a-very-distinctive-reference") {
		t.Fatalf("the counters payload names a reference: %s", rendered)
	}
	// Every VALUE is a number, or an array of numbers. Keys are field names this test file can read; values
	// are the only place a request could leave a trace.
	var generic map[string]any
	if err := json.Unmarshal(encoded, &generic); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for key, value := range generic {
		if _, ok := value.(float64); ok {
			continue
		}
		elements, isArray := value.([]any)
		if !isArray {
			t.Fatalf("counter %q is neither a number nor an array of them: %#v", key, value)
		}
		for index, element := range elements {
			if _, ok := element.(float64); !ok {
				t.Fatalf("%s[%d] is not a number: %#v", key, index, element)
			}
		}
	}
	// And it is BOUNDED by registration, not by traffic: one entry, however many requests arrive.
	for i := 0; i < 25; i++ {
		again, _ := http.NewRequest(http.MethodGet, server.DirectURL()+"/a-very-distinctive-reference-name", nil)
		again.Header.Set("Range", byteRange(0, 511))
		resp, err := http.DefaultClient.Do(again)
		if err != nil {
			t.Fatalf("ranged get: %v", err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}
	if got := len(server.Snapshot().ObjectBytes); got != 1 {
		t.Fatalf("twenty-six requests must still be one entry, got %d", got)
	}

	// AND THE ONE THING THE ARRAYS DO CARRY IS AN OBJECT ORDERING, which the comments now say outright. It
	// is asserted here so the claim and the behaviour cannot drift apart: position is stable and meaningful.
	server.AddObject("second-object", 2048)
	if got := len(server.Snapshot().ObjectSizes); got != 2 {
		t.Fatalf("a second registration takes the next slot, want 2 entries, got %d", got)
	}
	if sizes := server.Snapshot().ObjectSizes; sizes[0] != 1024 || sizes[1] != 2048 {
		t.Fatalf("registration order is the array order, got %v", sizes)
	}
}

// TestConcurrentRegistrationKeepsTheTwoArraysCoherent is the race the single-lock snapshot exists for.
//
// THE DEFECT THIS CLOSES. ObjectBytes and ObjectSizes were built by two methods that each took the lock
// separately. An AddObject landing between them produced arrays of DIFFERENT LENGTHS, and a caller pairing
// them by index would read one object's bytes against the next object's size — silently, and only under a
// race it could never reproduce on demand. A gate registers objects while earlier ones are being read, so
// the window is real rather than theoretical.
//
// TWO PROPERTIES, BOTH ASSERTED ON EVERY SNAPSHOT TAKEN DURING THE STORM:
//
//	the arrays are the same length, always — a snapshot never straddles a registration
//	the ordinal prefix is STABLE — object i keeps its slot and its size forever, so a delta taken across
//	two snapshots is a delta for one object rather than for whatever landed in that slot
//
// It also re-registers existing references, because AddObject is idempotent by reference and a re-register
// that reassigned an ordinal would shuffle the array under a gate mid-measurement.
func TestConcurrentRegistrationKeepsTheTwoArraysCoherent(t *testing.T) {
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()

	const objects = 60
	sizeFor := func(i int) int64 { return int64(1024 * (i + 1)) }
	refFor := func(i int) string { return fmt.Sprintf("obj-%03d", i) }

	// One object exists before the storm, so every snapshot has a prefix to be stable about.
	server.AddObject(refFor(0), sizeFor(0))

	var wg sync.WaitGroup
	stop := make(chan struct{})

	// Registrations, and re-registrations of references already present.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 1; i < objects; i++ {
			server.AddObject(refFor(i), sizeFor(i))
			server.AddObject(refFor(i/2), sizeFor(i/2)) // re-register an existing reference
		}
		close(stop)
	}()

	// Snapshots taken continuously against it, each one checked as it arrives.
	wg.Add(1)
	go func() {
		defer wg.Done()
		previous := []int64{}
		for {
			select {
			case <-stop:
				return
			default:
			}
			snapshot := server.Snapshot()
			if len(snapshot.ObjectBytes) != len(snapshot.ObjectSizes) {
				t.Errorf("a snapshot straddled a registration: %d byte totals against %d sizes",
					len(snapshot.ObjectBytes), len(snapshot.ObjectSizes))
				return
			}
			// THE PREFIX NEVER CHANGES. Whatever this snapshot knows, it agrees with every earlier one about
			// the objects they both knew — including their sizes, which is what makes an ordinal a handle.
			if len(snapshot.ObjectSizes) < len(previous) {
				t.Errorf("the array shrank, from %d to %d", len(previous), len(snapshot.ObjectSizes))
				return
			}
			for i, size := range previous {
				if snapshot.ObjectSizes[i] != size {
					t.Errorf("ordinal %d changed size from %d to %d: a re-registration shuffled the array",
						i, size, snapshot.ObjectSizes[i])
					return
				}
			}
			previous = snapshot.ObjectSizes
		}
	}()

	wg.Wait()

	// And the finished state is exactly what was registered, in registration order.
	final := server.Snapshot()
	if len(final.ObjectSizes) != objects {
		t.Fatalf("every distinct reference took one slot: want %d, got %d", objects, len(final.ObjectSizes))
	}
	for i := 0; i < objects; i++ {
		if final.ObjectSizes[i] != sizeFor(i) {
			t.Fatalf("ordinal %d holds size %d, want %d — registration order is the array order",
				i, final.ObjectSizes[i], sizeFor(i))
		}
	}
	if len(final.ObjectBytes) != len(final.ObjectSizes) {
		t.Fatalf("the two arrays disagree at rest: %d and %d",
			len(final.ObjectBytes), len(final.ObjectSizes))
	}
}

// TestThePrivacyClaimStaysNarrowerThanTheContract stops one specific contradiction from coming back.
//
// THE DEFECT THIS CLOSES. The per-object arrays are indexed by REGISTRATION ORDER — that is the contract, it
// is what makes a position a stable handle across two snapshots, and the field comment says so. Three other
// comments in these same two files nevertheless denied the telemetry carried any ordering at all, which was
// false. Both statements cannot be true, and the false one was the reassuring one.
//
// The rule is narrow and mechanical: any sentence in this package that denies an ordering must say WHICH one
// it means. "No per-request ordering" is true and provable; the bare denial is false the moment an array is
// indexed by anything. A privacy claim that overstates itself is worth less than a smaller accurate one,
// because a reader who finds one overstatement has to doubt the rest.
func TestThePrivacyClaimStaysNarrowerThanTheContract(t *testing.T) {
	for _, name := range []string{"fakeprovider.go", "fileobject_test.go"} {
		source, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("reading %s: %v", name, err)
		}
		for number, line := range strings.Split(string(source), "\n") {
			// Only DENIALS are in scope. A line that merely mentions ordering is describing something, and
			// a scan that flagged those would train its reader to skip it.
			lower := strings.ToLower(line)
			denies := strings.Contains(lower, "no ordering") || strings.Contains(lower, "or ordering") ||
				strings.Contains(lower, "nor ordering") || strings.Contains(lower, "without ordering")
			if !denies {
				continue
			}
			// The assertion's own machinery is not a claim about the telemetry.
			if strings.Contains(line, "strings.Contains(lower") {
				continue
			}
			// Qualified denials are fine, and so is the paragraph that records the correction itself.
			qualified := strings.Contains(line, "per-request") ||
				strings.Contains(line, "registration") ||
				strings.Contains(line, "temporal") ||
				strings.Contains(line, "was") // the paragraph recording that the bare denial was false
			if !qualified {
				t.Errorf("%s:%d claims something about ordering without saying which ordering: %q\n"+
					"the arrays ARE indexed by registration order; only per-request ordering is absent",
					name, number+1, strings.TrimSpace(line))
			}
		}
	}
}

// TestTheAccountedIdentityHoldsWithARequestInFlight is gate9's failure, reproduced deliberately.
//
// THE DEFECT THIS CLOSES. RangeRequests counts ARRIVALS; the class and bytes are recorded when the body is
// served. A request in flight at a snapshot is therefore counted on one side of
// `classified + bodyless == requests` and not the other, and gate9's PX9 window failed 5 against 4 for
// exactly that reason — one request had arrived before the window opened and was classified inside it.
//
// A HELD REQUEST MAKES THE WINDOW DETERMINISTIC. The hold blocks inside serveRange AFTER the arrival is
// counted and BEFORE anything is classified, which is precisely the state that broke the old identity.
func TestTheAccountedIdentityHoldsWithARequestInFlight(t *testing.T) {
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	server.AddObject("obj-flight", 8*1024*1024)
	server.Hold("obj-flight")

	done := make(chan struct{})
	go func() {
		defer close(done)
		request, _ := http.NewRequest(http.MethodGet, server.DirectURL()+"/obj-flight", nil)
		request.Header.Set("Range", byteRange(0, 1024*1024-1))
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			return
		}
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
	}()

	// Wait until the request has ARRIVED and is blocked in the hold.
	deadline := time.Now().Add(5 * time.Second)
	for server.Counters().CurrentHeldWaiters.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the request never reached the hold")
		}
		time.Sleep(time.Millisecond)
	}

	// THE SNAPSHOT TAKEN MID-FLIGHT. This is the state gate9 hit.
	inFlight := server.Snapshot()
	classified := inFlight.ChunkResponses + inFlight.SmallResponses +
		inFlight.PartialResponses + inFlight.OversizedResponses
	if classified+inFlight.BodylessResponses != inFlight.AccountedResponses {
		t.Fatalf("the accounted identity must hold mid-flight: %d classified + %d bodyless != %d accounted",
			classified, inFlight.BodylessResponses, inFlight.AccountedResponses)
	}
	// AND THE OLD IDENTITY MUST NOT, or this test would prove nothing about the change.
	if classified+inFlight.BodylessResponses == inFlight.RangeRequests {
		t.Fatalf("arrivals and accounted responses agree mid-flight (%d), so this test is not exercising "+
			"the skew it exists for", inFlight.RangeRequests)
	}
	if inFlight.RangeRequests != 1 || inFlight.AccountedResponses != 0 {
		t.Fatalf("mid-flight expects 1 arrival and 0 accounted, got %d and %d",
			inFlight.RangeRequests, inFlight.AccountedResponses)
	}

	server.Release("obj-flight")
	<-done

	// AND AFTERWARDS BOTH AGREE, because the request is no longer straddling anything.
	settled := server.Snapshot()
	settledClassified := settled.ChunkResponses + settled.SmallResponses +
		settled.PartialResponses + settled.OversizedResponses
	if settledClassified+settled.BodylessResponses != settled.AccountedResponses {
		t.Fatalf("the accounted identity must hold at rest: %d + %d != %d",
			settledClassified, settled.BodylessResponses, settled.AccountedResponses)
	}
	if settled.AccountedResponses != settled.RangeRequests {
		t.Fatalf("with nothing in flight the two sides should agree: %d accounted, %d arrivals",
			settled.AccountedResponses, settled.RangeRequests)
	}
}

// TestSnapshotIsCoherentUnderConcurrentAccounting hammers the compound critical section from both sides.
//
// The identity must hold on EVERY snapshot taken while bodies are being served, not merely at rest: a
// snapshot that caught the class incremented and the accounted counter not yet moved would be the same
// defect gate9 found, just harder to reproduce. It also asserts the per-object class columns reconcile with
// the aggregate ones, which is what makes per-object arithmetic checkable rather than inferred.
func TestSnapshotIsCoherentUnderConcurrentAccounting(t *testing.T) {
	server, err := New(Options{})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	for i := 0; i < 4; i++ {
		server.AddObject(fmt.Sprintf("obj-%d", i), 8*1024*1024)
	}

	var wg sync.WaitGroup
	stop := make(chan struct{})
	for worker := 0; worker < 4; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			ref := fmt.Sprintf("obj-%d", worker)
			for i := 0; i < 40; i++ {
				request, _ := http.NewRequest(http.MethodGet, server.DirectURL()+"/"+ref, nil)
				// A mix of classes, so every column moves.
				length := int64(4096 + (i%3)*1024*1024)
				request.Header.Set("Range", byteRange(0, length-1))
				response, err := http.DefaultClient.Do(request)
				if err != nil {
					return
				}
				io.Copy(io.Discard, response.Body)
				response.Body.Close()
			}
		}(worker)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			snapshot := server.Snapshot()
			classified := snapshot.ChunkResponses + snapshot.SmallResponses +
				snapshot.PartialResponses + snapshot.OversizedResponses
			if classified+snapshot.BodylessResponses != snapshot.AccountedResponses {
				t.Errorf("an incoherent snapshot: %d classified + %d bodyless != %d accounted",
					classified, snapshot.BodylessResponses, snapshot.AccountedResponses)
				return
			}
			// THE PER-OBJECT COLUMNS RECONCILE WITH THE AGGREGATE, on the same snapshot.
			var chunk, small, partial, oversized, bytes int64
			for i := range snapshot.ObjectBytes {
				chunk += snapshot.ObjectChunk[i]
				small += snapshot.ObjectSmall[i]
				partial += snapshot.ObjectPartial[i]
				oversized += snapshot.ObjectOversized[i]
				bytes += snapshot.ObjectBytes[i]
			}
			if chunk != snapshot.ChunkResponses || small != snapshot.SmallResponses ||
				partial != snapshot.PartialResponses || oversized != snapshot.OversizedResponses {
				t.Errorf("per-object class columns do not sum to their aggregates: "+
					"chunk %d/%d small %d/%d partial %d/%d oversized %d/%d",
					chunk, snapshot.ChunkResponses, small, snapshot.SmallResponses,
					partial, snapshot.PartialResponses, oversized, snapshot.OversizedResponses)
				return
			}
			if bytes != snapshot.BytesServed {
				t.Errorf("per-object bytes %d do not sum to bytes served %d", bytes, snapshot.BytesServed)
				return
			}
		}
	}()

	// Let the workers finish, then stop the observer.
	go func() { time.Sleep(1500 * time.Millisecond); close(stop) }()
	wg.Wait()
}
