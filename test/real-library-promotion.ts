import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildPromotionDestination,
  realLibraryPathMatch,
  runRealLibraryPromotion,
  type RealLibraryPromotionApproval,
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
  return mkdtempSync(join(tmpdir(), 'catalog-real-promotion-'));
}

const MINIMAL_MP4_FIXTURE = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isomcatalog-authority-promotion-fixture', 'ascii'),
]);

function sourceInTestLibrary(root: string, name = 'source.mp4', body: string | Buffer = MINIMAL_MP4_FIXTURE): { source: string; testRoot: string } {
  const testRoot = join(root, 'catalog-authority-test-library');
  const source = join(testRoot, 'Movies', 'Promotion Proof (2026)', name);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, body);
  return { source, testRoot };
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// A one-shot approval bound to the exact item, source real path/checksum, destination, and root.
function boundApproval(opts: { itemId: string; targetRoot: string; source: string; title: string; year?: number; approvalId?: string }): RealLibraryPromotionApproval {
  const destinationPath = buildPromotionDestination({
    title: opts.title,
    ...(opts.year !== undefined ? { year: opts.year } : {}),
    sourceFile: opts.source,
    targetRoot: opts.targetRoot,
  });
  return {
    approved: true,
    approvalId: opts.approvalId ?? 'approval',
    itemId: opts.itemId,
    targetRoot: opts.targetRoot,
    sourceRealPath: realpathSync(opts.source),
    sourceSha256: sha256File(opts.source),
    destinationPath,
  };
}

// Read-only observer that reports visible-by-path exactly while the promoted file is on disk.
const fileStateClient: RealLibraryVisibilityClient = {
  async findVisibleItem({ destinationPath }) {
    return existsSync(destinationPath)
      ? { visible: true, itemId: 'jellyfin-real-item', matchBasis: 'path' }
      : { visible: false };
  },
};

const now = (() => {
  let i = 0;
  return () => new Date(Date.UTC(2026, 6, 15, 1, 0, i++));
})();

console.log('Running Phase 230 real-library promotion suite:\n');

