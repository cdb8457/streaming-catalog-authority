package source

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// EndpointConfig is everything the daemon knows about one HTTP Range endpoint. It comes from the daemon's own
// configuration, never from a manifest — a manifest names an endpoint, it does not describe one.
type EndpointConfig struct {
	ID string
	// ResolverURL turns a stable objectRef into short-lived access material. Empty means the endpoint serves
	// the objectRef directly and needs no resolution step.
	ResolverURL string
	// DirectBaseURL is used when ResolverURL is empty: the objectRef is appended as a single path segment.
	DirectBaseURL string
	// AllowedOrigins is the egress allowlist, as scheme+host+port. A resolved URL whose origin is not here is
	// never contacted, and neither is one whose name resolves to a loopback, private or link-local address.
	AllowedOrigins []string
	// TokenFile is the secret file holding the long-lived credential. Never argv, never an inline env value.
	TokenFile string
	// AllowInsecureHTTP permits a plaintext scheme. It says NOTHING about which addresses may be dialled.
	AllowInsecureHTTP bool
	// AllowPrivateAddresses is a separate, test-only authority that permits loopback, private and link-local
	// destinations.
	//
	// THESE TWO ARE NOT THE SAME PERMISSION. An earlier draft derived the address policy from the scheme
	// switch, so allowing plaintext HTTP to a public provider silently also authorised the daemon to dial
	// 127.0.0.1 and 169.254.169.254. A provider that wants plaintext is a bad provider; a provider that can
	// steer the daemon at the host's own metadata service is a vulnerability. They need separate switches.
	AllowPrivateAddresses bool
	MaxConnections        int
	ResolutionDeadline    time.Duration
	RefreshCooldown       time.Duration
	RequestTimeout        time.Duration
}

// Lease is EPHEMERAL ACCESS MATERIAL: a short-lived URL and the headers that go with it.
//
// IT IS MEMORY ONLY. It is never written to a manifest, to disk, to the probe-prefix cache, to a log line, to
// a metric label, to argv or to an error message. It has a String method that says so, so an accidental `%v`
// prints a placeholder rather than a signed URL.
type Lease struct {
	url       *url.URL
	header    http.Header
	expiresAt time.Time
	// generation increments on every successful resolution. A caller that meets a failure can tell whether
	// somebody else already replaced the lease it was using.
	generation uint64
}

func (l *Lease) String() string { return "<access-lease redacted>" }

func (l *Lease) Expired(now time.Time, skew time.Duration) bool {
	if l == nil {
		return true
	}
	if l.expiresAt.IsZero() {
		return false
	}
	return !now.Add(skew).Before(l.expiresAt)
}

// MaxSecretBytes bounds a credential file. A secret is a token, not a payload; anything larger is a
// misconfiguration or a device pretending to be one.
const MaxSecretBytes = 8 * 1024

// SecretFile holds a credential read from a file. The value never leaves this type except as a header value.
//
// THE FILE IS OPENED NO-FOLLOW AND CHECKED THROUGH THE DESCRIPTOR IT WILL READ. A symlinked secret path is
// refused rather than followed, and the mode and type are verified on the open descriptor rather than on a
// path that could have been replaced in between.
type SecretFile struct {
	path string
	mu   sync.Mutex
	// value is held in memory only, and is dropped and re-read on rotation.
	value string
}

func NewSecretFile(path string) *SecretFile { return &SecretFile{path: path} }

func (s *SecretFile) Value() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.value != "" {
		return s.value, nil
	}
	if s.path == "" {
		return "", nil
	}
	return s.loadLocked()
}

// Reload re-reads the file. This is what a rotated credential looks like from here, and it happens as part of
// an access refresh rather than on a timer. The old value is dropped before the new one is read, so a failed
// rotation cannot leave a stale credential in play.
func (s *SecretFile) Reload() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.value = ""
	_, err := s.loadLocked()
	return err
}

func (s *SecretFile) loadLocked() (string, error) {
	if s.path == "" {
		return "", nil
	}
	if !filepath.IsAbs(s.path) {
		return "", Fail(CondSourceAuthRefused, ClassTerminal, "credential path must be absolute")
	}
	file, err := openNoFollow(s.path)
	if err != nil {
		// The path is named in configuration; the contents never are, and neither is the OS error text.
		return "", Fail(CondSourceAuthRefused, ClassTerminal, "credential file unreadable")
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return "", Fail(CondSourceAuthRefused, ClassTerminal, "credential file unreadable")
	}
	if !info.Mode().IsRegular() {
		// Never a device, a FIFO or a directory: reading one can block forever or return something that is
		// not a credential at all.
		return "", Fail(CondSourceAuthRefused, ClassTerminal, "credential file is not a regular file")
	}
	if info.Size() > MaxSecretBytes {
		return "", Fail(CondSourceAuthRefused, ClassTerminal, "credential file is too large")
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		// Group- or world-readable. A credential that anybody on the host can read is not a credential.
		return "", Fail(CondSourceAuthRefused, ClassTerminal, "credential file permissions are too broad")
	}

	raw := make([]byte, MaxSecretBytes)
	n, err := file.Read(raw)
	if err != nil && n == 0 {
		return "", Fail(CondSourceAuthRefused, ClassTerminal, "credential file unreadable")
	}
	value := strings.TrimRight(string(raw[:n]), "\r\n")
	if value == "" {
		return "", Fail(CondSourceAuthRefused, ClassTerminal, "credential file empty")
	}
	if strings.ContainsAny(value, "\r\n") {
		// A newline inside a credential becomes header injection the moment it is composed into a request.
		return "", Fail(CondSourceAuthRefused, ClassTerminal, "credential contains a line break")
	}
	s.value = value
	return value, nil
}

