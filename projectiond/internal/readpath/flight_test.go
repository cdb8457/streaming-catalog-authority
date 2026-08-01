package readpath

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/cache"
)

// REGRESSION: the completion boundary used to leak a duplicate fetch.
//
// The fetch goroutine deleted the flight, unlocked, and only then let a waiter wake and populate the cache. A
// read arriving in that window found neither a flight to join nor a cache to read, and started a SECOND
// provider request for bytes that had already been paid for. "Exactly one fetch" therefore held only when
// nobody arrived at precisely the wrong moment, which is not a guarantee.
//
// The seam pauses on the fetch goroutine after the transport produced bytes and before they are published,
// which is exactly that window, and starts another read inside it.
func TestNoDuplicateFetchAtTheCompletionBoundary(t *testing.T) {
	adapter := newCountingAdapter()
	probe, err := cache.NewProbeCache(t.TempDir(), 64<<20, 4<<20)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := NewReader(DefaultConfig(), staticRouter{adapter}, probe, cache.NewPlaybackCache(32<<20, 8<<20))
	if err != nil {
		t.Fatal(err)
	}

	entered := make(chan struct{})
	proceed := make(chan struct{})
	var once sync.Once
	reader.onFetchComplete = func() {
		once.Do(func() {
			close(entered)
			<-proceed
		})
	}

	first, err := reader.Open(testEntry(), "gen_one")
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Release(first)
	second, err := reader.Open(testEntry(), "gen_one")
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Release(second)

	firstDone := make(chan error, 1)
	go func() {
		_, err := reader.Read(context.Background(), first, make([]byte, 4096), 0)
		firstDone <- err
	}()

	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("the fetch never reached its completion boundary")
	}

	// A second read arrives in the window. It must not start its own fetch.
	secondDone := make(chan error, 1)
	go func() {
		_, err := reader.Read(context.Background(), second, make([]byte, 4096), 0)
		secondDone <- err
	}()
	time.Sleep(150 * time.Millisecond) // long enough for a duplicate to have been issued

	close(proceed)
	if err := <-firstDone; err != nil {
		t.Fatalf("the first read failed: %v", err)
	}
	select {
	case err := <-secondDone:
		if err != nil {
			t.Fatalf("the second read failed: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the second read never completed")
	}

	if got := adapter.Count(); got != 1 {
		t.Fatalf("the completion boundary allowed %d fetches; exactly one is the guarantee", got)
	}
}

// A newcomer must not attach itself to a flight whose last participant has already left: that fetch is
// cancelled and would hand the newcomer a failure that has nothing to do with its own request.
func TestNewReadDoesNotJoinAnAbandonedFlight(t *testing.T) {
	adapter := newGatedAdapter(0) // every fetch parks until released
	reader := newBlockingReader(t, adapter)

	handle, err := reader.Open(testEntry(), "gen_one")
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Release(handle)

	// One reader starts a fetch and abandons it.
	abandoning, cancel := context.WithCancel(context.Background())
	gone := make(chan struct{})
	go func() {
		defer close(gone)
		_, _ = reader.Read(abandoning, handle, make([]byte, 4096), 0)
	}()
	select {
	case <-adapter.parked:
	case <-time.After(3 * time.Second):
		t.Fatal("the fetch never started")
	}
	cancel()
	<-gone

	// The next reader must get a fresh fetch rather than inheriting the cancelled one.
	second, err := reader.Open(testEntry(), "gen_one")
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Release(second)

	result := make(chan error, 1)
	go func() {
		_, err := reader.Read(context.Background(), second, make([]byte, 4096), 0)
		result <- err
	}()
	time.Sleep(100 * time.Millisecond)
	close(adapter.release)

	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("a new read inherited an abandoned flight's failure: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the new read never completed")
	}
}
