// Package daemon wires the pieces together: configuration, the adapter router, the generation store, the
// read path and a status surface that contacts nothing.
package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/cache"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/manifest"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/namespace"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/readpath"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/source"
)

// EndpointConfigFile is the on-disk shape of one HTTP Range endpoint.
//
// A CREDENTIAL IS A PATH HERE, NEVER A VALUE. There is no field that holds a token, so a configuration file
// that leaked could not leak one.
type EndpointConfigFile struct {
	ID            string `json:"id"`
	ResolverURL   string `json:"resolverUrl,omitempty"`
	DirectBaseURL string `json:"directBaseUrl,omitempty"`
	// AllowedOrigins are scheme+host+port. A hostname alone is not enough: the same name on a different port
	// is a different destination, and only the configured one was ever intended.
	AllowedOrigins    []string `json:"allowedOrigins"`
	TokenFile         string   `json:"tokenFile,omitempty"`
	AllowInsecureHTTP bool     `json:"allowInsecureHttp,omitempty"`
	// AllowPrivateAddresses is a TEST-ONLY switch for the in-process fake endpoint. It is deliberately
	// separate from allowInsecureHttp: permitting a plaintext scheme must not also permit the daemon to dial
	// loopback, private or link-local addresses.
	AllowPrivateAddresses bool `json:"allowPrivateAddresses,omitempty"`
	// LoopbackResolver authorises the RESOLVER REQUEST ONLY to reach a literal 127.0.0.0/8 or ::1 address.
	// It is NOT allowPrivateAddresses: it does not reach RFC1918, link-local, the metadata address, a name
	// that resolves to loopback, a CDN URL or directBaseUrl. Default false.
	LoopbackResolver     bool `json:"loopbackResolver,omitempty"`
	MaxConnections       int  `json:"maxConnections,omitempty"`
	ResolutionDeadlineMs int  `json:"resolutionDeadlineMs,omitempty"`
	RefreshCooldownMs    int  `json:"refreshCooldownMs,omitempty"`
}

// Config is the daemon's whole configuration.
type Config struct {
	MountPoint string `json:"mountPoint"`
	// PointerPath names a small JSON file the control plane publishes by rename. It carries the generation
	// id, the sequence, the artifact's byte length and its digest. The artifact it names must live in the
	// same directory: an artifact path that escapes it is refused.
	PointerPath            string               `json:"pointerPath"`
	LocalRoots             map[string]string    `json:"localRoots,omitempty"`
	Endpoints              []EndpointConfigFile `json:"endpoints,omitempty"`
	ProbeCacheDir          string               `json:"probeCacheDir"`
	ProbeCacheMaxBytes     int64                `json:"probeCacheMaxBytes,omitempty"`
	ProbeCacheMaxItemBytes int64                `json:"probeCacheMaxItemBytes,omitempty"`
	PlaybackCacheMaxBytes  int64                `json:"playbackCacheMaxBytes,omitempty"`
	PlaybackPerHandleBytes int64                `json:"playbackPerHandleBytes,omitempty"`
	GlobalMaxInflight      int                  `json:"globalMaxInflight,omitempty"`
	PerEndpointMaxInflight int                  `json:"perEndpointMaxInflight,omitempty"`
	QueueWaitMs            int                  `json:"queueWaitMs,omitempty"`
	StatusAddr             string               `json:"statusAddr,omitempty"`
	ReadDeadlineMs         int                  `json:"readDeadlineMs,omitempty"`
}

// Pointer is the artifact pointer the control plane publishes atomically.
type Pointer struct {
	GenerationID   string `json:"generationId"`
	Sequence       int64  `json:"sequence"`
	ArtifactName   string `json:"artifactName"`
	ArtifactBytes  int64  `json:"artifactBytes"`
	ManifestDigest string `json:"manifestDigest"`
}

// Daemon is the running data plane.
type Daemon struct {
	cfg      Config
	Store    *namespace.Store
	Reader   *readpath.Reader
	Probe    *cache.ProbeCache
	Playback *cache.PlaybackCache

	local     source.Adapter
	endpoints map[string]*source.HTTPRangeAdapter
	limiter   *source.Limiter

	startedAt time.Time
	mounted   atomic.Bool
	// serveDeath is the record of the most recent FUSE serve-loop death, nil until the supervisor records
	// one. The daemon itself never guesses about the serve loop: main's supervisor is the only writer, and a
	// successful remount restores nil.
	serveDeath atomic.Pointer[serveDeathRecord]
	mu         sync.Mutex
	lastAdmit  AdmitRecord

	// mountObserver answers what is ACTUALLY at the mount point, or nil when nothing has been wired.
	//
	// IT IS INJECTED RATHER THAN IMPORTED, and that is not indirection for its own sake. The probe is
	// linux-only and this package is not; injecting it keeps `daemon` portable and — much more usefully —
	// lets the sampler below be driven deterministically by a test, including the states a real FUSE mount
	// can only be pushed into on a host with /dev/fuse.
	mountObserver func() string
	// underlayVerifier answers whether the mount point is in exactly the state that was fingerprinted before
	// this process mounted anything, or nil when nothing has been wired — which refuses. See
	// SetUnderlayVerifier for why it is a second injected function and not a second return value on the one
	// above.
	underlayVerifier func() (string, string)
	// mountSample is the last COMPLETED observation and when it was taken. /readyz answers from this and
	// never from a probe of its own; see the sampler for why that is the whole design.
	mountSample atomic.Pointer[mountObservation]
	// probeInFlight is single-flight, and it is a FLAG rather than a property of the sampler loop because
	// the loop alone does not provide it. Giving up WAITING for a probe does not stop the probe: the
	// goroutine stays parked in an uninterruptible statfs until the connection is torn down. A loop that
	// merely ran its samples one after another would therefore still start a fresh goroutine on every tick
	// against a wedged mount, which is precisely what single-flight is supposed to prevent — measured, by
	// the test that asserts it, before any of this reached a host.
	probeInFlight atomic.Bool

	// mountedFirstAt is when this process FIRST mounted, in unix nanoseconds, and it is never reset — not by
	// an unmount, and expressly not by a remount.
	//
	// THAT IT SURVIVES A REMOUNT IS THE WHOLE POINT. It anchors the bootstrap grace, and a grace anchored to
	// the LATEST mount would hand every recovery a fresh window in which readiness need not be observed at
	// all. That is precisely how both of this product's worst failures stayed invisible: each of them was a
	// daemon that had just remounted and believed itself well.
	mountedFirstAt atomic.Int64
	// lastServeDeathAt is when a serve-loop death was most recently RECORDED, in unix nanoseconds, and unlike
	// `serveDeath` it is never cleared. `ClearServeDeath` retires the current death; it does not make the
	// death un-happen, and two policy decisions below turn on whether one ever did.
	lastServeDeathAt atomic.Int64

	// recovery is Phase 6's bounded automatic recovery: the durable budget, the sustain window and the last
	// published decision. It has its own mutex because the readiness path must never wait on a ledger write.
	recovery recoveryState
}

