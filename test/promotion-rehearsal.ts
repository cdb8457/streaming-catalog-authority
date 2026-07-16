import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPromotionRehearsal, type RehearsalScenario } from '../src/ops/promotion-rehearsal.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }
async function assertRejects(fn: () => Promise<unknown>, matcher: string, msg: string): Promise<void> {
  try { await fn(); } catch (e) { if (!String((e as Error).message).includes(matcher)) throw new Error(`${msg}: wrong error "${(e as Error).message}"`); return; }
  throw new Error(`${msg}: did not reject`);
}

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-rehearsal-')); }
const fixedNow = (() => { let i = 0; return () => new Date(Date.UTC(2026, 6, 15, 8, 0, i++)); })();
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 15, 9, 0, i++)); }

function stage(manifest: Awaited<ReturnType<typeof runPromotionRehearsal>>['manifest'], id: string) {
  const s = manifest.stages.find((x) => x.stage === id);
  assert(s !== undefined, `manifest has stage ${id}`);
  return s!;
}

console.log('Running Phase 230 promotion rehearsal suite:\n');

await test('runs the full fixture pipeline end-to-end and passes', async () => {
  const root = workspace();
  try {
    const { manifest, artifacts } = await runPromotionRehearsal({ workDir: root, runId: 'run-pass', itemId: '11111111-1111-4111-8111-111111111111', now: fixedNow });
    assertEq(manifest.outcome, 'REHEARSAL_PASS', `pass (notes: ${manifest.notes.join(',')})`);
    assertEq(manifest.scenario, 'success', 'records success scenario');
    assertEq(manifest.notes.length, 0, 'no blocker notes on success');
    assertEq(manifest.stages.length, 5, 'five stages');
    assert(manifest.stages.every((s) => s.ok), 'all stages ok');
    assertEq(stage(manifest, 'APPROVAL').status, 'APPROVAL_ATTESTATION_READY', 'approval ready');
    assertEq(stage(manifest, 'PROMOTION').status, 'REAL_LIBRARY_PROMOTION_WITHDRAWN', 'promotion withdrawn (clean)');
    assertEq(stage(manifest, 'EVIDENCE_REVIEW').status, 'PROMOTION_EVIDENCE_ACCEPTED', 'evidence accepted');
    assertEq(stage(manifest, 'READINESS').status, 'READY', 'readiness ready');
    assertEq(stage(manifest, 'ACCEPTANCE_SEAL').status, 'ACCEPTED_SEALED', 'acceptance sealed');
    assert(manifest.stages.every((s) => /^[0-9a-f]{64}$/.test(s.digest ?? '')), 'every stage carries a digest');
    assert(/^[0-9a-f]{64}$/.test(manifest.manifestDigest), 'manifest digest present');
    for (const k of ['approval', 'approvalEvidence', 'promotionEvidence', 'evidenceReview', 'readiness', 'acceptancePacket'] as const) {
      assert(artifacts[k] !== undefined, `artifact ${k} returned`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('the sandbox is ephemeral and removed after the run', async () => {
  const root = workspace();
  try {
    await runPromotionRehearsal({ workDir: root, runId: 'run-ephemeral', now: fixedNow });
    assert(!existsSync(join(root, 'phase-230-rehearsal-run-ephemeral')), 'sandbox removed by default');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('keep-sandbox leaves a clean Movies tree (promoted file withdrawn)', async () => {
  const root = workspace();
  try {
    const { manifest } = await runPromotionRehearsal({ workDir: root, runId: 'run-keep', keepSandbox: true, now: fixedNow });
    assertEq(manifest.outcome, 'REHEARSAL_PASS', 'passes');
    const sandbox = join(root, 'phase-230-rehearsal-run-keep');
    assert(existsSync(sandbox), 'sandbox kept');
    const movies = join(sandbox, 'Movies');
    // Promote+withdraw returns the Movies tree to empty (the run created and then removed its file/dir).
    const remaining = existsSync(movies) ? readdirSync(movies) : [];
    assertEq(remaining.length, 0, 'no promoted residue left in sandbox Movies');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('the manifest is redaction-safe (no raw path or title)', async () => {
  const root = workspace();
  try {
    const { manifest } = await runPromotionRehearsal({ workDir: root, runId: 'run-redact', title: 'Secret Rehearsal Title', now: fixedNow });
    const serialized = JSON.stringify(manifest);
    assert(manifest.redactionSafe === true, 'flagged redaction-safe');
    assert(!manifest.notes.includes('RAW_PATH_IN_MANIFEST'), 'no raw-path note');
    assert(!serialized.includes('Secret Rehearsal Title'), 'no raw title');
    assert(!serialized.includes('/mnt/'), 'no /mnt path');
    assert(!serialized.includes('catalog-authority-test-library'), 'no test-library fragment');
    assert(!serialized.includes(root), 'no sandbox work-dir path');
    assert(manifest.forbidden.includes('live-jellyfin') && manifest.forbidden.includes('real-movies-write'), 'boundary forbidden list present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('refuses a work-dir that intersects the real Movies root', async () => {
  await assertRejects(() => runPromotionRehearsal({ workDir: '/mnt/user/media/Movies', runId: 'x' }), 'must not intersect the real Movies root', 'real Movies work-dir refused');
});

const FAILURE_CASES: Array<{ scenario: RehearsalScenario; stage: string; status: string; note: string }> = [
  { scenario: 'visibility-timeout', stage: 'PROMOTION', status: 'REAL_LIBRARY_PROMOTION_FAILED', note: 'PROMOTION_NOT_CLEAN' },
  { scenario: 'rejected-acceptance', stage: 'ACCEPTANCE_SEAL', status: 'ACCEPTANCE_REFUSED', note: 'ACCEPTANCE_NOT_SEALED' },
  { scenario: 'tampered-readiness', stage: 'ACCEPTANCE_SEAL', status: 'ACCEPTANCE_REFUSED', note: 'ACCEPTANCE_NOT_SEALED' },
  { scenario: 'digest-chain-mismatch', stage: 'READINESS', status: 'BLOCKED', note: 'READINESS_NOT_READY' },
];

for (const c of FAILURE_CASES) {
  await test(`scenario ${c.scenario} yields REHEARSAL_FAIL with a generic blocker`, async () => {
    const root = workspace();
    try {
      const { manifest } = await runPromotionRehearsal({ workDir: root, runId: `run-${c.scenario}`, scenario: c.scenario, now: fixedNow });
      assertEq(manifest.outcome, 'REHEARSAL_FAIL', `fails (notes: ${manifest.notes.join(',')})`);
      assertEq(manifest.scenario, c.scenario, 'records the scenario');
      assertEq(manifest.stages.length, 5, 'still records all five stages');
      const s = stage(manifest, c.stage);
      assertEq(s.ok, false, `${c.stage} not ok`);
      assertEq(s.status, c.status, `${c.stage} status is a generic enum`);
      assert(manifest.notes.includes(c.note), `generic blocker note ${c.note}`);
      // notes/statuses stay generic — no raw path or title leaks even on failure.
      const serialized = JSON.stringify(manifest);
      assert(!serialized.includes('/mnt/') && !serialized.includes('catalog-authority-test-library') && !serialized.includes(root), 'no raw path in a failed manifest');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

await test('manifestDigest recomputes deterministically from the manifest body', async () => {
  const root = workspace();
  try {
    const { manifest } = await runPromotionRehearsal({ workDir: root, runId: 'run-recompute', itemId: '22222222-2222-4222-8222-222222222222', now: makeNow() });
    const { manifestDigest, ...body } = manifest as unknown as Record<string, unknown> & { manifestDigest: string };
    const recomputed = createHash('sha256').update(`phase-230-rehearsal-manifest:${JSON.stringify(body)}`).digest('hex');
    assertEq(recomputed, manifestDigest, 'recomputed manifest digest matches the sealed value');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('two runs with identical fixed inputs produce an identical manifest (deterministic)', async () => {
  const root = workspace();
  try {
    const fixed = { workDir: join(root, 'fixed'), runId: 'run-det', itemId: '33333333-3333-4333-8333-333333333333', title: 'Deterministic Fixture', year: 2026, acceptorId: 'coordinator-1', scenario: 'success' as RehearsalScenario };
    const a = await runPromotionRehearsal({ ...fixed, now: makeNow() });
    const b = await runPromotionRehearsal({ ...fixed, now: makeNow() });
    assertEq(a.manifest.outcome, 'REHEARSAL_PASS', 'first run passes');
    assertEq(a.manifest.manifestDigest, b.manifest.manifestDigest, 'manifest digest is identical across runs');
    assertEq(JSON.stringify(a.manifest), JSON.stringify(b.manifest), 'whole manifest is identical across runs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI rejects an unknown --scenario', () => {
  const cliPath = fileURLToPath(new URL('../src/ops/promotion-rehearsal-cli.ts', import.meta.url));
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--scenario', 'not-a-scenario'], { cwd: projectRoot, encoding: 'utf8' });
  assertEq(res.status, 2, `usage exit (stderr: ${res.stderr ?? ''})`);
  assert((res.stderr ?? '').includes('invalid --scenario'), 'reports invalid scenario');
});

await test('CLI runs a failing scenario, exits 1, and reports it redaction-safely', async () => {
  const root = workspace();
  try {
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-rehearsal-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--scenario', 'rejected-acceptance', '--work-dir', join(root, 'work'), '--run-id', 'cli-fail'], { cwd: projectRoot, encoding: 'utf8' });
    assertEq(res.status, 1, `REHEARSAL_FAIL exit (stderr: ${res.stderr ?? ''})`);
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.scenario, 'rejected-acceptance', 'stdout scenario');
    assertEq(parsed.outcome, 'REHEARSAL_FAIL', 'stdout outcome');
    assert(Array.isArray(parsed.notes) && (parsed.notes as string[]).includes('ACCEPTANCE_NOT_SEALED'), 'generic blocker note in stdout');
    assert(!(res.stdout ?? '').includes('/mnt/') && !(res.stdout ?? '').includes('catalog-authority-test-library'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI runs the rehearsal, writes the manifest, and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const outPath = join(root, 'catalog-authority-test-library', 'REHEARSALMARKER-out', 'manifest.json');
    const workDir = join(root, 'work');
    const artifactsDir = join(root, 'artifacts');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-rehearsal-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath,
      '--work-dir', workDir, '--run-id', 'cli-run', '--out', outPath, '--artifacts-dir', artifactsDir],
      { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `CLI exits PASS (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'manifest file written');
    const stdout = res.stdout ?? '';
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    assertEq(parsed.outcome, 'REHEARSAL_PASS', 'stdout outcome PASS');
    assertEq(parsed.manifestWritten, true, 'stdout reports manifestWritten');
    assert(!('outputFile' in parsed) && !('out' in parsed), 'no raw out path key in stdout');
    assert(!stdout.includes('REHEARSALMARKER'), 'stdout does not echo the out-path marker');
    assert(!stdout.includes('catalog-authority-test-library'), 'stdout has no test-library fragment');
    assert(!stdout.includes('/mnt/'), 'stdout has no /mnt fragment');
    const manifest = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    assertEq(manifest.report, 'phase-230-promotion-rehearsal-manifest', 'written file is the manifest');
    assert(existsSync(join(artifactsDir, 'acceptancePacket.json')), 'stage artifacts written');
    // The rehearsal cleaned up its own sandbox even under an operator work-dir.
    assert(!existsSync(join(workDir, 'phase-230-rehearsal-cli-run')), 'CLI sandbox removed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
