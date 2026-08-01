package manifest

import (
	"fmt"
	"sort"
	"strconv"
)

// Parse decodes and validates one manifest in isolation.
//
// Either every rule holds and the caller gets a fully typed manifest, or the caller gets every problem found
// and no manifest. There is no state in which some of a generation was admitted.
func Parse(raw []byte) (*Manifest, []Problem) {
	if len(raw) > MaxArtifactBytes {
		return nil, []Problem{{Code: "MANIFEST_TOO_LARGE", At: ""}}
	}
	decoded, err := decodeGeneric(raw)
	if err != nil {
		return nil, []Problem{{Code: "MANIFEST_NOT_JSON", At: ""}}
	}
	return Validate(decoded)
}

// Validate runs the static half of admission — checks 1 and 3 through 10 of the Phase 0 contract. The
// predecessor and shrink-guard checks that need the previously admitted generation are ValidateSuccession.
func Validate(input any) (*Manifest, []Problem) {
	p := &problemList{}
	root, ok := asObject(input)
	if !ok {
		return nil, []Problem{{Code: "MANIFEST_NOT_AN_OBJECT", At: ""}}
	}
	p.checkNoUnknownKeys(root, []string{"format", "version", "generation", "entries"}, "")
	if s, _ := asString(root["format"]); s != Format {
		p.add("MANIFEST_FORMAT_INVALID", "format")
	}
	if !integerEquals(root["version"], Version) {
		p.add("MANIFEST_VERSION_INVALID", "version")
	}

	entries, ok := asArray(root["entries"])
	if !ok {
		p.add("MANIFEST_ENTRIES_MALFORMED", "entries")
		return nil, p.list
	}
	if len(entries) > MaxEntries {
		p.add("MANIFEST_TOO_MANY_ENTRIES", "entries")
	}

	validateGeneration(root["generation"], len(entries), p)
	for i, entry := range entries {
		validateEntry(entry, indexAt("entries", i), p)
	}
	validateCrossEntry(root, entries, p)

	if p.any() {
		return nil, p.list
	}
	return build(root, entries), nil
}

// ---------------------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------------------

