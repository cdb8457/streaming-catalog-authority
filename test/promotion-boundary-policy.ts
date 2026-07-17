import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoundaryPolicy, BOUNDARY_POLICY_RULES, BOUNDARY_HOOK_COUNT } from '../src/ops/promotion-boundary-policy.js';
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

console.log('Running Phase 230 static live-boundary policy suite:\n');

test('BOUNDARY_POLICY_ENFORCED over the live repo', () => {
  const p = buildBoundaryPolicy(projectRoot);
  assertEq(p.overall, 'BOUNDARY_POLICY_ENFORCED', `enforced (violations: ${p.violations.join(',')})`);
  assertEq(p.authorization, 'NONE', 'authorizes nothing');
  assertEq(p.ruleCount, BOUNDARY_POLICY_RULES.length, 'all rules compiled');
  assert(p.hookCount === BOUNDARY_HOOK_COUNT && p.hookCount >= 11, 'the full hook set compiled');
  assert(p.scannedSources > 0 && p.scannedDocs > 0, 'sources and docs were scanned');
  assert(p.rules.every((r) => r.ok), 'every rule holds');
  assertEq(verifySelfDigests([p]).overall, 'ALL_VERIFIED', 'report self-verifies');
  assert(/^[0-9a-f]{64}$/.test(p.policyDigest), 'policy digest present');
});

test('VIOLATED when a planted source carries a live hook', () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-policy-hook-'));
  try {
    mkdirSync(join(root, 'src', 'ops'), { recursive: true });
    // Planted in a throwaway temp fixture only -- assembled here so this test file carries no live hook.
    const hook = ['fet', 'ch('].join('');
    writeFileSync(join(root, 'src', 'ops', 'promotion-approval.ts'), `const x = '${hook}';\n`);
    const p = buildBoundaryPolicy(root);
    assertEq(p.overall, 'BOUNDARY_POLICY_VIOLATED', 'violated');
    assert(p.violations.includes('FORBIDDEN_HOOK_FOUND'), 'forbidden-hook violation');
    assert(p.violations.includes('BOUNDARY_LANGUAGE_MISSING'), 'missing-docs violation too');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('VIOLATED when a non-rehearsal tool invokes the promotion service', () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-policy-caller-'));
  try {
    mkdirSync(join(root, 'src', 'ops'), { recursive: true });
    const call = ['runRealLibrary', 'Promotion('].join('');
    writeFileSync(join(root, 'src', 'ops', 'promotion-approval.ts'), `${call});\n`);
    const p = buildBoundaryPolicy(root);
    assert(p.violations.includes('UNSANDBOXED_PROMOTION_CALL'), 'unsandboxed-caller violation');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('VIOLATED (docs) on an empty root, and redaction-safe', () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-policy-empty-'));
  try {
    const p = buildBoundaryPolicy(root);
    assertEq(p.overall, 'BOUNDARY_POLICY_VIOLATED', 'violated');
    assert(p.violations.includes('BOUNDARY_LANGUAGE_MISSING'), 'docs violation');
    assert(!p.violations.includes('FORBIDDEN_HOOK_FOUND'), 'no hooks in empty sources');
    assert(p.redactionSafe === true && !JSON.stringify(p).includes('/mnt/'), 'redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI compiles the policy and never echoes raw paths to stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-policy-'));
  try {
    const outPath = join(dir, 'catalog-authority-test-library', 'BPMARKER-out', 'policy.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-boundary-policy-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `ENFORCED exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'policy file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'BOUNDARY_POLICY_ENFORCED', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('BPMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
