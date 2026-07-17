import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGateCoverage } from '../src/ops/promotion-gate-coverage.js';
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

console.log('Running Phase 230 gate coverage completeness suite:\n');

test('GATE_COVERAGE_COMPLETE: every op/gate/blocker/taxonomy dimension is covered', () => {
  const c = buildGateCoverage(projectRoot);
  assertEq(c.overall, 'GATE_COVERAGE_COMPLETE', `complete (gaps: ${c.gaps.join(',')})`);
  assertEq(c.authorization, 'NONE', 'authorizes nothing');
  assert(c.dimensions.length === 4 && c.dimensions.every((d) => d.ok), 'every dimension ok');
  assert(c.opCount > 0 && c.gateNodeCount > 0 && c.blockerCodeCount > 0, 'non-empty counts');
  assertEq(verifySelfDigests([c]).overall, 'ALL_VERIFIED', 'report self-verifies');
  assert(/^[0-9a-f]{64}$/.test(c.coverageDigest), 'coverage digest present');
});

test('GATE_COVERAGE_INCOMPLETE when pointed at a project root with no wiring', () => {
  const empty = mkdtempSync(join(tmpdir(), 'catalog-coverage-empty-'));
  try {
    const c = buildGateCoverage(empty);
    assertEq(c.overall, 'GATE_COVERAGE_INCOMPLETE', 'incomplete on empty root');
    assert(c.gaps.includes('MISSING_WIRING') && c.gaps.includes('GATE_NOT_IN_LOCAL_SUITE'), 'wiring + suite gaps flagged');
    assert(c.redactionSafe === true && !JSON.stringify(c).includes('/mnt/'), 'redaction-safe');
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

await test('CLI reports coverage and never echoes raw paths to stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-coverage-'));
  try {
    const outPath = join(dir, 'catalog-authority-test-library', 'GCMARKER-out', 'coverage.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-gate-coverage-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `COMPLETE exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'coverage file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'GATE_COVERAGE_COMPLETE', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('GCMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
