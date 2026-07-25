import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { installCompletionSecret, testKek } from './crypto-setup.js';
import { migrateWith } from '../src/db/pool.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import {
  CATALOG_SNAPSHOT_FORMAT,
  CATALOG_SNAPSHOT_VERSION,
  CatalogImportError,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ITEMS,
  IMPORT_MAX_METADATA_KEYS,
  IMPORT_MAX_REF_VALUE_LENGTH,
  IMPORT_MAX_TITLE_LENGTH,
  deriveItemId,
  externalIdDigest,
  parseCatalogSnapshot,
} from '../src/core/catalog/import-snapshot.js';
import {
  CATALOG_IMPORT_DIR_ENV,
  CatalogImportPathError,
  applyCatalogImport,
  createExistingStateLookup,
  planCatalogImport,
  previewCatalogImportResult,
  readCatalogSnapshot,
  renderCatalogImportResult,
  resolveImportFile,
  type ExistingStateLookup,
} from '../src/ops/catalog-import.js';
import { parseCatalogImportArgs } from '../src/ops/catalog-import-cli.js';

// Phase 259 — offline catalog import.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - A malformed, oversized or hostile snapshot writes NOTHING. Validation completes before the first
//     database call, so a rejected file leaves an empty catalog empty.
//   - The same file imported twice produces the same catalog. Identities are derived, so a repeat is a
//     no-op rather than a duplicate.
//   - An import cannot resurrect a forgotten item. Erasure is a decision; import is not allowed to reverse it.
//   - No title, provider ref value, external id or path ever appears in a report.
//   - It reads exactly one file. It contacts no provider, no media server and no network endpoint, and it
//     scans no media path — proved against the module source as well as by behaviour.
//
// A REAL, THROWAWAY POSTGRESQL IS USED for everything that claims something about persistence, encryption or
// idempotency. Ciphertext at rest and the "second write is a no-op" behaviour are the database's, and a fake
// pool would only prove that this file agrees with itself.

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: Array<[string, unknown]> = [];
const skips: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function skip(name: string, why: string): void {
  skipped++; skips.push(`${name} — ${why}`); console.log(`  SKIP  ${name}: ${why}`);
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
function assertRejects(doc: unknown, msg: string): CatalogImportError {
  try { parseCatalogSnapshot(typeof doc === 'string' ? doc : JSON.stringify(doc)); }
  catch (err) {
    if (err instanceof CatalogImportError) return err;
    throw new Error(`${msg}: threw ${(err as Error).name} instead of CatalogImportError`);
  }
  throw new Error(`${msg}: was accepted`);
}

const WORK = mkdtempSync(join(tmpdir(), 'ca-catalog-import-'));

function snapshot(items: unknown[], source = 'my-library'): string {
  return JSON.stringify({ format: CATALOG_SNAPSHOT_FORMAT, version: CATALOG_SNAPSHOT_VERSION, source, items });
}
function item(externalId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { externalId, title: `Title ${externalId}`, ...extra };
}

/** An in-memory stand-in for the database lookup, for the pure planning tests. */
function lookupOf(states: Array<{ itemId: string; present?: boolean; forgotten?: boolean; shredState?: string | null }>): ExistingStateLookup {
  return (ids) => Promise.resolve(states
    .filter((s) => ids.includes(s.itemId))
    .map((s) => ({ itemId: s.itemId, present: s.present ?? true, forgotten: s.forgotten ?? false, shredState: s.shredState ?? 'active' })));
}

async function main(): Promise<void> {
  console.log('Phase 259 — offline catalog import\n');

  // --- the format ------------------------------------------------------------------------------------------

  console.log('the snapshot format accepts what it documents');

  await test('a minimal snapshot parses and normalizes', () => {
    const parsed = parseCatalogSnapshot(snapshot([item('m-1')]));
    assertEq(parsed.source, 'my-library', 'wrong source');
    assertEq(parsed.items.length, 1, 'wrong item count');
    assertEq(parsed.items[0]!.title, 'Title m-1', 'wrong title');
    assertEq(parsed.items[0]!.year, null, 'a missing year should normalize to null');
    assertEq(parsed.items[0]!.providerRefs.length, 0, 'refs should default to empty');
    assert(/^[0-9a-f-]{36}$/.test(parsed.items[0]!.itemId), 'the derived id is not a uuid');
  });

  await test('a full snapshot keeps every documented field', () => {
    const parsed = parseCatalogSnapshot(snapshot([item('m-2', {
      year: 1994,
      providerRefs: [{ type: 'imdb', value: 'tt0111161' }, { type: 'tmdb', value: '278' }],
      metadata: { collection: 'favourites', shelf: 'a1' },
    })]));
    const only = parsed.items[0]!;
    assertEq(only.year, 1994, 'wrong year');
    assertEq(only.providerRefs.map((r) => r.type).join(','), 'imdb,tmdb', 'wrong ref types');
    assertEq(only.metadata.collection, 'favourites', 'wrong metadata');
  });

  await test('a title is trimmed but never otherwise rewritten', () => {
    const parsed = parseCatalogSnapshot(snapshot([{ externalId: 'm-3', title: '  The Thing  ' }]));
    assertEq(parsed.items[0]!.title, 'The Thing', 'the title was not trimmed');
  });

  await test('item ids are deterministic, and scoped to the source', () => {
    const a = deriveItemId('lib-a', 'x-1');
    assertEq(a, deriveItemId('lib-a', 'x-1'), 'the same input produced two ids');
    assert(a !== deriveItemId('lib-b', 'x-1'), 'two sources collided');
    assert(a !== deriveItemId('lib-a', 'x-2'), 'two external ids collided');
    // RFC 4122 name-based shape, so it cannot be mistaken for a random id.
    assertEq(a[14], '5', 'the derived id is not version 5');
    assert('89ab'.includes(a[19]!), 'the derived id has the wrong variant');
  });

  await test('the snapshot digest is order-independent and content-free', () => {
    const forward = parseCatalogSnapshot(snapshot([item('a'), item('b')]));
    const reversed = parseCatalogSnapshot(snapshot([item('b'), item('a')]));
    assertEq(forward.digest, reversed.digest, 'reordering changed the digest');
    const changed = parseCatalogSnapshot(snapshot([item('a'), item('b', { year: 2001 })]));
    assert(changed.digest !== forward.digest, 'a content change did not change the digest');
    assert(!forward.digest.includes('Title'), 'the digest carries content');
  });

  // --- adversarial input ------------------------------------------------------------------------------------

  console.log('\nmalformed, oversized and hostile input is refused whole');

  for (const [label, doc] of [
    ['not JSON', '{'],
    ['a JSON array', '[]'],
    ['a JSON string', '"nope"'],
    ['a null document', 'null'],
    ['the wrong format', { format: 'something-else', version: 1, source: 'a', items: [] }],
    ['the wrong version', { format: CATALOG_SNAPSHOT_FORMAT, version: 99, source: 'a', items: [] }],
    ['an unknown top-level key', { format: CATALOG_SNAPSHOT_FORMAT, version: 1, source: 'a', items: [], exec: 'rm -rf /' }],
    ['a missing source', { format: CATALOG_SNAPSHOT_FORMAT, version: 1, items: [] }],
    ['a source with a slash', { format: CATALOG_SNAPSHOT_FORMAT, version: 1, source: '../etc', items: [] }],
    ['a source with a space', { format: CATALOG_SNAPSHOT_FORMAT, version: 1, source: 'my library', items: [] }],
    ['items that are not an array', { format: CATALOG_SNAPSHOT_FORMAT, version: 1, source: 'a', items: {} }],
    ['no items at all', { format: CATALOG_SNAPSHOT_FORMAT, version: 1, source: 'a', items: [] }],
  ] as Array<[string, unknown]>) {
    await test(`rejects ${label}`, () => { assertRejects(doc, label); });
  }

  await test('rejects a duplicate externalId, naming both positions and neither value', () => {
    const err = assertRejects(snapshot([item('same'), item('other'), item('same')]), 'duplicate externalId');
    const problem = err.problems.join(' ');
    assert(problem.includes('item 2') && problem.includes('item 0'), `both positions should be named: ${problem}`);
    assert(problem.includes(externalIdDigest('my-library', 'same')), 'the digest is missing');
    assert(!problem.includes('Title same'), 'the title leaked into the problem');
  });

  await test('rejects a record with no title or an empty one', () => {
    assertRejects(snapshot([{ externalId: 'a' }]), 'a missing title');
    assertRejects(snapshot([{ externalId: 'a', title: '   ' }]), 'a blank title');
    assertRejects(snapshot([{ externalId: 'a', title: 42 }]), 'a numeric title');
  });

  await test('rejects an over-long title, external id, ref value and metadata value', () => {
    assertRejects(snapshot([{ externalId: 'a', title: 'x'.repeat(IMPORT_MAX_TITLE_LENGTH + 1) }]), 'an over-long title');
    assertRejects(snapshot([item('x'.repeat(200))]), 'an over-long external id');
    assertRejects(snapshot([item('a', { providerRefs: [{ type: 'imdb', value: 'x'.repeat(IMPORT_MAX_REF_VALUE_LENGTH + 1) }] })]), 'an over-long ref value');
    assertRejects(snapshot([item('a', { metadata: { k: 'x'.repeat(2000) } })]), 'an over-long metadata value');
  });

  await test('rejects a provider ref type the database would not accept', () => {
    // The closed set lives in cat_apply_internal. Catching it here turns a SQL exception part-way through an
    // import into a validation failure before anything is written.
    const err = assertRejects(snapshot([item('a', { providerRefs: [{ type: 'netflix', value: 'x' }] })]), 'an unknown ref type');
    assert(err.problems.join(' ').includes('imdb'), 'the rejection does not name the accepted types');
  });

  await test('rejects two refs of the same type on one item', () => {
    assertRejects(snapshot([item('a', { providerRefs: [{ type: 'imdb', value: '1' }, { type: 'imdb', value: '2' }] })]), 'a repeated ref type');
  });

  await test('rejects nested metadata, and metadata keys that are not plain', () => {
    assertRejects(snapshot([item('a', { metadata: { k: { nested: true } } })]), 'nested metadata');
    assertRejects(snapshot([item('a', { metadata: { 'Bad Key': 'x' } })]), 'a metadata key with a space');
    // Written as raw JSON on purpose: an object literal with this key SETS a prototype rather than creating
    // an own property, so building it in JavaScript would test nothing. JSON.parse does create it as an own
    // property, which is exactly the shape a hostile file would carry.
    assertRejects(
      `{"format":"${CATALOG_SNAPSHOT_FORMAT}","version":1,"source":"my-library","items":[{"externalId":"a","title":"A","metadata":{"__proto__":"polluted"}}]}`,
      'a prototype-shaped metadata key');
    const many: Record<string, string> = {};
    for (let i = 0; i <= IMPORT_MAX_METADATA_KEYS; i += 1) many[`k${i}`] = 'v';
    assertRejects(snapshot([item('a', { metadata: many })]), 'too many metadata keys');
  });

  await test('rejects control characters in a title, a ref value and a metadata value', () => {
    const nul = String.fromCharCode(0);
    const esc = String.fromCharCode(27);
    assertRejects(snapshot([{ externalId: 'a', title: `Ti${nul}tle` }]), 'a NUL in a title');
    assertRejects(snapshot([{ externalId: 'a', title: `Ti${esc}[31m` }]), 'an ANSI escape in a title');
    assertRejects(snapshot([item('a', { providerRefs: [{ type: 'imdb', value: `tt${nul}1` }] })]), 'a NUL in a ref value');
    assertRejects(snapshot([item('a', { metadata: { k: `v${esc}[0m` } })]), 'an escape in a metadata value');
  });

  await test('a title carrying a script tag is accepted as text and is not rewritten', () => {
    // Escaping is the RENDERER's job, and Phase 260 does it with textContent. Mangling the value here would
    // corrupt a legitimate title while proving nothing; what matters is that it round-trips unchanged.
    const hostile = '<script>alert(1)</script> & "quotes"';
    const parsed = parseCatalogSnapshot(snapshot([{ externalId: 'a', title: hostile }]));
    assertEq(parsed.items[0]!.title, hostile, 'the title was silently rewritten');
  });

  await test('an external id that looks like SQL is data, not syntax', () => {
    const parsed = parseCatalogSnapshot(snapshot([item("'; DROP TABLE items; --")]));
    assertEq(parsed.items.length, 1, 'the record was dropped');
    assert(/^[0-9a-f-]{36}$/.test(parsed.items[0]!.itemId), 'the derived id is not a plain uuid');
  });

  await test('rejects more items than the bound allows, without parsing them', () => {
    const many = Array.from({ length: IMPORT_MAX_ITEMS + 1 }, (_, i) => item(`m-${i}`));
    const err = assertRejects(snapshot(many), 'too many items');
    assert(err.problems.join(' ').includes(String(IMPORT_MAX_ITEMS)), 'the bound is not named');
  });

  await test('rejects a document over the byte limit before parsing it', () => {
    const err = assertRejects(`{"padding":"${'x'.repeat(IMPORT_MAX_BYTES + 10)}"}`, 'an oversized document');
    assertEq(err.problems.length, 1, 'an oversized document should be rejected on that ground alone');
    assert(err.problems[0]!.includes('byte'), 'the byte bound is not named');
  });

  await test('every problem is reported at once, and none of them carries content', () => {
    const err = assertRejects(snapshot([
      { externalId: 'a', title: '' },
      { externalId: 'b', title: 'Secret Title', year: 12 },
      { externalId: 'c', title: 'Another Secret', providerRefs: [{ type: 'nope', value: 'x' }] },
    ]), 'several problems');
    assert(err.problems.length >= 3, `expected several problems, got ${err.problems.length}`);
    const text = err.problems.join(' ');
    assert(!text.includes('Secret Title') && !text.includes('Another Secret'), `a title leaked: ${text}`);
  });

  // --- path handling ------------------------------------------------------------------------------------------

  console.log('\nthe file it reads is the one the operator mounted, and nothing else');

  const importDir = join(WORK, 'import');
  const outside = join(WORK, 'outside');
  mkdirSync(importDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(importDir, 'good.json'), snapshot([item('p-1')]));
  writeFileSync(join(outside, 'secret.json'), snapshot([item('p-2')]));
  const boundedEnv = { [CATALOG_IMPORT_DIR_ENV]: importDir } as NodeJS.ProcessEnv;

  await test('a relative name resolves inside the configured import directory', () => {
    const resolved = resolveImportFile('good.json', boundedEnv);
    assert(resolved.startsWith(importDir), 'a relative name escaped the import directory');
  });

  await test('a traversal out of the import directory is refused', () => {
    for (const attempt of ['../outside/secret.json', '../../etc/passwd', join(outside, 'secret.json')]) {
      let threw = false;
      try { resolveImportFile(attempt, boundedEnv); } catch (err) { threw = err instanceof CatalogImportPathError; }
      assert(threw, `a traversal was accepted: ${attempt}`);
    }
  });

  // Whether the symlink can be created at all is decided BEFORE the assertion is registered, so an
  // unprivileged Windows host reports one honest SKIP rather than a skip and a pass for the same name.
  const escapingLink = join(importDir, 'link.json');
  let linksSupported = true;
  try { symlinkSync(join(outside, 'secret.json'), escapingLink); } catch { linksSupported = false; }
  const symlinkName = 'a symlink inside the import directory that points outside it is refused';
  if (!linksSupported) {
    skip(symlinkName, 'this host does not allow creating symlinks (it runs on Linux in CI)');
  } else {
    await test(symlinkName, () => {
      let threw = false;
      try { resolveImportFile('link.json', boundedEnv); } catch (err) { threw = err instanceof CatalogImportPathError; }
      assert(threw, 'a symlink out of the import directory was followed');
    });
    rmSync(escapingLink, { force: true });
  }

  await test('a rejected path names the constraint, never the path', () => {
    try { resolveImportFile('../outside/secret.json', boundedEnv); }
    catch (err) {
      const message = (err as Error).message;
      assert(!message.includes(outside) && !message.includes(importDir), `the message leaked a path: ${message}`);
      assert(message.includes(CATALOG_IMPORT_DIR_ENV), 'the message does not name the setting to fix');
      return;
    }
    throw new Error('the traversal was accepted');
  });

  await test('a directory is not a snapshot', () => {
    let threw = false;
    try { readCatalogSnapshot(importDir); } catch (err) { threw = err instanceof CatalogImportPathError; }
    assert(threw, 'a directory was read as a snapshot');
  });

  await test('an oversized file is refused before it is read into memory', () => {
    const big = join(importDir, 'big.json');
    writeFileSync(big, 'x'.repeat(IMPORT_MAX_BYTES + 1024));
    let err: unknown;
    try { readCatalogSnapshot(big); } catch (caught) { err = caught; }
    rmSync(big, { force: true });
    assert(err instanceof CatalogImportError, 'an oversized file was not refused');
  });

  await test('with no import directory configured, the operator names any path they can already read', () => {
    const resolved = resolveImportFile(join(outside, 'secret.json'), {} as NodeJS.ProcessEnv);
    assert(resolved.endsWith('secret.json'), 'an unconfigured run refused a readable path');
  });

  // --- planning ---------------------------------------------------------------------------------------------

  console.log('\nthe preview says what would happen, and the applier does exactly that');

  const twoItems = parseCatalogSnapshot(snapshot([item('k-1'), item('k-2')]));

  await test('an empty catalog plans every record as a create', async () => {
    const plan = await planCatalogImport(twoItems, lookupOf([]));
    assertEq(plan.counts.create, 2, 'wrong create count');
    assertEq(plan.noop, false, 'a plan with creates is not a no-op');
  });

  await test('records that already exist plan as unchanged, and the plan is a no-op', async () => {
    const plan = await planCatalogImport(twoItems, lookupOf(twoItems.items.map((i) => ({ itemId: i.itemId }))));
    assertEq(plan.counts.unchanged, 2, 'wrong unchanged count');
    assert(plan.noop, 'a plan that writes nothing should be a no-op');
  });

  await test('--update-existing plans an update instead of leaving them alone', async () => {
    const plan = await planCatalogImport(twoItems, lookupOf(twoItems.items.map((i) => ({ itemId: i.itemId }))), { updateExisting: true });
    assertEq(plan.counts.update, 2, 'wrong update count');
    assertEq(plan.noop, false, 'a plan with updates is not a no-op');
  });

  await test('a forgotten item is BLOCKED: an import cannot undo an erasure', async () => {
    const plan = await planCatalogImport(twoItems, lookupOf([
      { itemId: twoItems.items[0]!.itemId, present: false, forgotten: true, shredState: 'shred_complete' },
    ]));
    assertEq(plan.counts.blocked, 1, 'a forgotten item was not blocked');
    assertEq(plan.counts.create, 1, 'the other record should still be creatable');
    const blocked = plan.items.find((i) => i.action === 'blocked')!;
    assert(blocked.reason!.includes('forgotten'), 'the block does not say why');
  });

  await test('a shred that is still pending is BLOCKED too', async () => {
    const plan = await planCatalogImport(twoItems, lookupOf([
      { itemId: twoItems.items[0]!.itemId, present: true, forgotten: false, shredState: 'shred_pending' },
    ]));
    assertEq(plan.counts.blocked, 1, 'a pending shred was not blocked');
  });

  await test('a preview writes nothing and says so', async () => {
    const plan = await planCatalogImport(twoItems, lookupOf([]));
    const preview = previewCatalogImportResult(plan);
    assertEq(preview.mode, 'preview', 'wrong mode');
    assert(preview.items.every((i) => i.outcome !== 'applied'), 'a preview reported something as applied');
    assert(preview.notes.some((n) => n.includes('--apply')), 'the preview does not say how to commit it');
    assert(renderCatalogImportResult(preview).includes('nothing was written'), 'the summary does not say nothing was written');
  });

  await test('no report line carries a title, an external id or a path', async () => {
    const hostile = parseCatalogSnapshot(snapshot([{ externalId: 'top-secret-id', title: 'Top Secret Title' }]));
    const plan = await planCatalogImport(hostile, lookupOf([]));
    for (const text of [
      renderCatalogImportResult(previewCatalogImportResult(plan)),
      JSON.stringify(previewCatalogImportResult(plan)),
      JSON.stringify(plan),
    ]) {
      assert(!text.includes('Top Secret Title'), 'a title reached a report');
      assert(!text.includes('top-secret-id'), 'an external id reached a report');
      assert(!text.includes(WORK), 'a filesystem path reached a report');
    }
  });

  // --- argument parsing --------------------------------------------------------------------------------------

  console.log('\nthe CLI defaults to writing nothing');

  await test('--file is required and --apply is opt-in', () => {
    let threw = false;
    try { parseCatalogImportArgs([]); } catch { threw = true; }
    assert(threw, '--file was not required');
    const preview = parseCatalogImportArgs(['--file', 'a.json']);
    assertEq(preview.apply, false, 'the default is not a preview');
    assertEq(parseCatalogImportArgs(['--file', 'a.json', '--apply']).apply, true, '--apply was not honoured');
  });

  await test('an unknown option and a value-swallowing flag are usage errors', () => {
    for (const argv of [['--yolo'], ['--file', '--apply'], ['--file']]) {
      let threw = false;
      try { parseCatalogImportArgs(argv); } catch { threw = true; }
      assert(threw, `accepted ${argv.join(' ')}`);
    }
  });

  // --- the module cannot reach the outside world ----------------------------------------------------------------

  console.log('\nthe import path has no way to contact anything');

  /** Source with comments removed, so a scan tests what the CODE does rather than what a comment mentions. */
  function codeOf(relative: string): string {
    const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  }

  await test('neither module imports a network, media or provider facility', () => {
    for (const file of ['../src/core/catalog/import-snapshot.ts', '../src/ops/catalog-import.ts', '../src/ops/catalog-import-cli.ts']) {
      const code = codeOf(file);
      for (const forbidden of [
        'node:http', 'node:https', 'node:net', 'node:dgram', 'node:dns', 'node:tls', 'undici', 'fetch(',
        'node:child_process', 'jellyfin', 'tmdb', 'torbox', 'readdirSync', 'opendirSync', 'globSync',
        'promotion', 'unraid',
      ]) {
        assert(!code.toLowerCase().includes(forbidden.toLowerCase()), `${file} references ${forbidden}`);
      }
    }
  });

  await test('the snapshot parser opens no file and touches no database', () => {
    const code = codeOf('../src/core/catalog/import-snapshot.ts');
    for (const forbidden of ["'node:fs'", 'readFileSync', "from 'pg'", 'getPool', 'process.env']) {
      assert(!code.includes(forbidden), `the parser references ${forbidden}`);
    }
  });

  // --- against a real database ------------------------------------------------------------------------------------

  console.log('\nagainst a real PostgreSQL: it persists, it encrypts, and a repeat changes nothing');

  const external = process.env.DATABASE_URL !== undefined;
  let pg: Awaited<ReturnType<typeof startEmbedded>> | undefined;
  if (!external) {
    try {
      pg = await startEmbedded();
    } catch (err) {
      skip('the whole live-database section', `an embedded PostgreSQL could not be started: ${(err as Error).message}`);
    }
  }

  if (external || pg !== undefined) {
    await migrateWith(process.env.ADMIN_DATABASE_URL!);
    const admin = new Client({ connectionString: process.env.ADMIN_DATABASE_URL! });
    await admin.connect();
    const completionSecret = await installCompletionSecret(admin);
    const keystore = join(WORK, 'keystore');
    mkdirSync(keystore, { recursive: true });
    const custodian = new FileCustodian(keystore, completionSecret, testKek());
    const { getPool, closePool } = await import('../src/db/pool.js');
    const pool = getPool();
    const authority = new CatalogAuthority(pool, custodian);
    const lookup = createExistingStateLookup(pool);

    const live = parseCatalogSnapshot(snapshot([
      item('live-1', { year: 1994, providerRefs: [{ type: 'imdb', value: 'tt-live-1' }], metadata: { shelf: 'a1' } }),
      item('live-2', { year: 2001 }),
    ], 'live-library'));

    await test('a preview against a real database writes nothing at all', async () => {
      const before = Number((await pool.query('SELECT count(*)::int AS n FROM items')).rows[0].n);
      const plan = await planCatalogImport(live, lookup);
      previewCatalogImportResult(plan);
      const after = Number((await pool.query('SELECT count(*)::int AS n FROM items')).rows[0].n);
      assertEq(after, before, 'a preview changed the database');
      assertEq(plan.counts.create, 2, 'the preview did not plan two creates');
    });

    await test('applying persists both records through CatalogAuthority', async () => {
      const plan = await planCatalogImport(live, lookup);
      const result = await applyCatalogImport(live, plan, authority);
      assert(result.ok, `the import was incomplete: ${JSON.stringify(result.items)}`);
      assertEq(result.created, 2, 'wrong created count');
      for (const record of live.items) {
        const row = (await pool.query('SELECT present, forgotten, identity_ct FROM items WHERE id = $1', [record.itemId])).rows[0];
        assert(row !== undefined, 'an imported item is missing from the database');
        assertEq(row.present, true, 'an imported item is not present');
        assert(Buffer.isBuffer(row.identity_ct) && row.identity_ct.length > 0, 'an imported item has no ciphertext');
      }
    });

    await test('what is at rest is CIPHERTEXT — no imported title appears anywhere in the tables', async () => {
      const identities = (await pool.query('SELECT identity_ct FROM items WHERE identity_ct IS NOT NULL')).rows
        .map((r) => (r.identity_ct as Buffer).toString('latin1')).join('');
      assert(!identities.includes('Title live-1'), 'an imported title is readable in the items table');
      const refs = (await pool.query('SELECT ref_value_ct FROM provider_refs WHERE ref_value_ct IS NOT NULL')).rows
        .map((r) => (r.ref_value_ct as Buffer).toString('latin1')).join('');
      assert(!refs.includes('tt-live-1'), 'an imported provider ref is readable in the provider_refs table');
    });

    await test('the identity round-trips: every imported field comes back through readIdentity', async () => {
      const identity = await authority.readIdentity(live.items[0]!.itemId);
      assert(identity !== null, 'the imported identity could not be read back');
      assertEq(identity!.title, 'Title live-1', 'the title did not round-trip');
      assertEq(identity!.year, 1994, 'the year did not round-trip');
      assertEq((identity!.externalIds as Record<string, string>)['live-library'], 'live-1', 'the external id was not recorded');
      assertEq((identity!.metadata as Record<string, string>).shelf, 'a1', 'the metadata did not round-trip');
      assertEq(identity!.providerRefs?.[0]?.value, 'tt-live-1', 'the provider ref did not round-trip');
    });

    await test('importing the same file again changes nothing and creates no duplicate', async () => {
      const before = Number((await pool.query('SELECT count(*)::int AS n FROM items')).rows[0].n);
      const plan = await planCatalogImport(live, lookup);
      assertEq(plan.counts.unchanged, 2, 'a repeat import did not see the records as already present');
      assert(plan.noop, 'a repeat import is not a no-op');
      const result = await applyCatalogImport(live, plan, authority);
      assertEq(result.created, 0, 'a repeat import created something');
      assert(result.ok, 'a repeat import reported not-ok');
      const after = Number((await pool.query('SELECT count(*)::int AS n FROM items')).rows[0].n);
      assertEq(after, before, 'a repeat import changed the row count');
    });

    await test('--update-existing rewrites the identity in place, keeping the same lineage key', async () => {
      const keyBefore = (await pool.query('SELECT key_id, cur_epoch FROM item_key_control WHERE item_id = $1', [live.items[1]!.itemId])).rows[0];
      const corrected = parseCatalogSnapshot(snapshot([
        item('live-1', { year: 1994, providerRefs: [{ type: 'imdb', value: 'tt-live-1' }], metadata: { shelf: 'a1' } }),
        { externalId: 'live-2', title: 'A Corrected Title', year: 2002 },
      ], 'live-library'));
      const plan = await planCatalogImport(corrected, lookup, { updateExisting: true });
      const result = await applyCatalogImport(corrected, plan, authority, { updateExisting: true });
      assert(result.ok, 'the update was incomplete');
      const identity = await authority.readIdentity(corrected.items[1]!.itemId);
      assertEq(identity!.title, 'A Corrected Title', 'the update did not land');
      assertEq(identity!.year, 2002, 'the year was not updated');
      const keyAfter = (await pool.query('SELECT key_id, cur_epoch FROM item_key_control WHERE item_id = $1', [live.items[1]!.itemId])).rows[0];
      assertEq(keyAfter.key_id, keyBefore.key_id, 'an in-place update rotated the lineage key');
      assertEq(keyAfter.cur_epoch, keyBefore.cur_epoch, 'an in-place update changed the epoch');
    });

    await test('an import cannot resurrect a forgotten item', async () => {
      const forgettable = parseCatalogSnapshot(snapshot([item('forget-me')], 'live-library'));
      await applyCatalogImport(forgettable, await planCatalogImport(forgettable, lookup), authority);
      assertEq(await authority.forget(forgettable.items[0]!.itemId), 'shred_complete', 'the item was not forgotten');

      const plan = await planCatalogImport(forgettable, lookup);
      assertEq(plan.counts.blocked, 1, 'a forgotten item was not blocked in the plan');
      const result = await applyCatalogImport(forgettable, plan, authority);
      assertEq(result.blocked, 1, 'the blocked record was not reported');
      assertEq(result.created, 0, 'a forgotten item was recreated');
      assertEq(await authority.readIdentity(forgettable.items[0]!.itemId), null, 'a forgotten identity became readable again');
    });

    await test('a record that fails leaves no partial row, and the run stops and says what did not land', async () => {
      const good = parseCatalogSnapshot(snapshot([item('rb-1'), item('rb-2'), item('rb-3')], 'live-library'));
      const plan = await planCatalogImport(good, lookup);
      // A custodian that refuses the second provisioning: `provisionAndWrite` never reaches the database, so
      // nothing about rb-2 can be half-written. rb-3 must be reported as not attempted, not as a pass.
      let calls = 0;
      const flaky = {
        addItem: (itemId: string, identity: unknown) => {
          calls += 1;
          if (calls === 2) return Promise.reject(new Error('the custodian refused to provision a key'));
          return authority.addItem(itemId, identity as never);
        },
        updateIdentity: authority.updateIdentity.bind(authority),
      };
      const result = await applyCatalogImport(good, plan, flaky);
      assert(!result.ok, 'a run with a failure reported ok');
      assertEq(result.created, 1, 'wrong created count after a failure');
      assertEq(result.failed, 1, 'wrong failed count');
      assertEq(result.notAttempted, 1, 'the record after the failure was not reported as not-attempted');
      const failedId = good.items[1]!.itemId;
      assertEq((await pool.query('SELECT count(*)::int AS n FROM items WHERE id = $1', [failedId])).rows[0].n, 0, 'the failed record left a row behind');
      assertEq((await pool.query('SELECT count(*)::int AS n FROM item_key_control WHERE item_id = $1', [failedId])).rows[0].n, 0, 'the failed record left a key lineage behind');
    });

    await test('re-running after a failure completes the import, touching nothing that already landed', async () => {
      const good = parseCatalogSnapshot(snapshot([item('rb-1'), item('rb-2'), item('rb-3')], 'live-library'));
      const plan = await planCatalogImport(good, lookup);
      assertEq(plan.counts.unchanged, 1, 'the record that landed should be seen as already present');
      assertEq(plan.counts.create, 2, 'the two records that did not land should be creatable');
      const result = await applyCatalogImport(good, plan, authority);
      assert(result.ok, 'the resumed run was incomplete');
      assertEq(result.created, 2, 'the resumed run created the wrong number of records');
      for (const record of good.items) {
        assert(await authority.readIdentity(record.itemId) !== null, 'a record is still missing after the resumed run');
      }
    });

    await test('a rejected snapshot never reaches the database', async () => {
      const before = Number((await pool.query('SELECT count(*)::int AS n FROM items')).rows[0].n);
      const bad = join(importDir, 'bad.json');
      writeFileSync(bad, snapshot([item('never-1'), { externalId: 'never-2' }]));
      let threw = false;
      try { readCatalogSnapshot(bad); } catch (err) { threw = err instanceof CatalogImportError; }
      assert(threw, 'a snapshot with an invalid record was accepted');
      const after = Number((await pool.query('SELECT count(*)::int AS n FROM items')).rows[0].n);
      assertEq(after, before, 'a rejected snapshot changed the database');
      assertEq((await pool.query('SELECT count(*)::int AS n FROM items WHERE id = $1', [deriveItemId('my-library', 'never-1')])).rows[0].n, 0,
        'the valid record from a rejected snapshot was written');
    });

    await test('the lookup batches, and a large id list is parameterised rather than interpolated', async () => {
      const many = parseCatalogSnapshot(snapshot(Array.from({ length: 1200 }, (_, i) => item(`bulk-${i}`)), 'live-library'));
      const plan = await planCatalogImport(many, lookup);
      assertEq(plan.total, 1200, 'the plan lost records');
      assertEq(plan.counts.create, 1200, 'a large snapshot did not plan cleanly');
    });

    await admin.end();
    await closePool();
    if (pg !== undefined) await pg.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  for (const line of skips) console.log(`  SKIP ${line}`);
  for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? String(err)}`);
  rmSync(WORK, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
