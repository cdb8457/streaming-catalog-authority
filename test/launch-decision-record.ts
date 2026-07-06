import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildLaunchDecisionRecordInputErrorReport,
  buildLaunchDecisionRecordReport,
  formatLaunchDecisionRecordJson,
  parseLaunchDecisionRecordJson,
  type LaunchDecisionRecordReport,
} from '../src/ops/launch-decision-record.js';

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
    report: 'phase-85-launch-decision-record',
    sourcePacket: 'phase-84-operator-acceptance-packet',
    disposition: 'launch-candidate-requested',
    productionSecurityDecision: 'residual-risk-accepted',
    unraidOperatorRehearsal: 'accepted',
    liveServiceValidation: 'accepted',
    independentReviewerVerdict: 'GO',
    redactionSafe: true,
    artifactContentsIncluded: false,
    credentialValuesIncluded: false,
    credentialPathsIncluded: false,
    rawRefsIncluded: false,
    providerPayloadsIncluded: false,
    liveServiceContact: false,
    commandExecution: false,
    launchApproved: false,
    productionReady: false,
    closesO4: false,
    closesO5: false,
    fileCustodianStatus: 'reference-harness-not-production-kms',
    ...overrides,
  };
}

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/launch-decision-record-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function assertNoLeak(output: string): void {
  for (const sentinel of [
    'SECRET_VALUE_SENTINEL',
    'DATABASE_URL_SENTINEL',
    'TOKEN_VALUE_SENTINEL',
    'PRIVATE_TITLE_SENTINEL',
    'RAW_REF_SENTINEL',
    'INFOHASH_SENTINEL',
    'MAGNET_SENTINEL',
    'provider payload body',
    'credential-file-contents',
    'postgres://',
    'http://localhost',
    'https://api',
    'Authorization',
    'Bearer ',
    'Basic ',
    'OAuth',
  ]) assert(!output.includes(sentinel), `output excludes ${sentinel}`);
}

console.log('Running Phase 85 launch decision record suite:\n');

test('launch-candidate-requested record is ready only with reviewer GO and accepted gates', () => {
  const report = buildLaunchDecisionRecordReport(record());
  assert(report.report === 'phase-85-launch-decision-record-preflight', 'report name');
  assert(report.sourcePacket === 'phase-84-operator-acceptance-packet', 'source packet');
  assert(report.disposition === 'launch-candidate-requested', 'disposition');
  assert(report.launchCandidateReadiness === 'ready-for-review', 'ready for review');
  assert(report.launchApproved === false, 'does not approve launch');
  assert(report.productionReady === false, 'does not claim production ready');
  assert(report.closesO4 === false && report.closesO5 === false, 'does not close O4/O5');
  assert(report.findings.some((finding) => finding.code === 'RESIDUAL_RISK_ACCEPTED_FOR_O4_OR_O5'), 'residual risk warning');

  const noGo = buildLaunchDecisionRecordReport(record({ independentReviewerVerdict: 'HOLD' }));
  assert(noGo.launchCandidateReadiness === 'blocked', 'HOLD blocks launch candidate readiness');
  assert(noGo.findings.some((finding) => finding.code === 'LAUNCH_CANDIDATE_REQUIRES_REVIEWER_GO'), 'GO required');
});

test('blocked and deferred decisions are recordable but stay blocked', () => {
  for (const disposition of ['blocked', 'deferred']) {
    const report = buildLaunchDecisionRecordReport(record({
      disposition,
      productionSecurityDecision: 'blocked',
      unraidOperatorRehearsal: 'deferred',
      liveServiceValidation: 'deferred',
      independentReviewerVerdict: 'NOT_REQUESTED',
    }));
    assert(report.summary.fail === 0, `${disposition} has no validation failure`);
    assert(report.launchCandidateReadiness === 'blocked', `${disposition} remains blocked`);
    assert(report.launchApproved === false, `${disposition} does not approve launch`);
  }
});

test('unsafe metadata and hostile values fail without echoing values', () => {
  const hostile = [
    'SECRET_VALUE_SENTINEL',
    'postgres://DATABASE_URL_SENTINEL',
    'TOKEN_VALUE_SENTINEL',
    'RAW_REF_SENTINEL',
    'PRIVATE_TITLE_SENTINEL',
    'provider payload body',
    'https://api.example.invalid/private',
  ].join(' ');
  const report = buildLaunchDecisionRecordReport(record({
    artifactContentsIncluded: true,
    credentialValuesIncluded: true,
    credentialPathsIncluded: true,
    rawRefsIncluded: true,
    providerPayloadsIncluded: true,
    liveServiceContact: true,
    commandExecution: true,
    launchApproved: true,
    productionReady: true,
    notes: hostile,
  }));
  const output = formatLaunchDecisionRecordJson(report);
  assert(report.launchCandidateReadiness === 'blocked', 'unsafe metadata blocks readiness');
  assert(report.summary.fail > 0, 'unsafe metadata fails');
  assertNoLeak(output);
});

