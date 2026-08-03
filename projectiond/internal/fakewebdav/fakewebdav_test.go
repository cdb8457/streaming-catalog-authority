package fakewebdav

// The COMPARISON CONTROL's endpoint, held to the properties every figure G22 reports depends on.
//
// WHAT THESE TESTS ARE FOR. G22 has no pass threshold, so nothing downstream will ever fail because a number
// was wrong — which makes the instrument the only thing standing between a broken counter and a published
// comparison. Each test below is one way this endpoint could produce a plausible, self-consistent, wrong
// figure.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeFixture(t *testing.T, name string, size int) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	body := make([]byte, size)
	for index := range body {
		body[index] = byte(index % 251)
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatalf("writing the fixture: %v", err)
	}
	return path
}

func newServer(t *testing.T, token string) *Server {
	t.Helper()
	server, err := New(Options{BearerToken: token, MaxHold: 750 * time.Millisecond})
	if err != nil {
		t.Fatalf("starting the endpoint: %v", err)
	}
	t.Cleanup(func() { _ = server.Close() })
	return server
}

func request(t *testing.T, method, url, token string, headers map[string]string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatalf("building the request: %v", err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("issuing the request: %v", err)
	}
	return response
}

func body(t *testing.T, response *http.Response) string {
	t.Helper()
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("reading the body: %v", err)
	}
	return string(raw)
}

// A CORPUS WHOSE NAMES CARRY SPACES AND PARENTHESES, on purpose. The shared corpus's names do, and a listing
// that escaped them wrongly is exactly the kind of defect a comparison would attribute to the topology.
func seedAndCorpus(t *testing.T, server *Server) (seedPath, corpusPath string) {
	t.Helper()
	seedPath = "/Movies/Projection Seed (2026)/Projection Seed (2026).mp4"
	corpusPath = "/Movies/Projection Corpus 01 (2026)/Projection Corpus 01 (2026).mp4"
	if _, err := server.AddFileObject("/Canary/Projection Canary.bin", "obj-canary",
		writeFixture(t, "canary.bin", 4096), true); err != nil {
		t.Fatalf("registering the canary: %v", err)
	}
	if _, err := server.AddFileObject(seedPath, "obj-seed", writeFixture(t, "seed.mp4", 2048), true); err != nil {
		t.Fatalf("registering the seed: %v", err)
	}
	if _, err := server.AddFileObject(corpusPath, "obj-corpus", writeFixture(t, "corpus.mp4", 9000), false); err != nil {
		t.Fatalf("registering the corpus entry: %v", err)
	}
	return seedPath, corpusPath
}

func snapshot(t *testing.T, server *Server) CountersSnapshot {
	t.Helper()
	response := request(t, http.MethodGet, server.BaseURL()+"/counters", "", nil)
	var out CountersSnapshot
	if err := json.Unmarshal([]byte(body(t, response)), &out); err != nil {
		t.Fatalf("decoding the counters: %v", err)
	}
	return out
}

// THE PARTITIONS, CHECKED AS THE GATE CHECKS THEM. If these ever stop holding, every figure the comparison
// reports is a number with no denominator.
func assertPartitions(t *testing.T, snap CountersSnapshot) {
	t.Helper()
	if snap.RangedBodies+snap.FullBodies+snap.BodylessResponses != snap.AccountedResponses {
		t.Fatalf("the request partition does not balance: %d+%d+%d != %d",
			snap.RangedBodies, snap.FullBodies, snap.BodylessResponses, snap.AccountedResponses)
	}
	if snap.RangedBytes+snap.FullBytes != snap.BytesServed {
		t.Fatalf("the byte partition does not balance: %d+%d != %d",
			snap.RangedBytes, snap.FullBytes, snap.BytesServed)
	}
	var attributed, ranged, full, gets int64
	for index := range snap.ObjectBytes {
		attributed += snap.ObjectBytes[index]
		ranged += snap.ObjectRanged[index]
		full += snap.ObjectFull[index]
		gets += snap.ObjectGets[index]
	}
	if attributed != snap.BytesServed {
		t.Fatalf("bytes are not fully attributed: %d against %d", attributed, snap.BytesServed)
	}
	if ranged != snap.RangedBodies || full != snap.FullBodies || gets != snap.RangedBodies+snap.FullBodies {
		t.Fatalf("requests are not fully attributed: %d/%d/%d", ranged, full, gets)
	}
}

