import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq, assertThrows } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  CONTENT_OBJECTS_FILE_MAX_BYTES,
  CONTENT_OBJECTS_MAX,
  ContentCommandError,
  addLocalObjects,
  addTorboxObjects,
  checkPathComponents,
  contentVersionKeyFor,
  inRegistryTransaction,
  isUnder,
  isoOf,
  parseContentConfig,
  probePlanFor,
  readObjectsFile,
  readPublishedEntryIds,
  renderAdd,
  renderHold,
  renderReconcile,
  renderStatus,
  type ContentFileStat,
  type ContentHost,
} from '../src/ops/projection-content.js';
import type { Queryable } from '../src/core/projection/source-registry.js';
import { main, parseArgs, safeErrorMessage } from '../src/ops/projection-content-cli.js';
import { sealedProblems } from '../src/core/usenet/sealed.js';
import { PHASE10_DIVERGENCE_CODES, PHASE10_DIVERGENCE_MEANINGS } from '../src/core/projection/phase10.js';
import { manifestDigestOfBytes, probeOffsetsFor, PROJECTION_PROBE_PLAN } from '../src/core/projection/manifest-v1.js';

// Projection Phase 10 D10.3 — the content command's boundary, offline.
//
// WHAT THIS SUITE IS FOR, AND WHAT IT DELIBERATELY IS NOT. `test/projection-content-db.ts` measures P10-4 and
// P10-5 against a real migrated PostgreSQL, and nothing here stands in for that. This runs everywhere in
// milliseconds and pins the boundary a database run does not exercise:
//
//   * the objects file is REFUSED rather than repaired, for each of the ways it can be wrong;
//   * a provider object reference cannot be an argument, and a permissive objects file is refused;
//   * `--publish` is explicit on the verbs that can publish and REFUSED on the ones that cannot;
//   * every rendered line says what did NOT happen, because Phase 10 §2.2 is a defect in a sentence.
//
// IT OPENS NO CONNECTION AND CONTACTS NOTHING: the host boundary is injected.
//
// IT DOES TOUCH ONE REAL DIRECTORY, and the exception is named rather than quietly taken. The arms that ask
// what a media server can SEE write a pointer and an artifact into a temporary directory of their own, because
// the question is what happens when the BYTES on disk stop agreeing with the pointer that names them and there
// is nothing to disagree about in memory. Every one of those directories is removed by the last arm.

const h = createHarness('Projection Phase 10 D10.3 — the content command, offline');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

const ITEM = '11111111-2222-4333-8444-555555555555';
const CONFIG = {
  manifestDir: '/var/lib/projection/manifests',
  mediaRoot: '/mnt/user/media',
  rootId: 'media',
  endpointId: 'vault',
};

const fileStat = (extra: Partial<ContentFileStat> = {}): ContentFileStat =>
  ({ kind: 'file', sizeBytes: 10, mtime: '2026-06-01T10:00:00.000Z', ownerOnly: true, ...extra });

/** A host whose whole filesystem is one objects file, so a refusal can only come from the file's content. */
function hostWith(body: unknown, stat: Partial<ContentFileStat> = {}, hasPosixModes = true): ContentHost {
  return {
    hasPosixModes,
    async stat() { return fileStat(stat); },
    async readFile() { return typeof body === 'string' ? body : JSON.stringify(body); },
    async digestWindow() { return 'f'.repeat(64); },
  };
}

h.section('the configuration');

test('a configuration with an unknown key is REFUSED rather than ignored', () => {
  let code = '';
  try { parseContentConfig({ ...CONFIG, manifestDirectory: '/elsewhere' }); }
  catch (error) { code = (error as ContentCommandError).code; }
  assertEq(code, 'CONFIG_UNKNOWN_KEY',
    'a typo in the document that decides where a generation is written was silently accepted, and the default '
    + 'would quietly point somewhere else');
});

test('a relative path is refused, because it would resolve against whatever directory the command ran from', () => {
  let code = '';
  try { parseContentConfig({ ...CONFIG, manifestDir: 'manifests' }); }
  catch (error) { code = (error as ContentCommandError).code; }
  assertEq(code, 'CONFIG_MANIFESTDIR_INVALID', 'a relative manifest directory was accepted');
});

test('a trailing slash is normalised rather than refused, because it is not an error', () => {
  assertEq(parseContentConfig({ ...CONFIG, mediaRoot: '/mnt/user/media/' }).mediaRoot, '/mnt/user/media',
    'the media root');
});

test('the usenet state directory is OPTIONAL, and its absence is a fact rather than a default', () => {
  assertEq(parseContentConfig(CONFIG).usenetStateDir, undefined, 'no ledger to cross-check');
  assertEq(parseContentConfig({ ...CONFIG, usenetStateDir: '/var/lib/projection-usenet' }).usenetStateDir,
    '/var/lib/projection-usenet', 'a ledger to cross-check');
});

h.section('the objects file, and every way it is refused rather than repaired');

