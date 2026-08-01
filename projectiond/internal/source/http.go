package source

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// HTTPStats are the counters the amplification gates assert on.
type HTTPStats struct {
	Requests       atomic.Int64
	Bytes          atomic.Int64
	Status429      atomic.Int64
	RefusedRedirs  atomic.Int64
	FullBodyOnPart atomic.Int64
}

// HTTPRangeAdapter reads bytes over HTTP with a strict partial-content discipline.
//
// IT IS PROVIDER-INDEPENDENT. It knows an endpoint id, an opaque object reference and a resolver; it knows
// nothing about any particular provider's API. A later provider-specific adapter is a different Resolver, not
// a different read path — which is the whole reason resolution was separated from fetching.
type HTTPRangeAdapter struct {
	cfg      EndpointConfig
	policy   EgressPolicy
	resolver *Resolver
	client   *http.Client
	breaker  *Breaker
	limiter  *Limiter
	Stats    HTTPStats
	now      func() time.Time
}

var errRedirectRefused = errors.New("redirect refused")

// NewHTTPRangeAdapter builds the adapter and the one HTTP client it uses.
//
// THE CONFIGURATION IS VALIDATED BEFORE A CLIENT EXISTS, so there is no window in which a credential-bearing
// request could be made against an endpoint whose allowlist turned out to be unusable.
func NewHTTPRangeAdapter(cfg EndpointConfig, secret *SecretFile, breaker *Breaker, limiter *Limiter) (*HTTPRangeAdapter, error) {
	policy, err := ValidateEndpoint(cfg)
	if err != nil {
		return nil, err
	}
	maxConns := cfg.MaxConnections
	if maxConns < 1 {
		maxConns = 4
	}
	timeout := cfg.RequestTimeout
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	transport := &http.Transport{
		Proxy:                 nil, // no proxy: egress goes exactly where the allowlist says
		MaxConnsPerHost:       maxConns,
		MaxIdleConnsPerHost:   maxConns,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 10 * time.Second,
		ExpectContinueTimeout: time.Second,
		DisableCompression:    true, // a ranged read is bytes, not a document
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
		// Every address is re-checked immediately before the connection is made, which is the only place a
		// DNS rebind can be caught.
		DialContext: policy.DialContext(DefaultDialer()),
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   timeout,
		// REDIRECTS ARE NEVER FOLLOWED. Following one would let a provider point this daemon at any host it
		// liked, straight through the allowlist.
		CheckRedirect: func(*http.Request, []*http.Request) error { return errRedirectRefused },
	}
	adapter := &HTTPRangeAdapter{cfg: cfg, policy: policy, client: client, breaker: breaker, limiter: limiter, now: time.Now}
	adapter.resolver = NewResolver(cfg, policy, client, secret)
	return adapter, nil
}

func (a *HTTPRangeAdapter) Kind() string        { return "http-range" }
func (a *HTTPRangeAdapter) Resolver() *Resolver { return a.resolver }
func (a *HTTPRangeAdapter) Close() error {
	a.client.CloseIdleConnections()
	return nil
}

func (a *HTTPRangeAdapter) SetClock(now func() time.Time) {
	a.now = now
	a.resolver.SetClock(now)
}

