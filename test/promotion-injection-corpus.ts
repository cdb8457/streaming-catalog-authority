import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INJECTION_PAYLOADS, verifyInjectionCorpus } from '../src/ops/promotion-injection-corpus.js';
import { buildFixtureEvidenceBundle } from '../src/ops/promotion-fixture-bundle.js';
import { LOCAL_OPS_REGISTRY } from '../src/ops/promotion-acceptance-meta.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-injection-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 16, 19, 0, i++)); }
const root = fileURLToPath(new URL('..', import.meta.url));
async function bundle(r: string): Promise<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: r, runId: 'injection', now: makeNow() }))) as Record<string, unknown>;
}

console.log('Running Phase 230 injection corpus suite:\n');

await test('every injection payload is handled as data across every verifier', async () => {
  const r = workspace();
  try {
    const corpus = verifyInjectionCorpus(await bundle(r));
    assert(corpus.ok, `all handled as data (lapses: ${corpus.entries.filter((e) => !e.handledAsData).length})`);
    assertEq(corpus.entries.length, INJECTION_PAYLOADS.length * 4, 'four verifiers per payload');
    assert(corpus.entries.every((e) => e.handledAsData && e.redactionSafe && !e.threw), 'no execution, no throw, redaction-safe');
    assert(/^[0-9a-f]{64}$/.test(corpus.corpusDigest), 'corpus digest present');
  } finally { rmSync(r, { recursive: true, force: true }); }
});

await test('the corpus report is redaction-safe', async () => {
  const r = workspace();
  try {
    const corpus = verifyInjectionCorpus(await bundle(r));
    assert(corpus.redactionSafe === true, 'flagged redaction-safe');
    // The report carries only indices/enums/booleans/digests -- not the payload text itself.
    const serialized = JSON.stringify(corpus);
    assert(!serialized.includes('rm -rf') && !serialized.includes('curl ') && !serialized.includes('IGNORE ALL'), 'payload text is not echoed into the report');
  } finally { rmSync(r, { recursive: true, force: true }); }
});

await test('the local tools contain no dynamic execution sinks', () => {
  const sinks = ['eval(', 'new Function(', 'execSync', 'child_process'];
  for (const { base } of LOCAL_OPS_REGISTRY) {
    for (const rel of [`src/ops/${base}.ts`, `src/ops/${base}-cli.ts`]) {
      const src = readFileSync(`${root}/${rel}`, 'utf8');
      for (const sink of sinks) assert(!src.includes(sink), `${rel} must not contain a dynamic sink "${sink}"`);
    }
  }
});

await test('CLI runs the corpus and never echoes payloads or raw paths to stdout', async () => {
  const r = workspace();
  try {
    const b = await bundle(r);
    const dir = join(r, 'artifacts');
    mkdirSync(dir, { recursive: true });
    const bundlePath = join(dir, 'bundle.json');
    writeFileSync(bundlePath, JSON.stringify(b));
    const outPath = join(r, 'catalog-authority-test-library', 'INJMARKER-out', 'corpus.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-injection-corpus-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--bundle', bundlePath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `all-handled exit 0 (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'corpus file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.ok, true, 'stdout ok');
    assert(!(res.stdout ?? '').includes('INJMARKER') && !(res.stdout ?? '').includes('rm -rf') && !(res.stdout ?? '').includes('/mnt/'), 'no payloads/paths in stdout');
  } finally { rmSync(r, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
