import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  G22_WORDING_FILES, deliveryOverstatements, readForWordingScan,
} from './projection-delivery-wording.js';
import { findRedactionProblems, type GateResult } from '../src/core/projection/media-server-dataplane.js';
import {
  BARRIER_RELEASE_OVERSHOOT_MS, CONCURRENCY_RULES, HOLD_ARM_MS, HOLD_MAX_MS, REQUIRED_SERVER_COUNT,
  analyseOverlap, overlapProblems, type OverlapSample,
} from '../src/core/projection/three-server-concurrency.js';
import {
  COMMITTED_BYTES_ARE_NOT_DELIVERED_BYTES,
  COMPARISON_CORPUS, COMPARISON_CORPUS_ENTRIES, COMPARISON_HAS_NO_PASS_THRESHOLD, COMPARISON_HOLD_ARM_MS,
  COMPARISON_HOLD_MAX_MS, COMPARISON_SERVER_COUNT, PRODUCT_REMOTE_ENTRIES,
  PER_SERVER_ATTRIBUTION_IS_IMPOSSIBLE_HERE, RCLONE_COMPARISON_NONCLAIMS, RCLONE_COMPARISON_TOPOLOGY,
  RCLONE_IS_A_TEST_CONTROL_NOT_A_CANDIDATE_FRONTEND, RCLONE_TIMEOUTS_MS,
  RESOLUTION_CALLS_DO_NOT_EXIST_ON_THIS_TOPOLOGY, WEBDAV_COUNTER_ARRAY_KEYS, WEBDAV_COUNTER_KEYS_REQUIRED,
  WEBDAV_GAUGE_KEYS, WEBDAV_SERVER_TRAFFIC_IS_NOT_CLIENT_BEHAVIOUR,
  clientStatsProblems, comparisonColdStateProblems, comparisonMeasurements, parseClientStats,
  parseWebdavCounters, webdavAttributionProblems,
  type WebdavCounters,
} from '../src/core/projection/rclone-comparison.js';
import { runConcurrentScans, type ServerAdapter } from '../src/ops/projection-rclone-comparison.js';

// Projection Phase 1 — the offline half of the RCLONE/WEBDAV COMPARISON CONTROL (G22).
//
// WHAT THIS SUITE IS FOR. The gate needs Docker, /dev/fuse, a digest-pinned rclone and THREE real media
// servers, and it takes the better part of an hour. This suite runs everywhere, in seconds, and holds the
// rules the gate depends on.
//
// EVERY TEST HERE IS AN ADVERSARY RATHER THAN A DESCRIPTION, and the adversary is a peculiar one, because
// G22 HAS NO PASS THRESHOLD. Nothing downstream will ever fail because a cost figure was wrong — so the
// question each test asks is not "did the naive path behave" but "what is the cheapest way to make this gate
// publish a comparison it did not earn, and does something refuse it?" The list of cheats is the
// specification:
//
//   a WARM client cache, so the scan reaches the endpoint barely at all and the naive path looks cheap
//   an ALREADY-POPULATED VFS cache directory inherited from a previous run
//   a corpus that was never revealed, so "nothing was served" describes an empty library
//   three SEQUENTIAL scans reported as concurrent
//   one server absent, or reading a different mount
//   a DIFFERENT corpus on the two sides of the comparison
//   a mount that is really local passthrough, so no traffic crosses the wire at all
//   provider traffic that nothing attributed, or a counter that reset
//   telemetry missing a key and read as zero
//   a SKIP or a FAILURE swallowed by a wrapper
//   an image pinned by tag rather than by digest
//   a credential or an absolute path in the report
//   a THRESHOLD attached to a comparative figure, which would turn a control into a competitor
//   wording that turns a measurement into an architectural recommendation, or a Docker Desktop run into
//     G22, Linux, Unraid or Phase 1 closure

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

const TEST_DEADLINE_MS = 60_000;

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
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

/**
 * Collapse a source file's whitespace so a prose assertion is about the SENTENCE rather than about where a
 * line happened to wrap. A check that broke every time a paragraph was reflowed would be deleted within a
 * month, and the rule it was holding would go with it.
 */
const flat = (source: string): string => source.replace(/[\s*]+/g, ' ');

const GATE = read('deploy/projection-rclone-comparison-gate.sh');
const THREE_RUN = read('deploy/projection-rclone-comparison-gate-three.sh');
const OPTIONAL = read('deploy/projection-rclone-comparison-gate-optional.sh');
const PRODUCT_GATE = read('deploy/projection-three-server-concurrency-gate.sh');
const CORE = read('src/core/projection/rclone-comparison.ts');
const CLI = read('src/ops/projection-rclone-comparison-cli.ts');
const DRIVER = read('src/ops/projection-rclone-comparison.ts');
const ENDPOINT = read('projectiond/internal/fakewebdav/fakewebdav.go');
const DOC = read('docs/PROJECTION_PHASE_1_RCLONE_COMPARISON.md');
const PLAN = read('docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md');

/**
 * A COUNTERS DOCUMENT, BUILT THE WAY THE ENDPOINT BUILDS ONE — every partition balanced.
 *
 * Building it rather than hand-writing one is what lets a test say "and now break exactly this", instead of
 * hand-writing thirty near-identical objects whose OTHER fields drift and make a refusal ambiguous.
 */
interface ObjectFixture {
  size: number;
  /** What the responses for this object PROMISED. */
  committed: number;
  /** What the write calls for it RETURNED. Defaults to `committed` — a fully consumed read. */
  observed?: number;
  ranged: number;
  full: number;
}

function counters(objects: readonly ObjectFixture[],
  overrides: Partial<WebdavCounters> = {}): WebdavCounters {
  const observedOf = (object: ObjectFixture): number => object.observed ?? object.committed;
  const rangedBodies = objects.reduce((total, object) => total + object.ranged, 0);
  const fullBodies = objects.reduce((total, object) => total + object.full, 0);
  const committedBytes = objects.reduce((total, object) => total + object.committed, 0);
  const observedBytes = objects.reduce((total, object) => total + observedOf(object), 0);
  // The byte split between ranged and full is not derivable from the per-object columns, so the fixture puts
  // every byte in the ranged bucket unless a test says otherwise. That keeps both partitions exact.
  return {
    requests: rangedBodies + fullBodies,
    accountedResponses: rangedBodies + fullBodies,
    propfind: 0, propfindDepth0: 0, propfindDepth1: 0, propfindOther: 0,
    options: 0, head: 0, gets: rangedBodies + fullBodies, writeAttempts: 0,
    rangedBodies, fullBodies, bodylessResponses: 0,
    rangedCommittedBytes: committedBytes, fullCommittedBytes: 0, committedBytes,
    rangedObservedBytes: observedBytes, fullObservedBytes: 0, observedBytes,
    // Every body is treated as completed unless a fixture makes observed differ from committed.
    completedBodies: objects.reduce(
      (total, object) => total + (observedOf(object) === object.committed ? object.ranged + object.full : 0), 0),
    truncatedBodies: objects.reduce(
      (total, object) => total + (observedOf(object) === object.committed ? 0 : object.ranged + object.full), 0),
    bodiesInFlight: 0,
    metadataBytes: 0, served429: 0,
    peakConns: 4, peakConcurrent: 3,
    heldRequests: 1, currentHeldWaiters: 0, holdTimeouts: 0,
    revealed: true,
    objectSizes: objects.map((object) => object.size),
    objectCommitted: objects.map((object) => object.committed),
    objectObserved: objects.map((object) => observedOf(object)),
    objectGets: objects.map((object) => object.ranged + object.full),
    objectRanged: objects.map((object) => object.ranged),
    objectFull: objects.map((object) => object.full),
    ...overrides,
  };
}

function zeroLike(snapshot: WebdavCounters, overrides: Partial<WebdavCounters> = {}): WebdavCounters {
  return {
    ...snapshot,
    requests: 0, accountedResponses: 0,
    propfind: 0, propfindDepth0: 0, propfindDepth1: 0, propfindOther: 0,
    options: 0, head: 0, gets: 0, writeAttempts: 0,
    rangedBodies: 0, fullBodies: 0, bodylessResponses: 0,
    rangedCommittedBytes: 0, fullCommittedBytes: 0, committedBytes: 0,
    rangedObservedBytes: 0, fullObservedBytes: 0, observedBytes: 0,
    completedBodies: 0, truncatedBodies: 0, bodiesInFlight: 0,
    metadataBytes: 0, served429: 0,
    peakConns: 0, peakConcurrent: 0,
    heldRequests: 0, currentHeldWaiters: 0, holdTimeouts: 0,
    objectCommitted: snapshot.objectSizes.map(() => 0),
    objectObserved: snapshot.objectSizes.map(() => 0),
    objectGets: snapshot.objectSizes.map(() => 0),
    objectRanged: snapshot.objectSizes.map(() => 0),
    objectFull: snapshot.objectSizes.map(() => 0),
    ...overrides,
  };
}

/** The 51-object registration the real gate produces: canary, seed, barrier, then forty-eight. */
function realShapedObjects(): ObjectFixture[] {
  const out: ObjectFixture[] = [
    { size: 262_144, committed: 0, ranged: 0, full: 0 },      // 0 the canary, never touched in a window
    { size: 33_000, committed: 0, ranged: 0, full: 0 },       // 1 the seed, read before the window opened
    { size: 105_406_871, committed: 42_000_000, ranged: 3, full: 0 }, // 2 the barrier fixture
  ];
  for (let index = 0; index < COMPARISON_CORPUS.GENERATED_ENTRIES; index += 1) {
    out.push({ size: 40_000, committed: 120_000, ranged: 3, full: 0 });
  }
  return out;
}

/** Every corpus ordinal, i.e. everything at or after the boundary. */
const FIRST_CORPUS_ORDINAL = 2;

