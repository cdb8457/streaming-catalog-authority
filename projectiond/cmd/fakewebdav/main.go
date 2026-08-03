//go:build linux

// Command fakewebdav runs the deterministic, instrumented WebDAV endpoint the COMPARISON CONTROL measures.
//
// IT IS A GATE TOOL AND IT NEVER SHIPS, exactly like ./cmd/mkfixture and ./cmd/fakerange. The production
// Dockerfile builds only ./cmd/projectiond, and `test/projectiond-wiring.ts` refuses a Dockerfile that names
// this tool.
//
// WHAT IT IS FOR. `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §5 G22 — the comparison control — puts the
// SAME ~50-entry corpus behind an rclone/WebDAV mount and measures what that costs. This is the server half.
// `docs/ADR_002_PROJECTION_APPLIANCE.md` rejected rclone over WebDAV as production architecture and kept it
// as a test control; a test control is not an architecture, and nothing in this binary is a component of the
// product.
//
// IT CONTACTS NOTHING AND NAMES NOTHING. Every byte it serves comes from a file the gate generated on the
// machine that runs it, from a synthetic signal. There is no provider here, no real endpoint and no network
// call leaving this process.
//
// WHAT IT WRITES. A small JSON document naming, per registered object: the WebDAV path, the size and the
// sha256 of the whole file — recorded OUTSIDE the mount, before anything has read it through one, which is
// the only kind of expectation worth comparing a mount's answer against.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/fakewebdav"
)

type objectOut struct {
	Path   string `json:"path"`
	Ref    string `json:"ref"`
	Seed   bool   `json:"seed"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

func main() {
	addr := flag.String("addr", "0.0.0.0:8098", "address to listen on")
	emit := flag.String("emit", "", "write the object descriptor JSON here")
	// THE CREDENTIAL COMES FROM A FILE, NEVER FROM AN ARGUMENT. A token on a command line is in this
	// process's argv, in the container's inspect output and in any shell history that recorded the run. The
	// gate mints a high-entropy value per run, writes it to a file, and then searches the mount, the client's
	// cache and every media server's library state for that exact string.
	tokenFile := flag.String("token-file", "", "read the required bearer token from this file")
	// HOW LONG A HELD RESPONSE MAY BLOCK. The comparison arms a rendezvous so the three scanners coexist, and
	// the bound has to sit under the client's own IO timeout or a forgotten release would fail a read rather
	// than pausing one. Zero keeps the package default.
	maxHold := flag.Duration("max-hold", 0, "how long a held GET may block; 0 keeps the default")
	var files fileList
	var seeds fileList
	flag.Var(&files, "file-object", "ref=davPath=hostPath, repeatable — a corpus entry")
	flag.Var(&seeds, "seed-object", "ref=davPath=hostPath, repeatable — visible BEFORE the reveal")
	flag.Parse()

	if len(files) == 0 && len(seeds) == 0 {
		fail("at least one --file-object or --seed-object is required")
	}

	token := ""
	if *tokenFile != "" {
		raw, err := os.ReadFile(*tokenFile)
		if err != nil {
			fail(err.Error())
		}
		token = strings.TrimSpace(string(raw))
		if token == "" {
			fail("the token file is empty, so every request would be accepted and the leak search would " +
				"have no subject")
		}
	}

	server, err := fakewebdav.New(fakewebdav.Options{
		Addr: *addr, BearerToken: token, MaxHold: *maxHold,
	})
	if err != nil {
		fail(err.Error())
	}
	defer func() { _ = server.Close() }()

	// THE SEEDS ARE REGISTERED FIRST AND THE ORDER IS LOAD-BEARING. The counters carry a registration ordinal
	// and no path, so a caller splits a window's bytes at a known boundary — everything at or above the first
	// corpus ordinal is corpus, everything below it is not. Registering them in any other order would make
	// that boundary a guess.
	out := make([]objectOut, 0, len(files)+len(seeds))
	for _, spec := range seeds {
		out = append(out, register(server, spec, true))
	}
	for _, spec := range files {
		out = append(out, register(server, spec, false))
	}

	if *emit != "" {
		encoded, err := json.MarshalIndent(out, "", "  ")
		if err != nil {
			fail(err.Error())
		}
		if err := os.WriteFile(*emit, append(encoded, '\n'), 0o644); err != nil {
			fail(err.Error())
		}
	}

	fmt.Printf("fakewebdav listening on %s with %d seed and %d corpus object(s)\n",
		*addr, len(seeds), len(files))
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	<-signals
	fmt.Println("fakewebdav stopping")
}

func register(server *fakewebdav.Server, spec fileSpec, seed bool) objectOut {
	size, err := server.AddFileObject(spec.davPath, spec.ref, spec.hostPath, seed)
	if err != nil {
		fail(err.Error())
	}
	return objectOut{
		Path: spec.davPath, Ref: spec.ref, Seed: seed, Size: size, SHA256: digestOf(spec.hostPath),
	}
}

// digestOf hashes the file on disk, streaming, so a hundred-megabyte fixture does not have to be resident.
func digestOf(path string) string {
	handle, err := os.Open(path)
	if err != nil {
		fail(err.Error())
	}
	defer func() { _ = handle.Close() }()
	hash := sha256.New()
	if _, err := io.Copy(hash, handle); err != nil {
		fail(err.Error())
	}
	return hex.EncodeToString(hash.Sum(nil))
}

type fileSpec struct {
	ref      string
	davPath  string
	hostPath string
}

type fileList []fileSpec

func (l *fileList) String() string { return fmt.Sprintf("%d objects", len(*l)) }

// Set splits on the FIRST two '=' characters: a reference and a WebDAV path may not contain one, and a host
// path may.
func (l *fileList) Set(value string) error {
	first := strings.Index(value, "=")
	if first <= 0 {
		return fmt.Errorf("an object is ref=davPath=hostPath")
	}
	rest := value[first+1:]
	second := strings.Index(rest, "=")
	if second <= 0 || second == len(rest)-1 {
		return fmt.Errorf("an object is ref=davPath=hostPath")
	}
	*l = append(*l, fileSpec{
		ref: value[:first], davPath: rest[:second], hostPath: rest[second+1:],
	})
	return nil
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, "fakewebdav: "+message)
	os.Exit(1)
}
