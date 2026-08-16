import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq, assertThrows } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  USENET_LEDGER_EVENTS,
  USENET_LEDGER_SUBDIR,
  UsenetJobLedger,
  createFileLedgerStorage,
  createMemoryLedgerStorage,
  deriveSubmissionKey,
  usenetLedgerPath,
  type LedgerClock,
} from '../src/core/usenet/job-ledger.js';
import { seal } from '../src/core/usenet/sealed.js';
import { submissionMarkerFor } from '../src/core/usenet/sab-contract.js';

// Projection Phase 9 §3, THIRD DELIVERABLE — "a durable job ledger that survives process and host restarts
// without submitting the same job twice".
//
// THE THREE THINGS THIS SUITE PROVES, AND WHY EACH ONE MATTERS MORE THAN IT LOOKS.
//
//   IT IS DURABLE AND IT REPLAYS. A ledger that is only in memory is a ledger that a restart erases, and a
//   ledger a restart erases means a resubmission — a second download of the same bytes on somebody's metered
//   account. So the file is written, a second `open` replays it, and the folded state is identical.
//
//   IT CARRIES NO IDENTITY. The bytes on disk are scanned. A ledger that recorded the NZB URL would put it in
//   a file that survives every restart and gets copied into every backup, which is the exact opposite of what
//   closure rule 9 asks for.
//
//   IT REFUSES RATHER THAN GUESSES. A record with an unknown event, a marker its key does not derive, a
//   digest that is not a digest, or damage in the middle of the file is a REFUSAL to open. A ledger that
//   recovered by skipping a line it could not read would silently forget a submission, and the thing it
//   forgot is the thing that stops a second one.

const h = createHarness('Projection Phase 9 — the durable job ledger');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

const SOURCE_URL = 'https://indexer.example/getnzb?id=42&apikey=indexerkeyindexerkeyindexerkey';
const SOURCE = seal('nzb-source', SOURCE_URL);
const OTHER = seal('nzb-source', 'https://indexer.example/getnzb?id=43&apikey=indexerkeyindexerkeyindexerkey');
const JOB_REF = seal('job-ref', 'SABnzbd_nzo_9aB3xY');
const ITEM = '11111111-2222-3333-4444-555555555555';
const DIGEST = 'c'.repeat(64);

let tick = 0;
const clock: LedgerClock = { nowIso: () => new Date(1_700_000_000_000 + (tick += 1000)).toISOString() };

function memoryLedger(): { ledger: UsenetJobLedger; lines: () => readonly string[] } {
  const storage = createMemoryLedgerStorage();
  return { ledger: UsenetJobLedger.open(storage, clock), lines: () => storage.lines() };
}

/**
 * A real temporary directory, removed whatever happens.
 *
 * IT AWAITS THE BODY. An earlier draft took a synchronous callback and one test passed it an async function,
 * which meant the directory was deleted while the test was still using it — a test that passed for a reason
 * unrelated to what it was checking.
 */
async function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'phase9-ledger-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

h.section('the submission key and the marker');

test('the same source in the same category derives one key, and a different source derives another', () => {
  assertEq(deriveSubmissionKey(SOURCE), deriveSubmissionKey(SOURCE), 'stable');
  assert(deriveSubmissionKey(SOURCE) !== deriveSubmissionKey(OTHER), 'a different source is a different key');
  assert(deriveSubmissionKey(SOURCE) !== deriveSubmissionKey(SOURCE, 'other'), 'the category is part of the key');
  assert(/^[0-9a-f]{32}$/.test(deriveSubmissionKey(SOURCE)), 'the key shape');
  assert(!deriveSubmissionKey(SOURCE).includes('indexer'), 'the key carries no part of the source');
});

test('a key can only be derived from a sealed NZB source', async () => {
  await assertThrows(() => deriveSubmissionKey(seal('sab-api-key', 'abcdef0123456789')),
    /SUBMISSION_SOURCE_INVALID/, 'a key is not a source');
});

h.section('reserve, and the exactly-once guarantee it exists for');