test('a permissive TorBox objects file is refused, because it carries an opaque object reference', async () => {
  await assertThrows(
    () => readObjectsFile(hostWith([], { ownerOnly: false }), '/tmp/objects.json', 'http-range'),
    /OBJECTS_FILE_PERMISSIVE|beyond its owner/,
    'a world-readable file of provider object references was accepted');
});

test('a LOCAL objects file is not held to that mode, because it names no secret', async () => {
  const objects = await readObjectsFile(
    hostWith([{ label: 'a', itemId: ITEM, path: 'Movies/A/A.bin', relativePath: 'movies/a.bin' }], { ownerOnly: false }),
    '/tmp/local.json', 'local');
  assertEq(objects.length, 1, 'a local objects file was refused over a mode that guards nothing');
});

test('a mode is not demanded where the platform reports no meaningful one', async () => {
  const objects = await readObjectsFile(
    hostWith([{ label: 'a', itemId: ITEM, path: 'Movies/A/A.bin', ref: 'opaque', sizeBytes: 10, mtime: '2026-06-01T10:00:00.000Z' }],
      { ownerOnly: false }, false),
    '/tmp/objects.json', 'http-range');
  assertEq(objects.length, 1, 'a fictional Windows mode refused an operator\'s file');
});

test('a symlinked objects file is refused, and never followed', async () => {
  await assertThrows(() => readObjectsFile(hostWith([], { kind: 'symlink' }), '/tmp/objects.json', 'local'),
    /SYMLINK|symbolic link/, 'a symlinked objects file was followed');
});

test('an empty list is refused, because a run that added nothing should say so loudly', async () => {
  await assertThrows(() => readObjectsFile(hostWith([]), '/tmp/objects.json', 'local'),
    /OBJECTS_FILE_EMPTY|names nothing/, 'an empty objects file read as a successful no-op');
});

test('the template\'s own _comment keys are IGNORED rather than treated as unknown', async () => {
  const objects = await readObjectsFile(hostWith([{
    _comment_label: 'the template is more than half comments',
    _comment_ref: 'and an operator edits it in place',
    label: 'remote-one', itemId: ITEM, path: 'Movies/A/A.bin', ref: 'opaque-ref',
    sizeBytes: 4 * 1024 * 1024, mtime: '2026-06-01T10:00:00.000Z', sha256: null,
  }]), '/tmp/objects.json', 'http-range');
  assertEq(objects[0]?.label, 'remote-one',
    'an operator who edited deploy/real-provider-objects.template.json in place was told their file is malformed');
});

test('the template\'s REPLACE-ME placeholder is refused, rather than registered as a reference', async () => {
  await assertThrows(() => readObjectsFile(hostWith([{
    label: 'remote-one', itemId: ITEM, path: 'Movies/A/A.bin', ref: 'REPLACE-ME-opaque-object-reference',
    sizeBytes: 10, mtime: '2026-06-01T10:00:00.000Z',
  }]), '/tmp/objects.json', 'http-range'), /OBJECT_REF_INVALID|placeholder/,
  'the template\'s placeholder was registered as if it were an object');
});

test('an unnormalized projected path is REFUSED, never rewritten', async () => {
  await assertThrows(() => readObjectsFile(hostWith([{
    label: 'a', itemId: ITEM, path: '../escape/A.bin', relativePath: 'movies/a.bin',
  }]), '/tmp/local.json', 'local'), /OBJECT_PATH_INVALID/,
  'a path that escapes the namespace was accepted, and sanitising one would produce a namespace no re-scan is '
  + 'idempotent over');
});

test('an absolute relativePath is refused, because a local locator is relative to a configured root', async () => {
  await assertThrows(() => readObjectsFile(hostWith([{
    label: 'a', itemId: ITEM, path: 'Movies/A/A.bin', relativePath: '/mnt/user/media/movies/a.bin',
  }]), '/tmp/local.json', 'local'), /OBJECT_RELATIVE_PATH_INVALID/, 'an absolute local locator was accepted');
});

test('an object with no catalog record is refused, because an entry with no logical media id is unattributable', async () => {
  await assertThrows(() => readObjectsFile(hostWith([{
    label: 'a', itemId: 'not-a-uuid', path: 'Movies/A/A.bin', relativePath: 'movies/a.bin',
  }]), '/tmp/local.json', 'local'), /OBJECT_ITEM_ID_INVALID/, 'an entry with no catalog record was accepted');
});

test('a TorBox object with no exact mtime is refused, because there is no rounding downstream', async () => {
  await assertThrows(() => readObjectsFile(hostWith([{
    label: 'a', itemId: ITEM, path: 'Movies/A/A.bin', ref: 'opaque', sizeBytes: 10, mtime: '2026-06-01',
  }]), '/tmp/objects.json', 'http-range'), /OBJECT_MTIME_INVALID/, 'a truncated mtime was accepted');
});

h.section('the probe plan, and the refusal that names the windows');

