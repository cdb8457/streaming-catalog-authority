package source

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"net"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/fakeprovider"
)

func parseIP(t *testing.T, value string) net.IP {
	t.Helper()
	ip := net.ParseIP(value)
	if ip == nil {
		t.Fatalf("unparseable address %q", value)
	}
	return ip
}

const testObject = "obj-alpha"
const testObjectSize = int64(6 * 1024 * 1024)

func newFake(t *testing.T, opts fakeprovider.Options) *fakeprovider.Server {
	t.Helper()
	server, err := fakeprovider.New(opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	server.AddObject(testObject, testObjectSize)
	return server
}

func newAdapter(t *testing.T, server *fakeprovider.Server, mutate func(*EndpointConfig)) *HTTPRangeAdapter {
	t.Helper()
	cfg := EndpointConfig{
		ID:             "fake",
		ResolverURL:    server.ResolveURL(),
		AllowedOrigins: []string{server.BaseURL()},
		// Two separate permissions, both needed by the loopback fake and neither implying the other.
		AllowInsecureHTTP:     true,
		AllowPrivateAddresses: true,
		MaxConnections:        4,
		ResolutionDeadline:    2 * time.Second,
		RefreshCooldown:       30 * time.Second,
		RequestTimeout:        5 * time.Second,
	}
	if mutate != nil {
		mutate(&cfg)
	}
	adapter, err := NewHTTPRangeAdapter(cfg, nil, NewBreaker(5, 30*time.Second, 60*time.Second, 1),
		NewLimiter(8, 4, 2*time.Second))
	if err != nil {
		t.Fatalf("adapter refused: %v", err)
	}
	t.Cleanup(func() { _ = adapter.Close() })
	return adapter
}

func rangeRequest(offset, length int64) ReadRequest {
	return ReadRequest{
		SourceID: "src_alpha", SourceGeneration: 1, SizeBytes: testObjectSize,
		Offset: offset, Length: length,
		Locator: Locator{Kind: "http-range", EndpointID: "fake", ObjectRef: testObject},
	}
}

func TestRangeReadReturnsExactBytes(t *testing.T) {
	server := newFake(t, fakeprovider.Options{})
	adapter := newAdapter(t, server, nil)

	buf := make([]byte, 4096)
	n, err := adapter.Fetch(context.Background(), rangeRequest(1000, 4096), buf)
	if err != nil {
		t.Fatal(err)
	}
	if n != 4096 {
		t.Fatalf("expected 4096 bytes, got %d", n)
	}
	if !bytes.Equal(buf, fakeprovider.ObjectBytes(testObject, 1000, 4096)) {
		t.Fatal("the bytes returned are not the bytes the endpoint serves")
	}
}

// Every injected protocol violation must be refused, and a 200 full body must not be consumed at all.
func TestProtocolViolationsAreRefused(t *testing.T) {
	cases := []struct {
		fault fakeprovider.Fault
		cond  string
	}{
		{fakeprovider.FaultFullBodyOnRange, CondRangeUnsupported},
		{fakeprovider.FaultMalformedRange, CondRangeMismatch},
		{fakeprovider.FaultMismatchedRange, CondRangeMismatch},
		{fakeprovider.FaultWrongTotalSize, CondSizeDisagrees},
		{fakeprovider.FaultShortBody, CondShortBody},
		{fakeprovider.FaultRedirect, CondRedirectRefused},
	}
	for _, testCase := range cases {
		t.Run(string(testCase.fault), func(t *testing.T) {
			server := newFake(t, fakeprovider.Options{})
			adapter := newAdapter(t, server, nil)
			server.InjectFault(testObject, testCase.fault, 0)

			buf := make([]byte, 65536)
			_, err := adapter.Fetch(context.Background(), rangeRequest(0, 65536), buf)
			if err == nil {
				t.Fatalf("%s must be refused", testCase.fault)
			}
			failure := AsFailure(err)
			if failure.Cond != testCase.cond {
				t.Fatalf("expected %s, got %s", testCase.cond, failure.Cond)
			}
			if failure.Class != ClassTerminal {
				t.Fatalf("%s must be terminal, got %s", testCase.fault, failure.Class)
			}
			if testCase.fault == fakeprovider.FaultFullBodyOnRange {
				// The body must never have been read: a whole-file download to answer a 64 KiB probe is the
				// most expensive mistake available here.
				if adapter.Stats.Bytes.Load() != 0 {
					t.Fatalf("a 200 full body was consumed: %d bytes", adapter.Stats.Bytes.Load())
				}
				if adapter.Stats.FullBodyOnPart.Load() != 1 {
					t.Fatal("the full-body violation was not counted")
				}
			}
		})
	}
}

// A body LONGER than the granted range is not a protocol failure to reject — it is extra bytes to ignore.
// The read is bounded at the granted length, so the surplus is never read into the buffer, never returned and
// never cached. This is the other half of dropping the EOF probe: correctness comes from the bound, not from
// proving the server stopped talking.
func TestLongBodyIsTruncatedToTheGrantedRangeNotRejected(t *testing.T) {
	server := newFake(t, fakeprovider.Options{})
	adapter := newAdapter(t, server, nil)
	server.InjectFault(testObject, fakeprovider.FaultLongBody, 0)

	buf := make([]byte, 65536)
	n, err := adapter.Fetch(context.Background(), rangeRequest(0, 65536), buf)
	if err != nil {
		t.Fatalf("a correct prefix with surplus bytes must still be usable: %v", err)
	}
	if n != 65536 {
		t.Fatalf("expected exactly the granted range, got %d", n)
	}
	if !bytes.Equal(buf, fakeprovider.ObjectBytes(testObject, 0, 65536)) {
		t.Fatal("the surplus bytes contaminated the result")
	}
	if adapter.Stats.Bytes.Load() != 65536 {
		t.Fatalf("only the granted range may be counted, got %d", adapter.Stats.Bytes.Load())
	}
}

func TestRetryableStatusesAreClassifiedRetryable(t *testing.T) {
	for _, fault := range []fakeprovider.Fault{fakeprovider.Fault429, fakeprovider.Fault503} {
		t.Run(string(fault), func(t *testing.T) {
			server := newFake(t, fakeprovider.Options{})
			adapter := newAdapter(t, server, nil)
			server.InjectFault(testObject, fault, 0)
			buf := make([]byte, 4096)
			_, err := adapter.Fetch(context.Background(), rangeRequest(0, 4096), buf)
			if err == nil {
				t.Fatal("expected a failure")
			}
			if AsFailure(err).Class != ClassRetryable {
				t.Fatalf("%s must be retryable, got %s", fault, AsFailure(err).Class)
			}
		})
	}
}

// REGRESSION: a correct chunked 206 whose terminal chunk is late used to stall for the whole client timeout,
// because the reader insisted on proving EOF after the exact range. The granted range is enough.
func TestCorrectChunkedBodyWithDelayedCloseDoesNotStall(t *testing.T) {
	server := newFake(t, fakeprovider.Options{TimeoutFor: 3 * time.Second})
	adapter := newAdapter(t, server, nil)
	server.InjectFault(testObject, fakeprovider.FaultDelayedClose, 0)

	buf := make([]byte, 32768)
	start := time.Now()
	n, err := adapter.Fetch(context.Background(), rangeRequest(0, 32768), buf)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("a correct body must be accepted: %v", err)
	}
	if n != 32768 || !bytes.Equal(buf, fakeprovider.ObjectBytes(testObject, 0, 32768)) {
		t.Fatal("the accepted bytes are wrong")
	}
	if elapsed > 1500*time.Millisecond {
		t.Fatalf("the read waited for the terminal chunk: %v", elapsed)
	}
}

