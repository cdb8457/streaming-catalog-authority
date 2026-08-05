import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  G18_WORDING_FILES, deliveryOverstatements, readForWordingScan,
} from './projection-delivery-wording.js';
import {
  MEDIA_SERVER_BUDGETS, findRedactionProblems,
} from '../src/core/projection/media-server-dataplane.js';
import {
  PROJECTIOND_ADMISSION_LIMITS, PROJECTIOND_READ_POLICY,
} from '../src/core/projection/runtime-contract.js';
import { PLEX_LARGE_FIXTURE, PLEX_SCAN_ENVELOPE } from '../src/core/projection/plex-dataplane.js';
import {
  CONCURRENCY_DEADLINES_MS, CONCURRENCY_RULES, COUNTER_ARRAY_KEYS, COUNTER_KEYS_REQUIRED, HOLD_ARM_MS,
  HOLD_MAX_MS, BARRIER_RELEASE_OVERSHOOT_MS, REQUIRED_SERVER_COUNT, THREE_SERVER_IDS,
  GAUGE_COUNTER_KEYS, MONOTONIC_COUNTER_KEYS, OBSERVED_BYTES_ARE_APPLICATION_WRITES,
  THREE_SERVER_NONCLAIMS, analyseOverlap,
  attributionProblems, breachedObjects, breachedShapes, coldStateProblems, corpusAttribution,
  daemonBlockByteCeiling, objectByteVerdicts, objectShapeVerdicts, overlapProblems, parseProviderCounters,
  triggerSpreadSeconds, CANONICAL_SCAN_WINDOWS_PER_ENTRY, canonicalRangeRequestCeiling,
  canonicalResolutionCeiling, canonicalScanByteCeiling,
  type OverlapSample, type ProviderCounters,
} from '../src/core/projection/three-server-concurrency.js';
import { PROJECTION_PHASE_1_BUDGETS } from '../src/core/projection/runtime-contract.js';
import { PROJECTION_PROBE_PLAN } from '../src/core/projection/manifest-v1.js';
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

/**
 * WHAT COUNTS AS A LINE THAT DECLARES ITSELF HISTORICAL.
 *
 * THE PROSE CHECKS BELOW ARE ABOUT CURRENT-TENSE CLAIMS ONLY, and an earlier version of them SAID so while
 * testing the whole file. It passed, but only because no historical line happened to spell the retired
 * number — accidental scoping, not scoping, and exactly the comment-contradicts-code defect those very
 * checks exist to catch.
 *
 * So the rule is made explicit and checkable: a retired number or a retracted formula may appear ONLY on a
 * line that marks itself as looking backwards. That permits — and protects — §3.4, the run records and every
 * "an earlier version…" note this repository keeps on purpose, while still refusing a stale claim written in
 * the present tense. It also makes history SELF-DECLARING: prose that describes what used to be true and
 * forgets to say so fails, and the fix is to say so rather than to delete it.
 */
const RETROSPECTIVE_MARKERS: readonly RegExp[] = Object.freeze([
  /\bused to\b/i, /\ban earlier\b/i, /\bearlier version\b/i, /\bretired\b/i, /\bpre-remediation\b/i,
  /\bbefore the watchdog\b/i, /\bpreviously\b/i, /\bno longer\b/i, /\bFAILED\b/, /\bfailed on\b/i,
  /\bit was\b/i, /\bwhich was\b/i, /\bwould contradict\b/i, /\bsaying it the second way\b/i,
]);

/** Lines matching `pattern` that do NOT declare themselves historical. The only lines the checks judge. */
function currentTenseLines(text: string, pattern: RegExp): string[] {
  return text.split('\n')
    .filter((line) => pattern.test(line))
    .filter((line) => !RETROSPECTIVE_MARKERS.some((marker) => marker.test(line)));
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

interface FakeObject {
  size: number; small: number; chunk: number; partial: number; oversized: number;
  /** Bytes the writes for this object actually RETURNED. Defaults to the committed length: a drained body. */
  observed?: number;
}

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
    // THE APPLICATION-WRITE COLUMN. It defaults to the committed length — a body the client drained — so an
    // existing test that says nothing about it keeps describing the case it always described. A test that
    // wants divergence sets `observed` on an object and gets a coherent truncated-body document.
    observedBytes: sum(objects.map((o, i) => o.observed ?? (objectBytes[i] as number))),
    completedBodies: sum(objects.map((o, i) => ((o.observed ?? (objectBytes[i] as number))
      === (objectBytes[i] as number) ? o.small + o.chunk + o.partial + o.oversized : 0))),
    truncatedBodies: sum(objects.map((o, i) => ((o.observed ?? (objectBytes[i] as number))
      === (objectBytes[i] as number) ? 0 : o.small + o.chunk + o.partial + o.oversized))),
    bodiesInFlight: 0,
    objectBytes,
    objectObserved: objects.map((o, i) => o.observed ?? (objectBytes[i] as number)),
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
    observedBytes: 0, completedBodies: 0, truncatedBodies: 0, bodiesInFlight: 0,
    chunkResponses: 0, chunkBytes: 0, smallResponses: 0, smallBytes: 0,
    partialResponses: 0, partialBytes: 0, oversizedResponses: 0, oversizedBytes: 0,
    bodylessResponses: 0, heldRequests: 0, holdTimeouts: 0,
    objectBytes: empty, objectObserved: empty, objectChunk: empty, objectSmall: empty,
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

/** A timeline in which all three overlapped for a real, CONTINUOUS interval. */
function overlappingTimeline(ticks = 8, spanMs = 40, intervalMs = 500): OverlapSample[] {
  const samples: OverlapSample[] = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    const inFlight: Record<string, boolean> = {};
    for (const id of THREE_SERVER_IDS) inFlight[id] = true;
    samples.push({ atMs: tick * intervalMs, spanMs, inFlight, unreadable: [] });
  }
  return samples;
}

/** One sample in which every server was in flight. */
function allInFlight(atMs: number, spanMs = 40): OverlapSample {
  const inFlight: Record<string, boolean> = {};
  for (const id of THREE_SERVER_IDS) inFlight[id] = true;
  return { atMs, spanMs, inFlight, unreadable: [] };
}

