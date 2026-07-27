import { Client } from 'pg';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COLLECTION_EXIT_OK,
  COLLECTION_EXIT_REFUSED,
  CollectionCommandUsageError,
  collectionCommandUsage,
  parseCollectionArgs,
  redactPlanForCli,
  renderCollectionOutcome,
  runCollectionCommand,
  type CollectionCommandDeps,
} from '../src/ops/collection-command.js';
import { collectionKeyFor } from '../src/core/publish/collection-model.js';
import { createCollectionHistoryStore } from '../src/ops/collection-history.js';
import {
  JELLYFIN_ALLOW_COLLECTION_WRITES_ENV,
  JELLYFIN_ENABLE_NETWORK_ENV,
} from '../src/ops/jellyfin-control-config.js';
import type { FetchLike } from '../src/core/adapters/jellyfin/transport.js';
import { migrateWith } from '../src/db/pool.js';
import { startEmbedded } from './embedded-pg.js';
import { installCompletionSecret } from './crypto-setup.js';

// Phase 272 — the collection lifecycle from a terminal, with the same services and the same gates.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - IT IS NOT A BYPASS. Every command runs the same gate check, the same planner, the same queue and the
//     same passes the HTTP routes run, and the command module imports no second implementation of any of it.
//   - APPLY AND REPAIR REQUIRE THE DIGEST AN OPERATOR TYPES, compared with the SAME constant-time comparison
//     the routes use, against a plan RECOMPUTED at the moment of the write.
//   - A CLOSED SWITCH REFUSES, names itself, and writes nothing.
//   - OUTPUT IS STRICTER THAN THE BROWSER'S: no title, no year, no provider reference, no Jellyfin id, no
//     handle, no token, no api key, no address — in the summary AND in `--json`.
//   - THE WHOLE LOOP WORKS FROM THE COMMAND LINE: preview, apply, reconcile, status, audit, repair, revoke,
//     history — against a real database and a real (fake) media server.
//   - ARGUMENT PARSING IS STRICT: an unknown flag, a missing value, a malformed record id and a contradictory
//     combination are each a usage error, decided before a database connection is ever opened.

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

const WORK = mkdtempSync(join(tmpdir(), 'ca-collection-cli-'));
const SECRET_REF = 'tt-phase272-ref-value-must-never-be-printed';
const API_KEY = 'phase272-api-key-must-never-be-printed';
const KEY_FILE = join(WORK, 'jellyfin_api_key');
writeFileSync(KEY_FILE, `${API_KEY}\n`, 'utf8');

/** Everything this suite printed. Scanned at the end for anything a terminal must never carry. */
const printed: string[] = [];

interface FakeCollection { id: string; name: string; ids: string[] }

interface FakeJellyfin {
  readonly baseUrl: string;
  readonly collections: Map<string, FakeCollection>;
  readonly library: Record<string, string>;
  close(): Promise<void>;
}

