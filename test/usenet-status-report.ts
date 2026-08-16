import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq, assertThrows } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  USENET_REFUSAL_MEANINGS,
  USENET_REFUSAL_MEANING_KEYS,
  USENET_REFUSAL_REASON_KEYS,
  renderStatusLines,
  toStatusDocument,
} from '../src/core/usenet/status-report.js';
import { UsenetJobLedger, createMemoryLedgerStorage } from '../src/core/usenet/job-ledger.js';
import { seal } from '../src/core/usenet/sealed.js';
import { USENET_JOB_STATES, USENET_REFUSAL_REASONS, isTransientRefusal } from '../src/core/usenet/sab-contract.js';

// Projection Phase 9 §3, LAST DELIVERABLE — the operator surface, and closure rule 9.
//
// TWO PROPERTIES, AND THE SECOND IS ENFORCED BY THE CODE ITSELF RATHER THAN BY THIS SUITE. First, every
// refusal an operator can meet has a sentence explaining it — a code with no explanation is a dead end at the
// exact moment somebody needs help. Second, the document cannot carry identity: `toStatusDocument` runs the
// sealed-value scanner over its own output and THROWS rather than returning a document with a URL, an
// absolute download path or a worker job id in it. This suite drives that path deliberately.

const h = createHarness('Projection Phase 9 — the operator status surface');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

const SOURCE = seal('nzb-source', 'https://indexer.example/getnzb?id=42&apikey=indexerkeyindexerkey');
const JOB_REF = seal('job-ref', 'SABnzbd_nzo_9aB3xY');
const ITEM = '11111111-2222-3333-4444-555555555555';
const DIGEST = 'ab'.repeat(32);

function ledgerWith(build: (ledger: UsenetJobLedger) => void): UsenetJobLedger {
  const ledger = UsenetJobLedger.open(createMemoryLedgerStorage());
  build(ledger);
  return ledger;
}

h.section('the closed sets line up');

test('every refusal reason has a meaning, and the meanings table has no key the set does not', () => {
  assertEq(USENET_REFUSAL_MEANING_KEYS.length, USENET_REFUSAL_REASON_KEYS.length, 'the two tables differ in size');
  for (const reason of USENET_REFUSAL_REASONS) {
    const meaning = USENET_REFUSAL_MEANINGS[reason];
    assert(typeof meaning === 'string' && meaning.length > 20,
      `${reason} has no explanation; an operator meeting it has been told a code, not a reason`);
  }
  for (const key of USENET_REFUSAL_MEANING_KEYS) {
    assert((USENET_REFUSAL_REASONS as readonly string[]).includes(key),
      `the meanings table explains ${key}, which is not a reason this contract can produce`);
  }
});

test('no meaning names a path, a URL, a provider or a worker job id', () => {
  for (const [reason, meaning] of Object.entries(USENET_REFUSAL_MEANINGS)) {
    assert(!/https?:\/\/|\/downloads\/|\/mnt\/|SABnzbd_nzo/.test(meaning), `${reason}'s meaning carries identity`);
  }
});

h.section('the document');

test('an empty ledger produces a document with every state present at zero', () => {
  const document = toStatusDocument([]);
  for (const state of USENET_JOB_STATES) {
    assertEq(document.counts[state], 0, `${state} is missing from the counts`);
  }
  assertEq(document.jobs.length, 0, 'jobs');
  assertEq(document.retryable + document.blocked, 0, 'nothing is refused');
});

test('a job in flight is named by an opaque prefix and by fingerprints, never by its source', () => {
  const ledger = ledgerWith((l) => {
    const { job } = l.reserve({ sealedSource: SOURCE, itemId: ITEM });
    l.confirmSubmitted(job.key, JOB_REF);
    l.recordObserved(job.key, 'repairing', JOB_REF);
  });
  const document = toStatusDocument(ledger.all());
  const row = document.jobs[0];
  assert(row !== undefined, 'no job');
  assertEq(row.state, 'repairing', 'the state');
  assertEq(row.job.length, 11, 'the job is named by an eleven-character prefix');
  assertEq(row.source, SOURCE.fingerprint(), 'the source fingerprint');
  assertEq(row.worker, JOB_REF.fingerprint(), 'the worker fingerprint');
  assertEq(document.counts.repairing, 1, 'the count');
  const text = JSON.stringify(document);
  assert(!text.includes('indexer.example'), 'the document carries the source');
  assert(!text.includes('SABnzbd_nzo'), 'the document carries the worker job id');
});

