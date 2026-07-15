import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildPromotionReadinessChecklist, type PromotionReadinessInput } from '../src/ops/promotion-readiness.js';
import { buildApprovalAttestation } from '../src/ops/promotion-approval.js';
import { reviewPromotionEvidence } from '../src/ops/promotion-evidence-review.js';
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

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-readiness-')); }

const MINIMAL_MP4_FIXTURE = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isomcatalog-authority-readiness-fixture', 'ascii'),
]);

const now = (() => { let i = 0; return () => new Date(Date.UTC(2026, 6, 15, 5, 0, i++)); })();
const visibleClient: RealLibraryVisibilityClient = {
  async findVisibleItem({ destinationPath }) { return existsSync(destinationPath) ? { visible: true, itemId: 'jf', matchBasis: 'path' } : { visible: false }; },
};
const neverVisibleClient: RealLibraryVisibilityClient = { async findVisibleItem() { return { visible: false }; } };

const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const TITLE = 'Readiness Proof';

function roundTrip<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

// Build a complete, mutually-consistent bundle from the real tools (promote-only success).
async function fullBundle(root: string, opts: { observed: boolean } = { observed: true }): Promise<PromotionReadinessInput & { approval: Record<string, unknown>; promotionEvidence: Record<string, unknown>; evidenceReview: Record<string, unknown>; approvalEvidence: Record<string, unknown> }> {
  const testRoot = join(root, 'catalog-authority-test-library');
  const source = join(testRoot, 'Movies', `${TITLE} (2026)`, 'source.mp4');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, MINIMAL_MP4_FIXTURE);
  const targetRoot = join(root, 'Movies');
  mkdirSync(targetRoot, { recursive: true });
  const built = buildApprovalAttestation({ itemId: ITEM_ID, title: TITLE, year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot, approvalId: 'readiness-approval' });
  assert(built.ok, 'approval built');
  const report = await runRealLibraryPromotion({
    itemId: ITEM_ID, title: TITLE, year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot,
    approval: { approved: true, ...built.approval! },
    allowCustomTargetRootForTests: true,
    visibilityClient: opts.observed ? visibleClient : neverVisibleClient,
    visibilityPolls: 1, visibilityPollMs: 0,
    now,
  });
  const promotionEvidence = roundTrip(report) as unknown as Record<string, unknown>;
  const evidenceReview = roundTrip(reviewPromotionEvidence(promotionEvidence)) as unknown as Record<string, unknown>;
  return {
    approval: roundTrip(built.approval!) as unknown as Record<string, unknown>,
    approvalEvidence: roundTrip(built.evidence) as unknown as Record<string, unknown>,
    promotionEvidence,
    evidenceReview,
  };
}

function item(checklist: ReturnType<typeof buildPromotionReadinessChecklist>, id: string) {
  const found = checklist.items.find((i) => i.id === id);
  assert(found !== undefined, `checklist has item ${id}`);
  return found!;
}

console.log('Running Phase 230 promotion readiness suite:\n');

