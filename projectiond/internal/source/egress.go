package source

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"
)

// Origin is a scheme, host and port together. The egress allowlist is a set of ORIGINS rather than a set of
// hostnames, because a hostname alone says nothing about the port — an allowlisted name on port 9000 is a
// different destination from the same name on 443, and only one of them was ever configured.
type Origin struct {
	Scheme string
	Host   string
	Port   string
}

func (o Origin) String() string { return o.Scheme + "://" + net.JoinHostPort(o.Host, o.Port) }

func defaultPort(scheme string) string {
	if scheme == "http" {
		return "80"
	}
	return "443"
}

// ParseOrigin accepts `https://host[:port]`, or a bare `host[:port]` which is taken as https.
func ParseOrigin(raw string) (Origin, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return Origin{}, errors.New("empty origin")
	}
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return Origin{}, err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return Origin{}, fmt.Errorf("unsupported scheme %q", parsed.Scheme)
	}
	if parsed.Hostname() == "" {
		return Origin{}, errors.New("origin without a host")
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return Origin{}, errors.New("an origin carries no path")
	}
	port := parsed.Port()
	if port == "" {
		port = defaultPort(parsed.Scheme)
	}
	return Origin{Scheme: parsed.Scheme, Host: strings.ToLower(parsed.Hostname()), Port: port}, nil
}

// OriginOf derives the origin of a URL the daemon is about to contact.
func OriginOf(target *url.URL) Origin {
	port := target.Port()
	if port == "" {
		port = defaultPort(target.Scheme)
	}
	return Origin{Scheme: target.Scheme, Host: strings.ToLower(target.Hostname()), Port: port}
}

// EgressPolicy is the endpoint's allowlist plus the address policy applied at dial time.
type EgressPolicy struct {
	Allowed []Origin
	// AllowLoopback exists for the in-process fake endpoint. It is a TEST authority: it permits loopback AND
	// RFC1918 private unicast, and production configuration leaves it off.
	AllowLoopback bool
	// LiteralLoopbackResolver is the PRODUCTION authority for one specific arrangement, and it is not the
	// same permission as AllowLoopback.
	//
	// WHY IT HAD TO EXIST SEPARATELY. A provider adapter can only hold its API key out of this daemon by
	// running as a loopback-only resolver process beside it, which the daemon reaches at
	// `http://127.0.0.1:PORT`. Reaching that requires dialling loopback. The only existing way to permit
	// that was AllowPrivateAddresses -- a switch whose own documentation calls it test-only and which also
	// authorises every RFC1918 destination. Turning it on in production to reach a resolver on the same host
	// would silently widen CDN egress across the operator's entire private network, which is the opposite of
	// what the arrangement is for.
	//
	// WHAT IT PERMITS, EXHAUSTIVELY: dialling a LITERAL 127.0.0.0/8 or ::1 address, on the client that talks
	// to the RESOLVER ENDPOINT ONLY. It does not permit RFC1918, link-local, the metadata address, the
	// unspecified address, multicast, or a DNS NAME THAT RESOLVES TO LOOPBACK -- that last one is a fact
	// about a DNS answer rather than about the URL, and it can change between the check and the dial. It is
	// never set on the policy the data plane uses, so no CDN URL and no directBaseUrl can reach loopback
	// however the provider answers.
	LiteralLoopbackResolver bool
}

func (p EgressPolicy) permits(o Origin) bool {
	for _, allowed := range p.Allowed {
		if allowed == o {
			return true
		}
	}
	return false
}

// CheckURL validates a URL against the allowlist before anything is dialled and before any credential is
// attached. A resolved URL is provider-supplied data: without this the provider would simply name the host
// it wanted contacted.
func (p EgressPolicy) CheckURL(target *url.URL, allowInsecureHTTP bool) *Failure {
	switch target.Scheme {
	case "https":
	case "http":
		// PLAINTEXT TO A LITERAL LOOPBACK ADDRESS IS THE ONE EXCEPTION, and only under the narrow production
		// authority. That connection never reaches a network interface, so the eavesdropper TLS defends
		// against has no wire to sit on; requiring a certificate authority for a socket nothing off-host can
		// address would buy nothing. Every other plaintext destination is still refused.
		if !allowInsecureHTTP && !(p.LiteralLoopbackResolver && isLiteralLoopbackHost(target.Hostname())) {
			return Fail(CondTLSVerifyFailed, ClassTerminal, "plaintext endpoint refused")
		}
	default:
		return Fail(CondAccessURLNotAllowed, ClassTerminal, "unsupported scheme")
	}
	if target.User != nil {
		return Fail(CondAccessURLNotAllowed, ClassTerminal, "userinfo in access URL")
	}
	if !p.permits(OriginOf(target)) {
		return Fail(CondAccessURLNotAllowed, ClassTerminal, "origin not in endpoint allowlist")
	}
	return nil
}