// A lease that lapses mid-stream is the NORMAL end of a signed URL's life. One refresh recovers it, the
// identity does not move, and the bytes are still correct.
func TestExpiredLeaseIsRecoveredByExactlyOneRefresh(t *testing.T) {
	server := newFake(t, fakeprovider.Options{LeaseTTL: 250 * time.Millisecond})
	adapter := newAdapter(t, server, nil)

	buf := make([]byte, 4096)
	if _, err := adapter.Fetch(context.Background(), rangeRequest(0, 4096), buf); err != nil {
		t.Fatalf("first read: %v", err)
	}
	resolutionsAfterFirst := server.Counters().Resolutions.Load()
	if resolutionsAfterFirst != 1 {
		t.Fatalf("the first read should resolve exactly once, got %d", resolutionsAfterFirst)
	}

	time.Sleep(400 * time.Millisecond) // the lease lapses

	if _, err := adapter.Fetch(context.Background(), rangeRequest(4096, 4096), buf); err != nil {
		t.Fatalf("a lapsed lease must be recovered, not fatal: %v", err)
	}
	if !bytes.Equal(buf, fakeprovider.ObjectBytes(testObject, 4096, 4096)) {
		t.Fatal("the bytes after a refresh are wrong")
	}
	if got := server.Counters().Resolutions.Load(); got != 2 {
		t.Fatalf("exactly one refresh should have happened, resolutions=%d", got)
	}
}

