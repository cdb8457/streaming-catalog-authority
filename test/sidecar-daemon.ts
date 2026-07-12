import { execFileSync, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runSidecarDaemonSelfTest,
  SidecarDaemonConfigError,
  validateSidecarDaemonConfig,
  type SidecarDaemonSelfTestReport,
} from '../src/ops/sidecar-daemon.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

console.log('Running Phase 187 sidecar daemon executable suite:\n');

await test('config rejects missing values and network endpoint shapes', () => {
  assertRejects(() => validateSidecarDaemonConfig({}), 'missing config rejected');
  assertRejects(() => validateSidecarDaemonConfig({
    socketPath: '127.0.0.1:9999',
    stateDir: '/tmp/catalog-sidecar-state',
    completionSecretFile: '/tmp/completion-secret',
    kekFile: '/tmp/kek',
  }), 'network socket rejected');
  assertRejects(() => validateSidecarDaemonConfig({
    socketPath: validSocketPath('catalog-sidecar-config'),
    stateDir: 'http://example.invalid/state',
    completionSecretFile: '/tmp/completion-secret',
    kekFile: '/tmp/kek',
  }), 'network-looking state dir rejected');
});

await test('config accepts local socket, local state, and local secret files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase-187-config-'));
  try {
    const completionSecretFile = join(dir, 'completion_secret');
    const kekFile = join(dir, 'kek');
    writeFileSync(completionSecretFile, 'phase-187-test-secret\n', 'utf8');
    writeFileSync(kekFile, `${randomBytes(32).toString('hex')}\n`, 'utf8');
    const config = validateSidecarDaemonConfig({
      socketPath: validSocketPath('catalog-sidecar-valid'),
      stateDir: join(dir, 'state'),
      completionSecretFile,
      kekFile,
    });
    assert(config.stateDir.endsWith('state'), 'state dir accepted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('self-test exercises executable wrapper and emits redaction-safe evidence', async () => {
  const report = await runSidecarDaemonSelfTest();
  assert(report.ok === true, 'self-test ok');
  assert(report.report === 'phase-187-sidecar-daemon-self-test', 'report id');
  assert(report.executableImplemented === true, 'executable implemented');
  assert(report.localSocketOnly === true, 'local socket only');
  assert(report.usesFileCustodianReferenceHarness === true, 'reference harness boundary explicit');
  assert(report.serviceInstallAllowed === false, 'service install blocked');
  assert(report.composeChangeAllowed === false, 'compose change blocked');
  assert(report.runtimeCutoverAllowed === false, 'runtime cutover blocked');
  assert(report.closesO4 === false && report.closesO5 === false, 'no gate closure');
  for (const check of report.checks) assert(check.state === 'pass', `check passes: ${check.id}`);
  assertNoLeak(report);
});

await test('CLI self-test emits parseable JSON and leaks no environment sentinels', () => {
  const sentinels = ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://user:pass@example.invalid/db'];
  const output = execFileSync('node', ['--import', 'tsx', 'src/ops/sidecar-daemon-cli.ts', '--self-test', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      TOKEN: sentinels[0],
      PRIVATE_TITLE: sentinels[1],
      DATABASE_URL: sentinels[2],
    },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(output) as SidecarDaemonSelfTestReport;
  assert(parsed.ok === true, 'CLI JSON ok');
  for (const sentinel of sentinels) assert(!output.includes(sentinel), `output omits ${sentinel}`);
});

await test('documented npm command and docs preserve no-cutover boundary', () => {
  const output = execSync('npm run --silent ops:sidecar-daemon -- -- --self-test --json', { cwd: root, encoding: 'utf8' });
  const parsed = JSON.parse(output) as SidecarDaemonSelfTestReport;
  assert(parsed.ok === true, 'documented command ok');
  const source = `${read('src/ops/sidecar-daemon.ts')}\n${read('src/ops/sidecar-daemon-cli.ts')}`;
  const combined = `${source}\n${read('docs/PHASE_187_SIDECAR_DAEMON_EXECUTABLE.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const forbidden of [
    'node:http',
    'node:https',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    '@aws-sdk',
    '@azure',
    '@google-cloud',
    'express',
    'fastify',
    'koa',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 187 source excludes ${forbidden}`);
  for (const required of [
    'phase-187-sidecar-daemon-self-test',
    'SIDECAR_DAEMON_SELF_TEST',
    'ops:sidecar-daemon',
    '--self-test',
    '--serve',
    'SIDECAR_SOCKET_PATH',
    'SIDECAR_STATE_DIR',
    'SIDECAR_COMPLETION_SECRET_FILE',
    'SIDECAR_KEK_FILE',
    'local Unix socket or Windows named pipe only',
    'usesFileCustodianReferenceHarness: true',
    'serviceInstallAllowed: false',
    'composeChangeAllowed: false',
    'runtimeCutoverAllowed: false',
    'O4 remains open',
    'O5 remains open',
  ]) assert(combined.includes(required), `Phase 187 surface preserves ${required}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}

function assertRejects(fn: () => unknown, label: string): void {
  try {
    fn();
  } catch (err) {
    assert(err instanceof SidecarDaemonConfigError, `${label} error type`);
    return;
  }
  throw new Error(label);
}

function validSocketPath(name: string): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}-${process.pid}` : join(tmpdir(), `${name}-${process.pid}.sock`);
}

function assertNoLeak(value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const sentinel of [
    'phase-187-sidecar-daemon-secret',
    'phase-187-item-redacted',
    'key_',
    'rcpt_',
    'wrappedHex',
    'dekBase64',
    'postgres://',
    'http://',
    'https://',
    'PRIVATE',
  ]) assert(!text.includes(sentinel), `evidence leaked ${sentinel}`);
}
