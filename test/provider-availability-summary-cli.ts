import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/provider-availability-summary-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function report(status: string, action: string): unknown {
  return {
    adapterStatus: status === 'invalid' || status === 'stale' ? 'unknown' : status,
    decision: { status, action, advisoryOnly: true, persisted: false, redactionSafe: true },
    advisoryOnly: true,
    persisted: false,
    redactionSafe: true,
    echoesAdapterLocator: false,
    echoesAdapterDetail: false,
  };
}

console.log('Running Phase 58 provider availability summary CLI suite:\n');

test('CLI summarizes explicit bridge report files into redaction-safe JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-summary-'));
  try {
    const hit = join(dir, 'hit.json');
    const miss = join(dir, 'miss.json');
    writeFileSync(hit, JSON.stringify(report('available', 'candidate')), 'utf8');
    writeFileSync(miss, JSON.stringify(report('unavailable', 'skip')), 'utf8');

    const result = runCli([hit, miss, '--json']);
    assertEq(result.status, 0, 'exit');
    const summary = JSON.parse(String(result.stdout)) as { readiness: string; counts: Record<string, number>; itemRowsIncluded: boolean };
    assertEq(summary.readiness, 'has-candidates', 'readiness');
    assertEq(summary.counts.total, 2, 'total');
    assertEq(summary.counts.candidate, 1, 'candidate');
    assertEq(summary.counts.skip, 1, 'skip');
    assertEq(summary.itemRowsIncluded, false, 'no rows');
    assert(!String(result.stdout).includes(hit), 'stdout omits path');
    assert(!String(result.stderr).includes(hit), 'stderr omits path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI fails closed for missing, malformed, directory, and oversized inputs without path leaks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-summary-'));
  try {
    const malformed = join(dir, 'malformed.json');
    const oversized = join(dir, 'oversized.json');
    const subdir = join(dir, 'subdir');
    writeFileSync(malformed, '{"decision":', 'utf8');
    writeFileSync(oversized, JSON.stringify({ padding: 'x'.repeat(70 * 1024) }), 'utf8');
    mkdirSync(subdir);

    const result = runCli([join(dir, 'missing.json'), malformed, oversized, subdir, '--json']);
    assertEq(result.status, 1, 'hold exit');
    const summary = JSON.parse(String(result.stdout)) as { readiness: string; counts: Record<string, number> };
    assertEq(summary.readiness, 'held', 'held');
    assertEq(summary.counts.total, 4, 'total');
    assertEq(summary.counts.invalid, 4, 'invalid');
    const combined = `${String(result.stdout)}\n${String(result.stderr)}`;
    assert(!combined.includes(dir), 'no directory path leak');
    assert(!combined.includes(oversized), 'no oversized path leak');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI rejects missing operands and unsupported flags', () => {
  assertEq(runCli(['--json']).status, 2, 'missing operand exits usage');
  assertEq(runCli(['--unsupported']).status, 2, 'unsupported exits usage');
});

test('npm package-script JSON invocation is parseable and redaction-safe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-summary-'));
  try {
    const path = join(dir, 'hit.json');
    writeFileSync(path, JSON.stringify(report('available', 'candidate')), 'utf8');
    const result = spawnSync('npm', ['run', '--silent', 'ops:provider-availability-summary', '--', '--', path, '--json'], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    assertEq(result.status, 0, 'npm exit');
    const parsed = JSON.parse(String(result.stdout)) as { report: string; providerDetailsIncluded: boolean };
    assertEq(parsed.report, 'phase-57-provider-availability-summary', 'summary report');
    assertEq(parsed.providerDetailsIncluded, false, 'no provider details');
    assert(!String(result.stdout).includes(path), 'stdout omits path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source and docs preserve no provider/runtime scope creep', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['ops:provider-availability-summary'], 'tsx src/ops/provider-availability-summary-cli.ts', 'ops script');
  assertEq(pkg.scripts['test:provider-availability-summary-cli'], 'tsx test/provider-availability-summary-cli.ts', 'test script');
  assert((pkg.scripts.test ?? '').includes('test/provider-availability-summary-cli.ts'), 'suite in npm test');

  const source = `${read('src/core/adapters/provider-availability-summary.ts')}\n${read('src/ops/provider-availability-summary-cli.ts')}`;
  for (const forbidden of [
    '@torbox/torbox-api',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'request-download-link',
    'request-permalink',
    'document.',
    'window.',
  ]) assert(!source.includes(forbidden), `source excludes ${forbidden}`);
  assert(read('README.md').includes('Provider availability summary CLI (Phase 58)'), 'README mentions phase');
  assert(read('test/deploy.ts').includes('provider availability summary CLI - Phase 58'), 'deploy guard mentions phase');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