// mountObservation is one completed sample: what was seen, when — and the two facts about the STREAM that
// one sample cannot carry on its own.
//
// WHY THE STREAM FACTS LIVE ON THE SAMPLE. Phase 5's readiness policy asks two questions a single
// observation cannot answer: how long the mount has been continuously live, and how long it is since it last
// was. Keeping them in the same immutable record under the same atomic pointer means the request path reads
// ONE consistent moment; three separate atomics could be read across a sampler write and produce a verdict
// that was never true of any instant.
type mountObservation struct {
	state string
	at    time.Time
	// liveSince is when the CURRENT uninterrupted run of live observations began, zero when this observation
	// is not live. It is what the recovery confirmation measures.
	liveSince time.Time
	// lastLiveAt is when the mount was most recently OBSERVED live, and it carries across non-live samples —
	// which is the point. It is what the fault hold measures, and it is deliberately not derivable from the
	// current sample: a `foreign` observation says nothing about when the mount was last well.
	lastLiveAt time.Time
	// runPrecededBy is when the mount was last observed live BEFORE the current run began, zero when there
	// was no earlier live observation. It is the width of the gap the current run is recovering from.
	//
	// IT IS WHAT MAKES THE RECOVERY CONFIRMATION HYSTERESIS RATHER THAN A BLANKET DELAY. A confirmation that
	// applied to every run would be the mirror of the flap the fault hold prevents: any transient long
	// enough to produce one non-live sample restarts the run, so an unconditional confirmation would take the
	// appliance out of service for a whole second at the TAIL of every transient the hold just protected the
	// front of. Measured, on the first real Tower run, by the arm that exists to catch precisely that.
	runPrecededBy time.Time
}

const (
	// MountStateLive is the probe's own word for a mount that is ours and answering.
	//
	// SPELLED HERE, ONCE, AND PHASE 5 IS WHY. Phase 4 deliberately spelled none of the probe's four states in
	// this package: the observation was reported and never judged, so there was nothing to compare against.
	// Phase 5 makes readiness depend on the observation, which means something must know which word means
	// healthy. One exported constant is the containment — `test/projection-operational-mount-health.ts` pins
	// it against `fusefs.ProbeResult.String()`'s own spelling through the contract module, so this cannot
	// become the second vocabulary Phase 4 was avoiding.
	MountStateLive = "live-projectiond"
	// MountStateTimeout means a probe was outstanding past the timeout and the sampler stopped waiting for
	// it. It is NEVER conflated with a negative result: "we could not look" and "we looked and it is not
	// live" are different facts with different first suspects.
	MountStateTimeout = "timeout"
	// MountStateUnchecked means no probe has completed yet, or no observer is wired at all.
	MountStateUnchecked = "unchecked"
)

// THE READINESS POLICY, AND EVERY NUMBER IN IT IS PREDECLARED.
//
// These are `PROJECTIOND_MOUNT_HEALTH` in `src/core/projection/runtime-contract.ts`, and
// `test/projection-operational-mount-health.ts` fails if this file and that one disagree. They are not
// flags, for the same reason the sampler's cadence is not one: an operator who could widen the fault hold
// could make a broken mount report ready indefinitely, and the whole value of the policy is that its bounds
// are a property of the product rather than of a deployment.
const (
	// MountSampleMaxAge is the oldest a sample may be while the daemon is healthy. DERIVED from the sampler's
	// interval and probe timeout, both of which live in `cmd/projectiond`.
	MountSampleMaxAge = 3000 * time.Millisecond
	// MountBootstrapGrace is how long after the FIRST mount an ABSENT observation does not make readiness
	// false. It never covers a definitively non-live one, and a serve-loop death forfeits it permanently.
	MountBootstrapGrace = 15000 * time.Millisecond
	// MountFaultHold is how long a fault must persist, measured from the last live observation, before it is
	// believed. DERIVED: two whole worst-case sampling windows.
	MountFaultHold = 6000 * time.Millisecond
	// MountRecoveryConfirm is how long the mount must be continuously observed live before readiness returns.
	// DERIVED: one sample interval, which is the shortest run that cannot consist of a single sample.
	MountRecoveryConfirm = 1000 * time.Millisecond
)

// The closed set of readiness reason codes, in the precedence order they are evaluated. A reader can switch
// on these; none of them carries a path, an origin, a provider reference or an OS error string.
const (
	ReadyReasonOK                     = "ok"
	ReadyReasonNoGeneration           = "no-generation-admitted"
	ReadyReasonNotMounted             = "not-mounted"
	ReadyReasonServeLoopDead          = "serve-loop-dead"
	ReadyReasonMountNotLive           = "mount-observed-not-live"
	ReadyReasonObservationStale       = "mount-observation-stale"
	ReadyReasonObservationUnavailable = "mount-observation-unavailable"
	ReadyReasonMountRecovering        = "mount-recovering"
)

// serveDeathRecord is the immutable record of one serve-loop death: why the loop exited and when the death
// was observed. The pointer is nil while no death is current, which is also what a successful remount
// restores.
type serveDeathRecord struct {
	err error
	at  time.Time
}

// AdmitRecord is what the status surface reports about the most recent admission attempt.
//
// IT IS REDACTION-SAFE BY CONSTRUCTION. Problem CODES, counts and a generation number. Never a path, never a
// locator, never anything a provider said — this document is meant to be pasteable into an issue.
type AdmitRecord struct {
	At        time.Time `json:"at"`
	Accepted  bool      `json:"accepted"`
	Unchanged bool      `json:"unchanged,omitempty"`
	Sequence  int64     `json:"sequence,omitempty"`
	Problems  []string  `json:"problems,omitempty"`
	Additions int       `json:"additions,omitempty"`
	Deletions int       `json:"deletions,omitempty"`
	// Refusal is a closed-set reason code, not an OS error string.
	Refusal string `json:"refusal,omitempty"`
}

// Closed-set refusal reasons. A reader can switch on these; none of them carries a path.
const (
	RefusalPointerUnreadable  = "pointer-unreadable"
	RefusalPointerMalformed   = "pointer-malformed"
	RefusalArtifactUnreadable = "artifact-unreadable"
	RefusalArtifactEscapes    = "artifact-path-escapes-manifest-directory"
	RefusalArtifactLength     = "artifact-length-disagrees-with-pointer"
	RefusalArtifactTooLarge   = "artifact-exceeds-bound"
	RefusalDigestMismatch     = "artifact-digest-mismatch"
	RefusalGenerationMismatch = "pointer-generation-mismatch"
	RefusalGenerationReused   = "generation-reused-with-different-bytes"
)

