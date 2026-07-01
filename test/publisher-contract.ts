import type { PublisherAdapter, PublishableIdentity } from '../src/core/adapters/publisher.js';
import { FakePublisherAdapter } from '../src/core/adapters/fake-publisher.js';
import { loadPublisherConfig, createPublisher, publisherFromEnv, type PublisherConfig } from '../src/core/adapters/publisher-factory.js';
import { ConfigError, type Env } from '../src/config/env.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }

const identity: PublishableIdentity = { itemId: '00000000-0000-0000-0000-000000000000', title: 'T', year: 2020, providerRefs: [{ type: 'tmdb', value: '1' }] };

/** Shared conformance kit — any PublisherAdapter must pass. */
async function runPublisherContract(label: string, make: () => PublisherAdapter): Promise<void> {
  await test(`${label} — describe() reports a publisher and declares fields`, () => {
    const a = make();
    const d = a.describe();
    assert(typeof d.name === 'string' && d.name.length > 0, 'name present');
    assertEq(d.kind, 'publisher', 'kind is publisher');
    assert(Array.isArray(a.requires), 'requires is an array');
    for (const f of a.requires) assert(['title', 'year', 'providerRefs'].includes(f), `declared field ${f} is allowed`);
  });
  await test(`${label} — dry-run reports without publishing`, async () => {
    const r = await make().publish({ identity, dryRun: true });
    assertEq(r.dryRun, true, 'result marked dry-run');
    assertEq(r.status, 'skipped', 'dry-run does not publish');
  });
  await test(`${label} — a live publish returns an advisory result with an opaque handle`, async () => {
    const r = await make().publish({ identity, dryRun: false });
    assertEq(r.dryRun, false, 'not dry-run');
    assertEq(r.status, 'published', 'published');
    assert(typeof r.handle === 'string' && r.handle.length > 0, 'opaque handle present');
  });
}

async function main(): Promise<void> {
  console.log('Running Phase 8 publisher conformance + factory suite (Stage 8.4):\n');

  await runPublisherContract('FakePublisherAdapter', () => new FakePublisherAdapter());
  await runPublisherContract('factory(fake)', () => createPublisher({ mode: 'fake' })!);

  await test('fake — dry-run makes NO entry in the local sink; a live publish does', async () => {
    const a = new FakePublisherAdapter();
    await a.publish({ identity, dryRun: true });
    assertEq(a.published.length, 0, 'dry-run left the sink empty');
    await a.publish({ identity, dryRun: false });
    assertEq(a.published.length, 1, 'live publish recorded to the local sink');
  });

  // --- factory config validation --------------------------------------------
  await test('factory — PUBLISHER_MODE parses fake/none; unset defaults to none', () => {
    assertEq(loadPublisherConfig({ PUBLISHER_MODE: 'fake' } as Env).mode, 'fake', 'fake');
    assertEq(loadPublisherConfig({ PUBLISHER_MODE: 'none' } as Env).mode, 'none', 'none');
    assertEq(loadPublisherConfig({} as Env).mode, 'none', 'unset -> none');
  });

  await test('factory — unknown PUBLISHER_MODE FAILS CLOSED (ConfigError)', () => {
    try { loadPublisherConfig({ PUBLISHER_MODE: 'plex' } as Env); assert(false, 'should throw'); }
    catch (e) { assert(e instanceof ConfigError, 'ConfigError'); assert(/PUBLISHER_MODE must be one of/.test((e as Error).message), 'lists supported modes'); }
  });

  await test('factory — createPublisher(none) is null; unsupported mode fails closed', () => {
    assertEq(createPublisher({ mode: 'none' }), null, 'none -> null');
    try { createPublisher({ mode: 'jellyfin' } as unknown as PublisherConfig); assert(false, 'should throw'); }
    catch (e) { assert(e instanceof ConfigError, 'fail-closed'); }
  });

  await test('factory — publisherFromEnv builds a fake / returns null for none', () => {
    const a = publisherFromEnv({ PUBLISHER_MODE: 'fake' } as Env);
    assert(a !== null && a.describe().kind === 'publisher', 'fake built');
    assertEq(publisherFromEnv({} as Env), null, 'none by default');
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