await test('READY for a complete, mutually-consistent bundle', async () => {
  const root = workspace();
  try {
    const bundle = await fullBundle(root);
    const checklist = buildPromotionReadinessChecklist(bundle);
    assertEq(checklist.verdict, 'READY', `ready (blockers: ${checklist.blockers.join(',')})`);
    assertEq(checklist.blockers.length, 0, 'no blockers');
    assertEq(item(checklist, 'PROMOTION_MATCHES_APPROVAL').status, 'PASS', 'promotion matches approval');
    assertEq(item(checklist, 'OBSERVED_JELLYFIN_STATE').status, 'PASS', 'observed state present');
    assertEq(item(checklist, 'EVIDENCE_REVIEW_ACCEPTED').status, 'PASS', 'review accepted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the approval item digest does not match the promotion evidence', async () => {
  const root = workspace();
  try {
    const bundle = await fullBundle(root);
    (bundle.approval as Record<string, unknown>).itemId = '99999999-9999-4999-8999-999999999999';
    const checklist = buildPromotionReadinessChecklist(bundle);
    assertEq(checklist.verdict, 'BLOCKED', 'blocked on item mismatch');
    const m = item(checklist, 'PROMOTION_MATCHES_APPROVAL');
    assertEq(m.status, 'FAIL', 'promotion match fails');
    assert(m.mismatches?.includes('ITEM'), 'ITEM mismatch reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the approval source checksum does not match', async () => {
  const root = workspace();
  try {
    const bundle = await fullBundle(root);
    (bundle.approval as Record<string, unknown>).sourceSha256 = 'a'.repeat(64);
    const checklist = buildPromotionReadinessChecklist(bundle);
    assertEq(checklist.verdict, 'BLOCKED', 'blocked on source mismatch');
    assert(item(checklist, 'PROMOTION_MATCHES_APPROVAL').mismatches?.includes('SOURCE'), 'SOURCE mismatch reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the approval destination does not match', async () => {
  const root = workspace();
  try {
    const bundle = await fullBundle(root);
    const approval = bundle.approval as Record<string, unknown>;
    // Change the whole "<Title> (<Year>)" folder AND file, so the destination basename (what the
    // promotion evidence exposes as destinationNameDigest) actually differs.
    approval.destinationPath = String(approval.destinationPath).split('Readiness Proof (2026)').join('Different Movie (2026)');
    const checklist = buildPromotionReadinessChecklist(bundle);
    assertEq(checklist.verdict, 'BLOCKED', 'blocked on destination mismatch');
    assert(item(checklist, 'PROMOTION_MATCHES_APPROVAL').mismatches?.includes('DESTINATION'), 'DESTINATION mismatch reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the evidence review rejected the promotion evidence', async () => {
  const root = workspace();
  try {
    const bundle = await fullBundle(root);
    const review = bundle.evidenceReview as Record<string, unknown>;
    review.status = 'PROMOTION_EVIDENCE_REJECTED';
    review.ok = false;
    const checklist = buildPromotionReadinessChecklist(bundle);
    assertEq(checklist.verdict, 'BLOCKED', 'blocked on rejected review');
    assertEq(item(checklist, 'EVIDENCE_REVIEW_ACCEPTED').status, 'FAIL', 'review-accepted fails');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the review is for a different promotion evidence', async () => {
  const root = workspace();
  try {
    const bundle = await fullBundle(root);
    (bundle.evidenceReview as Record<string, unknown>).subjectEvidenceDigest = 'b'.repeat(64);
    const checklist = buildPromotionReadinessChecklist(bundle);
    assertEq(checklist.verdict, 'BLOCKED', 'blocked on untied review');
    assertEq(item(checklist, 'EVIDENCE_REVIEW_ACCEPTED').status, 'FAIL', 'review-tie fails');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED on missing observed-state evidence (promotion failed at visibility)', async () => {
  const root = workspace();
  try {
    const bundle = await fullBundle(root, { observed: false });
    // The failed report is itself well-formed, so its review is accepted and ties -- but there
    // is no observed real-library visibility, which must block readiness.
    const checklist = buildPromotionReadinessChecklist(bundle);
    assertEq(checklist.verdict, 'BLOCKED', 'blocked on missing observed state');
    assertEq(item(checklist, 'OBSERVED_JELLYFIN_STATE').status, 'FAIL', 'observed-state fails');
    assertEq(item(checklist, 'EVIDENCE_REVIEW_ACCEPTED').status, 'PASS', 'the failed evidence is still a valid, reviewed document');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when promotion evidence is entirely absent', async () => {
  const root = workspace();
  try {
    const bundle = await fullBundle(root);
    const checklist = buildPromotionReadinessChecklist({ approval: bundle.approval, approvalEvidence: bundle.approvalEvidence });
    assertEq(checklist.verdict, 'BLOCKED', 'blocked without promotion evidence');
    assertEq(item(checklist, 'PROMOTION_EVIDENCE_PRESENT').status, 'FAIL', 'promotion-present fails');
    assertEq(item(checklist, 'EVIDENCE_REVIEW_ACCEPTED').status, 'FAIL', 'review-accepted fails (no review)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('emitted checklist never leaks a raw path or title from the inputs', async () => {
  const root = workspace();
  try {
    const bundle = await fullBundle(root);
    const approval = bundle.approval as Record<string, unknown>;
    const rawSource = String(approval.sourceRealPath);
    const rawDestination = String(approval.destinationPath);
    const checklist = buildPromotionReadinessChecklist(bundle);
    const serialized = JSON.stringify(checklist);
    assert(checklist.redactionSafe === true, 'flagged redaction-safe');
    assertEq(item(checklist, 'NO_LEAK_IN_CHECKLIST').status, 'PASS', 'no-leak self-check passes');
    assert(!serialized.includes(rawSource), 'raw source real path not echoed');
    assert(!serialized.includes(rawDestination), 'raw destination path not echoed');
    assert(!serialized.includes(TITLE), 'raw title not echoed');
    assert(!serialized.includes('/mnt/'), 'no unix path fragment');
    assert(!serialized.includes('catalog-authority-test-library'), 'no test-library fragment');
    assert(/^[0-9a-f]{64}$/.test(checklist.checklistDigest), 'checklist digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when supplied approval evidence is MISSING an expected digest', async () => {
  const root = workspace();
  try {
    const bundle = await fullBundle(root);
    delete (bundle.approvalEvidence as Record<string, unknown>).itemDigest; // omitted, must not silently pass
    const checklist = buildPromotionReadinessChecklist(bundle);
    assertEq(checklist.verdict, 'BLOCKED', 'missing digest field blocks');
    const m = item(checklist, 'APPROVAL_EVIDENCE_MATCHES_APPROVAL');
    assertEq(m.status, 'FAIL', 'approval-evidence match fails');
    assert(m.required, 'the check is required once approval evidence is supplied');
    assert(m.mismatches?.includes('ITEM'), 'missing ITEM digest reported');
    assert(checklist.blockers.includes('APPROVAL_EVIDENCE_MATCHES_APPROVAL'), 'listed as a blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when supplied approval evidence has a MALFORMED expected digest', async () => {
  const root = workspace();
  try {
    const bundle = await fullBundle(root);
    (bundle.approvalEvidence as Record<string, unknown>).sourceRealPathDigest = 'not-a-sha256';
    const checklist = buildPromotionReadinessChecklist(bundle);
    assertEq(checklist.verdict, 'BLOCKED', 'malformed digest field blocks');
    const m = item(checklist, 'APPROVAL_EVIDENCE_MATCHES_APPROVAL');
    assertEq(m.status, 'FAIL', 'approval-evidence match fails');
    assert(m.mismatches?.includes('SOURCE_REAL_PATH'), 'malformed SOURCE_REAL_PATH digest reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when supplied approval evidence has a wrong-but-valid digest', async () => {
  const root = workspace();
  try {
    const bundle = await fullBundle(root);
    (bundle.approvalEvidence as Record<string, unknown>).destinationNameDigest = 'c'.repeat(64);
    const checklist = buildPromotionReadinessChecklist(bundle);
    assertEq(checklist.verdict, 'BLOCKED', 'diverging digest blocks');
    assert(item(checklist, 'APPROVAL_EVIDENCE_MATCHES_APPROVAL').mismatches?.includes('DESTINATION_NAME'), 'DESTINATION_NAME divergence reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('approval-evidence check is SKIPPED and non-blocking when not supplied', async () => {
  const root = workspace();
  try {
    const bundle = await fullBundle(root);
    const checklist = buildPromotionReadinessChecklist({ approval: bundle.approval, promotionEvidence: bundle.promotionEvidence, evidenceReview: bundle.evidenceReview });
    assertEq(checklist.verdict, 'READY', `still ready without approval evidence (blockers: ${checklist.blockers.join(',')})`);
    const m = item(checklist, 'APPROVAL_EVIDENCE_MATCHES_APPROVAL');
    assertEq(m.status, 'SKIPPED', 'skipped when absent');
    assert(!m.required, 'not required when absent');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED and does not throw on a malformed approval', () => {
  const checklist = buildPromotionReadinessChecklist({ approval: { nope: true } });
  assertEq(checklist.verdict, 'BLOCKED', 'malformed approval blocked');
  assertEq(item(checklist, 'APPROVAL_WELL_FORMED').status, 'FAIL', 'approval-well-formed fails');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