test('a supplied probe set is mapped onto the plan the size implies, in the contract\'s own order', () => {
  const size = 8 * 1024 * 1024;
  const expected = probeOffsetsFor(size, PROJECTION_PROBE_PLAN.WINDOW_BYTES);
  const plan = probePlanFor(size, expected.map((window, index) => ({
    offset: window.offset, length: window.length, sha256: String(index).repeat(64).slice(0, 64),
  })));
  assertEq(plan.length, expected.length, 'the plan length');
  assertEq(plan.map((probe) => probe.position).join(','), expected.map((window) => window.position).join(','),
    'the positions, in the contract\'s order');
});

test('a probe at the wrong offset is refused, and the refusal NAMES the windows the size requires', () => {
  let message = '';
  try { probePlanFor(8 * 1024 * 1024, [{ offset: 17, length: 1_048_576, sha256: 'a'.repeat(64) }]); }
  catch (error) { message = (error as Error).message; }
  // `registerVersion` would refuse this three commands later as an offset mismatch. An operator meeting that
  // has been told a code; this tells them what to digest.
  assert(/head:0:1048576/.test(message) && /middle:/.test(message) && /tail:/.test(message),
    `the refusal did not name the required windows: ${message}`);
});

test('a file below the single-probe threshold needs one whole-file probe, not three', () => {
  const size = 1024;
  const plan = probePlanFor(size, [{ offset: 0, length: size, sha256: 'b'.repeat(64) }]);
  assertEq(plan.length, 1, 'a small file was asked for three overlapping probes');
  assertEq(plan[0]?.position, 'head', 'the single probe position');
});

h.section('derived values');

test('a version key is derived from what the entry IS, so adding twice mints one version', () => {
  const first = contentVersionKeyFor('local', 'local-one', 'abc');
  assertEq(contentVersionKeyFor('local', 'local-one', 'abc'), first, 'the same inputs derived two keys');
  assert(contentVersionKeyFor('local', 'local-one', 'abd') !== first, 'different bytes derived one key');
  assert(contentVersionKeyFor('http-range', 'local-one', 'abc') !== first, 'two kinds derived one key');
});

test('a nonsensical mtime falls back to the epoch rather than throwing', () => {
  // The reasoning `manifest-bridge.ts` records: the value is metadata a media server displays and it is not
  // identity, so refusing an otherwise-registrable file over it would be refusing the wrong thing.
  assertEq(isoOf(0), '1970-01-01T00:00:00.000Z', 'zero');
  assertEq(isoOf(-1), '1970-01-01T00:00:00.000Z', 'negative');
  assertEq(isoOf(Number.NaN), '1970-01-01T00:00:00.000Z', 'not a number');
  assertEq(isoOf(1_800_000_000_000), '2027-01-15T08:00:00.000Z', 'an ordinary mtime');
});

test('containment is answered on both separator conventions', () => {
  assert(isUnder('/mnt/media/manifests', '/mnt/media'), 'a child under a parent');
  assert(isUnder('/mnt/media', '/mnt/media'), 'a directory is under itself');
  assert(!isUnder('/mnt/media-other', '/mnt/media'), 'a sibling whose name shares a prefix is not a child');
  assert(isUnder('C:\\\\tmp\\\\media\\\\manifests', 'C:\\\\tmp\\\\media'),
    'a containment check that stopped containing on Windows is one nobody would notice');
});

h.section('the CLI surface, and what it refuses to take as an argument');

test('an object reference is never an argument: add-torbox needs --file', () => {
  let code = '';
  try { parseArgs(['add-torbox', '--config', '/etc/content.json']); }
  catch (error) { code = (error as ContentCommandError).code; }
  assertEq(code, 'USAGE', 'add-torbox accepted no file, so a reference could only have come from argv');
});

test('--publish is REFUSED on a verb that cannot publish, rather than silently ignored', () => {
  let code = '';
  try { parseArgs(['reconcile', '--config', '/etc/content.json', '--publish']); }
  catch (error) { code = (error as ContentCommandError).code; }
  assertEq(code, 'USAGE',
    'an operator typed --publish on reconcile and it was ignored, which leaves their belief in place');
});

test('--publish is accepted on the two verbs that register, and defaults to off', () => {
  assertEq(parseArgs(['add-local', '--config', '/c', '--file', '/f']).publish, false, 'default');
  assertEq(parseArgs(['add-local', '--config', '/c', '--file', '/f', '--publish']).publish, true, 'explicit');
});

test('an unknown verb and an unknown option are both refused', () => {
  for (const argv of [['destroy', '--config', '/c'], ['status', '--config', '/c', '--force']]) {
    let code = '';
    try { parseArgs(argv); } catch (error) { code = (error as ContentCommandError).code; }
    assertEq(code, 'USAGE', `${argv.join(' ')} was accepted`);
  }
});

