//go:build linux

package fusefs

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/daemon"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/manifest"
)

// Shared manifest-building support for both the privileged smoke run and the ordinary in-process tests. It
// uses the daemon's own derivations, so a test cannot accidentally assert against a manifest the validator
// would refuse.

type entrySpec struct {
	path       string
	size       int64
	local      bool
	objectRef  string
	relative   string
	visibility string
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

func buildManifest(sequence int64, generationSeed string, predecessor map[string]any, specs []entrySpec) []byte {
	entries := make([]any, 0, len(specs))
	for _, spec := range specs {
		versionID := "pv_" + hex64("version:"+spec.path)
		var locator map[string]any
		kind := "http-range"
		if spec.local {
			kind = "local"
			locator = map[string]any{"rootId": "media", "relativePath": spec.relative}
		} else {
			locator = map[string]any{"endpointId": "fake", "objectRef": spec.objectRef}
		}
		visibility := spec.visibility
		if visibility == "" {
			visibility = "available"
		}
		var degraded any
		if visibility == "degraded" {
			degraded = map[string]any{"reason": "source-unreachable", "since": "2026-07-01T00:00:00.000Z"}
		}
		entries = append(entries, map[string]any{
			"projectedEntryId":   "pe_" + hex64("entry:"+spec.path),
			"logicalMediaId":     uuidFor("media:" + spec.path),
			"projectedVersionId": versionID,
			"path":               spec.path,
			"nodeKind":           "file",
			"sizeBytes":          spec.size,
			"mtime":              "2026-06-01T10:00:00.000Z",
			"mode":               0o444,
			"readOnly":           true,
			"inode":              strconv.FormatUint(manifest.DeriveInode(versionID), 10),
			"visibility":         visibility,
			"degraded":           degraded,
			"retiring":           nil,
			"sources": []any{map[string]any{
				"sourceId": "src_" + hex32("source:"+spec.path), "kind": kind,
				"preference": 0, "sourceGeneration": 1,
				"locator": locator, "byteIdentity": nil,
			}},
		})
	}
	document := map[string]any{
		"format":  manifest.Format,
		"version": manifest.Version,
		"generation": map[string]any{
			"generationId": "gen_" + hex32(generationSeed),
			"sequence":     sequence,
			"createdAt":    time.Unix(1_780_000_000+sequence, 0).UTC().Format("2006-01-02T15:04:05.000Z"),
			"predecessor":  predecessor,
			"provenance": map[string]any{
				"producer": "catalog-authority", "producerVersion": "1.2.6",
				"controlPlaneSchemaVersion": 9,
				"sourceSnapshotDigest":      "sha256:" + hex64("snapshot:"+generationSeed),
				"probeWindowBytes":          manifest.ProbeWindowBytes,
			},
			"admission": map[string]any{
				"intent": "routine", "entryCount": len(entries), "deletions": []any{},
				"deletionGuardAcknowledged": false, "deletionGuardDigest": nil,
			},
		},
		"entries": entries,
	}
	raw, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		panic(err)
	}
	return append(raw, '\n')
}

// publish writes the artifact and then publishes the pointer BY RENAME, exactly as the control plane does.
func publish(t *testing.T, dir string, artifactName string, raw []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, artifactName), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	parsed, problems := manifest.Parse(raw)
	if len(problems) > 0 {
		t.Fatalf("the test built an invalid manifest: %v", manifest.Codes(problems))
	}
	encoded, err := json.Marshal(daemon.Pointer{
		GenerationID:   parsed.Generation.GenerationID,
		Sequence:       parsed.Generation.Sequence,
		ArtifactName:   artifactName,
		ArtifactBytes:  int64(len(raw)),
		ManifestDigest: manifest.DigestOfBytes(raw),
	})
	if err != nil {
		t.Fatal(err)
	}
	tmp := filepath.Join(dir, "pointer.json.tmp")
	if err := os.WriteFile(tmp, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, filepath.Join(dir, "pointer.json")); err != nil {
		t.Fatal(err)
	}
}
