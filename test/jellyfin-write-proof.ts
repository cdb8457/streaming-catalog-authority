import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE_221_COLLECTION_PREFIX, runJellyfinWriteProof, type JellyfinWriteProofClient } from '../src/ops/jellyfin-write-proof.js';
import type { Env } from '../src/config/env.js';
import type { CatalogAuthority } from '../src/core/catalog/authority.js';
import type { JellyfinRef } from '../src/core/adapters/jellyfin/client.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

const SECRET = 'PHASE221-SUPER-SECRET-JELLYFIN-KEY';
const HOST = 'private-jellyfin-hostname';
const RAW_REF = 'phase221-raw-provider-ref';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';
const JELLYFIN_ID = 'phase221-raw-jellyfin-item-id';
const COLLECTION_ID = 'phase221-raw-collection-id';

function fixtureEnv(dir: string, overrides: Env = {}): Env {
  const keyFile = path.join(dir, 'jellyfin_api_key');
  writeFileSync(keyFile, SECRET, 'utf8');
  return {
    JELLYFIN_ENABLE_NETWORK: 'true',
    JELLYFIN_ALLOW_LIVE_PUBLISH: 'true',
    JELLYFIN_BASE_URL: `http://${HOST}:8096`,
    JELLYFIN_API_KEY_FILE: keyFile,
    CUSTODIAN_MODE: 'sidecar',
    CUSTODIAN_SIDECAR_SOCKET_PATH: '/run/catalog-sidecar/catalog-sidecar.sock',
    ...overrides,
  };
}

function noLeak(value: unknown): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return !text.includes(SECRET)
    && !text.includes(HOST)
    && !text.includes(RAW_REF)
    && !text.includes(ITEM_ID)
    && !text.includes(JELLYFIN_ID)
    && !text.includes(COLLECTION_ID)
    && !text.includes('192.168.')
    && !text.includes('postgresql://');
}

function fakeAuthority(refs: readonly JellyfinRef[]): CatalogAuthority {
  return {
    withPublishableIdentity: async (_itemId: string, requires: readonly string[], fn: (identity: unknown) => unknown) => {
      assert(requires.length === 1 && requires[0] === 'providerRefs', 'requires providerRefs only');
      return fn({ itemId: ITEM_ID, providerRefs: refs });
    },
  } as unknown as CatalogAuthority;
}

class ProofClient implements JellyfinWriteProofClient {
  readonly events: string[] = [];
  private readonly collections = new Map<string, { token: string; items: Set<string> }>();
  constructor(private readonly faults: Partial<Record<'priorResidue' | 'delete', boolean>> = {}) {
    if (faults.priorResidue) this.collections.set('prior-collection-id', { token: 'prior-token', items: new Set() });
  }

  async findItemsByRefs(refs: readonly JellyfinRef[]): Promise<string[]> {
    this.events.push(`find:${refs.length}`);
    return refs.length > 0 ? [JELLYFIN_ID] : [];
  }

  async createTaggedCollection(_name: string, itemIds: readonly string[], token: string): Promise<string> {
    this.events.push(`create:${itemIds.length}`);
    this.collections.set(COLLECTION_ID, { token, items: new Set(itemIds) });
    return COLLECTION_ID;
  }

  async addItemsToCollection(collectionId: string, itemIds: readonly string[]): Promise<void> {
    this.events.push(`add:${itemIds.length}`);
    const collection = this.collections.get(collectionId);
    if (!collection) throw new Error('missing collection');
    for (const id of itemIds) collection.items.add(id);
  }

  async listCollectionItemIds(collectionId: string): Promise<string[]> {
    this.events.push('list-items');
    return [...(this.collections.get(collectionId)?.items ?? [])];
  }

  async removeItemsFromCollection(collectionId: string, itemIds: readonly string[]): Promise<void> {
    this.events.push(`remove:${itemIds.length}`);
    const collection = this.collections.get(collectionId);
    if (!collection) return;
    for (const id of itemIds) collection.items.delete(id);
  }

