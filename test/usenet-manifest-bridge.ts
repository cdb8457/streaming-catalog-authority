import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq, assertThrows } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  isProviderBackedEntry,
  mixedNamespaceCensus,
  planLocalSource,
  projectedMtimeFrom,
  torBoxDrift,
  usenetVersionKeyFor,
} from '../src/core/usenet/manifest-bridge.js';
import { seal } from '../src/core/usenet/sealed.js';
import type { ProvenOutput } from '../src/core/usenet/completed-output.js';
import {
  deriveInode,
  deriveProjectedEntryId,
  deriveProjectedVersionId,
  deriveSourceId,
  normalizeProjectedPath,
  validateManifestV1,
  type ProjectedEntry,
  type ProjectionSource,
} from '../src/core/projection/manifest-v1.js';
import { USENET_PROJECTED_PATH_PREFIX } from '../src/core/usenet/sab-contract.js';

// Projection Phase 9 §3, SEVENTH DELIVERABLE — "manifest production for admitted local files WITHOUT
// CHANGING TORBOX LOCATORS".
//
// TWO CLAIMS, AND THE SECOND IS THE ONE THAT MATTERS MOST.
//
//   AN ADMITTED USENET FILE IS AN ORDINARY LOCAL SOURCE. Everything the bridge produces goes through
//   `manifest-v1.ts`'s own derivation and validation, so a Usenet entry is indistinguishable — to the daemon,
//   to a media server, and to the manifest schema — from any other local entry. There is no new source kind,
//   no new field, and nothing for the daemon to learn.
//
//   THE TORBOX HALF DOES NOT MOVE. §4's sixth hard refusal is "let a Usenet outage alter the TorBox
//   namespace". `torBoxDrift` is the guard, and this suite drives every way a namespace could drift: dropped,
//   re-pathed, re-versioned, re-inoded, resized, degraded, and — the quiet one — the same entry with the same
//   source COUNT pointing at a different object.

const h = createHarness('Projection Phase 9 — the manifest bridge');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

const DIGEST = 'ab'.repeat(32);
const ITEM = '11111111-2222-3333-4444-555555555555';

function proven(segments: readonly string[], sizeBytes = 4_194_304): ProvenOutput {
  return {
    segments,
    sizeBytes,
    sha256: DIGEST,
    probes: [{ position: 'head', offset: 0, length: sizeBytes, sha256: 'cd'.repeat(32) }],
    sealedPath: seal('completed-path', `/downloads/complete/projection/${segments.join('/')}`),
    stat: { kind: 'file', sizeBytes, dev: '1', ino: '2', mtimeMs: 3, nlink: 1 },
  };
}

function entry(over: Partial<ProjectedEntry> & { path: string; sources: readonly ProjectionSource[] }): ProjectedEntry {
  const versionId = over.projectedVersionId ?? deriveProjectedVersionId(over.path);
  return {
    projectedEntryId: deriveProjectedEntryId(over.path),
    logicalMediaId: ITEM,
    projectedVersionId: versionId,
    path: over.path,
    nodeKind: 'file',
    sizeBytes: over.sizeBytes ?? 1000,
    mtime: '2026-01-01T00:00:00.000Z',
    mode: 0o444,
    readOnly: true,
    inode: deriveInode(versionId),
    visibility: over.visibility ?? 'available',
    degraded: over.degraded ?? null,
    retiring: null,
    sources: over.sources,
  };
}

const torBoxSource = (objectRef: string): ProjectionSource => ({
  sourceId: deriveSourceId('http-range', { endpointId: 'torbox', objectRef }),
  kind: 'http-range',
  preference: 0,
  sourceGeneration: 1,
  locator: { endpointId: 'torbox', objectRef },
  byteIdentity: null,
});

const localSource = (relativePath: string): ProjectionSource => ({
  sourceId: deriveSourceId('local', { rootId: 'media', relativePath }),
  kind: 'local',
  preference: 0,
  sourceGeneration: 1,
  locator: { rootId: 'media', relativePath },
  byteIdentity: null,
});

h.section('the version key');

test('a version key is derived from the BYTES, not from the job', () => {
  assertEq(usenetVersionKeyFor(DIGEST), `usenet-${DIGEST.slice(0, 32)}`, 'the key');
  assertEq(usenetVersionKeyFor(DIGEST), usenetVersionKeyFor(DIGEST), 'stable');
  assert(usenetVersionKeyFor(DIGEST) !== usenetVersionKeyFor('ef'.repeat(32)), 'different bytes, different key');
});

