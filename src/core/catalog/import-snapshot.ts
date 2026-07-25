import { createHash } from 'node:crypto';
import { KNOWN_REF_TYPES, type RefType } from './events.js';

// Phase 259 — the offline catalog snapshot format.
//
// WHAT THIS IS. One JSON file, written by the operator, describing catalog records they want Catalog
// Authority to hold. It is the first genuine product workflow: everything before it installs the software.
//
// WHAT THIS IS NOT, AND CANNOT BECOME. This module reads a string and returns a value. It opens no file,
// makes no network call, spawns no process and touches no database — every one of those lives above it. It
// therefore cannot scan a media path, cannot contact Jellyfin or a provider, and cannot be talked into it by
// anything in a snapshot, because there is no code path here that could act on such an instruction.
//
// VALIDATION IS COMPLETE BEFORE ANY CALLER WRITES ANYTHING. `parseCatalogSnapshot` either returns a fully
// normalized document or throws with every problem it found. That is what makes a malformed file a no-op
// rather than a half-import: the applier never sees a partially valid snapshot, so there is no state in
// which some records from a bad file were persisted and others were not.
//
// IDENTITIES ARE DERIVED, NOT INVENTED. An item's id is a deterministic function of (source, externalId).
// Re-importing the same file therefore addresses the same items, which is what makes the whole operation
// idempotent — the database's own `cat_add_item_ct` treats a second write to an existing active item as a
// no-op, so a repeat import cannot duplicate anything.
//
// PROBLEMS NAME FIELDS AND POSITIONS, NEVER VALUES. Every message here is of the form "item 12: title is
// longer than 512 characters". A title, a provider ref value or a metadata value never appears in an error,
// a log line or a report — the import path is redaction-safe by construction, not by a later filter.

export const CATALOG_SNAPSHOT_FORMAT = 'catalog-authority.snapshot';
export const CATALOG_SNAPSHOT_VERSION = 1;

/** Bounds. Every one of them is a refusal, not a truncation: a file that exceeds one is rejected whole. */
export const IMPORT_MAX_BYTES = 8 * 1024 * 1024;
export const IMPORT_MAX_ITEMS = 10_000;
export const IMPORT_MAX_SOURCE_LENGTH = 64;
export const IMPORT_MAX_EXTERNAL_ID_LENGTH = 128;
export const IMPORT_MAX_TITLE_LENGTH = 512;
export const IMPORT_MAX_REFS_PER_ITEM = KNOWN_REF_TYPES.length;
export const IMPORT_MAX_REF_VALUE_LENGTH = 256;
export const IMPORT_MAX_METADATA_KEYS = 24;
export const IMPORT_MAX_METADATA_KEY_LENGTH = 64;
export const IMPORT_MAX_METADATA_VALUE_LENGTH = 512;
export const IMPORT_MIN_YEAR = 1800;
export const IMPORT_MAX_YEAR = 2200;
/** How many distinct problems a rejection reports before it stops listing them. */
export const IMPORT_MAX_REPORTED_PROBLEMS = 50;

/** A source name is an operator-chosen label, and it participates in every derived id, so it is constrained. */
const SOURCE_RE = /^[a-z0-9][a-z0-9._-]*$/;
/** An external id is opaque to us; it only has to be a printable, single-line token we can hash. */
const EXTERNAL_ID_RE = /^[\x21-\x7e][\x20-\x7e]*$/;
const METADATA_KEY_RE = /^[a-z0-9][a-z0-9._-]*$/;
/** C0/C1 control characters. They have no place in a title, a ref value or a metadata value. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export interface NormalizedProviderRef {
  readonly type: RefType;
  readonly value: string;
}

export interface NormalizedSnapshotItem {
  /** The deterministic item id this record will occupy. */
  readonly itemId: string;
  readonly externalId: string;
  readonly title: string;
  readonly year: number | null;
  readonly providerRefs: readonly NormalizedProviderRef[];
  readonly metadata: Readonly<Record<string, string>>;
}