// Fetch fills dst[:req.Length] and returns how many bytes it produced.
//
// AT MOST ONE ACCESS REFRESH PER FETCH. If the first attempt is refused in a way that a fresh lease could
// plausibly fix, the reference is re-resolved once and the identical request is retried. If that fails, the
// failure is re-classified terminal so no caller upstream can turn it into a second refresh — a refresh
// cannot trigger a refresh.
func (a *HTTPRangeAdapter) Fetch(ctx context.Context, req ReadRequest, dst []byte) (int, error) {
	if failure := req.Valid(dst); failure != nil {
		return 0, failure
	}
	if a.breaker != nil && !a.breaker.Allow() {
		// Zero packets leave the host while the breaker is open, and the entry stays exactly where it is.
		return 0, Fail(CondCircuitOpen, ClassTerminal, a.cfg.ID)
	}

	// The lease is keyed by the FULL pinned transport identity, so a generation swap that reuses a source id
	// with a bumped source generation or a different object cannot be handed the old object's lease.
	identity := NewTransportIdentity(a.cfg.ID, req.SourceID, req.SourceGeneration, req.Locator.ObjectRef)

	lease, err := a.resolver.Get(ctx, identity, req.Locator.ObjectRef)
	if err != nil {
		a.recordFailure(err)
		return 0, err
	}

	n, failure := a.attempt(ctx, lease, req, dst)
	if failure == nil {
		if a.breaker != nil {
			a.breaker.RecordSuccess()
		}
		return n, nil
	}
	if failure.Class != ClassAccessRefresh {
		a.recordFailure(failure)
		return n, failure
	}

	// A lapsed lease is the normal end of a signed URL's life, not a failure, so this is not counted against
	// the breaker unless the refresh itself fails.
	fresh, refreshErr := a.resolver.Refresh(ctx, identity, req.Locator.ObjectRef, lease)
	if refreshErr != nil {
		a.recordFailure(refreshErr)
		return 0, terminalize(refreshErr)
	}
	n, failure = a.attempt(ctx, fresh, req, dst)
	if failure == nil {
		if a.breaker != nil {
			a.breaker.RecordSuccess()
		}
		return n, nil
	}
	a.recordFailure(failure)
	return n, terminalize(failure)
}

// terminalize makes a post-refresh failure un-refreshable, so there is no path on which a refresh leads to
// another refresh.
func terminalize(err error) error {
	f := AsFailure(err)
	if f.Class == ClassAccessRefresh {
		return Fail(f.Cond, ClassTerminal, f.Detail)
	}
	return f
}

func (a *HTTPRangeAdapter) recordFailure(err error) {
	if a.breaker == nil {
		return
	}
	// ONLY ENDPOINT-HEALTH FAILURES OPEN THE BREAKER. A handful of objects a provider no longer has must not
	// black out every healthy title on the endpoint; see CountsTowardEndpointBreaker.
	if !CountsTowardEndpointBreaker(AsFailure(err).Cond) {
		return
	}
	a.breaker.RecordFailure()
}