func validateGeneration(value any, entryCount int, p *problemList) {
	gen, ok := asObject(value)
	if !ok {
		p.add("GENERATION_MALFORMED", "generation")
		return
	}
	p.checkNoUnknownKeys(gen, []string{"generationId", "sequence", "createdAt", "predecessor", "provenance", "admission"}, "generation")

	if !matches(gen["generationId"], reGenID) {
		p.add("GENERATION_ID_INVALID", "generation.generationId")
	}
	sequence, sequenceOK := asInteger(gen["sequence"], 1, MaxSizeBytes)
	if !sequenceOK {
		p.add("GENERATION_SEQUENCE_INVALID", "generation.sequence")
	}
	if _, ok := isTimestamp(gen["createdAt"]); !ok {
		p.add("GENERATION_CREATED_AT_INVALID", "generation.createdAt")
	}

	predecessor := gen["predecessor"]
	if sequenceOK && sequence == 1 {
		if predecessor != nil {
			p.add("GENERATION_FIRST_HAS_PREDECESSOR", "generation.predecessor")
		}
	} else {
		pred, ok := asObject(predecessor)
		if !ok {
			p.add("GENERATION_PREDECESSOR_REQUIRED", "generation.predecessor")
		} else {
			p.checkNoUnknownKeys(pred, []string{"generationId", "sequence", "manifestDigest"}, "generation.predecessor")
			if !matches(pred["generationId"], reGenID) {
				p.add("GENERATION_PREDECESSOR_ID_INVALID", "generation.predecessor.generationId")
			}
			if sequenceOK && !integerEquals(pred["sequence"], sequence-1) {
				p.add("GENERATION_PREDECESSOR_SEQUENCE_INVALID", "generation.predecessor.sequence")
			}
			if !matches(pred["manifestDigest"], reSHA256) {
				p.add("GENERATION_PREDECESSOR_DIGEST_INVALID", "generation.predecessor.manifestDigest")
			}
		}
	}

	prov, ok := asObject(gen["provenance"])
	if !ok {
		p.add("PROVENANCE_MALFORMED", "generation.provenance")
	} else {
		p.checkNoUnknownKeys(prov, []string{"producer", "producerVersion", "controlPlaneSchemaVersion", "sourceSnapshotDigest", "probeWindowBytes"}, "generation.provenance")
		if s, _ := asString(prov["producer"]); s != "catalog-authority" {
			p.add("PROVENANCE_PRODUCER_INVALID", "generation.provenance.producer")
		}
		if !matches(prov["producerVersion"], reSemver) {
			p.add("PROVENANCE_PRODUCER_VERSION_INVALID", "generation.provenance.producerVersion")
		}
		if _, ok := asInteger(prov["controlPlaneSchemaVersion"], 1, 10_000); !ok {
			p.add("PROVENANCE_SCHEMA_VERSION_INVALID", "generation.provenance.controlPlaneSchemaVersion")
		}
		if !matches(prov["sourceSnapshotDigest"], reSHA256) {
			p.add("PROVENANCE_SNAPSHOT_DIGEST_INVALID", "generation.provenance.sourceSnapshotDigest")
		}
		if !integerEquals(prov["probeWindowBytes"], ProbeWindowBytes) {
			p.add("PROVENANCE_PROBE_WINDOW_INVALID", "generation.provenance.probeWindowBytes")
		}
	}

	admission, ok := asObject(gen["admission"])
	if !ok {
		p.add("ADMISSION_MALFORMED", "generation.admission")
		return
	}
	p.checkNoUnknownKeys(admission, []string{"intent", "entryCount", "deletions", "deletionGuardAcknowledged", "deletionGuardDigest"}, "generation.admission")

	intent, _ := asString(admission["intent"])
	if !inSet(admission["intent"], GenerationIntents) {
		p.add("ADMISSION_INTENT_INVALID", "generation.admission.intent")
	}
	if !integerEquals(admission["entryCount"], int64(entryCount)) {
		p.add("ADMISSION_ENTRY_COUNT_MISMATCH", "generation.admission.entryCount")
	}

	deletions, ok := asArray(admission["deletions"])
	if !ok {
		p.add("ADMISSION_DELETIONS_MALFORMED", "generation.admission.deletions")
		return
	}
	seen := map[string]bool{}
	ids := make([]string, 0, len(deletions))
	for i, item := range deletions {
		at := indexAt("generation.admission.deletions", i)
		id, isString := asString(item)
		switch {
		case !isString || !reEntryID.MatchString(id):
			p.add("ADMISSION_DELETION_ID_INVALID", at)
		case seen[id]:
			p.add("ADMISSION_DELETION_ID_DUPLICATE", at)
		default:
			seen[id] = true
			ids = append(ids, id)
		}
	}
	// A routine generation cannot remove anything. Deletion is a separate, declared kind of generation, and
	// that is what makes "the scan came back short" structurally unable to become "the file is gone".
	if intent == "routine" && len(deletions) > 0 {
		p.add("ADMISSION_ROUTINE_GENERATION_DELETES", "generation.admission.deletions")
	}
	if intent == "deletion" && len(deletions) == 0 {
		p.add("ADMISSION_DELETION_GENERATION_EMPTY", "generation.admission.deletions")
	}

	acknowledged, isBool := admission["deletionGuardAcknowledged"].(bool)
	if !isBool {
		p.add("ADMISSION_DELETION_GUARD_INVALID", "generation.admission.deletionGuardAcknowledged")
	}
	guardDigest := admission["deletionGuardDigest"]
	if acknowledged {
		if !matches(guardDigest, reSHA256) {
			p.add("ADMISSION_DELETION_GUARD_DIGEST_INVALID", "generation.admission.deletionGuardDigest")
		} else if s, _ := asString(guardDigest); s != DeletionAcknowledgementDigest(ids) {
			p.add("ADMISSION_DELETION_GUARD_DIGEST_MISMATCH", "generation.admission.deletionGuardDigest")
		}
	} else if guardDigest != nil {
		p.add("ADMISSION_DELETION_GUARD_DIGEST_FORBIDDEN", "generation.admission.deletionGuardDigest")
	}
}