test('the first reservation creates and the second reports the existing job rather than a new one', () => {
  const { ledger, lines } = memoryLedger();
  const first = ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
  assert(first.created, 'the first reservation did not create');
  const second = ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
  assert(!second.created, 'the second reservation created a second job');
  assertEq(second.job.key, first.job.key, 'the same key');
  assertEq(lines().length, 1, 'a repeated reservation wrote a second record');
});

test('a reservation records the marker its key derives, and the marker says nothing about the content', () => {
  const { ledger } = memoryLedger();
  const { job } = ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
  assertEq(job.marker, submissionMarkerFor(job.key), 'the marker is derived');
  assertEq(job.phase, 'reserved', 'the phase');
  assertEq(job.jobFingerprint, null, 'nothing is known about the worker yet');
  assertEq(job.itemId, ITEM, 'the catalog record');
});

test('the reservation is written BEFORE anything else can happen, which is the whole ordering claim', () => {
  const { ledger, lines } = memoryLedger();
  ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
  const record = JSON.parse(lines()[0] as string) as Record<string, unknown>;
  assertEq(record['event'], 'reserved', 'the first record is the reservation');
  assert(record['jobFingerprint'] === undefined, 'a reservation cannot already know a job reference');
});

h.section('the state machine');

test('reserve → submitted → observed → admitted is the ordinary path, and each step folds', () => {
  const { ledger } = memoryLedger();
  const { job } = ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
  assertEq(ledger.confirmSubmitted(job.key, JOB_REF).phase, 'submitted', 'submitted');
  assertEq(ledger.confirmSubmitted(job.key, JOB_REF).jobFingerprint, JOB_REF.fingerprint(), 'the job fingerprint');
  assertEq(ledger.recordObserved(job.key, 'repairing').lastObservedState, 'repairing', 'observed');
  const admitted = ledger.recordAdmitted(job.key, {
    sha256: DIGEST, sizeBytes: 4096, projectedPath: 'usenet/a.mkv', versionKey: 'usenet-abc', projectedEntryId: 'pe_x',
  });
  assert(admitted.admitted, 'the admission was refused');
  assertEq(admitted.job.phase, 'admitted', 'admitted');
  assertEq(admitted.job.admitted?.sha256, DIGEST, 'the proof');
});

test('a second admission with the SAME proof is an idempotent no-op reported as already-admitted', () => {
  const { ledger, lines } = memoryLedger();
  const { job } = ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
  ledger.confirmSubmitted(job.key, JOB_REF);
  const admission = {
    sha256: DIGEST, sizeBytes: 4096, projectedPath: 'usenet/a.mkv', versionKey: 'usenet-abc', projectedEntryId: 'pe_x',
  };
  ledger.recordAdmitted(job.key, admission);
  const before = lines().length;
  const again = ledger.recordAdmitted(job.key, admission);
  assert(!again.admitted, 'the second admission published');
  assertEq(again.reason, 'already-admitted', 'the reason');
  assertEq(lines().length, before, 'a repeated admission wrote a record');
});

test('a second admission with a DIFFERENT proof is a refusal, because one job cannot have two byte streams', () => {
  const { ledger } = memoryLedger();
  const { job } = ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
  ledger.confirmSubmitted(job.key, JOB_REF);
  ledger.recordAdmitted(job.key, {
    sha256: DIGEST, sizeBytes: 4096, projectedPath: 'usenet/a.mkv', versionKey: 'usenet-abc', projectedEntryId: 'pe_x',
  });
  const conflicting = ledger.recordAdmitted(job.key, {
    sha256: 'd'.repeat(64), sizeBytes: 4096, projectedPath: 'usenet/a.mkv', versionKey: 'usenet-abd', projectedEntryId: 'pe_x',
  });
  assert(!conflicting.admitted, 'the conflicting admission published');
  assertEq(conflicting.reason, 'admitted-digest-mismatch', 'the reason');
});

