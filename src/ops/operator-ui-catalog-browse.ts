import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { CatalogAuthority, ItemIdentity } from '../core/catalog/authority.js';
import { ITEM_ID_RE, KNOWN_REF_TYPES } from '../core/catalog/events.js';

// Phase 260 — reading the catalog back.
//
// THE CONSTRAINT THAT SHAPES EVERYTHING HERE. Item identity is encrypted at rest with a per-item key, and
// crypto-shredding is the whole erasure story (Phase 2). There is no plaintext title column to index, sort or
// search on, and adding one would mean a forgotten item's title survived its key — which would defeat the
// design this project is built around. So the browser DECRYPTS, through `CatalogAuthority.readIdentity`,
// which is fail-closed at every step and already re-checks the lineage at its linearization point.
//
// THAT MAKES SCANNING EXPENSIVE, SO IT IS BOUNDED AND HONEST. Two paths:
//
//   - NO SEARCH, NO FILTER, SORTED BY ID. The database paginates (`ORDER BY id LIMIT/OFFSET`) and only the
//     requested page is ever decrypted — at most `pageSize` items. Exact, cheap, never truncated.
//   - ANYTHING ELSE. Searching, filtering, or sorting by title or year needs plaintext, so a bounded window
//     of items is read in id order and matched in this process. When the catalog is larger than the window,
//     the response says `truncated: true` and reports how far it looked. It never implies it saw everything.
//
// IT IS READ-ONLY, AND STRUCTURALLY SO. Every query in this file is a SELECT; there is no INSERT, UPDATE,
// DELETE, or authority mutation reachable from it, and the runtime role it runs as is the least-privileged
// one. It reads no promotion record and produces no evidence of any kind.
//
// PROVIDER REF VALUES ARE NEVER DISCLOSED. A ref value is the thing the adapter boundary exists to guard —
// `withProviderRef` discloses exactly one, to one adapter, under redaction, and re-checks that it is still
// current before doing so. A browser panel is not that. The list and the detail view show the ref TYPE and a
// short non-reversible fingerprint of the value, which is enough to tell two records apart and to see that a
// ref is present, and is not the value.

export const CATALOG_BROWSE_ROUTE = '/api/catalog';
export const CATALOG_ITEM_ROUTE = '/api/catalog/item';

export const CATALOG_BROWSE_DEFAULT_PAGE_SIZE = 25;
export const CATALOG_BROWSE_MAX_PAGE_SIZE = 100;
export const CATALOG_BROWSE_MAX_PAGE = 1000;
/** How many items a filtered or searched request will decrypt before it stops and says it stopped. */
export const CATALOG_BROWSE_MAX_SCAN = 1000;
/** How many identities are decrypted at once. Bounded so a page never opens an unbounded fan of connections. */
export const CATALOG_BROWSE_READ_CONCURRENCY = 8;
export const CATALOG_BROWSE_MAX_QUERY_LENGTH = 128;
export const CATALOG_BROWSE_MAX_METADATA_KEYS = 24;
export const CATALOG_BROWSE_MAX_VALUE_LENGTH = 512;

export const CATALOG_SORT_FIELDS = ['id', 'title', 'year'] as const;
export type CatalogSortField = (typeof CATALOG_SORT_FIELDS)[number];
export type CatalogSortOrder = 'asc' | 'desc';

export interface CatalogBrowseQuery {
  readonly search: string;
  readonly sort: CatalogSortField;
  readonly order: CatalogSortOrder;
  readonly page: number;
  readonly pageSize: number;
  /** Restrict to items carrying this provider ref type. One of the database's own closed set. */
  readonly refType: string | null;
  /** Restrict to items imported under this source label. */
  readonly source: string | null;
  readonly yearFrom: number | null;
  readonly yearTo: number | null;
}

export interface CatalogBrowseQueryResult {
  readonly query: CatalogBrowseQuery;
  /** Parameters that were present but unusable. The request still succeeds with the default. */
  readonly ignored: readonly string[];
}

const SOURCE_RE = /^[a-z0-9][a-z0-9._-]*$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export const CATALOG_BROWSE_DEFAULT_QUERY: CatalogBrowseQuery = {
  search: '', sort: 'id', order: 'asc', page: 1, pageSize: CATALOG_BROWSE_DEFAULT_PAGE_SIZE,
  refType: null, source: null, yearFrom: null, yearTo: null,
};

