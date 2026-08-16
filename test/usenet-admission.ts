import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createHarness, assert, assertEq, createFakeClock, createFakeFileSystem, createFakePublisher, mediaBytes,
  SMALL_MEDIA_BYTES, type FakeNode,
} from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import { UsenetAdmissionService, stateOf } from '../src/core/usenet/admission.js';
import { SabClient } from '../src/core/usenet/sab-client.js';
import { createSabHttpTransport } from '../src/core/usenet/sab-http-transport.js';
import { startFakeSabnzbd, type FakeSabService } from '../src/core/usenet/sab-fake-service.js';
import {
  UsenetJobLedger, createMemoryLedgerStorage, deriveSubmissionKey, type LedgerStorage,
} from '../src/core/usenet/job-ledger.js';
import { seal } from '../src/core/usenet/sealed.js';
import { USENET_DEDICATED_CATEGORY } from '../src/core/usenet/sab-contract.js';
import { deriveProjectedEntryId } from '../src/core/projection/manifest-v1.js';

// Projection Phase 9 — reconciliation and admission, end to end and provider-free.
//
// WHAT "END TO END" MEANS HERE. A real HTTP fake worker, the shipped transport, the shipped client, the real
// ledger (in memory storage, but the SAME class and the same replay), the real output checks against a fake
// filesystem, the real manifest bridge, and a publisher that records what it was asked to publish. The only
// two things that are not the shipped code are the socket's peer and the disk underneath — which is exactly
// the boundary §3's first deliverable draws.
//
// THE FOUR CLAIMS THIS SUITE EXISTS FOR, three of which §5 names directly:
//
//   §5.2  a completed job is admitted EXACTLY ONCE, however many times reconciliation runs.
//   §5.3  a failed or incomplete job is refused and never reaches the publisher.
//   §5.6  a worker restart and a control-plane restart submit no duplicate job and lose no admitted entry.
//   §5.7  a Usenet outage changes nothing about what is already published.

const h = createHarness('Projection Phase 9 — reconciliation and admission');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

const API_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SOURCE = seal('nzb-source', 'https://indexer.example/getnzb?id=42&apikey=indexerkeyindexerkey');
const OTHER_SOURCE = seal('nzb-source', 'https://indexer.example/getnzb?id=43&apikey=indexerkeyindexerkey');
const ITEM = '11111111-2222-3333-4444-555555555555';
const ROOT = '/downloads/complete/projection';
const MEDIA = mediaBytes(SMALL_MEDIA_BYTES);

const dir = (): FakeNode => ({ kind: 'directory' });

function baseTree(jobName = 'Some.Job', extra: Readonly<Record<string, FakeNode>> = {}): Record<string, FakeNode> {
  return {
    '/downloads': dir(),
    '/downloads/complete': dir(),
    [ROOT]: dir(),
    [`${ROOT}/${jobName}`]: dir(),
    [`${ROOT}/${jobName}/feature.mkv`]: { kind: 'file', bytes: MEDIA },
    ...extra,
  };
}

interface Rig {
  readonly service: UsenetAdmissionService;
  readonly ledger: UsenetJobLedger;
  readonly worker: FakeSabService;
  readonly publisher: ReturnType<typeof createFakePublisher>;
  readonly fs: ReturnType<typeof createFakeFileSystem>;
  readonly storage: ReturnType<typeof createMemoryLedgerStorage>;
}

async function withRig(
  fn: (rig: Rig) => Promise<void>,
  options: {
    tree?: Record<string, FakeNode>;
    storage?: ReturnType<typeof createMemoryLedgerStorage>;
    publisherFailTimes?: number;
    fsOptions?: Parameters<typeof createFakeFileSystem>[1];
  } = {},
): Promise<void> {
  const worker = await startFakeSabnzbd({ apiKey: API_KEY });
  try {
    const storage = options.storage ?? createMemoryLedgerStorage();
    const ledger = UsenetJobLedger.open(storage);
    const fs = createFakeFileSystem(options.tree ?? baseTree(), options.fsOptions ?? {});
    const publisher = createFakePublisher(
      options.publisherFailTimes === undefined ? {} : { failTimes: options.publisherFailTimes },
    );
    const client = new SabClient({
      endpoint: worker.endpoint,
      apiKey: seal('sab-api-key', API_KEY),
      transport: createSabHttpTransport(),
      sleep: async () => undefined,
    });
    const service = new UsenetAdmissionService({
      client,
      ledger,
      fs,
      clock: createFakeClock(),
      publisher,
      completedRoot: ROOT,
      rootId: 'media',
      completedRootUnderMediaRoot: ['usenet-complete'],
      category: USENET_DEDICATED_CATEGORY,
    });
    await fn({ service, ledger, worker, publisher, fs, storage });
  } finally {
    await worker.close();
  }
}

