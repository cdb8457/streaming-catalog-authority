import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSidecarFactoryEvidencePacket } from '../src/ops/sidecar-factory-evidence.js';
import { reviewSidecarFactoryEvidence } from '../src/ops/sidecar-factory-evidence-review.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];
const tests: Array<readonly [string, () => void | Promise<void>]> = [];

function test(name: string, fn: () => void | Promise<void>): void {
  tests.push([name, fn]);
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-sidecar-factory-review-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

function cli(args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/sidecar-factory-evidence-review-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function cliOk(args: readonly string[]): string {
  return execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/sidecar-factory-evidence-review-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 190 sidecar factory evidence review suite:\n');

test('review accepts fresh Phase 189 evidence output', async () => {
  await withTempDir(async (dir) => {
    const evidence = join(dir, 'phase-189.json');
    writeJson(evidence, await buildSidecarFactoryEvidencePacket());
    const report = reviewSidecarFactoryEvidence({ files: [evidence] });
    assert(report.report === 'phase-190-sidecar-factory-evidence-review', 'report id');
    assert(report.ok === true, 'ok');
    assert(report.reviewed === 1 && report.passed === 1 && report.failed === 0, 'counts');
    assert(report.closesO4 === false && report.closesO5 === false, 'does not close O4/O5');
    assert(report.files[0]?.checks.every((check) => check.state === 'pass'), 'all checks pass');
  });
});

test('review fails malformed JSON, missing schema, failed checks, unsafe boundary, and secret-looking values', async () => {
  await withTempDir(async (dir) => {
    const good = await buildSidecarFactoryEvidencePacket();
    const malformed = join(dir, 'malformed.json');
    const missing = join(dir, 'missing.json');
    const failedCheck = join(dir, 'failed-check.json');
    const boundary = join(dir, 'boundary.json');
    const secret = join(dir, 'secret.json');
    writeFileSync(malformed, '{nope', 'utf8');
    writeJson(missing, { report: 'phase-189-sidecar-factory-evidence' });
    writeJson(failedCheck, { ...good, checks: [{ id: 'daemon-wrapper-started', status: 'fail', label: 'bad' }] });
    writeJson(boundary, { ...good, runtimeCutoverAllowed: true, note: 'runtime cutover enabled' });
    writeJson(secret, { ...good, note: 'token: super-secret-value' });
    const report = reviewSidecarFactoryEvidence({ files: [malformed, missing, failedCheck, boundary, secret] });
    assert(report.ok === false, 'not ok');
    assert(report.failed === 5, 'all fail');
    assert(report.files.some((file) => file.checks.some((check) => check.name === 'json' && check.state === 'fail')), 'json fails');
    assert(report.files.some((file) => file.checks.some((check) => check.name === 'schema' && check.state === 'fail')), 'schema fails');
    assert(report.files.some((file) => file.checks.some((check) => check.name === 'pass-state' && check.state === 'fail')), 'pass-state fails');
    assert(report.files.some((file) => file.checks.some((check) => check.name === 'boundary' && check.state === 'fail')), 'boundary fails');
    assert(report.files.some((file) => file.checks.some((check) => check.name === 'redaction' && check.state === 'fail')), 'redaction fails');
  });
});

test('CLI prints PASS/FAIL summaries and returns nonzero on any failure', async () => {
  await withTempDir(async (dir) => {
    const pass = join(dir, 'pass.json');
    const passWithBom = join(dir, 'pass-with-bom.json');
    const fail = join(dir, 'fail.json');
    const good = await buildSidecarFactoryEvidencePacket();
    writeJson(pass, good);
    writeFileSync(passWithBom, `\uFEFF${JSON.stringify(good)}\n`, 'utf8');
    writeJson(fail, { ...good, providerContactAllowed: true });
    const text = cliOk([pass]);
    assert(text.includes('PASS'), 'pass text');
    const bomText = cliOk([passWithBom]);
    assert(bomText.includes('PASS'), 'PowerShell UTF-8 BOM file passes');
    const failedRun = cli([pass, fail]);
    assert(failedRun.status === 1, 'nonzero on failure');
    assert(String(failedRun.stdout).includes('FAIL'), 'fail text');
    const json = cliOk(['--json', pass]);
    assert(json.includes('phase-190-sidecar-factory-evidence-review'), 'json report');
    const documented = execSync(`npm run --silent ops:sidecar-factory-evidence-review -- -- --json "${pass}"`, {
      cwd: root,
      encoding: 'utf8',
    });
    assert(documented.includes('"ok":true'), 'documented npm command returns JSON');
  });
});

test('source, docs, and package preserve Phase 190 static review boundary', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert(pkg.scripts['test:sidecar-factory-evidence-review'] === 'tsx test/sidecar-factory-evidence-review.ts', 'test script');
  assert(pkg.scripts['ops:sidecar-factory-evidence-review'] === 'tsx src/ops/sidecar-factory-evidence-review-cli.ts', 'ops script');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-factory-evidence.ts && tsx test/sidecar-factory-evidence-review.ts && tsx test/sidecar-unraid-service-plan.ts'),
    'aggregate order',
  );
  const source = `${read('src/ops/sidecar-factory-evidence-review.ts')}\n${read('src/ops/sidecar-factory-evidence-review-cli.ts')}`;
  const combined = `${source}\n${read('docs/PHASE_190_SIDECAR_FACTORY_EVIDENCE_REVIEW.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const required of [
    'phase-190-sidecar-factory-evidence-review',
    'ops:sidecar-factory-evidence-review',
    'valid JSON',
    'required Phase 189 evidence fields',
    'overall evidence and every required check passed',
    'review keeps sidecar evidence local and non-mutating',
    'redaction-safe labels',
    'closesO4',
    'closesO5',
  ]) assert(combined.includes(required), `surface includes ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    '@aws-sdk',
    '@azure',
    '@google-cloud',
    'express',
    'fastify',
    'koa',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `source excludes ${forbidden}`);
});

for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    failures.push([name, err]);
    console.log(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
