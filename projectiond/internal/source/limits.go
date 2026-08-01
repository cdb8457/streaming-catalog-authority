package source

import (
	"context"
	"sync"
	"time"
)

// Limiter is the daemon-wide and per-endpoint concurrency cap.
//
// A READ THAT CANNOT GET A SLOT RETURNS EIO. It does not queue past its deadline and it does not hang: the
// queue wait is bounded well inside the absolute read deadline, so a saturated endpoint costs one file's read
// rather than the mount's responsiveness.
//
// THE ENDPOINT SLOT IS TAKEN FIRST, AND THAT ORDER IS THE WHOLE POINT. An earlier draft took the global slot
// first and then waited on the endpoint semaphore, which meant a saturated endpoint's queue occupied global
// capacity while doing no work at all — one slow provider could starve every healthy one. Waiting for the
// endpoint first means queued work for a hot endpoint holds nothing another endpoint needs, and the global
// slot is held only by requests that are actually about to run. If the global slot then cannot be had in
// time, the endpoint slot is rolled back rather than leaked.
type Limiter struct {
	global    chan struct{}
	perHost   map[string]chan struct{}
	perHostN  int
	queueWait time.Duration
	mu        sync.Mutex

	// observed high-water marks, for the acceptance gates
	statMu     sync.Mutex
	inflight   int
	maxSeen    int
	perMax     map[string]int
	perCurrent map[string]int
}

func NewLimiter(globalN, perEndpointN int, queueWait time.Duration) *Limiter {
	if globalN < 1 {
		globalN = 1
	}
	if perEndpointN < 1 {
		perEndpointN = 1
	}
	if queueWait <= 0 {
		queueWait = 5 * time.Second
	}
	return &Limiter{
		global:     make(chan struct{}, globalN),
		perHost:    map[string]chan struct{}{},
		perHostN:   perEndpointN,
		queueWait:  queueWait,
		perMax:     map[string]int{},
		perCurrent: map[string]int{},
	}
}

func (l *Limiter) endpointSem(endpoint string) chan struct{} {
	l.mu.Lock()
	defer l.mu.Unlock()
	sem, ok := l.perHost[endpoint]
	if !ok {
		sem = make(chan struct{}, l.perHostN)
		l.perHost[endpoint] = sem
	}
	return sem
}

// Acquire takes an endpoint slot and then a global slot, both bounded by one shared queue-wait budget.
func (l *Limiter) Acquire(ctx context.Context, endpoint string) (func(), error) {
	waitCtx, cancel := context.WithTimeout(ctx, l.queueWait)
	defer cancel()

	sem := l.endpointSem(endpoint)
	select {
	case sem <- struct{}{}:
	case <-waitCtx.Done():
		return nil, Fail(CondAdmissionQueue, ClassTerminal, "endpoint")
	}

	select {
	case l.global <- struct{}{}:
	case <-waitCtx.Done():
		<-sem // roll the endpoint slot back rather than leaking it
		return nil, Fail(CondAdmissionQueue, ClassTerminal, "global")
	}

	l.statMu.Lock()
	l.inflight++
	l.perCurrent[endpoint]++
	if l.inflight > l.maxSeen {
		l.maxSeen = l.inflight
	}
	if l.perCurrent[endpoint] > l.perMax[endpoint] {
		l.perMax[endpoint] = l.perCurrent[endpoint]
	}
	l.statMu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			l.statMu.Lock()
			l.inflight--
			l.perCurrent[endpoint]--
			l.statMu.Unlock()
			<-l.global
			<-sem
		})
	}, nil
}

// Peak reports the highest simultaneous in-flight count observed, globally and for one endpoint. The
// acceptance gates assert these never exceeded the configured caps.
func (l *Limiter) Peak(endpoint string) (global, perEndpoint int) {
	l.statMu.Lock()
	defer l.statMu.Unlock()
	return l.maxSeen, l.perMax[endpoint]
}

// breakerState is explicit rather than inferred from timestamps, because "closed" and "open but cooled down"
// were previously distinguishable only by a comparison that a failed probe left in an unreachable state.
type breakerState int

const (
	breakerClosed breakerState = iota
	breakerOpen
	breakerHalfOpen
)

// Breaker is the per-endpoint circuit breaker.
//
// An open breaker is the mechanism by which a provider outage costs ZERO further provider traffic instead of
// one failed request per file per scan. A successful access-lease refresh is deliberately not a failure here:
// a lease lapsing is the normal life of a signed URL, and counting it would mean a healthy endpoint with a
// short lease trips its own breaker during ordinary playback.
//
// THE HALF-OPEN PROBE CANNOT WEDGE. Exactly one request is admitted per cooldown; if it fails the breaker
// re-opens for another full cooldown, and if it succeeds the breaker closes. An earlier draft left a failed
// probe with an elapsed deadline and a spent probe budget, which is a state no later request could ever get
// out of — the endpoint would have stayed dark forever after one unlucky retry.
type Breaker struct {
	threshold int
	window    time.Duration
	cooldown  time.Duration
	halfOpenN int

	mu           sync.Mutex
	state        breakerState
	failures     []time.Time
	openUntil    time.Time
	probesIssued int
	now          func() time.Time
}

func NewBreaker(threshold int, window, cooldown time.Duration, halfOpenProbes int) *Breaker {
	if threshold < 1 {
		threshold = 1
	}
	if halfOpenProbes < 1 {
		halfOpenProbes = 1
	}
	return &Breaker{
		threshold: threshold, window: window, cooldown: cooldown, halfOpenN: halfOpenProbes,
		now: time.Now,
	}
}

// SetClock is for tests. Production always uses the wall clock.
func (b *Breaker) SetClock(now func() time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.now = now
}

// Allow reports whether a request may leave the host. While open it returns false and the read fails fast
// locally: zero packets, and the entry stays exactly where it was in the namespace.
func (b *Breaker) Allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	switch b.state {
	case breakerClosed:
		return true
	case breakerOpen:
		if now.Before(b.openUntil) {
			return false
		}
		// The cooldown elapsed. Admit exactly one probe and remember that it is outstanding.
		b.state = breakerHalfOpen
		b.probesIssued = 1
		return true
	default: // breakerHalfOpen
		if b.probesIssued >= b.halfOpenN {
			return false
		}
		b.probesIssued++
		return true
	}
}

func (b *Breaker) RecordSuccess() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.state = breakerClosed
	b.failures = nil
	b.openUntil = time.Time{}
	b.probesIssued = 0
}

func (b *Breaker) RecordFailure() {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	if b.state == breakerHalfOpen {
		// A failed probe re-opens for another full cooldown. This is the branch whose absence wedged the
		// endpoint permanently.
		b.state = breakerOpen
		b.openUntil = now.Add(b.cooldown)
		b.probesIssued = 0
		b.failures = nil
		return
	}
	cutoff := now.Add(-b.window)
	kept := b.failures[:0]
	for _, t := range b.failures {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	b.failures = append(kept, now)
	if len(b.failures) >= b.threshold {
		b.state = breakerOpen
		b.openUntil = now.Add(b.cooldown)
		b.probesIssued = 0
		b.failures = nil
	}
}

func (b *Breaker) IsOpen() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.state == breakerOpen && b.now().Before(b.openUntil)
}
