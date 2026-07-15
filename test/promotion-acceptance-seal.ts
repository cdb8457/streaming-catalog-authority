import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealPromotionAcceptance, verifyAcceptanceSeal } from '../src/ops/promotion-acceptance-seal.js';
import { buildApprovalAttestation } from '../src/ops/promotion-approval.js';
import { reviewPromotionEvidence } from '../src/ops/promotion-evidence-review.js';
import { buildPromotionReadinessChecklist } from '../src/ops/promotion-readiness.js';
import { runRealLibraryPromotion, type RealLibraryVisibilityClient } from '../src/ops/real-library-promotion.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-acceptance-')); }

const MINIMAL_MP4_FIXTURE = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isomcatalog-authority-acceptance-fixture', 'ascii'),
]);

const now = (() => { let i = 0; return () => new Date(Date.UTC(2026, 6, 15, 7, 0, i++)); })();
const visibleClient: RealLibraryVisibilityClient = {
  async findVisibleItem({ destinationPath }) { return existsSync(destinationPath) ? { visible: true, itemId: 'jf', matchBasis: 'path' } : { visible: false }; },
};

const TITLE = 'Acceptance Proof';
const ITEM_ID = '11111111-1111-4111-8111-111111111111';

function roundTrip<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

interface Bundle {
  approval: Record<string, unknown>;
  approvalEvidence: Record<string, unknown>;
  promotionEvidence: Record<string, unknown>;
  evidenceReview: Record<string, unknown>;
  checklist: ReturnType<typeof buildPromotionReadinessChecklist>;
}

async function readyBundle(root: string): Promise<Bundle> {
  const testRoot = join(root, 'catalog-authority-test-library');
  const source = join(testRoot, 'Movies', `${TITLE} (2026)`, 'source.mp4');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, MINIMAL_MP4_FIXTURE);
  const targetRoot = join(root, 'Movies');
  mkdirSync(targetRoot, { recursive: true });
  const built = buildApprovalAttestation({ itemId: ITEM_ID, title: TITLE, year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot, approvalId: 'acceptance-approval' });
  const report = await runRealLibraryPromotion({
    itemId: ITEM_ID, title: TITLE, year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot,
    approval: { approved: true, ...built.approval! },
    allowCustomTargetRootForTests: true, visibilityClient: visibleClient, visibilityPolls: 1, visibilityPollMs: 0, now,
  });
  const promotionEvidence = roundTrip(report) as unknown as Record<string, unknown>;
  const evidenceReview = roundTrip(reviewPromotionEvidence(promotionEvidence)) as unknown as Record<string, unknown>;
  const approval = roundTrip(built.approval!) as unknown as Record<string, unknown>;
  const approvalEvidence = roundTrip(built.evidence) as unknown as Record<string, unknown>;
  const checklist = buildPromotionReadinessChecklist({ approval, approvalEvidence, promotionEvidence, evidenceReview });
  assertEq(checklist.verdict, 'READY', 'bundle checklist is READY');
  return { approval, approvalEvidence, promotionEvidence, evidenceReview, checklist };
}

const ACCEPT = { acceptorId: 'coordinator-1', decision: 'ACCEPT', accepted: true };

console.log('Running Phase 230 promotion acceptance-seal suite:\n');

