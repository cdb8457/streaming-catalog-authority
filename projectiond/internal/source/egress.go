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
	// AllowLoopback exists for the in-process fake endpoint. It is the ONLY way a loopback, private or
	// link-local address is ever dialled, it is set from its own configuration switch rather than inferred
	// from anything else, and production configuration leaves it off.
	AllowLoopback bool
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
		if !allowInsecureHTTP {
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
		resolver := net.DefaultResolver
		addrs, err := resolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, Fail(CondSourceUnreachable, ClassRetryable, "name resolution failed")
		}
		var lastErr error
		for _, addr := range addrs {
			if failure := p.checkIP(addr.IP); failure != nil {
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

func (p EgressPolicy) checkIP(ip net.IP) *Failure {
	if p.AllowLoopback {
		return nil
	}
	switch {
	case ip.IsLoopback():
		return Fail(CondAccessURLNotAllowed, ClassTerminal, "resolved to a loopback address")
	case ip.IsPrivate():
		return Fail(CondAccessURLNotAllowed, ClassTerminal, "resolved to a private address")
	case ip.IsLinkLocalUnicast(), ip.IsLinkLocalMulticast():
		// 169.254.169.254 is the cloud metadata service on every major provider.
		return Fail(CondAccessURLNotAllowed, ClassTerminal, "resolved to a link-local address")
	case ip.IsUnspecified(), ip.IsMulticast(), ip.IsInterfaceLocalMulticast():
		return Fail(CondAccessURLNotAllowed, ClassTerminal, "resolved to a non-routable address")
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
		if origin.Scheme == "http" && !cfg.AllowInsecureHTTP {
			return policy, fmt.Errorf("endpoint %s allowlists a plaintext origin without allowInsecureHttp", cfg.ID)
		}
		policy.Allowed = append(policy.Allowed, origin)
	}
	if cfg.ResolverURL == "" && cfg.DirectBaseURL == "" {
		return policy, fmt.Errorf("endpoint %s has neither a resolver nor a direct base URL", cfg.ID)
	}
	for _, raw := range []string{cfg.ResolverURL, cfg.DirectBaseURL} {
		if raw == "" {
			continue
		}
		parsed, err := url.Parse(raw)
		if err != nil {
			return policy, fmt.Errorf("endpoint %s has an unparseable URL", cfg.ID)
		}
		// The resolver's own URL is held to the same policy as anything it later hands back. It is the one
		// request that carries the long-lived credential, so it is the last place to be lax.
		if failure := policy.CheckURL(parsed, cfg.AllowInsecureHTTP); failure != nil {
			return policy, fmt.Errorf("endpoint %s: %s", cfg.ID, failure.Detail)
		}
	}
	if cfg.RefreshCooldown < 0 || cfg.ResolutionDeadline < 0 || cfg.RequestTimeout < 0 {
		return policy, fmt.Errorf("endpoint %s has a negative duration", cfg.ID)
	}
	return policy, nil
}

// DefaultDialer is the base dialer every endpoint's guarded dialer wraps.
func DefaultDialer() *net.Dialer {
	return &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
}

// parseIPForTest is not used by production code; the tests reach checkIP through it so the address policy can
// be asserted directly rather than through a live DNS answer.

// mustParseURL is used by the egress tests to build a target without repeating error handling.
