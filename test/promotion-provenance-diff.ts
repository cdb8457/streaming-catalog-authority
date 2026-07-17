import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProvenanceDiff } from '../src/ops/promotion-provenance-diff.js';
import { buildFixtureEvidenceBundle } from '../src/ops/promotion-fixture-bundle.js';
import { replayFixtureBundle } from '../src/ops/promotion-bundle-replay.js';
import { buildCoordinatorEvidencePacket } from '../src/ops/promotion-evidence-packet.js';
import { buildReviewTranscript } from '../src/ops/promotion-review-transcript.js';
import { buildProvenanceLedger } from '../src/ops/promotion-provenance-ledger.js';
import { verifyGateDag } from '../src/ops/promotion-gate-dag.js';
import { buildArchiveManifest } from '../src/ops/promotion-archive-manifest.js';
import { buildReviewBundle } from '../src/ops/promotion-review-bundle.js';
import { buildFinalSummary } from '../src/ops/promotion-final-summary.js';
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
function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-provdiff-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 19, 8, 0, i++)); }
const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const BASE = '1111111111111111111111111111111111111111';

function context(over: Record<string, unknown> = {}) {
  return { branch: 'work/phase-230', base: BASE, head: HEAD, commits: [{ sha: HEAD, subject: 'the reviewed commit' }], ...over };
}

async function artifacts(root: string, commit = HEAD) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'provdiff', now: makeNow() })));
  const replay = replayFixtureBundle(bundle);
  const evidence = buildCoordinatorEvidencePacket({ bundle, replay });
  const transcript = buildReviewTranscript({ reviewedCommit: commit, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }] });
  const ledger = buildProvenanceLedger({ bundle, replay, evidence, transcript });
  const dag = verifyGateDag();
  const archive = buildArchiveManifest({ ledger, dag, evidence, transcript });
  const reviewBundle = buildReviewBundle({ evidence, transcript, ledger, dag, archive });
  const finalSummary = buildFinalSummary({ reviewBundle, transcript });
  return { transcript, reviewBundle, finalSummary };
}

console.log('Running Phase 230 evidence provenance diff suite:\n');

await test('PROVENANCE_ALIGNED when head == reviewed commit, in range, and artifacts bind', async () => {
  const root = workspace();
  try {
    const a = await artifacts(root);
    const d = buildProvenanceDiff({ context: context(), transcript: a.transcript, finalSummary: a.finalSummary, reviewBundle: a.reviewBundle });
    assertEq(d.overall, 'PROVENANCE_ALIGNED', `aligned (blockers: ${d.blockers.join(',')})`);
    assertEq(d.authorization, 'NONE', 'authorizes nothing');
    assertEq(d.head, HEAD, 'head recorded');
    assertEq(d.reviewedCommit, HEAD, 'reviewed commit recorded');
    assert(d.checks.every((c) => c.ok), 'every check ok');
    assertEq(verifySelfDigests([d]).overall, 'ALL_VERIFIED', 'report self-verifies');
    assert(/^[0-9a-f]{64}$/.test(d.diffDigest), 'diff digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('MISALIGNED when head does not equal the reviewed commit', async () => {
  const root = workspace();
  try {
    const a = await artifacts(root, 'a1b2c3d4e5f6071829304152637485960a1b2c3d'); // transcript reviewed at a different commit
    const d = buildProvenanceDiff({ context: context(), transcript: a.transcript });
    assertEq(d.overall, 'PROVENANCE_MISALIGNED', 'misaligned');
    assert(d.blockers.includes('HEAD_REVIEWED_COMMIT_MISMATCH'), 'head/reviewed-commit mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('MISALIGNED on missing head/base/branch and malformed commit shas', async () => {
  const root = workspace();
  try {
    const a = await artifacts(root);
    const missing = buildProvenanceDiff({ context: { commits: [{ sha: HEAD, subject: 'x' }] }, transcript: a.transcript });
    assert(missing.blockers.includes('HEAD_MISSING') && missing.blockers.includes('BASE_MISSING') && missing.blockers.includes('BRANCH_MISSING'), 'missing ref blockers');
    const badSha = buildProvenanceDiff({ context: context({ commits: [{ sha: 'nope', subject: 'x' }] }), transcript: a.transcript });
    assert(badSha.blockers.includes('COMMIT_SHA_MALFORMED'), 'malformed commit sha blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('MISALIGNED on a stale review bundle and on a path/title leak', async () => {
  const root = workspace();
  try {
    const a = await artifacts(root);
    const stale = { report: 'phase-230-promotion-coordinator-review-bundle', overall: 'REVIEW_BUNDLE_READY', components: [{ component: 'transcript', digest: '0'.repeat(64) }] };
    const staleDiff = buildProvenanceDiff({ context: context(), transcript: a.transcript, reviewBundle: stale });
    assert(staleDiff.blockers.includes('STALE_ARTIFACT'), 'stale-artifact blocker');
    const leak = buildProvenanceDiff({ context: context({ commits: [{ sha: HEAD, subject: '/mnt/user/media/Movies/x.mkv' }] }), transcript: a.transcript });
    assert(leak.blockers.includes('RAW_PATH_LEAK'), 'path/title leak blocker');
    assert(!JSON.stringify(staleDiff).includes('/mnt/'), 'report stays redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('MISALIGNED and redaction-safe on empty input', () => {
  const d = buildProvenanceDiff({});
  assertEq(d.overall, 'PROVENANCE_MISALIGNED', 'misaligned');
  assert(d.blockers.includes('TRANSCRIPT_MISSING') && d.blockers.includes('HEAD_MISSING'), 'missing blockers');
  assert(d.redactionSafe === true && !JSON.stringify(d).includes('/mnt/'), 'redaction-safe');
});

await test('CLI builds the diff and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const a = await artifacts(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const ctx = w('ctx.json', context()); const tr = w('tr.json', a.transcript); const fs = w('fs.json', a.finalSummary); const rb = w('rb.json', a.reviewBundle);
    const outPath = join(root, 'catalog-authority-test-library', 'PDMARKER-out', 'diff.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-provenance-diff-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--context', ctx, '--transcript', tr, '--finalsummary', fs, '--reviewbundle', rb, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `ALIGNED exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'diff file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'PROVENANCE_ALIGNED', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('PDMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
