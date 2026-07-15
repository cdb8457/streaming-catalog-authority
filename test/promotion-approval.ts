import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildApprovalAttestation,
  validateApprovalAttestation,
} from '../src/ops/promotion-approval.js';
import {
  buildPromotionDestination,
  runRealLibraryPromotion,
  type RealLibraryVisibilityClient,
} from '../src/ops/real-library-promotion.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'catalog-approval-'));
}

const MINIMAL_MP4_FIXTURE = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isomcatalog-authority-approval-fixture', 'ascii'),
]);

function sourceInTestLibrary(root: string, name = 'source.mp4', body: string | Buffer = MINIMAL_MP4_FIXTURE): { source: string; testRoot: string } {
  const testRoot = join(root, 'catalog-authority-test-library');
  const source = join(testRoot, 'Movies', 'Approval Proof (2026)', name);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, body);
  return { source, testRoot };
}

const now = (() => {
  let i = 0;
  return () => new Date(Date.UTC(2026, 6, 15, 2, 0, i++));
})();

console.log('Running Phase 230 promotion approval-attestation suite:\n');

await test('build produces a complete binding for a valid test-library source', () => {
  const root = workspace();
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    const targetRoot = join(root, 'Movies');
    const result = buildApprovalAttestation({
      itemId: '11111111-1111-4111-8111-111111111111',
      title: 'Approval Proof',
      year: 2026,
      sourceFile: source,
      testLibraryRoot: testRoot,
      targetRoot,
      approvalId: 'approval-build-1',
    });
    assert(result.ok, 'build ok');
    const a = result.approval!;
    assertEq(a.itemId, '11111111-1111-4111-8111-111111111111', 'itemId bound');
    assertEq(a.targetRoot, targetRoot, 'targetRoot bound');
    assertEq(a.destinationPath, buildPromotionDestination({ title: 'Approval Proof', year: 2026, sourceFile: source, targetRoot }), 'destination bound');
    assertEq(a.sourceSha256.length, 64, 'sha256 present');
    assert(a.sourceRealPath.length > 0, 'source real path present');
    assertEq(result.evidence.status, 'APPROVAL_ATTESTATION_READY', 'evidence ready');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('a built attestation is exactly what the promotion service accepts (non-live, mock observer)', async () => {
  const root = workspace();
  const targetRoot = join(root, 'Movies');
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    mkdirSync(targetRoot, { recursive: true });
    const built = buildApprovalAttestation({
      itemId: '22222222-2222-4222-8222-222222222222',
      title: 'Approval Proof',
      year: 2026,
      sourceFile: source,
      testLibraryRoot: testRoot,
      targetRoot,
      approvalId: 'approval-build-2',
    });
    assert(built.ok, 'attestation built');
    const fileStateClient: RealLibraryVisibilityClient = {
      async findVisibleItem({ destinationPath }) {
        return existsSync(destinationPath) ? { visible: true, itemId: 'jf', matchBasis: 'path' } : { visible: false };
      },
    };
    const report = await runRealLibraryPromotion({
      itemId: '22222222-2222-4222-8222-222222222222',
      title: 'Approval Proof',
      year: 2026,
      sourceFile: source,
      testLibraryRoot: testRoot,
      targetRoot,
      approval: { approved: true, ...built.approval! },
      allowCustomTargetRootForTests: true,
      visibilityClient: fileStateClient,
      visibilityPolls: 1,
      visibilityPollMs: 0,
      now,
    });
    // The service accepts the binding (never PROMOTION_APPROVAL_*): it reaches observed visibility.
    assert(!report.lifecycle.transitions.some((t) => t.failureCode === 'PROMOTION_APPROVAL_REQUIRED' || t.failureCode === 'PROMOTION_APPROVAL_MISMATCH'), 'approval binding accepted');
    assertEq(report.status, 'REAL_LIBRARY_PROMOTION_VISIBLE', 'promotion reaches observed visibility with the built approval');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('build then validate round-trips ok', () => {
  const root = workspace();
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    const targetRoot = join(root, 'Movies');
    const input = { itemId: '33333333-3333-4333-8333-333333333333', title: 'Approval Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot };
    const built = buildApprovalAttestation({ ...input, approvalId: 'approval-3' });
    assert(built.ok, 'built');
    const validated = validateApprovalAttestation(built.approval, input);
    assert(validated.ok, 'validate ok');
    assertEq(validated.evidence.problems.length, 0, 'no problems');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('validate fails closed on a mismatched item id', () => {
  const root = workspace();
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    const targetRoot = join(root, 'Movies');
    const built = buildApprovalAttestation({ itemId: '44444444-4444-4444-8444-444444444444', title: 'Approval Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot, approvalId: 'approval-4' });
    const validated = validateApprovalAttestation(built.approval, { itemId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', title: 'Approval Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot });
    assert(!validated.ok, 'mismatched item fails');
    assert(validated.evidence.problems.includes('ITEM_ID_MISMATCH'), 'item mismatch problem');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('validate fails closed on a tampered source checksum', () => {
  const root = workspace();
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    const targetRoot = join(root, 'Movies');
    const input = { itemId: '55555555-5555-4555-8555-555555555555', title: 'Approval Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot };
    const built = buildApprovalAttestation({ ...input, approvalId: 'approval-5' });
    const tampered = { ...built.approval!, sourceSha256: 'deadbeef'.repeat(8) };
    const validated = validateApprovalAttestation(tampered, input);
    assert(!validated.ok, 'tampered checksum fails');
    assert(validated.evidence.problems.includes('SOURCE_CHECKSUM_MISMATCH'), 'checksum mismatch problem');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('validate fails closed on a destination that does not match the title/year', () => {
  const root = workspace();
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    const targetRoot = join(root, 'Movies');
    const built = buildApprovalAttestation({ itemId: '66666666-6666-4666-8666-666666666666', title: 'Approval Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot, approvalId: 'approval-6' });
    // Same approval, but validated against a different declared title -> destination diverges.
    const validated = validateApprovalAttestation(built.approval, { itemId: '66666666-6666-4666-8666-666666666666', title: 'Different Title', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot });
    assert(!validated.ok, 'destination divergence fails');
    assert(validated.evidence.problems.includes('DESTINATION_PATH_MISMATCH'), 'destination mismatch problem');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('validate reports every missing binding field', () => {
  const root = workspace();
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    const targetRoot = join(root, 'Movies');
    const validated = validateApprovalAttestation({}, { itemId: '77777777-7777-4777-8777-777777777777', title: 'Approval Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot });
    assert(!validated.ok, 'empty approval fails');
    for (const code of ['MISSING_APPROVAL_ID', 'MISSING_ITEM_ID', 'MISSING_TARGET_ROOT', 'MISSING_SOURCE_REAL_PATH', 'MISSING_SOURCE_SHA256', 'MISSING_DESTINATION_PATH']) {
      assert(validated.evidence.problems.includes(code as never), `reports ${code}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('build fails for a source outside the isolated test library', () => {
  const root = workspace();
  try {
    const { testRoot } = sourceInTestLibrary(root);
    const outside = join(root, 'elsewhere', 'stray.mp4');
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(outside, MINIMAL_MP4_FIXTURE);
    const result = buildApprovalAttestation({ itemId: '88888888-8888-4888-8888-888888888888', title: 'Stray', year: 2026, sourceFile: outside, testLibraryRoot: testRoot, targetRoot: join(root, 'Movies'), approvalId: 'approval-8' });
    assert(!result.ok, 'outside source rejected');
    assert(result.approval === undefined, 'no approval emitted for an invalid source');
    assert(result.evidence.problems.includes('SOURCE_OUTSIDE_TEST_LIBRARY'), 'outside-library problem');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('build fails for a symlinked source', () => {
  const root = workspace();
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    const link = join(testRoot, 'Movies', 'Approval Proof (2026)', 'link.mp4');
    let linked = true;
    try { symlinkSync(source, link); } catch { linked = false; console.log('    (skipped: symlink creation not permitted)'); }
    if (!linked) return;
    const result = buildApprovalAttestation({ itemId: '99999999-9999-4999-8999-999999999999', title: 'Approval Proof', year: 2026, sourceFile: link, testLibraryRoot: testRoot, targetRoot: join(root, 'Movies'), approvalId: 'approval-9' });
    assert(!result.ok, 'symlinked source rejected');
    assert(result.evidence.problems.includes('SOURCE_IS_SYMLINK'), 'symlink problem');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('build rejects a symlinked test-library root (mirrors the promotion service)', () => {
  const root = workspace();
  try {
    // Real test library holding the source, plus a junction standing in as the test-library root.
    const realTestLib = join(root, 'real-test-library');
    const source = join(realTestLib, 'Movies', 'Approval Proof (2026)', 'source.mp4');
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, MINIMAL_MP4_FIXTURE);
    const junctionRoot = join(root, 'catalog-authority-test-library');
    let linked = true;
    try { symlinkSync(realTestLib, junctionRoot, 'junction'); } catch { linked = false; console.log('    (skipped: symlink creation not permitted)'); }
    if (!linked) return;
    const sourceViaJunction = join(junctionRoot, 'Movies', 'Approval Proof (2026)', 'source.mp4');
    const result = buildApprovalAttestation({
      itemId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      title: 'Approval Proof',
      year: 2026,
      sourceFile: sourceViaJunction,
      testLibraryRoot: junctionRoot,
      targetRoot: join(root, 'Movies'),
      approvalId: 'approval-symlink-root',
    });
    assert(!result.ok, 'symlinked test-library root rejected');
    assert(result.approval === undefined, 'no approval emitted through a symlinked root');
    assert(result.evidence.problems.includes('SOURCE_SYMLINK_COMPONENT'), 'symlink component problem');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('build rejects a symlinked intermediate component in the source path', () => {
  const root = workspace();
  try {
    const testRoot = join(root, 'catalog-authority-test-library'); // real root
    mkdirSync(testRoot, { recursive: true });
    // The source lives outside the test library; a junction inside the root points to it.
    const outsideMovies = join(root, 'outside-movies');
    const source = join(outsideMovies, 'Approval Proof (2026)', 'source.mp4');
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, MINIMAL_MP4_FIXTURE);
    const moviesLink = join(testRoot, 'Movies');
    let linked = true;
    try { symlinkSync(outsideMovies, moviesLink, 'junction'); } catch { linked = false; console.log('    (skipped: symlink creation not permitted)'); }
    if (!linked) return;
    const sourceViaLink = join(moviesLink, 'Approval Proof (2026)', 'source.mp4');
    const result = buildApprovalAttestation({
      itemId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      title: 'Approval Proof',
      year: 2026,
      sourceFile: sourceViaLink,
      testLibraryRoot: testRoot,
      targetRoot: join(root, 'Movies'),
      approvalId: 'approval-symlink-ancestor',
    });
    assert(!result.ok, 'symlinked intermediate component rejected');
    assert(result.approval === undefined, 'no approval emitted through a symlinked ancestor');
    assert(result.evidence.problems.includes('SOURCE_SYMLINK_COMPONENT'), 'symlink component problem');
    // The real file behind the junction must not be reachable as an approved source.
    assertEq(existsSync(source), true, 'the out-of-tree file itself is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('validate also rejects a symlinked intermediate component', () => {
  const root = workspace();
  try {
    const testRoot = join(root, 'catalog-authority-test-library');
    mkdirSync(testRoot, { recursive: true });
    const outsideMovies = join(root, 'outside-movies');
    const source = join(outsideMovies, 'Approval Proof (2026)', 'source.mp4');
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, MINIMAL_MP4_FIXTURE);
    const moviesLink = join(testRoot, 'Movies');
    let linked = true;
    try { symlinkSync(outsideMovies, moviesLink, 'junction'); } catch { linked = false; console.log('    (skipped: symlink creation not permitted)'); }
    if (!linked) return;
    const sourceViaLink = join(moviesLink, 'Approval Proof (2026)', 'source.mp4');
    // A hand-authored approval that is otherwise well-formed must still be refused because the
    // source is reached through a symlink — validation mirrors the service's containment.
    const approval = {
      approvalId: 'approval-x',
      itemId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      targetRoot: join(root, 'Movies'),
      sourceRealPath: sourceViaLink,
      sourceSha256: 'a'.repeat(64),
      destinationPath: buildPromotionDestination({ title: 'Approval Proof', year: 2026, sourceFile: sourceViaLink, targetRoot: join(root, 'Movies') }),
    };
    const validated = validateApprovalAttestation(approval, {
      itemId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      title: 'Approval Proof',
      year: 2026,
      sourceFile: sourceViaLink,
      testLibraryRoot: testRoot,
      targetRoot: join(root, 'Movies'),
    });
    assert(!validated.ok, 'validate rejects a symlink-reached source');
    assert(validated.evidence.problems.includes('SOURCE_SYMLINK_COMPONENT'), 'symlink component problem on validate');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('build fails for a disallowed source extension', () => {
  const root = workspace();
  try {
    const { testRoot } = sourceInTestLibrary(root, 'notes.txt', 'plain text');
    const source = join(testRoot, 'Movies', 'Approval Proof (2026)', 'notes.txt');
    const result = buildApprovalAttestation({ itemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Approval Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot: join(root, 'Movies'), approvalId: 'approval-10' });
    assert(!result.ok, 'txt source rejected');
    assert(result.evidence.problems.includes('SOURCE_EXTENSION_NOT_ALLOWED'), 'extension problem');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('evidence is redaction-safe: no raw title, source path, or destination path', () => {
  const root = workspace();
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    const targetRoot = join(root, 'Movies');
    const built = buildApprovalAttestation({ itemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Secret Working Title', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot, approvalId: 'approval-secret-id' });
    assert(built.ok, 'built');
    const serialized = JSON.stringify(built.evidence);
    assert(built.evidence.redactionSafe === true, 'flagged redaction-safe');
    assert(!serialized.includes('Secret Working Title'), 'title not echoed');
    assert(!serialized.includes(source), 'raw source path not echoed');
    assert(!serialized.includes(built.approval!.destinationPath), 'raw destination path not echoed');
    assert(!serialized.includes('approval-secret-id'), 'raw approval id not echoed');
    // Digests are present instead.
    assert(built.evidence.destinationPathDigest !== undefined && built.evidence.itemDigest.length === 64, 'digests present');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