h.section('submitting');

test('a first submission reserves, submits once, and records the worker\'s reference', async () => {
  await withRig(async (rig) => {
    const outcome = await rig.service.submit(SOURCE, ITEM);
    assertEq(outcome.outcome, 'submitted', 'the outcome');
    assertEq(outcome.state, 'downloading', 'the state');
    assertEq(rig.worker.submitCount(), 1, 'exactly one submission reached the worker');
    assertEq(rig.ledger.get(outcome.key)?.phase, 'submitted', 'the ledger phase');
  });
});

test('A SECOND SUBMISSION OF THE SAME SOURCE NEVER REACHES THE WORKER', async () => {
  await withRig(async (rig) => {
    await rig.service.submit(SOURCE, ITEM);
    const again = await rig.service.submit(SOURCE, ITEM);
    assertEq(again.outcome, 'already-known', 'the second outcome');
    assertEq(rig.worker.submitCount(), 1,
      'the same NZB was submitted twice, which is a second download of the same bytes on somebody\'s '
      + 'metered account');
  });
});

test('a different source is a different submission', async () => {
  await withRig(async (rig) => {
    await rig.service.submit(SOURCE, ITEM);
    const other = await rig.service.submit(OTHER_SOURCE, ITEM);
    assertEq(other.outcome, 'submitted', 'the second source');
    assertEq(rig.worker.submitCount(), 2, 'two distinct sources');
    assert(other.key !== deriveSubmissionKey(SOURCE), 'two sources shared one key');
  });
});

test('a submission refuses anything that is not a sealed NZB source', async () => {
  await withRig(async (rig) => {
    const wrong = await rig.service.submit(seal('completed-path', '/downloads/x'), ITEM);
    assertEq(wrong.outcome, 'refused', 'the outcome');
    assertEq(wrong.reason, 'nzb-source-not-approved', 'the reason');
    assertEq(rig.worker.submitCount(), 0, 'a refused submission reached the worker');
  });
});

test('A REJECTED CREDENTIAL DOES NOT WEDGE THE SUBMISSION FOREVER', async () => {
  await withRig(async (rig) => {
    rig.worker.setFaults({ rejectCredential: true });
    const refused = await rig.service.submit(SOURCE, ITEM);
    assertEq(refused.outcome, 'refused', 'the outcome');
    assertEq(refused.reason, 'worker-rejected-credential', 'the reason');
    assertEq(rig.worker.submitCount(), 1, 'the worker was asked once');

    // The operator fixes the key. The submission key is derived from the SOURCE, so if the first failure had
    // been recorded as a permanent refusal this source could never be submitted again.
    rig.worker.setFaults({});
    const retried = await rig.service.submit(SOURCE, ITEM);
    assertEq(retried.outcome, 'submitted', 'a fixed credential could not re-submit the same source');
    assertEq(rig.worker.submitCount(), 2, 'the retry did not reach the worker');
  });
});