// ResolverStats are counters the acceptance gates assert on.
type ResolverStats struct {
	Resolutions atomic.Int64
	Refreshes   atomic.Int64
	Shared      atomic.Int64
	Refused     atomic.Int64
}

type resolveCall struct {
	done  chan struct{}
	lease *Lease
	err   error
}

type leaseSlot struct {
	mu       sync.Mutex
	lease    *Lease
	inflight *resolveCall
	// lastUsed and active are guarded by the RESOLVER's lock, not this slot's, because they are eviction
	// bookkeeping rather than lease state. `active` is how many callers currently hold this slot; a slot with
	// an active holder is never evictable, which is what stops eviction from defeating single-flight.
	lastUsed time.Time
	active   int
	// resolvedOnce distinguishes the FIRST-EVER resolution from every later one. The first is not a refresh:
	// it is simply how a source becomes readable, and charging it to the expiry-recovery budget would mean the
	// very first read spent the allowance the first expiry needs.
	resolvedOnce  bool
	lastRefreshAt time.Time
}

// Resolver turns a STABLE reference into ephemeral access material, and renews it under hard bounds.
//
// THE SPLIT THIS ENFORCES. The control plane chose the source and proved the byte identity; this only decides
// how to reach the source it was given. A resolution never changes which source is read, and it never touches
// the namespace.
type Resolver struct {
	cfg    EndpointConfig
	policy EgressPolicy
	client *http.Client
	secret *SecretFile
	Stats  ResolverStats

	mu    sync.Mutex
	slots map[string]*leaseSlot
	now   func() time.Time
}

// MaxLeaseSlots bounds how many transport identities a resolver remembers.
//
// A slot is small, but one per source identity held forever is a leak with a library-sized coefficient: a
// 200 000-entry manifest with a mirror each is 400 000 slots, and a generation swap that bumps source
// generations creates a fresh set beside the old one. Least-recently-used slots are dropped once the bound is
// passed; dropping one costs at most one extra resolution later, which is the cheapest possible failure mode.
const MaxLeaseSlots = 8192

func NewResolver(cfg EndpointConfig, policy EgressPolicy, client *http.Client, secret *SecretFile) *Resolver {
	return &Resolver{cfg: cfg, policy: policy, client: client, secret: secret, slots: map[string]*leaseSlot{}, now: time.Now}
}

func (r *Resolver) SetClock(now func() time.Time) { r.now = now }

// acquireSlot returns the slot for an identity WITH ITS LOCK ALREADY HELD, and pins it against eviction.
//
// WHY BOTH, ATOMICALLY. An earlier draft inserted the slot, ran eviction while its lastUsed was still zero —
// so a brand-new slot could evict itself — and then released the resolver lock before the caller took the
// slot lock. In that gap another insertion could evict the slot just handed out, and the next caller for the
// same identity would create a second one. Two slots for one identity is two in-flight resolutions for one
// object: single-flight defeated by the cache that exists to bound it.
//
// Every caller must pair this with releaseSlot.
func (r *Resolver) acquireSlot(id TransportIdentity) *leaseSlot {
	key := id.Key()
	r.mu.Lock()
	s, ok := r.slots[key]
	if !ok {
		s = &leaseSlot{}
		r.slots[key] = s
	}
	// Marked used and pinned BEFORE anything can evict it.
	s.lastUsed = r.now()
	s.active++
	r.evictLocked()
	r.mu.Unlock()

	s.mu.Lock()
	return s
}

