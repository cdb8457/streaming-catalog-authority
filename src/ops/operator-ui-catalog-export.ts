import {
  CATALOG_SNAPSHOT_FORMAT,
  CATALOG_SNAPSHOT_VERSION,
  IMPORT_MAX_METADATA_KEYS,
  IMPORT_MAX_METADATA_VALUE_LENGTH,
  IMPORT_MAX_TITLE_LENGTH,
} from '../core/catalog/import-snapshot.js';
import type { CatalogReader } from './operator-ui-catalog-browse.js';

// Phase 265 — taking your catalog back out, as a file you can read.
//
// WHAT IT PRODUCES. A document in the SAME format the import reads — `catalog-authority.snapshot` v1 — so an
// export is a real backup of the part of a catalog this product can give back, and re-importing one is a
// supported round trip rather than a shape nothing else understands.
//
// WHAT IT DELIBERATELY DOES NOT CONTAIN, AND WHY THE ROUND TRIP IS THEREFORE LOSSY. Provider reference
// VALUES are the thing the adapter boundary exists to guard: `withProviderRef` discloses exactly one, to one
// adapter, under redaction, after re-checking that it is still current. A file an operator downloads through
// a browser is not that, and no amount of "it is their own data" makes a bulk disclosure of every protected
// reference into a different thing. So refs are omitted entirely and COUNTED — the export says how many it
// left out, in the response, rather than quietly producing a document that looks complete. The same is true
// of item ids and key material: neither appears, because neither is content an operator wrote.
//
// IT IS A READ, STRUCTURALLY. The only database access is through `CatalogReader`, whose three statements are
// SELECTs. There is no authority, no event append and no history write anywhere in this file, so "exporting
// wrote nothing" is a property of what this code can reach.
//
// IT IS DETERMINISTIC. Records are ordered by the operator's own external id, every object's keys are
// written in a fixed order, and the serialisation is explicit — so exporting the same catalog twice produces
// the same bytes, and two exports can be diffed to see what changed rather than to see how they were
// serialised.
//
// IT IS BOUNDED, AND REFUSES RATHER THAN TRUNCATING. An export larger than the limit is a refusal with a
// named code. A truncated file that still says `"format": "catalog-authority.snapshot"` is a backup that
// silently is not one, which is worse than no file.
//
// IT IS SANITIZED. Values are re-checked against the import's own bounds on the way out: a control character
// or an over-long value is dropped and counted, never emitted. The result is that an export is always a
// document the import would accept, and a record that was written by some other route cannot smuggle a
// terminal escape sequence into a file somebody opens.

export const CATALOG_EXPORT_ROUTE = '/api/catalog/export';
export const CATALOG_EXPORT_REPORT = 'phase-265-catalog-export';

/** How many records one export will produce. Beyond this it refuses; it never truncates. */
export const CATALOG_EXPORT_MAX_ITEMS = 5000;
/** How many item ids are read to discover the sources present. Same bound the browser's scan uses. */
export const CATALOG_EXPORT_MAX_SCAN = 5000;

/** The shape a source label may have. Identical to the import's, and re-checked here on the way out. */
const SOURCE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** C0/C1 control characters — the same set the import refuses, applied again on the way out. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
/** A metadata key the import would accept. A key that would not survive a re-import is not exported. */
const METADATA_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** An external id the import would accept: printable ASCII, single line, no leading space. */
const EXTERNAL_ID_RE = /^[!-~][ -~]{0,127}$/;

export type CatalogExportRefusal =
  | 'EMPTY'
  | 'AMBIGUOUS_SOURCE'
  | 'UNKNOWN_SOURCE'
  | 'TOO_LARGE';

export interface CatalogExportSanitized {
  /** Provider references omitted. Never disclosed, always counted. */
  readonly providerRefsOmitted: number;
  /** Metadata entries dropped because they did not survive the outbound bounds check. */
  readonly metadataDropped: number;
  /** Records skipped because their title did not survive the outbound bounds check. */
  readonly recordsSkipped: number;
}

export interface CatalogExportSuccess {
  readonly ok: true;
  readonly source: string;
  readonly count: number;
  /** The exact bytes to send. Serialised once, here, so what is hashed and what is sent cannot differ. */
  readonly json: string;
  /** A fixed-grammar file name, built from a source that has been re-validated against a closed pattern. */
  readonly fileName: string;
  readonly sanitized: CatalogExportSanitized;
  /** Every source present in the catalog, so a UI can offer them without inventing any. */
  readonly sources: readonly string[];
}

