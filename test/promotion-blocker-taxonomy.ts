import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBlockerTaxonomy, categoryOf, BLOCKER_CODES } from '../src/ops/promotion-blocker-taxonomy.js';
import { buildGateDag } from '../src/ops/promotion-gate-dag.js';

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

console.log('Running Phase 230 blocker taxonomy suite:\n');

test('the taxonomy is consistent: well-formed, attributed, unique per op', () => {
  const t = buildBlockerTaxonomy();
  assertEq(t.overall, 'TAXONOMY_CONSISTENT', `consistent (problems: ${t.problems.join(',')})`);
  assertEq(t.authorization, 'NONE', 'authorizes nothing');
  assert(t.count > 0 && t.count === BLOCKER_CODES.length, 'count matches distinct codes');
  assert(t.entries.every((e) => /^[A-Z][A-Z0-9_]*$/.test(e.code) && e.op.length > 0), 'every entry well-formed and attributed');
  assert(Object.values(t.categories).reduce((a, b) => a + b, 0) === t.count, 'categories partition the codes');
  assert(/^[0-9a-f]{64}$/.test(t.taxonomyDigest), 'taxonomy digest present');
});

test('categoryOf derives the expected buckets', () => {
  assertEq(categoryOf('LEDGER_MISSING'), 'missing', 'missing');
  assertEq(categoryOf('DAG_DIGEST_MISMATCH'), 'mismatch', 'mismatch');
  assertEq(categoryOf('ACCEPTANCE_PACKET_STATUS_INVALID'), 'invalid', 'invalid');
  assertEq(categoryOf('LEDGER_INCOMPLETE'), 'incomplete', 'incomplete');
  assertEq(categoryOf('RAW_PATH_LEAK'), 'leak', 'leak');
  assertEq(categoryOf('ARCHIVE_NOT_READY'), 'not-ready', 'not-ready');
});

test('every gate-DAG node blocker is catalogued in the taxonomy', () => {
  const catalogued = new Set(BLOCKER_CODES);
  const dagCodes = new Set(buildGateDag().flatMap((n) => n.blockers));
  const uncatalogued = [...dagCodes].filter((c) => !catalogued.has(c));
  assertEq(uncatalogued.length, 0, `uncatalogued gate-DAG blockers: ${uncatalogued.join(',')}`);
});

test('no duplicate code+op pair is declared', () => {
  const t = buildBlockerTaxonomy();
  const seen = new Set<string>();
  for (const e of t.entries) { const k = `${e.code} ${e.op}`; assert(!seen.has(k), `duplicate ${k}`); seen.add(k); }
});

await test('CLI emits the taxonomy and never echoes raw paths to stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-taxonomy-'));
  try {
    const outPath = join(dir, 'catalog-authority-test-library', 'TAXMARKER-out', 'taxonomy.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-blocker-taxonomy-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `CONSISTENT exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'taxonomy file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'TAXONOMY_CONSISTENT', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('TAXMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
