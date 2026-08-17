import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import { topLevelDeclaration } from './helpers/ts-source.js';
import {
  NAMESPACE_SNAPSHOT_CONNECT_TIMEOUT_MS,
  NAMESPACE_SNAPSHOT_STATEMENT_TIMEOUT_MS,
  UNRESOLVED_MTIME,
  UNRESOLVED_SIZE_BYTES,
  projectedEntriesOf,
} from '../src/core/projection/namespace-snapshot.js';
import { buildGeneration, type PublishSnapshot } from '../src/core/projection/publisher.js';
import { torBoxDrift, isProviderBackedEntry } from '../src/core/usenet/manifest-bridge.js';
import {
  deriveInode, deriveProjectedEntryId, deriveProjectedVersionId, deriveSourceId,
} from '../src/core/projection/manifest-v1.js';

// Projection Phase 10 D10.1 — the namespace snapshot's derivation, offline.
//
// WHAT THIS SUITE IS FOR, AND WHAT IT DELIBERATELY IS NOT. The live half of D10.1 — a real admission through
// the real `createRegistryPublisher` against a real migrated PostgreSQL recording no `admittedWithoutDriftCheck`
// — is `test/projection-drift-guard-db.ts`, and no assertion here stands in for it. This suite pins the two
// things a database run cannot check about itself:
//
//   * that `projectedEntriesOf` agrees ENTRY-FOR-ENTRY with what `buildGeneration` publishes, so the guard is
//     comparing the namespace the daemon will actually serve rather than a lookalike; and
//   * that the derivation is TOTAL — a row `buildGeneration` refuses is still present in the drift picture,
//     because an entry dropped from both sides is an entry the guard is blind to, and the rows most likely to
//     be dropped are the rows something has already broken.
//
// IT OPENS NO CONNECTION AND CONTACTS NOTHING.

const h = createHarness('Projection Phase 10 D10.1 — the namespace snapshot, offline');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

const MTIME = '2026-06-01T10:00:00.000Z';
const versionOf = (key: string, sizeBytes: number): PublishSnapshot['versions'][number] => ({
  projectedVersionId: deriveProjectedVersionId(key),
  versionKey: key,
  sizeBytes,
  mtime: MTIME,
  probeWindowBytes: null,
  probes: null,
});

const entryOf = (path: string, versionKey: string, sources: PublishSnapshot['entries'][number]['sources']): PublishSnapshot['entries'][number] => ({
  projectedEntryId: deriveProjectedEntryId(path),
  itemId: '11111111-2222-4333-8444-555555555555',
  projectedVersionId: deriveProjectedVersionId(versionKey),
  path,
  visibility: 'available',
  degradedReason: null,
  degradedSince: null,
  deletionIntentId: null,
  retiringDeclaredAt: null,
  graceDeadline: null,
  sources,
});

/**
 * Source ids are DERIVED, not invented, because `validateManifestV1` refuses anything that is not
 * `src_<32 hex>` — and a fixture that could not be published would make the comparison below vacuous.
 */
const remoteSource = (objectRef: string, preference = 0): PublishSnapshot['entries'][number]['sources'][number] => ({
  sourceId: deriveSourceId('http-range', { endpointId: 'vault', objectRef }),
  kind: 'http-range', preference, sourceGeneration: 1, rootId: 'vault', objectRef,
});

const localSource = (relativePath: string, preference = 0): PublishSnapshot['entries'][number]['sources'][number] => ({
  sourceId: deriveSourceId('local', { rootId: 'media', relativePath }),
  kind: 'local', preference, sourceGeneration: 1, rootId: 'media', objectRef: relativePath,
});

const TORBOX_PATH = 'Movies/Remote One/Remote One.bin';
const LOCAL_PATH = 'usenet/Some.Release/file.bin';

function snapshotOf(extra: Partial<PublishSnapshot> = {}): PublishSnapshot {
  return {
    roots: [{ rootId: 'vault', kind: 'http-range' }, { rootId: 'media', kind: 'local' }],
    versions: [versionOf('remote-one', 4 * 1024 * 1024), versionOf('usenet-abc', 1024)],
    entries: [
      entryOf(TORBOX_PATH, 'remote-one', [remoteSource('obj-a')]),
      entryOf(LOCAL_PATH, 'usenet-abc', [localSource('usenet-complete/file.bin')]),
    ],
    ...extra,
  };
}

h.section('the picture is the publisher\'s picture');

