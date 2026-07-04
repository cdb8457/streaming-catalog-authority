import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildTorBoxLiveSmokeAcceptanceInputErrorReport,
  buildTorBoxLiveSmokeAcceptanceReport,
  formatTorBoxLiveSmokeAcceptanceJson,
  parseTorBoxLiveSmokeAcceptanceJson,
  type TorBoxLiveSmokeAcceptanceReport,
} from '../src/ops/torbox-live-smoke-acceptance-record.js';

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
    report: 'phase-54-torbox-live-smoke-acceptance-record',
    decision: 'accepted',
    independentReviewerVerdict: 'GO',
    packetManifestPreflight: 'ready-for-review',
    redactionSafe: true,
    artifactContentsIncluded: false,
    credentialValuesIncluded: false,
    credentialPathsIncluded: false,
    rawRefsIncluded: false,
    providerPayloadsIncluded: false,
    liveTorBoxContact: false,
    commandExecution: false,
    enablesProviderMode: false,
    closesO4: false,
    closesO5: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    ...overrides,
  };
}

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/torbox-live-smoke-acceptance-record-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 54 TorBox live smoke acceptance record suite:\n');

test('accepted record is ready only with packet manifest ready and reviewer GO', () => {
  const report = buildTorBoxLiveSmokeAcceptanceReport(record());
  assert(report.report === 'phase-54-torbox-live-smoke-acceptance-preflight', 'report name');
  assert(report.decision === 'accepted', 'accepted decision');
  assert(report.reviewReadiness === 'ready-for-review', 'ready');
  assert(report.enablesProviderMode === false, 'does not enable provider mode');
  assert(report.findings.some((finding) => finding.code === 'INDEPENDENT_REVIEWER_GO'), 'reviewer GO required');

  const noGo = buildTorBoxLiveSmokeAcceptanceReport(record({ independentReviewerVerdict: 'HOLD' }));
  assert(noGo.reviewReadiness === 'not-ready-for-review', 'accepted without GO blocks');
  assert(noGo.findings.some((finding) => finding.code === 'INDEPENDENT_REVIEWER_GO_REQUIRED'), 'GO required code');
});

test('rejected and deferred records are allowed but never enable provider mode', () => {
  for (const decision of ['rejected', 'deferred']) {
    const report = buildTorBoxLiveSmokeAcceptanceReport(record({ decision, independentReviewerVerdict: 'HOLD' }));
    assert(report.reviewReadiness === 'ready-for-review', `${decision} can be recorded`);
    assert(report.enablesProviderMode === false, `${decision} does not enable provider mode`);
    assert(report.findings.some((finding) => finding.level === 'warn' && finding.code.includes(decision.toUpperCase())), `${decision} warning`);
  }
});

test('unsafe metadata and hostile values do not leak', () => {
  const sentinels = [
    'TORBOX_TOKEN=secret-token',
    '/run/secrets/torbox-token',
    'RAW-INFOHASH-SECRET',
    'https://api.torbox.app/v1/api/torrents/checkcached?token=secret',
    'Private Movie Title 1999',
  ];
  const report = buildTorBoxLiveSmokeAcceptanceReport(record({
    credentialValuesIncluded: true,
    credentialPathsIncluded: true,
    rawRefsIncluded: true,
    providerPayloadsIncluded: true,
    artifactContentsIncluded: true,
    notes: sentinels.join(' '),
  }));
  const output = formatTorBoxLiveSmokeAcceptanceJson(report);
  assert(report.reviewReadiness === 'not-ready-for-review', 'unsafe metadata blocks');
  for (const sentinel of sentinels) assert(!output.includes(sentinel), `output excludes ${sentinel}`);
});

test('parser and input errors fail closed without value echo', () => {
  assert(parseTorBoxLiveSmokeAcceptanceJson('{nope') === 'ACCEPTANCE_JSON_MALFORMED', 'malformed');
  assert(parseTorBoxLiveSmokeAcceptanceJson('[]') === 'ACCEPTANCE_OBJECT_REQUIRED', 'array');
  assert(parseTorBoxLiveSmokeAcceptanceJson('\ufeff{"ok":true}') instanceof Object, 'BOM accepted');
  const report = buildTorBoxLiveSmokeAcceptanceInputErrorReport('ACCEPTANCE_FILE_READ_FAILED');
  assert(report.reviewReadiness === 'not-ready-for-review', 'input error not ready');
  assert(!formatTorBoxLiveSmokeAcceptanceJson(report).includes('/secret/path'), 'no path echo');
});

