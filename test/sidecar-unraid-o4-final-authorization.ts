import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildSidecarUnraidO4FinalAuthorizationReport,
  formatSidecarUnraidO4FinalAuthorizationJson,
  parseSidecarUnraidO4FinalAuthorizationJson,
  sampleSidecarUnraidO4AuthorizationRecord,
  sampleSidecarUnraidO4ClosureGateReport,
  type SidecarUnraidO4FinalAuthorizationReport,
} from '../src/ops/sidecar-unraid-o4-final-authorization.js';

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
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/sidecar-unraid-o4-final-authorization-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 116 sidecar Unraid O4 final authorization suite:\n');

test('ready Phase 115 gate plus fixed authorization closes only O4', () => {
  const report = buildSidecarUnraidO4FinalAuthorizationReport(sampleSidecarUnraidO4ClosureGateReport(), sampleSidecarUnraidO4AuthorizationRecord());
  assert(report.report === 'phase-116-sidecar-unraid-o4-final-authorization', 'report id');
  assert(report.authorizationStatus === 'o4-authorized', 'authorized');
  assert(report.o4Status === 'closed/authorized', 'O4 closed');
  assert(report.closesO4 === true, 'closes O4');
  assert(report.o5Status === 'open/deferred', 'O5 remains open');
  assert(report.closesO5 === false, 'does not close O5');
  assert(report.productionReady === false, 'not production ready');
  assert(report.commandExecution === false, 'no execution');
  assert(report.serviceInstalled === false && report.serviceStarted === false, 'no service mutation');
});

test('not-ready gate or wrong authorization scope blocks O4 closure', () => {
  const badGate = buildSidecarUnraidO4FinalAuthorizationReport({
    ...sampleSidecarUnraidO4ClosureGateReport(),
    reviewReadiness: 'not-ready-for-final-o4-authorization',
  }, sampleSidecarUnraidO4AuthorizationRecord());
  assert(badGate.authorizationStatus === 'not-authorized', 'bad gate blocks auth');
  assert(badGate.o4Status === 'open/deferred' && badGate.closesO4 === false, 'bad gate keeps O4 open');

  const badAuth = buildSidecarUnraidO4FinalAuthorizationReport(sampleSidecarUnraidO4ClosureGateReport(), {
    ...sampleSidecarUnraidO4AuthorizationRecord(),
    scope: 'production-launch',
  });
  assert(badAuth.authorizationStatus === 'not-authorized', 'bad scope blocks auth');
  assert(badAuth.closesO4 === false, 'bad scope does not close O4');
});

test('parser and CLI read explicit gate and authorization records without path or value leaks', () => {
  assert(parseSidecarUnraidO4FinalAuthorizationJson('{bad', 'closureGate') === 'CLOSURE_GATE_JSON_MALFORMED', 'gate malformed');
  assert(parseSidecarUnraidO4FinalAuthorizationJson('[]', 'authorization') === 'AUTHORIZATION_OBJECT_REQUIRED', 'auth array');
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-o4-final-'));
  try {
    const gate = join(dir, 'gate.json');
    const authorization = join(dir, 'authorization.json');
    writeFileSync(gate, JSON.stringify({ ...sampleSidecarUnraidO4ClosureGateReport(), notes: 'SECRET_GATE_SENTINEL' }), 'utf8');
    writeFileSync(authorization, JSON.stringify({ ...sampleSidecarUnraidO4AuthorizationRecord(), notes: 'PRIVATE_AUTH_SENTINEL' }), 'utf8');
    const result = runCli(['--closure-gate', gate, '--authorization', authorization, '--json']);
    const stdout = String(result.stdout);
    assert(result.status === 0, 'CLI exits zero');
    const parsed = JSON.parse(stdout) as SidecarUnraidO4FinalAuthorizationReport;
    assert(parsed.authorizationStatus === 'o4-authorized', 'stdout authorized');
    for (const forbidden of [gate, authorization, dir, 'SECRET_GATE_SENTINEL', 'PRIVATE_AUTH_SENTINEL']) {
      assert(!stdout.includes(forbidden), `stdout omits ${forbidden}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI rejects missing and oversized inputs without path leaks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-o4-final-'));
  try {
    const good = join(dir, 'good.json');
    const oversized = join(dir, 'oversized.json');
    writeFileSync(good, JSON.stringify(sampleSidecarUnraidO4ClosureGateReport()), 'utf8');
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
  assert(pkg.scripts['ops:sidecar-unraid-o4-final-authorization'] === 'tsx src/ops/sidecar-unraid-o4-final-authorization-cli.ts', 'ops script');
  assert(pkg.scripts['test:sidecar-unraid-o4-final-authorization'] === 'tsx test/sidecar-unraid-o4-final-authorization.ts', 'test script');
  assert(formatSidecarUnraidO4FinalAuthorizationJson(buildSidecarUnraidO4FinalAuthorizationReport(sampleSidecarUnraidO4ClosureGateReport(), sampleSidecarUnraidO4AuthorizationRecord())).includes('phase-116-sidecar-unraid-o4-final-authorization'), 'json report');

  const source = `${read('src/ops/sidecar-unraid-o4-final-authorization.ts')}\n${read('src/ops/sidecar-unraid-o4-final-authorization-cli.ts')}`;
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

  const docs = `${read('docs/PHASE_116_SIDECAR_UNRAID_O4_FINAL_AUTHORIZATION.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const required of [
    'Phase 116',
    'phase-116-sidecar-unraid-o4-final-authorization',
    'phase-116-sidecar-unraid-o4-final-authorization-record',
    'phase-115-sidecar-unraid-o4-closure-gate-preflight',
    'o4-authorized',
    'closed/authorized',
    'enabled O4 closure flag',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'productionReady: false',
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
