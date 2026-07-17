import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEvidenceMinimizer } from '../src/ops/promotion-evidence-minimizer.js';
import { verifyGateDag } from '../src/ops/promotion-gate-dag.js';
import { buildBlockerTaxonomy } from '../src/ops/promotion-blocker-taxonomy.js';
import { buildGateCoverage } from '../src/ops/promotion-gate-coverage.js';
import { buildClosureHygiene } from '../src/ops/promotion-closure-hygiene.js';
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

console.log('Running Phase 230 evidence minimizer suite:\n');

test('MINIMIZED_CLEAN: reports project to digests/statuses/counts with no leak', () => {
  const reports = [verifyGateDag(), buildBlockerTaxonomy(), buildGateCoverage(projectRoot), buildClosureHygiene(projectRoot)];
  const m = buildEvidenceMinimizer(reports);
  assertEq(m.overall, 'MINIMIZED_CLEAN', `clean (leaks: ${m.leaks.join(',')})`);
  assertEq(m.authorization, 'NONE', 'authorizes nothing');
  assertEq(m.count, reports.length, 'counts every report');
  assert(m.entries.every((e) => /^phase-\d+-/.test(e.report)), 'each entry names its report');
  assert(m.entries.every((e) => e.digest === null || /^[0-9a-f]{64}$/.test(e.digest)), 'digests only');
  assert(m.entries.some((e) => Object.keys(e.counts).length > 0), 'counts projected');
  assertEq(m.packedKinds.join(','), 'DIGESTS,STATUSES,COUNTS', 'only digests/statuses/counts packed');
  assertEq(verifySelfDigests([m]).overall, 'ALL_VERIFIED', 'report self-verifies');
  assert(/^[0-9a-f]{64}$/.test(m.minimizerDigest), 'minimizer digest present');
});

test('MINIMIZED_LEAK when a projected status carries free text (a path/title)', () => {
  const leaky = { report: 'phase-230-promotion-gate-dag', overall: '/mnt/user/media/Movies/x.mkv', dagDigest: 'a'.repeat(64) };
  const m = buildEvidenceMinimizer([leaky]);
  assertEq(m.overall, 'MINIMIZED_LEAK', 'leak detected');
  assert(m.leaks.includes('phase-230-promotion-gate-dag'), 'leaking report flagged');
});

test('the minimal projection drops free-text fields entirely', () => {
  const rich = { report: 'phase-230-promotion-coordinator-final-summary', overall: 'FINAL_SUMMARY_READY', reviewedCommit: 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6', testsPassed: 50, testsFailed: 0, humanGates: ['a free-text human gate sentence'], disclaimers: ['a free-text disclaimer'], summaryDigest: 'b'.repeat(64) };
  const m = buildEvidenceMinimizer([rich]);
  assertEq(m.overall, 'MINIMIZED_CLEAN', 'clean -- free text was dropped, not packed');
  const e = m.entries[0]!;
  assert(!('humanGates' in (e as object)) && !('disclaimers' in (e as object)), 'free-text fields not in the minimal record');
  assert(e.counts['testsPassed'] === 50 && e.counts['testsFailed'] === 0, 'counts kept');
  assert(!JSON.stringify(m).includes('free-text'), 'no free text in the minimal bundle');
});

test('NO_REPORTS and redaction-safe on empty input', () => {
  const m = buildEvidenceMinimizer([]);
  assertEq(m.overall, 'NO_REPORTS', 'no reports');
  assert(m.redactionSafe === true && !JSON.stringify(m).includes('/mnt/'), 'redaction-safe');
});

await test('CLI minimizes reports and never echoes raw paths to stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-minimizer-'));
  try {
    const reports = [verifyGateDag(), buildBlockerTaxonomy()];
    const files = reports.map((r, i) => { const p = join(dir, `r${i}.json`); writeFileSync(p, JSON.stringify(r)); return p; });
    const outPath = join(dir, 'catalog-authority-test-library', 'EMMARKER-out', 'minimal.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-evidence-minimizer-cli.ts', import.meta.url));
    const flags: string[] = [];
    for (const f of files) flags.push('--report', f);
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...flags, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `CLEAN exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'minimal file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'MINIMIZED_CLEAN', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('EMMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
