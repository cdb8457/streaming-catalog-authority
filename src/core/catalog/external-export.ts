import { createHash } from 'node:crypto';
import { KNOWN_REF_TYPES, type RefType } from './events.js';
import {
  CATALOG_SNAPSHOT_FORMAT,
  CATALOG_SNAPSHOT_VERSION,
  CatalogImportError,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_EXTERNAL_ID_LENGTH,
  IMPORT_MAX_ITEMS,
  IMPORT_MAX_METADATA_KEYS,
  IMPORT_MAX_METADATA_KEY_LENGTH,
  IMPORT_MAX_METADATA_VALUE_LENGTH,
  IMPORT_MAX_REF_VALUE_LENGTH,
  IMPORT_MAX_REPORTED_PROBLEMS,
  IMPORT_MAX_TITLE_LENGTH,
  IMPORT_MAX_YEAR,
  IMPORT_MIN_YEAR,
  type NormalizedSnapshot,
  parseCatalogSnapshot,
} from './import-snapshot.js';

// Phase 274 — the EXTERNAL EXPORT: what an operator's OTHER system hands this one, and the only shape in
// which it may do so.
//
// WHAT THIS IS FOR. Catalog Authority holds catalog records. Somebody else's system — a Usenet or debrid
// acquisition tool, a spreadsheet, a media manager — already knows what an operator has. Until now the only
// way to get that into this product was for a person to hand-write the canonical snapshot. This module is the
// other half: a strict, closed schema for what such a system may EXPORT to a local file, and a deterministic
// transformation from that file into the canonical import snapshot.
//
// -----------------------------------------------------------------------------------------------------
// THIS IS AN INPUT BOUNDARY, NOT AN INTEGRATION.
// -----------------------------------------------------------------------------------------------------
//
// NOTHING HERE CONTACTS THE EXTERNAL SYSTEM, AND NOTHING HERE COULD. This module takes a string and returns
// a value. It opens no file, makes no network call, spawns no process, reads no environment variable and
// touches no database — exactly like `import-snapshot.ts`, and for exactly the same reason: a transformation
// that cannot perform I/O cannot be talked into performing it by the document it is transforming. The
// acquisition system is not queried, polled, authenticated to or named in a request. An operator EXPORTS from
// it, by hand, and this reads that file.
//
// ACQUISITION DATA IS REFUSED, NOT CARRIED. An export from a download tool naturally knows things this
// product must never hold: NZB ids, magnet links, tracker names, download URLs, and absolute paths into
// somebody's media library. Those are not filtered out quietly — an export carrying one is REJECTED whole,
// by key namespace and by value shape. A catalog record that quietly gained a download URL would be a
// coupling to an acquisition pipeline that this product's whole boundary says does not exist, and a silent
// drop would let one appear in a later version by somebody deleting a filter.
//
// PROVENANCE IS STRUCTURAL, NOT A LABEL. The produced snapshot's `source` is `external.<system>`, so:
//   * every derived item id is a function of it (`deriveItemId`), and a record produced from an external
//     export can never collide with a hand-written one;
//   * the record's own `externalIds` map is keyed by it, which is what the catalog panel and the export
//     already display as the record's source.
// There is no separate provenance field to strip, forget or forge.
//
// DETERMINISM IS THE POINT. Same export bytes -> byte-identical snapshot, the same content digest and the
// same snapshot digest, on any machine. Entries are ordered by their external id, references by type,
// attributes by key, and nothing consults a clock, a random source, the environment or the filesystem.
//
// THE OUTPUT IS PROVED, NOT ASSUMED. `produceCatalogSnapshot` parses its own output with
// `parseCatalogSnapshot` before returning it. A snapshot this module emits is therefore known to be
// importable by the shipped importer — not believed to be, because the shipped importer said so.
//
// PROBLEMS NAME FIELDS AND POSITIONS, NEVER VALUES — AND A KEY IS A VALUE. Same rule as the importer:
// "entry 12: title is longer than 512 characters", never the title. This module holds itself to the stricter
// reading of it, because an EXPORT's key names are supplied by somebody else's software: an attribute key can
// be a URL, an absolute media path, an api token or a film title, and a message of the form "unknown key:
// <key>" would print it to a terminal, a CI log and whatever gets pasted into an issue — while the check that
// produced it exists precisely because that key is the hostile part. So every diagnostic here names a
// POSITION (`entry 12`, `attributes[3]`, `references[1]`) and, where it helps, the closed set of names that
// ARE allowed. Nothing the document supplied is ever echoed back.