func New(cfg Config) (*Daemon, error) {
	if err := applyDefaults(&cfg); err != nil {
		return nil, err
	}

	probe, err := cache.NewProbeCache(cfg.ProbeCacheDir, cfg.ProbeCacheMaxBytes, cfg.ProbeCacheMaxItemBytes)
	if err != nil {
		return nil, err
	}
	playback := cache.NewPlaybackCache(cfg.PlaybackCacheMaxBytes, cfg.PlaybackPerHandleBytes)

	d := &Daemon{
		cfg:       cfg,
		Store:     namespace.NewStore(),
		Probe:     probe,
		Playback:  playback,
		endpoints: map[string]*source.HTTPRangeAdapter{},
		limiter: source.NewLimiter(cfg.GlobalMaxInflight, cfg.PerEndpointMaxInflight,
			time.Duration(cfg.QueueWaitMs)*time.Millisecond),
		startedAt: time.Now(),
	}

	if len(cfg.LocalRoots) > 0 {
		local, err := newLocalAdapter(cfg.LocalRoots)
		if err != nil {
			return nil, err
		}
		d.local = local
	}
	for _, endpoint := range cfg.Endpoints {
		if endpoint.ID == "" {
			return nil, errors.New("endpoint without an id")
		}
		// Last-one-wins on a duplicate id would silently discard an endpoint the operator configured.
		if _, exists := d.endpoints[endpoint.ID]; exists {
			return nil, fmt.Errorf("endpoint id %q is configured more than once", endpoint.ID)
		}
		var secret *source.SecretFile
		if endpoint.TokenFile != "" {
			secret = source.NewSecretFile(endpoint.TokenFile)
		}
		breaker := source.NewBreaker(5, 30*time.Second, 60*time.Second, 1)
		adapter, err := source.NewHTTPRangeAdapter(source.EndpointConfig{
			ID:                    endpoint.ID,
			ResolverURL:           endpoint.ResolverURL,
			DirectBaseURL:         endpoint.DirectBaseURL,
			AllowedOrigins:        endpoint.AllowedOrigins,
			TokenFile:             endpoint.TokenFile,
			AllowInsecureHTTP:     endpoint.AllowInsecureHTTP,
			AllowPrivateAddresses: endpoint.AllowPrivateAddresses,
			LoopbackResolver:      endpoint.LoopbackResolver,
			MaxConnections:        endpoint.MaxConnections,
			ResolutionDeadline:    durationOr(endpoint.ResolutionDeadlineMs, 5*time.Second),
			RefreshCooldown:       durationOr(endpoint.RefreshCooldownMs, 30*time.Second),
			RequestTimeout:        time.Duration(cfg.ReadDeadlineMs) * time.Millisecond,
		}, secret, breaker, d.limiter)
		if err != nil {
			return nil, err
		}
		d.endpoints[endpoint.ID] = adapter
	}

	readCfg := readpath.DefaultConfig()
	readCfg.ReadDeadline = time.Duration(cfg.ReadDeadlineMs) * time.Millisecond
	reader, err := readpath.NewReader(readCfg, d, probe, playback)
	if err != nil {
		return nil, err
	}
	d.Reader = reader
	return d, nil
}

func durationOr(ms int, fallback time.Duration) time.Duration {
	if ms <= 0 {
		return fallback
	}
	return time.Duration(ms) * time.Millisecond
}

func applyDefaults(cfg *Config) error {
	if cfg.ProbeCacheMaxBytes == 0 {
		cfg.ProbeCacheMaxBytes = 2 * 1024 * 1024 * 1024
	}
	if cfg.ProbeCacheMaxItemBytes == 0 {
		cfg.ProbeCacheMaxItemBytes = 1024 * 1024
	}
	if cfg.PlaybackCacheMaxBytes == 0 {
		cfg.PlaybackCacheMaxBytes = 512 * 1024 * 1024
	}
	if cfg.PlaybackPerHandleBytes == 0 {
		cfg.PlaybackPerHandleBytes = 64 * 1024 * 1024
	}
	if cfg.GlobalMaxInflight == 0 {
		cfg.GlobalMaxInflight = 8
	}
	if cfg.PerEndpointMaxInflight == 0 {
		cfg.PerEndpointMaxInflight = 4
	}
	if cfg.QueueWaitMs == 0 {
		cfg.QueueWaitMs = 5000
	}
	if cfg.ReadDeadlineMs == 0 {
		cfg.ReadDeadlineMs = 20000
	}
	// THE CACHE DIRECTORY IS REQUIRED, not defaulted to a temp path. A probe cache under /tmp is cleared by
	// the next reboot and can be shared with another user on the host — so the persistence it exists to
	// provide would be a coin flip, and "the second scan is free" would be an unreliable claim.
	if cfg.ProbeCacheDir == "" {
		return errors.New("probeCacheDir is required: a durable directory is what makes the scan cache persistent")
	}
	if !filepath.IsAbs(cfg.ProbeCacheDir) {
		return errors.New("probeCacheDir must be an absolute path")
	}
	if cfg.PointerPath == "" {
		return errors.New("pointerPath is required")
	}
	if !filepath.IsAbs(cfg.PointerPath) {
		return errors.New("pointerPath must be an absolute path")
	}
	if cfg.StatusAddr != "" {
		if err := validateLoopbackAddr(cfg.StatusAddr); err != nil {
			return err
		}
	}
	return nil
}

// validateLoopbackAddr keeps the status surface off every interface but the local one. It reports counts and
// generation numbers, but it also reports whether an appliance is healthy, and that is nobody else's business.
func validateLoopbackAddr(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("statusAddr must be host:port: %w", err)
	}
	if host == "" {
		return errors.New("statusAddr must name a loopback address explicitly")
	}
	ip := net.ParseIP(host)
	if ip == nil {
		if strings.EqualFold(host, "localhost") {
			return nil
		}
		return errors.New("statusAddr must be a loopback IP literal or localhost")
	}
	if !ip.IsLoopback() {
		return errors.New("statusAddr must be a loopback address")
	}
	return nil
}

// AdapterFor implements readpath.Router.
func (d *Daemon) AdapterFor(locator source.Locator) (source.Adapter, error) {
	switch locator.Kind {
	case "local":
		if d.local == nil {
			return nil, source.Fail(source.CondSourceRefUnknown, source.ClassTerminal, "no local roots configured")
		}
		return d.local, nil
	case "http-range":
		adapter, ok := d.endpoints[locator.EndpointID]
		if !ok {
			return nil, source.Fail(source.CondSourceRefUnknown, source.ClassTerminal, "unknown endpoint")
		}
		return adapter, nil
	default:
		return nil, source.Fail(source.CondSourceRefUnknown, source.ClassTerminal, "unknown source kind")
	}
}

// Endpoint exposes an adapter for tests and for the status surface.
func (d *Daemon) Endpoint(id string) *source.HTTPRangeAdapter { return d.endpoints[id] }
func (d *Daemon) Limiter() *source.Limiter                    { return d.limiter }
func (d *Daemon) Config() Config                              { return d.cfg }

// SetMounted records that the namespace is actually being served. READY MEANS SERVING: a generation that
// parsed but was never mounted is not something a health check should call ready, because nothing can read it.
//
// IT ALSO STAMPS THE FIRST MOUNT, ONCE. That timestamp anchors the bootstrap grace and is never moved by a
// later mount — see `mountedFirstAt`.
func (d *Daemon) SetMounted(mounted bool) {
	d.mounted.Store(mounted)
	if mounted {
		d.mountedFirstAt.CompareAndSwap(0, time.Now().UnixNano())
	}
}

// SetMountObserver wires the thing that answers what is ACTUALLY at the mount point. Wiring is optional and
// its absence is reported as `unchecked` rather than as a negative result.
func (d *Daemon) SetMountObserver(observe func() string) { d.mountObserver = observe }

// SampleMount takes ONE observation, bounded, and stores it if it completed. It is exported so the sampler
// loop and a test drive exactly the same code path — a sampler whose only test is "the daemon started" is a
// sampler nobody has actually checked.
//
// WHY THE BOUND IS ON THE WAIT AND NOT ON THE PROBE. `syscall.Statfs` cannot be interrupted: a probe against
// a wedged connection returns when the connection is torn down and not before. So the timeout here bounds how
// long THIS function waits, and the abandoned goroutine ends when the syscall does. That is also why the
// caller must not run two at once — see MountSampleLoop.
//
// A PROBE THAT OVERRUNS DOES NOT OVERWRITE THE LAST GOOD SAMPLE. It records `timeout` only when there is
// nothing better to say, and otherwise leaves the previous observation in place TO AGE. A stale sample with
// an honest age is data; a fresh sample that says `timeout` when a probe is merely slow would erase the last
// thing actually known about the mount.
func (d *Daemon) SampleMount(timeout time.Duration) {
	observe := d.mountObserver
	if observe == nil {
		return
	}
	// SINGLE-FLIGHT, AND IT HAS TO BE CHECKED HERE. A probe abandoned by an earlier call is still running;
	// starting another would add one parked goroutine per call for as long as the mount stayed wedged.
	if !d.probeInFlight.CompareAndSwap(false, true) {
		d.noteProbeUnfinished()
		return
	}
	done := make(chan string, 1)
	go func() {
		// Released when the syscall finally returns, which for a wedged mount is when the connection is torn
		// down. Until then every later call takes the branch above.
		defer d.probeInFlight.Store(false)
		done <- observe()
	}()
	select {
	case state := <-done:
		d.storeObservation(state, time.Now())
	case <-time.After(timeout):
		d.noteProbeUnfinished()
	}
}