test('every entry the publisher would publish is derived identically by the snapshot', () => {
  const snapshot = snapshotOf();
  const built = buildGeneration({
    snapshot, previous: null, nowIso: MTIME, intent: 'routine', controlPlaneSchemaVersion: 1,
  });
  assert(built.ok && built.manifest !== null, 'the fixture snapshot must build a generation for this to mean anything');

  const derived = projectedEntriesOf(snapshot);
  const byId = new Map(derived.map((entry) => [entry.projectedEntryId, entry]));

  for (const published of built.manifest.entries) {
    const mirror = byId.get(published.projectedEntryId);
    assert(mirror !== undefined, `the snapshot dropped ${published.path}, which the publisher publishes`);
    // COMPARED FIELD BY FIELD RATHER THAN BY DIGEST. A digest comparison that failed would say "they differ"
    // and a reader would still have to find out where; this says which field, which is what a repair needs.
    for (const field of ['path', 'projectedVersionId', 'logicalMediaId', 'sizeBytes', 'mtime', 'inode',
      'visibility', 'nodeKind', 'mode', 'readOnly'] as const) {
      assertEq(mirror[field], published[field], `${field} on ${published.path}`);
    }
    assertEq(JSON.stringify(mirror.sources), JSON.stringify(published.sources), `sources on ${published.path}`);
  }
  assertEq(derived.length, built.manifest.entries.length, 'the two pictures hold the same number of entries');
});

test('the TorBox half is recognised as provider-backed in the derived picture', () => {
  const derived = projectedEntriesOf(snapshotOf());
  const torbox = derived.filter(isProviderBackedEntry);
  assertEq(torbox.length, 1, 'exactly one provider-backed entry');
  assertEq(torbox[0]?.path, TORBOX_PATH, 'and it is the http-range one');
});

test('sources are ordered by preference, so a row order change is not reported as a locator change', () => {
  const forward = snapshotOf({
    entries: [entryOf(TORBOX_PATH, 'remote-one', [remoteSource('obj-a', 0), remoteSource('obj-b', 1)])],
  });
  const reversed = snapshotOf({
    entries: [entryOf(TORBOX_PATH, 'remote-one', [remoteSource('obj-b', 1), remoteSource('obj-a', 0)])],
  });
  assertEq(torBoxDrift(projectedEntriesOf(forward), projectedEntriesOf(reversed)).length, 0,
    'a database returning two source rows in a different order reported drift, which would train an operator '
    + 'to ignore the alarm that matters');
});

h.section('the derivation is TOTAL, which the publisher\'s deliberately is not');

test('an entry whose version row is missing is still in the picture, with a size no version can hold', () => {
  const snapshot = snapshotOf({ versions: [versionOf('usenet-abc', 1024)] });

  const built = buildGeneration({
    snapshot, previous: null, nowIso: MTIME, intent: 'routine', controlPlaneSchemaVersion: 1,
  });
  assert(!built.ok, 'the publisher must REFUSE this snapshot, or this test is not about the difference');
  assert(built.problems.some((problem) => problem.code === 'PRODUCER_VERSION_ROW_MISSING'),
    'the publisher refused for a different reason than the one this test is about');

  const derived = projectedEntriesOf(snapshot);
  assertEq(derived.length, 2, 'the drift picture dropped the entry the publisher refused; the guard would be '
    + 'blind to exactly the row something had already broken');
  const orphan = derived.find((entry) => entry.path === TORBOX_PATH);
  assert(orphan !== undefined, 'the TorBox entry is absent from the drift picture');
  assertEq(orphan.sizeBytes, UNRESOLVED_SIZE_BYTES, 'an unresolvable version reports a sentinel size');
  assertEq(orphan.mtime, UNRESOLVED_MTIME, 'and a sentinel mtime');
  assertEq(orphan.inode, deriveInode(orphan.projectedVersionId),
    'the inode still derives from the entry row, which is where it comes from');
});

test('a version row that disappears around a publish is REPORTED as drift rather than passing silently', () => {
  const before = projectedEntriesOf(snapshotOf());
  const after = projectedEntriesOf(snapshotOf({ versions: [versionOf('usenet-abc', 1024)] }));
  const drift = torBoxDrift(before, after);
  assert(drift.some((problem) => problem.code === 'TORBOX_ENTRY_SIZE_CHANGED'),
    'the TorBox entry lost its version row across the publish and nothing said so');
});

test('the sentinel size is negative, so it can never collide with a size a version can hold', () => {
  assert(UNRESOLVED_SIZE_BYTES < 0, 'a non-negative sentinel could be mistaken for an empty file');
});

test('a locator naming an unregistered root is still compared, because a drift guard is not an admission check', () => {
  const snapshot = snapshotOf({ roots: [{ rootId: 'media', kind: 'local' }] });
  const built = buildGeneration({
    snapshot, previous: null, nowIso: MTIME, intent: 'routine', controlPlaneSchemaVersion: 1,
  });
  assert(!built.ok, 'the publisher must refuse an unregistered root, or this test proves nothing');
  const derived = projectedEntriesOf(snapshot);
  assertEq(derived.filter(isProviderBackedEntry).length, 1,
    'the TorBox entry vanished from the drift picture because its root was not registered');
});

h.section('the two decisions the module is required to have made');

/**
 * Comments stripped before scanning. This module ARGUES about the publish lock in prose — Phase 10 §7 R1 is
 * why it does not take one — and a check that grepped the whole file would fail on the explanation. A pin
 * that punishes a file for explaining itself is a pin that gets the explanation deleted.
 */
const stripComments = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');
const codeOf = (relative: string): string => stripComments(read(relative));

