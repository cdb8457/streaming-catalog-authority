import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
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
  renderSnapshotProduction,
  resolveProducedSnapshotPath,
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

const exportDoc = (entries: unknown[], overrides: Record<string, unknown> = {}): string => JSON.stringify({
  format: EXTERNAL_EXPORT_FORMAT,
  version: EXTERNAL_EXPORT_VERSION,
  system: 'torbox',
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

test('the writing module creates no link and builds no directory', () => {
  const source = readRepo('src/ops/catalog-snapshot-produce.ts');
  for (const forbidden of ['symlinkSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'node:http', 'node:net',
    'node:child_process', 'node:dns']) {
    assert(!source.includes(forbidden), `the writing module must not name ${forbidden}`);
  }
  // `linkSync` on its own, and NOT the `unlinkSync` it is a substring of — the temporary file's cleanup is a
  // legitimate unlink and the scan must not be satisfied by refusing it.
  assert(!/(?<![A-Za-z])linkSync/.test(source), 'the writing module must not name linkSync');
  assert(source.includes('unlinkSync'), 'while it does remove its own temporary file');
  assert(!/\bfetch\s*\(/.test(source), 'the writing module must not call a transport');
  // The atomic-write shape, asserted by the calls it must make rather than by the comment that describes it.
  assert(source.includes('O_EXCL'), 'the temporary file is created exclusively');
  assert(source.includes('fsyncSync(fd)'), 'and flushed before the rename');
  assert(source.includes('renameSync(temporary, output.path)'), 'and moved into place by a rename');
  assert(source.includes('lstatSync(output.path)'), 'and the destination is examined with lstat, not stat');
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
  rejects(() => parseExternalExport(exportDoc([{ entryId: 'a', title: 'b', extra: 1 }])), 'unknown key extra', 'an unknown entry key');
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
    'unknown key extra', 'an unknown reference key');
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
      'acquisition or media-location data', `the ${prefix} namespace`);
    rejects(() => parseExternalExport(exportDoc([{ entryId: 'a', title: 'b', attributes: { [prefix]: 'x' } }])),
      'acquisition or media-location data', `the bare ${prefix} key`);
  }
  rejects(() => parseExternalExport(exportDoc([{ entryId: 'a', title: 'b', attributes: { 'external.system': 'forged' } }])),
    'reserved by Catalog Authority', 'a forged provenance key');
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

test('nothing a report carries names any content, any path or any external system detail', () => {
  const output = resolveProducedSnapshotPath(join(OUT, 'redaction.json'), {});
  const report = produceSnapshotFile({ text: SAMPLE, output });
  const rendered = renderSnapshotProduction(report);
  const serialised = JSON.stringify(report);
  for (const forbidden of [SECRET_TITLE, SECRET_REF, SECRET_ATTR, 'Second', 'Third', OUT, WORK]) {
    assert(!rendered.includes(forbidden), `the rendered report must not carry ${forbidden.slice(0, 24)}`);
    assert(!serialised.includes(forbidden), `and neither must the JSON: ${forbidden.slice(0, 24)}`);
  }
  assertEq(report.report, SNAPSHOT_PRODUCE_REPORT, 'the report names itself');
  assertEq(report.network, 'none', 'and declares no network');
  assertEq(report.acquisition, 'external-input-only', 'and declares the source as external input only');
  assertEq(report.mediaAccess, 'none', 'and declares no media access');
  assertEq(report.symlinksCreated, 0, 'and no symlink creation');
  rmSync(output.path);
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

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
process.exit(failed === 0 ? 0 : 1);
