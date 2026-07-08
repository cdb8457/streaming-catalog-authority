import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildSidecarUnraidO4ClosureGateReport,
  formatSidecarUnraidO4ClosureGateJson,
  parseSidecarUnraidO4ClosureGateJson,
  sampleSidecarUnraidO4BoundaryReport,
  sampleSidecarUnraidO4VerdictReport,
  type SidecarUnraidO4ClosureGateReport,
} from '../src/ops/sidecar-unraid-o4-closure-gate.js';

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
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/sidecar-unraid-o4-closure-gate-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 115 sidecar Unraid O4 closure gate suite:\n');

test('ready boundary plus GO verdict becomes ready for final O4 authorization but closes no gates', () => {
  const report = buildSidecarUnraidO4ClosureGateReport(sampleSidecarUnraidO4BoundaryReport(), sampleSidecarUnraidO4VerdictReport());
  assert(report.report === 'phase-115-sidecar-unraid-o4-closure-gate-preflight', 'report id');
  assert(report.reviewReadiness === 'ready-for-final-o4-authorization', 'ready for final auth');
  assert(report.o4Status === 'closure-ready-pending-final-authorization', 'closure-ready status');
  assert(report.productionReady === false, 'not production ready');
  assert(report.closesO4 === false && report.closesO5 === false, 'no closure');
  assert(report.inputValuesEchoed === false, 'no values echoed');
  assert(report.commandExecution === false, 'no execution');
  assert(report.serviceInstalled === false && report.serviceStarted === false, 'no service mutation');
});

test('not-ready boundary or non-GO verdict blocks final authorization readiness', () => {
  const badBoundary = buildSidecarUnraidO4ClosureGateReport({
    ...sampleSidecarUnraidO4BoundaryReport(),
    reviewReadiness: 'not-ready-for-independent-review',
  }, sampleSidecarUnraidO4VerdictReport());
  assert(badBoundary.reviewReadiness === 'not-ready-for-final-o4-authorization', 'bad boundary blocks');
  assert(badBoundary.o4Status === 'open/deferred', 'bad boundary keeps O4 open');

  const holdVerdict = buildSidecarUnraidO4ClosureGateReport(sampleSidecarUnraidO4BoundaryReport(), {
    ...sampleSidecarUnraidO4VerdictReport(),
    verdict: 'HOLD',
    reviewReadiness: 'not-ready-for-o4-closure-gate',
  });
  assert(holdVerdict.reviewReadiness === 'not-ready-for-final-o4-authorization', 'HOLD blocks');
  assert(holdVerdict.summary.fail > 0, 'HOLD creates failed required literals');
});

test('parser and CLI read explicit boundary and verdict reports without path or value leaks', () => {
  assert(parseSidecarUnraidO4ClosureGateJson('{bad', 'boundary') === 'BOUNDARY_REPORT_JSON_MALFORMED', 'boundary malformed');
  assert(parseSidecarUnraidO4ClosureGateJson('[]', 'verdict') === 'VERDICT_REPORT_OBJECT_REQUIRED', 'verdict array');
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-o4-gate-'));
  try {
    const boundary = join(dir, 'boundary.json');
    const verdict = join(dir, 'verdict.json');
    writeFileSync(boundary, JSON.stringify({ ...sampleSidecarUnraidO4BoundaryReport(), notes: 'SECRET_VALUE_SENTINEL' }), 'utf8');
    writeFileSync(verdict, JSON.stringify({ ...sampleSidecarUnraidO4VerdictReport(), notes: 'PRIVATE_TITLE_SENTINEL' }), 'utf8');
    const result = runCli(['--boundary', boundary, '--verdict', verdict, '--json']);
    const stdout = String(result.stdout);
    assert(result.status === 0, 'CLI exits zero');
    const parsed = JSON.parse(stdout) as SidecarUnraidO4ClosureGateReport;
    assert(parsed.reviewReadiness === 'ready-for-final-o4-authorization', 'stdout ready');
    for (const forbidden of [boundary, verdict, dir, 'SECRET_VALUE_SENTINEL', 'PRIVATE_TITLE_SENTINEL']) {
      assert(!stdout.includes(forbidden), `stdout omits ${forbidden}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI rejects missing and oversized inputs without path leaks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-o4-gate-'));
  try {
    const good = join(dir, 'good.json');
    const oversized = join(dir, 'oversized.json');
    writeFileSync(good, JSON.stringify(sampleSidecarUnraidO4BoundaryReport()), 'utf8');
    writeFileSync(oversized, JSON.stringify({ padding: 'x'.repeat(70 * 1024) }), 'utf8');
    for (const args of [
      ['--json'],
      ['--boundary', join(dir, 'missing.json'), '--verdict', good, '--json'],
      ['--boundary', oversized, '--verdict', good, '--json'],
      ['--boundary', good, '--verdict', join(dir, 'missing.json'), '--json'],
      ['--boundary', good, '--verdict', oversized, '--json'],
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
  assert(pkg.scripts['ops:sidecar-unraid-o4-closure-gate'] === 'tsx src/ops/sidecar-unraid-o4-closure-gate-cli.ts', 'ops script');
  assert(pkg.scripts['test:sidecar-unraid-o4-closure-gate'] === 'tsx test/sidecar-unraid-o4-closure-gate.ts', 'test script');
  assert(formatSidecarUnraidO4ClosureGateJson(buildSidecarUnraidO4ClosureGateReport(sampleSidecarUnraidO4BoundaryReport(), sampleSidecarUnraidO4VerdictReport())).includes('phase-115-sidecar-unraid-o4-closure-gate-preflight'), 'json report');

  const source = `${read('src/ops/sidecar-unraid-o4-closure-gate.ts')}\n${read('src/ops/sidecar-unraid-o4-closure-gate-cli.ts')}`;
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

  const docs = `${read('docs/PHASE_115_SIDECAR_UNRAID_O4_CLOSURE_GATE.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const required of [
    'Phase 115',
    'phase-115-sidecar-unraid-o4-closure-gate-preflight',
    'phase-113-sidecar-unraid-custodian-boundary-preflight',
    'phase-114-sidecar-unraid-custodian-review-verdict-preflight',
    'ready-for-final-o4-authorization',
    'closure-ready-pending-final-authorization',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'productionReady: false',
    'closesO4: false',
    'closesO5: false',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(docs.includes(required), `docs include ${required}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
