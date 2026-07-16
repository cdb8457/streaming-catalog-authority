import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffFixtureBundles } from '../src/ops/promotion-bundle-diff.js';
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

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-diff-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 16, 15, 0, i++)); }
async function bundle(root: string, runId: string): Promise<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: join(root, runId), runId, now: makeNow() }))) as Record<string, unknown>;
}

console.log('Running Phase 230 bundle diff suite:\n');

await test('two identical-input bundles diff as identical', async () => {
  const root = workspace();
  try {
    const a = await bundle(root, 'same');
    const b = await bundle(root, 'same');
    const diff = diffFixtureBundles(a, b);
    assert(diff.identical, `identical (differ: ${diff.differingComponents.join(',')})`);
    assert(diff.aValid && diff.bValid, 'both valid');
    assertEq(diff.differingComponents.length, 0, 'no differing components');
    assert(diff.components.every((c) => c.equal), 'all components equal');
    assert(/^[0-9a-f]{64}$/.test(diff.diffDigest), 'diff digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('two different-input bundles differ across components', async () => {
  const root = workspace();
  try {
    const a = await bundle(root, 'alpha');
    const b = await bundle(root, 'beta');
    const diff = diffFixtureBundles(a, b);
    assert(!diff.identical, 'not identical');
    assert(diff.differingComponents.includes('bundle'), 'bundle component differs');
    assert(diff.differingComponents.includes('promotionEvidence'), 'promotion component differs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('pinpoints a single tampered component', async () => {
  const root = workspace();
  try {
    const a = await bundle(root, 'base');
    const b = JSON.parse(JSON.stringify(a)) as Record<string, unknown>;
    (b.artifacts as { promotionEvidence: Record<string, unknown> }).promotionEvidence.evidenceDigest = '0'.repeat(64);
    const diff = diffFixtureBundles(a, b);
    assert(!diff.identical, 'not identical');
    assert(diff.differingComponents.includes('promotionEvidence'), 'promotion component flagged');
    // the untouched bundle-level and other components remain equal
    assert(diff.components.find((c) => c.component === 'integrity')!.equal, 'integrity unchanged');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('is redaction-safe and handles an invalid bundle without throwing', async () => {
  const root = workspace();
  try {
    const a = await bundle(root, 'valid');
    const diff = diffFixtureBundles(a, { report: 'not-a-bundle' });
    assert(!diff.identical, 'not identical vs invalid');
    assert(diff.aValid && !diff.bValid, 'a valid, b invalid');
    assert(diff.redactionSafe === true && !JSON.stringify(diff).includes('/mnt/'), 'redaction-safe, no paths');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI diffs two bundles and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const a = await bundle(root, 'clia');
    const b = await bundle(root, 'clib');
    const dir = join(root, 'artifacts');
    mkdirSync(dir, { recursive: true });
    const aPath = join(dir, 'a.json');
    const bPath = join(dir, 'b.json');
    writeFileSync(aPath, JSON.stringify(a));
    writeFileSync(bPath, JSON.stringify(b));
    const outPath = join(root, 'catalog-authority-test-library', 'DIFFMARKER-out', 'diff.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-bundle-diff-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--a', aPath, '--b', bPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 1, `differ exit 1 (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'diff file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.identical, false, 'stdout identical false');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('DIFFMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