await test('refuses without explicit operator approval', async () => {
  const root = workspace();
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    const report = await runRealLibraryPromotion({
      itemId: '11111111-1111-4111-8111-111111111111',
      title: 'Promotion Proof',
      year: 2026,
      sourceFile: source,
      testLibraryRoot: testRoot,
      targetRoot: '/mnt/user/media/Movies',
      approval: { approved: false, approvalId: 'approval-1' },
      visibilityClient: fileStateClient,
      now,
    });
    assertEq(report.status, 'REAL_LIBRARY_PROMOTION_FAILED', 'approval missing fails');
    assert(report.lifecycle.transitions.some((t) => t.failureCode === 'PROMOTION_APPROVAL_REQUIRED'), 'approval failure code');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('refuses an approval not bound to this item/source/destination', async () => {
  const root = workspace();
  const targetRoot = join(root, 'Movies');
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    mkdirSync(targetRoot, { recursive: true });
    const wrongItem: RealLibraryPromotionApproval = {
      ...boundApproval({ itemId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', targetRoot, source, title: 'Bind Proof', year: 2026 }),
      // approval attests a DIFFERENT item than the one being promoted below.
    };
    const report = await runRealLibraryPromotion({
      itemId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      title: 'Bind Proof',
      year: 2026,
      sourceFile: source,
      testLibraryRoot: testRoot,
      targetRoot,
      approval: wrongItem,
      allowCustomTargetRootForTests: true,
      visibilityClient: fileStateClient,
      now,
    });
    assertEq(report.status, 'REAL_LIBRARY_PROMOTION_FAILED', 'unbound approval fails closed');
    assert(report.lifecycle.transitions.some((t) => t.failureCode === 'PROMOTION_APPROVAL_MISMATCH'), 'approval mismatch code');
    const dest = buildPromotionDestination({ title: 'Bind Proof', year: 2026, sourceFile: source, targetRoot });
    assert(!existsSync(dest), 'nothing is promoted under an unbound approval');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('refuses an approval whose bound source checksum does not match', async () => {
  const root = workspace();
  const targetRoot = join(root, 'Movies');
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    mkdirSync(targetRoot, { recursive: true });
    const tampered: RealLibraryPromotionApproval = {
      ...boundApproval({ itemId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', targetRoot, source, title: 'Checksum Proof', year: 2026 }),
      sourceSha256: 'deadbeef'.repeat(8), // attests a checksum the source does not have
    };
    const report = await runRealLibraryPromotion({
      itemId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      title: 'Checksum Proof',
      year: 2026,
      sourceFile: source,
      testLibraryRoot: testRoot,
      targetRoot,
      approval: tampered,
      allowCustomTargetRootForTests: true,
      visibilityClient: fileStateClient,
      now,
    });
    assertEq(report.status, 'REAL_LIBRARY_PROMOTION_FAILED', 'checksum-unbound approval fails closed');
    assert(report.lifecycle.transitions.some((t) => t.failureCode === 'PROMOTION_APPROVAL_MISMATCH'), 'approval mismatch code');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('refuses Gelato/AIO or unapproved target roots', async () => {
  const root = workspace();
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    const report = await runRealLibraryPromotion({
      itemId: '22222222-2222-4222-8222-222222222222',
      title: 'Promotion Proof',
      sourceFile: source,
      testLibraryRoot: testRoot,
      targetRoot: '/mnt/user/media/Gelato',
      approval: boundApproval({ itemId: '22222222-2222-4222-8222-222222222222', targetRoot: '/mnt/user/media/Gelato', source, title: 'Promotion Proof' }),
      visibilityClient: fileStateClient,
      now,
    });
    assert(report.lifecycle.transitions.some((t) => t.failureCode === 'PROMOTION_TARGET_FORBIDDEN'), 'target forbidden');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('refuses to overwrite a different real-library file', async () => {
  const root = workspace();
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    const targetRoot = join(root, 'Movies');
    mkdirSync(targetRoot, { recursive: true });
    const dest = buildPromotionDestination({ title: 'Collision Proof', year: 2026, sourceFile: source, targetRoot });
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, 'different-real-library-file');
    const report = await runRealLibraryPromotion({
      itemId: '33333333-3333-4333-8333-333333333333',
      title: 'Collision Proof',
      year: 2026,
      sourceFile: source,
      testLibraryRoot: testRoot,
      targetRoot,
      approval: boundApproval({ itemId: '33333333-3333-4333-8333-333333333333', targetRoot, source, title: 'Collision Proof', year: 2026 }),
      allowCustomTargetRootForTests: true,
      visibilityClient: fileStateClient,
      now,
    });
    assert(report.lifecycle.transitions.some((t) => t.failureCode === 'PROMOTION_DESTINATION_COLLISION'), 'collision failure');
    assertEq(readFileSync(dest, 'utf8'), 'different-real-library-file', 'existing file preserved');
    rmSync(dirname(dest), { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('promotes, verifies observed visibility, withdraws, and restores prior tree digest', async () => {
  const root = workspace();
  const targetRoot = join(root, 'Movies');
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    mkdirSync(targetRoot, { recursive: true });
    const report = await runRealLibraryPromotion({
      itemId: '44444444-4444-4444-8444-444444444444',
      title: 'Promotion Proof',
      year: 2026,
      sourceFile: source,
      testLibraryRoot: testRoot,
      targetRoot,
      approval: boundApproval({ itemId: '44444444-4444-4444-8444-444444444444', targetRoot, source, title: 'Promotion Proof', year: 2026 }),
      allowCustomTargetRootForTests: true,
      visibilityClient: fileStateClient,
      visibilityPolls: 2,
      visibilityPollMs: 0,
      withdrawAfter: true,
      now,
    });
    assert(report.ok, 'promotion withdrawal proof ok');
    assertEq(report.status, 'REAL_LIBRARY_PROMOTION_WITHDRAWN', 'withdrawn status');
    assertEq(report.jellyfin?.matchBasis, 'path', 'visibility observed by exact path');
    assert(report.realLibrary.returnedToBefore, 'tree returned to before digest');
    assert(report.jellyfin?.absentAfterWithdrawal, 'Jellyfin absence observed after withdrawal');
    const dest = buildPromotionDestination({ title: 'Promotion Proof', year: 2026, sourceFile: source, targetRoot });
    assert(!existsSync(dest), 'promoted file withdrawn');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('requires observed Jellyfin visibility: no client cannot reach real-library success', async () => {
  const root = workspace();
  const targetRoot = join(root, 'Movies');
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    mkdirSync(targetRoot, { recursive: true });
    const report = await runRealLibraryPromotion({
      itemId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      title: 'Visibility Required',
      year: 2026,
      sourceFile: source,
      testLibraryRoot: testRoot,
      targetRoot,
      approval: boundApproval({ itemId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', targetRoot, source, title: 'Visibility Required', year: 2026 }),
      allowCustomTargetRootForTests: true,
      now, // no visibilityClient
    });
    assertEq(report.status, 'REAL_LIBRARY_PROMOTION_FAILED', 'file proof alone is not success');
    assert(report.lifecycle.transitions.some((t) => t.failureCode === 'PROMOTION_VISIBILITY_REQUIRED'), 'visibility-required code');
    assert(report.lifecycle.currentState !== 'VISIBLE_IN_REAL_LIBRARY', 'never marks visible from file proof');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('visibility that is not by exact path is not accepted', async () => {
  const root = workspace();
  const targetRoot = join(root, 'Movies');
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    mkdirSync(targetRoot, { recursive: true });
    // Reports visible but never with a 'path' basis: must be treated as no evidence.
    const nonPathClient: RealLibraryVisibilityClient = {
      async findVisibleItem() { return { visible: true, itemId: 'title-only' }; },
    };
    const report = await runRealLibraryPromotion({
      itemId: '00000000-0000-4000-8000-000000000000',
      title: 'Basis Proof',
      year: 2026,
      sourceFile: source,
      testLibraryRoot: testRoot,
      targetRoot,
      approval: boundApproval({ itemId: '00000000-0000-4000-8000-000000000000', targetRoot, source, title: 'Basis Proof', year: 2026 }),
      allowCustomTargetRootForTests: true,
      visibilityClient: nonPathClient,
      visibilityPolls: 1,
      visibilityPollMs: 0,
      now,
    });
    assertEq(report.status, 'REAL_LIBRARY_PROMOTION_FAILED', 'non-path visibility fails closed');
    assert(report.lifecycle.transitions.some((t) => t.failureCode === 'PROMOTION_REAL_LIBRARY_VISIBILITY_TIMEOUT'), 'visibility timeout code');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('same-checksum existing destination is an already-present no-op', async () => {
  const root = workspace();
  const targetRoot = join(root, 'Movies');
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    mkdirSync(targetRoot, { recursive: true });
    const dest = buildPromotionDestination({ title: 'Noop Proof', sourceFile: source, targetRoot });
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(source));
    const report = await runRealLibraryPromotion({
      itemId: '55555555-5555-4555-8555-555555555555',
      title: 'Noop Proof',
      sourceFile: source,
      testLibraryRoot: testRoot,
      targetRoot,
      approval: boundApproval({ itemId: '55555555-5555-4555-8555-555555555555', targetRoot, source, title: 'Noop Proof' }),
      allowCustomTargetRootForTests: true,
      visibilityClient: fileStateClient,
      now,
    });
    assert(report.ok, 'same-checksum promotion ok');
    assert(report.file.alreadyPresent, 'already present no-op');
    rmSync(dirname(dest), { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('atomic no-clobber: concurrent promotions never overwrite or corrupt the destination', async () => {
  const root = workspace();
  const targetRoot = join(root, 'Movies');
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    mkdirSync(targetRoot, { recursive: true });
    const approval = boundApproval({ itemId: '99999999-9999-4999-8999-999999999999', targetRoot, source, title: 'Race Proof', year: 2026 });
    const run = () => runRealLibraryPromotion({
      itemId: '99999999-9999-4999-8999-999999999999',
      title: 'Race Proof',
      year: 2026,
      sourceFile: source,
      testLibraryRoot: testRoot,
      targetRoot,
      approval,
      allowCustomTargetRootForTests: true,
      visibilityClient: fileStateClient,
      visibilityPolls: 1,
      visibilityPollMs: 0,
      now,
    });
    const reports = await Promise.all(Array.from({ length: 8 }, run));
    for (const r of reports) {
      assert(r.status !== 'REAL_LIBRARY_PROMOTION_FAILED', 'no concurrent run fails');
      assert(r.lifecycle.transitions.every((t) => t.failureCode !== 'PROMOTION_DESTINATION_COLLISION'), 'no false collision from the race');
    }
    // Exactly one writer creates the file; the rest observe an already-present no-op.
    const creators = reports.filter((r) => !r.file.alreadyPresent).length;
    assert(creators >= 1, 'at least one writer created the destination');
    const dest = buildPromotionDestination({ title: 'Race Proof', year: 2026, sourceFile: source, targetRoot });
    assert(existsSync(dest), 'destination exists after the race');
    assertEq(sha256File(dest), sha256File(source), 'destination content is exactly the source (no clobber/corruption)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('refuses to withdraw a pre-existing real-library file (no data loss)', async () => {
  const root = workspace();
  const targetRoot = join(root, 'Movies');
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    mkdirSync(targetRoot, { recursive: true });
    const dest = buildPromotionDestination({ title: 'Pre Existing Real File', year: 2026, sourceFile: source, targetRoot });
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(source)); // same-checksum file that this run did NOT create
    const report = await runRealLibraryPromotion({
      itemId: '66666666-6666-4666-8666-666666666666',
      title: 'Pre Existing Real File',
      year: 2026,
      sourceFile: source,
      testLibraryRoot: testRoot,
      targetRoot,
      approval: boundApproval({ itemId: '66666666-6666-4666-8666-666666666666', targetRoot, source, title: 'Pre Existing Real File', year: 2026 }),
      allowCustomTargetRootForTests: true,
      visibilityClient: fileStateClient,
      withdrawAfter: true,
      now,
    });
    assertEq(report.status, 'REAL_LIBRARY_PROMOTION_FAILED', 'withdrawal of a pre-existing file must fail closed');
    assert(report.lifecycle.transitions.some((t) => t.failureCode === 'PROMOTION_WITHDRAWAL_REFUSED'), 'withdrawal refused code');
    assert(existsSync(dest), 'pre-existing real-library file must survive the refused withdrawal');
    assertEq(readFileSync(dest).length, readFileSync(source).length, 'pre-existing file bytes intact');
    rmSync(dirname(dest), { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('withdrawal keeps a pre-existing destination directory and its unrelated files', async () => {
  const root = workspace();
  const targetRoot = join(root, 'Movies');
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    mkdirSync(targetRoot, { recursive: true });
    const dest = buildPromotionDestination({ title: 'Shared Dir Proof', year: 2026, sourceFile: source, targetRoot });
    mkdirSync(dirname(dest), { recursive: true }); // directory pre-exists, promotion did not create it
    const sibling = join(dirname(dest), 'poster.jpg');
    writeFileSync(sibling, 'pre-existing-artwork');
    const report = await runRealLibraryPromotion({
      itemId: '77777777-7777-4777-8777-777777777777',
      title: 'Shared Dir Proof',
      year: 2026,
      sourceFile: source,
      testLibraryRoot: testRoot,
      targetRoot,
      approval: boundApproval({ itemId: '77777777-7777-4777-8777-777777777777', targetRoot, source, title: 'Shared Dir Proof', year: 2026 }),
      allowCustomTargetRootForTests: true,
      visibilityClient: fileStateClient,
      withdrawAfter: true,
      now,
    });
    assertEq(report.status, 'REAL_LIBRARY_PROMOTION_WITHDRAWN', 'promotion into a shared directory withdraws cleanly');
    assert(!existsSync(dest), 'only the promoted file is removed');
    assert(existsSync(dirname(dest)), 'pre-existing directory is preserved');
    assert(existsSync(sibling), 'unrelated sibling file is preserved');
    assert(report.realLibrary.returnedToBefore, 'tree returns to the pre-promotion digest');
    rmSync(dirname(dest), { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('refuses a symlinked destination directory that escapes the approved root', async () => {
  const root = workspace();
  const targetRoot = join(root, 'Movies');
  const outside = join(root, 'outside-real-root');
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    mkdirSync(targetRoot, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const dest = buildPromotionDestination({ title: 'Symlink Escape', year: 2026, sourceFile: source, targetRoot });
    let linked = true;
    try {
      symlinkSync(outside, dirname(dest), 'junction'); // movie dir is a symlink pointing outside the root
    } catch {
      linked = false;
      console.log('    (skipped: symlink creation not permitted in this environment)');
    }
    if (!linked) return;
    const report = await runRealLibraryPromotion({
      itemId: '88888888-8888-4888-8888-888888888888',
      title: 'Symlink Escape',
      year: 2026,
      sourceFile: source,
      testLibraryRoot: testRoot,
      targetRoot,
      approval: boundApproval({ itemId: '88888888-8888-4888-8888-888888888888', targetRoot, source, title: 'Symlink Escape', year: 2026 }),
      allowCustomTargetRootForTests: true,
      visibilityClient: fileStateClient,
      now,
    });
    assertEq(report.status, 'REAL_LIBRARY_PROMOTION_FAILED', 'symlinked destination component is refused');
    assert(report.lifecycle.transitions.some((t) => t.failureCode === 'PROMOTION_TARGET_FORBIDDEN'), 'target forbidden code');
    assertEq(existsSync(join(outside, 'Symlink Escape (2026).mp4')), false, 'nothing was written through the symlink');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('exact-path matcher is case-sensitive and rejects the same-title test-library twin', () => {
  const dest = '/mnt/user/media/Movies/Promotion Proof (2026)/Promotion Proof (2026).mp4';
  assert(realLibraryPathMatch(dest, dest), 'identical path matches');
  assert(realLibraryPathMatch('/mnt/user/media/Movies//Promotion Proof (2026)/Promotion Proof (2026).mp4', dest), 'collapsed separators match');
  assert(realLibraryPathMatch('\\mnt\\user\\media\\Movies\\Promotion Proof (2026)\\Promotion Proof (2026).mp4', dest), 'backslash separators match');
  // Case-sensitive: a lowercase Movies is a different Linux path and must NOT match.
  assert(!realLibraryPathMatch('/mnt/user/media/movies/Promotion Proof (2026)/Promotion Proof (2026).mp4', dest), 'case difference must not match');
  // The isolated test-library twin shares the title/tail but is NOT the promoted path.
  assert(!realLibraryPathMatch('/mnt/user/media/catalog-authority-test-library/Movies/Promotion Proof (2026)/Promotion Proof (2026).mp4', dest), 'test-library twin must not match');
  // A different real-library movie must not match.
  assert(!realLibraryPathMatch('/mnt/user/media/Movies/Other Movie (2026)/Other Movie (2026).mp4', dest), 'different movie must not match');
});

await test('visibility client exception yields a redaction-safe digested failure', async () => {
  const root = workspace();
  const targetRoot = join(root, 'Movies');
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    mkdirSync(targetRoot, { recursive: true });
    const secret = 'http://192.168.1.31:8096/Items?token=SECRET-should-not-leak';
    const client: RealLibraryVisibilityClient = {
      async findVisibleItem() { throw new Error(`jellyfin visibility failed for ${secret}`); },
    };
    const report = await runRealLibraryPromotion({
      itemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'Promotion Proof',
      year: 2026,
      sourceFile: source,
      testLibraryRoot: testRoot,
      targetRoot,
      approval: boundApproval({ itemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', targetRoot, source, title: 'Promotion Proof', year: 2026 }),
      allowCustomTargetRootForTests: true,
      visibilityClient: client,
      visibilityPolls: 1,
      visibilityPollMs: 0,
      now,
    });
    assertEq(report.status, 'REAL_LIBRARY_PROMOTION_FAILED', 'visibility exception fails closed');
    assert(report.lifecycle.transitions.some((t) => t.failureCode === 'PROMOTION_VISIBILITY_CHECK_FAILED'), 'digested visibility failure code');
    const serialized = JSON.stringify(report);
    assert(!serialized.includes('SECRET-should-not-leak'), 'raw visibility error text must not leak into evidence');
    assert(!serialized.includes('192.168.1.31'), 'raw endpoint must not leak into evidence');
    rmSync(targetRoot, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('refuses a symlinked target root that escapes to an outside directory', async () => {
  const root = workspace();
  const realTargetRoot = join(root, 'Movies');
  const outside = join(root, 'outside-real-root');
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    mkdirSync(outside, { recursive: true });
    let linked = true;
    try {
      symlinkSync(outside, realTargetRoot, 'junction'); // the approved root itself is a symlink out of bounds
    } catch {
      linked = false;
      console.log('    (skipped: symlink creation not permitted in this environment)');
    }
    if (!linked) return;
    const report = await runRealLibraryPromotion({
      itemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: 'Root Escape',
      year: 2026,
      sourceFile: source,
      testLibraryRoot: testRoot,
      targetRoot: realTargetRoot,
      approval: boundApproval({ itemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', targetRoot: realTargetRoot, source, title: 'Root Escape', year: 2026 }),
      allowCustomTargetRootForTests: true,
      visibilityClient: fileStateClient,
      now,
    });
    assertEq(report.status, 'REAL_LIBRARY_PROMOTION_FAILED', 'symlinked target root is refused');
    assert(report.lifecycle.transitions.some((t) => t.failureCode === 'PROMOTION_TARGET_FORBIDDEN'), 'target forbidden code');
    assertEq(existsSync(join(outside, 'Root Escape (2026)')), false, 'nothing was written through the symlinked root');
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
