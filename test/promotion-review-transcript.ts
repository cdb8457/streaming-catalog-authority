import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewTranscript, REVIEW_DISCLAIMERS, REVIEW_HUMAN_GATES } from '../src/ops/promotion-review-transcript.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-transcript-')); }
const COMMIT = 'f11f86aba5410bbacf9ff008aa10206ad1fc3d12';

console.log('Running Phase 230 review transcript suite:\n');

await test('REVIEW_CLEAN for a valid commit, all-passing tests, no blockers', () => {
  const t = buildReviewTranscript({
    reviewedCommit: COMMIT,
    testResults: [{ command: 'npm run test:phase230-local', passed: 200, failed: 0 }, { command: 'npx tsc -p tsconfig.json --noEmit', passed: 1, failed: 0 }],
    blockers: [],
  });
  assertEq(t.verdict, 'REVIEW_CLEAN', `clean (problems: ${t.problems.join(',')})`);
  assertEq(t.authorization, 'NONE', 'authorizes nothing');
  assertEq(t.reviewedCommit, COMMIT, 'records reviewed commit');
  assertEq(t.humanGates.length, REVIEW_HUMAN_GATES.length, 'human gates present');
  assertEq(t.disclaimers.length, REVIEW_DISCLAIMERS.length, 'disclaimers present');
  assert(t.disclaimers.some((d) => /does NOT authorize Phase 231/i.test(d)), 'explicit no-Phase-231 language');
  assert(/^[0-9a-f]{64}$/.test(t.transcriptDigest), 'transcript digest present');
});

await test('REVIEW_BLOCKED when a test failed', () => {
  const t = buildReviewTranscript({ reviewedCommit: COMMIT, testResults: [{ command: 'npm run test:phase230-local', passed: 199, failed: 1 }] });
  assertEq(t.verdict, 'REVIEW_BLOCKED', 'blocked');
  assert(t.problems.includes('TEST_FAILED'), 'test-failed problem');
});

await test('REVIEW_BLOCKED when a blocker is present', () => {
  const t = buildReviewTranscript({ reviewedCommit: COMMIT, testResults: [], blockers: ['BUNDLE_SELF_DIGEST_MISMATCH'] });
  assertEq(t.verdict, 'REVIEW_BLOCKED', 'blocked');
  assertEq(t.blockers.length, 1, 'records the blocker');
  assertEq(t.disclaimers.length, REVIEW_DISCLAIMERS.length, 'disclaimers still present');
});

await test('REVIEW_BLOCKED on an invalid reviewed commit', () => {
  const t = buildReviewTranscript({ reviewedCommit: 'not-a-sha', testResults: [] });
  assertEq(t.verdict, 'REVIEW_BLOCKED', 'blocked');
  assert(t.problems.includes('REVIEWED_COMMIT_INVALID'), 'invalid-commit problem');
  assert(t.reviewedCommit === undefined, 'invalid commit not echoed');
});

await test('REVIEW_BLOCKED and flagged when a remediation carries a raw path', () => {
  const t = buildReviewTranscript({ reviewedCommit: COMMIT, testResults: [], remediations: ['fixed /mnt/user/media/Movies handling'] });
  assertEq(t.verdict, 'REVIEW_BLOCKED', 'blocked');
  assert(t.problems.includes('RAW_PATH_IN_TRANSCRIPT'), 'raw-path problem');
});

await test('the transcript is redaction-safe and its digest recomputes deterministically', () => {
  const t = buildReviewTranscript({ reviewedCommit: COMMIT, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }], remediations: ['tightened the strict schema success-state check'] });
  assert(t.redactionSafe === true, 'flagged redaction-safe');
  const serialized = JSON.stringify(t);
  assert(!serialized.includes('/mnt/') && !serialized.includes('catalog-authority-test-library'), 'no path fragments');
  const { transcriptDigest, ...rest } = t as unknown as Record<string, unknown> & { transcriptDigest: string };
  const recomputed = createHash('sha256').update(`phase-230-review-transcript:${JSON.stringify(rest)}`).digest('hex');
  assertEq(recomputed, transcriptDigest, 'transcript digest recomputes');
  const again = buildReviewTranscript({ reviewedCommit: COMMIT, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }], remediations: ['tightened the strict schema success-state check'] });
  assertEq(JSON.stringify(again), JSON.stringify(t), 'transcript is deterministic');
});

await test('CLI builds the transcript and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const dir = join(root, 'artifacts');
    mkdirSync(dir, { recursive: true });
    const inputPath = join(dir, 'review.json');
    writeFileSync(inputPath, JSON.stringify({ testResults: [{ command: 'npm run test:phase230-local', passed: 200, failed: 0 }], blockers: [], remediations: [] }));
    const outPath = join(root, 'catalog-authority-test-library', 'TRANSCRIPTMARKER-out', 'transcript.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-review-transcript-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--reviewed-commit', COMMIT, '--input', inputPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `REVIEW_CLEAN exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'transcript file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.verdict, 'REVIEW_CLEAN', 'stdout verdict');
    assertEq(parsed.authorization, 'NONE', 'stdout authorization NONE');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('TRANSCRIPTMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
