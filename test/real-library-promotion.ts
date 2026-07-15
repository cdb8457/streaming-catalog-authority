import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
      now,
    });
    assertEq(report.status, 'REAL_LIBRARY_PROMOTION_FAILED', 'approval missing fails');
    assert(report.lifecycle.transitions.some((t) => t.failureCode === 'PROMOTION_APPROVAL_REQUIRED'), 'approval failure code');
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
      approval: { approved: true, approvalId: 'approval-2' },
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
      approval: { approved: true, approvalId: 'approval-3' },
      allowCustomTargetRootForTests: true,
      now,
    });
    assert(report.lifecycle.transitions.some((t) => t.failureCode === 'PROMOTION_DESTINATION_COLLISION'), 'collision failure');
    assertEq(readFileSync(dest, 'utf8'), 'different-real-library-file', 'existing file preserved');
    rmSync(dirname(dest), { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('promotes, verifies visibility, withdraws, and restores prior tree digest', async () => {
  const root = workspace();
  const targetRoot = join(root, 'Movies');
  try {
    const { source, testRoot } = sourceInTestLibrary(root);
    mkdirSync(targetRoot, { recursive: true });
    let calls = 0;
    const client: RealLibraryVisibilityClient = {
      async findVisibleItem() {
        calls += 1;
        return calls < 2
          ? { visible: true, itemId: 'jellyfin-real-item', matchBasis: 'path' }
          : { visible: false };
      },
    };
    const report = await runRealLibraryPromotion({
      itemId: '44444444-4444-4444-8444-444444444444',
      title: 'Promotion Proof',
      year: 2026,
      sourceFile: source,
      testLibraryRoot: testRoot,
      targetRoot,
      approval: { approved: true, approvalId: 'approval-4' },
      allowCustomTargetRootForTests: true,
      visibilityClient: client,
      awaitVisibility: true,
      visibilityPolls: 2,
      visibilityPollMs: 0,
      withdrawAfter: true,
      now,
    });
    assert(report.ok, 'promotion withdrawal proof ok');
    assertEq(report.status, 'REAL_LIBRARY_PROMOTION_WITHDRAWN', 'withdrawn status');
    assert(report.realLibrary.returnedToBefore, 'tree returned to before digest');
    assert(report.jellyfin?.absentAfterWithdrawal, 'Jellyfin absence observed after withdrawal');
    const dest = buildPromotionDestination({ title: 'Promotion Proof', year: 2026, sourceFile: source, targetRoot });
    assert(!existsSync(dest), 'promoted file withdrawn');
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
      approval: { approved: true, approvalId: 'approval-5' },
      allowCustomTargetRootForTests: true,
      now,
    });
    assert(report.ok, 'same-checksum promotion ok');
    assert(report.file.alreadyPresent, 'already present no-op');
    rmSync(dirname(dest), { recursive: true, force: true });
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
