import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNegativeEvidenceCorpus, NEGATIVE_SAMPLE_COUNT } from '../src/ops/promotion-negative-evidence-corpus.js';
import { verifyCliContract } from '../src/ops/promotion-cli-contract.js';
import { verifySelfDigests } from '../src/ops/promotion-self-digest-verifier.js';
import { buildBlockerTaxonomy } from '../src/ops/promotion-blocker-taxonomy.js';

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

console.log('Running Phase 230 negative-evidence adversarial corpus suite:\n');

test('CORPUS_HELD: every adversarial sample is rejected by its validator', () => {
  const c = buildNegativeEvidenceCorpus();
  assertEq(c.overall, 'CORPUS_HELD', `held (breaches: ${c.breaches.join(',')})`);
  assertEq(c.authorization, 'NONE', 'authorizes nothing');
  assert(c.count >= 15 && c.count === NEGATIVE_SAMPLE_COUNT, 'a substantial sample set');
  assert(c.samples.every((s) => s.rejected), 'every sample rejected');
  assert(Object.keys(c.categories).length >= 6, 'several adversarial categories');
  const ids = new Set(c.samples.map((s) => s.sample));
  assert(ids.has('release-checklist-commit-binding-mismatch') && ids.has('merge-readiness-final-summary-unbound'), 'covers release-checklist + merge-readiness binding blockers');
  assert(ids.has('archive-evidence-ledger-mismatch') && ids.has('review-bundle-archive-component-mismatch') && ids.has('matrix-review-archive-mismatch'), 'covers stale/mismatch green-looking artifacts');
  assert(ids.has('release-checklist-digestless-required') && ids.has('merge-readiness-checklist-bindings-incomplete'), 'covers digestless required binding evidence');
  // BA scope: green-looking AP-AZ artifacts fail closed across every dimension.
  assert(ids.has('report-schema-forged-self-digest'), 'covers wrong-but-valid self-digest');            // forged digest
  assert(ids.has('report-schema-malformed-digest'), 'covers missing/malformed digest');                 // missing digest
  assert(ids.has('report-schema-wrong-report-id'), 'covers wrong report id');                           // wrong report id
  assert(ids.has('readiness-not-ready-where-green-required'), 'covers not-ready-where-green-required');  // not-ready status
  assert(ids.has('readiness-missing-component-digest'), 'covers missing component digest');
  assert(ids.has('release-checklist-commit-binding-mismatch') && ids.has('merge-readiness-final-summary-unbound'), 'covers wrong binding'); // wrong binding
  assert(ids.has('cli-capture-redaction-leak'), 'covers payload/path leak');                            // payload/path leak
  // BS scope: forged-but-green components fail closed on a real recompute across terminal/pack/aggregators.
  assert(ids.has('terminal-closure-forged-green-component'), 'covers forged-green terminal component');
  assert(ids.has('reviewer-pack-forged-green-component'), 'covers forged-green pack component');
  assert(ids.has('pack-integrity-forged-green-component') && ids.has('pack-integrity-forged-pack-digest'), 'covers forged-green pack-integrity + forged pack digest');
  assert(ids.has('chain-bundle-forged-green-component') && ids.has('readiness-forged-green-component'), 'covers forged-green aggregator components');
  assert((c.categories['forged-green-component'] ?? 0) >= 6, 'a substantial forged-green-component set');
  assert(/^[0-9a-f]{64}$/.test(c.corpusDigest), 'corpus digest present');
});

test('the rejection predicates are discriminating (genuinely-green inputs are NOT rejected)', () => {
  // If these validators accepted the adversarial inputs, they would also (wrongly) never accept anything.
  assert(verifyCliContract({ report: 'phase-230-promotion-thing-capture', redactionSafe: true, thingDigest: 'a'.repeat(64) }).ok, 'a clean capture is accepted');
  assertEq(verifySelfDigests([buildBlockerTaxonomy()]).overall, 'ALL_VERIFIED', 'a real report self-verifies');
});

test('the corpus report is itself self-digest verifiable and redaction-safe', () => {
  const c = buildNegativeEvidenceCorpus();
  assertEq(verifySelfDigests([c]).overall, 'ALL_VERIFIED', 'corpus report is registered + self-consistent');
  const json = JSON.stringify(c);
  assert(!json.includes('/mnt/') && !json.includes('.mkv') && !json.includes('not-a-sha'), 'no payload fragments leak into the report');
});

await test('CLI runs the corpus and never echoes raw paths to stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-negcorpus-'));
  try {
    const outPath = join(dir, 'catalog-authority-test-library', 'NEGMARKER-out', 'corpus.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-negative-evidence-corpus-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `CORPUS_HELD exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'corpus file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'CORPUS_HELD', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('NEGMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
