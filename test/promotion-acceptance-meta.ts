import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAcceptanceMetaCheck, LOCAL_OPS_REGISTRY } from '../src/ops/promotion-acceptance-meta.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

const root = fileURLToPath(new URL('..', import.meta.url));

console.log('Running Phase 230 acceptance meta-check suite:\n');

await test('every local op is complete (module, cli, test, doc, scripts, gate, boundary)', () => {
  const meta = buildAcceptanceMetaCheck(root);
  assert(meta.ok, `all complete (incomplete: ${meta.incomplete.join(',')})`);
  assertEq(meta.ops.length, LOCAL_OPS_REGISTRY.length, 'one entry per registered op');
  assert(meta.ops.every((o) => o.hasModule && o.hasCli && o.hasTest && o.hasDoc && o.hasScripts && o.inGate && o.hasBoundary), 'every facet present');
  assert(/^[0-9a-f]{64}$/.test(meta.metaDigest), 'meta digest present');
});

await test('reports a gap for an unregistered/absent op against a bare project root', () => {
  const empty = mkdtempSync(join(tmpdir(), 'catalog-meta-'));
  try {
    const meta = buildAcceptanceMetaCheck(empty); // no files -> every op incomplete
    assert(!meta.ok, 'not ok against an empty root');
    assertEq(meta.incomplete.length, meta.ops.length, 'all incomplete');
    assert(meta.ops.every((o) => !o.hasModule && !o.inGate), 'facets absent');
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

await test('the meta report is redaction-safe', () => {
  const meta = buildAcceptanceMetaCheck(root);
  assert(meta.redactionSafe === true && !JSON.stringify(meta).includes('/mnt/'), 'redaction-safe, no paths');
});

await test('CLI runs the meta-check and never echoes raw paths to stdout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-meta-cli-'));
  try {
    const outPath = join(dir, 'catalog-authority-test-library', 'METAMARKER-out', 'meta.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-acceptance-meta-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--out', outPath], { cwd: root, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `all complete exit 0 (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'meta file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.ok, true, 'stdout ok');
    assert(!(res.stdout ?? '').includes('METAMARKER') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
