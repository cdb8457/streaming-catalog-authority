import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewBundle, REVIEW_BUNDLE_DISCLAIMERS } from '../src/ops/promotion-review-bundle.js';
import { buildFixtureEvidenceBundle } from '../src/ops/promotion-fixture-bundle.js';
import { replayFixtureBundle } from '../src/ops/promotion-bundle-replay.js';
import { buildCoordinatorEvidencePacket } from '../src/ops/promotion-evidence-packet.js';
import { buildReviewTranscript } from '../src/ops/promotion-review-transcript.js';
import { buildProvenanceLedger } from '../src/ops/promotion-provenance-ledger.js';
import { verifyGateDag } from '../src/ops/promotion-gate-dag.js';
import { buildArchiveManifest } from '../src/ops/promotion-archive-manifest.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-reviewbundle-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 16, 20, 0, i++)); }
const COMMIT = 'c71c61e7d868705fa191b7fdf9d93f15f1309043';

async function greenInputs(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'rb', now: makeNow() })));
  const replay = replayFixtureBundle(bundle);
  const evidence = buildCoordinatorEvidencePacket({ bundle, replay });
  const transcript = buildReviewTranscript({ reviewedCommit: COMMIT, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }] });
  const ledger = buildProvenanceLedger({ bundle, replay, evidence, transcript });
  const dag = verifyGateDag();
  const archive = buildArchiveManifest({ ledger, dag, evidence, transcript });
  return { evidence, transcript, ledger, dag, archive };
}

console.log('Running Phase 230 coordinator review bundle suite:\n');

await test('REVIEW_BUNDLE_READY only when all five components are green', async () => {
  const root = workspace();
  try {
    const inputs = await greenInputs(root);
    const rb = buildReviewBundle(inputs);
    assertEq(rb.overall, 'REVIEW_BUNDLE_READY', `ready (blockers: ${rb.blockers.join(',')})`);
    assertEq(rb.authorization, 'NONE', 'authorizes nothing');
    assertEq(rb.components.length, 5, 'five components');
    assert(rb.components.every((c) => c.present && c.ok && /^[0-9a-f]{64}$/.test(c.digest ?? '')), 'all components green with digests');
    assertEq(rb.disclaimers.length, REVIEW_BUNDLE_DISCLAIMERS.length, 'disclaimers present');
    assert(rb.disclaimers.some((d) => /does NOT authorize Phase 231/i.test(d)), 'explicit no-Phase-231 language');
    assert(/^[0-9a-f]{64}$/.test(rb.reviewBundleDigest), 'review bundle digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when a component is missing (disclaimers still present)', async () => {
  const root = workspace();
  try {
    const { evidence, transcript, ledger, dag } = await greenInputs(root);
    const rb = buildReviewBundle({ evidence, transcript, ledger, dag }); // no archive
    assertEq(rb.overall, 'REVIEW_BUNDLE_BLOCKED', 'blocked');
    assert(rb.blockers.includes('ARCHIVE_MISSING'), 'archive-missing blocker');
    assertEq(rb.disclaimers.length, REVIEW_BUNDLE_DISCLAIMERS.length, 'disclaimers still present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the transcript is not clean', async () => {
  const root = workspace();
  try {
    const { evidence, ledger, dag, archive } = await greenInputs(root);
    const notClean = buildReviewTranscript({ reviewedCommit: COMMIT, blockers: ['X'] });
    const rb = buildReviewBundle({ evidence, transcript: notClean, ledger, dag, archive });
    assertEq(rb.overall, 'REVIEW_BUNDLE_BLOCKED', 'blocked');
    assert(rb.blockers.includes('TRANSCRIPT_NOT_CLEAN'), 'transcript-not-clean blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED and redaction-safe on empty input', () => {
  const rb = buildReviewBundle({});
  assertEq(rb.overall, 'REVIEW_BUNDLE_BLOCKED', 'blocked');
  assert(rb.blockers.includes('EVIDENCE_MISSING') && rb.blockers.includes('ARCHIVE_MISSING'), 'missing blockers');
  assert(rb.redactionSafe === true && !JSON.stringify(rb).includes('/mnt/'), 'redaction-safe');
});

await test('CLI assembles the review bundle and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const inputs = await greenInputs(root);
    const dir = join(root, 'artifacts');
    mkdirSync(dir, { recursive: true });
    const p = { evidence: join(dir, 'evidence.json'), transcript: join(dir, 'transcript.json'), ledger: join(dir, 'ledger.json'), dag: join(dir, 'dag.json'), archive: join(dir, 'archive.json') };
    writeFileSync(p.evidence, JSON.stringify(inputs.evidence));
    writeFileSync(p.transcript, JSON.stringify(inputs.transcript));
    writeFileSync(p.ledger, JSON.stringify(inputs.ledger));
    writeFileSync(p.dag, JSON.stringify(inputs.dag));
    writeFileSync(p.archive, JSON.stringify(inputs.archive));
    const outPath = join(root, 'catalog-authority-test-library', 'RBMARKER-out', 'reviewbundle.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-review-bundle-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--evidence', p.evidence, '--transcript', p.transcript, '--ledger', p.ledger, '--dag', p.dag, '--archive', p.archive, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `READY exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'review bundle file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'REVIEW_BUNDLE_READY', 'stdout overall');
    assertEq(parsed.authorization, 'NONE', 'stdout authorization NONE');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('RBMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
