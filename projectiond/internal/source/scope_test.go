package source

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/fakeprovider"
)

// REGRESSION: the private-address override must not widen past its own name.
//
// It made checkIP return nil before every classification, so enabling the in-process fake also authorised
// 169.254.169.254 — the cloud metadata service — plus 0.0.0.0 and multicast. A test convenience that can
// reach the metadata service is a server-side request forgery with a friendly field name.
func TestPrivateAddressOverrideCannotReachMetadataOrNonRoutableAddresses(t *testing.T) {
	permissive := EgressPolicy{AllowLoopback: true}
	for _, address := range []string{
		"169.254.169.254", // the cloud metadata service
		"169.254.1.1",     // any link-local
		"fe80::1",         // IPv6 link-local
		"0.0.0.0",         // unspecified
		"::",              // IPv6 unspecified
		"224.0.0.1",       // multicast
		"ff02::1",         // IPv6 link-local multicast
	} {
		if failure := permissive.checkIP(parseIP(t, address)); failure == nil {
			t.Fatalf("%s must be refused even with the private-address switch on", address)
		}
	}
	// What the switch IS for: loopback and RFC1918, and nothing else.
	for _, address := range []string{"127.0.0.1", "::1", "10.0.0.5", "192.168.1.9", "172.16.0.3"} {
		if failure := permissive.checkIP(parseIP(t, address)); failure != nil {
			t.Fatalf("%s should be permitted by the private-address switch: %v", address, failure)
		}
	}
	// And with the switch off, those go back to being refused.
	strict := EgressPolicy{}
	for _, address := range []string{"127.0.0.1", "10.0.0.5"} {
		if failure := strict.checkIP(parseIP(t, address)); failure == nil {
			t.Fatalf("%s must be refused without the switch", address)
		}
	}
	if failure := strict.checkIP(parseIP(t, "93.184.216.34")); failure != nil {
		t.Fatalf("a public address must be reachable: %v", failure)
	}
}

