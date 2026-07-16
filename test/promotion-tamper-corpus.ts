import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTamperCorpus, runTamperEntry, verifyTamperCorpus } from '../src/ops/promotion-tamper-corpus.js';
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

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-tamper-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 16, 16, 0, i++)); }
async function bundle(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'tamper', now: makeNow() }))) as Record<string, unknown>;
}

const EXPECTED_KINDS = [
  'missing-artifact', 'wrong-report', 'bundle-self-digest', 'matrix-self-digest',
  'manifest-stage', 'schema-failed-state', 'dashboard-blocked',
];

console.log('Running Phase 230 tamper corpus suite:\n');

await test('the corpus covers every tamper kind and each produces its expected generic failure', async () => {
  const root = workspace();
  try {
    const corpus = verifyTamperCorpus(await bundle(root));
    assert(corpus.ok, `all detected (misses: ${corpus.entries.filter((e) => !e.matched).map((e) => e.kind).join(',')})`);
    const kinds = corpus.entries.map((e) => e.kind).sort();
    assertEq(JSON.stringify(kinds), JSON.stringify([...EXPECTED_KINDS].sort()), 'covers every kind');
    assert(corpus.entries.every((e) => e.matched), 'every tamper detected');
    assert(/^[0-9a-f]{64}$/.test(corpus.corpusDigest), 'corpus digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('each generated entry, run individually, matches its expected code', async () => {
  const root = workspace();
  try {
    const entries = generateTamperCorpus(await bundle(root));
    assertEq(entries.length, EXPECTED_KINDS.length, 'one entry per kind');
    for (const entry of entries) {
      const result = runTamperEntry(entry);
      assert(result.matched, `${entry.kind} -> ${entry.expectedCode} not detected`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('the corpus report is redaction-safe', async () => {
  const root = workspace();
  try {
    const corpus = verifyTamperCorpus(await bundle(root));
    assert(corpus.redactionSafe === true, 'flagged redaction-safe');
    const serialized = JSON.stringify(corpus);
    assert(!serialized.includes('/mnt/') && !serialized.includes('catalog-authority-test-library') && !serialized.includes(root), 'no path fragments');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI verifies the corpus and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const b = await bundle(root);
    const dir = join(root, 'artifacts');
    mkdirSync(dir, { recursive: true });
    const bundlePath = join(dir, 'bundle.json');
    writeFileSync(bundlePath, JSON.stringify(b));
    const outPath = join(root, 'catalog-authority-test-library', 'CORPUSMARKER-out', 'corpus.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-tamper-corpus-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--bundle', bundlePath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `all detected exit 0 (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'corpus file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.ok, true, 'stdout ok');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('CORPUSMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
