// Package fakewebdav is the deterministic, instrumented WebDAV endpoint the COMPARISON CONTROL measures.
//
// WHAT IT IS FOR, AND THE FIRST LINE MATTERS MOST. `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §5 G22 says:
// "The same corpus behind an rclone/WebDAV mount, measured the same way. This is EVIDENCE, NOT ARCHITECTURE:
// it exists to record what the naive approach costs. It has no pass threshold."
//
// `docs/ADR_002_PROJECTION_APPLIANCE.md` rejected rclone over WebDAV as production architecture and kept it
// as a TEST CONTROL, in those words. This package is that test control's server half, and nothing here is a
// component of the product. It is a gate tool in the same sense `internal/fakeprovider` and ./cmd/fakerange
// are: the production image builds only ./cmd/projectiond, and an offline suite refuses a build that changes
// that.
//
// WHY IT IS NOT `internal/fakeprovider` WITH ANOTHER HANDLER. That server speaks the product's own transport:
// a stable object reference, an access-resolution step, and ranged GETs against a resolved URL. WebDAV has
// none of those. Its namespace IS its URL space, there is no resolution step to count, listing is a PROPFIND
// rather than a manifest the control plane published, and a client is free to ask for a whole body. Folding
// the two into one server would have meant one set of counters whose names lied about half of what they
// counted — and the single most interesting number this control produces is the one the product's transport
// does not have: how much METADATA traffic a namespace costs when it is not published.
//
// IT COUNTS BYTES TWICE, AND THE DIFFERENCE BETWEEN THE TWO IS THE WHOLE REASON THIS COMMENT IS LONG.
//
//	COMMITTED bytes are what a response PROMISED: the Content-Length it set, derived from the object's own
//	  registered size and the range asked for. They are recorded BEFORE the first byte reaches the socket, so
//	  no client can observe a byte the counters have not described yet, and they are the number that is
//	  comparable with the product's own endpoint — which measures the same thing.
//
//	OBSERVED bytes are what `io.Copy` ACTUALLY WROTE, recorded after the write returns, together with whether
//	  it returned the whole committed length or stopped early.
//
// THEY ARE NOT THE SAME NUMBER AND AN EARLIER VERSION OF THIS FILE HAD ONLY THE FIRST, while calling it
// "served". A client that opens a large object, reads a header and closes the handle receives a small
// fraction of a large committed length — and on a corpus built around a ~105 MB fixture read by three media
// servers, that is not a corner case, it is the expected shape. Reporting the committed figure as what was
// served overstates delivery by exactly the amount the client abandoned, and any conclusion drawn from
// comparing it against a client's own accounting measures this endpoint's optimism rather than the topology.
//
// THE PARTITIONS A CALLER MUST CHECK BEFORE READING ANY OF IT:
//
//	RangedBodies + FullBodies + BodylessResponses    == AccountedResponses
//	RangedCommittedBytes + FullCommittedBytes        == CommittedBytes
//	RangedObservedBytes  + FullObservedBytes         == ObservedBytes
//	sum(ObjectCommittedBytes)                        == CommittedBytes
//	sum(ObjectObservedBytes)                         == ObservedBytes
//	sum(ObjectRanged)                                == RangedBodies
//	sum(ObjectFull)                                  == FullBodies
//	ObservedBytes                                    <= CommittedBytes,   always
//
// ...AND TWO MORE THAT HOLD ONLY ONCE EVERY BODY HAS FINISHED WRITING:
//
//	CompletedBodies + TruncatedBodies                == RangedBodies + FullBodies
//	BodiesInFlight                                   == 0
//
// A SNAPSHOT TAKEN WITH A BODY STILL IN FLIGHT CANNOT SUPPORT AN OBSERVED-BYTE FIGURE, because that body's
// committed length is already counted and its observed length is not yet. `BodiesInFlight` is published so a
// caller can WAIT for settlement rather than guess, and so a caller that did not wait is refused rather than
// answered.
//
// BOTH BYTE TOTALS ARE MEDIA BYTES AND NOTHING ELSE. A PROPFIND answer is XML this server authored; counting
// it in either total would put the instrument's own prose inside the number being compared. Metadata bytes
// are counted separately, in MetadataBytes, and reported beside them — which is the honest shape, because on
// this topology metadata traffic is a real cost rather than an accounting artefact.
//
// IT MUTATES NOTHING AND SERVES NOTHING BUT WHAT IT WAS GIVEN. Read-only: OPTIONS, PROPFIND, HEAD and GET.
// PUT, DELETE, MKCOL, MOVE, COPY, PROPPATCH and LOCK are answered 405 and counted as bodiless, so a client
// that tried to write is visible in the numbers rather than silently tolerated.
package fakewebdav

