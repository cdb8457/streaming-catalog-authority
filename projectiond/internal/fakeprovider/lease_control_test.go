//go:build linux

package fakeprovider

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// THE CONTROL SURFACE THE LEASE GATES DRIVE THE ENDPOINT THROUGH, and the properties that make it safe to
// have at all. `InjectFault` and the lease store are ordinary methods; a gate that runs this server in its own
// container cannot call them, so they are also reachable over HTTP. Everything below is about the two rules
// that keeps honest: a control request is NOT traffic, and it does not special-case the paths it drives.

func resolveOnce(t *testing.T, server *Server, ref string) (string, http.Header) {
	t.Helper()
	body := strings.NewReader(`{"objectRef":"` + ref + `"}`)
	resp, err := http.Post(server.ResolveURL(), "application/json", body)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("resolve answered %d", resp.StatusCode)
	}
	var out struct {
		URL     string            `json:"url"`
		Headers map[string]string `json:"headers"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	header := http.Header{}
	for key, value := range out.Headers {
		header.Set(key, value)
	}
	return out.URL, header
}

func rangeGet(t *testing.T, url string, header http.Header) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	for key, values := range header {
		req.Header[key] = values
	}
	req.Header.Set("Range", "bytes=0-1023")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	payload, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, payload
}

func TestExpireAllLeasesRejectsThroughTheORDINARYPath(t *testing.T) {
	// THE LAPSE IS AN EVENT THE GATE CAUSES, NOT A RACE IT HOPES FOR. G24 needs a lease to lapse DURING a
	// read; a short TTL only gets there by out-guessing the reader. What matters here is that causing it
	// deliberately produces the SAME answer a naturally lapsed lease produces, on the same code path and the
	// same counter — otherwise the gate would be measuring a special case built for it.
	server, err := New(Options{LeaseTTL: time.Hour})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	server.AddObject("obj", 4096)

	url, header := resolveOnce(t, server, "obj")
	status, payload := rangeGet(t, url, header)
	if status != http.StatusPartialContent {
		t.Fatalf("a live lease must be served: %d", status)
	}
	if len(payload) != 1024 {
		t.Fatalf("a live lease must serve its range: %d bytes", len(payload))
	}
	before := server.Counters().ExpiredRejected.Load()

	if expired := server.ExpireAllLeases(); expired != 1 {
		t.Fatalf("one outstanding lease should have lapsed, got %d", expired)
	}

	status, payload = rangeGet(t, url, header)
	if status != http.StatusUnauthorized {
		t.Fatalf("a lapsed lease must answer 401, which is what makes it refreshable: %d", status)
	}
	if len(payload) != 0 {
		t.Fatalf("a lapsed lease must serve NO bytes, got %d", len(payload))
	}
	if got := server.Counters().ExpiredRejected.Load(); got != before+1 {
		t.Fatalf("the ordinary expiry counter must move: %d -> %d", before, got)
	}
}

func TestControlRequestsAreNotTraffic(t *testing.T) {
	// A CONTROL REQUEST THAT SPENT THE BUDGET WOULD WIDEN THE VERY THING IT EXISTS TO MEASURE. The gate arms
	// faults and lapses leases between measured windows; if either counted as a ranged request or a
	// resolution, every budget in G24-G26 would be measuring the harness.
	server, err := New(Options{LeaseTTL: time.Hour})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	server.AddObject("obj", 4096)

	beforeRange := server.Counters().RangeRequests.Load()
	beforeResolve := server.Counters().Resolutions.Load()

	for _, path := range []string{
		"/control/fault/obj?fault=short-body&times=1",
		"/control/expire-leases",
		"/counters",
	} {
		resp, err := http.Get(server.BaseURL() + path)
		if err != nil {
			t.Fatalf("control %s: %v", path, err)
		}
		resp.Body.Close()
		if resp.StatusCode >= 400 {
			t.Fatalf("control %s answered %d", path, resp.StatusCode)
		}
	}

	if got := server.Counters().RangeRequests.Load(); got != beforeRange {
		t.Fatalf("control moved the ranged-request counter: %d -> %d", beforeRange, got)
	}
	if got := server.Counters().Resolutions.Load(); got != beforeResolve {
		t.Fatalf("control moved the resolution counter: %d -> %d", beforeResolve, got)
	}
}

func TestFaultControlArmsTheSameFaultTheMethodDoes(t *testing.T) {
	// The HTTP surface must be a way to CALL InjectFault, not a second implementation of it.
	server, err := New(Options{LeaseTTL: time.Hour})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	server.AddObject("obj", 4096)

	resp, err := http.Get(server.BaseURL() + "/control/fault/obj?fault=full-body-on-range&times=1")
	if err != nil {
		t.Fatalf("arm: %v", err)
	}
	resp.Body.Close()

	url, header := resolveOnce(t, server, "obj")
	status, payload := rangeGet(t, url, header)
	if status != http.StatusOK {
		t.Fatalf("the armed fault must answer a ranged request with a full body 200: %d", status)
	}
	if len(payload) != 4096 {
		t.Fatalf("a full-body answer serves the whole object: %d", len(payload))
	}

	// ...and it was armed for exactly one request, so the next is clean.
	status, _ = rangeGet(t, url, header)
	if status != http.StatusPartialContent {
		t.Fatalf("the fault must be consumed after one request: %d", status)
	}
}

func TestExpireAllLeasesIsIdempotentAndCountsOnlyLiveLeases(t *testing.T) {
	server, err := New(Options{LeaseTTL: time.Hour})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	defer server.Close()
	server.AddObject("obj", 4096)
	resolveOnce(t, server, "obj")
	resolveOnce(t, server, "obj")

	if expired := server.ExpireAllLeases(); expired != 2 {
		t.Fatalf("both live leases should have lapsed, got %d", expired)
	}
	// A SECOND CALL LAPSES NOTHING, because there is nothing live left. A gate that armed the lapse twice
	// must not be told it worked twice.
	if expired := server.ExpireAllLeases(); expired != 0 {
		t.Fatalf("nothing was live, so nothing should have lapsed, got %d", expired)
	}
}
