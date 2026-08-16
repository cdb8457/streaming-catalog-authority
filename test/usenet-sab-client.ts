import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import { SabClient, clampTimeout, type SabTransport, type SabTransportRequest } from '../src/core/usenet/sab-client.js';
import { createSabHttpTransport } from '../src/core/usenet/sab-http-transport.js';
import { startFakeSabnzbd, type FakeSabService } from '../src/core/usenet/sab-fake-service.js';
import { seal } from '../src/core/usenet/sealed.js';
import { SAB_CLIENT_BOUNDS, submissionMarkerFor } from '../src/core/usenet/sab-contract.js';

// Projection Phase 9 §3, FIRST DELIVERABLE — the boundary suite, run against a fake SABnzbd BEFORE any real
// server is contacted.
//
// IT DRIVES THE SHIPPED TRANSPORT OVER REAL HTTP. The fake worker is a `node:http` server on loopback, so the
// path under test is the whole one: query composition, the credential in the request line, the byte bound
// enforced during the read, the socket destroyed at the bound, the timeout, the non-JSON body, the 401. A
// suite that stubbed the transport would prove the parser and leave the part that could leak a credential
// entirely unexercised.
//
// NOTHING HERE CONTACTS A REAL SABNZBD, A REAL INDEXER OR A REAL USENET PROVIDER, and nothing here can: the
// only endpoint any client in this file is given is the loopback port the fake server just bound.

const h = createHarness('Projection Phase 9 — the SABnzbd client boundary');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

const API_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const KEY = seal('sab-api-key', API_KEY);
const SOURCE = seal('nzb-source', 'https://indexer.example/getnzb?id=42&apikey=indexerkeyindexerkey');
const MARKER = submissionMarkerFor('b'.repeat(32));
const STORAGE = '/downloads/complete/projection/Some.Release/file.mkv';

/** Start a fake worker, hand a client to `fn`, and close it whatever happens. */
async function withWorker(
  fn: (client: SabClient, worker: FakeSabService) => Promise<void>,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const worker = await startFakeSabnzbd({ apiKey: API_KEY });
  try {
    const client = new SabClient({
      endpoint: worker.endpoint,
      apiKey: KEY,
      transport: createSabHttpTransport(),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      sleep: async () => undefined,
    });
    await fn(client, worker);
  } finally {
    await worker.close();
  }
}

h.section('the five operations, against a well-behaved worker');

test('version and status are read and bounded', async () => {
  await withWorker(async (client) => {
    const version = await client.version();
    assert(version.ok, 'version was refused');
    assertEq(version.value.version, '4.3.2', 'the version');
    const status = await client.status();
    assert(status.ok, 'status was refused');
    assertEq(status.value.paused, false, 'paused');
  });
});

test('a submission is accepted once and returns one sealed job reference', async () => {
  await withWorker(async (client, worker) => {
    const result = await client.submitUrl(SOURCE, MARKER);
    assert(result.ok, 'the submission was refused');
    assertEq(result.value.jobRef.kind, 'job-ref', 'the job reference is sealed');
    assertEq(worker.submitCount(), 1, 'exactly one submission reached the worker');
    assertEq(worker.requests[worker.requests.length - 1]?.marker, MARKER, 'the marker travelled');
    assertEq(worker.requests[worker.requests.length - 1]?.category, 'projection', 'the dedicated category travelled');
  });
});

test('the queue is parsed into closed-set states with sealed references and no release names', async () => {
  await withWorker(async (client, worker) => {
    await client.submitUrl(SOURCE, MARKER);
    worker.setQueueStatus(MARKER, 'Downloading');
    const queue = await client.queue();
    assert(queue.ok, 'the queue was refused');
    assertEq(queue.value.length, 1, 'one slot');
    const slot = queue.value[0];
    assertEq(slot?.status, 'Downloading', 'the status');
    assertEq(slot?.marker, MARKER, 'the marker survives the .nzb suffix the worker appends');
    assertEq(JSON.stringify(slot), JSON.stringify({
      jobRef: '[sealed:job-ref]', status: 'Downloading', marker: MARKER, category: 'projection', bytesLeft: 0,
    }), 'the slot stringifies with no worker job id');
  });
});

