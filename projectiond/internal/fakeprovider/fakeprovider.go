// Package fakeprovider is a deterministic HTTP Range endpoint with an access resolver, counters and fault
// injection. It is the only "provider" the automated gates ever contact.
//
// IT IS DETERMINISTIC ON PURPOSE. Object bytes are a pure function of the object reference and the offset, so
// a test can assert the exact bytes a read returned without shipping fixtures, and two runs of the same gate
// compare the same numbers. Every counter here is what the amplification budget is measured against.
package fakeprovider

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Fault is an injected misbehaviour, applied to one object.
type Fault string

const (
	FaultNone Fault = ""
	// FaultFullBodyOnRange answers a ranged request with 200 and the whole object. Accepting one is the most
	// expensive protocol failure available here.
	FaultFullBodyOnRange Fault = "full-body-on-range"
	FaultMalformedRange  Fault = "malformed-content-range"
	FaultMismatchedRange Fault = "mismatched-content-range"
	FaultShortBody       Fault = "short-body"
	FaultWrongTotalSize  Fault = "wrong-total-size"
	FaultLongBody        Fault = "long-body"
	Fault401             Fault = "status-401"
	Fault403             Fault = "status-403"
	Fault410             Fault = "status-410"
	Fault429             Fault = "status-429"
	Fault503             Fault = "status-503"
	FaultTimeout         Fault = "timeout"
	FaultRedirect        Fault = "redirect"
	FaultDisallowedHost  Fault = "disallowed-host"
	FaultResolverError   Fault = "resolver-error"
	// FaultDelayedClose serves the CORRECT bytes for the granted range, chunked, and then delays its terminal
	// chunk. A client that insists on reading to EOF before accepting the range stalls here for the whole
	// request timeout even though the server did nothing wrong.
	FaultDelayedClose Fault = "delayed-close"
)

// Object is one served byte stream.
type Object struct {
	Ref  string
	Size int64
}

// Counters are read by the gates. Every one of them is a number a budget is asserted against.
type Counters struct {
	Resolutions       atomic.Int64
	RangeRequests     atomic.Int64
	BytesServed       atomic.Int64
	Served429         atomic.Int64
	FullBodyServed    atomic.Int64
	ExpiredRejected   atomic.Int64
	PeakConcurrent    atomic.Int64
	CurrentConcurrent atomic.Int64
	PeakConns         atomic.Int64
	CurrentConns      atomic.Int64
}

// Server is the fake endpoint.
type Server struct {
	listener net.Listener
	server   *http.Server
	counters Counters

	mu sync.Mutex
	// objects by reference
	objects map[string]Object
	// faults by reference; remaining>0 means "apply this many more times, then stop"
	faults     map[string]*faultState
	leaseTTL   time.Duration
	leaseSeq   atomic.Uint64
	leases     map[string]time.Time
	now        func() time.Time
	timeoutFor time.Duration
	// requireAuth makes the resolver refuse a request with no bearer credential.
	requireAuth bool
	token       string
}

type faultState struct {
	fault     Fault
	remaining int
}

type Options struct {
	// LeaseTTL is how long a resolved access URL stays valid. Set it shorter than a read to exercise the
	// expiry-mid-read gate.
	LeaseTTL time.Duration
	// Token, when non-empty, must be presented to the resolver as a bearer credential.
	Token      string
	TimeoutFor time.Duration
	MaxConns   int
}

