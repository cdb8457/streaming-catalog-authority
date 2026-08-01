// Package source is the data plane's read path: the two Phase 1 adapters, the access resolver that turns a
// stable reference into short-lived transport, and the bounds that stop either of them from becoming a
// denial-of-service against the provider or against the mount.
//
// THE ANTI-HANG CONTRACT IS THE HEADLINE. Every call here takes a context with an absolute deadline and
// returns by it. There is no unbounded wait, no unbounded goroutine and no unbounded body read. A hang is
// worse than an error: an error costs one file, a hang costs the library.
package source

import (
	"context"
	"errors"
	"syscall"
)

// Class decides what the read path does next with a failure.
type Class int

const (
	// ClassRetryable — the same request to the same source could plausibly work.
	ClassRetryable Class = iota
	// ClassAccessRefresh — re-resolve the STABLE reference into fresh access material, then retry once. For a
	// debrid or CDN-shaped source this is the normal end of a signed URL's life, not a failure.
	ClassAccessRefresh
	// ClassTerminal — fails the SOURCE for this read. It is not retried, because that is how one broken link
	// becomes a hundred provider requests.
	ClassTerminal
)

func (c Class) String() string {
	switch c {
	case ClassRetryable:
		return "retryable"
	case ClassAccessRefresh:
		return "access-refresh-then-retry"
	default:
		return "terminal"
	}
}

// Condition names mirror PROJECTIOND_ERROR_MAP exactly. They are the vocabulary the contract, the daemon and
// the tests all use, so a test can assert on the condition rather than on a message.
const (
	CondPathNotInGeneration = "path-not-in-generation"
	CondEntryDegraded       = "entry-degraded"
	CondSourceUnreachable   = "source-unreachable"
	CondSourceAuthRefused   = "source-auth-refused"
	CondSourceNotFound      = "source-not-found"
	CondAccessLeaseExpired  = "access-lease-expired"
	CondAccessResolveFailed = "access-resolution-failed"
	CondSourceRefUnknown    = "source-reference-unknown"
	CondAccessURLNotAllowed = "access-url-outside-endpoint-allowlist"
	CondRangeUnsupported    = "range-unsupported"
	CondRangeMismatch       = "range-mismatch"
	CondShortBody           = "short-body"
	CondSizeDisagrees       = "size-disagrees-with-manifest"
	CondReadDeadline        = "read-deadline-exceeded"
	CondAdmissionQueue      = "admission-queue-timeout"
	CondCircuitOpen         = "circuit-open"
	CondNoIdenticalFailover = "no-byte-identical-failover"
	CondMutationAttempted   = "mutation-attempted"
	CondRedirectRefused     = "redirect-refused"
	CondTLSVerifyFailed     = "tls-verification-failed"
)

// Failure is every error this package produces. It carries a condition rather than a message, so nothing a
// provider said can reach a log line or an errno.
type Failure struct {
	Cond  string
	Class Class
	// Detail is for tests and for the daemon's own structured status. It never contains a URL, a header, a
	// token, an object reference or anything a provider returned.
	Detail string
}

func (f *Failure) Error() string {
	if f.Detail == "" {
		return f.Cond
	}
	return f.Cond + ": " + f.Detail
}

// Errno maps a condition to what a media server actually sees.
//
// ENOENT MEANS ONE THING ONLY: the path is not in the admitted generation. A provider outage, an expired
// lease, an open circuit and an unreachable control plane are all EIO, because a media server treats ENOENT
// as "the file was deleted" and will remove the item on the strength of it. EIO it retries.
func (f *Failure) Errno() syscall.Errno {
	switch f.Cond {
	case CondPathNotInGeneration:
		return syscall.ENOENT
	case CondMutationAttempted:
		return syscall.EROFS
	default:
		return syscall.EIO
	}
}

func Fail(cond string, class Class, detail string) *Failure {
	return &Failure{Cond: cond, Class: class, Detail: detail}
}

// AsFailure recovers a *Failure from an error chain, or synthesises an EIO one. Nothing escapes this package
// as an unclassified error.
func AsFailure(err error) *Failure {
	if err == nil {
		return nil
	}
	var f *Failure
	if errors.As(err, &f) {
		return f
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return Fail(CondReadDeadline, ClassTerminal, "")
	}
	return Fail(CondSourceUnreachable, ClassRetryable, "")
}

// ReadRequest is one aligned, bounded read of one source of one entry. Everything in it comes from the
// admitted manifest; nothing in it comes from a provider.
//
// LENGTH IS ALREADY CLAMPED WHEN AN ADAPTER SEES IT. The read engine clamps the request and the destination
// buffer against the manifest size before dispatch, so an adapter never has to decide what a read past EOF
// means. It still returns the byte count it actually produced, so a partial answer is a SHORT READ rather
// than a buffer the caller assumes was filled — zero padding past EOF would be silent corruption.
type ReadRequest struct {
	EntryPath          string
	ProjectedVersionID string
	SourceID           string
	SourceGeneration   int64
	SizeBytes          int64
	Offset             int64
	Length             int64
	Locator            Locator
}

// Valid rejects a request the engine should never have built. An adapter that is handed one refuses rather
// than indexing a slice with it.
func (r ReadRequest) Valid(dst []byte) *Failure {
	switch {
	case r.Offset < 0 || r.Length < 0 || r.SizeBytes < 0:
		return Fail(CondRangeMismatch, ClassTerminal, "negative read geometry")
	case r.Offset+r.Length > r.SizeBytes:
		return Fail(CondRangeMismatch, ClassTerminal, "read past the manifest size")
	case int64(len(dst)) < r.Length:
		return Fail(CondRangeMismatch, ClassTerminal, "destination shorter than the request")
	}
	return nil
}

// Locator is the stable reference, copied out of the manifest. It has no lifetime.
type Locator struct {
	Kind         string
	RootID       string
	RelativePath string
	EndpointID   string
	ObjectRef    string
}

// Adapter is what a source kind implements.
//
// Fetch returns the number of bytes actually written into dst. A caller must use that count and must not
// assume dst[:req.Length] was filled: an adapter that produced fewer bytes has produced fewer bytes, and
// treating the remainder as zeroes would hand a player silent corruption.
type Adapter interface {
	Kind() string
	Fetch(ctx context.Context, req ReadRequest, dst []byte) (int, error)
	Close() error
}