// The other half of the same rule: when the daemon does NOT know the lease has lapsed and the endpoint
// rejects it, one refresh recovers the read. This is the 401/403/410 path rather than the expiry-clock path.
func TestRejectedLeaseIsRecoveredByExactlyOneRefresh(t *testing.T) {
	server := newFake(t, fakeprovider.Options{})
	adapter := newAdapter(t, server, nil)
	// Only the first ranged request is rejected; the refresh and its retry must then succeed.
	server.InjectFault(testObject, fakeprovider.Fault401, 1)

	buf := make([]byte, 4096)
	if _, err := adapter.Fetch(context.Background(), rangeRequest(0, 4096), buf); err != nil {
		t.Fatalf("a rejected lease must be recovered, not fatal: %v", err)
	}
	if !bytes.Equal(buf, fakeprovider.ObjectBytes(testObject, 0, 4096)) {
		t.Fatal("the bytes after a refresh are wrong")
	}
	if got := server.Counters().Resolutions.Load(); got != 2 {
		t.Fatalf("one initial resolution plus one refresh, got %d", got)
	}
	// And a refresh cannot cascade: a source that keeps rejecting fails the read rather than looping.
	server.InjectFault(testObject, fakeprovider.Fault403, 0)
	before := server.Counters().Resolutions.Load()
	if _, err := adapter.Fetch(context.Background(), rangeRequest(8192, 4096), buf); err == nil {
		t.Fatal("a persistently rejecting source must fail the read")
	}
	if after := server.Counters().Resolutions.Load(); after-before > 1 {
		t.Fatalf("a refresh triggered another refresh: %d extra resolutions", after-before)
	}
}

// REGRESSION: twenty handles meeting the same expired lease must cost ONE resolution. The resolver
// single-flights, and concurrent waiters share the result.
func TestConcurrentExpiryCostsOneRefresh(t *testing.T) {
	server := newFake(t, fakeprovider.Options{LeaseTTL: 200 * time.Millisecond})
	adapter := newAdapter(t, server, nil)

	buf := make([]byte, 4096)
	if _, err := adapter.Fetch(context.Background(), rangeRequest(0, 4096), buf); err != nil {
		t.Fatal(err)
	}
	time.Sleep(350 * time.Millisecond)

	var wg sync.WaitGroup
	var failures atomic.Int64
	start := make(chan struct{})
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			local := make([]byte, 4096)
			offset := int64(4096 * (index + 1))
			if _, err := adapter.Fetch(context.Background(), rangeRequest(offset, 4096), local); err != nil {
				failures.Add(1)
			}
		}(i)
	}
	close(start)
	wg.Wait()

	if failures.Load() != 0 {
		t.Fatalf("%d concurrent reads failed across a lease expiry", failures.Load())
	}
	// One initial resolution plus exactly one refresh, however many readers met the expiry.
	if got := server.Counters().Resolutions.Load(); got != 2 {
		t.Fatalf("expected one initial resolution and one shared refresh, got %d", got)
	}
}

