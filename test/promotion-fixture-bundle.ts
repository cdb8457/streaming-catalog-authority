import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-bundle-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 16, 12, 0, i++)); }

console.log('Running Phase 230 fixture evidence bundle suite:\n');

await test('generates a complete, all-green BUNDLE_READY bundle', async () => {
  const root = workspace();
  try {
    const bundle = await buildFixtureEvidenceBundle({ workDir: root, runId: 'b', now: makeNow() });
    assertEq(bundle.outcome, 'BUNDLE_READY', `ready (notes: ${bundle.notes.join(',')})`);
    assertEq(bundle.authorization, 'NONE', 'authorizes nothing');
    for (const k of ['approvalEvidence', 'promotionEvidence', 'evidenceReview', 'readiness', 'acceptancePacket'] as const) {
      assert(bundle.artifacts[k] !== undefined, `artifact ${k} present`);
    }
    for (const k of ['integrity', 'schema', 'matrix', 'handoff', 'dashboard'] as const) {
      assert(bundle.reports[k] !== undefined, `report ${k} present`);
    }
    assert(bundle.rehearsalManifest !== undefined, 'rehearsal manifest present');
    assertEq((bundle.reports.dashboard as { overall?: string }).overall, 'DASHBOARD_READY', 'dashboard READY');
    assert(/^[0-9a-f]{64}$/.test(bundle.bundleDigest), 'bundle digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('the bundle is redaction-safe (no raw path or title)', async () => {
  const root = workspace();
  try {
    const bundle = await buildFixtureEvidenceBundle({ workDir: root, runId: 'b-redact', now: makeNow() });
    assert(bundle.redactionSafe === true, 'flagged redaction-safe');
    assert(!bundle.notes.includes('RAW_PATH_IN_BUNDLE'), 'no raw-path note');
    const serialized = JSON.stringify(bundle);
    assert(!serialized.includes('/mnt/'), 'no /mnt path');
    assert(!serialized.includes('catalog-authority-test-library'), 'no test-library fragment');
    assert(!serialized.includes(root), 'no work-dir path');
    assert(!('approval' in bundle.artifacts), 'the raw approval attestation (with real paths) is not embedded; only approvalEvidence is');
    assert(bundle.artifacts.approvalEvidence !== undefined, 'the redaction-safe approval evidence is embedded');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('bundleDigest recomputes deterministically from the body', async () => {
  const root = workspace();
  try {
    const bundle = await buildFixtureEvidenceBundle({ workDir: root, runId: 'b-recompute', now: makeNow() });
    const { bundleDigest, ...body } = bundle as unknown as Record<string, unknown> & { bundleDigest: string };
    const recomputed = createHash('sha256').update(`phase-230-fixture-bundle:${JSON.stringify(body)}`).digest('hex');
    assertEq(recomputed, bundleDigest, 'recomputed bundle digest matches');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('two runs with identical fixed inputs produce an identical bundle (deterministic)', async () => {
  const root = workspace();
  try {
    const fixed = { workDir: join(root, 'fixed'), runId: 'b-det', acceptorId: 'coordinator-1' };
    const a = await buildFixtureEvidenceBundle({ ...fixed, now: makeNow() });
    const b = await buildFixtureEvidenceBundle({ ...fixed, now: makeNow() });
    assertEq(a.bundleDigest, b.bundleDigest, 'bundle digest identical across runs');
    assertEq(JSON.stringify(a), JSON.stringify(b), 'whole bundle identical across runs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI writes the bundle and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const outPath = join(root, 'catalog-authority-test-library', 'BUNDLEMARKER-out', 'bundle.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-fixture-bundle-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--work-dir', join(root, 'work'), '--run-id', 'cli-bundle', '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `BUNDLE_READY exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'bundle file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.outcome, 'BUNDLE_READY', 'stdout outcome');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('BUNDLEMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
    const bundle = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    assertEq(bundle.report, 'phase-230-promotion-fixture-evidence-bundle', 'written file is the bundle');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
