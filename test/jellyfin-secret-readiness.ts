import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkJellyfinSecretReadiness } from '../src/ops/jellyfin-secret-readiness.js';
import type { Env } from '../src/config/env.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');
const SECRET = 'PHASE212-SUPER-SECRET-JELLYFIN-KEY';
const PRIVATE_PATH_SENTINEL = 'private-secret-dir';

function noLeak(value: unknown): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return !text.includes(SECRET) && !text.includes(PRIVATE_PATH_SENTINEL) && !text.includes('192.168.');
}

function writeSecret(dir: string, mode = 0o600): string {
  const secretDir = path.join(dir, PRIVATE_PATH_SENTINEL);
  mkdirSync(secretDir, { recursive: true });
  const file = path.join(secretDir, 'jellyfin_api_key');
  writeFileSync(file, `${SECRET}\n`, { encoding: 'utf8', mode });
  chmodSync(file, mode);
  return file;
}

console.log('Running Phase 212 Jellyfin secret readiness suite:\n');

await test('phase record defines no-network secret readiness gate', () => {
  const doc = read('docs/PHASE_212_JELLYFIN_SECRET_READINESS_GATE.md');
  for (const required of [
    'phase-212-jellyfin-secret-readiness-gate',
    'JELLYFIN_SECRET_READINESS_GATE_READY',
    'SECRET_READINESS_COMMAND_READY_LIVE_CAPTURE_STILL_BLOCKED',
    'f51d8fa',
    'phase-211',
    'phase-212-jellyfin-secret-readiness',
    'JELLYFIN_SECRET_NOT_READY',
    'JELLYFIN_SECRET_READY',
    'secretValueEchoed: false',
    'secretPathEchoed: false',
    'does not contact Jellyfin',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

await test('ready secret file passes without echoing value or path', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jf-secret-ready-'));
  try {
    const keyFile = writeSecret(dir, 0o600);
    const report = checkJellyfinSecretReadiness({ JELLYFIN_API_KEY_FILE: keyFile } as Env);
    assert(report.ok, 'report ok');
    assertEq(report.status, 'JELLYFIN_SECRET_READY', 'ready status');
    assertEq(report.secretValueEchoed, false, 'value not echoed');
    assertEq(report.secretPathEchoed, false, 'path not echoed');
    assert(report.findings.some((finding) => finding.code === 'SECRET_FILE_READABLE_NONEMPTY' && finding.level === 'pass'), 'readable pass');
    assert(report.findings.some((finding) => (finding.code === 'SECRET_FILE_MODE_RESTRICTIVE' || finding.code === 'SECRET_FILE_MODE_PLATFORM_LIMITED') && finding.level === 'pass'), 'mode pass');
    assert(noLeak(report), 'report redaction-safe');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('missing, direct, and too-open secret configurations fail safely', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jf-secret-not-ready-'));
  try {
    const openFile = writeSecret(dir, 0o644);
    const cases: Array<readonly [string, Env, string]> = [
      ['missing env', {} as Env, 'SECRET_FILE_ENV_MISSING'],
      ['missing file', { JELLYFIN_API_KEY_FILE: path.join(dir, 'missing') } as Env, 'SECRET_FILE_UNREADABLE_OR_EMPTY'],
      ['direct env', { JELLYFIN_API_KEY: SECRET, JELLYFIN_API_KEY_FILE: openFile } as Env, 'DIRECT_SECRET_ENV_SET'],
    ];
    if (process.platform !== 'win32') cases.push(['too open', { JELLYFIN_API_KEY_FILE: openFile } as Env, 'SECRET_FILE_MODE_TOO_OPEN']);
    for (const [name, env, expected] of cases) {
      const report = checkJellyfinSecretReadiness(env);
      assert(!report.ok, `${name} not ready`);
      assertEq(report.status, 'JELLYFIN_SECRET_NOT_READY', `${name} status`);
      assert(report.findings.some((finding) => finding.code === expected && finding.level === 'fail'), `${name} expected finding`);
      assert(noLeak(report), `${name} report redaction-safe`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('package, deploy guard, and README wire Phase 212 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const deploy = read('test/deploy.ts');
  const readme = read('README.md');
  assert(pkg.scripts['ops:jellyfin-secret-readiness'] === 'tsx src/ops/jellyfin-secret-readiness-cli.ts', 'ops script present');
  assert(pkg.scripts['test:jellyfin-secret-readiness'] === 'tsx test/jellyfin-secret-readiness.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order present');
  assert(deploy.includes('Phase 212 Jellyfin secret readiness gate'), 'deploy guard entry');
  assert(deploy.includes('JELLYFIN_SECRET_READINESS_GATE_READY'), 'deploy guard status');
  assert(readme.includes('Phase 212 adds `docs/PHASE_212_JELLYFIN_SECRET_READINESS_GATE.md`'), 'README ledger entry');
});

await test('phase record is redaction-safe and preserves deferred launch state', () => {
  const doc = read('docs/PHASE_212_JELLYFIN_SECRET_READINESS_GATE.md');
  for (const required of [
    'Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`',
    'Phase 210 remains `JELLYFIN_LIVE_EVIDENCE_BLOCKED_SECRET_MISSING`',
    'Phase 211 remains `LIVE_EVIDENCE_CAPTURE_COMMAND_READY_AWAITING_SECRET`',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
  ]) assert(doc.includes(required), `status includes ${required}`);
  for (const forbidden of [
    SECRET,
    PRIVATE_PATH_SENTINEL,
    '192.168.',
    'postgres://',
    'postgresql://',
    '-----BEGIN',
    'ssh-ed25519',
    'password:',
    'secret:',
    'kek:',
    'dek:',
    'O5_CLOSED',
    'JELLYFIN_INTEGRATION_LAUNCHED',
  ]) assert(!doc.includes(forbidden), `doc excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