async function startFakeJellyfin(initialLibrary: Record<string, string>): Promise<FakeJellyfin> {
  const library = { ...initialLibrary };
  const collections = new Map<string, FakeCollection>();
  let counter = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const json = (value: unknown, status = 200): void => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(value));
    };
    const idsParam = (): string[] => (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);

    if (url.pathname === '/System/Info') { json({ Version: '10.9.11' }); return; }
    if (req.method === 'POST' && url.pathname === '/Collections') {
      const id = `jf-col-${++counter}`;
      collections.set(id, { id, name: url.searchParams.get('name') ?? '', ids: idsParam() });
      json({ Id: id });
      return;
    }
    const collectionItems = /^\/Collections\/([^/]+)\/Items$/.exec(url.pathname);
    if (collectionItems !== null) {
      const collection = collections.get(decodeURIComponent(collectionItems[1]!));
      if (collection === undefined) { json({}, 404); return; }
      const wanted = idsParam();
      if (req.method === 'POST') { for (const item of wanted) if (!collection.ids.includes(item)) collection.ids.push(item); json({}); return; }
      if (req.method === 'DELETE') { collection.ids = collection.ids.filter((i) => !wanted.includes(i)); json({}); return; }
      json({}, 405);
      return;
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/Items/')) {
      const id = decodeURIComponent(url.pathname.slice('/Items/'.length));
      if (!collections.has(id)) { json({}, 404); return; }
      collections.delete(id);
      json({});
      return;
    }
    if (url.pathname === '/Items') {
      const parentId = url.searchParams.get('parentId');
      if (parentId !== null) { json({ Items: (collections.get(parentId)?.ids ?? []).map((id) => ({ Id: id })) }); return; }
      const types = (url.searchParams.get('IncludeItemTypes') ?? '').split(',');
      if (types.includes('BoxSet')) { json({ Items: [...collections.values()].map((c) => ({ Id: c.id, Name: c.name })) }); return; }
      json({
        Items: Object.entries(library).map(([ref, id]) => {
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
    collections,
    library,
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
  console.log('Running Phase 272 collection command-line suite:\n');

  // -------------------------------------------------------------------------------------------------------
  // Argument parsing, decided before anything is opened.
  // -------------------------------------------------------------------------------------------------------

  const goodId = '00000000-0000-5000-8000-000000000001';

  await test('the parser accepts the whole documented surface', () => {
    const preview = parseCollectionArgs(['preview', '--name', 'Weekend picks', '--item', goodId, '--json']);
    assertEq(preview.command, 'preview', 'the command is the first argument');
    assertEq(preview.name, 'Weekend picks', 'the name is read');
    assertEq(preview.itemIds.join(','), goodId, 'and the selection');
    assertEq(preview.json, true, 'and the output flag');

    const apply = parseCollectionArgs(['apply', '--name', 'X', '--search', 'alpha', '--confirm-digest', 'a'.repeat(64)]);
    assertEq(apply.confirmDigest, 'a'.repeat(64), 'apply takes the digest');
    assertEq(apply.search, 'alpha', 'and a search selection');

    const revoke = parseCollectionArgs(['apply', '--name', 'X', '--revoke', '--confirm-digest', 'b'.repeat(64)]);
    assertEq(revoke.revoke, true, 'revoke mode is a flag');

    for (const command of ['status', 'audit', 'reconcile', 'revoke', 'history']) {
      assertEq(parseCollectionArgs([command]).command, command as never, `${command} needs no options`);
    }
    assertEq(parseCollectionArgs(['--help']).help, true, 'and help is help');
  });

  await test('the parser refuses rather than guessing, and says what is wrong', () => {
    for (const [argv, why] of [
      [[], 'no command at all'],
      [['explode'], 'an unknown command'],
      [['preview', '--name'], 'a flag with no value'],
      [['preview', '--name', '--json'], 'a flag that would swallow the next flag'],
      [['preview', '--name', 'X', '--unknown'], 'an unknown option'],
      [['preview', '--name', 'bad [name]', '--item', goodId], 'a name outside the closed grammar'],
      [['preview', '--name', 'X'], 'a selection that was never given'],
      [['preview', '--name', 'X', '--item', 'not-a-uuid'], 'a malformed record id'],
      [['preview', '--name', 'X', '--revoke', '--item', goodId], 'a revoke that carries a selection'],
      [['preview', '--name', 'X', '--revoke', '--search', 'a'], 'a revoke that carries a search'],
      [['apply', '--name', 'X', '--item', goodId], 'an apply with no digest'],
      [['apply', '--name', 'X', '--item', goodId, '--confirm-digest', 'nope'], 'an apply with a malformed digest'],
      [['repair'], 'a repair with no digest'],
    ] as Array<[string[], string]>) {
      let threw = false;
      try { parseCollectionArgs(argv); } catch (err) { threw = err instanceof CollectionCommandUsageError; }
      assert(threw, `the parser accepted ${why}`);
    }
  });

  await test('the usage text documents every command and says what the gates are', () => {
    const usage = collectionCommandUsage();
    printed.push(usage);
    for (const command of ['preview', 'apply', 'status', 'audit', 'repair', 'reconcile', 'revoke', 'history']) {
      assert(usage.includes(`  ${command}`), `usage documents ${command}`);
    }
    assert(usage.includes('--confirm-digest'), 'and the digest an operator has to state');
    assert(usage.includes('four deployment switches'), 'and that the same switches apply');
    assert(usage.includes('never contains a title'), 'and what it will not print');
  });

  await test('the command module calls the shared services and imports no second implementation', () => {
    const source = readRepo('src/ops/collection-command.ts');
    for (const shared of ['checkCollectionWriteGates', 'buildCollectionPlan', 'queueCollectionPlan',
      'runCollectionReconcile', 'runCollectionRevocation', 'auditCollectionDrift', 'buildCollectionRepairPlan',
      'applyCollectionRepair', 'digestEchoMatches']) {
      assert(source.includes(shared), `the CLI must call the shared ${shared}`);
    }
    // A CLI that could reach a transport or a Jellyfin client by itself would be a second, less-examined path.
    const imports = source.split('\n').filter((line) => line.startsWith('import '));
    for (const forbidden of ['http-client', 'guarded-fetch', 'outbox-target', 'collection-target', 'node:http']) {
      assert(!imports.some((line) => line.includes(forbidden)), `the CLI must not import ${forbidden}`);
    }
    // And the ENTRYPOINT is the only place that resolves a real transport.
    const entry = readRepo('src/ops/collection-command-cli.ts');
    assert(entry.includes('resolveJellyfinTransport'), 'the entrypoint resolves the one transport');
    assert(entry.includes('isDirectRun'), 'and only runs when it is the program');
  });

  // -------------------------------------------------------------------------------------------------------
  // The whole loop, against a real database and a real fake media server.
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
    process.env.CUSTODIAN_KEK = Buffer.alloc(32, 53).toString('base64');
    process.env.COMPLETION_SECRET = completionSecret;

    const { getPool, closePool } = await import('../src/db/pool.js');
    const { CatalogAuthority } = await import('../src/core/catalog/authority.js');
    const { createCustodian, loadCustodianConfig } = await import('../src/core/crypto/custodian-factory.js');
    const { createExistingStateLookup } = await import('../src/ops/catalog-import.js');
    const { applyImport } = await import('../src/ops/catalog-import-service.js');
    const { createCatalogReader } = await import('../src/ops/operator-ui-catalog-browse.js');

    const pool = getPool();
    const authority = new CatalogAuthority(pool, createCustodian(loadCustodianConfig()));
    const text = `${JSON.stringify({
      format: 'catalog-authority.snapshot', version: 1, source: 'cli-library',
      items: [
        { externalId: 'c-1', title: 'Command Alpha', year: 1994, providerRefs: [{ type: 'imdb', value: `${SECRET_REF}-1` }] },
        { externalId: 'c-2', title: 'Command Bravo', year: 2001, providerRefs: [{ type: 'imdb', value: `${SECRET_REF}-2` }] },
      ],
    }, null, 2)}\n`;
    const applied = await applyImport({ text, lookup: createExistingStateLookup(pool), authority, actor: 'cli', fileName: 'cli.json' });
    assertEq(applied.result.created, 2, 'the fixture did not import');

    const reader = createCatalogReader(pool, authority);
    const ids = [...await reader.listActiveIds(10, 0)];

    const fake = await startFakeJellyfin({
      [`imdb:${SECRET_REF}-1`]: 'jf-item-1',
      [`imdb:${SECRET_REF}-2`]: 'jf-item-2',
    });
    const env: NodeJS.ProcessEnv = {
      [JELLYFIN_ENABLE_NETWORK_ENV]: 'true',
      JELLYFIN_ALLOW_LIVE_PUBLISH: 'true',
      [JELLYFIN_ALLOW_COLLECTION_WRITES_ENV]: 'true',
      PUBLISH_EXTERNAL_IDENTITY: 'allow',
      JELLYFIN_BASE_URL: fake.baseUrl,
      JELLYFIN_API_KEY_FILE: KEY_FILE,
    };
    const realFetch = globalThis.fetch as unknown as FetchLike;
    const deps = (over: Partial<CollectionCommandDeps> = {}): CollectionCommandDeps => ({
      pool, reader, authority, history: createCollectionHistoryStore(pool), fetch: realFetch, env, ...over,
    });

    /** Run a command as the entrypoint would: parse the argv, run it, render it, keep the output. */
    const run = async (argv: readonly string[], over: Partial<CollectionCommandDeps> = {}) => {
      const args = parseCollectionArgs([...argv]);
      const result = await runCollectionCommand(args, deps(over));
      const rendered = renderCollectionOutcome(result.outcome, args.json);
      printed.push(rendered);
      return { ...result, rendered };
    };

    const named = (prefix: string): FakeCollection | undefined =>
      [...fake.collections.values()].find((c) => c.name.startsWith(`${prefix} `));

    await test('preview computes one collection, prints its digest, and writes nothing external', async () => {
      const before = (await admin.query('SELECT count(*)::int AS n FROM managed_collections')).rows[0].n as number;
      const result = await run(['preview', '--name', 'Terminal picks', '--item', ids[0]!, '--item', ids[1]!]);
      assertEq(result.exitCode, COLLECTION_EXIT_OK, 'a preview succeeds');
      assert(result.outcome.kind === 'plan', 'and returns a plan');
      assertEq(result.outcome.plan.collection.action, 'create', 'proposing ONE collection');
      assertEq(result.outcome.plan.counts.add, 2, 'holding both records');
      assert(result.rendered.includes(result.outcome.plan.planDigest), 'and the digest is printed so it can be typed back');
      assert(result.rendered.includes('no title is ever printed'), 'and the output says what it withholds');
      assertEq((await admin.query('SELECT count(*)::int AS n FROM managed_collections')).rows[0].n as number, before,
        'a preview creates no collection');
      assertEq(fake.collections.size, 0, 'and contacts no media server');
    });

    await test('a preview prints no title, no year and no reference — in the summary AND in --json', async () => {
      const summary = await run(['preview', '--name', 'Terminal picks', '--item', ids[0]!, '--item', ids[1]!]);
      const json = await run(['preview', '--name', 'Terminal picks', '--item', ids[0]!, '--item', ids[1]!, '--json']);
      for (const output of [summary.rendered, json.rendered]) {
        for (const forbidden of ['Command Alpha', 'Command Bravo', SECRET_REF, '1994', '2001', API_KEY, fake.baseUrl]) {
          assert(!output.includes(forbidden), `the command line printed ${forbidden}`);
        }
      }
      // The redaction REMOVES the fields rather than blanking them.
      assert(summary.outcome.kind === 'plan', 'the summary is a plan');
      const redacted = redactPlanForCli(summary.outcome.plan) as { members: Array<Record<string, unknown>> };
      for (const member of redacted.members) {
        assert(!('title' in member), 'the title field is removed, not emptied');
        assert(!('year' in member), 'and so is the year');
        assert('itemId' in member, 'while the opaque id an operator needs stays');
      }
    });

    await test('apply refuses without the digest an operator states, and with the wrong one', async () => {
      const plan = await run(['preview', '--name', 'Terminal picks', '--item', ids[0]!, '--item', ids[1]!]);
      assert(plan.outcome.kind === 'plan', 'the preview produced a plan');
      const before = (await admin.query('SELECT count(*)::int AS n FROM managed_collections')).rows[0].n as number;

      const wrong = await run(['apply', '--name', 'Terminal picks', '--item', ids[0]!, '--item', ids[1]!,
        '--confirm-digest', 'f'.repeat(64)]);
      assertEq(wrong.exitCode, COLLECTION_EXIT_REFUSED, 'a wrong digest refuses');
      assert(wrong.outcome.kind === 'refused' && wrong.outcome.code === 'DIGEST_MISMATCH', 'and says exactly why');
      assertEq((await admin.query('SELECT count(*)::int AS n FROM managed_collections')).rows[0].n as number, before,
        'and nothing was recorded');

      // The digest of a DIFFERENT plan is also refused: it is the digest of THIS plan that is required.
      const other = await run(['preview', '--name', 'Something else', '--item', ids[0]!]);
      assert(other.outcome.kind === 'plan', 'the other preview produced a plan');
      const crossed = await run(['apply', '--name', 'Terminal picks', '--item', ids[0]!, '--item', ids[1]!,
        '--confirm-digest', other.outcome.plan.planDigest]);
      assert(crossed.outcome.kind === 'refused' && crossed.outcome.code === 'DIGEST_MISMATCH',
        'another plan\'s digest is not this plan\'s digest');
    });

    await test('a closed switch refuses the apply, names itself, and writes nothing', async () => {
      const plan = await run(['preview', '--name', 'Terminal picks', '--item', ids[0]!, '--item', ids[1]!]);
      assert(plan.outcome.kind === 'plan', 'the preview produced a plan');
      const before = (await admin.query('SELECT count(*)::int AS n FROM managed_collections')).rows[0].n as number;
      const closed = { ...env };
      delete closed[JELLYFIN_ALLOW_COLLECTION_WRITES_ENV];
      const result = await run(
        ['apply', '--name', 'Terminal picks', '--item', ids[0]!, '--item', ids[1]!, '--confirm-digest', plan.outcome.plan.planDigest],
        { env: closed },
      );
      assertEq(result.exitCode, COLLECTION_EXIT_REFUSED, 'the apply refuses');
      assert(result.outcome.kind === 'refused' && result.outcome.code === 'WRITES_DISABLED', 'naming the switch');
      assert(result.rendered.includes(JELLYFIN_ALLOW_COLLECTION_WRITES_ENV), 'and telling the operator what to set');
      assertEq((await admin.query('SELECT count(*)::int AS n FROM managed_collections')).rows[0].n as number, before,
        'and nothing was recorded');
    });

    await test('the whole loop runs from the command line: apply, reconcile, status', async () => {
      const plan = await run(['preview', '--name', 'Terminal picks', '--item', ids[0]!, '--item', ids[1]!]);
      assert(plan.outcome.kind === 'plan', 'the preview produced a plan');
      const applyResult = await run(['apply', '--name', 'Terminal picks', '--item', ids[0]!, '--item', ids[1]!,
        '--confirm-digest', plan.outcome.plan.planDigest]);
      assertEq(applyResult.exitCode, COLLECTION_EXIT_OK, `the apply succeeded: ${applyResult.rendered}`);
      assert(applyResult.outcome.kind === 'queued', 'and it queued');
      assertEq(applyResult.outcome.queued.action, 'created', 'recording one collection');
      assertEq(applyResult.outcome.queued.members, 2, 'holding two records');
      assertEq(fake.collections.size, 0, 'and it contacted nothing');
      assert(applyResult.rendered.includes('Nothing has been sent to a media server'),
        'and the output says the difference between queued and done');

      const reconciled = await run(['reconcile']);
      assertEq(reconciled.exitCode, COLLECTION_EXIT_OK, 'the reconcile succeeded');
      assert(reconciled.outcome.kind === 'reconciled', 'and reports a pass');
      assertEq(reconciled.outcome.result.grouped.created, 1, 'creating exactly one collection');
      assertEq(fake.collections.size, 1, 'and the server holds exactly one');
      assertEq([...named('Terminal picks')!.ids].sort().join(','), 'jf-item-1,jf-item-2', 'holding both library items');

      const status = await run(['status']);
      assert(status.outcome.kind === 'status', 'status reports the model');
      assertEq(status.outcome.status.counts.published, 1, 'with one published collection');
      assert(status.rendered.includes('Terminal picks'), 'and names the operator\'s own label');
      assert(status.rendered.includes(collectionKeyFor('jellyfin', 'Terminal picks')), 'and its durable key');
    });

    await test('a second apply of an unchanged plan is a no-op the command line reports honestly', async () => {
      const plan = await run(['preview', '--name', 'Terminal picks', '--item', ids[0]!, '--item', ids[1]!]);
      assert(plan.outcome.kind === 'plan', 'the preview produced a plan');
      assertEq(plan.outcome.plan.collection.action, 'unchanged', 'nothing would change');
      assertEq(plan.outcome.plan.noop, true, 'and the plan says so');
      const applied2 = await run(['apply', '--name', 'Terminal picks', '--item', ids[0]!, '--item', ids[1]!,
        '--confirm-digest', plan.outcome.plan.planDigest]);
      assertEq(applied2.exitCode, COLLECTION_EXIT_OK, 'applying it is safe');
      assertEq(fake.collections.size, 1, 'and the server still holds exactly one collection');
    });

    await test('audit is read-only from the command line, and repair needs the digest it printed', async () => {
      // Somebody deletes the collection in the Jellyfin UI.
      const target = named('Terminal picks')!;
      fake.collections.delete(target.id);

      const audit = await run(['audit']);
      assertEq(audit.exitCode, COLLECTION_EXIT_OK, 'the audit ran');
      assert(audit.outcome.kind === 'audit', 'and returned a drift report');
      assertEq(audit.outcome.drift.counts.missing, 1, 'noticing the collection is gone');
      assertEq(audit.outcome.repair.counts.recreate, 1, 'and offering to re-arm it');
      assert(audit.rendered.includes(audit.outcome.repair.planDigest), 'printing the digest to type back');
      assert(audit.rendered.includes('read-only'), 'and saying it changed nothing');

      const wrong = await run(['repair', '--confirm-digest', 'f'.repeat(64)]);
      assert(wrong.outcome.kind === 'refused' && wrong.outcome.code === 'DIGEST_MISMATCH', 'a wrong digest refuses');

      const repaired = await run(['repair', '--confirm-digest', audit.outcome.repair.planDigest]);
      assertEq(repaired.exitCode, COLLECTION_EXIT_OK, `the repair applied: ${repaired.rendered}`);
      assert(repaired.outcome.kind === 'repaired', 'and reports what it wrote');
      assertEq(repaired.outcome.result.rearmed, 1, 're-arming one collection');
      assertEq(fake.collections.size, 0, 'and NOTHING was created on the media server by the repair itself');
      assert(repaired.rendered.includes('durable state only'), 'which the output says plainly');

      const reconciled = await run(['reconcile']);
      assert(reconciled.outcome.kind === 'reconciled', 'the ordinary pass carries it out');
      assertEq(reconciled.outcome.result.grouped.created, 1, 'recreating exactly one collection');
      assertEq(fake.collections.size, 1, 'and the server holds it again');
    });

    await test('a repair with the write switches off is refused, while an audit still runs', async () => {
      const readOnly: NodeJS.ProcessEnv = {
        [JELLYFIN_ENABLE_NETWORK_ENV]: 'true',
        JELLYFIN_BASE_URL: fake.baseUrl,
        JELLYFIN_API_KEY_FILE: KEY_FILE,
      };
      const audit = await run(['audit'], { env: readOnly });
      assertEq(audit.exitCode, COLLECTION_EXIT_OK, 'investigating does not require turning writing on');
      assert(audit.outcome.kind === 'audit', 'and it produced a report');
      const repair = await run(['repair', '--confirm-digest', audit.outcome.repair.planDigest], { env: readOnly });
      assert(repair.outcome.kind === 'refused' && repair.outcome.code === 'WRITES_DISABLED', 'but repairing does');
    });

    await test('revoke works end to end from the command line, and needs its own digest', async () => {
      const target = named('Terminal picks')!;
      const plan = await run(['preview', '--name', 'Terminal picks', '--revoke']);
      assert(plan.outcome.kind === 'plan', 'the revoke preview produced a plan');
      assertEq(plan.outcome.plan.collection.action, 'revoke', 'proposing to remove the collection');

      const wrong = await run(['apply', '--name', 'Terminal picks', '--revoke', '--confirm-digest', 'f'.repeat(64)]);
      assert(wrong.outcome.kind === 'refused', 'a wrong digest refuses the revoke too');
      assert(fake.collections.has(target.id), 'and the collection is still there');

      const queued = await run(['apply', '--name', 'Terminal picks', '--revoke', '--confirm-digest', plan.outcome.plan.planDigest]);
      assertEq(queued.exitCode, COLLECTION_EXIT_OK, `the revoke was queued: ${queued.rendered}`);
      assert(queued.outcome.kind === 'queued' && queued.outcome.queued.action === 'revoke-queued', 'as a queued removal');
      assert(fake.collections.has(target.id), 'and STILL nothing has been sent');

      const pass = await run(['revoke']);
      assert(pass.outcome.kind === 'revoked', 'the revoke pass ran');
      assertEq(pass.outcome.result.grouped.revoked, 1, 'removing exactly one collection');
      assert(!fake.collections.has(target.id), 'and it is gone from the server');
    });

    await test('the command line writes to the SAME durable history the browser does', async () => {
      const result = await run(['history']);
      assert(result.outcome.kind === 'history', 'history is served');
      const rows = (await admin.query("SELECT action, outcome FROM collection_control_history WHERE actor = 'cli' ORDER BY id")).rows;
      for (const action of ['planned', 'queued', 'reconciled', 'revoked', 'audited', 'repaired']) {
        assert(rows.some((r) => r.action === action), `the command line recorded its ${action}`);
      }
      assert(rows.some((r) => r.outcome === 'preview'), 'including the previews that wrote nothing');
    });

    await test('nothing this suite printed carries a title, a reference, a key, an id or an address', () => {
      const all = printed.join('\n');
      for (const forbidden of ['Command Alpha', 'Command Bravo', SECRET_REF, API_KEY, KEY_FILE,
        'jf-col-', 'jf-item-', fake.baseUrl, 'cat:']) {
        assert(!all.includes(forbidden), `the command line printed ${forbidden}`);
      }
      assert(printed.length > 15, 'and the scan saw a meaningful amount of output');
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