// releaseSlot drops the eviction pin, and prunes if the table is over its bound.
//
// WHY EVICTION HAPPENS HERE TOO. A burst of concurrent reads can hold far more slots active than the cap
// allows — that is intended, since an active slot must never be taken from its holder — but if the pruning
// only ever ran on INSERT, the oversized table would stay oversized forever once the burst ended and no new
// identity arrived. The cap is therefore "at most MaxLeaseSlots once things are idle", not "never exceeded",
// and this is the half that makes the first clause true.
//
// The prune runs only while the table is actually over its bound, so the common release is a decrement and a
// size comparison rather than a sort of the whole map.
func (r *Resolver) releaseSlot(s *leaseSlot) {
	r.mu.Lock()
	if s.active > 0 {
		s.active--
	}
	if len(r.slots) > MaxLeaseSlots {
		r.evictLocked()
	}
	r.mu.Unlock()
}

// evictLocked keeps the slot table bounded. A slot any caller currently holds is never dropped, so eviction
// can never take a slot out from under a resolution or hand a second caller a fresh one for the same
// identity. It is called with r.mu held and takes no slot lock, which is also what keeps the lock order
// one-way: resolver lock, then slot lock, never the reverse.
func (r *Resolver) evictLocked() {
	if len(r.slots) <= MaxLeaseSlots {
		return
	}
	type aged struct {
		key  string
		when time.Time
	}
	candidates := make([]aged, 0, len(r.slots))
	for key, slot := range r.slots {
		if slot.active > 0 {
			continue
		}
		candidates = append(candidates, aged{key: key, when: slot.lastUsed})
	}
	sort.Slice(candidates, func(i, j int) bool {
		if !candidates[i].when.Equal(candidates[j].when) {
			return candidates[i].when.Before(candidates[j].when)
		}
		return candidates[i].key < candidates[j].key
	})
	for _, candidate := range candidates {
		if len(r.slots) <= MaxLeaseSlots {
			return
		}
		delete(r.slots, candidate.key)
	}
}

// SlotCount is exported so a test can prove the table stays bounded.
func (r *Resolver) SlotCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.slots)
}

const leaseSkew = 2 * time.Second

// Get returns a usable lease, resolving one if there is none or the one held has lapsed.
//
// A KNOWN-EXPIRED LEASE IS A REFRESH, NOT AN INITIAL RESOLUTION. An earlier draft treated it as initial,
// which meant an endpoint whose resolutions were failing was re-resolved once per read, forever, with no
// cooldown between attempts — precisely the storm the budget exists to prevent.
func (r *Resolver) Get(ctx context.Context, id TransportIdentity, objectRef string) (*Lease, error) {
	slot := r.acquireSlot(id)
	defer r.releaseSlot(slot)
	if lease := slot.lease; lease != nil && !lease.Expired(r.now(), leaseSkew) {
		slot.mu.Unlock()
		return lease, nil
	}
	return r.resolveLocked(ctx, slot, objectRef, slot.resolvedOnce)
}

// Refresh forces a re-resolution because the access material was rejected or has lapsed.
//
// BOUNDED, SINGLE-FLIGHTED, COOLDOWN-LIMITED. Twenty handles meeting the same expired lease cost ONE
// resolution: the first starts it and the other nineteen wait on the same call. A source whose resolutions
// keep failing cannot be asked again until the configured cooldown elapses, however many readers want it. A
// refresh never triggers another refresh.
func (r *Resolver) Refresh(ctx context.Context, id TransportIdentity, objectRef string, stale *Lease) (*Lease, error) {
	slot := r.acquireSlot(id)
	defer r.releaseSlot(slot)
	// Somebody already replaced the lease this caller was using: take theirs rather than asking again.
	if slot.lease != nil && (stale == nil || slot.lease.generation > stale.generation) &&
		!slot.lease.Expired(r.now(), leaseSkew) {
		lease := slot.lease
		slot.mu.Unlock()
		r.Stats.Shared.Add(1)
		return lease, nil
	}
	return r.resolveLocked(ctx, slot, objectRef, true)
}

// resolveLocked is entered holding slot.mu and always releases it.
func (r *Resolver) resolveLocked(ctx context.Context, slot *leaseSlot, objectRef string, isRefresh bool) (*Lease, error) {
	if call := slot.inflight; call != nil {
		slot.mu.Unlock()
		r.Stats.Shared.Add(1)
		return waitFor(ctx, call)
	}
	if isRefresh {
		now := r.now()
		if !slot.lastRefreshAt.IsZero() && now.Sub(slot.lastRefreshAt) < r.cfg.RefreshCooldown {
			slot.mu.Unlock()
			r.Stats.Refused.Add(1)
			return nil, Fail(CondAccessLeaseExpired, ClassTerminal, "refresh budget exhausted for this cooldown")
		}
		slot.lastRefreshAt = now
		r.Stats.Refreshes.Add(1)
	}
	slot.resolvedOnce = true
	call := &resolveCall{done: make(chan struct{})}
	slot.inflight = call
	slot.mu.Unlock()

	// The resolution runs on the calling goroutine. There is no background worker here, so there is no way to
	// leak one and no queue that can outlive its reader.
	lease, err := r.doResolve(ctx, objectRef)

	slot.mu.Lock()
	call.lease, call.err = lease, err
	if err == nil {
		if slot.lease != nil {
			lease.generation = slot.lease.generation + 1
		} else {
			lease.generation = 1
		}
		slot.lease = lease
	}
	slot.inflight = nil
	slot.mu.Unlock()
	close(call.done)
	return lease, err
}