test('the eight verbs of D10.3 are exactly the verbs the CLI accepts', () => {
  for (const verb of ['preflight', 'add-torbox', 'add-local', 'publish', 'reconcile', 'hold', 'release', 'status']) {
    const argv = ['--config', '/c'];
    if (verb === 'add-torbox' || verb === 'add-local') argv.push('--file', '/f');
    if (verb === 'hold' || verb === 'release') argv.push('--path', 'Movies/A/A.bin');
    assertEq(parseArgs([verb, ...argv]).verb, verb, `${verb} is not a verb`);
  }
});

h.section('what the rendered output must always say');

test('every add says NOTHING IS VISIBLE YET, because Phase 10 §2.2 is a defect in a sentence', () => {
  const lines = renderAdd([{
    label: 'local-one', path: 'Movies/A/A.bin', projectedEntryId: `pe_${'a'.repeat(64)}`,
    versionKey: 'local-local-one-0000000000000000', sizeBytes: 10, needsPublish: true,
  }]).join('\n');
  assert(/NOTHING IS VISIBLE YET/.test(lines), 'the verb that registers did not say that it did not publish');
  assert(/publish/.test(lines), 'it did not say what to run');
});

test('every reconcile says it changed nothing, in its first line and in its last', () => {
  const lines = renderReconcile({
    phase: 10, publishedSequence: 3, registryEntries: 2, publishedEntries: 1, admittedNotPublished: 1,
    ledgerChecked: false,
    unresolvedLocalRoots: ['archive'],
    divergences: [{
      code: 'registry-ahead-of-generation', meaning: PHASE10_DIVERGENCE_MEANINGS['registry-ahead-of-generation'],
      at: 'Movies/A/A.bin', detail: 'admitted-not-published',
    }],
  });
  assert(/CHANGES NOTHING/.test(lines[0] as string), 'the header does not say the report changes nothing');
  assert(/NOTHING ABOVE WAS ACTED ON/.test(lines.join('\n')), 'the footer does not say nothing was acted on');
  assert(/NOT read/.test(lines.join('\n')),
    'a run that could not read the ledger reported no ledger divergence as though it had looked');
});

test('every hold says the entry is still in the namespace', () => {
  const lines = renderHold({
    path: 'Movies/A/A.bin', projectedEntryId: `pe_${'a'.repeat(64)}`, visibility: 'degraded', changed: true,
  }, 'hold').join('\n');
  assert(/STILL IN THE NAMESPACE/.test(lines),
    'hold did not say the entry stays, so an operator could read it as a removal');
});

test('status marks an unpublished entry with a character an eye finds', () => {
  const lines = renderStatus({
    phase: 10, publishedSequence: 1, agrees: true,
    counts: { registered: 1, published: 0, admittedNotPublished: 1, degraded: 0, held: 0 },
    entries: [{
      path: 'Movies/A/A.bin', kinds: ['local'], sizeBytes: 10, visibility: 'available', degradedReason: null,
      publication: 'admitted-not-published',
    }],
  }).join('\n');
  assert(/! Movies\/A\/A\.bin/.test(lines), 'an unpublished entry looks exactly like a published one');
  assert(/admitted-not-published/.test(lines), 'the publication state is not named');
});

h.section('the divergence set is CLOSED');

test('every code the reconciler can emit has a meaning, and every meaning has a code', () => {
  assertEq(Object.keys(PHASE10_DIVERGENCE_MEANINGS).sort().join(','), [...PHASE10_DIVERGENCE_CODES].sort().join(','),
    'a divergence with no documented meaning is a code, not a reason; and a meaning nothing can produce would '
    + 'make a reader conclude the question had been asked');
});

test('the reconciler names no code the contract does not', () => {
  const source = read('src/ops/projection-content.ts');
  const emitted = [...source.matchAll(/add\('([a-z-]+)'/g)].map((match) => match[1] as string);
  assert(emitted.length >= PHASE10_DIVERGENCE_CODES.length, `only ${emitted.length} divergences are emitted`);
  for (const code of emitted) {
    assert((PHASE10_DIVERGENCE_CODES as readonly string[]).includes(code),
      `the reconciler emits ${code}, which §3.3 does not name`);
  }
});

h.section('the error path, which is the one path whose text this project does not write');

/** Everything the command wrote to stderr while `fn` ran. */
async function stderrOf(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]): void => { lines.push(parts.map((part) => String(part)).join(' ')); };
  try { await fn(); } finally { console.error = original; }
  return lines.join('\n');
}

test('an unknown VERB is not echoed, because an operator can mistype a path into that slot', async () => {
  const secret = '/mnt/user/media/Some Film (2026)/Some Film.mkv';
  const written = await stderrOf(() => main([secret]));
  assert(!written.includes(secret),
    'the first argument was printed back to stderr, so a path reached whatever collects it');
  assert(written.includes('eight verbs'), 'the operator was not told what was wrong');
});

