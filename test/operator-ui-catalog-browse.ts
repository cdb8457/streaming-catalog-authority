import { readFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { Script, createContext } from 'node:vm';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_BROWSE_DEFAULT_PAGE_SIZE,
  CATALOG_BROWSE_MAX_PAGE,
  CATALOG_BROWSE_MAX_PAGE_SIZE,
  CATALOG_BROWSE_MAX_SCAN,
  CATALOG_BROWSE_ROUTE,
  CATALOG_FILTER_REF_TYPES,
  CATALOG_ITEM_ROUTE,
  browseCatalog,
  compareRecords,
  matchesQuery,
  parseCatalogBrowseQuery,
  readCatalogItem,
  refFingerprint,
  type CatalogReader,
  type CatalogRecordSummary,
} from '../src/ops/operator-ui-catalog-browse.js';
import {
  CATALOG_IMPORT_BOUNDS,
  CATALOG_IMPORT_COMMANDS,
  CATALOG_SNAPSHOT_EXAMPLE,
  catalogImportFieldTable,
  catalogImportSteps,
} from '../src/ops/operator-ui-catalog-import-guide.js';
import { parseCatalogSnapshot } from '../src/core/catalog/import-snapshot.js';
import { applyCatalogImport, createExistingStateLookup, planCatalogImport } from '../src/ops/catalog-import.js';
import { migrateWith } from '../src/db/pool.js';
import { startEmbedded } from './embedded-pg.js';
import { installCompletionSecret } from './crypto-setup.js';
import { Client } from 'pg';
import type { ItemIdentity } from '../src/core/catalog/authority.js';
import {
  createOperatorUiServiceServer,
  validateOperatorUiServiceConfig,
} from '../src/ops/operator-ui-service.js';
import {
  OPERATOR_UI_LOCAL_AUTH_HEADER,
  loadOperatorUiLocalAuthRuntime,
} from '../src/ops/operator-ui-local-auth-runtime.js';

// Phase 260 — the authenticated, read-only catalog browser.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - Every catalog route requires the operator token, and answers 401 without it.
//   - It is a READ. No route mutates anything, and nothing a browser sends reaches SQL as syntax.
//   - Paging is bounded, and the order is TOTAL — so paging cannot show a record twice or skip one.
//   - An empty catalog is a healthy 200 with guidance, not an error.
//   - Provider ref VALUES never leave the process. Type and fingerprint only.
//   - A forgotten item is indistinguishable from one that never existed.
//   - A hostile title is data. The page never parses a response value as markup.
//
// The routing, auth and header assertions run against a REAL http.Server on a real port, because "this route
// requires a token" is a claim about a server. The paging, ordering and filtering logic runs against an
// in-memory reader so the adversarial cases are exhaustive rather than expensive; Phase 259's suite already
// proves the same records survive a real PostgreSQL round trip.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

const WORK = mkdtempSync(join(tmpdir(), 'ca-catalog-browse-'));

// --- an in-memory catalog -------------------------------------------------------------------------------

interface FakeRecord { itemId: string; identity: ItemIdentity }

function fakeReader(records: readonly FakeRecord[]): CatalogReader & { reads: string[]; queries: number } {
  const sorted = [...records].sort((a, b) => a.itemId.localeCompare(b.itemId, 'en'));
  const state = {
    reads: [] as string[],
    queries: 0,
    countActive: () => Promise.resolve(sorted.length),
    listActiveIds: (limit: number, offset: number) => {
      state.queries += 1;
      return Promise.resolve(sorted.slice(offset, offset + limit).map((r) => r.itemId));
    },
    readIdentity: (itemId: string) => {
      state.reads.push(itemId);
      const found = sorted.find((r) => r.itemId === itemId);
      return Promise.resolve(found ? found.identity : null);
    },
  };
  return state;
}