// ---------------------------------------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------------------------------------

var entryFields = []string{
	"projectedEntryId", "logicalMediaId", "projectedVersionId", "path", "nodeKind", "sizeBytes",
	"mtime", "mode", "readOnly", "inode", "visibility", "degraded", "retiring", "sources",
}

func validateEntry(value any, at string, p *problemList) {
	entry, ok := asObject(value)
	if !ok {
		p.add("ENTRY_MALFORMED", at)
		return
	}
	p.checkNoUnknownKeys(entry, entryFields, at)

	if !matches(entry["projectedEntryId"], reEntryID) {
		p.add("ENTRY_ID_INVALID", at+".projectedEntryId")
	}
	if !matches(entry["logicalMediaId"], reUUID) {
		p.add("LOGICAL_MEDIA_ID_INVALID", at+".logicalMediaId")
	}
	versionID, versionOK := asString(entry["projectedVersionId"])
	if !versionOK || !reVersionID.MatchString(versionID) {
		p.add("PROJECTED_VERSION_ID_INVALID", at+".projectedVersionId")
	}

	if path := NormalizeProjectedPath(entry["path"]); !path.OK {
		code := path.Code
		if code == "" {
			code = "PATH_INVALID"
		}
		p.add("ENTRY_"+code, at+".path")
	}

	// Directories are DERIVED by the daemon from the file paths above; they are not manifest rows. A
	// directory has no byte stream, so it has no projected version, so an ino derived from a projected
	// version could not exist for one.
	if s, _ := asString(entry["nodeKind"]); s != "file" {
		p.add("ENTRY_NODE_KIND_INVALID", at+".nodeKind")
	}

	sizeBytes, sizeOK := asInteger(entry["sizeBytes"], 0, MaxSizeBytes)
	if !sizeOK {
		p.add("ENTRY_SIZE_INVALID", at+".sizeBytes")
	}
	if _, ok := isTimestamp(entry["mtime"]); !ok {
		p.add("ENTRY_MTIME_INVALID", at+".mtime")
	}
	// 0o444. The namespace is read-only in the mode bits as well as in the operation table.
	if !integerEquals(entry["mode"], 0o444) {
		p.add("ENTRY_MODE_INVALID", at+".mode")
	}
	if ro, ok := entry["readOnly"].(bool); !ok || !ro {
		p.add("ENTRY_READ_ONLY_INVALID", at+".readOnly")
	}

	inode, inodeIsString := asString(entry["inode"])
	switch {
	case !inodeIsString || !reDecimalNum.MatchString(inode):
		p.add("ENTRY_INODE_INVALID", at+".inode")
	case versionOK && inode != strconv.FormatUint(DeriveInode(versionID), 10):
		p.add("ENTRY_INODE_NOT_DERIVED", at+".inode")
	}

	visibility, _ := asString(entry["visibility"])
	if !inSet(entry["visibility"], VisibilityStates) {
		p.add("ENTRY_VISIBILITY_INVALID", at+".visibility")
	}

	degraded := entry["degraded"]
	if visibility == "degraded" {
		d, ok := asObject(degraded)
		if !ok {
			p.add("ENTRY_DEGRADED_STATE_REQUIRED", at+".degraded")
		} else {
			p.checkNoUnknownKeys(d, []string{"reason", "since"}, at+".degraded")
			if !inSet(d["reason"], DegradedReasons) {
				p.add("ENTRY_DEGRADED_REASON_INVALID", at+".degraded.reason")
			}
			if _, ok := isTimestamp(d["since"]); !ok {
				p.add("ENTRY_DEGRADED_SINCE_INVALID", at+".degraded.since")
			}
		}
	} else if degraded != nil {
		p.add("ENTRY_DEGRADED_STATE_FORBIDDEN", at+".degraded")
	}

	retiring := entry["retiring"]
	if visibility == "retiring" {
		r, ok := asObject(retiring)
		if !ok {
			p.add("ENTRY_RETIRING_STATE_REQUIRED", at+".retiring")
		} else {
			p.checkNoUnknownKeys(r, []string{"deletionIntentId", "declaredAt", "graceDeadline"}, at+".retiring")
			if !matches(r["deletionIntentId"], reHex32) {
				p.add("ENTRY_DELETION_INTENT_ID_INVALID", at+".retiring.deletionIntentId")
			}
			declaredAt, declaredOK := isTimestamp(r["declaredAt"])
			graceDeadline, graceOK := isTimestamp(r["graceDeadline"])
			if !declaredOK {
				p.add("ENTRY_RETIRING_DECLARED_AT_INVALID", at+".retiring.declaredAt")
			}
			if !graceOK {
				p.add("ENTRY_RETIRING_GRACE_DEADLINE_INVALID", at+".retiring.graceDeadline")
			}
			if declaredOK && graceOK && !graceDeadline.After(declaredAt) {
				p.add("ENTRY_RETIRING_GRACE_NOT_IN_FUTURE", at+".retiring.graceDeadline")
			}
		}
	} else if retiring != nil {
		p.add("ENTRY_RETIRING_STATE_FORBIDDEN", at+".retiring")
	}

	sources, ok := asArray(entry["sources"])
	if !ok {
		p.add("ENTRY_SOURCES_MALFORMED", at+".sources")
		return
	}
	// An entry with no source is an entry that cannot be read. That is not "degraded", it is a producer bug,
	// and admitting it would put a file in the namespace that answers EIO forever with no state saying why.
	if len(sources) < 1 {
		p.add("ENTRY_SOURCES_EMPTY", at+".sources")
	}
	if len(sources) > MaxSourcesPerEntry {
		p.add("ENTRY_TOO_MANY_SOURCES", at+".sources")
	}

	size := int64(-1)
	if sizeOK {
		size = sizeBytes
	}
	preferences := map[int64]bool{}
	sourceIDs := map[string]bool{}
	for i, source := range sources {
		sourceAt := indexAt(at+".sources", i)
		validateSource(source, size, sourceAt, p)
		if s, ok := asObject(source); ok {
			if pref, ok := asInteger(s["preference"], -1<<40, 1<<40); ok {
				if preferences[pref] {
					p.add("SOURCE_PREFERENCE_DUPLICATE", sourceAt+".preference")
				}
				preferences[pref] = true
			}
			if id, ok := asString(s["sourceId"]); ok {
				if sourceIDs[id] {
					p.add("SOURCE_ID_DUPLICATE", sourceAt+".sourceId")
				}
				sourceIDs[id] = true
			}
		}
	}
	// Preference is a total order starting at zero: "which source do I try next" must never have a gap or a
	// tie, because a tie is a coin flip and a coin flip is a source a failover cannot reason about.
	for expected := 0; expected < len(sources); expected++ {
		if !preferences[int64(expected)] {
			p.add("SOURCE_PREFERENCE_NOT_CONTIGUOUS", at+".sources")
			break
		}
	}

	// Multi-source entries need proof. Two locators pointing at bytes nobody compared are two DIFFERENT
	// projected versions wearing one id, and a mid-handle failover between them would hand a player the
	// middle of a different file.
	if len(sources) > 1 {
		identities := make([]*ByteIdentity, len(sources))
		for i, source := range sources {
			if s, ok := asObject(source); ok {
				identities[i] = buildByteIdentity(s["byteIdentity"])
			}
			if identities[i] == nil {
				p.add("MULTI_SOURCE_BYTE_IDENTITY_REQUIRED", indexAt(at+".sources", i)+".byteIdentity")
			}
		}
		for i := 1; i < len(identities); i++ {
			if !identities[0].Equal(identities[i]) {
				p.add("MULTI_SOURCE_BYTE_IDENTITY_MISMATCH", indexAt(at+".sources", i)+".byteIdentity")
			}
		}
	}
}