test('an unknown OPTION is not echoed, because --database-url=<connection string> is ONE token', async () => {
  // The realistic mistake, not a contrived one: every other CLI on the host accepts the `=` form, this one
  // takes a separate value, and the whole credential arrives as an unrecognised flag.
  const credential = '--database-url=postgresql://app:hunter2@127.0.0.1:5670/catalog';
  const written = await stderrOf(() => main(['status', '--config', '/tmp/none.json', credential]));
  assert(!written.includes('hunter2'), 'a password typed as part of a flag was printed to stderr');
  assert(!written.includes(credential), 'the unrecognised option was echoed with its value');
});

test('a message THIS PROJECT composed is printed, so the rule is not "withhold everything"', () => {
  assertEq(safeErrorMessage(new ContentCommandError('X', 'the objects file is not there')),
    'the objects file is not there', 'a sentence this project wrote was withheld');
});

test('a message this project did NOT compose is withheld whatever it says', () => {
  // §4's ninth hard refusal forbids an arbitrary OS error string in an emitted document. A list of shapes to
  // reject is the wrong side of that rule: it is a promise to have thought of every shape.
  const written = safeErrorMessage(new Error('connect ECONNREFUSED 127.0.0.1:5670'));
  assert(!written.includes('127.0.0.1'), 'a driver message reached the operator surface verbatim');
  assert(written.includes('withheld'), 'the reader was not told that something was withheld');
});

test('a CONNECTION STRING is withheld, which the six sealed shapes do not match', () => {
  // THE EXACT HAZARD `safeErrorMessage`'s own comment named. `sealedProblems`'s URL shape lists http, ftp,
  // nntp and news; a control-plane scheme is not one of them, so the string it promised to withhold would
  // have been printed if it were the only check.
  const url = 'postgresql://app:hunter2@127.0.0.1:5670/catalog';
  assertEq(sealedProblems(url).length, 0, 'the premise of this arm no longer holds: sealedProblems now matches it');
  const written = safeErrorMessage(new ContentCommandError('X', `could not reach ${url}`));
  assert(!written.includes('hunter2'), 'a connection string reached the operator surface');
});

h.section('the objects file is BOUNDED, and two objects cannot be one entry');

test('an objects file larger than the bound is refused from its STAT, before it is read', async () => {
  // The body is valid JSON. If the bound were checked after the read this would pass, which is the point:
  // `--file` takes a path under the same root the media is under, and pointing it at a film is the one
  // mistake the argument invites.
  const host = hostWith([{ label: 'a', itemId: ITEM, path: 'Movies/A/A.bin', relativePath: 'movies/a.bin' }],
    { sizeBytes: CONTENT_OBJECTS_FILE_MAX_BYTES + 1 });
  await assertThrows(() => readObjectsFile(host, '/tmp/local.json', 'local'),
    /OBJECTS_FILE_TOO_LARGE/, 'a file of any size was read into memory on an operator\'s say-so');
});

test('a file naming more objects than one operator action is refused', async () => {
  const many = Array.from({ length: CONTENT_OBJECTS_MAX + 1 }, (_ignored, index) => ({
    label: `a${index}`, itemId: ITEM, path: `Movies/A/${index}.bin`, relativePath: `movies/${index}.bin`,
  }));
  await assertThrows(() => readObjectsFile(hostWith(many), '/tmp/local.json', 'local'),
    /OBJECTS_FILE_TOO_MANY/, 'an unbounded list was accepted');
});

test('two objects naming ONE projected path are refused, rather than one silently replacing the other', async () => {
  await assertThrows(() => readObjectsFile(hostWith([
    { label: 'first', itemId: ITEM, path: 'Movies/A/A.bin', relativePath: 'movies/a.bin' },
    { label: 'second', itemId: ITEM, path: 'Movies/A/A.bin', relativePath: 'movies/b.bin' },
  ]), '/tmp/local.json', 'local'), /OBJECT_PATH_DUPLICATE/,
  'the second registration overwrote the first while both were reported as registered');
});

test('the comparison is the CONTRACT\'S FOLD, so two paths that differ only in case are still one entry', async () => {
  // `validateSuccession` already refuses a folded collision at publish time. Meeting that refusal three
  // commands later, phrased as a manifest position, is meeting it in the wrong place.
  await assertThrows(() => readObjectsFile(hostWith([
    { label: 'first', itemId: ITEM, path: 'Movies/A/A.bin', relativePath: 'movies/a.bin' },
    { label: 'second', itemId: ITEM, path: 'movies/a/a.bin', relativePath: 'movies/b.bin' },
  ]), '/tmp/local.json', 'local'), /OBJECT_PATH_DUPLICATE/,
  'two paths that are one file on every share this namespace is reached from were both registered');
});

test('two objects sharing a LABEL are refused, because a label is the only identity a report line has', async () => {
  await assertThrows(() => readObjectsFile(hostWith([
    { label: 'same', itemId: ITEM, path: 'Movies/A/A.bin', relativePath: 'movies/a.bin' },
    { label: 'same', itemId: ITEM, path: 'Movies/B/B.bin', relativePath: 'movies/b.bin' },
  ]), '/tmp/local.json', 'local'), /OBJECT_LABEL_DUPLICATE/,
  'two rows answering to one label make every later line about them ambiguous');
});

