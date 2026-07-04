import type { ProviderAdapter, AdapterRefView } from '../src/core/adapters/adapter.js';
import { FakeProviderAdapter } from '../src/core/adapters/fake-adapter.js';
import { loadAdapterConfig, createAdapter, adapterFromEnv, type AdapterConfig } from '../src/core/adapters/adapter-factory.js';
import type { TorBoxTransport } from '../src/core/adapters/torbox-real-client-gate.js';
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
const view = (refValue: string, refType = 'infohash'): AdapterRefView => ({ itemId: '00000000-0000-0000-0000-000000000000', refType, refValue });
const torboxTransport = (available: ReadonlySet<string>): TorBoxTransport => ({
  async request(request) {
    return {
      status: 200,
      body: { availability: request.scopedRef && available.has(request.scopedRef.refValue) ? 'available' : 'unavailable' },
    };
  },
});

/** Shared conformance kit — any ProviderAdapter must pass. `make(available)` returns a fresh adapter. */
async function runAdapterContract(label: string, make: (available: ReadonlySet<string>) => ProviderAdapter): Promise<void> {
  await test(`${label} — describe() reports a ref-resolver`, () => {
    const d = make(new Set()).describe();
    assert(typeof d.name === 'string' && d.name.length > 0, 'name present');
    assertEq(d.kind, 'ref-resolver', 'kind is ref-resolver');
  });
  await test(`${label} — resolveRef returns a valid advisory result`, async () => {
    const a = make(new Set(['YES']));
    const hit = await a.resolveRef(view('YES'));
    assert(['available', 'unavailable', 'unknown'].includes(hit.status), 'status in the enum');
    assertEq(hit.status, 'available', 'known-available ref is available');
    const miss = await a.resolveRef(view('NO'));
    assertEq(miss.status, 'unavailable', 'unknown ref is unavailable');
  });
  await test(`${label} — resolveRef does not throw on a normal view and is repeatable`, async () => {
    const a = make(new Set(['X']));
    for (let i = 0; i < 3; i++) assertEq((await a.resolveRef(view('X'))).status, 'available', 'deterministic');
  });
}

async function main(): Promise<void> {
  console.log('Running Phase 7 adapter conformance + factory suite (Stage 7.4):\n');

  await runAdapterContract('FakeProviderAdapter', (avail) => new FakeProviderAdapter(avail));
  await runAdapterContract('factory(fake)', (avail) => createAdapter({ mode: 'fake', available: avail })!);
  await runAdapterContract('factory(torbox-readonly)', (avail) => createAdapter({ mode: 'torbox-readonly', transport: torboxTransport(avail) })!);

  // --- factory config validation --------------------------------------------
  await test('factory — ADAPTER_MODE parses fake/none; unset defaults to none', () => {
    assertEq(loadAdapterConfig({ ADAPTER_MODE: 'fake' } as Env).mode, 'fake', 'fake');
    assertEq(loadAdapterConfig({ ADAPTER_MODE: 'none' } as Env).mode, 'none', 'none');
    assertEq(loadAdapterConfig({} as Env).mode, 'none', 'unset -> none');
  });

  await test('factory — unknown ADAPTER_MODE FAILS CLOSED (ConfigError)', () => {
    try { loadAdapterConfig({ ADAPTER_MODE: 'real-debrid' } as Env); assert(false, 'should throw'); }
    catch (e) { assert(e instanceof ConfigError, 'ConfigError'); assert(/ADAPTER_MODE must be one of/.test((e as Error).message), 'lists supported modes'); }
  });

  await test('factory — torbox-readonly ADAPTER_MODE requires explicit injected transport config', () => {
    try { loadAdapterConfig({ ADAPTER_MODE: 'torbox-readonly' } as Env); assert(false, 'should throw'); }
    catch (e) { assert(e instanceof ConfigError, 'ConfigError'); assert(/explicit injected transport/i.test((e as Error).message), 'transport required'); }
  });

  await test('factory — createAdapter(none) is null; unsupported mode fails closed', () => {
    assertEq(createAdapter({ mode: 'none' }), null, 'none -> null');
    try { createAdapter({ mode: 'kms' } as unknown as AdapterConfig); assert(false, 'should throw'); }
    catch (e) { assert(e instanceof ConfigError, 'fail-closed'); }
  });

  await test('factory — adapterFromEnv builds a fake / returns null for none', async () => {
    const a = adapterFromEnv({ ADAPTER_MODE: 'fake' } as Env);
    assert(a !== null && a.describe().kind === 'ref-resolver', 'fake built');
    assertEq(adapterFromEnv({} as Env), null, 'none by default');
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
