import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPORT_MAX_ENTRIES,
  EXTERNAL_EXPORT_FORMAT,
  EXTERNAL_EXPORT_VERSION,
  EXTERNAL_REFERENCE_KINDS,
  EXTERNAL_SOURCE_PREFIX,
  FORBIDDEN_ATTRIBUTE_PREFIXES,
  CatalogExportError,
  looksLikeLocation,
  parseExternalExport,
  produceCatalogSnapshot,
} from '../src/core/catalog/external-export.js';
import {
  CATALOG_SNAPSHOT_FORMAT,
  IMPORT_MAX_BYTES,
  deriveItemId,
  parseCatalogSnapshot,
} from '../src/core/catalog/import-snapshot.js';
import {
  SNAPSHOT_OUT_DIR_ENV,
  SNAPSHOT_PRODUCE_REPORT,
  SnapshotProducePathError,
  produceSnapshotFile,
  publishTemporary,
  realModeSurface,
  renderSnapshotProduction,
  resolveProducedSnapshotPath,
  writeAtomically,
} from '../src/ops/catalog-snapshot-produce.js';
import { parseProduceArgs, SnapshotProduceUsageError } from '../src/ops/catalog-snapshot-produce-cli.js';
import { INBOX_NAME_RE, listImportInbox } from '../src/ops/catalog-import-inbox.js';
import { CATALOG_IMPORT_DIR_ENV } from '../src/ops/catalog-import.js';

