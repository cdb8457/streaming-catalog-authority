package source

import (
	"net/url"
	"strings"
	"testing"
)

// The narrow production authority for a loopback resolver, and everything it must NOT authorise.
//
// WHY THIS AUTHORITY EXISTS. A provider adapter keeps its API key out of this daemon by running as a
// loopback-only resolver process beside it, reached at `http://127.0.0.1:PORT`. The only pre-existing way to
// dial that was AllowPrivateAddresses — a switch its own documentation calls test-only, and which also
// authorises every RFC1918 destination. Turning it on in production to reach a process on the same host
// would silently widen CDN egress across the operator's entire private network.
//
// WHY THE TESTS ARE SHAPED LIKE THIS. A permission is defined by what it refuses, so each case below is a
// destination the authority must still reject, asserted with the switch ON. A single test that only proved
// `127.0.0.1` becomes reachable would pass against an implementation that had simply re-enabled everything.

func loopbackCfg(resolverURL string) EndpointConfig {
	return EndpointConfig{
		ID:               "provider",
		ResolverURL:      resolverURL,
		AllowedOrigins:   []string{"http://127.0.0.1:8140", "https://cdn.example.com"},
		LoopbackResolver: true,
	}
}

func TestLiteralLoopbackResolverIsAcceptedWithoutWideningPrivateAddresses(t *testing.T) {
	policy, err := ValidateEndpoint(loopbackCfg("http://127.0.0.1:8140/resolve"))
	if err != nil {
		t.Fatalf("a loopback resolver endpoint was refused: %v", err)
	}
	// THE DATA POLICY MUST NOT HAVE GAINED THE PERMISSION. This is the whole point of the split: what the
	// daemon may do to reach its resolver is not what it may do with a URL a provider hands back.
	if policy.LiteralLoopbackResolver {
		t.Fatal("the data-plane policy carries the loopback authority; only the resolver's may")
	}
	if policy.AllowLoopback {
		t.Fatal("the loopback resolver authority turned on the test-only private-address switch")
	}
	resolverPolicy := ResolverPolicy(policy, loopbackCfg("http://127.0.0.1:8140/resolve"))
	if !resolverPolicy.LiteralLoopbackResolver {
		t.Fatal("the resolver policy did not gain the authority it was configured with")
	}
	if resolverPolicy.AllowLoopback {
		t.Fatal("the resolver policy must not gain the private-address permission")
	}
}

func TestLoopbackResolverDefaultsToRefusing(t *testing.T) {
	// FAIL CLOSED. An endpoint that says nothing about this gets the strict behaviour.
	cfg := loopbackCfg("http://127.0.0.1:8140/resolve")
	cfg.LoopbackResolver = false
	if _, err := ValidateEndpoint(cfg); err == nil {
		t.Fatal("a plaintext loopback resolver was accepted with no authority configured")
	}
}

func TestLoopbackResolverAuthorityDoesNotReachAnythingButLiteralLoopback(t *testing.T) {
	policy := ResolverPolicy(EgressPolicy{LiteralLoopbackResolver: true}, EndpointConfig{LoopbackResolver: true})

	// EVERY ONE OF THESE IS STILL REFUSED WITH THE SWITCH ON. The literal-loopback flag below is true only
	// where the HOST AS WRITTEN was a loopback literal; for these addresses it is false, which is exactly
	// the DNS-rebind case (`a name that resolved here`).
	for _, address := range []string{
		"10.0.0.5",        // RFC1918 — the widening this authority exists to avoid
		"172.16.4.9",      // RFC1918
		"192.168.1.10",    // RFC1918
		"169.254.169.254", // the cloud metadata service
		"fe80::1",         // link-local
		"0.0.0.0",         // unspecified
		"224.0.0.1",       // multicast
		"ff02::1",         // link-local multicast
	} {
		if failure := policy.checkIP(parseIP(t, address), false); failure == nil {
			t.Fatalf("%s was permitted by the loopback-resolver authority", address)
		}
	}

	// AND A NAME THAT MERELY RESOLVES TO LOOPBACK IS REFUSED. What a name resolves to is a DNS answer,
	// controlled by whoever runs the name, and it can differ between the check and the dial.
	for _, address := range []string{"127.0.0.1", "::1"} {
		if failure := policy.checkIP(parseIP(t, address), false); failure == nil {
			t.Fatalf("%s was permitted when the host was NOT written as a literal", address)
		}
		if failure := policy.checkIP(parseIP(t, address), true); failure != nil {
			t.Fatalf("%s was refused when the host WAS written as a literal: %s", address, failure.Detail)
		}
	}
}