/** Item ids are uuids; these are deterministic so ordering assertions are stable. */
function idFor(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-5000-8000-${hex}`;
}

function record(n: number, identity: Partial<ItemIdentity> & { title: string }): FakeRecord {
  return {
    itemId: idFor(n),
    identity: { year: null, externalIds: { 'my-library': `ext-${n}` }, metadata: null, ...identity },
  };
}

const CATALOG: FakeRecord[] = [
  record(1, { title: 'Alpha', year: 1994, providerRefs: [{ type: 'imdb', value: 'tt0000001' }] }),
  record(2, { title: 'Bravo', year: 2001 }),
  record(3, { title: 'charlie', year: 1994, providerRefs: [{ type: 'tmdb', value: '278' }] }),
  record(4, { title: 'Delta', year: null, metadata: { shelf: 'a1' } }),
  record(5, { title: 'Echo', year: 2020, providerRefs: [{ type: 'imdb', value: 'tt0000005' }] }),
];

const q = (search: string) => parseCatalogBrowseQuery(search);

async function main(): Promise<void> {
  console.log('Phase 260 — authenticated read-only catalog browser\n');

  // --- query parsing -------------------------------------------------------------------------------------

  console.log('the query string is bounded, closed-set, and never rejects a browser');

  await test('an empty query is the deterministic default', () => {
    const { query, ignored } = q('');
    assertEq(query.sort, 'id', 'wrong default sort');
    assertEq(query.order, 'asc', 'wrong default order');
    assertEq(query.page, 1, 'wrong default page');
    assertEq(query.pageSize, CATALOG_BROWSE_DEFAULT_PAGE_SIZE, 'wrong default page size');
    assertEq(query.search, '', 'wrong default search');
    assertEq(ignored.length, 0, 'the default query ignored something');
  });

  await test('a sort field outside the closed set falls back and is reported, never reaching SQL', () => {
    for (const hostile of ['title; DROP TABLE items', 'id--', '(SELECT 1)', 'identity_ct', '']) {
      const { query, ignored } = q(`sort=${encodeURIComponent(hostile)}`);
      assertEq(query.sort, 'id', `a hostile sort was accepted: ${hostile}`);
      assert(ignored.includes('sort'), `the ignored sort was not reported: ${hostile}`);
    }
  });

  await test('an order outside asc/desc falls back', () => {
    const { query, ignored } = q('order=RANDOM()');
    assertEq(query.order, 'asc', 'a hostile order was accepted');
    assert(ignored.includes('order'), 'the ignored order was not reported');
  });

  await test('page and pageSize are clamped, and a non-integer is refused before Number sees it', () => {
    for (const raw of ['0', '-1', '1e999', 'Infinity', '0x10', ' 3 ', 'NaN', '9999999999', String(CATALOG_BROWSE_MAX_PAGE + 1)]) {
      const { query } = q(`page=${encodeURIComponent(raw)}`);
      assertEq(query.page, 1, `page ${raw} was accepted`);
    }
    assertEq(q(`pageSize=${CATALOG_BROWSE_MAX_PAGE_SIZE + 1}`).query.pageSize, CATALOG_BROWSE_DEFAULT_PAGE_SIZE, 'an over-large page size was accepted');
    assertEq(q(`pageSize=${CATALOG_BROWSE_MAX_PAGE_SIZE}`).query.pageSize, CATALOG_BROWSE_MAX_PAGE_SIZE, 'the ceiling page size was rejected');
    assertEq(q(`page=${CATALOG_BROWSE_MAX_PAGE}`).query.page, CATALOG_BROWSE_MAX_PAGE, 'the ceiling page was rejected');
  });

  await test('a refType outside the database\'s own closed set is refused', () => {
    assertEq(q('refType=netflix').query.refType, null, 'an unknown ref type was accepted');
    assert(q('refType=netflix').ignored.includes('refType'), 'the ignored ref type was not reported');
    for (const type of CATALOG_FILTER_REF_TYPES) {
      assertEq(q(`refType=${type}`).query.refType, type, `the known ref type ${type} was refused`);
    }
  });

  await test('a source with a quote, a slash or a space is refused', () => {
    for (const hostile of ["' OR 1=1 --", '../etc', 'My Library', 'x'.repeat(80)]) {
      assertEq(q(`source=${encodeURIComponent(hostile)}`).query.source, null, `a hostile source was accepted: ${hostile}`);
    }
    assertEq(q('source=my-library').query.source, 'my-library', 'a plain source was refused');
  });

  await test('an over-long or control-bearing search term is dropped, not truncated', () => {
    assertEq(q(`q=${'x'.repeat(200)}`).query.search, '', 'an over-long search was accepted');
    assertEq(q(`q=${encodeURIComponent(`a${String.fromCharCode(0)}b`)}`).query.search, '', 'a NUL-bearing search was accepted');
    assertEq(q('q=%20alpha%20').query.search, 'alpha', 'a search was not trimmed');
  });

  await test('an inverted year range is dropped rather than matching nothing', () => {
    const { query, ignored } = q('yearFrom=2020&yearTo=1990');
    assertEq(query.yearFrom, null, 'an inverted range was kept');
    assertEq(query.yearTo, null, 'an inverted range was kept');
    assert(ignored.some((entry) => entry.includes('inverted')), 'the inversion was not reported');
  });

  await test('a repeated parameter takes the first and says so', () => {
    const { query, ignored } = q('page=3&page=99');
    assertEq(query.page, 3, 'the wrong repeated value was taken');
    assert(ignored.some((entry) => entry.includes('repeated')), 'the repetition was not reported');
  });

  await test('a query string of a hundred junk parameters still produces a working first page', () => {
    const junk = Array.from({ length: 100 }, (_, i) => `junk${i}=${i}`).join('&');
    const { query } = q(junk);
    assertEq(query.page, 1, 'a junk query changed the page');
    assertEq(query.sort, 'id', 'a junk query changed the sort');
  });

  // --- ordering ------------------------------------------------------------------------------------------

  console.log('\nthe order is total, so paging cannot double or skip a record');

  const summaryOf = (id: string, title: string, year: number | null): CatalogRecordSummary =>
    ({ itemId: id, title, year, refTypes: [], sources: [] });

  await test('records with identical titles are still totally ordered, by id', () => {
    const a = summaryOf(idFor(1), 'Same', 2000);
    const b = summaryOf(idFor(2), 'Same', 2000);
    assert(compareRecords(a, b, 'title', 'asc') < 0, 'a tie was not broken by id');
    assert(compareRecords(b, a, 'title', 'asc') > 0, 'the tie-break is not antisymmetric');
    assertEq(compareRecords(a, a, 'title', 'asc'), 0, 'a record does not equal itself');
  });

  await test('a record with no year sorts last in BOTH directions', () => {
    const dated = summaryOf(idFor(1), 'A', 1994);
    const undated = summaryOf(idFor(2), 'B', null);
    assert(compareRecords(dated, undated, 'year', 'asc') < 0, 'undated did not sort last ascending');
    assert(compareRecords(dated, undated, 'year', 'desc') < 0, 'undated did not sort last descending');
  });

  await test('sorting the whole catalog is stable across repeated sorts', () => {
    const summaries = CATALOG.map((r) => summaryOf(r.itemId, r.identity.title as string, r.identity.year ?? null));
    const once = [...summaries].sort((a, b) => compareRecords(a, b, 'title', 'asc')).map((s) => s.itemId);
    const twice = [...summaries].sort((a, b) => compareRecords(a, b, 'title', 'asc')).map((s) => s.itemId);
    assertEq(once.join(','), twice.join(','), 'the sort is not deterministic');
  });

  // --- filtering -----------------------------------------------------------------------------------------

  console.log('\nfilters are grounded in fields that actually exist');

  await test('search matches the title case-insensitively', () => {
    const summary: CatalogRecordSummary = { itemId: idFor(1), title: 'The Shawshank', year: 1994, refTypes: [], sources: [] };
    assert(matchesQuery(summary, {}, q('q=shawshank').query), 'a lower-case search did not match');
    assert(matchesQuery(summary, {}, q('q=SHAW').query), 'an upper-case search did not match');
    assert(!matchesQuery(summary, {}, q('q=zzz').query), 'an unrelated search matched');
  });

  await test('search also matches the operator\'s own record id', () => {
    const summary: CatalogRecordSummary = { itemId: idFor(1), title: 'Anything', year: null, refTypes: [], sources: ['my-library'] };
    assert(matchesQuery(summary, { 'my-library': 'movie-0042' }, q('q=0042').query), 'an external id search did not match');
  });

  await test('refType, source and year filters each exclude', () => {
    const summary: CatalogRecordSummary = { itemId: idFor(1), title: 'A', year: 1994, refTypes: ['imdb'], sources: ['my-library'] };
    assert(matchesQuery(summary, {}, q('refType=imdb').query), 'a matching ref type excluded');
    assert(!matchesQuery(summary, {}, q('refType=tmdb').query), 'a non-matching ref type included');
    assert(matchesQuery(summary, {}, q('source=my-library').query), 'a matching source excluded');
    assert(!matchesQuery(summary, {}, q('source=other').query), 'a non-matching source included');
    assert(matchesQuery(summary, {}, q('yearFrom=1990&yearTo=2000').query), 'a matching year excluded');
    assert(!matchesQuery(summary, {}, q('yearFrom=2000').query), 'a year below the floor included');
    assert(!matchesQuery(summary, {}, q('yearTo=1990').query), 'a year above the ceiling included');
  });

  await test('a year filter excludes records with no year at all', () => {
    const undated: CatalogRecordSummary = { itemId: idFor(1), title: 'A', year: null, refTypes: [], sources: [] };
    assert(!matchesQuery(undated, {}, q('yearFrom=1900').query), 'an undated record passed a year floor');
  });

  // --- paging --------------------------------------------------------------------------------------------

  console.log('\npaging is bounded, exact when it can be, and honest when it cannot');

  await test('an empty catalog is a healthy 200 with guidance, not an error', async () => {
    const result = await browseCatalog(fakeReader([]), q(''));
    assert(result.ok, 'an empty catalog reported not-ok');
    assertEq(result.state, 'EMPTY', 'wrong state');
    assertEq(result.total, 0, 'wrong total');
    assertEq(result.items.length, 0, 'an empty catalog returned records');
    assert(result.guidance.includes('healthy'), 'the guidance does not say an empty catalog is fine');
    assert(result.guidance.toLowerCase().includes('import'), 'the guidance does not point at the import');
  });

  await test('the unfiltered id-sorted path decrypts only the requested page', async () => {
    const reader = fakeReader(CATALOG);
    const result = await browseCatalog(reader, q('pageSize=2'));
    assertEq(result.items.length, 2, 'wrong page size');
    assertEq(reader.reads.length, 2, `the cheap path decrypted ${reader.reads.length} records for a 2-record page`);
    assertEq(result.total, 5, 'wrong total');
    assertEq(result.pageCount, 3, 'wrong page count');
    assertEq(result.truncated, false, 'the exact path reported truncation');
  });

  await test('paging forward covers every record exactly once, with no repeats', async () => {
    const reader = fakeReader(CATALOG);
    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const result = await browseCatalog(reader, q(`pageSize=2&page=${page}`));
      for (const item of result.items) seen.push(item.itemId);
    }
    assertEq(seen.length, 5, 'paging lost or duplicated records');
    assertEq(new Set(seen).size, 5, 'a record appeared on two pages');
  });

  await test('descending id paging is the exact reverse of ascending', async () => {
    const reader = fakeReader(CATALOG);
    const asc: string[] = [];
    const desc: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      for (const item of (await browseCatalog(reader, q(`pageSize=2&page=${page}`))).items) asc.push(item.itemId);
      for (const item of (await browseCatalog(reader, q(`pageSize=2&page=${page}&order=desc`))).items) desc.push(item.itemId);
    }
    assertEq(desc.join(','), [...asc].reverse().join(','), 'descending paging is not the reverse of ascending');
  });

  await test('a page past the end is empty, not an error and not the first page again', async () => {
    const result = await browseCatalog(fakeReader(CATALOG), q('pageSize=2&page=50'));
    assert(result.ok, 'a page past the end reported not-ok');
    assertEq(result.items.length, 0, 'a page past the end returned records');
    assertEq(result.state, 'NO_MATCH', 'wrong state past the end');
    assertEq(result.total, 5, 'the total was lost');
  });

  await test('a search that matches nothing is NO_MATCH with guidance, not EMPTY', async () => {
    const result = await browseCatalog(fakeReader(CATALOG), q('q=nothing-matches-this'));
    assertEq(result.state, 'NO_MATCH', 'wrong state');
    assertEq(result.total, 5, 'the total should still describe the catalog');
    assertEq(result.matched, 0, 'wrong matched count');
    assert(result.guidance.toLowerCase().includes('clear'), 'the guidance does not say how to recover');
  });

  await test('a search reports its result set, sorted deterministically', async () => {
    const result = await browseCatalog(fakeReader(CATALOG), q('sort=title&order=asc'));
    assertEq(result.items.map((i) => i.title).join(','), 'Alpha,Bravo,charlie,Delta,Echo', 'title sort is wrong or case-sensitive');
  });

  await test('a scan larger than the bound reports truncated, and says how far it looked', async () => {
    const many = Array.from({ length: CATALOG_BROWSE_MAX_SCAN + 25 }, (_, i) => record(i + 1, { title: `Item ${i}` }));
    const result = await browseCatalog(fakeReader(many), q('q=Item'));
    assert(result.truncated, 'a scan past the bound did not report truncation');
    assertEq(result.scanned, CATALOG_BROWSE_MAX_SCAN, 'the scan was not bounded');
    assertEq(result.total, CATALOG_BROWSE_MAX_SCAN + 25, 'the total should still be the whole catalog');
    assert(result.guidance.includes(String(CATALOG_BROWSE_MAX_SCAN)), 'the guidance does not name the bound');
  });

  await test('a record whose identity fails closed mid-page is dropped, not faked', async () => {
    const reader = fakeReader(CATALOG);
    const failing = { ...reader, readIdentity: (id: string) => (id === idFor(2) ? Promise.resolve(null) : reader.readIdentity(id)) };
    const result = await browseCatalog(failing, q('pageSize=10'));
    assertEq(result.items.length, 4, 'a fail-closed record was not dropped');
    assert(!result.items.some((i) => i.itemId === idFor(2)), 'the fail-closed record is still in the page');
  });

  await test('a read that throws does not fail the whole page', async () => {
    const reader = fakeReader(CATALOG);
    const throwing = { ...reader, readIdentity: (id: string) => (id === idFor(3) ? Promise.reject(new Error('custodian unreachable')) : reader.readIdentity(id)) };
    const result = await browseCatalog(throwing, q('pageSize=10'));
    assertEq(result.items.length, 4, 'a throwing read broke the page');
  });

  // --- what a response may contain ------------------------------------------------------------------------

  console.log('\nno provider ref value ever leaves the process');

  await test('a list response carries ref TYPES and no values', async () => {
    const result = await browseCatalog(fakeReader(CATALOG), q('pageSize=10'));
    const text = JSON.stringify(result);
    assert(!text.includes('tt0000001') && !text.includes('tt0000005') && !text.includes('278'),
      'a provider ref value reached a list response');
    assert(result.items.some((i) => i.refTypes.includes('imdb')), 'the ref type was not reported');
  });

  await test('a detail response carries a fingerprint and no value', async () => {
    const lookup = await readCatalogItem(fakeReader(CATALOG), idFor(1));
    assert(lookup.found, 'a present record was not found');
    const text = JSON.stringify(lookup);
    assert(!text.includes('tt0000001'), 'a provider ref value reached a detail response');
    assertEq(lookup.found ? lookup.item.providerRefs[0]!.type : '', 'imdb', 'the ref type was lost');
    assertEq(lookup.found ? lookup.item.providerRefs[0]!.fingerprint.length : 0, 12, 'wrong fingerprint length');
  });

  await test('the fingerprint is stable, scoped to the type, and not the value', () => {
    assertEq(refFingerprint('imdb', 'tt1'), refFingerprint('imdb', 'tt1'), 'the fingerprint is not stable');
    assert(refFingerprint('imdb', 'tt1') !== refFingerprint('tmdb', 'tt1'), 'the fingerprint ignores the type');
    assert(refFingerprint('imdb', 'tt1') !== refFingerprint('imdb', 'tt2'), 'two values share a fingerprint');
    assert(!refFingerprint('imdb', 'tt1').includes('tt1'), 'the fingerprint contains the value');
  });

  await test('a detail response shows the operator their own id and metadata', async () => {
    const lookup = await readCatalogItem(fakeReader(CATALOG), idFor(4));
    assert(lookup.found, 'the record was not found');
    assertEq(lookup.found ? lookup.item.externalIds['my-library'] : '', 'ext-4', 'the external id was lost');
    assertEq(lookup.found ? lookup.item.metadata.shelf : '', 'a1', 'the metadata was lost');
  });

  await test('a non-string or over-long metadata value is dropped rather than shipped', async () => {
    const odd = fakeReader([{
      itemId: idFor(9),
      identity: {
        title: 'Odd', year: null,
        metadata: { good: 'ok', nested: { a: 1 } as never, huge: 'x'.repeat(5000) } as Record<string, unknown>,
        externalIds: null,
      },
    }]);
    const lookup = await readCatalogItem(odd, idFor(9));
    assert(lookup.found, 'the record was not found');
    const metadata = lookup.found ? lookup.item.metadata : {};
    assertEq(metadata.good, 'ok', 'a good metadata value was dropped');
    assert(!('nested' in metadata), 'a nested metadata value was shipped');
    assert(!('huge' in metadata), 'an over-long metadata value was shipped');
  });

  await test('a hostile title is carried as data, exactly as stored', async () => {
    const hostile = '<script>alert(1)</script>';
    const reader = fakeReader([{ itemId: idFor(7), identity: { title: hostile, year: null, externalIds: null, metadata: null } }]);
    const result = await browseCatalog(reader, q(''));
    assertEq(result.items[0]!.title, hostile, 'the title was rewritten');
    // The response is JSON. The page writes it with textContent, asserted below against the shipped script.
    assert(JSON.stringify(result).includes('\\u003cscript') || JSON.stringify(result).includes('<script>'),
      'the title did not survive serialisation as data');
  });

  await test('a forgotten record and one that never existed are the same answer', async () => {
    const reader = fakeReader(CATALOG);
    const missing = await readCatalogItem(reader, '11111111-1111-5111-8111-111111111111');
    assert(!missing.found && missing.reason === 'NOT_FOUND', 'an absent record gave the wrong answer');
    const forgotten = { ...reader, readIdentity: () => Promise.resolve(null) };
    const shredded = await readCatalogItem(forgotten, idFor(1));
    assert(!shredded.found && shredded.reason === 'NOT_FOUND', 'a forgotten record gave a different answer');
  });

  await test('an id that is not a uuid is refused before any read happens', async () => {
    const reader = fakeReader(CATALOG);
    for (const hostile of ["' OR 1=1 --", '../../etc/passwd', '', 'not-a-uuid', '00000000-0000-5000-8000-00000000000']) {
      const lookup = await readCatalogItem(reader, hostile);
      assert(!lookup.found && lookup.reason === 'INVALID_ID', `a hostile id was accepted: ${hostile}`);
    }
    assertEq(reader.reads.length, 0, 'a hostile id reached a read');
  });

  // --- the shipped page -----------------------------------------------------------------------------------

  console.log('\nthe page renders catalog values as text and nothing else');

  const appJs = readFileSync(fileURLToPath(new URL('../src/ops/operator-ui-app.js', import.meta.url)), 'utf8');
  const service = readFileSync(fileURLToPath(new URL('../src/ops/operator-ui-service.ts', import.meta.url)), 'utf8');

  await test('the catalog renderers write only textContent, never markup', () => {
    const catalogCode = appJs.slice(appJs.indexOf('function catalogQuery'), appJs.indexOf('async function refresh'));
    assert(catalogCode.length > 500, 'the catalog code was not found');
    assert(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(catalogCode),
      'the catalog code writes markup');
    assert(catalogCode.includes('textContent'), 'the catalog code does not use textContent');
  });

  await test('the catalog query is assembled with URLSearchParams, so a search term cannot inject a parameter', () => {
    assert(appJs.includes('new URLSearchParams()'), 'the query is not built with URLSearchParams');
    assert(appJs.includes("encodeURIComponent(itemId)"), 'the record id is not encoded into the detail URL');
  });

  await test('the page does not store the token or the catalog anywhere persistent', () => {
    assert(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(appJs), 'the page uses browser storage');
  });

  await test('the shell offers only filters the database actually enforces', () => {
    for (const type of CATALOG_FILTER_REF_TYPES) {
      assert(service.includes(`value="\${escapeHtml(type)}"`) || service.includes(type), `the ${type} filter option is missing`);
    }
    assert(service.includes('id="catalog-panel"'), 'the catalog panel is missing');
    assert(service.includes('href="#catalog-panel"'), 'the catalog nav link is missing');
    assert(service.includes('href="#import-panel"'), 'the import nav link is missing');
  });

  await test('Setup & Diagnostics points at the import instructions, which point at the browser', () => {
    assert(/Import a catalog/.test(service), 'the import panel is not named');
    assert(service.includes('#import-panel'), 'nothing links to the import instructions');
    const steps = catalogImportSteps();
    assertEq(steps[steps.length - 1]!.id, 'browse', 'the import instructions do not end at browsing');
    assert(steps[steps.length - 1]!.detail.includes('Catalog panel'), 'the last step does not name the panel');
  });

  await test('the import guide documents a snapshot the importer would actually accept', () => {
    const parsed = parseCatalogSnapshot(CATALOG_SNAPSHOT_EXAMPLE);
    assertEq(parsed.items.length, 2, 'the worked example is not the document it claims to be');
    assert(CATALOG_IMPORT_BOUNDS.includes('8 MiB'), 'the bounds note does not state the byte limit');
    assert(catalogImportFieldTable().some((row) => row.field === 'items[].title' && row.required), 'the field table is wrong');
    assert(CATALOG_IMPORT_COMMANDS.every((pair) => pair.command.startsWith('docker compose exec app npm run ops:catalog-import')),
      'the documented commands are not the shipped command');
    assert(CATALOG_IMPORT_COMMANDS.some((pair) => !pair.command.includes('--apply')), 'no preview command is documented');
    assert(CATALOG_IMPORT_COMMANDS.some((pair) => pair.command.includes('--apply')), 'no apply command is documented');
  });

  // --- the shipped script, actually executed against a DOM --------------------------------------------------

  console.log('\nthe shipped script, run for real: a hostile title becomes text, never markup');

  // A DOM small enough to be honest about what it is, and complete enough to run the real file. Every element
  // records what was written to it, and `innerHTML` THROWS on any non-empty assignment — so if the script ever
  // stopped using textContent, this harness fails rather than quietly proving nothing.
  interface FakeNode {
    tagName: string;
    textContent: string;
    className: string;
    value: string;
    type: string;
    children: FakeNode[];
    attributes: Record<string, string>;
    listeners: Record<string, Array<(event: unknown) => unknown>>;
    appendChild(child: FakeNode): void;
    replaceChildren(): void;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    addEventListener(name: string, fn: (event: unknown) => unknown): void;
  }

  function makeNode(tagName: string): FakeNode {
    const node: FakeNode = {
      tagName,
      textContent: '',
      className: '',
      value: '',
      type: '',
      children: [],
      attributes: {},
      listeners: {},
      appendChild(child) { node.children.push(child); },
      replaceChildren() { node.children.length = 0; },
      setAttribute(name, value) { node.attributes[name] = value; },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name]! : null; },
      addEventListener(name, fn) { (node.listeners[name] ??= []).push(fn); },
    };
    Object.defineProperty(node, 'innerHTML', {
      set(value: string) { if (value !== '') throw new Error(`the page assigned markup to innerHTML: ${value.slice(0, 60)}`); },
      get() { return ''; },
    });
    return node;
  }

  await test('the shipped app.js renders a hostile catalog title as TEXT, and never as markup', async () => {
    const nodes = new Map<string, FakeNode>();
    const getById = (id: string): FakeNode => {
      let node = nodes.get(id);
      if (node === undefined) { node = makeNode('div'); nodes.set(id, node); }
      return node;
    };
    const requests: string[] = [];
    const hostileTitle = '<img src=x onerror=alert(1)>';
    const itemId = idFor(1);
    const fakeFetch = (path: string, init: { headers: Record<string, string> }): Promise<unknown> => {
      requests.push(path);
      assertEq(init.headers['x-operator-ui-secret'], 'the-token', `${path} was requested without the token`);
      const body = path.startsWith('/api/catalog/item')
        ? { ok: true, item: { itemId, title: hostileTitle, year: 1994, refTypes: ['imdb'], sources: ['my-library'], externalIds: { 'my-library': 'ext-1' }, metadata: { shelf: '</dd><script>x</script>' }, providerRefs: [{ type: 'imdb', fingerprint: 'abc123def456' }] } }
        : path.startsWith('/api/catalog')
          ? { ok: true, state: 'RESULTS', total: 1, matched: 1, page: 1, pageSize: 25, pageCount: 1, truncated: false, scanLimit: 1000, items: [{ itemId, title: hostileTitle, year: 1994, refTypes: ['imdb'], sources: ['my-library'] }], ignored: [], guidance: '1 of 1 record matched.' }
          : { ok: true, entries: [], checks: [], doctor: { ok: true, checks: [] }, doctorSummary: {}, needsAttention: [] };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    };
    const context = {
      document: {
        getElementById: getById,
        createElement: (tag: string) => makeNode(tag),
      },
      fetch: fakeFetch,
      URLSearchParams,
      Promise,
      Object,
      String,
      console,
      navigator: {},
    };
    const source = readFileSync(fileURLToPath(new URL('../src/ops/operator-ui-app.js', import.meta.url)), 'utf8');
    createContext(context);
    new Script(source, { filename: 'operator-ui-app.js' }).runInContext(context);

    getById('token').value = 'the-token';
    // The Search button, not Load everything: this exercises exactly the catalog path, rather than requiring
    // this harness to also stand in for the installation, status, chain and support-report payloads.
    const searchHandlers = getById('catApply').listeners.click ?? [];
    assertEq(searchHandlers.length, 1, 'the catalog Search button has no handler');
    await searchHandlers[0]!({});
    // Give the awaited chain inside the handler a turn to settle.
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    assert(requests.some((path) => path.startsWith('/api/catalog?')), `the catalog was never requested: ${requests.join(', ')}`);
    const results = getById('catResults');
    assertEq(results.children.length, 1, `the catalog list has ${results.children.length} rows`);
    const row = results.children[0]!.children[0]!;
    assertEq(row.tagName, 'button', 'a catalog row is not a button');
    assert(row.textContent.includes(hostileTitle), `the hostile title was not rendered as text: ${row.textContent}`);
    assertEq(row.getAttribute('data-item-id'), itemId, 'the row does not carry the record id');

    // Clicking the row loads the detail, through the delegated listener the page installed.
    const rowHandlers = results.listeners.click ?? [];
    assertEq(rowHandlers.length, 1, 'the results list has no delegated handler');
    await rowHandlers[0]!({ target: row });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    assert(requests.some((path) => path === `/api/catalog/item?id=${encodeURIComponent(itemId)}`),
      `the detail request was not made or was not encoded: ${requests.join(', ')}`);
    const detail = getById('catDetail');
    assert(detail.children.length >= 6, `the detail view rendered ${detail.children.length} nodes`);
    const detailText = detail.children.map((node) => node.textContent).join(' | ');
    assert(detailText.includes(hostileTitle), 'the detail view did not render the title');
    assert(detailText.includes('</dd><script>x</script>'), 'the detail view did not render a hostile metadata value as text');
    assert(detailText.includes('abc123def456'), 'the detail view did not show the ref fingerprint');
    assert(!detailText.includes('tt0000001'), 'the detail view showed a ref value');

    // Every assignment above went through textContent: the innerHTML setter on every node throws on any
    // non-empty write, so reaching this line is the proof.
  });

  // --- the real server ------------------------------------------------------------------------------------

  console.log('\nagainst a real server: every catalog route needs the token, and is a read');

  const secretsDir = join(WORK, 'secrets');
  mkdirSync(secretsDir, { recursive: true });
  const tokenFile = join(secretsDir, 'operator_ui_token');
  // A real-shaped token: long enough and varied enough for the runtime's own acceptance rules, and long
  // enough that the service's log redaction would catch it if it ever reached a log line.
  const TOKEN = 'phase260-operator-token-abcdefghij';
  writeFileSync(tokenFile, `${TOKEN}\n`);
  const recordsDir = join(WORK, 'records');
  mkdirSync(recordsDir, { recursive: true });

  const config = validateOperatorUiServiceConfig({
    host: '127.0.0.1', port: 8099, operatorSecretFile: tokenFile, promotionRecordsDir: recordsDir,
  });
  const server: Server = createOperatorUiServiceServer(config, loadOperatorUiLocalAuthRuntime(tokenFile));
  const port = await freePort();
  await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', resolve); });

  const call = (path: string, options: { token?: string; method?: string } = {}): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (options.token !== undefined) headers[OPERATOR_UI_LOCAL_AUTH_HEADER] = options.token;
      const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });

  for (const [label, path] of [
    ['the catalog list', `${CATALOG_BROWSE_ROUTE}?q=alpha`],
    ['a catalog record', `${CATALOG_ITEM_ROUTE}?id=${idFor(1)}`],
  ] as Array<[string, string]>) {
    await test(`${label} answers 401 with no token`, async () => {
      const res = await call(path);
      assertEq(res.status, 401, 'an unauthenticated request was not refused');
      assert(res.body.includes('OPERATOR_UI_SERVICE_UNAUTHORIZED'), 'the refusal has the wrong code');
      assert(!res.body.includes('title'), 'the refusal body leaked catalog shape');
    });

    await test(`${label} answers 401 with the wrong token`, async () => {
      // Same LENGTH as the real one, so this exercises the constant-time comparison rather than the cheap
      // length check that precedes it.
      const wrong = `phase260-operator-token-ABCDEFGHIJ`;
      assertEq(wrong.length, TOKEN.length, 'the wrong token is not the same length as the real one');
      assertEq((await call(path, { token: wrong })).status, 401, 'a wrong token was accepted');
      assertEq((await call(path, { token: 'short' })).status, 401, 'a short token was accepted');
    });

    await test(`${label} refuses every method except GET`, async () => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await call(path, { token: TOKEN, method });
        assertEq(res.status, 405, `${method} was not refused`);
        assertEq(res.headers.allow, 'GET', `${method} was not told what is allowed`);
      }
      // HEAD is a known route with no body — 405 like the others, and never a leak.
      const head = await call(path, { token: TOKEN, method: 'HEAD' });
      assertEq(head.status, 405, 'HEAD was not refused');
      assertEq(head.body, '', 'HEAD returned a body');
    });

    await test(`${label} carries the same hardened headers as every other route`, async () => {
      const res = await call(path, { token: TOKEN });
      assertEq(res.headers['x-content-type-options'], 'nosniff', 'missing nosniff');
      assertEq(res.headers['cache-control'], 'no-store', 'missing no-store');
      assertEq(res.headers['x-frame-options'], 'DENY', 'missing frame denial');
      assert(String(res.headers['content-security-policy'] ?? '').includes("default-src 'none'"), 'missing CSP');
      assert(String(res.headers['content-type'] ?? '').includes('application/json'), 'wrong content type');
    });

    await test(`${label} fails closed, not open, when there is no database`, async () => {
      // No DATABASE_URL is configured in this process, so the route must answer 503 with a fixed code and
      // nothing about the configuration — never 200 with an empty catalog, which would read as "you have no
      // records" when the truth is "nothing was asked".
      const res = await call(path, { token: TOKEN });
      assertEq(res.status, 503, `a route with no database answered ${res.status}`);
      const body = JSON.parse(res.body) as { ok: boolean; code: string; message: string };
      assertEq(body.ok, false, 'an unreachable catalog reported ok');
      assertEq(body.code, 'OPERATOR_UI_CATALOG_UNAVAILABLE', 'wrong code');
      assert(!/postgres|password|DATABASE_URL|\/run\/secrets/i.test(res.body), 'the failure leaked configuration');
    });
  }

  await test('an unsafe request target never reaches the catalog routes', async () => {
    for (const path of ['/api/catalog/../logs', '/api/catalog%2f..%2flogs', '//api/catalog']) {
      const res = await call(path, { token: TOKEN });
      assertEq(res.status, 404, `an unsafe target was routed: ${path}`);
    }
  });

  await test('the token is never echoed into a response or a log entry', async () => {
    await call(`${CATALOG_BROWSE_ROUTE}?q=${TOKEN}`, { token: TOKEN });
    const logs = await call('/api/logs', { token: TOKEN });
    assert(!logs.body.includes(TOKEN), 'the operator token reached the log buffer');
    assert(logs.body.includes('CATALOG_UNAVAILABLE') || logs.body.includes('CATALOG_READ'), 'the catalog request was not logged at all');
  });

  await test('a catalog log line carries a verdict and no catalog content', async () => {
    const logs = JSON.parse((await call('/api/logs', { token: TOKEN })).body) as { entries: Array<{ code: string; message: string }> };
    for (const entry of logs.entries.filter((e) => e.code.startsWith('CATALOG'))) {
      assert(!/alpha|tt00000/i.test(entry.message), `a log line carried catalog content: ${entry.message}`);
    }
  });

  await test('the unauthenticated shell still renders the import instructions', async () => {
    const res = await call('/');
    assertEq(res.status, 200, 'the shell did not render');
    assert(res.body.includes('id="import-panel"'), 'the import instructions need a token to read');
    assert(res.body.includes('id="catalog-panel"'), 'the catalog panel is missing from the shell');
    assert(!res.body.includes(TOKEN), 'the shell leaked the token');
  });

  await test('the shell escapes every string it renders server-side', async () => {
    const res = await call('/');
    // The import guide is the only catalog content rendered into HTML, and it is static — but the escaper is
    // what makes that safe to keep true, so the page must contain no unescaped angle bracket from it.
    const panel = res.body.slice(res.body.indexOf('id="import-panel"'), res.body.indexOf('</section>', res.body.indexOf('id="import-panel"')));
    assert(!panel.includes('<script'), 'the import panel contains a script tag');
    assert(panel.includes('&quot;') || panel.includes('&amp;'), 'the import panel does not look escaped at all');
  });

  await new Promise<void>((resolve) => { server.close(() => resolve()); });

  // --- end to end: import a snapshot, then browse it over HTTP ---------------------------------------------

  console.log('\nend to end: what Phase 259 imported is what Phase 260 serves');

  let pg: Awaited<ReturnType<typeof startEmbedded>> | undefined;
  if (process.env.DATABASE_URL === undefined) {
    try { pg = await startEmbedded(); }
    catch (err) { console.log(`  SKIP  the end-to-end section: an embedded PostgreSQL could not be started: ${(err as Error).message}`); }
  }

  if (process.env.DATABASE_URL !== undefined) {
    await migrateWith(process.env.ADMIN_DATABASE_URL!);
    const admin = new Client({ connectionString: process.env.ADMIN_DATABASE_URL! });
    await admin.connect();
    const completionSecret = await installCompletionSecret(admin);
    const keystore = join(WORK, 'keystore');
    mkdirSync(keystore, { recursive: true });
    // The service builds its own authority from environment configuration, so the custodian this test uses to
    // IMPORT has to be the one the service will later construct: same mode, same keystore, same KEK file.
    const kekFile = join(WORK, 'kek');
    const kek = Buffer.alloc(32, 11);
    writeFileSync(kekFile, kek.toString('base64'));
    process.env.CUSTODIAN_MODE = 'file';
    process.env.CUSTODIAN_KEYSTORE_DIR = keystore;
    process.env.CUSTODIAN_KEK = kek.toString('base64');
    process.env.COMPLETION_SECRET = completionSecret;

    const { getPool, closePool } = await import('../src/db/pool.js');
    const { CatalogAuthority } = await import('../src/core/catalog/authority.js');
    const { createCustodian, loadCustodianConfig } = await import('../src/core/crypto/custodian-factory.js');
    const authority = new CatalogAuthority(getPool(), createCustodian(loadCustodianConfig()));

    const snapshot = parseCatalogSnapshot(JSON.stringify({
      format: 'catalog-authority.snapshot',
      version: 1,
      source: 'e2e-library',
      items: [
        { externalId: 'e2e-1', title: 'A Hostile <script>alert(1)</script> Title', year: 1994, providerRefs: [{ type: 'imdb', value: 'tt-e2e-secret' }] },
        { externalId: 'e2e-2', title: 'Second Record', year: 2001, metadata: { shelf: 'b2' } },
        { externalId: 'e2e-3', title: 'Third Record' },
      ],
    }));
    const plan = await planCatalogImport(snapshot, createExistingStateLookup(getPool()));
    const applied = await applyCatalogImport(snapshot, plan, authority);
    const livePort = await freePort();
    const liveServer = createOperatorUiServiceServer(config, loadOperatorUiLocalAuthRuntime(tokenFile));
    await new Promise<void>((resolve) => { liveServer.listen(livePort, '127.0.0.1', resolve); });
    const liveCall = (path: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: livePort, path, headers: { [OPERATOR_UI_LOCAL_AUTH_HEADER]: TOKEN } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });

    await test('the import landed, and the browse endpoint serves exactly those records', async () => {
      assertEq(applied.created, 3, `the import did not create three records: ${JSON.stringify(applied.items)}`);
      const res = await liveCall(CATALOG_BROWSE_ROUTE);
      assertEq(res.status, 200, `the catalog endpoint answered ${res.status}: ${res.body}`);
      const body = JSON.parse(res.body) as { total: number; state: string; items: Array<{ title: string; itemId: string }> };
      assertEq(body.total, 3, 'the catalog does not hold the imported records');
      assertEq(body.state, 'RESULTS', 'wrong state for a populated catalog');
      assertEq(body.items.length, 3, 'the page did not carry every record');
    });

    await test('a search over a real, encrypted catalog finds the record', async () => {
      const body = JSON.parse((await liveCall(`${CATALOG_BROWSE_ROUTE}?q=second`)).body) as { matched: number; items: Array<{ title: string }> };
      assertEq(body.matched, 1, 'the search did not find exactly one record');
      assertEq(body.items[0]!.title, 'Second Record', 'the search found the wrong record');
    });

    await test('a year filter and a title sort work over the real catalog', async () => {
      const filtered = JSON.parse((await liveCall(`${CATALOG_BROWSE_ROUTE}?yearFrom=2000`)).body) as { matched: number };
      assertEq(filtered.matched, 1, 'the year filter matched the wrong number of records');
      const sorted = JSON.parse((await liveCall(`${CATALOG_BROWSE_ROUTE}?sort=title&order=desc`)).body) as { items: Array<{ title: string }> };
      assertEq(sorted.items[0]!.title, 'Third Record', 'the descending title sort is wrong');
    });

    await test('the hostile title is served as JSON data, and the provider ref value is not served at all', async () => {
      const res = await liveCall(CATALOG_BROWSE_ROUTE);
      assert(!res.body.includes('tt-e2e-secret'), 'a provider ref value reached the wire');
      const body = JSON.parse(res.body) as { items: Array<{ title: string }> };
      assert(body.items.some((i) => i.title.includes('<script>alert(1)</script>')), 'the hostile title was mangled');
      // Content-type is JSON, so a browser never parses this as a document; the page writes it with
      // textContent, which is asserted against the shipped script above.
      assert(res.body.startsWith('{'), 'the catalog response is not a JSON document');
    });

    await test('the detail route serves one real record, with a fingerprint instead of the ref value', async () => {
      const list = JSON.parse((await liveCall(`${CATALOG_BROWSE_ROUTE}?q=hostile`)).body) as { items: Array<{ itemId: string }> };
      const res = await liveCall(`${CATALOG_ITEM_ROUTE}?id=${list.items[0]!.itemId}`);
      assertEq(res.status, 200, `the detail route answered ${res.status}`);
      const body = JSON.parse(res.body) as { item: { externalIds: Record<string, string>; providerRefs: Array<{ type: string; fingerprint: string }> } };
      assertEq(body.item.externalIds['e2e-library'], 'e2e-1', 'the operator\'s own id was not shown back to them');
      assertEq(body.item.providerRefs[0]!.type, 'imdb', 'the ref type was lost');
      assert(!res.body.includes('tt-e2e-secret'), 'the detail route disclosed a provider ref value');
    });

    await test('a record that is forgotten stops being browsable, immediately', async () => {
      const list = JSON.parse((await liveCall(`${CATALOG_BROWSE_ROUTE}?q=Third`)).body) as { items: Array<{ itemId: string }> };
      const itemId = list.items[0]!.itemId;
      assertEq(await authority.forget(itemId), 'shred_complete', 'the record was not forgotten');
      const after = JSON.parse((await liveCall(CATALOG_BROWSE_ROUTE)).body) as { total: number };
      assertEq(after.total, 2, 'a forgotten record is still counted');
      const detail = await liveCall(`${CATALOG_ITEM_ROUTE}?id=${itemId}`);
      assertEq(detail.status, 404, 'a forgotten record is still readable');
    });

    await test('browsing wrote nothing: the event log and row count are unchanged by a page load', async () => {
      const before = (await admin.query('SELECT count(*)::int AS n FROM events')).rows[0].n as number;
      for (const path of [CATALOG_BROWSE_ROUTE, `${CATALOG_BROWSE_ROUTE}?q=second`, `${CATALOG_BROWSE_ROUTE}?sort=title`]) {
        assertEq((await liveCall(path)).status, 200, `a browse request failed: ${path}`);
      }
      assertEq((await admin.query('SELECT count(*)::int AS n FROM events')).rows[0].n as number, before,
        'browsing the catalog appended an event');
    });

    await new Promise<void>((resolve) => { liveServer.close(() => resolve()); });
    await admin.end();
    await closePool();
    if (pg !== undefined) await pg.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? String(err)}`);
  rmSync(WORK, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
}

/** A port the OS just told us is free. Deterministic enough, and never collides with a sibling suite. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
