import { createHash } from 'node:crypto';

import {
  canonicalJson,
  deletionAcknowledgementDigest,
  deriveGenerationId,
  deriveInode,
  manifestContentDigest,
  manifestDigestOfBytes,
  normalizeProjectedPath,
  serializeManifestArtifact,
  validateManifestV1,
  validateSuccession,
  PROJECTION_MANIFEST_FORMAT,
  PROJECTION_MANIFEST_VERSION,
  PROJECTION_PROBE_PLAN,
  PROJECTION_SHRINK_GUARD,
  type AdmittedGeneration,
  type ByteIdentity,
  type DegradedState,
  type HttpRangeLocator,
  type LocalLocator,
  type ManifestProblem,
  type ProbeDigest,
  type ProjectedEntry,
  type ProjectionGenerationIntent,
  type ProjectionManifestV1,
  type ProjectionSource,
  type ProjectionSourceKind,
} from './manifest-v1.js';

// Projection Phase 1 — turning one consistent PostgreSQL snapshot into one candidate generation.
//
// WHAT THIS MODULE IS. A pure function from (snapshot, predecessor, clock, intent) to (artifact bytes, or a
// list of problems). It opens no file, makes no network call, reads no clock and touches no database: every
// input arrives as an argument, which is what makes a generation reproducible by a reviewer and what makes a
// retry produce the SAME bytes rather than equivalent ones.
//
// WHY IT DOES NOT RE-IMPLEMENT ADMISSION. Every rule the daemon enforces is enforced here by CALLING the
// daemon's own contract — `validateManifestV1` and `validateSuccession` out of `manifest-v1.ts`, the same
// functions the fixture corpus and the Go port are checked against. A producer with its own idea of what is
// admissible is a producer that eventually publishes something the daemon refuses, and the refusal surfaces at
// the mount rather than at the publish. Anything below that looks like a check is a check the CONTRACT cannot
// express because it is about the snapshot rather than about the manifest — a missing version row, a locator
// naming an unconfigured root, a deletion of something that was never retiring.
//
// FAILURE IS ALWAYS "NO GENERATION". There is no partial build and no repair. A snapshot that cannot produce
// an admissible generation produces problems, and the daemon goes on serving what it already has — which is
// the same thing it does when this control plane is switched off, and is the reason a bad publish is a
// non-event rather than an outage.

/** The producer identity every generation carries. Semantic version; it is provenance, not a feature flag. */
export const PROJECTION_PRODUCER = 'catalog-authority';
export const PROJECTION_PRODUCER_VERSION = '1.0.0';

/** How an artifact is named on disk. The generation id is in the name, so no two generations share a file. */
export function artifactNameFor(sequence: number, generationId: string): string {
  return `generation-${sequence}-${generationId.slice('gen_'.length)}.json`;
}

export interface SnapshotProbe {
  readonly position: string;
  readonly offset: number;
  readonly length: number;
  readonly sha256: string;
}

export interface SnapshotVersion {
  readonly projectedVersionId: string;
  readonly versionKey: string;
  readonly sizeBytes: number;
  readonly mtime: string;
  readonly probeWindowBytes: number | null;
  readonly probes: readonly SnapshotProbe[] | null;
}

export interface SnapshotSource {
  readonly sourceId: string;
  readonly kind: ProjectionSourceKind;
  readonly preference: number;
  readonly sourceGeneration: number;
  readonly rootId: string;
  readonly objectRef: string;
}

export interface SnapshotEntry {
  readonly projectedEntryId: string;
  readonly itemId: string;
  readonly projectedVersionId: string;
  readonly path: string;
  readonly visibility: 'available' | 'degraded' | 'retiring';
  readonly degradedReason: string | null;
  readonly degradedSince: string | null;
  readonly deletionIntentId: string | null;
  readonly retiringDeclaredAt: string | null;
  readonly graceDeadline: string | null;
  readonly sources: readonly SnapshotSource[];
}

export interface SnapshotRoot {
  readonly rootId: string;
  readonly kind: ProjectionSourceKind;
}

/** Everything a generation is computed from. One read, one transaction, one consistent picture. */
export interface PublishSnapshot {
  readonly roots: readonly SnapshotRoot[];
  readonly versions: readonly SnapshotVersion[];
  /** The LIVE entries — those no published deletion generation has tombstoned. */
  readonly entries: readonly SnapshotEntry[];
}