func TestLoopbackAuthorityNeverAppliesToDirectBaseURL(t *testing.T) {
	// A directBaseUrl names the PROVIDER, which is never on this host, so a loopback one is a
	// misconfiguration rather than an architecture. It is checked under the strict policy.
	cfg := EndpointConfig{
		ID:               "provider",
		DirectBaseURL:    "http://127.0.0.1:8140/objects",
		AllowedOrigins:   []string{"http://127.0.0.1:8140"},
		LoopbackResolver: true,
	}
	if _, err := ValidateEndpoint(cfg); err == nil {
		t.Fatal("a loopback directBaseUrl was accepted under the resolver authority")
	}
}

func TestLoopbackAuthorityNeverAppliesToAResolvedCDNURL(t *testing.T) {
	// The URL a resolver hands back is checked against the STRICT policy, whatever the resolver was reached
	// over. A provider that answered with `http://127.0.0.1:9/x` is trying to make the daemon talk to
	// something on its own host.
	policy, err := ValidateEndpoint(loopbackCfg("http://127.0.0.1:8140/resolve"))
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	target, err := url.Parse("http://127.0.0.1:8140/handed-back")
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if failure := policy.CheckURL(target, false); failure == nil {
		t.Fatal("a resolved loopback URL was accepted under the data-plane policy")
	}
}

func TestLoopbackResolverStillObeysTheAllowlist(t *testing.T) {
	// THE AUTHORITY DECIDES ADDRESSES, NEVER MEMBERSHIP. An operator who has not named the resolver's origin
	// gets a refusal rather than an implicit exception — which is what the review found the real gate would
	// otherwise hit.
	cfg := loopbackCfg("http://127.0.0.1:9999/resolve")
	if _, err := ValidateEndpoint(cfg); err == nil {
		t.Fatal("a resolver origin absent from the allowlist was accepted")
	} else if !strings.Contains(err.Error(), "allowlist") {
		t.Fatalf("the refusal should name the allowlist, got %v", err)
	}
}

func TestLoopbackResolverDoesNotRelaxTLSForAnythingElse(t *testing.T) {
	policy := ResolverPolicy(
		EgressPolicy{
			Allowed:                 []Origin{{Scheme: "http", Host: "cdn.example.com", Port: "80"}},
			LiteralLoopbackResolver: true,
		},
		EndpointConfig{LoopbackResolver: true},
	)
	// Plaintext to a NAME is still refused without the explicit insecure opt-in, even with the authority on.
	target, err := url.Parse("http://cdn.example.com/x")
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if failure := policy.CheckURL(target, false); failure == nil {
		t.Fatal("plaintext to a named host was permitted by the loopback authority")
	}
}

func TestHostnameThatLooksLoopbackIsNotALiteral(t *testing.T) {
	// `localhost` is a NAME. It resolves to loopback on virtually every host, and that is precisely why it
	// must not be treated as a literal: the authority is defined on what cannot change, and a name can.
	for _, host := range []string{"localhost", "LOCALHOST", "resolver.internal", "127.0.0.1.nip.io"} {
		if isLiteralLoopbackHost(host) {
			t.Fatalf("%q was treated as a loopback literal", host)
		}
	}
	for _, host := range []string{"127.0.0.1", "127.1.2.3", "::1", "[::1]"} {
		if !isLiteralLoopbackHost(host) {
			t.Fatalf("%q was not recognised as a loopback literal", host)
		}
	}
	// And a public literal is not loopback.
	for _, host := range []string{"93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"} {
		if isLiteralLoopbackHost(host) {
			t.Fatalf("%q was treated as loopback", host)
		}
	}
}

func TestPrivateAddressSwitchStillMeansWhatItMeant(t *testing.T) {
	// A REGRESSION GUARD FOR THE OLD SWITCH. Splitting the new authority out must not have changed what
	// AllowPrivateAddresses does for the fixtures that rely on it.
	permissive := EgressPolicy{AllowLoopback: true}
	for _, address := range []string{"127.0.0.1", "10.0.0.5", "192.168.1.10"} {
		if failure := permissive.checkIP(parseIP(t, address), false); failure != nil {
			t.Fatalf("AllowLoopback no longer permits %s: %s", address, failure.Detail)
		}
	}
	for _, address := range []string{"169.254.169.254", "0.0.0.0", "224.0.0.1"} {
		if failure := permissive.checkIP(parseIP(t, address), false); failure == nil {
			t.Fatalf("AllowLoopback now permits %s, which it never did", address)
		}
	}
}