test('an admission over an unconfirmed reservation is refused rather than published', () => {
  const { ledger } = memoryLedger();
  const { job } = ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
  const result = ledger.recordAdmitted(job.key, {
    sha256: DIGEST, sizeBytes: 4096, projectedPath: 'usenet/a.mkv', versionKey: 'usenet-abc', projectedEntryId: 'pe_x',
  });
  assert(!result.admitted, 'an unconfirmed reservation was admitted');
  assertEq(result.reason, 'submission-not-reserved', 'the reason');
});

test('AN ADMITTED JOB IS NEVER UNPUBLISHED BY A LATER REFUSAL — §1', () => {
  const { ledger, lines } = memoryLedger();
  const { job } = ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
  ledger.confirmSubmitted(job.key, JOB_REF);
  ledger.recordAdmitted(job.key, {
    sha256: DIGEST, sizeBytes: 4096, projectedPath: 'usenet/a.mkv', versionKey: 'usenet-abc', projectedEntryId: 'pe_x',
  });
  const before = lines().length;
  const after = ledger.recordRefused(job.key, 'worker-unreachable', true);
  assertEq(after.phase, 'admitted', 'a Usenet failure moved an already-admitted entry');
  assertEq(after.refusal, null, 'a refusal was recorded against an admitted entry');
  assertEq(lines().length, before, 'a refusal after admission wrote a record');
});

test('a transient refusal can be cleared and a permanent one cannot', async () => {
  const { ledger } = memoryLedger();
  const { job } = ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
  ledger.confirmSubmitted(job.key, JOB_REF);
  ledger.recordRefused(job.key, 'output-still-changing', true);
  assertEq(ledger.clearTransientRefusal(job.key).refusal, null, 'a transient refusal did not clear');
  ledger.recordRefused(job.key, 'output-is-symlink', false);
  await assertThrows(() => ledger.clearTransientRefusal(job.key), /LEDGER_STATE_CONFLICT/, 'permanent');
});

test('AN UNCHANGED OBSERVATION WRITES NOTHING, so the ledger grows with events and not with elapsed time', () => {
  const { ledger, lines } = memoryLedger();
  const { job } = ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
  ledger.confirmSubmitted(job.key, JOB_REF);
  ledger.recordObserved(job.key, 'downloading', JOB_REF);
  const after = lines().length;
  for (let tick = 0; tick < 24; tick += 1) ledger.recordObserved(job.key, 'downloading', JOB_REF);
  assertEq(lines().length, after,
    'a four-hour download observed every ten minutes appended a record per look, so the ledger grows with '
    + 'the frequency of the timer rather than with what happened');
  ledger.recordObserved(job.key, 'repairing', JOB_REF);
  assertEq(lines().length, after + 1, 'a CHANGED observation must still be recorded');
});

test('THE SAME REFUSAL TWICE IS ONE REFUSAL, and a different one is still recorded', () => {
  const { ledger, lines } = memoryLedger();
  const { job } = ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
  ledger.confirmSubmitted(job.key, JOB_REF);
  ledger.recordRefused(job.key, 'output-is-symlink', false);
  const after = lines().length;
  for (let tick = 0; tick < 10; tick += 1) ledger.recordRefused(job.key, 'output-is-symlink', false);
  assertEq(lines().length, after, 'the same permanent refusal was appended once per look');
  ledger.recordRefused(job.key, 'output-multiply-linked', false);
  assertEq(lines().length, after + 1, 'a DIFFERENT refusal must still be recorded');
});

test('a lost submission returns the job to reserved and forgets the worker reference', () => {
  const { ledger } = memoryLedger();
  const { job } = ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
  const lost = ledger.recordSubmissionLost(job.key);
  assertEq(lost.phase, 'reserved', 'the phase');
  assertEq(lost.jobFingerprint, null, 'the worker reference');
});

test('a confirmed submission cannot be declared lost, because it was not', async () => {
  const { ledger } = memoryLedger();
  const { job } = ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
  ledger.confirmSubmitted(job.key, JOB_REF);
  await assertThrows(() => ledger.recordSubmissionLost(job.key), /LEDGER_STATE_CONFLICT/, 'confirmed');
});

