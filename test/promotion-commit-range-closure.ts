import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCommitRangeClosure } from '../src/ops/promotion-commit-range-closure.js';
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
const BASE = '1111111111111111111111111111111111111111';
const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const s = (n: number): string => n.toString(16).padStart(40, '0');
const RANGE = {
  base: BASE, head: HEAD, commits: [
    { sha: s(1), subject: 'Add review-transcript verifier v2 (phase BH)' },
    { sha: s(2), subject: 'Fix fail-open release-checklist digest binding (AN/AO remediation)' },
    { sha: s(3), subject: 'Consolidate docs & add coordinator review index (phase BC)' },
    { sha: HEAD, subject: 'Stop tracking _wire.py scratch helper' },
  ],
};

console.log('Running Phase 230 commit-range closure suite:\n');

test('RANGE_CLOSED when every commit is categorized by phase/remediation/docs/chore', () => {
  const c = buildCommitRangeClosure(RANGE);
  assertEq(c.overall, 'RANGE_CLOSED', `closed (blockers: ${c.blockers.join(',')})`);
  assertEq(c.authorization, 'NONE', 'authorizes nothing');
  assertEq(c.commitCount, 4, 'every commit categorized');
  assert(!('uncategorized' in c.categories), 'no uncategorized commits');
  assert((c.categories['phase-op'] ?? 0) >= 1 && (c.categories['remediation'] ?? 0) >= 1 && (c.categories['chore'] ?? 0) >= 1, 'multiple categories represented');
  assertEq(c.base, BASE, 'base recorded');
  assertEq(c.head, HEAD, 'head recorded');
  assertEq(verifySelfDigests([c]).overall, 'ALL_VERIFIED', 'report self-verifies');
  assert(/^[0-9a-f]{64}$/.test(c.closureDigest), 'closure digest present');
});

test('RANGE_OPEN on an uncategorized commit', () => {
  const c = buildCommitRangeClosure({ ...RANGE, commits: [...RANGE.commits, { sha: s(9), subject: 'wip' }] });
  assertEq(c.overall, 'RANGE_OPEN', 'open');
  assert(c.blockers.includes('COMMIT_UNCATEGORIZED'), 'uncategorized-commit blocker');
});

test('RANGE_OPEN on a malformed sha or a subject that leaks a path', () => {
  const badSha = buildCommitRangeClosure({ ...RANGE, commits: [{ sha: 'nope', subject: 'Add thing (phase BX)' }] });
  assert(badSha.blockers.includes('COMMIT_SHA_MALFORMED'), 'malformed sha blocked');
  const leak = buildCommitRangeClosure({ ...RANGE, commits: [{ sha: s(1), subject: '/mnt/user/media/Movies/x.mkv' }] });
  assert(leak.blockers.includes('COMMIT_SUBJECT_LEAK'), 'subject leak blocked');
  assert(!JSON.stringify(leak).includes('/mnt/'), 'report stays redaction-safe');
});

test('RANGE_OPEN and redaction-safe on empty input', () => {
  const c = buildCommitRangeClosure({});
  assertEq(c.overall, 'RANGE_OPEN', 'open');
  assert(c.blockers.includes('NO_COMMITS') && c.blockers.includes('BASE_MISSING'), 'missing blockers');
  assert(c.redactionSafe === true && !JSON.stringify(c).includes('/mnt/'), 'redaction-safe');
});

await test('CLI verifies the range and never echoes raw paths/subjects to stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-range-'));
  try {
    const inPath = join(dir, 'range.json'); writeFileSync(inPath, JSON.stringify(RANGE));
    const outPath = join(dir, 'catalog-authority-test-library', 'CRMARKER-out', 'closure.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-commit-range-closure-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--in', inPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `CLOSED exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'closure file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'RANGE_CLOSED', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('_wire.py') && !(res.stdout ?? '').includes('CRMARKER') && !(res.stdout ?? '').includes('/mnt/'), 'no subject/path fragments in stdout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
