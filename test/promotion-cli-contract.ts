import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCliContract, buildCliContractReport } from '../src/ops/promotion-cli-contract.js';
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

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-clicontract-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 17, 10, 0, i++)); }
const COMMIT = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const sig = (keys: string[]): string => keys.filter((k) => k !== 'outputWritten').sort().join(',');

async function chain(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'cli', now: makeNow() })));
  const replay = replayFixtureBundle(bundle);
  const evidence = buildCoordinatorEvidencePacket({ bundle, replay });
  const transcript = buildReviewTranscript({ reviewedCommit: COMMIT, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }] });
  const ledger = buildProvenanceLedger({ bundle, replay, evidence, transcript });
  const dag = verifyGateDag();
  const archive = buildArchiveManifest({ ledger, dag, evidence, transcript });
  const reviewBundle = buildReviewBundle({ evidence, transcript, ledger, dag, archive });
  return { evidence, transcript, ledger, dag, archive, reviewBundle };
}
function run(cli: string, args: string[]): { status: number | null; stdout: string } {
  const cliPath = join(projectRoot, 'src', 'ops', cli);
  const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], { cwd: projectRoot, encoding: 'utf8' });
  assert(res.error === undefined, `spawn ${cli}: ${res.error?.message ?? ''}`);
  return { status: res.status, stdout: res.stdout ?? '' };
}

console.log('Running Phase 230 CLI contract guard suite:\n');

test('every reporting CLI declares redactionSafe in its stdout capture (static coverage)', () => {
  const dir = join(projectRoot, 'src', 'ops');
  const clis = readdirSync(dir).filter((f) => f.endsWith('-cli.ts'));
  const reporting = clis.filter((f) => readFileSync(join(dir, f), 'utf8').includes("-capture'"));
  assert(reporting.length >= 10, `expected many reporting CLIs, found ${reporting.length}`);
  for (const f of reporting) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert(src.includes('redactionSafe: true'), `${f} must emit redactionSafe: true`);
  }
});

test('the verifier accepts a compliant capture and rejects each violation', () => {
  const good = { report: 'phase-230-promotion-thing-capture', overall: 'X', redactionSafe: true, someDigest: 'a'.repeat(64) };
  assert(verifyCliContract(good).ok, 'compliant capture accepted');
  assert(verifyCliContract({ ...good, report: 'phase-230-promotion-thing' }).problems.includes('REPORT_ID_INVALID'), 'bad report id flagged');
  assert(verifyCliContract({ ...good, redactionSafe: false }).problems.includes('REDACTION_FLAG_MISSING'), 'missing flag flagged');
  const noDigest = { report: 'phase-230-promotion-thing-capture', overall: 'X', redactionSafe: true };
  assert(verifyCliContract(noDigest).problems.includes('DIGEST_MISSING'), 'missing digest flagged');
  assert(verifyCliContract({ ...good, note: '/mnt/user/media/Movies/x.mkv' }).problems.includes('RAW_PATH_LEAK'), 'path leak flagged');
  assert(!verifyCliContract(42).ok && verifyCliContract(42).problems.includes('NOT_AN_OBJECT'), 'non-object rejected');
});

await test('a live consistency-matrix + self-digest-verifier capture matches its declared signature', async () => {
  const root = workspace();
  try {
    const set = await chain(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const p = { evidence: w('e.json', set.evidence), transcript: w('t.json', set.transcript), ledger: w('l.json', set.ledger), dag: w('d.json', set.dag), archive: w('ar.json', set.archive), review: w('rb.json', set.reviewBundle) };

    const m = run('promotion-consistency-matrix-cli.ts', ['--evidence', p.evidence, '--transcript', p.transcript, '--ledger', p.ledger, '--dag', p.dag, '--archive', p.archive, '--reviewbundle', p.review]);
    assertEq(m.status, 0, 'matrix CLI exit 0');
    const mc = JSON.parse(m.stdout) as Record<string, unknown>;
    const mr = verifyCliContract(mc);
    assert(mr.ok, `matrix capture compliant (problems: ${mr.problems.join(',')})`);
    assertEq(mr.keySignature, sig(['report', 'overall', 'authorization', 'redactionSafe', 'edges', 'mismatches', 'incomplete', 'matrixDigest']), 'matrix signature stable');

    const v = run('promotion-self-digest-verifier-cli.ts', ['--report', p.evidence, '--report', p.ledger]);
    assertEq(v.status, 0, 'verifier CLI exit 0');
    const vc = JSON.parse(v.stdout) as Record<string, unknown>;
    const vr = verifyCliContract(vc);
    assert(vr.ok, `verifier capture compliant (problems: ${vr.problems.join(',')})`);
    assertEq(vr.keySignature, sig(['report', 'overall', 'authorization', 'redactionSafe', 'count', 'results', 'mismatches', 'unrecognized', 'verifierDigest']), 'verifier signature stable');

    // the aggregate report over both captures
    const agg = buildCliContractReport([mc, vc]);
    assertEq(agg.overall, 'CONTRACT_OK', `aggregate ok (violations: ${agg.violations.join(',')})`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('NO_CAPTURES and redaction-safe on empty input', () => {
  const r = buildCliContractReport([]);
  assertEq(r.overall, 'NO_CAPTURES', 'no captures');
  assert(r.redactionSafe === true && !JSON.stringify(r).includes('/mnt/'), 'redaction-safe');
});

await test('CLI verifies captures and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const set = await chain(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const p = { evidence: w('e.json', set.evidence), transcript: w('t.json', set.transcript), ledger: w('l.json', set.ledger), dag: w('d.json', set.dag), archive: w('ar.json', set.archive), review: w('rb.json', set.reviewBundle) };
    const m = run('promotion-consistency-matrix-cli.ts', ['--evidence', p.evidence, '--transcript', p.transcript, '--ledger', p.ledger, '--dag', p.dag, '--archive', p.archive, '--reviewbundle', p.review]);
    const capFile = w('cap.json', JSON.parse(m.stdout));
    const outPath = join(root, 'catalog-authority-test-library', 'CCMARKER-out', 'contract.json');
    const res = run('promotion-cli-contract-cli.ts', ['--capture', capFile, '--out', outPath]);
    assertEq(res.status, 0, `CONTRACT_OK exit (stdout: ${res.stdout})`);
    assert(existsSync(outPath), 'contract report written');
    const parsed = JSON.parse(res.stdout) as Record<string, unknown>;
    assertEq(parsed.overall, 'CONTRACT_OK', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!res.stdout.includes('CCMARKER') && !res.stdout.includes('catalog-authority-test-library') && !res.stdout.includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