test('history carries a sealed storage path and a failure BOOLEAN rather than the worker\'s message', async () => {
  await withWorker(async (client, worker) => {
    await client.submitUrl(SOURCE, MARKER);
    worker.complete(MARKER, { storagePath: STORAGE, bytes: 4096 });
    const history = await client.history();
    assert(history.ok, 'history was refused');
    const slot = history.value[0];
    assertEq(slot?.status, 'Completed', 'the status');
    assertEq(slot?.storagePath?.reveal(), STORAGE, 'the path is available to the admission service');
    assert(!JSON.stringify(slot).includes('/downloads/'), 'the slot stringifies without the path');
    assertEq(slot?.failed, false, 'not failed');
  });
});

test('a failed job carries failed=true and none of the worker\'s message text', async () => {
  await withWorker(async (client, worker) => {
    await client.submitUrl(SOURCE, MARKER);
    worker.failJob(MARKER, 'Some.Release.2024.1080p.x265 could not be repaired by news.example');
    const history = await client.history();
    assert(history.ok, 'history was refused');
    const slot = history.value[0];
    assertEq(slot?.status, 'Failed', 'the status');
    assertEq(slot?.failed, true, 'failed');
    const text = JSON.stringify(slot);
    assert(!text.includes('Some.Release'), 'the release name reached the parsed slot');
    assert(!text.includes('news.example'), 'the provider name reached the parsed slot');
  });
});

h.section('failing closed');

const faultCases: ReadonlyArray<[string, Record<string, unknown>, string]> = [
  ['a rejected credential', { rejectCredential: true }, 'worker-rejected-credential'],
  ['an API-level key error at HTTP 200', { apiError: 'API Key Required' }, 'worker-rejected-credential'],
  ['an API-level error that is not about the key', { apiError: 'unusable NZB' }, 'worker-response-malformed'],
  ['a body that is not JSON', { nonJsonBody: true }, 'worker-response-malformed'],
  ['a 500', { httpStatus: 500 }, 'worker-unreachable'],
  ['a document that is not shaped like one', { malformedDocument: true }, 'worker-response-malformed'],
  ['a slot with no job reference', { slotsMissingJobRef: true }, 'worker-response-malformed'],
  ['a queue state no contract defines', { unknownQueueStatus: 'Teleporting' }, 'worker-state-unrecognised'],
];

for (const [label, faults, expected] of faultCases) {
  test(`${label} fails closed as ${expected}`, async () => {
    // The worker starts WELL-BEHAVED and takes one submission first, so that the queue it then answers badly
    // has a slot in it. A fault injected into an empty queue would be a fault nothing had to parse.
    const worker = await startFakeSabnzbd({ apiKey: API_KEY });
    try {
      const client = new SabClient({
        endpoint: worker.endpoint, apiKey: KEY, transport: createSabHttpTransport(), sleep: async () => undefined,
      });
      const submitted = await client.submitUrl(SOURCE, MARKER);
      assert(submitted.ok, 'the setup submission was refused');
      worker.setQueueStatus(MARKER, 'Downloading');
      worker.setFaults(faults);
      const result = await client.queue();
      assert(!result.ok, `${label} produced a reading`);
      assertEq(result.reason, expected as never, `${label} reason`);
    } finally {
      await worker.close();
    }
  });
}

test('an unknown HISTORY state fails closed rather than being read as complete', async () => {
  const worker = await startFakeSabnzbd({ apiKey: API_KEY, faults: { unknownHistoryStatus: 'Teleported' } });
  try {
    const client = new SabClient({ endpoint: worker.endpoint, apiKey: KEY, transport: createSabHttpTransport(), sleep: async () => undefined });
    await client.submitUrl(SOURCE, MARKER);
    worker.complete(MARKER, { storagePath: STORAGE, bytes: 4096 });
    const history = await client.history();
    assert(!history.ok, 'an unrecognised history state produced a reading');
    assertEq(history.reason, 'worker-state-unrecognised', 'the reason');
  } finally {
    await worker.close();
  }
});