func validateSource(value any, sizeBytes int64, at string, p *problemList) {
	source, ok := asObject(value)
	if !ok {
		p.add("SOURCE_MALFORMED", at)
		return
	}
	p.checkNoUnknownKeys(source, []string{"sourceId", "kind", "preference", "sourceGeneration", "locator", "byteIdentity"}, at)

	if !matches(source["sourceId"], reSourceID) {
		p.add("SOURCE_ID_INVALID", at+".sourceId")
	}
	kind, _ := asString(source["kind"])
	if !inSet(source["kind"], SourceKinds) {
		p.add("SOURCE_KIND_INVALID", at+".kind")
	}
	if _, ok := asInteger(source["preference"], 0, MaxSourcesPerEntry-1); !ok {
		p.add("SOURCE_PREFERENCE_INVALID", at+".preference")
	}
	if _, ok := asInteger(source["sourceGeneration"], 1, MaxSizeBytes); !ok {
		p.add("SOURCE_GENERATION_INVALID", at+".sourceGeneration")
	}

	locator, ok := asObject(source["locator"])
	switch {
	case !ok:
		p.add("LOCATOR_MALFORMED", at+".locator")
	case kind == "local":
		p.checkNoUnknownKeys(locator, []string{"rootId", "relativePath"}, at+".locator")
		if !matches(locator["rootId"], reIDLabel) {
			p.add("LOCATOR_ROOT_ID_INVALID", at+".locator.rootId")
		}
		if rel := NormalizeProjectedPath(locator["relativePath"]); !rel.OK {
			p.add("LOCATOR_RELATIVE_PATH_INVALID", at+".locator.relativePath")
		} else {
			scanLocatorValue(rel.Path, at+".locator.relativePath", p)
		}
	case kind == "http-range":
		// A STABLE reference. No expiry, no signed URL and no lease: access material expires on the
		// provider's schedule, and a namespace generation must not be coupled to that.
		p.checkNoUnknownKeys(locator, []string{"endpointId", "objectRef"}, at+".locator")
		if !matches(locator["endpointId"], reIDLabel) {
			p.add("LOCATOR_ENDPOINT_ID_INVALID", at+".locator.endpointId")
		}
		if objectRef, ok := asString(locator["objectRef"]); !ok {
			p.add("LOCATOR_OBJECT_REF_INVALID", at+".locator.objectRef")
		} else {
			scanLocatorValue(objectRef, at+".locator.objectRef", p)
		}
	}

	if source["byteIdentity"] != nil {
		validateByteIdentity(source["byteIdentity"], sizeBytes, at+".byteIdentity", p)
	}
}

