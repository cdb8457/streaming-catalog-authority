import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRedactionCorpus, REDACTION_LEAK_COUNT, REDACTION_SAFE_COUNT, REDACTION_DETECTOR_COUNT } from '../src/ops/promotion-redaction-corpus.js';
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

console.log('Running Phase 230 redaction regression corpus suite:\n');

test('REDACTION_CORPUS_HELD: every leak payload flagged by every detector, no safe value flagged', () => {
  const c = buildRedactionCorpus();
  assertEq(c.overall, 'REDACTION_CORPUS_HELD', `held (breaches: ${c.breaches.join(',')})`);
  assertEq(c.authorization, 'NONE', 'authorizes nothing');
  assert(c.leakCount >= 8 && c.leakCount === REDACTION_LEAK_COUNT, 'a substantial leak set');
  assert(c.safeCount >= 5 && c.safeCount === REDACTION_SAFE_COUNT, 'a safe set proving discrimination');
  assert(c.detectorCount >= 4 && c.detectorCount === REDACTION_DETECTOR_COUNT, 'multiple detectors exercised');
  assert(c.leaks.every((l) => l.detected && l.detectedBy === c.detectorCount), 'every leak flagged by every detector');
  assert(c.safe.every((s) => s.clean && s.flaggedBy === 0), 'no safe value flagged by any detector');
  assert(Object.keys(c.categories).length >= 4, 'several leak categories');
  assert(/^[0-9a-f]{64}$/.test(c.redactionDigest), 'redaction digest present');
});

test('the corpus report never echoes a payload and is self-digest verifiable', () => {
  const c = buildRedactionCorpus();
  const json = JSON.stringify(c);
  assert(!json.includes('/mnt/') && !json.includes('.mkv') && !json.includes('.mp4') && !json.includes('.m4v'), 'no payload fragments in the report');
  assert(!json.includes('catalog-authority-test-library'), 'no fixture marker in the report');
  assertEq(verifySelfDigests([c]).overall, 'ALL_VERIFIED', 'corpus report is registered + self-consistent');
});

test('leak coverage spans path, live-library, media-title, and fixture-marker categories', () => {
  const c = buildRedactionCorpus();
  const cats = new Set(c.leaks.map((l) => l.category));
  assert(cats.has('absolute-path') && cats.has('live-library-path') && cats.has('media-title') && cats.has('fixture-marker'), 'all leak categories present');
  const ids = new Set(c.leaks.map((l) => l.sample));
  assert(ids.has('mnt-movies-media-path') && ids.has('windows-drive-path') && ids.has('uppercase-media-filename'), 'key regression samples present');
});

await test('CLI runs the corpus and never echoes payloads to stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-redaction-'));
  try {
    const outPath = join(dir, 'catalog-authority-test-library', 'RDMARKER-out', 'corpus.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-redaction-corpus-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `HELD exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'corpus file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'REDACTION_CORPUS_HELD', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('RDMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/') && !(res.stdout ?? '').includes('.mkv'), 'no payload/path fragments in stdout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