export interface PreviousGeneration extends AdmittedGeneration {
  readonly sequence: number;
  /** What the predecessor SAYS, as recorded when it was published. The "has anything changed" comparison. */
  readonly contentDigest: string;
}

export interface BuildRequest {
  readonly snapshot: PublishSnapshot;
  /** The generation the control plane currently says is current, or null before the first publish. */
  readonly previous: PreviousGeneration | null;
  /** The producer's clock, supplied rather than read. A module that reads a clock cannot be tested. */
  readonly nowIso: string;
  readonly intent: ProjectionGenerationIntent;
  /** Only meaningful for a `deletion` intent. Ids of entries to remove from the namespace. */
  readonly deletions?: readonly string[];
  /** The operator's explicit acknowledgement of a large deletion set (Phase 0 admission check 12). */
  readonly deletionGuardAcknowledged?: boolean;
  readonly controlPlaneSchemaVersion: number;
  readonly producerVersion?: string;
}

export interface BuildResult {
  readonly ok: boolean;
  readonly problems: readonly ManifestProblem[];
  readonly manifest: ProjectionManifestV1 | null;
  /** The EXACT bytes. What gets fsync'd, what gets digested, what the pointer names. */
  readonly artifact: Buffer | null;
  readonly manifestDigest: string | null;
  /** What this generation SAYS, ignoring which generation it is. Equal digests mean nothing changed. */
  readonly contentDigest: string | null;
  readonly snapshotDigest: string;
  readonly sequence: number;
  readonly generationId: string | null;
  /** True when the predecessor already says exactly this. A publish then mints nothing. */
  readonly unchanged: boolean;
  readonly additions: readonly string[];
  readonly deletions: readonly string[];
}

/**
 * The digest of the snapshot a generation was computed from.
 *
 * It covers everything the build reads and nothing else, so two builds over the same catalog state produce the
 * same value and a build over a moved one cannot. It is provenance: a reviewer holding two manifests can tell
 * "the catalog changed" from "the producer changed" without either manifest naming a path.
 */