export const EXTERNAL_EXPORT_FORMAT = 'catalog-authority.external-export';
export const EXTERNAL_EXPORT_VERSION = 1;

/**
 * The prefix every produced snapshot's `source` carries.
 *
 * It is what makes "this came from somebody else's system" a property of the record's identity rather than a
 * note beside it, and it is why an external export can never be mistaken for, or collide with, a snapshot an
 * operator wrote by hand.
 */
export const EXTERNAL_SOURCE_PREFIX = 'external.';

/** Bounds. Every one is a refusal, not a truncation: an export that exceeds one is rejected whole. */
export const EXPORT_MAX_BYTES = IMPORT_MAX_BYTES;
export const EXPORT_MAX_ENTRIES = IMPORT_MAX_ITEMS;
/** Bounded so `external.<system>` always fits the importer's own 64-character source limit. */
export const EXPORT_MAX_SYSTEM_LENGTH = 32;
export const EXPORT_MAX_ENTRY_ID_LENGTH = IMPORT_MAX_EXTERNAL_ID_LENGTH;
export const EXPORT_MAX_TITLE_LENGTH = IMPORT_MAX_TITLE_LENGTH;
export const EXPORT_MAX_REFERENCES_PER_ENTRY = KNOWN_REF_TYPES.length;
export const EXPORT_MAX_REFERENCE_ID_LENGTH = IMPORT_MAX_REF_VALUE_LENGTH;
export const EXPORT_MAX_ATTRIBUTES = IMPORT_MAX_METADATA_KEYS;
export const EXPORT_MAX_ATTRIBUTE_KEY_LENGTH = IMPORT_MAX_METADATA_KEY_LENGTH;
export const EXPORT_MAX_ATTRIBUTE_VALUE_LENGTH = IMPORT_MAX_METADATA_VALUE_LENGTH;
export const EXPORT_MAX_REPORTED_PROBLEMS = IMPORT_MAX_REPORTED_PROBLEMS;

/** A system label is an operator-chosen name for the system the export came out of. It becomes the source. */
const SYSTEM_RE = /^[a-z0-9][a-z0-9-]*$/;
/** An entry id is opaque to us; it only has to be a printable, single-line token we can derive an id from. */
const ENTRY_ID_RE = /^[\x21-\x7e][\x20-\x7e]*$/;
const ATTRIBUTE_KEY_RE = /^[a-z0-9][a-z0-9._-]*$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The reference vocabularies an external system is allowed to speak, and what each means here.
 *
 * A CLOSED MAP, NOT A NORMALISER. An unknown `kind` is a rejection rather than a dropped reference: a record
 * that silently lost the reference it would have been matched by is a record that later reports "no library
 * item found" for a reason nobody can see. Both the external spelling (`imdb_id`) and the canonical one
 * (`imdb`) are accepted, because real exports use both and neither is ambiguous.
 */
export const EXTERNAL_REFERENCE_KINDS: Readonly<Record<string, RefType>> = Object.freeze({
  imdb: 'imdb',
  imdb_id: 'imdb',
  imdbid: 'imdb',
  tmdb: 'tmdb',
  tmdb_id: 'tmdb',
  tmdbid: 'tmdb',
  tvdb: 'tvdb',
  tvdb_id: 'tvdb',
  tvdbid: 'tvdb',
  tvmaze: 'tvmaze',
  tvmaze_id: 'tvmaze',
  anidb: 'anidb',
  anidb_id: 'anidb',
  infohash: 'infohash',
});

/**
 * Attribute key namespaces an export may NOT use, because they are the vocabulary of ACQUISITION.
 *
 * The absolute invariant of this product is that it never downloads, scrapes, plays, streams or acquires
 * media, and never creates a media symlink. An export from a download tool knows all of those things. Letting
 * one of them into a catalog record would not merely be untidy: it would make this product hold the state an
 * acquisition pipeline runs on, which is the first step of becoming one. So the namespaces are closed here,
 * at the input boundary, and an export that uses one is refused whole.
 */
export const FORBIDDEN_ATTRIBUTE_PREFIXES: readonly string[] = Object.freeze([
  'download', 'nzb', 'usenet', 'torrent', 'magnet', 'tracker', 'debrid', 'seed', 'stream', 'playback',
  'path', 'file', 'folder', 'library', 'media', 'mount', 'symlink', 'link', 'url', 'uri',
]);