test('a body larger than the bound is refused rather than buffered', async () => {
  const worker = await startFakeSabnzbd({
    apiKey: API_KEY,
    faults: { oversizedBytes: SAB_CLIENT_BOUNDS.MAX_RESPONSE_BYTES + 1024 },
  });
  try {
    const client = new SabClient({ endpoint: worker.endpoint, apiKey: KEY, transport: createSabHttpTransport(), sleep: async () => undefined });
    const result = await client.queue();
    assert(!result.ok, 'an oversized body produced a reading');
    assertEq(result.reason, 'worker-response-too-large', 'the reason');
  } finally {
    await worker.close();
  }
});

test('a worker that never answers is a timeout, and the timeout is the client\'s not the kernel\'s', async () => {
  const worker = await startFakeSabnzbd({ apiKey: API_KEY, faults: { hang: true } });
  try {
    const client = new SabClient({
      endpoint: worker.endpoint, apiKey: KEY, transport: createSabHttpTransport(),
      timeoutMs: 300, sleep: async () => undefined,
    });
    const started = Date.now();
    const result = await client.version();
    const elapsed = Date.now() - started;
    assert(!result.ok, 'a hanging worker produced a reading');
    assertEq(result.reason, 'worker-unreachable', 'the reason');
    // Three attempts at 300 ms plus a no-op backoff. Generous ceiling; the point is that it ENDS.
    assert(elapsed < 10_000, `the client waited ${elapsed}ms rather than honouring its own timeout`);
  } finally {
    await worker.close();
  }
});

test('a closed port is unreachable rather than an exception escaping to the caller', async () => {
  const worker = await startFakeSabnzbd({ apiKey: API_KEY });
  const endpoint = worker.endpoint;
  await worker.close();
  const client = new SabClient({ endpoint, apiKey: KEY, transport: createSabHttpTransport(), sleep: async () => undefined });
  const result = await client.version();
  assert(!result.ok, 'a closed port produced a reading');
  assertEq(result.reason, 'worker-unreachable', 'the reason');
});

h.section('retries, and the one operation that has none');

test('a read is retried up to the bound; a submission is attempted exactly once', async () => {
  let reads = 0;
  let submits = 0;
  const transport: SabTransport = {
    async request(request: SabTransportRequest) {
      if (request.operation === 'submit-url') submits += 1;
      else reads += 1;
      throw new Error('connection refused');
    },
  };
  const client = new SabClient({
    endpoint: { host: '127.0.0.1', port: 1, scheme: 'http' }, apiKey: KEY, transport, sleep: async () => undefined,
  });
  await client.queue();
  assertEq(reads, SAB_CLIENT_BOUNDS.MAX_READ_ATTEMPTS, 'a read is retried to the bound');
  await client.submitUrl(SOURCE, MARKER);
  assertEq(submits, 1,
    'a submission that timed out MAY have reached the worker, so repeating it is a second download on '
    + 'somebody\'s metered account');
});

test('a malformed answer is not retried, because it will be malformed again', async () => {
  let calls = 0;
  const transport: SabTransport = {
    async request() { calls += 1; return { status: 200, body: { queue: 'nonsense' } }; },
  };
  const client = new SabClient({
    endpoint: { host: '127.0.0.1', port: 1, scheme: 'http' }, apiKey: KEY, transport, sleep: async () => undefined,
  });
  const result = await client.queue();
  assert(!result.ok, 'a malformed answer produced a reading');
  assertEq(calls, 1, 'a malformed answer was retried');
});

h.section('what a submission refuses to do');