func scanLocatorValue(value, at string, p *problemList) {
	if len(value) == 0 || len(value) > MaxLocatorValueLen {
		p.add("LOCATOR_VALUE_LENGTH", at)
		return
	}
	if !rePrintable.MatchString(value) {
		p.add("LOCATOR_VALUE_NOT_PRINTABLE_ASCII", at)
		return
	}
	for _, forbidden := range locatorForbiddenChars {
		if containsFold(value, forbidden) {
			p.add("LOCATOR_VALUE_URL_SHAPED", at)
			return
		}
	}
	for _, word := range locatorForbiddenWords {
		if containsFold(value, word) {
			p.add("LOCATOR_VALUE_CREDENTIAL_SHAPED", at)
			return
		}
	}
}

func containsFold(haystack, needle string) bool {
	return len(needle) > 0 && len(haystack) >= len(needle) &&
		indexFold(haystack, needle) >= 0
}

func indexFold(haystack, needle string) int {
	lowerHay := asciiLower(haystack)
	lowerNeedle := asciiLower(needle)
	for i := 0; i+len(lowerNeedle) <= len(lowerHay); i++ {
		if lowerHay[i:i+len(lowerNeedle)] == lowerNeedle {
			return i
		}
	}
	return -1
}

func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

func validateByteIdentity(value any, sizeBytes int64, at string, p *problemList) {
	identity, ok := asObject(value)
	if !ok {
		p.add("BYTE_IDENTITY_MALFORMED", at)
		return
	}
	p.checkNoUnknownKeys(identity, []string{"sizeBytes", "probeWindowBytes", "probes"}, at)
	if !integerEquals(identity["sizeBytes"], sizeBytes) {
		p.add("BYTE_IDENTITY_SIZE_MISMATCH", at+".sizeBytes")
	}
	if !integerEquals(identity["probeWindowBytes"], ProbeWindowBytes) {
		p.add("BYTE_IDENTITY_WINDOW_INVALID", at+".probeWindowBytes")
	}
	probes, ok := asArray(identity["probes"])
	if !ok {
		p.add("BYTE_IDENTITY_PROBES_MALFORMED", at+".probes")
		return
	}
	if len(probes) > MaxProbesPerSource {
		p.add("BYTE_IDENTITY_TOO_MANY_PROBES", at+".probes")
	}
	expected := ProbeOffsetsFor(sizeBytes)
	if len(probes) != len(expected) {
		p.add("BYTE_IDENTITY_PROBE_COUNT", at+".probes")
		return
	}
	for i := range expected {
		probeAt := indexAt(at+".probes", i)
		probe, ok := asObject(probes[i])
		if !ok {
			p.add("BYTE_IDENTITY_PROBE_MALFORMED", probeAt)
			continue
		}
		p.checkNoUnknownKeys(probe, []string{"position", "offset", "length", "sha256"}, probeAt)
		if s, _ := asString(probe["position"]); s != expected[i].Position {
			p.add("BYTE_IDENTITY_PROBE_POSITION", probeAt+".position")
		}
		if !integerEquals(probe["offset"], expected[i].Offset) {
			p.add("BYTE_IDENTITY_PROBE_OFFSET", probeAt+".offset")
		}
		if !integerEquals(probe["length"], expected[i].Length) {
			p.add("BYTE_IDENTITY_PROBE_LENGTH", probeAt+".length")
		}
		if !matches(probe["sha256"], reHex64) {
			p.add("BYTE_IDENTITY_PROBE_DIGEST", probeAt+".sha256")
		}
	}
}

