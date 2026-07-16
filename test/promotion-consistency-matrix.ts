import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConsistencyMatrix } from '../src/ops/promotion-consistency-matrix.js';
import { buildFixtureEvidenceBundle } from '../src/ops/promotion-fixture-bundle.js';
import { replayFixtureBundle } from '../src/ops/promotion-bundle-replay.js';
import { buildCoordinatorEvidencePacket } from '../src/ops/promotion-evidence-packet.js';
import { buildReviewTranscript } from '../src/ops/promotion-review-transcript.js';
import { buildProvenanceLedger } from '../src/ops/promotion-provenance-ledger.js';
import { verifyGateDag } from '../src/ops/promotion-gate-dag.js';
import { buildArchiveManifest } from '../src/ops/promotion-archive-manifest.js';
import { buildReviewBundle } from '../src/ops/promotion-review-bundle.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-matrix-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 16, 22, 0, i++)); }
const COMMIT = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const COMMIT_ALT = 'a1b2c3d4e5f6071829304152637485960a1b2c3d';

async function fullSet(root: string, commit = COMMIT) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'matrix', now: makeNow() })));
  const replay = replayFixtureBundle(bundle);
  const evidence = buildCoordinatorEvidencePacket({ bundle, replay });
  const transcript = buildReviewTranscript({ reviewedCommit: commit, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }] });
  const ledger = buildProvenanceLedger({ bundle, replay, evidence, transcript });
  const dag = verifyGateDag();
  const archive = buildArchiveManifest({ ledger, dag, evidence, transcript });
  const reviewBundle = buildReviewBundle({ evidence, transcript, ledger, dag, archive });
  return { evidence, transcript, ledger, dag, archive, reviewBundle };
}

console.log('Running Phase 230 cross-report consistency matrix suite:\n');

await test('MATRIX_CONSISTENT when every shared digest agrees across all reports', async () => {
  const root = workspace();
  try {
    const set = await fullSet(root);
    const m = buildConsistencyMatrix(set);
    assertEq(m.overall, 'MATRIX_CONSISTENT', `consistent (mismatches: ${m.mismatches.join(',')}; incomplete: ${m.incomplete.join(',')})`);
    assertEq(m.authorization, 'NONE', 'authorizes nothing');
    assertEq(m.edges.length, 11, 'all edges present');
    assert(m.edges.every((e) => e.status === 'consistent'), 'every edge consistent');
    assert(/^[0-9a-f]{64}$/.test(m.matrixDigest), 'matrix digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('MATRIX_INCONSISTENT when one report is swapped for a different run', async () => {
  const root = workspace();
  try {
    const set = await fullSet(root); // ledger/archive/review built over transcript@COMMIT
    const otherTranscript = buildReviewTranscript({ reviewedCommit: COMMIT_ALT, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }] });
    const m = buildConsistencyMatrix({ ...set, transcript: otherTranscript });
    assertEq(m.overall, 'MATRIX_INCONSISTENT', 'inconsistent');
    assert(m.mismatches.includes('ledger.transcript-entry=transcript.self'), 'ledger/transcript edge flagged');
    assert(m.mismatches.includes('archive.transcript=transcript.self'), 'archive/transcript edge flagged');
    assert(m.mismatches.includes('review.transcript=transcript.self'), 'review/transcript edge flagged');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('MATRIX_INCOMPLETE when a report is missing', async () => {
  const root = workspace();
  try {
    const { evidence, transcript, ledger, dag, archive } = await fullSet(root);
    const m = buildConsistencyMatrix({ evidence, transcript, ledger, dag, archive }); // no reviewBundle
    assertEq(m.overall, 'MATRIX_INCOMPLETE', 'incomplete');
    assert(m.incomplete.some((r) => r.startsWith('review.')), 'review edges incomplete');
    assertEq(m.mismatches.length, 0, 'no false mismatches');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('INCOMPLETE and redaction-safe on empty input', () => {
  const m = buildConsistencyMatrix({});
  assertEq(m.overall, 'MATRIX_INCOMPLETE', 'incomplete');
  assertEq(m.incomplete.length, 11, 'all edges incomplete');
  assert(m.redactionSafe === true && !JSON.stringify(m).includes('/mnt/'), 'redaction-safe');
});

await test('CLI builds the matrix and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const set = await fullSet(root);
    const dir = join(root, 'artifacts');
    mkdirSync(dir, { recursive: true });
    const p = {
      evidence: join(dir, 'evidence.json'), transcript: join(dir, 'transcript.json'), ledger: join(dir, 'ledger.json'),
      dag: join(dir, 'dag.json'), archive: join(dir, 'archive.json'), reviewbundle: join(dir, 'review.json'),
    };
    writeFileSync(p.evidence, JSON.stringify(set.evidence));
    writeFileSync(p.transcript, JSON.stringify(set.transcript));
    writeFileSync(p.ledger, JSON.stringify(set.ledger));
    writeFileSync(p.dag, JSON.stringify(set.dag));
    writeFileSync(p.archive, JSON.stringify(set.archive));
    writeFileSync(p.reviewbundle, JSON.stringify(set.reviewBundle));
    const outPath = join(root, 'catalog-authority-test-library', 'MATRIXMARKER-out', 'matrix.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-consistency-matrix-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--evidence', p.evidence, '--transcript', p.transcript, '--ledger', p.ledger, '--dag', p.dag, '--archive', p.archive, '--reviewbundle', p.reviewbundle, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `CONSISTENT exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'matrix file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'MATRIX_CONSISTENT', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('MATRIXMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
