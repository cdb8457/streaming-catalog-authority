import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRehearsalMatrix } from '../src/ops/promotion-rehearsal-matrix.js';
import { REHEARSAL_SCENARIOS } from '../src/ops/promotion-rehearsal.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-matrix-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 15, 10, 0, i++)); }

console.log('Running Phase 230 rehearsal matrix suite:\n');

await test('runs every scenario and each matches its expected outcome (MATRIX_PASS)', async () => {
  const root = workspace();
  try {
    const matrix = await runRehearsalMatrix({ workDir: root, runId: 'm', now: makeNow() });
    assertEq(matrix.outcome, 'MATRIX_PASS', `matrix pass (${matrix.entries.map((e) => `${e.scenario}:${e.matches}`).join(',')})`);
    assertEq(matrix.entries.length, REHEARSAL_SCENARIOS.length, 'one entry per scenario');
    for (const e of matrix.entries) {
      assert(e.matches, `${e.scenario} matched`);
      assertEq(e.expected, e.scenario === 'success' ? 'REHEARSAL_PASS' : 'REHEARSAL_FAIL', `${e.scenario} expected`);
      assert(/^[0-9a-f]{64}$/.test(e.manifestDigest), `${e.scenario} manifest digest present`);
    }
    assert(/^[0-9a-f]{64}$/.test(matrix.matrixDigest), 'matrix digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('the matrix manifest is redaction-safe', async () => {
  const root = workspace();
  try {
    const matrix = await runRehearsalMatrix({ workDir: root, runId: 'm-redact', now: makeNow() });
    const serialized = JSON.stringify(matrix);
    assert(matrix.redactionSafe === true, 'flagged redaction-safe');
    assert(!serialized.includes('/mnt/'), 'no /mnt path');
    assert(!serialized.includes('catalog-authority-test-library'), 'no test-library fragment');
    assert(!serialized.includes(root), 'no work-dir path');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('matrixDigest recomputes deterministically from the manifest body', async () => {
  const root = workspace();
  try {
    const matrix = await runRehearsalMatrix({ workDir: root, runId: 'm-recompute', now: makeNow() });
    const { matrixDigest, ...body } = matrix as unknown as Record<string, unknown> & { matrixDigest: string };
    const recomputed = createHash('sha256').update(`phase-230-rehearsal-matrix:${JSON.stringify(body)}`).digest('hex');
    assertEq(recomputed, matrixDigest, 'recomputed matrix digest matches');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('two matrix runs with identical fixed inputs are identical (deterministic)', async () => {
  const root = workspace();
  try {
    const fixed = { workDir: join(root, 'fixed'), runId: 'm-det', acceptorId: 'coordinator-1' };
    const a = await runRehearsalMatrix({ ...fixed, now: makeNow() });
    const b = await runRehearsalMatrix({ ...fixed, now: makeNow() });
    assertEq(a.matrixDigest, b.matrixDigest, 'matrix digest identical across runs');
    assertEq(JSON.stringify(a), JSON.stringify(b), 'whole matrix identical across runs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI runs the matrix, writes it, and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const outPath = join(root, 'catalog-authority-test-library', 'MATRIXMARKER-out', 'matrix.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-rehearsal-matrix-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--work-dir', join(root, 'work'), '--run-id', 'cli-matrix', '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `MATRIX_PASS exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'matrix file written');
    const stdout = res.stdout ?? '';
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    assertEq(parsed.outcome, 'MATRIX_PASS', 'stdout outcome');
    assertEq(parsed.matrixWritten, true, 'stdout reports matrixWritten');
    assert(!('outputFile' in parsed), 'no outputFile key');
    assert(!stdout.includes('MATRIXMARKER') && !stdout.includes('catalog-authority-test-library') && !stdout.includes('/mnt/'), 'no path fragments in stdout');
    const matrix = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    assertEq(matrix.report, 'phase-230-promotion-rehearsal-matrix', 'written file is the matrix manifest');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
