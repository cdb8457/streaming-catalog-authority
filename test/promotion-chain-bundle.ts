import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChainBundle } from '../src/ops/promotion-chain-bundle.js';
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
import { buildMergeReadiness } from '../src/ops/promotion-merge-readiness.js';
import { buildProvenanceDiff } from '../src/ops/promotion-provenance-diff.js';
import { buildGateCoverage } from '../src/ops/promotion-gate-coverage.js';

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
function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-chain-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 19, 12, 0, i++)); }
const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const BASE = '1111111111111111111111111111111111111111';

async function chain(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'chain', now: makeNow() })));
  const replay = replayFixtureBundle(bundle);
  const evidence = buildCoordinatorEvidencePacket({ bundle, replay });
  const transcript = buildReviewTranscript({ reviewedCommit: HEAD, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }] });
  const ledger = buildProvenanceLedger({ bundle, replay, evidence, transcript });
  const dag = verifyGateDag();
  const archive = buildArchiveManifest({ ledger, dag, evidence, transcript });
  const reviewBundle = buildReviewBundle({ evidence, transcript, ledger, dag, archive });
  const selfDigest = verifySelfDigests([evidence, transcript, ledger, dag, archive, reviewBundle]);
  const finalSummary = buildFinalSummary({ reviewBundle, transcript });
  const negativeCorpus = buildNegativeEvidenceCorpus();
  const closureHygiene = buildClosureHygiene(projectRoot);
  const releaseChecklist = buildReleaseChecklist({ reviewBundle, transcript, finalSummary, closureHygiene, negativeCorpus, selfDigest });
  const context = { branch: 'work/phase-230', base: BASE, head: HEAD, commits: [{ sha: HEAD, subject: 'a commit' }], requiredTests: ['npm run test:phase230-local'] };
  const mergeReadiness = buildMergeReadiness({ releaseChecklist, finalSummary, context });
  const provenanceDiff = buildProvenanceDiff({ context, transcript, finalSummary, reviewBundle });
  const gateCoverage = buildGateCoverage(projectRoot);
  return { finalSummary, releaseChecklist, mergeReadiness, negativeCorpus, provenanceDiff, gateCoverage };
}

console.log('Running Phase 230 artifact chain bundle suite:\n');

await test('CHAIN_BUNDLE_READY when every component is green, digest-bound, and consistent', async () => {
  const root = workspace();
  try {
    const g = await chain(root);
    const b = buildChainBundle(g);
    assertEq(b.overall, 'CHAIN_BUNDLE_READY', `ready (blockers: ${b.blockers.join(',')})`);
    assertEq(b.authorization, 'NONE', 'authorizes nothing');
    assertEq(b.components.length, 6, 'six components');
    assert(b.components.every((c) => c.present && c.ok && /^[0-9a-f]{64}$/.test(c.digest ?? '')), 'all components green with digests');
    assert(b.bindings.length === 1 && b.bindings[0]!.ok, 'final-summary binding holds');
    assertEq(verifySelfDigests([b]).overall, 'ALL_VERIFIED', 'bundle self-verifies');
    assert(/^[0-9a-f]{64}$/.test(b.chainDigest), 'chain digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when a component is missing or not-ready', async () => {
  const root = workspace();
  try {
    const { finalSummary, releaseChecklist, mergeReadiness, negativeCorpus, provenanceDiff } = await chain(root);
    const missing = buildChainBundle({ finalSummary, releaseChecklist, mergeReadiness, negativeCorpus, provenanceDiff }); // no gateCoverage
    assertEq(missing.overall, 'CHAIN_BUNDLE_BLOCKED', 'missing component blocked');
    assert(missing.blockers.includes('GATE_COVERAGE_MISSING'), 'gate-coverage-missing blocker');

    const notReady = buildChainBundle({ ...(await chain(root)), provenanceDiff: { report: 'phase-230-promotion-provenance-diff', overall: 'PROVENANCE_MISALIGNED', diffDigest: 'a'.repeat(64) } });
    assert(notReady.blockers.includes('PROVENANCE_DIFF_MISALIGNED'), 'not-ready component blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when a component carries no/malformed binding digest', async () => {
  const root = workspace();
  try {
    const g = await chain(root);
    const stripped = JSON.parse(JSON.stringify(g.mergeReadiness)) as Record<string, unknown>;
    delete stripped.manifestDigest;
    const b = buildChainBundle({ ...g, mergeReadiness: stripped });
    assertEq(b.overall, 'CHAIN_BUNDLE_BLOCKED', 'blocked');
    assert(b.blockers.includes('COMPONENT_DIGEST_MISSING'), 'component-digest-missing blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the release checklist did not clear this final summary', async () => {
  const root = workspace();
  try {
    const g = await chain(root);
    const otherFinal = JSON.parse(JSON.stringify(g.finalSummary)) as Record<string, unknown>;
    otherFinal.summaryDigest = 'b'.repeat(64); // a different (but well-formed) summary digest
    const b = buildChainBundle({ ...g, finalSummary: otherFinal });
    assertEq(b.overall, 'CHAIN_BUNDLE_BLOCKED', 'blocked');
    assert(b.blockers.includes('FINAL_SUMMARY_BINDING_MISMATCH'), 'binding-mismatch blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BLOCKED and redaction-safe on empty input', () => {
  const b = buildChainBundle({});
  assertEq(b.overall, 'CHAIN_BUNDLE_BLOCKED', 'blocked');
  assert(b.blockers.includes('FINAL_SUMMARY_MISSING') && b.blockers.includes('GATE_COVERAGE_MISSING'), 'missing blockers');
  assert(b.redactionSafe === true && !JSON.stringify(b).includes('/mnt/'), 'redaction-safe');
});

await test('CLI packs the bundle and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const g = await chain(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const fs = w('fs.json', g.finalSummary); const rc = w('rc.json', g.releaseChecklist); const mr = w('mr.json', g.mergeReadiness);
    const nc = w('nc.json', g.negativeCorpus); const pd = w('pd.json', g.provenanceDiff); const gc = w('gc.json', g.gateCoverage);
    const outPath = join(root, 'catalog-authority-test-library', 'CBMARKER-out', 'bundle.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-chain-bundle-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--finalsummary', fs, '--releasechecklist', rc, '--mergereadiness', mr, '--negativecorpus', nc, '--provenancediff', pd, '--gatecoverage', gc, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `READY exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'bundle file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'CHAIN_BUNDLE_READY', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('CBMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