/**
 * Parse a request's query string into a bounded, deterministic query.
 *
 * NOTHING HERE THROWS AND NOTHING HERE REJECTS. A browser that sends a page number of `1e999`, a page size of
 * `-4`, a sort field of `; DROP TABLE`, or a hundred repeated parameters gets a WORKING page built from the
 * defaults, plus an `ignored` list naming which parameters were not usable. A 400 on a stale bookmark would
 * be a worse experience than a first page, and — more importantly — every value that reaches SQL from here is
 * an integer this function produced or a value from a closed set, never a caller's string.
 */
export function parseCatalogBrowseQuery(search: string): CatalogBrowseQueryResult {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const ignored: string[] = [];
  const take = (name: string): string | null => {
    const values = params.getAll(name);
    if (values.length === 0) return null;
    // A repeated parameter is ambiguous. Taking the first and saying so beats guessing.
    if (values.length > 1) ignored.push(`${name} (repeated)`);
    return values[0] ?? null;
  };

  let searchTerm = '';
  const rawSearch = take('q');
  if (rawSearch !== null) {
    const trimmed = rawSearch.trim();
    if (trimmed.length > CATALOG_BROWSE_MAX_QUERY_LENGTH || CONTROL_CHARS.test(trimmed)) ignored.push('q');
    else searchTerm = trimmed;
  }

  let sort: CatalogSortField = 'id';
  const rawSort = take('sort');
  if (rawSort !== null) {
    if ((CATALOG_SORT_FIELDS as readonly string[]).includes(rawSort)) sort = rawSort as CatalogSortField;
    else ignored.push('sort');
  }

  let order: CatalogSortOrder = 'asc';
  const rawOrder = take('order');
  if (rawOrder !== null) {
    if (rawOrder === 'asc' || rawOrder === 'desc') order = rawOrder;
    else ignored.push('order');
  }

  const page = boundedInt(take('page'), 1, CATALOG_BROWSE_MAX_PAGE, 1, 'page', ignored) ?? 1;
  const pageSize = boundedInt(take('pageSize'), 1, CATALOG_BROWSE_MAX_PAGE_SIZE, CATALOG_BROWSE_DEFAULT_PAGE_SIZE, 'pageSize', ignored)
    ?? CATALOG_BROWSE_DEFAULT_PAGE_SIZE;

  let refType: string | null = null;
  const rawRefType = take('refType');
  if (rawRefType !== null && rawRefType !== '') {
    if ((KNOWN_REF_TYPES as readonly string[]).includes(rawRefType)) refType = rawRefType;
    else ignored.push('refType');
  }

  let source: string | null = null;
  const rawSource = take('source');
  if (rawSource !== null && rawSource !== '') {
    if (rawSource.length <= 64 && SOURCE_RE.test(rawSource)) source = rawSource;
    else ignored.push('source');
  }

  let yearFrom = boundedInt(take('yearFrom'), 0, 9999, null, 'yearFrom', ignored);
  let yearTo = boundedInt(take('yearTo'), 0, 9999, null, 'yearTo', ignored);
  if (yearFrom !== null && yearTo !== null && yearFrom > yearTo) {
    // An inverted range matches nothing, which reads as "the catalog is empty" — a wrong answer to a typo.
    ignored.push('yearFrom/yearTo (inverted)');
    yearFrom = null;
    yearTo = null;
  }

  return {
    query: { search: searchTerm, sort, order, page, pageSize, refType, source, yearFrom, yearTo },
    ignored,
  };
}

/**
 * A whole number inside a range, or the fallback.
 *
 * The digit-only pattern is doing real work: it refuses `1e999`, `-4`, `0x10`, `Infinity` and ` 3 ` before
 * `Number` ever sees them, so a page offset that reaches SQL is always a small non-negative integer.
 */
function boundedInt(raw: string | null, min: number, max: number, fallback: number | null, name: string, ignored: string[]): number | null {
  if (raw === null || raw === '') return fallback;
  if (!/^\d{1,9}$/.test(raw)) { ignored.push(name); return fallback; }
  const value = Number(raw);
  if (value < min || value > max) { ignored.push(name); return fallback; }
  return value;
}

export interface CatalogRecordSummary {
  readonly itemId: string;
  readonly title: string;
  readonly year: number | null;
  /** Provider ref TYPES only. The values are never in a response. */
  readonly refTypes: readonly string[];
  /** The source labels this record was imported under (the keys of externalIds). */
  readonly sources: readonly string[];
}

export interface CatalogRecordDetail extends CatalogRecordSummary {
  /** The operator's own key for this record, per source. Their identifier, shown back to them. */
  readonly externalIds: Readonly<Record<string, string>>;
  readonly metadata: Readonly<Record<string, string>>;
  /** Ref type plus a short, non-reversible fingerprint. NEVER the ref value. */
  readonly providerRefs: ReadonlyArray<{ readonly type: string; readonly fingerprint: string }>;
}