test('a submission refuses an unsealed source, a wrong seal kind and a release-name marker', async () => {
  await withWorker(async (client, worker) => {
    const wrongKind = await client.submitUrl(seal('completed-path', '/downloads/x'), MARKER);
    assert(!wrongKind.ok && wrongKind.reason === 'nzb-source-not-approved', 'a completed path is not a source');
    const badMarker = await client.submitUrl(SOURCE, 'Some.Release.2024.1080p');
    assert(!badMarker.ok && badMarker.reason === 'nzb-source-not-approved', 'a release name is not a marker');
    assertEq(worker.submitCount(), 0, 'a refused submission must not reach the worker at all');
  });
});

test('a worker returning two job ids from one submission is a refusal', async () => {
  const worker = await startFakeSabnzbd({ apiKey: API_KEY, faults: { submitReturnsIds: 2 } });
  try {
    const client = new SabClient({ endpoint: worker.endpoint, apiKey: KEY, transport: createSabHttpTransport(), sleep: async () => undefined });
    const result = await client.submitUrl(SOURCE, MARKER);
    assert(!result.ok, 'a fan-out submission produced an accepted reading');
    assertEq(result.reason, 'worker-response-malformed', 'the reason');
  } finally {
    await worker.close();
  }
});

test('a worker that declines the submission is a refusal rather than a silent success', async () => {
  const worker = await startFakeSabnzbd({ apiKey: API_KEY, faults: { submitDeclines: true } });
  try {
    const client = new SabClient({ endpoint: worker.endpoint, apiKey: KEY, transport: createSabHttpTransport(), sleep: async () => undefined });
    const result = await client.submitUrl(SOURCE, MARKER);
    assert(!result.ok, 'a declined submission was read as accepted');
  } finally {
    await worker.close();
  }
});

h.section('the credential, and where it is allowed to exist');

test('the client describes itself by fingerprint, never by key, host or port', async () => {
  await withWorker(async (client) => {
    const described = client.describe();
    assertEq(described.worker, 'SABnzbd', 'the worker');
    assert(/^[0-9a-f]{12}$/.test(described.keyFingerprint), 'a fingerprint');
    const text = JSON.stringify(described);
    assert(!text.includes(API_KEY), 'the description carries the key');
    assert(!text.includes('127.0.0.1'), 'the description carries the address');
  });
});

test('the request the transport receives carries the key SEALED, and no query field holds it', async () => {
  const seen: SabTransportRequest[] = [];
  const transport: SabTransport = {
    async request(request) { seen.push(request); return { status: 200, body: { version: '4.3.2' } }; },
  };
  const client = new SabClient({
    endpoint: { host: '127.0.0.1', port: 1, scheme: 'http' }, apiKey: KEY, transport, sleep: async () => undefined,
  });
  await client.version();
  const request = seen[0];
  assert(request !== undefined, 'no request was made');
  assertEq(JSON.stringify(request.query).includes(API_KEY), false, 'the key is in the plain query');
  assertEq(request.apiKey.reveal(), API_KEY, 'the key travels as a sealed field');
  assert(!JSON.stringify(request).includes(API_KEY), 'the whole request stringifies without the key');
});

test('exactly one file in src/core/usenet reveals a secret, and it is the transport', () => {
  const directory = join(repoRoot, 'src/core/usenet');
  const revealing: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith('.ts')) continue;
    // Comment lines are dropped before counting: several files DISCUSS `.reveal()` in the argument for why
    // they do not call it, and a check that counted those would be a check that discouraged the explanation.
    const text = readFileSync(join(directory, entry), 'utf8')
      .split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    // `sealed.ts` DEFINES reveal, and `job-ledger.ts` reveals a source to DERIVE a key from it — neither is a
    // request composition. Every other reveal of an API key or an NZB source belongs in the transport.
    const calls = (text.match(/\.reveal\(\)/g) ?? []).length;
    if (calls > 0 && entry !== 'sealed.ts') revealing.push(`${entry}:${calls}`);
  }
  assertEq(revealing.sort().join(' '), 'admission.ts:1 job-ledger.ts:1 sab-http-transport.ts:2',
    // admission.ts reveals a COMPLETED PATH to open it; job-ledger.ts reveals an NZB SOURCE to derive a
    // submission key from it; the transport reveals the API key and the source to compose one request.

    'a new call site that turns a sealed value back into a string has appeared; each one is a place a '
    + 'credential, an NZB URL or a completed path can escape, and each one needs its own argument');
});