export interface NormalizedSnapshot {
  readonly format: typeof CATALOG_SNAPSHOT_FORMAT;
  readonly version: typeof CATALOG_SNAPSHOT_VERSION;
  readonly source: string;
  readonly items: readonly NormalizedSnapshotItem[];
  /** A digest of the normalized document. Two identical imports produce the same value; it names no content. */
  readonly digest: string;
}

export class CatalogImportError extends Error {
  readonly code = 'CATALOG_IMPORT_REJECTED';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`the catalog snapshot was rejected:\n  - ${problems.join('\n  - ')}`);
    this.name = 'CatalogImportError';
    this.problems = problems;
  }
}

/**
 * The item id for a record.
 *
 * Derived, so a re-import addresses the same rows; name-based (RFC 4122 §4.3 shape, SHA-256 truncated), so
 * the mapping is stable across machines and versions without a lookup table. It is NOT a hash an observer can
 * invert into the external id without already knowing the source and the id — but it is not a secret either,
 * and nothing here treats it as one. The item id is opaque to the authority by design (see events.ts).
 */
export function deriveItemId(source: string, externalId: string): string {
  const hash = createHash('sha256')
    .update(`${CATALOG_SNAPSHOT_FORMAT}/v${CATALOG_SNAPSHOT_VERSION}\u0000${source}\u0000${externalId}`, 'utf8')
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5 (name-based)
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A short, stable label for a record that is safe to print. It is not reversible and names no content. */
export function externalIdDigest(source: string, externalId: string): string {
  return createHash('sha256').update(`${source}\u0000${externalId}`, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Parse, validate and normalize a snapshot document.
 *
 * Collects EVERY problem rather than throwing on the first. An operator fixing an export by hand should get
 * the whole list once, not discover the next fault on the next run.
 */
export function parseCatalogSnapshot(text: string): NormalizedSnapshot {
  const problems: string[] = [];
  const add = (problem: string): void => {
    if (problems.length < IMPORT_MAX_REPORTED_PROBLEMS) problems.push(problem);
  };

  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > IMPORT_MAX_BYTES) {
    // Reported alone: everything below would parse a document already known to be out of bounds.
    throw new CatalogImportError([`the snapshot is ${byteLength} bytes, over the ${IMPORT_MAX_BYTES}-byte limit`]);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new CatalogImportError(['the snapshot is not valid JSON']);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new CatalogImportError(['the snapshot must be a JSON object']);
  }
  const root = doc as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!['format', 'version', 'source', 'items'].includes(key)) {
      add(`the snapshot has an unknown top-level key: ${key}`);
    }
  }
  if (root.format !== CATALOG_SNAPSHOT_FORMAT) add(`format must be "${CATALOG_SNAPSHOT_FORMAT}"`);
  if (root.version !== CATALOG_SNAPSHOT_VERSION) add(`version must be ${CATALOG_SNAPSHOT_VERSION}`);

  const source = root.source;
  let validSource = false;
  if (typeof source !== 'string' || source.length === 0) add('source is required and must be a string');
  else if (source.length > IMPORT_MAX_SOURCE_LENGTH) add(`source is longer than ${IMPORT_MAX_SOURCE_LENGTH} characters`);
  else if (!SOURCE_RE.test(source)) add('source must be lower-case letters, digits, dot, dash or underscore, starting with a letter or digit');
  else validSource = true;

  const rawItems = root.items;
  if (!Array.isArray(rawItems)) {
    add('items must be an array');
    throw new CatalogImportError(problems);
  }
  if (rawItems.length === 0) add('items is empty; there is nothing to import');
  if (rawItems.length > IMPORT_MAX_ITEMS) {
    add(`the snapshot has ${rawItems.length} items, over the ${IMPORT_MAX_ITEMS}-item limit`);
  }
  // Bail before the per-item pass if the envelope itself is wrong. Without a usable source there are no
  // derived ids at all, and a wrong `format` or `version` means the per-item shape is not this format's —
  // so continuing would bury the one fault that has to be fixed first under a hundred consequences of it.
  if (!validSource || problems.length > 0) throw new CatalogImportError(problems);

  const items: NormalizedSnapshotItem[] = [];
  const seenExternalIds = new Map<string, number>();
  const seenItemIds = new Map<string, number>();

  rawItems.forEach((raw, index) => {
    const at = `item ${index}`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      add(`${at}: must be an object`);
      return;
    }
    const rec = raw as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (!['externalId', 'title', 'year', 'providerRefs', 'metadata'].includes(key)) {
        add(`${at}: unknown key ${key}`);
      }
    }

    const externalId = rec.externalId;
    if (typeof externalId !== 'string' || externalId.length === 0) { add(`${at}: externalId is required and must be a non-empty string`); return; }
    if (externalId.length > IMPORT_MAX_EXTERNAL_ID_LENGTH) { add(`${at}: externalId is longer than ${IMPORT_MAX_EXTERNAL_ID_LENGTH} characters`); return; }
    if (!EXTERNAL_ID_RE.test(externalId)) { add(`${at}: externalId must be printable ASCII on a single line, with no leading space`); return; }

    const duplicateAt = seenExternalIds.get(externalId);
    if (duplicateAt !== undefined) {
      // The value is NOT echoed. Two positions and a digest are enough to find it without putting operator
      // content in a message that may be pasted into an issue.
      add(`${at}: duplicate externalId, already used by item ${duplicateAt} (digest ${externalIdDigest(source as string, externalId)})`);
      return;
    }
    seenExternalIds.set(externalId, index);

    const title = rec.title;
    if (typeof title !== 'string' || title.trim().length === 0) { add(`${at}: title is required and must be a non-empty string`); return; }
    if (title.length > IMPORT_MAX_TITLE_LENGTH) { add(`${at}: title is longer than ${IMPORT_MAX_TITLE_LENGTH} characters`); return; }
    if (CONTROL_CHARS.test(title)) { add(`${at}: title contains control characters`); return; }

    let year: number | null = null;
    if (rec.year !== undefined && rec.year !== null) {
      const value = rec.year;
      if (typeof value !== 'number' || !Number.isInteger(value)) { add(`${at}: year must be a whole number`); return; }
      if (value < IMPORT_MIN_YEAR || value > IMPORT_MAX_YEAR) { add(`${at}: year must be between ${IMPORT_MIN_YEAR} and ${IMPORT_MAX_YEAR}`); return; }
      year = value;
    }

    const providerRefs: NormalizedProviderRef[] = [];
    if (rec.providerRefs !== undefined) {
      if (!Array.isArray(rec.providerRefs)) { add(`${at}: providerRefs must be an array`); return; }
      if (rec.providerRefs.length > IMPORT_MAX_REFS_PER_ITEM) { add(`${at}: more than ${IMPORT_MAX_REFS_PER_ITEM} providerRefs`); return; }
      const seenTypes = new Set<string>();
      let refProblem = false;
      for (const [refIndex, rawRef] of rec.providerRefs.entries()) {
        const where = `${at}: providerRefs[${refIndex}]`;
        if (rawRef === null || typeof rawRef !== 'object' || Array.isArray(rawRef)) { add(`${where} must be an object`); refProblem = true; break; }
        const ref = rawRef as Record<string, unknown>;
        for (const key of Object.keys(ref)) {
          if (key !== 'type' && key !== 'value') { add(`${where} has an unknown key ${key}`); refProblem = true; }
        }
        if (refProblem) break;
        const type = ref.type;
        if (typeof type !== 'string' || !(KNOWN_REF_TYPES as readonly string[]).includes(type)) {
          // The closed set is the DATABASE's, enforced in cat_apply_internal. Rejecting here turns a SQL
          // exception halfway through an import into a validation failure before anything is written.
          add(`${where} type must be one of: ${KNOWN_REF_TYPES.join(', ')}`);
          refProblem = true; break;
        }
        if (seenTypes.has(type)) { add(`${where} repeats the ${type} type; an item holds at most one ref per type`); refProblem = true; break; }
        seenTypes.add(type);
        const value = ref.value;
        if (typeof value !== 'string' || value.length === 0) { add(`${where} value is required and must be a non-empty string`); refProblem = true; break; }
        if (value.length > IMPORT_MAX_REF_VALUE_LENGTH) { add(`${where} value is longer than ${IMPORT_MAX_REF_VALUE_LENGTH} characters`); refProblem = true; break; }
        if (CONTROL_CHARS.test(value)) { add(`${where} value contains control characters`); refProblem = true; break; }
        providerRefs.push({ type: type as RefType, value });
      }
      if (refProblem) return;
    }

    // Null-prototype: `METADATA_KEY_RE` already refuses `__proto__` (it does not start with a letter or
    // digit), but an accumulator with no prototype means a key that ever got past a future edit of that
    // pattern still cannot reach `Object.prototype`.
    const metadata: Record<string, string> = Object.create(null) as Record<string, string>;
    if (rec.metadata !== undefined) {
      const raw = rec.metadata;
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { add(`${at}: metadata must be an object`); return; }
      const entries = Object.entries(raw as Record<string, unknown>);
      if (entries.length > IMPORT_MAX_METADATA_KEYS) { add(`${at}: metadata has more than ${IMPORT_MAX_METADATA_KEYS} keys`); return; }
      let metaProblem = false;
      for (const [key, value] of entries) {
        if (key.length > IMPORT_MAX_METADATA_KEY_LENGTH || !METADATA_KEY_RE.test(key)) {
          add(`${at}: metadata key ${JSON.stringify(key).slice(0, 24)} must be lower-case letters, digits, dot, dash or underscore`);
          metaProblem = true; break;
        }
        // Flat string values only. A nested object would be an unbounded structure inside an encrypted blob
        // that the browser later renders, and there is no import need it serves.
        if (typeof value !== 'string') { add(`${at}: metadata.${key} must be a string`); metaProblem = true; break; }
        if (value.length > IMPORT_MAX_METADATA_VALUE_LENGTH) { add(`${at}: metadata.${key} is longer than ${IMPORT_MAX_METADATA_VALUE_LENGTH} characters`); metaProblem = true; break; }
        if (CONTROL_CHARS.test(value)) { add(`${at}: metadata.${key} contains control characters`); metaProblem = true; break; }
        metadata[key] = value;
      }
      if (metaProblem) return;
    }

    const itemId = deriveItemId(source as string, externalId);
    const collision = seenItemIds.get(itemId);
    if (collision !== undefined) {
      // Two distinct external ids deriving to one item id is a SHA-256 collision and will not happen. It is
      // checked anyway because the alternative is one record silently overwriting another.
      add(`${at}: derives the same item id as item ${collision}`);
      return;
    }
    seenItemIds.set(itemId, index);
    items.push({ itemId, externalId, title: title.trim(), year, providerRefs, metadata });
  });

  if (problems.length > 0) throw new CatalogImportError(problems);

  return {
    format: CATALOG_SNAPSHOT_FORMAT,
    version: CATALOG_SNAPSHOT_VERSION,
    source: source as string,
    items,
    digest: snapshotDigest(source as string, items),
  };
}

/**
 * A digest over the NORMALIZED document.
 *
 * Order-independent by construction — the per-item digests are sorted before hashing — so two exports of the
 * same catalog in different orders produce the same value and an operator can tell "the same snapshot" from
 * "a changed snapshot" without diffing files that contain their own content.
 */
export function snapshotDigest(source: string, items: readonly NormalizedSnapshotItem[]): string {
  const perItem = items.map((item) => createHash('sha256').update(JSON.stringify([
    item.externalId, item.title, item.year,
    item.providerRefs.map((r) => [r.type, r.value]),
    Object.keys(item.metadata).sort().map((k) => [k, item.metadata[k]]),
  ]), 'utf8').digest('hex')).sort();
  return createHash('sha256').update(`${source}\u0000${perItem.join('')}`, 'utf8').digest('hex');
}
