import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AdapterRefView } from '../src/core/adapters/adapter.js';
import {
  TORBOX_READONLY_CLIENT_REF_OPERATION_MAP,
  TORBOX_READONLY_CLIENT_ROUTE_IDS,
  TorBoxReadOnlyClient,
  type TorBoxReadOnlySupportedRefType,
} from '../src/core/adapters/torbox-readonly-client.js';
import { TorBoxRealClientGateError, type TorBoxTransport, type TorBoxTransportRequest, type TorBoxTransportResponse } from '../src/core/adapters/torbox-real-client-gate.js';

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
const repoRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/');

function walkTs(relDir: string): Array<[string, string]> {
  const abs = fileURLToPath(new URL(`../${relDir}`, import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
  return walk(abs).map((path) => [path.replace(/\\/g, '/').replace(repoRoot, ''), readFileSync(path, 'utf8')]);
}

const view = (refType: string, refValue: string): AdapterRefView => ({
  itemId: '00000000-0000-4000-8000-000000000034',
  refType,
  refValue,
});

class FixtureTransport implements TorBoxTransport {
  readonly requests: TorBoxTransportRequest[] = [];
  readonly publicDiagnostics: string[] = [];
  private readonly responses: TorBoxTransportResponse[];
  private readonly fault?: unknown;

  constructor(responses: readonly TorBoxTransportResponse[], fault?: unknown) {
    this.responses = [...responses];
    this.fault = fault;
  }

  async request(request: TorBoxTransportRequest): Promise<TorBoxTransportResponse> {
    this.requests.push(request);
    this.publicDiagnostics.push(JSON.stringify({
      operation: request.operation,
      method: request.method,
      routeId: request.routeId,
      refType: request.scopedRef?.refType,
      timeoutMs: request.timeoutMs,
    }));
    if (this.fault) throw this.fault;
    return this.responses.shift() ?? { status: 200, body: { availability: 'unknown' } };
  }
}

function publicBlob(...values: unknown[]): string {
  return values.map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join('\n');
}

function assertNoLeak(blob: string, label: string): void {
  for (const forbidden of [
    'RAW-INFOHASH-SECRET',
    'RAW-HASH-DIGEST-SECRET',
    'RAW-LINK-DIGEST-SECRET',
    'RAW-NZB-DIGEST-SECRET',
    'HOSTILE-REF-SECRET',
    'credential-leak-marker',
    'PRIVATE TITLE MARKER',
    '2026',
    'metadata-leak-marker',
    'raw-body-leak-marker',
    'download-url-marker',
    'cdn-leak-marker',
    'permalink-leak-marker',
    '00000000-0000-4000-8000-000000000034',
  ]) assert(!blob.includes(forbidden), `${label} excludes ${forbidden}`);
}

async function main(): Promise<void> {
  console.log('Running Phase 34 TorBox read-only injected transport fixture suite:\n');

  await test('request mapping from scoped refs to read-only operations and route ids is deterministic', async () => {
    const transport = new FixtureTransport([
      { status: 200, body: { availability: 'available' } },
      { status: 200, body: { availability: 'unavailable' } },
      { status: 200, body: { availability: 'unknown' } },
      { status: 200, body: { availability: 'available' } },
    ]);
    const client = new TorBoxReadOnlyClient({ transport, timeoutMs: 4_000 });
    const refs: Array<[TorBoxReadOnlySupportedRefType, string]> = [
      ['infohash', 'RAW-INFOHASH-SECRET'],
      ['hash-digest', 'RAW-HASH-DIGEST-SECRET'],
      ['link-derived-digest', 'RAW-LINK-DIGEST-SECRET'],
      ['nzb-derived-digest', 'RAW-NZB-DIGEST-SECRET'],
    ];

    const results = [];
    for (const [refType, refValue] of refs) results.push(await client.resolveRef(view(refType, refValue)));

    assertEq(transport.requests.length, refs.length, 'one request per supported ref');
    for (let i = 0; i < refs.length; i++) {
      const [refType, refValue] = refs[i]!;
      const req = transport.requests[i]!;
      const operation = TORBOX_READONLY_CLIENT_REF_OPERATION_MAP[refType];
      assertEq(req.operation, operation, `${refType} operation`);
      assertEq(req.routeId, TORBOX_READONLY_CLIENT_ROUTE_IDS[operation], `${refType} route id`);
      assertEq(req.method, 'GET', `${refType} uses GET`);
      assertEq(req.timeoutMs, 4_000, `${refType} timeout propagated`);
      assertEq(req.scopedRef?.refType, refType, `${refType} ref type scoped`);
      assertEq(req.scopedRef?.refValue, refValue, `${refType} raw ref stays transport-internal`);
    }
    assertNoLeak(publicBlob(results, transport.publicDiagnostics), 'public result and diagnostics');
  });

  await test('unsupported and empty refs fail closed without transport requests', async () => {
    const transport = new FixtureTransport([{ status: 200, body: { availability: 'available' } }]);
    const client = new TorBoxReadOnlyClient({ transport });
    const lines: string[] = [];
    const unsupported = await client.resolveRef(view('tmdb', 'HOSTILE-REF-SECRET'), { log: (line) => lines.push(line) });
    const empty = await client.resolveRef(view('infohash', ''), { log: (line) => lines.push(line) });

    assertEq(unsupported.status, 'unknown', 'unsupported status');
    assertEq(unsupported.detail, 'unsupported-ref-type', 'unsupported detail');
    assertEq(empty.status, 'unknown', 'empty status');
    assertEq(empty.detail, 'empty-ref-value', 'empty detail');
    assertEq(transport.requests.length, 0, 'no transport call for unsupported input');
    assertNoLeak(publicBlob(unsupported, empty, lines, transport.publicDiagnostics), 'unsupported outputs');
  });

  await test('no unsupported operation can be requested through the client surface', async () => {
    const transport = new FixtureTransport([
      { status: 200, body: { availability: 'available' } },
      { status: 200, body: { availability: 'available' } },
    ]);
    const client = new TorBoxReadOnlyClient({ transport });
    await client.checkServiceStatus();
    await client.checkHosters();

    const requested = transport.requests.map((req) => req.operation).sort();
    assertEq(requested.join(','), ['hoster-list', 'status-check'].sort().join(','), 'explicit service calls are read-only only');
    for (const req of transport.requests) {
      assert(!req.scopedRef, `${req.operation} does not carry item refs`);
      assertEq(req.method, 'GET', `${req.operation} uses GET`);
    }
    const source = read('src/core/adapters/torbox-readonly-client.ts');
    for (const forbidden of ['create-download', 'request-download-link', 'request-permalink', 'user-list', 'user-data', 'control-item', 'delete-item', 'export-provider-data', 'cdn-url']) {
      assert(!source.includes(forbidden), `client source does not expose ${forbidden}`);
    }
  });

  await test('availability parser accepts clear hit, miss, and unknown only', async () => {
    for (const [body, expected] of [
      [{ availability: 'available' }, 'available'],
      [{ availability: 'unavailable' }, 'unavailable'],
      [{ availability: 'unknown' }, 'unknown'],
    ] as const) {
      const transport = new FixtureTransport([{ status: 200, body }]);
      const client = new TorBoxReadOnlyClient({ transport });
      assertEq((await client.resolveRef(view('infohash', 'RAW-INFOHASH-SECRET'))).status, expected, `parses ${expected}`);
    }

    for (const body of [
      { availability: true },
      { availability: 'available', raw: 'raw-body-leak-marker' },
      { cached: true },
      [{ availability: 'available' }],
      'available',
      null,
    ]) {
      const transport = new FixtureTransport([{ status: 200, body }]);
      const client = new TorBoxReadOnlyClient({ transport });
      const result = await client.resolveRef(view('infohash', 'RAW-INFOHASH-SECRET'));
      assertEq(result.status, 'unknown', 'ambiguous payload fails closed');
      assertEq(result.detail, 'ambiguous-availability', 'ambiguous detail is fixed');
      assertNoLeak(publicBlob(result, transport.publicDiagnostics), 'ambiguous output');
    }
  });

  await test('non-2xx and failure categories produce redaction-safe unknown results', async () => {
    const cases: Array<[number, TorBoxTransportResponse['category'] | undefined, string]> = [
      [401, undefined, 'auth'],
      [403, undefined, 'auth'],
      [429, undefined, 'quota'],
      [408, undefined, 'timeout'],
      [500, undefined, 'transport'],
      [200, 'parse', 'parse'],
      [200, 'quota', 'quota'],
    ];
    for (const [status, category, detail] of cases) {
      const transport = new FixtureTransport([{ status, category, body: { availability: 'available', hostile: 'raw-body-leak-marker' } }]);
      const lines: string[] = [];
      const client = new TorBoxReadOnlyClient({ transport });
      const result = await client.resolveRef(view('infohash', 'RAW-INFOHASH-SECRET'), { log: (line) => lines.push(line) });
      assertEq(result.status, 'unknown', `${status}/${String(category)} is unknown`);
      assertEq(result.detail, detail, `${status}/${String(category)} detail`);
      assertNoLeak(publicBlob(result, lines, transport.publicDiagnostics), `${status}/${String(category)} output`);
    }

    const parseFault = new SyntaxError('raw-body-leak-marker');
    const parseTransport = new FixtureTransport([], parseFault);
    const parseResult = await new TorBoxReadOnlyClient({ transport: parseTransport }).resolveRef(view('infohash', 'RAW-INFOHASH-SECRET'));
    assertEq(parseResult.status, 'unknown', 'syntax fault unknown');
    assertEq(parseResult.detail, 'parse', 'syntax fault parse detail');
    assertNoLeak(publicBlob(parseResult, parseTransport.publicDiagnostics), 'syntax fault output');

    const transportFault = new FixtureTransport([], new Error('credential-leak-marker'));
    const transportResult = await new TorBoxReadOnlyClient({ transport: transportFault }).resolveRef(view('infohash', 'RAW-INFOHASH-SECRET'));
    assertEq(transportResult.status, 'unknown', 'transport fault unknown');
    assertEq(transportResult.detail, 'transport', 'transport fault detail');
    assertNoLeak(publicBlob(transportResult, transportFault.publicDiagnostics), 'transport fault output');
  });

  await test('optional gate-error mode throws sanitized Phase 33 gate errors only', async () => {
    const transport = new FixtureTransport([{ status: 429, body: { availability: 'available', raw: 'raw-body-leak-marker' } }]);
    const client = new TorBoxReadOnlyClient({ transport, gateErrors: 'throw' });
    let threw = false;
    try {
      await client.resolveRef(view('infohash', 'RAW-INFOHASH-SECRET'));
    } catch (err) {
      threw = true;
      assert(err instanceof TorBoxRealClientGateError, 'throws gate error');
      assertEq((err as TorBoxRealClientGateError).operation, 'torrent-cache-check', 'operation kept');
      assertEq((err as TorBoxRealClientGateError).status, 429, 'status kept');
      assertEq((err as TorBoxRealClientGateError).category, 'quota', 'category derived');
      assertEq(JSON.stringify(err), '{"operation":"torrent-cache-check","status":429,"category":"quota"}', 'minimal JSON');
      assertNoLeak(publicBlob((err as Error).message, String(err), JSON.stringify(err), transport.publicDiagnostics), 'gate error output');
    }
    assert(threw, 'gate error mode throws');
  });

  await test('raw refs, credentials, URLs, body, metadata, item ids, CDN, and permalink data never appear in public outputs', async () => {
    const transport = new FixtureTransport([
      {
        status: 200,
        body: {
          availability: 'available',
          credential: 'credential-leak-marker',
          title: 'PRIVATE TITLE MARKER',
          year: 2026,
          metadata: 'metadata-leak-marker',
          body: 'raw-body-leak-marker',
          location: 'download-url-marker',
          cdn: 'cdn-leak-marker',
          permalink: 'permalink-leak-marker',
        },
      },
    ]);
    const lines: string[] = [];
    const maliciousRuntimeView = {
      ...view('infohash', 'RAW-INFOHASH-SECRET'),
      title: 'PRIVATE TITLE MARKER',
      year: 2026,
      metadata: { marker: 'metadata-leak-marker' },
      location: 'download-url-marker',
      cdn: 'cdn-leak-marker',
      permalink: 'permalink-leak-marker',
    } as unknown as AdapterRefView;
    const result = await new TorBoxReadOnlyClient({ transport }).resolveRef(maliciousRuntimeView, { log: (line) => lines.push(line) });
    assertEq(result.status, 'unknown', 'hostile provider body is ambiguous');
    assertNoLeak(publicBlob(result, lines, transport.publicDiagnostics), 'hostile public output');
  });

  await test('source has no SDK, network, env, DB, Docker, factory, provider-mode, or persistence scope creep', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const source = read('src/core/adapters/torbox-readonly-client.ts');
    const factory = read('src/core/adapters/adapter-factory.ts');
    const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    assert(!allDeps.includes('@torbox/torbox-api'), 'no TorBox SDK dependency installed');
    assert(!/torbox/i.test(factory), 'adapter factory stays closed to TorBox');
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
      'window.fetch',
      'fetch(',
      'process.env',
      'readFileSync',
      'readdirSync',
      'openSync',
      'readSync',
      'docker compose',
      'ADAPTER_MODE',
      'createAdapter',
      'INSERT INTO',
      'UPDATE ',
      'DELETE FROM',
      'TRUNCATE',
    ]) assert(!source.includes(forbidden), `read-only client source excludes ${forbidden}`);
  });

  await test('adapter factory remains closed and package test chain includes the suite', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const factory = read('src/core/adapters/adapter-factory.ts');
    assert(!/torbox/i.test(factory), 'adapter factory does not mention TorBox');
    assertEq(pkg.scripts['test:torbox-readonly-client'], 'tsx test/torbox-readonly-client.ts', 'focused script present');
    assert((pkg.scripts.test ?? '').includes('test/torbox-readonly-client.ts'), 'suite is in npm test chain');
  });

  await test('TorBox source allowlist includes only the static boundary, fakes, gate, and Phase 34 client', () => {
    const allowed = new Set([
      'src/core/adapters/torbox-boundary.ts',
      'src/core/adapters/fake-torbox-adapter.ts',
      'src/core/adapters/torbox-real-client-gate.ts',
      'src/core/adapters/torbox-readonly-client.ts',
      'src/ops/torbox-smoke-shell.ts',
      'src/ops/torbox-smoke-cli.ts',
      'src/ops/torbox-transport-acceptance.ts',
      'src/ops/torbox-smoke-readiness-preflight.ts',
      'src/ops/torbox-smoke-readiness-preflight-cli.ts',
      'src/ops/torbox-live-transport.ts',
      'src/ops/torbox-live-smoke-runner.ts',
      'src/ops/torbox-live-smoke-evidence-preflight.ts',
      'src/ops/torbox-live-smoke-evidence-preflight-cli.ts',
    ]);
    for (const [path, source] of walkTs('src')) {
      if (allowed.has(path)) continue;
      assert(!/torbox/i.test(source), `${path} does not name TorBox`);
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
