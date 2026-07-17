import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoundaryAudit } from '../src/ops/promotion-boundary-audit.js';
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

console.log('Running Phase 230 final boundary audit suite:\n');

test('BOUNDARY_AUDIT_CLEAN over the live repo', () => {
  const a = buildBoundaryAudit(projectRoot);
  assertEq(a.overall, 'BOUNDARY_AUDIT_CLEAN', `clean (violations: ${a.violations.join(',')})`);
  assertEq(a.authorization, 'NONE', 'authorizes nothing');
  assertEq(a.ruleCount, 5, 'all five audit rules evaluated');
  assert(a.rules.every((r) => r.ok), 'every rule holds');
  assert(a.scannedSources > 80 && a.scannedDocs === 3, 'sources + index docs scanned');
  assertEq(verifySelfDigests([a]).overall, 'ALL_VERIFIED', 'report self-verifies');
  assert(/^[0-9a-f]{64}$/.test(a.auditDigest), 'audit digest present');
});

test('FAILED when a planted op source carries a network endpoint', () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-audit-url-'));
  try {
    mkdirSync(join(root, 'src', 'ops'), { recursive: true });
    const url = ['https', '://'].join('') + 'example.invalid/scan';
    writeFileSync(join(root, 'src', 'ops', 'promotion-approval.ts'), `const endpoint = '${url}';\n`);
    const a = buildBoundaryAudit(root);
    assertEq(a.overall, 'BOUNDARY_AUDIT_FAILED', 'failed');
    assert(a.violations.includes('AUDIT_NETWORK_URL_FOUND'), 'network-url violation');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('FAILED when a planted op source reads the environment', () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-audit-env-'));
  try {
    mkdirSync(join(root, 'src', 'ops'), { recursive: true });
    const env = ['process.', 'env'].join('');
    writeFileSync(join(root, 'src', 'ops', 'promotion-approval.ts'), `const v = ${env}.SOMETHING;\n`);
    const a = buildBoundaryAudit(root);
    assert(a.violations.includes('AUDIT_ENV_READ_FOUND'), 'env-read violation');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('FAILED on an empty root (no gate, doc drift) and redaction-safe', () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-audit-empty-'));
  try {
    const a = buildBoundaryAudit(root);
    assertEq(a.overall, 'BOUNDARY_AUDIT_FAILED', 'failed');
    assert(a.violations.includes('AUDIT_NON_LOCAL_SUITE'), 'absent gate fails closed');
    assert(a.violations.includes('AUDIT_DOC_DRIFT'), 'missing index docs fail closed');
    assert(a.violations.includes('AUDIT_POLICY_VIOLATED'), 'policy violation surfaces');
    assert(a.redactionSafe === true && !JSON.stringify(a).includes('/mnt/'), 'redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI audits the boundary and never echoes raw paths to stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-audit-cli-'));
  try {
    const outPath = join(dir, 'catalog-authority-test-library', 'BAMARKER-out', 'audit.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-boundary-audit-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `CLEAN exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'audit file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'BOUNDARY_AUDIT_CLEAN', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('BAMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
