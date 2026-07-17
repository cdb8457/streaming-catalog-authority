import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegressionOracle, REGRESSION_FINDING_COUNT } from '../src/ops/promotion-regression-oracle.js';
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

console.log('Running Phase 230 regression oracle suite:\n');

test('ORACLE_COMPLETE: every finding maps to a catalogued blocker and an existing repro test', () => {
  const o = buildRegressionOracle(projectRoot);
  assertEq(o.overall, 'ORACLE_COMPLETE', `complete (gaps: ${o.gaps.join(',')})`);
  assertEq(o.authorization, 'NONE', 'authorizes nothing');
  assertEq(o.count, REGRESSION_FINDING_COUNT, 'every finding indexed');
  assert(o.count >= 10, 'a substantial regression set');
  assert(o.entries.every((e) => e.mapped), 'every finding mapped');
  const catalogued = new Set(BLOCKER_CODES);
  assert(o.entries.every((e) => catalogued.has(e.blocker) && e.test.startsWith('test/')), 'blockers catalogued + tests referenced');
  assertEq(verifySelfDigests([o]).overall, 'ALL_VERIFIED', 'report self-verifies');
  assert(/^[0-9a-f]{64}$/.test(o.oracleDigest), 'oracle digest present');
});

test('INCOMPLETE on an uncatalogued blocker or a finding without a repro (injected)', () => {
  const badBlocker = buildRegressionOracle(projectRoot, [{ finding: 'zombie-finding', blocker: 'NOT_A_REAL_CODE', test: 'test/promotion-report-schema.ts' }]);
  assertEq(badBlocker.overall, 'ORACLE_INCOMPLETE', 'incomplete');
  assert(badBlocker.gaps.includes('BLOCKER_UNCATALOGUED'), 'uncatalogued-blocker gap');
  const noRepro = buildRegressionOracle(projectRoot, [{ finding: '', blocker: 'REPORT_DIGEST_MISMATCH', test: 'test/promotion-report-schema.ts' }]);
  assert(noRepro.gaps.includes('FINDING_WITHOUT_REPRO'), 'finding-without-repro gap');
});

test('INCOMPLETE (missing repro test) on a project root with no tests, and redaction-safe', () => {
  const empty = mkdtempSync(join(tmpdir(), 'catalog-oracle-empty-'));
  try {
    const o = buildRegressionOracle(empty);
    assertEq(o.overall, 'ORACLE_INCOMPLETE', 'incomplete on empty root');
    assert(o.gaps.includes('REPRO_MISSING_TEST'), 'repro-missing-test gap');
    assert(o.redactionSafe === true && !JSON.stringify(o).includes('/mnt/'), 'redaction-safe');
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

await test('CLI indexes the oracle and never echoes raw paths to stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-oracle-'));
  try {
    const outPath = join(dir, 'catalog-authority-test-library', 'ROMARKER-out', 'oracle.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-regression-oracle-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `COMPLETE exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'oracle file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'ORACLE_COMPLETE', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('ROMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