// ---------------------------------------------------------------------------------------------------------
// Cross-entry rules. These are the ones a per-entry schema cannot express, and they are the ones that decide
// whether a namespace is coherent.
// ---------------------------------------------------------------------------------------------------------

type versionWitness struct {
	sizeBytes any
	mtime     any
	inode     any
	identity  *ByteIdentity
	hasSource bool
}

func validateCrossEntry(root map[string]any, entries []any, p *problemList) {
	byPath := map[string]bool{}
	byFolded := map[string]bool{}
	byEntryID := map[string]bool{}
	byInode := map[string]string{}
	byVersion := map[string]versionWitness{}

	for i, raw := range entries {
		entry, ok := asObject(raw)
		if !ok {
			continue
		}
		at := indexAt("entries", i)

		if path, ok := asString(entry["path"]); ok {
			if byPath[path] {
				p.add("DUPLICATE_PATH", at+".path")
			}
			byPath[path] = true
			folded := FoldProjectedPath(path)
			if byFolded[folded] {
				p.add("PATH_CASE_COLLISION", at+".path")
			}
			byFolded[folded] = true
		}
		if id, ok := asString(entry["projectedEntryId"]); ok {
			if byEntryID[id] {
				p.add("DUPLICATE_PROJECTED_ENTRY_ID", at+".projectedEntryId")
			}
			byEntryID[id] = true
		}

		versionID, versionOK := asString(entry["projectedVersionId"])
		inode, inodeOK := asString(entry["inode"])
		if versionOK && inodeOK {
			// Two DIFFERENT projected versions deriving the same ino is a 2^63 collision, not a producer
			// mistake. It is still a refusal: a namespace where two files share an inode is a namespace where
			// a media server's dedupe silently drops one of them.
			if owner, seen := byInode[inode]; seen && owner != versionID {
				p.add("INODE_COLLISION", at+".inode")
			}
			byInode[inode] = versionID
		}

		if versionOK {
			var identity *ByteIdentity
			hasSource := false
			if sources, ok := asArray(entry["sources"]); ok && len(sources) > 0 {
				hasSource = true
				if first, ok := asObject(sources[0]); ok {
					identity = buildByteIdentity(first["byteIdentity"])
				}
			}
			witness, seen := byVersion[versionID]
			if !seen {
				byVersion[versionID] = versionWitness{
					sizeBytes: entry["sizeBytes"], mtime: entry["mtime"], inode: entry["inode"],
					identity: identity, hasSource: hasSource,
				}
				continue
			}
			// Size and mtime belong to the projected VERSION, not to the entry. Two entries naming one
			// version and disagreeing about its size is the metadata instability that makes a library
			// re-scan forever.
			if !sameJSONScalar(witness.sizeBytes, entry["sizeBytes"]) {
				p.add("SHARED_VERSION_SIZE_MISMATCH", at+".sizeBytes")
			}
			if !sameJSONScalar(witness.mtime, entry["mtime"]) {
				p.add("SHARED_VERSION_MTIME_MISMATCH", at+".mtime")
			}
			if !sameJSONScalar(witness.inode, entry["inode"]) {
				p.add("SHARED_VERSION_INODE_MISMATCH", at+".inode")
			}
			if identity == nil || witness.identity == nil {
				p.add("SHARED_VERSION_BYTE_IDENTITY_REQUIRED", at+".sources[0].byteIdentity")
			} else if !witness.identity.Equal(identity) {
				p.add("SHARED_VERSION_BYTE_IDENTITY_MISMATCH", at+".sources[0].byteIdentity")
			}
		}
	}

	gen, ok := asObject(root["generation"])
	if !ok {
		return
	}
	admission, ok := asObject(gen["admission"])
	if !ok {
		return
	}
	deletions, _ := asArray(admission["deletions"])
	for i, item := range deletions {
		// A deletion generation removes an entry by naming it. An entry that is both present and deleted is a
		// producer that has not decided, and admitting it would leave the daemon to guess.
		if id, ok := asString(item); ok && byEntryID[id] {
			p.add("DELETED_ENTRY_STILL_PRESENT", indexAt("generation.admission.deletions", i))
		}
	}
}

