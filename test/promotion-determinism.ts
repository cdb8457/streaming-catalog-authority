import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessDeterminism } from '../src/ops/promotion-determinism.js';
import { buildFixtureEvidenceBundle } from '../src/ops/promotion-fixture-bundle.js';
import { replayFixtureBundle } from '../src/ops/promotion-bundle-replay.js';
import { buildCoordinatorEvidencePacket } from '../src/ops/promotion-evidence-packet.js';
import { buildReviewTranscript } from '../src/ops/promotion-review-transcript.js';
import { buildProvenanceLedger } from '../src/ops/promotion-provenance-ledger.js';
import { verifyGateDag } from '../src/ops/promotion-gate-dag.js';
import { buildArchiveManifest } from '../src/ops/promotion-archive-manifest.js';
import { buildReviewBundle } from '../src/ops/promotion-review-bundle.js';
import { buildConsistencyMatrix } from '../src/ops/promotion-consistency-matrix.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-determinism-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 17, 12, 0, i++)); }
const COMMIT = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const COMMIT_ALT = 'a1b2c3d4e5f6071829304152637485960a1b2c3d';

async function chain(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'det', now: makeNow() })));
  const replay = replayFixtureBundle(bundle);
  const evidence = buildCoordinatorEvidencePacket({ bundle, replay });
  const transcript = buildReviewTranscript({ reviewedCommit: COMMIT, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }] });
  const ledger = buildProvenanceLedger({ bundle, replay, evidence, transcript });
  const dag = verifyGateDag();
  const archive = buildArchiveManifest({ ledger, dag, evidence, transcript });
  return { evidence, transcript, ledger, dag, archive };
}

console.log('Running Phase 230 determinism stress suite:\n');

// Rebuild the fixture chain from scratch, with identical (workDir, runId, now) inputs, to capture the
// bottom-of-stack digests. Same inputs must yield the same digests every time.
async function rebuild(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'det', now: makeNow() })));
  const replay = replayFixtureBundle(bundle);
  const evidence = buildCoordinatorEvidencePacket({ bundle, replay });
  const transcript = buildReviewTranscript({ reviewedCommit: COMMIT, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }] });
  const ledger = buildProvenanceLedger({ bundle, replay, evidence, transcript });
  return { bundle: bundle.bundleDigest as string, replay: replay.replayDigest, evidence: evidence.packetDigest, ledger: ledger.ledgerDigest };
}