import (
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// DavPrefix is the URL prefix the WebDAV namespace lives under.
//
// IT IS A PREFIX RATHER THAN THE ROOT SO THE CONTROL SURFACES CANNOT BE MISTAKEN FOR CONTENT. `/counters` and
// `/control/*` are how a gate outside this process reads the instrument and drives the barrier; if the WebDAV
// tree were served from `/`, a client walking the namespace could reach them and the numbers would include
// the act of reading the numbers. Everything under DavPrefix is traffic; nothing outside it is.
const DavPrefix = "/dav"

// FixedModTime is the modification time every entry reports.
//
// DETERMINISM IS THE WHOLE POINT OF THIS CORPUS. A media server records mtime, and a comparison run whose
// mtimes moved between runs would produce library churn that belonged to the clock rather than to the
// topology under test. It is the same instant the manifest gates publish, so the two sides of the comparison
// describe files that differ in no observable respect.
const FixedModTime = "2026-06-01T10:00:00Z"

// Object is one file this server serves, and the ORDINAL it is registered at is the only handle the counters
// carry. Registration order is what makes a position a stable name across two snapshots without this server
// ever reporting a path in its telemetry.
type Object struct {
	// Path is the WebDAV path, WITHOUT DavPrefix and with a leading slash: "/Movies/Some Name/Some Name.mp4".
	Path string
	// Ref is the short, opaque handle the barrier control surface uses. It never appears in a listing.
	Ref string
	// Seed marks the one entry that is visible BEFORE the corpus is revealed. See Reveal.
	Seed bool
	Size int64
	// file is the on-disk source of the bytes, generated by the gate on the machine that runs it.
	file string
	// etag is derived from path and size, so two runs of the same corpus produce the same etag and a client
	// that caches on it behaves identically in both.
	etag string
}

// Counters are read by the gate. Every one is a number the comparison REPORTS; none of them is a threshold,
// because G22 has none. What they are held to instead is COHERENCE: the partitions above, and monotonicity
// across a window. A figure taken off a broken instrument is worse than no figure, since a comparison is
// exactly the kind of thing a reader trusts without re-deriving.
type Counters struct {
	// Requests counts ARRIVALS: every request that reaches the handler, before its outcome is known. It is
	// the wrong side of a partition identity and the right denominator for "how much did the client ask for".
	Requests atomic.Int64
	// AccountedResponses counts requests whose outcome has been RECORDED, incremented in the same critical
	// section as the class and the bytes, so the partition holds with any number of requests still in flight.
	AccountedResponses atomic.Int64

	// The method census. WebDAV's metadata traffic is the half of this comparison the product's own transport
	// has no equivalent of, so it is counted by method rather than lumped into "requests".
	Propfind       atomic.Int64
	PropfindDepth0 atomic.Int64
	PropfindDepth1 atomic.Int64
	PropfindOther  atomic.Int64
	Options        atomic.Int64
	Head           atomic.Int64
	Gets           atomic.Int64
	// WriteAttempts counts every mutating method. It must be zero: the mount is read-only and so is this
	// server, and a client that tried is a finding rather than a nuisance.
	WriteAttempts atomic.Int64

	// The body classes, which are a partition of AccountedResponses together with BodylessResponses.
	RangedBodies      atomic.Int64
	FullBodies        atomic.Int64
	BodylessResponses atomic.Int64

	// COMMITTED: the Content-Length each response promised, counted before its first byte reaches the socket.
	RangedCommittedBytes atomic.Int64
	FullCommittedBytes   atomic.Int64
	CommittedBytes       atomic.Int64

	// OBSERVED: what the write actually put on the socket, counted after it returned. See the package comment.
	RangedObservedBytes atomic.Int64
	FullObservedBytes   atomic.Int64
	ObservedBytes       atomic.Int64
	// CompletedBodies wrote their whole committed length with no error; TruncatedBodies did not — a client
	// that closed the handle early, a broken pipe, or a read error on the fixture. The two sum to the body
	// count only once nothing is still writing.
	CompletedBodies atomic.Int64
	TruncatedBodies atomic.Int64
	// BodiesInFlight is a live GAUGE: how many bodies are between "committed" and "observed" right now. It is
	// the only field that answers "may an observed-byte figure be read from this snapshot at all".
	BodiesInFlight atomic.Int64

	// MetadataBytes is XML this server authored: PROPFIND multistatus bodies. In NEITHER media total.
	MetadataBytes atomic.Int64

	// Served429 is never emitted by this server and is counted anyway, so "zero 429s observed" is a
	// measurement rather than a property of the code somebody has to go and read.
	Served429 atomic.Int64

	PeakConns         atomic.Int64
	CurrentConns      atomic.Int64
	PeakConcurrent    atomic.Int64
	CurrentConcurrent atomic.Int64

	// The barrier. HeldRequests is a lifetime count, CurrentHeldWaiters the live gauge, HoldTimeouts the
	// number of holds that LAPSED rather than being released — which is how a gate detects that its rendezvous
	// degraded a read instead of pausing one.
	HeldRequests       atomic.Int64
	CurrentHeldWaiters atomic.Int64
	HoldTimeouts       atomic.Int64
}

// Options configures the server. Every field a gate needs to make its numbers derivable is here rather than
// defaulted silently.
type Options struct {
	Addr string
	// BearerToken, when non-empty, must be presented on every WebDAV request.
	//
	// A NAIVE MOUNT STILL AUTHENTICATES, and the comparison would be dishonest without it: an unauthenticated
	// endpoint is not what an operator points rclone at, and the one thing this topology genuinely has to be
	// held to is that the credential does not end up somewhere a media server can read it. The gate mints a
	// high-entropy value per run and then searches for that exact string.
	BearerToken string
	// MaxHold bounds how long Hold may block one request, so a gate that died between arm and release
	// degrades into a slow read rather than a wedged mount. Zero means 15s.
	MaxHold time.Duration
}

type Server struct {
	listener net.Listener
	server   *http.Server
	counters Counters

	mu       sync.Mutex
	objects  []*Object
	byPath   map[string]*Object
	byRef    map[string]*Object
	dirs     map[string]bool
	holds    map[string]chan struct{}
	revealed bool

	// accounting covers the response-classification set: the body classes, both byte totals, BodylessResponses,
	// AccountedResponses and the per-object columns. Nothing else, and Snapshot says so.
	accounting      sync.Mutex
	objectCommitted []*atomic.Int64
	objectObserved  []*atomic.Int64
	objectGets      []*atomic.Int64
	objectRange     []*atomic.Int64
	objectFull      []*atomic.Int64

	maxHold time.Duration
	token   string
}

// New starts the server. It listens immediately, so a caller that gets no error has a reachable endpoint.
func New(opts Options) (*Server, error) {
	addr := opts.Addr
	if addr == "" {
		addr = "127.0.0.1:0"
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	s := &Server{
		listener: listener,
		byPath:   map[string]*Object{},
		byRef:    map[string]*Object{},
		dirs:     map[string]bool{"/": true},
		holds:    map[string]chan struct{}{},
		maxHold:  opts.MaxHold,
		token:    opts.BearerToken,
	}
	if s.maxHold == 0 {
		s.maxHold = 15 * time.Second
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/counters", s.handleCounters)
	mux.HandleFunc("/control/hold/", func(w http.ResponseWriter, r *http.Request) {
		s.Hold(strings.TrimPrefix(r.URL.Path, "/control/hold/"))
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/control/release/", func(w http.ResponseWriter, r *http.Request) {
		s.Release(strings.TrimPrefix(r.URL.Path, "/control/release/"))
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/control/reveal", func(w http.ResponseWriter, r *http.Request) {
		s.Reveal()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc(DavPrefix+"/", s.handleDav)
	mux.HandleFunc(DavPrefix, s.handleDav)
	s.server = &http.Server{
		Handler: mux,
		// A HELD REQUEST MUST NOT BE KILLED BY THE SERVER'S OWN WRITE DEADLINE. The barrier blocks a response
		// before its first byte; a WriteTimeout shorter than MaxHold would abort it and the gate would be
		// measuring its own instrument. ReadHeaderTimeout still bounds a client that never finishes a request
		// line, which is the case a timeout is actually for here.
		ReadHeaderTimeout: 30 * time.Second,
		ConnState:         s.trackConn,
	}
	go func() { _ = s.server.Serve(listener) }()
	return s, nil
}

// WaitForSettlement blocks until no body is between its commit and its observation, or until the budget
// elapses. It answers whether settlement was reached, so a caller that ran out of budget can refuse to read
// an observed-byte figure rather than reading a half-written one.
//
// IT IS BOUNDED AND IT DOES NOT RETRY FOREVER. A gate that looped until the gauge happened to reach zero
// would hang on a client that never finished, and a hang is a worse failure than a refusal.
func (s *Server) WaitForSettlement(budget time.Duration) bool {
	deadline := time.Now().Add(budget)
	for {
		if s.counters.BodiesInFlight.Load() == 0 {
			return true
		}
		if !time.Now().Before(deadline) {
			return s.counters.BodiesInFlight.Load() == 0
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (s *Server) Close() error {
	_ = s.server.Close()
	return s.listener.Close()
}

func (s *Server) BaseURL() string { return "http://" + s.listener.Addr().String() }

// DavURL is what a client is pointed at.
func (s *Server) DavURL() string { return s.BaseURL() + DavPrefix }

func (s *Server) Counters() *Counters { return &s.counters }

// trackConn samples the connection count ON EVERY ACCEPT, which is the sampling point the acceptance plan's
// connection gate names. It counts every connection to this process, including a gate's own polls of the
// uncounted /counters surface — so a caller judging a client against it is judging the harness too, and the
// in-flight gauge below is the one that describes the client alone.
func (s *Server) trackConn(_ net.Conn, state http.ConnState) {
	switch state {
	case http.StateNew:
		current := s.counters.CurrentConns.Add(1)
		for {
			peak := s.counters.PeakConns.Load()
			if current <= peak || s.counters.PeakConns.CompareAndSwap(peak, current) {
				break
			}
		}
	case http.StateClosed, http.StateHijacked:
		s.counters.CurrentConns.Add(-1)
	}
}

// ---------------------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------------------

// AddFileObject registers one file. The ORDER of these calls is the ordinal order the counters report in, and
// a caller that registers a non-corpus object first can then split a window's bytes at a known boundary
// without this server ever reporting a path.
func (s *Server) AddFileObject(davPath, ref, file string, seed bool) (int64, error) {
	info, err := os.Stat(file)
	if err != nil {
		return 0, err
	}
	if info.IsDir() {
		return 0, errors.New("an object is a file, not a directory")
	}
	clean := normalise(davPath)
	if clean == "/" {
		return 0, errors.New("an object needs a path")
	}
	digest := etagOf(clean, info.Size())
	object := &Object{Path: clean, Ref: ref, Seed: seed, Size: info.Size(), file: file, etag: digest}

	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.byPath[clean]; exists {
		return 0, fmt.Errorf("%s is already registered", ref)
	}
	if _, exists := s.byRef[ref]; exists {
		return 0, fmt.Errorf("%s is already registered", ref)
	}
	s.objects = append(s.objects, object)
	s.byPath[clean] = object
	s.byRef[ref] = object
	for _, dir := range ancestors(clean) {
		s.dirs[dir] = true
	}
	s.accounting.Lock()
	s.objectCommitted = append(s.objectCommitted, &atomic.Int64{})
	s.objectObserved = append(s.objectObserved, &atomic.Int64{})
	s.objectGets = append(s.objectGets, &atomic.Int64{})
	s.objectRange = append(s.objectRange, &atomic.Int64{})
	s.objectFull = append(s.objectFull, &atomic.Int64{})
	s.accounting.Unlock()
	return info.Size(), nil
}

// Reveal makes the non-seed corpus visible.
//
// WHY A SERVER-SIDE REVEAL EXISTS AT ALL, STATED HERE RATHER THAN LEFT TO BE INFERRED. The comparison has to
// measure a COLD scan, and a media server begins scanning a library root the moment the library is created.
// The product's own gates get this for free — they publish a one-entry generation, create the libraries, and
// publish the corpus afterwards. This topology has no publish step, so the same shape is produced here: until
// Reveal, the namespace holds exactly the seed entry, and the concurrent scan is the first thing that has
// ever listed or read the corpus.
//
// IT IS AN INSTRUMENT AND NOT A FEATURE, AND IT DOES NOT FLATTER THE RESULT. Revealing files changes nothing
// about what listing and reading them then costs; it only decides WHEN. A client's own directory cache is
// its own business, and the gate invalidates it explicitly rather than pretending the reveal was seen.
func (s *Server) Reveal() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.revealed = true
}

func (s *Server) revealedNow() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.revealed
}

// Hold blocks every GET body for one object until Release, or until MaxHold lapses.
func (s *Server) Hold(ref string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.holds[ref]; !exists {
		s.holds[ref] = make(chan struct{})
	}
}

// Release lets any held request proceed. Releasing something not held is not an error.
func (s *Server) Release(ref string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ch, exists := s.holds[ref]; exists {
		close(ch)
		delete(s.holds, ref)
	}
}

// waitForHold blocks a request while its object is held, and counts the fact that it blocked. Three numbers,
// because a lifetime count cannot answer "was something blocked AT THIS INSTANT" and a live gauge cannot
// answer "did a hold lapse rather than being released".
func (s *Server) waitForHold(ref string) {
	s.mu.Lock()
	ch, held := s.holds[ref]
	s.mu.Unlock()
	if !held {
		return
	}
	s.counters.HeldRequests.Add(1)
	s.counters.CurrentHeldWaiters.Add(1)
	defer s.counters.CurrentHeldWaiters.Add(-1)
	timer := time.NewTimer(s.maxHold)
	defer timer.Stop()
	select {
	case <-ch:
	case <-timer.C:
		s.counters.HoldTimeouts.Add(1)
	}
}

// ---------------------------------------------------------------------------------------------------------
// The wire shape of the counters
// ---------------------------------------------------------------------------------------------------------

// CountersSnapshot is what /counters answers. It exists because a gate running this server in its own
// container cannot read atomics across a process boundary.
type CountersSnapshot struct {
	Requests           int64 `json:"requests"`
	AccountedResponses int64 `json:"accountedResponses"`

	Propfind       int64 `json:"propfind"`
	PropfindDepth0 int64 `json:"propfindDepth0"`
	PropfindDepth1 int64 `json:"propfindDepth1"`
	PropfindOther  int64 `json:"propfindOther"`
	Options        int64 `json:"options"`
	Head           int64 `json:"head"`
	Gets           int64 `json:"gets"`
	WriteAttempts  int64 `json:"writeAttempts"`

	RangedBodies      int64 `json:"rangedBodies"`
	FullBodies        int64 `json:"fullBodies"`
	BodylessResponses int64 `json:"bodylessResponses"`

	// COMMITTED — what the responses promised in their Content-Length. NOT what was delivered.
	RangedCommittedBytes int64 `json:"rangedCommittedBytes"`
	FullCommittedBytes   int64 `json:"fullCommittedBytes"`
	CommittedBytes       int64 `json:"committedBytes"`

	// OBSERVED — what the writes actually put on the socket. Readable only once BodiesInFlight is zero.
	RangedObservedBytes int64 `json:"rangedObservedBytes"`
	FullObservedBytes   int64 `json:"fullObservedBytes"`
	ObservedBytes       int64 `json:"observedBytes"`
	CompletedBodies     int64 `json:"completedBodies"`
	TruncatedBodies     int64 `json:"truncatedBodies"`
	// BodiesInFlight is a GAUGE, not a total. It is deliberately in the wire shape so a caller can wait for
	// settlement, and so a caller that read the snapshot too early can be refused rather than answered.
	BodiesInFlight int64 `json:"bodiesInFlight"`

	MetadataBytes int64 `json:"metadataBytes"`
	Served429     int64 `json:"served429"`

	PeakConns      int64 `json:"peakConns"`
	PeakConcurrent int64 `json:"peakConcurrent"`

	HeldRequests       int64 `json:"heldRequests"`
	CurrentHeldWaiters int64 `json:"currentHeldWaiters"`
	HoldTimeouts       int64 `json:"holdTimeouts"`

	// Revealed says whether the corpus was visible when this snapshot was taken. A cold-window claim that
	// could not tell "nothing was read" from "nothing was there to read" would be worthless.
	Revealed bool `json:"revealed"`

	// The per-object columns, in REGISTRATION ORDER and carrying no path, reference or timestamp. A caller
	// pairs them by index, which is why they are taken in one call under one lock: taken separately, an
	// object registered in between produces columns of different lengths and index i means two objects.
	ObjectSizes     []int64 `json:"objectSizes"`
	ObjectCommitted []int64 `json:"objectCommitted"`
	ObjectObserved  []int64 `json:"objectObserved"`
	ObjectGets      []int64 `json:"objectGets"`
	ObjectRanged    []int64 `json:"objectRanged"`
	ObjectFull      []int64 `json:"objectFull"`
}

func (s *Server) Snapshot() CountersSnapshot {
	s.accounting.Lock()
	defer s.accounting.Unlock()
	s.mu.Lock()
	sizes := make([]int64, len(s.objects))
	for index, object := range s.objects {
		sizes[index] = object.Size
	}
	revealed := s.revealed
	s.mu.Unlock()
	read := func(columns []*atomic.Int64) []int64 {
		out := make([]int64, len(columns))
		for index, cell := range columns {
			out[index] = cell.Load()
		}
		return out
	}
	return CountersSnapshot{
		Requests:             s.counters.Requests.Load(),
		AccountedResponses:   s.counters.AccountedResponses.Load(),
		Propfind:             s.counters.Propfind.Load(),
		PropfindDepth0:       s.counters.PropfindDepth0.Load(),
		PropfindDepth1:       s.counters.PropfindDepth1.Load(),
		PropfindOther:        s.counters.PropfindOther.Load(),
		Options:              s.counters.Options.Load(),
		Head:                 s.counters.Head.Load(),
		Gets:                 s.counters.Gets.Load(),
		WriteAttempts:        s.counters.WriteAttempts.Load(),
		RangedBodies:         s.counters.RangedBodies.Load(),
		FullBodies:           s.counters.FullBodies.Load(),
		BodylessResponses:    s.counters.BodylessResponses.Load(),
		RangedCommittedBytes: s.counters.RangedCommittedBytes.Load(),
		FullCommittedBytes:   s.counters.FullCommittedBytes.Load(),
		CommittedBytes:       s.counters.CommittedBytes.Load(),
		RangedObservedBytes:  s.counters.RangedObservedBytes.Load(),
		FullObservedBytes:    s.counters.FullObservedBytes.Load(),
		ObservedBytes:        s.counters.ObservedBytes.Load(),
		CompletedBodies:      s.counters.CompletedBodies.Load(),
		TruncatedBodies:      s.counters.TruncatedBodies.Load(),
		BodiesInFlight:       s.counters.BodiesInFlight.Load(),
		MetadataBytes:        s.counters.MetadataBytes.Load(),
		Served429:            s.counters.Served429.Load(),
		PeakConns:            s.counters.PeakConns.Load(),
		PeakConcurrent:       s.counters.PeakConcurrent.Load(),
		HeldRequests:         s.counters.HeldRequests.Load(),
		CurrentHeldWaiters:   s.counters.CurrentHeldWaiters.Load(),
		HoldTimeouts:         s.counters.HoldTimeouts.Load(),
		Revealed:             revealed,
		ObjectSizes:          sizes,
		ObjectCommitted:      read(s.objectCommitted),
		ObjectObserved:       read(s.objectObserved),
		ObjectGets:           read(s.objectGets),
		ObjectRanged:         read(s.objectRange),
		ObjectFull:           read(s.objectFull),
	}
}

// handleCounters is NOT counted as traffic. A surface that perturbed the numbers it reports would make every
// figure read a little larger every time somebody looked at it.
func (s *Server) handleCounters(w http.ResponseWriter, _ *http.Request) {
	encoded, err := json.Marshal(s.Snapshot())
	if err != nil {
		http.Error(w, "counters could not be encoded", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(encoded)
}

// ---------------------------------------------------------------------------------------------------------
// The WebDAV surface
// ---------------------------------------------------------------------------------------------------------

func (s *Server) handleDav(w http.ResponseWriter, r *http.Request) {
	s.counters.Requests.Add(1)
	current := s.counters.CurrentConcurrent.Add(1)
	for {
		peak := s.counters.PeakConcurrent.Load()
		if current <= peak || s.counters.PeakConcurrent.CompareAndSwap(peak, current) {
			break
		}
	}
	defer s.counters.CurrentConcurrent.Add(-1)

	// EVERY EXIT IS ACCOUNTED FOR, STRUCTURALLY RATHER THAN BY ENUMERATION. `classified` is set by whichever
	// branch recorded a body; anything else — a refusal, a 404, a method this server does not implement —
	// lands in BodylessResponses because nobody had to remember to add it there. The first draft of the
	// equivalent reconciliation in `internal/fakeprovider` listed the refusals by hand and was short by a
	// dozen paths while its own comment claimed to cover every request.
	classified := false
	defer func() {
		if !classified {
			s.accounting.Lock()
			s.counters.BodylessResponses.Add(1)
			s.counters.AccountedResponses.Add(1)
			s.accounting.Unlock()
		}
	}()

	if s.token != "" && r.Header.Get("Authorization") != "Bearer "+s.token {
		w.Header().Set("WWW-Authenticate", `Bearer realm="comparison-control"`)
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	switch r.Method {
	case http.MethodOptions:
		s.counters.Options.Add(1)
		w.Header().Set("DAV", "1, 2")
		w.Header().Set("Allow", "OPTIONS, GET, HEAD, PROPFIND")
		w.Header().Set("MS-Author-Via", "DAV")
		w.WriteHeader(http.StatusOK)
	case "PROPFIND":
		classified = s.servePropfind(w, r)
	case http.MethodHead:
		s.counters.Head.Add(1)
		s.serveHead(w, r)
	case http.MethodGet:
		s.counters.Gets.Add(1)
		classified = s.serveGet(w, r)
	default:
		// EVERY MUTATING METHOD, REFUSED AND COUNTED. The mount is read-only and so is this server; a client
		// that tried to write shows up as a number rather than as a line in a log nobody reads.
		s.counters.WriteAttempts.Add(1)
		w.Header().Set("Allow", "OPTIONS, GET, HEAD, PROPFIND")
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// visible answers whether a path exists RIGHT NOW: before the reveal, only the seed entry and the directories
// leading to it do.
func (s *Server) visible(path string) (*Object, bool, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if object, ok := s.byPath[path]; ok {
		if s.revealed || object.Seed {
			return object, false, true
		}
		return nil, false, false
	}
	if !s.dirs[path] {
		return nil, false, false
	}
	if s.revealed {
		return nil, true, true
	}
	// Before the reveal a directory exists only if the seed entry is inside it.
	for _, object := range s.objects {
		if !object.Seed {
			continue
		}
		if path == "/" || strings.HasPrefix(object.Path, path+"/") {
			return nil, true, true
		}
	}
	return nil, false, false
}

// childrenOf lists the immediate children of a directory, files and subdirectories alike, in a stable order.
// Stability matters: a listing whose order moved between two runs would make a client's traversal order — and
// therefore its request order — differ for reasons that have nothing to do with the topology.
func (s *Server) childrenOf(dir string) (files []*Object, dirs []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	prefix := dir
	if prefix != "/" {
		prefix += "/"
	}
	seen := map[string]bool{}
	for _, object := range s.objects {
		if !s.revealed && !object.Seed {
			continue
		}
		if !strings.HasPrefix(object.Path, prefix) {
			continue
		}
		rest := object.Path[len(prefix):]
		if slash := strings.Index(rest, "/"); slash >= 0 {
			child := prefix + rest[:slash]
			if !seen[child] {
				seen[child] = true
				dirs = append(dirs, child)
			}
			continue
		}
		files = append(files, object)
	}
	sort.Slice(files, func(a, b int) bool { return files[a].Path < files[b].Path })
	sort.Strings(dirs)
	return files, dirs
}

func (s *Server) servePropfind(w http.ResponseWriter, r *http.Request) bool {
	depth := strings.TrimSpace(r.Header.Get("Depth"))
	s.counters.Propfind.Add(1)
	switch depth {
	case "0":
		s.counters.PropfindDepth0.Add(1)
	case "1", "":
		// AN ABSENT DEPTH IS DEPTH 1, WHICH IS WHAT RFC 4918 §10.2 SAYS AND NOT WHAT A READER EXPECTS. It is
		// counted as depth 1 rather than as "other" so the census describes what the server did.
		s.counters.PropfindDepth1.Add(1)
	default:
		s.counters.PropfindOther.Add(1)
	}
	path := davPathOf(r.URL)
	object, isDir, ok := s.visible(path)
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return false
	}
	entries := []propfindEntry{}
	if isDir {
		entries = append(entries, dirEntry(path))
		if depth != "0" {
			files, dirs := s.childrenOf(path)
			for _, child := range dirs {
				entries = append(entries, dirEntry(child))
			}
			for _, file := range files {
				entries = append(entries, fileEntry(file))
			}
		}
	} else {
		entries = append(entries, fileEntry(object))
	}
	body := renderMultistatus(entries)
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusMultiStatus)
	written, _ := w.Write(body)
	// METADATA BYTES ARE THEIR OWN TOTAL. See the package comment: folding XML this server authored into
	// "provider bytes" would put the instrument's own prose inside the number being compared.
	s.counters.MetadataBytes.Add(int64(written))
	return false
}

func (s *Server) serveHead(w http.ResponseWriter, r *http.Request) {
	path := davPathOf(r.URL)
	object, isDir, ok := s.visible(path)
	if !ok || isDir {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Length", strconv.FormatInt(object.Size, 10))
	w.Header().Set("Content-Type", contentTypeOf(object.Path))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("ETag", object.etag)
	w.Header().Set("Last-Modified", httpDate())
	w.WriteHeader(http.StatusOK)
}

func (s *Server) serveGet(w http.ResponseWriter, r *http.Request) bool {
	path := davPathOf(r.URL)
	object, isDir, ok := s.visible(path)
	if !ok || isDir {
		w.WriteHeader(http.StatusNotFound)
		return false
	}
	// THE BARRIER BLOCKS BEFORE THE FIRST BYTE, which is the only place it can block without corrupting the
	// response it is holding.
	s.waitForHold(object.Ref)

	rangeHeader := r.Header.Get("Range")
	offset, length := int64(0), object.Size
	ranged := false
	if rangeHeader != "" {
		start, end, valid := parseRange(rangeHeader, object.Size)
		if !valid {
			w.Header().Set("Content-Range", "bytes */"+strconv.FormatInt(object.Size, 10))
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return false
		}
		offset, length, ranged = start, end-start+1, true
	}
	// THE BODY IS STREAMED, NOT BUFFERED, AND THAT IS A CORRECTNESS PROPERTY RATHER THAN A NICETY. The shared
	// corpus carries a ~105 MB fixture on purpose, and a naive client asks for it whole; three media servers
	// reading one mount can have several such responses in flight at once. An endpoint that read each one into
	// memory first would be the reason a run failed, and "the comparison ran out of memory" is not a fact
	// about the topology under test.
	handle, err := os.Open(object.file)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return false
	}
	defer func() { _ = handle.Close() }()

	w.Header().Set("Content-Type", contentTypeOf(object.Path))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("ETag", object.etag)
	w.Header().Set("Last-Modified", httpDate())
	w.Header().Set("Content-Length", strconv.FormatInt(length, 10))

	// PHASE ONE — COMMIT. The counters move BEFORE the body reaches the socket, deliberately: no client may
	// observe a byte the counters have not described yet. What is counted here is the length the response
	// COMMITS TO in its Content-Length, and the gauge that says this body has not finished writing.
	//
	// THE GAUGE IS INCREMENTED IN THE SAME CRITICAL SECTION AS THE COMMIT, and decremented in the same one as
	// the observation. That is what makes a snapshot coherent: it can never see a committed length whose body
	// is neither counted as in flight nor counted as observed.
	s.accounting.Lock()
	if ranged {
		s.counters.RangedBodies.Add(1)
		s.counters.RangedCommittedBytes.Add(length)
	} else {
		s.counters.FullBodies.Add(1)
		s.counters.FullCommittedBytes.Add(length)
	}
	s.counters.CommittedBytes.Add(length)
	s.counters.AccountedResponses.Add(1)
	s.counters.BodiesInFlight.Add(1)
	s.recordObjectCommittedLocked(object, length, ranged)
	s.accounting.Unlock()

	if ranged {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", offset, offset+length-1, object.Size))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.WriteHeader(http.StatusOK)
	}

	// PHASE TWO — OBSERVE. `io.Copy` returns how much it actually wrote and why it stopped, and BOTH are used.
	//
	// AN EARLIER VERSION DISCARDED BOTH — `_, _ = io.Copy(...)` — and the endpoint then reported the committed
	// length as though it had been delivered. A client that opens a large object, reads a header and closes
	// the handle receives a small fraction of a large committed length, and on this corpus that is the normal
	// case rather than a corner one. The lock is taken only here, for a few adds, and never across the write
	// itself: an endpoint that held its accounting lock for the length of a 105 MB transfer would freeze the
	// instrument that measures it.
	written, copyErr := io.Copy(w, io.NewSectionReader(handle, offset, length))
	if written < 0 {
		written = 0
	}
	s.accounting.Lock()
	if ranged {
		s.counters.RangedObservedBytes.Add(written)
	} else {
		s.counters.FullObservedBytes.Add(written)
	}
	s.counters.ObservedBytes.Add(written)
	if copyErr == nil && written == length {
		s.counters.CompletedBodies.Add(1)
	} else {
		// A SHORT WRITE AND AN ERRORED ONE ARE THE SAME FINDING and are not separated, because the endpoint
		// cannot tell an abandoned read from a broken pipe and would be guessing if it named one.
		s.counters.TruncatedBodies.Add(1)
	}
	s.recordObjectObservedLocked(object, written)
	s.counters.BodiesInFlight.Add(-1)
	s.accounting.Unlock()
	return true
}

// ordinalOf answers where an object sits in registration order, which is the only handle the per-object
// columns carry. It is looked up rather than cached on the object so the columns and the registry cannot
// disagree about an index.
func (s *Server) ordinalOf(object *Object) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	for index, candidate := range s.objects {
		if candidate == object {
			return index
		}
	}
	return -1
}

// recordObjectCommittedLocked attributes one body's COMMITTED length and its request class to its
// registration ordinal. The caller holds s.accounting.
func (s *Server) recordObjectCommittedLocked(object *Object, n int64, ranged bool) {
	ordinal := s.ordinalOf(object)
	if ordinal < 0 || ordinal >= len(s.objectCommitted) {
		return
	}
	s.objectCommitted[ordinal].Add(n)
	s.objectGets[ordinal].Add(1)
	if ranged {
		s.objectRange[ordinal].Add(1)
	} else {
		s.objectFull[ordinal].Add(1)
	}
}

// recordObjectObservedLocked attributes what was actually written for one body. The caller holds
// s.accounting. It is a SEPARATE call from the commit above, at a separate moment, because the two numbers
// are separated by however long the write took and by whether the client stayed to receive it.
func (s *Server) recordObjectObservedLocked(object *Object, n int64) {
	ordinal := s.ordinalOf(object)
	if ordinal < 0 || ordinal >= len(s.objectObserved) {
		return
	}
	s.objectObserved[ordinal].Add(n)
}

// ---------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------

type propfindEntry struct {
	path        string
	isDir       bool
	size        int64
	etag        string
	contentType string
}

func dirEntry(path string) propfindEntry { return propfindEntry{path: path, isDir: true} }

func fileEntry(object *Object) propfindEntry {
	return propfindEntry{
		path: object.Path, size: object.Size, etag: object.etag,
		contentType: contentTypeOf(object.Path),
	}
}

// renderMultistatus writes the 207 body. The href is the FULL, PERCENT-ENCODED request path including the
// prefix: this corpus's names carry spaces and parentheses on purpose, because a naive mount meeting them is
// exactly the kind of thing a comparison should find out about rather than design around.
func renderMultistatus(entries []propfindEntry) []byte {
	var out strings.Builder
	out.WriteString(`<?xml version="1.0" encoding="utf-8"?>` + "\n")
	out.WriteString(`<D:multistatus xmlns:D="DAV:">` + "\n")
	for _, entry := range entries {
		href := (&url.URL{Path: DavPrefix + entry.path}).EscapedPath()
		if entry.isDir && !strings.HasSuffix(href, "/") {
			href += "/"
		}
		out.WriteString("  <D:response>\n")
		out.WriteString("    <D:href>" + escapeXML(href) + "</D:href>\n")
		out.WriteString("    <D:propstat>\n      <D:prop>\n")
		out.WriteString("        <D:displayname>" + escapeXML(baseName(entry.path)) + "</D:displayname>\n")
		out.WriteString("        <D:getlastmodified>" + httpDate() + "</D:getlastmodified>\n")
		if entry.isDir {
			out.WriteString("        <D:resourcetype><D:collection/></D:resourcetype>\n")
			// Quota properties, so a client asking "how much room is there" gets an answer rather than an
			// error it then has to decide how to treat. The numbers are fixed and mean nothing.
			out.WriteString("        <D:quota-available-bytes>1099511627776</D:quota-available-bytes>\n")
			out.WriteString("        <D:quota-used-bytes>0</D:quota-used-bytes>\n")
		} else {
			out.WriteString("        <D:resourcetype/>\n")
			out.WriteString("        <D:getcontentlength>" + strconv.FormatInt(entry.size, 10) +
				"</D:getcontentlength>\n")
			out.WriteString("        <D:getcontenttype>" + escapeXML(entry.contentType) + "</D:getcontenttype>\n")
			out.WriteString("        <D:getetag>" + escapeXML(entry.etag) + "</D:getetag>\n")
		}
		out.WriteString("      </D:prop>\n      <D:status>HTTP/1.1 200 OK</D:status>\n")
		out.WriteString("    </D:propstat>\n  </D:response>\n")
	}
	out.WriteString("</D:multistatus>\n")
	return []byte(out.String())
}

func escapeXML(value string) string {
	var out strings.Builder
	_ = xml.EscapeText(&out, []byte(value))
	return out.String()
}

// davPathOf turns a request URL into a namespace path: prefix stripped, percent-decoding already done by the
// URL parser, trailing slash removed, and always leading-slashed.
func davPathOf(target *url.URL) string {
	path := target.Path
	if strings.HasPrefix(path, DavPrefix) {
		path = path[len(DavPrefix):]
	}
	return normalise(path)
}

func normalise(path string) string {
	if path == "" {
		return "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	for len(path) > 1 && strings.HasSuffix(path, "/") {
		path = path[:len(path)-1]
	}
	return path
}

func ancestors(path string) []string {
	out := []string{"/"}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	current := ""
	for index := 0; index < len(parts)-1; index++ {
		current += "/" + parts[index]
		out = append(out, current)
	}
	return out
}

func baseName(path string) string {
	if path == "/" {
		return "/"
	}
	if index := strings.LastIndex(path, "/"); index >= 0 {
		return path[index+1:]
	}
	return path
}

func contentTypeOf(path string) string {
	if strings.HasSuffix(strings.ToLower(path), ".mp4") {
		return "video/mp4"
	}
	return "application/octet-stream"
}

// httpDate is FixedModTime in the format RFC 7231 requires. It is constant, which is what a deterministic
// corpus needs: a media server records the modification time it was told.
func httpDate() string {
	parsed, err := time.Parse(time.RFC3339, FixedModTime)
	if err != nil {
		return "Mon, 01 Jun 2026 10:00:00 GMT"
	}
	return parsed.UTC().Format(http.TimeFormat)
}

func etagOf(path string, size int64) string {
	sum := 0
	for _, char := range path {
		sum = sum*31 + int(char)
	}
	raw := []byte(fmt.Sprintf("%08x%012x", uint32(sum), size))
	return `"` + hex.EncodeToString(raw)[:24] + `"`
}

// parseRange reads a single `bytes=a-b` range. Multi-range is deliberately unsupported and answered 416: a
// client that asked for one would be doing something no media server does, and silently serving the first
// part would hide it.
func parseRange(value string, size int64) (int64, int64, bool) {
	if !strings.HasPrefix(value, "bytes=") {
		return 0, 0, false
	}
	spec := strings.TrimPrefix(value, "bytes=")
	if strings.Contains(spec, ",") {
		return 0, 0, false
	}
	dash := strings.Index(spec, "-")
	if dash < 0 {
		return 0, 0, false
	}
	startText, endText := spec[:dash], spec[dash+1:]
	if startText == "" {
		suffix, err := strconv.ParseInt(endText, 10, 64)
		if err != nil || suffix <= 0 {
			return 0, 0, false
		}
		if suffix > size {
			suffix = size
		}
		return size - suffix, size - 1, true
	}
	start, err := strconv.ParseInt(startText, 10, 64)
	if err != nil || start < 0 || start >= size {
		return 0, 0, false
	}
	end := size - 1
	if endText != "" {
		parsed, parseErr := strconv.ParseInt(endText, 10, 64)
		if parseErr != nil || parsed < start {
			return 0, 0, false
		}
		if parsed < end {
			end = parsed
		}
	}
	return start, end, true
}
