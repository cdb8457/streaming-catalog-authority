import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifyArtifactIntegrity, type ArtifactBundle } from '../src/ops/promotion-artifact-integrity.js';
import { buildApprovalAttestation } from '../src/ops/promotion-approval.js';
import { reviewPromotionEvidence } from '../src/ops/promotion-evidence-review.js';
import { buildPromotionReadinessChecklist } from '../src/ops/promotion-readiness.js';
import { sealPromotionAcceptance } from '../src/ops/promotion-acceptance-seal.js';
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

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-integrity-')); }
const MINIMAL_MP4_FIXTURE = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypmp42', 'ascii'), Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('mp42isomintegrity-fixture', 'ascii')]);
const now = (() => { let i = 0; return () => new Date(Date.UTC(2026, 6, 15, 11, 0, i++)); })();
const observer: RealLibraryVisibilityClient = { async findVisibleItem({ destinationPath }) { return existsSync(destinationPath) ? { visible: true, itemId: 'jf', matchBasis: 'path' } : { visible: false }; } };
function roundTrip<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

interface Bundle {
  approvalEvidence: Record<string, unknown>;
  promotionEvidence: Record<string, unknown>;
  evidenceReview: Record<string, unknown>;
  readiness: Record<string, unknown>;
  acceptancePacket: Record<string, unknown>;
}

async function fullBundle(root: string, tag: string): Promise<Bundle> {
  const itemId = `1111${tag}`.padEnd(12, '0');
  const testRoot = join(root, `tl-${tag}`, 'catalog-authority-test-library');
  const source = join(testRoot, 'Movies', 'Integrity Proof (2026)', 'source.mp4');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, MINIMAL_MP4_FIXTURE);
  const targetRoot = join(root, `mv-${tag}`, 'Movies');
  mkdirSync(targetRoot, { recursive: true });
  const built = buildApprovalAttestation({ itemId, title: 'Integrity Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot, approvalId: `int-${tag}` });
  const report = await runRealLibraryPromotion({ itemId, title: 'Integrity Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot, approval: { approved: true, ...built.approval! }, allowCustomTargetRootForTests: true, visibilityClient: observer, visibilityPolls: 1, visibilityPollMs: 0, now });
  const promotionEvidence = roundTrip(report) as unknown as Record<string, unknown>;
  const evidenceReview = roundTrip(reviewPromotionEvidence(promotionEvidence)) as unknown as Record<string, unknown>;
  const approvalEvidence = roundTrip(built.evidence) as unknown as Record<string, unknown>;
  const checklist = buildPromotionReadinessChecklist({ approval: built.approval, approvalEvidence, promotionEvidence, evidenceReview });
  const readiness = roundTrip(checklist) as unknown as Record<string, unknown>;
  const packet = sealPromotionAcceptance({ readinessChecklist: checklist, evidenceReview, approvalEvidence, acceptance: { acceptorId: 'coordinator-1', decision: 'ACCEPT', accepted: true } });
  const acceptancePacket = roundTrip(packet) as unknown as Record<string, unknown>;
  return { approvalEvidence, promotionEvidence, evidenceReview, readiness, acceptancePacket };
}

console.log('Running Phase 230 artifact-integrity suite:\n');

await test('accepts a clean, fully-consistent bundle', async () => {
  const root = workspace();
  try {
    const b = await fullBundle(root, 'a');
    const rep = verifyArtifactIntegrity(b);
    assert(rep.ok, `ok (problems: ${rep.problems.join(',')})`);
    assertEq(rep.checkedArtifacts.length, 5, 'all five artifacts checked');
    assert(/^[0-9a-f]{64}$/.test(rep.integrityDigest), 'integrity digest present');
    assert(rep.redactionSafe === true, 'redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('detects a tampered self-digest', async () => {
  const root = workspace();
  try {
    const b = await fullBundle(root, 'b');
    b.promotionEvidence.evidenceDigest = '0'.repeat(64);
    const rep = verifyArtifactIntegrity(b);
    assert(!rep.ok, 'rejected');
    assert(rep.problems.includes('PROMOTION_EVIDENCE_SELF_DIGEST_MISMATCH'), 'self-digest mismatch reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('detects a broken cross-artifact digest chain', async () => {
  const root = workspace();
  try {
    const b = await fullBundle(root, 'c');
    const other = await fullBundle(root, 'd');
    // Swap in a self-valid review that belongs to a DIFFERENT promotion evidence.
    b.evidenceReview = other.evidenceReview;
    const rep = verifyArtifactIntegrity(b);
    assert(!rep.ok, 'rejected');
    assert(rep.problems.includes('REVIEW_TO_PROMOTION_MISMATCH'), 'chain mismatch reported');
    assert(!rep.problems.includes('EVIDENCE_REVIEW_SELF_DIGEST_MISMATCH'), 'the swapped review is itself self-valid (isolates the chain break)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('detects a missing artifact', async () => {
  const root = workspace();
  try {
    const b = await fullBundle(root, 'e');
    const partial: ArtifactBundle = { approvalEvidence: b.approvalEvidence, promotionEvidence: b.promotionEvidence, evidenceReview: b.evidenceReview, readiness: b.readiness };
    const rep = verifyArtifactIntegrity(partial);
    assert(!rep.ok, 'rejected');
    assert(rep.problems.includes('ACCEPTANCE_PACKET_MISSING'), 'missing artifact reported');
    assert(!rep.checkedArtifacts.includes('acceptancePacket'), 'missing artifact not marked checked');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('detects a packet bound to the wrong readiness checklist', async () => {
  const root = workspace();
  try {
    const b = await fullBundle(root, 'f');
    (b.acceptancePacket.boundDigests as Record<string, unknown>).checklistDigest = '1'.repeat(64);
    const rep = verifyArtifactIntegrity(b);
    assert(!rep.ok, 'rejected');
    // The self-digest also breaks (boundDigests is inside the sealed body) — both are legitimate signals.
    assert(rep.problems.includes('PACKET_TO_READINESS_MISMATCH') || rep.problems.includes('ACCEPTANCE_PACKET_SELF_DIGEST_MISMATCH'), 'packet inconsistency reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('the integrity report is redaction-safe and does not throw on empty input', () => {
  const rep = verifyArtifactIntegrity({});
  assert(!rep.ok, 'empty bundle is not ok');
  assertEq(rep.checkedArtifacts.length, 0, 'nothing checked');
  assert(rep.problems.includes('PROMOTION_EVIDENCE_MISSING'), 'missing codes for absent artifacts');
  assert(!JSON.stringify(rep).includes('/mnt/'), 'no path fragments');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
