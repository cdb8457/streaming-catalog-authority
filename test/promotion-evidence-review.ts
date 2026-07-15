import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { reviewPromotionEvidence } from '../src/ops/promotion-evidence-review.js';
import { buildApprovalAttestation } from '../src/ops/promotion-approval.js';
import { runRealLibraryPromotion, type RealLibraryVisibilityClient } from '../src/ops/real-library-promotion.js';
import { existsSync } from 'node:fs';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-evidence-review-')); }

const MINIMAL_MP4_FIXTURE = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isomcatalog-authority-evidence-fixture', 'ascii'),
]);

const now = (() => { let i = 0; return () => new Date(Date.UTC(2026, 6, 15, 3, 0, i++)); })();

const fileStateClient: RealLibraryVisibilityClient = {
  async findVisibleItem({ destinationPath }) {
    return existsSync(destinationPath) ? { visible: true, itemId: 'jf', matchBasis: 'path' } : { visible: false };
  },
};

// Produce a genuine phase-230-real-library-promotion report, then round-trip it through JSON
// exactly as the CLI writes and a reviewer reads it.
async function produceEvidence(root: string, opts: { withdraw: boolean }): Promise<Record<string, unknown>> {
  const itemId = '11111111-1111-4111-8111-111111111111';
  const testRoot = join(root, 'catalog-authority-test-library');
  const source = join(testRoot, 'Movies', 'Evidence Proof (2026)', 'source.mp4');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, MINIMAL_MP4_FIXTURE);
  const targetRoot = join(root, 'Movies');
  mkdirSync(targetRoot, { recursive: true });
  const built = buildApprovalAttestation({ itemId, title: 'Evidence Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot, approvalId: 'evidence-approval' });
  const report = await runRealLibraryPromotion({
    itemId,
    title: 'Evidence Proof',
    year: 2026,
    sourceFile: source,
    testLibraryRoot: testRoot,
    targetRoot,
    approval: { approved: true, ...built.approval! },
    allowCustomTargetRootForTests: true,
    visibilityClient: fileStateClient,
    visibilityPolls: 1,
    visibilityPollMs: 0,
    withdrawAfter: opts.withdraw,
    now,
  });
  return JSON.parse(JSON.stringify(report, null, 2)) as Record<string, unknown>;
}

// Recompute evidenceDigest the way runRealLibraryPromotion does, so a tampered field can be
// tested in isolation without also tripping EVIDENCE_DIGEST_MISMATCH.
function reseal(report: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
  const withoutDigest: Record<string, unknown> = {};
  for (const key of Object.keys(clone)) if (key !== 'evidenceDigest') withoutDigest[key] = clone[key];
  clone.evidenceDigest = createHash('sha256').update(`phase-230-report:${JSON.stringify(withoutDigest)}`).digest('hex');
  return clone;
}

console.log('Running Phase 230 promotion evidence-review suite:\n');

await test('accepts a genuine promote-then-withdraw evidence report', async () => {
  const root = workspace();
  try {
    const report = await produceEvidence(root, { withdraw: true });
    const review = reviewPromotionEvidence(report);
    assert(review.ok, `accepted (problems: ${review.problems.join(',')})`);
    assertEq(review.status, 'PROMOTION_EVIDENCE_ACCEPTED', 'accepted status');
    assert(review.checks.evidenceDigestVerified, 'evidenceDigest recomputes');
    assert(review.checks.noRawPathLeak && review.checks.forbiddenListComplete && review.checks.stateStatusConsistent, 'all core checks pass');
    assertEq(review.subjectStatus, 'REAL_LIBRARY_PROMOTION_WITHDRAWN', 'echoes subject status');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('accepts a genuine promote-only (visible) evidence report', async () => {
  const root = workspace();
  try {
    const report = await produceEvidence(root, { withdraw: false });
    const review = reviewPromotionEvidence(report);
    assert(review.ok, `accepted (problems: ${review.problems.join(',')})`);
    assertEq(review.subjectStatus, 'REAL_LIBRARY_PROMOTION_VISIBLE', 'echoes subject status');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('rejects a report not flagged redaction-safe', async () => {
  const root = workspace();
  try {
    const report = await produceEvidence(root, { withdraw: true });
    report.redactionSafe = false;
    const review = reviewPromotionEvidence(reseal(report));
    assert(!review.ok, 'rejected');
    assert(review.problems.includes('NOT_FLAGGED_REDACTION_SAFE'), 'redaction-safe problem');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('rejects a report with an identity-echo flag set', async () => {
  const root = workspace();
  try {
    const report = await produceEvidence(root, { withdraw: true });
    report.titleEchoed = true;
    const review = reviewPromotionEvidence(reseal(report));
    assert(!review.ok, 'rejected');
    assert(review.problems.includes('IDENTITY_ECHO_FLAG_SET'), 'identity echo problem');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('rejects a truncated forbidden list', async () => {
  const root = workspace();
  try {
    const report = await produceEvidence(root, { withdraw: true });
    report.forbidden = (report.forbidden as string[]).slice(0, 3);
    const review = reviewPromotionEvidence(reseal(report));
    assert(!review.ok, 'rejected');
    assert(review.problems.includes('FORBIDDEN_LIST_INCOMPLETE'), 'forbidden list problem');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('rejects an ok/status/state inconsistency', async () => {
  const root = workspace();
  try {
    const report = await produceEvidence(root, { withdraw: false });
    report.ok = false; // status stays VISIBLE + state VISIBLE_IN_REAL_LIBRARY -> inconsistent with ok=false
    const review = reviewPromotionEvidence(reseal(report));
    assert(!review.ok, 'rejected');
    assert(review.problems.includes('STATE_STATUS_INCONSISTENT'), 'state/status problem');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('rejects a tampered evidenceDigest (not resealed)', async () => {
  const root = workspace();
  try {
    const report = await produceEvidence(root, { withdraw: true });
    report.evidenceDigest = '0'.repeat(64); // valid shape, wrong value
    const review = reviewPromotionEvidence(report);
    assert(!review.ok, 'rejected');
    assert(review.problems.includes('EVIDENCE_DIGEST_MISMATCH'), 'digest mismatch problem');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('rejects a raw path leaked into a transition evidence string', async () => {
  const root = workspace();
  try {
    const report = await produceEvidence(root, { withdraw: true });
    const lifecycle = report.lifecycle as { transitions: Array<Record<string, unknown>> };
    assert(lifecycle.transitions.length > 0, 'report has at least one transition');
    lifecycle.transitions[0]!.evidence = '/mnt/user/media/Movies/Secret (2026)/Secret (2026).mp4';
    const review = reviewPromotionEvidence(reseal(report));
    assert(!review.ok, 'rejected');
    assert(review.problems.includes('RAW_PATH_LEAK_SUSPECTED'), 'raw path leak problem');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('rejects a raw path smuggled into file.extension', async () => {
  const root = workspace();
  try {
    const report = await produceEvidence(root, { withdraw: true });
    (report.file as Record<string, unknown>).extension = '/mnt/user/media/Movies/Secret.mp4';
    const review = reviewPromotionEvidence(reseal(report));
    assert(!review.ok, 'rejected');
    assert(review.problems.includes('RAW_PATH_LEAK_SUSPECTED'), 'raw path leak problem under file.extension');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('rejects a raw path smuggled into a nested extension field', async () => {
  const root = workspace();
  try {
    const report = await produceEvidence(root, { withdraw: true });
    (report.file as Record<string, unknown>).nested = { extension: 'C:\\secret\\movie.mp4' };
    const review = reviewPromotionEvidence(reseal(report));
    assert(!review.ok, 'rejected');
    assert(review.problems.includes('RAW_PATH_LEAK_SUSPECTED'), 'raw path leak problem under a nested extension');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('still accepts a genuine report whose extension is a safe media enum', async () => {
  const root = workspace();
  try {
    const report = await produceEvidence(root, { withdraw: true });
    assertEq((report.file as Record<string, unknown>).extension, '.mp4', 'fixture uses a safe extension enum');
    const review = reviewPromotionEvidence(report);
    assert(review.ok, `safe extension still accepted (problems: ${review.problems.join(',')})`);
    assert(review.checks.noRawPathLeak, 'no false-positive leak on a valid extension');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('rejects a non-promotion / malformed document without throwing', () => {
  for (const bogus of [null, 42, 'nope', {}, { report: 'something-else', version: 1 }]) {
    const review = reviewPromotionEvidence(bogus);
    assert(!review.ok, 'malformed rejected');
    assert(review.problems.includes('REPORT_TYPE_INVALID'), 'report-type problem');
  }
});

await test('the review record is itself redaction-safe', async () => {
  const root = workspace();
  try {
    const report = await produceEvidence(root, { withdraw: true });
    const review = reviewPromotionEvidence(report);
    const serialized = JSON.stringify(review);
    assert(review.redactionSafe === true, 'flagged redaction-safe');
    assert(!serialized.includes('/mnt/'), 'no unix path in review');
    assert(!serialized.includes('catalog-authority-test-library'), 'no test-library path in review');
    assert(/^[0-9a-f]{64}$/.test(review.reviewDigest), 'review digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
