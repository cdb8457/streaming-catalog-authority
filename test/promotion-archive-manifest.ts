import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArchiveManifest } from '../src/ops/promotion-archive-manifest.js';
import { buildFixtureEvidenceBundle } from '../src/ops/promotion-fixture-bundle.js';
import { replayFixtureBundle } from '../src/ops/promotion-bundle-replay.js';
import { buildCoordinatorEvidencePacket } from '../src/ops/promotion-evidence-packet.js';
import { buildReviewTranscript } from '../src/ops/promotion-review-transcript.js';
import { buildProvenanceLedger } from '../src/ops/promotion-provenance-ledger.js';
import { verifyGateDag } from '../src/ops/promotion-gate-dag.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-archive-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 16, 18, 0, i++)); }
const COMMIT = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';

async function greenInputs(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'archive', now: makeNow() })));
  const replay = replayFixtureBundle(bundle);
  const evidence = buildCoordinatorEvidencePacket({ bundle, replay });
  const transcript = buildReviewTranscript({ reviewedCommit: COMMIT, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }] });
  const ledger = buildProvenanceLedger({ bundle, replay, evidence, transcript });
  const dag = verifyGateDag();
  return { ledger, dag, evidence, transcript };
}

console.log('Running Phase 230 archive manifest suite:\n');

await test('ARCHIVE_READY only when ledger + dag + evidence + transcript are all green', async () => {
  const root = workspace();
  try {
    const { ledger, dag, evidence, transcript } = await greenInputs(root);
    const archive = buildArchiveManifest({ ledger, dag, evidence, transcript });
    assertEq(archive.overall, 'ARCHIVE_READY', `ready (blockers: ${archive.blockers.join(',')})`);
    assertEq(archive.authorization, 'NONE', 'authorizes nothing');
    assertEq(archive.components.length, 4, 'four components');
    assert(archive.components.every((c) => c.present && c.ok && /^[0-9a-f]{64}$/.test(c.digest ?? '')), 'all components green with digests');
    assert(/^[0-9a-f]{64}$/.test(archive.archiveDigest), 'archive digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when a component is missing', async () => {
  const root = workspace();
  try {
    const { ledger, dag, evidence } = await greenInputs(root);
    const archive = buildArchiveManifest({ ledger, dag, evidence });
    assertEq(archive.overall, 'ARCHIVE_BLOCKED', 'blocked');
    assert(archive.blockers.includes('TRANSCRIPT_MISSING'), 'transcript-missing blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the ledger is incomplete', async () => {
  const root = workspace();
  try {
    const { dag, evidence, transcript } = await greenInputs(root);
    const incompleteLedger = buildProvenanceLedger({}); // no inputs -> complete false
    const archive = buildArchiveManifest({ ledger: incompleteLedger, dag, evidence, transcript });
    assertEq(archive.overall, 'ARCHIVE_BLOCKED', 'blocked');
    assert(archive.blockers.includes('LEDGER_INCOMPLETE'), 'ledger-incomplete blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the review transcript is not clean', async () => {
  const root = workspace();
  try {
    const { ledger, dag, evidence } = await greenInputs(root);
    const blockedTranscript = buildReviewTranscript({ reviewedCommit: COMMIT, blockers: ['SOME_BLOCKER'] });
    const archive = buildArchiveManifest({ ledger, dag, evidence, transcript: blockedTranscript });
    assertEq(archive.overall, 'ARCHIVE_BLOCKED', 'blocked');
    assert(archive.blockers.includes('TRANSCRIPT_NOT_CLEAN'), 'transcript-not-clean blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED and redaction-safe on empty input', () => {
  const archive = buildArchiveManifest({});
  assertEq(archive.overall, 'ARCHIVE_BLOCKED', 'blocked');
  assert(archive.blockers.includes('LEDGER_MISSING') && archive.blockers.includes('DAG_MISSING'), 'missing blockers');
  assert(archive.redactionSafe === true && !JSON.stringify(archive).includes('/mnt/'), 'redaction-safe');
});

await test('CLI assembles the archive and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const { ledger, dag, evidence, transcript } = await greenInputs(root);
    const dir = join(root, 'artifacts');
    mkdirSync(dir, { recursive: true });
    const p = { ledger: join(dir, 'ledger.json'), dag: join(dir, 'dag.json'), evidence: join(dir, 'evidence.json'), transcript: join(dir, 'transcript.json') };
    writeFileSync(p.ledger, JSON.stringify(ledger));
    writeFileSync(p.dag, JSON.stringify(dag));
    writeFileSync(p.evidence, JSON.stringify(evidence));
    writeFileSync(p.transcript, JSON.stringify(transcript));
    const outPath = join(root, 'catalog-authority-test-library', 'ARCHIVEMARKER-out', 'archive.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-archive-manifest-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--ledger', p.ledger, '--dag', p.dag, '--evidence', p.evidence, '--transcript', p.transcript, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `READY exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'archive file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'ARCHIVE_READY', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('ARCHIVEMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