export function snapshotDigestOf(snapshot: PublishSnapshot): string {
  const body = canonicalJson({
    roots: [...snapshot.roots].sort((a, b) => (a.rootId < b.rootId ? -1 : 1)),
    versions: [...snapshot.versions].sort((a, b) =>
      (a.projectedVersionId < b.projectedVersionId ? -1 : 1)),
    entries: [...snapshot.entries]
      .map((entry) => ({ ...entry, sources: [...entry.sources].sort((a, b) => a.preference - b.preference) }))
      .sort((a, b) => (a.projectedEntryId < b.projectedEntryId ? -1 : 1)),
  });
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

function locatorFor(source: SnapshotSource): LocalLocator | HttpRangeLocator {
  return source.kind === 'local'
    ? { rootId: source.rootId, relativePath: source.objectRef }
    : { endpointId: source.rootId, objectRef: source.objectRef };
}

function byteIdentityFor(version: SnapshotVersion): ByteIdentity | null {
  if (version.probes === null || version.probeWindowBytes === null) return null;
  const probes: ProbeDigest[] = version.probes.map((probe) => ({
    position: probe.position as ProbeDigest['position'],
    offset: probe.offset,
    length: probe.length,
    sha256: probe.sha256,
  }));
  return { sizeBytes: version.sizeBytes, probeWindowBytes: version.probeWindowBytes, probes };
}

/**
 * Build one candidate generation from one snapshot.
 *
 * The order of the checks is the order in which a problem is worth reporting: snapshot coherence first
 * (a manifest cannot be assembled from rows that do not join), then the contract's own static admission, then
 * succession against the predecessor. Each stage returns everything it found; none of them repairs anything.
 */
export function buildGeneration(request: BuildRequest): BuildResult {
  const { snapshot, previous, nowIso, intent } = request;
  const snapshotDigest = snapshotDigestOf(snapshot);
  const requestedDeletions = [...new Set(request.deletions ?? [])].sort();
  const sequence = previous === null ? 1 : previous.sequence + 1;
  const problems: ManifestProblem[] = [];
  const fail = (code: string, at: string): void => { problems.push({ code, at }); };
  const empty = (extra: Partial<BuildResult> = {}): BuildResult => ({
    ok: false, problems, manifest: null, artifact: null, manifestDigest: null, contentDigest: null,
    snapshotDigest, sequence, generationId: null, unchanged: false, additions: [], deletions: [], ...extra,
  });

  const rootKinds = new Map(snapshot.roots.map((root) => [root.rootId, root.kind]));
  const versions = new Map(snapshot.versions.map((version) => [version.projectedVersionId, version]));

  // How many LIVE entries name each version, computed before deletions are applied? No — after, because
  // "shared" means shared in the generation being published, and byte identity is required on the sources of
  // an entry whose version appears more than once IN IT.
  const deletionSet = new Set(requestedDeletions);
  if (intent === 'routine' && requestedDeletions.length > 0) {
    fail('PRODUCER_ROUTINE_GENERATION_DELETES', 'deletions');
  }
  if (intent === 'deletion' && requestedDeletions.length === 0) {
    fail('PRODUCER_DELETION_GENERATION_EMPTY', 'deletions');
  }

  // A DELETION IS ONLY EVER A REMOVAL OF SOMETHING AFFIRMATIVELY RETIRING. The daemon checks this too, against
  // its own predecessor; checking it here as well means the operator hears "that entry is not retiring" at the
  // moment they asked, rather than watching a generation be refused at a mount they cannot see.
  const byId = new Map(snapshot.entries.map((entry) => [entry.projectedEntryId, entry]));
  for (const id of requestedDeletions) {
    const entry = byId.get(id);
    if (entry === undefined) { fail('PRODUCER_DELETION_NAMES_UNKNOWN_ENTRY', `deletion:${id.slice(0, 11)}`); continue; }
    if (entry.visibility !== 'retiring' || entry.graceDeadline === null) {
      fail('PRODUCER_DELETION_ENTRY_NOT_RETIRING', `deletion:${id.slice(0, 11)}`);
      continue;
    }
    if (Date.parse(entry.graceDeadline) > Date.parse(nowIso)) {
      fail('PRODUCER_DELETION_GRACE_NOT_ELAPSED', `deletion:${id.slice(0, 11)}`);
    }
  }

  const retained = snapshot.entries.filter((entry) => !deletionSet.has(entry.projectedEntryId));
  const versionUse = new Map<string, number>();
  for (const entry of retained) {
    versionUse.set(entry.projectedVersionId, (versionUse.get(entry.projectedVersionId) ?? 0) + 1);
  }

  const entries: ProjectedEntry[] = [];
  for (const entry of [...retained].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const at = `entry:${entry.projectedEntryId.slice(0, 11)}`;
    const version = versions.get(entry.projectedVersionId);
    if (version === undefined) { fail('PRODUCER_VERSION_ROW_MISSING', at); continue; }
    // The path is checked here as well as at admission because a path that cannot be normalized would
    // otherwise be reported against an index in a document nobody has yet, instead of against the row.
    if (!normalizeProjectedPath(entry.path).ok) { fail('PRODUCER_PATH_NOT_NORMALIZED', at); continue; }
    if (entry.sources.length === 0) { fail('PRODUCER_ENTRY_HAS_NO_SOURCE', at); continue; }

    const identity = byteIdentityFor(version);
    const shared = (versionUse.get(entry.projectedVersionId) ?? 0) > 1;
    if (identity === null && (entry.sources.length > 1 || shared)) {
      // Two locators pointing at bytes nobody compared are two DIFFERENT byte streams wearing one id, and a
      // mid-handle failover between them would hand a player the middle of a different file.
      fail('PRODUCER_BYTE_IDENTITY_REQUIRED', at);
      continue;
    }

    const sources: ProjectionSource[] = [];
    for (const source of [...entry.sources].sort((a, b) => a.preference - b.preference)) {
      const kind = rootKinds.get(source.rootId);
      if (kind === undefined) { fail('PRODUCER_LOCATOR_ROOT_NOT_REGISTERED', at); continue; }
      if (kind !== source.kind) { fail('PRODUCER_LOCATOR_KIND_DISAGREES_WITH_ROOT', at); continue; }
      sources.push({
        sourceId: source.sourceId,
        kind: source.kind,
        preference: source.preference,
        sourceGeneration: source.sourceGeneration,
        locator: locatorFor(source),
        byteIdentity: identity,
      });
    }
    if (sources.length !== entry.sources.length) continue;

    entries.push({
      projectedEntryId: entry.projectedEntryId,
      logicalMediaId: entry.itemId,
      projectedVersionId: entry.projectedVersionId,
      path: entry.path,
      nodeKind: 'file',
      sizeBytes: version.sizeBytes,
      mtime: version.mtime,
      mode: 0o444,
      readOnly: true,
      inode: deriveInode(entry.projectedVersionId),
      visibility: entry.visibility,
      // The state's evidence travels with it, exactly as it was asserted. An empty string where a timestamp
      // belongs is left to fail the contract's own validator rather than repaired into something plausible:
      // a repaired timestamp is a lie about when the control plane observed something.
      degraded: entry.visibility === 'degraded'
        ? {
          reason: (entry.degradedReason ?? '') as DegradedState['reason'],
          since: entry.degradedSince ?? '',
        }
        : null,
      retiring: entry.visibility === 'retiring'
        ? {
          deletionIntentId: entry.deletionIntentId ?? '',
          declaredAt: entry.retiringDeclaredAt ?? '',
          graceDeadline: entry.graceDeadline ?? '',
        }
        : null,
      sources,
    });
  }
  if (problems.length > 0) return empty();

  const contentDigest = manifestContentDigest(intent, entries, requestedDeletions);

  // NOTHING CHANGED IS NOT A GENERATION. Publishing one would burn a sequence, rewrite a pointer and make every
  // reader re-read an artifact that says exactly what the last one said. The publisher reports it and stops.
  if (previous !== null && previous.contentDigest === contentDigest) {
    return {
      ok: true, problems: [], manifest: previous.manifest, artifact: null,
      manifestDigest: previous.manifestDigest, contentDigest, snapshotDigest,
      sequence: previous.sequence, generationId: previous.manifest.generation.generationId,
      unchanged: true, additions: [], deletions: [],
    };
  }

  const guardBudget = Math.max(
    PROJECTION_SHRINK_GUARD.MAX_DELETIONS_ABSOLUTE,
    Math.floor((previous?.manifest.entries.length ?? 0) * PROJECTION_SHRINK_GUARD.MAX_DELETIONS_FRACTION),
  );
  const guardRequired = requestedDeletions.length > guardBudget;
  const guardAcknowledged = request.deletionGuardAcknowledged === true;
  if (guardRequired && !guardAcknowledged) {
    fail('PRODUCER_SHRINK_GUARD_UNACKNOWLEDGED', 'deletions');
    return empty();
  }

  const predecessorDigest = previous?.manifestDigest ?? null;
  const generationId = deriveGenerationId(sequence, contentDigest, predecessorDigest);
  const candidate: ProjectionManifestV1 = {
    format: PROJECTION_MANIFEST_FORMAT,
    version: PROJECTION_MANIFEST_VERSION,
    generation: {
      generationId,
      sequence,
      createdAt: nowIso,
      predecessor: previous === null ? null : {
        generationId: previous.manifest.generation.generationId,
        sequence: previous.sequence,
        manifestDigest: previous.manifestDigest,
      },
      provenance: {
        producer: PROJECTION_PRODUCER,
        producerVersion: request.producerVersion ?? PROJECTION_PRODUCER_VERSION,
        controlPlaneSchemaVersion: request.controlPlaneSchemaVersion,
        sourceSnapshotDigest: snapshotDigest,
        probeWindowBytes: PROJECTION_PROBE_PLAN.WINDOW_BYTES,
      },
      admission: {
        intent,
        entryCount: entries.length,
        deletions: requestedDeletions,
        deletionGuardAcknowledged: guardAcknowledged && guardRequired,
        deletionGuardDigest: guardAcknowledged && guardRequired
          ? deletionAcknowledgementDigest(requestedDeletions) : null,
      },
    },
    entries,
  };

  // THE CONTRACT'S OWN VALIDATOR, not a second opinion. If this refuses, the daemon would have refused too.
  const staticCheck = validateManifestV1(JSON.parse(JSON.stringify(candidate)) as unknown);
  if (!staticCheck.ok) return empty({ problems: staticCheck.problems, generationId });

  let additions: readonly string[] = entries.map((entry) => entry.projectedEntryId).sort();
  let deletions: readonly string[] = [];
  if (previous !== null) {
    const succession = validateSuccession(previous, staticCheck.manifest as ProjectionManifestV1, nowIso);
    if (!succession.ok) return empty({ problems: succession.problems, generationId });
    additions = succession.additions;
    deletions = succession.deletions;
  }

  const artifact = serializeManifestArtifact(staticCheck.manifest as ProjectionManifestV1);
  return {
    ok: true,
    problems: [],
    manifest: staticCheck.manifest,
    artifact,
    manifestDigest: manifestDigestOfBytes(artifact),
    contentDigest,
    snapshotDigest,
    sequence,
    generationId,
    unchanged: false,
    additions,
    deletions,
  };
}
