import { Client } from 'pg';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIBRARY_MATCH_MAX_RECORDS,
  LIBRARY_MATCH_REPORT,
  matchCatalogToLibrary,
  renderLibraryMatch,
  type LibraryMatchReport,
} from '../src/ops/jellyfin-library-match.js';
import {
  createCollectionAuditRuntime,
  readOnlyCollectionTarget,
} from '../src/ops/collection-execution.js';
import { parseCollectionArgs, renderCollectionOutcome, runCollectionCommand } from '../src/ops/collection-command.js';
import {
  JELLYFIN_ALLOW_COLLECTION_WRITES_ENV,
  JELLYFIN_ENABLE_NETWORK_ENV,
} from '../src/ops/jellyfin-control-config.js';
import { produceCatalogSnapshot } from '../src/core/catalog/external-export.js';
import type { CollectionTarget } from '../src/core/publish/collection-outbox.js';
import type { FetchLike } from '../src/core/adapters/jellyfin/transport.js';
import { migrateWith } from '../src/db/pool.js';
import { startEmbedded } from './embedded-pg.js';
import { installCompletionSecret } from './crypto-setup.js';

// Phase 275 — the read-only link between imported catalog records and a Jellyfin library.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - IT RUNS ON THE READ SWITCH ALONE, and every write gate stays exactly closed while it does — asserted
//     from the environment the report was taken under and from the report's own declaration.
//   - IT IS A READ, AND THE OBJECT GRAPH SAYS SO. The target it is handed refuses create, addMembers,
//     removeMembers and remove; the module holds no writer of any table; and a whole session leaves every row
//     count in the database exactly where it found it.
//   - PROVIDER IDENTITY GOES NOWHERE. Asserted against the request lines the fake server actually RECEIVED —
//     no reference value, no title, no record id, no api key in any URL — and only allowed read methods and
//     routes appear at all.
//   - UNKNOWN IS A VERDICT AND ABSENCE IS NEVER INFERRED. A failed listing and a truncated listing both make
//     every record they would have judged `unknown`, and the report says the library was not read completely.
//   - A RECORD WITH NO REFERENCE IS NOT A MISSING RECORD, and a forgotten one is neither: they are
//     `no-references` and `unreadable`, two answers that a single "not found" would have destroyed.
//   - THE OUTPUT IS REDACTION-SAFE at the command line's stricter standard: opaque record ids, closed-set
//     words and counts, and no title, reference value, media-server id, handle, address or key.

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

const WORK = mkdtempSync(join(tmpdir(), 'ca-library-match-'));
const SECRET_REF = 'tt-phase275-ref-value-must-never-be-disclosed';
const API_KEY = 'phase275-api-key-must-never-be-disclosed';
const KEY_FILE = join(WORK, 'jellyfin_api_key');
writeFileSync(KEY_FILE, `${API_KEY}\n`, 'utf8');

const emitted: string[] = [];

interface FakeJellyfin {
  readonly baseUrl: string;
  readonly requests: Array<{ method: string; url: string }>;
  library: Record<string, string>;
  breakCandidates: boolean;
  close(): Promise<void>;
}

