import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClosureHygiene } from '../src/ops/promotion-closure-hygiene.js';

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

console.log('Running Phase 230 closure hygiene suite:\n');

test('the toolchain is hygienic: DAG acyclic, blockers catalogued, taxonomy ops known, registry wired', () => {
  const h = buildClosureHygiene(projectRoot);
  assertEq(h.overall, 'HYGIENE_OK', `hygienic (problems: ${h.problems.join(',')})`);
  assertEq(h.authorization, 'NONE', 'authorizes nothing');
  assert(h.checks.every((c) => c.ok), 'every hygiene check ok');
  const names = new Set(h.checks.map((c) => c.check));
  assert(names.has('self-digest-covers-reports') && names.has('cli-contract-conformant'), 'the new coverage checks are present');
  assert(h.opCount > 0 && h.nodeCount > 0 && h.blockerCodeCount > 0, 'non-empty counts');
  assert(/^[0-9a-f]{64}$/.test(h.hygieneDigest), 'hygiene digest present');
});

test('HYGIENE_VIOLATION when pointed at a project root with no wiring', () => {
  const empty = mkdtempSync(join(tmpdir(), 'catalog-hygiene-empty-'));
  try {
    const h = buildClosureHygiene(empty);
    assertEq(h.overall, 'HYGIENE_VIOLATION', 'violation on empty root');
    assert(h.problems.includes('REGISTRY_NOT_WIRED'), 'registry-not-wired flagged');
    assert(h.redactionSafe === true && !JSON.stringify(h).includes('/mnt/'), 'redaction-safe');
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

await test('CLI reports hygiene and never echoes raw paths to stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-hygiene-'));
  try {
    const outPath = join(dir, 'catalog-authority-test-library', 'HYGMARKER-out', 'hygiene.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-closure-hygiene-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `HYGIENE_OK exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'hygiene file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'HYGIENE_OK', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('HYGMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
