import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFailureMatrix } from '../src/ops/promotion-failure-matrix.js';
import { BLOCKER_CODES } from '../src/ops/promotion-blocker-taxonomy.js';
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

console.log('Running Phase 230 failure-mode matrix suite:\n');

test('FAILURE_MATRIX_COMPLETE: every catalogued blocker maps to test + doc + gate with evidence', () => {
  const m = buildFailureMatrix(projectRoot);
  assertEq(m.overall, 'FAILURE_MATRIX_COMPLETE', `complete (gaps: ${m.gaps.join(',')})`);
  assertEq(m.authorization, 'NONE', 'authorizes nothing');
  assertEq(m.codeCount, BLOCKER_CODES.length, 'one entry per distinct catalogued code');
  assert(m.codeCount >= 140, 'the full original + AP-AX blocker set covered');
  assertEq(m.mappedCount, m.codeCount, 'every code fully mapped');
  assert(m.entries.every((e) => e.mapped && e.test !== null && e.doc !== null && e.kind !== 'none'), 'every entry has test/doc/evidence');
  assert((m.kinds['asserted'] ?? 0) > 0 && (m.kinds['emitted'] ?? 0) > 0, 'evidence kinds classified');
  assertEq(verifySelfDigests([m]).overall, 'ALL_VERIFIED', 'matrix self-verifies');
  assert(/^[0-9a-f]{64}$/.test(m.failureMatrixDigest), 'matrix digest present');
});

test('AP-AX blockers are present and mapped', () => {
  const m = buildFailureMatrix(projectRoot);
  const byCode = new Map(m.entries.map((e) => [e.code, e]));
  for (const code of ['HEAD_REVIEWED_COMMIT_MISMATCH', 'STALE_ARTIFACT', 'MISSING_WIRING', 'CHAIN_BUNDLE_NOT_READY', 'LEAK_NOT_DETECTED', 'FORBIDDEN_HOOK_FOUND', 'PACK_BINDING_MISMATCH', 'MACHINE_GATE_FAILED']) {
    const e = byCode.get(code);
    assert(e !== undefined && e.mapped, `${code} mapped`);
  }
});

test('INCOMPLETE on stale-map drift and on an unmapped blocker (UNMAPPED_BLOCKER / STALE_TAXONOMY)', () => {
  const m = buildFailureMatrix(projectRoot, [{ code: 'ZOMBIE_CODE_NOT_IN_TAXONOMY', op: 'no-such-op' }]);
  assertEq(m.overall, 'FAILURE_MATRIX_INCOMPLETE', 'incomplete');
  assert(m.gaps.includes('STALE_TAXONOMY'), 'stale-taxonomy gap for a code no longer catalogued');
  assert(m.gaps.includes('UNMAPPED_BLOCKER'), 'unmapped-blocker gap for an unknown op');
});

test('INCOMPLETE on an empty root (MISSING_TEST_PATH / BLOCKER_WITHOUT_EVIDENCE) and redaction-safe', () => {
  const empty = mkdtempSync(join(tmpdir(), 'catalog-failmatrix-empty-'));
  try {
    const m = buildFailureMatrix(empty);
    assertEq(m.overall, 'FAILURE_MATRIX_INCOMPLETE', 'incomplete on empty root');
    assert(m.gaps.includes('MISSING_TEST_PATH'), 'missing-test-path gap');
    assert(m.gaps.includes('BLOCKER_WITHOUT_EVIDENCE'), 'blocker-without-evidence gap');
    assert(m.redactionSafe === true && !JSON.stringify(m).includes('/mnt/'), 'redaction-safe');
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

await test('CLI builds the matrix and never echoes raw paths to stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-failmatrix-'));
  try {
    const outPath = join(dir, 'catalog-authority-test-library', 'FMMARKER-out', 'matrix.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-failure-matrix-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `COMPLETE exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'matrix file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'FAILURE_MATRIX_COMPLETE', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('FMMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
