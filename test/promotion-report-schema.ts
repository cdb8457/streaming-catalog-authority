import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReportSchema, REPORT_SCHEMA_IDS } from '../src/ops/promotion-report-schema.js';
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
import { buildChainBundle } from '../src/ops/promotion-chain-bundle.js';
import { buildRedactionCorpus } from '../src/ops/promotion-redaction-corpus.js';
import { buildBoundaryPolicy } from '../src/ops/promotion-boundary-policy.js';
import { buildReviewAutomation } from '../src/ops/promotion-review-automation.js';
import { buildReviewerPack } from '../src/ops/promotion-reviewer-pack.js';
import { buildAcceptancePreflight } from '../src/ops/promotion-acceptance-preflight.js';
import { buildFailureMatrix } from '../src/ops/promotion-failure-matrix.js';
import { buildCliErgonomics } from '../src/ops/promotion-cli-ergonomics.js';

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
function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-repschema-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 22, 8, 0, i++)); }
const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const BASE = '1111111111111111111111111111111111111111';

async function allReports(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'repschema', now: makeNow() })));
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
  const chainBundle = buildChainBundle({ finalSummary, releaseChecklist, mergeReadiness, negativeCorpus, provenanceDiff, gateCoverage });
  const redactionCorpus = buildRedactionCorpus();
  const boundaryPolicy = buildBoundaryPolicy(projectRoot);
  const reviewAutomation = buildReviewAutomation({ chainBundle, redactionCorpus, boundaryPolicy });
  const reviewerPack = buildReviewerPack({ finalSummary, releaseChecklist, mergeReadiness, chainBundle, reviewAutomation, redactionCorpus, boundaryPolicy });
  const acceptancePreflight = buildAcceptancePreflight({ reviewerPack, context });
  const failureMatrix = buildFailureMatrix(projectRoot);
  const cliErgonomics = buildCliErgonomics(projectRoot);
  return [provenanceDiff, gateCoverage, chainBundle, redactionCorpus, boundaryPolicy, reviewAutomation, reviewerPack, acceptancePreflight, failureMatrix, cliErgonomics];
}

console.log('Running Phase 230 report schema strictness suite:\n');

await test('REPORT_SCHEMA_OK: all ten AP-AZ report types match their strict schemas', async () => {
  const root = workspace();
  try {
    const reports = await allReports(root);
    assertEq(reports.length, REPORT_SCHEMA_IDS.length, 'one live report per schema');
    const s = buildReportSchema(reports);
    assertEq(s.overall, 'REPORT_SCHEMA_OK', `ok (violations: ${s.violations.join(',')})`);
    assertEq(s.authorization, 'NONE', 'authorizes nothing');
    assertEq(s.count, reports.length, 'counts every report');
    assert(s.results.every((r) => r.valid && r.problems.length === 0), 'every report valid');
    assertEq(verifySelfDigests([s]).overall, 'ALL_VERIFIED', 'report self-verifies');
    assert(/^[0-9a-f]{64}$/.test(s.reportSchemaDigest), 'schema digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('VIOLATION on unknown key, missing key, bad status, bad digest, unknown report', async () => {
  const root = workspace();
  try {
    const [provenanceDiff] = await allReports(root);
    const base = JSON.parse(JSON.stringify(provenanceDiff)) as Record<string, unknown>;

    const extra = { ...base, smuggledField: 1 };
    assert(buildReportSchema([extra]).violations.includes('UNKNOWN_KEY'), 'unknown key flagged');

    const missing = { ...base } as Record<string, unknown>;
    delete missing.commitCount;
    assert(buildReportSchema([missing]).violations.includes('REPORT_SHAPE_INVALID'), 'missing key flagged');

    const badStatus = { ...base, overall: 'PROVENANCE_MAYBE' };
    assert(buildReportSchema([badStatus]).violations.includes('REPORT_STATUS_INVALID'), 'bad status flagged');

    const badDigest = { ...base, diffDigest: 'nope' };
    assert(buildReportSchema([badDigest]).violations.includes('REPORT_DIGEST_INVALID'), 'bad digest flagged');

    const unknown = { report: 'phase-999-unknown-report' };
    const u = buildReportSchema([unknown]);
    assertEq(u.overall, 'REPORT_SCHEMA_VIOLATION', 'violation');
    assert(u.violations.includes('REPORT_UNRECOGNIZED'), 'unknown report flagged');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('VIOLATION when the fixed literals drift (authorization/redactionSafe/version)', () => {
  const shaped = { report: 'phase-230-promotion-cli-ergonomics', version: 1, redactionSafe: true, authorization: 'SOME', overall: 'CLI_ERGONOMICS_OK', cliCount: 1, results: [], gaps: [], ergonomicsDigest: 'a'.repeat(64) };
  const s = buildReportSchema([shaped]);
  assert(s.violations.includes('REPORT_SHAPE_INVALID'), 'authorization drift flagged');
});

test('NO_REPORTS and redaction-safe on empty input', () => {
  const s = buildReportSchema([]);
  assertEq(s.overall, 'NO_REPORTS', 'no reports');
  assert(s.redactionSafe === true && !JSON.stringify(s).includes('/mnt/'), 'redaction-safe');
});

await test('CLI validates reports and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const reports = await allReports(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const flags: string[] = [];
    reports.forEach((r, i) => { const p = join(dir, `r${i}.json`); writeFileSync(p, JSON.stringify(r)); flags.push('--report', p); });
    const outPath = join(root, 'catalog-authority-test-library', 'RSMARKER-out', 'schema.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-report-schema-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...flags, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `OK exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'schema file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'REPORT_SCHEMA_OK', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('RSMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
