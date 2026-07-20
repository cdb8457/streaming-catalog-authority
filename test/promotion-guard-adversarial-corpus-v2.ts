import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGuardAdversarialCorpusV2, GUARD_ADVERSARIAL_SAMPLE_COUNT } from '../src/ops/promotion-guard-adversarial-corpus-v2.js';
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

console.log('Running Phase 230 shared adversarial guard corpus v2 suite:\n');

test('GUARD_CORPUS_V2_HELD: every adversarial sample blocks and every safe sample stays clean', () => {
  const c = buildGuardAdversarialCorpusV2(projectRoot);
  assertEq(c.overall, 'GUARD_CORPUS_V2_HELD', `held (breaches: ${c.breaches.join(',')})`);
  assertEq(c.authorization, 'NONE', 'authorizes nothing');
  assert(c.count >= 15 && c.count === GUARD_ADVERSARIAL_SAMPLE_COUNT, 'a substantial sample set');
  assert(c.samples.every((s) => s.held), 'every sample held');
  const ids = new Set(c.samples.map((s) => s.sample));
  assert(ids.has('nested-hard-authorization-claim') && ids.has('whitespace-affixed-claim-field') && ids.has('camelcase-claim-field') && ids.has('object-key-claim'), 'covers nested/ws/camel/object-key claim variants');
  assert(ids.has('phase-231-token') && ids.has('forged-approval-status-flag'), 'covers phase-231 tokens + forged approval statuses');
  assert(ids.has('live-surface-url-in-plan') && ids.has('raw-media-path-in-plan') && ids.has('symlink-containment-target-in-plan'), 'covers live surface / raw path / symlink-containment');
  assert(ids.has('redaction-sensitive-failure-evidence'), 'covers redaction-sensitive failure evidence');
  assert(ids.has('checklist-forged-closure-summary') && ids.has('acceptance-trace-forged-approval') && ids.has('acceptance-trace-component-claims-live'), 'covers checklist + acceptance-trace guards');
  assert(ids.has('safe-clean-artifacts') && ids.has('safe-valid-preflight-plan') && ids.has('safe-pending-gate-lists-tokens'), 'covers safe (no-false-positive) cases');
});

test('the corpus exercises every launch-proofing guard', () => {
  const c = buildGuardAdversarialCorpusV2(projectRoot);
  for (const guard of ['no-live-authorization-guard', 'live-preflight-plan', 'approval-request-packet', 'review-checklist-v2', 'operator-acceptance-trace']) {
    assert(c.guardsCovered.includes(guard), `covers ${guard}`);
  }
});

test('the corpus report is itself self-digest verifiable and redaction-safe', () => {
  const c = buildGuardAdversarialCorpusV2(projectRoot);
  assertEq(verifySelfDigests([c]).overall, 'ALL_VERIFIED', 'corpus report self-verifies');
  const json = JSON.stringify(c);
  assert(!json.includes('/mnt/') && !json.includes('.mkv'), 'no payload fragments leak into the report');
});

await test('CLI runs the corpus and never echoes raw paths to stdout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-guardcorpus-'));
  try {
    const outPath = join(dir, 'catalog-authority-test-library', 'GCMARKER-out', 'corpus.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-guard-adversarial-corpus-v2-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `HELD exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'corpus file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'GUARD_CORPUS_V2_HELD', 'stdout overall');
    assert(!(res.stdout ?? '').includes('GCMARKER') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
