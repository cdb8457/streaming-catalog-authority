package source

import (
	"context"
	"testing"
	"time"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/fakeprovider"
)

// REGRESSION: the address policy used to be derived from the HTTP scheme switch, so allowing plaintext to a
// public provider silently also authorised the daemon to dial 127.0.0.1 and 169.254.169.254. Those are
// unrelated authorities and they now have unrelated switches.
func TestInsecureHTTPDoesNotAuthorizePrivateAddresses(t *testing.T) {
	server := newFake(t, fakeprovider.Options{})
	adapter, err := NewHTTPRangeAdapter(EndpointConfig{
		ID: "fake", ResolverURL: server.ResolveURL(), AllowedOrigins: []string{server.BaseURL()},
		AllowInsecureHTTP: true, // the scheme is permitted...
		// ...but the address policy is NOT, and this endpoint happens to be on loopback.
		AllowPrivateAddresses: false,
		RequestTimeout:        3 * time.Second, RefreshCooldown: 30 * time.Second,
	}, nil, NewBreaker(5, 30*time.Second, 60*time.Second, 1), NewLimiter(8, 4, time.Second))
	if err != nil {
		t.Fatalf("the endpoint should be constructible; only the dial is refused: %v", err)
	}
	defer adapter.Close()

	if _, fetchErr := adapter.Fetch(context.Background(), rangeRequest(0, 4096), make([]byte, 4096)); fetchErr == nil {
		t.Fatal("a loopback destination must be refused when only the scheme switch is on")
	}
	if got := server.Counters().Resolutions.Load(); got != 0 {
		t.Fatalf("the resolver was contacted at a loopback address without the address switch: %d", got)
	}

	// And with the explicit test-only switch it works, which proves the refusal above was the address policy
	// rather than something else about this endpoint.
	permitted := newAdapter(t, server, nil)
	if _, err := permitted.Fetch(context.Background(), rangeRequest(0, 4096), make([]byte, 4096)); err != nil {
		t.Fatalf("the explicit private-address switch should permit the loopback fake: %v", err)
	}
}

func TestEgressPolicyIsNotDerivedFromTheSchemeSwitch(t *testing.T) {
	policy, err := ValidateEndpoint(EndpointConfig{
		ID: "e", DirectBaseURL: "http://example.test", AllowedOrigins: []string{"http://example.test"},
		AllowInsecureHTTP: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if policy.AllowLoopback {
		t.Fatal("the plaintext switch must not authorise loopback, private or link-local destinations")
	}

	permissive, err := ValidateEndpoint(EndpointConfig{
		ID: "e", DirectBaseURL: "http://example.test", AllowedOrigins: []string{"http://example.test"},
		AllowInsecureHTTP: true, AllowPrivateAddresses: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !permissive.AllowLoopback {
		t.Fatal("the explicit private-address switch must be what authorises them")
	}
}

// An origin is scheme, host AND port. The same name on another port is a different destination.
func TestAllowlistIsByOriginNotHostname(t *testing.T) {
	policy, err := ValidateEndpoint(EndpointConfig{
		ID: "e", DirectBaseURL: "https://cdn.example.test", AllowedOrigins: []string{"https://cdn.example.test"},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{
		"https://cdn.example.test:9000/x", // right name, wrong port
		"http://cdn.example.test/x",       // right name, wrong scheme
		"https://other.example.test/x",    // wrong name
		"https://user@cdn.example.test/x", // userinfo
	} {
		parsed := mustParseURL(t, target)
		if failure := policy.CheckURL(parsed, false); failure == nil {
			t.Fatalf("%s must be refused", target)
		}
	}
	if failure := policy.CheckURL(mustParseURL(t, "https://cdn.example.test/object/a"), false); failure != nil {
		t.Fatalf("the configured origin must be permitted: %v", failure)
	}
}
