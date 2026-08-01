import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalJson,
  deriveDeletionIntentId,
  deriveGenerationId,
  deriveInode,
  deriveProjectedEntryId,
  deriveProjectedVersionId,
  deriveSourceId,
  manifestContentDigest,
  manifestDigestOfBytes,
  probeOffsetsFor,
  serializeManifestArtifact,
  validateManifestV1,
  PROJECTION_ID_DOMAINS,
  PROJECTION_PROBE_PLAN,
  type ProjectionManifestV1,
} from '../src/core/projection/manifest-v1.js';
import {
  artifactMatches, directorySyncFailureIsFatal, ensureArtifact, readExact, readPointer, serializePointer,
  writeDurable, writePointer,
  POINTER_FILE_NAME,
} from '../src/core/projection/artifact-store.js';
import {
  artifactNameFor, buildGeneration, snapshotDigestOf,
  type PreviousGeneration, type PublishSnapshot, type SnapshotEntry, type SnapshotVersion,
} from '../src/core/projection/publisher.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';

// Projection Phase 1 — the publisher's offline suite.
//
// EVERYTHING HERE IS PURE OR TOUCHES ONE TEMPORARY DIRECTORY. No database, no daemon, no Docker: the rules
// this file proves are the ones that decide whether a generation can exist at all, and they are decidable
// from values. The database integration lives in `projection-publisher-db.ts` and the end-to-end mount in
// `deploy/projection-publisher-mount-gate.sh`, because those prove different things and a suite that needs a
// server to prove an arithmetic rule is a suite that stops running.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`);
}
function assertHasProblem(problems: readonly { code: string }[], code: string, msg: string): void {
  if (!problems.some((problem) => problem.code === code)) {
    throw new Error(`${msg}: expected ${code}, got ${problems.map((p) => p.code).join(', ') || 'none'}`);
  }
}

console.log('Running projection publisher suite:\n');

const NOW = '2026-07-01T12:00:00.000Z';
const MTIME = '2026-06-01T10:00:00.000Z';
const ITEM_A = '11111111-1111-4111-8111-111111111111';
const ITEM_B = '22222222-2222-4222-8222-222222222222';

const hex64 = (seed: string): string => createHash('sha256').update(seed).digest('hex');

function versionOf(key: string, sizeBytes: number, withProbes: boolean): SnapshotVersion {
  const probes = probeOffsetsFor(sizeBytes).map((slot) => ({
    position: slot.position, offset: slot.offset, length: slot.length, sha256: hex64(`${key}:${slot.position}`),
  }));
  return {
    projectedVersionId: deriveProjectedVersionId(key),
    versionKey: key,
    sizeBytes,
    mtime: MTIME,
    probeWindowBytes: withProbes ? PROJECTION_PROBE_PLAN.WINDOW_BYTES : null,
    probes: withProbes ? probes : null,
  };
}

function entryOf(
  path: string, versionKey: string, itemId: string,
  sources: Array<{ kind: 'local' | 'http-range'; rootId: string; objectRef: string }>,
  overrides: Partial<SnapshotEntry> = {},
): SnapshotEntry {
  return {
    projectedEntryId: deriveProjectedEntryId(path),
    itemId,
    projectedVersionId: deriveProjectedVersionId(versionKey),
    path,
    visibility: 'available',
    degradedReason: null,
    degradedSince: null,
    deletionIntentId: null,
    retiringDeclaredAt: null,
    graceDeadline: null,
    sources: sources.map((source, index) => ({
      sourceId: deriveSourceId(source.kind, source.kind === 'local'
        ? { rootId: source.rootId, relativePath: source.objectRef }
        : { endpointId: source.rootId, objectRef: source.objectRef }),
      kind: source.kind,
      preference: index,
      sourceGeneration: 1,
      rootId: source.rootId,
      objectRef: source.objectRef,
    })),
    ...overrides,
  };
}

const ROOTS = [
  { rootId: 'media', kind: 'local' as const },
  { rootId: 'vault', kind: 'http-range' as const },
];

/** The baseline snapshot: one local entry and one HTTP Range entry, which is the Phase 1 pair. */
function baselineSnapshot(): PublishSnapshot {
  return {
    roots: ROOTS,
    versions: [versionOf('local-a', 3 * 1024 * 1024, false), versionOf('remote-b', 4 * 1024 * 1024, true)],
    entries: [
      entryOf('Movies/Local A/Local A.bin', 'local-a', ITEM_A, [{ kind: 'local', rootId: 'media', objectRef: 'local-a.bin' }]),
      entryOf('Movies/Remote B/Remote B.bin', 'remote-b', ITEM_B, [{ kind: 'http-range', rootId: 'vault', objectRef: 'obj-remote-b' }]),
    ],
  };
}