test('the snapshot takes NO publish lock, and reads READ ONLY at REPEATABLE READ', () => {
  const source = codeOf('src/core/projection/namespace-snapshot.ts');
  assert(!/cat_projection_publish_lock/.test(source),
    'the namespace snapshot takes the publish lock, which serialises every admission behind every publish '
    + '(Phase 10 §7 R1 decided against it)');
  assert(/BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/.test(source),
    'the snapshot does not read inside a read-only repeatable-read transaction');
});

test('the snapshot opens its own connection rather than borrowing the registry client', () => {
  const source = codeOf('src/core/projection/namespace-snapshot.ts');
  assert(/new Client\(/.test(source), 'the snapshot does not open its own connection');
  assert(/client\.end\(\)/.test(source), 'the snapshot does not close the connection it opened');
});

test('the shipped publisher implements namespaceSnapshot, which is the whole of the D10.1 repair', () => {
  // EXTRACTED FROM THE RAW SOURCE AND THEN STRIPPED, in that order. `codeOf` collapses a block comment to a
  // single space, which joins the `*/` line onto the declaration that follows it — so a declaration this
  // file documents is no longer at column zero and a structural reader cannot find it.
  //
  // AND THE READER IS BRACE-DELIMITED, NOT SLICED TO THE NEXT `\n}\n`. That literal carries a bare LF and
  // matches nothing on an ordinary Windows checkout, where `indexOf` answers -1 and `slice(0, -1)` hands back
  // THE WHOLE REST OF THE FILE. This assertion then PASSED — over every publisher in the module rather than
  // over `createRegistryPublisher` — which is the version of the defect that costs nothing until the day the
  // method moves to a different factory and nobody is told. Two sibling pins failed the other way at the
  // Phase 10-12 integration merge; this one was the quiet half of the same bug.
  const publisher = stripComments(topLevelDeclaration(read('src/ops/usenet-command.ts'),
    'export function createRegistryPublisher', 'src/ops/usenet-command.ts createRegistryPublisher'));
  assert(/async namespaceSnapshot\(\)/.test(publisher),
    'createRegistryPublisher does not present a namespace, so every real admission is still recorded '
    + 'admittedWithoutDriftCheck — which is Phase 10 §2.1, unrepaired');
  assert(/readNamespaceSnapshot\(connectionString\)/.test(publisher),
    'the publisher\'s snapshot does not use the caller\'s connection string, so a gate pointed at a throwaway '
    + 'database would compare the appliance\'s real namespace');
});

test('the snapshot is BOUNDED IN TIME, because a hang on this path is not the failure the design handles', () => {
  // WHY THIS IS NOT A DETAIL. `admit()` calls the snapshot twice around every publish, inside
  // `withUsenetLedgerLock` — a lock held for the whole of `ops:usenet reconcile`. An unbounded connect does
  // not delay one admission; it hangs the reconciliation and every `submit` queued behind the lock for as
  // long as the operating system will wait on a TCP connect.
  //
  // AND IT DEFEATS THE DECISION D10.1 TURNS ON. The repair's shape is that a database which BLINKS produces a
  // REFUSAL rather than an admission carrying the weaker guarantee. A blink that HANGS produces neither: no
  // refusal, no admission, a held lock. A bound turns it back into the transient refusal `admit()` already
  // has a branch for.
  const source = codeOf('src/core/projection/namespace-snapshot.ts');
  assert(/connectionTimeoutMillis:/.test(source),
    'the snapshot waits forever on a connect, on a path that holds the Usenet ledger lock while it waits');
  assert(/statement_timeout:/.test(source),
    'the snapshot waits forever on a query that has been accepted and never answered');
  assert(NAMESPACE_SNAPSHOT_CONNECT_TIMEOUT_MS > 0 && NAMESPACE_SNAPSHOT_CONNECT_TIMEOUT_MS <= 60_000,
    'the connect bound is not a bound');
  assert(NAMESPACE_SNAPSHOT_STATEMENT_TIMEOUT_MS >= NAMESPACE_SNAPSHOT_CONNECT_TIMEOUT_MS,
    'a statement bound shorter than the connect bound refuses a database that answered');
});

test('a declared-but-failing snapshot REFUSES rather than falling back to no drift check', () => {
  const source = codeOf('src/core/usenet/admission.ts');
  const window = source.slice(source.indexOf('let before:'), source.indexOf('let published:'));
  assert(/TORBOX_SNAPSHOT_UNREADABLE/.test(window),
    'the pre-publish snapshot failure path does not name what went wrong');
  assert(/recordRefused\(job\.key, 'torbox-namespace-drifted', true\)/.test(window),
    'a publisher that offered the comparison and could not make it still publishes, so a database that '
    + 'blinked buys the weaker guarantee Phase 10 D10.1 exists to remove');
  assert(!/before = null;\s*\n\s*\}\s*\n\s*\}/.test(window),
    'the silent fallback to before = null is still reachable');
});

h.section('wiring');

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-namespace-snapshot.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'projection-namespace-snapshot.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

await h.finish();
