package source

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// REGRESSION: a saturated endpoint must not starve a healthy one.
//
// The limiter used to take the daemon-global slot FIRST and then wait on the endpoint semaphore, so requests
// merely queued for a hot endpoint occupied global capacity while doing no work. One slow provider could hold
// every global slot and lock out every other endpoint. The endpoint slot is taken first now, so queued work
// for one endpoint holds nothing another endpoint needs.
func TestSlowEndpointDoesNotStarveAHealthyOne(t *testing.T) {
	limiter := NewLimiter(4, 2, 2*time.Second)
	ctx := context.Background()

	// Fill the hot endpoint to its per-endpoint cap and hold it.
	var held []func()
	for i := 0; i < 2; i++ {
		release, err := limiter.Acquire(ctx, "hot")
		if err != nil {
			t.Fatalf("filling the hot endpoint: %v", err)
		}
		held = append(held, release)
	}

	// Pile far more work onto the hot endpoint than the global cap could hold. All of it must queue on the
	// endpoint semaphore, holding no global capacity.
	var queued sync.WaitGroup
	stop := make(chan struct{})
	for i := 0; i < 12; i++ {
		queued.Add(1)
		go func() {
			defer queued.Done()
			release, err := limiter.Acquire(ctx, "hot")
			if err == nil {
				<-stop
				release()
			}
		}()
	}
	time.Sleep(150 * time.Millisecond) // let the queue build

	// A healthy endpoint must still get through immediately.
	done := make(chan error, 1)
	go func() {
		release, err := limiter.Acquire(ctx, "healthy")
		if err == nil {
			release()
		}
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("a healthy endpoint was starved by a saturated one: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("a healthy endpoint was starved by a saturated one: it never acquired")
	}

	close(stop)
	for _, release := range held {
		release()
	}
	queued.Wait()

	global, perHot := limiter.Peak("hot")
	if global > 4 {
		t.Fatalf("the global cap was exceeded: %d", global)
	}
	if perHot > 2 {
		t.Fatalf("the per-endpoint cap was exceeded: %d", perHot)
	}
}

func TestAdmissionQueueTimesOutRatherThanHanging(t *testing.T) {
	limiter := NewLimiter(1, 1, 100*time.Millisecond)
	release, err := limiter.Acquire(context.Background(), "endpoint")
	if err != nil {
		t.Fatal(err)
	}
	defer release()

	start := time.Now()
	if _, err := limiter.Acquire(context.Background(), "endpoint"); err == nil {
		t.Fatal("a saturated limiter must refuse rather than block forever")
	} else if AsFailure(err).Cond != CondAdmissionQueue {
		t.Fatalf("expected an admission-queue failure, got %v", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("the queue wait was not bounded: %v", elapsed)
	}
}

// A rolled-back endpoint slot must not leak: if the global slot cannot be had, the endpoint slot goes back.
func TestEndpointSlotIsRolledBackWhenGlobalIsFull(t *testing.T) {
	// One global slot and one slot per endpoint, so a leaked endpoint slot is immediately observable: endpoint
	// "b" would have nothing left to give.
	limiter := NewLimiter(1, 1, 80*time.Millisecond)
	release, err := limiter.Acquire(context.Background(), "a")
	if err != nil {
		t.Fatal(err)
	}
	// Endpoint "b" has capacity but the global cap is taken, so this must fail and give its slot back.
	if _, err := limiter.Acquire(context.Background(), "b"); err == nil {
		t.Fatal("expected the global cap to refuse")
	}
	release()
	// If the rollback leaked, "b" is now permanently full and this hangs out its queue wait.
	recovered, err := limiter.Acquire(context.Background(), "b")
	if err != nil {
		t.Fatalf("the endpoint slot leaked when the global acquisition failed: %v", err)
	}
	recovered()
}

// REGRESSION: a failed half-open probe used to wedge the breaker permanently.
//
// After the cooldown, Allow() marked a probe as issued; a failure below the threshold then left an elapsed
// deadline and a spent probe budget, a state no later Allow could escape. The endpoint stayed dark forever
// after one unlucky retry.
func TestBreakerHalfOpenFailureReopensRatherThanWedging(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	clock := func() time.Time { return now }
	breaker := NewBreaker(3, 30*time.Second, 60*time.Second, 1)
	breaker.SetClock(clock)

	for i := 0; i < 3; i++ {
		if !breaker.Allow() {
			t.Fatalf("the breaker should be closed on failure %d", i)
		}
		breaker.RecordFailure()
	}
	if !breaker.IsOpen() {
		t.Fatal("three failures inside the window must open the breaker")
	}
	if breaker.Allow() {
		t.Fatal("an open breaker must send nothing")
	}

	// Cooldown elapses: exactly one probe.
	now = now.Add(61 * time.Second)
	if !breaker.Allow() {
		t.Fatal("after the cooldown one probe must be admitted")
	}
	if breaker.Allow() {
		t.Fatal("half-open admits exactly one probe, not two")
	}
	// The probe fails. This is the branch whose absence wedged the endpoint.
	breaker.RecordFailure()
	if !breaker.IsOpen() {
		t.Fatal("a failed probe must re-open the breaker for another cooldown")
	}
	if breaker.Allow() {
		t.Fatal("a re-opened breaker must send nothing until its new cooldown elapses")
	}

	// Second cooldown, and this time the probe succeeds.
	now = now.Add(61 * time.Second)
	if !breaker.Allow() {
		t.Fatal("the breaker must offer another probe after the second cooldown")
	}
	breaker.RecordSuccess()
	if breaker.IsOpen() {
		t.Fatal("a successful probe must close the breaker")
	}
	for i := 0; i < 5; i++ {
		if !breaker.Allow() {
			t.Fatal("a closed breaker admits everything")
		}
	}
}

// Exactly one probe escapes, even when many goroutines ask at the same instant.
func TestBreakerHalfOpenAdmitsExactlyOneProbeUnderConcurrency(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	breaker := NewBreaker(1, 30*time.Second, 60*time.Second, 1)
	breaker.SetClock(func() time.Time { return now })

	breaker.Allow()
	breaker.RecordFailure()
	if !breaker.IsOpen() {
		t.Fatal("the breaker should be open")
	}
	now = now.Add(61 * time.Second)

	var admitted atomic.Int64
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if breaker.Allow() {
				admitted.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()
	if got := admitted.Load(); got != 1 {
		t.Fatalf("exactly one half-open probe may escape, got %d", got)
	}
}