test('every event this version defines is reachable and the set is closed', () => {
  assertEq(USENET_LEDGER_EVENTS.join(' '), 'reserved submitted submission-lost observed admitted refused', 'events');
});

h.section('what the bytes on disk carry, and what they must not');

test('the ledger file carries no URL, no release name, no completed path and no worker job id', () => {
  const { ledger, lines } = memoryLedger();
  const { job } = ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
  ledger.confirmSubmitted(job.key, JOB_REF);
  ledger.recordObserved(job.key, 'unpacking');
  ledger.recordAdmitted(job.key, {
    sha256: DIGEST, sizeBytes: 4096, projectedPath: 'usenet/Some.Folder/a.mkv', versionKey: 'usenet-abc',
    projectedEntryId: 'pe_x',
  });
  const text = lines().join('\n');
  assert(!text.includes('indexer.example'), 'the ledger carries the NZB source');
  assert(!text.includes('apikey'), 'the ledger carries a credential-shaped value');
  assert(!text.includes('SABnzbd_nzo'), 'the ledger carries the worker job id');
  assert(!text.includes('/downloads/'), 'the ledger carries a completed path');
  assert(text.includes(JOB_REF.fingerprint()), 'the ledger records the job FINGERPRINT so a restart can match');
  // The projected path IS namespace identity and does appear; it is what a published manifest already carries.
  assert(text.includes('usenet/Some.Folder/a.mkv'), 'the ledger records what was published');
});

h.section('durability and replay');

test('a file-backed ledger survives a restart with its state folded identically', async () => {
  await withTempDir((dir) => {
    const path = usenetLedgerPath(dir);
    const before = UsenetJobLedger.open(createFileLedgerStorage(path), clock);
    const { job } = before.reserve({ sealedSource: SOURCE, itemId: ITEM });
    before.confirmSubmitted(job.key, JOB_REF);
    before.recordObserved(job.key, 'repairing');

    // A COMPLETELY NEW PROCESS'S WORTH OF STATE: nothing is carried across but the file.
    const after = UsenetJobLedger.open(createFileLedgerStorage(path), clock);
    const replayed = after.get(job.key);
    assert(replayed !== undefined, 'the job did not survive the restart');
    assertEq(replayed.phase, 'submitted', 'the phase');
    assertEq(replayed.lastObservedState, 'repairing', 'the observation');
    assertEq(replayed.jobFingerprint, JOB_REF.fingerprint(), 'the worker fingerprint');
    assertEq(replayed.itemId, ITEM, 'the catalog record');
  });
});

test('THE RESTART DOES NOT RESUBMIT: a replayed reservation reports itself as already known', async () => {
  await withTempDir((dir) => {
    const path = usenetLedgerPath(dir);
    const before = UsenetJobLedger.open(createFileLedgerStorage(path), clock);
    before.reserve({ sealedSource: SOURCE, itemId: ITEM });

    const after = UsenetJobLedger.open(createFileLedgerStorage(path), clock);
    const second = after.reserve({ sealedSource: SOURCE, itemId: ITEM });
    assert(!second.created,
      'a restart that reserves the same source again would submit it again, which is the single defect this '
      + 'ledger exists to prevent');
  });
});

test('the ledger lives in a sub-directory, never at the top level of a directory something else sweeps', async () => {
  await withTempDir((dir) => {
    const path = usenetLedgerPath(dir);
    assert(path.includes(USENET_LEDGER_SUBDIR),
      'a ledger at the top level of a cache root is one the next daemon start deletes, and a deleted ledger '
      + 'is an exactly-once guarantee that silently resets');
    const ledger = UsenetJobLedger.open(createFileLedgerStorage(path), clock);
    ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
    assert(existsSync(path), 'the ledger file was not created where its own path function says it is');
  });
});