// storeObservation records one completed sample AND advances the two stream facts the readiness policy needs.
//
// THE SAMPLER IS THE ONLY WRITER, which is what makes this safe without a lock: it is called from
// `SampleMount`, and `SampleMount`'s single-flight flag means at most one probe is ever outstanding. The
// record it stores is immutable, so a reader on the request path sees one whole consistent moment.
func (d *Daemon) storeObservation(state string, at time.Time) {
	next := &mountObservation{state: state, at: at}
	previous := d.mountSample.Load()
	if state == MountStateLive {
		next.lastLiveAt = at
		// A RUN, NOT A SAMPLE. The run continues only if the previous observation was itself live; anything
		// else — a corpse, a stranger, a probe that overran — ends it and the confirmation starts again.
		//
		// ...AND A RUN MAY NOT SPAN A SERVE-LOOP DEATH, WHICH THE FIRST REAL RUN IS WHAT TAUGHT US. The
		// supervisor remounts in about a second, and the sampler probes once a second, so an abort and its
		// whole recovery can pass BETWEEN two samples: the run then continues unbroken across the death and
		// readiness comes straight back on an observation taken before the fault. That measured, on Tower, as
		// a "recovery" vouched for by a live run seventy-two seconds old that predated the abort entirely.
		// An observation from before a death cannot say anything about what is on the other side of it —
		// which is exactly the shape of Phase 2's worst defect, where the remount succeeded for the daemon
		// and for nobody else. So a recorded death ends the run, and the next live sample starts a new one.
		continues := previous != nil && !previous.liveSince.IsZero()
		if death := unixNanoTime(d.lastServeDeathAt.Load()); continues && !death.IsZero() {
			continues = previous.liveSince.After(death)
		}
		if continues {
			next.liveSince = previous.liveSince
			next.runPrecededBy = previous.runPrecededBy
		} else {
			next.liveSince = at
			if previous != nil {
				next.runPrecededBy = previous.lastLiveAt
			}
		}
	} else if previous != nil {
		// The mount is not live NOW, and when it last was is the thing the fault hold measures. Dropping it
		// here would restart that clock on every non-live sample, and a fault would never outlast the hold.
		next.lastLiveAt = previous.lastLiveAt
	}
	d.mountSample.Store(next)
}

// noteProbeUnfinished records that no observation completed this time.
//
// IT AGES THE LAST GOOD SAMPLE RATHER THAN REPLACING IT. Overwriting a real observation with `timeout`
// because one probe was slow would erase the last thing actually known about the mount; the age is what
// carries that news, and it carries it without throwing anything away. `timeout` is stored only when there
// has never been an observation at all, because then it is the most that can honestly be said — and it is
// still not the same word as a negative result.
func (d *Daemon) noteProbeUnfinished() {
	if d.mountSample.Load() == nil {
		d.mountSample.Store(&mountObservation{state: MountStateTimeout, at: time.Now()})
	}
}

// MountSampleLoop samples the mount point on its own cadence until the context is done.
//
// SINGLE-FLIGHT BY CONSTRUCTION: this loop is sequential, so a probe that blocks holds the loop rather than
// spawning a second one. That is what bounds a wedged mount to ONE stuck goroutine instead of one per
// interval for as long as it stays wedged, and it is why the sample ages instead of the endpoint hanging.
func (d *Daemon) MountSampleLoop(ctx context.Context, interval, timeout time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	d.SampleMount(timeout)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.SampleMount(timeout)
		}
	}
}

// RecordServeDeath tells the status surface that the FUSE serve loop died. The supervisor calls it when it
// observes the serve loop exit without an unmount request. It is what makes /readyz answer not-ready with a
// reason: "the process is alive but the namespace is gone" is exactly the failure mode this exists to make
// visible.
func (d *Daemon) RecordServeDeath(err error) {
	now := time.Now()
	d.serveDeath.Store(&serveDeathRecord{err: err, at: now})
	// ...AND IT IS REMEMBERED AFTER THE DEATH IS RETIRED. `ClearServeDeath` says "this one is over"; it does
	// not say it never happened. A daemon that has lost its namespace once forfeits the bootstrap grace and
	// the fault hold for good, because neither of those protects against a KNOWN death — they exist to stop a
	// sampling artefact being read as a fault, and a recorded serve-loop exit is not an artefact.
	d.lastServeDeathAt.Store(now.UnixNano())
}

// ClearServeDeath clears a recorded serve death after the supervisor has successfully remounted.
func (d *Daemon) ClearServeDeath() {
	d.serveDeath.Store(nil)
}

// readinessInputs is everything the readiness decision reads, gathered ONCE.
//
// IT IS A STRUCT RATHER THAN SIX ARGUMENTS SO THE DECISION IS A PURE FUNCTION OF A MOMENT. The daemon is a
// moving object; a decision that read `mounted`, then the sample, then the serve death would be a verdict
// about three different instants, and the one it reported would be an instant that never existed. It is also
// what lets `decideReadiness` be driven exhaustively by a table test with a fake clock, including states a
// real FUSE mount can only be pushed into on a host with /dev/fuse.
type readinessInputs struct {
	now           time.Time
	hasGeneration bool
	mounted       bool
	serveDead     bool
	sample        *mountObservation
	// mountedFirstAt anchors the bootstrap grace and is zero before the first mount.
	mountedFirstAt time.Time
	// lastServeDeathAt is the most recent RECORDED serve-loop death, zero if there has never been one. It is
	// not cleared by a recovery.
	lastServeDeathAt time.Time
}

// readinessVerdict is the decision, plus the two durations an operator needs to see why it was taken.
type readinessVerdict struct {
	ready bool
	// reason is one of the closed-set codes above, always set, including `ok`.
	reason string
	// liveRun is how long the mount has been continuously observed live, zero when it is not live now.
	liveRun time.Duration
	// sinceLive is how long since the mount was last observed live, measured from the first mount when it
	// never has been, and zero when it is live now.
	sinceLive time.Duration
	// inGrace reports whether the bootstrap grace is currently in force.
	inGrace bool
	// graceRemaining is how much of the bootstrap grace is left, zero once it is over or forfeited.
	graceRemaining time.Duration
}