func TestRevealGatesTheCorpusAndNotTheSeed(t *testing.T) {
	// THE COLD WINDOW DEPENDS ENTIRELY ON THIS. A corpus visible before the libraries exist would be scanned
	// by the first media server that created one, and the measured window would then describe a topology that
	// had already done the work.
	server := newServer(t, "")
	seedPath, corpusPath := seedAndCorpus(t, server)

	if response := request(t, "PROPFIND", server.DavURL()+"/Movies", "",
		map[string]string{"Depth": "1"}); true {
		listing := body(t, response)
		if !strings.Contains(listing, "Projection%20Seed%20%282026%29") {
			t.Fatalf("the seed's directory is not listed before the reveal: %s", listing)
		}
		if strings.Contains(listing, "Projection%20Corpus%2001") {
			t.Fatalf("the corpus is listed before the reveal: %s", listing)
		}
	}
	if response := request(t, http.MethodGet, server.DavURL()+corpusPath, "", nil); response.StatusCode != 404 {
		t.Fatalf("a corpus entry was readable before the reveal: %d", response.StatusCode)
	}
	if response := request(t, http.MethodGet, server.DavURL()+seedPath, "", nil); response.StatusCode != 200 {
		t.Fatalf("the seed was not readable before the reveal: %d", response.StatusCode)
	}

	server.Reveal()
	if response := request(t, http.MethodGet, server.DavURL()+corpusPath, "", nil); response.StatusCode != 200 {
		t.Fatalf("a corpus entry is still not readable after the reveal: %d", response.StatusCode)
	}
	if !snapshot(t, server).Revealed {
		t.Fatal("the snapshot does not report that the corpus was revealed; a window that served nothing " +
			"could then not be told from a window with nothing to serve")
	}
}

func TestRangedAndFullBodiesAreCountedSeparately(t *testing.T) {
	// THE HEADLINE SPLIT OF THE WHOLE COMPARISON. A client that asks for whole bodies where the product's
	// daemon asks for ranges is the finding; folding the two into one "requests" total would erase it.
	server := newServer(t, "")
	_, corpusPath := seedAndCorpus(t, server)
	server.Reveal()

	response := request(t, http.MethodGet, server.DavURL()+corpusPath, "",
		map[string]string{"Range": "bytes=100-199"})
	if response.StatusCode != http.StatusPartialContent {
		t.Fatalf("a ranged request was not answered 206: %d", response.StatusCode)
	}
	if got := response.Header.Get("Content-Range"); got != "bytes 100-199/9000" {
		t.Fatalf("the Content-Range is wrong: %q", got)
	}
	if length := len(body(t, response)); length != 100 {
		t.Fatalf("a ranged body was %d bytes, not 100", length)
	}
	full := request(t, http.MethodGet, server.DavURL()+corpusPath, "", nil)
	if length := len(body(t, full)); length != 9000 {
		t.Fatalf("a whole-body response was %d bytes, not 9000", length)
	}

	snap := snapshot(t, server)
	if snap.RangedBodies != 1 || snap.FullBodies != 1 {
		t.Fatalf("the split is wrong: %d ranged, %d full", snap.RangedBodies, snap.FullBodies)
	}
	if snap.RangedBytes != 100 || snap.FullBytes != 9000 || snap.BytesServed != 9100 {
		t.Fatalf("the byte columns are wrong: %d/%d/%d", snap.RangedBytes, snap.FullBytes, snap.BytesServed)
	}
	assertPartitions(t, snap)
}

func TestMetadataBytesAreNeverFoldedIntoMediaBytes(t *testing.T) {
	// "PROVIDER BYTES" MUST NOT CONTAIN THE INSTRUMENT'S OWN PROSE. A listing body is XML this endpoint wrote;
	// counting it beside media would make the single most-quoted figure in the comparison partly a function of
	// how verbose the listing format is.
	server := newServer(t, "")
	seedAndCorpus(t, server)
	server.Reveal()
	response := request(t, "PROPFIND", server.DavURL()+"/Movies", "", map[string]string{"Depth": "1"})
	if response.StatusCode != http.StatusMultiStatus {
		t.Fatalf("PROPFIND was not answered 207: %d", response.StatusCode)
	}
	listing := body(t, response)
	snap := snapshot(t, server)
	if snap.BytesServed != 0 {
		t.Fatalf("a listing put %d bytes into the media total", snap.BytesServed)
	}
	if snap.MetadataBytes != int64(len(listing)) {
		t.Fatalf("metadata bytes are %d against a %d-byte listing", snap.MetadataBytes, len(listing))
	}
	if snap.Propfind != 1 || snap.PropfindDepth1 != 1 || snap.PropfindDepth0 != 0 {
		t.Fatalf("the PROPFIND census is wrong: %d/%d/%d",
			snap.Propfind, snap.PropfindDepth1, snap.PropfindDepth0)
	}
	assertPartitions(t, snap)
}