func sameJSONScalar(a, b any) bool {
	return fmt.Sprintf("%v", a) == fmt.Sprintf("%v", b)
}

func buildByteIdentity(value any) *ByteIdentity {
	identity, ok := asObject(value)
	if !ok {
		return nil
	}
	size, sizeOK := asInteger(identity["sizeBytes"], 0, MaxSizeBytes)
	window, windowOK := asInteger(identity["probeWindowBytes"], 1, MaxSizeBytes)
	if !sizeOK || !windowOK {
		return nil
	}
	probes, ok := asArray(identity["probes"])
	if !ok {
		return nil
	}
	out := &ByteIdentity{SizeBytes: size, ProbeWindowBytes: window}
	for _, raw := range probes {
		probe, ok := asObject(raw)
		if !ok {
			return nil
		}
		position, _ := asString(probe["position"])
		offset, offsetOK := asInteger(probe["offset"], 0, MaxSizeBytes)
		length, lengthOK := asInteger(probe["length"], 0, MaxSizeBytes)
		digest, digestOK := asString(probe["sha256"])
		if !offsetOK || !lengthOK || !digestOK {
			return nil
		}
		out.Probes = append(out.Probes, ProbeDigest{Position: position, Offset: offset, Length: length, SHA256: digest})
	}
	return out
}

// ---------------------------------------------------------------------------------------------------------
// Building the typed manifest, from a tree that has already passed every rule above
// ---------------------------------------------------------------------------------------------------------