test('AN AMBIGUOUS SUBMISSION IS NEVER RE-SENT BY A SECOND SUBMIT — only reconciliation resolves it', async () => {
  const storage = createMemoryLedgerStorage();
  const worker = await startFakeSabnzbd({ apiKey: API_KEY });
  try {
    const ledger = UsenetJobLedger.open(storage);
    // A transport that always fails is exactly the case where the worker MAY have accepted the submission.
    const unreachable = new SabClient({
      endpoint: { host: '127.0.0.1', port: 1, scheme: 'http' },
      apiKey: seal('sab-api-key', API_KEY),
      transport: { async request() { throw new Error('connection refused'); } },
      sleep: async () => undefined,
    });
    const build = (client: SabClient): UsenetAdmissionService => new UsenetAdmissionService({
      client,
      ledger,
      fs: createFakeFileSystem(baseTree()),
      clock: createFakeClock(),
      publisher: createFakePublisher(),
      completedRoot: ROOT,
      rootId: 'media',
      completedRootUnderMediaRoot: ['usenet-complete'],
      category: USENET_DEDICATED_CATEGORY,
    });

    const first = await build(unreachable).submit(SOURCE, ITEM);
    assertEq(first.reason, 'worker-unreachable', 'the reason');

    const second = await build(unreachable).submit(SOURCE, ITEM);
    assertEq(second.outcome, 'already-known',
      'a submission that MIGHT have landed was sent again, which is a second download of the same bytes');

    // Reconciliation against a reachable worker finds nothing carrying the marker, records it lost, and only
    // THEN may the source be submitted again.
    const reachable = new SabClient({
      endpoint: worker.endpoint, apiKey: seal('sab-api-key', API_KEY),
      transport: createSabHttpTransport(), sleep: async () => undefined,
    });
    const reconciled = await build(reachable).reconcileAll();
    assertEq(reconciled[0]?.reason, 'job-absent-from-worker', 'the reconciliation reason');

    const third = await build(reachable).submit(SOURCE, ITEM);
    assertEq(third.outcome, 'submitted', 'a proved-lost submission could not be re-sent');
    assertEq(worker.submitCount(), 1, 'exactly one submission reached the reachable worker');
  } finally {
    await worker.close();
  }
});

h.section('reconciling a job through its lifecycle');

test('the queue statuses fold to the operator lifecycle without ever reaching ready-to-admit', async () => {
  await withRig(async (rig) => {
    const submitted = await rig.service.submit(SOURCE, ITEM);
    for (const [status, expected] of [
      ['Downloading', 'downloading'], ['Repairing', 'repairing'], ['Extracting', 'unpacking'],
    ] as const) {
      rig.worker.setQueueStatus(submitted.marker, status);
      const outcomes = await rig.service.reconcileAll();
      assertEq(outcomes[0]?.state, expected, `${status} folds`);
    }
    assertEq(rig.publisher.published().length, 0, 'nothing in the queue may publish');
  });
});

test('§5.2 — a completed job is admitted, exactly once, however many reconciliations run', async () => {
  await withRig(async (rig) => {
    const submitted = await rig.service.submit(SOURCE, ITEM);
    rig.worker.complete(submitted.marker, { storagePath: `${ROOT}/Some.Job`, bytes: SMALL_MEDIA_BYTES });

    const first = await rig.service.reconcileAll();
    assertEq(first[0]?.state, 'admitted', 'the first reconciliation did not admit');
    assertEq(first[0]?.admitted?.projectedPath, 'usenet/Some.Job/feature.mkv', 'the projected path');
    assertEq(first[0]?.admitted?.projectedEntryId, deriveProjectedEntryId('usenet/Some.Job/feature.mkv'), 'the id');

    for (let round = 0; round < 4; round += 1) await rig.service.reconcileAll();
    assertEq(rig.publisher.published().length, 1,
      'a job was published more than once; every media server would see the entry churn');
    assertEq(rig.ledger.get(submitted.key)?.phase, 'admitted', 'the ledger phase');
  });
});

test('an admitted job is not reconciled again at all, so a Usenet outage cannot touch it', async () => {
  await withRig(async (rig) => {
    const submitted = await rig.service.submit(SOURCE, ITEM);
    rig.worker.complete(submitted.marker, { storagePath: `${ROOT}/Some.Job`, bytes: SMALL_MEDIA_BYTES });
    await rig.service.reconcileAll();

    // §5.7: the worker goes away entirely.
    rig.worker.setFaults({ rejectCredential: true });
    const outcomes = await rig.service.reconcileAll();
    assertEq(outcomes.length, 0, 'an admitted job was reconciled against an unreachable worker');
    assertEq(rig.ledger.get(submitted.key)?.phase, 'admitted', 'an outage moved an admitted entry');
    assertEq(rig.ledger.get(submitted.key)?.refusal, null, 'an outage recorded a refusal against an admitted entry');
  });
});

h.section('§5.3 — refusing');