// decideReadiness is the whole Phase 5 state machine, and the order of its clauses IS the predeclared reason
// precedence. Nothing here contacts anything, takes a probe, or blocks.
//
// WHY THE POLICY IS NOT "observed == live". The observation is a SAMPLE and a sample is late by construction:
// a probe runs on its own cadence, one that overruns leaves the previous sample to age, and a successful
// remount restores the mount up to a full interval before anything sees it. Wiring readiness straight to the
// latest sample would make a HEALTHY daemon flap — not-ready for a second whenever a probe was slow, and
// not-ready for a second after every recovery. So three bounded rules stand between the sample and the
// verdict, and each of them has a failure it exists to prevent:
//
//   - THE BOOTSTRAP GRACE covers "we have not been able to look yet" and nothing else. Without it a cold
//     start on a loaded host answers not-ready for a reason that is about the host.
//   - THE FAULT HOLD requires a fault to outlast two whole worst-case sampling windows. Without it one late
//     sample takes an appliance out of service.
//   - THE RECOVERY CONFIRMATION requires the mount to be live for a full interval — at least two distinct
//     observations. Without it one lucky sample puts a broken appliance back in service, which is the same
//     defect as the first, pointing the other way.
//
// AND NEITHER THE GRACE NOR THE HOLD SURVIVES A KNOWN DEATH. Both exist to stop a SAMPLING ARTEFACT being
// read as a fault. A serve-loop exit the supervisor observed is not an artefact — it is the fault — so once
// one has been recorded, a non-live observation is believed at once and the grace is gone for the life of the
// process.
func decideReadiness(in readinessInputs) readinessVerdict {
	verdict := readinessVerdict{reason: ReadyReasonOK}

	// The grace window, computed first because two clauses below consult it. It is bounded, it runs from the
	// FIRST mount, and a recorded serve death ends it permanently.
	if !in.mountedFirstAt.IsZero() && in.lastServeDeathAt.IsZero() {
		if elapsed := in.now.Sub(in.mountedFirstAt); elapsed < MountBootstrapGrace {
			verdict.inGrace = true
			verdict.graceRemaining = MountBootstrapGrace - elapsed
		}
	}

	var lastLive time.Time
	if in.sample != nil {
		lastLive = in.sample.lastLiveAt
	}
	// How long since the mount was last OBSERVED live. With no live observation ever, the clock runs from the
	// first mount — that is when looking became possible, and it is what bounds the bootstrap.
	origin := lastLive
	if origin.IsZero() {
		origin = in.mountedFirstAt
	}
	if !origin.IsZero() && in.now.After(origin) {
		verdict.sinceLive = in.now.Sub(origin)
	}
	// A fault is BELIEVED once it has outlasted the hold — or immediately, if a serve-loop death has been
	// recorded since the mount was last seen well.
	held := verdict.sinceLive > MountFaultHold ||
		(!in.lastServeDeathAt.IsZero() && in.lastServeDeathAt.After(lastLive))

	// ---- the precedence, in order. First match wins. ----

	// 1-3: the three pre-existing readiness rules, unchanged in meaning and still ahead of everything Phase 5
	// added. A daemon with nothing to serve, one whose serve loop the supervisor watched exit, and one that
	// never mounted are not mount-OBSERVATION questions, and reporting the lagging sample for any of them
	// would name a symptom and bury the cause.
	//
	// A SERVE DEATH OUTRANKS `not-mounted`, AND THAT ORDER WAS CORRECTED AFTER MEASUREMENT. Predeclared the
	// other way round, it made `serve-loop-dead` UNREPORTABLE: the supervisor runs `SetMounted(false)` and
	// THEN `RecordServeDeath`, and on recovery `ClearServeDeath()` and THEN `SetMounted(true)` — so `mounted`
	// is false for the whole window in which a death is recorded, and `not-mounted` would be the only thing
	// ever said. The first real Tower run measured exactly that. It is also the worse of the two answers: a
	// death is WHY the daemon is not mounted. The readiness BOOLEAN is identical either way.
	if !in.hasGeneration {
		verdict.reason = ReadyReasonNoGeneration
		return verdict
	}
	if in.serveDead {
		verdict.reason = ReadyReasonServeLoopDead
		return verdict
	}
	if !in.mounted {
		verdict.reason = ReadyReasonNotMounted
		return verdict
	}

	state := MountStateUnchecked
	age := time.Duration(0)
	if in.sample != nil {
		state = in.sample.state
		if age = in.now.Sub(in.sample.at); age < 0 {
			age = 0
		}
	}
	liveNow := in.sample != nil && state == MountStateLive && age <= MountSampleMaxAge

	if !liveNow {
		// 4-6: WHICH KIND of not-live, and each is believed only once `held`.
		switch {
		case in.sample == nil || state == MountStateTimeout || state == MountStateUnchecked:
			// "WE COULD NOT LOOK", which is the only branch the bootstrap grace covers. It is never conflated
			// with a negative result, and the grace is never extended to one.
			if verdict.inGrace {
				verdict.ready = true
				return verdict
			}
			verdict.reason = ReadyReasonObservationUnavailable
		case state != MountStateLive:
			// "WE LOOKED AND IT IS NOT LIVE" — a corpse, a stranger, or nothing at all. Definitive, and never
			// covered by the grace at any age of the process.
			verdict.reason = ReadyReasonMountNotLive
		default:
			// Live, but the verdict has stopped advancing. THIS IS THE WEDGED-MOUNT SIGNATURE: a probe that
			// cannot answer leaves the previous sample in place to age, so a mount nobody can read presents
			// as a stale opinion rather than as a negative one.
			verdict.reason = ReadyReasonObservationStale
		}
		if held {
			return verdict
		}
		// Inside the hold. The fault is real enough to name but not yet old enough to believe, so readiness
		// stands on the last live observation — which is the anti-flap, and the whole reason it exists.
		verdict.ready = true
		verdict.reason = ReadyReasonOK
		return verdict
	}

	// Live and fresh. 7: the recovery confirmation.
	verdict.sinceLive = 0
	if !in.sample.liveSince.IsZero() && in.now.After(in.sample.liveSince) {
		verdict.liveRun = in.now.Sub(in.sample.liveSince)
	}
	// IT IS HYSTERESIS, WHICH MEANS IT CONFIRMS ON THE WAY BACK ONLY IF IT ACTUALLY LEFT.
	//
	// Predeclared, this was unconditional, and that made it the mirror image of the flap the fault hold
	// exists to prevent: any transient long enough to produce one non-live sample restarts the run, so an
	// unconditional confirmation would take the appliance out of service for a whole second at the TAIL of
	// every transient whose front the hold had just protected. The first real Tower run measured it — a
	// two-second fault, readiness held throughout the fault and then dropped to 503 as the mount came back.
	//
	// So the confirmation applies only when the fault the current run is recovering FROM was one readiness
	// was actually withheld for: a gap wider than the hold, a recorded death inside it, or no earlier live
	// observation at all. Nothing else waits.
	gapBefore := time.Duration(0)
	if !in.sample.runPrecededBy.IsZero() && in.sample.liveSince.After(in.sample.runPrecededBy) {
		gapBefore = in.sample.liveSince.Sub(in.sample.runPrecededBy)
	}
	faultWasBelieved := in.sample.runPrecededBy.IsZero() || gapBefore > MountFaultHold ||
		(!in.lastServeDeathAt.IsZero() && in.lastServeDeathAt.After(in.sample.runPrecededBy))
	// The bootstrap grace waives it too, and there waiving prevents a flap rather than causing one: the grace
	// has already been answering ready, so requiring a confirmation as the first sample lands would take the
	// daemon out of service at the exact moment it first proved itself well.
	if faultWasBelieved && verdict.liveRun < MountRecoveryConfirm && !verdict.inGrace {
		verdict.reason = ReadyReasonMountRecovering
		return verdict
	}
	verdict.ready = true
	return verdict
}

// ServeError reports the reason the serve loop died, or nil while no death is recorded.
func (d *Daemon) ServeError() error {
	if record := d.serveDeath.Load(); record != nil {
		return record.err
	}
	return nil
}