async function startFakeJellyfin(initial: Record<string, string>): Promise<FakeJellyfin> {
  const state = { library: { ...initial }, breakCandidates: false };
  const requests: Array<{ method: string; url: string }> = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '/' });
    const json = (value: unknown, status = 200): void => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/System/Info') { json({ Version: '10.9.11' }); return; }
    if (url.pathname === '/Items' && req.method === 'GET') {
      const types = (url.searchParams.get('IncludeItemTypes') ?? '').split(',');
      if (types.includes('BoxSet')) { json({ Items: [] }); return; }
      if (state.breakCandidates) { json({ error: 'no' }, 500); return; }
      json({
        Items: Object.entries(state.library).map(([ref, id]) => {
          const [type, value] = ref.split(':');
          return { Id: id, ProviderIds: { [type!]: value } };
        }),
      });
      return;
    }
    json({}, 404);
  });

  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    get library() { return state.library; },
    set library(value: Record<string, string>) { state.library = value; },
    get breakCandidates() { return state.breakCandidates; },
    set breakCandidates(value: boolean) { state.breakCandidates = value; },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function main(): Promise<void> {
  console.log('Running Phase 275 Jellyfin library match suite:\n');

  await test('the matcher module reaches for no writer of any kind', () => {
    const source = readRepo('src/ops/jellyfin-library-match.ts');
    for (const forbidden of ['upsertManagedCollection', 'setManagedMembers', 'markManagedRevokePending',
      'rearmManagedCollection', 'touchManagedCollection', 'queueCollectionPlan', 'applyCollectionRepair',
      'pool.query', 'INSERT', 'UPDATE ', 'DELETE ', 'JellyfinHttpClient', 'createTaggedCollection']) {
      assert(!source.includes(forbidden), `the matcher must not name ${forbidden}`);
    }
    assert(!/\bfetch\s*\(/.test(source), 'and it constructs no transport of its own');
    // The four write methods on a target are the ones it must never call, by name.
    for (const method of ['.create(', '.addMembers(', '.removeMembers(', '.remove(']) {
      assert(!source.includes(method), `the matcher must not call ${method}`);
    }
    assert(source.includes('deps.target.resolve('), 'and the ONE target method it calls is resolve');

    // The COMMAND module did not widen either. It reads the write-switch STATE through the one function that
    // already knows how each switch is spelled, rather than importing the real-client factory and the consent
    // loader to ask a question about three booleans — a read-only surface that reached for the factory would
    // be a read-only surface with a client in its object graph.
    const command = readRepo('src/ops/collection-command.ts');
    const imports = command.split('\n').filter((line) => line.startsWith('import ') || /^\s{2}[A-Za-z]+,$/.test(line));
    for (const forbidden of ['real-factory', 'publish/consent', 'jellyfin-control-config']) {
      assert(!imports.some((line) => line.includes(forbidden)), `the command module must not import ${forbidden}`);
    }
    assert(command.includes('describeCollectionWriteGates(env)'), 'it asks the shared gate module instead');
  });

  await test('the read-only target refuses every write, so a match cannot change a media server', async () => {
    const calls: string[] = [];
    const wrapped = readOnlyCollectionTarget({
      name: 'jellyfin',
      resolve: async () => { calls.push('resolve'); return { ids: ['jf-1'], truncated: false }; },
      findByToken: async () => null,
      listMembers: async () => ({ ids: [], truncated: false }),
      create: async () => { calls.push('create'); return 'nope'; },
      addMembers: async () => { calls.push('addMembers'); },
      removeMembers: async () => { calls.push('removeMembers'); },
      remove: async () => { calls.push('remove'); return 'deleted'; },
    });
    for (const call of [
      () => wrapped.create('n', ['a'], 't'),
      () => wrapped.addMembers('h', ['a']),
      () => wrapped.removeMembers('h', ['a']),
      () => wrapped.remove('h'),
    ]) {
      let threw = false;
      try { await call(); } catch { threw = true; }
      assert(threw, 'every write on a read-only target throws');
    }
    assertEq(calls.filter((c) => c !== 'resolve').length, 0, 'and not one reached the underlying target');
  });

  await test('`match` is a command with no name, no selection and no digest', () => {
    const parsed = parseCollectionArgs(['match']);
    assertEq(parsed.command, 'match', 'the command parses on its own');
    assertEq(parsed.name, null, 'it names no collection');
    assertEq(parsed.confirmDigest, null, 'and confirms no digest, because it authorises nothing');
    assertEq(parseCollectionArgs(['match', '--json']).json, true, 'and it takes --json');
  });

  // -------------------------------------------------------------------------------------------------------
  // The unknown verdicts, against a synthetic target. A page bound of 100,000 rows is not reachable against a
  // real server in a suite, so the behaviour is driven directly through the port that reports it.
  // -------------------------------------------------------------------------------------------------------

  const syntheticTarget = (outcome: () => Promise<{ ids: readonly string[]; truncated: boolean }>): CollectionTarget => ({
    name: 'jellyfin',
    beginPass: () => undefined,
    resolve: () => outcome(),
    findByToken: async () => null,
    listMembers: async () => ({ ids: [], truncated: false }),
    create: async () => { throw new Error('write'); },
    addMembers: async () => { throw new Error('write'); },
    removeMembers: async () => { throw new Error('write'); },
    remove: async () => { throw new Error('write'); },
  });

  const syntheticDeps = (target: CollectionTarget, refs: Array<{ type: string; value: string }>) => ({
    reader: {
      countActive: async () => 1,
      listActiveIds: async (limit: number, offset: number) => (offset === 0 ? ['11111111-1111-4111-8111-111111111111'].slice(0, limit) : []),
      readIdentity: async () => null,
    },
    authority: {
      withPublishableIdentity: async <T>(_id: string, _requires: readonly never[], fn: (identity: { itemId: string; providerRefs?: Array<{ type: string; value: string }> }) => Promise<T> | T): Promise<T | null> =>
        fn({ itemId: '11111111-1111-4111-8111-111111111111', providerRefs: refs }),
    },
    target,
    requires: ['providerRefs'],
    gates: { collectionWritesEnabled: false, livePublishEnabled: false, externalIdentityAllowed: false },
  }) as unknown as Parameters<typeof matchCatalogToLibrary>[0];

  await test('a listing that hits its page bound makes every record UNKNOWN, never absent', async () => {
    const report = await matchCatalogToLibrary(syntheticDeps(
      syntheticTarget(async () => ({ ids: [], truncated: true })),
      [{ type: 'imdb', value: SECRET_REF }],
    ));
    assertEq(report.counts.unknown, 1, 'the record could not be judged');
    assertEq(report.counts.unmatched, 0, 'and was NOT reported as absent from the library');
    assertEq(report.findings[0]!.reason, 'SCAN_TRUNCATED', 'and it says exactly why');
    assertEq(report.libraryComplete, false, 'and the report says the library was not read completely');
    assert(report.guidance.includes('is not "it is not there"'), 'and the guidance says what that means');
  });

  await test('a listing that FAILS makes every record UNKNOWN too', async () => {
    const report = await matchCatalogToLibrary(syntheticDeps(
      syntheticTarget(async () => { throw new Error('the media server is down'); }),
      [{ type: 'imdb', value: SECRET_REF }],
    ));
    assertEq(report.counts.unknown, 1, 'the record could not be judged');
    assertEq(report.findings[0]!.reason, 'SCAN_FAILED', 'and it says the scan failed');
    assertEq(report.findings[0]!.matches, null, 'with no count invented for it');
    assertEq(report.libraryComplete, false, 'and the library is not claimed to have been read');
  });

  await test('a record with no reference is `no-references`, which is not an absence', async () => {
    const report = await matchCatalogToLibrary(syntheticDeps(
      syntheticTarget(async () => ({ ids: [], truncated: false })),
      [],
    ));
    assertEq(report.counts.noReferences, 1, 'it is reported as having nothing to match by');
    assertEq(report.counts.unmatched, 0, 'and not as missing from the library');
    assertEq(report.libraryComplete, true, 'and no incomplete read is claimed');
    // AND THE MEDIA SERVER WAS NEVER CONSULTED, which the report says out loud rather than letting
    // "the library read completed" stand as evidence the server was reachable.
    assertEq(report.libraryRead, false, 'the library was never consulted at all');
    assert(report.guidance.includes('was not consulted at all'), 'and the guidance says so');
  });

  await test('a record forgotten BETWEEN the listing and the resolution is `unreadable`, never absent', async () => {
    // The real race, driven deterministically. `listActiveIds` already excludes a forgotten record, so the
    // only way this arises against a live database is a forget landing mid-pass — and the answer to it must
    // be "this product will not describe that record", not "your library does not have it".
    let resolved = 0;
    const deps = syntheticDeps(syntheticTarget(async () => { resolved += 1; return { ids: [], truncated: false }; }), []);
    const report = await matchCatalogToLibrary({
      ...deps,
      // The fail-closed disclosure bridge's own answer for a forgotten, shredded or key-inactive record.
      authority: { withPublishableIdentity: async () => null },
    });
    assertEq(report.counts.unreadable, 1, 'the record is unreadable');
    assertEq(report.counts.unmatched, 0, 'and is NOT reported as missing from the library');
    assertEq(report.findings[0]!.reason, 'RECORD_NOT_DISCLOSABLE', 'and it says exactly why');
    assertEq(report.findings[0]!.refTypes.length, 0, 'disclosing no reference type');
    assertEq(resolved, 0, 'and the media server was never asked about it at all');
  });

  // -------------------------------------------------------------------------------------------------------
  // Everything else, against a real embedded PostgreSQL and a fake media server over real HTTP.
  // -------------------------------------------------------------------------------------------------------

  let pg: Awaited<ReturnType<typeof startEmbedded>> | undefined;
  const external = process.env.DATABASE_URL !== undefined;
  if (!external) {
    try { pg = await startEmbedded(); }
    catch (err) { console.log(`  SKIP  embedded PostgreSQL unavailable: ${(err as Error).message}`); }
  }

  if (external || pg !== undefined) {
    await migrateWith(process.env.ADMIN_DATABASE_URL!);
    const admin = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
    await admin.connect();
    const completionSecret = await installCompletionSecret(admin);

    const keystore = join(WORK, 'keystore');
    mkdirSync(keystore, { recursive: true });
    process.env.CUSTODIAN_MODE = 'file';
    process.env.CUSTODIAN_KEYSTORE_DIR = keystore;
    process.env.CUSTODIAN_KEK = Buffer.alloc(32, 43).toString('base64');
    process.env.COMPLETION_SECRET = completionSecret;

    const { getPool, closePool } = await import('../src/db/pool.js');
    const { CatalogAuthority } = await import('../src/core/catalog/authority.js');
    const { createCustodian, loadCustodianConfig } = await import('../src/core/crypto/custodian-factory.js');
    const { createExistingStateLookup } = await import('../src/ops/catalog-import.js');
    const { applyImport } = await import('../src/ops/catalog-import-service.js');
    const { createCatalogReader } = await import('../src/ops/operator-ui-catalog-browse.js');

    const pool = getPool();
    const authority = new CatalogAuthority(pool, createCustodian(loadCustodianConfig()));

    // THE FIXTURE IS PRODUCED, NOT WRITTEN. Phase 274's producer turns an external export into the canonical
    // snapshot, and this suite imports exactly that — so the matcher is exercised against records that came
    // in the way the shipped workflow brings them in.
    const produced = produceCatalogSnapshot(JSON.stringify({
      format: 'catalog-authority.external-export',
      version: 1,
      system: 'match-fixture',
      entries: [
        { entryId: 'm-1', title: 'Match Alpha', references: [{ kind: 'imdb_id', id: `${SECRET_REF}-1` }] },
        { entryId: 'm-2', title: 'Match Bravo', references: [{ kind: 'imdb_id', id: `${SECRET_REF}-2` }] },
        { entryId: 'm-3', title: 'Match Charlie' },
        { entryId: 'm-4', title: 'Match Delta', references: [{ kind: 'tmdb_id', id: `${SECRET_REF}-4` }] },
      ],
    }));
    const applied = await applyImport({
      text: produced.text, lookup: createExistingStateLookup(pool), authority, actor: 'cli', fileName: 'match.json',
    });
    assertEq(applied.result.created, 4, 'the produced fixture did not import');

    const reader = createCatalogReader(pool, authority);
    const ids = [...await reader.listActiveIds(10, 0)];

    // The fake library holds TWO of the four references: one match, one unmatched, one with no reference at
    // all, and one whose reference is simply not there.
    const fake = await startFakeJellyfin({
      [`imdb:${SECRET_REF}-1`]: 'jf-item-1',
      [`imdb:${SECRET_REF}-2`]: 'jf-item-2',
    });

    /** The environment a MATCH is expected to be taken in: the read switch on, every write gate closed. */
    const readOnlyEnv: NodeJS.ProcessEnv = {
      [JELLYFIN_ENABLE_NETWORK_ENV]: 'true',
      JELLYFIN_BASE_URL: fake.baseUrl,
      JELLYFIN_API_KEY_FILE: KEY_FILE,
    };
    const realFetch = globalThis.fetch as unknown as FetchLike;

    const runMatch = async (env: NodeJS.ProcessEnv = readOnlyEnv): Promise<LibraryMatchReport> => {
      const result = await runCollectionCommand(parseCollectionArgs(['match']), {
        pool, reader, authority, fetch: realFetch, env,
      });
      assert(result.outcome.kind === 'match', `the match command refused: ${JSON.stringify(result.outcome)}`);
      emitted.push(renderCollectionOutcome(result.outcome, false));
      emitted.push(renderCollectionOutcome(result.outcome, true));
      return result.outcome.match;
    };

    const counts = async (): Promise<string> => {
      const tables = ['items', 'events', 'publish_ledger', 'managed_collections', 'managed_collection_members',
        'collection_control_history', 'import_history'];
      const out: string[] = [];
      for (const table of tables) {
        out.push(`${table}=${(await admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number}`);
      }
      return out.join(' ');
    };

    await test('with the network switch OFF there is no match at all, and it says which switch', async () => {
      const result = await runCollectionCommand(parseCollectionArgs(['match']), {
        pool, reader, authority, fetch: realFetch, env: { JELLYFIN_BASE_URL: fake.baseUrl, JELLYFIN_API_KEY_FILE: KEY_FILE },
      });
      assert(result.outcome.kind === 'refused', 'a closed read switch refuses');
      assertEq(result.outcome.code, 'NETWORK_DISABLED', 'and names the switch');
      emitted.push(renderCollectionOutcome(result.outcome, true));
    });

    await test('the match runs on the READ switch alone, with every write gate closed', async () => {
      const report = await runMatch();
      assertEq(report.report, LIBRARY_MATCH_REPORT, 'the report names itself');
      assertEq(report.gates.networkEnabled, true, 'the read switch was on');
      assertEq(report.gates.collectionWritesEnabled, false, 'the collection-write switch was closed');
      assertEq(report.gates.livePublishEnabled, false, 'the live-publish switch was closed');
      assertEq(report.gates.externalIdentityAllowed, false, 'and publish consent was denied');
      assertEq(report.wrote, 'nothing', 'and it declares that it wrote nothing');
    });

    await test('every record is judged, and the three non-answers are three different answers', async () => {
      const report = await runMatch();
      assertEq(report.counts.examined, 4, 'all four records were compared');
      assertEq(report.counts.matched, 2, 'two are in the library');
      assertEq(report.counts.unmatched, 1, 'one carries a reference the library does not hold');
      assertEq(report.counts.noReferences, 1, 'one has nothing to match by');
      assertEq(report.counts.unknown, 0, 'and nothing was left unjudged');
      assertEq(report.libraryComplete, true, 'the library listing completed');
      for (const finding of report.findings) {
        if (finding.outcome === 'matched') assertEq(finding.matches, 1, 'a match names its count');
        if (finding.outcome === 'unmatched') assertEq(finding.matches, 0, 'and an absence is a zero, not a null');
        if (finding.outcome === 'no-references') assertEq(finding.refTypes.length, 0, 'and a record with no refs says so');
      }
    });

    await test('a whole match session writes NOTHING, in any table', async () => {
      const before = await counts();
      await runMatch();
      await runMatch();
      assertEq(await counts(), before, 'not one row changed anywhere in the database');
    });

    await test('the report is deterministic: the same state produces the same digest', async () => {
      const a = await runMatch();
      const b = await runMatch();
      assertEq(a.reportDigest, b.reportDigest, 'two reports of the same state are the same report');
      // ...and a library that CHANGED moves it, so the digest is not a constant.
      const original = fake.library;
      fake.library = { ...original };
      delete fake.library[`imdb:${SECRET_REF}-2`];
      const c = await runMatch();
      assert(c.reportDigest !== a.reportDigest, 'a changed library changes the digest');
      assertEq(c.counts.matched, 1, 'and one fewer record is found');
      assertEq(c.counts.unmatched, 2, 'while the other is now correctly reported absent');
      fake.library = original;
    });

    await test('a media server that cannot be listed produces UNKNOWN, never a library full of absences', async () => {
      fake.breakCandidates = true;
      try {
        const report = await runMatch();
        assertEq(report.counts.unknown, 3, 'every record with a reference is unknown');
        assertEq(report.counts.unmatched, 0, 'and NOT ONE is reported as missing from the library');
        assertEq(report.counts.noReferences, 1, 'while the record with no reference is still answered');
        assertEq(report.libraryComplete, false, 'and the report says the library was not read');
      } finally {
        fake.breakCandidates = false;
      }
    });

    await test('a whole match TRANSMITS no reference value, no title, no record id and no key', async () => {
      fake.requests.length = 0;
      const report = await runMatch();
      assert(report.counts.examined > 0, 'the match examined something, so the scan below is not vacuous');
      assert(fake.requests.length > 0, 'and it really did contact the server');
      const sent = fake.requests.map((r) => `${r.method} ${decodeURIComponent(r.url)}`).join(' | ');
      for (const forbidden of [SECRET_REF, 'Match Alpha', 'Match Bravo', 'Match Charlie', 'm-1', 'm-2', API_KEY]) {
        assert(!sent.includes(forbidden), `the match put ${forbidden} in a request`);
      }
      for (const id of ids) assert(!sent.includes(id), 'the match put a catalog record id in a request');
    });

    await test('the transport ledger shows only allowed READ methods and routes, and no write route at all', async () => {
      fake.requests.length = 0;
      await runMatch();
      assert(fake.requests.length > 0, 'requests were made');
      for (const request of fake.requests) {
        assertEq(request.method, 'GET', `a match sent a ${request.method}`);
        const path = new URL(request.url, 'http://127.0.0.1').pathname;
        assert(path === '/Items' || path === '/System/Info',
          `a match reached ${path}, which is not one of the two read routes it is allowed`);
      }
      // The four write routes, by the shapes the mapping actually builds, must not appear anywhere.
      const ledger = fake.requests.map((r) => `${r.method} ${r.url}`).join('\n');
      for (const forbidden of ['POST /Collections', 'DELETE /Collections', 'DELETE /Items/', '/Collections/']) {
        assert(!ledger.includes(forbidden), `the ledger shows ${forbidden}, which is a write`);
      }
    });

    await test('turning the write switches ON does not change what a match does', async () => {
      // The point is not that it is allowed: it is that the command has no write path whatever the switches
      // say, so a report taken on a fully-open installation is the same read as one taken on a closed one —
      // and it REPORTS that the switches were open, so nobody can mistake the two.
      const before = await counts();
      const openEnv: NodeJS.ProcessEnv = {
        ...readOnlyEnv,
        [JELLYFIN_ALLOW_COLLECTION_WRITES_ENV]: 'true',
        JELLYFIN_ALLOW_LIVE_PUBLISH: 'true',
        PUBLISH_EXTERNAL_IDENTITY: 'allow',
      };
      fake.requests.length = 0;
      const report = await runMatch(openEnv);
      assertEq(report.gates.collectionWritesEnabled, true, 'the report says the write switch was open');
      assertEq(report.gates.livePublishEnabled, true, 'and the live-publish switch');
      assertEq(report.gates.externalIdentityAllowed, true, 'and that consent was granted');
      assertEq(report.wrote, 'nothing', 'and it still wrote nothing');
      for (const request of fake.requests) assertEq(request.method, 'GET', 'and still sent only reads');
      assertEq(await counts(), before, 'and the database is untouched');
    });

    await test('nothing this suite printed carries a title, a reference, a media-server id, an address or a key', () => {
      const all = emitted.join('\n');
      for (const forbidden of [SECRET_REF, API_KEY, KEY_FILE, fake.baseUrl, 'jf-item-', 'Match Alpha',
        'Match Bravo', 'Match Charlie', 'Match Delta']) {
        assert(!all.includes(forbidden), `the command line printed ${forbidden}`);
      }
      assert(emitted.length > 8, 'and the scan saw a meaningful number of outputs');
      // The opaque record id IS printed, on purpose: it is what the next command takes as input.
      assert(ids.some((id) => all.includes(id)), 'the opaque record id is printed, which is what makes the report usable');
    });

    await test('the report bound is declared, and a report that hit it says so', () => {
      assertEq(LIBRARY_MATCH_MAX_RECORDS > 0, true, 'the bound exists');
      const rendered = renderLibraryMatch({
        report: LIBRARY_MATCH_REPORT, version: 1, target: 'jellyfin', wrote: 'nothing',
        contacted: 'read-only library listing', libraryRead: true, libraryComplete: false, truncated: true,
        counts: { examined: 0, matched: 0, unmatched: 0, noReferences: 0, unreadable: 0, unknown: 0 },
        findings: [], gates: { networkEnabled: true, collectionWritesEnabled: false, livePublishEnabled: false, externalIdentityAllowed: false },
        reportDigest: '0'.repeat(64),
        guidance: `Only the first ${LIBRARY_MATCH_MAX_RECORDS} catalog records were examined.`,
      });
      assert(rendered.includes('catalog truncated       true'), 'a truncated report says so');
      assert(rendered.includes('library read complete   false'), 'and an incomplete library read says so');
    });

    // The audit runtime is what hands the matcher a read-only target; assert the wiring rather than trust it.
    await test('the match borrows the AUDIT runtime, whose target cannot write', async () => {
      const built = createCollectionAuditRuntime({ pool, authority, fetch: realFetch, env: readOnlyEnv });
      assert(built.ok, 'the audit runtime is available on the read switch alone');
      let threw = false;
      try { await built.runtime.target.create('n', ['a'], 't'); } catch { threw = true; }
      assert(threw, 'and its target refuses to create');
    });

    // LAST, because it deliberately erases part of the fixture and does not put it back.
    await test('a forgotten record leaves the comparison entirely, and is never reported as absent', async () => {
      const before = await runMatch();
      const victim = ids[0]!;
      await admin.query('SELECT cat_forget_begin($1)', [victim]);
      const after = await runMatch();
      assertEq(after.counts.examined, before.counts.examined - 1, 'the forgotten record is no longer compared');
      assertEq(after.findings.some((f) => f.itemId === victim), false, 'and does not appear in the report at all');
      assertEq(after.counts.unmatched <= before.counts.unmatched + 1, true,
        'and its disappearance did not turn into an absence somewhere else');
    });

    await fake.close();
    await closePool();
    await admin.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (pg !== undefined) await pg.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
  try { rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(failed === 0 ? 0 : 1);
}

void main();
