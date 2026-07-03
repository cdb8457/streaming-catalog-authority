import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildTorBoxSmokeShellReport,
  formatTorBoxSmokeShellJson,
  formatTorBoxSmokeShellText,
  parseTorBoxSmokeShellArgs,
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
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

function expectOptions(parsed: TorBoxSmokeShellOptions | { readonly error: string }): TorBoxSmokeShellOptions {
  if ('error' in parsed) throw new Error(`unexpected parse error: ${parsed.error}`);
  return parsed;
}

function acknowledgedArgs(fixture: string): string[] {
  return [
    '--live-smoke',
    '--read-only',
    '--redacted',
    '--operator-authorized',
    '--credential-ref',
    'SECRET-CREDENTIAL-REF',
    '--fixture',
    fixture,
  ];
}

console.log('Running Phase 38 TorBox smoke fixture harness suite:\n');

test('Phase 38 docs and package wiring exist without adding live smoke to CI', () => {
  assert(exists('docs/PHASE_38_TORBOX_SMOKE_FIXTURE_HARNESS.md'), 'Phase 38 doc exists');
  assertEq(pkg.scripts['test:torbox-smoke-fixture'], 'tsx test/torbox-smoke-fixture.ts', 'focused script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-smoke-fixture.ts'), 'fixture suite is in npm test');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');
  assert(!(pkg.scripts.ci ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm ci');
});

test('available fixture produces redaction-safe PASS without TorBox contact', () => {
  const report = buildTorBoxSmokeShellReport(expectOptions(parseTorBoxSmokeShellArgs(acknowledgedArgs('available'))));
  assertEq(report.ok, true, 'fixture available passes');
  assertEq(report.category, 'fixture-ok', 'success category is fixed');
  assertEq(report.wouldContactTorBox, false, 'fixture does not contact TorBox');
  assertEq(report.mode, 'local-fixture-harness', 'fixture mode is explicit');
  assertEq(report.evidence.counts.availabilityHits, 1, 'hit count recorded');
  assert(report.gates.every((gate) => gate.ok), 'all gates pass in fixture mode');
  const publicOutput = `${formatTorBoxSmokeShellJson(report)}\n${formatTorBoxSmokeShellText(report)}`;
  assert(!publicOutput.includes('SECRET-CREDENTIAL-REF'), 'credential ref value is not printed');
});

test('failure fixtures produce fixed categories without provider strings', () => {
  for (const fixture of ['auth', 'quota', 'timeout', 'parse', 'ambiguous-response']) {
    const report = buildTorBoxSmokeShellReport(expectOptions(parseTorBoxSmokeShellArgs(acknowledgedArgs(fixture))));
    assertEq(report.ok, false, `${fixture} fixture blocks`);
    assertEq(report.category, fixture, `${fixture} category is fixed`);
    const publicOutput = `${formatTorBoxSmokeShellJson(report)}\n${formatTorBoxSmokeShellText(report)}`;
    for (const forbidden of ['SECRET-CREDENTIAL-REF', 'provider payload', 'response body', 'endpoint URL', 'account label', 'raw ref']) {
      assert(!publicOutput.includes(forbidden), `${fixture} output does not include ${forbidden}`);
    }
  }
});

test('cache fixture accepts presence marker but never raw ref value', () => {
  const parsed = parseTorBoxSmokeShellArgs([
    ...acknowledgedArgs('available'),
    '--probe',
    'cache-availability',
    '--ref-type',
    'infohash',
    '--scoped-ref-present',
  ]);
  const report = buildTorBoxSmokeShellReport(expectOptions(parsed));
  assertEq(report.ok, true, 'cache fixture passes with supported type and presence marker');
  assertEq(report.operation, 'cache-availability', 'cache operation recorded');
  assertEq(report.evidence.scopedRef, 'present', 'only scoped ref presence is recorded');
  assert(!formatTorBoxSmokeShellJson(report).includes('infohash-secret'), 'no raw ref appears');
});

test('CLI fixture success exits zero and fixture failure exits refused status', () => {
  const success = spawnSync('npm', ['run', '--silent', 'smoke:torbox-readonly', '--', '--', ...acknowledgedArgs('available'), '--json'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  assertEq(success.status, 0, 'fixture success exits zero');
  const successJson = JSON.parse(success.stdout) as ReturnType<typeof buildTorBoxSmokeShellReport>;
  assertEq(successJson.report, 'phase-38-torbox-smoke-cli-fixture-harness', 'success report name');
  assertEq(successJson.wouldContactTorBox, false, 'success fixture does not contact TorBox');
  assert(!`${success.stdout}\n${success.stderr}`.includes('SECRET-CREDENTIAL-REF'), 'success output redacts credential ref');

  const failure = spawnSync('npm', ['run', '--silent', 'smoke:torbox-readonly', '--', '--', ...acknowledgedArgs('timeout'), '--json'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  assertEq(failure.status, 2, 'fixture failure exits refused status');
  const failureJson = JSON.parse(failure.stdout) as ReturnType<typeof buildTorBoxSmokeShellReport>;
  assertEq(failureJson.category, 'timeout', 'failure category is fixed');
});

test('docs preserve no-live boundaries and production gates', () => {
  const combined = [
    read('docs/PHASE_38_TORBOX_SMOKE_FIXTURE_HARNESS.md'),
    read('docs/PHASE_37_TORBOX_SMOKE_CLI_SHELL.md'),
    read('README.md'),
  ].join('\n');
  for (const term of [
    'does not add a live TorBox transport',
    'never contacts TorBox',
    'no live TorBox calls',
    'no real TorBox transport implementation',
    'no `@torbox/torbox-api` dependency or import',
    'no global fetch',
    'no environment-variable reads',
    'no ADAPTER_MODE wiring',
    'no adapter-factory mode for TorBox',
    'request-download-link',
    'request-permalink',
    'CDN',
    'permalink URL',
    'playback',
    'downloading',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian` remains a hardened reference',
  ]) assert(combined.includes(term), `docs include ${term}`);
});

test('Phase 38 source has no SDK, network, env, DB, Docker, or adapter-mode creep', () => {
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
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
  ]) assert(!source.includes(forbidden), `Phase 38 source excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
