import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildO5KekFinalAuthorizationReport,
  formatO5KekFinalAuthorizationJson,
  parseO5KekFinalAuthorizationJson,
  sampleO5KekAuthorizationRecord,
  sampleO5KekClosureGateReport,
  type O5KekFinalAuthorizationReport,
} from '../src/ops/o5-kek-final-authorization.js';

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
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/o5-kek-final-authorization-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 119 O5 KEK final authorization suite:\n');

test('ready Phase 118 gate plus fixed authorization closes only O5', () => {
  const report = buildO5KekFinalAuthorizationReport(sampleO5KekClosureGateReport(), sampleO5KekAuthorizationRecord());
  assert(report.report === 'phase-119-o5-kek-final-authorization', 'report id');
  assert(report.authorizationStatus === 'o5-authorized', 'authorized');
  assert(report.o4Status === 'closed/authorized', 'O4 remains closed');
  assert(report.o5Status === 'closed/authorized', 'O5 closed');
  assert(report.closesO4 === false, 'does not close O4');
  assert(report.closesO5 === true, 'closes O5');
  assert(report.productionReady === false, 'not production ready');
  assert(report.commandExecution === false, 'no execution');
  assert(report.serviceInstalled === false && report.serviceStarted === false, 'no service mutation');
});

test('not-ready gate or wrong authorization scope blocks O5 closure', () => {
  const badGate = buildO5KekFinalAuthorizationReport({
    ...sampleO5KekClosureGateReport(),
    reviewReadiness: 'not-ready-for-final-o5-authorization',
  }, sampleO5KekAuthorizationRecord());
  assert(badGate.authorizationStatus === 'not-authorized', 'bad gate blocks auth');
  assert(badGate.o5Status === 'open/deferred' && badGate.closesO5 === false, 'bad gate keeps O5 open');

  const badAuth = buildO5KekFinalAuthorizationReport(sampleO5KekClosureGateReport(), {
    ...sampleO5KekAuthorizationRecord(),
    scope: 'production-launch',
  });
  assert(badAuth.authorizationStatus === 'not-authorized', 'bad scope blocks auth');
  assert(badAuth.closesO5 === false, 'bad scope does not close O5');
});

test('parser and CLI read explicit gate and authorization records without path or value leaks', () => {
  assert(parseO5KekFinalAuthorizationJson('{bad', 'closureGate') === 'CLOSURE_GATE_JSON_MALFORMED', 'gate malformed');
  assert(parseO5KekFinalAuthorizationJson('[]', 'authorization') === 'AUTHORIZATION_OBJECT_REQUIRED', 'auth array');
  const dir = mkdtempSync(join(tmpdir(), 'o5-kek-final-'));
  try {
    const gate = join(dir, 'gate.json');
    const authorization = join(dir, 'authorization.json');
    writeFileSync(gate, JSON.stringify({ ...sampleO5KekClosureGateReport(), notes: 'SECRET_GATE_SENTINEL' }), 'utf8');
    writeFileSync(authorization, JSON.stringify({ ...sampleO5KekAuthorizationRecord(), notes: 'CUSTODIAN_KEK=base64secret' }), 'utf8');
    const result = runCli(['--closure-gate', gate, '--authorization', authorization, '--json']);
    const stdout = String(result.stdout);
    assert(result.status === 0, 'CLI exits zero');
    const parsed = JSON.parse(stdout) as O5KekFinalAuthorizationReport;
    assert(parsed.authorizationStatus === 'o5-authorized', 'stdout authorized');
    for (const forbidden of [gate, authorization, dir, 'SECRET_GATE_SENTINEL', 'CUSTODIAN_KEK=base64secret']) {
      assert(!stdout.includes(forbidden), `stdout omits ${forbidden}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI rejects missing and oversized inputs without path leaks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o5-kek-final-'));
  try {
    const good = join(dir, 'good.json');
    const oversized = join(dir, 'oversized.json');
    writeFileSync(good, JSON.stringify(sampleO5KekClosureGateReport()), 'utf8');
    writeFileSync(oversized, JSON.stringify({ padding: 'x'.repeat(70 * 1024) }), 'utf8');
    for (const args of [
      ['--json'],
      ['--closure-gate', join(dir, 'missing.json'), '--authorization', good, '--json'],
      ['--closure-gate', oversized, '--authorization', good, '--json'],
      ['--closure-gate', good, '--authorization', join(dir, 'missing.json'), '--json'],
      ['--closure-gate', good, '--authorization', oversized, '--json'],
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

test('source and docs preserve final-authorization-only boundary', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert(pkg.scripts['ops:o5-kek-final-authorization'] === 'tsx src/ops/o5-kek-final-authorization-cli.ts', 'ops script');
  assert(pkg.scripts['test:o5-kek-final-authorization'] === 'tsx test/o5-kek-final-authorization.ts', 'test script');
  assert(formatO5KekFinalAuthorizationJson(buildO5KekFinalAuthorizationReport(sampleO5KekClosureGateReport(), sampleO5KekAuthorizationRecord())).includes('phase-119-o5-kek-final-authorization'), 'json report');

  const source = `${read('src/ops/o5-kek-final-authorization.ts')}\n${read('src/ops/o5-kek-final-authorization-cli.ts')}`;
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

  const docs = `${read('docs/PHASE_119_O5_KEK_FINAL_AUTHORIZATION.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const required of [
    'Phase 119',
    'phase-119-o5-kek-final-authorization',
    'phase-119-o5-kek-final-authorization-record',
    'phase-118-o5-kek-closure-gate-preflight',
    'o5-authorized',
    'closed/authorized',
    'enabled O5 closure flag',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'productionReady: false',
    'closesO4: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(docs.includes(required), `docs include ${required}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}

