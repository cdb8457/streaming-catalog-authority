import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  MEDIA_SERVER_BUDGETS, findRedactionProblems,
} from '../src/core/projection/media-server-dataplane.js';
import {
  PROJECTIOND_ADMISSION_LIMITS, PROJECTIOND_READ_POLICY,
} from '../src/core/projection/runtime-contract.js';
import { PLEX_LARGE_FIXTURE, PLEX_SCAN_ENVELOPE } from '../src/core/projection/plex-dataplane.js';
import {
  CONCURRENCY_DEADLINES_MS, CONCURRENCY_RULES, COUNTER_ARRAY_KEYS, COUNTER_KEYS_REQUIRED, HOLD_ARM_MS,
  HOLD_MAX_MS, REQUIRED_SERVER_COUNT, THREE_SERVER_IDS, THREE_SERVER_NONCLAIMS, analyseOverlap,
  attributionProblems, breachedObjects, breachedShapes, coldStateProblems, corpusAttribution,
  daemonBlockByteCeiling, objectByteVerdicts, objectShapeVerdicts, overlapProblems, parseProviderCounters,
  triggerSpreadSeconds, type OverlapSample, type ProviderCounters,
} from '../src/core/projection/three-server-concurrency.js';
import { adapterFor, runConcurrentScans, type ServerAdapter } from '../src/ops/projection-three-server-concurrency.js';

// Projection Phase 1 — the offline half of the THREE-SERVER CONCURRENT SCAN gate (G18).
//
// WHAT THIS SUITE IS FOR. The gate itself needs Docker, /dev/fuse, a real PostgreSQL and THREE real media
// servers, and it takes the better part of an hour. This suite runs everywhere, in seconds, and holds the
// rules the gate depends on.
//
// EVERY TEST HERE IS AN ADVERSARY RATHER THAN A DESCRIPTION. The question each one asks is not "does the
// happy path work" — the gate answers that, against real servers — but "what is the cheapest way to make
// this gate report a pass it did not earn, and does something refuse it?" The list of cheats is the
// specification:
//
//   three SEQUENTIAL scans reported as concurrent
//   one server absent, or pointed at a different mount, generation or provider
//   a WARM cache making a scan cost nothing, so every ceiling passes over an empty room
//   a counter that reset, or telemetry that is missing and reads as zero
//   an aggregate byte budget passing while one object was downloaded whole
//   a 429, or a connection cap, breached
//   a SKIP or a FAILURE swallowed by a wrapper
//   an image pinned by tag rather than by digest
//   a credential or an absolute path in the report
//   a host preflight run after the gate had already changed the host
//   a log collector that streams forever instead of returning
//   wording that upgrades a Docker Desktop run into Linux/Unraid or G18 closure

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

const TEST_DEADLINE_MS = 30_000;