test('a version key satisfies the registration boundary\'s own key shape', () => {
  assert(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(usenetVersionKeyFor(DIGEST)),
    'the key would be refused by registerVersion, so an admission could never be published');
});

test('a version key cannot be derived from something that is not a digest', async () => {
  await assertThrows(() => usenetVersionKeyFor('nope'), /USENET_VERSION_KEY_DIGEST_INVALID/, 'not a digest');
});

h.section('planning a local source');

test('a plain output plans a projected path, a relative path and derived ids', () => {
  const plan = planLocalSource({
    output: proven(['Some.Job', 'feature.mkv']),
    rootId: 'media',
    completedRootUnderMediaRoot: ['usenet-complete'],
  });
  assert(plan.ok, 'a plain output was refused');
  assertEq(plan.value.projectedPath, 'usenet/Some.Job/feature.mkv', 'the projected path');
  assertEq(plan.value.relativePath, 'usenet-complete/Some.Job/feature.mkv', 'the path under the media root');
  assertEq(plan.value.projectedEntryId, deriveProjectedEntryId('usenet/Some.Job/feature.mkv'), 'the entry id');
  assertEq(plan.value.projectedVersionId, deriveProjectedVersionId(plan.value.versionKey), 'the version id');
  assertEq(plan.value.rootId, 'media', 'the local root id is the one the appliance already serves');
});

test('the whole plan is a LOCAL source; nothing about it names a provider or an endpoint', () => {
  const plan = planLocalSource({
    output: proven(['Some.Job', 'feature.mkv']), rootId: 'media', completedRootUnderMediaRoot: ['usenet-complete'],
  });
  assert(plan.ok, 'refused');
  const text = JSON.stringify(plan.value);
  assert(!text.includes('http-range'), 'the plan names a provider source kind');
  assert(!text.includes('endpointId'), 'the plan names an endpoint');
  assert(!text.includes('/downloads/'), 'the plan carries the absolute completed path');
});

test('the projected prefix is the contract\'s, and an override is a whole normalized segment', () => {
  const plan = planLocalSource({
    output: proven(['a.mkv']), rootId: 'media', completedRootUnderMediaRoot: [],
  });
  assert(plan.ok && plan.value.projectedPath.startsWith(`${USENET_PROJECTED_PATH_PREFIX}/`), 'the default prefix');
  const overridden = planLocalSource({
    output: proven(['a.mkv']), rootId: 'media', completedRootUnderMediaRoot: [], pathPrefix: 'usenet-gate',
  });
  assert(overridden.ok && overridden.value.projectedPath === 'usenet-gate/a.mkv', 'an override');
  const bad = planLocalSource({
    output: proven(['a.mkv']), rootId: 'media', completedRootUnderMediaRoot: [], pathPrefix: '/absolute',
  });
  assert(!bad.ok && bad.reason === 'output-name-not-projectable', 'an absolute prefix');
});

const unprojectable: ReadonlyArray<[string, readonly string[]]> = [
  ['a backslash in the name', ['Some\\Job.mkv']],
  ['a control character', ['SomeJob.mkv']],
  ['a decomposed name', ['café.mkv']],
  ['a trailing space', ['Some.Job ', 'a.mkv']],
  ['a relative component', ['..', 'a.mkv']],
  ['a name that reads as a credential', ['token', 'a.mkv']],
  // A `://` cannot appear inside one path segment, so the URL-shape check fires on the OTHER characters the
  // locator contract forbids: `?`, `&`, `@` and a backslash.
  ['a name carrying a query string', ['feature?quality=1080p.mkv']],
  ['a name carrying an at-sign', ['user@host.mkv']],
];

for (const [label, segments] of unprojectable) {
  test(`${label} is REFUSED rather than rewritten`, () => {
    const plan = planLocalSource({ output: proven(segments), rootId: 'media', completedRootUnderMediaRoot: [] });
    assert(!plan.ok, `${label} was accepted or sanitised`);
    assertEq(plan.reason, 'output-name-not-projectable', 'the reason');
  });
}