func TestAnAbsentDepthCountsAsDepthOne(t *testing.T) {
	// RFC 4918 §10.2 SAYS AN ABSENT DEPTH IS INFINITY FOR PROPFIND, AND EVERY REAL CLIENT SENDS ONE. What
	// matters for the census is that the endpoint files what it DID: it answers a bare PROPFIND as a listing,
	// so it must count it as one rather than as "other".
	server := newServer(t, "")
	seedAndCorpus(t, server)
	request(t, "PROPFIND", server.DavURL()+"/Movies", "", nil)
	snap := snapshot(t, server)
	if snap.PropfindDepth1 != 1 || snap.PropfindOther != 0 {
		t.Fatalf("a bare PROPFIND was filed as %d depth-1 and %d other",
			snap.PropfindDepth1, snap.PropfindOther)
	}
}

func TestAWrongCredentialIsRefusedAndCounted(t *testing.T) {
	// A CONTROL AGAINST AN OPEN ENDPOINT WOULD BE DISHONEST. Nobody points a media server's library root at an
	// unauthenticated share, and the gate's leak searches need a credential that was genuinely required.
	server := newServer(t, "s3cret-value")
	_, corpusPath := seedAndCorpus(t, server)
	server.Reveal()
	if response := request(t, http.MethodGet, server.DavURL()+corpusPath, "wrong", nil); response.StatusCode != 401 {
		t.Fatalf("a wrong credential was not refused: %d", response.StatusCode)
	}
	if response := request(t, http.MethodGet, server.DavURL()+corpusPath, "s3cret-value", nil); response.StatusCode != 200 {
		t.Fatalf("the right credential was refused: %d", response.StatusCode)
	}
	snap := snapshot(t, server)
	if snap.BodylessResponses != 1 {
		t.Fatalf("the refusal was not counted as bodiless: %d", snap.BodylessResponses)
	}
	assertPartitions(t, snap)
}

func TestEveryMutatingMethodIsRefusedAndVisible(t *testing.T) {
	// THE MOUNT IS READ-ONLY AND SO IS THIS ENDPOINT. A client that tried to write is a finding about the
	// topology, and a finding nobody counted is a finding nobody has.
	server := newServer(t, "")
	seedAndCorpus(t, server)
	server.Reveal()
	for _, method := range []string{"PUT", "DELETE", "MKCOL", "MOVE", "COPY", "PROPPATCH", "LOCK"} {
		response := request(t, method, server.DavURL()+"/Movies/x", "", nil)
		if response.StatusCode != http.StatusMethodNotAllowed {
			t.Fatalf("%s was not refused: %d", method, response.StatusCode)
		}
	}
	snap := snapshot(t, server)
	if snap.WriteAttempts != 7 {
		t.Fatalf("write attempts were counted as %d, not 7", snap.WriteAttempts)
	}
	assertPartitions(t, snap)
}