// isLiteralLoopbackHost is true only for an address literal that IS loopback.
//
// A NAME IS NOT AN ADDRESS, and that distinction is the whole safety of the narrow authority. `localhost`,
// `resolver.internal` and anything else that merely RESOLVES to 127.0.0.1 return false here: what they
// resolve to is a DNS answer, it is controlled by whoever runs the name, and it can differ between the check
// and the dial. Only a literal cannot change its mind.
func isLiteralLoopbackHost(host string) bool {
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

// DialContext is the second half of the defence, and it is the half an allowlist alone cannot provide.
//
// AN ALLOWLISTED NAME IS NOT AN ALLOWLISTED ADDRESS. DNS is controlled by whoever runs the name, so
// `cdn.example.com` can resolve to 169.254.169.254, to 127.0.0.1, or to anything on the operator's private
// network — and it can do so only on the second lookup, after a check against the name passed. Every address
// is therefore re-checked at dial time, immediately before the connection is made, on the resolved IPs.
func (p EgressPolicy) DialContext(base *net.Dialer) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, Fail(CondAccessURLNotAllowed, ClassTerminal, "unparseable address")
		}
		// Whether the HOST AS WRITTEN was a loopback literal is decided here, before any lookup, and carried
		// into the per-address check. Deciding it from the resolved address instead would authorise exactly
		// the DNS-rebind case the narrow authority exists to exclude.
		literalLoopback := isLiteralLoopbackHost(host)
		resolver := net.DefaultResolver
		addrs, err := resolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, Fail(CondSourceUnreachable, ClassRetryable, "name resolution failed")
		}
		var lastErr error
		for _, addr := range addrs {
			if failure := p.checkIP(addr.IP, literalLoopback); failure != nil {
				// One bad address poisons the whole name: a round-robin that sometimes points at localhost is
				// not a destination this daemon is willing to reach on any of its addresses.
				return nil, failure
			}
		}
		for _, addr := range addrs {
			conn, err := base.DialContext(ctx, network, net.JoinHostPort(addr.IP.String(), port))
			if err == nil {
				return conn, nil
			}
			lastErr = err
		}
		if lastErr == nil {
			lastErr = errors.New("no address")
		}
		return nil, lastErr
	}
}

// checkIP classifies a resolved address.
//
// THE OVERRIDE IS NARROW, AND DELIBERATELY SO. An earlier draft made AllowLoopback return nil before every
// classification, which meant enabling the in-process fake also authorised 169.254.169.254 — the cloud
// metadata service on every major provider — along with 0.0.0.0 and multicast. The switch is called
// AllowPrivateAddresses and it now permits exactly that: loopback and RFC1918 private unicast. Link-local,
// unspecified, multicast and anything else non-routable stay refused whatever it is set to, because no test
// fixture has ever needed them and a switch that quietly widens past its own name is how a test convenience
// becomes a server-side request forgery.
func (p EgressPolicy) checkIP(ip net.IP, literalLoopbackHost bool) *Failure {
	switch {
	case ip.IsUnspecified():
		return Fail(CondAccessURLNotAllowed, ClassTerminal, "resolved to an unspecified address")
	case ip.IsMulticast(), ip.IsInterfaceLocalMulticast(), ip.IsLinkLocalMulticast():
		return Fail(CondAccessURLNotAllowed, ClassTerminal, "resolved to a multicast address")
	case ip.IsLinkLocalUnicast():
		// 169.254.169.254 lives here. Never reachable, under any switch.
		return Fail(CondAccessURLNotAllowed, ClassTerminal, "resolved to a link-local address")
	case ip.IsLoopback():
		if p.AllowLoopback {
			return nil
		}
		// THE NARROW PRODUCTION AUTHORITY, and note that it requires BOTH conditions: the switch, and a host
		// that was written as a loopback literal. A name that resolved here is refused even with the switch
		// on, which is what stops the authority from becoming a DNS-rebind hole.
		if p.LiteralLoopbackResolver && literalLoopbackHost {
			return nil
		}
		return Fail(CondAccessURLNotAllowed, ClassTerminal, "resolved to a loopback address")
	case ip.IsPrivate():
		// DELIBERATELY NOT REACHED BY LiteralLoopbackResolver. Widening a loopback-resolver permission to
		// RFC1918 is the exact conflation this authority was split out to avoid.
		if p.AllowLoopback {
			return nil
		}
		return Fail(CondAccessURLNotAllowed, ClassTerminal, "resolved to a private address")
	}
	return nil
}

// TransportIdentity is what a lease belongs to.
//
// AN OBJECT REFERENCE IS NEVER PART OF A KEY IN CLEAR. It is digested, so a key can appear in a map, a metric
// or a test failure without carrying the reference itself.
type TransportIdentity struct {
	EndpointID       string
	SourceID         string
	SourceGeneration int64
	ObjectRefDigest  string
}

// NewTransportIdentity binds a lease to the exact source the handle pinned.
//
// KEYING ON sourceID ALONE WAS A DEFECT. A generation swap may carry the same source id forward with a bumped
// source generation and a different object reference; a lease cached under the bare id would then be handed
// to a handle reading a different object, and an old handle and a new one would fight over one slot.
func NewTransportIdentity(endpointID, sourceID string, sourceGeneration int64, objectRef string) TransportIdentity {
	sum := sha256.Sum256([]byte("projectiond.objectref.v1\n" + objectRef))
	return TransportIdentity{
		EndpointID:       endpointID,
		SourceID:         sourceID,
		SourceGeneration: sourceGeneration,
		ObjectRefDigest:  hex.EncodeToString(sum[:]),
	}
}