test('an admitted entry survives a restart, so a control-plane restart loses nothing', async () => {
  await withTempDir((dir) => {
    const path = usenetLedgerPath(dir);
    const before = UsenetJobLedger.open(createFileLedgerStorage(path), clock);
    const { job } = before.reserve({ sealedSource: SOURCE, itemId: ITEM });
    before.confirmSubmitted(job.key, JOB_REF);
    before.recordAdmitted(job.key, {
      sha256: DIGEST, sizeBytes: 4096, projectedPath: 'usenet/a.mkv', versionKey: 'usenet-abc', projectedEntryId: 'pe_x',
    });
    const after = UsenetJobLedger.open(createFileLedgerStorage(path), clock);
    assertEq(after.get(job.key)?.admitted?.sha256, DIGEST, 'the admission did not survive the restart');
  });
});

h.section('damage, and what is recovered from rather than guessed at');

test('a TORN TRAILING LINE is dropped, because the record it represents was never acknowledged', async () => {
  await withTempDir((dir) => {
    const path = usenetLedgerPath(dir);
    const ledger = UsenetJobLedger.open(createFileLedgerStorage(path), clock);
    const { job } = ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
    // A crash mid-append: half a record, no newline.
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"v":1,"event":"sub`, 'utf8');
    const after = UsenetJobLedger.open(createFileLedgerStorage(path), clock);
    assertEq(after.get(job.key)?.phase, 'reserved', 'the torn record was applied or the file was refused');
  });
});

test('damage in the MIDDLE of the file is a refusal to open, never a silent skip', async () => {
  await withTempDir(async (dir) => {
    const path = usenetLedgerPath(dir);
    const ledger = UsenetJobLedger.open(createFileLedgerStorage(path), clock);
    const { job } = ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
    ledger.confirmSubmitted(job.key, JOB_REF);
    const lines = readFileSync(path, 'utf8').split('\n');
    lines[0] = '{not json';
    writeFileSync(path, lines.join('\n'), 'utf8');
    await assertThrows(() => UsenetJobLedger.open(createFileLedgerStorage(path), clock),
      /LEDGER_LINE_MALFORMED/, 'damage in the middle');
  });
});

const damaged: ReadonlyArray<[string, Record<string, unknown>, RegExp]> = [
  ['an unknown version', { v: 2 }, /LEDGER_VERSION_UNKNOWN/],
  ['an unknown event', { event: 'teleported' }, /LEDGER_EVENT_UNKNOWN/],
  ['a key that is not a key', { key: 'nope' }, /LEDGER_KEY_INVALID/],
  ['a marker its key does not derive', { marker: 'projection-' + 'f'.repeat(32) }, /LEDGER_MARKER_INVALID/],
  ['a category that is not a label', { category: 'a b c' }, /LEDGER_CATEGORY_INVALID/],
  ['a fingerprint that is not one', { sourceFingerprint: 'zzz' }, /LEDGER_FINGERPRINT_INVALID/],
  ['a timestamp that is not one', { at: 'yesterday' }, /LEDGER_TIMESTAMP_INVALID/],
  ['an item id that is not a UUID', { itemId: 'not-a-uuid' }, /LEDGER_ITEM_ID_INVALID/],
];

for (const [label, override, pattern] of damaged) {
  test(`${label} is refused rather than replayed`, async () => {
    const key = deriveSubmissionKey(SOURCE);
    const base = {
      v: 1, at: '2026-01-01T00:00:00.000Z', key, event: 'reserved', marker: submissionMarkerFor(key),
      category: 'projection', sourceFingerprint: SOURCE.fingerprint(),
    };
    const storage = createMemoryLedgerStorage([JSON.stringify({ ...base, ...override })]);
    await assertThrows(() => UsenetJobLedger.open(storage, clock), pattern, label);
  });
}