func waitFor(ctx context.Context, call *resolveCall) (*Lease, error) {
	select {
	case <-call.done:
		return call.lease, call.err
	case <-ctx.Done():
		return nil, Fail(CondReadDeadline, ClassTerminal, "waiting for a shared access resolution")
	}
}

type resolveResponse struct {
	URL             string            `json:"url"`
	Headers         map[string]string `json:"headers"`
	ExpiresAtUnixMs int64             `json:"expiresAtUnixMs"`
}

func (r *Resolver) doResolve(ctx context.Context, objectRef string) (*Lease, error) {
	r.Stats.Resolutions.Add(1)

	// No resolver configured: the endpoint serves the stable reference directly. There is still a lease, it
	// simply has no expiry, which keeps one code path for both shapes.
	if r.cfg.ResolverURL == "" {
		target, err := url.Parse(strings.TrimRight(r.cfg.DirectBaseURL, "/") + "/" + url.PathEscape(objectRef))
		if err != nil {
			return nil, Fail(CondAccessResolveFailed, ClassTerminal, "unparseable direct URL")
		}
		if failure := r.policy.CheckURL(target, r.cfg.AllowInsecureHTTP); failure != nil {
			return nil, failure
		}
		return &Lease{url: target, header: http.Header{}}, nil
	}

	deadline := r.cfg.ResolutionDeadline
	if deadline <= 0 {
		deadline = 5 * time.Second
	}
	// The resolution is spent FROM the read's absolute deadline, never added to it.
	resolveCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()

	body, _ := json.Marshal(map[string]string{"objectRef": objectRef})
	req, err := http.NewRequestWithContext(resolveCtx, http.MethodPost, r.cfg.ResolverURL, bytes.NewReader(body))
	if err != nil {
		return nil, Fail(CondAccessResolveFailed, ClassTerminal, "")
	}
	req.Header.Set("Content-Type", "application/json")
	if r.secret != nil {
		token, err := r.secret.Value()
		if err != nil {
			return nil, err
		}
		if token != "" {
			// The credential is composed into a header at request time. It is never a URL component.
			req.Header.Set("Authorization", "Bearer "+token)
		}
	}

	resp, err := r.client.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(resolveCtx.Err(), context.DeadlineExceeded) {
			return nil, Fail(CondReadDeadline, ClassTerminal, "access resolution deadline")
		}
		var f *Failure
		if errors.As(err, &f) {
			return nil, f
		}
		return nil, Fail(CondAccessResolveFailed, ClassRetryable, "")
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
		return nil, Fail(CondSourceRefUnknown, ClassTerminal, "")
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		// A rotated credential is the likely cause, so re-read the secret file once. The retry itself is the
		// caller's single refresh; this does not loop.
		if r.secret != nil {
			_ = r.secret.Reload()
		}
		return nil, Fail(CondSourceAuthRefused, ClassTerminal, "")
	case resp.StatusCode != http.StatusOK:
		return nil, Fail(CondAccessResolveFailed, ClassRetryable, "")
	}

	var decoded resolveResponse
	if err := json.NewDecoder(newBoundedReader(resp.Body, 64*1024)).Decode(&decoded); err != nil {
		return nil, Fail(CondAccessResolveFailed, ClassTerminal, "unparseable resolver response")
	}
	target, err := url.Parse(decoded.URL)
	if err != nil {
		return nil, Fail(CondAccessResolveFailed, ClassTerminal, "unparseable access URL")
	}
	// A RESOLVED URL IS PROVIDER-SUPPLIED DATA and is treated as untrusted input. The origin is checked here,
	// and every address it resolves to is checked again at dial time.
	if failure := r.policy.CheckURL(target, r.cfg.AllowInsecureHTTP); failure != nil {
		return nil, failure
	}

	header := http.Header{}
	for k, v := range decoded.Headers {
		if strings.ContainsAny(k, "\r\n") || strings.ContainsAny(v, "\r\n") {
			return nil, Fail(CondAccessResolveFailed, ClassTerminal, "header injection in resolver response")
		}
		header.Set(k, v)
	}
	lease := &Lease{url: target, header: header}
	if decoded.ExpiresAtUnixMs > 0 {
		lease.expiresAt = time.UnixMilli(decoded.ExpiresAtUnixMs).UTC()
	}
	return lease, nil
}

// openNoFollow opens a path refusing to traverse a final symlink.
func openNoFollow(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|osNoFollow, 0)
	if err != nil {
		return nil, err
	}
	return file, nil
}
