import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewOperatorUiEvidence } from '../src/ops/operator-ui-evidence-review.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    failures.push([name, err]);
    console.log(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

function sampleEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    report: 'phase-150-operator-ui-live-check',
    baseUrl: 'http://app:8099',
    ok: true,
    checks: [
      { name: 'healthz', state: 'pass', statusCode: 200, detail: 'health endpoint returned ok' },
      { name: 'unauth-status', state: 'pass', statusCode: 401, detail: 'status endpoint rejected missing token' },
      { name: 'auth-status', state: 'pass', statusCode: 200, detail: 'authenticated status returned ok' },
      { name: 'auth-logs', state: 'pass', statusCode: 200, detail: 'authenticated logs returned redacted entries' },
    ],
    forbidden: ['token-output', 'secret-output'],
    statusSummary: { ok: true, pass: 12, warn: 2, fail: 0, total: 14, needsAttentionCount: 2 },
    logSummary: { entries: 4 },
    ...overrides,
  };
}

function withTempEvidence(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-ui-evidence-review-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

function cli(args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/operator-ui-evidence-review-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function cliOk(args: readonly string[]): string {
  return execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/operator-ui-evidence-review-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 152 operator UI evidence review suite:\n');

test('review accepts fresh complete passing live-check evidence', () => {
  withTempEvidence((dir) => {
    const file = join(dir, 'evidence.json');
    writeJson(file, sampleEvidence());
    const report = reviewOperatorUiEvidence({ files: [file], nowMs: Date.now() });
    assert(report.report === 'phase-152-operator-ui-evidence-review', 'report id');
    assert(report.ok === true, 'ok');
    assert(report.reviewed === 1 && report.passed === 1 && report.failed === 0, 'counts');
    assert(report.files[0]?.checks.every((check) => check.state === 'pass'), 'all checks pass');
  });
});

test('review fails invalid JSON, missing schema, stale files, and failing checks', () => {
  withTempEvidence((dir) => {
    const invalid = join(dir, 'invalid.json');
    const missing = join(dir, 'missing.json');
    const stale = join(dir, 'stale.json');
    const failing = join(dir, 'failing.json');
    writeFileSync(invalid, '{nope', 'utf8');
    writeJson(missing, { report: 'phase-150-operator-ui-live-check' });
    writeJson(stale, sampleEvidence());
    writeJson(failing, sampleEvidence({ ok: false, checks: [{ name: 'healthz', state: 'fail', statusCode: 500, detail: 'bad' }] }));
    const old = new Date(Date.now() - 49 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    const report = reviewOperatorUiEvidence({ files: [invalid, missing, stale, failing], maxAgeHours: 24 });
    assert(report.ok === false, 'not ok');
    assert(report.failed === 4, 'all four fail');
    assert(report.files.some((file) => file.checks.some((check) => check.name === 'recent' && check.state === 'fail')), 'stale fails');
    assert(report.files.some((file) => file.checks.some((check) => check.name === 'json' && check.state === 'fail')), 'invalid json fails');
    assert(report.files.some((file) => file.checks.some((check) => check.name === 'schema' && check.state === 'fail')), 'schema fails');
    assert(report.files.some((file) => file.checks.some((check) => check.name === 'passing' && check.state === 'fail')), 'passing fails');
  });
});

test('CLI prints PASS/FAIL summaries and returns nonzero on any failure', () => {
  withTempEvidence((dir) => {
    const pass = join(dir, 'pass.json');
    const fail = join(dir, 'fail.json');
    writeJson(pass, sampleEvidence());
    writeJson(fail, sampleEvidence({ ok: false }));
    const text = cliOk([pass]);
    assert(text.includes('PASS'), 'pass text');
    const failedRun = cli([pass, fail]);
    assert(failedRun.status === 1, 'nonzero on failure');
    assert(String(failedRun.stdout).includes('FAIL'), 'fail text');
    const json = cliOk(['--json', pass]);
    assert(json.includes('phase-152-operator-ui-evidence-review'), 'json report');
  });
});

test('source, docs, package, and launcher preserve Phase 152 review boundary', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert(pkg.scripts['test:operator-ui-evidence-review'] === 'tsx test/operator-ui-evidence-review.ts', 'test script');
  assert(pkg.scripts['ops:operator-ui-evidence-review'] === 'tsx src/ops/operator-ui-evidence-review-cli.ts', 'ops script');
  assert((pkg.scripts.test ?? '').includes('test/operator-ui-live-check.ts && tsx test/operator-ui-evidence-review.ts'), 'aggregate order');
  const source = `${read('src/ops/operator-ui-evidence-review.ts')}\n${read('src/ops/operator-ui-evidence-review-cli.ts')}`;
  const combined = [
    source,
    read('deploy/unraid-ops-launcher.sh'),
    read('docs/PHASE_152_OPERATOR_UI_EVIDENCE_REVIEW.md'),
    read('README.md'),
    read('package.json'),
  ].join('\n');
  for (const required of [
    'phase-152-operator-ui-evidence-review',
    'ops:operator-ui-evidence-review',
    'ui-evidence-review',
    '--max-age-hours',
    'valid JSON',
    'schema',
    'recent',
    'passing',
  ]) assert(combined.includes(required), `surface includes ${required}`);
  for (const forbidden of [
    '@torbox/torbox-api',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'request-download-link',
    'magnet:',
    'docker compose',
  ]) assert(!source.includes(forbidden), `source excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
