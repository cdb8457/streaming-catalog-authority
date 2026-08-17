import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq, assertThrows } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  ContentCommandError,
  contentVersionKeyFor,
  isUnder,
  isoOf,
  parseContentConfig,
  probePlanFor,
  readObjectsFile,
  renderAdd,
  renderHold,
  renderReconcile,
  renderStatus,
  type ContentFileStat,
  type ContentHost,
} from '../src/ops/projection-content.js';
import { parseArgs } from '../src/ops/projection-content-cli.js';
import { PHASE10_DIVERGENCE_CODES, PHASE10_DIVERGENCE_MEANINGS } from '../src/core/projection/phase10.js';
import { probeOffsetsFor, PROJECTION_PROBE_PLAN } from '../src/core/projection/manifest-v1.js';

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
// IT OPENS NO CONNECTION, READS NO REAL FILE AND CONTACTS NOTHING: the host boundary is injected.

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

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-content-command.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'projection-content-command.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

await h.finish();
