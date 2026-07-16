import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFinalSummary, FINAL_SUMMARY_HUMAN_GATES, FINAL_SUMMARY_DISCLAIMERS } from '../src/ops/promotion-final-summary.js';
import { buildFixtureEvidenceBundle } from '../src/ops/promotion-fixture-bundle.js';
import { replayFixtureBundle } from '../src/ops/promotion-bundle-replay.js';
import { buildCoordinatorEvidencePacket } from '../src/ops/promotion-evidence-packet.js';
import { buildReviewTranscript } from '../src/ops/promotion-review-transcript.js';
import { buildProvenanceLedger } from '../src/ops/promotion-provenance-ledger.js';
import { verifyGateDag } from '../src/ops/promotion-gate-dag.js';
import { buildArchiveManifest } from '../src/ops/promotion-archive-manifest.js';
import { buildReviewBundle } from '../src/ops/promotion-review-bundle.js';
import { buildConsistencyMatrix } from '../src/ops/promotion-consistency-matrix.js';
import { verifySelfDigests } from '../src/ops/promotion-self-digest-verifier.js';
import { buildBlockerTaxonomy } from '../src/ops/promotion-blocker-taxonomy.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-summary-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 17, 14, 0, i++)); }
const COMMIT = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';

async function greenAll(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'summary', now: makeNow() })));
  const replay = replayFixtureBundle(bundle);
  const evidence = buildCoordinatorEvidencePacket({ bundle, replay });
  const transcript = buildReviewTranscript({ reviewedCommit: COMMIT, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }] });
  const ledger = buildProvenanceLedger({ bundle, replay, evidence, transcript });
  const dag = verifyGateDag();
  const archive = buildArchiveManifest({ ledger, dag, evidence, transcript });
  const reviewBundle = buildReviewBundle({ evidence, transcript, ledger, dag, archive });
  const consistencyMatrix = buildConsistencyMatrix({ evidence, transcript, ledger, dag, archive, reviewBundle });
  const selfDigest = verifySelfDigests([evidence, transcript, ledger, dag, archive, reviewBundle]);
  const taxonomy = buildBlockerTaxonomy();
  return { evidence, transcript, ledger, dag, archive, reviewBundle, consistencyMatrix, selfDigest, taxonomy };
}

console.log('Running Phase 230 coordinator final summary suite:\n');

await test('FINAL_SUMMARY_READY when the review bundle is READY and every supplied check is green', async () => {
  const root = workspace();
  try {
    const g = await greenAll(root);
    const s = buildFinalSummary({ reviewBundle: g.reviewBundle, transcript: g.transcript, consistencyMatrix: g.consistencyMatrix, selfDigest: g.selfDigest, taxonomy: g.taxonomy });
    assertEq(s.overall, 'FINAL_SUMMARY_READY', `ready (blockers: ${s.blockers.join(',')})`);
    assertEq(s.authorization, 'NONE', 'authorizes nothing');
    assert(s.checks.every((c) => c.ok), 'every check ok');
    assertEq(s.humanGates.length, FINAL_SUMMARY_HUMAN_GATES.length, 'human gates restated');
    assertEq(s.disclaimers.length, FINAL_SUMMARY_DISCLAIMERS.length, 'disclaimers present');
    assert(s.humanGates.some((h) => /Phase 231/.test(h)), 'Phase 231 gate named');
    assert(/^[0-9a-f]{64}$/.test(s.summaryDigest), 'summary digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('surfaces the exact reviewed commit and test results from the transcript', async () => {
  const root = workspace();
  try {
    const g = await greenAll(root);
    const s = buildFinalSummary({ reviewBundle: g.reviewBundle, transcript: g.transcript });
    assertEq(s.overall, 'FINAL_SUMMARY_READY', `ready (blockers: ${s.blockers.join(',')})`);
    assertEq(s.reviewedCommit, COMMIT, 'exact reviewed commit carried');
    assertEq(s.testResults.length, 1, 'one test-result row');
    assertEq(s.testResults[0]!.command, 'npm run test:phase230-local', 'command carried');
    assertEq(s.testsPassed, 5, 'passed total');
    assertEq(s.testsFailed, 0, 'failed total');
    assert(s.checks.filter((c) => c.check !== 'reviewBundle' && c.check !== 'transcript').every((c) => !c.present && c.ok), 'optionals absent, not blocking');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the transcript is missing (commit/results unknown)', async () => {
  const root = workspace();
  try {
    const g = await greenAll(root);
    const s = buildFinalSummary({ reviewBundle: g.reviewBundle });
    assertEq(s.overall, 'FINAL_SUMMARY_BLOCKED', 'blocked');
    assert(s.blockers.includes('TRANSCRIPT_MISSING'), 'transcript-missing blocker');
    assertEq(s.reviewedCommit, null, 'no commit without a transcript');
    assertEq(s.testResults.length, 0, 'no test results without a transcript');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the review bundle is not READY', async () => {
  const root = workspace();
  try {
    const { evidence, transcript, ledger, dag } = await greenAll(root);
    const notReady = buildReviewBundle({ evidence, transcript, ledger, dag }); // no archive -> BLOCKED
    const s = buildFinalSummary({ reviewBundle: notReady, transcript });
    assertEq(s.overall, 'FINAL_SUMMARY_BLOCKED', 'blocked');
    assert(s.blockers.includes('REVIEW_BUNDLE_NOT_READY'), 'review-bundle-not-ready blocker');
    assertEq(s.humanGates.length, FINAL_SUMMARY_HUMAN_GATES.length, 'human gates still restated');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when a supplied optional check is not green', async () => {
  const root = workspace();
  try {
    const g = await greenAll(root);
    const otherTranscript = buildReviewTranscript({ reviewedCommit: 'a1b2c3d4e5f6071829304152637485960a1b2c3d', testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }] });
    const badMatrix = buildConsistencyMatrix({ ...g, transcript: otherTranscript });
    const s = buildFinalSummary({ reviewBundle: g.reviewBundle, transcript: g.transcript, consistencyMatrix: badMatrix });
    assertEq(s.overall, 'FINAL_SUMMARY_BLOCKED', 'blocked');
    assert(s.blockers.includes('MATRIX_NOT_CONSISTENT'), 'matrix-not-consistent blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BLOCKED and redaction-safe on empty input', () => {
  const s = buildFinalSummary({});
  assertEq(s.overall, 'FINAL_SUMMARY_BLOCKED', 'blocked');
  assert(s.blockers.includes('REVIEW_BUNDLE_MISSING'), 'missing blocker');
  assert(s.redactionSafe === true && !JSON.stringify(s).includes('/mnt/'), 'redaction-safe');
});

await test('CLI builds the summary and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const g = await greenAll(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const rb = w('rb.json', g.reviewBundle); const trf = w('tr.json', g.transcript); const mx = w('mx.json', g.consistencyMatrix); const sd = w('sd.json', g.selfDigest); const tx = w('tx.json', g.taxonomy);
    const outPath = join(root, 'catalog-authority-test-library', 'FSMARKER-out', 'summary.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-final-summary-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--reviewbundle', rb, '--transcript', trf, '--matrix', mx, '--selfdigest', sd, '--taxonomy', tx, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `READY exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'summary file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'FINAL_SUMMARY_READY', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assertEq(parsed.reviewedCommit, COMMIT, 'stdout carries the exact reviewed commit');
    assertEq(parsed.testsPassed, 5, 'stdout carries the passed total');
    assert(!(res.stdout ?? '').includes('FSMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