test('an admitted job reports its projected path, its size and a digest PREFIX', () => {
  const ledger = ledgerWith((l) => {
    const { job } = l.reserve({ sealedSource: SOURCE, itemId: ITEM });
    l.confirmSubmitted(job.key, JOB_REF);
    l.recordAdmitted(job.key, {
      sha256: DIGEST, sizeBytes: 4_194_304, projectedPath: 'usenet/Some.Job/feature.mkv',
      versionKey: `usenet-${DIGEST.slice(0, 32)}`, projectedEntryId: 'pe_abc',
    });
  });
  const document = toStatusDocument(ledger.all());
  const admitted = document.jobs[0]?.admitted;
  assert(admitted !== null && admitted !== undefined, 'no admission');
  assertEq(admitted.projectedPath, 'usenet/Some.Job/feature.mkv', 'the path');
  assertEq(admitted.digestPrefix.length, 16, 'a prefix rather than the whole digest');
  assertEq(document.counts.admitted, 1, 'the count');
});

test('a refusal reports its reason, its meaning and whether looking again could help', () => {
  const ledger = ledgerWith((l) => {
    const transient = l.reserve({ sealedSource: SOURCE, itemId: ITEM });
    l.confirmSubmitted(transient.job.key, JOB_REF);
    l.recordRefused(transient.job.key, 'output-still-changing', true);
    const permanent = l.reserve({ sealedSource: seal('nzb-source', 'https://indexer.example/getnzb?id=99'), itemId: ITEM });
    l.confirmSubmitted(permanent.job.key, JOB_REF);
    l.recordRefused(permanent.job.key, 'output-is-symlink', false);
  });
  const document = toStatusDocument(ledger.all());
  assertEq(document.retryable, 1, 'one retryable refusal');
  assertEq(document.blocked, 1, 'one refusal that needs an operator');
  for (const row of document.jobs) {
    assert(row.refusal !== null, 'a refused job carries no refusal');
    assertEq(row.refusal.meaning, USENET_REFUSAL_MEANINGS[row.refusal.reason], 'the meaning');
    assertEq(row.refusal.transient, isTransientRefusal(row.refusal.reason), 'the transience matches the contract');
  }
});

test('THE DOCUMENT REFUSES TO EXIST IF IT WOULD CARRY IDENTITY', async () => {
  // A projected path is namespace identity and is allowed. An ABSOLUTE download path is not, and this is
  // the only way one could reach the document — a bug that recorded a completed path as the projected one.
  const ledger = ledgerWith((l) => {
    const { job } = l.reserve({ sealedSource: SOURCE, itemId: ITEM });
    l.confirmSubmitted(job.key, JOB_REF);
    l.recordAdmitted(job.key, {
      sha256: DIGEST, sizeBytes: 4_194_304, projectedPath: '/downloads/complete/projection/Some.Job/feature.mkv',
      versionKey: `usenet-${DIGEST.slice(0, 32)}`, projectedEntryId: 'pe_abc',
    });
  });
  await assertThrows(() => toStatusDocument(ledger.all()), /SEALED_LEAK_REFUSED/,
    'a document carrying an absolute download path was returned rather than refused');
});

h.section('the rendering');

test('the rendered lines say the same thing as the document and add nothing to it', () => {
  const ledger = ledgerWith((l) => {
    const { job } = l.reserve({ sealedSource: SOURCE, itemId: ITEM });
    l.confirmSubmitted(job.key, JOB_REF);
    l.recordRefused(job.key, 'output-unpack-residue', true);
  });
  const document = toStatusDocument(ledger.all());
  const lines = renderStatusLines(document).join('\n');
  assert(lines.includes('output-unpack-residue'), 'the reason is not rendered');
  assert(lines.includes('retryable'), 'the transience is not rendered');
  assert(lines.includes(document.jobs[0]?.job as string), 'the job prefix is not rendered');
  assert(!lines.includes('indexer.example'), 'the rendering carries the source');
  for (const state of USENET_JOB_STATES) {
    assert(lines.includes(`${state}=`), `${state} is missing from the count line`);
  }
});

test('an empty ledger renders a sentence rather than an empty screen', () => {
  const lines = renderStatusLines(toStatusDocument([])).join('\n');
  assert(lines.includes('no submissions recorded'), 'an empty status says nothing at all');
});

h.section('wiring');

test('the status module scans its own output before returning it', () => {
  const source = read('src/core/usenet/status-report.ts');
  assert(source.includes('assertSealedSafe(document'),
    'the status document is returned without being scanned, so the guarantee is a discipline rather than a check');
});

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/usenet-status-report.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'usenet-status-report.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

await h.finish();