test('a job the worker recorded as failed is refused and never reaches the publisher', async () => {
  await withRig(async (rig) => {
    const submitted = await rig.service.submit(SOURCE, ITEM);
    rig.worker.failJob(submitted.marker, 'Some.Release could not be repaired');
    const outcomes = await rig.service.reconcileAll();
    assertEq(outcomes[0]?.state, 'refused', 'the state');
    assertEq(outcomes[0]?.reason, 'job-failed-at-worker', 'the reason');
    assertEq(rig.publisher.published().length, 0, 'a failed job was published');
    assert(!JSON.stringify(outcomes).includes('Some.Release'), 'the worker\'s failure message reached the outcome');
  });
});

test('a completed job carrying a failure message is refused rather than admitted', async () => {
  await withRig(async (rig) => {
    const submitted = await rig.service.submit(SOURCE, ITEM);
    rig.worker.complete(submitted.marker, { storagePath: `${ROOT}/Some.Job`, bytes: SMALL_MEDIA_BYTES });
    const job = rig.worker.jobByMarker(submitted.marker);
    assert(job !== undefined, 'the fake worker lost the job');
    job.failMessage = 'unpack failed but the job is in history as Completed';
    const outcomes = await rig.service.reconcileAll();
    assertEq(outcomes[0]?.reason, 'job-failed-at-worker', 'the reason');
    assertEq(rig.publisher.published().length, 0, 'published');
  });
});

test('§4 — A JOB THAT VANISHES FROM BOTH LISTS IS REFUSED, NEVER READ AS SUCCESS', async () => {
  await withRig(async (rig) => {
    const submitted = await rig.service.submit(SOURCE, ITEM);
    rig.worker.forget(submitted.marker);
    const outcomes = await rig.service.reconcileAll();
    assertEq(outcomes[0]?.state, 'refused', 'the state');
    assertEq(outcomes[0]?.reason, 'job-absent-from-worker', 'the reason');
    assertEq(rig.publisher.published().length, 0, 'a vanished job was published');
  });
});

test('a completed job in the wrong category is refused, so an operator\'s own download is never touched', async () => {
  await withRig(async (rig) => {
    const submitted = await rig.service.submit(SOURCE, ITEM);
    rig.worker.complete(submitted.marker, { storagePath: `${ROOT}/Some.Job`, bytes: SMALL_MEDIA_BYTES });
    const job = rig.worker.jobByMarker(submitted.marker);
    assert(job !== undefined, 'the fake worker lost the job');
    (job as { category: string }).category = 'movies';
    const outcomes = await rig.service.reconcileAll();
    assertEq(outcomes[0]?.reason, 'category-not-dedicated', 'the reason');
    assertEq(rig.publisher.published().length, 0, 'published');
  });
});

const outputRefusals: ReadonlyArray<[string, Record<string, FakeNode>, string]> = [
  // The job directory IS the path the worker named, so a link there is `output-is-symlink`; a link on a file
  // found while walking under it is `output-component-is-symlink`. Both are permanent, and both refuse.
  ['a symlinked job directory', baseTree('Some.Job', { [`${ROOT}/Some.Job`]: { kind: 'symlink' } }), 'output-is-symlink'],
  ['a symlinked output', baseTree('Some.Job', { [`${ROOT}/Some.Job/feature.mkv`]: { kind: 'symlink' } }), 'output-component-is-symlink'],
  ['a FIFO output', baseTree('Some.Job', { [`${ROOT}/Some.Job/feature.mkv`]: { kind: 'fifo' } }), 'output-not-regular-file'],
  ['an unpack artefact still present', baseTree('Some.Job', { [`${ROOT}/Some.Job/part.rar`]: { kind: 'file', bytes: Buffer.alloc(10) } }), 'output-unpack-residue'],
  ['two publishable files', baseTree('Some.Job', { [`${ROOT}/Some.Job/second.mkv`]: { kind: 'file', bytes: mediaBytes(SMALL_MEDIA_BYTES, 3) } }), 'output-not-uniquely-identified'],
  ['a job directory with nothing publishable', {
    '/downloads': dir(), '/downloads/complete': dir(), [ROOT]: dir(), [`${ROOT}/Some.Job`]: dir(),
  }, 'output-not-uniquely-identified'],
];

for (const [label, tree, reason] of outputRefusals) {
  test(`${label} is refused as ${reason} and nothing is published`, async () => {
    await withRig(async (rig) => {
      const submitted = await rig.service.submit(SOURCE, ITEM);
      rig.worker.complete(submitted.marker, { storagePath: `${ROOT}/Some.Job`, bytes: SMALL_MEDIA_BYTES });
      const outcomes = await rig.service.reconcileAll();
      assertEq(outcomes[0]?.reason, reason as never, `${label} reason`);
      assertEq(rig.publisher.published().length, 0, `${label} published`);
    }, { tree });
  });
}