export interface CatalogExportRefused {
  readonly ok: false;
  readonly refusal: CatalogExportRefusal;
  readonly message: string;
  readonly sources: readonly string[];
}

export type CatalogExportResult = CatalogExportSuccess | CatalogExportRefused;

interface ExportRecord {
  readonly externalId: string;
  readonly title: string;
  readonly year: number | null;
  readonly metadata: ReadonlyArray<readonly [string, string]>;
}

/**
 * Build one export.
 *
 * `requestedSource` comes from a query string and is treated as untrusted: it is matched against the sources
 * the DATABASE actually holds, never used to build a query, a path or a file name before that match. A source
 * that is not present is a refusal that lists what is, so an operator can fix a typo without guessing.
 */
export async function exportCatalog(
  reader: CatalogReader,
  requestedSource: unknown,
): Promise<CatalogExportResult> {
  const total = await reader.countActive();
  if (total === 0) {
    return {
      ok: false,
      refusal: 'EMPTY',
      sources: [],
      message: 'This catalog is empty, so there is nothing to export. That is a healthy state for a fresh '
        + 'installation — import a snapshot first.',
    };
  }
  if (total > CATALOG_EXPORT_MAX_ITEMS) {
    return {
      ok: false,
      refusal: 'TOO_LARGE',
      sources: [],
      message: `This catalog holds ${total} records, more than the ${CATALOG_EXPORT_MAX_ITEMS} one export `
        + 'produces. Nothing was written and no partial file was produced: a truncated export that still '
        + 'called itself a snapshot would be a backup that silently is not one. Use the command-line backup '
        + 'for a whole installation.',
    };
  }

  const ids = await reader.listActiveIds(Math.min(total, CATALOG_EXPORT_MAX_SCAN), 0);
  const byExternalId = new Map<string, Map<string, ExportRecord>>();
  const sanitized = { providerRefsOmitted: 0, metadataDropped: 0, recordsSkipped: 0 };

  for (const itemId of ids) {
    // Fail-closed per record, exactly as the browser does: a lineage that stopped being active mid-export
    // drops out rather than failing the whole export or being invented into the file.
    const identity = await reader.readIdentity(itemId).catch(() => null);
    if (identity === null) continue;

    sanitized.providerRefsOmitted += (identity.providerRefs ?? []).length;

    const title = typeof identity.title === 'string' ? identity.title.trim() : '';
    const titleOk = title.length > 0 && title.length <= IMPORT_MAX_TITLE_LENGTH && !CONTROL_CHARS.test(title);
    const externalIds = flatStrings(identity.externalIds);

    for (const [source, externalId] of externalIds) {
      // A source or an external id the IMPORT would not accept is not exported. The point of writing this
      // format is that it can be read back; emitting a record that would be rejected on re-import would be
      // producing a file that only looks like a snapshot.
      if (!SOURCE_RE.test(source) || !EXTERNAL_ID_RE.test(externalId)) { sanitized.recordsSkipped += 1; continue; }
      if (!titleOk) { sanitized.recordsSkipped += 1; continue; }
      const metadata: Array<readonly [string, string]> = [];
      for (const [key, value] of flatStrings(identity.metadata)) {
        if (metadata.length >= IMPORT_MAX_METADATA_KEYS) { sanitized.metadataDropped += 1; continue; }
        if (!METADATA_KEY_RE.test(key)
          || value.length > IMPORT_MAX_METADATA_VALUE_LENGTH
          || CONTROL_CHARS.test(value)) {
          sanitized.metadataDropped += 1;
          continue;
        }
        metadata.push([key, value]);
      }
      const bucket = byExternalId.get(source) ?? new Map<string, ExportRecord>();
      // A source/externalId pair addresses exactly one record by construction (the item id is derived from
      // it), so a collision here would be a database that disagrees with its own derivation. Last write
      // wins deterministically because the ids are read in a fixed order.
      bucket.set(externalId, {
        externalId,
        title,
        year: typeof identity.year === 'number' && Number.isInteger(identity.year) ? identity.year : null,
        metadata: metadata.sort((a, b) => a[0].localeCompare(b[0], 'en')),
      });
      byExternalId.set(source, bucket);
    }
  }

  const sources = [...byExternalId.keys()].sort((a, b) => a.localeCompare(b, 'en'));
  if (sources.length === 0) {
    return {
      ok: false,
      refusal: 'EMPTY',
      sources,
      message: 'No record in this catalog carries an importable source label, so there is nothing this export '
        + 'could produce that the import would accept.',
    };
  }

  let source: string;
  if (typeof requestedSource === 'string' && requestedSource !== '') {
    if (!sources.includes(requestedSource)) {
      return {
        ok: false,
        refusal: 'UNKNOWN_SOURCE',
        sources,
        message: 'No record in this catalog carries that source label. The labels this catalog does hold are '
          + 'listed with this message.',
      };
    }
    source = requestedSource;
  } else if (sources.length === 1) {
    source = sources[0]!;
  } else {
    return {
      ok: false,
      refusal: 'AMBIGUOUS_SOURCE',
      sources,
      message: 'This catalog holds records from more than one source, and a snapshot describes exactly one. '
        + 'Choose which source to export; the labels are listed with this message.',
    };
  }

  const records = [...byExternalId.get(source)!.values()]
    .sort((a, b) => a.externalId.localeCompare(b.externalId, 'en'));
  if (records.length > CATALOG_EXPORT_MAX_ITEMS) {
    return {
      ok: false,
      refusal: 'TOO_LARGE',
      sources,
      message: `That source holds ${records.length} records, more than the ${CATALOG_EXPORT_MAX_ITEMS} one `
        + 'export produces. Nothing was written and no partial file was produced.',
    };
  }

  return {
    ok: true,
    source,
    count: records.length,
    json: serialize(source, records),
    fileName: exportFileName(source),
    sanitized,
    sources,
  };
}