/** Reserved for this product's own use, so a future provenance key can never be forged by an export. */
export const RESERVED_ATTRIBUTE_PREFIX = 'external.';

/**
 * The closed key sets, declared once and NAMED IN DIAGNOSTICS INSTEAD OF THE KEY THAT WAS FOUND.
 *
 * A key in somebody else's document is a value. It can be a URL, an absolute path, an api token or a film
 * title, and an "unknown key: <key>" message puts it on a terminal, into a CI log and into whatever an
 * operator pastes into an issue. Every diagnostic below therefore names a POSITION and the set of keys that
 * ARE allowed — which is strictly more actionable than echoing the wrong one, and which cannot carry anything.
 */
const ROOT_KEYS: readonly string[] = ['format', 'version', 'system', 'entries'];
const ENTRY_KEYS: readonly string[] = ['entryId', 'title', 'year', 'references', 'attributes'];
const REFERENCE_KEYS: readonly string[] = ['kind', 'id'];

export class CatalogExportError extends Error {
  readonly code = 'CATALOG_EXTERNAL_EXPORT_REJECTED';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`the external export was rejected:\n  - ${problems.join('\n  - ')}`);
    this.name = 'CatalogExportError';
    this.problems = problems;
  }
}

export interface NormalizedExportEntry {
  readonly entryId: string;
  readonly title: string;
  readonly year: number | null;
  readonly references: readonly { readonly type: RefType; readonly value: string }[];
  readonly attributes: Readonly<Record<string, string>>;
}

export interface NormalizedExport {
  readonly format: typeof EXTERNAL_EXPORT_FORMAT;
  readonly version: typeof EXTERNAL_EXPORT_VERSION;
  /** The operator's label for the system this came out of. Lower-case, dash-separated, bounded. */
  readonly system: string;
  /** The `source` the produced snapshot will carry: `external.<system>`. */
  readonly source: string;
  readonly entries: readonly NormalizedExportEntry[];
}

/**
 * Is a value something that points OUT of this product — a URL, an absolute path, a UNC share?
 *
 * Applied to every reference id and every attribute value. A provider reference is an identifier; an
 * attribute is a note. Neither has any business being a location, and a catalog record that carried one
 * would be a record that tells somebody where the media file is — which is the coupling this product does
 * not have.
 */
export function looksLikeLocation(value: string): boolean {
  if (value.includes('://')) return true;                                     // http://, smb://, anything
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;                             // C:\ or C:/
  if (/^(magnet|file|smb|nfs|ftp|ftps|sftp|data|javascript):/i.test(value)) return true; // schemes with no //
  if (value.startsWith('/') || value.startsWith('\\\\')) return true;         // POSIX absolute, or a UNC share
  return false;
}

/**
 * Parse, validate and normalize an external export document.
 *
 * Collects EVERY problem rather than throwing on the first, exactly as the importer does: an operator fixing
 * an export by hand should get the whole list once, not discover the next fault on the next run.
 */