func build(root map[string]any, entries []any) *Manifest {
	gen, _ := asObject(root["generation"])
	prov, _ := asObject(gen["provenance"])
	admission, _ := asObject(gen["admission"])

	m := &Manifest{}
	m.Generation.GenerationID, _ = asString(gen["generationId"])
	m.Generation.Sequence, _ = asInteger(gen["sequence"], 1, MaxSizeBytes)
	m.Generation.CreatedAtRaw, _ = asString(gen["createdAt"])
	m.Generation.CreatedAt, _ = isTimestamp(gen["createdAt"])
	if pred, ok := asObject(gen["predecessor"]); ok {
		p := &Predecessor{}
		p.GenerationID, _ = asString(pred["generationId"])
		p.Sequence, _ = asInteger(pred["sequence"], 0, MaxSizeBytes)
		p.ManifestDigest, _ = asString(pred["manifestDigest"])
		m.Generation.Predecessor = p
	}
	m.Generation.Provenance.Producer, _ = asString(prov["producer"])
	m.Generation.Provenance.ProducerVersion, _ = asString(prov["producerVersion"])
	m.Generation.Provenance.ControlPlaneSchemaVersion, _ = asInteger(prov["controlPlaneSchemaVersion"], 0, MaxSizeBytes)
	m.Generation.Provenance.SourceSnapshotDigest, _ = asString(prov["sourceSnapshotDigest"])
	m.Generation.Provenance.ProbeWindowBytes, _ = asInteger(prov["probeWindowBytes"], 0, MaxSizeBytes)
	m.Generation.Admission.Intent, _ = asString(admission["intent"])
	m.Generation.Admission.EntryCount, _ = asInteger(admission["entryCount"], 0, MaxSizeBytes)
	m.Generation.Admission.DeletionGuardAcknowledged, _ = admission["deletionGuardAcknowledged"].(bool)
	m.Generation.Admission.DeletionGuardDigest, _ = asString(admission["deletionGuardDigest"])
	if deletions, ok := asArray(admission["deletions"]); ok {
		for _, item := range deletions {
			if id, ok := asString(item); ok {
				m.Generation.Admission.Deletions = append(m.Generation.Admission.Deletions, id)
			}
		}
	}

	for _, raw := range entries {
		e, _ := asObject(raw)
		entry := Entry{}
		entry.ProjectedEntryID, _ = asString(e["projectedEntryId"])
		entry.LogicalMediaID, _ = asString(e["logicalMediaId"])
		entry.ProjectedVersionID, _ = asString(e["projectedVersionId"])
		entry.Path, _ = asString(e["path"])
		entry.NodeKind, _ = asString(e["nodeKind"])
		entry.SizeBytes, _ = asInteger(e["sizeBytes"], 0, MaxSizeBytes)
		entry.MtimeRaw, _ = asString(e["mtime"])
		entry.Mtime, _ = isTimestamp(e["mtime"])
		mode, _ := asInteger(e["mode"], 0, 0xffff)
		entry.Mode = uint32(mode)
		inodeString, _ := asString(e["inode"])
		entry.Inode, _ = strconv.ParseUint(inodeString, 10, 64)
		entry.Visibility, _ = asString(e["visibility"])
		if d, ok := asObject(e["degraded"]); ok {
			state := &DegradedState{}
			state.Reason, _ = asString(d["reason"])
			state.Since, _ = isTimestamp(d["since"])
			entry.Degraded = state
		}
		if r, ok := asObject(e["retiring"]); ok {
			state := &RetiringState{}
			state.DeletionIntentID, _ = asString(r["deletionIntentId"])
			state.DeclaredAt, _ = isTimestamp(r["declaredAt"])
			state.GraceDeadline, _ = isTimestamp(r["graceDeadline"])
			entry.Retiring = state
		}
		if sources, ok := asArray(e["sources"]); ok {
			for _, rawSource := range sources {
				s, _ := asObject(rawSource)
				source := Source{}
				source.SourceID, _ = asString(s["sourceId"])
				source.Kind, _ = asString(s["kind"])
				pref, _ := asInteger(s["preference"], 0, MaxSourcesPerEntry)
				source.Preference = int(pref)
				source.SourceGeneration, _ = asInteger(s["sourceGeneration"], 0, MaxSizeBytes)
				if l, ok := asObject(s["locator"]); ok {
					source.Locator.RootID, _ = asString(l["rootId"])
					source.Locator.RelativePath, _ = asString(l["relativePath"])
					source.Locator.EndpointID, _ = asString(l["endpointId"])
					source.Locator.ObjectRef, _ = asString(l["objectRef"])
				}
				source.ByteIdentity = buildByteIdentity(s["byteIdentity"])
				entry.Sources = append(entry.Sources, source)
			}
			sort.SliceStable(entry.Sources, func(i, j int) bool {
				return entry.Sources[i].Preference < entry.Sources[j].Preference
			})
		}
		m.Entries = append(m.Entries, entry)
	}
	return m
}
