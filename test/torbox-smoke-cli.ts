import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildTorBoxSmokeShellReport,
  formatTorBoxSmokeShellJson,
  formatTorBoxSmokeShellText,
  parseTorBoxSmokeShellArgs,
  torBoxSmokeShellUsage,
  type TorBoxSmokeShellOptions,
} from '../src/ops/torbox-smoke-shell.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`);
}

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const exists = (rel: string): boolean => existsSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)));
const repoRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/');

function walkTs(relDir: string): Array<[string, string]> {
  const abs = fileURLToPath(new URL(`../${relDir}`, import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
  return walk(abs).map((path) => [path.replace(/\\/g, '/').replace(repoRoot, ''), readFileSync(path, 'utf8')]);
}

function assertIncludes(blob: string, terms: string[], label: string): void {
  for (const term of terms) assert(blob.includes(term), `${label} includes ${term}`);
}
function expectOptions(parsed: TorBoxSmokeShellOptions | { readonly error: string }): TorBoxSmokeShellOptions {
  if ('error' in parsed) throw new Error(`unexpected parse error: ${parsed.error}`);
  return parsed;
}

console.log('Running Phase 37 TorBox smoke CLI shell suite:\n');

const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const root = fileURLToPath(new URL('../', import.meta.url));

test('Phase 37 docs, shell, CLI, and scripts exist and are wired', () => {
  assert(exists('docs/PHASE_37_TORBOX_SMOKE_CLI_SHELL.md'), 'Phase 37 doc exists');
  assert(exists('src/ops/torbox-smoke-shell.ts'), 'pure shell module exists');
  assert(exists('src/ops/torbox-smoke-cli.ts'), 'CLI wrapper exists');
  assertEq(pkg.scripts['smoke:torbox-readonly'], 'tsx src/ops/torbox-smoke-cli.ts', 'operator smoke script present');
  assertEq(pkg.scripts['test:torbox-smoke-cli'], 'tsx test/torbox-smoke-cli.ts', 'focused test script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-smoke-cli.ts'), 'deterministic shell suite is in npm test');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');
  assert(!(pkg.scripts.ci ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm ci');
});

test('default shell report refuses before live smoke and before TorBox contact', () => {
  const parsed = parseTorBoxSmokeShellArgs([]);
  const report = buildTorBoxSmokeShellReport(expectOptions(parsed));
  assertEq(report.ok, false, 'report is not ok');
  assertEq(report.liveSmokeAttempted, false, 'no live smoke attempted');
  assertEq(report.wouldContactTorBox, false, 'no TorBox contact');
  assertEq(report.category, 'not-authorized', 'first default block is authorization');
  assert(report.gates.some((gate) => gate.name === 'local-fixture-transport-attached' && !gate.ok && gate.category === 'transport'), 'fixture transport gate blocks');
});

test('fully acknowledged shell still blocks because no live transport is attached', () => {
  const parsed = parseTorBoxSmokeShellArgs([
    '--live-smoke',
    '--read-only',
    '--redacted',
    '--operator-authorized',
    '--credential-ref',
    'SECRET-SENTINEL-REF',
    '--probe',
    'hoster-metadata',
  ]);
  const report = buildTorBoxSmokeShellReport(expectOptions(parsed));
  assertEq(report.category, 'transport', 'final block is missing transport');
  assertEq(report.operation, 'hoster-list', 'hoster probe maps to operation');
  assertEq(report.evidence.credentialRef, 'configured', 'credential ref is booleanized');
  const publicOutput = `${formatTorBoxSmokeShellJson(report)}\n${formatTorBoxSmokeShellText(report)}`;
  assert(!publicOutput.includes('SECRET-SENTINEL-REF'), 'credential ref value is not printed');
  assert(!publicOutput.includes('token') && !publicOutput.includes('apikey'), 'no credential-like output');
});

test('cache probe validates ref type and scoped-ref presence without raw ref values', () => {
  const unsupported = parseTorBoxSmokeShellArgs([
    '--live-smoke',
    '--read-only',
    '--redacted',
    '--operator-authorized',
    '--credential-ref',
    'opaque',
    '--probe',
    'cache-availability',
    '--ref-type',
    'raw-infohash-secret',
  ]);
  const unsupportedReport = buildTorBoxSmokeShellReport(expectOptions(unsupported));
  assertEq(unsupportedReport.category, 'unsupported-ref', 'unsupported ref type blocks first');

  const missingRef = parseTorBoxSmokeShellArgs([
    '--live-smoke',
    '--read-only',
    '--redacted',
    '--operator-authorized',
    '--credential-ref',
    'opaque',
    '--probe',
    'cache-availability',
    '--ref-type',
    'infohash',
  ]);
  const missingReport = buildTorBoxSmokeShellReport(expectOptions(missingRef));
  assertEq(missingReport.category, 'empty-ref', 'missing scoped ref marker blocks');

  const okPreflight = parseTorBoxSmokeShellArgs([
    '--live-smoke',
    '--read-only',
    '--redacted',
    '--operator-authorized',
    '--credential-ref',
    'RAW-REF-SECRET',
    '--probe',
    'cache-availability',
    '--ref-type',
    'infohash',
    '--scoped-ref-present',
  ]);
  const report = buildTorBoxSmokeShellReport(expectOptions(okPreflight));
  assertEq(report.category, 'transport', 'valid cache preflight still blocks on no transport');
  assertEq(report.evidence.scopedRef, 'present', 'scoped ref presence is booleanized');
  assert(!formatTorBoxSmokeShellJson(report).includes('RAW-REF-SECRET'), 'raw ref value is not printed');
});

test('unsupported arguments fail closed through usage without secret echo', () => {
  const parsed = parseTorBoxSmokeShellArgs(['--credential-ref', 'SECRET-VALUE', '--unsupported']);
  assert('error' in parsed && parsed.error === 'unsupported-argument', 'unsupported argument rejected');
  assert(!torBoxSmokeShellUsage().includes('SECRET-VALUE'), 'usage does not echo values');
});

test('CLI emits parseable JSON refusal and never prints credential ref values', () => {
  const result = spawnSync('npm', [
    'run',
    '--silent',
    'smoke:torbox-readonly',
    '--',
    '--',
    '--live-smoke',
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
  assertEq(result.status, 2, 'CLI refuses with usage/preflight status');
  const parsed = JSON.parse(result.stdout) as ReturnType<typeof buildTorBoxSmokeShellReport>;
  assertEq(parsed.report, 'phase-38-torbox-smoke-cli-fixture-harness', 'JSON report name');
  assertEq(parsed.wouldContactTorBox, false, 'JSON says no TorBox contact');
  assertEq(parsed.category, 'transport', 'acknowledged command blocks on no transport');
  assert(!`${result.stdout}\n${result.stderr}`.includes('SECRET-CREDENTIAL-REF'), 'credential ref value not echoed');
});

test('CLI text refusal is redaction-safe and not live-network capable', () => {
  let output = '';
  try {
    output = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/torbox-smoke-cli.ts'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const caught = err as { stdout?: string; stderr?: string; status?: number };
    assertEq(caught.status, 2, 'default CLI exits with refusal status');
    output = `${caught.stdout ?? ''}\n${caught.stderr ?? ''}`;
  }
  assertIncludes(output, [
    'torbox read-only smoke preflight shell',
    'would-contact-torbox: false',
    'BLOCK operator-authorization',
    'No live TorBox transport is attached in Phase 38.',
  ], 'text refusal');
});

test('docs preserve boundaries, redaction, and production gates', () => {
  const combined = [
    read('docs/PHASE_37_TORBOX_SMOKE_CLI_SHELL.md'),
    read('docs/PHASE_36_TORBOX_LIVE_SMOKE_CONTRACT.md'),
    read('README.md'),
  ].join('\n');
  assertIncludes(combined, [
    'does not add a live TorBox transport',
    'refuses before provider contact',
    'absent from `npm run test` / `npm run ci`',
    'no live TorBox calls',
    'no real TorBox transport implementation',
    'no `@torbox/torbox-api` dependency or import',
    'no global fetch',
    'no environment-variable reads',
    'no ADAPTER_MODE wiring',
    'no adapter-factory mode for TorBox',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian` remains a hardened reference harness',
  ], 'Phase 37 docs');
  for (const forbidden of ['request-download-link', 'request-permalink', 'user list', 'user data', 'control', 'delete', 'export', 'CDN', 'permalink URL', 'playback', 'downloading']) {
    assert(combined.includes(forbidden), `Phase 37 docs forbid ${forbidden}`);
  }
});

test('source has no SDK, network, env, DB, Docker, adapter-mode, or provider-write creep', () => {
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  for (const banned of ['@torbox/torbox-api', 'node-fetch', 'undici', 'axios', 'got', 'puppeteer', 'playwright']) {
    assert(!allDeps.includes(banned), `no ${banned} dependency`);
  }
  const source = `${read('src/ops/torbox-smoke-shell.ts')}\n${read('src/ops/torbox-smoke-cli.ts')}`;
  for (const forbidden of [
    '@torbox/torbox-api',
    "from 'pg'",
    'from "pg"',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'window.fetch',
    'fetch(',
    'process.env',
    'readFileSync',
    'readdirSync',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'createTorBoxTransport',
    'TorBoxLiveTransport',
    'requestDownloadLink',
    'create-download',
  ]) assert(!source.includes(forbidden), `Phase 37 source excludes ${forbidden}`);

  const torboxRuntime = walkTs('src')
    .filter(([path]) => /src\/ops\/torbox-smoke-(shell|cli)\.ts$/.test(path) || /src\/core\/adapters\/torbox/.test(path))
    .map(([path, text]) => `${path}\n${text}`)
    .join('\n');
  assert(!torboxRuntime.includes('globalThis.fetch'), 'TorBox runtime has no global fetch');
  assert(!torboxRuntime.includes("from '@torbox/torbox-api'"), 'TorBox runtime has no SDK import');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