export function parseExternalExport(text: string): NormalizedExport {
  const problems: string[] = [];
  const add = (problem: string): void => {
    if (problems.length < EXPORT_MAX_REPORTED_PROBLEMS) problems.push(problem);
  };

  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > EXPORT_MAX_BYTES) {
    throw new CatalogExportError([`the export is ${byteLength} bytes, over the ${EXPORT_MAX_BYTES}-byte limit`]);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new CatalogExportError(['the export is not valid JSON']);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new CatalogExportError(['the export must be a JSON object']);
  }
  const root = doc as Record<string, unknown>;
  // THE COUNT AND THE ALLOWED SET, NEVER THE KEY. A key in somebody else's document is a value like any
  // other: it can be a URL, a path, a token or a title, and it would go straight to a terminal and into a
  // support bundle. Naming what IS allowed is at least as actionable and cannot carry anything.
  const unknownRootKeys = Object.keys(root).filter((key) => !ROOT_KEYS.includes(key)).length;
  if (unknownRootKeys > 0) {
    add(`the export has ${unknownRootKeys} unknown top-level key(s); only ${ROOT_KEYS.join(', ')} are allowed`);
  }
  if (root.format !== EXTERNAL_EXPORT_FORMAT) add(`format must be "${EXTERNAL_EXPORT_FORMAT}"`);
  if (root.version !== EXTERNAL_EXPORT_VERSION) add(`version must be ${EXTERNAL_EXPORT_VERSION}`);

  const system = root.system;
  let validSystem = false;
  if (typeof system !== 'string' || system.length === 0) add('system is required and must be a string');
  else if (system.length > EXPORT_MAX_SYSTEM_LENGTH) add(`system is longer than ${EXPORT_MAX_SYSTEM_LENGTH} characters`);
  else if (!SYSTEM_RE.test(system)) add('system must be lower-case letters, digits and dashes, starting with a letter or digit');
  else validSystem = true;

  const rawEntries = root.entries;
  if (!Array.isArray(rawEntries)) {
    add('entries must be an array');
    throw new CatalogExportError(problems);
  }
  if (rawEntries.length === 0) add('entries is empty; there is nothing to produce a snapshot from');
  if (rawEntries.length > EXPORT_MAX_ENTRIES) {
    add(`the export has ${rawEntries.length} entries, over the ${EXPORT_MAX_ENTRIES}-entry limit`);
  }
  // Bail before the per-entry pass if the envelope is wrong: without a usable system there is no source, and
  // a wrong `format` or `version` means the per-entry shape is not this format's, so every consequence of
  // that would bury the one fault that has to be fixed first.
  if (!validSystem || problems.length > 0) throw new CatalogExportError(problems);

  const entries: NormalizedExportEntry[] = [];
  const seen = new Map<string, number>();

  rawEntries.forEach((raw, index) => {
    const at = `entry ${index}`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { add(`${at}: must be an object`); return; }
    const rec = raw as Record<string, unknown>;
    const unknownEntryKeys = Object.keys(rec).filter((key) => !ENTRY_KEYS.includes(key)).length;
    if (unknownEntryKeys > 0) {
      add(`${at}: has ${unknownEntryKeys} unknown key(s); only ${ENTRY_KEYS.join(', ')} are allowed`);
    }

    const entryId = rec.entryId;
    if (typeof entryId !== 'string' || entryId.length === 0) { add(`${at}: entryId is required and must be a non-empty string`); return; }
    if (entryId.length > EXPORT_MAX_ENTRY_ID_LENGTH) { add(`${at}: entryId is longer than ${EXPORT_MAX_ENTRY_ID_LENGTH} characters`); return; }
    if (!ENTRY_ID_RE.test(entryId)) { add(`${at}: entryId must be printable ASCII on a single line, with no leading space`); return; }
    if (looksLikeLocation(entryId)) { add(`${at}: entryId looks like a URL or a filesystem path, which is acquisition data and is refused`); return; }

    const duplicate = seen.get(entryId);
    if (duplicate !== undefined) {
      // The VALUE is not echoed: two positions are enough to find it without putting operator content in a
      // message somebody may paste into an issue.
      add(`${at}: duplicate entryId, already used by entry ${duplicate}`);
      return;
    }
    seen.set(entryId, index);

    const title = rec.title;
    if (typeof title !== 'string' || title.trim().length === 0) { add(`${at}: title is required and must be a non-empty string`); return; }
    if (title.length > EXPORT_MAX_TITLE_LENGTH) { add(`${at}: title is longer than ${EXPORT_MAX_TITLE_LENGTH} characters`); return; }
    if (CONTROL_CHARS.test(title)) { add(`${at}: title contains control characters`); return; }

    let year: number | null = null;
    if (rec.year !== undefined && rec.year !== null) {
      const value = rec.year;
      if (typeof value !== 'number' || !Number.isInteger(value)) { add(`${at}: year must be a whole number`); return; }
      if (value < IMPORT_MIN_YEAR || value > IMPORT_MAX_YEAR) { add(`${at}: year must be between ${IMPORT_MIN_YEAR} and ${IMPORT_MAX_YEAR}`); return; }
      year = value;
    }

    const references: Array<{ type: RefType; value: string }> = [];
    if (rec.references !== undefined) {
      if (!Array.isArray(rec.references)) { add(`${at}: references must be an array`); return; }
      if (rec.references.length > EXPORT_MAX_REFERENCES_PER_ENTRY) {
        add(`${at}: more than ${EXPORT_MAX_REFERENCES_PER_ENTRY} references`);
        return;
      }
      const seenTypes = new Set<string>();
      let refProblem = false;
      for (const [refIndex, rawRef] of rec.references.entries()) {
        const where = `${at}: references[${refIndex}]`;
        if (rawRef === null || typeof rawRef !== 'object' || Array.isArray(rawRef)) { add(`${where} must be an object`); refProblem = true; break; }
        const ref = rawRef as Record<string, unknown>;
        const unknownRefKeys = Object.keys(ref).filter((key) => !REFERENCE_KEYS.includes(key)).length;
        if (unknownRefKeys > 0) {
          add(`${where} has ${unknownRefKeys} unknown key(s); only ${REFERENCE_KEYS.join(', ')} are allowed`);
          refProblem = true;
        }
        if (refProblem) break;
        const kind = ref.kind;
        if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(EXTERNAL_REFERENCE_KINDS, kind)) {
          // A closed vocabulary. An unknown kind is a rejection rather than a dropped reference: a record
          // that silently lost the reference it would be matched by fails later, somewhere nobody is looking.
          add(`${where} kind must be one of: ${Object.keys(EXTERNAL_REFERENCE_KINDS).sort().join(', ')}`);
          refProblem = true; break;
        }
        const type = EXTERNAL_REFERENCE_KINDS[kind]!;
        if (seenTypes.has(type)) { add(`${where} maps to the ${type} reference type, which this entry already has`); refProblem = true; break; }
        seenTypes.add(type);
        const id = ref.id;
        if (typeof id !== 'string' || id.length === 0) { add(`${where} id is required and must be a non-empty string`); refProblem = true; break; }
        if (id.length > EXPORT_MAX_REFERENCE_ID_LENGTH) { add(`${where} id is longer than ${EXPORT_MAX_REFERENCE_ID_LENGTH} characters`); refProblem = true; break; }
        if (CONTROL_CHARS.test(id)) { add(`${where} id contains control characters`); refProblem = true; break; }
        if (looksLikeLocation(id)) { add(`${where} id looks like a URL or a filesystem path, which is acquisition data and is refused`); refProblem = true; break; }
        references.push({ type, value: id });
      }
      if (refProblem) return;
    }

    // Null-prototype for the same reason the importer uses one: a key that ever got past a future edit of
    // `ATTRIBUTE_KEY_RE` still cannot reach `Object.prototype`.
    const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
    if (rec.attributes !== undefined) {
      const raw = rec.attributes;
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { add(`${at}: attributes must be an object`); return; }
      const pairs = Object.entries(raw as Record<string, unknown>);
      if (pairs.length > EXPORT_MAX_ATTRIBUTES) { add(`${at}: attributes has more than ${EXPORT_MAX_ATTRIBUTES} keys`); return; }
      let problem = false;
      // AN ATTRIBUTE IS ADDRESSED BY ITS POSITION, NEVER BY ITS KEY. A key is document-supplied, so it is a
      // value: it can be a URL, an absolute path, a token or a title, and the whole point of an attribute
      // namespace check is that the key is the hostile part. `attributes[3]` is a position an operator can
      // find in their own file and it carries nothing at all.
      //
      // The position is the order the keys are ENUMERATED in, which is the order they were written in for
      // every key this format admits except a purely numeric one — JavaScript hoists those. An attribute key
      // is an operator's own label (`shelf`, `note`), so that is a curiosity rather than a problem; it is
      // written down here so nobody later reads a shifted index as a bug in the parser.
      for (const [position, [key, value]] of pairs.entries()) {
        const which = `${at}: attributes[${position}]`;
        if (key.length > EXPORT_MAX_ATTRIBUTE_KEY_LENGTH || !ATTRIBUTE_KEY_RE.test(key)) {
          add(`${which} has a key that must be 1-${EXPORT_MAX_ATTRIBUTE_KEY_LENGTH} characters of lower-case letters, digits, dot, dash or underscore, starting with a letter or digit`);
          problem = true; break;
        }
        if (key.startsWith(RESERVED_ATTRIBUTE_PREFIX)) {
          add(`${which} has a key in the "${RESERVED_ATTRIBUTE_PREFIX}" namespace, which Catalog Authority reserves and an export cannot supply`);
          problem = true; break;
        }
        const namespace = key.split(/[._-]/)[0]!;
        if (FORBIDDEN_ATTRIBUTE_PREFIXES.includes(namespace)) {
          add(`${which} has a key in an acquisition or media-location namespace, which this product does not hold`);
          problem = true; break;
        }
        if (typeof value !== 'string') { add(`${which} must be a string`); problem = true; break; }
        if (value.length > EXPORT_MAX_ATTRIBUTE_VALUE_LENGTH) { add(`${which} is longer than ${EXPORT_MAX_ATTRIBUTE_VALUE_LENGTH} characters`); problem = true; break; }
        if (CONTROL_CHARS.test(value)) { add(`${which} contains control characters`); problem = true; break; }
        if (looksLikeLocation(value)) {
          add(`${which} looks like a URL or a filesystem path, which is acquisition data and is refused`);
          problem = true; break;
        }
        attributes[key] = value;
      }
      if (problem) return;
    }

    entries.push({ entryId, title: title.trim(), year, references, attributes });
  });

  if (problems.length > 0) throw new CatalogExportError(problems);

  return {
    format: EXTERNAL_EXPORT_FORMAT,
    version: EXTERNAL_EXPORT_VERSION,
    system: system as string,
    source: `${EXTERNAL_SOURCE_PREFIX}${system as string}`,
    entries,
  };
}

