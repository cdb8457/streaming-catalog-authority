import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AdapterRefView, ProviderAdapter } from '../src/core/adapters/adapter.js';
import {
  FakeTorBoxAdapter,
  TORBOX_FAKE_SUPPORTED_REF_TYPES,
  type FakeTorBoxAvailableRef,
} from '../src/core/adapters/fake-torbox-adapter.js';
import { TORBOX_BOUNDARY_CONTRACT } from '../src/core/adapters/torbox-boundary.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`);
}

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const view = (refType: string, refValue: string): AdapterRefView => ({
  itemId: '00000000-0000-4000-8000-000000000032',
  refType,
  refValue,
});
const available = (refType: FakeTorBoxAvailableRef['refType'], refValue: string): FakeTorBoxAvailableRef => ({ refType, refValue });

async function runProviderAdapterContract(label: string, make: (availableRefs: readonly FakeTorBoxAvailableRef[]) => ProviderAdapter): Promise<void> {
  await test(`${label} - describe() reports a ref-resolver`, () => {
    const d = make([]).describe();
    assert(typeof d.name === 'string' && d.name.length > 0, 'name present');
    assertEq(d.kind, 'ref-resolver', 'kind is ref-resolver');
  });

  await test(`${label} - resolveRef returns valid advisory statuses`, async () => {
    const adapter = make([available('infohash', 'INFOHASH-AVAILABLE')]);
    const hit = await adapter.resolveRef(view('infohash', 'INFOHASH-AVAILABLE'));
    assertEq(hit.status, 'available', 'known local fake ref is available');
    assert(typeof hit.locator === 'string' && hit.locator.startsWith('tbx-fake:'), 'available hit has opaque local locator');
    const miss = await adapter.resolveRef(view('infohash', 'INFOHASH-MISS'));
    assertEq(miss.status, 'unavailable', 'normal miss is unavailable');
    const unknown = await adapter.resolveRef(view('tmdb', '603'));
    assertEq(unknown.status, 'unknown', 'unsupported ref is unknown');
  });

  await test(`${label} - resolveRef is deterministic and does not throw for ordinary unknown refs`, async () => {
    const adapter = make([available('hash-digest', 'DIGEST-YES')]);
    for (let i = 0; i < 3; i++) {
      assertEq((await adapter.resolveRef(view('hash-digest', 'DIGEST-YES'))).status, 'available', 'repeatable hit');
      assertEq((await adapter.resolveRef(view('hash-digest', 'DIGEST-NO'))).status, 'unavailable', 'repeatable miss');
      assertEq((await adapter.resolveRef(view('unknown-ref-type', 'ANY'))).status, 'unknown', 'repeatable unsupported');
    }
  });
}

function assertOutputSafe(blob: string, label: string): void {
  for (const forbidden of [
    'RAW-INFOHASH-SECRET',
    'RAW-LINK-DIGEST-SECRET',
    'HOSTILE-REF-SECRET',
    'SECRET-CREDENTIAL',
    'SECRET TITLE',
    '2026',
    'metadata-secret',
    'cdn.',
    'permalink',
    'download-link',
  ]) assert(!blob.includes(forbidden), `${label} excludes ${forbidden}`);
}

