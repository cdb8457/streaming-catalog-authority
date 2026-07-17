import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCliErgonomics } from '../src/ops/promotion-cli-ergonomics.js';
import { LOCAL_OPS_REGISTRY } from '../src/ops/promotion-acceptance-meta.js';
import { verifySelfDigests } from '../src/ops/promotion-self-digest-verifier.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
function run(cliBase: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const cliPath = join(projectRoot, 'src', 'ops', `${cliBase}-cli.ts`);
  const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], { cwd: projectRoot, encoding: 'utf8' });
  assert(res.error === undefined, `spawn ${cliBase}: ${res.error?.message ?? ''}`);
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

console.log('Running Phase 230 CLI ergonomics suite:\n');

test('CLI_ERGONOMICS_OK: every registered CLI defines usage() and handles --help', () => {
  const e = buildCliErgonomics(projectRoot);
  assertEq(e.overall, 'CLI_ERGONOMICS_OK', `ok (gaps: ${e.gaps.join(',')})`);
  assertEq(e.authorization, 'NONE', 'authorizes nothing');
  assertEq(e.cliCount, LOCAL_OPS_REGISTRY.length, 'every registered CLI scanned');
  assert(e.results.every((r) => r.usageDefined && r.helpHandled && r.ok), 'usage + --help everywhere');
  assertEq(verifySelfDigests([e]).overall, 'ALL_VERIFIED', 'report self-verifies');
  assert(/^[0-9a-f]{64}$/.test(e.ergonomicsDigest), 'ergonomics digest present');
});

await test('--help exits 0 with a usage line on a representative CLI sample (old + new)', async () => {
  for (const base of ['promotion-approval', 'promotion-provenance-ledger', 'promotion-review-bundle', 'promotion-gate-dag', 'promotion-failure-matrix', 'promotion-reviewer-pack']) {
    const res = run(base, ['--help']);
    assertEq(res.status, 0, `${base} --help exits 0 (stderr: ${res.stderr})`);
    assert(res.stdout.includes('usage:'), `${base} --help prints usage`);
  }
});

await test('malformed input fails cleanly: non-zero exit, one-line message, no stack trace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-ergo-'));
  try {
    const bogus = join(dir, 'not-json.txt');
    writeFileSync(bogus, 'this is not json');
    const res = run('promotion-provenance-diff', ['--context', bogus, '--transcript', bogus]);
    assertEq(res.status, 2, 'input error exits 2');
    assert(res.stderr.trim().length > 0 && !res.stderr.includes('at '), `clean message, no stack trace (stderr: ${res.stderr})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI_ERGONOMICS_GAP when a planted CLI lacks --help handling', () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-ergo-gap-'));
  try {
    mkdirSync(join(root, 'src', 'ops'), { recursive: true });
    writeFileSync(join(root, 'src', 'ops', 'promotion-approval-cli.ts'), 'function usage(): string { return ""; }\n');
    const e = buildCliErgonomics(root);
    assertEq(e.overall, 'CLI_ERGONOMICS_GAP', 'gap');
    assert(e.gaps.includes('HELP_MISSING'), 'help-missing gap');
    assert(e.gaps.includes('USAGE_MISSING'), 'usage-missing gap for the other (empty) CLIs');
    assert(e.redactionSafe === true && !JSON.stringify(e).includes('/mnt/'), 'redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI reports ergonomics and never echoes raw paths to stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-ergo-cli-'));
  try {
    const outPath = join(dir, 'catalog-authority-test-library', 'CEMARKER-out', 'ergonomics.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-cli-ergonomics-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `OK exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'ergonomics file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'CLI_ERGONOMICS_OK', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('CEMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