test('an ordinary two-object file is still accepted, so the checks refuse something rather than everything', async () => {
  const objects = await readObjectsFile(hostWith([
    { label: 'first', itemId: ITEM, path: 'Movies/A/A.bin', relativePath: 'movies/a.bin' },
    { label: 'second', itemId: ITEM, path: 'Movies/B/B.bin', relativePath: 'movies/b.bin' },
  ]), '/tmp/local.json', 'local');
  assertEq(objects.length, 2, 'a perfectly ordinary objects file was refused');
});

h.section('what a media server can see, answered the way the daemon answers it');

/**
 * A manifest directory holding one pointer and one artifact, as `publishGeneration` leaves them.
 *
 * WRITTEN RATHER THAN FAKED, because the question these arms ask is what happens when the BYTES on disk stop
 * agreeing with the pointer that names them — and there is nothing to disagree about in memory.
 */
function manifestDirWith(
  entryIds: readonly string[], tamper: (pointer: Record<string, unknown>, dir: string) => void = () => undefined,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'phase10-audit-'));
  const artifact = Buffer.from(JSON.stringify({ entries: entryIds.map((id) => ({ projectedEntryId: id })) }), 'utf8');
  writeFileSync(join(dir, 'generation-1.json'), artifact);
  const pointer: Record<string, unknown> = {
    generationId: 'gen_1', sequence: 1, artifactName: 'generation-1.json',
    artifactBytes: artifact.length, manifestDigest: manifestDigestOfBytes(artifact),
  };
  tamper(pointer, dir);
  writeFileSync(join(dir, 'pointer.json'), `${JSON.stringify(pointer)}\n`);
  temporaryDirs.push(dir);
  return dir;
}

const temporaryDirs: string[] = [];
const ENTRY = `pe_${'a'.repeat(64)}`;
const OUTSIDE_ENTRY = `pe_${'b'.repeat(64)}`;
const configFor = (manifestDir: string): typeof CONFIG => ({ ...CONFIG, manifestDir });

test('an artifact that AGREES with its pointer is what a media server can see', () => {
  const ids = readPublishedEntryIds(configFor(manifestDirWith([ENTRY])));
  assert(ids.has(ENTRY), 'a published entry was reported as invisible, so every entry would read as ahead of the generation');
});

test('an artifact whose BYTES do not match the pointer is not published, because the daemon refuses it', () => {
  // A TRUNCATED OR HALF-WRITTEN ARTIFACT IS EXACTLY THIS. `publishStatus` already says `agrees=false` about it
  // by calling `artifactMatches`; this reader used to be the only one of the three that called its entries
  // VISIBLE, which is the one question it exists to answer.
  const dir = manifestDirWith([ENTRY], (_pointer, at) => { writeFileSync(join(at, 'generation-1.json'), 'x'.repeat(64)); });
  assertEq(readPublishedEntryIds(configFor(dir)).size, 0,
    'an artifact no daemon would serve was read as the published generation');
});

test('an artifact whose DIGEST does not match the pointer is not published either', () => {
  const dir = manifestDirWith([ENTRY], (pointer) => { pointer['manifestDigest'] = `sha256:${'0'.repeat(64)}`; });
  assertEq(readPublishedEntryIds(configFor(dir)).size, 0, 'the digest the pointer declares was never checked');
});

test('a pointer naming something that is not a NAME is refused, never joined onto the manifest directory', () => {
  // THE FILE OUTSIDE IS REAL AND VALID, so the refusal can only come from the name being a path. A test whose
  // traversal target did not exist would pass on the read failing and say nothing about the guard.
  let outside = '';
  const dir = manifestDirWith([ENTRY], (pointer, at) => {
    const artifact = Buffer.from(JSON.stringify({ entries: [{ projectedEntryId: OUTSIDE_ENTRY }] }), 'utf8');
    outside = join(at, '..', 'phase10-audit-outside.json');
    writeFileSync(outside, artifact);
    pointer['artifactName'] = '../phase10-audit-outside.json';
    pointer['artifactBytes'] = artifact.length;
    pointer['manifestDigest'] = manifestDigestOfBytes(artifact);
  });
  try {
    assertEq(readPublishedEntryIds(configFor(dir)).size, 0,
      'a hand-edited pointer read a file from outside the directory this command owns');
  } finally {
    rmSync(outside, { force: true });
  }
});

h.section('containment: the walk from the media root, following nothing');

/** A host whose filesystem is a map from absolute path to kind. Anything unnamed is missing. */
function treeHost(tree: Readonly<Record<string, ContentFileStat['kind']>>, body: unknown = []): ContentHost {
  return {
    hasPosixModes: true,
    async stat(absolutePath) {
      const kind = tree[absolutePath];
      return kind === undefined
        ? fileStat({ kind: 'missing' })
        : fileStat({ kind, sizeBytes: kind === 'file' ? 1024 : 0 });
    },
    async readFile() { return JSON.stringify(body); },
    async digestWindow() { return 'a'.repeat(64); },
  };
}

