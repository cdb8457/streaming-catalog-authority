import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewMatrix, REVIEW_MATRIX_HUMAN_GATES, REVIEW_MATRIX_DISCLAIMERS, REVIEW_PLACEHOLDER } from '../src/ops/promotion-review-matrix.js';
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
const BASE = '1'.repeat(40);
const C1 = '2'.repeat(40);
const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const TESTS = ['npm run test:phase230-local', 'npm run typecheck'];
function goodRange() { return { base: BASE, head: HEAD, commits: [{ sha: C1, subject: 'a commit' }, { sha: HEAD, subject: 'another commit' }], requiredTests: TESTS }; }

console.log('Running Phase 230 review matrix suite:\n');

await test('REVIEW_MATRIX_READY scaffold: every review cell is a PENDING placeholder, authorizing nothing', () => {
  const m = buildReviewMatrix(goodRange());
  assertEq(m.overall, 'REVIEW_MATRIX_READY', `ready (blockers: ${m.blockers.join(',')})`);
  assertEq(m.authorization, 'NONE', 'authorizes nothing');
  assertEq(m.commitCount, 2, 'two commit rows');
  assertEq(m.testCount, 2, 'two test columns');
  assertEq(m.placeholderCount, 2 * (2 + 2), 'placeholder count = rows * (2 + tests)');
  // every review cell is PENDING -- no approval/authorization value is ever emitted
  assert(m.rows.every((r) => r.humanReviewed === REVIEW_PLACEHOLDER && r.signedOff === REVIEW_PLACEHOLDER), 'per-commit slots are PENDING');
  assert(m.rows.every((r) => r.tests.length === 2 && r.tests.every((t) => t.result === REVIEW_PLACEHOLDER)), 'per-commit/test cells are PENDING');
  assert(!JSON.stringify(m).includes('APPROVED') && !JSON.stringify(m.rows).includes('PASS'), 'no completed outcome emitted');
  assertEq(m.humanGates.length, REVIEW_MATRIX_HUMAN_GATES.length, 'human gates enumerated');
  assert(m.humanGates.some((h) => /Phase 231/.test(h)), 'Phase 231 stays a human, unauthorized step');
  assert(/no Phase 231|no live-promotion|no live Jellyfin/i.test(m.boundary), 'closed live-boundary restated');
  assertEq(m.disclaimers.length, REVIEW_MATRIX_DISCLAIMERS.length, 'disclaimers present');
  assertEq(verifySelfDigests([m]).overall, 'ALL_VERIFIED', 'matrix self-verifies');
  assert(!JSON.stringify(m).includes('/mnt/'), 'redaction-safe');
});

await test('BLOCKED and fails closed on a malformed range (base/head/commits/tests)', () => {
  assert(buildReviewMatrix({ ...goodRange(), base: 'nope' }).blockers.includes('BASE_MISSING'), 'base-missing blocker');
  assert(buildReviewMatrix({ ...goodRange(), head: 'nope' }).blockers.includes('HEAD_MISSING'), 'head-missing blocker');
  assert(buildReviewMatrix({ ...goodRange(), commits: [] }).blockers.includes('NO_COMMITS'), 'no-commits blocker');
  assert(buildReviewMatrix({ ...goodRange(), commits: [{ sha: 'xyz' }, { sha: HEAD }] }).blockers.includes('COMMIT_SHA_MALFORMED'), 'commit-sha-malformed blocker');
  assert(buildReviewMatrix({ ...goodRange(), requiredTests: [] }).blockers.includes('NO_TESTS'), 'no-tests blocker');
  // head must be the terminal commit
  assert(buildReviewMatrix({ ...goodRange(), commits: [{ sha: HEAD }, { sha: C1 }] }).blockers.includes('HEAD_NOT_TERMINAL_COMMIT'), 'head-not-terminal blocker');
});

await test('a path-bearing commit subject or test label is rejected AND never echoed (redaction closed)', () => {
  const leak = '/mnt/user/media/Movies/leak.mkv';
  const subj = buildReviewMatrix({ ...goodRange(), commits: [{ sha: C1 }, { sha: HEAD, subject: leak }] });
  assert(subj.blockers.includes('COMMIT_SUBJECT_LEAK'), 'commit-subject-leak blocker');
  assert(!JSON.stringify(subj).includes('/mnt/') && !JSON.stringify(subj).includes('.mkv'), 'subject never echoed');

  const tl = buildReviewMatrix({ ...goodRange(), requiredTests: [leak] });
  assert(tl.blockers.includes('TEST_NAME_LEAK'), 'test-name-leak blocker');
  assert(!JSON.stringify(tl).includes('/mnt/') && !JSON.stringify(tl).includes('.mkv'), 'test label never echoed');
});

test('BLOCKED and redaction-safe on empty input (human gates + boundary still stated)', () => {
  const m = buildReviewMatrix({});
  assertEq(m.overall, 'REVIEW_MATRIX_BLOCKED', 'blocked');
  assert(m.blockers.includes('BASE_MISSING') && m.blockers.includes('NO_COMMITS') && m.blockers.includes('NO_TESTS'), 'missing blockers');
  assertEq(m.humanGates.length, REVIEW_MATRIX_HUMAN_GATES.length, 'human gates still enumerated');
  assert(m.boundary.length > 0 && m.redactionSafe === true && !JSON.stringify(m).includes('/mnt/'), 'boundary stated + redaction-safe');
});

await test('CLI builds the review matrix and never echoes raw paths to stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-reviewmatrix-'));
  try {
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const rangePath = join(dir, 'range.json'); writeFileSync(rangePath, JSON.stringify(goodRange()));
    const outPath = join(root, 'catalog-authority-test-library', 'RMXMARKER-out', 'matrix.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-review-matrix-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--range', rangePath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `READY exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'matrix file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'REVIEW_MATRIX_READY', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('RMXMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
