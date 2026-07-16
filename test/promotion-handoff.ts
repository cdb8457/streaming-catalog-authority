import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCoordinatorHandoff, HANDOFF_DISCLAIMERS } from '../src/ops/promotion-handoff.js';
import { runPromotionRehearsal, type RehearsalScenario } from '../src/ops/promotion-rehearsal.js';
import { verifyArtifactIntegrity } from '../src/ops/promotion-artifact-integrity.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-handoff-')); }
const now = (() => { let i = 0; return () => new Date(Date.UTC(2026, 6, 15, 12, 0, i++)); })();

async function rehearsalArtifacts(root: string, scenario: RehearsalScenario) {
  const { manifest, artifacts } = await runPromotionRehearsal({ workDir: root, runId: `h-${scenario}`, scenario, now });
  const integrity = verifyArtifactIntegrity({
    approvalEvidence: artifacts.approvalEvidence,
    promotionEvidence: artifacts.promotionEvidence,
    evidenceReview: artifacts.evidenceReview,
    readiness: artifacts.readiness,
    acceptancePacket: artifacts.acceptancePacket,
  });
  return { manifest, artifacts, integrity };
}

console.log('Running Phase 230 coordinator handoff suite:\n');

await test('READY_FOR_COORDINATOR for a sealed, integral, passing bundle', async () => {
  const root = workspace();
  try {
    const { manifest, artifacts, integrity } = await rehearsalArtifacts(root, 'success');
    const handoff = buildCoordinatorHandoff({ acceptancePacket: artifacts.acceptancePacket, rehearsalManifest: manifest, integrityReport: integrity });
    assertEq(handoff.handoffState, 'READY_FOR_COORDINATOR', `ready (blockers: ${handoff.blockers.join(',')})`);
    assertEq(handoff.authorization, 'NONE', 'authorizes nothing');
    assertEq(handoff.blockers.length, 0, 'no blockers');
    assertEq(handoff.acceptance.status, 'ACCEPTED_SEALED', 'acceptance sealed');
    assert(handoff.rehearsal?.outcome === 'REHEARSAL_PASS' && handoff.integrity?.ok === true, 'rehearsal + integrity summarized');
    assert(Object.keys(handoff.boundDigests).length > 0, 'bound digests carried');
    assert(/^[0-9a-f]{64}$/.test(handoff.handoffDigest), 'handoff digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('always carries the explicit no-Phase-231 / no-live disclaimers', async () => {
  const root = workspace();
  try {
    const { artifacts } = await rehearsalArtifacts(root, 'success');
    const handoff = buildCoordinatorHandoff({ acceptancePacket: artifacts.acceptancePacket });
    assertEq(handoff.disclaimers.length, HANDOFF_DISCLAIMERS.length, 'all disclaimers present');
    const text = handoff.disclaimers.join(' ');
    assert(/does NOT authorize Phase 231/i.test(text), 'explicit no-Phase-231 language');
    assert(/does NOT authorize live promotion/i.test(text), 'explicit no-live-promotion language');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('NOT_READY when acceptance was refused (disclaimers still present)', async () => {
  const root = workspace();
  try {
    const { artifacts } = await rehearsalArtifacts(root, 'rejected-acceptance');
    const handoff = buildCoordinatorHandoff({ acceptancePacket: artifacts.acceptancePacket });
    assertEq(handoff.handoffState, 'NOT_READY', 'not ready');
    assert(handoff.blockers.includes('ACCEPTANCE_NOT_SEALED'), 'acceptance blocker');
    assertEq(handoff.disclaimers.length, HANDOFF_DISCLAIMERS.length, 'disclaimers still present when not ready');
    assertEq(handoff.authorization, 'NONE', 'still authorizes nothing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('NOT_READY when the integrity report is not ok', async () => {
  const root = workspace();
  try {
    const { artifacts } = await rehearsalArtifacts(root, 'success');
    const badIntegrity = { report: 'phase-230-promotion-artifact-integrity', version: 1, ok: false, problems: ['PROMOTION_EVIDENCE_SELF_DIGEST_MISMATCH'], integrityDigest: 'a'.repeat(64) };
    const handoff = buildCoordinatorHandoff({ acceptancePacket: artifacts.acceptancePacket, integrityReport: badIntegrity });
    assertEq(handoff.handoffState, 'NOT_READY', 'not ready');
    assert(handoff.blockers.includes('INTEGRITY_NOT_OK'), 'integrity blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('NOT_READY when a supplied rehearsal did not pass', async () => {
  const root = workspace();
  try {
    const { artifacts } = await rehearsalArtifacts(root, 'success');
    const failedRehearsal = { report: 'phase-230-promotion-rehearsal-manifest', outcome: 'REHEARSAL_FAIL', manifestDigest: 'b'.repeat(64) };
    const handoff = buildCoordinatorHandoff({ acceptancePacket: artifacts.acceptancePacket, rehearsalManifest: failedRehearsal });
    assertEq(handoff.handoffState, 'NOT_READY', 'not ready');
    assert(handoff.blockers.includes('REHEARSAL_NOT_PASSED'), 'rehearsal blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('NOT_READY and does not throw when the acceptance packet is missing', () => {
  const handoff = buildCoordinatorHandoff({});
  assertEq(handoff.handoffState, 'NOT_READY', 'not ready');
  assert(handoff.blockers.includes('ACCEPTANCE_MISSING'), 'missing acceptance blocker');
  assertEq(handoff.disclaimers.length, HANDOFF_DISCLAIMERS.length, 'disclaimers present');
});

await test('the handoff packet is redaction-safe', async () => {
  const root = workspace();
  try {
    const { manifest, artifacts, integrity } = await rehearsalArtifacts(root, 'success');
    const handoff = buildCoordinatorHandoff({ acceptancePacket: artifacts.acceptancePacket, rehearsalManifest: manifest, integrityReport: integrity });
    assert(handoff.redactionSafe === true, 'flagged redaction-safe');
    assert(!handoff.blockers.includes('RAW_PATH_IN_HANDOFF'), 'no raw-path blocker');
    const serialized = JSON.stringify(handoff);
    assert(!serialized.includes('/mnt/'), 'no /mnt path');
    assert(!serialized.includes('catalog-authority-test-library'), 'no test-library fragment');
    assert(!serialized.includes(root), 'no work-dir path');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI builds a redaction-safe handoff and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const { manifest, artifacts, integrity } = await rehearsalArtifacts(root, 'success');
    const dir = join(root, 'artifacts');
    mkdirSync(dir, { recursive: true });
    const acceptancePath = join(dir, 'acceptance.json');
    const rehearsalPath = join(dir, 'rehearsal.json');
    const integrityPath = join(dir, 'integrity.json');
    writeFileSync(acceptancePath, JSON.stringify(artifacts.acceptancePacket));
    writeFileSync(rehearsalPath, JSON.stringify(manifest));
    writeFileSync(integrityPath, JSON.stringify(integrity));
    const outPath = join(root, 'catalog-authority-test-library', 'HANDOFFMARKER-out', 'handoff.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-handoff-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--acceptance-packet', acceptancePath, '--rehearsal-manifest', rehearsalPath, '--integrity-report', integrityPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `READY exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'handoff file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.handoffState, 'READY_FOR_COORDINATOR', 'stdout state');
    assertEq(parsed.authorization, 'NONE', 'stdout authorization NONE');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(Array.isArray(parsed.disclaimers) && (parsed.disclaimers as string[]).some((d) => /Phase 231/i.test(d)), 'disclaimers in stdout');
    assert(!(res.stdout ?? '').includes('HANDOFFMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
