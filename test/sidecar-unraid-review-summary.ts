import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildSidecarUnraidReviewSummaryReport,
  formatSidecarUnraidReviewSummaryJson,
  parseSidecarUnraidReviewSummaryJson,
  type SidecarUnraidReviewSummaryReport,
} from '../src/ops/sidecar-unraid-review-summary.js';

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

function gate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    report: 'phase-108-sidecar-unraid-review-gate',
    redactionSafe: true,
    evidenceValuesEchoed: false,
    commandExecution: false,
    liveServiceContact: false,
    providerContactAllowed: false,
    serviceInstalled: false,
    serviceStarted: false,
    reviewReadiness: 'ready-for-review',
    closesO4: false,
    closesO5: false,
    ...overrides,
  };
}

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/sidecar-unraid-review-summary-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 109 sidecar Unraid review summary suite:\n');

test('ready Phase 108 review gate becomes ready for acceptance record', () => {
  const report = buildSidecarUnraidReviewSummaryReport(gate());
  assert(report.report === 'phase-109-sidecar-unraid-review-summary', 'report id');
  assert(report.reviewReadiness === 'ready-for-acceptance-record', 'ready');
  assert(report.inputValuesEchoed === false, 'no values echoed');
  assert(report.commandExecution === false, 'no execution');
  assert(report.serviceInstalled === false, 'no install');
  assert(report.providerContactAllowed === false, 'no provider contact');
  assert(report.closesO4 === false && report.closesO5 === false, 'no gate closure');
});

test('unsafe or not-ready Phase 108 fields block acceptance readiness', () => {
  const report = buildSidecarUnraidReviewSummaryReport(gate({ reviewReadiness: 'not-ready-for-review', serviceInstalled: true }));
  assert(report.reviewReadiness === 'not-ready-for-acceptance-record', 'not ready');
  assert(report.summary.fail >= 2, 'failures counted');
});

test('parser and CLI read one explicit review-gate file without path or value leaks', () => {
  assert(parseSidecarUnraidReviewSummaryJson('{bad') === 'REVIEW_SUMMARY_JSON_MALFORMED', 'malformed');
  assert(parseSidecarUnraidReviewSummaryJson('[]') === 'REVIEW_SUMMARY_OBJECT_REQUIRED', 'array');
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-review-summary-'));
  try {
    const input = join(dir, 'review-gate.json');
    writeFileSync(input, JSON.stringify(gate({ hostile: 'SECRET_VALUE_SENTINEL' })), 'utf8');
    const result = runCli([input, '--json']);
    const stdout = String(result.stdout);
    assert(result.status === 0, 'CLI exits zero');
    const parsed = JSON.parse(stdout) as SidecarUnraidReviewSummaryReport;
    assert(parsed.reviewReadiness === 'ready-for-acceptance-record', 'stdout ready');
    assert(!stdout.includes(input), 'stdout omits path');
    assert(!stdout.includes('SECRET_VALUE_SENTINEL'), 'stdout omits hostile value');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source and docs preserve summary-only boundary', () => {
  const source = `${read('src/ops/sidecar-unraid-review-summary.ts')}\n${read('src/ops/sidecar-unraid-review-summary-cli.ts')}`;
  const docs = `${read('docs/PHASE_109_SIDECAR_UNRAID_REVIEW_SUMMARY.md')}\n${read('README.md')}\n${read('package.json')}`;
  assert((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts['ops:sidecar-unraid-review-summary'] === 'tsx src/ops/sidecar-unraid-review-summary-cli.ts', 'ops script');
  assert(formatSidecarUnraidReviewSummaryJson(buildSidecarUnraidReviewSummaryReport(gate())).includes('SIDECAR_UNRAID_REVIEW_SUMMARY'), 'json code');
  for (const forbidden of ['node:http', 'node:https', 'node:net', 'globalThis.fetch', 'fetch(', 'execSync', 'spawnSync', 'ProviderAdapter', 'TorBoxReadOnlyClient', 'JellyfinHttpClient']) {
    assert(!source.includes(forbidden), `source excludes ${forbidden}`);
  }
  for (const required of ['Phase 109', 'SIDECAR_UNRAID_REVIEW_SUMMARY', 'single-redacted-phase-108-review-gate-json-file', 'closesO4: false', 'closesO5: false', 'O4/O5 remain open/deferred']) {
    assert(docs.includes(required), `docs include ${required}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
