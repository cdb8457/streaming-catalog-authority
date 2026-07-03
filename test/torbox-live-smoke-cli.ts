import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TorBoxTransport, TorBoxTransportRequest, TorBoxTransportResponse } from '../src/core/adapters/torbox-real-client-gate.js';
import {
  formatTorBoxLiveSmokeJson,
  formatTorBoxLiveSmokeText,
  runTorBoxLiveSmoke,
} from '../src/ops/torbox-live-smoke-runner.js';
import { buildTorBoxSmokeShellReport, parseTorBoxSmokeShellArgs, type TorBoxSmokeShellOptions } from '../src/ops/torbox-smoke-shell.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`);
}

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const exists = (rel: string): boolean => existsSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)));
const repoRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/');
const root = fileURLToPath(new URL('../', import.meta.url));

function walkTs(relDir: string): Array<[string, string]> {
  const abs = fileURLToPath(new URL(`../${relDir}`, import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
  return walk(abs).map((path) => [path.replace(/\\/g, '/').replace(repoRoot, ''), readFileSync(path, 'utf8')]);
}

function expectOptions(parsed: TorBoxSmokeShellOptions | { readonly error: string }): TorBoxSmokeShellOptions {
  if ('error' in parsed) throw new Error(`unexpected parse error: ${parsed.error}`);
  return parsed;
}

function liveArgs(extra: string[] = []): string[] {
  return [
    '--live-smoke',
    '--live-transport',
    '--read-only',
    '--redacted',
    '--operator-authorized',
    '--credential-file',
    'SECRET-PATH-SENTINEL',
    ...extra,
  ];
}

console.log('Running Phase 43 TorBox live smoke CLI suite:\n');

const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

await test('Phase 43 runner, docs, and package wiring exist without adding operator smoke to CI', () => {
  assert(exists('src/ops/torbox-live-smoke-runner.ts'), 'live smoke runner source exists');
  assert(exists('docs/PHASE_43_TORBOX_LIVE_SMOKE_CLI.md'), 'Phase 43 doc exists');
  assertEq(pkg.scripts['test:torbox-live-smoke-cli'], 'tsx test/torbox-live-smoke-cli.ts', 'focused script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-smoke-cli.ts'), 'deterministic suite is in npm test');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');
  assert(!(pkg.scripts.ci ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm ci');
});

await test('live preflight requires explicit live transport and credential file indirection', () => {
  const withoutTransport = buildTorBoxSmokeShellReport(expectOptions(parseTorBoxSmokeShellArgs([
    '--live-smoke',
    '--read-only',
    '--redacted',
    '--operator-authorized',
    '--credential-file',
    'SECRET-PATH-SENTINEL',
  ])));
  assertEq(withoutTransport.ok, false, 'no live transport still blocks');
  assertEq(withoutTransport.wouldContactTorBox, false, 'no transport means no TorBox contact');

  const credentialRefOnly = buildTorBoxSmokeShellReport(expectOptions(parseTorBoxSmokeShellArgs([
    '--live-smoke',
    '--live-transport',
    '--read-only',
    '--redacted',
    '--operator-authorized',
    '--credential-ref',
    'SECRET-CREDENTIAL-REF',
  ])));
  assertEq(credentialRefOnly.ok, false, 'live mode requires credential-file');
  assert(credentialRefOnly.gates.some((gate) => gate.name === 'credential-file-indirection' && !gate.ok), 'credential-file gate blocks');
  assert(!formatTorBoxLiveSmokeText({
    report: 'phase-43-torbox-live-smoke-cli',
    phase: 43,
    ok: false,
    liveSmokeAttempted: true,
    wouldContactTorBox: true,
    command: 'smoke:torbox-readonly',
    mode: 'live-transport-smoke',
    probe: 'service-status',
    operation: 'status-check',
    category: 'not-authorized',
    evidence: {
      statuses: ['unknown'],
      counts: { serviceStatusChecks: 1, hosterMetadataChecks: 0, cacheAvailabilityChecks: 0, availabilityHits: 0, availabilityMisses: 0, availabilityUnknown: 1 },
      credentialFile: 'configured',
      scopedRef: 'not-recorded',
    },
    notes: [],
  }).includes('SECRET-PATH-SENTINEL'), 'formatter never prints paths');
});

await test('injected live smoke runner emits fixed redacted evidence for status and hoster probes', async () => {
  const requests: TorBoxTransportRequest[] = [];
  const transport: TorBoxTransport = {
    async request(request): Promise<TorBoxTransportResponse> {
      requests.push(request);
      return { status: 200, body: { availability: 'available' } };
    },
  };
  for (const probe of ['service-status', 'hoster-metadata'] as const) {
    const report = await runTorBoxLiveSmoke({ options: expectOptions(parseTorBoxSmokeShellArgs(liveArgs(['--probe', probe]))), transport });
    assertEq(report.ok, true, `${probe} passes`);
    assertEq(report.category, 'live-smoke-ok', `${probe} fixed category`);
    const output = `${formatTorBoxLiveSmokeJson(report)}\n${formatTorBoxLiveSmokeText(report)}`;
    for (const forbidden of ['SECRET-PATH-SENTINEL', 'SECRET-PROVIDER-PAYLOAD', 'api.torbox.app', 'Authorization', 'Bearer', 'token']) {
      assert(!output.includes(forbidden), `${probe} output excludes ${forbidden}`);
    }
  }
  assertEq(requests.length, 2, 'two injected transport calls');
  assertEq(requests[0]?.operation, 'status-check', 'status operation');
  assertEq(requests[1]?.operation, 'hoster-list', 'hoster operation');
});

await test('cache live smoke requires raw scoped ref for request but never emits it', async () => {
  const missing = buildTorBoxSmokeShellReport(expectOptions(parseTorBoxSmokeShellArgs(liveArgs([
    '--probe',
    'cache-availability',
    '--ref-type',
    'infohash',
    '--scoped-ref-present',
  ]))));
  assertEq(missing.ok, false, 'presence marker is not enough for live cache smoke');
  assertEq(missing.category, 'empty-ref', 'missing raw scoped ref blocks');

  let requestedRef = '';
  const transport: TorBoxTransport = {
    async request(request): Promise<TorBoxTransportResponse> {
      requestedRef = request.scopedRef?.refValue ?? '';
      return { status: 200, body: { availability: 'unavailable' } };
    },
  };
  const report = await runTorBoxLiveSmoke({
    options: expectOptions(parseTorBoxSmokeShellArgs(liveArgs([
      '--probe',
      'cache-availability',
      '--ref-type',
      'infohash',
      '--scoped-ref',
      'RAW-REF-SECRET',
    ]))),
    transport,
  });
  assertEq(requestedRef, 'RAW-REF-SECRET', 'runner passes scoped ref to injected transport');
  assertEq(report.ok, true, 'cache smoke returns advisory result');
  assertEq(report.evidence.counts.availabilityMisses, 1, 'miss count recorded');
  const output = `${formatTorBoxLiveSmokeJson(report)}\n${formatTorBoxLiveSmokeText(report)}`;
  assert(!output.includes('RAW-REF-SECRET'), 'raw scoped ref is not printed');
});

await test('CLI refuses before live transport when gates are missing and never echoes secret values', () => {
  const result = spawnSync('npm', [
    'run',
    '--silent',
    'smoke:torbox-readonly',
    '--',
    '--',
    '--live-smoke',
    '--live-transport',
    '--read-only',
    '--redacted',
    '--operator-authorized',
    '--credential-ref',
    'SECRET-CREDENTIAL-REF',
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  assertEq(result.status, 2, 'CLI refuses without credential file');
  const output = `${result.stdout}\n${result.stderr}`;
  assert(!output.includes('SECRET-CREDENTIAL-REF'), 'credential ref value not echoed');
  assert(!output.includes('SECRET-PATH-SENTINEL'), 'path sentinel not echoed');
  const parsed = JSON.parse(result.stdout);
  assertEq(parsed.report, 'phase-43-torbox-live-smoke-cli', 'live preflight report emitted');
  assertEq(parsed.ok, false, 'preflight blocks');
});

await test('source keeps live capability confined to operator CLI and injected runner', () => {
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  for (const banned of ['@torbox/torbox-api', 'node-fetch', 'undici', 'axios', 'got', 'puppeteer', 'playwright']) {
    assert(!allDeps.includes(banned), `no ${banned} dependency`);
  }

  const shell = read('src/ops/torbox-smoke-shell.ts');
  const runner = read('src/ops/torbox-live-smoke-runner.ts');
  const cli = read('src/ops/torbox-smoke-cli.ts');
  for (const forbidden of ['node:fs', 'globalThis.fetch', 'process.env', '@torbox/torbox-api', "from 'pg'", 'ADAPTER_MODE', 'createAdapter']) {
    assert(!shell.includes(forbidden), `shell excludes ${forbidden}`);
    assert(!runner.includes(forbidden), `runner excludes ${forbidden}`);
  }
  assert(cli.includes('globalThis.fetch'), 'CLI is the TorBox fetch attachment point');
  assert(cli.includes('openSync') && cli.includes('readSync') && !cli.includes('readFileSync'), 'CLI uses bounded explicit credential file read');
  for (const forbidden of ['process.env', '@torbox/torbox-api', "from 'pg'", 'ADAPTER_MODE', 'createAdapter', 'requestdl', 'requestDownloadLink', 'create-download', 'cdn-url']) {
    assert(!cli.includes(forbidden), `CLI excludes ${forbidden}`);
  }

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