async function main(): Promise<void> {
  console.log('Running Phase 32 local fake TorBox adapter suite:\n');

  await runProviderAdapterContract('FakeTorBoxAdapter', (refs) => new FakeTorBoxAdapter(refs));

  await test('supported ref types are the Phase 31 scoped cache-check set only', () => {
    assertEq(
      TORBOX_FAKE_SUPPORTED_REF_TYPES.slice().sort().join(','),
      ['hash-digest', 'infohash', 'link-derived-digest', 'nzb-derived-digest'].sort().join(','),
      'supported local fake ref types',
    );
    const phase31ScopedExamples: readonly string[] = TORBOX_BOUNDARY_CONTRACT.allowedDataCrossing.scopedRefExamples;
    for (const phrase of ['infohash', 'hash digest', 'link-derived digest', 'NZB-derived digest']) {
      assert(phase31ScopedExamples.includes(phrase), `Phase 31 boundary includes ${phrase}`);
    }
  });

  await test('adapter observes only opaque item id plus one scoped ref, never identity fields', async () => {
    const adapter = new FakeTorBoxAdapter([available('infohash', 'RAW-INFOHASH-SECRET')]);
    const maliciousRuntimeView = {
      ...view('infohash', 'RAW-INFOHASH-SECRET'),
      title: 'SECRET TITLE',
      year: 2026,
      metadata: { marker: 'metadata-secret' },
      externalIds: { imdb: 'tt-secret' },
    } as unknown as AdapterRefView;
    const result = await adapter.resolveRef(maliciousRuntimeView);
    assertEq(result.status, 'available', 'sanitized view still resolves');
    assertEq(Object.keys(adapter.seen[0]!).sort().join(','), 'itemId,refType,refValue', 'seen view has only three keys');
    assertEq(adapter.observed[0], JSON.stringify({ viewKeys: ['itemId', 'refType', 'refValue'], ctxKeys: [] }), 'observed keys are sanitized');
    assert(!JSON.stringify(adapter.seen).includes('SECRET TITLE'), 'title was not recorded');
    assert(!JSON.stringify(adapter.observed).includes('metadata-secret'), 'metadata was not observed');
  });

  await test('available/unavailable output is advisory and redaction-safe', async () => {
    const adapter = new FakeTorBoxAdapter([
      available('infohash', 'RAW-INFOHASH-SECRET'),
      available('link-derived-digest', 'RAW-LINK-DIGEST-SECRET'),
    ]);
    const hit = await adapter.resolveRef(view('infohash', 'RAW-INFOHASH-SECRET'));
    const hitAgain = await adapter.resolveRef(view('infohash', 'RAW-INFOHASH-SECRET'));
    const linkHit = await adapter.resolveRef(view('link-derived-digest', 'RAW-LINK-DIGEST-SECRET'));
    const miss = await adapter.resolveRef(view('link-derived-digest', 'MISSING-LINK-DIGEST'));

    assertEq(hit.status, 'available', 'infohash hit');
    assertEq(hitAgain.locator, hit.locator, 'locator is deterministic');
    assertEq(linkHit.status, 'available', 'link-derived digest hit');
    assertEq(miss.status, 'unavailable', 'miss is advisory unavailable');
    assertOutputSafe(JSON.stringify([hit, hitAgain, linkHit, miss]), 'advisory results');
  });

  await test('unsupported risky operation ref types fail closed without link or mutation output', async () => {
    const adapter = new FakeTorBoxAdapter([available('infohash', 'SAFE')]);
    const lines: string[] = [];
    for (const refType of [
      'create-download',
      'request-download-link',
      'user-list',
      'user-data',
      'control-item',
      'delete-item',
      'export-torrent-data',
      'cdn-url',
      'permalink-url',
    ]) {
      const result = await adapter.resolveRef(view(refType, 'HOSTILE-REF-SECRET'), { log: (line) => lines.push(line) });
      assertEq(result.status, 'unknown', `${refType} fails closed`);
      assert(!result.locator, `${refType} has no locator`);
      assertEq(result.detail, 'unsupported-ref-type', `${refType} has redaction-safe detail`);
    }
    assertOutputSafe(JSON.stringify(lines), 'logs');
  });

  await test('returned locator/detail never include raw refs, URLs, tokens, titles, or CDN/permalink strings', async () => {
    const adapter = new FakeTorBoxAdapter([available('infohash', 'RAW-INFOHASH-SECRET')]);
    const result = await adapter.resolveRef(view('infohash', 'RAW-INFOHASH-SECRET'));
    assert(result.locator !== 'RAW-INFOHASH-SECRET', 'locator is not the raw ref');
    assert(!result.locator?.includes('00000000-0000-4000-8000-000000000032'), 'locator does not echo item id');
    assertOutputSafe(JSON.stringify(result), 'available result');
  });

  await test('source has no SDK, network, env, DB, Docker, or provider-mode scope creep', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const source = read('src/core/adapters/fake-torbox-adapter.ts');
    const factory = read('src/core/adapters/adapter-factory.ts');
    const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });

    assert(!allDeps.includes('@torbox/torbox-api'), 'no TorBox SDK dependency installed');
    assert(!factory.includes('fake-torbox') && !factory.includes('FakeTorBoxAdapter'), 'adapter factory does not expose TorBox mode');
    for (const forbidden of [
      '@torbox/torbox-api',
      "from 'pg'",
      'from "pg"',
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dns',
      'node:child_process',
      'globalThis.fetch',
      'fetch(',
      'process.env',
      'readFileSync',
      'readdirSync',
      'docker compose',
      'ADAPTER_MODE',
      'createAdapter',
      'requestDownloadLink',
      'createTorrent',
      'createWebDownload',
      'createUsenetDownload',
    ]) assert(!source.includes(forbidden), `fake adapter source excludes ${forbidden}`);
  });

  await test('package scripts wire the fake TorBox adapter suite into npm test', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    assertEq(pkg.scripts['test:torbox-fake-adapter'], 'tsx test/torbox-fake-adapter.ts', 'focused script present');
    assert((pkg.scripts.test ?? '').includes('test/torbox-fake-adapter.ts'), 'suite is in npm test chain');
  });

  await test('no accidental TorBox source appears beyond the static boundary and local fake contract', () => {
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const allowed = new Set([
      'src/core/adapters/torbox-boundary.ts',
      'src/core/adapters/fake-torbox-adapter.ts',
      'src/core/adapters/torbox-real-client-gate.ts',
      'src/core/adapters/torbox-readonly-client.ts',
      'src/core/adapters/torbox-provider-adapter.ts',
      'src/core/adapters/adapter-factory.ts',
      'src/ops/torbox-smoke-shell.ts',
      'src/ops/torbox-smoke-cli.ts',
      'src/ops/torbox-transport-acceptance.ts',
      'src/ops/torbox-smoke-readiness-preflight.ts',
      'src/ops/torbox-smoke-readiness-preflight-cli.ts',
      'src/ops/torbox-live-smoke-labels.ts',
      'src/ops/torbox-live-transport.ts',
      'src/ops/torbox-live-smoke-runner.ts',
      'src/ops/torbox-live-smoke-evidence-preflight.ts',
      'src/ops/torbox-live-smoke-evidence-preflight-cli.ts',
      'src/ops/torbox-live-smoke-summary-pack.ts',
      'src/ops/torbox-live-smoke-summary-pack-cli.ts',
      'src/ops/torbox-live-smoke-plan.ts',
      'src/ops/torbox-live-smoke-plan-cli.ts',
    ]);
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      return entry.isDirectory() ? walk(path) : entry.name.endsWith('.ts') ? [path] : [];
    });
    const repoRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/');
    for (const file of walk(root)) {
      const rel = file.replace(/\\/g, '/').replace(repoRoot, '');
      if (allowed.has(rel)) continue;
      assert(!/torbox/i.test(readFileSync(file, 'utf8')), `${rel} does not name TorBox`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