// REGRESSION: a handful of bad OBJECTS must not black out a healthy ENDPOINT.
//
// The breaker counted every classified failure, so five ordinary 404s — or five objects whose responses were
// truncated or mis-ranged — opened the endpoint-wide breaker and made every healthy title unreadable.
func TestBadObjectsDoNotOpenTheEndpointBreaker(t *testing.T) {
	server := newFake(t, fakeprovider.Options{})
	breaker := NewBreaker(5, 30*time.Second, 60*time.Second, 1)
	adapter, err := NewHTTPRangeAdapter(EndpointConfig{
		ID: "fake", ResolverURL: server.ResolveURL(), AllowedOrigins: []string{server.BaseURL()},
		AllowInsecureHTTP: true, AllowPrivateAddresses: true, MaxConnections: 4,
		RequestTimeout: 5 * time.Second, RefreshCooldown: 30 * time.Second,
	}, nil, breaker, NewLimiter(8, 4, 2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.Close()

	// Five DIFFERENT objects, each broken in an object-specific way.
	faults := []fakeprovider.Fault{
		fakeprovider.FaultMismatchedRange, // wrong Content-Range for this object
		fakeprovider.FaultShortBody,       // this object's stored bytes are truncated
		fakeprovider.FaultWrongTotalSize,  // this object disagrees with the manifest
		fakeprovider.FaultMismatchedRange,
		fakeprovider.FaultShortBody,
	}
	for i, fault := range faults {
		ref := fmt.Sprintf("bad-%d", i)
		server.AddObject(ref, testObjectSize)
		server.InjectFault(ref, fault, 0)
		req := rangeRequest(0, 65536)
		req.SourceID = fmt.Sprintf("src_bad_%d", i)
		req.Locator.ObjectRef = ref
		if _, err := adapter.Fetch(context.Background(), req, make([]byte, 65536)); err == nil {
			t.Fatalf("object %s should have failed", ref)
		}
	}
	// Objects a provider simply does not have any more.
	for i := 0; i < 5; i++ {
		req := rangeRequest(0, 4096)
		req.SourceID = fmt.Sprintf("src_missing_%d", i)
		req.Locator.ObjectRef = fmt.Sprintf("never-existed-%d", i)
		if _, err := adapter.Fetch(context.Background(), req, make([]byte, 4096)); err == nil {
			t.Fatal("a missing object should have failed")
		}
	}

	if breaker.IsOpen() {
		t.Fatal("bad and missing OBJECTS opened the endpoint-wide breaker")
	}
	// The healthy title must still be readable, which is the whole point.
	if _, err := adapter.Fetch(context.Background(), rangeRequest(0, 4096), make([]byte, 4096)); err != nil {
		t.Fatalf("a healthy object became unreadable because other objects were bad: %v", err)
	}
}

// ...while genuine endpoint failures still open it.
func TestEndpointFailuresStillOpenTheBreaker(t *testing.T) {
	server := newFake(t, fakeprovider.Options{})
	breaker := NewBreaker(5, 30*time.Second, 60*time.Second, 1)
	adapter, err := NewHTTPRangeAdapter(EndpointConfig{
		ID: "fake", ResolverURL: server.ResolveURL(), AllowedOrigins: []string{server.BaseURL()},
		AllowInsecureHTTP: true, AllowPrivateAddresses: true, MaxConnections: 4,
		RequestTimeout: 5 * time.Second, RefreshCooldown: 30 * time.Second,
	}, nil, breaker, NewLimiter(8, 4, 2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.Close()

	server.InjectFault(testObject, fakeprovider.Fault503, 0)
	for i := 0; i < 6 && !breaker.IsOpen(); i++ {
		_, _ = adapter.Fetch(context.Background(), rangeRequest(0, 4096), make([]byte, 4096))
	}
	if !breaker.IsOpen() {
		t.Fatal("repeated 5xx from the endpoint must open the breaker")
	}
	if !CountsTowardEndpointBreaker(CondSourceUnreachable) {
		t.Fatal("transport failure must count")
	}
	for _, perObject := range []string{
		CondSourceRefUnknown, CondSourceNotFound, CondSizeDisagrees, CondRangeMismatch, CondShortBody,
		CondAccessLeaseExpired, CondCircuitOpen, CondAdmissionQueue,
	} {
		if CountsTowardEndpointBreaker(perObject) {
			t.Fatalf("%s is object-specific or self-inflicted and must not count", perObject)
		}
	}
}

// REGRESSION: eviction must not defeat single-flight.
//
// The slot table was inserted into, evicted, and then handed out with the resolver lock released — so a
// concurrent insertion could evict the slot just returned, and the next caller for the same identity would
// build a second one. Two slots for one identity is two resolutions for one object.
//
// This drives the table directly rather than through 8k HTTP requests: the property is about slot
// bookkeeping, and a test that never crosses MaxLeaseSlots cannot regress the thing it names.
func TestSlotEvictionCannotDefeatSingleFlight(t *testing.T) {
	server := newFake(t, fakeprovider.Options{})
	resolver := newAdapter(t, server, nil).Resolver()

	hot := NewTransportIdentity("fake", "src_hot", 1, "obj-hot")
	held := resolver.acquireSlot(hot)
	held.mu.Unlock()
	// The hot slot stays ACTIVE for the whole flood, exactly as it would while a resolution is in flight.
	defer resolver.releaseSlot(held)

	// Force the table well past its cap, releasing each so it becomes evictable.
	for i := 0; i < MaxLeaseSlots+1000; i++ {
		id := NewTransportIdentity("fake", fmt.Sprintf("src_flood_%d", i), 1, fmt.Sprintf("obj-flood-%d", i))
		slot := resolver.acquireSlot(id)
		slot.mu.Unlock()
		resolver.releaseSlot(slot)
	}
	if got := resolver.SlotCount(); got > MaxLeaseSlots {
		t.Fatalf("eviction did not keep the table bounded: %d slots, cap %d", got, MaxLeaseSlots)
	}

	// The hot identity must still resolve to the SAME slot. A different pointer means a second slot, which
	// means a second in-flight resolution for one object.
	again := resolver.acquireSlot(hot)
	again.mu.Unlock()
	defer resolver.releaseSlot(again)
	if again != held {
		t.Fatal("an active slot was evicted and re-created; single-flight is defeated")
	}
}

// REGRESSION: a burst may legitimately hold more slots than the cap, but the table must come back down once
// the burst ends — not stay oversized forever because pruning only ran on insert.
func TestSlotTableReturnsToItsBoundAfterABurst(t *testing.T) {
	server := newFake(t, fakeprovider.Options{})
	resolver := newAdapter(t, server, nil).Resolver()

	// Hold MORE than the cap active at once. This is allowed while they are in use: an active slot must never
	// be taken from its holder.
	const burst = MaxLeaseSlots + 500
	held := make([]*leaseSlot, 0, burst)
	for i := 0; i < burst; i++ {
		id := NewTransportIdentity("fake", fmt.Sprintf("src_burst_%d", i), 1, fmt.Sprintf("obj-burst-%d", i))
		slot := resolver.acquireSlot(id)
		slot.mu.Unlock()
		held = append(held, slot)
	}
	if got := resolver.SlotCount(); got <= MaxLeaseSlots {
		t.Fatalf("the burst never exceeded the cap, so this proves nothing: %d slots", got)
	}

	// Drain. The table must return to its bound WITHOUT any new identity arriving to trigger a prune.
	for _, slot := range held {
		resolver.releaseSlot(slot)
	}
	if got := resolver.SlotCount(); got > MaxLeaseSlots {
		t.Fatalf("the table stayed oversized after the burst drained: %d slots, cap %d", got, MaxLeaseSlots)
	}
}

// And the same property under real concurrent traffic, as a smoke over the locking rather than the arithmetic.
func TestConcurrentIdentitiesResolveOncePerIdentity(t *testing.T) {
	server := newFake(t, fakeprovider.Options{LeaseTTL: time.Hour})
	adapter := newAdapter(t, server, nil)

	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 8; j++ {
				_, _ = adapter.Fetch(context.Background(), rangeRequest(0, 4096), make([]byte, 4096))
			}
		}()
	}
	wg.Wait()
	if got := server.Counters().Resolutions.Load(); got != 1 {
		t.Fatalf("192 concurrent reads of one identity resolved %d times", got)
	}
}
