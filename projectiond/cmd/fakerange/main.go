//go:build linux

// Command fakerange runs the deterministic HTTP Range endpoint as a standalone process.
//
// IT IS A GATE TOOL AND IT NEVER SHIPS, exactly like ./cmd/mkfixture. The production Dockerfile builds only
// ./cmd/projectiond, so this binary exists solely inside the pinned toolchain image. It exists because the
// publisher-to-mount gate has to read a REMOTE projected entry through the mount, and a remote entry needs an
// endpoint that answers ranged requests correctly — which `internal/fakeprovider` already is, and which the
// rest of the Phase 1 gates already measure their amplification budgets against.
//
// IT IS NOT A PROVIDER ADAPTER AND IT CONTACTS NOTHING. Object bytes are a pure function of the object
// reference and the offset, so the gate can assert the exact bytes a read returned without shipping a fixture,
// and two runs compare the same digests. There is no named provider here, no real endpoint, and no network
// call leaves this process — the wiring gate refuses any Go file in this module that names one.
//
// WHAT IT WRITES. A small JSON document naming, per object: the size, the sha256 of the WHOLE object, and the
// byte-identity probe digests at the contract's fixed offsets. The gate registers those probes as the control
// plane's assertion about the byte stream and hashes the whole-object digest against what it read through the
// mount — a digest recorded OUTSIDE the thing being verified, which is the only kind worth comparing against.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/fakeprovider"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/manifest"
)

type probeOut struct {
	Position string `json:"position"`
	Offset   int64  `json:"offset"`
	Length   int64  `json:"length"`
	SHA256   string `json:"sha256"`
}

type objectOut struct {
	Ref    string     `json:"ref"`
	Size   int64      `json:"size"`
	SHA256 string     `json:"sha256"`
	Probes []probeOut `json:"probes"`
}

func main() {
	addr := flag.String("addr", "0.0.0.0:8099", "address to listen on")
	emit := flag.String("emit", "", "write the object descriptor JSON here")
	var objects objectList
	flag.Var(&objects, "object", "ref:size, repeatable")
	flag.Parse()

	if len(objects) == 0 {
		fail("--object ref:size is required at least once")
	}

	server, err := fakeprovider.New(fakeprovider.Options{Addr: *addr})
	if err != nil {
		fail(err.Error())
	}
	defer server.Close()

	out := make([]objectOut, 0, len(objects))
	for _, object := range objects {
		server.AddObject(object.ref, object.size)

		// The whole-object digest, and the probe digests at the contract's own fixed offsets. Both are
		// computed from the same deterministic content function the server serves from, so they describe
		// exactly what a reader will get.
		whole := sha256.Sum256(fakeprovider.ObjectBytes(object.ref, 0, object.size))
		probes := make([]probeOut, 0, 3)
		for _, slot := range manifest.ProbeOffsetsFor(object.size) {
			digest := sha256.Sum256(fakeprovider.ObjectBytes(object.ref, slot.Offset, slot.Length))
			probes = append(probes, probeOut{
				Position: slot.Position, Offset: slot.Offset, Length: slot.Length,
				SHA256: hex.EncodeToString(digest[:]),
			})
		}
		out = append(out, objectOut{
			Ref: object.ref, Size: object.size, SHA256: hex.EncodeToString(whole[:]), Probes: probes,
		})
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

	fmt.Printf("fakerange listening on %s with %d object(s)\n", *addr, len(objects))
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	<-signals
	fmt.Println("fakerange stopping")
}

type objectSpec struct {
	ref  string
	size int64
}

type objectList []objectSpec

func (l *objectList) String() string { return fmt.Sprintf("%d objects", len(*l)) }

func (l *objectList) Set(value string) error {
	// Split on the LAST colon: an object reference may contain one, a size may not.
	index := strings.LastIndex(value, ":")
	if index <= 0 {
		return fmt.Errorf("an object is ref:size")
	}
	size, err := strconv.ParseInt(value[index+1:], 10, 64)
	if err != nil || size <= 0 {
		return fmt.Errorf("an object size is a positive integer")
	}
	*l = append(*l, objectSpec{ref: value[:index], size: size})
	return nil
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, "fakerange: "+message)
	os.Exit(1)
}
