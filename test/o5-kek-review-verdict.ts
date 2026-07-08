import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildO5KekReviewVerdictReport,
  formatO5KekReviewVerdictJson,
  parseO5KekReviewVerdictJson,
  sampleO5KekReviewVerdictRecord,
  type O5KekReviewVerdictReport,
} from '../src/ops/o5-kek-review-verdict.js';

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
  return { ...sampleO5KekReviewVerdictRecord(), ...overrides };
}

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/o5-kek-review-verdict-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 117 O5 KEK review verdict suite:\n');

test('GO verdict becomes ready for O5 closure gate but closes no gates', () => {
  const report = buildO5KekReviewVerdictReport(record());
  assert(report.report === 'phase-117-o5-kek-review-verdict-preflight', 'report id');
  assert(report.verdict === 'GO', 'GO verdict');
  assert(report.reviewReadiness === 'ready-for-o5-closure-gate', 'ready for later gate');
  assert(report.verdictValuesEchoed === false, 'no values echoed');
  assert(report.rawReviewerNotesIncluded === false, 'no raw notes');
  assert(report.commandExecution === false, 'no execution');
  assert(report.productionReady === false, 'not production ready');
  assert(report.serviceInstalled === false && report.serviceStarted === false, 'no service install/start');
  assert(report.closesO4 === false && report.closesO5 === false, 'no closure in this phase');
  assert(report.o4Status === 'closed/authorized' && report.o5Status === 'open/deferred', 'O4 done, O5 open');
});

test('HOLD, REJECTED, and invalid verdicts are not ready for O5 closure gate', () => {
  for (const verdict of ['HOLD', 'REJECTED']) {
    const report = buildO5KekReviewVerdictReport(record({ verdict }));
    assert(report.reviewReadiness === 'not-ready-for-o5-closure-gate', `${verdict} not ready`);
    assert(report.summary.fail === 0, `${verdict} is a valid record`);
    assert(report.findings.some((finding) => finding.code.includes(String(verdict))), `${verdict} finding`);
  }
  const invalid = buildO5KekReviewVerdictReport(record({ verdict: 'MAYBE' }));
  assert(invalid.verdict === 'invalid', 'invalid verdict');
  assert(invalid.reviewReadiness === 'not-ready-for-o5-closure-gate', 'invalid not ready');
  assert(invalid.summary.fail > 0, 'invalid fails');
});

test('unsafe metadata blocks readiness and does not leak hostile values', () => {
  const report = buildO5KekReviewVerdictReport(record({
    rawReviewerNotesIncluded: true,
    rawEvidenceIncluded: true,
    productionReady: true,
    notes: 'SECRET_VALUE_SENTINEL PRIVATE_TITLE_SENTINEL CUSTODIAN_KEK=base64secret',
  }));
  const output = formatO5KekReviewVerdictJson(report);
  assert(report.reviewReadiness === 'not-ready-for-o5-closure-gate', 'unsafe not ready');
  assert(report.summary.fail >= 3, 'failures counted');
  for (const forbidden of ['SECRET_VALUE_SENTINEL', 'PRIVATE_TITLE_SENTINEL', 'CUSTODIAN_KEK=base64secret']) {
    assert(!output.includes(forbidden), `output omits ${forbidden}`);
  }
});

test('parser and CLI read one explicit verdict file without path or value leaks', () => {
  assert(parseO5KekReviewVerdictJson('{bad') === 'VERDICT_JSON_MALFORMED', 'malformed');
  assert(parseO5KekReviewVerdictJson('[]') === 'VERDICT_OBJECT_REQUIRED', 'array');
  assert(parseO5KekReviewVerdictJson('\ufeff{"ok":true}') instanceof Object, 'BOM accepted');
  const dir = mkdtempSync(join(tmpdir(), 'o5-kek-review-verdict-'));
  try {
    const input = join(dir, 'verdict.json');
    writeFileSync(input, JSON.stringify(record({ notes: 'SECRET_VALUE_SENTINEL' })), 'utf8');
    const result = runCli([input, '--json']);
    const stdout = String(result.stdout);
    assert(result.status === 0, 'CLI exits zero');
    const parsed = JSON.parse(stdout) as O5KekReviewVerdictReport;
    assert(parsed.reviewReadiness === 'ready-for-o5-closure-gate', 'stdout ready');
    assert(!stdout.includes(input), 'stdout omits path');
    assert(!stdout.includes(dir), 'stdout omits directory');
    assert(!stdout.includes('SECRET_VALUE_SENTINEL'), 'stdout omits hostile value');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI rejects missing, directory, oversized, and multiple inputs without path leaks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o5-kek-review-verdict-'));
  try {
    const oversized = join(dir, 'oversized.json');
    writeFileSync(oversized, JSON.stringify({ padding: 'x'.repeat(70 * 1024) }), 'utf8');
    for (const args of [
      ['--json'],
      [join(dir, 'missing.json'), '--json'],
      [dir, '--json'],
      [oversized, '--json'],
      [oversized, oversized, '--json'],
    ]) {
      const result = runCli(args);
      assert(result.status !== 0, `non-zero for ${args.join(' ')}`);
      const combined = `${String(result.stdout)}\n${String(result.stderr)}`;
      assert(!combined.includes(dir), 'no directory path leak');
      assert(!combined.includes(oversized), 'no file path leak');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source and docs preserve verdict-only boundary', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert(pkg.scripts['ops:o5-kek-review-verdict'] === 'tsx src/ops/o5-kek-review-verdict-cli.ts', 'ops script');
  assert(pkg.scripts['test:o5-kek-review-verdict'] === 'tsx test/o5-kek-review-verdict.ts', 'test script');
  const source = `${read('src/ops/o5-kek-review-verdict.ts')}\n${read('src/ops/o5-kek-review-verdict-cli.ts')}`;
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

  const docs = `${read('docs/PHASE_117_O5_KEK_REVIEW_VERDICT.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const required of [
    'Phase 117',
    'phase-117-o5-kek-review-verdict',
    'phase-117-o5-kek-review-verdict-preflight',
    'single-redacted-o5-kek-review-verdict-json-file',
    'phase-30-kek-evidence-preflight',
    'GO',
    'HOLD',
    'REJECTED',
    'verdictValuesEchoed: false',
    'rawReviewerNotesIncluded: false',
    'productionReady: false',
    'closesO4: false',
    'closesO5: false',
    'ready-for-o5-closure-gate',
    'FileCustodian remains a hardened reference harness',
  ]) assert(docs.includes(required), `docs include ${required}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}

