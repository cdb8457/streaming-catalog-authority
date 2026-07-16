import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySelfDigests } from '../src/ops/promotion-self-digest-verifier.js';
import { buildFixtureEvidenceBundle } from '../src/ops/promotion-fixture-bundle.js';
import { replayFixtureBundle } from '../src/ops/promotion-bundle-replay.js';
import { buildCoordinatorEvidencePacket } from '../src/ops/promotion-evidence-packet.js';
import { buildReviewTranscript } from '../src/ops/promotion-review-transcript.js';
import { buildProvenanceLedger } from '../src/ops/promotion-provenance-ledger.js';
import { verifyGateDag } from '../src/ops/promotion-gate-dag.js';
import { buildArchiveManifest } from '../src/ops/promotion-archive-manifest.js';
import { buildReviewBundle } from '../src/ops/promotion-review-bundle.js';
import { buildConsistencyMatrix } from '../src/ops/promotion-consistency-matrix.js';
import { buildChangelog } from '../src/ops/promotion-changelog.js';
import { buildCliContractReport } from '../src/ops/promotion-cli-contract.js';
import { assessDeterminism } from '../src/ops/promotion-determinism.js';
import { buildBlockerTaxonomy } from '../src/ops/promotion-blocker-taxonomy.js';
import { buildFinalSummary } from '../src/ops/promotion-final-summary.js';
import { buildClosureHygiene } from '../src/ops/promotion-closure-hygiene.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-selfdigest-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 17, 8, 0, i++)); }
const COMMIT = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';

async function reportSet(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'selfdig', now: makeNow() })));
  const replay = replayFixtureBundle(bundle);
  const evidence = buildCoordinatorEvidencePacket({ bundle, replay });
  const transcript = buildReviewTranscript({ reviewedCommit: COMMIT, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }] });
  const ledger = buildProvenanceLedger({ bundle, replay, evidence, transcript });
  const dag = verifyGateDag();
  const archive = buildArchiveManifest({ ledger, dag, evidence, transcript });
  const reviewBundle = buildReviewBundle({ evidence, transcript, ledger, dag, archive });
  const matrix = buildConsistencyMatrix({ evidence, transcript, ledger, dag, archive, reviewBundle });
  const changelog = buildChangelog({ commits: [{ sha: COMMIT, subject: 'Record repeatability evidence' }] });
  // The AE-AK meta-op reports themselves must also be self-digest-verifiable.
  const selfDigest = verifySelfDigests([bundle, replay, evidence, transcript, ledger, dag, archive, reviewBundle, matrix, changelog]);
  const taxonomy = buildBlockerTaxonomy();
  const determinism = assessDeterminism([{ subject: 'gate-dag', digests: [dag.dagDigest, dag.dagDigest] }]);
  const cliContract = buildCliContractReport([{ report: 'phase-230-promotion-thing-capture', redactionSafe: true, someDigest: 'a'.repeat(64) }]);
  const finalSummary = buildFinalSummary({ reviewBundle, transcript, consistencyMatrix: matrix, selfDigest, taxonomy });
  const hygiene = buildClosureHygiene(projectRoot);
  return [bundle, replay, evidence, transcript, ledger, dag, archive, reviewBundle, matrix, changelog, selfDigest, taxonomy, determinism, cliContract, finalSummary, hygiene];
}

console.log('Running Phase 230 self-digest verifier suite:\n');

await test('ALL_VERIFIED when every report is recognized and self-consistent', async () => {
  const root = workspace();
  try {
    const reports = await reportSet(root);
    const v = verifySelfDigests(reports);
    assertEq(v.overall, 'ALL_VERIFIED', `verified (mismatches: ${v.mismatches.join(',')}; unrecognized: ${v.unrecognized.join(',')})`);
    assertEq(v.authorization, 'NONE', 'authorizes nothing');
    assertEq(v.count, reports.length, 'counts every report');
    assert(v.results.every((r) => r.recognized && r.verified), 'all recognized and verified');
    assert(/^[0-9a-f]{64}$/.test(v.verifierDigest), 'verifier digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('DIGEST_MISMATCH when a report body is tampered', async () => {
  const root = workspace();
  try {
    const reports = await reportSet(root);
    const tampered = JSON.parse(JSON.stringify(reports[4])) as { complete: boolean; [k: string]: unknown }; // the ledger
    tampered.complete = !tampered.complete; // body changed, ledgerDigest now stale
    const v = verifySelfDigests([tampered, reports[5]!]);
    assertEq(v.overall, 'DIGEST_MISMATCH', 'mismatch');
    assert(v.mismatches.includes('phase-230-promotion-provenance-ledger'), 'ledger flagged');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('UNRECOGNIZED_REPORT when an unknown report id is supplied', () => {
  const v = verifySelfDigests([{ report: 'phase-999-not-a-thing', someDigest: 'x' }]);
  assertEq(v.overall, 'UNRECOGNIZED_REPORT', 'unrecognized');
  assert(v.unrecognized.includes('phase-999-not-a-thing'), 'unknown id listed');
  assert(v.results[0]!.recognized === false, 'marked not recognized');
});

await test('NO_REPORTS and redaction-safe on empty input', () => {
  const v = verifySelfDigests([]);
  assertEq(v.overall, 'NO_REPORTS', 'no reports');
  assert(v.redactionSafe === true && !JSON.stringify(v).includes('/mnt/'), 'redaction-safe');
});

await test('CLI verifies reports and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const reports = await reportSet(root);
    const dir = join(root, 'artifacts');
    mkdirSync(dir, { recursive: true });
    const files = reports.map((r, i) => { const p = join(dir, `r${i}.json`); writeFileSync(p, JSON.stringify(r)); return p; });
    const outPath = join(root, 'catalog-authority-test-library', 'SDMARKER-out', 'verification.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-self-digest-verifier-cli.ts', import.meta.url));
    const flags: string[] = [];
    for (const p of files) { flags.push('--report', p); }
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...flags, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `ALL_VERIFIED exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'verification file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'ALL_VERIFIED', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('SDMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