export type CatalogBrowseState = 'EMPTY' | 'RESULTS' | 'NO_MATCH';

export interface CatalogBrowseResult {
  readonly ok: true;
  readonly code: 'OPERATOR_UI_CATALOG';
  readonly report: 'phase-260-catalog-browser';
  readonly state: CatalogBrowseState;
  /** Every active record in the catalog. */
  readonly total: number;
  /** How many matched the query. Equal to `total` when there is no search or filter. */
  readonly matched: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
  /** True when a search or filter stopped at the scan bound and did not see the whole catalog. */
  readonly truncated: boolean;
  readonly scanned: number;
  readonly scanLimit: number;
  readonly items: readonly CatalogRecordSummary[];
  readonly query: CatalogBrowseQuery;
  readonly ignored: readonly string[];
  /** Guidance for the state the catalog is actually in. Never an error. */
  readonly guidance: string;
}

export interface CatalogReader {
  /** How many present, non-forgotten items have an active key lineage. */
  countActive(): Promise<number>;
  /** Item ids in a deterministic order (`ORDER BY id`), bounded. */
  listActiveIds(limit: number, offset: number): Promise<readonly string[]>;
  /** Decrypt one identity. Fail-closed: null when the lineage is not active. */
  readIdentity(itemId: string): Promise<ItemIdentity | null>;
}

/**
 * The only database access this feature has. Three SELECTs, all parameterised, none of them touching
 * ciphertext directly — decryption goes through `CatalogAuthority`, which owns the fail-closed rules.
 */
export function createCatalogReader(pool: Pool, authority: Pick<CatalogAuthority, 'readIdentity'>): CatalogReader {
  const ACTIVE = `FROM items i JOIN item_key_control k ON k.item_id = i.id
                   WHERE i.present AND NOT i.forgotten AND i.identity_ct IS NOT NULL AND k.shred_state = 'active'`;
  return {
    countActive: async () => Number((await pool.query(`SELECT count(*)::int AS n ${ACTIVE}`)).rows[0].n),
    listActiveIds: async (limit, offset) => (await pool.query(
      `SELECT i.id ${ACTIVE} ORDER BY i.id ASC LIMIT $1 OFFSET $2`, [limit, offset],
    )).rows.map((row) => row.id as string),
    readIdentity: (itemId) => authority.readIdentity(itemId),
  };
}

/** A short, non-reversible fingerprint of a provider ref value. Enough to compare; never the value. */
export function refFingerprint(refType: string, value: string): string {
  return createHash('sha256').update(`phase-260-ref\u0000${refType}\u0000${value}`, 'utf8').digest('hex').slice(0, 12);
}

function toSummary(itemId: string, identity: ItemIdentity): CatalogRecordSummary {
  return {
    itemId,
    title: typeof identity.title === 'string' ? identity.title : '',
    year: typeof identity.year === 'number' ? identity.year : null,
    refTypes: (identity.providerRefs ?? []).map((ref) => ref.type).sort(),
    sources: Object.keys(stringMap(identity.externalIds) ?? {}).sort(),
  };
}

/**
 * Coerce a decrypted map to flat strings, bounded.
 *
 * The import path only ever writes flat string maps, but an item created by any other route (or by an older
 * build) can hold anything the identity blob allowed. Rendering is not the place to discover that, so
 * anything that is not a bounded string is dropped here rather than shipped to a browser.
 */
function stringMap(value: unknown): Record<string, string> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (count >= CATALOG_BROWSE_MAX_METADATA_KEYS) break;
    if (typeof item !== 'string' || item.length > CATALOG_BROWSE_MAX_VALUE_LENGTH) continue;
    if (key.length > CATALOG_BROWSE_MAX_VALUE_LENGTH) continue;
    out[key] = item;
    count += 1;
  }
  return out;
}

/** Does this record match the query? Plain in-process matching over already-decrypted values. */
export function matchesQuery(summary: CatalogRecordSummary, externalIds: Record<string, string>, query: CatalogBrowseQuery): boolean {
  if (query.refType !== null && !summary.refTypes.includes(query.refType)) return false;
  if (query.source !== null && !summary.sources.includes(query.source)) return false;
  if (query.yearFrom !== null && (summary.year === null || summary.year < query.yearFrom)) return false;
  if (query.yearTo !== null && (summary.year === null || summary.year > query.yearTo)) return false;
  if (query.search !== '') {
    const needle = query.search.toLocaleLowerCase();
    const inTitle = summary.title.toLocaleLowerCase().includes(needle);
    // The operator's own key for the record is searchable too: "which row in my export is this?" is the
    // question a detail view exists to answer, and it should be askable from the search box.
    const inExternalId = Object.values(externalIds).some((value) => value.toLocaleLowerCase().includes(needle));
    if (!inTitle && !inExternalId) return false;
  }
  return true;
}

