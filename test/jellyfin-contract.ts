import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FakeJellyfinClient } from '../src/core/adapters/jellyfin/fake-client.js';
import { JellyfinPublisher } from '../src/core/adapters/jellyfin/publisher.js';
import { JellyfinRevoker } from '../src/core/adapters/jellyfin/revoker.js';
import { createJellyfinAdapters } from '../src/core/adapters/jellyfin/factory.js';
import { loadJellyfinConfig, registerJellyfinSecret, describeJellyfinConfig } from '../src/core/adapters/jellyfin/config.js';
import { SecretStore } from '../src/core/secrets/secret-store.js';
import { ConfigError, type Env } from '../src/config/env.js';
import type { PublishableIdentity } from '../src/core/adapters/publisher.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];
const tmpDirs: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }

const ID = '00000000-0000-0000-0000-000000000000';
const identity = (refs: Array<{ type: string; value: string }>, title = 'My Movie'): PublishableIdentity => ({ itemId: ID, title, providerRefs: refs });

async function main(): Promise<void> {
  console.log('Running Phase 10 Jellyfin contract + config suite (Stage 10.4):\n');

  // --- fake client ------------------------------------------------------------
  await test('FakeJellyfinClient — matches library refs; create/delete collection is deterministic', async () => {
    const c = new FakeJellyfinClient({ 'tmdb:603': 'item-a', 'imdb:tt0133093': 'item-b' });
    assertEq((await c.findItemsByRefs([{ type: 'tmdb', value: '603' }])).join(','), 'item-a', 'matched tmdb');
    assertEq((await c.findItemsByRefs([{ type: 'tmdb', value: 'nope' }])).length, 0, 'unmatched dropped');
    const h1 = await c.createCollection('X', ['item-a']);
    const h2 = await c.createCollection('Y', ['item-b']);
    assertEq(h1, 'jf-col-1', 'deterministic id'); assertEq(h2, 'jf-col-2', 'deterministic id');
    assert(c.hasCollection(h1), 'stored'); assertEq(await c.deleteCollection(h1), 'deleted', 'deleted');
    assertEq(await c.deleteCollection(h1), 'not_found', 'already gone -> not_found');
  });

  // --- publisher: minimization + deterministic no-match -----------------------
  await test('JellyfinPublisher — declares exactly [title, providerRefs]', () => {
    assertEq([...new JellyfinPublisher(new FakeJellyfinClient()).requires].sort().join(','), 'providerRefs,title', 'minimized field set');
  });
  await test('JellyfinPublisher — no refs / all-unmatched -> skipped, NO handle', async () => {
    const pub = new JellyfinPublisher(new FakeJellyfinClient({ 'tmdb:1': 'a' }));
    const none = await pub.publish({ identity: identity([]), dryRun: false });
    assertEq(none.status, 'skipped', 'no refs -> skipped'); assertEq(none.handle, undefined, 'no handle');
    const miss = await pub.publish({ identity: identity([{ type: 'tmdb', value: '999' }]), dryRun: false });
    assertEq(miss.status, 'skipped', 'all-unmatched -> skipped'); assertEq(miss.handle, undefined, 'no handle');
    assert(/0\/1/.test(miss.detail ?? ''), 'detail reports 0/1 matched');
  });
  await test('JellyfinPublisher — dry-run with matches -> skipped, NO handle, counts in detail', async () => {
    const client = new FakeJellyfinClient({ 'tmdb:603': 'a' });
    const r = await new JellyfinPublisher(client).publish({ identity: identity([{ type: 'tmdb', value: '603' }]), dryRun: true });
    assertEq(r.status, 'skipped', 'dry-run -> skipped'); assertEq(r.handle, undefined, 'no handle');
    assert(/1\/1/.test(r.detail ?? ''), 'counts'); assertEq(client.collectionCount(), 0, 'no collection created on dry-run');
  });
  await test('JellyfinPublisher — live partial match -> published matched-only, handle, counts', async () => {
    const client = new FakeJellyfinClient({ 'tmdb:603': 'a' }); // imdb ref will NOT match
    const r = await new JellyfinPublisher(client).publish({ identity: identity([{ type: 'tmdb', value: '603' }, { type: 'imdb', value: 'tt999' }], 'Matrix'), dryRun: false });
    assertEq(r.status, 'published', 'published'); assert(typeof r.handle === 'string', 'handle');
    assert(/1\/2/.test(r.detail ?? ''), 'partial counts 1/2');
    const col = client.getCollection(r.handle!);
    assertEq(col?.name, 'Matrix', 'collection named by title'); assertEq(col?.itemIds.join(','), 'a', 'MATCHED items only');
  });

  // --- revoker: opaque handle only --------------------------------------------
  await test('JellyfinRevoker — revokes by opaque collection id; unknown -> not_found', async () => {
    const client = new FakeJellyfinClient({ 'tmdb:1': 'a' });
    const handle = await client.createCollection('C', ['a']);
    const rev = new JellyfinRevoker(client);
    assertEq((await rev.revoke(handle)).status, 'revoked', 'revoked'); assert(!client.hasCollection(handle), 'deleted');
    assertEq((await rev.revoke('jf-col-nope')).status, 'not_found', 'unknown handle -> not_found');
  });

  // --- factory: pure wiring ---------------------------------------------------
  await test('createJellyfinAdapters — wires publisher + revoker over the injected client', () => {
    const { publisher, revoker } = createJellyfinAdapters(new FakeJellyfinClient());
    assertEq(publisher.describe().name, 'jellyfin', 'publisher'); assertEq(revoker.describe().kind, 'revoker', 'revoker');
  });

  // --- config parser: fail-closed + redaction-safe ----------------------------
  await test('loadJellyfinConfig — unconfigured -> null; full config parses', () => {
    assertEq(loadJellyfinConfig({} as Env), null, 'unset -> null');
    const cfg = loadJellyfinConfig({ JELLYFIN_BASE_URL: 'http://jf.local:8096', JELLYFIN_API_KEY: 'k' } as Env);
    assert(cfg !== null && cfg.baseUrl === 'http://jf.local:8096' && cfg.apiKey === 'k', 'parsed');
  });
  await test('loadJellyfinConfig — partial/invalid config throws ConfigError (no key value leaked)', () => {
    try { loadJellyfinConfig({ JELLYFIN_BASE_URL: 'http://jf.local' } as Env); assert(false, 'should throw'); }
    catch (e) { assert(e instanceof ConfigError, 'base-only -> ConfigError'); }
    try { loadJellyfinConfig({ JELLYFIN_API_KEY: 'SECRET-KEY' } as Env); assert(false, 'should throw'); }
    catch (e) { assert(e instanceof ConfigError && !(e as Error).message.includes('SECRET-KEY'), 'key-only -> ConfigError, key not leaked'); }
    try { loadJellyfinConfig({ JELLYFIN_BASE_URL: 'not-a-url', JELLYFIN_API_KEY: 'SECRET-KEY' } as Env); assert(false, 'should throw'); }
    catch (e) { assert(e instanceof ConfigError && !(e as Error).message.includes('SECRET-KEY'), 'bad url -> ConfigError, key not leaked'); }
  });
  await test('loadJellyfinConfig — api key via *_FILE indirection', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jf-')); tmpDirs.push(dir);
    const f = path.join(dir, 'key'); writeFileSync(f, 'file-key-123\n');
    const cfg = loadJellyfinConfig({ JELLYFIN_BASE_URL: 'http://jf.local', JELLYFIN_API_KEY_FILE: f } as Env);
    assert(cfg !== null && cfg.apiKey === 'file-key-123', 'api key read from *_FILE (trimmed)');
  });
  await test('config — api key is redaction-safe (SecretStore + describe never leaks it)', () => {
    const cfg = { baseUrl: 'http://jf.local', apiKey: 'SUPER-SECRET-KEY' };
    assert(!describeJellyfinConfig(cfg).includes('SUPER-SECRET-KEY'), 'describe hides the key');
    const secrets = new SecretStore();
    registerJellyfinSecret(cfg, secrets);
    assert(secrets.size() >= 1, 'api key registered for redaction');
    assert(secrets.redact('token=SUPER-SECRET-KEY').indexOf('SUPER-SECRET-KEY') === -1, 'redacts the key in text');
  });

  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