func (t TransportIdentity) Key() string {
	return t.EndpointID + "\x00" + t.SourceID + "\x00" +
		fmt.Sprintf("%d", t.SourceGeneration) + "\x00" + t.ObjectRefDigest
}

// ValidateEndpoint checks a whole endpoint configuration BEFORE any credential-bearing request is possible.
// A misconfigured allowlist that is only discovered when a token is already on the wire is a leak waiting to
// happen.
func ValidateEndpoint(cfg EndpointConfig) (EgressPolicy, error) {
	// The address policy comes from its OWN switch, never from the scheme switch.
	policy := EgressPolicy{AllowLoopback: cfg.AllowPrivateAddresses}
	if len(cfg.AllowedOrigins) == 0 {
		return policy, fmt.Errorf("endpoint %s has an empty egress allowlist", cfg.ID)
	}
	for _, raw := range cfg.AllowedOrigins {
		origin, err := ParseOrigin(raw)
		if err != nil {
			return policy, fmt.Errorf("endpoint %s has an unusable allowlist entry: %w", cfg.ID, err)
		}
		// A PLAINTEXT ALLOWLIST ENTRY IS REFUSED, with one narrow exception: a literal loopback origin under
		// the loopback-resolver authority. Without the exception an operator would have to set
		// allowInsecureHttp to name their own resolver -- and that switch relaxes plaintext for EVERY origin
		// on the list, including the CDN. Requiring the broad switch to express the narrow need is exactly
		// the conflation this authority was split out to remove.
		if origin.Scheme == "http" && !cfg.AllowInsecureHTTP {
			if !(cfg.LoopbackResolver && isLiteralLoopbackHost(origin.Host)) {
				return policy, fmt.Errorf("endpoint %s allowlists a plaintext origin without allowInsecureHttp", cfg.ID)
			}
		}
		policy.Allowed = append(policy.Allowed, origin)
	}
	if cfg.ResolverURL == "" && cfg.DirectBaseURL == "" {
		return policy, fmt.Errorf("endpoint %s has neither a resolver nor a direct base URL", cfg.ID)
	}
	// THE RESOLVER URL IS CHECKED UNDER THE RESOLVER POLICY, EVERYTHING ELSE UNDER THE DATA POLICY.
	//
	// The two differ in exactly one bit, and only the resolver's own URL is allowed to benefit from it. A
	// directBaseUrl names the PROVIDER, which is never on this host, so a loopback one is a
	// misconfiguration rather than an architecture -- it is checked strictly and stays refused.
	resolverPolicy := ResolverPolicy(policy, cfg)
	for _, entry := range []struct {
		raw    string
		policy EgressPolicy
	}{
		{cfg.ResolverURL, resolverPolicy},
		{cfg.DirectBaseURL, policy},
	} {
		if entry.raw == "" {
			continue
		}
		parsed, err := url.Parse(entry.raw)
		if err != nil {
			return policy, fmt.Errorf("endpoint %s has an unparseable URL", cfg.ID)
		}
		// The resolver's own URL is held to the same policy as anything it later hands back, save for the one
		// narrow loopback authority. It is the request that carries the long-lived credential, so it is the
		// last place to be lax.
		if failure := entry.policy.CheckURL(parsed, cfg.AllowInsecureHTTP); failure != nil {
			return policy, fmt.Errorf("endpoint %s: %s", cfg.ID, failure.Detail)
		}
	}
	if cfg.RefreshCooldown < 0 || cfg.ResolutionDeadline < 0 || cfg.RequestTimeout < 0 {
		return policy, fmt.Errorf("endpoint %s has a negative duration", cfg.ID)
	}
	return policy, nil
}

// ResolverPolicy is the data policy plus, where configured, the narrow literal-loopback authority.
//
// IT IS A SEPARATE VALUE ON PURPOSE. Handing the same policy to both clients is how a permission meant for
// one request reaches every other one; the resolver's client gets this, the data plane keeps the strict
// original, and neither can be mistaken for the other at a call site.
//
// THE ALLOWLIST IS UNCHANGED AND STILL APPLIES. This authority decides only whether a loopback ADDRESS may be
// dialled. The resolver's origin must still appear in AllowedOrigins like anything else, so an operator who
// has not named it gets a refusal rather than an implicit exception.
func ResolverPolicy(base EgressPolicy, cfg EndpointConfig) EgressPolicy {
	base.LiteralLoopbackResolver = cfg.LoopbackResolver
	return base
}

// DefaultDialer is the base dialer every endpoint's guarded dialer wraps.
func DefaultDialer() *net.Dialer {
	return &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
}

// parseIPForTest is not used by production code; the tests reach checkIP through it so the address policy can
// be asserted directly rather than through a live DNS answer.

// mustParseURL is used by the egress tests to build a target without repeating error handling.