function buildFirst(snapshot: PublishSnapshot = baselineSnapshot()): ReturnType<typeof buildGeneration> {
  return buildGeneration({ snapshot, previous: null, nowIso: NOW, intent: 'routine', controlPlaneSchemaVersion: 10 });
}

function asPrevious(built: ReturnType<typeof buildGeneration>): PreviousGeneration {
  return {
    manifest: built.manifest as ProjectionManifestV1,
    manifestDigest: built.manifestDigest as string,
    sequence: built.sequence,
    contentDigest: built.contentDigest as string,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Identity derivation — the amendment this phase added to the contract
// ---------------------------------------------------------------------------------------------------------

test('every derived id has the shape the contract froze', () => {
  assert(/^pe_[0-9a-f]{64}$/.test(deriveProjectedEntryId('Movies/A/A.bin')), 'entry id');
  assert(/^pv_[0-9a-f]{64}$/.test(deriveProjectedVersionId('movie-a')), 'version id');
  assert(/^src_[0-9a-f]{32}$/.test(deriveSourceId('local', { rootId: 'media', relativePath: 'a.bin' })), 'source id');
  assert(/^gen_[0-9a-f]{32}$/.test(deriveGenerationId(1, `sha256:${hex64('c')}`, null)), 'generation id');
  assert(/^[0-9a-f]{32}$/.test(deriveDeletionIntentId('drop-a')), 'deletion intent id');
});

test('derivation is a pure function of its stated input, and nothing else', () => {
  assertEq(deriveProjectedEntryId('Movies/A/A.bin'), deriveProjectedEntryId('Movies/A/A.bin'), 'stable');
  assert(deriveProjectedEntryId('Movies/A/A.bin') !== deriveProjectedEntryId('Movies/B/A.bin'), 'path-sensitive');
  assertEq(deriveGenerationId(2, 'sha256:aa', 'sha256:bb'), deriveGenerationId(2, 'sha256:aa', 'sha256:bb'),
    'a retry over the same inputs derives the same generation');
  assert(deriveGenerationId(2, 'sha256:aa', 'sha256:bb') !== deriveGenerationId(3, 'sha256:aa', 'sha256:bb'),
    'a different sequence is a different generation');
});

test('the domains are distinct, so no two id spaces can ever collide by construction', () => {
  const domains = Object.values(PROJECTION_ID_DOMAINS);
  assertEq(new Set(domains).size, domains.length, 'every domain separator is unique');
  // The same input under two domains must not produce the same digest body.
  assert(deriveProjectedEntryId('x').slice(3) !== deriveProjectedVersionId('x').slice(3),
    'one input under two domains derives two different ids');
});

test('a source id follows the locator, because a source carries no identity of its own', () => {
  const a = deriveSourceId('local', { rootId: 'media', relativePath: 'a.bin' });
  assertEq(a, deriveSourceId('local', { rootId: 'media', relativePath: 'a.bin' }), 'same locator, same id');
  assert(a !== deriveSourceId('local', { rootId: 'media', relativePath: 'b.bin' }), 'different object, different id');
  assert(a !== deriveSourceId('http-range', { endpointId: 'media', objectRef: 'a.bin' }), 'kind participates');
});

// ---------------------------------------------------------------------------------------------------------
// Serialization and digests
// ---------------------------------------------------------------------------------------------------------

test('the artifact bytes are canonical, terminated and reproducible', () => {
  const built = buildFirst();
  const artifact = built.artifact as Buffer;
  assertEq(artifact[artifact.length - 1], 0x0a, 'the artifact ends in a newline');
  const reparsed = JSON.parse(artifact.toString('utf8')) as unknown;
  assertEq(canonicalJson(reparsed), canonicalJson(built.manifest), 'the bytes round-trip to the manifest');
  assertEq(serializeManifestArtifact(built.manifest as ProjectionManifestV1).toString('utf8'),
    artifact.toString('utf8'), 'serializing twice produces the same bytes');
  assertEq(built.manifestDigest, manifestDigestOfBytes(artifact), 'the digest is over the exact bytes');
});

test('the content digest ignores which generation it is, and nothing else', () => {
  const built = buildFirst();
  const manifest = built.manifest as ProjectionManifestV1;
  const direct = manifestContentDigest('routine', manifest.entries, []);
  assertEq(built.contentDigest, direct, 'the content digest is over intent, entries and deletions');
  // Entry ORDER must not change it: two producers that sorted differently must agree about "unchanged".
  const shuffled = [...manifest.entries].reverse();
  assertEq(manifestContentDigest('routine', shuffled, []), direct, 'order-independent');
  assert(manifestContentDigest('deletion', manifest.entries, ['pe_' + hex64('x')]) !== direct, 'intent participates');
});

test('the snapshot digest changes when the snapshot does and not when it is merely reordered', () => {
  const snapshot = baselineSnapshot();
  const reordered: PublishSnapshot = {
    roots: [...snapshot.roots].reverse(),
    versions: [...snapshot.versions].reverse(),
    entries: [...snapshot.entries].reverse(),
  };
  assertEq(snapshotDigestOf(snapshot), snapshotDigestOf(reordered), 'reordering is not a change');
  const moved: PublishSnapshot = { ...snapshot, versions: [versionOf('local-a', 4096, false), snapshot.versions[1] as SnapshotVersion] };
  assert(snapshotDigestOf(snapshot) !== snapshotDigestOf(moved), 'a changed size is a change');
});

// ---------------------------------------------------------------------------------------------------------
// The happy path, and the properties a generation must carry
// ---------------------------------------------------------------------------------------------------------

test('a first generation admits under the contract that the daemon enforces', () => {
  const built = buildFirst();
  assert(built.ok, `the baseline builds: ${built.problems.map((p) => p.code).join(', ')}`);
  const manifest = built.manifest as ProjectionManifestV1;
  assertEq(manifest.generation.sequence, 1, 'the first sequence is 1');
  assertEq(manifest.generation.predecessor, null, 'and it has no predecessor');
  assertEq(manifest.entries.length, 2, 'both entries are projected');
  assertEq(validateManifestV1(JSON.parse((built.artifact as Buffer).toString('utf8'))).ok, true,
    'the published bytes pass the contract validator');
});

test('the local and the HTTP Range shapes ship in the same generation, and are indistinguishable in kind', () => {
  const manifest = buildFirst().manifest as ProjectionManifestV1;
  const kinds = manifest.entries.flatMap((entry) => entry.sources.map((source) => source.kind)).sort();
  assertEq(canonicalJson(kinds), canonicalJson(['http-range', 'local']), 'one of each');
  for (const entry of manifest.entries) {
    assertEq(entry.nodeKind, 'file', 'every entry is a regular file');
    assertEq(entry.mode, 0o444, 'and read-only in its mode bits');
    assertEq(entry.readOnly, true, 'and in its flag');
  }
});

test('the inode is derived from the projected version and from nothing else', () => {
  const manifest = buildFirst().manifest as ProjectionManifestV1;
  for (const entry of manifest.entries) {
    assertEq(entry.inode, deriveInode(entry.projectedVersionId), 'inode is derived');
  }
});

test('a locator carries no lifetime, no URL and no credential anywhere in a built generation', () => {
  const artifact = (buildFirst().artifact as Buffer).toString('utf8');
  for (const forbidden of ['expiresAt', 'expires', 'token', 'Authorization', 'Bearer', '://', 'signature', 'lease']) {
    assert(!artifact.toLowerCase().includes(forbidden.toLowerCase()),
      `the artifact contains ${forbidden}, which is ephemeral access material or a URL`);
  }
});

test('two entries may share one projected version only with identical byte-identity proof', () => {
  const shared = versionOf('shared', 8 * 1024 * 1024, true);
  const built = buildGeneration({
    snapshot: {
      roots: ROOTS,
      versions: [shared],
      entries: [
        entryOf('Movies/One/One.bin', 'shared', ITEM_A, [{ kind: 'local', rootId: 'media', objectRef: 'one.bin' }]),
        entryOf('Movies/Two/Two.bin', 'shared', ITEM_B, [{ kind: 'http-range', rootId: 'vault', objectRef: 'obj-two' }]),
      ],
    },
    previous: null, nowIso: NOW, intent: 'routine', controlPlaneSchemaVersion: 10,
  });
  assert(built.ok, `a proven shared version admits: ${built.problems.map((p) => p.code).join(', ')}`);
  const manifest = built.manifest as ProjectionManifestV1;
  assertEq(manifest.entries[0]?.inode, manifest.entries[1]?.inode, 'one version is one inode');
});

test('an unproven shared version is refused rather than published', () => {
  const built = buildGeneration({
    snapshot: {
      roots: ROOTS,
      versions: [versionOf('shared', 8 * 1024 * 1024, false)],
      entries: [
        entryOf('Movies/One/One.bin', 'shared', ITEM_A, [{ kind: 'local', rootId: 'media', objectRef: 'one.bin' }]),
        entryOf('Movies/Two/Two.bin', 'shared', ITEM_B, [{ kind: 'local', rootId: 'media', objectRef: 'two.bin' }]),
      ],
    },
    previous: null, nowIso: NOW, intent: 'routine', controlPlaneSchemaVersion: 10,
  });
  assert(!built.ok, 'refused');
  assertHasProblem(built.problems, 'PRODUCER_BYTE_IDENTITY_REQUIRED', 'and named');
});

test('an entry with two sources needs proof, and gets it from its version', () => {
  const unproven = buildGeneration({
    snapshot: {
      roots: ROOTS,
      versions: [versionOf('dual', 5 * 1024 * 1024, false)],
      entries: [entryOf('Movies/Dual/Dual.bin', 'dual', ITEM_A, [
        { kind: 'local', rootId: 'media', objectRef: 'dual.bin' },
        { kind: 'http-range', rootId: 'vault', objectRef: 'obj-dual' },
      ])],
    },
    previous: null, nowIso: NOW, intent: 'routine', controlPlaneSchemaVersion: 10,
  });
  assertHasProblem(unproven.problems, 'PRODUCER_BYTE_IDENTITY_REQUIRED', 'two locators nobody compared');

  const proven = buildGeneration({
    snapshot: {
      roots: ROOTS,
      versions: [versionOf('dual', 5 * 1024 * 1024, true)],
      entries: [entryOf('Movies/Dual/Dual.bin', 'dual', ITEM_A, [
        { kind: 'local', rootId: 'media', objectRef: 'dual.bin' },
        { kind: 'http-range', rootId: 'vault', objectRef: 'obj-dual' },
      ])],
    },
    previous: null, nowIso: NOW, intent: 'routine', controlPlaneSchemaVersion: 10,
  });
  assert(proven.ok, `proof admits it: ${proven.problems.map((p) => p.code).join(', ')}`);
  const sources = (proven.manifest as ProjectionManifestV1).entries[0]?.sources ?? [];
  assertEq(canonicalJson(sources[0]?.byteIdentity), canonicalJson(sources[1]?.byteIdentity),
    'both sources carry the identical proof, which is what a mid-handle failover requires');
});

// ---------------------------------------------------------------------------------------------------------
// Producer refusals — the snapshot problems the contract cannot express
// ---------------------------------------------------------------------------------------------------------

test('an entry whose version row is missing is refused, not published with a guessed size', () => {
  const snapshot = baselineSnapshot();
  const built = buildGeneration({
    snapshot: { ...snapshot, versions: [snapshot.versions[0] as SnapshotVersion] },
    previous: null, nowIso: NOW, intent: 'routine', controlPlaneSchemaVersion: 10,
  });
  assertHasProblem(built.problems, 'PRODUCER_VERSION_ROW_MISSING', 'refused');
  assertEq(built.artifact, null, 'and nothing was built');
});

test('a locator naming an unconfigured root is refused', () => {
  const snapshot = baselineSnapshot();
  const built = buildGeneration({
    snapshot: { ...snapshot, roots: [{ rootId: 'media', kind: 'local' }] },
    previous: null, nowIso: NOW, intent: 'routine', controlPlaneSchemaVersion: 10,
  });
  assertHasProblem(built.problems, 'PRODUCER_LOCATOR_ROOT_NOT_REGISTERED', 'refused');
});

test('a source whose kind disagrees with its root is refused', () => {
  const snapshot = baselineSnapshot();
  const entry = entryOf('Movies/Mixed/Mixed.bin', 'local-a', ITEM_A, [{ kind: 'local', rootId: 'vault', objectRef: 'x.bin' }]);
  const built = buildGeneration({
    snapshot: { ...snapshot, entries: [entry] },
    previous: null, nowIso: NOW, intent: 'routine', controlPlaneSchemaVersion: 10,
  });
  assertHasProblem(built.problems, 'PRODUCER_LOCATOR_KIND_DISAGREES_WITH_ROOT', 'refused');
});

test('an entry with no source is refused: a file that answers EIO forever is not a namespace', () => {
  const snapshot = baselineSnapshot();
  const built = buildGeneration({
    snapshot: { ...snapshot, entries: [entryOf('Movies/None/None.bin', 'local-a', ITEM_A, [])] },
    previous: null, nowIso: NOW, intent: 'routine', controlPlaneSchemaVersion: 10,
  });
  assertHasProblem(built.problems, 'PRODUCER_ENTRY_HAS_NO_SOURCE', 'refused');
});

test('an un-normalized path is refused at the row, not repaired', () => {
  const snapshot = baselineSnapshot();
  const bad = { ...entryOf('Movies/A/A.bin', 'local-a', ITEM_A, [{ kind: 'local' as const, rootId: 'media', objectRef: 'a.bin' }]), path: 'Movies//A.bin' };
  const built = buildGeneration({
    snapshot: { ...snapshot, entries: [bad] },
    previous: null, nowIso: NOW, intent: 'routine', controlPlaneSchemaVersion: 10,
  });
  assertHasProblem(built.problems, 'PRODUCER_PATH_NOT_NORMALIZED', 'refused');
});

// ---------------------------------------------------------------------------------------------------------
// Succession, deletion, grace and the shrink guard
// ---------------------------------------------------------------------------------------------------------

test('a successor chains to its predecessor by id, sequence and digest', () => {
  const first = buildFirst();
  const snapshot = baselineSnapshot();
  const grown: PublishSnapshot = {
    ...snapshot,
    versions: [...snapshot.versions, versionOf('local-c', 2 * 1024 * 1024, false)],
    entries: [...snapshot.entries, entryOf('Movies/Local C/Local C.bin', 'local-c', ITEM_A, [{ kind: 'local', rootId: 'media', objectRef: 'local-c.bin' }])],
  };
  const second = buildGeneration({
    snapshot: grown, previous: asPrevious(first), nowIso: NOW, intent: 'routine', controlPlaneSchemaVersion: 10,
  });
  assert(second.ok, `the successor builds: ${second.problems.map((p) => p.code).join(', ')}`);
  const predecessor = (second.manifest as ProjectionManifestV1).generation.predecessor;
  assertEq(predecessor?.generationId, (first.manifest as ProjectionManifestV1).generation.generationId, 'id');
  assertEq(predecessor?.sequence, 1, 'sequence');
  assertEq(predecessor?.manifestDigest, first.manifestDigest, 'digest over the predecessor\'s exact bytes');
  assertEq(second.additions.length, 1, 'one addition');
  assertEq(second.deletions.length, 0, 'no deletion');
});

test('an unchanged snapshot mints nothing at all', () => {
  const first = buildFirst();
  const again = buildGeneration({
    snapshot: baselineSnapshot(), previous: asPrevious(first), nowIso: '2026-07-02T00:00:00.000Z',
    intent: 'routine', controlPlaneSchemaVersion: 10,
  });
  assert(again.ok, 'it is not an error');
  assertEq(again.unchanged, true, 'it is a no-op');
  assertEq(again.artifact, null, 'and no bytes were produced');
  assertEq(again.sequence, 1, 'the sequence did not advance');
});

test('a routine generation that simply loses an entry is refused', () => {
  const first = buildFirst();
  const snapshot = baselineSnapshot();
  const shortened: PublishSnapshot = { ...snapshot, entries: [snapshot.entries[0] as SnapshotEntry] };
  const second = buildGeneration({
    snapshot: shortened, previous: asPrevious(first), nowIso: NOW, intent: 'routine', controlPlaneSchemaVersion: 10,
  });
  assertHasProblem(second.problems, 'ENTRY_DISAPPEARED_WITHOUT_DELETION',
    'a short scan cannot become a deletion');
});

test('a routine generation may not carry deletions, and a deletion generation may not be empty', () => {
  const withDeletions = buildGeneration({
    snapshot: baselineSnapshot(), previous: null, nowIso: NOW, intent: 'routine',
    deletions: [deriveProjectedEntryId('Movies/Gone/Gone.bin')], controlPlaneSchemaVersion: 10,
  });
  assertHasProblem(withDeletions.problems, 'PRODUCER_ROUTINE_GENERATION_DELETES', 'routine cannot delete');
  const empty = buildGeneration({
    snapshot: baselineSnapshot(), previous: null, nowIso: NOW, intent: 'deletion', deletions: [],
    controlPlaneSchemaVersion: 10,
  });
  assertHasProblem(empty.problems, 'PRODUCER_DELETION_GENERATION_EMPTY', 'a deletion generation deletes something');
});

test('an entry that was never retiring cannot be deleted', () => {
  const first = buildFirst();
  const target = deriveProjectedEntryId('Movies/Local A/Local A.bin');
  const second = buildGeneration({
    snapshot: baselineSnapshot(), previous: asPrevious(first), nowIso: NOW, intent: 'deletion',
    deletions: [target], controlPlaneSchemaVersion: 10,
  });
  assertHasProblem(second.problems, 'PRODUCER_DELETION_ENTRY_NOT_RETIRING', 'refused');
});

test('a grace deadline that has not elapsed refuses the deletion, and its passing removes nothing on its own', () => {
  const snapshot = baselineSnapshot();
  const retiring: PublishSnapshot = {
    ...snapshot,
    entries: [
      { ...(snapshot.entries[0] as SnapshotEntry), visibility: 'retiring', deletionIntentId: deriveDeletionIntentId('drop-a'), retiringDeclaredAt: NOW, graceDeadline: '2026-07-08T12:00:00.000Z' },
      snapshot.entries[1] as SnapshotEntry,
    ],
  };
  const retiredGeneration = buildGeneration({
    snapshot: retiring, previous: null, nowIso: NOW, intent: 'routine', controlPlaneSchemaVersion: 10,
  });
  assert(retiredGeneration.ok, 'a retiring entry is projected normally');
  assertEq((retiredGeneration.manifest as ProjectionManifestV1).entries.length, 2, 'and stays in the namespace');

  const target = deriveProjectedEntryId('Movies/Local A/Local A.bin');
  const tooEarly = buildGeneration({
    snapshot: retiring, previous: asPrevious(retiredGeneration), nowIso: '2026-07-02T00:00:00.000Z',
    intent: 'deletion', deletions: [target], controlPlaneSchemaVersion: 10,
  });
  assertHasProblem(tooEarly.problems, 'PRODUCER_DELETION_GRACE_NOT_ELAPSED', 'the deadline has not passed');

  // The deadline passing is not itself a removal: the same snapshot still projects both entries.
  const stillThere = buildGeneration({
    snapshot: retiring, previous: asPrevious(retiredGeneration), nowIso: '2026-07-09T00:00:00.000Z',
    intent: 'routine', controlPlaneSchemaVersion: 10,
  });
  assertEq(stillThere.unchanged, true, 'an elapsed grace deadline changes nothing at all');

  const deleted = buildGeneration({
    snapshot: retiring, previous: asPrevious(retiredGeneration), nowIso: '2026-07-09T00:00:00.000Z',
    intent: 'deletion', deletions: [target], controlPlaneSchemaVersion: 10,
  });
  assert(deleted.ok, `an explicit deletion after grace admits: ${deleted.problems.map((p) => p.code).join(', ')}`);
  assertEq((deleted.manifest as ProjectionManifestV1).entries.length, 1, 'the entry is gone');
  assertEq(deleted.deletions.length, 1, 'and it is reported as a deletion');
});

test('a large deletion set needs an acknowledgement bound to exactly that set', () => {
  const roots = ROOTS;
  const versions: SnapshotVersion[] = [];
  const entries: SnapshotEntry[] = [];
  const grace = '2026-06-30T00:00:00.000Z';
  for (let index = 0; index < 60; index += 1) {
    const key = `bulk-${index}`;
    versions.push(versionOf(key, 1024 * (index + 1), false));
    entries.push(entryOf(`Movies/Bulk ${index}/Bulk ${index}.bin`, key, ITEM_A,
      [{ kind: 'local', rootId: 'media', objectRef: `bulk-${index}.bin` }], {
        visibility: 'retiring', deletionIntentId: deriveDeletionIntentId('bulk'), retiringDeclaredAt: MTIME, graceDeadline: grace,
      }));
  }
  const snapshot: PublishSnapshot = { roots, versions, entries };
  const first = buildGeneration({ snapshot, previous: null, nowIso: NOW, intent: 'routine', controlPlaneSchemaVersion: 10 });
  assert(first.ok, 'the bulk baseline builds');

  const ids = entries.map((entry) => entry.projectedEntryId);
  const unacknowledged = buildGeneration({
    snapshot, previous: asPrevious(first), nowIso: NOW, intent: 'deletion', deletions: ids,
    controlPlaneSchemaVersion: 10,
  });
  assertHasProblem(unacknowledged.problems, 'PRODUCER_SHRINK_GUARD_UNACKNOWLEDGED', 'refused without acknowledgement');

  const acknowledged = buildGeneration({
    snapshot, previous: asPrevious(first), nowIso: NOW, intent: 'deletion', deletions: ids,
    deletionGuardAcknowledged: true, controlPlaneSchemaVersion: 10,
  });
  assert(acknowledged.ok, `acknowledged admits: ${acknowledged.problems.map((p) => p.code).join(', ')}`);
  const admission = (acknowledged.manifest as ProjectionManifestV1).generation.admission;
  assertEq(admission.deletionGuardAcknowledged, true, 'the acknowledgement is recorded');
  assert(admission.deletionGuardDigest !== null, 'and bound to a digest of the exact id set');
});

test('a relocated path is refused as a carried entry, and is only expressible as delete-and-add', () => {
  const first = buildFirst();
  const snapshot = baselineSnapshot();
  // The SAME entry id at a different path. This is what a producer that tried to "move" an entry would emit.
  const moved: SnapshotEntry = { ...(snapshot.entries[0] as SnapshotEntry), path: 'Movies/Local A/Renamed.bin' };
  const second = buildGeneration({
    snapshot: { ...snapshot, entries: [moved, snapshot.entries[1] as SnapshotEntry] },
    previous: asPrevious(first), nowIso: NOW, intent: 'routine', controlPlaneSchemaVersion: 10,
  });
  assertHasProblem(second.problems, 'PATH_CHANGED_FOR_CARRIED_ENTRY', 'a carried entry cannot move');
});

test('an identity that changed under a carried entry is refused', () => {
  const first = buildFirst();
  const snapshot = baselineSnapshot();
  const swapped: SnapshotEntry = {
    ...(snapshot.entries[0] as SnapshotEntry),
    projectedVersionId: deriveProjectedVersionId('local-a-different'),
  };
  const second = buildGeneration({
    snapshot: {
      ...snapshot,
      versions: [...snapshot.versions, versionOf('local-a-different', 9 * 1024 * 1024, false)],
      entries: [swapped, snapshot.entries[1] as SnapshotEntry],
    },
    previous: asPrevious(first), nowIso: NOW, intent: 'routine', controlPlaneSchemaVersion: 10,
  });
  assertHasProblem(second.problems, 'PROJECTED_VERSION_ID_CHANGED', 'identity is immutable for a carried entry');
});

test('a degraded entry keeps its inode, size and mtime, and earns no refresh', () => {
  const first = buildFirst();
  const snapshot = baselineSnapshot();
  const degraded: SnapshotEntry = {
    ...(snapshot.entries[1] as SnapshotEntry),
    visibility: 'degraded', degradedReason: 'source-unreachable', degradedSince: NOW,
  };
  const second = buildGeneration({
    snapshot: { ...snapshot, entries: [snapshot.entries[0] as SnapshotEntry, degraded] },
    previous: asPrevious(first), nowIso: NOW, intent: 'routine', controlPlaneSchemaVersion: 10,
  });
  assert(second.ok, `degrading admits: ${second.problems.map((p) => p.code).join(', ')}`);
  const before = (first.manifest as ProjectionManifestV1).entries.find((e) => e.path === 'Movies/Remote B/Remote B.bin');
  const after = (second.manifest as ProjectionManifestV1).entries.find((e) => e.path === 'Movies/Remote B/Remote B.bin');
  assertEq(after?.inode, before?.inode, 'inode unchanged');
  assertEq(after?.sizeBytes, before?.sizeBytes, 'size unchanged');
  assertEq(after?.mtime, before?.mtime, 'mtime unchanged');
  assertEq(after?.visibility, 'degraded', 'and it is still present');
  assertEq(second.additions.length + second.deletions.length, 0, 'nothing a media server is told about');
});

// ---------------------------------------------------------------------------------------------------------
// The filesystem half
// ---------------------------------------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'projection-publisher-'));

test('a durable write lands under its final name and reads back exactly', () => {
  const bytes = Buffer.from('the exact bytes\n', 'utf8');
  const write = writeDurable(work, 'sample.json', bytes);
  assertEq(write.bytes, bytes.length, 'the length is what was written');
  assertEq(readExact(join(work, 'sample.json'), bytes.length)?.toString('utf8'), bytes.toString('utf8'), 'round trip');
  assertEq(readExact(join(work, 'sample.json'), bytes.length + 1), null, 'a wrong length reads as absent');
});

test('nothing is left behind under a name a reader could mistake for the artifact', () => {
  const built = buildFirst();
  const name = artifactNameFor(built.sequence, built.generationId as string);
  ensureArtifact(work, name, built.artifact as Buffer, built.manifestDigest as string);
  assert(/^generation-1-[0-9a-f]{32}\.json$/.test(name), 'the artifact name carries the generation');
  assert(artifactMatches(work, name, (built.artifact as Buffer).length, built.manifestDigest as string), 'it matches');
});

test('publishing an artifact that is already there, byte for byte, writes nothing', () => {
  const built = buildFirst();
  const name = artifactNameFor(built.sequence, built.generationId as string);
  ensureArtifact(work, name, built.artifact as Buffer, built.manifestDigest as string);
  assertEq(ensureArtifact(work, name, built.artifact as Buffer, built.manifestDigest as string), null,
    'a retry over an identical artifact is a no-op');
});

test('an artifact whose bytes were tampered with stops matching its digest', () => {
  const built = buildFirst();
  const name = artifactNameFor(built.sequence, built.generationId as string);
  ensureArtifact(work, name, built.artifact as Buffer, built.manifestDigest as string);
  const tampered = Buffer.from((built.artifact as Buffer).toString('utf8').replace('"routine"', '"routine "'), 'utf8');
  writeFileSync(join(work, name), tampered);
  assertEq(artifactMatches(work, name, (built.artifact as Buffer).length, built.manifestDigest as string), false,
    'the digest catches it');
  // ...and re-publishing puts the committed bytes back. This is the recovery path, offline.
  const rewritten = ensureArtifact(work, name, built.artifact as Buffer, built.manifestDigest as string);
  assert(rewritten !== null, 'it was rewritten');
  assert(artifactMatches(work, name, (built.artifact as Buffer).length, built.manifestDigest as string), 'and matches again');
});

test('a directory sync that fails on a platform that supports it is fatal, not a flag', () => {
  // THE POLICY, TESTED AS A POLICY. The rename is what publishes a generation and the directory sync is what
  // makes the rename itself survive a power cut; a publisher that could not perform it and still answered
  // "published" would be claiming a durability it did not obtain. Windows has no way to open a directory for
  // fsync, so a failure there is a fact about the PLATFORM and is reported rather than raised — Phase 0 §10.1
  // already says production is Linux. Anywhere else the filesystem was asked to make a rename durable and
  // said no, and that is an error.
  assertEq(directorySyncFailureIsFatal('linux'), true, 'a Linux failure is fatal');
  assertEq(directorySyncFailureIsFatal('darwin'), true, 'so is a macOS one');
  assertEq(directorySyncFailureIsFatal('freebsd'), true, 'and any other supported platform');
  assertEq(directorySyncFailureIsFatal('win32'), false, 'Windows cannot do it at all, and says so instead');
});

test('a durable write to a directory that is not one raises rather than reporting success', () => {
  // The nearest thing to an injectable fault without a seam: a path that cannot be a manifest directory. On a
  // platform where the directory sync is fatal this must throw; on Windows it is reported instead, and the
  // write itself still fails because the target is not writable as a directory either way.
  const notADirectory = join(work, 'definitely-a-file.txt');
  writeFileSync(notADirectory, 'not a directory\n');
  let threw = false;
  try {
    writeDurable(notADirectory, 'child.json', Buffer.from('x\n', 'utf8'));
  } catch {
    threw = true;
  }
  assertEq(threw, true, 'writing into a non-directory fails rather than reporting a durable write');
});

test('the pointer carries exactly the five fields the daemon decodes, and nothing else', () => {
  const built = buildFirst();
  const pointer = {
    generationId: built.generationId as string,
    sequence: built.sequence,
    artifactName: artifactNameFor(built.sequence, built.generationId as string),
    artifactBytes: (built.artifact as Buffer).length,
    manifestDigest: built.manifestDigest as string,
  };
  writePointer(work, pointer);
  const parsed = JSON.parse(readFileSync(join(work, POINTER_FILE_NAME), 'utf8')) as Record<string, unknown>;
  assertEq(canonicalJson(Object.keys(parsed).sort()),
    canonicalJson(['artifactBytes', 'artifactName', 'generationId', 'manifestDigest', 'sequence']),
    'the daemon refuses unknown fields, so a sixth would make every pointer unreadable');
  assertEq(canonicalJson(readPointer(work)), canonicalJson(pointer), 'and it reads back');
  assert(serializePointer(pointer).toString('utf8').endsWith('\n'), 'the pointer is well-formed text');
});

test('a malformed or extended pointer reads as absent rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'projection-pointer-'));
  try {
    assertEq(readPointer(dir), null, 'no pointer at all');
    writeFileSync(join(dir, POINTER_FILE_NAME), '{ "generationId": ');
    assertEq(readPointer(dir), null, 'a half-written pointer');
    writeFileSync(join(dir, POINTER_FILE_NAME), JSON.stringify({
      generationId: 'gen_' + hex64('x').slice(0, 32), sequence: 1, artifactName: 'a.json',
      artifactBytes: 1, manifestDigest: `sha256:${hex64('y')}`, extra: true,
    }));
    assertEq(readPointer(dir), null, 'a pointer with a field the daemon would refuse');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------------------

test('the publisher suites are inventoried and run in the aggregate', () => {
  const root = new URL('..', import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { scripts: Record<string, string> };
  for (const script of ['test:projection-publisher', 'test:projection-publisher-db',
    'ops:projection-register', 'ops:projection-publish', 'go:publisher-mount-gate']) {
    assert(typeof pkg.scripts[script] === 'string', `package.json defines ${script}`);
  }
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-publisher.ts'), 'this suite runs in npm test');
  const inventory = JSON.parse(readFileSync(new URL('test/suite-inventory.json', root), 'utf8')) as {
    suites: Array<{ file: string; group: string; args?: string[] }>;
  };
  assertEq(inventory.suites.find((s) => s.file === 'projection-publisher.ts')?.group, 'offline', 'offline');
  assertEq(inventory.suites.find((s) => s.file === 'projection-publisher-db.ts')?.group, 'db', 'db');
});

rmSync(work, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
