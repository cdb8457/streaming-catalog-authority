//go:build linux

// Command mkfixture writes a small, valid manifest generation and its backing local media.
//
// IT IS A GATE TOOL AND IT NEVER SHIPS. The production Dockerfile builds only ./cmd/projectiond, so this
// binary exists solely inside the toolchain image. It is here rather than inside a _test.go file because the
// image-mount gate needs a fixture on disk BEFORE the production image starts, and the production image
// deliberately contains no way to generate one — a data plane that can author a manifest is a data plane that
// can disagree with the control plane.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/manifest"
)

func main() {
	manifestDir := flag.String("manifest-dir", "", "directory to publish pointer.json and the artifact into")
	mediaDir := flag.String("media-dir", "", "directory to write the backing media into")
	entries := flag.Int("entries", 3, "how many projected entries to write")
	sizeBytes := flag.Int64("size", 3*1024*1024, "byte length of each entry")
	flag.Parse()

	if *manifestDir == "" || *mediaDir == "" {
		fail("--manifest-dir and --media-dir are required")
	}
	for _, dir := range []string{*manifestDir, *mediaDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			fail(err.Error())
		}
	}

	specs := make([]map[string]any, 0, *entries)
	expected := make([]string, 0, *entries)
	for i := 0; i < *entries; i++ {
		name := fmt.Sprintf("Sample %02d", i)
		relative := fmt.Sprintf("sample-%02d.bin", i)

		// Deterministic bytes, so a verifier can check them without shipping a fixture file.
		content := make([]byte, *sizeBytes)
		for b := range content {
			content[b] = byte((b + i) % 251)
		}
		if err := os.WriteFile(filepath.Join(*mediaDir, relative), content, 0o644); err != nil {
			fail(err.Error())
		}
		// The EXPECTED digest of the whole file, recorded OUTSIDE the projected namespace. A verifier that only
		// prints a hash proves nothing — a zero-filled file of the right length would pass — so the gate needs
		// something to compare against that did not come through the thing it is verifying.
		contentDigest := sha256.Sum256(content)
		expected = append(expected, fmt.Sprintf("%s  %s", hex.EncodeToString(contentDigest[:]), relative))

		path := fmt.Sprintf("Movies/%s/%s.bin", name, name)
		versionID := "pv_" + hex64("version:"+path)
		specs = append(specs, map[string]any{
			"projectedEntryId":   "pe_" + hex64("entry:"+path),
			"logicalMediaId":     uuidFor("media:" + path),
			"projectedVersionId": versionID,
			"path":               path,
			"nodeKind":           "file",
			"sizeBytes":          *sizeBytes,
			"mtime":              "2026-06-01T10:00:00.000Z",
			"mode":               0o444,
			"readOnly":           true,
			"inode":              strconv.FormatUint(manifest.DeriveInode(versionID), 10),
			"visibility":         "available",
			"degraded":           nil,
			"retiring":           nil,
			"sources": []any{map[string]any{
				"sourceId": "src_" + hex32("source:"+path), "kind": "local",
				"preference": 0, "sourceGeneration": 1,
				"locator":      map[string]any{"rootId": "media", "relativePath": relative},
				"byteIdentity": nil,
			}},
		})
	}

	document := map[string]any{
		"format":  manifest.Format,
		"version": manifest.Version,
		"generation": map[string]any{
			"generationId": "gen_" + hex32("mkfixture-one"),
			"sequence":     1,
			"createdAt":    time.Unix(1_780_000_001, 0).UTC().Format("2006-01-02T15:04:05.000Z"),
			"predecessor":  nil,
			"provenance": map[string]any{
				"producer": "catalog-authority", "producerVersion": "1.2.6",
				"controlPlaneSchemaVersion": 9,
				"sourceSnapshotDigest":      "sha256:" + hex64("snapshot:mkfixture"),
				"probeWindowBytes":          manifest.ProbeWindowBytes,
			},
			"admission": map[string]any{
				"intent": "routine", "entryCount": len(specs), "deletions": []any{},
				"deletionGuardAcknowledged": false, "deletionGuardDigest": nil,
			},
		},
		"entries": specs,
	}

	artifact, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		fail(err.Error())
	}
	artifact = append(artifact, '\n')

	// Refuse to publish something the daemon would reject: a fixture that cannot be admitted is a gate that
	// fails for the wrong reason.
	parsed, problems := manifest.Parse(artifact)
	if len(problems) > 0 {
		fail(fmt.Sprintf("the generated manifest is invalid: %v", manifest.Codes(problems)))
	}

	const artifactName = "generation-1.json"
	if err := os.WriteFile(filepath.Join(*manifestDir, artifactName), artifact, 0o644); err != nil {
		fail(err.Error())
	}
	pointer, err := json.Marshal(map[string]any{
		"generationId":   parsed.Generation.GenerationID,
		"sequence":       parsed.Generation.Sequence,
		"artifactName":   artifactName,
		"artifactBytes":  len(artifact),
		"manifestDigest": manifest.DigestOfBytes(artifact),
	})
	if err != nil {
		fail(err.Error())
	}
	// Published by rename, exactly as the control plane does it.
	tmp := filepath.Join(*manifestDir, "pointer.json.tmp")
	if err := os.WriteFile(tmp, pointer, 0o644); err != nil {
		fail(err.Error())
	}
	if err := os.Rename(tmp, filepath.Join(*manifestDir, "pointer.json")); err != nil {
		fail(err.Error())
	}

	if err := os.WriteFile(filepath.Join(*manifestDir, "expected-sha256.txt"),
		[]byte(strings.Join(expected, "\n")+"\n"), 0o644); err != nil {
		fail(err.Error())
	}

	fmt.Printf("wrote %d entries of %d bytes; generation %s\n",
		len(specs), *sizeBytes, parsed.Generation.GenerationID)
}

func hex64(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	return hex.EncodeToString(sum[:])
}

func hex32(seed string) string { return hex64(seed)[:32] }

func uuidFor(seed string) string {
	d := hex32(seed)
	return fmt.Sprintf("%s-%s-4%s-8%s-%s", d[0:8], d[8:12], d[13:16], d[17:20], d[20:32])
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, "mkfixture: "+message)
	os.Exit(1)
}