await test('seals a READY checklist with an ACCEPT decision and verifies', async () => {
  const root = workspace();
  try {
    const b = await readyBundle(root);
    const packet = sealPromotionAcceptance({ readinessChecklist: b.checklist, evidenceReview: b.evidenceReview, approvalEvidence: b.approvalEvidence, acceptance: ACCEPT });
    assertEq(packet.status, 'ACCEPTED_SEALED', `sealed (refusals: ${packet.refusals.join(',')})`);
    assert(packet.accepted, 'accepted true');
    assertEq(packet.refusals.length, 0, 'no refusals');
    assert(packet.readiness.checklistVerified, 'checklist verified');
    assert(/^[0-9a-f]{64}$/.test(packet.sealDigest), 'seal digest present');
    assert(packet.boundDigests.checklistDigest === b.checklist.checklistDigest, 'binds the checklist digest');
    assert(packet.boundDigests.evidenceReviewDigest !== undefined && packet.boundDigests.approvalEvidenceDigest !== undefined, 'binds review and approval-evidence digests');
    assert(packet.acceptance.acceptorDigest !== undefined && packet.acceptance.decision === 'ACCEPT', 'records acceptor digest + decision');
    assert(verifyAcceptanceSeal(packet).ok, 'verify accepts the seal');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('REFUSES to seal a BLOCKED readiness checklist', async () => {
  const root = workspace();
  try {
    const b = await readyBundle(root);
    const blocked = buildPromotionReadinessChecklist({ approval: b.approval }); // missing promotion evidence -> BLOCKED
    assertEq(blocked.verdict, 'BLOCKED', 'checklist is BLOCKED');
    const packet = sealPromotionAcceptance({ readinessChecklist: blocked, acceptance: ACCEPT });
    assertEq(packet.status, 'ACCEPTANCE_REFUSED', 'refused');
    assert(!packet.accepted, 'not accepted');
    assert(packet.refusals.includes('READINESS_NOT_READY'), 'readiness-not-ready refusal');
    assert(verifyAcceptanceSeal(packet).ok, 'a refused packet is still a valid sealed record');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('REFUSES when the decision is REJECT', async () => {
  const root = workspace();
  try {
    const b = await readyBundle(root);
    const packet = sealPromotionAcceptance({ readinessChecklist: b.checklist, acceptance: { acceptorId: 'coordinator-1', decision: 'REJECT', accepted: false } });
    assertEq(packet.status, 'ACCEPTANCE_REFUSED', 'refused');
    assert(packet.refusals.includes('ACCEPTANCE_REJECTED'), 'rejected refusal');
    assertEq(packet.acceptance.decision, 'REJECT', 'records REJECT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('REFUSES when no acceptor is given', async () => {
  const root = workspace();
  try {
    const b = await readyBundle(root);
    const packet = sealPromotionAcceptance({ readinessChecklist: b.checklist, acceptance: { decision: 'ACCEPT', accepted: true } });
    assertEq(packet.status, 'ACCEPTANCE_REFUSED', 'refused');
    assert(packet.refusals.includes('ACCEPTOR_MISSING'), 'acceptor-missing refusal');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('REFUSES a tampered readiness checklist (digest mismatch)', async () => {
  const root = workspace();
  try {
    const b = await readyBundle(root);
    const tampered = roundTrip(b.checklist) as unknown as Record<string, unknown>;
    tampered.itemDigest = 'a'.repeat(64); // change a bound field without resealing the checklist
    const packet = sealPromotionAcceptance({ readinessChecklist: tampered, acceptance: ACCEPT });
    assertEq(packet.status, 'ACCEPTANCE_REFUSED', 'refused');
    assert(packet.refusals.includes('READINESS_DIGEST_MISMATCH'), 'digest-mismatch refusal');
    assert(!packet.readiness.checklistVerified, 'checklist not verified');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('REFUSES and does not throw on a malformed readiness input', () => {
  const packet = sealPromotionAcceptance({ readinessChecklist: { nope: true }, acceptance: ACCEPT });
  assertEq(packet.status, 'ACCEPTANCE_REFUSED', 'refused');
  assert(packet.refusals.includes('READINESS_INVALID'), 'readiness-invalid refusal');
});

await test('REFUSES when the supplied evidence review is not tied to the checklist', async () => {
  const root = workspace();
  try {
    const b = await readyBundle(root);
    const otherReview = roundTrip(b.evidenceReview) as unknown as Record<string, unknown>;
    otherReview.subjectEvidenceDigest = 'c'.repeat(64); // review of a different promotion evidence
    const packet = sealPromotionAcceptance({ readinessChecklist: b.checklist, evidenceReview: otherReview, acceptance: ACCEPT });
    assertEq(packet.status, 'ACCEPTANCE_REFUSED', 'refused');
    assert(packet.refusals.includes('EVIDENCE_REVIEW_INCONSISTENT'), 'review-inconsistent refusal');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('verify detects a tampered sealed packet', async () => {
  const root = workspace();
  try {
    const b = await readyBundle(root);
    const packet = sealPromotionAcceptance({ readinessChecklist: b.checklist, acceptance: ACCEPT });
    const tampered = roundTrip(packet) as unknown as Record<string, unknown>;
    (tampered.boundDigests as Record<string, unknown>).itemDigest = 'e'.repeat(64); // change without resealing
    const v = verifyAcceptanceSeal(tampered);
    assert(!v.ok, 'tampered packet rejected');
    assert(v.problems.includes('SEAL_DIGEST_MISMATCH'), 'seal digest mismatch reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('verify detects a status/accepted inconsistency even when the seal recomputes', async () => {
  const root = workspace();
  try {
    const b = await readyBundle(root);
    const packet = sealPromotionAcceptance({ readinessChecklist: b.checklist, acceptance: ACCEPT });
    // Attacker flips accepted=false but re-seals so the digest matches; status stays ACCEPTED_SEALED.
    const { sealDigest, ...rest } = roundTrip(packet) as unknown as Record<string, unknown> & { sealDigest: string };
    void sealDigest;
    const bad = { ...rest, accepted: false };
    const resealed = { ...bad, sealDigest: createHash('sha256').update(`phase-230-acceptance-seal:${JSON.stringify(bad)}`).digest('hex') };
    const v = verifyAcceptanceSeal(resealed);
    assert(!v.ok, 'inconsistent packet rejected');
    assert(v.problems.includes('STATUS_INCONSISTENT'), 'status inconsistency reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('the sealed packet is redaction-safe (no raw path or title)', async () => {
  const root = workspace();
  try {
    const b = await readyBundle(root);
    const rawSource = String(b.approval.sourceRealPath);
    const rawDestination = String(b.approval.destinationPath);
    const packet = sealPromotionAcceptance({ readinessChecklist: b.checklist, evidenceReview: b.evidenceReview, approvalEvidence: b.approvalEvidence, acceptance: ACCEPT });
    const serialized = JSON.stringify(packet);
    assert(packet.redactionSafe === true, 'flagged redaction-safe');
    assert(!packet.refusals.includes('RAW_PATH_IN_PACKET'), 'no raw-path refusal');
    assert(!serialized.includes(rawSource) && !serialized.includes(rawDestination), 'no raw paths echoed');
    assert(!serialized.includes(TITLE), 'no raw title echoed');
    assert(!serialized.includes('/mnt/') && !serialized.includes('catalog-authority-test-library'), 'no path fragments');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI seals then verifies, without echoing raw paths to stdout', async () => {
  const root = workspace();
  try {
    const b = await readyBundle(root);
    const artifacts = join(root, 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    const readinessPath = join(artifacts, 'checklist.json');
    const reviewPath = join(artifacts, 'review.json');
    writeFileSync(readinessPath, JSON.stringify(b.checklist));
    writeFileSync(reviewPath, JSON.stringify(b.evidenceReview));
    const outPath = join(root, 'catalog-authority-test-library', 'SEALMARKER-out', 'packet.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-acceptance-seal-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const sealRes = spawnSync(process.execPath, ['--import', 'tsx', cliPath, 'seal',
      '--readiness', readinessPath, '--evidence-review', reviewPath, '--acceptor-id', 'coordinator-1', '--decision', 'ACCEPT', '--out', outPath],
      { cwd: projectRoot, encoding: 'utf8' });
    assert(sealRes.error === undefined, `seal spawn ok: ${sealRes.error?.message ?? ''}`);
    assertEq(sealRes.status, 0, `seal exits ACCEPTED (stderr: ${sealRes.stderr ?? ''})`);
    assert(existsSync(outPath), 'packet written');
    const sealOut = JSON.parse(sealRes.stdout ?? '') as Record<string, unknown>;
    assertEq(sealOut.status, 'ACCEPTED_SEALED', 'stdout status');
    assertEq(sealOut.outputWritten, true, 'stdout reports outputWritten');
    assert(!('outputFile' in sealOut), 'no outputFile key in stdout');
    assert(!(sealRes.stdout ?? '').includes('SEALMARKER'), 'stdout does not echo the out-path marker');
    assert(!(sealRes.stdout ?? '').includes('catalog-authority-test-library') && !(sealRes.stdout ?? '').includes('/mnt/'), 'stdout has no path fragments');

    const verifyRes = spawnSync(process.execPath, ['--import', 'tsx', cliPath, 'verify', '--packet', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assertEq(verifyRes.status, 0, `verify exits ok (stderr: ${verifyRes.stderr ?? ''})`);
    const verifyOut = JSON.parse(verifyRes.stdout ?? '') as Record<string, unknown>;
    assertEq(verifyOut.ok, true, 'verify ok');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
