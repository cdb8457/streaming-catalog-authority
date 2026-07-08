import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildO5KekClosureGateReport,
  formatO5KekClosureGateJson,
  parseO5KekClosureGateJson,
  sampleO5KekPreflightReport,
  sampleO5KekVerdictReport,
  type O5KekClosureGateReport,
} from '../src/ops/o5-kek-closure-gate.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/o5-kek-closure-gate-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 118 O5 KEK closure gate suite:\n');

test('ready KEK preflight plus GO verdict becomes ready for final O5 authorization but closes no gates', () => {
  const report = buildO5KekClosureGateReport(sampleO5KekPreflightReport(), sampleO5KekVerdictReport());
  assert(report.report === 'phase-118-o5-kek-closure-gate-preflight', 'report id');
  assert(report.reviewReadiness === 'ready-for-final-o5-authorization', 'ready for final auth');
  assert(report.o5Status === 'closure-ready-pending-final-authorization', 'closure-ready status');
  assert(report.o4Status === 'closed/authorized', 'O4 remains authorized');
  assert(report.productionReady === false, 'not production ready');
  assert(report.closesO4 === false && report.closesO5 === false, 'no closure');
  assert(report.inputValuesEchoed === false, 'no values echoed');
  assert(report.commandExecution === false, 'no execution');
  assert(report.serviceInstalled === false && report.serviceStarted === false, 'no service mutation');
});

test('not-ready KEK preflight or non-GO verdict blocks final authorization readiness', () => {
  const badPreflight = buildO5KekClosureGateReport({
    ...sampleO5KekPreflightReport(),
    reviewReadiness: 'not-ready-for-review',
  }, sampleO5KekVerdictReport());
  assert(badPreflight.reviewReadiness === 'not-ready-for-final-o5-authorization', 'bad KEK preflight blocks');
  assert(badPreflight.o5Status === 'open/deferred', 'bad KEK preflight keeps O5 open');

  const holdVerdict = buildO5KekClosureGateReport(sampleO5KekPreflightReport(), {
    ...sampleO5KekVerdictReport(),
    verdict: 'HOLD',
    reviewReadiness: 'not-ready-for-o5-closure-gate',
  });
  assert(holdVerdict.reviewReadiness === 'not-ready-for-final-o5-authorization', 'HOLD blocks');
  assert(holdVerdict.summary.fail > 0, 'HOLD creates failed required literals');
});

test('parser and CLI read explicit KEK preflight and verdict reports without path or value leaks', () => {
  assert(parseO5KekClosureGateJson('{bad', 'kekPreflight') === 'KEK_PREFLIGHT_JSON_MALFORMED', 'KEK preflight malformed');
  assert(parseO5KekClosureGateJson('[]', 'verdict') === 'VERDICT_REPORT_OBJECT_REQUIRED', 'verdict array');
  const dir = mkdtempSync(join(tmpdir(), 'o5-kek-gate-'));
  try {
    const kekPreflight = join(dir, 'kek-preflight.json');
    const verdict = join(dir, 'verdict.json');
    writeFileSync(kekPreflight, JSON.stringify({ ...sampleO5KekPreflightReport(), notes: 'CUSTODIAN_KEK=base64secret' }), 'utf8');
    writeFileSync(verdict, JSON.stringify({ ...sampleO5KekVerdictReport(), notes: 'PRIVATE_TITLE_SENTINEL' }), 'utf8');
    const result = runCli(['--kek-preflight', kekPreflight, '--verdict', verdict, '--json']);
    const stdout = String(result.stdout);
    assert(result.status === 0, 'CLI exits zero');
    const parsed = JSON.parse(stdout) as O5KekClosureGateReport;
    assert(parsed.reviewReadiness === 'ready-for-final-o5-authorization', 'stdout ready');
    for (const forbidden of [kekPreflight, verdict, dir, 'CUSTODIAN_KEK=base64secret', 'PRIVATE_TITLE_SENTINEL']) {
      assert(!stdout.includes(forbidden), `stdout omits ${forbidden}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI rejects missing and oversized inputs without path leaks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o5-kek-gate-'));
  try {
    const good = join(dir, 'good.json');
    const oversized = join(dir, 'oversized.json');
    writeFileSync(good, JSON.stringify(sampleO5KekPreflightReport()), 'utf8');
    writeFileSync(oversized, JSON.stringify({ padding: 'x'.repeat(70 * 1024) }), 'utf8');
    for (const args of [
      ['--json'],
      ['--kek-preflight', join(dir, 'missing.json'), '--verdict', good, '--json'],
      ['--kek-preflight', oversized, '--verdict', good, '--json'],
      ['--kek-preflight', good, '--verdict', join(dir, 'missing.json'), '--json'],
      ['--kek-preflight', good, '--verdict', oversized, '--json'],
    ]) {
      const result = runCli(args);
      assert(result.status !== 0, `non-zero for ${args.join(' ')}`);
      const combined = `${String(result.stdout)}\n${String(result.stderr)}`;
      assert(!combined.includes(dir), 'no directory path leak');
      assert(!combined.includes(oversized), 'no oversized path leak');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source and docs preserve closure-gate-only boundary', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert(pkg.scripts['ops:o5-kek-closure-gate'] === 'tsx src/ops/o5-kek-closure-gate-cli.ts', 'ops script');
  assert(pkg.scripts['test:o5-kek-closure-gate'] === 'tsx test/o5-kek-closure-gate.ts', 'test script');
  assert(formatO5KekClosureGateJson(buildO5KekClosureGateReport(sampleO5KekPreflightReport(), sampleO5KekVerdictReport())).includes('phase-118-o5-kek-closure-gate-preflight'), 'json report');

  const source = `${read('src/ops/o5-kek-closure-gate.ts')}\n${read('src/ops/o5-kek-closure-gate-cli.ts')}`;
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `source excludes ${forbidden}`);

  const docs = `${read('docs/PHASE_118_O5_KEK_CLOSURE_GATE.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const required of [
    'Phase 118',
    'phase-118-o5-kek-closure-gate-preflight',
    'phase-30-kek-evidence-preflight',
    'phase-117-o5-kek-review-verdict-preflight',
    'ready-for-final-o5-authorization',
    'closure-ready-pending-final-authorization',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'productionReady: false',
    'closesO4: false',
    'closesO5: false',
    'O5 remains open',
    'FileCustodian remains a hardened reference harness',
  ]) assert(docs.includes(required), `docs include ${required}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}

