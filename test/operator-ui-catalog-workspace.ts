import { Client } from 'pg';
import { request, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_EXPORT_MAX_ITEMS,
  CATALOG_EXPORT_ROUTE,
  exportCatalog,
  exportFileName,
} from '../src/ops/operator-ui-catalog-export.js';
import type { CatalogReader } from '../src/ops/operator-ui-catalog-browse.js';
import { parseCatalogSnapshot } from '../src/core/catalog/import-snapshot.js';
import type { ItemIdentity } from '../src/core/catalog/authority.js';
import { migrateWith } from '../src/db/pool.js';
import { startEmbedded } from './embedded-pg.js';
import { installCompletionSecret } from './crypto-setup.js';
import {
  OPERATOR_UI_CSP,
  createOperatorUiServiceServer,
  validateOperatorUiServiceConfig,
} from '../src/ops/operator-ui-service.js';
import {
  OPERATOR_UI_LOCAL_AUTH_HEADER,
  loadOperatorUiLocalAuthRuntime,
} from '../src/ops/operator-ui-local-auth-runtime.js';

// Phase 265 — the catalog as a WORKSPACE: search, sort, filter, page, detail, history and export.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - An export is a READ. Nothing about it writes a row, an event or a history entry.
//   - An export never carries a provider reference VALUE. It carries how many it left out.
//   - An export is DETERMINISTIC: the same catalog exported twice is the same bytes, to the byte.
//   - An export is BOUNDED and REFUSES rather than truncating, because a truncated file that still says
//     `"format": "catalog-authority.snapshot"` is a backup that silently is not one.
//   - An export is SANITIZED: what comes out is a document the import would accept, so a value written by
//     some other route cannot smuggle a control sequence into a file somebody opens.
//   - The download's file name comes from a closed grammar, so `Content-Disposition` cannot be steered.
//   - The page keeps its accessibility, its CSP and its habit of never parsing a value as markup.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepo = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8').split('\r\n').join('\n');

const WORK = mkdtempSync(join(tmpdir(), 'ca-catalog-workspace-'));
const TOKEN = 'phase265-operator-token-abcdefghij';
const SECRET_REF = 'tt-phase265-ref-value-must-never-be-exported';

// --- an in-memory catalog, so the export's adversarial cases are exhaustive rather than expensive --------

interface FakeRecord { itemId: string; identity: ItemIdentity }

function idFor(n: number): string {
  return `00000000-0000-5000-8000-${n.toString(16).padStart(12, '0')}`;
}

function fakeReader(records: readonly FakeRecord[]): CatalogReader {
  const sorted = [...records].sort((a, b) => a.itemId.localeCompare(b.itemId, 'en'));
  return {
    countActive: () => Promise.resolve(sorted.length),
    listActiveIds: (limit, offset) => Promise.resolve(sorted.slice(offset, offset + limit).map((r) => r.itemId)),
    readIdentity: (itemId) => Promise.resolve(sorted.find((r) => r.itemId === itemId)?.identity ?? null),
  };
}

function record(n: number, identity: Partial<ItemIdentity> & { title: string }): FakeRecord {
  return {
    itemId: idFor(n),
    identity: { year: null, externalIds: { 'my-library': `ext-${n}` }, metadata: null, ...identity },
  };
}

