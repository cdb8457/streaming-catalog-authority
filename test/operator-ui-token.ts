import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildOperatorUiTokenStatus,
  generateOperatorUiToken,
  isAcceptableOperatorUiToken,
  readTokenValue,
  rotateOperatorUiToken,
} from '../src/ops/operator-ui-token.js';

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

function runCli(args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/operator-ui-token-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function cliOk(args: readonly string[]): string {
  return execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/operator-ui-token-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function withTempToken(fn: (path: string, initialToken: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-operator-ui-token-'));
  try {
    const token = 'phase148-initial-token-ABCDEFGH-12345';
    const path = join(dir, 'operator_ui_token');
    writeFileSync(path, `${token}\n`, 'utf8');
    fn(path, token);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('Running Phase 148 operator UI token suite:\n');

test('token status reports metadata without exposing token value', () => {
  withTempToken((path, token) => {
    const status = buildOperatorUiTokenStatus(path);
    assert(status.report === 'phase-148-operator-ui-token', 'report id');
    assert(status.path === path, 'path retained');
    assert(status.exists === true, 'exists');
    assert(status.readable === true, 'readable');
    assert(status.acceptable === true, 'acceptable');
    assert(JSON.stringify(status).includes(token) === false, 'status omits token');
  });
});

test('rotate writes a new acceptable token and does not return its value', () => {
  withTempToken((path, initialToken) => {
    const status = rotateOperatorUiToken(path);
    const rotated = readTokenValue(path);
    assert(rotated !== initialToken, 'token rotated');
    assert(isAcceptableOperatorUiToken(rotated), 'rotated token acceptable');
    assert(JSON.stringify(status).includes(rotated) === false, 'rotate status omits new token');
    assert(status.bytes === Buffer.byteLength(rotated, 'utf8'), 'status byte count matches');
  });
});

test('CLI show-path/status/rotate are redaction-safe by default', () => {
  withTempToken((path, initialToken) => {
    assert(cliOk(['--show-path', '--path', path]).trim() === path, 'show path');
    const status = cliOk(['--status', '--json', '--path', path]);
    assert(status.includes('phase-148-operator-ui-token'), 'status json');
    assert(!status.includes(initialToken), 'status omits token');
    const rotate = cliOk(['--rotate', '--confirm', '--json', '--path', path]);
    const rotated = readTokenValue(path);
    assert(!rotate.includes(rotated), 'rotate output omits rotated token');
    assert(!rotate.includes(initialToken), 'rotate output omits old token');
  });
});

test('CLI refuses token printing unless explicitly confirmed', () => {
  withTempToken((path, token) => {
    const refused = runCli(['--print', '--path', path]);
    assert(refused.status !== 0, 'print without confirm refused');
    assert(!String(refused.stdout).includes(token), 'refused stdout omits token');
    assert(!String(refused.stderr).includes(token), 'refused stderr omits token');
    const printed = cliOk(['--print', '--confirm-print', '--path', path]);
    assert(printed.trim() === token, 'explicit confirmed print reveals token');
  });
});

test('source, docs, and package preserve Phase 148 token helper boundary', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert(pkg.scripts['test:operator-ui-token'] === 'tsx test/operator-ui-token.ts', 'test script');
  assert(pkg.scripts['ops:operator-ui-token'] === 'tsx src/ops/operator-ui-token-cli.ts', 'ops script');
  assert((pkg.scripts.test ?? '').includes('test/operator-ui-service.ts && tsx test/operator-ui-token.ts'), 'aggregate order');
  const source = `${read('src/ops/operator-ui-token.ts')}\n${read('src/ops/operator-ui-token-cli.ts')}`;
  const combined = [
    source,
    read('docs/PHASE_148_OPERATOR_UI_ACCESS.md'),
    read('README.md'),
    read('package.json'),
  ].join('\n');
  for (const required of [
    'phase-148-operator-ui-token',
    'ops:operator-ui-token',
    '--show-path',
    '--rotate --confirm',
    '--print --confirm-print',
    '/mnt/user/appdata/catalog/secrets/operator_ui_token',
  ]) assert(combined.includes(required), `surface includes ${required}`);
  for (const forbidden of [
    '@torbox/torbox-api',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'execSync',
    'spawnSync',
    'docker compose',
    'request-download-link',
  ]) assert(!source.includes(forbidden), `source excludes ${forbidden}`);
});

test('generated tokens satisfy local auth acceptance shape', () => {
  for (let i = 0; i < 10; i += 1) assert(isAcceptableOperatorUiToken(generateOperatorUiToken()), `generated token ${i}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
