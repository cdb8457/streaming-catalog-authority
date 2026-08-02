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
	MaxConnections        int  `json:"maxConnections,omitempty"`
	ResolutionDeadlineMs  int  `json:"resolutionDeadlineMs,omitempty"`
	RefreshCooldownMs     int  `json:"refreshCooldownMs,omitempty"`
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
	mu        sync.Mutex
	lastAdmit AdmitRecord
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
func (d *Daemon) SetMounted(mounted bool) { d.mounted.Store(mounted) }

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
	Ready               bool        `json:"ready"`
	Mounted             bool        `json:"mounted"`
	UptimeSeconds       int64       `json:"uptimeSeconds"`
	GenerationID        string      `json:"generationId,omitempty"`
	GenerationSequence  int64       `json:"generationSequence,omitempty"`
	Entries             int         `json:"entries"`
	TotalBytes          int64       `json:"totalBytes"`
	RetainedGenerations []string    `json:"retainedGenerations"`
	ProbeCacheBytes     int64       `json:"probeCacheBytes"`
	PlaybackCacheBytes  int64       `json:"playbackCacheBytes"`
	LastAdmission       AdmitRecord `json:"lastAdmission"`
}

func (d *Daemon) Status() Status {
	status := Status{
		Mounted:             d.mounted.Load(),
		UptimeSeconds:       int64(time.Since(d.startedAt).Seconds()),
		RetainedGenerations: d.Store.Retained(),
		ProbeCacheBytes:     d.Probe.TotalBytes(),
		PlaybackCacheBytes:  d.Playback.TotalBytes(),
		LastAdmission:       d.LastAdmit(),
	}
	if snap := d.Store.Current(); snap != nil {
		status.GenerationID = snap.GenerationID()
		status.GenerationSequence = snap.Sequence()
		status.Entries = snap.Tree.FileCount
		status.TotalBytes = snap.Tree.TotalBytes
		// Ready is "a generation is admitted AND it is actually being served".
		status.Ready = status.Mounted
	}
	if status.RetainedGenerations == nil {
		status.RetainedGenerations = []string{}
	}
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
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"alive": true, "uptimeSeconds": int64(time.Since(d.startedAt).Seconds()),
		})
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
		if !status.Ready {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		_ = json.NewEncoder(w).Encode(status)
	})
	return mux
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
