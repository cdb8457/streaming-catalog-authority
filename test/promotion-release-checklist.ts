import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReleaseChecklist, RELEASE_CHECKLIST_HUMAN_GATES, RELEASE_CHECKLIST_DISCLAIMERS } from '../src/ops/promotion-release-checklist.js';
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
function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-release-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 18, 8, 0, i++)); }
const COMMIT = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const COMMIT_ALT = 'a1b2c3d4e5f6071829304152637485960a1b2c3d';

function without(obj: unknown, field: string): Record<string, unknown> {
  const c = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  delete c[field];
  return c;
}
function withField(obj: unknown, field: string, value: unknown): Record<string, unknown> {
  const c = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  c[field] = value;
  return c;
}

async function greenInputs(root: string, commit = COMMIT) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'release', now: makeNow() })));
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
  return { reviewBundle, transcript, finalSummary, closureHygiene, negativeCorpus, selfDigest };
}

console.log('Running Phase 230 coordinator release checklist suite:\n');

await test('RELEASE_CHECKLIST_CLEARED when every item passes and the artifacts bind to one run', async () => {
  const root = workspace();
  try {
    const g = await greenInputs(root);
    const c = buildReleaseChecklist(g);
    assertEq(c.overall, 'RELEASE_CHECKLIST_CLEARED', `cleared (blockers: ${c.blockers.join(',')})`);
    assertEq(c.authorization, 'NONE', 'authorizes nothing');
    assert(c.items.every((i) => i.pass), 'every item passes');
    assert(c.bindings.length === 3 && c.bindings.every((b) => b.ok), 'all three bindings hold');
    assert(/^[0-9a-f]{64}$/.test(c.boundDigests['review-bundle'] ?? '') && /^[0-9a-f]{64}$/.test(c.boundDigests['final-summary'] ?? ''), 'bound digests recorded');
    assert(c.disclaimers.some((d) => /merge\/tag\/master/i.test(d)), 'explicit no-merge disclaimer');
    assertEq(verifySelfDigests([c]).overall, 'ALL_VERIFIED', 'checklist self-verifies');
    assertEq(c.humanGates.length, RELEASE_CHECKLIST_HUMAN_GATES.length, 'human gates restated');
    assertEq(c.disclaimers.length, RELEASE_CHECKLIST_DISCLAIMERS.length, 'disclaimers present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when a required READY artifact carries no binding digest (coordinator repro)', async () => {
  const root = workspace();
  try {
    const { reviewBundle, transcript, finalSummary, closureHygiene, negativeCorpus } = await greenInputs(root);
    // review bundle / final summary / hygiene / corpus are all READY/OK but carry no digest field
    const c = buildReleaseChecklist({
      reviewBundle: without(reviewBundle, 'reviewBundleDigest'),
      transcript,
      finalSummary: without(finalSummary, 'summaryDigest'),
      closureHygiene: without(closureHygiene, 'hygieneDigest'),
      negativeCorpus: without(negativeCorpus, 'corpusDigest'),
    });
    assertEq(c.overall, 'RELEASE_CHECKLIST_BLOCKED', 'must not clear without binding digests');
    assert(c.blockers.includes('REQUIRED_DIGEST_MISSING'), 'required-digest-missing blocker');
    assertEq(Object.keys(c.boundDigests).length, 1, 'only the transcript binds');
    assert(c.boundDigests['transcript'] !== undefined && c.boundDigests['review-bundle'] === undefined, 'no review-bundle binding recorded');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when a required artifact has a malformed digest field', async () => {
  const root = workspace();
  try {
    const g = await greenInputs(root);
    const c = buildReleaseChecklist({ ...g, finalSummary: withField(g.finalSummary, 'summaryDigest', 'not-a-sha256') });
    assertEq(c.overall, 'RELEASE_CHECKLIST_BLOCKED', 'blocked');
    assert(c.blockers.includes('REQUIRED_DIGEST_INVALID'), 'required-digest-invalid blocker');
    assert(c.boundDigests['final-summary'] === undefined, 'malformed digest not recorded as bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the optional self-digest is supplied with a malformed digest', async () => {
  const root = workspace();
  try {
    const g = await greenInputs(root);
    const c = buildReleaseChecklist({ ...g, selfDigest: withField(g.selfDigest, 'verifierDigest', 'nope') });
    assertEq(c.overall, 'RELEASE_CHECKLIST_BLOCKED', 'blocked');
    assert(c.blockers.includes('REQUIRED_DIGEST_INVALID'), 'supplied optional digest must be valid');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the final summary was built over a different reviewed commit', async () => {
  const root = workspace();
  try {
    const g = await greenInputs(root);
    // a final summary from a transcript at COMMIT_ALT, paired with the run's transcript at COMMIT
    const otherTranscript = buildReviewTranscript({ reviewedCommit: COMMIT_ALT, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }] });
    const staleFinal = buildFinalSummary({ reviewBundle: g.reviewBundle, transcript: otherTranscript });
    const c = buildReleaseChecklist({ ...g, finalSummary: staleFinal });
    assertEq(c.overall, 'RELEASE_CHECKLIST_BLOCKED', 'blocked');
    assert(c.blockers.includes('COMMIT_BINDING_MISMATCH'), 'commit-binding-mismatch blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the review bundle does not bind the supplied transcript', async () => {
  const a = workspace();
  const b = workspace();
  try {
    const ga = await greenInputs(a);
    const gb = await greenInputs(b, COMMIT_ALT); // a different commit -> a different transcript digest
    // review bundle from run A, but transcript + final summary from run B (transcript digest differs)
    const c = buildReleaseChecklist({ ...ga, transcript: gb.transcript, finalSummary: gb.finalSummary });
    assertEq(c.overall, 'RELEASE_CHECKLIST_BLOCKED', 'blocked');
    assert(c.blockers.includes('TRANSCRIPT_BUNDLE_MISMATCH'), 'transcript-bundle-mismatch blocker');
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

await test('BLOCKED when a required item is missing', async () => {
  const root = workspace();
  try {
    const { reviewBundle, transcript, finalSummary, closureHygiene } = await greenInputs(root);
    const c = buildReleaseChecklist({ reviewBundle, transcript, finalSummary, closureHygiene }); // no negativeCorpus
    assertEq(c.overall, 'RELEASE_CHECKLIST_BLOCKED', 'blocked');
    assert(c.blockers.includes('NEGATIVE_CORPUS_MISSING'), 'negative-corpus-missing blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the adversarial corpus reports a breach', async () => {
  const root = workspace();
  try {
    const g = await greenInputs(root);
    const breached = { report: 'phase-230-promotion-negative-evidence-corpus', overall: 'CORPUS_BREACHED' };
    const c = buildReleaseChecklist({ ...g, negativeCorpus: breached });
    assertEq(c.overall, 'RELEASE_CHECKLIST_BLOCKED', 'blocked');
    assert(c.blockers.includes('NEGATIVE_CORPUS_BREACHED'), 'corpus-breached blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BLOCKED and redaction-safe on empty input', () => {
  const c = buildReleaseChecklist({});
  assertEq(c.overall, 'RELEASE_CHECKLIST_BLOCKED', 'blocked');
  assert(c.blockers.includes('REVIEW_BUNDLE_MISSING') && c.blockers.includes('TRANSCRIPT_MISSING') && c.blockers.includes('FINAL_SUMMARY_MISSING'), 'required-missing blockers');
  assert(c.redactionSafe === true && !JSON.stringify(c).includes('/mnt/'), 'redaction-safe');
});

await test('CLI builds the checklist and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const g = await greenInputs(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const rb = w('rb.json', g.reviewBundle); const tr = w('tr.json', g.transcript); const fs = w('fs.json', g.finalSummary); const ch = w('ch.json', g.closureHygiene); const nc = w('nc.json', g.negativeCorpus); const sd = w('sd.json', g.selfDigest);
    const outPath = join(root, 'catalog-authority-test-library', 'RCMARKER-out', 'checklist.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-release-checklist-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--reviewbundle', rb, '--transcript', tr, '--finalsummary', fs, '--closurehygiene', ch, '--negativecorpus', nc, '--selfdigest', sd, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `CLEARED exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'checklist file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'RELEASE_CHECKLIST_CLEARED', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('RCMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