async function main(): Promise<void> {
  console.log('Running Phase 265 catalog workspace suite:\n');

  // -------------------------------------------------------------------------------------------------------
  // The export
  // -------------------------------------------------------------------------------------------------------

  const CATALOG = [
    record(3, { title: 'Charlie', year: 1994, metadata: { shelf: 'c3', note: 'third' } }),
    record(1, { title: 'Alpha', year: 2001, providerRefs: [{ type: 'imdb', value: SECRET_REF }] }),
    record(2, { title: 'Bravo' }),
  ];

  await test('an export is a snapshot the IMPORT would accept, and re-parses cleanly', async () => {
    const result = await exportCatalog(fakeReader(CATALOG), null);
    assert(result.ok, `the export refused: ${result.ok ? '' : result.message}`);
    const parsed = parseCatalogSnapshot(result.json);
    assertEq(parsed.source, 'my-library', 'the source');
    assertEq(parsed.items.length, 3, 'every record');
    assertEq(result.count, 3, 'the reported count agrees');
    // The operator's own values are shown back to them, unchanged.
    assertEq(parsed.items.find((i) => i.externalId === 'ext-1')!.title, 'Alpha', 'a title survives the round trip');
    assertEq(parsed.items.find((i) => i.externalId === 'ext-3')!.metadata.shelf, 'c3', 'metadata survives');
    assertEq(parsed.items.find((i) => i.externalId === 'ext-2')!.year, null, 'a missing year stays missing');
  });

  await test('an export NEVER carries a provider reference value, and says how many it left out', async () => {
    const result = await exportCatalog(fakeReader(CATALOG), null);
    assert(result.ok, 'the export refused');
    assert(!result.json.includes(SECRET_REF), 'a provider reference VALUE reached the export');
    assert(!result.json.includes('imdb'), 'even the reference type is not in the document');
    assert(!result.json.includes('providerRefs'), 'no reference structure is in the document');
    assertEq(result.sanitized.providerRefsOmitted, 1, 'the omission is counted rather than silent');
    // Nor is the item id: it is derived from the operator's own values, and is not content they wrote.
    assert(!result.json.includes(idFor(1)), 'an item id reached the export');
  });

  await test('an export is DETERMINISTIC, to the byte, whatever order the records are read in', async () => {
    const first = await exportCatalog(fakeReader(CATALOG), null);
    const shuffled = await exportCatalog(fakeReader([...CATALOG].reverse()), null);
    assert(first.ok && shuffled.ok, 'an export refused');
    assertEq(shuffled.json, first.json, 'two exports of the same catalog are not the same bytes');
    // ...and the ordering is the operator's own key, so a diff of two exports is a diff of the catalog.
    const order = [...first.json.matchAll(/"externalId": "([^"]+)"/g)].map((m) => m[1]);
    assertEq(order.join(','), 'ext-1,ext-2,ext-3', 'the export is not ordered by the operator\'s own id');
  });

  await test('an export is SANITIZED: a value the import would refuse never reaches the file', async () => {
    const hostile = [
      record(10, { title: 'A title with a bell \u0007 and an escape \u001b[31m in it' }),
      record(11, { title: 'Fine', metadata: { shelf: 'x\u0000y', 'Bad Key': 'v', ok: 'kept' } }),
      record(12, { title: '   ' }),
      // A LEADING space, which the import's own external-id grammar refuses. An interior space does not:
      // the import accepts one, so exporting it would be correct and this fixture would prove nothing.
      record(13, { title: 'Fine too', externalIds: { 'my-library': ' leading-space' } }),
      record(14, { title: 'Also fine', externalIds: { 'BAD SOURCE': 'ext-14' } }),
    ];
    const result = await exportCatalog(fakeReader(hostile), null);
    assert(result.ok, `the export refused: ${result.ok ? '' : result.message}`);
    // Every control character EXCEPT the newlines the document is formatted with. `JSON.stringify` escapes
    // C0 as `\\uXXXX` text, but it does NOT escape DEL or C1, so a raw one would survive into the file if
    // the export did not drop it — which is exactly what this asserts.
    assert(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(result.json),
      'a control character reached the export');
    const parsed = parseCatalogSnapshot(result.json);
    assertEq(parsed.items.length, 1, 'only the record with nothing wrong with it survived');
    assertEq(parsed.items[0]!.externalId, 'ext-11', 'the wrong record survived');
    assertEq(parsed.items[0]!.metadata.ok, 'kept', 'a good metadata value was dropped');
    assertEq(parsed.items[0]!.metadata.shelf, undefined, 'a metadata value with a control character was exported');
    assertEq(parsed.items[0]!.metadata['Bad Key'], undefined, 'a metadata key the import refuses was exported');
    assert(result.sanitized.recordsSkipped >= 3, 'the skipped records are counted rather than silent');
    assert(result.sanitized.metadataDropped >= 2, 'the dropped metadata is counted rather than silent');
  });

  await test('an EMPTY catalog is a refusal that explains itself, not an empty file', async () => {
    const result = await exportCatalog(fakeReader([]), null);
    assert(!result.ok, 'an empty catalog produced a file');
    assertEq(result.refusal, 'EMPTY', 'refusal');
    assert(/healthy/.test(result.message), 'it says an empty catalog is a healthy state');
  });

  await test('MORE THAN ONE source is a refusal that lists them, because a snapshot describes exactly one', async () => {
    const mixed = [
      record(20, { title: 'From A', externalIds: { 'library-a': 'a-1' } }),
      record(21, { title: 'From B', externalIds: { 'library-b': 'b-1' } }),
    ];
    const ambiguous = await exportCatalog(fakeReader(mixed), null);
    assert(!ambiguous.ok, 'an ambiguous export produced a file');
    assertEq(ambiguous.refusal, 'AMBIGUOUS_SOURCE', 'refusal');
    assertEq(ambiguous.sources.join(','), 'library-a,library-b', 'it lists what is available');

    const chosen = await exportCatalog(fakeReader(mixed), 'library-b');
    assert(chosen.ok, 'naming a source did not resolve it');
    assertEq(chosen.count, 1, 'the chosen source exported the wrong number of records');
    assertEq(parseCatalogSnapshot(chosen.json).source, 'library-b', 'the wrong source was exported');

    const unknown = await exportCatalog(fakeReader(mixed), 'library-z');
    assert(!unknown.ok && unknown.refusal === 'UNKNOWN_SOURCE', 'an unknown source produced a file');
    assertEq(unknown.sources.join(','), 'library-a,library-b', 'it lists what is available');
  });

  await test('a source from a query string cannot steer anything: it is matched, never interpolated', async () => {
    for (const hostile of [
      '../../etc/passwd', 'my-library"; DROP TABLE items; --', 'my-library\r\nX-Evil: 1', '../my-library',
      'my-library\u0000', '<script>', 'MY-LIBRARY',
    ]) {
      const result = await exportCatalog(fakeReader(CATALOG), hostile);
      assert(!result.ok, `"${hostile}" produced a file`);
      assertEq(result.refusal, 'UNKNOWN_SOURCE', `"${hostile}" was not simply not found`);
    }
  });

  await test('a catalog larger than the bound is REFUSED, never truncated', async () => {
    const huge: FakeRecord[] = [];
    for (let i = 0; i < CATALOG_EXPORT_MAX_ITEMS + 1; i += 1) {
      huge.push(record(1000 + i, { title: `Record ${i}`, externalIds: { 'my-library': `big-${i}` } }));
    }
    const result = await exportCatalog(fakeReader(huge), null);
    assert(!result.ok, 'an oversized catalog produced a file');
    assertEq(result.refusal, 'TOO_LARGE', 'refusal');
    assert(/nothing was written|no partial/i.test(result.message), 'it says no partial file was produced');
  });

  await test('the download file name comes from a closed grammar, so the header cannot be steered', () => {
    assertEq(exportFileName('my-library'), 'catalog-export-my-library.json', 'the ordinary case');
    for (const hostile of [
      'a"; filename="evil.sh', 'a\r\nX-Evil: 1', '../../etc/passwd', 'a/b', 'a b', 'A-Library', '',
      'a'.repeat(200),
    ]) {
      const name = exportFileName(hostile);
      assertEq(name, 'catalog-export-catalog.json', `"${hostile}" was not replaced by the constant`);
      assert(/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name), 'the fallback name is not safe either');
    }
  });

  await test('a record that fails closed mid-export drops out rather than being invented into the file', async () => {
    const reader: CatalogReader = {
      countActive: () => Promise.resolve(3),
      listActiveIds: () => Promise.resolve([idFor(1), idFor(2), idFor(3)]),
      readIdentity: (itemId) => itemId === idFor(2)
        ? Promise.reject(new Error('the lineage stopped being active'))
        : Promise.resolve(CATALOG.find((r) => r.itemId === itemId)?.identity ?? null),
    };
    const result = await exportCatalog(reader, null);
    assert(result.ok, 'a single unreadable record failed the whole export');
    assertEq(result.count, 2, 'the unreadable record was not dropped');
    assert(!result.json.includes('ext-2'), 'the unreadable record reached the file');
  });

  // -------------------------------------------------------------------------------------------------------
  // The page
  // -------------------------------------------------------------------------------------------------------

  const html = readRepo('src/ops/operator-ui-service.ts');
  const app = readRepo('src/ops/operator-ui-app.js');

  await test('every new control has a label, an id and a name a screen reader can read', () => {
    for (const id of ['catSource', 'catPageSize', 'impFile']) {
      assert(html.includes(`<label for="${id}"`), `${id} has no label`);
      assert(html.includes(`id="${id}"`), `${id} does not exist`);
    }
    // The live regions the panel reports through, so a change is announced rather than only drawn.
    for (const id of ['impStatus', 'impInbox', 'catExportStatus']) {
      const pattern = new RegExp(`id="${id}"[^>]*aria-live="polite"`);
      assert(pattern.test(html), `${id} is not an announced live region`);
    }
    assert(/role="status"/.test(html), 'the panel reports through status roles');
  });

  await test('the one panel that writes is marked as the one panel that writes', () => {
    assert(html.includes('class="panel wide writes" id="import-panel"'), 'the import panel is not marked');
    assert(/only panel on this page that changes anything/i.test(html), 'and does not say so in words');
    assert(html.includes('id="impApply" type="button" disabled'), 'apply is not disabled until a preview happens');
    // Colour is never the only signal: the words and the disabled state carry it too.
    assert(readRepo('src/ops/operator-ui-app.css').includes('.writes'), 'the marking has no styling');
  });

  await test('the page still parses no value as markup, and still loads no inline script', () => {
    // The ONLY innerHTML write in the shipped script assigns the empty string, exactly as before.
    for (const match of app.matchAll(/innerHTML\s*=\s*([^;]+);/g)) {
      assertEq(match[1]!.trim(), "''", 'a non-empty innerHTML write appeared in the page script');
    }
    assert(!/insertAdjacentHTML|document\.write|outerHTML\s*=/.test(app), 'a markup-writing API appeared');
    assert(!/<script>(?!.*src=)/.test(html.split('buildOperatorUiServiceHtml')[1] ?? ''), 'an inline script appeared');
    // The POLICY ITSELF, not the file that mentions it: the module's comments explain at length why there is
    // no `'unsafe-inline'` anywhere, and a substring search over the source would read those explanations as
    // the thing they are explaining.
    assert(OPERATOR_UI_CSP.includes("script-src 'self'"), 'the CSP no longer pins scripts to this origin');
    assert(OPERATOR_UI_CSP.includes("style-src 'self'"), 'the CSP no longer pins styles to this origin');
    assert(OPERATOR_UI_CSP.includes("default-src 'none'"), 'the CSP no longer denies everything by default');
    assert(!OPERATOR_UI_CSP.includes('unsafe-inline'), 'the CSP gained unsafe-inline');
    assert(!OPERATOR_UI_CSP.includes('unsafe-eval'), 'the CSP gained unsafe-eval');
  });

  await test('the export is fetched with the token in a HEADER, never in a URL', () => {
    assert(/exportCatalogFile/.test(app), 'there is no export function');
    assert(/'x-operator-ui-secret': token\.value/.test(app), 'the export does not send the token as a header');
    const exportFn = app.split('async function exportCatalogFile')[1]!.split('\n  // ')[0]!;
    assert(!/token\.value/.test(exportFn.replace(/'x-operator-ui-secret': token\.value/g, '')
      .replace(/if \(token\.value === ''\)/g, '')), 'the token is used somewhere else in the export path');
    assert(!/params\.set\('token'/.test(app), 'a token reaches a query string');
  });

  await test('the apply button is disarmed whenever the file selection changes', () => {
    assert(/impFile\.addEventListener\('change'/.test(app), 'nothing watches the file selection');
    assert(/disarmImport/.test(app), 'there is no disarm path');
    assert(/importConfirmedFile/.test(app), 'the confirmation is not tied to a file');
  });

  // -------------------------------------------------------------------------------------------------------
  // Against a real server and a real PostgreSQL
  // -------------------------------------------------------------------------------------------------------

  const secretsDir = join(WORK, 'secrets');
  mkdirSync(secretsDir, { recursive: true });
  const tokenFile = join(secretsDir, 'operator_ui_token');
  writeFileSync(tokenFile, `${TOKEN}\n`);
  const recordsDir = join(WORK, 'records');
  mkdirSync(recordsDir, { recursive: true });
  const config = validateOperatorUiServiceConfig({
    host: '127.0.0.1', port: 8099, operatorSecretFile: tokenFile, promotionRecordsDir: recordsDir,
  });

  interface Call { status: number; body: string; headers: Record<string, string | string[] | undefined> }
  const caller = (port: number) => (path: string, options: { token?: string; method?: string } = {}): Promise<Call> =>
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

  const port = await freePort();
  const server: Server = createOperatorUiServiceServer(config, loadOperatorUiLocalAuthRuntime(tokenFile));
  await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', resolve); });
  const call = caller(port);

  await test(`${CATALOG_EXPORT_ROUTE} needs the token, is GET-only, and fails closed with no database`, async () => {
    assertEq((await call(CATALOG_EXPORT_ROUTE)).status, 401, 'no token');
    assertEq((await call(CATALOG_EXPORT_ROUTE, { token: 'phase265-operator-token-ABCDEFGHIJ' })).status, 401,
      'a wrong token of the same length');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await call(CATALOG_EXPORT_ROUTE, { token: TOKEN, method });
      assertEq(res.status, 405, `${method} was not refused`);
      assertEq(res.headers.allow, 'GET', `${method} was not told what is allowed`);
    }
    const res = await call(CATALOG_EXPORT_ROUTE, { token: TOKEN });
    assertEq(res.status, 503, `a route with no database answered ${res.status}`);
    assert(!/postgres|password|DATABASE_URL|\/run\/secrets/i.test(res.body), 'the failure leaked configuration');
  });

  await new Promise<void>((resolve) => { server.close(() => resolve()); });

  console.log('\nend to end: exporting a real, encrypted catalog');

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
    const kek = Buffer.alloc(32, 17);
    process.env.CUSTODIAN_MODE = 'file';
    process.env.CUSTODIAN_KEYSTORE_DIR = keystore;
    process.env.CUSTODIAN_KEK = kek.toString('base64');
    process.env.COMPLETION_SECRET = completionSecret;

    const { getPool, closePool } = await import('../src/db/pool.js');
    const { CatalogAuthority } = await import('../src/core/catalog/authority.js');
    const { createCustodian, loadCustodianConfig } = await import('../src/core/crypto/custodian-factory.js');
    const { createExistingStateLookup } = await import('../src/ops/catalog-import.js');
    const { applyImport } = await import('../src/ops/catalog-import-service.js');
    const { createImportHistoryStore } = await import('../src/ops/import-history.js');

    const text = `${JSON.stringify({
      format: 'catalog-authority.snapshot',
      version: 1,
      source: 'workspace-library',
      items: [
        { externalId: 'w-1', title: 'Zulu Workspace Record', year: 2016, providerRefs: [{ type: 'imdb', value: SECRET_REF }], metadata: { shelf: 'z1' } },
        { externalId: 'w-2', title: 'Alpha Workspace Record', year: 1994 },
        { externalId: 'w-3', title: 'A Hostile <script>alert(1)</script> Record' },
      ],
    }, null, 2)}\n`;
    const applied = await applyImport({
      text,
      lookup: createExistingStateLookup(getPool()),
      authority: new CatalogAuthority(getPool(), createCustodian(loadCustodianConfig())),
      history: createImportHistoryStore(getPool()),
      actor: 'cli',
      fileName: 'workspace.json',
    });

    const livePort = await freePort();
    const liveServer = createOperatorUiServiceServer(config, loadOperatorUiLocalAuthRuntime(tokenFile));
    await new Promise<void>((resolve) => { liveServer.listen(livePort, '127.0.0.1', resolve); });
    const live = caller(livePort);
    const counts = async (): Promise<{ items: number; events: number; history: number }> => ({
      items: (await admin.query('SELECT count(*)::int AS n FROM items')).rows[0].n as number,
      events: (await admin.query('SELECT count(*)::int AS n FROM events')).rows[0].n as number,
      history: (await admin.query('SELECT count(*)::int AS n FROM import_history')).rows[0].n as number,
    });

    await test('the export route serves a real, encrypted catalog as a downloadable snapshot', async () => {
      assertEq(applied.result.created, 3, 'the fixture did not import');
      const res = await live(CATALOG_EXPORT_ROUTE, { token: TOKEN });
      assertEq(res.status, 200, `the export answered ${res.status}: ${res.body}`);
      assertEq(res.headers['content-disposition'], 'attachment; filename="catalog-export-workspace-library.json"',
        'the download name is wrong');
      assertEq(res.headers['content-type'], 'application/json; charset=utf-8', 'the content type is wrong');
      assertEq(res.headers['x-content-type-options'], 'nosniff', 'a browser could still sniff this');
      assertEq(res.headers['x-catalog-export-records'], '3', 'the record count header is wrong');
      assertEq(res.headers['x-catalog-export-refs-omitted'], '1', 'the omitted-reference count is wrong');
      const parsed = parseCatalogSnapshot(res.body);
      assertEq(parsed.items.length, 3, 'the export lost a record');
      assert(!res.body.includes(SECRET_REF), 'the export disclosed a provider reference value');
      // A hostile title survives as DATA — mangling a legitimate title would prove nothing, and the file is
      // served as JSON with nosniff so no browser parses it as a document.
      assert(res.body.includes('<script>alert(1)<\\/script>') || res.body.includes('<script>alert(1)</script>'),
        'the hostile title did not survive as text');
    });

    await test('exporting and browsing wrote NO row, NO event and NO history entry', async () => {
      const before = await counts();
      for (const path of [
        CATALOG_EXPORT_ROUTE, `${CATALOG_EXPORT_ROUTE}?source=workspace-library`,
        '/api/catalog', '/api/catalog?q=zulu', '/api/catalog?sort=title&order=desc&pageSize=1&page=2',
        '/api/import/history', '/api/import/inbox',
      ]) {
        const res = await live(path, { token: TOKEN });
        assert(res.status === 200 || res.status === 409, `${path} answered ${res.status}: ${res.body}`);
      }
      const after = await counts();
      assertEq(after.items, before.items, 'browsing or exporting created a row');
      assertEq(after.events, before.events, 'browsing or exporting appended an event');
      assertEq(after.history, before.history, 'browsing or exporting wrote a history entry');
    });

    await test('the export is byte-for-byte identical when nothing has changed', async () => {
      const first = await live(CATALOG_EXPORT_ROUTE, { token: TOKEN });
      const second = await live(CATALOG_EXPORT_ROUTE, { token: TOKEN });
      assertEq(second.body, first.body, 'two exports of an unchanged catalog differ');
    });

    await test('an export can be re-imported, and the re-import changes nothing', async () => {
      const exported = (await live(CATALOG_EXPORT_ROUTE, { token: TOKEN })).body;
      const before = await counts();
      const round = await applyImport({
        text: exported,
        lookup: createExistingStateLookup(getPool()),
        authority: new CatalogAuthority(getPool(), createCustodian(loadCustodianConfig())),
        actor: 'cli',
        fileName: 'round-trip.json',
      });
      assertEq(round.result.created, 0, 'a re-imported export created records');
      assertEq(round.result.unchanged, 3, 'a re-imported export did not recognise every record');
      const after = await counts();
      assertEq(after.items, before.items, 'a re-imported export changed the item count');
      assertEq(after.events, before.events, 'a re-imported export appended events');
    });

    await test('paging with a chosen page size is bounded and total, over the real catalog', async () => {
      const page1 = JSON.parse((await live('/api/catalog?pageSize=2&page=1&sort=title', { token: TOKEN })).body) as
        { items: Array<{ itemId: string }>; pageCount: number; pageSize: number };
      const page2 = JSON.parse((await live('/api/catalog?pageSize=2&page=2&sort=title', { token: TOKEN })).body) as
        { items: Array<{ itemId: string }> };
      assertEq(page1.pageSize, 2, 'the page size was ignored');
      assertEq(page1.pageCount, 2, 'the page count is wrong');
      assertEq(page1.items.length, 2, 'the first page is the wrong size');
      assertEq(page2.items.length, 1, 'the second page is the wrong size');
      const overlap = page2.items.filter((i) => page1.items.some((j) => j.itemId === i.itemId));
      assertEq(overlap.length, 0, 'a record appears on both pages');

      // Out-of-range page sizes fall back to the default and SAY they were ignored, rather than 400ing a
      // bookmark or — worse — being honoured.
      const silly = JSON.parse((await live('/api/catalog?pageSize=99999&page=0', { token: TOKEN })).body) as
        { pageSize: number; page: number; ignored: string[] };
      assertEq(silly.pageSize, 25, 'an out-of-range page size was honoured');
      assertEq(silly.page, 1, 'an out-of-range page was honoured');
      assert(silly.ignored.length >= 2, 'the ignored parameters were not reported');
    });

    await test('the source filter narrows to one source and never invents one', async () => {
      const all = JSON.parse((await live('/api/catalog?source=workspace-library', { token: TOKEN })).body) as { matched: number };
      assertEq(all.matched, 3, 'the source filter did not match the imported records');
      const none = JSON.parse((await live('/api/catalog?source=no-such-library', { token: TOKEN })).body) as
        { matched: number; state: string; total: number };
      assertEq(none.matched, 0, 'an unknown source matched records');
      assertEq(none.state, 'NO_MATCH', 'an unknown source reported the catalog as empty');
      assertEq(none.total, 3, 'an unknown source hid the catalog total');
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