/**
 * Serialise, deterministically and by hand.
 *
 * Written explicitly rather than by handing an object to `JSON.stringify` because the KEY ORDER is part of
 * the guarantee: two exports of the same catalog must be the same bytes, and object key order in JavaScript
 * depends on insertion order, which depends on the order fields happened to be assigned. Every value still
 * goes through `JSON.stringify`, so escaping is the language's and not this function's.
 */
function serialize(source: string, records: readonly ExportRecord[]): string {
  const lines: string[] = ['{'];
  lines.push(`  "format": ${JSON.stringify(CATALOG_SNAPSHOT_FORMAT)},`);
  lines.push(`  "version": ${JSON.stringify(CATALOG_SNAPSHOT_VERSION)},`);
  lines.push(`  "source": ${JSON.stringify(source)},`);
  lines.push('  "items": [');
  records.forEach((record, index) => {
    const tail = index === records.length - 1 ? '' : ',';
    lines.push('    {');
    lines.push(`      "externalId": ${JSON.stringify(record.externalId)},`);
    lines.push(`      "title": ${JSON.stringify(record.title)},`);
    const hasMetadata = record.metadata.length > 0;
    lines.push(`      "year": ${JSON.stringify(record.year)}${hasMetadata ? ',' : ''}`);
    if (hasMetadata) {
      lines.push('      "metadata": {');
      record.metadata.forEach(([key, value], metaIndex) => {
        const metaTail = metaIndex === record.metadata.length - 1 ? '' : ',';
        lines.push(`        ${JSON.stringify(key)}: ${JSON.stringify(value)}${metaTail}`);
      });
      lines.push('      }');
    }
    lines.push(`    }${tail}`);
  });
  lines.push('  ]');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/**
 * The download's file name.
 *
 * Built from a source that has ALREADY been matched against the closed set the database holds, and then
 * re-validated against the pattern anyway. A `Content-Disposition` header is a place where a quote, a
 * semicolon, a newline or a directory separator turns a file name into a second header or a path, so the
 * grammar of what may appear here is fixed rather than escaped: letters, digits, dot, dash, underscore, and
 * nothing else can survive the pattern. A source that somehow failed it falls back to a constant.
 */
export function exportFileName(source: string): string {
  const safe = SOURCE_RE.test(source) ? source : 'catalog';
  return `catalog-export-${safe}.json`;
}

/**
 * A decrypted map, flattened to bounded string pairs.
 *
 * The import path only ever writes flat string maps, but an item created by any other route (or by an older
 * build) can hold anything the identity blob allowed. An export is not the place to discover that, so
 * anything that is not a string pair is dropped here rather than serialised into a file somebody opens.
 * Ordered by key so the export is deterministic whatever order the blob happened to hold.
 */
function flatStrings(value: unknown): ReadonlyArray<readonly [string, string]> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const out: Array<readonly [string, string]> = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== 'string' || typeof item !== 'string') continue;
    out.push([key, item]);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0], 'en'));
}