func New(opts Options) (*Server, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &Server{
		listener:    listener,
		objects:     map[string]Object{},
		faults:      map[string]*faultState{},
		leases:      map[string]time.Time{},
		leaseTTL:    opts.LeaseTTL,
		now:         time.Now,
		timeoutFor:  opts.TimeoutFor,
		token:       opts.Token,
		requireAuth: opts.Token != "",
	}
	if s.leaseTTL == 0 {
		s.leaseTTL = time.Hour
	}
	if s.timeoutFor == 0 {
		s.timeoutFor = 2 * time.Second
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/resolve", s.handleResolve)
	mux.HandleFunc("/object/", s.handleObject)
	mux.HandleFunc("/direct/", s.handleDirect)
	s.server = &http.Server{
		Handler:      mux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		ConnState:    s.trackConn,
	}
	go s.server.Serve(listener)
	return s, nil
}

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

func (s *Server) Close() error {
	_ = s.server.Close()
	return s.listener.Close()
}

func (s *Server) BaseURL() string    { return "http://" + s.listener.Addr().String() }
func (s *Server) ResolveURL() string { return s.BaseURL() + "/resolve" }
func (s *Server) DirectURL() string  { return s.BaseURL() + "/direct" }
func (s *Server) Host() string {
	host, _, _ := net.SplitHostPort(s.listener.Addr().String())
	return host
}
func (s *Server) Counters() *Counters { return &s.counters }

// AddObject registers a servable object.
func (s *Server) AddObject(ref string, size int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[ref] = Object{Ref: ref, Size: size}
}

// InjectFault applies a fault to the next `times` requests for one object. times <= 0 means "always".
func (s *Server) InjectFault(ref string, fault Fault, times int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if fault == FaultNone {
		delete(s.faults, ref)
		return
	}
	s.faults[ref] = &faultState{fault: fault, remaining: times}
}

func (s *Server) takeFault(ref string) Fault {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, ok := s.faults[ref]
	if !ok {
		return FaultNone
	}
	if state.remaining > 0 {
		state.remaining--
		if state.remaining == 0 {
			delete(s.faults, ref)
		}
	}
	return state.fault
}

// ObjectBytes is the deterministic content function. Byte i of an object is derived from a digest of the
// reference and the 32-byte window index, so any range can be produced without materialising the object.
func ObjectBytes(ref string, offset, length int64) []byte {
	out := make([]byte, length)
	for i := int64(0); i < length; {
		pos := offset + i
		window := pos / 32
		var seed [8]byte
		binary.BigEndian.PutUint64(seed[:], uint64(window))
		digest := sha256.Sum256(append([]byte(ref+"\x00"), seed[:]...))
		start := pos % 32
		n := int64(copy(out[i:], digest[start:]))
		if n == 0 {
			break
		}
		i += n
	}
	return out
}

func (s *Server) handleResolve(w http.ResponseWriter, r *http.Request) {
	s.counters.Resolutions.Add(1)
	if s.requireAuth {
		if r.Header.Get("Authorization") != "Bearer "+s.token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
	}
	var body struct {
		ObjectRef string `json:"objectRef"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	_, known := s.objects[body.ObjectRef]
	s.mu.Unlock()
	if !known {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	switch s.takeFaultFor(body.ObjectRef, FaultResolverError, FaultDisallowedHost) {
	case FaultResolverError:
		w.WriteHeader(http.StatusInternalServerError)
		return
	case FaultDisallowedHost:
		// The provider names a host the daemon was never configured to contact. It must not be dialled.
		writeJSON(w, map[string]any{
			"url":             "http://evil.invalid/object/x/" + body.ObjectRef,
			"expiresAtUnixMs": s.now().Add(s.leaseTTL).UnixMilli(),
		})
		return
	}

	lease := "l" + strconv.FormatUint(s.leaseSeq.Add(1), 10)
	expires := s.now().Add(s.leaseTTL)
	s.mu.Lock()
	s.leases[lease] = expires
	s.mu.Unlock()
	writeJSON(w, map[string]any{
		"url":             s.BaseURL() + "/object/" + lease + "/" + body.ObjectRef,
		"headers":         map[string]string{"X-Fake-Lease": lease},
		"expiresAtUnixMs": expires.UnixMilli(),
	})
}

// takeFaultFor consumes the pending fault only when it is one of the listed kinds, so a range-path fault is
// not eaten by a resolver request.
func (s *Server) takeFaultFor(ref string, kinds ...Fault) Fault {
	s.mu.Lock()
	state, ok := s.faults[ref]
	s.mu.Unlock()
	if !ok {
		return FaultNone
	}
	for _, kind := range kinds {
		if state.fault == kind {
			return s.takeFault(ref)
		}
	}
	return FaultNone
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func (s *Server) handleDirect(w http.ResponseWriter, r *http.Request) {
	ref := strings.TrimPrefix(r.URL.Path, "/direct/")
	s.serveRange(w, r, ref, "")
}

func (s *Server) handleObject(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/object/")
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	s.serveRange(w, r, parts[1], parts[0])
}

func (s *Server) serveRange(w http.ResponseWriter, r *http.Request, ref, lease string) {
	current := s.counters.CurrentConcurrent.Add(1)
	for {
		peak := s.counters.PeakConcurrent.Load()
		if current <= peak || s.counters.PeakConcurrent.CompareAndSwap(peak, current) {
			break
		}
	}
	defer s.counters.CurrentConcurrent.Add(-1)
	s.counters.RangeRequests.Add(1)

	s.mu.Lock()
	object, known := s.objects[ref]
	expires, leaseKnown := s.leases[lease]
	s.mu.Unlock()
	if !known {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if lease != "" {
		if !leaseKnown || !s.now().Before(expires) {
			// The normal end of a signed URL's life.
			s.counters.ExpiredRejected.Add(1)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
	}

	fault := s.takeFault(ref)
	switch fault {
	case Fault401:
		w.WriteHeader(http.StatusUnauthorized)
		return
	case Fault403:
		w.WriteHeader(http.StatusForbidden)
		return
	case Fault410:
		w.WriteHeader(http.StatusGone)
		return
	case Fault429:
		s.counters.Served429.Add(1)
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusTooManyRequests)
		return
	case Fault503:
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	case FaultTimeout:
		time.Sleep(s.timeoutFor)
		return
	case FaultRedirect:
		w.Header().Set("Location", s.BaseURL()+"/direct/"+ref)
		w.WriteHeader(http.StatusFound)
		return
	}

	start, end, ok := parseRange(r.Header.Get("Range"), object.Size)
	if !ok {
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	length := end - start + 1
	data := ObjectBytes(ref, start, length)

	switch fault {
	case FaultFullBodyOnRange:
		// 200 with the whole object. A daemon that reads this body downloads the file to answer a probe.
		s.counters.FullBodyServed.Add(1)
		full := ObjectBytes(ref, 0, object.Size)
		w.Header().Set("Content-Length", strconv.FormatInt(object.Size, 10))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(full)
		s.counters.BytesServed.Add(object.Size)
		return
	case FaultMalformedRange:
		w.Header().Set("Content-Range", "octets "+strconv.FormatInt(start, 10))
	case FaultMismatchedRange:
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start+1, end+1, object.Size))
	case FaultWrongTotalSize:
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, object.Size+4096))
	default:
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, object.Size))
	}

	switch fault {
	case FaultShortBody:
		short := data[:len(data)/2]
		w.Header().Set("Content-Length", strconv.FormatInt(int64(len(data)), 10))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(short)
		s.counters.BytesServed.Add(int64(len(short)))
		return
	case FaultDelayedClose:
		// No Content-Length, so the response is chunked; the body is correct and complete, but the terminal
		// chunk is late.
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(data)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		s.counters.BytesServed.Add(int64(len(data)))
		time.Sleep(s.timeoutFor)
		return
	case FaultLongBody:
		long := append(data, ObjectBytes(ref, end+1, 64)...)
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(long)
		s.counters.BytesServed.Add(int64(len(long)))
		return
	}

	w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
	w.WriteHeader(http.StatusPartialContent)
	_, _ = w.Write(data)
	s.counters.BytesServed.Add(length)
}

func parseRange(value string, size int64) (int64, int64, bool) {
	if !strings.HasPrefix(value, "bytes=") {
		return 0, 0, false
	}
	spec := strings.TrimPrefix(value, "bytes=")
	dash := strings.Index(spec, "-")
	if dash <= 0 {
		return 0, 0, false
	}
	start, err := strconv.ParseInt(spec[:dash], 10, 64)
	if err != nil {
		return 0, 0, false
	}
	end, err := strconv.ParseInt(spec[dash+1:], 10, 64)
	if err != nil {
		return 0, 0, false
	}
	if start < 0 || end < start || start >= size {
		return 0, 0, false
	}
	if end >= size {
		end = size - 1
	}
	return start, end, true
}