test('the plan carries the FILE\'S OWN mtime, so a re-publish of the same bytes derives the same one', () => {
  const output = proven(['Some.Job', 'feature.mkv']);
  const plan = planLocalSource({ output, rootId: 'media', completedRootUnderMediaRoot: [] });
  assert(plan.ok, 'refused');
  assertEq(plan.value.mtime, projectedMtimeFrom(output.stat.mtimeMs), 'the mtime is the output\'s own');
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(plan.value.mtime),
    'the mtime is not the exact-millisecond shape the manifest contract requires');
  const again = planLocalSource({ output, rootId: 'media', completedRootUnderMediaRoot: [] });
  assert(again.ok && again.value.mtime === plan.value.mtime,
    'two plans over one output produced two mtimes, and validateSuccession refuses MTIME_CHANGED');
});

test('a nonsensical filesystem mtime falls back to the epoch rather than refusing a provable file', () => {
  assertEq(projectedMtimeFrom(0), '1970-01-01T00:00:00.000Z', 'zero');
  assertEq(projectedMtimeFrom(-1), '1970-01-01T00:00:00.000Z', 'negative');
  assertEq(projectedMtimeFrom(Number.NaN), '1970-01-01T00:00:00.000Z', 'not a number');
  assertEq(projectedMtimeFrom(9e15), '1970-01-01T00:00:00.000Z', 'beyond the renderable range');
  assertEq(projectedMtimeFrom(1_700_000_000_000), '2023-11-14T22:13:20.000Z', 'an ordinary mtime');
});

test('a planned projected path is one the manifest contract would itself accept', () => {
  const plan = planLocalSource({
    output: proven(['Some.Job', 'feature.mkv']), rootId: 'media', completedRootUnderMediaRoot: ['usenet-complete'],
  });
  assert(plan.ok, 'refused');
  assert(normalizeProjectedPath(plan.value.projectedPath).ok, 'the projected path');
  assert(normalizeProjectedPath(plan.value.relativePath).ok, 'the relative path');
});

test('an entry built from a plan validates as a whole manifest', () => {
  const plan = planLocalSource({
    output: proven(['Some.Job', 'feature.mkv'], 4_194_304), rootId: 'media', completedRootUnderMediaRoot: ['usenet-complete'],
  });
  assert(plan.ok, 'refused');
  const built = entry({
    path: plan.value.projectedPath,
    projectedVersionId: plan.value.projectedVersionId,
    sizeBytes: plan.value.sizeBytes,
    sources: [localSource(plan.value.relativePath)],
  });
  const manifest = {
    format: 'catalog-authority.projection-manifest',
    version: 1,
    generation: {
      generationId: `gen_${'a'.repeat(32)}`,
      sequence: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      predecessor: null,
      provenance: {
        producer: 'catalog-authority', producerVersion: '1.2.6', controlPlaneSchemaVersion: 1,
        sourceSnapshotDigest: `sha256:${'0'.repeat(64)}`, probeWindowBytes: 1_048_576,
      },
      admission: { intent: 'routine', entryCount: 1, deletions: [], deletionGuardAcknowledged: false, deletionGuardDigest: null },
    },
    entries: [built],
  };
  const validation = validateManifestV1(manifest);
  assert(validation.ok, `an entry built from a Phase 9 plan is not a valid manifest entry: `
    + validation.problems.map((problem) => `${problem.code} at ${problem.at}`).join('; '));
});

h.section('the TorBox guard');

const before: readonly ProjectedEntry[] = [
  entry({ path: 'films/Torboxed.mkv', sources: [torBoxSource('obj-1')] }),
  entry({ path: 'films/Local.mkv', sources: [localSource('films/Local.mkv')] }),
];

test('adding a Usenet entry moves nothing on the TorBox half', () => {
  const after = [...before, entry({ path: 'usenet/New.mkv', sources: [localSource('usenet-complete/New.mkv')] })];
  assertEq(torBoxDrift(before, after).length, 0, 'adding an entry drifted the TorBox half');
});