// LoadPointer reads the pointer file and admits the artifact it names.
//
// A FAILED ADMISSION LEAVES THE LAST GOOD SNAPSHOT SERVING. Every early return here is a refusal that changes
// nothing a media server can see, which is the same thing that happens when the control plane is simply gone.
func (d *Daemon) LoadPointer() AdmitRecord {
	record := AdmitRecord{At: time.Now()}
	manifestDir := filepath.Dir(d.cfg.PointerPath)

	// The pointer and the artifact are both opened NO-FOLLOW and read THROUGH THE DESCRIPTOR THAT WAS
	// STATTED. An earlier draft statted a path and then read it again by name, so an artifact could be
	// swapped or grown in between and the length check would have been about a file that no longer existed.
	pointerRaw, err := readFileBounded(d.cfg.PointerPath, 64*1024)
	if err != nil {
		record.Refusal = RefusalPointerUnreadable
		d.setLastAdmit(record)
		return record
	}
	var pointer Pointer
	if err := strictDecode(pointerRaw, &pointer); err != nil {
		record.Refusal = RefusalPointerMalformed
		d.setLastAdmit(record)
		return record
	}
	if pointer.ArtifactBytes <= 0 || pointer.ArtifactName == "" {
		record.Refusal = RefusalPointerMalformed
		d.setLastAdmit(record)
		return record
	}
	// The artifact must be a plain name inside the manifest directory. No absolute path, no separator, no
	// `..`: a pointer is a message from the control plane, and a message must not be able to name a file
	// anywhere on the host.
	if pointer.ArtifactName != filepath.Base(pointer.ArtifactName) ||
		pointer.ArtifactName == "." || pointer.ArtifactName == ".." ||
		strings.ContainsAny(pointer.ArtifactName, `/\`) {
		record.Refusal = RefusalArtifactEscapes
		d.setLastAdmit(record)
		return record
	}
	if pointer.ArtifactBytes > manifest.MaxArtifactBytes {
		record.Refusal = RefusalArtifactTooLarge
		d.setLastAdmit(record)
		return record
	}

	artifactPath := filepath.Join(manifestDir, pointer.ArtifactName)
	artifact, err := readFileExact(artifactPath, pointer.ArtifactBytes)
	if err != nil {
		if errors.Is(err, errLengthDisagrees) {
			record.Refusal = RefusalArtifactLength
		} else {
			record.Refusal = RefusalArtifactUnreadable
		}
		d.setLastAdmit(record)
		return record
	}

	result := d.Store.Admit(artifact, namespace.PointerClaim{
		GenerationID: pointer.GenerationID,
		Sequence:     pointer.Sequence,
		Digest:       pointer.ManifestDigest,
	}, time.Now())

	switch {
	case result.Unchanged:
		// The steady state. Re-reading an unchanged pointer is what the poll loop does; it is not an event.
		record.Accepted = true
		record.Unchanged = true
		record.Sequence = result.Admitted.Sequence()
	case errors.Is(result.Err, namespace.ErrDigestMismatch):
		record.Refusal = RefusalDigestMismatch
	case errors.Is(result.Err, namespace.ErrGenerationMismatch):
		record.Refusal = RefusalGenerationMismatch
	case errors.Is(result.Err, namespace.ErrSameGenerationDifferentBytes):
		record.Refusal = RefusalGenerationReused
	case errors.Is(result.Err, namespace.ErrArtifactTooLarge):
		record.Refusal = RefusalArtifactTooLarge
	case result.Err != nil:
		record.Refusal = RefusalArtifactUnreadable
	case len(result.Problems) > 0:
		record.Problems = manifest.Codes(result.Problems)
	default:
		record.Accepted = true
		record.Sequence = result.Admitted.Sequence()
		record.Additions = len(result.Succession.Additions)
		record.Deletions = len(result.Succession.Deletions)
	}
	d.setLastAdmit(record)
	return record
}

var errLengthDisagrees = errors.New("length disagrees with the pointer")

// readFileBounded opens no-follow and reads at most `limit` bytes from the descriptor it statted.
func readFileBounded(path string, limit int64) ([]byte, error) {
	file, err := openNoFollow(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errors.New("not a bounded regular file")
	}
	return io.ReadAll(io.LimitReader(file, limit))
}

// readFileExact requires the file to be exactly the length the pointer claimed, measured on the same
// descriptor the bytes come from.
func readFileExact(path string, want int64) ([]byte, error) {
	file, err := openNoFollow(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("artifact is not a regular file")
	}
	if info.Size() != want {
		return nil, errLengthDisagrees
	}
	data := make([]byte, want)
	if _, err := io.ReadFull(file, data); err != nil {
		return nil, err
	}
	// Nothing may follow: a file that grew between the fstat and the read is not the file the pointer named.
	var extra [1]byte
	if n, _ := file.Read(extra[:]); n > 0 {
		return nil, errLengthDisagrees
	}
	return data, nil
}

// strictDecode refuses unknown fields and trailing content. A pointer with a second JSON document after it is
// a pointer somebody appended to.
func strictDecode(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		return errors.New("trailing content after the document")
	}
	return nil
}

func (d *Daemon) setLastAdmit(record AdmitRecord) {
	d.mu.Lock()
	d.lastAdmit = record
	d.mu.Unlock()
}

func (d *Daemon) LastAdmit() AdmitRecord {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.lastAdmit
}

// Status is the health/ready document.
//
// IT CONTACTS NOTHING. No provider request, no database query, no filesystem walk — it reads counters and the
// current snapshot pointer. That is deliberate: a health check that talks to a provider reports the
// provider's health, and an appliance whose readiness depends on a remote service is an appliance that goes
// unready during an outage it is designed to survive.
type Status struct {
	Ready               bool     `json:"ready"`
	Mounted             bool     `json:"mounted"`
	UptimeSeconds       int64    `json:"uptimeSeconds"`
	GenerationID        string   `json:"generationId,omitempty"`
	GenerationSequence  int64    `json:"generationSequence,omitempty"`
	Entries             int      `json:"entries"`
	TotalBytes          int64    `json:"totalBytes"`
	RetainedGenerations []string `json:"retainedGenerations"`
	ProbeCacheBytes     int64    `json:"probeCacheBytes"`
	PlaybackCacheBytes  int64    `json:"playbackCacheBytes"`
	// Playback is what the playback cache DID, alongside the level above.
	//
	// WHY A LEVEL WAS NOT ENOUGH. `playbackCacheBytes` says how much is resident now, which cannot answer
	// whether this daemon served a read. Since a handle release stops deleting entries, a window of playback
	// can legitimately reach the provider zero times — the bytes were already here — and "zero provider
	// requests" then has two very different explanations: the daemon served it from memory, or something
	// that is not the daemon served it. Only a cumulative hit count and hit volume tell those apart, and an
	// acceptance gate that cannot tell them apart is one that passes on a bypassed daemon.
	//
	// IT IS NOT THE DIAGNOSTIC. These are cumulative counters, of the kind this surface already carries; they
	// hold no per-request record, no offset, no handle and no identity, and they are always on.
	Playback      cache.PlaybackCounters `json:"playback"`
	LastAdmission AdmitRecord            `json:"lastAdmission"`
	// MountObserved is what was last SEEN at the mount point, as opposed to what this process remembers
	// doing to it. `mounted` above is a boolean set once when the daemon believed it had mounted; it is
	// never re-checked, and the two worst failures in this product's history both presented as a healthy
	// daemon because of it — a remount into a namespace with no host peer, and a cold corpse that refused
	// every remount, each with `ready` answering true while no consumer could read a byte.
	//
	// IT DOES NOT CHANGE `ready` OR `mounted`. Those keep exactly the meanings every closed gate was
	// measured against; this is reported beside them so an operator, a restart policy or a monitor can see
	// the difference. Folding it into `ready` is a behaviour change to an endpoint three closed phases were
	// measured against, and it is deliberately not made here.
	MountObserved string `json:"mountObserved"`
	// MountObservedAgeMs is how old that observation is. It is not decoration and the verdict is worthless
	// without it: a probe that cannot answer manifests as a sample that stops advancing, so the age IS the
	// signal for a wedged mount, and a reader that ignored it would treat a minutes-old `live` as current.
	MountObservedAgeMs int64 `json:"mountObservedAgeMs"`
	// ServeError is why the FUSE serve loop exited, present only after a serve-loop death. It answers "the
	// process is alive but the namespace is gone". Like the rest of this surface it is loopback-only.
	//
	// IT IS THE ONE FREE-TEXT FIELD ON THIS DOCUMENT AND PHASE 5 DID NOT ADD IT. Phase 5's own additions are
	// closed-set codes and numbers, deliberately; this predates them, is unchanged, and is named here so that
	// "the readiness reasons are closed-set" is not read as a claim about the whole document.
	ServeError string `json:"serveError,omitempty"`
	// LastServeDeathAt is when the most recent serve-loop death was observed, RFC3339 UTC.
	LastServeDeathAt string `json:"lastServeDeathAt,omitempty"`
	// ReadyReason is WHY `ready` says what it says, as one of a closed set of codes, and it is present in
	// every response including when the answer is `ok`.
	//
	// A BOOLEAN IS NOT AN OPERATIONAL ANSWER. Phase 5 makes `ready` false for six distinct reasons whose
	// first suspects are completely different — nothing admitted, never mounted, a serve loop the supervisor
	// watched exit, a stranger on the mount point, a probe that stopped answering, a recovery still being
	// confirmed. An operator handed only `false` has to go and read logs to tell those apart, which is
	// exactly the position this product's two worst failures left people in.
	//
	// IT CARRIES NO PATH, NO ORIGIN, NO PROVIDER REFERENCE AND NO OS STRING, by construction: it is one of a
	// fixed list of constants. This document is meant to be pasteable into an issue.
	ReadyReason string `json:"readyReason"`
	// MountLiveRunMs is how long the mount has been CONTINUOUSLY observed live, zero when it is not live now.
	// It is what the recovery confirmation is measured against, published so the wait is legible rather than
	// looking like the endpoint being slow to agree.
	MountLiveRunMs int64 `json:"mountLiveRunMs"`
	// MountSinceLiveMs is how long since the mount was last observed live, zero while it is live now. During
	// a fault it is the number the fault hold is compared against, so it says how much longer a fault has to
	// persist before it is believed — and after a fault it is how long the outage actually was.
	MountSinceLiveMs int64 `json:"mountSinceLiveMs"`
	// MountBootstrapGrace reports whether readiness is currently entitled to stand on an ABSENT observation.
	//
	// IT IS PUBLISHED BECAUSE IT IS THE ONE WINDOW IN WHICH `ready` CAN BE TRUE UNOBSERVED. An operator, a
	// monitor or a gate that wants to know whether a green answer rests on evidence or on a grace can read
	// it here instead of inferring it from uptime.
	MountBootstrapGrace bool `json:"mountBootstrapGrace"`
	// MountGraceRemainingMs is how much of that window is left, and zero once it is over or forfeited.
	MountGraceRemainingMs int64 `json:"mountGraceRemainingMs"`
	// The Phase 6 recovery surface, embedded so its six fields sit at the top level of the document beside
	// the readiness ones an operator is already reading.
	//
	// STRICTLY ADDITIVE, AND THAT IS ASSERTED RATHER THAN INTENDED. `ready`, `mounted`, `readyReason` and
	// every Phase 4 and Phase 5 field keep the exact meanings the closed gates were measured against; this
	// tranche adds fields beside them and moves none of them. `PROJECTIOND_MOUNT_RECOVERY.DOES_NOT_CHANGE`
	// is that as a pin.
	//
	// WHY RECOVERY IS ON THE READINESS DOCUMENT AND NOT A THIRD ENDPOINT. An operator looking at a 503 needs
	// three answers in one place: what is wrong (`readyReason`), what is actually at the mount
	// (`mountObserved`), and whether anything is being done about it (`recoveryState`). Splitting the third
	// one onto its own surface means the answer to "is this fixing itself?" is a second request whose reply
	// describes a different instant.
	RecoverySnapshot
}

// Liveness is the document `/healthz` answers, and its shape is the tranche's second half.
//
// IT ANSWERS ONE QUESTION: IS THIS PROCESS AND ITS STATUS SERVER ALIVE. Once `ready` can be false while the
// process is perfectly healthy — which is exactly what Phase 5 introduced — a supervisor keying on the only
// endpoint there is cannot tell "restart me" from "do not send me traffic yet", and restarting a daemon whose
// mount is merely being confirmed is how a transient becomes an outage.
//
// IT MAKES NO CLAIM ABOUT THE MOUNT, AND IT SAYS SO IN THE DOCUMENT. `claimsMountUsable` is a constant
// `false`. A nonclaim that has to be inferred from the ABSENCE of a field is one a later edit adds a field
// beside without noticing; one that is written down is one a reader and a test can both hold this surface to.
type Liveness struct {
	Alive         bool  `json:"alive"`
	UptimeSeconds int64 `json:"uptimeSeconds"`
	// Surface names what this document is, so a response cannot be mistaken for `/readyz`'s.
	Surface string `json:"surface"`
	// ClaimsMountUsable is always false. See above: it is the nonclaim, stated rather than implied.
	ClaimsMountUsable bool `json:"claimsMountUsable"`
}

func (d *Daemon) Status() Status {
	status := Status{
		Mounted:             d.mounted.Load(),
		UptimeSeconds:       int64(time.Since(d.startedAt).Seconds()),
		RetainedGenerations: d.Store.Retained(),
		ProbeCacheBytes:     d.Probe.TotalBytes(),
		PlaybackCacheBytes:  d.Playback.TotalBytes(),
		Playback:            d.Playback.Counters(),
		LastAdmission:       d.LastAdmit(),
	}
	snap := d.Store.Current()
	if snap != nil {
		status.GenerationID = snap.GenerationID()
		status.GenerationSequence = snap.Sequence()
		status.Entries = snap.Tree.FileCount
		status.TotalBytes = snap.Tree.TotalBytes
	}
	// THE OBSERVATION IS READ, NEVER TAKEN, HERE. This function runs on the /readyz request path, and the
	// probe behind the observer decides with statfs — which reaches the connection, and on a live mount is
	// answered by this daemon's own serve loop. Probing inline would block the health endpoint for exactly
	// as long as the thing it exists to report on is broken, and a hung /readyz is a worse answer than a
	// stale one because an orchestrator reads a timeout as "unknown" and a stale sample as data.
	//
	// PHASE 5 MADE THAT PROPERTY LOAD-BEARING RATHER THAN MERELY TIDY. Readiness now DEPENDS on this
	// observation, so an inline probe here would not just make the endpoint slow — it would make an appliance
	// with a wedged mount unable to report that it has one.
	sample := d.mountSample.Load()
	status.MountObserved = MountStateUnchecked
	if sample != nil {
		status.MountObserved = sample.state
		age := time.Since(sample.at).Milliseconds()
		if age < 0 {
			age = 0
		}
		status.MountObservedAgeMs = age
	}

	// ONE MOMENT, ONE VERDICT. Every input is taken here and the decision is a pure function of them, so the
	// document cannot report a readiness that was true of no instant.
	verdict := decideReadiness(readinessInputs{
		now:              time.Now(),
		hasGeneration:    snap != nil,
		mounted:          status.Mounted,
		serveDead:        d.serveDeath.Load() != nil,
		sample:           sample,
		mountedFirstAt:   unixNanoTime(d.mountedFirstAt.Load()),
		lastServeDeathAt: unixNanoTime(d.lastServeDeathAt.Load()),
	})
	status.Ready = verdict.ready
	status.ReadyReason = verdict.reason
	status.MountLiveRunMs = verdict.liveRun.Milliseconds()
	status.MountSinceLiveMs = verdict.sinceLive.Milliseconds()
	status.MountBootstrapGrace = verdict.inGrace
	status.MountGraceRemainingMs = verdict.graceRemaining.Milliseconds()
	if record := d.serveDeath.Load(); record != nil {
		if record.err != nil {
			status.ServeError = record.err.Error()
		} else {
			status.ServeError = "the serve loop exited without an error"
		}
		status.LastServeDeathAt = record.at.UTC().Format(time.RFC3339)
	}
	if status.RetainedGenerations == nil {
		status.RetainedGenerations = []string{}
	}
	// THE RECOVERY SNAPSHOT IS READ, NEVER DECIDED, HERE — the same rule the observation above follows. The
	// decision belongs to the recovery loop, which owns the sustain window and the durable budget; a status
	// request that took one would advance a clock that is supposed to be advanced by time.
	status.RecoverySnapshot = d.RecoveryStatus()
	return status
}

// ServeStatus runs the loopback status server. It exposes /healthz and /readyz and nothing else.
func (d *Daemon) ServeStatus(ctx context.Context) error {
	if d.cfg.StatusAddr == "" {
		return nil
	}
	mux := d.statusMux()
	return d.serveStatusMux(ctx, mux)
}

// statusMux builds the status routes. Separated from serving so the routes can be exercised without binding
// a port — a route whose only test is "the daemon started" is a route nobody has actually checked.
func (d *Daemon) statusMux() *http.ServeMux {
	mux := http.NewServeMux()
	// LIVENESS, AND IT IS NOT READINESS. It answers whether this process and its status server are alive and
	// nothing else — no mount field, no generation, no readiness. It never reads the mount observation, so it
	// cannot be made slow or false by a broken mount, which is the only property that makes it useful once
	// `/readyz` can legitimately answer 503 on a perfectly healthy process.
	//
	// LOOPBACK ONLY, ON THE ROUTE AND NOT ONLY ON THE BIND. The listener already refuses every interface but
	// the local one; judging the request as well means the guarantee survives somebody putting this mux behind
	// a different listener. A malformed or missing remote address reads as NOT loopback.
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if !requestIsLoopback(r) {
			http.NotFound(w, r)
			return
		}
		// READ-ONLY, AND ONLY A READ. A mistaken POST is a visible 405 rather than an apparent success.
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "the liveness surface is read-only", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(d.Liveness())
	})
	// THE CACHE DIAGNOSTIC, AND IT IS ABSENT UNLESS SOMEBODY TURNED IT ON.
	//
	// WHY IT IS REGISTERED CONDITIONALLY RATHER THAN ALWAYS ANSWERING "disabled". A route that exists in
	// every build is a route somebody can probe; one that is not registered cannot leak the fact that the
	// daemon has a diagnostic at all. Turning the diagnostic on is a deliberate act, and the surface appears
	// with it.
	//
	// LOOPBACK ONLY. Even enabled, it answers only a request that arrived from the local host. The events
	// carry no reference, URL, lease or byte content, but they do describe the daemon own block plan, and a
	// debugging surface has no business being reachable from anywhere else.
	if d.Playback != nil && d.Playback.DiagnosticEnabled() {
		mux.HandleFunc("/debug/cache-diagnostic", func(w http.ResponseWriter, r *http.Request) {
			if !requestIsLoopback(r) {
				http.NotFound(w, r)
				return
			}
			// READ-ONLY, AND ONLY A READ. Anything but GET is refused rather than quietly treated as one,
			// so a mistaken POST is a visible 405 instead of an apparently successful call.
			if r.Method != http.MethodGet {
				w.Header().Set("Allow", http.MethodGet)
				http.Error(w, "the cache diagnostic is read-only", http.StatusMethodNotAllowed)
				return
			}
			// ONE CAPTURE, NOT TWO. Asking for the events and then separately for the summary would return
			// a summary of a different moment under an active read — the torn-snapshot defect gate9 found,
			// which this file has no business reintroducing at the point it is reported.
			report := d.Playback.DiagnosticReport()
			w.Header().Set("Content-Type", "application/json")
			// NEVER CACHED. It is a point-in-time view of a moving recorder; a stored copy would be read
			// later as though it described then.
			w.Header().Set("Cache-Control", "no-store")
			_ = json.NewEncoder(w).Encode(report)
		})
	}
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		status := d.Status()
		w.Header().Set("Content-Type", "application/json")
		// NEVER CACHED. Readiness is a statement about now, and a stored copy would be read later as though
		// it described then — which is the whole class of mistake this tranche exists to remove.
		w.Header().Set("Cache-Control", "no-store")
		if !status.Ready {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		_ = json.NewEncoder(w).Encode(status)
	})
	return mux
}

// Liveness answers whether this process and its status server are alive. It reads a clock and two constants;
// it never touches the mount observation, the store or the serve loop.
func (d *Daemon) Liveness() Liveness {
	return Liveness{
		Alive:         true,
		UptimeSeconds: int64(time.Since(d.startedAt).Seconds()),
		Surface:       "liveness",
		// ALWAYS FALSE, AND IT IS A CONSTANT ON PURPOSE. It is the nonclaim written into the document so that
		// a reader never has to infer it and a later edit cannot quietly contradict it.
		ClaimsMountUsable: false,
	}
}

// unixNanoTime turns a stored nanosecond stamp back into a time, mapping the zero stamp to the zero time so
// "never happened" stays distinguishable from "happened at the epoch".
func unixNanoTime(nanos int64) time.Time {
	if nanos == 0 {
		return time.Time{}
	}
	return time.Unix(0, nanos)
}

// serveStatusMux runs the status server over routes that were built and can be tested separately.
func (d *Daemon) serveStatusMux(ctx context.Context, mux *http.ServeMux) error {
	server := &http.Server{
		Addr:              d.cfg.StatusAddr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// Close releases adapters and their connections.
func (d *Daemon) Close() error {
	if d.local != nil {
		_ = d.local.Close()
	}
	for _, endpoint := range d.endpoints {
		_ = endpoint.Close()
	}
	return nil
}

// LoadConfigFile reads a configuration file, refusing unknown fields and trailing content so a typo is a
// refusal rather than a silently ignored setting.
func LoadConfigFile(path string) (Config, error) {
	var cfg Config
	raw, err := readFileBounded(path, 1024*1024)
	if err != nil {
		return cfg, err
	}
	if err := strictDecode(raw, &cfg); err != nil {
		return cfg, err
	}
	return cfg, nil
}

func openNoFollow(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|osNoFollow, 0)
}

// requestIsLoopback reports whether a request arrived from the local host.
//
// THE DEBUGGING SURFACE IS FOR SOMEBODY SITTING ON THE MACHINE. It is judged on the transport's own remote
// address rather than on any header: X-Forwarded-For and friends are supplied by the caller, so trusting one
// would let a remote request declare itself local. A malformed or missing remote address is treated as NOT
// loopback, because the safe reading of "I cannot tell where this came from" is "not from here".
func requestIsLoopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if host == "" {
		return false
	}
	address := net.ParseIP(host)
	if address == nil {
		return false
	}
	return address.IsLoopback()
}