const MEDIA = CONFIG.mediaRoot;

test('an ORDINARY tree walks clean, so the check refuses something rather than everything', async () => {
  const host = treeHost({ [MEDIA]: 'directory', [`${MEDIA}/movies`]: 'directory', [`${MEDIA}/movies/a.bin`]: 'file' });
  assertEq(await checkPathComponents(host, MEDIA, 'movies/a.bin'), 'ok', 'a plain directory tree was refused');
});

test('a SYMLINKED DIRECTORY on the way to the file is caught, which one lstat on the leaf cannot see', async () => {
  // The leaf is a perfectly ordinary regular file. It is a regular file in SOMEBODY ELSE'S share, reached
  // through a link this contract never follows — which is exactly what an lstat on the leaf reports as fine.
  const host = treeHost({ [MEDIA]: 'directory', [`${MEDIA}/movies`]: 'symlink', [`${MEDIA}/movies/a.bin`]: 'file' });
  assertEq(await checkPathComponents(host, MEDIA, 'movies/a.bin'), 'component-is-symlink',
    'a symbolic link on the way to the file was followed');
});

test('a media root that is itself a link is refused before any component is walked', async () => {
  assertEq(await checkPathComponents(treeHost({ [MEDIA]: 'symlink' }), MEDIA, 'movies/a.bin'), 'root-is-symlink',
    'the media root was followed');
});

test('a MISSING component is not a containment answer, because "not there" is the caller\'s own sentence', async () => {
  assertEq(await checkPathComponents(treeHost({ [MEDIA]: 'directory' }), MEDIA, 'movies/a.bin'), 'ok',
    'an absent file was reported as a containment problem rather than as an absent file');
});

test('add-local REFUSES a file reached through a symlinked directory, and never opens a connection', async () => {
  const objects = [{ label: 'a', itemId: ITEM, path: 'Movies/A/A.bin', relativePath: 'movies/a.bin' }];
  const host = treeHost(
    { '/tmp/local.json': 'file', [MEDIA]: 'directory', [`${MEDIA}/movies`]: 'symlink', [`${MEDIA}/movies/a.bin`]: 'file' },
    objects);
  let code = '';
  try { await addLocalObjects(CONFIG, host, '/tmp/local.json', 'postgresql://127.0.0.1:1/nothing'); }
  catch (error) { code = (error as ContentCommandError).code ?? ''; }
  assertEq(code, 'LOCAL_PATH_NOT_CONTAINED',
    'a file outside the media root was registered as a local source under it, and the locator every later '
    + 'reader resolves would resolve through the same link');
});

test('reconcile walks the components too, so a link that appeared later is reported', () => {
  const source = read('src/ops/projection-content.ts');
  const body = source.slice(source.indexOf('export async function reconcileContent'),
    source.indexOf('function readPublishedEntryIds'));
  assert(body.includes('checkPathComponents('),
    'reconcile stats the leaf through whatever the path resolves to, so a component that became a link after '
    + 'registration would be reported as agreeing');
});

h.section('an `add` is ONE transaction, and it refuses before it writes');

/** A `Queryable` that records every statement and can be told to refuse the nth registration. */
function recordingDb(failOn?: string): { readonly statements: string[]; readonly db: Queryable } {
  const statements: string[] = [];
  return {
    statements,
    db: {
      async query(text: string) {
        statements.push(text);
        if (failOn !== undefined && text.includes(failOn)) throw new Error('the registry refused this row');
        return { rows: [] };
      },
    },
  };
}

test('a successful add COMMITS, and every registration is inside the one transaction', async () => {
  const { statements, db } = recordingDb();
  await inRegistryTransaction(db, async () => { await db.query('SELECT cat_projection_entry_register(...)'); });
  assertEq(statements[0], 'BEGIN', 'the registrations did not open a transaction');
  assertEq(statements[statements.length - 1], 'COMMIT', 'the transaction was never committed');
});

test('a registration refused half way ROLLS BACK, so a failed add leaves NOTHING registered', async () => {
  const { statements, db } = recordingDb('entry_register');
  let message = '';
  try {
    await inRegistryTransaction(db, async () => {
      await db.query('SELECT cat_projection_version_register(...)');
      await db.query('SELECT cat_projection_entry_register(...)');
    });
  } catch (error) { message = (error as Error).message; }
  assertEq(message, 'the registry refused this row',
    'the rollback swallowed the cause, so the operator would be told about the recovery and not the refusal');
  assert(statements.includes('ROLLBACK'),
    'a run that registered a version and then had its entry refused left the version behind — the half-changed '
    + 'namespace the add verbs exist not to leave');
  assert(!statements.includes('COMMIT'), 'a refused add committed anyway');
});