test('CLI reads one explicit acceptance file and emits parseable JSON without path leaks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'torbox-acceptance-'));
  try {
    const acceptancePath = join(dir, 'acceptance.json');
    writeFileSync(acceptancePath, JSON.stringify(record()), 'utf8');
    const result = runCli([acceptancePath, '--json']);
    const stdout = String(result.stdout);
    const stderr = String(result.stderr);
    assert(result.status === 0, 'CLI exits zero');
    const parsed = JSON.parse(stdout) as TorBoxLiveSmokeAcceptanceReport;
    assert(parsed.report === 'phase-54-torbox-live-smoke-acceptance-preflight', 'stdout JSON report');
    assert(parsed.reviewReadiness === 'ready-for-review', 'stdout ready');
    assert(!stdout.includes(acceptancePath), 'stdout omits path');
    assert(!stderr.includes(acceptancePath), 'stderr omits path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI rejects missing, directory, oversized, and multiple inputs without path leaks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'torbox-acceptance-'));
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
      assert(result.status !== 0, `non-zero for ${args.length} args`);
      const combined = `${String(result.stdout)}\n${String(result.stderr)}`;
      assert(!combined.includes(dir), 'no directory path leak');
      assert(!combined.includes(oversized), 'no file path leak');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('npm package-script JSON invocation emits parseable redaction-safe JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'torbox-acceptance-'));
  try {
    const acceptancePath = join(dir, 'acceptance.json');
    writeFileSync(acceptancePath, JSON.stringify(record()), 'utf8');
    const result = spawnSync('npm', ['run', '--silent', 'ops:torbox-live-smoke-acceptance-record', '--', '--', acceptancePath, '--json'], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    assert(result.status === 0, 'npm script exits zero');
    const parsed = JSON.parse(String(result.stdout)) as TorBoxLiveSmokeAcceptanceReport;
    assert(parsed.report === 'phase-54-torbox-live-smoke-acceptance-preflight', 'stdout is Phase 54 JSON');
    assert(parsed.recordValuesEchoed === false, 'no record values echoed');
    assert(!String(result.stdout).includes(acceptancePath), 'stdout omits path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('docs and source preserve static acceptance boundaries', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  assert(pkg.scripts['ops:torbox-live-smoke-acceptance-record'] === 'tsx src/ops/torbox-live-smoke-acceptance-record-cli.ts', 'ops script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-smoke-acceptance-record.ts'), 'suite in npm test');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');

  const source = `${read('src/ops/torbox-live-smoke-acceptance-record.ts')}\n${read('src/ops/torbox-live-smoke-acceptance-record-cli.ts')}`;
  for (const forbidden of [
    '@torbox/torbox-api',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'request-download-link',
    'request-permalink',
    'readdirSync',
    'existsSync',
    'execFileSync',
    'spawnSync',
    'docker compose',
  ]) assert(!source.includes(forbidden), `Phase 54 source excludes ${forbidden}`);
  assert(!read('src/ops/torbox-live-smoke-acceptance-record.ts').includes("from 'node:fs'"), 'pure module has no filesystem dependency');
  assert(read('src/ops/torbox-live-smoke-acceptance-record-cli.ts').includes("from 'node:fs'"), 'CLI has bounded explicit file reads');

  const docs = `${read('docs/PHASE_54_TORBOX_LIVE_SMOKE_ACCEPTANCE_RECORD.md')}\n${read('README.md')}`;
  for (const kw of [
    'phase-54-torbox-live-smoke-acceptance-record',
    'ops:torbox-live-smoke-acceptance-record',
    'single-operator-supplied-acceptance-record-json-file',
    'enablesProviderMode',
    'no artifact contents',
    'does not enable TorBox provider mode',
    'O4 and O5 remain open/deferred',
    'FileCustodian',
  ]) assert(docs.includes(kw), `docs include ${kw}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