/**
 * Total order over records.
 *
 * ALWAYS TOTAL: every comparison falls back to the item id, which is unique. Two records with the same title
 * and year therefore have one fixed order, so paging through them cannot show the same record twice or skip
 * one — the defect an unstable sort produces at exactly the page boundary, where it is hardest to notice.
 */
export function compareRecords(a: CatalogRecordSummary, b: CatalogRecordSummary, sort: CatalogSortField, order: CatalogSortOrder): number {
  const direction = order === 'asc' ? 1 : -1;
  let primary = 0;
  if (sort === 'title') primary = a.title.localeCompare(b.title, 'en');
  else if (sort === 'year') {
    // A record with no year sorts last in BOTH directions. "Unknown" is not smaller than 1900; putting it at
    // the end either way means the first page of a year sort is always the part somebody asked to see.
    if (a.year === b.year) primary = 0;
    else if (a.year === null) return 1;
    else if (b.year === null) return -1;
    else primary = a.year - b.year;
  }
  if (primary !== 0) return primary * direction;
  return a.itemId.localeCompare(b.itemId, 'en') * direction;
}

function isFiltered(query: CatalogBrowseQuery): boolean {
  return query.search !== '' || query.refType !== null || query.source !== null
    || query.yearFrom !== null || query.yearTo !== null;
}

/** Read a list of identities with bounded concurrency, dropping any that fail closed. */
async function readAll(reader: CatalogReader, ids: readonly string[]): Promise<Array<{ itemId: string; identity: ItemIdentity }>> {
  const out: Array<{ itemId: string; identity: ItemIdentity } | null> = new Array(ids.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      if (index >= ids.length) return;
      next += 1;
      const itemId = ids[index]!;
      // A read that fails closed (a lineage that stopped being active mid-page, a custodian that is briefly
      // unreachable) drops the record from the page rather than failing the whole request. The item is not
      // pretended into existence, and the rest of the catalog stays browsable.
      const identity = await reader.readIdentity(itemId).catch(() => null);
      if (identity !== null) out[index] = { itemId, identity };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CATALOG_BROWSE_READ_CONCURRENCY, Math.max(ids.length, 1)) }, worker));
  return out.filter((entry): entry is { itemId: string; identity: ItemIdentity } => entry !== null);
}

/**
 * Build one page of the catalog.
 *
 * An EMPTY catalog is a healthy state and returns `ok: true`. A fresh install is not broken; it is empty, and
 * the guidance says what to do about it rather than reporting a fault.
 */
export async function browseCatalog(reader: CatalogReader, result: CatalogBrowseQueryResult): Promise<CatalogBrowseResult> {
  const { query, ignored } = result;
  const total = await reader.countActive();

  if (total === 0) {
    return page({
      state: 'EMPTY', total: 0, matched: 0, items: [], truncated: false, scanned: 0, query, ignored,
      guidance: 'This catalog is empty, which is a healthy state for a fresh installation. Write a snapshot '
        + 'file into your import folder and run the catalog import — the Import panel below has the format '
        + 'and the exact commands.',
    });
  }

  if (!isFiltered(query) && query.sort === 'id') {
    // THE CHEAP, EXACT PATH. The database orders and paginates; only this page is ever decrypted.
    const ordered = query.order === 'desc'
      ? await descendingPage(reader, total, query)
      : await reader.listActiveIds(query.pageSize, (query.page - 1) * query.pageSize);
    const records = await readAll(reader, ordered);
    return page({
      state: records.length === 0 ? 'NO_MATCH' : 'RESULTS',
      total, matched: total, truncated: false, scanned: ordered.length, query, ignored,
      items: records.map((entry) => toSummary(entry.itemId, entry.identity)),
      guidance: guidanceFor(total, total, false),
    });
  }

  // THE BOUNDED SCAN. Searching, filtering, or sorting by a field that only exists in plaintext needs the
  // identities, so a window of the catalog is read in id order and matched here.
  const scanLimit = Math.min(total, CATALOG_BROWSE_MAX_SCAN);
  const ids = await reader.listActiveIds(scanLimit, 0);
  const records = await readAll(reader, ids);
  const matches: CatalogRecordSummary[] = [];
  for (const entry of records) {
    const summary = toSummary(entry.itemId, entry.identity);
    if (matchesQuery(summary, stringMap(entry.identity.externalIds) ?? {}, query)) matches.push(summary);
  }
  matches.sort((a, b) => compareRecords(a, b, query.sort, query.order));
  const truncated = total > scanLimit;
  const offset = (query.page - 1) * query.pageSize;
  return page({
    state: matches.length === 0 ? 'NO_MATCH' : 'RESULTS',
    total, matched: matches.length, truncated, scanned: ids.length, query, ignored,
    items: matches.slice(offset, offset + query.pageSize),
    guidance: guidanceFor(total, matches.length, truncated),
  });
}