test('add-torbox refuses a probe plan BEFORE it opens a connection, so nothing is written to undo', async () => {
  // THE ORDERING IS THE ASSERTION. The database is deliberately unreachable: if the refusal arrives first,
  // this fails on the plan, and if the write loop is reached first it fails on the connection. An earlier
  // draft called `probePlanFor` inside the loop, so object 2's refusal arrived after object 1 was written.
  const objects = [
    { label: 'first', itemId: ITEM, path: 'Movies/A/A.bin', ref: 'opaque-one', sizeBytes: 4194304, mtime: '2026-06-01T10:00:00.000Z' },
    { label: 'second', itemId: ITEM, path: 'Movies/B/B.bin', ref: 'opaque-two', sizeBytes: 4194304, mtime: '2026-06-01T10:00:00.000Z', probeDigests: [] },
  ];
  let code = '';
  try {
    await addTorboxObjects(CONFIG, hostWith(objects), '/tmp/objects.json', 'postgresql://127.0.0.1:1/nothing');
  } catch (error) { code = (error as ContentCommandError).code ?? ''; }
  assertEq(code, 'OBJECT_PROBE_PLAN_MISMATCH',
    'the second object\'s probe plan was checked after a connection had been opened for the first one');
});

test('both add verbs run their writes through the transaction, structurally', () => {
  const source = read('src/ops/projection-content.ts');
  for (const verb of ['addTorboxObjects', 'addLocalObjects']) {
    const body = source.slice(source.indexOf(`export async function ${verb}`));
    const withinVerb = body.slice(0, body.indexOf('\n}\n') + 1);
    assert(withinVerb.includes('inRegistryTransaction('),
      `${verb} writes outside a transaction, so a refusal half way through leaves the earlier rows behind`);
    // AND THROUGH THE WORDED VERSION REGISTRATION. `cat_projection_version_register` RAISES when a key is
    // re-asserted with different bytes — the case an operator reaches by touching a file — and after the
    // error-path repair the CLI withholds any message this project did not compose, so a driver exception
    // there would reach them as a SQLSTATE and nothing else.
    assert(withinVerb.includes('registerVersionOrExplain('),
      `${verb} registers a version without wording the one refusal an operator can reach through ordinary use`);
  }
});

h.section('the refusals that are structural rather than asserted');

test('reconcile contains no write: not a register, not a degrade, not a publish', () => {
  const source = read('src/ops/projection-content.ts');
  const body = source.slice(source.indexOf('export async function reconcileContent'),
    source.indexOf('function readPublishedEntryIds'));
  for (const forbidden of ['registerEntry(', 'registerVersion(', 'registerRoot(', 'degradeEntry(', 'restoreEntry(',
    'retireEntry(', 'publishGeneration(', 'publishContent(']) {
    assert(!body.includes(forbidden),
      `reconcile calls ${forbidden}, and §4's second hard refusal is that a report never acts`);
  }
});

/**
 * The content plane's source with its comments removed.
 *
 * COMMENTS ARE STRIPPED BEFORE SCANNING, and that is not a loophole. These files ARGUE about the appliance —
 * why they do not own the mount point, why an argument is not a place for a reference that `docker inspect`
 * prints in full — and a check that grepped the whole file would fail on the explanation. A pin that punishes
 * a file for explaining itself is a pin that gets the explanation deleted.
 */
const contentPlaneCode = (): string => `${read('src/ops/projection-content.ts')}\n${read('src/ops/projection-content-cli.ts')}`
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

test('the content plane never writes inside the mount point and never touches the appliance', () => {
  const code = contentPlaneCode();
  for (const forbidden of ['fusermount', 'umount', 'docker ', 'projection-alpha', 'child_process', 'execSync']) {
    assert(!code.includes(forbidden), `the content plane names ${forbidden}, which is the appliance's own`);
  }
});

test('the content plane contacts no provider and never names endpoint.json', () => {
  const code = contentPlaneCode();
  for (const forbidden of ['endpoint.json', 'fetch(', 'https://', 'http://', 'net.connect', 'sabnzbd']) {
    assert(!code.includes(forbidden),
      `the content plane names ${forbidden}; Phase 10 is provider-free BY CONSTRUCTION and §4's third hard `
      + 'refusal says endpoint.json is not read, written or touched at any point');
  }
});

test('the shipped script refuses to publish implicitly, and says so where an operator reads it', () => {
  const script = read('deploy/projection-content.sh');
  assert(/NOTHING PUBLISHES IMPLICITLY/.test(script), 'the shipped script does not say publishing is explicit');
  assert(/never writes inside the projection mount point/.test(script), 'the script does not state the refusal');
  assert(!/projection-alpha\.sh/.test(script.split('# WHAT IT NEVER DOES')[1] ?? ''),
    'the content script invokes the appliance command');
});

h.section('wiring');

test('this suite leaves no temporary directory behind', () => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
  assert(true, 'unreachable');
});

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-content-command.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'projection-content-command.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

await h.finish();