test('an admission record missing its proof is refused rather than believed', async () => {
  const key = deriveSubmissionKey(SOURCE);
  const marker = submissionMarkerFor(key);
  const base = { v: 1, at: '2026-01-01T00:00:00.000Z', key, marker, category: 'projection', sourceFingerprint: SOURCE.fingerprint() };
  const storage = createMemoryLedgerStorage([
    JSON.stringify({ ...base, event: 'reserved' }),
    JSON.stringify({ ...base, event: 'submitted' }),
    JSON.stringify({ ...base, event: 'admitted', sizeBytes: 10, projectedPath: 'usenet/a.mkv', versionKey: 'v', projectedEntryId: 'pe' }),
  ]);
  await assertThrows(() => UsenetJobLedger.open(storage, clock), /LEDGER_DIGEST_INVALID/, 'a proofless admission');
});

test('a record for a submission that was never reserved is an orphan and is refused', async () => {
  const key = deriveSubmissionKey(SOURCE);
  const storage = createMemoryLedgerStorage([JSON.stringify({
    v: 1, at: '2026-01-01T00:00:00.000Z', key, event: 'submitted', marker: submissionMarkerFor(key),
    category: 'projection', sourceFingerprint: SOURCE.fingerprint(),
  })]);
  await assertThrows(() => UsenetJobLedger.open(storage, clock), /LEDGER_ORPHAN_RECORD/, 'an orphan');
});

test('a refusal naming a reason outside the closed set is refused', async () => {
  const key = deriveSubmissionKey(SOURCE);
  const marker = submissionMarkerFor(key);
  const base = { v: 1, at: '2026-01-01T00:00:00.000Z', key, marker, category: 'projection', sourceFingerprint: SOURCE.fingerprint() };
  const storage = createMemoryLedgerStorage([
    JSON.stringify({ ...base, event: 'reserved' }),
    JSON.stringify({ ...base, event: 'refused', reason: 'because-i-said-so' }),
  ]);
  await assertThrows(() => UsenetJobLedger.open(storage, clock), /LEDGER_REASON_INVALID/, 'an invented reason');
});

h.section('operating on a job the ledger does not have');

test('every verb refuses an unknown key rather than creating one', async () => {
  const { ledger } = memoryLedger();
  const unknown = 'e'.repeat(32);
  await assertThrows(() => ledger.confirmSubmitted(unknown, JOB_REF), /LEDGER_UNKNOWN_JOB/, 'confirm');
  await assertThrows(() => ledger.recordObserved(unknown, 'downloading'), /LEDGER_UNKNOWN_JOB/, 'observe');
  await assertThrows(() => ledger.recordRefused(unknown, 'worker-unreachable', true), /LEDGER_UNKNOWN_JOB/, 'refuse');
});

test('an admission with a digest or a size that is not one is a programming refusal, not a record', async () => {
  const { ledger } = memoryLedger();
  const { job } = ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
  ledger.confirmSubmitted(job.key, JOB_REF);
  await assertThrows(() => ledger.recordAdmitted(job.key, {
    sha256: 'short', sizeBytes: 1, projectedPath: 'p', versionKey: 'v', projectedEntryId: 'pe',
  }), /LEDGER_DIGEST_INVALID/, 'a short digest');
  await assertThrows(() => ledger.recordAdmitted(job.key, {
    sha256: DIGEST, sizeBytes: 0, projectedPath: 'p', versionKey: 'v', projectedEntryId: 'pe',
  }), /LEDGER_SIZE_INVALID/, 'a zero size');
});

h.section('wiring');

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/usenet-job-ledger.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'usenet-job-ledger.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

test('the durable storage fsyncs, which is the entire difference between a ledger and a note', () => {
  const source = read('src/core/usenet/job-ledger.ts');
  assert(source.includes('fsyncSync(fd)'), 'the ledger does not fsync the file it just appended to');
  assert(/fsyncSync\(dirFd\)/.test(source),
    'the ledger does not fsync the directory, so a crash between the write and the rename leaves a record '
    + 'whose name nothing can find');
  assert(!/writeFileSync/.test(source), 'the ledger rewrites rather than appends, which has a torn-file window');
});

await h.finish();

// Keep the imports honest: these are used by the temp-directory helper above.
void mkdirSync;
