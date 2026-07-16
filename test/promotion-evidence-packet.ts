import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCoordinatorEvidencePacket, EVIDENCE_DISCLAIMERS, EVIDENCE_HUMAN_GATES, EVIDENCE_TEST_COMMANDS } from '../src/ops/promotion-evidence-packet.js';
import { buildFixtureEvidenceBundle } from '../src/ops/promotion-fixture-bundle.js';
import { replayFixtureBundle } from '../src/ops/promotion-bundle-replay.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-packet-')); }
function makeNow(): () => Date { let i = 0; return () => new Date(Date.UTC(2026, 6, 16, 14, 0, i++)); }

async function bundleAndReplay(root: string) {
  const bundle = JSON.parse(JSON.stringify(await buildFixtureEvidenceBundle({ workDir: root, runId: 'packet', now: makeNow() })));
  const replay = replayFixtureBundle(bundle);
  return { bundle, replay };
}

console.log('Running Phase 230 coordinator evidence packet suite:\n');

await test('EVIDENCE_COMPLETE for a ready bundle + ok replay, with digests, commands, gates, disclaimers', async () => {
  const root = workspace();
  try {
    const { bundle, replay } = await bundleAndReplay(root);
    const packet = buildCoordinatorEvidencePacket({ bundle, replay });
    assertEq(packet.overall, 'EVIDENCE_COMPLETE', `complete (blockers: ${packet.blockers.join(',')})`);
    assertEq(packet.authorization, 'NONE', 'authorizes nothing');
    for (const k of ['bundle', 'manifest', 'matrix', 'integrity', 'schema', 'handoff', 'dashboard', 'replay']) {
      assert(/^[0-9a-f]{64}$/.test(packet.digests[k] ?? ''), `digest ${k} present`);
    }
    assertEq(packet.testCommands.length, EVIDENCE_TEST_COMMANDS.length, 'test commands present');
    assertEq(packet.humanGates.length, EVIDENCE_HUMAN_GATES.length, 'human gates present');
    assertEq(packet.disclaimers.length, EVIDENCE_DISCLAIMERS.length, 'disclaimers present');
    assert(packet.disclaimers.some((d) => /does NOT authorize Phase 231/i.test(d)), 'explicit no-Phase-231 language');
    assert(packet.humanGates.some((g) => /Phase 231/i.test(g)), 'human gates name the Phase 231 gate');
    assert(/^[0-9a-f]{64}$/.test(packet.packetDigest), 'packet digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('EVIDENCE_INCOMPLETE when the bundle is not ready', () => {
  const packet = buildCoordinatorEvidencePacket({ bundle: { report: 'phase-230-promotion-fixture-evidence-bundle', outcome: 'BUNDLE_INCOMPLETE' } });
  assertEq(packet.overall, 'EVIDENCE_INCOMPLETE', 'incomplete');
  assert(packet.blockers.includes('BUNDLE_NOT_READY'), 'bundle-not-ready blocker');
  assertEq(packet.disclaimers.length, EVIDENCE_DISCLAIMERS.length, 'disclaimers still present');
});

await test('EVIDENCE_INCOMPLETE when a supplied replay is not ok', async () => {
  const root = workspace();
  try {
    const { bundle } = await bundleAndReplay(root);
    const badReplay = { report: 'phase-230-promotion-bundle-replay', ok: false, replayDigest: 'a'.repeat(64) };
    const packet = buildCoordinatorEvidencePacket({ bundle, replay: badReplay });
    assertEq(packet.overall, 'EVIDENCE_INCOMPLETE', 'incomplete');
    assert(packet.blockers.includes('REPLAY_NOT_OK'), 'replay-not-ok blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('EVIDENCE_INCOMPLETE and no throw on an invalid/missing bundle', () => {
  const packet = buildCoordinatorEvidencePacket({});
  assertEq(packet.overall, 'EVIDENCE_INCOMPLETE', 'incomplete');
  assert(packet.blockers.includes('BUNDLE_INVALID'), 'bundle-invalid blocker');
});

await test('the packet is redaction-safe and its digest recomputes deterministically', async () => {
  const root = workspace();
  try {
    const { bundle, replay } = await bundleAndReplay(root);
    const packet = buildCoordinatorEvidencePacket({ bundle, replay });
    assert(packet.redactionSafe === true, 'flagged redaction-safe');
    assert(!packet.blockers.includes('RAW_PATH_IN_PACKET'), 'no raw-path blocker');
    const serialized = JSON.stringify(packet);
    assert(!serialized.includes('/mnt/') && !serialized.includes('catalog-authority-test-library') && !serialized.includes(root), 'no path fragments');
    const { packetDigest, ...rest } = packet as unknown as Record<string, unknown> & { packetDigest: string };
    const recomputed = createHash('sha256').update(`phase-230-evidence-packet:${JSON.stringify(rest)}`).digest('hex');
    assertEq(recomputed, packetDigest, 'packet digest recomputes');
    // deterministic: same inputs -> identical packet
    const again = buildCoordinatorEvidencePacket({ bundle, replay });
    assertEq(JSON.stringify(again), JSON.stringify(packet), 'packet is deterministic');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI builds the packet and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const { bundle, replay } = await bundleAndReplay(root);
    const dir = join(root, 'artifacts');
    mkdirSync(dir, { recursive: true });
    const bundlePath = join(dir, 'bundle.json');
    const replayPath = join(dir, 'replay.json');
    writeFileSync(bundlePath, JSON.stringify(bundle));
    writeFileSync(replayPath, JSON.stringify(replay));
    const outPath = join(root, 'catalog-authority-test-library', 'PACKETMARKER-out', 'packet.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-evidence-packet-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--bundle', bundlePath, '--replay', replayPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `COMPLETE exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'packet file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'EVIDENCE_COMPLETE', 'stdout overall');
    assertEq(parsed.authorization, 'NONE', 'stdout authorization NONE');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('PACKETMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