/**
 * The descending id page.
 *
 * `ORDER BY id DESC LIMIT/OFFSET` would be one query, but `listActiveIds` deliberately exposes exactly one
 * ordering so the SQL cannot be steered by a request. Reversing the offset arithmetic here keeps that true
 * and costs one extra bounded read.
 */
async function descendingPage(reader: CatalogReader, total: number, query: CatalogBrowseQuery): Promise<readonly string[]> {
  const fromEnd = (query.page - 1) * query.pageSize;
  const offset = Math.max(0, total - fromEnd - query.pageSize);
  const take = Math.max(0, Math.min(query.pageSize, total - fromEnd));
  if (take === 0) return [];
  const ids = await reader.listActiveIds(take, offset);
  return [...ids].reverse();
}

function guidanceFor(total: number, matched: number, truncated: boolean): string {
  if (truncated) {
    return `This catalog holds more records than one search reads at a time, so these results come from the `
      + `first ${CATALOG_BROWSE_MAX_SCAN} records by id. Narrow the search or use the filters to be sure you `
      + 'are seeing everything that matches.';
  }
  if (matched === 0) return 'Nothing matched. Clear the search and the filters to see the whole catalog.';
  return `${matched} of ${total} record${total === 1 ? '' : 's'} matched.`;
}

function page(input: {
  state: CatalogBrowseState;
  total: number;
  matched: number;
  items: readonly CatalogRecordSummary[];
  truncated: boolean;
  scanned: number;
  query: CatalogBrowseQuery;
  ignored: readonly string[];
  guidance: string;
}): CatalogBrowseResult {
  return {
    ok: true,
    code: 'OPERATOR_UI_CATALOG',
    report: 'phase-260-catalog-browser',
    state: input.state,
    total: input.total,
    matched: input.matched,
    page: input.query.page,
    pageSize: input.query.pageSize,
    pageCount: Math.max(1, Math.ceil(input.matched / input.query.pageSize)),
    truncated: input.truncated,
    scanned: input.scanned,
    scanLimit: CATALOG_BROWSE_MAX_SCAN,
    items: input.items,
    query: input.query,
    ignored: input.ignored,
    guidance: input.guidance,
  };
}

export type CatalogItemLookup =
  | { readonly found: true; readonly item: CatalogRecordDetail }
  | { readonly found: false; readonly reason: 'INVALID_ID' | 'NOT_FOUND' };

/**
 * One record, in full.
 *
 * `readIdentity` is fail-closed, so an item that has been forgotten, whose key is destroyed, or whose
 * custodian is unreachable is indistinguishable from one that never existed: NOT_FOUND. That is the correct
 * answer, and it is the same answer in every one of those cases so the response cannot be used to probe which.
 */
export async function readCatalogItem(reader: CatalogReader, rawId: unknown): Promise<CatalogItemLookup> {
  if (typeof rawId !== 'string' || !ITEM_ID_RE.test(rawId)) return { found: false, reason: 'INVALID_ID' };
  const identity = await reader.readIdentity(rawId);
  if (identity === null) return { found: false, reason: 'NOT_FOUND' };
  const summary = toSummary(rawId, identity);
  return {
    found: true,
    item: {
      ...summary,
      externalIds: stringMap(identity.externalIds) ?? {},
      metadata: stringMap(identity.metadata) ?? {},
      // Type and fingerprint. The decrypted value stops here and never enters a response body.
      providerRefs: (identity.providerRefs ?? [])
        .map((ref) => ({ type: ref.type, fingerprint: refFingerprint(ref.type, ref.value) }))
        .sort((a, b) => a.type.localeCompare(b.type, 'en')),
    },
  };
}

/** The filter values a UI can offer without inventing any. Exactly the closed set the database enforces. */
export const CATALOG_FILTER_REF_TYPES: readonly string[] = [...KNOWN_REF_TYPES];