test('the transport composes its URL with no interpolation anywhere in the file', () => {
  const text = read('src/core/usenet/sab-http-transport.ts');
  const errors = text.match(/new SabTransportError\('[^']*'\)/g) ?? [];
  assert(errors.length >= 3, 'the transport does not construct its fixed error set');
  for (const error of errors) {
    assert(!error.includes('${'), 'a transport error message interpolates, and its inputs include the URL');
  }
  assert(!/console\.(log|error|warn)/.test(text), 'the transport logs, and the only thing it holds is a URL with a key in it');
});

h.section('the request timeout is a DEADLINE, not a silence timer');

test('A WORKER THAT DRIPS ONE BYTE AT A TIME IS CUT OFF AT THE TIMEOUT, not kept alive by it', async () => {
  // THE DEFECT THIS PINS. `ClientRequest.setTimeout` arms the SOCKET's inactivity timer: it fires when
  // nothing has moved for that long, and every byte received resets it. So a peer that answers with one byte
  // every fraction of the timeout holds the request open indefinitely — up to the eight-megabyte response
  // bound — while `SAB_CLIENT_BOUNDS` calls its number "per-request". A control plane whose reconciliation
  // pass can be held open by a wedged proxy is a control plane that stops reconciling anything.
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    // Well under the timeout, so the inactivity timer alone would never fire.
    const drip = setInterval(() => { response.write('{'); }, 50);
    response.on('close', () => { clearInterval(drip); });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve(); }); });
  const address = server.address();
  assert(address !== null && typeof address !== 'string', 'the drip server did not bind');
  try {
    const client = new SabClient({
      endpoint: { host: '127.0.0.1', port: (address as { port: number }).port, scheme: 'http' },
      apiKey: KEY,
      transport: createSabHttpTransport(),
      timeoutMs: SAB_CLIENT_BOUNDS.TIMEOUT_MS.min,
      sleep: async () => undefined,
    });
    const startedAt = Date.now();
    const version = await client.version();
    const elapsed = Date.now() - startedAt;
    assert(!version.ok, 'a request that never finished produced a reading');
    assertEq(version.reason, 'worker-unreachable', 'the reason');
    // Three read attempts, each bounded by the deadline, plus the backoff the client was told to skip. A
    // generous ceiling: what is being asserted is that it ENDS, not how fast.
    assert(elapsed < 10_000, `the request was not bounded by its own timeout: ${elapsed}ms`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  }
});

h.section('a history reading is COMPLETE or it is a refusal, because absence is used as proof');

/**
 * Fill the fake worker's history with `count` completed jobs it did not have to be submitted to hold.
 *
 * The submissions go through `addurl` exactly as a real one would, so every slot the client later reads is a
 * slot the fake composes the ordinary way.
 */
async function seedHistory(worker: FakeSabService, count: number): Promise<string[]> {
  const markers: string[] = [];
  const client = new SabClient({
    endpoint: worker.endpoint, apiKey: KEY, transport: createSabHttpTransport(), sleep: async () => undefined,
  });
  for (let index = 0; index < count; index += 1) {
    const marker = submissionMarkerFor(index.toString(16).padStart(32, '0'));
    const accepted = await client.submitUrl(SOURCE, marker);
    assert(accepted.ok, `the fake worker declined seed submission ${index}`);
    worker.complete(marker, { storagePath: `${STORAGE}.${index}`, bytes: 1024 });
    markers.push(marker);
  }
  return markers;
}