  async deleteCollection(collectionId: string): Promise<'deleted' | 'not_found'> {
    this.events.push('delete');
    if (this.faults.delete) throw new Error(`delete ${SECRET}`);
    return this.collections.delete(collectionId) ? 'deleted' : 'not_found';
  }

  async findCollectionByToken(token: string): Promise<string | null> {
    this.events.push('find-token');
    for (const [id, collection] of this.collections) if (collection.token === token) return id;
    return null;
  }

  async findCollectionsByNamePrefix(_prefix: string): Promise<string[]> {
    this.events.push('find-prefix');
    return [...this.collections.keys()];
  }

  count(): number { return this.collections.size; }
}

console.log('Running Phase 221 Jellyfin write proof suite:\n');

await test('write proof happy path creates, adds, verifies, removes, deletes, and proves unchanged library state', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jf-write-proof-221-'));
  try {
    const client = new ProofClient();
    const report = await runJellyfinWriteProof({
      env: fixtureEnv(dir),
      authority: fakeAuthority([{ type: 'tmdb', value: RAW_REF }]),
      client,
      itemIds: [ITEM_ID],
      token: 'phase221-token',
      now: () => new Date('2026-07-14T12:00:00.000Z'),
    });
    assert(report.ok, 'write proof ok');
    assertEq(report.status, 'JELLYFIN_WRITE_PROOF_CLEANED_UP', 'success status');
    assertEq(report.cleanup.success, true, 'cleanup success');
    assertEq(report.libraryState.unchanged, true, 'library state unchanged');
    assertEq(report.collection.finalResidueCount, 0, 'no residue');
    assertEq(client.count(), 0, 'fake collection removed');
    assertEq(
      client.events.join(','),
      'find-prefix,find:1,find:1,create:0,add:1,list-items,remove:1,list-items,delete,find-token,find-prefix,find:1',
      'expected write sequence',
    );
    for (const step of ['preflight-residue', 'select-target', 'create-collection', 'add-items', 'verify-membership', 'remove-items', 'delete-collection', 'verify-absence', 'snapshot-after']) {
      assert(report.steps.some((s) => s.step === step && s.ok), `${step} ok`);
    }
    assert(noLeak(report), 'report redaction-safe');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('prior disposable collection residue refuses before any new write', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jf-write-proof-221-residue-'));
  try {
    const client = new ProofClient({ priorResidue: true });
    const report = await runJellyfinWriteProof({
      env: fixtureEnv(dir),
      authority: fakeAuthority([{ type: 'tmdb', value: RAW_REF }]),
      client,
      itemIds: [ITEM_ID],
      token: 'phase221-token',
    });
    assert(!report.ok, 'residue report fails');
    assertEq(report.status, 'JELLYFIN_WRITE_PROOF_REFUSED_PRIOR_RESIDUE', 'residue status');
    assertEq(report.collection.priorResidueCount, 1, 'prior residue counted');
    assert(!client.events.includes('create:0'), 'no create attempted');
    assert(noLeak(report), 'residue report redaction-safe');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('cleanup failure is recorded separately with orphan digest only', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jf-write-proof-221-cleanup-'));
  try {
    const client = new ProofClient({ delete: true });
    const report = await runJellyfinWriteProof({
      env: fixtureEnv(dir),
      authority: fakeAuthority([{ type: 'tmdb', value: RAW_REF }]),
      client,
      itemIds: [ITEM_ID],
      token: 'phase221-token',
    });
    assert(!report.ok, 'cleanup-failure report fails');
    assertEq(report.status, 'JELLYFIN_WRITE_PROOF_CLEANUP_FAILED', 'cleanup failure status');
    assertEq(report.cleanup.success, false, 'cleanup failed');
    assert(typeof report.cleanup.orphanedCollectionDigest === 'string', 'orphan digest emitted');
    assertEq(client.count(), 1, 'fixture models orphaned collection');
    assert(noLeak(report), 'cleanup failure redaction-safe');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('environment and endpoint boundary fail closed outside the write-proof command', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jf-write-proof-221-env-'));
  try {
    for (const [name, env] of [
      ['direct api key', fixtureEnv(dir, { JELLYFIN_API_KEY: SECRET })],
      ['write gate disabled', fixtureEnv(dir, { JELLYFIN_ALLOW_LIVE_PUBLISH: 'false' })],
      ['network disabled', fixtureEnv(dir, { JELLYFIN_ENABLE_NETWORK: 'false' })],
    ] as const) {
      let err: unknown;
      try {
        await runJellyfinWriteProof({ env, authority: fakeAuthority([]), client: new ProofClient(), itemIds: [] });
      } catch (caught) { err = caught; }
      assert(err instanceof Error, `${name} rejected`);
      assert(noLeak((err as Error).message), `${name} rejection redaction-safe`);
    }

    const source = read('src/ops/jellyfin-write-proof.ts');
    for (const forbiddenEndpoint of ['/Users', '/Playlists', '/Sessions', '/Videos', '/System/Configuration']) {
      assert(!source.includes(forbiddenEndpoint), `source excludes disallowed endpoint ${forbiddenEndpoint}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('phase document, launcher, package, and deploy guard wire Phase 221', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const launcher = read('deploy/unraid-jellyfin-write-proof.sh');
  const deploy = read('test/deploy.ts');
  const readme = read('README.md');
  assert(pkg.scripts['ops:jellyfin-write-proof'] === 'tsx src/ops/jellyfin-write-proof-cli.ts', 'ops script present');
  assert(pkg.scripts['test:jellyfin-write-proof'] === 'tsx test/jellyfin-write-proof.ts', 'test script present');
  for (const required of [
    'JELLYFIN_ALLOW_LIVE_PUBLISH=true',
    'ops:jellyfin-write-proof',
    '--confirm-disposable-write',
    'phase-221-jellyfin-write-proof.json',
    'docker compose -f "$COMPOSE_FILE" run --rm',
    'JELLYFIN_BASE_URL=$BASE_URL',
  ]) assert(launcher.includes(required), `launcher includes ${required}`);
  for (const forbidden of [' --publish', '\n-p ', 'ports:', 'docker run', 'JELLYFIN_API_KEY=']) {
    assert(!launcher.includes(forbidden), `launcher excludes ${forbidden}`);
  }
  for (const required of [
    'Phase 221 Jellyfin write-capable disposable collection proof',
    'JELLYFIN_WRITE_PROOF_CLEANED_UP',
    'test:jellyfin-write-proof',
    'Phase 221 adds `docs/PHASE_221_JELLYFIN_WRITE_PROOF.md`',
  ]) assert(`${deploy}\n${readme}`.includes(required), `Phase 221 wiring includes ${required}`);
});

await test('phase artifacts are redaction-safe and keep integration launch deferred', () => {
  const doc = read('docs/PHASE_221_JELLYFIN_WRITE_PROOF.md');
  for (const required of [
    'phase-221-jellyfin-write-proof',
    'JELLYFIN_WRITE_PROOF_CLEANED_UP',
    PHASE_221_COLLECTION_PREFIX,
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
    'Jellyfin runtime integration remains deferred pending Phase 222',
  ]) assert(doc.includes(required), `doc includes ${required}`);
  for (const forbidden of [
    SECRET,
    RAW_REF,
    JELLYFIN_ID,
    COLLECTION_ID,
    'O5_CLOSED',
    'provider mode enabled',
    'playback enabled',
    'download enabled',
    '192.168.',
    'postgres://',
    'postgresql://',
  ]) assert(!doc.includes(forbidden), `Phase 221 doc excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