test('parser and input errors fail closed without value echo', () => {
  assert(parseLaunchDecisionRecordJson('{nope') === 'LAUNCH_DECISION_JSON_MALFORMED', 'malformed JSON');
  assert(parseLaunchDecisionRecordJson('[]') === 'LAUNCH_DECISION_OBJECT_REQUIRED', 'array rejected');
  assert(parseLaunchDecisionRecordJson('\ufeff{"ok":true}') instanceof Object, 'BOM accepted');
  const report = buildLaunchDecisionRecordInputErrorReport('LAUNCH_DECISION_FILE_READ_FAILED');
  assert(report.launchCandidateReadiness === 'blocked', 'input error blocked');
  assert(!formatLaunchDecisionRecordJson(report).includes('/secret/path'), 'no path echo');
});

test('CLI reads one explicit decision file and emits parseable JSON without path leaks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'launch-decision-'));
  try {
    const decisionPath = join(dir, 'decision.json');
    writeFileSync(decisionPath, JSON.stringify(record()), 'utf8');
    const result = runCli([decisionPath, '--json']);
    const stdout = String(result.stdout);
    const stderr = String(result.stderr);
    assert(result.status === 0, 'CLI exits zero');
    const parsed = JSON.parse(stdout) as LaunchDecisionRecordReport;
    assert(parsed.report === 'phase-85-launch-decision-record-preflight', 'stdout JSON report');
    assert(parsed.launchCandidateReadiness === 'ready-for-review', 'stdout ready');
    assert(!stdout.includes(decisionPath), 'stdout omits path');
    assert(!stderr.includes(decisionPath), 'stderr omits path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI rejects missing, directory, oversized, and multiple inputs without path leaks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'launch-decision-'));
  try {
    const oversized = join(dir, 'oversized.json');
    writeFileSync(oversized, JSON.stringify({ padding: 'x'.repeat(70 * 1024) }), 'utf8');
    mkdirSync(join(dir, 'subdir'));
    for (const args of [
      ['--json'],
      [join(dir, 'missing.json'), '--json'],
      [join(dir, 'subdir'), '--json'],
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

test('npm package-script JSON invocation emits parseable redaction-safe JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'launch-decision-'));
  try {
    const decisionPath = join(dir, 'decision.json');
    writeFileSync(decisionPath, JSON.stringify(record()), 'utf8');
    const result = spawnSync('npm', ['run', '--silent', 'ops:launch-decision-record', '--', '--', decisionPath, '--json'], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    assert(result.status === 0, 'npm script exits zero');
    const parsed = JSON.parse(String(result.stdout)) as LaunchDecisionRecordReport;
    assert(parsed.report === 'phase-85-launch-decision-record-preflight', 'stdout is Phase 85 JSON');
    assert(parsed.recordValuesEchoed === false, 'no record values echoed');
    assert(!String(result.stdout).includes(decisionPath), 'stdout omits path');
    assertNoLeak(String(result.stdout));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('docs and source preserve launch decision boundaries', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert(pkg.scripts['ops:launch-decision-record'] === 'tsx src/ops/launch-decision-record-cli.ts', 'ops script present');
  assert(pkg.scripts['test:launch-decision-record'] === 'tsx test/launch-decision-record.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/operator-acceptance-packet.ts && tsx test/launch-decision-record.ts'), 'suite follows Phase 84 in npm test');

  const pureSource = read('src/ops/launch-decision-record.ts');
  const cliSource = read('src/ops/launch-decision-record-cli.ts');
  const source = `${pureSource}\n${cliSource}`;
  for (const forbidden of [
    "from 'pg'",
    'from "pg"',
    'node:https',
    'node:http',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'readFile',
    'writeFile',
    'createWriteStream',
    'readdirSync',
    'existsSync',
    'execFileSync',
    'spawnSync',
    'localStorage',
    'sessionStorage',
    'Set-Cookie',
    'Authorization',
    'Bearer',
    'Basic',
    'OAuth',
  ]) assert(!source.includes(forbidden), `Phase 85 source excludes ${forbidden}`);
  assert(!pureSource.includes("from 'node:fs'"), 'pure module has no filesystem dependency');
  assert(cliSource.includes("from 'node:fs'"), 'CLI has bounded explicit file reads');

  const docs = `${read('docs/PHASE_85_LAUNCH_DECISION_RECORD.md')}\n${read('README.md')}\n${read('test/deploy.ts')}`;
  for (const kw of [
    'Phase 85',
    'Launch Decision Record',
    'ops:launch-decision-record',
    'test:launch-decision-record',
    'phase-85-launch-decision-record',
    'single-operator-supplied-launch-decision-record-json-file',
    'launchApproved: false',
    'productionReady: false',
    'O4',
    'O5',
    'FileCustodian',
    'No launch approval',
  ]) assert(docs.includes(kw), `docs include ${kw}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