// REGRESSION: a lease was keyed by sourceID alone, so a generation swap reusing that id with a bumped source
// generation and a different object would have handed the new handle the old object's lease.
func TestLeasesAreKeyedByFullTransportIdentity(t *testing.T) {
	server := newFake(t, fakeprovider.Options{})
	server.AddObject("obj-beta", testObjectSize)
	adapter := newAdapter(t, server, nil)

	first := rangeRequest(0, 4096)
	buf := make([]byte, 4096)
	if _, err := adapter.Fetch(context.Background(), first, buf); err != nil {
		t.Fatal(err)
	}

	// Same source id, bumped source generation, different object. It must resolve again and return the OTHER
	// object's bytes.
	second := rangeRequest(0, 4096)
	second.SourceGeneration = 2
	second.Locator.ObjectRef = "obj-beta"
	if _, err := adapter.Fetch(context.Background(), second, buf); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(buf, fakeprovider.ObjectBytes("obj-beta", 0, 4096)) {
		t.Fatal("the second source generation was served the first object's lease")
	}
	if got := server.Counters().Resolutions.Load(); got != 2 {
		t.Fatalf("a different transport identity must resolve separately, got %d resolutions", got)
	}
}

// REGRESSION: a known-expired lease used to be treated as an INITIAL resolution, which bypassed the cooldown
// entirely — so an endpoint whose resolutions were failing was re-resolved once per read, forever.
func TestFailedResolutionsAreBoundedByTheCooldown(t *testing.T) {
	server := newFake(t, fakeprovider.Options{LeaseTTL: 100 * time.Millisecond})
	adapter := newAdapter(t, server, func(cfg *EndpointConfig) {
		cfg.RefreshCooldown = 10 * time.Second
	})

	buf := make([]byte, 4096)
	if _, err := adapter.Fetch(context.Background(), rangeRequest(0, 4096), buf); err != nil {
		t.Fatal(err)
	}
	if got := server.Counters().Resolutions.Load(); got != 1 {
		t.Fatalf("the initial resolution should be exactly one, got %d", got)
	}
	time.Sleep(200 * time.Millisecond) // lease lapses

	// Make every further resolution fail, then hammer it.
	server.InjectFault(testObject, fakeprovider.FaultResolverError, 0)
	for i := 0; i < 25; i++ {
		if _, err := adapter.Fetch(context.Background(), rangeRequest(0, 4096), buf); err == nil {
			t.Fatal("a failed resolution must fail the read")
		}
	}
	// One initial + at most one refresh inside the cooldown. Without the fix this would be 26.
	if got := server.Counters().Resolutions.Load(); got > 2 {
		t.Fatalf("the cooldown did not bound the resolution storm: %d resolutions", got)
	}
}

// A resolved URL naming a host the daemon was never configured to contact must not be dialled.
func TestResolvedHostOutsideTheAllowlistIsNeverContacted(t *testing.T) {
	server := newFake(t, fakeprovider.Options{})
	adapter := newAdapter(t, server, nil)
	server.InjectFault(testObject, fakeprovider.FaultDisallowedHost, 0)

	buf := make([]byte, 4096)
	_, err := adapter.Fetch(context.Background(), rangeRequest(0, 4096), buf)
	if err == nil {
		t.Fatal("a host outside the allowlist must be refused")
	}
	if AsFailure(err).Cond != CondAccessURLNotAllowed {
		t.Fatalf("expected an allowlist refusal, got %v", err)
	}
	if adapter.Stats.Requests.Load() != 0 {
		t.Fatal("nothing may be requested from a host outside the allowlist")
	}
}

// The dial-time address policy is the half an allowlist cannot provide: an allowlisted NAME can resolve to
// loopback, to a private address, or to the cloud metadata service.
func TestDialPolicyRefusesLoopbackAndPrivateAddresses(t *testing.T) {
	policy := EgressPolicy{AllowLoopback: false}
	for _, address := range []string{"127.0.0.1", "::1", "10.1.2.3", "192.168.5.5", "169.254.169.254", "0.0.0.0"} {
		if failure := policy.checkIP(parseIP(t, address), false); failure == nil {
			t.Fatalf("%s must be refused at dial time", address)
		}
	}
	if failure := policy.checkIP(parseIP(t, "93.184.216.34"), false); failure != nil {
		t.Fatalf("a public address must be permitted: %v", failure)
	}
	// The loopback exception exists only for the in-process fake, and it is explicit.
	if failure := (EgressPolicy{AllowLoopback: true}).checkIP(parseIP(t, "127.0.0.1"), false); failure != nil {
		t.Fatalf("the explicit test exception must permit loopback: %v", failure)
	}
}