func TestAHoldBlocksAReadAndIsCountedThreeWays(t *testing.T) {
	// THE RENDEZVOUS. A lifetime count cannot answer "was something blocked AT THIS INSTANT", a live gauge
	// cannot answer "did a hold lapse rather than being released", and the gate asserts both.
	server := newServer(t, "")
	_, corpusPath := seedAndCorpus(t, server)
	server.Reveal()
	server.Hold("obj-corpus")

	done := make(chan int, 1)
	go func() {
		response, err := http.Get(server.DavURL() + corpusPath)
		if err != nil {
			done <- 0
			return
		}
		defer func() { _ = response.Body.Close() }()
		raw, _ := io.ReadAll(response.Body)
		done <- len(raw)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if snapshot(t, server).CurrentHeldWaiters == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if snapshot(t, server).CurrentHeldWaiters != 1 {
		t.Fatal("no request was ever observed blocked at the barrier")
	}
	server.Release("obj-corpus")
	if length := <-done; length != 9000 {
		t.Fatalf("the released read returned %d bytes, not the whole object", length)
	}
	snap := snapshot(t, server)
	if snap.HeldRequests != 1 || snap.CurrentHeldWaiters != 0 || snap.HoldTimeouts != 0 {
		t.Fatalf("the hold counters are wrong: %d held, %d waiting, %d lapsed",
			snap.HeldRequests, snap.CurrentHeldWaiters, snap.HoldTimeouts)
	}
	assertPartitions(t, snap)
}

func TestAHoldThatIsNeverReleasedLapsesAndSaysSo(t *testing.T) {
	// A LAPSE IS NOT SILENT. If the gate died between arming and releasing, the read is degraded rather than
	// paused, and every figure taken over that window describes an instrument rather than a topology. The
	// gate asserts this counter is zero, so it has to move when it should.
	server := newServer(t, "")
	_, corpusPath := seedAndCorpus(t, server)
	server.Reveal()
	server.Hold("obj-corpus")
	started := time.Now()
	response := request(t, http.MethodGet, server.DavURL()+corpusPath, "", nil)
	if length := len(body(t, response)); length != 9000 {
		t.Fatalf("the lapsed read returned %d bytes; a lapse must degrade into a slow read, not a failed one",
			length)
	}
	if elapsed := time.Since(started); elapsed < 500*time.Millisecond {
		t.Fatalf("the read was not actually blocked: %s", elapsed)
	}
	if snap := snapshot(t, server); snap.HoldTimeouts != 1 {
		t.Fatalf("a lapsed hold was not counted: %d", snap.HoldTimeouts)
	}
}

func TestObjectColumnsPairByRegistrationOrdinalAndCarryNoName(t *testing.T) {
	// THE ONLY HANDLE THE TELEMETRY CARRIES IS AN ORDINAL, and the gate splits corpus from non-corpus at a
	// boundary in it. If the columns ever carried a path the report would have to redact them; if they ever
	// stopped being in registration order the boundary would name the wrong objects.
	server := newServer(t, "")
	_, corpusPath := seedAndCorpus(t, server)
	server.Reveal()
	request(t, http.MethodGet, server.DavURL()+corpusPath, "", map[string]string{"Range": "bytes=0-9"})
	snap := snapshot(t, server)
	if len(snap.ObjectSizes) != 3 || snap.ObjectSizes[0] != 4096 || snap.ObjectSizes[1] != 2048 ||
		snap.ObjectSizes[2] != 9000 {
		t.Fatalf("the size column is not in registration order: %v", snap.ObjectSizes)
	}
	if snap.ObjectBytes[0] != 0 || snap.ObjectBytes[1] != 0 || snap.ObjectBytes[2] != 10 {
		t.Fatalf("bytes were attributed to the wrong ordinal: %v", snap.ObjectBytes)
	}
	raw, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("encoding the snapshot: %v", err)
	}
	for _, forbidden := range []string{"Movies", "Canary", "obj-", ".mp4", "/"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("the telemetry names %q, so a report would have to redact it: %s", forbidden, raw)
		}
	}
}

func TestRangeParsingRefusesWhatItCannotAnswerExactly(t *testing.T) {
	cases := []struct {
		spec       string
		size       int64
		start, end int64
		ok         bool
	}{
		{"bytes=0-99", 1000, 0, 99, true},
		{"bytes=500-", 1000, 500, 999, true},
		{"bytes=-100", 1000, 900, 999, true},
		{"bytes=0-100000", 1000, 0, 999, true},
		{"bytes=1000-1010", 1000, 0, 0, false},
		{"bytes=200-100", 1000, 0, 0, false},
		// MULTI-RANGE IS REFUSED RATHER THAN PARTIALLY ANSWERED. No media server asks for one, so a client
		// that did would be doing something worth seeing, and serving it the first part would hide it.
		{"bytes=0-9,20-29", 1000, 0, 0, false},
		{"items=0-9", 1000, 0, 0, false},
		{"bytes=abc", 1000, 0, 0, false},
	}
	for _, testCase := range cases {
		start, end, ok := parseRange(testCase.spec, testCase.size)
		if ok != testCase.ok || (ok && (start != testCase.start || end != testCase.end)) {
			t.Fatalf("%s over %d gave %d-%d ok=%v, wanted %d-%d ok=%v",
				testCase.spec, testCase.size, start, end, ok, testCase.start, testCase.end, testCase.ok)
		}
	}
}

func TestAnUnsatisfiableRangeIsRefusedWithoutABody(t *testing.T) {
	server := newServer(t, "")
	_, corpusPath := seedAndCorpus(t, server)
	server.Reveal()
	response := request(t, http.MethodGet, server.DavURL()+corpusPath, "",
		map[string]string{"Range": "bytes=99999-"})
	if response.StatusCode != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("an unsatisfiable range was answered %d", response.StatusCode)
	}
	snap := snapshot(t, server)
	if snap.BytesServed != 0 || snap.BodylessResponses != 1 {
		t.Fatalf("an unsatisfiable range was not accounted as bodiless: %d bytes, %d bodiless",
			snap.BytesServed, snap.BodylessResponses)
	}
	assertPartitions(t, snap)
}