// Phase 274 — producing the canonical import snapshot from an operator-supplied export of an EXTERNAL system.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - THE TRANSFORMATION PERFORMS NO I/O, AND THAT IS CHECKED AGAINST THE MODULE'S OWN IMPORTS. The core
//     module cannot open a file, a socket or a process, so "producing a snapshot contacted nothing" is a fact
//     about what it is made of rather than a promise about what it did.
//   - ACQUISITION DATA IS REFUSED WHOLE, NOT FILTERED. A download URL, an NZB or torrent key, a tracker, a
//     magnet link, an absolute media path or a UNC share in an export is a REJECTION. A silent drop would let
//     one reappear the moment somebody deleted a filter.
//   - THE OUTPUT IS DETERMINISTIC TO THE BYTE, and independent of the order the export happened to be in.
//   - THE OUTPUT IS PROVED IMPORTABLE BY THE SHIPPED IMPORTER, not by a second model of the format.
//   - PROVENANCE IS STRUCTURAL: every produced record's source is `external.<system>`, so every derived item
//     id is a function of it and a produced record can never collide with a hand-written one.
//   - THE WRITE IS ATOMIC AND SYMLINK-SAFE, leaves no temporary file behind, refuses to clobber by accident,
//     refuses to write through a link, and leaves the previous file intact when it refuses.
//   - A PREVIEW WRITES NOTHING, STRUCTURALLY: with no output there is no path in the function's scope.
//   - THE REPORT IS REDACTION-SAFE: no title, reference value, attribute value or directory in it anywhere.
//   - THE PRODUCED NAME IS ONE THE IMPORT INBOX WILL OFFER, so the produce -> preview -> apply workflow has
//     no hole in the middle of it.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
function rejects(fn: () => unknown, needle: string, msg: string): void {
  try { fn(); } catch (err) {
    const problems = err instanceof CatalogExportError ? err.problems.join(' | ') : (err as Error).message;
    assert(problems.includes(needle), `${msg}: expected a problem mentioning "${needle}", got ${problems}`);
    return;
  }
  throw new Error(`${msg}: nothing was rejected`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepo = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8').split('\r\n').join('\n');

const WORK = mkdtempSync(join(tmpdir(), 'ca-produce-'));
const OUT = join(WORK, 'out');
mkdirSync(OUT, { recursive: true });

const SECRET_TITLE = 'A Title That Must Never Appear In A Report';
const SECRET_REF = 'tt-phase274-ref-value-must-never-be-disclosed';
const SECRET_ATTR = 'a-note-that-must-never-appear-in-a-report';
/** The external system's own label. The SNAPSHOT keeps it; the support report must not. */
const SECRET_SYSTEM = 'torbox';

const exportDoc = (entries: unknown[], overrides: Record<string, unknown> = {}): string => JSON.stringify({
  format: EXTERNAL_EXPORT_FORMAT,
  version: EXTERNAL_EXPORT_VERSION,
  system: SECRET_SYSTEM,
  entries,
  ...overrides,
});

const SAMPLE = exportDoc([
  { entryId: 'e-2', title: 'Second', year: 2001, references: [{ kind: 'tmdb_id', id: 'tmdb-2' }] },
  { entryId: 'e-1', title: SECRET_TITLE, year: 1994, references: [{ kind: 'imdb_id', id: SECRET_REF }], attributes: { note: SECRET_ATTR } },
  { entryId: 'e-3', title: 'Third' },
]);

console.log('Running Phase 274 external snapshot production suite:\n');

// ---------------------------------------------------------------------------------------------------------
// The shape of the modules themselves.
// ---------------------------------------------------------------------------------------------------------

test('the transformation module cannot perform I/O of any kind', () => {
  const source = readRepo('src/core/catalog/external-export.ts');
  const imports = [...source.matchAll(/^import[^\n]*from '([^']+)';/gm)].map((m) => m[1]!);
  assert(imports.length > 0, 'it has imports to check');
  for (const specifier of imports) {
    assert(specifier === 'node:crypto' || specifier.startsWith('./'),
      `the transformation module imports ${specifier}, which is not node:crypto or a sibling catalog module`);
  }
  // The token scan is deliberately crude and deliberately includes comments: a module that must not be able
  // to reach the network must not describe itself in the spelling that would reach it either.
  for (const forbidden of ['node:fs', 'node:http', 'node:https', 'node:net', 'node:dns', 'node:child_process',
    'readFileSync', 'writeFileSync', 'process.env', 'symlinkSync', 'linkSync']) {
    assert(!source.includes(forbidden), `the transformation module must not name ${forbidden}`);
  }
  // `fetch` is scanned for as a call, exactly as test/deploy.ts scans the Jellyfin adapter.
  assert(!/\bfetch\s*\(/.test(source), 'the transformation module must not call a transport');
});

test('the writing module creates no SYMBOLIC link, no media link and no directory', () => {
  const source = readRepo('src/ops/catalog-snapshot-produce.ts');
  for (const forbidden of ['symlinkSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'node:http', 'node:net',
    'node:child_process', 'node:dns']) {
    assert(!source.includes(forbidden), `the writing module must not name ${forbidden}`);
  }
  assert(!/\bfetch\s*\(/.test(source), 'the writing module must not call a transport');

  // THE INVARIANT IS "NO SYMBOLIC LINK AND NO MEDIA LINK", NOT "NO `linkSync`".
  //
  // An earlier version of this test forbade `linkSync` outright, and that was the wrong invariant stated in
  // the wrong place: it forbade the ONE primitive that can publish a file to a name only if the name is free,
  // which is what makes the default refusal a guarantee rather than a check a second producer runs past. A
  // hard link between two names of one snapshot file in one directory is not a symbolic link, does not point
  // into a media library, and lives for microseconds. So the scan now pins what actually matters, and pins
  // the primitive's PURPOSE so it cannot quietly become something else.
  assert(/(?<![A-Za-z])linkSync\(temporary, destination\)/.test(source),
    'the no-overwrite publish is a hard link from the temporary name to the destination');
  assert(source.includes('unlinkSync'), 'and the temporary name is removed afterwards');
  const linkCalls = [...source.matchAll(/(?<![A-Za-z])linkSync\(/g)].length;
  assertEq(linkCalls, 1, 'and there is exactly ONE link call in the module');
  // No media path can be an argument to it: this module never names one at all.
  for (const media of ['/mnt/', 'Movies', 'media/', '.mkv', '.mp4']) {
    assert(!source.includes(media), `the writing module must not name ${media}`);
  }

  // The atomic-write shape, asserted by the calls it must make rather than by the comment that describes it.
  assert(source.includes('O_EXCL'), 'the temporary file is created exclusively');
  assert(source.includes('fsyncSync(fd)'), 'and flushed before the publish');
  // THE OVERWRITE PATH IS STILL A RENAME, and it is still the ONLY rename in the module. It now reaches the
  // syscall through the replace surface so the win32-only retry can be proved on any host, so the shape is
  // asserted where the surface is built rather than at the call site — and the count is what keeps a second,
  // unretried rename from appearing somewhere else.
  assert(source.includes('rename: (from: string, to: string) => { renameSync(from, to); }'),
    'and the OVERWRITE path is a rename, which replaces');
  assertEq([...source.matchAll(/(?<![A-Za-z.])renameSync\(/g)].length, 1,
    'and there is exactly ONE rename call in the module');
  assert(source.includes("surface.platform === 'win32'"),
    'and the replacing retry is gated on the one platform whose rename fails while a file is merely open');
  assert(source.includes('lstatSync(output.path)'), 'and the destination is examined with lstat, not stat');
  assert(source.includes('fchmod: (fd, mode) => fchmodSync(fd, mode)'),
    'and the published file is made readable on the DESCRIPTOR, so a container running as another uid can import it');
  assert(source.includes('PUBLISHED_FILE_MODE = 0o644'), 'at the one mode a published snapshot carries');
});

test('no production caller passes the publish-window test seam', () => {
  // `beforePublish` exists so a suite can open the exact window a second producer would race through. It is a
  // seam, and a seam that production code started using would be a seam that could skip the publish.
  for (const rel of ['src/ops/catalog-snapshot-produce-cli.ts', 'src/ops/catalog-import-service.ts',
    'src/ops/catalog-import-cli.ts']) {
    assert(!readRepo(rel).includes('beforePublish'), `${rel} must not use the test seam`);
  }
  const module = readRepo('src/ops/catalog-snapshot-produce.ts');
  assertEq([...module.matchAll(/seams\.beforePublish\(\)/g)].length, 1,
    'and the seam is called in exactly one place, immediately before the publish');
  // ...and that call sits INSIDE a cleanup, so a hook that throws cannot leave the completed temporary behind.
  const around = /seams\.beforePublish\(\);\s*\}\s*catch \(err\) \{\s*try \{ unlinkSync\(temporary\); \}/.exec(module);
  assert(around !== null, 'and a hook that throws removes the temporary before rethrowing');
});

test('the CLI reads one file and writes one file, and imports nothing that could open a third', () => {
  const source = readRepo('src/ops/catalog-snapshot-produce-cli.ts');
  for (const forbidden of ['pg', 'getPool', 'CatalogAuthority', 'node:http', 'node:child_process', 'readdirSync']) {
    assert(!source.includes(forbidden), `the produce CLI must not name ${forbidden}`);
  }
  assert(source.includes('isDirectRun(import.meta.url)'), 'and it only runs when it IS the program');
});

// ---------------------------------------------------------------------------------------------------------
// The closed schema.
// ---------------------------------------------------------------------------------------------------------

test('a well-formed export parses, and its system becomes the record source', () => {
  const parsed = parseExternalExport(SAMPLE);
  assertEq(parsed.system, 'torbox', 'the system label survives');
  assertEq(parsed.source, `${EXTERNAL_SOURCE_PREFIX}torbox`, 'and the source is derived from it');
  assertEq(parsed.entries.length, 3, 'every entry parsed');
});

test('the envelope is closed: unknown keys, wrong format, wrong version, bad system', () => {
  rejects(() => parseExternalExport(exportDoc([], { extra: 1 })), 'unknown top-level key', 'an unknown top-level key');
  rejects(() => parseExternalExport(exportDoc([], { format: 'something-else' })), 'format must be', 'a wrong format');
  rejects(() => parseExternalExport(exportDoc([], { version: 2 })), 'version must be', 'a wrong version');
  rejects(() => parseExternalExport(exportDoc([{ entryId: 'a', title: 'b' }], { system: 'Torbox' })), 'system must be', 'an upper-case system');
  rejects(() => parseExternalExport(exportDoc([{ entryId: 'a', title: 'b' }], { system: 'a'.repeat(64) })), 'system is longer', 'an over-long system');
  rejects(() => parseExternalExport('not json'), 'not valid JSON', 'a non-JSON export');
  rejects(() => parseExternalExport('[]'), 'must be a JSON object', 'an array export');
  rejects(() => parseExternalExport(exportDoc([])), 'entries is empty', 'an empty export');
});

test('an entry is closed: unknown keys, missing id or title, a duplicate, a bad year', () => {
  rejects(() => parseExternalExport(exportDoc([{ entryId: 'a', title: 'b', extra: 1 }])), 'unknown key(s); only entryId', 'an unknown entry key');
  rejects(() => parseExternalExport(exportDoc([{ title: 'b' }])), 'entryId is required', 'a missing entryId');
  rejects(() => parseExternalExport(exportDoc([{ entryId: 'a' }])), 'title is required', 'a missing title');
  rejects(() => parseExternalExport(exportDoc([{ entryId: 'a', title: '   ' }])), 'title is required', 'a blank title');
  rejects(() => parseExternalExport(exportDoc([{ entryId: 'a', title: 'b' }, { entryId: 'a', title: 'c' }])), 'duplicate entryId', 'a duplicate');
  rejects(() => parseExternalExport(exportDoc([{ entryId: 'a', title: 'b', year: 1700 }])), 'year must be between', 'an impossible year');
  rejects(() => parseExternalExport(exportDoc([{ entryId: 'a', title: 'b', year: 1994.5 }])), 'year must be a whole number', 'a fractional year');
  rejects(() => parseExternalExport(exportDoc([{ entryId: 'a', title: `b${String.fromCharCode(7)}` }])), 'control characters', 'a control character');
});

test('a rejection names the field and the position and NEVER the value', () => {
  try {
    parseExternalExport(exportDoc([{ entryId: 'e-1', title: SECRET_TITLE, attributes: { 'download.url': 'x' } }]));
    throw new Error('the export should have been rejected');
  } catch (err) {
    assert(err instanceof CatalogExportError, 'it is an export rejection');
    const text = err.problems.join('\n');
    assert(text.includes('entry 0'), 'the position is named');
    assert(!text.includes(SECRET_TITLE), 'and the title is not echoed');
  }
});

test('the reference vocabulary is closed, and an unknown kind is a rejection rather than a dropped reference', () => {
  rejects(() => parseExternalExport(exportDoc([{ entryId: 'a', title: 'b', references: [{ kind: 'plex', id: 'x' }] }])),
    'kind must be one of', 'an unknown reference kind');
  rejects(() => parseExternalExport(exportDoc([{ entryId: 'a', title: 'b', references: [{ kind: 'imdb', id: 'x', extra: 1 }] }])),
    'unknown key(s); only kind, id', 'an unknown reference key');
  rejects(() => parseExternalExport(exportDoc([{ entryId: 'a', title: 'b', references: [{ kind: 'imdb', id: 'x' }, { kind: 'imdb_id', id: 'y' }] }])),
    'already has', 'two spellings of one reference type');
  // Every declared spelling maps to a type the DATABASE's own closed set admits.
  const snapshot = parseCatalogSnapshot(produceCatalogSnapshot(exportDoc(
    Object.keys(EXTERNAL_REFERENCE_KINDS).map((kind, index) => ({
      entryId: `k-${index}`, title: `Kind ${index}`, references: [{ kind, id: `value-${index}` }],
    })),
  )).text);
  assertEq(snapshot.items.length, Object.keys(EXTERNAL_REFERENCE_KINDS).length, 'every declared kind produced a record');
});

// ---------------------------------------------------------------------------------------------------------
// The acquisition boundary.
// ---------------------------------------------------------------------------------------------------------

test('every acquisition and media-location namespace is refused', () => {
  for (const prefix of FORBIDDEN_ATTRIBUTE_PREFIXES) {
    rejects(() => parseExternalExport(exportDoc([{ entryId: 'a', title: 'b', attributes: { [`${prefix}.value`]: 'x' } }])),
      'acquisition or media-location namespace', `the ${prefix} namespace`);
    rejects(() => parseExternalExport(exportDoc([{ entryId: 'a', title: 'b', attributes: { [prefix]: 'x' } }])),
      'acquisition or media-location namespace', `the bare ${prefix} key`);
  }
  rejects(() => parseExternalExport(exportDoc([{ entryId: 'a', title: 'b', attributes: { 'external.system': 'forged' } }])),
    'namespace, which Catalog Authority reserves', 'a forged provenance key');
});

test('a value that points somewhere is refused, wherever it appears', () => {
  for (const location of [
    'https://example.invalid/get?token=1',
    'http://10.0.0.5:8080/file.mkv',
    'magnet:?xt=urn:btih:abc',
    'file:/var/lib/thing',
    '/mnt/user/media/Movies/Thing (1994)/Thing.mkv',
    '\\\\server\\share\\thing.mkv',
    'C:\\media\\thing.mkv',
    'D:/media/thing.mkv',
  ]) {
    assert(looksLikeLocation(location), `${location} is a location`);
    rejects(() => parseExternalExport(exportDoc([{ entryId: 'a', title: 'b', attributes: { note: location } }])),
      'URL or a filesystem path', `an attribute holding ${location}`);
    rejects(() => parseExternalExport(exportDoc([{ entryId: 'a', title: 'b', references: [{ kind: 'imdb', id: location }] }])),
      'URL or a filesystem path', `a reference holding ${location}`);
  }
  rejects(() => parseExternalExport(exportDoc([{ entryId: 'https://example.invalid/x', title: 'b' }])),
    'URL or a filesystem path', 'an entry id holding a URL');
  // ...and an ordinary value is NOT a location, so the check is not merely refusing everything.
  for (const ordinary of ['tt1234567', 'a note', 'Shelf: A1', '2001', 'imdb-x_y.z']) {
    assert(!looksLikeLocation(ordinary), `${ordinary} is not a location`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// Bounds.
// ---------------------------------------------------------------------------------------------------------

test('the input and the output are both bounded, and a bound is a refusal', () => {
  const oversize = `{"format":"${EXTERNAL_EXPORT_FORMAT}","version":1,"system":"x","entries":[],"pad":"${'a'.repeat(IMPORT_MAX_BYTES)}"}`;
  rejects(() => parseExternalExport(oversize), 'over the', 'an over-large export');

  const tooMany = exportDoc(Array.from({ length: EXPORT_MAX_ENTRIES + 1 }, (_, i) => ({ entryId: `e-${i}`, title: 'x' })));
  rejects(() => parseExternalExport(tooMany), 'over the', 'too many entries');

  // A valid export whose PRODUCED document exceeds the importer's limit is refused before anything is
  // written, rather than discovered at import time. Pretty-printing is what makes the output bigger than the
  // input, so this uses many SHORT attributes: the per-line indent is the difference.
  const attributes: Record<string, string> = {};
  for (let i = 0; i < 24; i += 1) attributes[`a${String(i).padStart(2, '0')}`] = 'v'.repeat(30);
  const fat = exportDoc(Array.from({ length: 7500 }, (_, i) => ({ entryId: `e-${i}`, title: 'T', attributes })));
  // ASSERTED, NOT ASSUMED: if the INPUT were over its own bound this test would pass for the wrong reason,
  // reporting the input guard as if it were the output guard.
  assert(Buffer.byteLength(fat, 'utf8') < IMPORT_MAX_BYTES,
    'the fixture must be a LEGAL export, or this proves the input bound rather than the output bound');
  rejects(() => produceCatalogSnapshot(fat), "over the importer's", 'a snapshot larger than the importer accepts');
});

// ---------------------------------------------------------------------------------------------------------
// Determinism, provenance and the shipped importer's own verdict.
// ---------------------------------------------------------------------------------------------------------

test('the same export produces byte-identical output, whatever order it arrived in', () => {
  const a = produceCatalogSnapshot(SAMPLE);
  const b = produceCatalogSnapshot(SAMPLE);
  assertEq(a.text, b.text, 'two runs produce the same bytes');
  assertEq(a.contentDigest, b.contentDigest, 'and the same content digest');

  const reordered = exportDoc([
    { entryId: 'e-3', title: 'Third' },
    { entryId: 'e-1', title: SECRET_TITLE, year: 1994, references: [{ kind: 'imdb_id', id: SECRET_REF }], attributes: { note: SECRET_ATTR } },
    { entryId: 'e-2', title: 'Second', year: 2001, references: [{ kind: 'tmdb_id', id: 'tmdb-2' }] },
  ]);
  const c = produceCatalogSnapshot(reordered);
  assertEq(c.text, a.text, 'a reordered export produces the same file');
  assertEq(c.contentDigest, a.contentDigest, 'and the same content digest');
  assert(c.inputDigest !== a.inputDigest, 'while the INPUT digest correctly differs');
});

test('the produced document is parsed by the SHIPPED importer before it is returned', () => {
  const produced = produceCatalogSnapshot(SAMPLE);
  const reparsed = parseCatalogSnapshot(produced.text);
  assertEq(reparsed.format, CATALOG_SNAPSHOT_FORMAT, 'it is the canonical format');
  assertEq(reparsed.digest, produced.snapshot.digest, 'and the digest the producer reports is the importer\'s own');
  assertEq(reparsed.items.length, 3, 'three records');
  assert(produced.text.endsWith('}\n'), 'and it ends with exactly one newline');
});

test('provenance is structural: every derived item id is a function of external.<system>', () => {
  const produced = produceCatalogSnapshot(SAMPLE);
  assertEq(produced.source, 'external.torbox', 'the source declares the external system');
  for (const item of produced.snapshot.items) {
    assertEq(item.itemId, deriveItemId('external.torbox', item.externalId), 'the item id derives from that source');
    assert(item.itemId !== deriveItemId('torbox', item.externalId), 'and NOT from a bare system name');
  }
  // A hand-written snapshot using the same external ids addresses DIFFERENT records, which is the whole
  // point of the prefix.
  const handWritten = parseCatalogSnapshot(JSON.stringify({
    format: CATALOG_SNAPSHOT_FORMAT, version: 1, source: 'torbox',
    items: [{ externalId: 'e-1', title: 'Something' }],
  }));
  assert(handWritten.items[0]!.itemId !== produced.snapshot.items.find((i) => i.externalId === 'e-1')!.itemId,
    'a hand-written snapshot cannot address a produced record by accident');
});

test('references and attributes come out in a total order', () => {
  const produced = produceCatalogSnapshot(exportDoc([{
    entryId: 'e-1', title: 'Ordered',
    references: [{ kind: 'tvdb', id: 'c' }, { kind: 'imdb', id: 'a' }, { kind: 'tmdb', id: 'b' }],
    attributes: { zeta: '1', alpha: '2', mu: '3' },
  }]));
  const item = produced.snapshot.items[0]!;
  assertEq(item.providerRefs.map((r) => r.type).join(','), 'imdb,tmdb,tvdb', 'references are ordered by type');
  assertEq(Object.keys(item.metadata).sort().join(','), 'alpha,mu,zeta', 'and attributes by key');
  assertEq(produced.text.indexOf('"alpha"') < produced.text.indexOf('"mu"'), true, 'and the BYTES are in that order too');
});

// ---------------------------------------------------------------------------------------------------------
// The write.
// ---------------------------------------------------------------------------------------------------------

test('a preview writes nothing at all', () => {
  const before = readdirSync(OUT);
  const report = produceSnapshotFile({ text: SAMPLE });
  assertEq(report.mode, 'preview', 'it is a preview');
  assertEq(report.fileName, null, 'it names no file');
  assertEq(readdirSync(OUT).join(','), before.join(','), 'and the output directory is unchanged');
});

test('the write is atomic, complete, and leaves no temporary file behind', () => {
  const output = resolveProducedSnapshotPath(join(OUT, 'produced.json'), {});
  const report = produceSnapshotFile({ text: SAMPLE, output });
  assertEq(report.mode, 'write', 'it wrote');
  assertEq(report.fileName, 'produced.json', 'and it names the base name');
  assertEq(report.replaced, false, 'and nothing was replaced');
  const bytes = readFileSync(output.path);
  assertEq(createHash('sha256').update(bytes).digest('hex'), report.contentDigest,
    'the bytes on disk are exactly the bytes the report describes');
  assertEq(readdirSync(OUT).filter((n) => n.startsWith('.')).length, 0, 'no temporary file survived');
  // ...and what landed is importable.
  assertEq(parseCatalogSnapshot(bytes.toString('utf8')).items.length, 3, 'and the file imports');
});

test('an existing file is not clobbered by accident, and the old one survives the refusal', () => {
  const output = resolveProducedSnapshotPath(join(OUT, 'produced.json'), {});
  const before = readFileSync(output.path, 'utf8');
  let refused = false;
  try { produceSnapshotFile({ text: SAMPLE, output }); }
  catch (err) { refused = err instanceof SnapshotProducePathError && err.message.includes('--overwrite'); }
  assert(refused, 'a second write without --overwrite is refused');
  assertEq(readFileSync(output.path, 'utf8'), before, 'and the file that was there is untouched');
  assertEq(readdirSync(OUT).filter((n) => n.startsWith('.')).length, 0, 'and no temporary file was left');

  const replaced = produceSnapshotFile({ text: exportDoc([{ entryId: 'x-1', title: 'Replacement' }]), output, overwrite: true });
  assertEq(replaced.replaced, true, 'with --overwrite it replaces');
  assertEq(parseCatalogSnapshot(readFileSync(output.path, 'utf8')).items.length, 1, 'and the new document is there');
});

// ---------------------------------------------------------------------------------------------------------
// THE NO-OVERWRITE GUARANTEE IS ABOUT A WINDOW, AND THE WINDOW IS OPENED ON PURPOSE.
//
// The refusal above is the EASY case: the file was already there when the producer looked. The case that
// matters is the one a check cannot cover — the destination appearing BETWEEN the look and the publish, which
// is what two producers started a moment apart actually do. These tests open exactly that window, with the
// seam the module carries for the purpose, so the guarantee is proved rather than argued. Nothing here
// depends on timing, on scheduling, or on a second process.
// ---------------------------------------------------------------------------------------------------------

test('a destination that appears IN THE PUBLISH WINDOW is not replaced, and the rival bytes survive', () => {
  const output = resolveProducedSnapshotPath(join(OUT, 'raced.json'), {});
  const rival = '{"a rival producer":"got there first"}\n';
  let opened = 0;
  let refused = '';
  try {
    produceSnapshotFile({
      text: SAMPLE,
      output,
      // THE EXACT WINDOW: the temporary file is complete and fsynced, the destination was free when this
      // producer looked, and now somebody else's completed snapshot is at the name.
      beforePublish: () => { opened += 1; writeFileSync(output.path, rival, 'utf8'); },
    });
  } catch (err) {
    refused = err instanceof SnapshotProducePathError ? err.message : `unexpected: ${(err as Error).message}`;
  }
  assertEq(opened, 1, 'the window really was opened, so this test is not vacuous');
  assert(refused.includes('--overwrite'), `the racing publish must refuse, got: ${refused || 'no refusal at all'}`);
  assertEq(readFileSync(output.path, 'utf8'), rival, 'and the rival\'s complete bytes are exactly what survived');
  assertEq(readdirSync(OUT).filter((n) => n.startsWith('.')).length, 0, 'and the loser left no temporary file behind');
  rmSync(output.path);
});

test('two no-overwrite publishers cannot both succeed, and the winner is complete', () => {
  // The publish step driven directly with two independently completed temporaries — which is what two
  // concurrent producers hold at the moment they both try to take the name. No interleaving is simulated:
  // both files exist, both are complete, and the kernel decides.
  const destination = join(OUT, 'contended.json');
  const first = join(OUT, '.contended.json.tmp-a');
  const second = join(OUT, '.contended.json.tmp-b');
  writeFileSync(first, 'FIRST PRODUCER, COMPLETE\n', 'utf8');
  writeFileSync(second, 'SECOND PRODUCER, COMPLETE\n', 'utf8');

  publishTemporary(first, destination, false);
  assertEq(readFileSync(destination, 'utf8'), 'FIRST PRODUCER, COMPLETE\n', 'the first publisher took the name');
  assertEq(existsSync(first), false, 'and its temporary name is gone');

  let refused = '';
  try { publishTemporary(second, destination, false); }
  catch (err) { refused = err instanceof SnapshotProducePathError ? err.message : `unexpected: ${(err as Error).message}`; }
  assert(refused.includes('--overwrite'), `the second publisher must lose, got: ${refused || 'no refusal at all'}`);
  assertEq(readFileSync(destination, 'utf8'), 'FIRST PRODUCER, COMPLETE\n', 'and the winner\'s bytes are untouched');
  assertEq(existsSync(second), false, 'and the loser cleaned up its own temporary file');

  // ...while the OVERWRITE path deliberately does replace, because that is what was asked for.
  const third = join(OUT, '.contended.json.tmp-c');
  writeFileSync(third, 'DELIBERATE REPLACEMENT\n', 'utf8');
  publishTemporary(third, destination, true);
  assertEq(readFileSync(destination, 'utf8'), 'DELIBERATE REPLACEMENT\n', 'an explicit overwrite replaces');
  rmSync(destination);
});

// ---------------------------------------------------------------------------------------------------------
// A REPLACING PUBLISH IS RETRIED ON WINDOWS AND NOWHERE ELSE, AND BOTH HALVES ARE PROVED HERE.
//
// THE DEFECT. On Windows a replacing rename returns ERROR_ACCESS_DENIED — `EPERM` — while ANY other handle is
// open on the destination, and a virus scanner opens a file this process has just written. It is transient
// and it is not rare: under concurrent load this very suite failed in 6 of 72 runs at the merge base, and the
// operator-visible result was a produce that deleted its own finished snapshot and reported one opaque
// sentence with no errno in it. Instrumenting the retry showed every occurrence clearing on attempt 29, 32 or
// 45 — 0.6 to 0.9 seconds — so the budget is three seconds and the code is now named in the message.
//
// WHY THESE ARE DRIVEN THROUGH A SURFACE. The retry is win32-only on purpose: on POSIX `rename(2)` cannot
// fail because somebody has the destination open, so `EPERM` there is a real refusal that must stay terminal.
// A suite running on Linux would exercise neither branch, and a suite running on Windows would exercise only
// one — which is the same reason the mode surface beside it exists.
// ---------------------------------------------------------------------------------------------------------

test('a Windows sharing violation is retried until it clears, and the publish succeeds', () => {
  const destination = join(OUT, 'retried.json');
  const temporary = join(OUT, '.retried.json.tmp');
  writeFileSync(temporary, 'PUBLISHED AFTER A SCANNER LET GO\n', 'utf8');

  let attempts = 0;
  let paused = 0;
  publishTemporary(temporary, destination, true, {
    platform: 'win32',
    pause: () => { paused += 1; },
    rename: (from, to) => {
      attempts += 1;
      // Three refusals, exactly the shape Windows produces, and then the scanner lets go.
      if (attempts <= 3) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      renameSync(from, to);
    },
  });

  assertEq(attempts, 4, 'the publish retried until the rename went through');
  assertEq(paused, 3, 'and it paused between attempts rather than spinning');
  assertEq(readFileSync(destination, 'utf8'), 'PUBLISHED AFTER A SCANNER LET GO\n',
    'and the complete bytes are the ones at the destination name');
  assertEq(existsSync(temporary), false, 'and the temporary name is gone');
  rmSync(destination);
});

test('a POSIX EPERM is NOT retried, because there it is a real refusal', () => {
  // THE HALF THAT MATTERS MOST. On POSIX these codes mean a directory without write permission, a mount
  // point, a sticky-bit refusal — permanent, correct answers. Retrying them 150 times would turn a
  // diagnosable error into an intermittent-looking one three seconds later.
  const destination = join(OUT, 'posix-refused.json');
  const temporary = join(OUT, '.posix-refused.json.tmp');
  writeFileSync(temporary, 'NEVER PUBLISHED\n', 'utf8');

  let attempts = 0;
  let refused = '';
  try {
    publishTemporary(temporary, destination, true, {
      platform: 'linux',
      pause: () => { throw new Error('a POSIX refusal must not pause for a retry'); },
      rename: () => {
        attempts += 1;
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      },
    });
  } catch (err) {
    refused = err instanceof SnapshotProducePathError ? err.message : `unexpected: ${(err as Error).message}`;
  }

  assertEq(attempts, 1, 'a POSIX EPERM is answered once and believed');
  assert(refused.includes('(EPERM)'),
    `the refusal must name the errno it got, got: ${refused || 'no refusal at all'}`);
  assertEq(existsSync(destination), false, 'and nothing was published');
  assertEq(existsSync(temporary), false, 'and the temporary was removed');
});

test('a non-sharing failure on Windows is not retried either, and names its code', () => {
  const destination = join(OUT, 'nospace.json');
  const temporary = join(OUT, '.nospace.json.tmp');
  writeFileSync(temporary, 'NEVER PUBLISHED\n', 'utf8');

  let attempts = 0;
  let refused = '';
  try {
    publishTemporary(temporary, destination, true, {
      platform: 'win32',
      pause: () => { throw new Error('a full disk must not be waited out'); },
      rename: () => {
        attempts += 1;
        throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' });
      },
    });
  } catch (err) {
    refused = err instanceof SnapshotProducePathError ? err.message : `unexpected: ${(err as Error).message}`;
  }

  assertEq(attempts, 1, 'only the sharing codes are transient; a full disk is not');
  assert(refused.includes('(ENOSPC)'), `the refusal must name the errno, got: ${refused}`);
  assertEq(existsSync(temporary), false, 'and the temporary was removed');
});

test('the retry is bounded, and an unclearing sharing violation is still refused', () => {
  const destination = join(OUT, 'never-clears.json');
  const temporary = join(OUT, '.never-clears.json.tmp');
  writeFileSync(temporary, 'NEVER PUBLISHED\n', 'utf8');

  let attempts = 0;
  let refused = '';
  try {
    publishTemporary(temporary, destination, true, {
      platform: 'win32',
      pause: () => undefined,
      rename: () => {
        attempts += 1;
        throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
      },
    });
  } catch (err) {
    refused = err instanceof SnapshotProducePathError ? err.message : `unexpected: ${(err as Error).message}`;
  }

  assert(attempts > 1 && attempts <= 200,
    `the retry must be bounded and must have happened; it made ${attempts} attempts`);
  assert(refused.includes('(EBUSY)'), `and must still refuse, naming the errno; got: ${refused}`);
  assertEq(existsSync(destination), false, 'and publish nothing');
  assertEq(existsSync(temporary), false, 'and remove the temporary');
});

test('the no-replace claim is made only on the path that actually keeps it', () => {
  const output = resolveProducedSnapshotPath(join(OUT, 'claims.json'), {});
  const fresh = produceSnapshotFile({ text: SAMPLE, output });
  assert(fresh.notes.some((n) => n.includes('could not have replaced')),
    'a no-overwrite write claims the property it has');

  const replaced = produceSnapshotFile({ text: SAMPLE, output, overwrite: true });
  assert(replaced.notes.every((n) => !n.includes('could not have replaced')),
    'and an --overwrite write does NOT claim a property belonging to the other path');
  assert(replaced.notes.some((n) => n.includes('was replaced')), 'it says what it did instead');
  rmSync(output.path);
});

// ---------------------------------------------------------------------------------------------------------
// MAKING THE SNAPSHOT READABLE IS PART OF PUBLISHING IT, AND IT FAILS CLOSED.
//
// Both branches are driven through an injected surface rather than through whatever platform this suite
// happens to be running on, because a test that could only exercise its own host's branch would leave the
// other one covered by nothing but a reading of the code — which is precisely how the first version came to
// swallow every `fchmod` error under a comment about Windows.
// ---------------------------------------------------------------------------------------------------------

/** A surface that records what it was asked to do and can be told to fail. */
function modeSurface(platform: NodeJS.Platform, fail?: NodeJS.ErrnoException) {
  const calls: string[] = [];
  const surface = {
    platform,
    fchmod(fd: number, mode: number): void {
      calls.push(`fchmod:${mode.toString(8)}`);
      if (fail !== undefined) throw fail;
    },
    fsync(_fd: number): void { calls.push('fsync'); },
  };
  return { surface, calls };
}

function errno(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${code}: operation not permitted, fchmod`);
  err.code = code;
  return err;
}

test('on POSIX, a mode change that FAILS publishes nothing and leaves no temporary behind', () => {
  for (const platform of ['linux', 'darwin', 'freebsd'] as NodeJS.Platform[]) {
    for (const code of ['EPERM', 'EROFS', 'EIO']) {
      const output = resolveProducedSnapshotPath(join(OUT, 'unreadable.json'), {});
      const { surface, calls } = modeSurface(platform, errno(code));
      let refused = '';
      try {
        writeAtomically(output, '{"produced":"bytes"}\n', false, { mode: surface });
      } catch (err) {
        refused = err instanceof SnapshotProducePathError ? err.message : `unexpected: ${(err as Error).message}`;
      }
      assertEq(calls.join(','), 'fchmod:644', `${platform}/${code}: the mode change was attempted and not skipped`);
      assert(refused.includes('could not be made readable'), `${platform}/${code}: it refuses; got ${refused || 'no refusal'}`);
      assert(refused.includes(code), `${platform}/${code}: and names the errno, which is a rule and not a path`);
      // FAIL CLOSED, ON BOTH NAMES.
      assertEq(existsSync(output.path), false, `${platform}/${code}: nothing was published`);
      assertEq(readdirSync(OUT).filter((n) => n.startsWith('.')).length, 0, `${platform}/${code}: and no temporary survived`);
      // ...and the refusal is redaction-safe: it carries no directory and no absolute path.
      for (const forbidden of [OUT, WORK, output.path]) {
        assert(!refused.includes(forbidden), `${platform}/${code}: the refusal leaked a path`);
      }
    }
  }
});

test('on POSIX, a mode change that succeeds is FLUSHED before anything is published', () => {
  const output = resolveProducedSnapshotPath(join(OUT, 'flushed.json'), {});
  const { surface, calls } = modeSurface('linux');
  writeAtomically(output, '{"produced":"bytes"}\n', false, { mode: surface });
  assertEq(calls.join(','), 'fchmod:644,fsync', 'the mode is set and then flushed, in that order');
  assertEq(readFileSync(output.path, 'utf8'), '{"produced":"bytes"}\n', 'and the snapshot published');
  rmSync(output.path);
});

test('on Windows the mode change is SKIPPED by asking the platform, not by catching a failure', () => {
  const output = resolveProducedSnapshotPath(join(OUT, 'windows.json'), {});
  // The surface would THROW if it were called. On win32 it must not be called at all — a bypass that worked
  // by swallowing the error is exactly the bug this replaced.
  const { surface, calls } = modeSurface('win32', errno('EPERM'));
  writeAtomically(output, '{"produced":"bytes"}\n', false, { mode: surface });
  assertEq(calls.length, 0, 'neither the mode change nor its flush was attempted');
  assertEq(readFileSync(output.path, 'utf8'), '{"produced":"bytes"}\n', 'and the snapshot still published');
  rmSync(output.path);
});

test('a flush of the mode change that fails also publishes nothing', () => {
  const output = resolveProducedSnapshotPath(join(OUT, 'unflushed.json'), {});
  const surface = {
    platform: 'linux' as NodeJS.Platform,
    fchmod: (): void => undefined,
    fsync: (): void => { throw errno('EIO'); },
  };
  let refused = '';
  try { writeAtomically(output, '{"produced":"bytes"}\n', false, { mode: surface }); }
  catch (err) { refused = err instanceof SnapshotProducePathError ? err.message : `unexpected: ${(err as Error).message}`; }
  assert(refused.includes('could not be flushed'), `it refuses; got ${refused || 'no refusal'}`);
  assertEq(existsSync(output.path), false, 'nothing was published');
  assertEq(readdirSync(OUT).filter((n) => n.startsWith('.')).length, 0, 'and no temporary survived');
});

test('the real surface is the real platform and the real calls', () => {
  assertEq(realModeSurface.platform, process.platform, 'the shipped surface asks the actual platform');
  const source = readRepo('src/ops/catalog-snapshot-produce.ts');
  // The production path must go through `makePublishable`, not around it, and must not re-acquire a
  // swallow-everything shape.
  assert(source.includes('makePublishable(fd, seams.mode ?? realModeSurface)'),
    'the writer makes the file publishable through the one function that fails closed');
  assert(!/catch\s*\{\s*\/\*[^}]*mode bits/.test(source), 'and no comment-shaped catch swallows a mode failure');
  assertEq([...source.matchAll(/fchmodSync\(/g)].length, 1, 'there is exactly one fchmod call, inside that surface');
});

// ---------------------------------------------------------------------------------------------------------
// THE PUBLISH-WINDOW SEAM CANNOT LEAK A COMPLETED SNAPSHOT EITHER.
// ---------------------------------------------------------------------------------------------------------

test('a publish-window hook that THROWS removes the temporary and publishes nothing', () => {
  const output = resolveProducedSnapshotPath(join(OUT, 'hooked.json'), {});
  const boom = new Error('the suite blew up inside the window');
  let caught: unknown;
  try {
    produceSnapshotFile({ text: SAMPLE, output, beforePublish: () => { throw boom; } });
  } catch (err) { caught = err; }
  assertEq(caught, boom, 'the hook\'s own error propagates unchanged, so a suite can see what went wrong');
  assertEq(existsSync(output.path), false, 'nothing was published');
  // THE TEMPORARY IS COMPLETE BY THIS POINT, so leaking it would leave a whole snapshot in the operator's
  // import folder under a name nothing ever collects.
  assertEq(readdirSync(OUT).filter((n) => n.startsWith('.')).length, 0, 'and the completed temporary is gone');
});

test('a published snapshot is a plain regular file, not a link of any kind, and is readable', () => {
  const output = resolveProducedSnapshotPath(join(OUT, 'published.json'), {});
  produceSnapshotFile({ text: SAMPLE, output });
  const stats = lstatSync(output.path);
  assertEq(stats.isSymbolicLink(), false, 'the published snapshot is not a symbolic link');
  assertEq(stats.isFile(), true, 'it is a regular file');
  // The link used to publish it left exactly ONE name: the temporary is gone.
  assertEq(readdirSync(OUT).filter((n) => n.startsWith('.')).length, 0, 'and no second name for it survives');
  if (process.platform !== 'win32') {
    // The shipped stack bind-mounts the import folder into a container running as a DIFFERENT uid. A 0600
    // snapshot is one the product itself cannot read, which is a failed import rather than a tidy secret.
    assertEq(stats.mode & 0o004, 0o004, 'and it is readable by a process that is not its owner');
    assertEq(stats.mode & 0o022, 0, 'while still not being writable by anyone else');
  }
  rmSync(output.path);
});

test('the destination is never written through a symbolic link', () => {
  const target = join(OUT, 'link-target.json');
  const link = join(OUT, 'a-link.json');
  writeFileSync(target, 'original', 'utf8');
  let created = false;
  try { symlinkSync(target, link); created = true; }
  catch { console.log('       (symlink creation is not permitted on this platform; the link case is not exercised here)'); }
  if (created) {
    assert(lstatSync(link).isSymbolicLink(), 'the fixture really is a link');
    const output = resolveProducedSnapshotPath(link, {});
    let refused = false;
    try { produceSnapshotFile({ text: SAMPLE, output, overwrite: true }); }
    catch (err) { refused = err instanceof SnapshotProducePathError && err.message.includes('symbolic link'); }
    assert(refused, 'writing through a link is refused even with --overwrite');
    assertEq(readFileSync(target, 'utf8'), 'original', 'and the link\'s target is untouched');
    rmSync(link);
  }
  rmSync(target);
});

test('the produced name must be one the import inbox would offer', () => {
  for (const bad of ['produced.txt', '.hidden.json', 'produced json.json', 'a/b.json', 'produced.JSON']) {
    let refused = false;
    try { resolveProducedSnapshotPath(join(OUT, bad), {}); }
    catch (err) { refused = err instanceof SnapshotProducePathError; }
    assert(refused, `${bad} must be refused as an output name`);
  }
  assert(INBOX_NAME_RE.test('produced.json'), 'and a plain name is accepted by the inbox grammar');
  // The real listing offers it, so produce -> preview -> apply has no hole in the middle.
  const listing = listImportInbox({ [CATALOG_IMPORT_DIR_ENV]: OUT } as NodeJS.ProcessEnv);
  if (listing.state === 'UNSUPPORTED_PLATFORM') {
    console.log('       (this platform cannot open without following links, so the inbox offers nothing here)');
  } else {
    assert(listing.candidates.some((c) => c.name === 'produced.json'), 'the inbox offers the produced snapshot');
  }
});

test('a configured output directory admits a bare name and refuses a path', () => {
  const env = { [SNAPSHOT_OUT_DIR_ENV]: OUT } as NodeJS.ProcessEnv;
  const resolved = resolveProducedSnapshotPath('contained.json', env);
  assertEq(resolved.name, 'contained.json', 'a bare name is accepted');
  assertEq(resolved.path.startsWith(resolved.directory), true, 'and lands inside the configured directory');
  for (const escape of ['../escape.json', '/tmp/escape.json', 'sub/escape.json', '..\\escape.json']) {
    let refused = false;
    try { resolveProducedSnapshotPath(escape, env); }
    catch (err) { refused = err instanceof SnapshotProducePathError; }
    assert(refused, `${escape} must be refused when an output directory is configured`);
  }
  let missing = false;
  try { resolveProducedSnapshotPath('x.json', { [SNAPSHOT_OUT_DIR_ENV]: join(WORK, 'nowhere') } as NodeJS.ProcessEnv); }
  catch (err) { missing = err instanceof SnapshotProducePathError && err.message.includes(SNAPSHOT_OUT_DIR_ENV); }
  assert(missing, 'and an output directory that does not exist is named as the constraint');
});

// ---------------------------------------------------------------------------------------------------------
// Redaction.
// ---------------------------------------------------------------------------------------------------------

test('a report names no content, no path, and NOT WHICH external system the export came from', () => {
  const output = resolveProducedSnapshotPath(join(OUT, 'redaction.json'), {});
  const report = produceSnapshotFile({ text: SAMPLE, output });
  const rendered = renderSnapshotProduction(report);
  const serialised = JSON.stringify(report);
  // SECRET_SYSTEM and its derived source are the sentinels this test used to be named after and never
  // checked. The report carried `system: "torbox"` and `source: "external.torbox"` while calling itself
  // redaction-safe — which is to say it told a support bundle which acquisition tool the operator runs.
  for (const forbidden of [SECRET_TITLE, SECRET_REF, SECRET_ATTR, 'Second', 'Third', OUT, WORK,
    SECRET_SYSTEM, `${EXTERNAL_SOURCE_PREFIX}${SECRET_SYSTEM}`]) {
    assert(!rendered.includes(forbidden), `the rendered report must not carry ${forbidden.slice(0, 24)}`);
    assert(!serialised.includes(forbidden), `and neither must the JSON: ${forbidden.slice(0, 24)}`);
  }
  assertEq(report.report, SNAPSHOT_PRODUCE_REPORT, 'the report names itself');
  assertEq(report.provenance, 'external-input', 'it says the records came from an external system');
  assert(!('system' in report), 'and it carries no `system` field at all');
  assert(!('source' in report), 'and no `source` field at all');
  assertEq(report.network, 'none', 'and declares no network');
  assertEq(report.acquisition, 'external-input-only', 'and declares the input as external only');
  assertEq(report.mediaAccess, 'none', 'and declares no media access');
  assertEq(report.symlinksCreated, 0, 'and no symbolic link creation');

  // ...WHILE THE SNAPSHOT ITSELF STILL CARRIES THE REAL PROVENANCE. Removing it from the report must not
  // remove it from the document, because that is where every derived item id comes from.
  const onDisk = parseCatalogSnapshot(readFileSync(output.path, 'utf8'));
  assertEq(onDisk.source, `${EXTERNAL_SOURCE_PREFIX}${SECRET_SYSTEM}`, 'the produced snapshot keeps external.<system>');
  rmSync(output.path);
});

// ---------------------------------------------------------------------------------------------------------
// A KEY IN SOMEBODY ELSE'S DOCUMENT IS A VALUE.
//
// Every rejection below is triggered BY a key, so the key is the hostile part by construction. The sentinels
// are the shapes a key could actually be — a URL, an absolute path, a token, a title — and none of them may
// appear in the problem list, in the thrown message, or on the CLI's stderr.
// ---------------------------------------------------------------------------------------------------------

const HOSTILE_KEYS = [
  'https://exfiltrate.invalid/a?token=hunter2',
  '/mnt/user/media/Movies/Some Film (1994)/Some Film.mkv',
  'sk-live-0123456789abcdef',
  'A Film Title Nobody Should See',
  'nzb.9f8e7d6c5b4a',
];

/**
 * The subset of the above that an ATTRIBUTE key rule actually rejects.
 *
 * `sk-live-0123456789abcdef` is deliberately absent: it is a perfectly legal attribute key, so there is no
 * diagnostic for it to appear in. A test that expected a rejection there would be asserting the wrong thing
 * and would fail for a reason that has nothing to do with redaction.
 */
const HOSTILE_ATTRIBUTE_KEYS = HOSTILE_KEYS.filter((key) => key !== 'sk-live-0123456789abcdef');

function problemsOf(text: string): string[] {
  try { parseExternalExport(text); } catch (err) {
    if (err instanceof CatalogExportError) return [...err.problems, err.message];
    return [(err as Error).message];
  }
  throw new Error('the export should have been rejected');
}

test('an unknown ROOT key is refused without the key reaching the diagnostics', () => {
  for (const hostile of HOSTILE_KEYS) {
    const doc = JSON.stringify({
      format: EXTERNAL_EXPORT_FORMAT, version: EXTERNAL_EXPORT_VERSION, system: SECRET_SYSTEM,
      entries: [{ entryId: 'e-1', title: 'A' }], [hostile]: 'x',
    });
    const text = problemsOf(doc).join('\n');
    assert(!text.includes(hostile), `a root diagnostic echoed ${hostile.slice(0, 32)}`);
    assert(/unknown top-level key/.test(text), 'while still saying what is wrong');
    assert(/format, version, system, entries/.test(text), 'and what IS allowed, which is the actionable part');
  }
});

test('an unknown ENTRY key is refused without the key reaching the diagnostics', () => {
  for (const hostile of HOSTILE_KEYS) {
    const text = problemsOf(exportDoc([{ entryId: 'e-1', title: 'A' }, { entryId: 'e-2', title: 'B', [hostile]: 1 }])).join('\n');
    assert(!text.includes(hostile), `an entry diagnostic echoed ${hostile.slice(0, 32)}`);
    assert(text.includes('entry 1'), 'while naming the position an operator can find it at');
    assert(/entryId, title, year, references, attributes/.test(text), 'and the keys that are allowed');
  }
});

test('an unknown REFERENCE key is refused without the key reaching the diagnostics', () => {
  for (const hostile of HOSTILE_KEYS) {
    const text = problemsOf(exportDoc([
      { entryId: 'e-1', title: 'A', references: [{ kind: 'imdb', id: 'tt1' }, { kind: 'tmdb', id: 't1', [hostile]: 1 }] },
    ])).join('\n');
    assert(!text.includes(hostile), `a reference diagnostic echoed ${hostile.slice(0, 32)}`);
    assert(text.includes('references[1]'), 'while naming the reference position');
    assert(/kind, id/.test(text), 'and the keys that are allowed');
  }
});

test('every ATTRIBUTE rejection is addressed by position, never by the key that caused it', () => {
  // One case per branch of the attribute loop: shape, reserved namespace, acquisition namespace, non-string
  // value, over-long value, control characters, and a location-shaped value.
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['a key that is not a legal shape', { ok: 'v', 'NOT A KEY': 'v' }, 'attributes[1]'],
    ['a reserved key', { ok: 'v', 'external.system': 'forged' }, 'attributes[1]'],
    ['an acquisition key', { ok: 'v', 'nzb.id': 'abc' }, 'attributes[1]'],
    ['a non-string value', { ok: 'v', shelf: 12 }, 'attributes[1]'],
    ['an over-long value', { ok: 'v', shelf: 'x'.repeat(9999) }, 'attributes[1]'],
    ['a control character', { ok: 'v', shelf: `a${String.fromCharCode(7)}b` }, 'attributes[1]'],
    ['a location value', { ok: 'v', shelf: '/mnt/user/media/Movies/x.mkv' }, 'attributes[1]'],
  ];
  for (const [label, attributes, position] of cases) {
    const text = problemsOf(exportDoc([{ entryId: 'e-1', title: 'A', attributes }])).join('\n');
    assert(text.includes(position), `${label}: the diagnostic must name ${position}, got: ${text}`);
    for (const forbidden of ['NOT A KEY', 'external.system', 'nzb.id', '/mnt/user', 'Movies', 'x.mkv']) {
      assert(!text.includes(forbidden), `${label}: the diagnostic echoed ${forbidden}`);
    }
  }
  // ...and a hostile key that is ALSO a location is caught by the key rules without being printed.
  for (const hostile of HOSTILE_ATTRIBUTE_KEYS) {
    const text = problemsOf(exportDoc([{ entryId: 'e-1', title: 'A', attributes: { [hostile]: 'v' } }])).join('\n');
    assert(!text.includes(hostile), `an attribute-key diagnostic echoed ${hostile.slice(0, 32)}`);
    assert(text.includes('attributes[0]'), 'while naming the position');
  }
  // A key the rules DO allow is not rejected at all — so there is no diagnostic, and the key is carried into
  // the snapshot as the operator wrote it. Asserted so the loop above cannot pass by refusing everything.
  const legal = produceCatalogSnapshot(exportDoc([{ entryId: 'e-1', title: 'A', attributes: { 'sk-live-0123456789abcdef': 'v' } }]));
  assertEq(Object.keys(legal.snapshot.items[0]!.metadata).join(','), 'sk-live-0123456789abcdef',
    'a legal attribute key is accepted and preserved');
});

test('no rejection anywhere echoes a title, a reference value, a system label or an entry id', () => {
  const sentinels = ['a-title-sentinel-must-not-appear', 'tt-ref-sentinel-must-not-appear',
    'system-sentinel-must-not-appear', 'entry-id-sentinel-must-not-appear'];
  const doc = JSON.stringify({
    format: EXTERNAL_EXPORT_FORMAT,
    version: EXTERNAL_EXPORT_VERSION,
    system: 'system-sentinel-must-not-appear-because-it-is-far-too-long-for-the-bound',
    entries: [{
      entryId: 'entry-id-sentinel-must-not-appear',
      title: `a-title-sentinel-must-not-appear${'x'.repeat(600)}`,
      references: [{ kind: 'imdb', id: `tt-ref-sentinel-must-not-appear${'y'.repeat(600)}` }],
    }],
  });
  const text = problemsOf(doc).join('\n');
  for (const sentinel of sentinels) {
    assert(!text.includes(sentinel), `a diagnostic echoed the sentinel ${sentinel}`);
  }
  assert(text.length > 0, 'and something was still reported');
});

test('the CLI prints a refusal that carries no hostile key, on stderr', () => {
  const probe = join(WORK, 'hostile-probe.json');
  const hostile = 'https://exfiltrate.invalid/a?token=hunter2';
  writeFileSync(probe, JSON.stringify({
    format: EXTERNAL_EXPORT_FORMAT, version: EXTERNAL_EXPORT_VERSION, system: SECRET_SYSTEM,
    entries: [{ entryId: 'e-1', title: 'A', attributes: { [hostile]: 'v' } }],
  }), 'utf8');
  // BOUNDED, AND ITS OWN FAILURE IS DIAGNOSED. This starts a real child process through `tsx`, which is the
  // slowest thing any suite here does; without a timeout a bad moment on a loaded machine is a hang, and
  // without the stderr in the message a transient startup failure reads as "the CLI stopped refusing".
  const run = spawnSync(process.execPath, [
    '--import', 'tsx', join(repoRoot, 'src/ops/catalog-snapshot-produce-cli.ts'), '--from', probe, '--preview',
  ], { encoding: 'utf8', cwd: repoRoot, timeout: 120_000, windowsHide: true });
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  assert(run.error === undefined, `the CLI could not be started at all: ${String(run.error)}`);
  assertEq(run.status, 3, `the CLI refuses with the rejection exit code; it said: ${output.trim().slice(0, 400)}`);
  assert(!output.includes(hostile), `the CLI echoed the hostile key: ${output.trim().slice(0, 300)}`);
  assert(output.includes('attributes[0]'), 'while naming the position, so the operator can still fix it');
  assert(output.includes('Nothing was written'), 'and saying nothing was written');
  rmSync(probe);
});

// ---------------------------------------------------------------------------------------------------------
// The command line.
// ---------------------------------------------------------------------------------------------------------

test('the CLI parser is strict, and cannot be asked to both preview and write', () => {
  const parsed = parseProduceArgs(['--from', 'a.json', '--out', 'b.json', '--overwrite', '--json']);
  assertEq(parsed.from, 'a.json', 'the input is read');
  assertEq(parsed.out, 'b.json', 'and the output');
  assertEq(parsed.overwrite, true, 'and the overwrite flag');
  for (const [argv, needle] of [
    [['--from', 'a.json'], '--out is required'],
    [['--out', 'b.json'], '--from is required'],
    [['--from', 'a.json', '--out', 'b.json', '--preview'], 'takes no --out'],
    [['--from', 'a.json', '--preview', '--overwrite'], '--overwrite means nothing'],
    [['--from', '--out'], '--from needs a value'],
    [['--from', 'a.json', '--nope'], 'unknown option'],
  ] as Array<[string[], string]>) {
    let message = '';
    try { parseProduceArgs(argv); } catch (err) { message = (err as SnapshotProduceUsageError).message; }
    assert(message.includes(needle), `${argv.join(' ')} must be refused with "${needle}", got "${message}"`);
  }
  assertEq(parseProduceArgs(['--help']).help, true, 'and --help needs nothing else');
});

// ---------------------------------------------------------------------------------------------------------
// The acceptance fixtures are exports, and they produce what the gates expect.
// ---------------------------------------------------------------------------------------------------------

test('both acceptance fixtures are EXTERNAL EXPORTS, and no ready-made canonical snapshot is left to copy', () => {
  for (const rel of [
    'deploy/ci/acceptance/fixtures/catalog-acceptance-export.json',
    'deploy/ci/acceptance/fixtures/jellyfin-acceptance-export.json',
  ]) {
    const parsed = parseExternalExport(readRepo(rel));
    assertEq(parsed.format, EXTERNAL_EXPORT_FORMAT, `${rel} is an external export`);
    assert(parsed.entries.length > 0, `${rel} carries entries`);
  }
  // The old ready-made snapshots are GONE. While one exists, an acceptance gate can quietly go back to
  // copying it, and the claim "the snapshot was produced during the run" becomes unfalsifiable.
  for (const rel of [
    'deploy/ci/acceptance/fixtures/catalog-acceptance-snapshot.json',
    'deploy/ci/acceptance/fixtures/jellyfin-acceptance-snapshot.json',
  ]) {
    assert(!existsSync(join(repoRoot, rel)), `${rel} must not exist: an acceptance must produce its snapshot`);
  }
});

test('the acceptance exports produce exactly the records the gates count', () => {
  const catalog = produceCatalogSnapshot(readRepo('deploy/ci/acceptance/fixtures/catalog-acceptance-export.json'));
  assertEq(catalog.snapshot.items.length, 28, 'the catalog acceptance produces 28 records');
  assert(catalog.text.includes('tt-acceptance-ref-value-must-never-be-shown'),
    'and carries the reference value whose non-disclosure the gate proves');

  const jellyfin = produceCatalogSnapshot(readRepo('deploy/ci/acceptance/fixtures/jellyfin-acceptance-export.json'));
  assertEq(jellyfin.snapshot.items.length, 4, 'the Jellyfin acceptance produces 4 records');
  assertEq(jellyfin.entriesWithoutReferences, 1, 'one of which has no reference, so a plan reports it blocked');
  assertEq(jellyfin.references, 3, 'and three references in total');
});

test('both Docker acceptances read the preview mode as JSON, not as one whitespace spelling', () => {
  for (const rel of [
    'deploy/ci/catalog-acceptance.sh',
    'deploy/ci/jellyfin-control-acceptance.sh',
  ]) {
    const script = readRepo(rel);
    assert(script.includes('JSON.parse(s).mode'), `${rel} parses the report's mode field`);
    assert(!script.includes(`grep -q '"mode":"preview"'`),
      `${rel} does not reject the CLI's deliberately pretty-printed JSON`);
  }
});

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
process.exit(failed === 0 ? 0 : 1);
