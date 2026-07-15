import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildLocalMediaDestination,
  normalizeMediaTitle,
  runLocalMediaPipeline,
  type LocalMediaVisibilityClient,
} from '../src/ops/local-media-pipeline.js';

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
  return mkdtempSync(join(tmpdir(), 'catalog-local-media-'));
}

function mediaFile(dir: string, name = 'source.mp4', body = 'not-a-real-video-but-a-nonempty-media-fixture'): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

const now = (() => {
  let i = 0;
  return () => new Date(Date.UTC(2026, 6, 15, 0, 0, i++));
})();

console.log('Running Phase 225 import state machine suite:\n');

await test('normalizes titles and builds Jellyfin movie layout', () => {
  const dest = buildLocalMediaDestination({
    title: ' A: Bad / File*Name ',
    year: 2026,
    sourceFile: '/tmp/source.mkv',
    libraryRoot: '/mnt/user/media/catalog-authority-test-library',
  });
  assert(dest.replace(/\\/g, '/').endsWith('Movies/A Bad File Name (2026)/A Bad File Name (2026).mkv'), 'destination follows Jellyfin movie convention');
  assertEq(normalizeMediaTitle('   A   Movie   '), 'A Movie', 'title whitespace normalized');
});

await test('imports by copy and records observed-state transitions', async () => {
  const root = workspace();
  try {
    const source = mediaFile(root);
    const libraryRoot = join(root, 'library');
    const report = await runLocalMediaPipeline({
      itemId: '11111111-1111-4111-8111-111111111111',
      title: 'Local Proof',
      year: 2026,
      sourceFile: source,
      libraryRoot,
      now,
    });
    assert(report.ok, 'report ok');
    assertEq(report.status, 'LOCAL_MEDIA_IMPORTED', 'status imported');
    assertEq(report.lifecycle.currentState, 'IMPORTED', 'state imported');
    assert(report.lifecycle.transitions.every((t) => t.observedState), 'all transitions are observed-state transitions');
    assertEq(report.file.sourceSha256, report.file.destinationSha256, 'copy checksum matches');
    assert(readFileSync(source, 'utf8').includes('nonempty'), 'source remains unchanged');
    assert(!JSON.stringify(report).includes(source), 'raw source path not in evidence');
    assert(report.forbidden.includes('jellyfin-write-api'), 'Jellyfin writes forbidden');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('retries idempotently when destination already has matching checksum', async () => {
  const root = workspace();
  try {
    const source = mediaFile(root);
    const libraryRoot = join(root, 'library');
    await runLocalMediaPipeline({ itemId: '22222222-2222-4222-8222-222222222222', title: 'Repeat Proof', sourceFile: source, libraryRoot, now });
    const report = await runLocalMediaPipeline({ itemId: '22222222-2222-4222-8222-222222222222', title: 'Repeat Proof', sourceFile: source, libraryRoot, now });
    assert(report.ok, 'retry ok');
    assert(report.file.idempotentNoop, 'retry is no-op');
    assertEq(report.lifecycle.currentState, 'IMPORTED', 'still imported');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('fails closed on invalid source and forbidden extension without residue', async () => {
  const root = workspace();
  try {
    const libraryRoot = join(root, 'library');
    const badExt = mediaFile(root, 'source.txt');
    const forbidden = await runLocalMediaPipeline({ itemId: '33333333-3333-4333-8333-333333333333', title: 'Bad Ext', sourceFile: badExt, libraryRoot, now });
    assertEq(forbidden.status, 'LOCAL_MEDIA_FAILED', 'forbidden extension fails');
    assertEq(forbidden.lifecycle.currentState, 'FAILED', 'failure terminal');
    assert(forbidden.lifecycle.transitions.some((t) => t.failureCode === 'IMPORT_EXTENSION_FORBIDDEN'), 'extension failure code');
    const missing = await runLocalMediaPipeline({ itemId: '33333333-3333-4333-8333-333333333334', title: 'Missing', sourceFile: join(root, 'missing.mp4'), libraryRoot, now });
    assert(missing.lifecycle.transitions.some((t) => t.failureCode === 'IMPORT_SOURCE_INVALID'), 'missing source failure code');
    assert(!existsSync(join(libraryRoot, 'Movies', 'Missing (Unknown Year)')), 'missing source left no destination folder');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('fails closed on destination collision and preserves existing file', async () => {
  const root = workspace();
  try {
    const source = mediaFile(root, 'source.mp4', 'source-one');
    const libraryRoot = join(root, 'library');
    const dest = buildLocalMediaDestination({ title: 'Collision Proof', sourceFile: source, libraryRoot });
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, 'different-existing-file');
    const report = await runLocalMediaPipeline({ itemId: '44444444-4444-4444-8444-444444444444', title: 'Collision Proof', sourceFile: source, libraryRoot, now });
    assertEq(report.status, 'LOCAL_MEDIA_FAILED', 'collision fails');
    assert(report.lifecycle.transitions.some((t) => t.failureCode === 'IMPORT_DESTINATION_COLLISION'), 'collision failure code');
    assertEq(readFileSync(dest, 'utf8'), 'different-existing-file', 'existing file preserved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('awaits Jellyfin read-only visibility with bounded retry and no write assumption', async () => {
  const root = workspace();
  try {
    const source = mediaFile(root);
    const libraryRoot = join(root, 'library');
    let calls = 0;
    const client: LocalMediaVisibilityClient = {
      async findVisibleItem() {
        calls += 1;
        return calls < 3 ? { visible: false } : { visible: true, itemId: 'jellyfin-item-1', matchBasis: 'path' };
      },
    };
    const report = await runLocalMediaPipeline({
      itemId: '55555555-5555-4555-8555-555555555555',
      title: 'Visible Proof',
      sourceFile: source,
      libraryRoot,
      visibilityClient: client,
      awaitJellyfinVisibility: true,
      visibilityPolls: 5,
      visibilityPollMs: 0,
      now,
    });
    assertEq(report.lifecycle.currentState, 'VISIBLE_IN_JELLYFIN', 'visible after retry');
    assertEq(report.jellyfin?.polls, 3, 'bounded polling captured');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('records Jellyfin unreachable/timeout as failed with logs and imported file retained', async () => {
  const root = workspace();
  try {
    const source = mediaFile(root);
    const libraryRoot = join(root, 'library');
    const client: LocalMediaVisibilityClient = { async findVisibleItem() { return { visible: false }; } };
    const report = await runLocalMediaPipeline({
      itemId: '66666666-6666-4666-8666-666666666666',
      title: 'Timeout Proof',
      sourceFile: source,
      libraryRoot,
      visibilityClient: client,
      awaitJellyfinVisibility: true,
      visibilityPolls: 2,
      visibilityPollMs: 0,
      now,
    });
    assertEq(report.status, 'LOCAL_MEDIA_FAILED', 'timeout fails');
    assert(report.lifecycle.transitions.some((t) => t.failureCode === 'JELLYFIN_SCAN_TIMEOUT'), 'timeout failure code');
    assert(report.lifecycle.logsRetrievable, 'logs retrievable');
    assertEq(report.file.sourceSha256, report.file.destinationSha256, 'imported file remains consistent for safe retry');
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
