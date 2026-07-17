import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifactExportManifest } from '../src/ops/promotion-artifact-export-manifest.js';
import { LOCAL_OPS_REGISTRY } from '../src/ops/promotion-acceptance-meta.js';
import { verifySelfDigests } from '../src/ops/promotion-self-digest-verifier.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

console.log('Running Phase 230 artifact export manifest suite:\n');

test('COMPLETE: every registered artifact is registered, generatable, exportable, and redaction-safe', () => {
  const m = buildArtifactExportManifest(projectRoot);
  assertEq(m.overall, 'ARTIFACT_EXPORT_MANIFEST_COMPLETE', `complete (gaps: ${m.gaps.join(',')})`);
  assertEq(m.authorization, 'NONE', 'authorizes nothing');
  assertEq(m.artifactCount, LOCAL_OPS_REGISTRY.length, 'one entry per registered op');
  assert(m.artifactCount >= 40, `a substantial artifact set (got ${m.artifactCount})`);
  assertEq(m.exportableCount, m.artifactCount, 'every artifact is fully exportable');
  assert(m.artifacts.every((a) => a.registered && a.generatable && a.exportsToFile && a.cliRedactionSafe), 'every artifact registered/generatable/exportable/redaction-safe');
  assert(m.artifacts.every((a) => a.generateScript.startsWith('ops:') && a.testScript.startsWith('test:')), 'generate/test scripts named');
  assertEq(verifySelfDigests([m]).overall, 'ALL_VERIFIED', 'manifest self-verifies');
  assert(!JSON.stringify(m).includes('/mnt/') && !JSON.stringify(m).includes(':\\'), 'redaction-safe');
});

test('the manifest binds known artifacts to their produced report ids (and includes itself)', () => {
  const m = buildArtifactExportManifest(projectRoot);
  const byName = new Map(m.artifacts.map((a) => [a.artifact, a]));
  const expect: Array<[string, string]> = [
    ['terminal-closure', 'phase-230-promotion-terminal-closure-manifest'],
    ['pack-component-integrity', 'phase-230-promotion-pack-component-integrity'],
    ['aggregator-digest-audit', 'phase-230-promotion-aggregator-digest-audit'],
    ['artifact-export-manifest', 'phase-230-promotion-artifact-export-manifest'],
  ];
  for (const [name, id] of expect) {
    const entry = byName.get(name);
    assert(entry !== undefined, `artifact ${name} present`);
    assertEq(entry!.reportId, id, `artifact ${name} report id`);
    assert(entry!.exportsToFile && entry!.registered, `artifact ${name} exportable + registered`);
  }
});

test('INCOMPLETE and fails closed when artifacts are not generatable from the given root', () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), 'catalog-export-empty-'));
  try {
    const m = buildArtifactExportManifest(emptyRoot);
    assertEq(m.overall, 'ARTIFACT_EXPORT_MANIFEST_INCOMPLETE', 'incomplete against an empty root');
    assert(m.gaps.includes('ARTIFACT_REPORT_UNREGISTERED'), 'unregistered gap');
    assert(m.gaps.includes('ARTIFACT_NOT_GENERATABLE'), 'not-generatable gap');
    assert(m.gaps.includes('ARTIFACT_EXPORT_UNSUPPORTED'), 'export-unsupported gap');
    assert(m.gaps.includes('ARTIFACT_CLI_NONCONFORMANT'), 'cli-nonconformant gap');
    assertEq(m.exportableCount, 0, 'nothing exportable from an empty root');
    assert(!JSON.stringify(m).includes(emptyRoot), 'the scanned root is not echoed');
  } finally { rmSync(emptyRoot, { recursive: true, force: true }); }
});

test('CLI emits the manifest and never echoes raw paths to stdout', () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-export-'));
  try {
    const outPath = join(root, 'catalog-authority-test-library', 'EXPMARKER-out', 'export.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-artifact-export-manifest-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `COMPLETE exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'manifest file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'ARTIFACT_EXPORT_MANIFEST_COMPLETE', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('EXPMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