test('a completed path OUTSIDE the dedicated root is refused before anything is opened', async () => {
  await withRig(async (rig) => {
    const submitted = await rig.service.submit(SOURCE, ITEM);
    rig.worker.complete(submitted.marker, { storagePath: '/mnt/user/media/Some.Job', bytes: SMALL_MEDIA_BYTES });
    const outcomes = await rig.service.reconcileAll();
    assertEq(outcomes[0]?.reason, 'output-path-escapes-root', 'the reason');
    assertEq(rig.fs.digestCount(), 0, 'a path outside the root was digested');
  });
});

test('a completed job with no storage path at all is a transient refusal, not a crash', async () => {
  await withRig(async (rig) => {
    const submitted = await rig.service.submit(SOURCE, ITEM);
    rig.worker.complete(submitted.marker, { storagePath: '', bytes: SMALL_MEDIA_BYTES });
    const outcomes = await rig.service.reconcileAll();
    assertEq(outcomes[0]?.reason, 'output-missing', 'the reason');
  });
});

test('a submission with no catalog record is refused rather than published without a logical media id', async () => {
  await withRig(async (rig) => {
    const reservation = rig.ledger.reserve({ sealedSource: SOURCE });
    const submitted = await new SabClient({
      endpoint: rig.worker.endpoint, apiKey: seal('sab-api-key', API_KEY),
      transport: createSabHttpTransport(), sleep: async () => undefined,
    }).submitUrl(SOURCE, reservation.job.marker);
    assert(submitted.ok, 'the setup submission failed');
    rig.ledger.confirmSubmitted(reservation.job.key, submitted.value.jobRef);
    rig.worker.complete(reservation.job.marker, { storagePath: `${ROOT}/Some.Job`, bytes: SMALL_MEDIA_BYTES });
    const outcomes = await rig.service.reconcileAll();
    assertEq(outcomes[0]?.reason, 'catalog-record-missing', 'the reason');
    assertEq(rig.publisher.published().length, 0, 'published');
  });
});

test('a PERMANENTLY refused job is not looked at again; a TRANSIENTLY refused one is', async () => {
  await withRig(async (rig) => {
    const submitted = await rig.service.submit(SOURCE, ITEM);
    rig.worker.complete(submitted.marker, { storagePath: `${ROOT}/Some.Job`, bytes: SMALL_MEDIA_BYTES });
    const first = await rig.service.reconcileAll();
    assertEq(first[0]?.reason, 'output-is-symlink', 'the setup refusal');

    const second = await rig.service.reconcileAll();
    assertEq(second.length, 0,
      'a permanently refused job was reconciled again; a symlinked output will still be a symlinked output '
      + 'in ten minutes, and a timer that re-derived that every cycle tells nobody anything new');
  }, { tree: baseTree('Some.Job', { [`${ROOT}/Some.Job`]: { kind: 'symlink' } }) });

  await withRig(async (rig) => {
    const submitted = await rig.service.submit(SOURCE, ITEM);
    rig.worker.complete(submitted.marker, { storagePath: `${ROOT}/Some.Job`, bytes: SMALL_MEDIA_BYTES });
    const first = await rig.service.reconcileAll();
    assertEq(first[0]?.reason, 'output-unpack-residue', 'the setup refusal');

    // The worker finishes cleaning up, and the very next reconciliation admits without an operator doing
    // anything. That is the entire difference between a transient refusal and a permanent one.
    rig.fs.remove(`${ROOT}/Some.Job/part.rar`);
    const second = await rig.service.reconcileAll();
    assertEq(second[0]?.state, 'admitted', 'a transiently refused job was never looked at again');
  }, { tree: baseTree('Some.Job', { [`${ROOT}/Some.Job/part.rar`]: { kind: 'file', bytes: Buffer.alloc(10) } }) });
});

h.section('§5.6 — restarts');