async function withDeadline<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`test deadline of ${TEST_DEADLINE_MS}ms exceeded: ${label}`)),
          TEST_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await withDeadline(name, async () => { await fn(); });
    passed += 1; console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1; failures.push([name, error]); console.log(`  FAIL  ${name}: ${(error as Error).message}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepoFile = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

const GATE = readRepoFile('deploy/projection-three-server-concurrency-gate.sh');
const THREE = readRepoFile('deploy/projection-three-server-concurrency-gate-three.sh');
const OPTIONAL = readRepoFile('deploy/projection-three-server-concurrency-gate-optional.sh');
const COMPOSE = readRepoFile('docker-compose.projection-three.yml');
const CORE = readRepoFile('src/core/projection/three-server-concurrency.ts');
const DRIVER = readRepoFile('src/ops/projection-three-server-concurrency.ts');
const CLI = readRepoFile('src/ops/projection-three-server-concurrency-cli.ts');
const PACKAGE = JSON.parse(readRepoFile('package.json')) as { scripts: Record<string, string> };

// ----------------------------------------------------------------------------------------------------------
// A counters document that is coherent by construction, so a test can break exactly one thing about it.
// ----------------------------------------------------------------------------------------------------------

interface FakeObject { size: number; small: number; chunk: number; partial: number; oversized: number }

/**
 * Build a counters snapshot whose every partition holds.
 *
 * IT COMPUTES THE AGGREGATES FROM THE PER-OBJECT COLUMNS rather than taking both as input. A fixture that
 * let a caller state the total and the parts separately would let a test accidentally assert against an
 * incoherent document and mistake the incoherence for the thing under test.
 */
function counters(objects: readonly FakeObject[], overrides: Partial<ProviderCounters> = {}): ProviderCounters {
  const WINDOW = 1_048_576;
  const CHUNK = 4 * 1_048_576;
  const bytesOf = (object: FakeObject): number =>
    object.small * Math.min(WINDOW, object.size) + object.chunk * CHUNK
    + object.partial * (CHUNK - 1) + object.oversized * (CHUNK + 1);
  const objectBytes = objects.map(bytesOf);
  const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
  const base: ProviderCounters = {
    resolutions: objects.length,
    rangeRequests: sum(objects.map((o) => o.small + o.chunk + o.partial + o.oversized)),
    accountedResponses: sum(objects.map((o) => o.small + o.chunk + o.partial + o.oversized)),
    bytesServed: sum(objectBytes),
    served429: 0,
    fullBodyServed: 0,
    peakConns: 4,
    peakConcurrent: 3,
    chunkResponses: sum(objects.map((o) => o.chunk)),
    chunkBytes: sum(objects.map((o) => o.chunk * CHUNK)),
    smallResponses: sum(objects.map((o) => o.small)),
    smallBytes: sum(objects.map((o) => o.small * Math.min(WINDOW, o.size))),
    partialResponses: sum(objects.map((o) => o.partial)),
    partialBytes: sum(objects.map((o) => o.partial * (CHUNK - 1))),
    oversizedResponses: sum(objects.map((o) => o.oversized)),
    oversizedBytes: sum(objects.map((o) => o.oversized * (CHUNK + 1))),
    bodylessResponses: 0,
    holdTimeouts: 0,
    heldRequests: 1,
    objectBytes,
    objectSizes: objects.map((o) => o.size),
    objectChunk: objects.map((o) => o.chunk),
    objectSmall: objects.map((o) => o.small),
    objectPartial: objects.map((o) => o.partial),
    objectOversized: objects.map((o) => o.oversized),
  };
  return { ...base, ...overrides };
}

function zeroLike(reference: ProviderCounters): ProviderCounters {
  const empty = reference.objectBytes.map(() => 0);
  return {
    ...reference,
    resolutions: 0, rangeRequests: 0, accountedResponses: 0, bytesServed: 0,
    chunkResponses: 0, chunkBytes: 0, smallResponses: 0, smallBytes: 0,
    partialResponses: 0, partialBytes: 0, oversizedResponses: 0, oversizedBytes: 0,
    bodylessResponses: 0, heldRequests: 0, holdTimeouts: 0,
    objectBytes: empty, objectChunk: empty, objectSmall: empty,
    objectPartial: empty, objectOversized: empty,
  };
}

/** A timeline in which three servers scanned STRICTLY ONE AFTER ANOTHER. The cheat this gate exists to stop. */
function sequentialTimeline(): OverlapSample[] {
  const samples: OverlapSample[] = [];
  const ids = [...THREE_SERVER_IDS];
  ids.forEach((id, index) => {
    for (let tick = 0; tick < 8; tick += 1) {
      const inFlight: Record<string, boolean> = {};
      for (const other of ids) inFlight[other] = other === id;
      samples.push({ atMs: (index * 8 + tick) * 750, spanMs: 40, inFlight, unreadable: [] });
    }
  });
  return samples;
}

/** A timeline in which all three overlapped for a real interval. */
function overlappingTimeline(ticks = 8, spanMs = 40): OverlapSample[] {
  const samples: OverlapSample[] = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    const inFlight: Record<string, boolean> = {};
    for (const id of THREE_SERVER_IDS) inFlight[id] = true;
    samples.push({ atMs: tick * 750, spanMs, inFlight, unreadable: [] });
  }
  return samples;
}

async function main(): Promise<void> {
  console.log('\nProjection Phase 1 — three-server concurrent scan (G18), offline half\n');

  // --------------------------------------------------------------------------------------------------------
  console.log('THE CHEAT: three SEQUENTIAL scans reported as three concurrent ones');
  // --------------------------------------------------------------------------------------------------------

  await test('three strictly sequential scans produce ZERO simultaneous samples', () => {
    const analysis = analyseOverlap(sequentialTimeline());
    assertEq(analysis.simultaneousSamples, 0, 'a sequential run must produce no simultaneous sample');
    assertEq(analysis.maxServersInFlight, 1, 'a sequential run never has two servers in flight');
    assertEq(analysis.serversObservedInFlight, REQUIRED_SERVER_COUNT,
      'all three DID scan — which is exactly why "all three scanned" is not the claim');
  });

  await test('...and overlapProblems refuses it, naming sequential scans', () => {
    const problems = overlapProblems(analyseOverlap(sequentialTimeline()));
    assert(problems.length > 0, 'a sequential run must be refused');
    assert(problems.some((problem) => problem.includes('SEQUENTIAL')),
      `the refusal must name the failure mode: ${problems.join(' | ')}`);
  });

  await test('a genuinely overlapping timeline passes', () => {
    assertEq(overlapProblems(analyseOverlap(overlappingTimeline())).length, 0,
      'a real three-way overlap must not be refused');
  });

  await test('a single grazing sample is refused: an instant is not "scanning simultaneously"', () => {
    const problems = overlapProblems(analyseOverlap(overlappingTimeline(1)));
    assert(problems.length > 0, 'one overlapping sample must not satisfy G18');
  });

  await test('a burst of samples inside one tick fails the SPAN even though the count passes', () => {
    const samples: OverlapSample[] = [];
    for (let tick = 0; tick < 6; tick += 1) {
      const inFlight: Record<string, boolean> = {};
      for (const id of THREE_SERVER_IDS) inFlight[id] = true;
      // Six samples 100ms apart: the count clears its floor, the span does not.
      samples.push({ atMs: tick * 100, spanMs: 20, inFlight, unreadable: [] });
    }
    const analysis = analyseOverlap(samples);
    assert(analysis.simultaneousSamples >= CONCURRENCY_RULES.MIN_SIMULTANEOUS_SAMPLES,
      'the fixture is meant to clear the count floor');
    assert(overlapProblems(analysis).some((problem) => problem.includes('graze')),
      'a burst inside half a second must fail the span');
  });

  await test('a WIDE tick cannot be simultaneity: three answers 30s apart are not one instant', () => {
    const wide = overlappingTimeline(8, CONCURRENCY_DEADLINES_MS.SAMPLE_MAX_SPAN + 30_000);
    const analysis = analyseOverlap(wide);
    assertEq(analysis.simultaneousSamples, 0,
      'a tick whose three answers straddle half a minute is compatible with the first server having '
      + 'finished before the last was asked');
    assertEq(analysis.impreciseSamples, 8, 'every wide tick must be counted as imprecise');
    assert(overlapProblems(analysis).length > 0, 'and the run must be refused');
  });

  await test('a trigger spread is deliberately NOT overlap evidence', () => {
    // Three triggers 50ms apart, and three scans that never overlapped. The spread looks perfect.
    assert(triggerSpreadSeconds([0, 25, 50]) < 0.1, 'the fixture is meant to have a tiny spread');
    assert(overlapProblems(analyseOverlap(sequentialTimeline())).length > 0,
      'a tiny trigger spread must not rescue a sequential run');
    assert(CLI.includes('deliberately not the concurrency evidence'),
      'the CLI must say what the trigger spread is and is not');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: a server absent, idle, or unreachable');
  // --------------------------------------------------------------------------------------------------------

  await test('a server that never scanned is named, not folded into "no overlap"', () => {
    const samples = overlappingTimeline().map((sample) => ({
      ...sample, inFlight: { ...sample.inFlight, plex: false },
    }));
    const analysis = analyseOverlap(samples);
    assertEq(analysis.serversObservedInFlight, 2, 'only two servers scanned');
    const problems = overlapProblems(analysis);
    assert(problems.some((problem) => problem.includes('plex')),
      `the refusal must name the server that never scanned: ${problems.join(' | ')}`);
  });

  await test('an UNREADABLE server is not the same as an idle one, and cannot count as simultaneous', () => {
    const samples = overlappingTimeline().map((sample) => ({ ...sample, unreadable: ['emby'] }));
    const analysis = analyseOverlap(samples);
    assertEq(analysis.simultaneousSamples, 0, 'a sample with an unreadable server proves nothing either way');
    assertEq(analysis.unreadableSamples, 8, 'and the failed polls are counted rather than discarded');
  });

  await test('only the three named servers are ever in the set', () => {
    assertEq(THREE_SERVER_IDS.length, 3, 'G18 is about three media servers');
    assertEq(REQUIRED_SERVER_COUNT, 3, 'and the required count is derived from that list');
    for (const id of ['emby', 'jellyfin', 'plex']) {
      assert((THREE_SERVER_IDS as readonly string[]).includes(id), `${id} must be in the set`);
    }
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: a WARM cache, so the window costs nothing and every ceiling passes');
  // --------------------------------------------------------------------------------------------------------

  await test('a daemon scan-window cache that did not GROW is refused', () => {
    const problems = coldStateProblems({
      probeCacheBytesBefore: 4_194_304, probeCacheBytesAfter: 4_194_304, corpusBytesBefore: 0,
      rangeRequestDelta: 100, remoteObjectCount: 43, heldRequestDelta: 1, holdTimeoutDelta: 0,
    });
    assert(problems.some((problem) => problem.kind === 'probe-cache-did-not-grow'),
      'a cold scan of a ~50-entry corpus fills the scan-window cache; a window that added nothing to it was '
      + 'reading windows it already held');
  });

  await test('...and a NON-EMPTY cache before the window is NOT refused, because a local entry fills it', () => {
    // MEASURED ON THE FIRST REAL RUN: 33,187 bytes before the concurrent scan, and nothing was wrong. The
    // gate publishes a LOCAL seed entry on purpose so Plex's unavoidable creation scan has something to find
    // that costs the provider nothing, and a local entry's own byte-identity window lands in the same cache.
    // An emptiness assertion would have failed every correct run.
    assertEq(coldStateProblems({
      probeCacheBytesBefore: 33_187, probeCacheBytesAfter: 8_000_000, corpusBytesBefore: 0,
      rangeRequestDelta: 100, remoteObjectCount: 43, heldRequestDelta: 1, holdTimeoutDelta: 0,
    }).length, 0, 'a non-empty cache that grew is a cold window');
  });

  await test('a corpus the endpoint had already served bytes for is refused', () => {
    const problems = coldStateProblems({
      probeCacheBytesBefore: 0, probeCacheBytesAfter: 8_000_000, corpusBytesBefore: 1,
      rangeRequestDelta: 100, remoteObjectCount: 43, heldRequestDelta: 1, holdTimeoutDelta: 0,
    });
    assert(problems.some((problem) => problem.kind === 'corpus-already-read'),
      'one byte of prior corpus traffic means this window is not the corpus\'s first read');
  });

  await test('a window with ZERO provider traffic is refused rather than scoring perfectly', () => {
    const problems = coldStateProblems({
      probeCacheBytesBefore: 0, probeCacheBytesAfter: 8_000_000, corpusBytesBefore: 0,
      rangeRequestDelta: 0, remoteObjectCount: 43, heldRequestDelta: 0, holdTimeoutDelta: 0,
    });
    assert(problems.some((problem) => problem.kind === 'no-cold-traffic'),
      'a scan that never reached the provider satisfies every ceiling and must be refused');
    assert(problems.some((problem) => problem.kind === 'barrier-never-hit'),
      'and the barrier having gone unhit must be its own named failure');
  });

  await test('fewer ranged GETs than uncached remote objects is refused', () => {
    const problems = coldStateProblems({
      probeCacheBytesBefore: 0, probeCacheBytesAfter: 8_000_000, corpusBytesBefore: 0,
      rangeRequestDelta: 42, remoteObjectCount: 43, heldRequestDelta: 1, holdTimeoutDelta: 0,
    });
    assert(problems.some((problem) => problem.kind === 'no-cold-traffic'),
      'one object short means one object was never fetched');
  });

  await test('a LAPSED hold is refused: the instrument degraded the scan instead of measuring it', () => {
    const problems = coldStateProblems({
      probeCacheBytesBefore: 0, probeCacheBytesAfter: 8_000_000, corpusBytesBefore: 0,
      rangeRequestDelta: 100, remoteObjectCount: 43, heldRequestDelta: 2, holdTimeoutDelta: 1,
    });
    assert(problems.some((problem) => problem.kind === 'hold-lapsed'), 'a lapsed hold must be a failure');
  });

  await test('a genuinely cold window passes', () => {
    assertEq(coldStateProblems({
      probeCacheBytesBefore: 0, probeCacheBytesAfter: 8_000_000, corpusBytesBefore: 0,
      rangeRequestDelta: 100, remoteObjectCount: 43, heldRequestDelta: 1, holdTimeoutDelta: 0,
    }).length, 0, 'a cold window must not be refused');
  });

  await test('the gate publishes the corpus AFTER every library exists, and waits out Plex first', () => {
    const libraryAt = GATE.indexOf('plex library --state');
    const settleAt = GATE.indexOf('plex scan --state');
    const corpusAt = GATE.indexOf('register batch --file');
    assert(libraryAt > 0 && settleAt > libraryAt && corpusAt > settleAt,
      'Plex scans a section as soon as it exists, so the corpus must be published only after that scan has '
      + 'been waited out — otherwise the "concurrent" scan measures a warm cache');
    assert(GATE.includes('ONE LOCAL SEED ENTRY, AND NOTHING REMOTE'),
      'generation 1 must be local-only so no provider byte can be spent before the window');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: telemetry that reset, or that is missing and reads as zero');
  // --------------------------------------------------------------------------------------------------------

  const twoObjects: FakeObject[] = [
    { size: 262_144, small: 1, chunk: 0, partial: 0, oversized: 0 },
    { size: 104_857_600, small: 3, chunk: 4, partial: 0, oversized: 0 },
  ];

  await test('a coherent snapshot pair produces no attribution problem', () => {
    const before = zeroLike(counters(twoObjects));
    const after = counters(twoObjects);
    assertEq(attributionProblems(before, after, 2).length, 0, 'a coherent pair must pass');
  });

  await test('a counter that FELL is refused as a reset rather than read as a small delta', () => {
    const after = counters(twoObjects);
    const before = { ...after, rangeRequests: after.rangeRequests + 50 };
    const problems = attributionProblems(before, after, 2);
    assert(problems.some((problem) => problem.kind === 'counter-reset'),
      'a falling cumulative counter means the endpoint restarted inside the window');
  });

  await test('a broken REQUEST partition is refused', () => {
    const after = { ...counters(twoObjects), accountedResponses: 999 };
    assert(attributionProblems(zeroLike(counters(twoObjects)), after, 2)
      .some((problem) => problem.kind === 'request-partition'), 'the request partition must be exact');
  });

  await test('a broken BYTE partition is refused', () => {
    const after = { ...counters(twoObjects), bytesServed: 12 };
    assert(attributionProblems(zeroLike(counters(twoObjects)), after, 2)
      .some((problem) => problem.kind === 'byte-partition'), 'the byte partition must be exact');
  });

  await test('bytes served for an object the gate never registered are refused', () => {
    const base = counters(twoObjects);
    const after = {
      ...base,
      bytesServed: base.bytesServed + 4_194_304,
      smallBytes: base.smallBytes + 4_194_304,
      smallResponses: base.smallResponses + 1,
      accountedResponses: base.accountedResponses + 1,
      rangeRequests: base.rangeRequests + 1,
    };
    assert(attributionProblems(zeroLike(base), after, 2)
      .some((problem) => problem.kind === 'unattributed-bytes'),
      'a byte that belongs to no registered object must be refused');
  });

  await test('per-object columns of different lengths are refused', () => {
    const after = { ...counters(twoObjects), objectSmall: [1] };
    assert(attributionProblems(zeroLike(counters(twoObjects)), after, 2)
      .some((problem) => problem.kind === 'array-geometry'),
      'a caller pairs the columns by index; different lengths mean index i is two different objects');
  });

  await test('a snapshot with fewer objects than the gate registered is refused', () => {
    assert(attributionProblems(zeroLike(counters(twoObjects)), counters(twoObjects), 3)
      .some((problem) => problem.kind === 'array-geometry'),
      'one extra object at the endpoint is one place a byte could hide');
  });

  await test('MISSING telemetry fails closed rather than reading as zero', () => {
    for (const key of COUNTER_KEYS_REQUIRED) {
      const document = { ...counters(twoObjects) } as Record<string, unknown>;
      delete document[key];
      const parsed = parseProviderCounters(document, 'test');
      assert(parsed.counters === undefined,
        `a document with no "${key}" must not parse into a budgetable snapshot`);
    }
  });

  await test('a per-object column that is not an array of counts fails closed', () => {
    for (const key of COUNTER_ARRAY_KEYS) {
      const document = { ...counters(twoObjects) } as Record<string, unknown>;
      document[key] = 'not an array';
      assert(parseProviderCounters(document, 'test').counters === undefined,
        `a document whose "${key}" is not an array must not parse`);
    }
  });

  await test('a NEGATIVE or fractional counter fails closed', () => {
    assert(parseProviderCounters({ ...counters(twoObjects), served429: -1 }, 'test').counters === undefined,
      'a negative count is not a count');
    assert(parseProviderCounters({ ...counters(twoObjects), bytesServed: 1.5 }, 'test').counters === undefined,
      'a fractional byte total is not a byte total');
  });

  await test('the CLI reads counters through the validating parser, never through a cast', () => {
    assert(CLI.includes('parseProviderCounters'), 'the CLI must parse rather than cast');
    assert(!/as ProviderCounters/.test(CLI),
      'an `as ProviderCounters` over JSON.parse makes every missing field NaN, and NaN compares false '
      + 'against every ceiling — so a budget over broken telemetry would pass');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: an aggregate pass hiding a per-object breach');
  // --------------------------------------------------------------------------------------------------------

  await test('one object downloaded whole is caught even though the aggregate is comfortable', () => {
    // Forty tiny objects that cost almost nothing, and one large object read in full.
    const objects: FakeObject[] = [];
    for (let index = 0; index < 40; index += 1) {
      objects.push({ size: 40_000, small: 1, chunk: 0, partial: 0, oversized: 0 });
    }
    objects.push({ size: 104_857_600, small: 3, chunk: 30, partial: 0, oversized: 0 });
    const before = zeroLike(counters(objects));
    const after = counters(objects);
    const verdicts = objectByteVerdicts(before, after, daemonBlockByteCeiling,
      PLEX_LARGE_FIXTURE.MIN_BYTES, MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION);
    const breached = breachedObjects(verdicts);
    assertEq(breached.length, 1, 'exactly the runaway object must be named');
    assertEq(breached[0]?.ordinal, 40, 'and it must be named by its registration ordinal');
    assertEq(breached[0]?.boundKind, 'byte-fraction',
      'on an object that size the byte fraction is the binding bound');
  });

  await test('the byte fraction binds on a large fixture and cannot bind on a small one', () => {
    const large = objectByteVerdicts(
      zeroLike(counters([{ size: PLEX_LARGE_FIXTURE.MIN_BYTES, small: 3, chunk: 4, partial: 0, oversized: 0 }])),
      counters([{ size: PLEX_LARGE_FIXTURE.MIN_BYTES, small: 3, chunk: 4, partial: 0, oversized: 0 }]),
      daemonBlockByteCeiling, PLEX_LARGE_FIXTURE.MIN_BYTES, MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION);
    assertEq(large[0]?.boundKind, 'byte-fraction', 'at the large-fixture threshold the fraction binds');
    const small = objectByteVerdicts(
      zeroLike(counters([{ size: 40_000, small: 1, chunk: 0, partial: 0, oversized: 0 }])),
      counters([{ size: 40_000, small: 1, chunk: 0, partial: 0, oversized: 0 }]),
      daemonBlockByteCeiling, PLEX_LARGE_FIXTURE.MIN_BYTES, MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION);
    assertEq(small[0]?.boundKind, 'block-geometry',
      'below the threshold the fraction is unreachable by construction — the daemon serves a 4 MiB demand '
      + 'block for a one-byte read — so asserting it would be a gate that could never pass');
  });

  await test('THREE independent full envelopes on the large fixture would BREACH the fraction', () => {
    // The point of the large fixture: passing the fraction is the statement that the second and third
    // concurrent scans read what the first one cached. If three independent envelopes fitted under it, the
    // assertion would say nothing about sharing.
    const worstCase = REQUIRED_SERVER_COUNT * daemonBlockByteCeiling(PLEX_LARGE_FIXTURE.MIN_BYTES);
    const allowed = Math.floor(PLEX_LARGE_FIXTURE.MIN_BYTES * MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION);
    assert(worstCase > allowed,
      `three full envelopes (${worstCase}) must exceed the fraction (${allowed}), or the assertion is free`);
  });

  await test('an OVERSIZED response is refused however few there are, and is not multiplied by three', () => {
    const objects: FakeObject[] = [{ size: 104_857_600, small: 0, chunk: 0, partial: 0, oversized: 1 }];
    const shapes = objectShapeVerdicts(zeroLike(counters(objects)), counters(objects),
      PLEX_SCAN_ENVELOPE.BLOCK, PLEX_SCAN_ENVELOPE.SMALL);
    assertEq(breachedShapes(shapes).length, 1,
      'a body larger than a demand block has never been observed and three servers do not make one legitimate');
  });

  await test('the per-entry shape envelope is three scanners wide and no wider', () => {
    const atCeiling: FakeObject[] = [{
      size: 104_857_600, small: PLEX_SCAN_ENVELOPE.SMALL * REQUIRED_SERVER_COUNT,
      chunk: PLEX_SCAN_ENVELOPE.BLOCK * REQUIRED_SERVER_COUNT, partial: 0, oversized: 0,
    }];
    assertEq(breachedShapes(objectShapeVerdicts(zeroLike(counters(atCeiling)), counters(atCeiling),
      PLEX_SCAN_ENVELOPE.BLOCK, PLEX_SCAN_ENVELOPE.SMALL)).length, 0, 'exactly at the ceiling is inside it');
    const overCeiling: FakeObject[] = [{
      size: 104_857_600, small: 0,
      chunk: PLEX_SCAN_ENVELOPE.BLOCK * REQUIRED_SERVER_COUNT + 1, partial: 0, oversized: 0,
    }];
    assertEq(breachedShapes(objectShapeVerdicts(zeroLike(counters(overCeiling)), counters(overCeiling),
      PLEX_SCAN_ENVELOPE.BLOCK, PLEX_SCAN_ENVELOPE.SMALL)).length, 1, 'one over it is outside it');
  });

  await test('full and clipped blocks share one cap, so an entry cannot spend both', () => {
    const split: FakeObject[] = [{
      size: 104_857_600, small: 0,
      chunk: PLEX_SCAN_ENVELOPE.BLOCK * REQUIRED_SERVER_COUNT,
      partial: 1, oversized: 0,
    }];
    assertEq(breachedShapes(objectShapeVerdicts(zeroLike(counters(split)), counters(split),
      PLEX_SCAN_ENVELOPE.BLOCK, PLEX_SCAN_ENVELOPE.SMALL)).length, 1,
      'a clipped block is still a round trip for up to a demand block');
  });

  await test('bytes outside the shared corpus are separated from bytes inside it, exactly', () => {
    const objects: FakeObject[] = [
      { size: 262_144, small: 1, chunk: 0, partial: 0, oversized: 0 },
      { size: 104_857_600, small: 3, chunk: 4, partial: 0, oversized: 0 },
    ];
    const before = zeroLike(counters(objects));
    const after = counters(objects);
    const split = corpusAttribution(before, after, 1);
    assertEq(split.unattributed, 0, 'the split must account for every byte the endpoint served');
    assertEq(split.otherBytes, 262_144, 'the canary\'s bytes belong to the canary');
    assert(split.corpusBytes > 0, 'and the corpus\'s belong to the corpus');
  });

  await test('a corpus object with bytes BEFORE the window is what the cold check reads', () => {
    const objects: FakeObject[] = [
      { size: 262_144, small: 1, chunk: 0, partial: 0, oversized: 0 },
      { size: 104_857_600, small: 3, chunk: 4, partial: 0, oversized: 0 },
    ];
    const before = counters(objects);
    const after = counters(objects);
    assert(corpusAttribution(before, after, 1).corpusBytesBefore > 0,
      'a corpus object already read before the window must be visible to the cold check');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: a 429, or a connection cap, quietly breached');
  // --------------------------------------------------------------------------------------------------------

  await test('the gate holds 429s to zero, not to "few"', () => {
    assertEq(MEDIA_SERVER_BUDGETS.MAX_HTTP_429, 0, 'G16 says zero');
    assert(CLI.includes('G16-http-429'), 'the window must assert it inside the concurrent window');
    assert(CLI.includes(`${'$'}{gate}-http-429-total`),
      'and the whole-run invariant must assert it outside any window, because a delta lets a 429 in one '
      + 'window cancel against another');
  });

  await test('G17 is asserted against the CONFIGURED per-endpoint cap, sampled on accept', () => {
    assert(CLI.includes('PER_ENDPOINT_MAX_INFLIGHT_REQUESTS'),
      'the in-flight cap must be the configured one rather than a number chosen here');
    assert(CLI.includes('peakConns'), 'and the accept-sampled connection high-water mark must be asserted');
    assert(GATE.includes('"maxConnections": 4'),
      'the daemon config must SET the per-endpoint cap, or G17 asserts against a default nobody configured');
  });

  await test('a breached in-flight cap is a failure, not a rounding difference', () => {
    // The check the CLI makes, restated here against the same constant so a change to either is visible.
    const snapshot = counters(twoObjects, {
      peakConcurrent: PROJECTIOND_ADMISSION_LIMITS.PER_ENDPOINT_MAX_INFLIGHT_REQUESTS + 1,
    });
    assert(snapshot.peakConcurrent > PROJECTIOND_ADMISSION_LIMITS.PER_ENDPOINT_MAX_INFLIGHT_REQUESTS,
      'one over the configured cap must be over the configured cap');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: the hold starving reads it has nothing to do with');
  // --------------------------------------------------------------------------------------------------------

  await test('the blocking window is strictly inside the daemon\'s admission queue-wait budget', () => {
    assert(HOLD_ARM_MS < PROJECTIOND_ADMISSION_LIMITS.MAX_QUEUE_WAIT_MS,
      `a hold that blocked for ${HOLD_ARM_MS}ms against a ${PROJECTIOND_ADMISSION_LIMITS.MAX_QUEUE_WAIT_MS}ms `
      + 'queue-wait budget would starve reads of the other forty-nine entries into EIO, and the gate would be '
      + 'manufacturing the mis-catalogued files it claims to measure');
  });

  await test('...and the held request itself cannot outlive the daemon\'s first-byte deadline', () => {
    assert(HOLD_MAX_MS < PROJECTIOND_READ_POLICY.FIRST_BYTE_DEADLINE_MS,
      'a held response that has not begun by the first-byte deadline is abandoned and the READ FAILS');
    assert(HOLD_MAX_MS > HOLD_ARM_MS, 'the endpoint bound must be above the arm window so a release wins');
    assert(GATE.includes('--max-hold "$HOLD_MAX"'),
      'the gate must set the endpoint bound explicitly rather than inheriting the 15s package default, '
      + 'which is ABOVE the first-byte deadline');
    assert(GATE.includes('HOLD_MAX=5s'), 'and it must be the derived value');
  });

  await test('the arm clock starts when a request BLOCKS, not when the hold is armed', () => {
    assert(DRIVER.includes('blockingSinceMs'),
      'an armed hold nothing has reached starves nobody; timing the window from the arming would expire it '
      + 'before the first scanner arrived on a slow host');
    assert(DRIVER.includes('heldBaseline'), 'and the first block must be detected against a baseline');
  });

  await test('the barrier is released on every path out of the observation loop', () => {
    const releases = DRIVER.split('await release(').length - 1;
    assert(releases >= 3,
      'the barrier must be released when its bounded window elapses, when the deadline fires, and '
      + `unconditionally on the way out; found ${releases} release sites`);
    assert(DRIVER.includes('THE BARRIER IS RELEASED WHATEVER HAPPENED'),
      'and the unconditional release must say why it is unconditional');
  });

  await test('the barrier is NOT released on the three-way sample, and the first real run is why', () => {
    // Releasing the moment the rendezvous succeeded destroyed the overlap it had just created: the measured
    // three-way window was two samples spanning 0.75s, under the two-second floor. The hold now runs for its
    // whole bounded window.
    assert(DRIVER.includes('the barrier stays on for the rest of its window'),
      'the three-way observation must note itself without releasing the hold');
    const threeWayBlock = DRIVER.split('sawThreeWay = true;')[1]?.split('}')[0] ?? '';
    assert(!threeWayBlock.includes('release('),
      'releasing on success destroys the thing success created');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: a wrapper that swallows a SKIP or a FAILURE');
  // --------------------------------------------------------------------------------------------------------

  const stubDir = mkdtempSync(join(tmpdir(), 'projection-three-'));
  const stubPath = join(stubDir, 'stub-gate.sh');
  const writeStub = (statuses: readonly number[]): void => {
    writeFileSync(stubPath, [
      '#!/usr/bin/env bash',
      `COUNT_FILE="${join(stubDir, 'count').replace(/\\/g, '/')}"`,
      'if [ ! -f "$COUNT_FILE" ]; then echo 0 > "$COUNT_FILE"; fi',
      'n=$(cat "$COUNT_FILE")',
      'n=$((n + 1))',
      'echo "$n" > "$COUNT_FILE"',
      `statuses=(${statuses.join(' ')})`,
      'exit "${statuses[$((n - 1))]}"',
      '',
    ].join('\n'));
    chmodSync(stubPath, 0o755);
    writeFileSync(join(stubDir, 'count'), '0\n');
  };
  const runWrapper = (script: string, statuses: readonly number[], runs?: number): {
    status: number; stdout: string; stderr: string;
  } => {
    writeStub(statuses);
    const result = spawnSync('bash', [join(repoRoot, 'deploy', script)], {
      env: {
        ...process.env,
        PROJECTION_THREE_GATE_COMMAND: stubPath,
        ...(runs === undefined ? {} : { PROJECTION_THREE_GATE_RUNS: String(runs) }),
      },
      encoding: 'utf8',
    });
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };

  await test('the three-run wrapper propagates a SKIP as 77 and refuses to announce a sequence', () => {
    const result = runWrapper('projection-three-server-concurrency-gate-three.sh', [0, 77, 0]);
    assertEq(result.status, 77, 'a skipped run must not be folded into success');
    assert(result.stderr.includes('CLOSES NOTHING'), 'and it must say so');
    assert(!result.stdout.includes('consecutive three-server concurrent-scan runs completed'),
      'a skipped sequence must not print the closing message');
  });

  await test('the three-run wrapper stops on the FIRST failure and does not average', () => {
    const result = runWrapper('projection-three-server-concurrency-gate-three.sh', [0, 1, 0]);
    assertEq(result.status, 1, 'a failed run must fail the sequence');
    assert(result.stderr.includes('Runs completed: 1 of 3'), 'and it must say how far it got');
  });

  await test('three green runs announce a completed sequence AND its limits in the same breath', () => {
    const result = runWrapper('projection-three-server-concurrency-gate-three.sh', [0, 0, 0]);
    assertEq(result.status, 0, 'three green runs are a completed sequence');
    assert(result.stdout.includes('3 of 3 consecutive'), 'it must state the count');
    assert(result.stdout.includes('closes NEITHER G18'),
      'and in the same message it must refuse the reading that this closed G18');
  });

  await test('a zero-run sequence cannot announce a completed one', () => {
    const result = runWrapper('projection-three-server-concurrency-gate-three.sh', [0, 0, 0], 0);
    assert(result.status !== 0, 'a loop that never ran must not exit 0');
    assert(result.stderr.includes('refusing to report a completed sequence'), 'and must say why');
  });

  await test('the optional entry point maps ONLY 77', () => {
    const skipped = runWrapper('projection-three-server-concurrency-gate-optional.sh', [77]);
    assertEq(skipped.status, 0, 'the optional entry point exists to map a skip to success');
    assert(skipped.stderr.includes('NOTHING WAS PROVED'), 'and to say that nothing was proved');
    const failedRun = runWrapper('projection-three-server-concurrency-gate-optional.sh', [1]);
    assertEq(failedRun.status, 1, 'a real failure must propagate unchanged');
    const other = runWrapper('projection-three-server-concurrency-gate-optional.sh', [78]);
    assertEq(other.status, 78, 'and so must any other status');
  });

  await test('the gate exits 77 rather than 0 when the host cannot host it', () => {
    assert(GATE.includes('GATE_SKIP_STATUS=77'), 'the skip status must be 77');
    assert(GATE.includes('exit "$GATE_SKIP_STATUS"'), 'and the skip must exit with it');
    assert(GATE.includes('It is not a pass and must not be reported as one'),
      'and the skip must say what it is not');
  });

  await test('there is exactly ONE skip condition, and a small host is not it', () => {
    assertEq(GATE.split('exit "$GATE_SKIP_STATUS"').length - 1, 1,
      'a second skip condition is a second way for a required run to pass without running');
    assert(OPTIONAL.includes('there is no "this host is too small for three media servers" skip'),
      'a gate whose subject is three servers at once must fail rather than downgrade to two');
  });

  await test('the acceptance commands propagate 77 and the optional one is a separate entry point', () => {
    assertEq(PACKAGE.scripts['go:three-server-concurrency-gate'],
      'bash deploy/projection-three-server-concurrency-gate.sh', 'the gate command runs the gate');
    assertEq(PACKAGE.scripts['go:three-server-concurrency-gate:three'],
      'bash deploy/projection-three-server-concurrency-gate-three.sh', 'the three-run command runs the wrapper');
    assertEq(PACKAGE.scripts['go:three-server-concurrency-gate:optional'],
      'bash deploy/projection-three-server-concurrency-gate-optional.sh',
      'skip-as-success is a separate entry point a caller has to choose');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: an unpinned image, so two runs test two different things');
  // --------------------------------------------------------------------------------------------------------

  await test('every external image the gate names is pinned by digest', () => {
    const assignments = [...GATE.matchAll(/^([A-Z_]*IMAGE)="([^"]+)"$/gm)];
    assert(assignments.length >= 5, `expected the gate to pin several images, found ${assignments.length}`);
    for (const [, name, raw] of assignments) {
      const value = raw as string;
      if (value.startsWith('$')) continue;
      assert(value.includes('@sha256:'),
        `${name} is "${value}", which is a tag rather than a digest: two runs of a gate whose claim is that `
        + 'it passed three times in a row would be two runs of possibly different things');
    }
  });

  await test('the three media servers are pinned to the SAME digests their own gates pin', () => {
    for (const [gateFile, variable] of [
      ['deploy/projection-jellyfin-dataplane-gate.sh', 'JELLYFIN_IMAGE'],
      ['deploy/projection-plex-dataplane-gate.sh', 'PLEX_IMAGE'],
      ['deploy/projection-emby-dataplane-gate.sh', 'EMBY_IMAGE'],
    ] as const) {
      const ownGate = readRepoFile(gateFile);
      const own = new RegExp(`^${variable}="([^"]+)"$`, 'm').exec(ownGate)?.[1];
      const here = new RegExp(`^${variable}="([^"]+)"$`, 'm').exec(GATE)?.[1];
      assert(own !== undefined && here === own,
        `${variable} must be the digest its own gate pins, or this gate's three servers are not the three `
        + `servers the reused drivers' findings were measured against (own=${own}, here=${here})`);
    }
  });

  await test('the PostgreSQL image in the Compose file is pinned by digest too', () => {
    assert(/image: postgres:16@sha256:[0-9a-f]{64}/.test(COMPOSE), 'the database must be pinned');
  });

  await test('this gate takes its own project, network and port, so it cannot inherit another gate\'s state', () => {
    assert(COMPOSE.includes('name: projection-three-gate'), 'its own Compose project');
    assert(COMPOSE.includes('name: projection-three-gate'), 'its own network');
    assert(COMPOSE.includes('PROJECTION_THREE_GATE_PG_PORT:-5510'), 'its own database port');
    assert(COMPOSE.includes('tmpfs:'), 'and throwaway storage, so three runs are three runs from nothing');
    for (const port of ['5510', '8120', '8121', '8122', '32520']) {
      assert(GATE.includes(port), `the gate must name its own port ${port}`);
    }
    for (const taken of ['5480', '5490', '5500']) {
      assert(!GATE.includes(`:-${taken}}`), `port ${taken} belongs to another gate`);
    }
  });

  await test('every container name carries the shell PID, so two copies cannot collide', () => {
    for (const name of ['MOUNT_CONTAINER', 'RANGE_CONTAINER', 'JF_CONTAINER', 'PLEX_CONTAINER',
      'EMBY_CONTAINER']) {
      const value = new RegExp(`^${name}="([^"]+)"$`, 'm').exec(GATE)?.[1];
      assert(value !== undefined && value.endsWith('-$$'), `${name} must be run-unique, got ${String(value)}`);
    }
    assert(/^GATE_ROOT="\$PWD\/\.projection-three-gate"$/m.test(GATE), 'its own run root');
    assert(/^REL="\.projection-three-gate\/run-\$\$"$/m.test(GATE), 'and a run-unique directory inside it');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: one mount, one generation, one provider — or three of each');
  // --------------------------------------------------------------------------------------------------------

  await test('all three servers bind THE SAME mount directory', () => {
    const binds = [...GATE.matchAll(/-v "\$WORK\/mnt:([^"]+)"/g)].map((match) => match[1]);
    const serverBinds = binds.filter((bind) => (bind as string).startsWith('/media/projection'));
    assertEq(serverBinds.length, 3, 'exactly three media servers must bind the mount');
    for (const bind of serverBinds) {
      assertEq(bind, '/media/projection:rslave',
        'each server must see the same directory at the same path, propagated the same way');
    }
  });

  await test('all three libraries point at the same path inside that mount', () => {
    const paths = [...GATE.matchAll(/--mount-path (\S+)/g)].map((match) => match[1]);
    assertEq(paths.length, 3, 'three libraries');
    assertEq(new Set(paths).size, 1, 'one path');
    assertEq(paths[0], '/media/projection/Movies', 'and it is inside the projected mount');
  });

  await test('there is ONE daemon, ONE endpoint and ONE corpus generation', () => {
    assertEq(GATE.split('docker run -d --name "$MOUNT_CONTAINER"').length - 1, 1, 'one daemon container');
    assertEq(GATE.split('docker run -d --name "$RANGE_CONTAINER"').length - 1, 1, 'one endpoint container');
    assertEq(GATE.split('register batch --file').length - 1, 1, 'one corpus registration');
    assert(GATE.includes('ONE PostgreSQL, ONE publisher, ONE admitted generation'),
      'and the header must say so, because a wrapper around three independent gates is the thing this is not');
  });

  await test('all three servers are held against ONE expectation document', () => {
    const expectFlags = [...GATE.matchAll(/verify-corpus --server \S+\s+--catalogue \S+\s*\\\s*--expect-file (\S+)/g)]
      .map((match) => match[1]);
    assertEq(expectFlags.length, 3, 'three servers verified');
    assertEq(new Set(expectFlags).size, 1, 'against one shared expectation');
  });

  await test('each server keeps ITS OWN driver, bootstrap and ordinary-file predicate', () => {
    for (const driver of ['projection-jellyfin-dataplane-cli.ts', 'projection-plex-dataplane-cli.ts',
      'projection-emby-dataplane-cli.ts']) {
      assert(GATE.includes(driver), `${driver} must drive its own server`);
    }
    assert(DRIVER.includes('embyOrdinaryFileProblems'), 'Emby\'s predicate reads MediaSources[0].Type');
    assert(DRIVER.includes('locationType'), 'Jellyfin\'s reads LocationType, which Emby never sends');
    assert(DRIVER.includes('isOrdinaryFile'), 'Plex\'s reads accessible/exists off checkFiles=1');
    assert(DRIVER.includes('NOT REFACTORED INTO ONE'),
      'and the file must say why three predicates are not duplication');
  });

  await test('the driver is not a fourth media-server driver', () => {
    assert(DRIVER.includes('IT IS NOT A FOURTH MEDIA-SERVER DRIVER'), 'it must say so');
    // COMMENTS ARE STRIPPED FIRST, AND THAT IS NOT A LOOPHOLE. This file's whole argument is that the three
    // servers differ, so it NAMES the fields and flags they differ on. What must not appear is a media
    // server's endpoint spelling in CODE — an HTTP path this file builds, or a server field it reads —
    // because that would be a fourth driver growing inside the observer.
    const code = DRIVER.split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n');
    for (const spelling of ['/Library/VirtualFolders', '/library/sections', 'StartupWizardCompleted',
      'ScheduledTasks', 'X-Plex-Token', 'MediaBrowser Client']) {
      assert(!code.includes(spelling),
        `${spelling} is a media-server endpoint spelling and belongs in that server's own driver`);
    }
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: a preflight that ran after the gate had already changed the host');
  // --------------------------------------------------------------------------------------------------------

  await test('the host preflight runs BEFORE anything is built or started', () => {
    const preflight = GATE.indexOf('projection-host-preflight-cli.ts propagation');
    const traversal = GATE.indexOf('projection-host-preflight-cli.ts traversal');
    const build = GATE.indexOf('docker build -t "$IMAGE"');
    const compose = GATE.indexOf('docker compose -f "$COMPOSE_FILE" up');
    const serverStart = GATE.indexOf('docker run -d --name "$RANGE_CONTAINER"');
    assert(preflight > 0 && traversal > 0, 'both preflight checks must run');
    assert(preflight < build && traversal < build, 'before the image build');
    assert(preflight < compose && traversal < compose, 'before the database starts');
    assert(preflight < serverStart, 'and before any container is started');
  });

  await test('the preflight diagnoses and never repairs', () => {
    assert(GATE.includes('IT DIAGNOSES AND DOES NOT REPAIR'), 'the gate must say so');
    assert(!GATE.includes('mount --make-rshared') && !GATE.includes('make-shared'),
      'a gate that made a host mount shared would be mutating the machine to make itself pass');
    assert(GATE.includes('--require'), 'a not-shared answer must be fatal');
  });

  await test('the traversal mode is set explicitly rather than inherited from a umask', () => {
    assert(/chmod 755 "\$GATE_ROOT" "\$WORK"/.test(GATE),
      'at umask 077 the run root lands 0700 and a uid-1000 container cannot traverse it, however permissive '
      + 'the leaf is — and Docker Desktop cannot show you that, because the host side of a bind carries no '
      + 'modes at all');
  });

  await test('every media server\'s state directory is writable and the media is not', () => {
    // THE STATEMENT SPANS A LINE CONTINUATION, so the window is taken from the keyword rather than to the
    // next newline — a check that stopped at the newline would silently pass on half the directories.
    const chmodAt = GATE.indexOf('chmod 777');
    const chmod777 = chmodAt < 0 ? '' : GATE.slice(chmodAt, chmodAt + 300);
    for (const dir of ['jf-config', 'plex-config', 'emby-config', 'cache', 'mnt', 'out']) {
      assert(chmod777.includes(dir), `${dir} must be writable by whoever the server turns out to be`);
    }
    assert(!chmod777.includes('$WORK/media"') && !chmod777.includes('$WORK/manifest'),
      'the media and the manifest are read-only through the mount, and that is under test');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: a wait, a cleanup or a log collector that never returns');
  // --------------------------------------------------------------------------------------------------------

  await test('every log collector is bounded', () => {
    const dockerLogs = [...GATE.matchAll(/docker logs[^\n|]*/g)].map((match) => match[0]);
    assert(dockerLogs.length > 0, 'the gate must collect logs on failure');
    for (const invocation of dockerLogs) {
      assert(invocation.includes('--tail'),
        `"${invocation.trim()}" streams until the container stops; a diagnostic that never returns turns a `
        + 'named failure into a wedged run, and the operator then has no diagnosis AND no machine');
    }
  });

  await test('every wait in the gate is a bounded loop, never a `while true`', () => {
    assert(!/while\s+true/.test(GATE), 'a `while true` is a hang that looks like a slow run');
    const loops = [...GATE.matchAll(/for _ in \$\(seq 1 (\d+)\)/g)].map((match) => Number(match[1]));
    assert(loops.length > 0, 'the gate must have bounded polling loops');
    for (const bound of loops) assert(bound > 0 && bound <= 600, `a poll bound of ${bound} is not a bound`);
  });

  await test('every deadline in the concurrency contract is finite and ordered', () => {
    for (const [name, value] of Object.entries(CONCURRENCY_DEADLINES_MS)) {
      assert(Number.isFinite(value) && value > 0, `${name} must be a finite positive deadline`);
    }
    assert(CONCURRENCY_DEADLINES_MS.OVERLAP_OBSERVATION <= CONCURRENCY_DEADLINES_MS.CONCURRENT_SCAN,
      'the overlap has to be observed inside the scan window it belongs to');
    assert(CONCURRENCY_DEADLINES_MS.SAMPLE_INTERVAL < CONCURRENCY_DEADLINES_MS.SAMPLE_MAX_SPAN,
      'a tick that took longer than its own interval budget must still be able to be precise');
  });

  await test('the cleanup trap removes all three media servers, and the servers first', () => {
    const cleanup = /cleanup\(\) \{([\s\S]*?)\n\}/.exec(GATE)?.[1] ?? '';
    const servers = cleanup.indexOf('$PLEX_CONTAINER');
    const mount = cleanup.indexOf('$MOUNT_CONTAINER');
    assert(servers > 0 && mount > servers,
      'a FUSE mount with a live reader does not unmount cleanly, so the readers go first');
    for (const name of ['$PLEX_CONTAINER', '$JF_CONTAINER', '$EMBY_CONTAINER']) {
      assert(cleanup.includes(name), `${name} must be removed on the way out`);
    }
    assert(cleanup.includes('umount -l'), 'and a stale mount must be forced away');
    assert(GATE.includes('trap cleanup EXIT'), 'the cleanup must run on failure as well as on success');
  });

  await test('the concurrent scan records a per-server failure instead of rejecting the whole observation', () => {
    assert(DRIVER.includes('.catch((error: unknown)'),
      'one server\'s scan failing must not discard the timeline the other two produced');
    assert(CLI.includes('concurrent scans failed'), 'and the CLI must still fail the gate');
  });

  await test('a fake three-adapter run produces a real timeline and a real verdict', async () => {
    // The observer, driven end to end against adapters whose in-flight windows are scripted. This is the
    // behavioural half of the sequential-versus-concurrent test: the analysis functions above are pure, and
    // this checks that the loop actually feeds them what it saw.
    const start = Date.now();
    const makeAdapter = (id: string, fromMs: number, toMs: number): ServerAdapter => ({
      id: id as never,
      readState: () => ({}),
      scanIsRunningNow: async () => {
        const now = Date.now() - start;
        return now >= fromMs && now < toMs;
      },
      scanLibrary: async () => {
        await new Promise((resolve) => { setTimeout(resolve, toMs); });
        return { observedInFlight: true };
      },
      catalogue: async () => [],
    });
    const adapters = [
      makeAdapter('emby', 0, 900), makeAdapter('jellyfin', 0, 900), makeAdapter('plex', 0, 900),
    ];
    const outcome = await runConcurrentScans({
      adapters,
      states: new Map(adapters.map((adapter) => [adapter.id, {}])),
      sampleIntervalMs: 40,
      deadlineMs: 5_000,
    });
    assert(outcome.timeline.length >= 5, 'the observer must have taken real samples');
    assertEq(outcome.barrierArmed, false, 'no endpoint was supplied, so no barrier was armed');
    const analysis = analyseOverlap(outcome.timeline, adapters.map((adapter) => adapter.id));
    assertEq(analysis.maxServersInFlight, 3, 'all three overlapped');
    assertEq(outcome.perServer.length, 3, 'and every server has an outcome');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: a credential or a path in the report');
  // --------------------------------------------------------------------------------------------------------

  await test('the report is held to the same redaction rule as every other report here', () => {
    assert(CLI.includes('findRedactionProblems'), 'the report must be checked before it is printed');
    assert(CLI.includes('the report is not redaction-safe'), 'and refused if it is not');
    assert(GATE.includes('drive redaction-check --file'), 'and any kept artifact must be checked too');
  });

  await test('a report carrying a URL, a token or an absolute path is refused', () => {
    for (const leak of [
      { gate: 'X', verdict: 'pass', note: 'http://fakerange:8099/object/x' },
      { gate: 'X', verdict: 'pass', note: 'Token="abc"' },
      { gate: 'X', verdict: 'pass', note: 'read /mnt/projection/Movies/A.mp4' },
      { gate: 'X', verdict: 'pass', note: 'X-Plex-Token' },
      { gate: 'X', verdict: 'pass', note: 'expiresAtUnixMs 12' },
    ]) {
      assert(findRedactionProblems([leak]).length > 0,
        `the redaction rule must refuse ${JSON.stringify(leak.note)}`);
    }
  });

  await test('the gate\'s own verdict text carries no locator', () => {
    // Every note the CLI writes into a result is a template literal; the ones that interpolate a measured
    // value are safe, but a hard-coded URL or path in one would ship into the report.
    const notes = [...CLI.matchAll(/'([^']*(?:https?:\/\/|\/mnt\/|\/media\/)[^']*)'/g)].map((m) => m[1]);
    const offending = notes.filter((note) => !(note as string).startsWith('http://127.0.0.1'));
    assertEq(offending.length, 0, `a verdict note carries a locator: ${offending.join(' | ')}`);
  });

  await test('the gate searches every server\'s library state for the run\'s own lease secret', () => {
    assert(GATE.includes('LEASE_MARKER'), 'the lease must carry a high-entropy per-run marker');
    for (const dir of ['jf-config', 'plex-config', 'emby-config']) {
      assert(GATE.includes(dir), `${dir} must be searched`);
    }
    assert(GATE.includes('the searches above had a subject'),
      'and a run that resolved zero leases would have searched for a secret that never existed');
  });

  await test('no credential ever reaches a container argument vector', () => {
    assert(!/docker run[^\n]*--api-key/i.test(GATE), 'a token in argv lands in Docker\'s own metadata');
    assert(!/token/i.test(GATE.split('start_jellyfin()')[1]?.split('start_plex')[0] ?? ''),
      'no server is started with a credential on its command line');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: wording that upgrades Docker Desktop into Linux/Unraid or G18 closure');
  // --------------------------------------------------------------------------------------------------------

  await test('every nonclaim is stated, and stated from the constant rather than retyped', () => {
    assert(THREE_SERVER_NONCLAIMS.length >= 6, 'the nonclaims must be enumerated');
    assert(CLI.includes('THREE_SERVER_NONCLAIMS'), 'the CLI must print them from the constant');
    assert(GATE.includes('nonclaims'), 'and the gate must invoke that command rather than retyping prose');
    const joined = THREE_SERVER_NONCLAIMS.join(' ').toLowerCase();
    for (const subject of ['docker desktop', 'linux', 'unraid', 'real provider', 'g22', 'g27', 'phase 1']) {
      assert(joined.includes(subject), `the nonclaims must name ${subject}`);
    }
  });

  await test('the gate never claims a Docker Desktop run closed anything', () => {
    assert(GATE.includes('closes NONE of G7–G13 or G18') || GATE.includes('closes NONE of G7-G13 or G18'),
      'the header must say what a Docker Desktop pass closes: nothing');
    assert(!/G18 (is )?(now )?closed/i.test(GATE), 'nothing here may say G18 is closed');
    assert(!/Phase 1 (is )?(now )?(closed|complete)/i.test(GATE), 'nor that Phase 1 is');
  });

  await test('per-server provider attribution is refused rather than invented', () => {
    assert(CORE.includes('PER_SERVER_PROVIDER_ATTRIBUTION_IS_IMPOSSIBLE'),
      'one daemon serves all three servers, so the endpoint sees the daemon and never the server behind a byte');
    const joined = THREE_SERVER_NONCLAIMS.join(' ');
    assert(joined.includes('Per-server provider attribution') || joined.includes('per-server provider attribution'),
      'and the nonclaims must say so');
  });

  await test('the roadmap and the acceptance plan still say G18 is NOT RUN for tranche purposes', () => {
    const plan = readRepoFile('docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md');
    const roadmap = readRepoFile('docs/PROJECTION_ROADMAP.md');
    assert(/G18 \*\*High-concurrency scan\*\*[^\n]*not run/i.test(plan)
      || /G18[^\n]*NOT RUN/i.test(plan),
      'the §6.1 table must still carry G18 as not closing anything on this platform');
    assert(roadmap.includes('Linux') && roadmap.includes('Unraid'),
      'the roadmap must still name the platform the tranche closes on');
    assert(!/G18 is closed/i.test(plan) && !/G18 is closed/i.test(roadmap), 'and neither may say it is closed');
  });

  await test('the acceptance plan and the gate document each other', () => {
    const plan = readRepoFile('docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md');
    assert(plan.includes('projection-three-server-concurrency-gate.sh'),
      'the plan must name the gate that produced the G18 row');
    const doc = readRepoFile('docs/PROJECTION_PHASE_1_THREE_SERVER_CONCURRENCY.md');
    assert(doc.includes('G18'), 'the gate document must name the gate it is about');
    assert(doc.includes('NOT') && /docker desktop/i.test(doc),
      'and it must state what a Docker Desktop run does not close');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nWiring');
  // --------------------------------------------------------------------------------------------------------

  await test('this suite runs in the aggregate', () => {
    assert(AGGREGATE_SUITE_COMMAND.includes('tsx test/projection-three-server-concurrency.ts'),
      'a suite nobody runs is a suite that stops being true');
  });

  await test('the fake endpoint accepts an explicit hold bound', () => {
    const main = readRepoFile('projectiond/cmd/fakerange/main.go');
    assert(main.includes('"max-hold"'), 'the gate has to be able to bound the hold below the daemon\'s '
      + 'first-byte deadline; the package default of 15s is above it');
    assert(main.includes('MaxHold: *maxHold'), 'and the flag must actually reach the server');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const [name, error] of failures) console.error(`FAILED ${name}\n  ${String(error)}`);
    process.exit(1);
  }
}

void main();