export interface ProducedSnapshot {
  /** The exact bytes to write. UTF-8, two-space JSON, one trailing newline. */
  readonly text: string;
  readonly bytes: number;
  /** sha256 of `text`. What binds a produced file to the report that describes it. */
  readonly contentDigest: string;
  /** sha256 of the export bytes this was produced FROM. */
  readonly inputDigest: string;
  /** The parse of `text` by the SHIPPED importer. Its presence is the proof that the output is importable. */
  readonly snapshot: NormalizedSnapshot;
  readonly source: string;
  readonly system: string;
  readonly entries: number;
  readonly references: number;
  readonly entriesWithoutReferences: number;
}

/**
 * Turn a validated external export into the canonical import snapshot.
 *
 * TOTALLY ORDERED, SO THE BYTES ARE THE SAME EVERY TIME. Items by external id, references by type,
 * attributes by key. Two operators producing from the same export on different machines get the same file
 * and the same digest, which is what makes a digest something either of them can quote.
 *
 * THE OUTPUT IS PARSED BY THE IMPORTER BEFORE IT IS RETURNED. If `parseCatalogSnapshot` refuses it, that is a
 * defect in this function and it surfaces as a rejection here rather than as a failed import later.
 */
export function produceCatalogSnapshot(text: string): ProducedSnapshot {
  const parsed = parseExternalExport(text);
  const ordered = [...parsed.entries].sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));

  const items = ordered.map((entry) => {
    const item: Record<string, unknown> = { externalId: entry.entryId, title: entry.title };
    if (entry.year !== null) item.year = entry.year;
    if (entry.references.length > 0) {
      item.providerRefs = [...entry.references]
        .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))
        .map((ref) => ({ type: ref.type, value: ref.value }));
    }
    const keys = Object.keys(entry.attributes).sort();
    if (keys.length > 0) {
      const metadata: Record<string, string> = {};
      for (const key of keys) metadata[key] = entry.attributes[key]!;
      item.metadata = metadata;
    }
    return item;
  });

  const document = {
    format: CATALOG_SNAPSHOT_FORMAT,
    version: CATALOG_SNAPSHOT_VERSION,
    source: parsed.source,
    items,
  };
  const produced = `${JSON.stringify(document, null, 2)}\n`;
  const bytes = Buffer.byteLength(produced, 'utf8');
  if (bytes > IMPORT_MAX_BYTES) {
    // Refused rather than written: a file this product could not import is not a snapshot, and producing one
    // and discovering it at import time would waste the only step that had a chance of being reversible.
    throw new CatalogExportError([
      `the snapshot this export produces is ${bytes} bytes, over the importer's ${IMPORT_MAX_BYTES}-byte limit`,
    ]);
  }

  let snapshot: NormalizedSnapshot;
  try {
    // THE SHIPPED IMPORTER'S OWN PARSER. Not a second model of the format — the one the import path uses.
    snapshot = parseCatalogSnapshot(produced);
  } catch (err) {
    const problems = err instanceof CatalogImportError ? err.problems : ['the produced snapshot could not be parsed'];
    throw new CatalogExportError([
      'the snapshot this export produces is not a valid catalog snapshot, so nothing was written',
      ...problems,
    ]);
  }

  return {
    text: produced,
    bytes,
    contentDigest: createHash('sha256').update(Buffer.from(produced, 'utf8')).digest('hex'),
    inputDigest: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'),
    snapshot,
    source: parsed.source,
    system: parsed.system,
    entries: ordered.length,
    references: ordered.reduce((sum, entry) => sum + entry.references.length, 0),
    entriesWithoutReferences: ordered.filter((entry) => entry.references.length === 0).length,
  };
}
