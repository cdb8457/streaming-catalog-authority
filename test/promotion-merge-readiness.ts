import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMergeReadiness } from '../src/ops/promotion-merge-readiness.js';
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
import { buildNegativeEvidenceCorpus } from '../src/ops/promotion-negative-evidence-corpus.js';
import { buildClosureHygiene } from '../src/ops/promotion-closure-hygiene.js';
import { buildReleaseChecklist } from '../src/ops/promotion-release-checklist.js';

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
function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-merge-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 18, 10, 0, i++)); }
const COMMIT = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const COMMIT_ALT = 'a1b2c3d4e5f6071829304152637485960a1b2c3d';
const BASE = '1111111111111111111111111111111111111111';
const HEAD = '2222222222222222222222222222222222222222';

function goodContext() {
  return { branch: 'cdb8457/phase-230-promotion-safety-remediation', base: BASE, head: HEAD, commits: [{ sha: COMMIT, subject: 'Add merge-readiness dry-run manifest' }], requiredTests: ['npm run test:phase230-local', 'npm run typecheck'] };
}

async function clearedSet(root: string, commit = COMMIT) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'merge', now: makeNow() })));
  const replay = replayFixtureBundle(bundle);
  const evidence = buildCoordinatorEvidencePacket({ bundle, replay });
  const transcript = buildReviewTranscript({ reviewedCommit: commit, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }] });
  const ledger = buildProvenanceLedger({ bundle, replay, evidence, transcript });
  const dag = verifyGateDag();
  const archive = buildArchiveManifest({ ledger, dag, evidence, transcript });
  const reviewBundle = buildReviewBundle({ evidence, transcript, ledger, dag, archive });
  const selfDigest = verifySelfDigests([evidence, transcript, ledger, dag, archive, reviewBundle]);
  const finalSummary = buildFinalSummary({ reviewBundle, transcript });
  const negativeCorpus = buildNegativeEvidenceCorpus();
  const closureHygiene = buildClosureHygiene(projectRoot);
  const releaseChecklist = buildReleaseChecklist({ reviewBundle, transcript, finalSummary, closureHygiene, negativeCorpus, selfDigest });
  return { releaseChecklist, finalSummary, reviewBundle };
}

console.log('Running Phase 230 merge-readiness dry-run suite:\n');

