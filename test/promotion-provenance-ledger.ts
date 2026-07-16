import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProvenanceLedger } from '../src/ops/promotion-provenance-ledger.js';
import { buildFixtureEvidenceBundle } from '../src/ops/promotion-fixture-bundle.js';
import { replayFixtureBundle } from '../src/ops/promotion-bundle-replay.js';
import { buildCoordinatorEvidencePacket } from '../src/ops/promotion-evidence-packet.js';
import { buildReviewTranscript } from '../src/ops/promotion-review-transcript.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-ledger-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 16, 17, 0, i++)); }
const COMMIT = 'e00ec68ac90758521484ccc8fca9a51ede77ac75';

async function fullInputs(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'ledger', now: makeNow() })));
  const replay = replayFixtureBundle(bundle);
  const evidence = buildCoordinatorEvidencePacket({ bundle, replay });
  const transcript = buildReviewTranscript({ reviewedCommit: COMMIT, testResults: [{ command: 'npm run test:phase230-local', passed: 5, failed: 0 }] });
  return { bundle, replay, evidence, transcript };
}

console.log('Running Phase 230 provenance ledger suite:\n');

await test('complete ledger for a full input set with producers and consumers', async () => {
  const root = workspace();
  try {
    const { bundle, replay, evidence, transcript } = await fullInputs(root);
    const ledger = buildProvenanceLedger({ bundle, replay, evidence, transcript });
    assert(ledger.complete, `complete (absent: ${ledger.absent.join(',')})`);
    assertEq(ledger.entries.length, 15, 'fifteen provenance entries');
    assert(ledger.entries.every((e) => e.status === 'present' && /^[0-9a-f]{64}$/.test(e.digest ?? '')), 'every entry present with a digest');
    const approval = ledger.entries.find((e) => e.id === 'phase-230-promotion-approval-attestation')!;
    assertEq(approval.producer, 'promotion-approval', 'approval producer');
    assert(approval.consumers.includes('promotion-readiness'), 'approval consumer');
    assert(/^[0-9a-f]{64}$/.test(ledger.ledgerDigest), 'ledger digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('marks absent components when inputs are partial', async () => {
  const root = workspace();
  try {
    const { bundle } = await fullInputs(root);
    const ledger = buildProvenanceLedger({ bundle }); // no replay/evidence/transcript
    assert(!ledger.complete, 'incomplete');
    assert(ledger.absent.includes('phase-230-promotion-bundle-replay'), 'replay absent');
    assert(ledger.absent.includes('phase-230-promotion-coordinator-evidence-packet'), 'evidence absent');
    assert(ledger.absent.includes('phase-230-promotion-review-transcript'), 'transcript absent');
    // bundle-embedded artifacts/reports are still present
    assert(ledger.entries.find((e) => e.id === 'phase-230-promotion-acceptance-dashboard')!.status === 'present', 'dashboard present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('the ledger is redaction-safe and does not throw on empty input', () => {
  const ledger = buildProvenanceLedger({});
  assert(!ledger.complete, 'empty is incomplete');
  assertEq(ledger.absent.length, ledger.entries.length, 'all absent');
  assert(ledger.redactionSafe === true && !JSON.stringify(ledger).includes('/mnt/'), 'redaction-safe');
});

await test('CLI writes the ledger and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const { bundle, replay, evidence, transcript } = await fullInputs(root);
    const dir = join(root, 'artifacts');
    mkdirSync(dir, { recursive: true });
    const paths = {
      bundle: join(dir, 'bundle.json'), replay: join(dir, 'replay.json'),
      evidence: join(dir, 'evidence.json'), transcript: join(dir, 'transcript.json'),
    };
    writeFileSync(paths.bundle, JSON.stringify(bundle));
    writeFileSync(paths.replay, JSON.stringify(replay));
    writeFileSync(paths.evidence, JSON.stringify(evidence));
    writeFileSync(paths.transcript, JSON.stringify(transcript));
    const outPath = join(root, 'catalog-authority-test-library', 'LEDGERMARKER-out', 'ledger.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-provenance-ledger-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--bundle', paths.bundle, '--replay', paths.replay, '--evidence', paths.evidence, '--transcript', paths.transcript, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `complete exit 0 (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'ledger file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.complete, true, 'stdout complete');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('LEDGERMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