test('A CONTROL-PLANE RESTART DOES NOT RESUBMIT AND DOES NOT LOSE THE ADMITTED ENTRY', async () => {
  const storage = createMemoryLedgerStorage();
  let key = '';
  let marker = '';

  await withRig(async (rig) => {
    const submitted = await rig.service.submit(SOURCE, ITEM);
    key = submitted.key;
    marker = submitted.marker;
    rig.worker.complete(marker, { storagePath: `${ROOT}/Some.Job`, bytes: SMALL_MEDIA_BYTES });
    await rig.service.reconcileAll();
    assertEq(rig.publisher.published().length, 1, 'the first run did not publish');
  }, { storage });

  // A COMPLETELY NEW PROCESS: a new ledger instance replayed from the same durable lines, a new worker, a new
  // publisher. Only the ledger's bytes cross the boundary, which is exactly what survives a restart.
  await withRig(async (rig) => {
    assertEq(rig.ledger.get(key)?.phase, 'admitted', 'the admitted entry did not survive the restart');
    const again = await rig.service.submit(SOURCE, ITEM);
    assertEq(again.outcome, 'already-known', 'a restart resubmitted the same source');
    assertEq(rig.worker.submitCount(), 0, 'a restart reached the worker with a duplicate submission');
    const outcomes = await rig.service.reconcileAll();
    assertEq(outcomes.length, 0, 'an admitted job was reconciled after a restart');
    assertEq(rig.publisher.published().length, 0, 'a restart published the same entry a second time');
  }, { storage });
});

test('a restart mid-flight finds its own job by MARKER and confirms rather than resubmitting', async () => {
  const storage = createMemoryLedgerStorage();
  const worker = await startFakeSabnzbd({ apiKey: API_KEY });
  try {
    // A crash between the reservation and the confirmation: the ledger has a reservation, the worker has the
    // job. This is the state the whole marker mechanism exists to resolve.
    const before = UsenetJobLedger.open(storage);
    const reservation = before.reserve({ sealedSource: SOURCE, itemId: ITEM });
    const client = new SabClient({
      endpoint: worker.endpoint, apiKey: seal('sab-api-key', API_KEY),
      transport: createSabHttpTransport(), sleep: async () => undefined,
    });
    const accepted = await client.submitUrl(SOURCE, reservation.job.marker);
    assert(accepted.ok, 'the setup submission failed');
    worker.setQueueStatus(reservation.job.marker, 'Downloading');

    const after = UsenetJobLedger.open(storage);
    assertEq(after.get(reservation.job.key)?.phase, 'reserved', 'the replayed phase');
    const service = new UsenetAdmissionService({
      client,
      ledger: after,
      fs: createFakeFileSystem(baseTree()),
      clock: createFakeClock(),
      publisher: createFakePublisher(),
      completedRoot: ROOT,
      rootId: 'media',
      completedRootUnderMediaRoot: ['usenet-complete'],
      category: USENET_DEDICATED_CATEGORY,
    });
    const outcomes = await service.reconcileAll();
    assertEq(outcomes[0]?.state, 'downloading', 'the recovered state');
    assertEq(after.get(reservation.job.key)?.phase, 'submitted', 'the reservation was not confirmed by looking');
    assertEq(worker.submitCount(), 1, 'the recovery resubmitted rather than looked');
  } finally {
    await worker.close();
  }
});

test('a reservation whose submission never landed is recorded as lost and may be submitted again', async () => {
  const storage = createMemoryLedgerStorage();
  await withRig(async (rig) => {
    const reservation = rig.ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
    const outcomes = await rig.service.reconcileAll();
    assertEq(outcomes[0]?.reason, 'job-absent-from-worker', 'the reason');
    assertEq(rig.ledger.get(reservation.job.key)?.phase, 'reserved', 'the phase after a lost submission');
    assertEq(rig.worker.submitCount(), 0, 'reconciliation submitted rather than looked');
  }, { storage });
});

h.section('§5.7 — the worker going away');

test('an unreachable worker leaves every job exactly where it was, with a named transient reason', async () => {
  await withRig(async (rig) => {
    const submitted = await rig.service.submit(SOURCE, ITEM);
    rig.worker.setQueueStatus(submitted.marker, 'Downloading');
    await rig.service.reconcileAll();
    rig.worker.setFaults({ rejectCredential: true });

    const outcomes = await rig.service.reconcileAll();
    assertEq(outcomes.length, 1, 'the job disappeared from the report');
    assertEq(outcomes[0]?.reason, 'worker-rejected-credential', 'the reason');
    assertEq(outcomes[0]?.changed, false, 'an unreachable worker changed a job');
    assertEq(rig.ledger.get(submitted.key)?.lastObservedState, 'downloading', 'the last known state moved');
  });
});