test('A HISTORY LONGER THAN ONE PAGE IS READ WHOLE, so a job on page two is not read as absent', async () => {
  // THE DEFECT THIS PINS. `admission.ts` reads "absent from the queue and absent from the history" as proof
  // that a submission never reached the worker, and acts on that proof by recording the reservation LOST —
  // the one state in which the same source may be sent again. A single-page reading made that proof false
  // for any operator whose dedicated category held more than one page of completed jobs: the job is at the
  // worker, it is on page two, and the control plane would have told them to download it a second time.
  const worker = await startFakeSabnzbd({ apiKey: API_KEY });
  try {
    const total = SAB_CLIENT_BOUNDS.HISTORY_PAGE_LIMIT + 7;
    const markers = await seedHistory(worker, total);
    const client = new SabClient({
      endpoint: worker.endpoint, apiKey: KEY, transport: createSabHttpTransport(), sleep: async () => undefined,
    });
    const history = await client.history();
    assert(history.ok, `a multi-page history was refused: ${history.ok ? '' : history.reason}`);
    assertEq(history.value.length, total, 'the reading did not carry every history entry');

    const seen = new Set(history.value.map((slot) => slot.marker));
    const last = markers[markers.length - 1] as string;
    assert(seen.has(last), 'the entry beyond the first page is missing, so absence from this reading is not absence');
    assertEq(new Set(history.value.map((slot) => slot.jobRef.fingerprint())).size, total,
      'the pages overlapped and the reading double-counted a job');
  } finally {
    await worker.close();
  }
});

test('a worker that ignores `start` is REFUSED rather than having its first page read as the whole history', async () => {
  const worker = await startFakeSabnzbd({ apiKey: API_KEY });
  try {
    await seedHistory(worker, SAB_CLIENT_BOUNDS.HISTORY_PAGE_LIMIT + 3);
    worker.setFaults({ historyIgnoresStart: true });
    const client = new SabClient({
      endpoint: worker.endpoint, apiKey: KEY, transport: createSabHttpTransport(), sleep: async () => undefined,
    });
    const history = await client.history();
    assert(!history.ok, 'a worker that cannot be paged produced a reading anyway');
    assertEq(history.reason, 'worker-response-malformed', 'the reason');
  } finally {
    await worker.close();
  }
});

test('a worker that states more history than it returned is refused', async () => {
  await withWorker(async (client, worker) => {
    const accepted = await client.submitUrl(SOURCE, MARKER);
    assert(accepted.ok, 'the submission was declined');
    worker.complete(MARKER, { storagePath: STORAGE, bytes: 1024 });
    worker.setFaults({ understatesSlots: true });
    const history = await client.history();
    assert(!history.ok, 'a truncated history was read as a complete one');
    assertEq(history.reason, 'worker-response-too-large', 'the reason');
  });
});

test('a queue that states more slots than it returned is refused, for the same reason', async () => {
  await withWorker(async (client, worker) => {
    const accepted = await client.submitUrl(SOURCE, MARKER);
    assert(accepted.ok, 'the submission was declined');
    worker.setFaults({ understatesSlots: true });
    const queue = await client.queue();
    assert(!queue.ok, 'a truncated queue was read as a complete one');
    assertEq(queue.reason, 'worker-response-too-large', 'the reason');
  });
});

h.section('bounds and wiring');

test('a timeout outside the bound is clamped rather than honoured', () => {
  assertEq(clampTimeout(undefined), SAB_CLIENT_BOUNDS.TIMEOUT_MS.default, 'the default');
  assertEq(clampTimeout(1), SAB_CLIENT_BOUNDS.TIMEOUT_MS.min, 'the floor');
  assertEq(clampTimeout(10_000_000), SAB_CLIENT_BOUNDS.TIMEOUT_MS.max, 'the ceiling');
  assertEq(clampTimeout(1.5), SAB_CLIENT_BOUNDS.TIMEOUT_MS.default, 'a non-integer falls back to the default');
});

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/usenet-sab-client.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'usenet-sab-client.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

await h.finish();