func (a *HTTPRangeAdapter) attempt(ctx context.Context, lease *Lease, req ReadRequest, dst []byte) (int, *Failure) {
	want := req.Length
	if want == 0 {
		return 0, nil
	}
	last := req.Offset + want - 1

	if a.limiter != nil {
		release, err := a.limiter.Acquire(ctx, a.cfg.ID)
		if err != nil {
			return 0, AsFailure(err)
		}
		defer release()
	}
	if err := ctx.Err(); err != nil {
		return 0, Fail(CondReadDeadline, ClassTerminal, "")
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, lease.url.String(), nil)
	if err != nil {
		return 0, Fail(CondAccessResolveFailed, ClassTerminal, "")
	}
	for key, values := range lease.header {
		for _, value := range values {
			httpReq.Header.Add(key, value)
		}
	}
	httpReq.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", req.Offset, last))
	httpReq.Header.Set("Accept-Encoding", "identity")

	a.Stats.Requests.Add(1)
	resp, err := a.client.Do(httpReq)
	if err != nil {
		if errors.Is(err, errRedirectRefused) {
			a.Stats.RefusedRedirs.Add(1)
			return 0, Fail(CondRedirectRefused, ClassTerminal, "")
		}
		var f *Failure
		if errors.As(err, &f) {
			return 0, f
		}
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return 0, Fail(CondReadDeadline, ClassTerminal, "")
		}
		return 0, Fail(CondSourceUnreachable, ClassRetryable, "")
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusPartialContent:
		// the only acceptable answer to a ranged request
	case http.StatusOK:
		// A 200 FULL BODY IS A PROTOCOL VIOLATION, not a slow success. Accepting one turns a 1 MiB probe into
		// a whole-file download, which is exactly how a library scan becomes a bandwidth bill. The body is
		// never read: the connection is abandoned at the header.
		a.Stats.FullBodyOnPart.Add(1)
		return 0, Fail(CondRangeUnsupported, ClassTerminal, "")
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusGone:
		return 0, Fail(CondAccessLeaseExpired, ClassAccessRefresh, strconv.Itoa(resp.StatusCode))
	case http.StatusNotFound:
		return 0, Fail(CondSourceRefUnknown, ClassTerminal, "")
	case http.StatusRequestedRangeNotSatisfiable:
		return 0, Fail(CondRangeMismatch, ClassTerminal, "416")
	case http.StatusTooManyRequests:
		a.Stats.Status429.Add(1)
		return 0, Fail(CondSourceUnreachable, ClassRetryable, "429")
	case http.StatusRequestTimeout, http.StatusInternalServerError, http.StatusBadGateway,
		http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return 0, Fail(CondSourceUnreachable, ClassRetryable, strconv.Itoa(resp.StatusCode))
	default:
		return 0, Fail(CondSourceUnreachable, ClassTerminal, strconv.Itoa(resp.StatusCode))
	}

	start, end, total, ok := parseContentRange(resp.Header.Get("Content-Range"))
	if !ok {
		return 0, Fail(CondRangeMismatch, ClassTerminal, "unparseable Content-Range")
	}
	// EXACTLY the requested window, and a total that agrees with the manifest. A total that disagrees means
	// these are not the bytes of this projected version.
	if start != req.Offset || end != last {
		return 0, Fail(CondRangeMismatch, ClassTerminal, "")
	}
	if total != req.SizeBytes {
		return 0, Fail(CondSizeDisagrees, ClassTerminal, "")
	}
	if resp.ContentLength >= 0 && resp.ContentLength != want {
		return 0, Fail(CondRangeMismatch, ClassTerminal, "content-length")
	}

	// The body is bounded by the granted window, so a server that keeps sending cannot make this read consume
	// memory or time without bound.
	//
	// THE EXACT RANGE IS ENOUGH; EOF IS NOT REQUIRED. An earlier draft read one extra byte to prove the body
	// ended where it should. Against a correct chunked 206 that delays its terminal chunk, that probe blocked
	// until the whole client timeout — a correct server made slow by a correctness check. The bound is what
	// stops extra bytes being used: nothing past `want` is ever read into the buffer, returned or cached, and
	// a declared Content-Length that disagrees is already refused above.
	body := newBoundedReader(resp.Body, want)
	read, err := io.ReadFull(body, dst[:want])
	if err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) {
			return read, Fail(CondShortBody, ClassTerminal, "")
		}
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return read, Fail(CondReadDeadline, ClassTerminal, "")
		}
		return read, Fail(CondSourceUnreachable, ClassRetryable, "")
	}
	a.Stats.Bytes.Add(int64(read))
	return read, nil
}

// parseContentRange accepts exactly `bytes <start>-<end>/<total>` and nothing looser.
func parseContentRange(value string) (start, end, total int64, ok bool) {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, "bytes ") {
		return 0, 0, 0, false
	}
	rest := strings.TrimPrefix(value, "bytes ")
	slash := strings.LastIndex(rest, "/")
	if slash < 0 {
		return 0, 0, 0, false
	}
	span, totalPart := rest[:slash], rest[slash+1:]
	dash := strings.Index(span, "-")
	if dash < 0 {
		return 0, 0, 0, false
	}
	var err error
	if start, err = strconv.ParseInt(span[:dash], 10, 64); err != nil {
		return 0, 0, 0, false
	}
	if end, err = strconv.ParseInt(span[dash+1:], 10, 64); err != nil {
		return 0, 0, 0, false
	}
	if total, err = strconv.ParseInt(totalPart, 10, 64); err != nil {
		return 0, 0, 0, false
	}
	if start < 0 || end < start || total < 0 {
		return 0, 0, 0, false
	}
	return start, end, total, true
}

// boundedReader refuses to hand back more than the bytes that were asked for.
type boundedReader struct {
	inner     io.Reader
	remaining int64
}

func newBoundedReader(r io.Reader, limit int64) *boundedReader {
	return &boundedReader{inner: r, remaining: limit}
}

func (b *boundedReader) Read(p []byte) (int, error) {
	if b.remaining <= 0 {
		return 0, io.EOF
	}
	if int64(len(p)) > b.remaining {
		p = p[:b.remaining]
	}
	n, err := b.inner.Read(p)
	b.remaining -= int64(n)
	return n, err
}