test('a worker whose history is unreadable does not admit on the queue reading alone', async () => {
  await withRig(async (rig) => {
    const submitted = await rig.service.submit(SOURCE, ITEM);
    rig.worker.complete(submitted.marker, { storagePath: `${ROOT}/Some.Job`, bytes: SMALL_MEDIA_BYTES });
    rig.worker.setFaults({ malformedDocument: true });
    const outcomes = await rig.service.reconcileAll();
    assertEq(outcomes[0]?.reason, 'worker-response-malformed', 'the reason');
    assertEq(rig.publisher.published().length, 0, 'published on a partial reading');
  });
});

h.section('a publish that fails');

test('a failed publish is transient, records no admission, and the next reconciliation succeeds', async () => {
  await withRig(async (rig) => {
    const submitted = await rig.service.submit(SOURCE, ITEM);
    rig.worker.complete(submitted.marker, { storagePath: `${ROOT}/Some.Job`, bytes: SMALL_MEDIA_BYTES });

    const first = await rig.service.reconcileAll();
    assertEq(first[0]?.state, 'refused', 'a failing publish was recorded as an admission');
    assertEq(rig.ledger.get(submitted.key)?.admitted, null, 'an admission was recorded for a publish that failed');

    rig.ledger.clearTransientRefusal(submitted.key);
    const second = await rig.service.reconcileAll();
    assertEq(second[0]?.state, 'admitted', 'the retry did not admit');
    assertEq(rig.publisher.published().length, 1, 'the retry published more than once');
  }, { publisherFailTimes: 1 });
});

h.section('what a reconciliation outcome may carry');

test('no outcome carries a URL, a completed path, a release name or a worker job id', async () => {
  await withRig(async (rig) => {
    const submitted = await rig.service.submit(SOURCE, ITEM);
    rig.worker.complete(submitted.marker, { storagePath: `${ROOT}/Some.Job`, bytes: SMALL_MEDIA_BYTES });
    const outcomes = await rig.service.reconcileAll();
    const text = JSON.stringify(outcomes);
    assert(!text.includes('indexer.example'), 'an outcome carries the NZB source');
    assert(!text.includes('/downloads/'), 'an outcome carries the completed path');
    assert(!text.includes('SABnzbd_nzo'), 'an outcome carries the worker job id');
    assert(text.includes('usenet/Some.Job/feature.mkv'), 'an outcome must say what it published');
  });
});

test('the ledger\'s own bytes carry none of them either, after a whole successful run', async () => {
  const storage = createMemoryLedgerStorage();
  await withRig(async (rig) => {
    const submitted = await rig.service.submit(SOURCE, ITEM);
    rig.worker.setQueueStatus(submitted.marker, 'Repairing');
    await rig.service.reconcileAll();
    rig.worker.complete(submitted.marker, { storagePath: `${ROOT}/Some.Job`, bytes: SMALL_MEDIA_BYTES });
    await rig.service.reconcileAll();
  }, { storage });
  const text = (storage as LedgerStorage & { lines(): readonly string[] }).lines().join('\n');
  assert(!text.includes('indexer.example'), 'the ledger carries the NZB source');
  assert(!text.includes('/downloads/'), 'the ledger carries the completed path');
  assert(!text.includes('SABnzbd_nzo'), 'the ledger carries the worker job id');
});

h.section('stateOf');

test('a job with no observation yet reads as downloading rather than as unknown', async () => {
  await withRig(async (rig) => {
    const reservation = rig.ledger.reserve({ sealedSource: SOURCE, itemId: ITEM });
    assertEq(stateOf(reservation.job), 'downloading', 'a fresh reservation');
  });
});

h.section('wiring');

test('the admission service has no verb that retires, degrades or deletes an entry', () => {
  const source = read('src/core/usenet/admission.ts');
  for (const verb of ['retireEntry', 'degradeEntry', 'unlink', 'rm(', 'rename(', 'deletion']) {
    assert(!source.includes(verb),
      `the admission service can ${verb}, and §1 says a Usenet failure shall not empty, rename or make `
      + 'unavailable any already-admitted entry');
  }
});

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/usenet-admission.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'usenet-admission.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

await h.finish();