async function main(): Promise<void> {
  // --------------------------------------------------------------------------------------------------------
  console.log('\nWHAT G22 IS: a control with no threshold, and the difference is enforced');
  // --------------------------------------------------------------------------------------------------------

  await test('the acceptance plan still says G22 is evidence with no pass threshold', () => {
    // IF THE PLAN EVER SAYS SOMETHING ELSE, EVERY DESIGN DECISION IN THIS TRANCHE IS WRONG. The gate is
    // shaped around "no pass threshold"; a plan that acquired one would make a gate that records instead of
    // asserting into a gate that quietly does not check its own subject.
    assert(/G22 \| \*\*Comparison control\*\*/.test(PLAN), 'the plan still names G22');
    assert(PLAN.includes('It has no pass threshold.'), 'and still says it has no pass threshold');
    assert(PLAN.includes('**evidence, not architecture**'), 'and still says evidence, not architecture');
    assertEq(COMPARISON_HAS_NO_PASS_THRESHOLD, true, 'and the code says the same as a value');
  });

  await test('ADR 002 still rejects this topology, and the gate says so before it measures anything', () => {
    // A CONTROL THAT READ AS A CANDIDATE WOULD BE THE MOST EXPENSIVE MISTAKE THIS TRANCHE COULD MAKE. The
    // number this gate produces is the kind somebody quotes; if the surrounding text is ambiguous about
    // whether it is a recommendation, the quote arrives without the text.
    const adr = flat(read('docs/ADR_002_PROJECTION_APPLIANCE.md'));
    assert(adr.includes('Rejected as production architecture'), 'ADR 002 still rejects it');
    assert(adr.includes('A test control is not an architecture'), 'and still says a control is not one');
    assert(GATE.includes('THIS IS A CONTROL, NOT A CANDIDATE'),
      'the gate says so in its own header, before anything it measures');
    assertEq(RCLONE_IS_A_TEST_CONTROL_NOT_A_CANDIDATE_FRONTEND, true, 'and the code says it as a value');
  });

  await test('THE CHEAT: a threshold attached to a comparative figure', () => {
    // `GateResult` documents `measured` and `budget` as travelling together, so a figure emitted with a bare
    // `note` cannot acquire a ceiling by accident. What could happen by accident is somebody reaching for
    // `withinBudget` in the measurement command — which is what this refuses.
    const measureBlock = CLI.split("case 'measure': {")[1]?.split("case 'nonclaims'")[0] ?? '';
    assert(measureBlock.length > 500, 'the measurement command was found');
    assert(!measureBlock.includes('withinBudget('),
      'a comparative figure must not be compared against a ceiling: G22 has no pass threshold, and a control '
      + 'with a budget is a competitor');
    // What IS asserted there is arithmetic and coverage, not cost.
    assert(measureBlock.includes('bytes-fully-attributed'),
      'the one thing still asserted is that the figures add up');
    assert(measureBlock.includes('objects-exercised'),
      'and that the window actually reached every object, since a ceiling is satisfied by zero');
    assert(!CORE.includes('MAX_') || !/MAX_[A-Z_]*(BYTE|REQUEST|GET)/.test(CORE),
      'the core module defines no cost ceiling of its own');
  });

  await test('THE CHEAT: reporting "0 resolutions" as though it were an efficiency', () => {
    // THIS TOPOLOGY HAS NO RESOLUTION STEP BECAUSE ITS NAMESPACE IS ITS URL SPACE — which is the property
    // ADR 002 rejected it for. A zero in that column would read as the naive path winning one.
    assertEq(RESOLUTION_CALLS_DO_NOT_EXIST_ON_THIS_TOPOLOGY, true, 'the code states it');
    assert(CLI.includes('ABSENT rather than zero'), 'and the report says ABSENT rather than printing a zero');
    assert(!/resolutions?['"\s]*[:=]\s*0/.test(CLI), 'and no zero resolution figure is produced');
    assert(RCLONE_COMPARISON_NONCLAIMS.some((claim) => claim.includes('no resolution step')),
      'and it is one of the nonclaims the gate prints on every run');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: a WARM window, in any of the four ways it can be warm');
  // --------------------------------------------------------------------------------------------------------

  const coldInput = {
    revealedBefore: true,
    corpusCommittedBytesBefore: 0,
    corpusObservedBytesBefore: 0,
    clientCacheBytesBefore: 0,
    getDelta: 60,
    corpusObjectCount: 49,
    heldRequestDelta: 1,
    holdTimeoutDelta: 0,
  };

  await test('a genuinely cold window has no problems', () => {
    assertEq(comparisonColdStateProblems(coldInput).length, 0, 'the happy path must pass');
  });

  await test('THE CHEAT: the corpus had already been served bytes before the window', () => {
    const problems = comparisonColdStateProblems({ ...coldInput, corpusCommittedBytesBefore: 1 });
    assert(problems.some((problem) => problem.kind === 'corpus-already-read'),
      'a window that is not the corpus first read does not describe what a cold scan costs');
  });

  await test('THE CHEAT: an inherited, already-populated client cache directory', () => {
    // THE ONE THIS TOPOLOGY IS MOST EXPOSED TO. A populated VFS cache answers reads without reaching the
    // endpoint at all, so the naive path would be reported as costing a fraction of what it costs — a far
    // worse failure for a CONTROL than any expensive number could be.
    const problems = comparisonColdStateProblems({ ...coldInput, clientCacheBytesBefore: 4096 });
    assert(problems.some((problem) => problem.kind === 'client-cache-not-empty'),
      'a populated cache directory must be refused');
  });

  await test('THE CHEAT: a window over a corpus that was never revealed', () => {
    // WITHOUT THIS, "no corpus byte was served beforehand" is satisfied perfectly by a run in which the
    // corpus was never there. A scan of an empty library is cheap, correct and worthless.
    const problems = comparisonColdStateProblems({ ...coldInput, revealedBefore: false });
    assert(problems.some((problem) => problem.kind === 'corpus-not-revealed'),
      'an unrevealed corpus makes "nothing was served" meaningless');
  });

  await test('THE CHEAT: a window that reached the endpoint fewer times than there are objects', () => {
    const problems = comparisonColdStateProblems({ ...coldInput, getDelta: 48 });
    assert(problems.some((problem) => problem.kind === 'no-cold-traffic'),
      'a window that did not reach every object was answering from a cache');
  });

  await test('THE CHEAT: a rendezvous that never blocked anything, or one that lapsed', () => {
    assert(comparisonColdStateProblems({ ...coldInput, heldRequestDelta: 0 })
      .some((problem) => problem.kind === 'barrier-never-hit'),
    'a barrier nothing reached did nothing');
    assert(comparisonColdStateProblems({ ...coldInput, holdTimeoutDelta: 1 })
      .some((problem) => problem.kind === 'hold-lapsed'),
    'a lapsed hold degraded a read rather than pausing one, and every figure over that window is about the '
    + 'instrument');
  });

  await test('the gate takes its cold evidence on BOTH sides of the wire, before the window', () => {
    const beforeWindow = GATE.split('THREE REAL LIBRARY SCANS')[0] ?? '';
    assert(beforeWindow.includes('CACHE_BEFORE="$(cache_bytes)"'),
      'the client cache is measured before the scans');
    assert(beforeWindow.includes('counters-before.json'), 'and so are the endpoint counters');
    assert(beforeWindow.indexOf('plain reveal') < beforeWindow.indexOf('CACHE_BEFORE'),
      'and the reveal happens before both, so the snapshot describes a revealed corpus');
    assert(GATE.includes('--client-cache-before'), 'and the cold check is given the measured value');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: three SEQUENTIAL scans, or a missing server, presented as the same window');
  // --------------------------------------------------------------------------------------------------------

  const sequentialTimeline = (): OverlapSample[] => {
    const out: OverlapSample[] = [];
    const ids = ['emby', 'jellyfin', 'plex'];
    let at = 0;
    for (const scanning of ids) {
      for (let tick = 0; tick < 10; tick += 1) {
        out.push({
          atMs: at, spanMs: 5,
          inFlight: Object.fromEntries(ids.map((id) => [id, id === scanning])),
          unreadable: [],
        });
        at += 500;
      }
    }
    return out;
  };

  await test('THE CHEAT: three strictly sequential scans produce zero simultaneous samples', () => {
    const analysis = analyseOverlap(sequentialTimeline());
    assertEq(analysis.simultaneousSamples, 0, 'sequential scans never overlap, by construction');
    assertEq(analysis.maxServersInFlight, 1, 'and only one server is ever in flight');
    assert(overlapProblems(analysis).length > 0, 'and the analysis refuses them');
  });

  await test('THE CHEAT: one server absent, with the other two genuinely overlapping', () => {
    const ids = ['emby', 'jellyfin', 'plex'];
    const timeline: OverlapSample[] = [];
    for (let tick = 0; tick < 20; tick += 1) {
      timeline.push({
        atMs: tick * 500, spanMs: 5,
        inFlight: { emby: true, jellyfin: true, plex: false },
        unreadable: [],
      });
    }
    const analysis = analyseOverlap(timeline, ids);
    assertEq(analysis.simultaneousSamples, 0, 'two of three is not three');
    const problems = overlapProblems(analysis);
    assert(problems.some((problem) => problem.includes('never seen: plex')),
      `and the failure names the absent server: ${problems.join(' | ')}`);
  });

  await test('the comparison uses the PRODUCT gate\'s own observer, analysis and floors', () => {
    // "MEASURED THE SAME WAY" IS ONLY TRUE IF IT IS THE SAME MEASUREMENT. Two observers would make the
    // comparison include the difference between two observers, which nobody would be able to subtract out.
    assert(DRIVER.includes("from './projection-three-server-concurrency.js'"),
      'the driver composes the product gate\'s own driver rather than reimplementing it');
    assert(DRIVER.includes('export {') && DRIVER.includes('runConcurrentScans'),
      'and re-exports the same scan function');
    assert(!DRIVER.includes('async function runConcurrentScans'),
      'and does not define a second one');
    assert(CLI.includes("from '../src/core/projection/three-server-concurrency.js'")
      || CLI.includes("from '../core/projection/three-server-concurrency.js'"),
    'and the CLI takes its overlap analysis from the same module');
    assert(CLI.includes('CONCURRENCY_RULES.MIN_SIMULTANEOUS_SAMPLES')
      && CLI.includes('CONCURRENCY_RULES.MIN_SIMULTANEOUS_SPAN_SECONDS'),
    'and holds the same floors rather than softer ones');
    assertEq(COMPARISON_SERVER_COUNT, REQUIRED_SERVER_COUNT, 'and agrees about how many servers "three" is');
  });

  await test('EXECUTABLE: the scan driver refuses to report an overlap it did not observe', async () => {
    // A LIVE TIMELINE RATHER THAN A SCRIPTED ONE: three fake adapters that scan strictly one after another,
    // driven through the real function, on an injected clock.
    let clock = 0;
    const now = (): number => clock;
    const finish = new Map<string, number>([['emby', 3_000], ['jellyfin', 6_000], ['plex', 9_000]]);
    const adapters: ServerAdapter[] = ['emby', 'jellyfin', 'plex'].map((id) => ({
      id: id as never,
      readState: () => ({}),
      scanIsRunningNow: async () => {
        const ends = finish.get(id) as number;
        return clock < ends && clock >= ends - 3_000;
      },
      scanLibrary: async () => {
        // Each scan "completes" when the shared clock reaches its slot; the observer advances the clock.
        while (clock < (finish.get(id) as number)) await new Promise((resolve) => { setTimeout(resolve, 1); });
        return { observedInFlight: true };
      },
      catalogue: async () => [],
    }));
    const ticker = setInterval(() => { clock += 250; }, 1);
    try {
      const outcome = await runConcurrentScans({
        adapters,
        states: new Map(adapters.map((adapter) => [adapter.id, {}])),
        sampleIntervalMs: 1,
        deadlineMs: 30_000,
        now,
      });
      const analysis = analyseOverlap(outcome.timeline as OverlapSample[]);
      assertEq(analysis.simultaneousSamples, 0,
        'three scans that never coexisted must produce zero simultaneous samples through the REAL driver');
      assert(overlapProblems(analysis).length > 0, 'and the analysis must refuse them');
    } finally {
      clearInterval(ticker);
    }
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: a different corpus on the two sides of the comparison');
  // --------------------------------------------------------------------------------------------------------

  await test('both gates generate the corpus from CHARACTER-FOR-CHARACTER the same generator', () => {
    // EQUAL COUNTS OF DIFFERENTLY GENERATED FILES WOULD NOT BE THE SAME CORPUS. The cost of identifying a
    // library depends on the bytes in it, so two libraries generated from different signals differ in exactly
    // the way that makes the comparison meaningless — and nothing downstream would notice.
    const extract = (source: string, marker: string): string => {
      const start = source.indexOf(marker);
      assert(start > 0, `the ${marker} block was found`);
      const end = source.indexOf(marker, start + marker.length);
      assert(end > start, `the ${marker} block terminates`);
      return source.slice(start + marker.length, end).replace(/\r\n/g, '\n');
    };
    assertEq(extract(GATE, 'GENCORPUS'), extract(PRODUCT_GATE, 'GENCORPUS'),
      'the forty-eight-item generator body must be identical in both gates');

    // ...and the two singular fixtures, which live outside that block.
    //
    // THE OUTPUT PATH IS EXCLUDED AND NOTHING ELSE IS. The two gates write these fixtures into different
    // directories — the product's namespace comes from a manifest and this one's from a WebDAV tree — and a
    // destination is not a property of the media. Every ENCODING parameter is compared, because those are
    // what decide the bytes, and the bytes are what the comparison is about.
    const ffmpegLines = (source: string, needle: string): string => {
      const at = source.indexOf(needle);
      assert(at > 0, `${needle} appears`);
      const region = source.slice(at, at + 700).replace(/\r\n/g, '\n');
      return region.split('\n')
        .filter((line) => line.includes('-f lavfi') || line.includes('-c:v') || line.includes('-c:a'))
        .map((line) => line.trim().replace(/"\/work\/\S[^"]*"/g, '<output>'))
        .join('\n');
    };
    assertEq(ffmpegLines(GATE, 'testsrc=size=128x96:rate=15:duration=3'),
      ffmpegLines(PRODUCT_GATE, 'testsrc=size=128x96:rate=15:duration=3'),
      'the seed fixture is generated identically');
    assertEq(ffmpegLines(GATE, 'testsrc2=size=640x480:rate=24:duration=105'),
      ffmpegLines(PRODUCT_GATE, 'testsrc2=size=640x480:rate=24:duration=105'),
      'and so is the large barrier fixture');
  });

  await test('the corpus counts match the product gate\'s, and the entry total is the plan\'s ~50', () => {
    assert(PRODUCT_GATE.includes('CORPUS_COUNT=48') && GATE.includes('CORPUS_COUNT=48'),
      'both gates generate forty-eight');
    assert(PRODUCT_GATE.includes('CORPUS_LOCAL=6') && GATE.includes('CORPUS_LOCAL=6'),
      'and both know which six the product publishes as local passthrough');
    assertEq(COMPARISON_CORPUS.GENERATED_ENTRIES, 48, 'the code agrees');
    assertEq(COMPARISON_CORPUS_ENTRIES, 50, 'and fifty identities are what a server is held against');
    assertEq(PRODUCT_REMOTE_ENTRIES, 43, 'and forty-three is the subset the product also fetches remotely');
    assert(CLI.includes('COMPARISON_CORPUS_ENTRIES'),
      'and the gate asserts the expectation document is that size rather than assuming it');
  });

  await test('the report rolls the figures up BOTH ways and says why', () => {
    // ALL FIFTY ARE REMOTE HERE AND ONLY FORTY-THREE ARE ON THE PRODUCT'S SIDE. A total-against-total
    // comparison would charge the naive path for seven files the product never fetches, which would be a
    // thumb on the scale in the direction this repository is least entitled to push.
    assert(CLI.includes('product-comparable-subset'), 'the sub-total is reported');
    assert(CLI.includes('total-against-total comparison'),
      'and the reason is stated in the report itself, not only in a document');
    assert(GATE.includes('PRODUCT_ORDINALS'), 'and the gate computes the subset by registration ordinal');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: telemetry that cannot support a figure');
  // --------------------------------------------------------------------------------------------------------

  await test('a well-formed counters document parses', () => {
    const snapshot = counters(realShapedObjects());
    const parsed = parseWebdavCounters(JSON.parse(JSON.stringify(snapshot)), 'test');
    assertEq(parsed.problems.length, 0, `a valid document must parse: ${JSON.stringify(parsed.problems)}`);
    assert(parsed.counters !== undefined, 'and produce counters');
  });

  await test('THE CHEAT: a missing counter read as zero', () => {
    for (const key of WEBDAV_COUNTER_KEYS_REQUIRED) {
      const document = JSON.parse(JSON.stringify(counters(realShapedObjects()))) as Record<string, unknown>;
      delete document[key];
      const parsed = parseWebdavCounters(document, 'test');
      assert(parsed.counters === undefined, `a document missing "${key}" must be refused`);
    }
  });

  await test('THE CHEAT: a per-object column with a fractional count', () => {
    // A FRACTIONAL COUNT COMPARES PERFECTLY WELL AGAINST ANYTHING, so it would flow through every roll-up and
    // appear in a published table as a fact.
    for (const key of WEBDAV_COUNTER_ARRAY_KEYS) {
      const document = JSON.parse(JSON.stringify(counters(realShapedObjects()))) as Record<string, unknown>;
      (document[key] as number[])[1] = 4.5;
      assert(parseWebdavCounters(document, 'test').counters === undefined,
        `a fractional "${key}" must be refused`);
    }
  });

  await test('THE CHEAT: a counters document that does not say whether the corpus was revealed', () => {
    const document = JSON.parse(JSON.stringify(counters(realShapedObjects()))) as Record<string, unknown>;
    delete document.revealed;
    assert(parseWebdavCounters(document, 'test').counters === undefined,
      'without it, "nothing was served" cannot be told from "there was nothing to serve"');
  });

  await test('THE CHEAT: a counter that reset inside the window', () => {
    const after = counters(realShapedObjects());
    const before = { ...zeroLike(after), gets: 5, requests: 5, accountedResponses: 5, rangedBodies: 5 };
    // The `before` above is deliberately AHEAD of the after on one counter, which is what a restart looks like.
    const problems = webdavAttributionProblems(
      { ...before, rangedBodies: after.rangedBodies + 1, accountedResponses: after.accountedResponses + 1 },
      after, after.objectSizes.length,
    );
    assert(problems.some((problem) => problem.kind === 'counter-reset'),
      'a negative delta is exactly how a topology under test comes out looking cheap');
  });

  await test('THE CHEAT: a per-object reset compensated by a rise somewhere else', () => {
    // EVERY AGGREGATE SURVIVES THIS. Drop one ordinal to zero and raise another by the same amount: the sums,
    // the partitions and the totals are all unchanged, and the dropped ordinal's window delta is NEGATIVE.
    const objects = realShapedObjects();
    const after = counters(objects);
    const before = zeroLike(after);
    const tamperedBefore: WebdavCounters = {
      ...before,
      objectCommitted: before.objectCommitted.map((value, index) => (index === 5 ? 500_000 : value)),
    };
    const problems = webdavAttributionProblems(tamperedBefore, after, after.objectSizes.length);
    assert(problems.some((problem) => problem.kind === 'per-object-counter-reset'
      || problem.kind === 'unattributed-committed-bytes'),
    'a per-object fall must be refused even though every aggregate is intact');
  });

  await test('THE CHEAT: a byte served for something the gate never registered', () => {
    const after = counters(realShapedObjects());
    const leaky: WebdavCounters = { ...after, committedBytes: after.committedBytes + 1_000,
      rangedCommittedBytes: after.rangedCommittedBytes + 1_000 };
    const problems = webdavAttributionProblems(zeroLike(after), leaky, after.objectSizes.length);
    assert(problems.some((problem) => problem.kind === 'unattributed-committed-bytes'),
      'unattributed traffic is the only way "every byte belongs to the corpus" fails invisibly');
  });

  await test('THE CHEAT: an object whose SIZE moved between two snapshots', () => {
    const after = counters(realShapedObjects());
    const before = zeroLike(after);
    const moved: WebdavCounters = {
      ...before,
      objectSizes: before.objectSizes.map((value, index) => (index === 3 ? value + 1 : value)),
    };
    const problems = webdavAttributionProblems(moved, after, after.objectSizes.length);
    assert(problems.some((problem) => problem.kind === 'object-identity-moved'),
      'a registration ordinal is the only handle these columns carry, so a size that moved renames it');
  });

  await test('THE CHEAT: per-object columns of different lengths', () => {
    const after = counters(realShapedObjects());
    const ragged: WebdavCounters = { ...after, objectGets: after.objectGets.slice(0, -1) };
    const problems = webdavAttributionProblems(zeroLike(after), ragged, after.objectSizes.length);
    assert(problems.some((problem) => problem.kind === 'array-geometry'),
      'columns paired by index must all describe the same objects');
  });

  await test('a mutating request against a read-only endpoint is a finding', () => {
    const after = counters(realShapedObjects(), { writeAttempts: 1 });
    const problems = webdavAttributionProblems(zeroLike(after), after, after.objectSizes.length);
    assert(problems.some((problem) => problem.kind === 'write-attempted-in-window'),
      'the mount is read-only and so is the endpoint');
  });

  await test('a well-formed pair of snapshots has no attribution problems', () => {
    const after = counters(realShapedObjects());
    assertEq(webdavAttributionProblems(zeroLike(after), after, after.objectSizes.length).length, 0,
      'the happy path must pass, or every refusal above is untestable');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: a COMMITTED length reported as though it had been DELIVERED');
  // --------------------------------------------------------------------------------------------------------

  await test('no G22 surface claims delivery, receipt, wire traffic or billing in the present tense', () => {
    // THE SAME EXECUTED RULE THE G18 SUITE HOLDS, over this gate's own surfaces. It is one shared
    // implementation on purpose: two copies of a wording rule is how the copy nobody re-read goes stale,
    // which is the exact failure mode this rule exists to stop.
    const findings = G22_WORDING_FILES.flatMap((file) =>
      deliveryOverstatements(readForWordingScan(file), file));
    assert(findings.length === 0, `G22 surfaces make delivery claims:\n    ${findings.join('\n    ')}`);
  });

  await test('...and the retracted passages this document keeps are still allowed to quote themselves', () => {
    // THE ESCAPE HATCH IS TESTED RATHER THAN TRUSTED. §7.3 and §7.5 exist to say what was withdrawn, and a
    // rule that forbade them from naming it would delete the history instead of the defect.
    const doc = readForWordingScan('docs/PROJECTION_PHASE_1_RCLONE_COMPARISON.md');
    assert(doc.includes('what a provider would transfer'),
      'the retraction still QUOTES the claim it withdraws, which is the point of keeping it');
    assertEq(deliveryOverstatements(doc, 'doc').length, 0,
      'and the rule lets it, because those lines mark themselves as retracted');
    // ...while a fresh, unmarked copy of the same sentence would be caught.
    assert(deliveryOverstatements('the observed column is what a provider would transfer', 'x').length > 0,
      'an unmarked restatement of the retracted claim is still a claim');
  });

  await test('THE CHEAT: an unsettled snapshot, whose committed and observed totals describe different sets', () => {
    // THE DEFECT THIS CLOSES. Between a body's commit and its observation the endpoint has counted the length
    // it promised and not yet the length it wrote. A window read there understates delivery by an amount that
    // depends on WHEN the gate looked, and the deficit would then be reported as something the client did.
    const after = counters(realShapedObjects(), { bodiesInFlight: 2 });
    const problems = webdavAttributionProblems(zeroLike(after), after, after.objectSizes.length);
    assert(problems.some((problem) => problem.kind === 'telemetry-unsettled'),
      'a snapshot taken mid-write cannot support an observed-byte figure');
    // ...AND THE BEFORE SNAPSHOT TOO, so a body left writing by library creation cannot skew the baseline.
    const settled = counters(realShapedObjects());
    const dirtyBefore = zeroLike(settled, { bodiesInFlight: 1 });
    assert(webdavAttributionProblems(dirtyBefore, settled, settled.objectSizes.length)
      .some((problem) => problem.kind === 'telemetry-unsettled'),
    'an unsettled BEFORE snapshot is refused for the same reason');
  });

  await test('THE CHEAT: an endpoint claiming it wrote more than it promised', () => {
    const after = counters(realShapedObjects(), {
      observedBytes: 999_000_000_000, rangedObservedBytes: 999_000_000_000,
    });
    assert(webdavAttributionProblems(zeroLike(after), after, after.objectSizes.length)
      .some((problem) => problem.kind === 'observed-exceeds-committed'),
    'an endpoint cannot write more than its Content-Length promised, and if it says it did the two '
    + 'counters have stopped describing the same responses');
  });

  await test('THE CHEAT: a body outcome that does not account for every body', () => {
    const after = counters(realShapedObjects(), { completedBodies: 1, truncatedBodies: 0 });
    assert(webdavAttributionProblems(zeroLike(after), after, after.objectSizes.length)
      .some((problem) => problem.kind === 'outcome-partition'),
    'after settlement every body is either completed or truncated, and a shortfall means one was lost');
  });

  await test('the observed column is attributed per object, not only in aggregate', () => {
    const after = counters(realShapedObjects());
    const skewed: WebdavCounters = {
      ...after,
      objectObserved: after.objectObserved.map((value, index) => (index === 4 ? value - 1_000 : value)),
    };
    assert(webdavAttributionProblems(zeroLike(after), skewed, after.objectSizes.length)
      .some((problem) => problem.kind === 'unattributed-observed-bytes'),
      'an aggregate that no longer matches its columns is a number with no denominator');
  });

  await test('a truncated read makes committed and observed diverge, and both are reported', () => {
    // THIS IS THE SHAPE THE REAL RUN PRODUCES, modelled here so the arithmetic is checked offline: a client
    // that promised to read a large object and abandoned it part-way.
    const objects = realShapedObjects();
    objects[2] = { size: 105_406_871, committed: 105_406_871, observed: 4_000_000, ranged: 1, full: 0 };
    const after = counters(objects);
    assertEq(webdavAttributionProblems(zeroLike(after), after, after.objectSizes.length).length, 0,
      'divergence is not itself a defect; it is the measurement');
    const measured = comparisonMeasurements(zeroLike(after), after, FIRST_CORPUS_ORDINAL, [2]);
    assert(measured.observedBytes < measured.committedBytes,
      'the two totals must come apart when a read is abandoned');
    assertEq(measured.truncatedBodies, 1, 'and the abandoned body is counted as truncated');
    assertEq(measured.perObject.find((cost) => cost.ordinal === 2)?.observedBytes, 4_000_000,
      'per object, the observed column carries what was written');
    assert((measured.corpusObservedMultiplier as number) < (measured.corpusCommittedMultiplier as number),
      'and the two multipliers differ, so a reader cannot mistake one for the other');
  });

  await test('the PROPFIND depth census is a partition of the PROPFIND total', () => {
    const after = counters(realShapedObjects(), {
      propfind: 10, propfindDepth0: 2, propfindDepth1: 3, propfindOther: 0,
    });
    assert(webdavAttributionProblems(zeroLike(after), after, after.objectSizes.length)
      .some((problem) => problem.kind === 'propfind-partition'),
    'a depth bucket that stopped being incremented would leave the total intact and the breakdown wrong, '
    + 'and the breakdown is what the report calls the cost of discovering a namespace');
  });

  await test('a mutating request BEFORE the window is a separate finding from one inside it', () => {
    // WINDOW-CORRECTNESS BOTH WAYS. A whole-run check reports a pre-window write as though it happened in the
    // window; a naive delta misses it entirely. Both are refused, separately, so the log names which.
    const after = counters(realShapedObjects(), { writeAttempts: 3 });
    const before = zeroLike(after, { writeAttempts: 3 });
    const problems = webdavAttributionProblems(before, after, after.objectSizes.length);
    assert(!problems.some((problem) => problem.kind === 'write-attempted-in-window'),
      'nothing was written INSIDE the window, and a delta must say so');
    assert(problems.some((problem) => problem.kind === 'write-attempted-before-window'),
      'but the endpoint was not read-only-clean when the window opened, and that must not be silent');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: the mount client\'s own stats, read permissively');
  // --------------------------------------------------------------------------------------------------------

  await test('a well-formed client stats document parses', () => {
    const parsed = parseClientStats({ bytes: 12, transfers: 3, elapsedTime: 1.5 }, 'test');
    assertEq(parsed.problems.length, 0, 'extra fields are ignored, not refused');
    assertEq(parsed.stats?.bytes, 12, 'and the two required ones are read');
    assertEq(parsed.stats?.transfers, 3, 'both of them');
  });

  await test('THE CHEAT: a MISSING field becoming a confident zero', () => {
    // THE DEFECT THIS CLOSES. The call site was `Number(value ?? 0)`. A zero in this position does not read
    // as "the client did not say"; it reads as "the client transferred nothing", which is the most dramatic
    // possible version of the very claim the figure was being used to make.
    for (const document of [{ transfers: 3 }, { bytes: 12 }, {}]) {
      assert(parseClientStats(document, 'test').stats === undefined,
        `a document missing a required field must be refused: ${JSON.stringify(document)}`);
    }
  });

  await test('THE CHEAT: a STRING that looks like a number, coerced', () => {
    for (const value of ['12', '', ' 12 ', true, null, []]) {
      assert(parseClientStats({ bytes: value, transfers: 3 }, 'test').stats === undefined,
        `a non-number "bytes" must be refused rather than coerced: ${JSON.stringify(value)}`);
    }
  });

  await test('THE CHEAT: a fractional, negative, infinite or unsafe count', () => {
    for (const value of [4.5, -1, Infinity, -Infinity, NaN, Number.MAX_SAFE_INTEGER + 2]) {
      assert(parseClientStats({ bytes: value, transfers: 3 }, 'test').stats === undefined,
        `an unusable "bytes" must be refused: ${String(value)}`);
      assert(parseClientStats({ bytes: 12, transfers: value }, 'test').stats === undefined,
        `an unusable "transfers" must be refused: ${String(value)}`);
    }
  });

  await test('THE CHEAT: a document that is not an object at all', () => {
    for (const document of [null, undefined, 'stats', 42, [1, 2, 3]]) {
      assert(parseClientStats(document, 'test').stats === undefined,
        `a non-object must be refused: ${JSON.stringify(document ?? null)}`);
    }
  });

  await test('THE CHEAT: an inherited field answering for one the client never sent', () => {
    const inherited = Object.create({ bytes: 99, transfers: 9 }) as Record<string, unknown>;
    assert(parseClientStats(inherited, 'test').stats === undefined,
      'a value from a prototype is not a value the client reported');
  });

  await test('THE CHEAT: client totals that FELL across the window', () => {
    // Lifetime counters within one mount process. A fall means the process restarted inside the window, and
    // a negative client delta beside a positive endpoint one is exactly how a comparison acquires an
    // impossible ratio.
    const before = parseClientStats({ bytes: 500, transfers: 9 }, 'b').stats as never;
    const after = parseClientStats({ bytes: 400, transfers: 9 }, 'a').stats as never;
    assert(clientStatsProblems(before, after).some((problem) => problem.kind === 'client-counter-reset'),
      'a fall must be refused before any figure is derived from the pair');
    const rising = parseClientStats({ bytes: 900, transfers: 11 }, 'a').stats as never;
    assertEq(clientStatsProblems(before, rising).length, 0, 'and a rising pair is fine');
  });

  await test('the live read and the persisted snapshot go through the SAME parser', () => {
    // TWO PARSERS WOULD DRIFT, and the one that drifted would be the one nobody re-read. The driver's live
    // read and the CLI's file read both call `parseClientStats`, and neither does its own coercion.
    assert(DRIVER.includes('parseClientStats'), 'the driver parses the live read');
    assert(!/Number\(\s*\w+\.(bytes|transfers)/.test(DRIVER), 'and does not coerce it');
    assert(CLI.includes('readClientStatsFile'), 'the CLI parses the persisted snapshots');
    assert(!/Number\(client(After|Before)\./.test(CLI), 'and does not coerce them either');
    // THE CHECK IS ABOUT CODE, AND COMMENTS ARE STRIPPED BEFORE IT RUNS. The first version of this assertion
    // failed on the explanatory note that NAMES the removed defect — a rule catching its own history, which
    // is exactly the accidental scoping this repository keeps having to correct.
    const measureCode = (CLI.split("case 'measure'")[1]?.split("case 'nonclaims'")[0] ?? '')
      .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert(measureCode.length > 500, 'the measurement command was found');
    assert(!/\?\?\s*0\s*\)/.test(measureCode),
      'and the measurement command has no coercing default left in its CODE');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE MEASUREMENT ITSELF');
  // --------------------------------------------------------------------------------------------------------

  await test('the measurement partitions the window exactly, corpus against everything else', () => {
    const objects = realShapedObjects();
    objects[0] = { size: 262_144, committed: 1_024, ranged: 1, full: 0 }; // the canary, read by the readiness probe
    const after = counters(objects);
    const measured = comparisonMeasurements(zeroLike(after), after, FIRST_CORPUS_ORDINAL, [2, 3, 4]);
    assertEq(measured.unattributedCommittedBytes, 0, 'committed corpus plus non-corpus equals the total');
    assertEq(measured.unattributedObservedBytes, 0, 'and so does the observed pair');
    assertEq(measured.nonCorpusCommittedBytes, 1_024, 'the canary is outside the corpus');
    assertEq(measured.corpusCommittedBytes, after.committedBytes - 1_024, 'and everything else is inside it');
    assertEq(measured.objectsExercised, 1 + COMPARISON_CORPUS.GENERATED_ENTRIES,
      'every corpus object was reached');
  });

  await test('the product-comparable subset is a subset and is computed by ordinal', () => {
    const after = counters(realShapedObjects());
    const measured = comparisonMeasurements(zeroLike(after), after, FIRST_CORPUS_ORDINAL, [2, 3]);
    assertEq(measured.productComparableCommittedBytes, 42_000_000 + 120_000, 'only the named ordinals count');
    assert(measured.productComparableCommittedBytes < measured.corpusCommittedBytes,
      'and a subset is smaller than the whole');
  });

  await test('peaks are reported as high-water marks and never as a difference', () => {
    // SUBTRACTING TWO PEAKS PRODUCES A NUMBER THAT IS NEITHER THE PEAK IN THE WINDOW NOR ANYTHING ELSE.
    const after = counters(realShapedObjects(), { peakConns: 9, peakConcurrent: 6 });
    const before = zeroLike(after, { peakConns: 4, peakConcurrent: 3 });
    const measured = comparisonMeasurements(before, after, FIRST_CORPUS_ORDINAL, [2]);
    assertEq(measured.peakConns, 9, 'the whole-run peak is the honest reading');
    assertEq(measured.peakConcurrent, 6, 'for both connection gauges');
  });

  await test('per-object costs are ordered TWO ways, because the two orderings name different objects', () => {
    // THE DEFECT THIS CLOSES, FOUND BY READING A REAL RUN. The first version reported the top five by
    // MULTIPLIER only. On this corpus that named five small files at 21-26x — and left unnamed the ~105 MB
    // fixture, which at a lower multiple was the overwhelming majority of the window's bytes. The headline
    // figure's biggest single contributor was missing from the report that produced the headline figure.
    const objects = realShapedObjects();
    objects[7] = { size: 40_000, committed: 4_000_000, ranged: 1, full: 0 };
    const after = counters(objects);
    const measured = comparisonMeasurements(zeroLike(after), after, FIRST_CORPUS_ORDINAL, [2]);
    assertEq(measured.perObject[0]?.ordinal, 7, 'the worst multiplier comes first');
    assertEq(measured.perObject[0]?.committedMultiplier, 100, 'as a multiple of the object\'s own length');
    assertEq(measured.perObjectByBytes[0]?.ordinal, 2,
      'while the most-bytes ordering names the large fixture, which the multiplier ordering does not reach');
    assert(measured.perObjectByBytes[0]?.committedMultiplier as number < 1,
      'and it is there at a multiple BELOW one, which is exactly why the other ordering misses it');
    assert(measured.corpusSizeBytes > 0, 'the multiplier\'s denominator is reported beside it');
  });

  await test('a whole-body answer is counted apart from a ranged one', () => {
    const objects = realShapedObjects();
    objects[4] = { size: 40_000, committed: 40_000, ranged: 0, full: 1 };
    const after = counters(objects);
    const measured = comparisonMeasurements(zeroLike(after), after, FIRST_CORPUS_ORDINAL, [2]);
    assertEq(measured.fullGets, 1, 'a client that asks for a whole body is visible as such');
    assert(measured.rangedGets > 0, 'beside the ranged ones');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE HOLD CHAIN, THE CLIENT BOUNDS, AND WHERE THEY ARE DERIVED FROM');
  // --------------------------------------------------------------------------------------------------------

  await test('the rendezvous is the PRODUCT gate\'s own window, and the shell agrees with the code', () => {
    assertEq(COMPARISON_HOLD_ARM_MS, HOLD_ARM_MS, 'the arm window is imported, not chosen again');
    assertEq(COMPARISON_HOLD_MAX_MS, HOLD_MAX_MS, 'and so is the backstop');
    assert(GATE.includes(`--max-hold ${COMPARISON_HOLD_MAX_MS}ms`),
      `the gate must pass the endpoint the same backstop the code derives (${COMPARISON_HOLD_MAX_MS}ms)`);
  });

  await test('the hold is strictly inside the client\'s own IO deadline, which the gate sets explicitly', () => {
    // THE BINDING CONSTRAINT ON THIS TOPOLOGY IS DIFFERENT FROM THE PRODUCT'S, and the code says so rather
    // than inheriting the argument along with the number. There is no admission limiter here to starve; what
    // there is, is a client deadline a held response must not exceed.
    assert(COMPARISON_HOLD_ARM_MS + BARRIER_RELEASE_OVERSHOOT_MS <= COMPARISON_HOLD_MAX_MS,
      'arm plus overshoot must fit inside the backstop');
    assert(COMPARISON_HOLD_MAX_MS < RCLONE_TIMEOUTS_MS.IO_IDLE,
      'and the backstop must sit strictly under the client IO deadline');
    assert(GATE.includes(`--timeout ${RCLONE_TIMEOUTS_MS.IO_IDLE / 1000}s`),
      'and the gate must set that deadline explicitly rather than inherit it');
    assert(GATE.includes(`--contimeout ${RCLONE_TIMEOUTS_MS.CONNECT / 1000}s`),
      'along with the connect deadline');
    assert(CORE.includes('This topology has no admission limiter at all'),
      'and the code states why the constraint differs rather than copying the product\'s argument');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: a mount that is not really a mount, or is really local passthrough');
  // --------------------------------------------------------------------------------------------------------

  await test('the gate proves the mount carries the bytes before it measures anything', () => {
    // `--allow-non-empty` MEANS A DEAD CLIENT LEAVES THE UNDERLYING DIRECTORY VISIBLE — empty, readable and
    // silent. A gate that only asked "did the scan find things" would report a clean small number for a dead
    // mount. So a known file is read THROUGH the mount and digest-compared against a value recorded outside.
    assert(GATE.includes('--allow-non-empty'), 'the gate mounts over its own propagating bind');
    assert(GATE.includes('THIS IS THE CHECK THAT MAKES `--allow-non-empty` SAFE'),
      'and says why that is safe here');
    assert(GATE.includes('the bytes read through the mount are not the bytes the endpoint serves'),
      'and fails if a read through the mount does not digest to the recorded value');
    const beforeServers = GATE.split('starting THREE REAL MEDIA SERVERS')[0] ?? '';
    assert(beforeServers.includes('SEED_SHA_THROUGH_MOUNT'),
      'and it does so BEFORE a media server is involved, so a failure names the mount rather than the server');
  });

  await test('no media server is given the source files: only the mount', () => {
    // THE CHEAT: bind the generated media directly into the media servers, and the "comparison" measures
    // local disk while an idle endpoint reports beautiful numbers.
    for (const marker of ['start_jellyfin()', 'start_emby()', 'start_plex()']) {
      const block = GATE.split(marker)[1]?.split('\n}')[0] ?? '';
      assert(block.length > 100, `the ${marker} block was found`);
      assert(block.includes('$WORK/mnt:/media/projection:rslave'),
        `${marker} binds the rclone mount as its library root`);
      assert(!block.includes('$WORK/media:') && !block.includes('$WORK/remote:'),
        `${marker} must NOT be given the generated source files directly`);
    }
  });

  await test('all three servers are given the SAME mount directory and the SAME library root', () => {
    const roots = GATE.match(/--mount-path \S+/g) ?? [];
    assertEq(roots.length, 3, 'three libraries are created');
    assertEq(new Set(roots).size, 1, 'and all three name the same root: one namespace, three readers');
  });

  await test('the namespace is proved to disappear when the mount client stops', () => {
    assert(GATE.includes('the namespace is still visible after the mount client stopped'),
      'a stale mount is how the NEXT run reports a figure produced by a mount it did not create');
  });

  await test('seek and ordinary-file behaviour are MEASURED, after the window, not assumed', () => {
    // THE ACCEPTANCE PLAN SAYS TO RECORD A LIMITATION RATHER THAN CHANGE THE CONTRACT IF ONE IS FOUND, so the
    // question is asked directly — and asked AFTER the measured window, so its answer cannot appear inside
    // the cost figures.
    const measureAt = GATE.indexOf('drive measure');
    const seekAt = GATE.indexOf('does this topology preserve seek');
    assert(measureAt > 0 && seekAt > measureAt,
      'the seek probe runs after the measurement so it cannot pollute the figures');
    assert(GATE.includes('a BACKWARD seek through the mount returned different bytes'),
      'a backward seek is checked, which is the transition a naive client answers wrongly');
    assert(GATE.includes('IT IS NOT G9'),
      'and the gate says what this is not: ten decoded media-time seeks are a different claim');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nPINNING, BOUNDS, PREFLIGHT AND CLEANUP');
  // --------------------------------------------------------------------------------------------------------

  await test('every image the gate runs is pinned by digest', () => {
    const assignments = GATE.match(/^[A-Z_]*IMAGE="[^"]+"/gm) ?? [];
    assert(assignments.length >= 5, `every image assignment was found (${assignments.length})`);
    for (const assignment of assignments) {
      assert(assignment.includes('@sha256:') || assignment.includes('$'),
        `an image is pinned by tag rather than by digest: ${assignment}`);
    }
    assert(GATE.includes('rclone/rclone@sha256:'), 'including the mount client');
  });

  await test('the media-server digests are the SAME ones the product gate pins', () => {
    // A COMPARISON READ BY TWO DIFFERENT PLEXES WOULD INCLUDE THE DIFFERENCE BETWEEN TWO PLEXES.
    for (const name of ['JELLYFIN_IMAGE', 'PLEX_IMAGE', 'EMBY_IMAGE']) {
      const here = (GATE.match(new RegExp(`^${name}="([^"]+)"`, 'm')) ?? [])[1];
      const there = (PRODUCT_GATE.match(new RegExp(`^${name}="([^"]+)"`, 'm')) ?? [])[1];
      assert(here !== undefined && here === there, `${name} must be the same digest on both sides`);
    }
  });

  await test('the host preflight runs BEFORE any container is started', () => {
    // A PREFLIGHT THAT RUNS AFTER A CONTAINER IS DIAGNOSING A HOST THE GATE HAS ALREADY BEGUN USING, and its
    // "the host was fine" verdict is a verdict about a host with side effects on it. The product's gate
    // learned this the expensive way: its offline test compared the preflight against a container three
    // hundred lines further down, so the assertion was true of the comparison it made and false of the
    // sentence it existed to defend. This one compares against the FIRST `docker run` in the file.
    //
    // IT COMPARES AGAINST TOP-LEVEL INVOCATIONS, NOT AGAINST THE FIRST OCCURRENCE OF THE WORD. `cleanup()`
    // and `ffmpeg_run()` both contain `docker run` in their BODIES and are defined near the top of the file;
    // an index comparison against those would pass for a script that started containers first and would be
    // the same shape of accidental scoping the product gate's own version of this test had.
    const preflightAt = GATE.indexOf('projection-host-preflight-cli.ts propagation');
    assert(preflightAt > 0, 'the preflight is invoked');
    const lines = GATE.split('\n');
    let offset = 0;
    let firstDockerAt = -1;
    let firstDocker = '';
    for (const line of lines) {
      if (/^docker\s+(run|compose|network|build|exec|stop|rm|pull)\b/.test(line)) {
        // A COMPOSE PARSE CHECK STARTS NOTHING and is allowed to precede the preflight; anything else is not.
        if (!/^docker compose -f \S+ config -q/.test(line)) {
          firstDockerAt = offset;
          firstDocker = line;
          break;
        }
      }
      offset += line.length + 1;
    }
    assert(firstDockerAt > 0, 'the gate does eventually run a container');
    assert(firstDockerAt > preflightAt,
      `the first top-level docker invocation (${firstDocker.trim()}) must come after the preflight`);
    assert(GATE.includes('--require'), 'and a not-shared propagation is fatal');
  });

  await test('the skip is exit 77, has exactly one cause, and cannot be read as a pass', () => {
    assert(GATE.includes('GATE_SKIP_STATUS=77'), 'the skip status is 77');
    assert(GATE.includes('measured NOTHING'), 'and the message refuses the pass reading');
    assertEq((GATE.match(/exit "\$GATE_SKIP_STATUS"/g) ?? []).length, 1,
      'there is exactly ONE skip condition, and it is /dev/fuse');
    assert(GATE.includes('/dev/fuse is reachable from a container'), 'which is what it checks');
  });

  await test('every wait in the gate is bounded, and the log collector cannot stream forever', () => {
    assert(!/for\s*\(\(\s*;\s*;\s*\)\)/.test(GATE), 'there is no unbounded loop');
    assert(!/while\s+true/.test(GATE), 'and no `while true`');
    for (const loop of GATE.match(/for _ in \$\(seq 1 \d+\)/g) ?? []) {
      assert(/\d+/.test(loop), `a readiness loop is bounded: ${loop}`);
    }
    assert(GATE.includes('docker logs --tail 40'),
      'a diagnostic that never returns turns a named failure into a wedged run');
    assert(!/docker logs (?!--tail)/.test(GATE), 'and no unbounded `docker logs` anywhere');
  });

  await test('cleanup removes the servers first, then the mount, then the network', () => {
    const cleanup = GATE.split('cleanup() {')[1]?.split('\n}')[0] ?? '';
    assert(cleanup.length > 100, 'the cleanup function was found');
    const serversAt = cleanup.indexOf('PLEX_CONTAINER');
    const mountAt = cleanup.indexOf('MOUNT_CONTAINER');
    // THE UNMOUNT IS THE SHARED HELPER'S NOW, and the move is the correction. The inline `umount -l` ran
    // inside a container whose bind of the gate root carried Docker's default `rprivate` propagation, so on a
    // host where the mount genuinely propagates the host mountpoint survived — four were found on Unraid.
    const unmountAt = cleanup.indexOf('projection_gate_cleanup_run');
    const networkAt = cleanup.indexOf('docker network rm');
    assert(serversAt >= 0 && mountAt > serversAt,
      'the media servers go first: a FUSE mount with a live reader does not unmount cleanly');
    assert(unmountAt > mountAt, 'then the mount is force-unmounted, through the propagating helper');
    assert(networkAt > unmountAt, 'and the network last, when nothing is attached to it');
    assert(GATE.includes('trap cleanup EXIT'), 'and it runs on every exit path');
  });

  await test('every container name and the network carry the shell PID', () => {
    // TWO COPIES OF THIS GATE, OR THIS GATE BESIDE ONE OF THE PRODUCT'S FOUR, MUST NOT COLLIDE — and a
    // collision here would not fail loudly: it would silently share a mount, and the figures would describe
    // two runs.
    for (const name of ['DAV_CONTAINER', 'MOUNT_CONTAINER', 'JF_CONTAINER', 'PLEX_CONTAINER',
      'EMBY_CONTAINER', 'NETWORK']) {
      const line = (GATE.match(new RegExp(`^${name}="[^"]*"`, 'm')) ?? [])[0] ?? '';
      assert(line.includes('$$'), `${name} must carry the shell PID: ${line}`);
    }
  });

  await test('the ports do not collide with any of the product\'s four gates', () => {
    const ours = (GATE.match(/:-(\d{4,5})\}/g) ?? []).map((match) => match.slice(2, -1));
    assert(ours.length >= 5, `the gate declares its ports (${ours.join(',')})`);
    const theirs = new Set<string>();
    for (const script of ['projection-three-server-concurrency-gate.sh', 'projection-jellyfin-dataplane-gate.sh',
      'projection-plex-dataplane-gate.sh', 'projection-emby-dataplane-gate.sh']) {
      for (const match of read(`deploy/${script}`).match(/:-(\d{4,5})\}/g) ?? []) {
        theirs.add(match.slice(2, -1));
      }
    }
    for (const port of ours) {
      assert(!theirs.has(port), `port ${port} is already used by one of the product's gates`);
    }
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: a credential, a path or an address in the report');
  // --------------------------------------------------------------------------------------------------------

  await test('the nonclaims themselves are redaction-safe', () => {
    assertEq(findRedactionProblems(RCLONE_COMPARISON_NONCLAIMS).length, 0,
      'the gate prints these on every run');
    assertEq(findRedactionProblems(RCLONE_COMPARISON_TOPOLOGY).length, 0,
      'and emits the topology into the results file');
  });

  await test('the credential travels in a file, never in an argument or an environment value', () => {
    assert(GATE.includes('--token-file /secret/token'), 'the endpoint reads it from a file');
    assert(GATE.includes('BEARER_TOKEN_COMMAND'), 'and the client reads it through a command hook');
    assert(!/BEARER_TOKEN=/.test(GATE), 'and it is never an environment value');
    assert(!/--token [^-]/.test(GATE), 'nor an argument');
    assert(GATE.includes('"$DAV_TOKEN" "Authorization:" "Bearer "'),
      'and the gate then searches for that exact value where it must not appear');
  });

  await test('an INTERRUPTED run cannot leave the credential where `git add -A` reaches it', () => {
    // THE CLEANUP TRAP IS NOT ENOUGH ON ITS OWN, AND THAT IS THE POINT OF THIS CHECK. It deletes the run
    // directory on success and on failure — but a run interrupted between minting the credential and the trap
    // firing (a `kill -9`, a lost console) leaves `secret/token` on disk inside the repository, because bind
    // propagation forces the working directory to live beside the checkout rather than under a temp dir. Four
    // of the five gates in this family already carry a `.gitignore` entry for exactly that; this asserts that
    // this gate's is there rather than trusting that somebody remembered.
    const ignore = read('.gitignore');
    const root = (GATE.match(/^GATE_ROOT="\$PWD\/([^"]+)"/m) ?? [])[1];
    assert(root !== undefined && root.startsWith('.'), `the gate names its scratch root: ${String(root)}`);
    assert(ignore.includes(`${root}/`),
      `${root}/ is not in .gitignore, so an interrupted run could leave a minted credential staged`);
  });

  await test('the gate proves the credential was actually required', () => {
    assert(GATE.includes('the endpoint served a ranged request with the wrong credential'),
      'a leak search for an optional secret proves nothing');
    assert(GATE.includes('the searches above had no subject'),
      'and the requirement is re-checked after the searches');
  });

  await test('the endpoint telemetry carries no path, reference or timestamp', () => {
    // A REPORT CANNOT REDACT WHAT AN INSTRUMENT NEVER PRODUCED. The per-object columns are the one place a
    // path would be natural, and they carry a registration ordinal instead.
    const snapshotStruct = ENDPOINT.split('type CountersSnapshot struct {')[1]?.split('\n}')[0] ?? '';
    assert(snapshotStruct.length > 200, 'the wire shape was found');
    for (const forbidden of ['Path string', 'Ref string', 'URL string', 'Timestamp', 'Lease']) {
      assert(!snapshotStruct.includes(forbidden), `the wire shape carries ${forbidden}`);
    }
    assert(snapshotStruct.includes('ObjectSizes'), 'and identifies objects by ordinal and size only');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: a wrapper that swallows a SKIP or a FAILURE');
  // --------------------------------------------------------------------------------------------------------

  const stubDir = mkdtempSync(join(tmpdir(), 'projection-rclone-'));
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
        PROJECTION_RCLONE_GATE_COMMAND: stubPath,
        ...(runs === undefined ? {} : { PROJECTION_RCLONE_GATE_RUNS: String(runs) }),
      },
      encoding: 'utf8',
    });
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };

  await test('the three-run wrapper propagates a SKIP as 77 and refuses to announce a sequence', () => {
    const result = runWrapper('projection-rclone-comparison-gate-three.sh', [0, 77, 0]);
    assertEq(result.status, 77, 'a skipped run must not be folded into success');
    assert(result.stderr.includes('MEASURED NOTHING'), 'and it must say so');
    assert(!result.stdout.includes('consecutive rclone/WebDAV comparison runs completed'),
      'a skipped sequence must not print the closing message');
  });

  await test('the three-run wrapper stops on the FIRST failure and does not average', () => {
    const result = runWrapper('projection-rclone-comparison-gate-three.sh', [0, 1, 0]);
    assertEq(result.status, 1, 'a failed run must fail the sequence');
    assert(result.stderr.includes('Runs completed: 1 of 3'), 'and it must say how far it got');
  });

  await test('three completed runs announce the sequence AND its limits in the same breath', () => {
    const result = runWrapper('projection-rclone-comparison-gate-three.sh', [0, 0, 0]);
    assertEq(result.status, 0, 'three completed runs are a completed sequence');
    assert(result.stdout.includes('3 of 3 consecutive'), 'it must state the count');
    assert(result.stdout.includes('closes'), 'and refuse the closure reading');
    assert(result.stdout.includes('G22 has no pass threshold'),
      'and say plainly that the runs establish reproducibility, not a pass');
  });

  await test('a zero-run sequence cannot announce a completed one', () => {
    const result = runWrapper('projection-rclone-comparison-gate-three.sh', [0, 0, 0], 0);
    assert(result.status !== 0, 'a loop that never ran must not exit 0');
    assert(result.stderr.includes('refusing to report a completed sequence'), 'and must say why');
  });

  await test('the optional wrapper maps 77 and NOTHING else', () => {
    const skipped = runWrapper('projection-rclone-comparison-gate-optional.sh', [77]);
    assertEq(skipped.status, 0, 'a skip is success for a caller that chose this entry point');
    assert(skipped.stderr.includes('NOTHING WAS MEASURED'), 'and it says nothing was proved');
    for (const status of [1, 2, 66, 78]) {
      assertEq(runWrapper('projection-rclone-comparison-gate-optional.sh', [status]).status, status,
        `status ${status} must propagate unchanged`);
    }
    assertEq(OPTIONAL.split('GATE_SKIP_STATUS').length - 1, 3,
      'and only one status is named in it');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nEXECUTABLE: the CLI itself, run as a process, against crafted inputs');
  // --------------------------------------------------------------------------------------------------------

  const cliDir = mkdtempSync(join(tmpdir(), 'projection-rclone-cli-'));
  const runCli = (argv: readonly string[]): { status: number; stdout: string; stderr: string } => {
    const result = spawnSync('npx', ['tsx', join(repoRoot, 'src/ops/projection-rclone-comparison-cli.ts'),
      ...argv], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  const writeJson = (name: string, value: unknown): string => {
    const path = join(cliDir, name);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  };

  await test('EXECUTABLE: a results file containing a SKIP cannot exit zero', () => {
    // G22 DECLINES TO JUDGE THE COST. It does not decline to judge whether it measured anything, and a
    // comparison assembled out of unanswered questions is worse than none.
    const path = writeJson('results-with-skip.json', [
      { gate: 'RC1-something', verdict: 'pass', measured: 1, budget: 1 },
      { gate: 'RC3-something-else', verdict: 'skip', note: 'declined to judge itself' },
    ]);
    const result = runCli(['report', '--results', path]);
    assert(result.status !== 0, `a report over a skipped assertion must not exit zero (${result.status})`);
    assert(/SKIPPED/.test(result.stderr), `and must say why: ${result.stderr.slice(0, 200)}`);
  });

  await test('EXECUTABLE: an all-pass results file exits zero', () => {
    const path = writeJson('results-clean.json', [
      { gate: 'RC4-committed-bytes', verdict: 'pass', note: '13205874 media bytes committed' },
    ]);
    assertEq(runCli(['report', '--results', path]).status, 0, 'a clean report must pass');
  });

  await test('EXECUTABLE: a report carrying a URL or a path is refused', () => {
    const path = writeJson('results-leaky.json', [
      { gate: 'RC4-bytes', verdict: 'pass', note: 'served from http://fakedav:8098/dav/Movies' },
    ]);
    const result = runCli(['report', '--results', path]);
    assert(result.status !== 0, 'a leaky report must not be printed');
    assert(result.stderr.includes('a URL'), `and must name what leaked: ${result.stderr.slice(0, 200)}`);
  });

  await test('EXECUTABLE: broken telemetry fails closed rather than reporting a cheap comparison', () => {
    const after = counters(realShapedObjects());
    const broken = JSON.parse(JSON.stringify(after)) as Record<string, unknown>;
    delete broken.committedBytes;
    const beforePath = writeJson('broken-before.json', zeroLike(after));
    const afterPath = writeJson('broken-after.json', broken);
    const result = runCli(['telemetry', '--before', beforePath, '--after', afterPath,
      '--objects', String(after.objectSizes.length), '--gate', 'RC3']);
    assert(result.status !== 0, 'a missing counter must fail the gate');
    assert(/cannot support a comparison figure/.test(result.stderr),
      `and say so: ${result.stderr.slice(0, 200)}`);
  });

  await test('EXECUTABLE: a warm window fails the cold check with a named reason', () => {
    const after = counters(realShapedObjects());
    const warmBefore = zeroLike(after, {
      objectCommitted: after.objectSizes.map((_size, index) => (index >= FIRST_CORPUS_ORDINAL ? 1_000 : 0)),
      objectObserved: after.objectSizes.map((_size, index) => (index >= FIRST_CORPUS_ORDINAL ? 1_000 : 0)),
      committedBytes: (after.objectSizes.length - FIRST_CORPUS_ORDINAL) * 1_000,
      rangedCommittedBytes: (after.objectSizes.length - FIRST_CORPUS_ORDINAL) * 1_000,
      observedBytes: (after.objectSizes.length - FIRST_CORPUS_ORDINAL) * 1_000,
      rangedObservedBytes: (after.objectSizes.length - FIRST_CORPUS_ORDINAL) * 1_000,
      completedBodies: after.objectSizes.length - FIRST_CORPUS_ORDINAL,
      rangedBodies: after.objectSizes.length - FIRST_CORPUS_ORDINAL,
      accountedResponses: after.objectSizes.length - FIRST_CORPUS_ORDINAL,
      requests: after.objectSizes.length - FIRST_CORPUS_ORDINAL,
      gets: after.objectSizes.length - FIRST_CORPUS_ORDINAL,
      objectGets: after.objectSizes.map((_size, index) => (index >= FIRST_CORPUS_ORDINAL ? 1 : 0)),
      objectRanged: after.objectSizes.map((_size, index) => (index >= FIRST_CORPUS_ORDINAL ? 1 : 0)),
    });
    const beforePath = writeJson('warm-before.json', warmBefore);
    const afterPath = writeJson('warm-after.json', after);
    const result = runCli(['cold-window', '--before', beforePath, '--after', afterPath, '--gate', 'RC3',
      '--first-corpus-ordinal', String(FIRST_CORPUS_ORDINAL), '--corpus-objects', '49',
      '--client-cache-before', '0']);
    assert(result.status !== 0, 'a warm window must fail');
    assert(/corpus-already-read/.test(result.stderr), `and name the reason: ${result.stderr.slice(0, 300)}`);
  });

  await test('EXECUTABLE: the measurement records every figure and attaches a budget to none', () => {
    // THE STRONGEST FORM OF "G22 HAS NO PASS THRESHOLD": run the real command and read what it wrote.
    const after = counters(realShapedObjects());
    const beforePath = writeJson('measure-before.json', zeroLike(after));
    const afterPath = writeJson('measure-after.json', after);
    const clientBefore = writeJson('client-before.json', { bytes: 0, transfers: 0 });
    const clientAfter = writeJson('client-after.json', { bytes: 1_234_567, transfers: 51 });
    const resultsPath = join(cliDir, 'measure-results.json');
    const result = runCli(['measure', '--before', beforePath, '--after', afterPath, '--gate', 'RC4',
      '--first-corpus-ordinal', String(FIRST_CORPUS_ORDINAL), '--product-ordinals', '2,3,4',
      '--corpus-objects', '49', '--client-stats-before', clientBefore, '--client-stats-after', clientAfter,
      '--client-cache-before', '0', '--client-cache-after', '0', '--results', resultsPath]);
    assertEq(result.status, 0, `the measurement must succeed: ${result.stderr.slice(0, 400)}`);
    const results = JSON.parse(readFileSync(resultsPath, 'utf8')) as GateResult[];
    assert(results.length >= 12, `every figure is recorded (${results.length})`);
    for (const entry of results) {
      // THE EXEMPT ONES ARE INSTRUMENT CHECKS, NOT COST FIGURES. They assert that the numbers add up and
      // that the instruments were coherent; a budget on one of those is a correctness bound, which G22 has,
      // rather than a cost threshold, which it does not.
      const isArithmetic = entry.gate.includes('fully-attributed') || entry.gate.includes('objects-exercised')
        || entry.gate.includes('telemetry-coherent');
      if (isArithmetic) continue;
      assert(entry.budget === undefined,
        `${entry.gate} carries a budget of ${entry.budget}; G22 has no pass threshold and a control with a `
        + 'budget is a competitor');
    }
    for (const needed of ['RC4-requests-gets', 'RC4-requests-metadata', 'RC4-requests-resolution',
      'RC4-committed-bytes', 'RC4-observed-bytes', 'RC4-body-outcomes',
      'RC4-http-429', 'RC4-peak-connections', 'RC4-client-own-accounting',
      'RC4-client-telemetry-coherent',
      'RC4-per-server-attribution', 'RC4-topology']) {
      assert(results.some((entry) => entry.gate === needed), `the report is missing ${needed}`);
    }
    for (const ordering of ['by-multiplier', 'by-bytes']) {
      assert(results.some((entry) => entry.gate.startsWith(`RC4-object-cost-${ordering}:`)),
        `the report is missing the per-object costs ordered ${ordering}`);
    }
    assertEq(findRedactionProblems(results).length, 0, 'and the whole results file is redaction-safe');
  });

  await test('EXECUTABLE: a window that missed an object fails the coverage floor', () => {
    const objects = realShapedObjects();
    objects[10] = { size: 40_000, committed: 0, ranged: 0, full: 0 };
    const after = counters(objects);
    const beforePath = writeJson('short-before.json', zeroLike(after));
    const afterPath = writeJson('short-after.json', after);
    const result = runCli(['measure', '--before', beforePath, '--after', afterPath, '--gate', 'RC4',
      '--first-corpus-ordinal', String(FIRST_CORPUS_ORDINAL), '--product-ordinals', '2',
      '--corpus-objects', '49',
      '--client-stats-before', writeJson('cb.json', { bytes: 0 }),
      '--client-stats-after', writeJson('ca.json', { bytes: 1 }),
      '--client-cache-before', '0', '--client-cache-after', '0']);
    assert(result.status !== 0, 'a cost figure over a corpus the scan did not read is a small number for the '
      + 'wrong reason');
  });

  await test('EXECUTABLE: the nonclaims come from the constant, not from prose in the shell', () => {
    const result = runCli(['nonclaims']);
    assertEq(result.status, 0, 'the command works');
    for (const claim of RCLONE_COMPARISON_NONCLAIMS) {
      assert(result.stdout.includes(claim.slice(0, 60)), `the nonclaim "${claim.slice(0, 40)}…" is printed`);
    }
    assert(GATE.includes('nonclaims'), 'and the gate ends by invoking that command');
    assert(!GATE.includes('Phase 1 remains open"'), 'rather than retyping any of them in the shell');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nTHE CHEAT: wording that upgrades a measurement into a recommendation or a closure');
  // --------------------------------------------------------------------------------------------------------

  const CURRENT_TENSE_SOURCES: ReadonlyArray<readonly [string, string]> = [
    ['the gate', GATE], ['the three-run wrapper', THREE_RUN], ['the optional wrapper', OPTIONAL],
    ['the core module', CORE], ['the CLI', CLI], ['the driver', DRIVER], ['the document', DOC],
  ];

  await test('nothing anywhere claims this closes G22, Linux, Unraid or Phase 1', () => {
    const forbidden: ReadonlyArray<readonly [RegExp, string]> = [
      [/G22 is (now )?(closed|proved|passed)/i, 'G22 closure'],
      [/closes G22/i, 'G22 closure'],
      [/Phase 1 (is )?(closed|complete|done)/i, 'Phase 1 closure'],
      [/(proved|closed|passed) on (Linux|Unraid)/i, 'a Linux or Unraid claim'],
      [/tranche is (closed|complete)/i, 'tranche closure'],
    ];
    for (const [label, source] of CURRENT_TENSE_SOURCES) {
      for (const [pattern, kind] of forbidden) {
        assert(!pattern.test(source), `${label} claims ${kind}`);
      }
    }
  });

  await test('nothing anywhere recommends rclone or WebDAV as a frontend', () => {
    // THE SINGLE MOST DAMAGING SENTENCE THIS TRANCHE COULD PRODUCE. A cheap figure plus one careless clause
    // is how a rejected option comes back.
    const forbidden: ReadonlyArray<readonly [RegExp, string]> = [
      [/we should (use|adopt|switch to) rclone/i, 'a recommendation'],
      [/rclone is (the|a) (better|chosen|recommended|preferred)/i, 'a recommendation'],
      [/replace (projectiond|the daemon) with rclone/i, 'a replacement proposal'],
      [/rclone (as|becomes) the (frontend|data plane)/i, 'a frontend proposal'],
      [/(adopt|adopting) (the )?WebDAV (mount|frontend)/i, 'an adoption proposal'],
    ];
    for (const [label, source] of CURRENT_TENSE_SOURCES) {
      for (const [pattern, kind] of forbidden) {
        assert(!pattern.test(source), `${label} contains ${kind}`);
      }
    }
    assert(RCLONE_COMPARISON_NONCLAIMS.some((claim) => claim.includes('COMPARISON CONTROL and not an')),
      'and the first nonclaim printed on every run says so');
  });

  await test('the gate does not claim per-server attribution it cannot have', () => {
    assertEq(PER_SERVER_ATTRIBUTION_IS_IMPOSSIBLE_HERE, true, 'the code states it');
    assert(CLI.includes('NOT CLAIMED'), 'the report states it');
    assert(RCLONE_COMPARISON_NONCLAIMS.some((claim) => claim.includes('per-server attribution is impossible')),
      'and it is printed on every run');
    for (const server of ['Plex cost', 'Jellyfin cost', 'Emby cost']) {
      for (const [label, source] of CURRENT_TENSE_SOURCES) {
        assert(!source.includes(server), `${label} attributes a byte to ${server.split(' ')[0]}`);
      }
    }
  });

  await test('the distinction between endpoint traffic and client behaviour is stated and instrumented', () => {
    assertEq(WEBDAV_SERVER_TRAFFIC_IS_NOT_CLIENT_BEHAVIOUR, true, 'the code states it');
    assert(CLI.includes('THESE ARE THREE DIFFERENT MEASUREMENTS'),
      'the report names all three instruments: committed, observed, and the client\x27s own');
    assert(CLI.includes('none is corrected to match another'),
      'and says none is adjusted toward another');
    assert(CLI.includes('NO RATIO BETWEEN THEM IS A PROVIDER COST'),
      'and refuses the ratio an earlier version published as one');
    assertEq(COMMITTED_BYTES_ARE_NOT_DELIVERED_BYTES, true, 'and the code states it as a value');
    assert(GATE.includes('client-stats'), 'and the gate reads the client\'s own accounting');
  });

  await test('nothing implies the naive path costing more is what rejected it', () => {
    assert(flat(CORE).includes('A cheap number here would not reopen that decision, and an expensive one is '
      + 'not what closed it'), 'the code says the decision does not rest on these figures');
    assert(DOC.includes('ADR 002'), 'and the document points at where the decision does rest');
  });

  // --------------------------------------------------------------------------------------------------------
  console.log('\nWIRING');
  // --------------------------------------------------------------------------------------------------------

  await test('the suite runs in the default aggregate and has its own script', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    assertEq(pkg.scripts['test:projection-rclone-comparison'],
      'tsx test/projection-rclone-comparison.ts', 'the suite has a script');
    assert(AGGREGATE_SUITE_COMMAND.includes('test/projection-rclone-comparison.ts'),
      'and runs in the default aggregate');
    for (const script of ['go:rclone-comparison-gate', 'go:rclone-comparison-gate:three',
      'go:rclone-comparison-gate:optional']) {
      assert(typeof pkg.scripts[script] === 'string', `${script} is defined`);
    }
    // AND THE REQUIRED ENTRY POINTS PROPAGATE 77 rather than mapping it. Only the optional one maps.
    assert(pkg.scripts['go:rclone-comparison-gate']?.includes('projection-rclone-comparison-gate.sh'),
      'the required entry point is the gate itself');
    assert(pkg.scripts['go:rclone-comparison-gate:optional']?.includes('-optional.sh'),
      'and skip-as-success lives in its own entry point');
  });

  await test('the endpoint is a gate tool: it never ships and the daemon never imports it', () => {
    const dockerfile = read('projectiond/Dockerfile');
    assert(dockerfile.includes('./cmd/projectiond'), 'the image builds the daemon');
    assert(!dockerfile.includes('fakewebdav'), 'and does not build the comparison control\'s endpoint');
    assert(read('projectiond/cmd/fakewebdav/main.go').includes('//go:build linux'),
      'the tool is Linux-only, like the gate that uses it');
    for (const file of ['projectiond/internal/daemon/daemon.go', 'projectiond/internal/source/http.go',
      'projectiond/cmd/projectiond/main.go']) {
      assert(!read(file).includes('fakewebdav'), `${file} does not import it`);
    }
    assert(read('test/projectiond-wiring.ts').includes('fakewebdav'),
      'and the wiring suite holds that rule rather than this one alone');
  });

  await test('no shipped Compose file or runtime stack names the comparison control', () => {
    for (const composeFile of ['docker-compose.yml', 'docker-compose.runtime.yml', 'docker-compose.unraid.yml',
      'docker-compose.arcane.yml', 'docker-compose.deploy.yml', 'docker-compose.projectiond.yml']) {
      const source = read(composeFile);
      assert(!source.includes('rclone') && !source.includes('webdav') && !source.includes('fakedav'),
        `${composeFile} must not reference the comparison control`);
    }
    // AND THE GATE STANDS UP NO DATABASE, NO PUBLISHER AND NO DAEMON, because the naive path has none.
    assert(!GATE.includes('migrate-cli'), 'the gate runs no migration');
    assert(!GATE.includes('projection-publish-cli'), 'publishes no manifest');
    assert(!GATE.includes('projectiond:phase1'), 'and starts no daemon');
  });

  await test('the acceptance plan and the roadmap record what has been run, not what exists', () => {
    // A GATE EXISTING IS NOT A GATE PASSING, and §6.1 is the authority on which is which.
    assert(PLAN.includes('G22 **Comparison control**'), '§6.1 still carries a G22 row');
    assert(/G22 \*\*Comparison control\*\*[^\n]*Docker Desktop/i.test(PLAN),
      'and it names the platform every run has been on');
    assert(PLAN.includes('docs/PROJECTION_PHASE_1_RCLONE_COMPARISON.md'),
      'and points at the document that carries the run record');
    assert(DOC.includes('## 7. Run record'), 'which has one');
    assert(DOC.includes('A gate existing is not a gate passing'), 'and says what it is for');
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, error] of failures) console.log(`  - ${name}: ${(error as Error).stack ?? error}`);
    process.exit(1);
  }
}

await main();
