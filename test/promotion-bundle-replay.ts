import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayFixtureBundle } from '../src/ops/promotion-bundle-replay.js';
import { buildFixtureEvidenceBundle } from '../src/ops/promotion-fixture-bundle.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

type Rec = Record<string, unknown>;
type Reports = { integrity: Rec; schema: Rec; matrix: Rec; handoff: Rec; dashboard: Rec };
type Artifacts = { approvalEvidence: Rec; promotionEvidence: Rec; evidenceReview: Rec; readiness: Rec; acceptancePacket: Rec };
const reportsOf = (b: Rec): Reports => b.reports as Reports;
const artifactsOf = (b: Rec): Artifacts => b.artifacts as Artifacts;

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-replay-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 16, 13, 0, i++)); }

async function bundle(root: string): Promise<Record<string, unknown>> {
  const b = await buildFixtureEvidenceBundle({ workDir: root, runId: 'replay', now: makeNow() });
  return JSON.parse(JSON.stringify(b)) as Record<string, unknown>;
}

console.log('Running Phase 230 bundle replay suite:\n');

await test('accepts a clean, self-consistent bundle', async () => {
  const root = workspace();
  try {
    const rep = replayFixtureBundle(await bundle(root));
    assert(rep.ok, `ok (problems: ${rep.problems.join(',')})`);
    assert(rep.checks.length >= 5, 'ran the replay checks');
    assert(/^[0-9a-f]{64}$/.test(rep.replayDigest), 'replay digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BUNDLE_REPORT_INVALID on a non-bundle input, no throw', () => {
  for (const bogus of [null, 7, 'nope', {}, { report: 'x', version: 1 }]) {
    const rep = replayFixtureBundle(bogus);
    assert(!rep.ok, 'rejected');
    assert(rep.problems.includes('BUNDLE_REPORT_INVALID'), 'report-invalid reported');
  }
});

await test('rejects a missing artifact', async () => {
  const root = workspace();
  try {
    const b = await bundle(root);
    delete (b.artifacts as Record<string, unknown>).acceptancePacket;
    const rep = replayFixtureBundle(b);
    assert(!rep.ok, 'rejected');
    assert(rep.problems.includes('ACCEPTANCE_PACKET_MISSING'), 'missing artifact reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('detects a tampered stored integrity digest', async () => {
  const root = workspace();
  try {
    const b = await bundle(root);
    reportsOf(b).integrity.integrityDigest = '0'.repeat(64);
    const rep = replayFixtureBundle(b);
    assert(!rep.ok, 'rejected');
    assert(rep.problems.includes('INTEGRITY_REPLAY_MISMATCH'), 'integrity replay mismatch reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('detects a tampered stored dashboard digest', async () => {
  const root = workspace();
  try {
    const b = await bundle(root);
    reportsOf(b).dashboard.dashboardDigest = '1'.repeat(64);
    const rep = replayFixtureBundle(b);
    assert(!rep.ok, 'rejected');
    assert(rep.problems.includes('DASHBOARD_REPLAY_MISMATCH'), 'dashboard replay mismatch reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('detects a wrong stored report type', async () => {
  const root = workspace();
  try {
    const b = await bundle(root);
    reportsOf(b).schema.report = 'not-a-schema-report';
    const rep = replayFixtureBundle(b);
    assert(!rep.ok, 'rejected');
    assert(rep.problems.includes('SCHEMA_REPORT_WRONG'), 'schema-report-wrong reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('detects a tampered matrix (self-seal broken)', async () => {
  const root = workspace();
  try {
    const b = await bundle(root);
    reportsOf(b).matrix.outcome = 'MATRIX_FAIL'; // change without resealing
    const rep = replayFixtureBundle(b);
    assert(!rep.ok, 'rejected');
    assert(rep.problems.includes('MATRIX_SELF_DIGEST_MISMATCH'), 'matrix self-digest mismatch reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('detects a manifest stage that no longer matches its artifact', async () => {
  const root = workspace();
  try {
    const b = await bundle(root);
    // Swap the promotion evidence self-digest so the manifest PROMOTION stage no longer matches it.
    artifactsOf(b).promotionEvidence.evidenceDigest = '2'.repeat(64);
    const rep = replayFixtureBundle(b);
    assert(!rep.ok, 'rejected');
    assert(rep.problems.includes('MANIFEST_STAGE_MISMATCH'), 'manifest stage mismatch reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI replays a bundle and exits non-zero on tamper', async () => {
  const root = workspace();
  try {
    const dir = join(root, 'artifacts');
    mkdirSync(dir, { recursive: true });
    const good = await bundle(root);
    const goodPath = join(dir, 'bundle.json');
    writeFileSync(goodPath, JSON.stringify(good));
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-bundle-replay-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const outPath = join(root, 'catalog-authority-test-library', 'REPLAYMARKER-out', 'replay.json');
    const okRes = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--bundle', goodPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assertEq(okRes.status, 0, `clean bundle ok (stderr: ${okRes.stderr ?? ''})`);
    assert(existsSync(outPath), 'replay file written');
    const okOut = JSON.parse(okRes.stdout ?? '') as Record<string, unknown>;
    assertEq(okOut.ok, true, 'stdout ok');
    assert(!(okRes.stdout ?? '').includes('REPLAYMARKER') && !(okRes.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');

    const bad = await bundle(root);
    reportsOf(bad).integrity.integrityDigest = '3'.repeat(64);
    const badPath = join(dir, 'bad.json');
    writeFileSync(badPath, JSON.stringify(bad));
    const badRes = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--bundle', badPath], { cwd: projectRoot, encoding: 'utf8' });
    assertEq(badRes.status, 1, 'tampered bundle exits 1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