await test('DETERMINISTIC across repeated builds and reordered inputs', async () => {
  const root = workspace();
  try {
    const { evidence, transcript, ledger, dag, archive } = await chain(root);
    const times = <T>(n: number, f: () => T): T[] => Array.from({ length: n }, f);
    const s = [await rebuild(root), await rebuild(root), await rebuild(root)];

    const subjects = [
      // bottom-of-stack builders rebuilt from identical inputs
      { subject: 'fixture-bundle', digests: s.map((x) => x.bundle) },
      { subject: 'bundle-replay', digests: s.map((x) => x.replay) },
      { subject: 'evidence-packet', digests: s.map((x) => x.evidence) },
      { subject: 'provenance-ledger', digests: s.map((x) => x.ledger) },
      // pure aggregators recomputed in place
      { subject: 'gate-dag', digests: times(3, () => verifyGateDag().dagDigest) },
      { subject: 'archive-manifest', digests: times(3, () => buildArchiveManifest({ ledger, dag, evidence, transcript }).archiveDigest) },
      { subject: 'review-bundle', digests: times(3, () => buildReviewBundle({ evidence, transcript, ledger, dag, archive }).reviewBundleDigest) },
      // input-order independence: the matrix reads named fields, so key order must not change the digest.
      {
        subject: 'consistency-matrix-reordered', digests: [
          buildConsistencyMatrix({ evidence, transcript, ledger, dag, archive }).matrixDigest,
          buildConsistencyMatrix({ archive, dag, ledger, transcript, evidence }).matrixDigest,
          buildConsistencyMatrix({ dag, evidence, archive, ledger, transcript }).matrixDigest,
        ],
      },
    ];
    const r = assessDeterminism(subjects);
    assertEq(r.overall, 'DETERMINISTIC', `deterministic (non-deterministic: ${r.nonDeterministic.join(',')})`);
    assertEq(r.authorization, 'NONE', 'authorizes nothing');
    assert(r.results.every((x) => x.deterministic && x.distinct === 1 && x.samples === 3), 'every subject stable over 3 samples');
    assert(r.results.some((x) => x.subject === 'fixture-bundle') && r.results.some((x) => x.subject === 'provenance-ledger'), 'covers bundle + ledger');
    assert(/^[0-9a-f]{64}$/.test(r.determinismDigest), 'determinism digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('controlled changes are detected: a deliberate input change alters the digest', async () => {
  const root = workspace();
  try {
    const { evidence, ledger, dag } = await chain(root);
    // A controlled change to the reviewed commit must change the transcript digest...
    const trA = buildReviewTranscript({ reviewedCommit: COMMIT, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }] });
    const trB = buildReviewTranscript({ reviewedCommit: COMMIT_ALT, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }] });
    assert(trA.transcriptDigest !== trB.transcriptDigest, 'reviewed-commit change alters the transcript digest');
    // ...and propagate into the ledger digest.
    const ledgerA = buildProvenanceLedger({ bundle: {}, replay: {}, evidence, transcript: trA });
    const ledgerB = buildProvenanceLedger({ bundle: {}, replay: {}, evidence, transcript: trB });
    assert(ledgerA.ledgerDigest !== ledgerB.ledgerDigest, 'transcript change alters the ledger digest');
    // A change to the archive input changes its digest too.
    const archA = buildArchiveManifest({ ledger, dag, evidence, transcript: trA });
    const archB = buildArchiveManifest({ ledger, dag, evidence, transcript: trB });
    assert(archA.archiveDigest !== archB.archiveDigest, 'transcript change alters the archive digest');
    // Feeding the differing samples as one subject must be reported NON_DETERMINISTIC (sensitivity proof).
    const r = assessDeterminism([{ subject: 'transcript-controlled-change', digests: [trA.transcriptDigest, trB.transcriptDigest] }]);
    assertEq(r.overall, 'NON_DETERMINISTIC', 'controlled change surfaces as non-deterministic');
    assert(r.nonDeterministic.includes('transcript-controlled-change'), 'controlled-change subject flagged');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('NON_DETERMINISTIC when a subject varies across samples', () => {
  const r = assessDeterminism([{ subject: 'flaky', digests: ['a'.repeat(64), 'b'.repeat(64), 'a'.repeat(64)] }]);
  assertEq(r.overall, 'NON_DETERMINISTIC', 'non-deterministic');
  assert(r.nonDeterministic.includes('flaky'), 'flaky subject flagged');
});

test('INSUFFICIENT_SAMPLES when a subject has fewer than two samples', () => {
  const r = assessDeterminism([{ subject: 'thin', digests: ['a'.repeat(64)] }]);
  assertEq(r.overall, 'INSUFFICIENT_SAMPLES', 'insufficient');
  assert(!r.results[0]!.deterministic, 'single-sample subject not deterministic');
});

test('NO_SUBJECTS and redaction-safe on empty input', () => {
  const r = assessDeterminism([]);
  assertEq(r.overall, 'NO_SUBJECTS', 'no subjects');
  assert(r.redactionSafe === true && !JSON.stringify(r).includes('/mnt/'), 'redaction-safe');
});

await test('CLI assesses a subjects file and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const subjects = { subjects: [{ subject: 'gate-dag', digests: [verifyGateDag().dagDigest, verifyGateDag().dagDigest] }] };
    const inPath = join(root, 'subjects.json');
    writeFileSync(inPath, JSON.stringify(subjects));
    const outPath = join(root, 'catalog-authority-test-library', 'DETMARKER-out', 'determinism.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-determinism-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--in', inPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `DETERMINISTIC exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'determinism file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'DETERMINISTIC', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('DETMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