/** One sample in which nobody was scanning. */
function noneInFlight(atMs: number): OverlapSample {
  const inFlight: Record<string, boolean> = {};
  for (const id of THREE_SERVER_IDS) inFlight[id] = false;
  return { atMs, spanMs: 40, inFlight, unreadable: [] };
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
    assert(analysis.longestContinuousSimultaneousSamples >= CONCURRENCY_RULES.MIN_SIMULTANEOUS_SAMPLES,
      'the fixture is meant to clear the count floor, continuously');
    assert(overlapProblems(analysis).some((problem) => problem.includes('CONTINUOUS')),
      'a burst inside half a second must fail the duration floor');
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

  await test('SCATTERED simultaneous samples separated by IDLE fail the continuous floor', () => {
    // The exact cheat the totals could not see: three simultaneous samples spread across a long window with
    // the servers observed NOT scanning in between. The count clears three and last-minus-first clears two
    // seconds, and nothing overlapped for two seconds at any point.
    const samples = [
      allInFlight(0), noneInFlight(500), noneInFlight(1_000),
      allInFlight(1_500), noneInFlight(2_000), noneInFlight(2_500),
      allInFlight(3_000),
    ];
    const analysis = analyseOverlap(samples);
    assertEq(analysis.simultaneousSamples, 3, 'the fixture is meant to clear the TOTAL count');
    assert(analysis.simultaneousSpanSeconds >= CONCURRENCY_RULES.MIN_SIMULTANEOUS_SPAN_SECONDS,
      'and to clear the old first-to-last span');
    assertEq(analysis.longestContinuousSimultaneousSamples, 1, 'no two of them were adjacent');
    assertEq(analysis.longestContinuousSimultaneousSeconds, 0, 'so no run has any duration');
    assert(overlapProblems(analysis).length > 0, 'and the run must be refused');
  });

  await test('simultaneous samples separated by an UNREADABLE server fail the continuous floor', () => {
    const broken = { ...allInFlight(1_500), unreadable: ['plex'] };
    const samples = [allInFlight(0), allInFlight(500), allInFlight(1_000), broken,
      allInFlight(2_000), allInFlight(2_500)];
    const analysis = analyseOverlap(samples);
    assertEq(analysis.simultaneousSamples, 5, 'five samples still qualified');
    assertEq(analysis.longestContinuousSimultaneousSamples, 3, 'but the longest unbroken run is three');
    assertEq(analysis.longestContinuousSimultaneousSeconds, 1, 'lasting one second');
    assert(overlapProblems(analysis).some((problem) => problem.includes('CONTINUOUS')),
      'a poll this observer could not make is not an observation that all three were scanning');
  });

  await test('simultaneous samples separated by an IMPRECISE tick fail the continuous floor', () => {
    const wide = allInFlight(1_500, CONCURRENCY_DEADLINES_MS.SAMPLE_MAX_SPAN + 1);
    const samples = [allInFlight(0), allInFlight(500), allInFlight(1_000), wide,
      allInFlight(2_000), allInFlight(2_500)];
    const analysis = analyseOverlap(samples);
    assertEq(analysis.longestContinuousSimultaneousSamples, 3,
      'a tick too wide to describe one instant breaks the run like any other disqualifying sample');
    assert(overlapProblems(analysis).length > 0, 'and the run must be refused');
  });

  await test('a LONG MISSING-SAMPLE gap cannot become overlap duration', () => {
    // Two qualifying samples a minute apart, and nothing observed in between. Adjacent in the array is not
    // adjacent in time, and the minute nobody watched is not a minute of overlap.
    const samples = [allInFlight(0), allInFlight(60_000), allInFlight(60_500), allInFlight(61_000)];
    const analysis = analyseOverlap(samples);
    assertEq(analysis.simultaneousSamples, 4, 'all four qualified individually');
    assert(analysis.simultaneousSpanSeconds > 60, 'and first-to-last is over a minute');
    assertEq(analysis.longestContinuousSimultaneousSamples, 3, 'but the run restarts after the gap');
    assertEq(analysis.longestContinuousSimultaneousSeconds, 1, 'and lasts one second, not sixty-one');
    assertEq(analysis.brokenByGap, 1, 'and the break is reported');
    assert(overlapProblems(analysis).length > 0, 'so the run is refused');
  });

  await test('a gap exactly at the ceiling still joins; one millisecond over does not', () => {
    const at = CONCURRENCY_DEADLINES_MS.MAX_CONTINUOUS_GAP;
    assertEq(analyseOverlap([allInFlight(0), allInFlight(at), allInFlight(at * 2)])
      .longestContinuousSimultaneousSamples, 3, 'exactly at the ceiling is inside it');
    assertEq(analyseOverlap([allInFlight(0), allInFlight(at + 1)])
      .longestContinuousSimultaneousSamples, 1, 'one millisecond over is a new run');
  });

  await test('THE CADENCE CEILING IS AT MOST TWICE THE NOMINAL TICK, and strictly under the duration floor', () => {
    // IT WAS FIVE TIMES THE TICK. `SAMPLE_INTERVAL + SAMPLE_MAX_SPAN` = 2,500 ms, on the reasoning that a
    // tick may be as wide as the simultaneity bound -- which conflates how far apart THREE ANSWERS WITHIN
    // ONE TICK may be with how many polling intervals may go missing BETWEEN ticks.
    assert(CONCURRENCY_DEADLINES_MS.MAX_CONTINUOUS_GAP
      <= CONCURRENCY_DEADLINES_MS.SAMPLE_INTERVAL * 2,
      `the gap ceiling is ${CONCURRENCY_DEADLINES_MS.MAX_CONTINUOUS_GAP}ms against a nominal tick of `
      + `${CONCURRENCY_DEADLINES_MS.SAMPLE_INTERVAL}ms; more than one missed poll is unobserved time`);
    assert(CONCURRENCY_DEADLINES_MS.MAX_CONTINUOUS_GAP > CONCURRENCY_DEADLINES_MS.SAMPLE_INTERVAL,
      'and it must tolerate at least a slow tick, or a correct run breaks on ordinary jitter');
    assert(CONCURRENCY_DEADLINES_MS.MAX_CONTINUOUS_GAP
      < CONCURRENCY_RULES.MIN_SIMULTANEOUS_SPAN_SECONDS * 1_000,
      'and strictly under the duration floor, or a run can be assembled out of ceiling-width gaps alone');
    assert(CORE.includes('assertCadenceIsFailClosed'),
      'and the relation must be machine-checked at load, not written down in a comment');
  });

  await test('gaps of 1.5s and 2.0s BREAK the run, however unanimous the samples', () => {
    for (const gapMs of [1_500, 1_750, 2_000]) {
      const samples = [0, 1, 2, 3, 4, 5].map((index) => allInFlight(index * gapMs));
      const analysis = analyseOverlap(samples);
      assertEq(analysis.simultaneousSamples, 6, `all six samples qualify individually at ${gapMs}ms`);
      assertEq(analysis.longestContinuousSimultaneousSamples, 1,
        `a ${gapMs}ms gap is ${gapMs / CONCURRENCY_DEADLINES_MS.SAMPLE_INTERVAL} polling intervals of `
        + 'unobserved time and must break the run');
      assertEq(analysis.longestContinuousSimultaneousSeconds, 0, 'so no run has any credited duration');
      assert(overlapProblems(analysis).length > 0, 'and the timeline must be refused');
    }
  });

  await test('a run made entirely of CEILING-width gaps cannot clear the duration floor', () => {
    // THE HOLE THE CREDITED CALCULATION CLOSES. At the ceiling every gap is two nominal ticks, so half of
    // the wall span was never polled. Three such samples span exactly the two-second floor in wall time.
    const at = CONCURRENCY_DEADLINES_MS.MAX_CONTINUOUS_GAP;
    const samples = [allInFlight(0), allInFlight(at), allInFlight(at * 2)];
    const analysis = analyseOverlap(samples);
    assertEq(analysis.longestContinuousSimultaneousSamples, 3, 'the run is unbroken');
    assertEq(analysis.longestContinuousWallSeconds,
      CONCURRENCY_RULES.MIN_SIMULTANEOUS_SPAN_SECONDS, 'and its WALL span is exactly the floor');
    assert(analysis.longestContinuousSimultaneousSeconds
      < CONCURRENCY_RULES.MIN_SIMULTANEOUS_SPAN_SECONDS,
      `but only ${analysis.longestContinuousSimultaneousSeconds}s is credited, because each gap is worth at `
      + 'most one nominal tick — an observer that fell behind cannot charge the time it did not poll');
    assert(overlapProblems(analysis).some((problem) => problem.includes('CONTINUOUS')),
      'so the wall span alone must not clear the floor');
  });

  await test('the credited figure equals the wall span when the observer kept its cadence', () => {
    const analysis = analyseOverlap(overlappingTimeline(9, 40, CONCURRENCY_DEADLINES_MS.SAMPLE_INTERVAL));
    assertEq(analysis.longestContinuousSimultaneousSeconds, analysis.longestContinuousWallSeconds,
      'at nominal cadence nothing is discounted, so the rule costs a correct run nothing');
  });

  await test('the REAL measured sequences still pass: 9-10 continuous samples over 4.1-4.6s', () => {
    // The observer ticks at 500ms; the four wrapper sequences measured 9-10 simultaneous samples spanning
    // 4.1-4.6s, which is (n-1) x ~510ms -- i.e. continuous at the tick rate. Both shapes are reproduced.
    for (const [ticks, intervalMs] of [[9, 512], [10, 511]] as const) {
      const analysis = analyseOverlap(overlappingTimeline(ticks, 40, intervalMs));
      assertEq(analysis.longestContinuousSimultaneousSamples, ticks, 'the whole run is unbroken');
      // The measured gaps (~511-512 ms) sit just over the nominal tick, so each is credited the full 500 ms
      // and the run is credited (n-1) x 0.5 s: 4.0 s for nine samples, 4.5 s for ten. Both clear the floor
      // with a factor of two, and the wall span is the 4.1-4.6 s the runs reported.
      assert(analysis.longestContinuousSimultaneousSeconds >= 4
        && analysis.longestContinuousSimultaneousSeconds <= 4.7,
        `expected a 4.0-4.5s credited run, got ${analysis.longestContinuousSimultaneousSeconds}s`);
      assert(analysis.longestContinuousWallSeconds >= 4.0
        && analysis.longestContinuousWallSeconds <= 4.7,
        `and a 4.1-4.6s wall span, got ${analysis.longestContinuousWallSeconds}s`);
      assert(analysis.longestContinuousSimultaneousSeconds
        >= CONCURRENCY_RULES.MIN_SIMULTANEOUS_SPAN_SECONDS * 2,
        'the real measured shape must clear the floor with meaningful margin, not scrape it');
      assertEq(overlapProblems(analysis).length, 0,
        'the real measured shape must not be refused by the stricter rule');
    }
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

  await test('a FRACTIONAL per-object column fails closed, as the scalars already did', () => {
    // The parser's own message called these "whole non-negative counts" and only checked >= 0 and isFinite.
    // 4.5 responses parsed cleanly, and every per-object budget is a comparison against a ceiling -- so
    // fractional counts compare, and pass.
    for (const key of COUNTER_ARRAY_KEYS) {
      const document = { ...counters(twoObjects) } as Record<string, unknown>;
      document[key] = (document[key] as number[]).map((value, index) => (index === 0 ? 1.5 : value));
      assert(parseProviderCounters(document, 'test').counters === undefined,
        `a fractional value in "${key}" must not parse into a budgetable snapshot`);
    }
  });

  await test('a per-object RESET compensated elsewhere is refused, though every aggregate balances', () => {
    // The shape an endpoint restart makes: ordinal 0 drops to zero, ordinal 1 absorbs its bytes. Lengths,
    // sums, both partitions and every scalar are unchanged -- and ordinal 0's window delta is NEGATIVE,
    // which satisfies every per-object ceiling by arithmetic rather than by behaviour.
    const before = counters([
      { size: 4_194_304, small: 1, chunk: 1, partial: 0, oversized: 0 },
      { size: 4_194_304, small: 1, chunk: 1, partial: 0, oversized: 0 },
    ]);
    const moved = before.objectBytes[0] as number;
    const after: ProviderCounters = {
      ...before,
      objectBytes: [0, (before.objectBytes[1] as number) + moved],
      objectChunk: [0, (before.objectChunk[0] as number) + (before.objectChunk[1] as number)],
      objectSmall: [0, (before.objectSmall[0] as number) + (before.objectSmall[1] as number)],
    };
    // The fixture really does leave every aggregate intact, or it would be testing the wrong thing.
    assertEq(after.objectBytes.reduce((a, b) => a + b, 0), after.bytesServed,
      'the compensating move must keep the attribution sum exact');
    const problems = attributionProblems(before, after, 2);
    assert(problems.some((problem) => problem.kind === 'per-object-counter-reset'),
      `a compensated per-object reset must be refused: ${problems.map((p) => p.kind).join(', ') || 'none'}`);
  });

  await test('a per-object CLASS counter reset is refused even when bytes are untouched', () => {
    // Every class column is non-zero in the BEFORE snapshot, or setting it to zero would not be a fall and
    // the test would pass by not exercising anything.
    const before = counters([{ size: 4_194_304, small: 3, chunk: 2, partial: 1, oversized: 1 }]);
    for (const column of ['objectChunk', 'objectSmall', 'objectPartial', 'objectOversized'] as const) {
      const after = { ...before, [column]: [0] } as ProviderCounters;
      assert(attributionProblems(before, after, 1)
        .some((problem) => problem.kind === 'per-object-counter-reset'),
        `a reset of ${column} must be refused; a negative class delta would let the per-entry request-shape `
        + 'check pass while the byte column looked fine');
    }
  });

  await test('an object whose SIZE changed between snapshots is refused', () => {
    const before = counters([{ size: 4_194_304, small: 1, chunk: 0, partial: 0, oversized: 0 }]);
    const after = { ...before, objectSizes: [8_388_608] };
    assert(attributionProblems(before, after, 1)
      .some((problem) => problem.kind === 'object-identity-moved'),
      'every per-object ceiling is derived from objectSizes[i]; if it moved, the ceiling belongs to a '
      + 'different object');
  });

  await test('a REORDER of two differently sized objects is refused', () => {
    const before = counters([
      { size: 4_194_304, small: 1, chunk: 1, partial: 0, oversized: 0 },
      { size: 262_144, small: 1, chunk: 0, partial: 0, oversized: 0 },
    ]);
    const after: ProviderCounters = {
      ...before,
      objectSizes: [before.objectSizes[1] as number, before.objectSizes[0] as number],
      objectBytes: [before.objectBytes[1] as number, before.objectBytes[0] as number],
      objectChunk: [before.objectChunk[1] as number, before.objectChunk[0] as number],
      objectSmall: [before.objectSmall[1] as number, before.objectSmall[0] as number],
    };
    const kinds = attributionProblems(before, after, 2).map((problem) => problem.kind);
    assert(kinds.includes('object-identity-moved'),
      'a reorder moves the sizes at each ordinal, and the ordinal is the only handle these columns carry');
    assert(kinds.includes('per-object-counter-reset'),
      'and the swapped-down column is also a fall, which is a second independent refusal');
  });

  await test('these refusals happen BEFORE any budget verdict is reached', () => {
    // Order is the guarantee: the CLI records the telemetry verdict first, and `record` throws on a failed
    // verdict, so nothing downstream of it can produce a number over telemetry the gate does not trust.
    const telemetryAt = CLI.indexOf('-telemetry-coherent');
    for (const later of ['-cold-window', '-G14a-range-requests', '-G15-provider-bytes',
      '-G15-per-object-breaches', '-per-entry-request-shape']) {
      assert(CLI.indexOf(later) > telemetryAt,
        `${later} must be recorded after the telemetry check, which throws on failure`);
    }
    assert(/if \(result\.verdict === 'fail'\) throw new GateFailure/.test(CLI),
      'and a failed verdict must stop the phase rather than being counted');
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

  await test('G14a, G14b and G15 are the ACCEPTANCE PLAN\'s ceilings, not the media-server multipliers', () => {
    // THE DEFECT THIS CLOSES. G18 says G14a-G17 hold UNCHANGED. The window command asserted the three
    // single-server gates' x6 real-scanner multipliers -- 258 and 258 against 43 remote entries, where the
    // plan says 155 and 52 -- and mentioned the plan's own numbers in a note as a "bonus observation".
    assertEq(canonicalRangeRequestCeiling(43), 155, 'ceil(1.2 x 43 x 3)');
    assertEq(canonicalResolutionCeiling(43), 52, 'ceil(1.2 x 43)');
    assertEq(canonicalScanByteCeiling(43),
      Math.floor(1.2 * PROJECTION_PROBE_PLAN.WINDOW_BYTES * 3 * 43), 'the plan\'s own flat byte arithmetic');
    assertEq(CANONICAL_SCAN_WINDOWS_PER_ENTRY, PROJECTION_PHASE_1_BUDGETS.SCAN_WINDOWS_PER_ENTRY,
      'the window count is the contract\'s');
    assertEq(PROJECTION_PHASE_1_BUDGETS.MAX_RANGE_REQUEST_MULTIPLIER, 1.2, 'and so is the multiplier');
    assertEq(PROJECTION_PHASE_1_BUDGETS.MAX_RESOLUTION_REQUEST_MULTIPLIER, 1.2, 'both of them');
    assert(canonicalRangeRequestCeiling(43)
      < Math.ceil(43 * MEDIA_SERVER_BUDGETS.MAX_SCAN_RANGE_MULTIPLIER),
      'and the canonical ceiling must be the STRICTER of the two, or none of this mattered');
  });

  await test('the CLI derives those ceilings from the contract and cannot be told otherwise', () => {
    assert(CLI.includes('canonicalRangeRequestCeiling') && CLI.includes('canonicalResolutionCeiling')
      && CLI.includes('canonicalScanByteCeiling'), 'all three must come from the canonical helpers');
    assert(!CLI.includes("optionalNumber(args, 'windows'"),
      'a `--windows` flag is a way to weaken a REQUIRED acceptance gate from a command line');
    assert(!/withinBudget\(`\$\{gate\}-G14a-range-requests`[^;]*MAX_SCAN_RANGE_MULTIPLIER/s.test(CLI),
      'G14a must not be asserted against the looser real-scanner multiplier');
    assert(CLI.includes('-G15-provider-bytes-block-geometry'),
      'the stricter block-geometry ceiling must survive AS WELL, never instead');
  });

  await test('the gate holds 429s to zero, not to "few"', () => {
    assertEq(PROJECTION_PHASE_1_BUDGETS.MAX_HTTP_429, 0, 'G16 says zero, in the plan own constant');
    assertEq(MEDIA_SERVER_BUDGETS.MAX_HTTP_429, 0, 'and the media-server mirror agrees');
    assert(CLI.includes('PROJECTION_PHASE_1_BUDGETS.MAX_HTTP_429'),
      'a gate id that names an acceptance gate should read that acceptance gate constant, even where the '
      + 'two happen to be equal — which is exactly what made it easy to reach for the wrong one');
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
    assert(GATE.includes('HOLD_MAX=4500ms'), 'and it must be the derived value');
  });

  await test('the BACKSTOP is STRICTLY below the queue-wait budget, not equal to it', () => {
    // IT WAS EXACTLY EQUAL, at 5,000 against 5,000, while the text beside it said "strictly shorter". On the
    // boundary the guarantee is gone: a read arriving an instant after another blocks waits the entire
    // budget and can be refused admission -- the starvation the bound exists to prevent.
    assert(HOLD_MAX_MS < PROJECTIOND_ADMISSION_LIMITS.MAX_QUEUE_WAIT_MS,
      `the endpoint backstop is ${HOLD_MAX_MS}ms against a `
      + `${PROJECTIOND_ADMISSION_LIMITS.MAX_QUEUE_WAIT_MS}ms queue-wait budget; equality is not "strictly `
      + 'shorter" and leaves a read on the boundary that can be refused admission');
    // The whole chain, ordered, so a future edit to any one term is caught by the relation and not by prose.
    assert(HOLD_ARM_MS < HOLD_MAX_MS
      && HOLD_MAX_MS < PROJECTIOND_ADMISSION_LIMITS.MAX_QUEUE_WAIT_MS
      && PROJECTIOND_ADMISSION_LIMITS.MAX_QUEUE_WAIT_MS < PROJECTIOND_READ_POLICY.FIRST_BYTE_DEADLINE_MS,
      `arm ${HOLD_ARM_MS} < backstop ${HOLD_MAX_MS} < queue-wait `
      + `${PROJECTIOND_ADMISSION_LIMITS.MAX_QUEUE_WAIT_MS} < first-byte `
      + `${PROJECTIOND_READ_POLICY.FIRST_BYTE_DEADLINE_MS} must hold, strictly, at every step`);
  });

  await test('THE ARM WINDOW LEAVES ROOM FOR THE LAG BETWEEN THE BLOCK AND ITS DETECTION', () => {
    // RUN 2 OF THE FIRST FULLY REMEDIATED SEQUENCE FAILED HERE. The endpoint's backstop is measured from the
    // moment a request ACTUALLY blocks; the arm window is measured from the moment the observer's polled
    // `/counters` NOTICES it. Those are different clocks. At arm=4,000 against backstop=4,500 the difference
    // only had to reach 500ms, and it did -- `holdTimeouts` moved to 1 -- while run 1 of the same sequence
    // passed on identical code by detecting the block one tick sooner. A gate whose verdict depends on which
    // tick a poll lands in is not measuring the data plane.
    const lagAllowance = CONCURRENCY_DEADLINES_MS.MAX_CONTINUOUS_GAP
      + CONCURRENCY_DEADLINES_MS.SAMPLE_INTERVAL;
    assert(HOLD_ARM_MS + lagAllowance <= HOLD_MAX_MS,
      `the arm window (${HOLD_ARM_MS}ms) plus the observation lag it must tolerate (${lagAllowance}ms) must `
      + `fit inside the endpoint backstop (${HOLD_MAX_MS}ms), or a correct run reports a lapsed hold`);
    assert(HOLD_ARM_MS > 0, 'and the arm window must still exist');
    assert(CORE.includes('assertHoldChainIsFailClosed'),
      'and the relation must be machine-checked at load, not written down in a comment');
  });

  await test('EXECUTABLE: slow server polls cannot delay the barrier release', async () => {
    // THE REGRESSION FOR THE DEFECT RUN 2 FOUND, AND FOR THE HALF-FIX THAT FOLLOWED IT.
    //
    // The release used to be checked in the observation loop, below the three server polls. This drives the
    // real `runConcurrentScans` against a real (loopback) endpoint with adapters whose `scanIsRunningNow`
    // takes far longer than the arm window. Under the old shape the release could not fire until those polls
    // returned, so it would land at least one poll-length late — and at the real constants that is what made
    // the endpoint's backstop lapse. With the watchdog on its own cadence, server latency is not on the
    // release path at all.
    let held = 0;
    let countersPolls = 0;
    let releasedAt = 0;
    let blockedAt = 0;
    const requests: string[] = [];
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      requests.push(url);
      if (url === '/counters') {
        // THE FIRST POLL IS THE BASELINE READ, taken after the hold is ARMED but before any request has
        // BLOCKED on it, and it must report ZERO — otherwise the baseline itself is 1, no later poll is ever
        // "greater than baseline", and the block is never detected. The block appears from the second poll
        // onward, so the arm window starts almost immediately and this test is about RELEASE latency rather
        // than about detection.
        countersPolls += 1;
        if (countersPolls > 1 && held === 0) { held = 1; blockedAt = Date.now(); }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ heldRequests: held }));
        return;
      }
      if (url.startsWith('/control/release/')) { releasedAt = Date.now(); res.statusCode = 204; res.end(); return; }
      if (url.startsWith('/control/hold/')) { res.statusCode = 204; res.end(); return; }
      res.statusCode = 404; res.end();
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as AddressInfo).port;

    const SLOW_POLL_MS = 1_500;
    const ARM_MS = 300;
    try {
      const slowAdapter = (id: string): ServerAdapter => ({
        id: id as never,
        readState: () => ({}),
        scanIsRunningNow: async () => {
          // The latency that used to sit between the gate deciding to release and actually releasing.
          await new Promise((resolve) => { setTimeout(resolve, SLOW_POLL_MS); });
          return true;
        },
        scanLibrary: async () => {
          await new Promise((resolve) => { setTimeout(resolve, 3_000); });
          return { observedInFlight: true };
        },
        catalogue: async () => [],
      });
      const adapters = THREE_SERVER_IDS.map((id) => slowAdapter(id));
      await runConcurrentScans({
        adapters,
        states: new Map(adapters.map((adapter) => [adapter.id, {}])),
        endpointBaseUrl: `http://127.0.0.1:${port}`,
        barrierRef: 'obj-test-barrier',
        sampleIntervalMs: 50,
        holdArmMs: ARM_MS,
        deadlineMs: 20_000,
      });

      assert(blockedAt > 0, 'the fake endpoint must have reported a block');
      assert(releasedAt > 0, 'and the barrier must have been released');
      const overshoot = releasedAt - blockedAt - ARM_MS;
      // THE BOUND IS THE WATCHDOG'S OWN, and it is far below one server poll -- which is what makes this
      // discriminating rather than decorative. If the release were queued behind the polls again, or the
      // watchdog's cadence were slowed to theirs, the overshoot would be at least SLOW_POLL_MS.
      const bound = BARRIER_RELEASE_OVERSHOOT_MS + 250;
      assert(bound * 2 <= SLOW_POLL_MS,
        'the fixture must separate a correct release from a poll-queued one by at least a factor of two');
      assert(overshoot <= bound,
        `the release landed ${overshoot}ms after its arm window, above the watchdog's own bound of `
        + `${bound}ms. One ${SLOW_POLL_MS}ms server poll on the release path would look exactly like this`);
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });

  await test('the barrier release lives on its OWN loop, not in the observation tick', () => {
    // Structural companion to the executable regression above: the release must not be reachable from the
    // tick body at all, because that is where the unbounded server polls are.
    const tickBody = DRIVER.split('const tickStart = now();')[1] ?? '';
    assert(!tickBody.includes('readCounters(opts.endpointBaseUrl'),
      'the barrier gauge must not be polled from the observation tick');
    assert(!/blockingSinceMs !== 0 && now\(\) - blockingSinceMs >= armMs/.test(tickBody),
      'and the arm-window release must not be checked from it either');
    const watchdog = DRIVER.split('const watchdog = (async () =>')[1] ?? '';
    assert(watchdog.includes('readCounters(opts.endpointBaseUrl'), 'the watchdog polls the gauge');
    assert(watchdog.includes('BARRIER_WATCHDOG_INTERVAL'), 'on its own cadence');
    assert(watchdog.includes('await release('), 'and it is what releases');
  });

  await test('the arm clock starts when the WATCHDOG OBSERVES a blocked request, not when the hold is armed', () => {
    // THE LABEL USED TO SAY "when a request BLOCKS", which is the BACKSTOP's clock and not this one. What
    // the code below actually does is compare `heldRequests` against a baseline and stamp the moment the
    // WATCHDOG SEES it rise -- so the clock starts at observation, which lags the true block by up to one
    // watchdog period. That gap is the whole subject of §3.4 and of the run that failed on it; a test whose
    // name asserted the other clock was restating the defect while passing.
    assert(DRIVER.includes('blockingSinceMs'),
      'an armed hold nothing has reached starves nobody; timing the window from the arming would expire it '
      + 'before the first scanner arrived on a slow host');
    assert(DRIVER.includes('heldBaseline'),
      'and the block must be detected by the watchdog seeing heldRequests rise above a baseline');
    // The stamp is taken at the moment of OBSERVATION, which is what makes the name above accurate.
    assert(/held > heldBaseline\)\s*\{[\s\S]{0,120}blockingSinceMs = now\(\)/.test(DRIVER),
      'blockingSinceMs must be stamped where the watchdog observes the rise, not passed in from elsewhere');
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
  console.log('\nTHE CHEAT: a COMMITTED length standing in for what was WRITTEN');
  // --------------------------------------------------------------------------------------------------------

  const realShaped: FakeObject[] = [
    { size: 262_144, small: 0, chunk: 0, partial: 0, oversized: 0 },
    { size: 105_406_871, small: 3, chunk: 2, partial: 0, oversized: 0 },
    { size: 40_000, small: 3, chunk: 0, partial: 0, oversized: 0 },
  ];

  await test('no G18 surface claims delivery, receipt, wire traffic or billing in the present tense', () => {
    // THIS WORDING HAS NOW BEEN CORRECTED THREE TIMES. A committed counter was reported as "served"; the
    // correction said "put on the socket" and "actually written"; and a comparison of one instrument's
    // observed column against another's committed one was published as "delivered". Each round fixed the
    // sentences somebody looked at. This one is executed, over every G18 surface, so the next round cannot
    // depend on who reads which file.
    const findings = G18_WORDING_FILES.flatMap((file) =>
      deliveryOverstatements(readForWordingScan(file), file));
    assert(findings.length === 0, `G18 surfaces make delivery claims:\n    ${findings.join('\n    ')}`);
  });

  await test('...and the rule is live in BOTH directions, so neither half is decorative', () => {
    // A PROSE RULE THAT NEVER FIRES IS INDISTINGUISHABLE FROM ONE THAT IS BROKEN. So the check is driven
    // against text built to fail it, and against the two shapes it must NOT fail.
    assert(deliveryOverstatements('the endpoint actually wrote 12 bytes to the socket', 'x').length > 0,
      'a plain current-tense delivery claim must be caught');
    assert(deliveryOverstatements('committed bytes left the endpoint\'s control', 'x').length > 0,
      'and so must the committed-length overstatement this round removed');
    assertEq(deliveryOverstatements('it is NOT proof of peer receipt, NOT a TCP acknowledgement', 'x').length,
      0, 'a NEGATED phrase is the nonclaim these gates are required to carry');
    assertEq(deliveryOverstatements('an earlier version said the endpoint actually wrote it', 'x').length, 0,
      'and a line that declares itself historical may quote what it retracts');
    // THE HISTORICAL ESCAPE IS NOT A BLANKET ONE: the marker has to be on the line making the claim.
    assert(deliveryOverstatements('the second answers where the delivered traffic went', 'x').length > 0,
      'a claim on a line with no marker and no negation is still a claim');
  });

  await test('the endpoint reports what Write RETURNED, not only what it promised', () => {
    // THE DEFECT THIS CLOSES, WHICH SHIPPED IN BOTH FAKE ENDPOINTS. Every body-producing branch ended
    // `_, _ = w.Write(payload)`, discarding the count and the error, so the only byte figure that existed was
    // the COMMITTED payload length. The sibling gate then built a delivery-shaped conclusion on it.
    const endpoint = readRepoFile('projectiond/internal/fakeprovider/fakeprovider.go');
    const code = endpoint.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert(!code.includes('_, _ = w.Write('),
      'the write count and error are discarded again, so no figure built on this endpoint describes writing');
    assert(code.includes('ObservedBytes.Add('), 'the write return is recorded');
    assert(code.includes('CompletedBodies.Add(') && code.includes('TruncatedBodies.Add('),
      'and whether the body finished is recorded beside it');
    assert(code.includes('BodiesInFlight.Add('), 'and a gauge says when the observed column may be read');
  });

  await test('THE CHEAT: an unsettled snapshot, whose two byte columns describe different sets', () => {
    const after = counters(realShaped, { bodiesInFlight: 2 });
    assert(attributionProblems(zeroLike(after), after, after.objectSizes.length)
      .some((problem) => problem.kind === 'telemetry-unsettled'),
    'a snapshot taken mid-write cannot support an observed-byte figure');
    const settled = counters(realShaped);
    assert(attributionProblems({ ...zeroLike(settled), bodiesInFlight: 1 }, settled,
      settled.objectSizes.length).some((problem) => problem.kind === 'telemetry-unsettled'),
    'and an unsettled BEFORE snapshot is refused for the same reason');
  });

  await test('THE CHEAT: an endpoint claiming it wrote more than it committed to', () => {
    const after = counters(realShaped, { observedBytes: 999_000_000_000 });
    assert(attributionProblems(zeroLike(after), after, after.objectSizes.length)
      .some((problem) => problem.kind === 'observed-exceeds-committed'),
    'if it says it did, the two columns have stopped describing the same responses');
  });

  await test('THE CHEAT: an outcome count that does not account for every body', () => {
    const after = counters(realShaped, { completedBodies: 1, truncatedBodies: 0 });
    assert(attributionProblems(zeroLike(after), after, after.objectSizes.length)
      .some((problem) => problem.kind === 'outcome-partition'),
    'after settlement every body is completed or truncated, and a shortfall means one was lost');
  });

  await test('the observed column is attributed per object and refused when it is not', () => {
    const after = counters(realShaped);
    const skewed = {
      ...after,
      objectObserved: after.objectObserved.map((value, index) => (index === 1 ? value - 1 : value)),
    };
    assert(attributionProblems(zeroLike(after), skewed, after.objectSizes.length)
      .some((problem) => problem.kind === 'unattributed-observed-bytes'),
    'an aggregate that no longer matches its columns is a number with no denominator');
  });

  await test('THE BUDGET IS ASSERTED ON BOTH COLUMNS, so the observed one cannot weaken anything', () => {
    // THE POINT. Observed can never exceed committed, so a ceiling moved FROM committed TO observed would be
    // laxer. Asserting both keeps every historical assertion and adds the bytes-written bound beside it.
    const objects: FakeObject[] = [{ size: 40_000, small: 1, chunk: 0, partial: 0, oversized: 0 }];
    const after = counters(objects);
    const verdicts = objectByteVerdicts(zeroLike(after), after, daemonBlockByteCeiling,
      PLEX_LARGE_FIXTURE.MIN_BYTES, MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION);
    assertEq(verdicts[0]?.withinBudget, true, 'a well-behaved object passes on committed');
    assertEq(verdicts[0]?.observedWithinBudget, true, 'and on observed');
    const breachedOnObserved = objectByteVerdicts(zeroLike(after),
      { ...after, objectObserved: [999_999_999], observedBytes: 999_999_999 },
      daemonBlockByteCeiling, PLEX_LARGE_FIXTURE.MIN_BYTES, MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION);
    assertEq(breachedOnObserved[0]?.observedWithinBudget, false, 'an observed breach is a breach');
    assertEq(breachedObjects(breachedOnObserved).length, 1,
      'and it is REPORTED as one, so the column that is reported is the column that is enforced');
  });

  await test('a truncated body makes the two columns diverge without breaking any partition', () => {
    const objects: FakeObject[] = [{
      size: 40_000, small: 1, chunk: 0, partial: 0, oversized: 0, observed: 4_096,
    }];
    const after = counters(objects);
    assertEq(attributionProblems(zeroLike(after), after, after.objectSizes.length).length, 0,
      'divergence is not a defect; it is the measurement');
    assertEq(after.truncatedBodies, 1, 'and the abandoned body is counted as truncated');
    assert(after.observedBytes < after.bytesServed, 'with the two totals genuinely apart');
  });

  await test('a byte total above the safe-integer range is refused rather than silently rounded', () => {
    // ABOVE 2^53 A JSON NUMBER HAS ALREADY LOST PRECISION while `Number.isInteger` still answers true, and
    // every difference taken from it is quietly wrong. A byte total is exactly the field that gets there.
    const after = counters(realShaped);
    const huge = JSON.parse(JSON.stringify(after)) as Record<string, unknown>;
    huge.bytesServed = Number.MAX_SAFE_INTEGER + 2;
    assert(parseProviderCounters(huge, 'test').counters === undefined, 'an unsafe integer must not parse');
    const hugeColumn = JSON.parse(JSON.stringify(after)) as Record<string, unknown>;
    (hugeColumn.objectBytes as number[])[0] = Number.MAX_SAFE_INTEGER + 2;
    assert(parseProviderCounters(hugeColumn, 'test').counters === undefined,
      'and neither must an unsafe per-object entry');
  });

  await test('the gauges are excluded from the monotonicity rule, by name', () => {
    assert(GAUGE_COUNTER_KEYS.includes('bodiesInFlight'), 'the in-flight gauge is a gauge');
    assert(GAUGE_COUNTER_KEYS.includes('currentHeldWaiters'), 'and so is the held-waiter gauge');
    for (const key of GAUGE_COUNTER_KEYS) {
      assert(!MONOTONIC_COUNTER_KEYS.includes(key), `${key} must not be held to monotonicity`);
    }
    assertEq(MONOTONIC_COUNTER_KEYS.length, COUNTER_KEYS_REQUIRED.length - 1,
      'and everything else still is: only bodiesInFlight is in both lists, since currentHeldWaiters was '
      + 'never a required key');
    assertEq(OBSERVED_BYTES_ARE_APPLICATION_WRITES, true,
      'and what an observed byte is — and is not — is stated as a value a test can hold');
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

  await test('the three-run wrapper says what three green runs here are and are not', () => {
    assert(THREE.includes('closes NEITHER G18 NOR any of G7-G13'),
      'the closing message must refuse the reading that three green runs on this host closed anything');
    // IT MUST SAY WHERE THEY DID HAPPEN, AND THAT SENTENCE HAS CHANGED BECAUSE THE FACT DID. It used to read
    // "No run of this gate has ever happened on Linux or Unraid"; three consecutive fresh Unraid runs made
    // that false, and a wrapper that went on printing it would be the exact failure this repository exists to
    // prevent — a document disagreeing with what runs. What it must NOT do is round the new fact up.
    assert(THREE.includes('HAS now run on a real Unraid host'),
      'and it must say where they did happen');
    assert(THREE.includes('Phase 1 remains open'),
      'while refusing the reading that this closed the tranche');
    // IT NAMES THE GATES THAT CANNOT BE RUN AT ALL, so "not run" is never confused with "run and failed".
    // That list used to be G24-G27; G24, G25 and G26 have since been written and run 3/3 on Unraid, so only
    // G27's three-server half is left and the wrapper must say the smaller, true thing.
    assert(/G27s three-server half has no executable gate/.test(THREE),
      'and naming the gate that cannot be run at all');
    assert(!/G24-G2[67] have no executable gate/.test(THREE),
      'and no longer claiming that of the lease gates, which exist and have run');
    assert(THREE.includes('a run that inherited the previous one'),
      'the whole value of the repetition is that no run can inherit what the previous one left behind');
    assert(THREE.includes('COLD'),
      'and on THIS gate that matters more than on the other three: a run that inherited a warm probe cache '
      + 'would measure a window in which the data plane did no work');
  });

  await test('each adapter is the server it names, and the three are distinct', () => {
    const adapters = THREE_SERVER_IDS.map((id) => adapterFor(id));
    assertEq(adapters.length, REQUIRED_SERVER_COUNT, 'one adapter per server');
    assertEq(new Set(adapters.map((adapter) => adapter.id)).size, REQUIRED_SERVER_COUNT,
      'three distinct servers, not one server three times');
    for (const adapter of adapters) {
      assert((THREE_SERVER_IDS as readonly string[]).includes(adapter.id),
        `an adapter reported an id outside the set: ${adapter.id}`);
      for (const method of ['readState', 'scanIsRunningNow', 'scanLibrary', 'catalogue'] as const) {
        assertEq(typeof adapter[method], 'function', `${adapter.id} must implement ${method}`);
      }
    }
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

  await test('the host preflight runs before the FIRST executable container start, whichever it is', () => {
    // THE DEFECT THIS CLOSES, AND IT IS A DEFECT IN THE TEST RATHER THAN IN THE GATE. This asserted "before
    // any container is started" and compared the preflight against the RANGE container, three hundred lines
    // further down -- while the /dev/fuse probe started a container well before it. The claim was true of the
    // comparison and false of the sentence. So the comparison is now against the FIRST container start in the
    // file, computed rather than named, and it cannot go vacuous again when a new start is added above it.
    //
    // TOP-LEVEL LINES ONLY. Function bodies (`cleanup`, `start_daemon`, `daemon_status`, ...) are indented in
    // this file and their `docker run`s execute when the function is CALLED, not where it is written; the
    // cleanup trap in particular is defined near the top and runs last. So an unindented, non-comment line is
    // what counts as an executable start, and the function CALLS that start containers are unindented too.
    const lines = GATE.split('\n');
    // ...AND A ONE-LINE FUNCTION DEFINITION IS NOT AN EXECUTION. `ffmpeg_run() { docker run …; }` sits at
    // column 0 and starts nothing until it is called. Excluding definitions is the difference between a check
    // that finds the first thing that RUNS and one that finds the first thing that MENTIONS docker — and the
    // second is how this assertion went vacuous the first time.
    const isDefinition = (line: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{/.test(line);
    const startsAt = lines.findIndex((line) => !/^\s/.test(line) && !line.trimStart().startsWith('#')
      && !isDefinition(line)
      && (/\bdocker run\b/.test(line) || /\bdocker build\b/.test(line)
        || /\bdocker compose\b[^|]*\bup\b/.test(line)
        || /^start_(daemon|jellyfin|plex|emby)\b/.test(line)));
    const preflightAt = lines.findIndex((line) => line.includes('projection-host-preflight-cli.ts propagation'));
    const traversalAt = lines.findIndex((line) => line.includes('projection-host-preflight-cli.ts traversal'));
    assert(preflightAt > 0 && traversalAt > 0, 'both preflight checks must run');
    assert(startsAt > 0, 'the gate must start a container somewhere, or this check is meaningless');
    assert(preflightAt < startsAt && traversalAt < startsAt,
      `the first executable container start is line ${startsAt + 1} (${lines[startsAt]?.trim()}), and the `
      + `preflight is at line ${preflightAt + 1}. A preflight that runs after a container is diagnosing a `
      + 'host this gate has already begun using');
    // ...and specifically before the /dev/fuse probe, which is the one it used to run after.
    const fuseProbeAt = lines.findIndex((line) => line.includes('--device /dev/fuse:/dev/fuse'));
    assert(fuseProbeAt > 0 && preflightAt < fuseProbeAt,
      'the /dev/fuse probe starts a container and must come after the non-mutating preflight');
  });

  await test('the preflight itself starts nothing, so running it first is free', () => {
    const lines = GATE.split('\n');
    const preflightAt = lines.findIndex((line) => line.includes('projection-host-preflight-cli.ts propagation'));
    const traversalAt = lines.findIndex((line) => line.includes('projection-host-preflight-cli.ts traversal'));
    for (const at of [preflightAt, traversalAt]) {
      assert(/^npx tsx /.test(lines[at] as string),
        'the preflight must be a host-local process invocation, not a container');
    }
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
    assert(cleanup.includes('projection_gate_cleanup_run'),
      'and a stale mount must be forced away through the shared helper, which unmounts in a namespace\n'
      + 'that propagates back to the host — the inline version did not, and left four mountpoints on Unraid');
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

  await test('the success banner names the CANONICAL Phase 1 ceilings, not the media-server ones', () => {
    // The banner is what an operator reads. It said G14a-G17 came "from the same MEDIA_SERVER_BUDGETS the
    // three single-server gates hold" -- which is what the gate did BEFORE the canonical correction, and
    // stating it afterwards would misdescribe the evidence in the one place most likely to be quoted.
    const banner = GATE.split('gate PASSED. Exactly what was proved:')[1] ?? '';
    assert(banner.length > 0, 'the gate must have a success banner');
    assert(!/same MEDIA_SERVER_BUDGETS/.test(banner),
      'the banner must not say the required ceilings are the media-server gates\' looser multipliers');
    assert(/PROJECTION_PHASE_1_BUDGETS|acceptance plan's own/.test(banner),
      'it must name the acceptance plan\'s own ceilings as the required ones');
    assert(/block geometry|block-geometry/.test(banner),
      'and say the stricter per-object model is asserted IN ADDITION');
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

  await test('every PROSE copy of the hold chain agrees with the constants', () => {
    // THE DEFECT THIS CLOSES. The chain was written out in three places -- the gate document, the gate
    // script's header, and the core module -- and when the arm window moved from 4,000ms to 3,000ms two of
    // them kept the old number in the PRESENT TENSE, beside a table that already said 3 s. A reader has no
    // way to tell which sentence is the stale one, and the numbers are exactly what an operator would quote.
    //
    // So the current-tense copies are checked against the constants rather than against each other, and
    // "current-tense" is decided by `currentTenseLines` rather than asserted in a comment -- see
    // RETROSPECTIVE_MARKERS. §3.4 and the run records exist to say what was wrong, and rewriting them would
    // erase the history this repository keeps on purpose, so a line that declares itself historical passes.
    const doc = readRepoFile('docs/PROJECTION_PHASE_1_THREE_SERVER_CONCURRENCY.md');
    // THE SOURCE MODULES ARE IN SCOPE TOO. They carry the same chain in prose, and a stale copy there is no
    // more true for being in a comment -- the retired four-second arm survived in `three-server-concurrency.ts`
    // precisely because this list stopped at the document and the shell script.
    const currentTense: ReadonlyArray<readonly [string, string]> = [
      ['the gate document', doc],
      ['the gate script header', GATE],
      ['the core module', CORE],
      ['the driver', DRIVER],
    ];
    const retiredArm = /arm 4,000|arm 4000/;
    for (const [where, text] of currentTense) {
      const stale = currentTenseLines(text, retiredArm);
      assertEq(stale.length, 0,
        `${where} states the retired 4,000ms arm window in the present tense: ${stale[0]?.trim() ?? ''}`);
      // The POSITIVE half applies only where the chain is spelled out in full. The driver explains the
      // clocks and defers the numbers to the core module, and demanding it repeat them would be demanding a
      // fifth copy of the thing this check exists to keep in sync.
      if (where === 'the driver') continue;
      assert(text.includes(`${HOLD_ARM_MS.toLocaleString('en-US')}`)
        || text.includes(String(HOLD_ARM_MS)),
        `${where} must state the arm window that is actually configured (${HOLD_ARM_MS}ms)`);
      assert(text.includes(`${HOLD_MAX_MS.toLocaleString('en-US')}`)
        || text.includes(String(HOLD_MAX_MS)),
        `${where} must state the backstop that is actually configured (${HOLD_MAX_MS}ms)`);
    }
    // ...and the relation the prose claims is the one the code enforces.
    assert(HOLD_ARM_MS + BARRIER_RELEASE_OVERSHOOT_MS <= HOLD_MAX_MS,
      'the chain the prose states must be the chain assertHoldChainIsFailClosed enforces');
  });

  await test('no current-tense prose restates the arm window in WORDS at its retired value', () => {
    // `arm 4,000` was caught; "Four seconds is not long enough" was not, and it sat in the core module and
    // the document saying the same retired number in English. A check that only recognises the digits is a
    // check somebody can walk straight past.
    const doc = readRepoFile('docs/PROJECTION_PHASE_1_THREE_SERVER_CONCURRENCY.md');
    const retiredInWords = /\bfour seconds\b/i;
    for (const [where, text] of [['the gate document', doc], ['the core module', CORE],
      ['the gate script header', GATE]] as const) {
      const stale = currentTenseLines(text, retiredInWords);
      assertEq(stale.length, 0,
        `${where} states the retired four-second arm window in words: ${stale[0]?.trim() ?? ''}`);
    }
  });

  await test('no current-tense prose times the ARM WINDOW from actual block time', () => {
    // The companion to the release-timing check: the same wrong clock, one step earlier in the sentence.
    const doc = readRepoFile('docs/PROJECTION_PHASE_1_THREE_SERVER_CONCURRENCY.md');
    // A TEMPERED MATCH, because the CORRECT sentences also contain both clocks. "The arm window is timed
    // from when this gate NOTICES a block while the backstop is timed from when the request actually blocks"
    // is exactly right, and a naive span would flag it. So the match stops at any observation or backstop
    // word: it fires only where the arm clock is tied to the block with nothing standing between them.
    const wrongClock =
      /(arm (clock|window)|blocking clock)\s+(starts|is timed)(?:(?!notic|observ|watchdog|backstop)[^.])*?\brequest\s+(first\s+)?(actually\s+)?blocks?\b/i;
    for (const [where, text] of [['the gate document', doc], ['the core module', CORE],
      ['the driver', DRIVER], ['the gate script header', GATE], ['the focused suite', readRepoFile('test/projection-three-server-concurrency.ts')]] as const) {
      const stale = currentTenseLines(text, wrongClock);
      assertEq(stale.length, 0,
        `${where} times the arm window from when a request blocks, which is the BACKSTOP's clock: `
        + `${stale[0]?.trim() ?? ''}`);
    }
  });

  await test('the scoping those checks CLAIM is the scoping they DO', () => {
    // The previous version asserted over the whole file while its comment promised that historical text was
    // out of scope. It passed by luck. This drives the helper directly, so the promise is a behaviour.
    const historical = 'It used to be `arm 4,000 ms`, and an earlier version said so.';
    const present = 'The chain is `arm 4,000 ms < backstop 4,500 ms`.';
    const retiredArm = /arm 4,000|arm 4000/;
    assertEq(currentTenseLines(historical, retiredArm).length, 0,
      'a line that declares itself historical must be permitted, or the checks pressure somebody into '
      + 'deleting the record of a defect');
    assertEq(currentTenseLines(present, retiredArm).length, 1,
      'and a line that states it in the present tense must be caught');
    assertEq(currentTenseLines(`${historical}\n${present}`, retiredArm).length, 1,
      'and the two must be separated line by line rather than judged as one blob');
  });

  await test('no current-tense prose times the RELEASE from when a request actually blocks', () => {
    // THE DEFECT THIS CLOSES. The gate header said "the driver releases three seconds after a request
    // actually blocks" two lines below a paragraph explaining that the arm window is timed from when the
    // driver NOTICES a block and the backstop from when it actually blocks. Both cannot be true, and the
    // live evidence agrees with the paragraph: the arm window is 3,000ms and the measured block was 3.1s.
    const doc = readRepoFile('docs/PROJECTION_PHASE_1_THREE_SERVER_CONCURRENCY.md');
    const releaseTiming = /releases?\s+\w+\s+seconds?\s+after[^.]*actually\s+block/i;
    for (const [where, text] of [['the gate document', doc], ['the gate script header', GATE]] as const) {
      const offending = currentTenseLines(text, releaseTiming);
      assertEq(offending.length, 0,
        `${where} times the release from the moment a request ACTUALLY blocks, which is the BACKSTOP's `
        + `clock, not the arm window's: ${offending[0]?.trim() ?? ''}`);
    }
    // ...and the corrected claim is present, naming the clock the arm window actually uses.
    assert(/three seconds after the WATCHDOG NOTICES|after the watchdog notices/i.test(GATE),
      'the gate header must say the release is timed from when the watchdog NOTICES the blocked request');
    assert(/3\.1\s*s/.test(GATE),
      'and record the measured actual block, which is longer than the arm window by the watchdog lag');
  });

  await test('every PROSE copy of the gap ceiling states the derivation actually in force', () => {
    // The bullet describing the CURRENT rule said the ceiling is "one tick sleep plus the widest a tick may
    // be and still describe one instant" -- which is the retired 2.5 s formula, stated in the present tense
    // two paragraphs after the correct 1 s value.
    const doc = readRepoFile('docs/PROJECTION_PHASE_1_THREE_SERVER_CONCURRENCY.md');
    const retiredFormula = currentTenseLines(doc, /gap ceiling is derived — one tick sleep/);
    assertEq(retiredFormula.length, 0,
      'the document derives the gap ceiling from the retired SAMPLE_INTERVAL + SAMPLE_MAX_SPAN formula in '
      + `the present tense: ${retiredFormula[0]?.trim() ?? ''}`);
    assert(/2 × SAMPLE_INTERVAL|twice the\s+nominal tick|twice the nominal tick/.test(doc),
      'it must state the derivation in force: twice the nominal tick');
    assert(/credited at most one nominal tick/.test(doc),
      'and the credited-duration rule, which is the half a gap ceiling alone does not give');
    assertEq(CONCURRENCY_DEADLINES_MS.MAX_CONTINUOUS_GAP,
      CONCURRENCY_DEADLINES_MS.SAMPLE_INTERVAL * 2, 'and the constant must match the prose');
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
  console.log('\nEXECUTABLE: the CLI itself, run as a process, against crafted inputs');
  // --------------------------------------------------------------------------------------------------------

  const cliDir = mkdtempSync(join(tmpdir(), 'projection-three-cli-'));
  const runCli = (argv: readonly string[]): { status: number; stdout: string; stderr: string } => {
    const result = spawnSync('npx', ['tsx', join(repoRoot, 'src/ops/projection-three-server-concurrency-cli.ts'),
      ...argv], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };

  await test('EXECUTABLE: a results file containing a SKIP cannot exit zero or announce a pass', async () => {
    // THE DEFECT THIS CLOSES. `report` counted skips, printed the count, and then moved the exit status on
    // `fail` alone. A run with `0 failed, 7 skipped` exited 0 and the gate script printed the whole PASSED
    // banner underneath it. That is the skip-versus-pass mistake this gate is careful about at the PROCESS
    // level -- 77 is not 0 -- reappearing one level down, at the assertion level, unguarded.
    const path = join(cliDir, 'results-with-skip.json');
    writeFileSync(path, `${JSON.stringify([
      { gate: 'TS1-something', verdict: 'pass', measured: 1, budget: 1 },
      { gate: 'TS3-something-else', verdict: 'skip', note: 'declined to judge itself' },
    ], null, 2)}\n`);
    const result = runCli(['report', '--results', path]);
    assert(result.status !== 0,
      `a report over a skipped assertion must not exit zero (exited ${result.status})`);
    assert(/SKIPPED/.test(result.stderr),
      `and must say why: ${result.stderr.slice(0, 300)}`);
    assert(!/\bPASSED\b/.test(result.stdout), 'and must not announce a pass');
  });

  await test('EXECUTABLE: an all-pass results file still exits zero', async () => {
    const path = join(cliDir, 'results-clean.json');
    writeFileSync(path, `${JSON.stringify([
      { gate: 'TS1-something', verdict: 'pass', measured: 1, budget: 1 },
    ], null, 2)}\n`);
    assertEq(runCli(['report', '--results', path]).status, 0, 'a clean report must still pass');
  });

  await test('EXECUTABLE: traffic between the 1.2x and 6x multipliers FAILS G14a', async () => {
    // 200 ranged GETs over 43 remote entries: comfortably inside the old 258 ceiling and well outside the
    // acceptance plan's 155. If the canonical ceiling had not replaced the media-server one, this passes.
    // Ordinal 0 is the READINESS CANARY and takes no traffic in the window, exactly as the real gate
    // requires: bytes served for it would fail `bytes-outside-the-corpus` before G14a was ever reached.
    const objects = [{ size: 262_144, small: 0, chunk: 0, partial: 0, oversized: 0 }];
    for (let index = 0; index < 43; index += 1) {
      objects.push({ size: 262_144, small: 1, chunk: 0, partial: 0, oversized: 0 });
    }
    const before = zeroLike(counters(objects));
    const after = counters(objects);
    const inflated: ProviderCounters = {
      ...after,
      rangeRequests: 200,
      resolutions: 43,
    };
    const beforePath = join(cliDir, 'g14a-before.json');
    const afterPath = join(cliDir, 'g14a-after.json');
    writeFileSync(beforePath, `${JSON.stringify(before, null, 2)}\n`);
    writeFileSync(afterPath, `${JSON.stringify(inflated, null, 2)}\n`);
    assert(200 < Math.ceil(43 * MEDIA_SERVER_BUDGETS.MAX_SCAN_RANGE_MULTIPLIER),
      'the fixture must sit INSIDE the old looser ceiling, or it proves nothing about the change');
    assert(200 > canonicalRangeRequestCeiling(43), 'and outside the acceptance plan\'s');
    const result = runCli(['window', '--before', beforePath, '--after', afterPath, '--gate', 'TSX',
      '--objects', String(objects.length), '--non-corpus-objects', '1', '--remote-entries', '43',
      '--large-bytes', '0', '--small-bytes', String(43 * 262_144),
      '--probe-cache-before', '0', '--probe-cache-after', '5000000']);
    assert(result.status !== 0, `G14a must fail at 200 ranged GETs (exited ${result.status})`);
    assert(/G14a-range-requests/.test(result.stdout + result.stderr),
      `and G14a must be the assertion that failed: ${(result.stdout + result.stderr).slice(-400)}`);
  });

  await test('EXECUTABLE: resolutions between the 1.2x and 6x multipliers FAIL G14b', async () => {
    // Ordinal 0 is the READINESS CANARY and takes no traffic in the window, exactly as the real gate
    // requires: bytes served for it would fail `bytes-outside-the-corpus` before G14a was ever reached.
    const objects = [{ size: 262_144, small: 0, chunk: 0, partial: 0, oversized: 0 }];
    for (let index = 0; index < 43; index += 1) {
      objects.push({ size: 262_144, small: 1, chunk: 0, partial: 0, oversized: 0 });
    }
    const before = zeroLike(counters(objects));
    const after = counters(objects);
    const inflated: ProviderCounters = { ...after, rangeRequests: 47, resolutions: 120 };
    const beforePath = join(cliDir, 'g14b-before.json');
    const afterPath = join(cliDir, 'g14b-after.json');
    writeFileSync(beforePath, `${JSON.stringify(before, null, 2)}\n`);
    writeFileSync(afterPath, `${JSON.stringify(inflated, null, 2)}\n`);
    assert(120 < Math.ceil(43 * MEDIA_SERVER_BUDGETS.MAX_SCAN_RESOLUTION_MULTIPLIER)
      && 120 > canonicalResolutionCeiling(43),
      'the fixture must sit between the two ceilings');
    const result = runCli(['window', '--before', beforePath, '--after', afterPath, '--gate', 'TSX',
      '--objects', String(objects.length), '--non-corpus-objects', '1', '--remote-entries', '43',
      '--large-bytes', '0', '--small-bytes', String(43 * 262_144),
      '--probe-cache-before', '0', '--probe-cache-after', '5000000']);
    assert(result.status !== 0, `G14b must fail at 120 resolutions (exited ${result.status})`);
    assert(/G14b-resolutions/.test(result.stdout + result.stderr),
      `and G14b must be the assertion that failed: ${(result.stdout + result.stderr).slice(-400)}`);
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