await test('MERGE_DRY_RUN_READY with a cleared checklist + valid context -- and performs no merge', async () => {
  const root = workspace();
  try {
    const g = await clearedSet(root);
    const m = buildMergeReadiness({ releaseChecklist: g.releaseChecklist, finalSummary: g.finalSummary, context: goodContext() });
    assertEq(m.overall, 'MERGE_DRY_RUN_READY', `ready (blockers: ${m.blockers.join(',')})`);
    assertEq(m.authorization, 'NONE', 'authorizes nothing');
    assertEq(m.dryRun, true, 'is a dry run');
    assertEq(m.gitInvoked, false, 'no git invoked');
    assertEq(m.mergeActionsPerformed.length, 0, 'no merge actions performed');
    assertEq(m.branch, 'cdb8457/phase-230-promotion-safety-remediation', 'branch recorded');
    assertEq(m.base, BASE, 'base recorded');
    assertEq(m.head, HEAD, 'head recorded');
    assert(m.commitsSinceBase.length === 1 && m.commitsSinceBase[0]!.sha === COMMIT, 'commits since base recorded');
    assert(m.requiredTests.includes('npm run test:phase230-local'), 'required tests recorded');
    assert(/full .npm test. aggregate/i.test(m.fullNpmTestCaveat), 'full npm test caveat present');
    assertEq(m.openBlockers.length, 0, 'no open blockers when cleared');
    assert(m.disclaimers.some((d) => /no merge, tag, branch, or push to master/i.test(d)), 'explicit no-merge disclaimer');
    assert(m.humanGates.some((h) => /push-to-master/i.test(h)), 'merge is a human gate');
    assertEq(verifySelfDigests([m]).overall, 'ALL_VERIFIED', 'manifest self-verifies');
    assert(/^[0-9a-f]{64}$/.test(m.manifestDigest), 'manifest digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the final summary is not bound to the cleared checklist', async () => {
  const root = workspace();
  try {
    const g = await clearedSet(root);
    // a READY final summary from a different reviewed commit -> different summaryDigest than the checklist bound
    const otherTranscript = buildReviewTranscript({ reviewedCommit: COMMIT_ALT, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }] });
    const otherFinal = buildFinalSummary({ reviewBundle: g.reviewBundle, transcript: otherTranscript });
    const m = buildMergeReadiness({ releaseChecklist: g.releaseChecklist, finalSummary: otherFinal, context: goodContext() });
    assertEq(m.overall, 'MERGE_DRY_RUN_BLOCKED', 'blocked');
    assert(m.blockers.includes('FINAL_SUMMARY_BINDING_MISMATCH'), 'final-summary-binding-mismatch blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the release checklist is not cleared (open blockers surfaced)', async () => {
  const notCleared = { report: 'phase-230-promotion-coordinator-release-checklist', overall: 'RELEASE_CHECKLIST_BLOCKED', blockers: ['COMMIT_BINDING_MISMATCH'] };
  const m = buildMergeReadiness({ releaseChecklist: notCleared, context: goodContext() });
  assertEq(m.overall, 'MERGE_DRY_RUN_BLOCKED', 'blocked');
  assert(m.blockers.includes('RELEASE_CHECKLIST_NOT_CLEARED'), 'not-cleared blocker');
  assert(m.openBlockers.includes('COMMIT_BINDING_MISMATCH') && m.openBlockers.includes('RELEASE_CHECKLIST_NOT_CLEARED'), 'open blockers aggregate upstream + local');
  assertEq(m.mergeActionsPerformed.length, 0, 'still performs no merge');
});

await test('BLOCKED when the dry-run context is missing or malformed', async () => {
  const root = workspace();
  try {
    const g = await clearedSet(root);
    const missing = buildMergeReadiness({ releaseChecklist: g.releaseChecklist });
    assertEq(missing.overall, 'MERGE_DRY_RUN_BLOCKED', 'missing context blocked');
    assert(missing.blockers.includes('MERGE_CONTEXT_MISSING'), 'context-missing blocker');

    const badBase = buildMergeReadiness({ releaseChecklist: g.releaseChecklist, context: { ...goodContext(), base: 'not-a-sha' } });
    assert(badBase.blockers.includes('MERGE_CONTEXT_INVALID'), 'bad base -> context-invalid');

    const noCommits = buildMergeReadiness({ releaseChecklist: g.releaseChecklist, context: { ...goodContext(), commits: [] } });
    assert(noCommits.blockers.includes('MERGE_CONTEXT_INVALID'), 'no commits -> context-invalid');

    const leakyTest = buildMergeReadiness({ releaseChecklist: g.releaseChecklist, context: { ...goodContext(), requiredTests: ['/mnt/user/media/Movies/run.sh'] } });
    assert(leakyTest.blockers.includes('MERGE_CONTEXT_INVALID'), 'path-like required test -> context-invalid');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BLOCKED and redaction-safe on empty input (and still a no-op dry run)', () => {
  const m = buildMergeReadiness({});
  assertEq(m.overall, 'MERGE_DRY_RUN_BLOCKED', 'blocked');
  assert(m.blockers.includes('RELEASE_CHECKLIST_MISSING') && m.blockers.includes('MERGE_CONTEXT_MISSING'), 'missing blockers');
  assertEq(m.mergeActionsPerformed.length, 0, 'no merge actions');
  assertEq(m.gitInvoked, false, 'no git invoked');
  assert(m.redactionSafe === true && !JSON.stringify(m).includes('/mnt/'), 'redaction-safe');
});

await test('CLI builds the manifest and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const g = await clearedSet(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const rc = w('rc.json', g.releaseChecklist); const fs = w('fs.json', g.finalSummary); const ctx = w('ctx.json', goodContext());
    const outPath = join(root, 'catalog-authority-test-library', 'MRMARKER-out', 'manifest.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-merge-readiness-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--releasechecklist', rc, '--context', ctx, '--finalsummary', fs, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `READY exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'manifest file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'MERGE_DRY_RUN_READY', 'stdout overall');
    assertEq(parsed.dryRun, true, 'stdout marks dry run');
    assertEq(parsed.gitInvoked, false, 'stdout marks no git');
    assertEq((parsed.mergeActionsPerformed as unknown[]).length, 0, 'stdout shows no merge actions');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('MRMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