func TestPlaintextEndpointIsRefusedWithoutTheExplicitOptIn(t *testing.T) {
	server := newFake(t, fakeprovider.Options{})
	_, err := NewHTTPRangeAdapter(EndpointConfig{
		ID: "fake", ResolverURL: server.ResolveURL(),
		AllowedOrigins: []string{server.BaseURL()}, AllowInsecureHTTP: false,
	}, nil, nil, nil)
	if err == nil {
		t.Fatal("a plaintext endpoint must be refused unless the operator opted in explicitly")
	}
}

func TestEndpointWithoutAnAllowlistIsRefused(t *testing.T) {
	if _, err := NewHTTPRangeAdapter(EndpointConfig{ID: "fake", DirectBaseURL: "https://cdn.example.test"},
		nil, nil, nil); err == nil {
		t.Fatal("an endpoint with an empty allowlist must be refused before any request is possible")
	}
}

// The credential is read from a file and composed into a header. The resolver refuses without it.
func TestCredentialComesFromASecretFile(t *testing.T) {
	server := newFake(t, fakeprovider.Options{Token: "s3cr3t-value"})
	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "token")
	if err := os.WriteFile(tokenPath, []byte("s3cr3t-value\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	adapter := newAdapter(t, server, func(cfg *EndpointConfig) { cfg.TokenFile = tokenPath })
	adapter.resolver.secret = NewSecretFile(tokenPath)

	buf := make([]byte, 4096)
	if _, err := adapter.Fetch(context.Background(), rangeRequest(0, 4096), buf); err != nil {
		t.Fatalf("a correct credential should be accepted: %v", err)
	}
}

func TestSecretFileRefusesUnsafeShapes(t *testing.T) {
	dir := t.TempDir()

	loose := filepath.Join(dir, "loose")
	if err := os.WriteFile(loose, []byte("token"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := NewSecretFile(loose).Value(); err == nil {
		t.Fatal("a world-readable credential must be refused")
	}

	empty := filepath.Join(dir, "empty")
	if err := os.WriteFile(empty, []byte("\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewSecretFile(empty).Value(); err == nil {
		t.Fatal("an empty credential must be refused")
	}

	if _, err := NewSecretFile("relative/path").Value(); err == nil {
		t.Fatal("a relative credential path must be refused")
	}

	injected := filepath.Join(dir, "injected")
	if err := os.WriteFile(injected, []byte("abc\r\nX-Evil: 1"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewSecretFile(injected).Value(); err == nil {
		t.Fatal("a credential containing a line break must be refused")
	}
}

// A lease never has a printable form: an accidental %v prints a placeholder, not a signed URL.
func TestLeaseNeverRendersItsURL(t *testing.T) {
	lease := &Lease{}
	if lease.String() != "<access-lease redacted>" {
		t.Fatalf("a lease must not render its contents, got %q", lease.String())
	}
}

func TestConcurrencyCapsAreNeverExceeded(t *testing.T) {
	server := newFake(t, fakeprovider.Options{})
	limiter := NewLimiter(4, 2, 5*time.Second)
	adapter, err := NewHTTPRangeAdapter(EndpointConfig{
		ID: "fake", ResolverURL: server.ResolveURL(), AllowedOrigins: []string{server.BaseURL()},
		AllowInsecureHTTP: true, AllowPrivateAddresses: true, MaxConnections: 2,
		RequestTimeout: 5 * time.Second, RefreshCooldown: 30 * time.Second,
	}, nil, NewBreaker(50, time.Minute, time.Minute, 1), limiter)
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.Close()

	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			buf := make([]byte, 8192)
			_, _ = adapter.Fetch(context.Background(), rangeRequest(int64(index)*8192, 8192), buf)
		}(i)
	}
	wg.Wait()

	global, perEndpoint := limiter.Peak("fake")
	if global > 4 {
		t.Fatalf("the global cap was exceeded: %d", global)
	}
	if perEndpoint > 2 {
		t.Fatalf("the per-endpoint cap was exceeded: %d", perEndpoint)
	}
	if peak := server.Counters().PeakConcurrent.Load(); peak > 2 {
		t.Fatalf("the endpoint saw more concurrent requests than the cap: %d", peak)
	}
	if got := server.Counters().Served429.Load(); got != 0 {
		t.Fatalf("a correctly limited client must never be rate limited: %d", got)
	}
}