func TestTheControlAndCounterSurfacesAreNotTraffic(t *testing.T) {
	// A SURFACE THAT PERTURBED THE NUMBERS IT REPORTS would make every figure read a little larger every time
	// somebody looked at it, and the gate polls /counters on a watchdog cadence throughout the window.
	server := newServer(t, "")
	seedAndCorpus(t, server)
	for index := 0; index < 5; index++ {
		snapshot(t, server)
	}
	request(t, http.MethodPost, server.BaseURL()+"/control/reveal", "", nil)
	request(t, http.MethodPost, server.BaseURL()+"/control/hold/obj-corpus", "", nil)
	request(t, http.MethodPost, server.BaseURL()+"/control/release/obj-corpus", "", nil)
	snap := snapshot(t, server)
	if snap.Requests != 0 || snap.AccountedResponses != 0 {
		t.Fatalf("control traffic was counted: %d requests, %d accounted",
			snap.Requests, snap.AccountedResponses)
	}
}

func TestListingsEscapeNamesAndAreStablyOrdered(t *testing.T) {
	// TWO RUNS OF A DETERMINISTIC CORPUS MUST PRODUCE THE SAME TRAVERSAL. A listing whose order moved between
	// runs would make a client's request order differ for reasons that have nothing to do with the topology,
	// and the comparison would then be quoting a number that varies for no measurable cause.
	server := newServer(t, "")
	seedAndCorpus(t, server)
	server.Reveal()
	first := body(t, request(t, "PROPFIND", server.DavURL()+"/Movies", "", map[string]string{"Depth": "1"}))
	second := body(t, request(t, "PROPFIND", server.DavURL()+"/Movies", "", map[string]string{"Depth": "1"}))
	if first != second {
		t.Fatal("two identical listings differ")
	}
	// THE HREFS, AND ONLY THE HREFS. `displayname` carries the name as it is, which is correct and is not what
	// a client resolves; an href that leaked a raw space would produce a request no server could route.
	hrefs := 0
	for _, line := range strings.Split(first, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "<D:href>") {
			continue
		}
		hrefs++
		inner := strings.TrimSuffix(strings.TrimPrefix(trimmed, "<D:href>"), "</D:href>")
		if strings.ContainsAny(inner, " ()") {
			t.Fatalf("an href carries an unescaped character: %q", inner)
		}
	}
	if hrefs != 3 {
		t.Fatalf("the listing named %d hrefs, not the collection and its two children", hrefs)
	}
	for _, needed := range []string{
		"<D:href>/dav/Movies/Projection%20Seed%20%282026%29/</D:href>",
		"<D:collection/>",
		fmt.Sprintf("<D:getlastmodified>%s</D:getlastmodified>", httpDate()),
	} {
		if !strings.Contains(first, needed) {
			t.Fatalf("the listing is missing %q: %s", needed, first)
		}
	}
	// A FILE'S OWN PROPERTIES, because a client that cannot read a length from a listing asks for it another
	// way and the metadata census then describes the endpoint rather than the client.
	fileListing := body(t, request(t, "PROPFIND",
		server.DavURL()+"/Movies/Projection Corpus 01 (2026)", "", map[string]string{"Depth": "1"}))
	if !strings.Contains(fileListing, "<D:getcontentlength>9000</D:getcontentlength>") {
		t.Fatalf("a listed file carries no length: %s", fileListing)
	}
	if !strings.Contains(fileListing, "<D:getcontenttype>video/mp4</D:getcontenttype>") {
		t.Fatalf("a listed file carries no content type: %s", fileListing)
	}
}

func TestOptionsAdvertisesTheReadOnlySurface(t *testing.T) {
	server := newServer(t, "")
	seedAndCorpus(t, server)
	response := request(t, http.MethodOptions, server.DavURL()+"/", "", nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("OPTIONS was answered %d", response.StatusCode)
	}
	if dav := response.Header.Get("DAV"); !strings.Contains(dav, "1") {
		t.Fatalf("OPTIONS does not advertise DAV: %q", dav)
	}
	if allow := response.Header.Get("Allow"); strings.Contains(allow, "PUT") {
		t.Fatalf("a read-only endpoint advertises PUT: %q", allow)
	}
	if snap := snapshot(t, server); snap.Options != 1 {
		t.Fatalf("OPTIONS was counted %d times", snap.Options)
	}
}