const drifts: ReadonlyArray<[string, (entries: readonly ProjectedEntry[]) => readonly ProjectedEntry[], string]> = [
  ['dropping the TorBox entry', (entries) => entries.slice(1), 'TORBOX_ENTRY_DROPPED'],
  ['degrading it because Usenet was down',
    (entries) => entries.map((e) => (isProviderBackedEntry(e)
      ? { ...e, visibility: 'degraded' as const, degraded: { reason: 'source-unreachable' as const, since: '2026-01-01T00:00:00.000Z' } }
      : e)), 'TORBOX_ENTRY_VISIBILITY_CHANGED'],
  ['resizing it', (entries) => entries.map((e) => (isProviderBackedEntry(e) ? { ...e, sizeBytes: 999 } : e)), 'TORBOX_ENTRY_SIZE_CHANGED'],
  ['re-inoding it', (entries) => entries.map((e) => (isProviderBackedEntry(e) ? { ...e, inode: '4242' } : e)), 'TORBOX_ENTRY_INODE_CHANGED'],
  ['re-versioning it',
    (entries) => entries.map((e) => (isProviderBackedEntry(e) ? { ...e, projectedVersionId: deriveProjectedVersionId('other') } : e)),
    'TORBOX_ENTRY_VERSION_CHANGED'],
  ['REPOINTING ITS LOCATOR while keeping the id and the source count',
    (entries) => entries.map((e) => (isProviderBackedEntry(e) ? { ...e, sources: [torBoxSource('obj-2')] } : e)),
    'TORBOX_ENTRY_SOURCES_CHANGED'],
];

for (const [label, mutate, code] of drifts) {
  test(`${label} is caught as ${code}`, () => {
    const problems = torBoxDrift(before, mutate(before));
    assert(problems.length > 0, `${label} was not caught`);
    assert(problems.some((problem) => problem.code === code), `${label} produced ${problems.map((p) => p.code).join(',')}`);
    for (const problem of problems) {
      assert(/^pe_[0-9a-f]{8}$/.test(problem.at), 'a drift problem names a path rather than an id prefix');
    }
  });
}

test('a path change on a TorBox entry is caught even though the manifest contract also refuses it', () => {
  const after = before.map((e) => (isProviderBackedEntry(e) ? { ...e, path: 'films/Moved.mkv' } : e));
  assert(torBoxDrift(before, after).some((problem) => problem.code === 'TORBOX_ENTRY_PATH_CHANGED'), 'a path move');
});

test('the guard is about PROVIDER-BACKED entries, so a local entry changing is not TorBox drift', () => {
  const after = before.map((e) => (isProviderBackedEntry(e) ? e : { ...e, sizeBytes: 12 }));
  assertEq(torBoxDrift(before, after).length, 0, 'a local entry moving was reported as TorBox drift');
});

h.section('the mixed-namespace census, which §5.4 is stated in terms of');

test('a namespace with one of each is mixed; one with only one kind is not', () => {
  const usenetEntry = entry({ path: 'usenet/New.mkv', sources: [localSource('usenet-complete/New.mkv')] });
  const mixed = mixedNamespaceCensus([...before, usenetEntry]);
  assertEq(mixed.providerBacked, 1, 'the TorBox count');
  assertEq(mixed.usenetProjected, 1, 'the admitted Usenet count');
  assert(mixed.mixed, 'a namespace with one of each is not reported mixed');

  assert(!mixedNamespaceCensus(before).mixed, 'a TorBox-only namespace is reported mixed');
  assert(!mixedNamespaceCensus([usenetEntry]).mixed, 'a Usenet-only namespace is reported mixed');
});

test('an entry merely named "usenet-something" at the top level is not counted as a Usenet entry', () => {
  const decoy = entry({ path: 'usenet-films/Decoy.mkv', sources: [localSource('a/b.mkv')] });
  assertEq(mixedNamespaceCensus([decoy]).usenetProjected, 0,
    'the census matches a path PREFIX SEGMENT, not a string prefix');
});

h.section('wiring');

test('the bridge imports its derivations rather than formatting ids itself', () => {
  const source = read('src/core/usenet/manifest-bridge.ts');
  assert(source.includes('deriveProjectedEntryId'), 'the bridge derives entry ids through the contract');
  assert(source.includes('deriveProjectedVersionId'), 'the bridge derives version ids through the contract');
  assert(source.includes('normalizeProjectedPath'), 'the bridge normalizes through the contract');
  assert(source.includes('checkLocatorValue'), 'the bridge does not run the registration boundary\'s own check');
  assert(!/`pe_\$\{/.test(source) && !/`pv_\$\{/.test(source), 'the bridge formats an id itself');
});

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/usenet-manifest-bridge.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const found = inventory.suites.find((suite) => suite.file === 'usenet-manifest-bridge.ts');
  assert(found !== undefined, 'suite is inventoried');
  assertEq(found.group, 'offline', 'offline group');
});

await h.finish();
