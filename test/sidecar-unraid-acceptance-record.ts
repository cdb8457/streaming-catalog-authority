import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildSidecarUnraidAcceptanceReport,
  formatSidecarUnraidAcceptanceJson,
  parseSidecarUnraidAcceptanceJson,
  type SidecarUnraidAcceptanceReport,
} from '../src/ops/sidecar-unraid-acceptance-record.js';

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

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    report: 'phase-110-sidecar-unraid-acceptance-record',
    decision: 'accepted',
    independentReviewerVerdict: 'GO',
    reviewSummaryPreflight: 'ready-for-acceptance-record',
    redactionSafe: true,
    recordValuesEchoed: false,
    commandExecution: false,
    serviceInstalled: false,
    serviceStarted: false,
    providerContactAllowed: false,
    closesO4: false,
    closesO5: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    ...overrides,
  };
}

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/sidecar-unraid-acceptance-record-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 110 sidecar Unraid acceptance record suite:\n');

test('accepted record is ready only with reviewer GO and closes no gates', () => {
  const report = buildSidecarUnraidAcceptanceReport(record());
  assert(report.report === 'phase-110-sidecar-unraid-acceptance-preflight', 'report id');
  assert(report.decision === 'accepted', 'accepted');
  assert(report.reviewReadiness === 'ready-for-handoff', 'ready');
  assert(report.serviceInstalled === false, 'no service install');
  assert(report.providerContactAllowed === false, 'no provider contact');
  assert(report.closesO4 === false && report.closesO5 === false, 'no O4/O5 closure');
  const noGo = buildSidecarUnraidAcceptanceReport(record({ independentReviewerVerdict: 'HOLD' }));
  assert(noGo.reviewReadiness === 'not-ready-for-handoff', 'accepted without GO blocks');
});

test('rejected and deferred records are allowed but still no production claim', () => {
  for (const decision of ['rejected', 'deferred']) {
    const report = buildSidecarUnraidAcceptanceReport(record({ decision, independentReviewerVerdict: 'HOLD' }));
    assert(report.reviewReadiness === 'ready-for-handoff', `${decision} ready for handoff`);
    assert(report.closesO4 === false && report.closesO5 === false, `${decision} no closure`);
    assert(report.findings.some((finding) => finding.code.includes(decision.toUpperCase())), `${decision} warning`);
  }
});

test('parser and CLI read one explicit acceptance file without path or value leaks', () => {
  assert(parseSidecarUnraidAcceptanceJson('{bad') === 'ACCEPTANCE_JSON_MALFORMED', 'malformed');
  assert(parseSidecarUnraidAcceptanceJson('[]') === 'ACCEPTANCE_OBJECT_REQUIRED', 'array');
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-acceptance-'));
  try {
    const input = join(dir, 'acceptance.json');
    writeFileSync(input, JSON.stringify(record({ notes: 'PRIVATE_TITLE_SENTINEL SECRET_VALUE_SENTINEL' })), 'utf8');
    const result = runCli([input, '--json']);
    const stdout = String(result.stdout);
    assert(result.status === 0, 'CLI exits zero');
    const parsed = JSON.parse(stdout) as SidecarUnraidAcceptanceReport;
    assert(parsed.reviewReadiness === 'ready-for-handoff', 'stdout ready');
    assert(!stdout.includes(input), 'stdout omits path');
    assert(!stdout.includes('PRIVATE_TITLE_SENTINEL'), 'stdout omits hostile value');
    assert(!stdout.includes('SECRET_VALUE_SENTINEL'), 'stdout omits hostile secret');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source and docs preserve acceptance-only boundary', () => {
  const source = `${read('src/ops/sidecar-unraid-acceptance-record.ts')}\n${read('src/ops/sidecar-unraid-acceptance-record-cli.ts')}`;
  const docs = `${read('docs/PHASE_110_SIDECAR_UNRAID_ACCEPTANCE_RECORD.md')}\n${read('README.md')}\n${read('package.json')}`;
  assert((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts['ops:sidecar-unraid-acceptance-record'] === 'tsx src/ops/sidecar-unraid-acceptance-record-cli.ts', 'ops script');
  assert(formatSidecarUnraidAcceptanceJson(buildSidecarUnraidAcceptanceReport(record())).includes('phase-110-sidecar-unraid-acceptance-preflight'), 'json report');
  for (const forbidden of ['node:http', 'node:https', 'node:net', 'globalThis.fetch', 'fetch(', 'execSync', 'spawnSync', 'ProviderAdapter', 'TorBoxReadOnlyClient', 'JellyfinHttpClient']) {
    assert(!source.includes(forbidden), `source excludes ${forbidden}`);
  }
  for (const required of ['Phase 110', 'phase-110-sidecar-unraid-acceptance-record', 'single-operator-supplied-sidecar-unraid-acceptance-record-json-file', 'decision', 'closesO4: false', 'closesO5: false', 'O4/O5 remain open/deferred']) {
    assert(docs.includes(required), `docs include ${required}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
