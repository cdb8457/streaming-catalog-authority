// Projection Phase 1 — G22, the rclone/WebDAV COMPARISON CONTROL, as rules rather than as prose.
//
// WHAT G22 SAYS, VERBATIM (`docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §5):
//
//   "The same corpus behind an rclone/WebDAV mount, measured the same way. This is EVIDENCE, NOT
//    ARCHITECTURE: it exists to record what the naive approach costs. It has no pass threshold."
//
// EVERY WORD OF THAT SENTENCE IS LOAD-BEARING AND THIS FILE IS SHAPED AROUND THE LAST FOUR.
//
// THERE IS NO PASS THRESHOLD ON A COST FIGURE HERE, AND THERE WILL NOT BE ONE. `docs/ADR_002_…` §2 rejected
// rclone over WebDAV as production architecture and kept it as a test control, in those words. A control with
// a budget is a competitor: the moment a ranged-GET count here has a ceiling, somebody is optimising the
// naive path, and the thing this gate exists to record — WHAT THE NAIVE PATH ACTUALLY DOES — stops being
// recorded and starts being argued about. So every comparative number below is produced and reported and
// asserted on by NOTHING.
//
// WHAT DOES FAIL CLOSED, AND IT IS EVERYTHING THAT MAKES A NUMBER WORTH READING. A measurement taken off a
// broken instrument is worse than no measurement at all, because a comparison is exactly the kind of artefact
// a reader trusts without re-deriving it. So: the mount has to work, the corpus has to be the corpus, the
// telemetry has to be coherent and monotonic, every byte has to be attributed to a registered object, the
// window has to be COLD, no credential may leak, and a skipped or failed step may not be swallowed. Those are
// correctness and instrumentation properties, not cost thresholds, and each of them refuses a specific way
// this gate could report a cheap number it did not earn.
//
// WHAT THIS FILE IS NOT. It is not a second data plane, not a source adapter, not a frontend, and nothing in
// it is reachable from the product. `projectiond` does not import it, the publisher does not import it, and
// no shipped Compose file names it. It is the offline half of a measurement.
//
// IT IS PURE. No socket, no clock, no filesystem — so every rule here is checkable against a scripted
// counters document, including the documents that are awkward to produce against a real mount: the one whose
// counter reset, the one whose partitions do not balance, the one taken over a warm cache.

import {
  BARRIER_RELEASE_OVERSHOOT_MS, HOLD_ARM_MS, HOLD_MAX_MS, REQUIRED_SERVER_COUNT,
} from './three-server-concurrency.js';

// ---------------------------------------------------------------------------------------------------------
// What is under test, stated as data
// ---------------------------------------------------------------------------------------------------------

/**
 * THE PATH TOPOLOGY, NAMED EXACTLY ONCE AND ASSERTED BY THE OFFLINE SUITE.
 *
 * A comparison whose topology is described in a paragraph is a comparison whose topology drifts. Each hop is
 * a place a measurement could be taken from a different thing than the one the report names:
 *
 *   1. a deterministic WebDAV endpoint serving the SAME ~50-entry corpus, from files generated on this
 *      machine, with per-object request and byte telemetry;
 *   2. ONE rclone mount of that endpoint, read-only, with a FRESH VFS cache;
 *   3. the ORDINARY read-only regular files that mount presents — not symlinks, not `.strm` placeholders;
 *   4. THREE real, digest-pinned media servers, each holding THE SAME mount directory as its library root.
 *
 * WHAT IS DELIBERATELY ABSENT FROM IT, because their absence is half of what is being compared: there is no
 * manifest, no admitted generation, no publisher, no PostgreSQL and no `projectiond`. The naive path has none
 * of those, and standing them up beside it would be measuring something nobody would ever deploy.
 */
export const RCLONE_COMPARISON_TOPOLOGY: readonly string[] = Object.freeze([
  'a deterministic WebDAV endpoint serving the same ~50-entry corpus',
  'one read-only rclone mount of that endpoint, with a fresh VFS cache',
  'the ordinary read-only regular files that mount presents',
  'three real, digest-pinned media servers on that one mount directory',
]);

/**
 * G22 HAS NO PASS THRESHOLD, AS A VALUE A TEST CAN HOLD RATHER THAN A SENTENCE SOMEBODY COULD DELETE.
 *
 * The offline suite asserts that no comparative figure produced by this module is ever compared against a
 * ceiling, and that the gate's own report says so. See the header.
 */
export const COMPARISON_HAS_NO_PASS_THRESHOLD = true;

/**
 * ...AND IT IS A CONTROL RATHER THAN A CANDIDATE.
 *
 * `docs/ADR_002_PROJECTION_APPLIANCE.md` §2 rejected this topology as production architecture for reasons
 * that are unaffected by anything measured here: a provider URL space inside the media server's view, file
 * identity that is a function of a remote path, and an outage that empties the mount — which a media server
 * reads as a mass deletion. **A cheap number here would not reopen that decision, and an expensive one is not
 * what closed it.** The gate refuses any wording that presents the measurement as a recommendation.
 */
export const RCLONE_IS_A_TEST_CONTROL_NOT_A_CANDIDATE_FRONTEND = true;

// ---------------------------------------------------------------------------------------------------------
// The client's own bounds, configured rather than defaulted
// ---------------------------------------------------------------------------------------------------------

/**
 * THE MOUNT CLIENT'S TIMEOUTS, SET EXPLICITLY BY THE GATE AND NOT LEFT TO A DEFAULT.
 *
 * The barrier below blocks one response before its first byte. Whether that is a legitimate rendezvous or a
 * manufactured failure depends entirely on the client's own IO deadline: a hold longer than it turns "three
 * servers were observed scanning at once" into "the instrument broke a read and the servers were waiting on
 * a corpse". So the gate passes these to the mount rather than inheriting whatever the version in the pinned
 * image happens to default to, and the relation between them and the hold is machine-checked below.
 *
 * THEY ARE NOT TUNING AND THEY ARE NOT AN OPTIMISATION. They are wide — far wider than anything this corpus
 * needs — precisely so that no cost figure this gate reports can be attributed to a deadline it imposed.
 */
export const RCLONE_TIMEOUTS_MS = Object.freeze({
  /** `--timeout`: how long an IO operation may make no progress before the client abandons it. */
  IO_IDLE: 30_000,
  /** `--contimeout`: how long a connection attempt may take. */
  CONNECT: 10_000,
} as const);

/**
 * The rendezvous hold, REUSED FROM G18 RATHER THAN CHOSEN AGAIN, and the distinction matters.
 *
 * G22 says the same corpus is measured "the same way". The overlap evidence is only comparable with G18's if
 * the window in which the three scanners are held together is the same window, so these are that gate's own
 * constants imported — a future edit there moves both, and two spellings of one number cannot drift apart.
 *
 * WHAT IS *NOT* INHERITED IS THE ARGUMENT FOR THE BOUND. G18 derives its ceiling from the daemon's admission
 * limits, because held requests occupy the daemon's per-endpoint slots and a hold longer than the queue-wait
 * budget starves reads of objects it has nothing to do with. **This topology has no admission limiter at all**
 * — that is one of the things being compared — so the binding constraint here is the client's own IO deadline
 * instead, and `assertComparisonHoldChainIsFailClosed` checks that one rather than restating G18's.
 */
export const COMPARISON_HOLD_ARM_MS = HOLD_ARM_MS;
export const COMPARISON_HOLD_MAX_MS = HOLD_MAX_MS;

function assertComparisonHoldChainIsFailClosed(): void {
  if (!(COMPARISON_HOLD_ARM_MS > 0
    && COMPARISON_HOLD_ARM_MS + BARRIER_RELEASE_OVERSHOOT_MS <= COMPARISON_HOLD_MAX_MS)) {
    throw new Error(`the arm window (${COMPARISON_HOLD_ARM_MS}ms) plus the watchdog overshoot it must `
      + `tolerate (${BARRIER_RELEASE_OVERSHOOT_MS}ms) must fit inside the endpoint backstop `
      + `(${COMPARISON_HOLD_MAX_MS}ms), or the backstop fires before the gate releases and a correct run `
      + 'reports a lapsed hold');
  }
  if (!(COMPARISON_HOLD_MAX_MS < RCLONE_TIMEOUTS_MS.IO_IDLE)) {
    throw new Error(`the endpoint backstop (${COMPARISON_HOLD_MAX_MS}ms) must stay strictly below the mount `
      + `client's own IO deadline (${RCLONE_TIMEOUTS_MS.IO_IDLE}ms), or a held response fails the read it is `
      + 'holding and this gate manufactures the defect it claims to measure');
  }
}

assertComparisonHoldChainIsFailClosed();

// ---------------------------------------------------------------------------------------------------------
// The corpus, which has to be the SAME corpus
// ---------------------------------------------------------------------------------------------------------

/**
 * THE SHARED CORPUS'S SHAPE, so "the same corpus" is a checkable number rather than an intention.
 *
 * These are the counts `deploy/projection-three-server-concurrency-gate.sh` generates, and the offline suite
 * compares the two gates' generator bodies TEXTUALLY as well — because equal counts of differently generated
 * files would not be the same corpus, and every cost figure here would then be a comparison between two
 * different libraries.
 *
 * WHY THE LOCAL/REMOTE SPLIT IS RECORDED AND NOT REPRODUCED. The product's corpus has seven local passthrough
 * entries and forty-three behind the endpoint. **This topology has no such distinction**: everything a naive
 * mount presents comes from the remote, because there is nothing else for it to come from. So all fifty are
 * served over WebDAV here, and `PRODUCT_REMOTE_ENTRIES` exists so the report can also roll the same figures
 * up over just the subset the product treats as remote — the only sub-total for which the two sides are
 * comparing like with like.
 */
export const COMPARISON_CORPUS = Object.freeze({
  /** Generated corpus files, excluding the seed entry and the barrier fixture. */
  GENERATED_ENTRIES: 48,
  /** Of those, the ones the PRODUCT publishes as local passthrough. Served over WebDAV here regardless. */
  PRODUCT_LOCAL_ENTRIES: 6,
  /** The seed entry, visible before the reveal so a library can be created against a non-empty root. */
  SEED_ENTRIES: 1,
  /** The large barrier fixture, which is also the object whose read the rendezvous holds. */
  BARRIER_ENTRIES: 1,
  /** One registered object that is never inside the library root: the readiness canary. */
  NON_CORPUS_OBJECTS: 1,
} as const);

/** Every identity a media server is held against: the seed, the barrier fixture and the generated corpus. */
export const COMPARISON_CORPUS_ENTRIES =
  COMPARISON_CORPUS.SEED_ENTRIES + COMPARISON_CORPUS.BARRIER_ENTRIES + COMPARISON_CORPUS.GENERATED_ENTRIES;

/** The subset the product serves over its own endpoint: the barrier fixture plus the non-local generated. */
export const PRODUCT_REMOTE_ENTRIES =
  COMPARISON_CORPUS.BARRIER_ENTRIES
  + (COMPARISON_CORPUS.GENERATED_ENTRIES - COMPARISON_CORPUS.PRODUCT_LOCAL_ENTRIES);

// ---------------------------------------------------------------------------------------------------------
// Telemetry that has to be trustworthy before any figure over it means anything
// ---------------------------------------------------------------------------------------------------------

/**
 * The scalar counters a comparison window is computed from.
 *
 * WHY A FAIL-CLOSED PARSER RATHER THAN A CAST. `JSON.parse` answers `any`, and an `as WebdavCounters` over it
 * makes every missing field `undefined`, every arithmetic on it `NaN`, and every subsequent report a
 * confident table of `NaN`s — or worse, of zeros, which read as "the naive path cost nothing". The whole
 * point of this gate is the size of these numbers, so a document that cannot support them is refused rather
 * than rendered.
 */
export const WEBDAV_COUNTER_KEYS_REQUIRED = Object.freeze([
  'requests', 'accountedResponses', 'propfind', 'propfindDepth0', 'propfindDepth1', 'propfindOther',
  'options', 'head', 'gets', 'writeAttempts', 'rangedBodies', 'rangedBytes', 'fullBodies', 'fullBytes',
  'bodylessResponses', 'bytesServed', 'metadataBytes', 'served429', 'peakConns', 'peakConcurrent',
  'heldRequests', 'currentHeldWaiters', 'holdTimeouts',
] as const);

/**
 * The counters that may never fall between two snapshots of ONE endpoint process.
 *
 * `currentHeldWaiters` is the one live GAUGE and is deliberately excluded: it rises and falls by design, and
 * requiring it to be monotonic would fail every correct run.
 */
export const MONOTONIC_WEBDAV_COUNTER_KEYS: readonly string[] = Object.freeze(
  WEBDAV_COUNTER_KEYS_REQUIRED.filter((key) => key !== 'currentHeldWaiters'),
);

/** The per-object columns, paired BY INDEX, which is why they must all be the same length. */
export const WEBDAV_COUNTER_ARRAY_KEYS = Object.freeze([
  'objectSizes', 'objectBytes', 'objectGets', 'objectRanged', 'objectFull',
] as const);

export interface WebdavCounters {
  readonly requests: number;
  readonly accountedResponses: number;
  readonly propfind: number;
  readonly propfindDepth0: number;
  readonly propfindDepth1: number;
  readonly propfindOther: number;
  readonly options: number;
  readonly head: number;
  readonly gets: number;
  readonly writeAttempts: number;
  readonly rangedBodies: number;
  readonly rangedBytes: number;
  readonly fullBodies: number;
  readonly fullBytes: number;
  readonly bodylessResponses: number;
  readonly bytesServed: number;
  readonly metadataBytes: number;
  readonly served429: number;
  readonly peakConns: number;
  readonly peakConcurrent: number;
  readonly heldRequests: number;
  readonly currentHeldWaiters: number;
  readonly holdTimeouts: number;
  readonly objectSizes: readonly number[];
  readonly objectBytes: readonly number[];
  readonly objectGets: readonly number[];
  readonly objectRanged: readonly number[];
  readonly objectFull: readonly number[];
  /** Whether the corpus was visible when the snapshot was taken. See `comparisonColdStateProblems`. */
  readonly revealed: boolean;
}

export interface TelemetryProblem {
  readonly kind: string;
  readonly detail: string;
}

/** Read one counters document, refusing anything a figure could not honestly be derived from. */
export function parseWebdavCounters(
  value: unknown, label: string,
): { counters?: WebdavCounters; problems: TelemetryProblem[] } {
  const problems: TelemetryProblem[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      problems: [{
        kind: 'missing-telemetry',
        detail: `the ${label} counters document is not an object, so nothing can be measured from it`,
      }],
    };
  }
  const document = value as Record<string, unknown>;
  const scalars: Record<string, number> = {};
  for (const key of WEBDAV_COUNTER_KEYS_REQUIRED) {
    const raw = document[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
      problems.push({
        kind: 'missing-telemetry',
        detail: `the ${label} snapshot has no usable "${key}" counter (${JSON.stringify(raw)}); a comparison `
          + 'figure read through a forgiving parser would report zero cost for a measurement that never happened',
      });
      continue;
    }
    scalars[key] = raw;
  }
  const arrays: Record<string, number[]> = {};
  for (const key of WEBDAV_COUNTER_ARRAY_KEYS) {
    const raw = document[key];
    // WHOLE MEANS WHOLE. A fractional per-object count compares perfectly well against anything, so a column
    // of 4.5 requests would flow through every roll-up below and appear in a report as a fact.
    if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'number'
      || !Number.isFinite(entry) || !Number.isInteger(entry) || entry < 0)) {
      problems.push({
        kind: 'missing-telemetry',
        detail: `the ${label} snapshot's "${key}" is not an array of whole non-negative counts, so per-object `
          + 'attribution cannot be checked and an aggregate figure could be hiding one object read whole',
      });
      continue;
    }
    arrays[key] = raw as number[];
  }
  if (typeof document.revealed !== 'boolean') {
    problems.push({
      kind: 'missing-telemetry',
      detail: `the ${label} snapshot does not say whether the corpus was revealed, so "nothing was read" `
        + 'cannot be told apart from "there was nothing to read"',
    });
  }
  if (problems.length > 0) return { problems };
  return {
    counters: { ...scalars, ...arrays, revealed: document.revealed as boolean } as unknown as WebdavCounters,
    problems: [],
  };
}

/**
 * Everything that makes a pair of counter snapshots unfit to compute a comparison from.
 *
 * WHAT EACH REFUSAL IS FOR:
 *
 *   RESET. Any cumulative counter lower after than before. The endpoint restarted inside the window, so the
 *     two readings describe different processes and their difference describes neither — and a NEGATIVE delta
 *     is exactly how a topology under test comes out looking cheap.
 *   REQUEST PARTITION. `ranged + full + bodyless == accountedResponses`, on both snapshots. The endpoint's own
 *     statement that every request it accounted for landed in exactly one bucket.
 *   BYTE PARTITION. `rangedBytes + fullBytes == bytesServed`, likewise.
 *   ATTRIBUTION. `sum(objectBytes) == bytesServed`, and the same for the two request columns. A shortfall
 *     means a body was served for something this gate never registered, which is the only way "every byte
 *     belongs to the shared corpus" can fail invisibly.
 *   ARRAY GEOMETRY. Every per-object column must have one entry per registered object; a caller pairs them by
 *     index, and columns of different lengths make index i mean two different objects.
 *   SIZE STABILITY, per ordinal. `objectSizes[i]` is the only description of an object these columns carry.
 *     If it moved, the ordinal is describing something else and every per-object figure derived from it
 *     belongs to a different file — which also catches a REORDER, for every pair whose sizes differ.
 *   PER-OBJECT MONOTONICITY, on every cumulative column. The aggregates survive a per-object reset that is
 *     compensated elsewhere: drop ordinal 7 to zero and raise ordinal 8 by the same amount, and every sum,
 *     every partition and every total is unchanged while ordinal 7's window delta is negative.
 *   WRITES. A read-only mount that issued a mutating request is a finding, not a nuisance.
 */
export function webdavAttributionProblems(
  before: WebdavCounters, after: WebdavCounters, expectedObjects: number,
): TelemetryProblem[] {
  const problems: TelemetryProblem[] = [];
  const raw = (snapshot: WebdavCounters): Record<string, number> =>
    snapshot as unknown as Record<string, number>;

  for (const key of MONOTONIC_WEBDAV_COUNTER_KEYS) {
    const from = raw(before)[key] as number;
    const to = raw(after)[key] as number;
    if (to < from) {
      problems.push({
        kind: 'counter-reset',
        detail: `"${key}" fell from ${from} to ${to} across the window, which only happens when the endpoint `
          + 'process restarted inside it; the two readings describe different processes',
      });
    }
  }

  for (const [label, snapshot] of [['before', before], ['after', after]] as const) {
    if (snapshot.rangedBodies + snapshot.fullBodies + snapshot.bodylessResponses
      !== snapshot.accountedResponses) {
      problems.push({
        kind: 'request-partition',
        detail: `the ${label} snapshot accounts for ${snapshot.accountedResponses} responses but its buckets `
          + `sum to ${snapshot.rangedBodies + snapshot.fullBodies + snapshot.bodylessResponses}`,
      });
    }
    if (snapshot.rangedBytes + snapshot.fullBytes !== snapshot.bytesServed) {
      problems.push({
        kind: 'byte-partition',
        detail: `the ${label} snapshot served ${snapshot.bytesServed} media bytes but its buckets sum to `
          + `${snapshot.rangedBytes + snapshot.fullBytes}`,
      });
    }
    const columns: ReadonlyArray<readonly [string, readonly number[]]> = [
      ['objectSizes', snapshot.objectSizes], ['objectBytes', snapshot.objectBytes],
      ['objectGets', snapshot.objectGets], ['objectRanged', snapshot.objectRanged],
      ['objectFull', snapshot.objectFull],
    ];
    for (const [name, column] of columns) {
      if (!Array.isArray(column) || column.length !== expectedObjects) {
        problems.push({
          kind: 'array-geometry',
          detail: `the ${label} snapshot's ${name} has ${Array.isArray(column) ? column.length : 'no'} `
            + `entries, not the ${expectedObjects} objects this gate registered`,
        });
      }
    }
    const sum = (column: readonly number[]): number => column.reduce((total, value) => total + value, 0);
    if (sum(snapshot.objectBytes) !== snapshot.bytesServed) {
      problems.push({
        kind: 'unattributed-bytes',
        detail: `the ${label} snapshot served ${snapshot.bytesServed} media bytes but attributes `
          + `${sum(snapshot.objectBytes)} to registered objects; the difference was served for something this `
          + 'gate never published',
      });
    }
    if (sum(snapshot.objectRanged) !== snapshot.rangedBodies
      || sum(snapshot.objectFull) !== snapshot.fullBodies) {
      problems.push({
        kind: 'unattributed-requests',
        detail: `the ${label} snapshot's per-object request columns sum to `
          + `${sum(snapshot.objectRanged)} ranged and ${sum(snapshot.objectFull)} full, against aggregates of `
          + `${snapshot.rangedBodies} and ${snapshot.fullBodies}`,
      });
    }
    if (sum(snapshot.objectGets) !== snapshot.rangedBodies + snapshot.fullBodies) {
      problems.push({
        kind: 'unattributed-requests',
        detail: `the ${label} snapshot attributes ${sum(snapshot.objectGets)} served GETs to objects, against `
          + `${snapshot.rangedBodies + snapshot.fullBodies} bodies it accounted for`,
      });
    }
  }

  if (after.writeAttempts !== 0) {
    problems.push({
      kind: 'write-attempted',
      detail: `${after.writeAttempts} mutating WebDAV request(s) reached the endpoint. The mount is read-only `
        + 'and so is the endpoint, so a client that tried is a finding about this topology rather than noise',
    });
  }

  // A geometry failure means the columns cannot be paired by index at all, and every elementwise check below
  // would be comparing objects that are not the same object. Stop rather than pile on.
  if (problems.some((problem) => problem.kind === 'array-geometry')) return problems;

  for (let ordinal = 0; ordinal < after.objectSizes.length; ordinal += 1) {
    const sizeBefore = before.objectSizes[ordinal] as number;
    const sizeAfter = after.objectSizes[ordinal] as number;
    if (sizeBefore !== sizeAfter) {
      problems.push({
        kind: 'object-identity-moved',
        detail: `object #${ordinal} was ${sizeBefore} bytes in the before snapshot and ${sizeAfter} in the `
          + 'after one. Registration ordinals are the only handle these columns carry, so a size that moved '
          + 'means the ordinal is describing a different file',
      });
    }
  }
  const cumulative: ReadonlyArray<readonly [string, readonly number[], readonly number[]]> = [
    ['objectBytes', before.objectBytes, after.objectBytes],
    ['objectGets', before.objectGets, after.objectGets],
    ['objectRanged', before.objectRanged, after.objectRanged],
    ['objectFull', before.objectFull, after.objectFull],
  ];
  for (const [name, from, to] of cumulative) {
    for (let ordinal = 0; ordinal < to.length; ordinal += 1) {
      if ((to[ordinal] as number) < (from[ordinal] as number)) {
        problems.push({
          kind: 'per-object-counter-reset',
          detail: `${name}[${ordinal}] fell from ${from[ordinal]} to ${to[ordinal]} across the window. These `
            + 'are lifetime totals within one endpoint process, and a negative per-object delta makes a '
            + 'topology look cheap by arithmetic while every aggregate partition stays intact',
        });
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------
// Cold state
// ---------------------------------------------------------------------------------------------------------

export interface ColdComparisonProblem {
  readonly kind: string;
  readonly detail: string;
}

/**
 * Everything that makes a comparison window incapable of describing what a scan of this corpus costs.
 *
 * THE CHEAT THIS CLOSES IS THE SAME ONE G18 IS EXPOSED TO AND THE MECHANISM IS DIFFERENT. There, a warm
 * scan-window cache in the daemon makes a re-scan cost the provider nothing. Here it is the mount client's
 * own VFS and directory caches: a corpus that had already been listed and read would be answered out of them,
 * the endpoint would see almost nothing, and the naive path would be reported as costing almost nothing —
 * the exact opposite of what this control exists to record, and far more embarrassing than an expensive
 * number.
 *
 * FIVE THINGS ARE REQUIRED, AND EACH CLOSES A DIFFERENT HALF:
 *
 *   THE CORPUS WAS REVEALED. Without this, "no corpus byte was served beforehand" is satisfied by a run in
 *     which the corpus was never there — and a scan of an empty library is cheap, correct and worthless.
 *   NO CORPUS BYTE HAD EVER BEEN SERVED. The endpoint's own per-object totals, before the window. This is the
 *     load-bearing one: a client cannot answer from a cache it never filled.
 *   THE CLIENT'S CACHE DIRECTORY WAS EMPTY. The second, independent instrument, on the other side of the
 *     wire, so one broken one cannot carry the claim.
 *   THE WINDOW REACHED THE ENDPOINT AT LEAST ONCE PER CORPUS OBJECT. A floor, not a ceiling. A window that
 *     issued fewer GETs than there are objects did not read the corpus, whatever else it did.
 *   A REQUEST WAS ACTUALLY BLOCKED AT THE BARRIER, AND NO HOLD LAPSED. The first says the scanners really
 *     were waiting on the endpoint rather than on a cache; the second says the rendezvous PAUSED a read
 *     rather than breaking one.
 */
export function comparisonColdStateProblems(input: {
  readonly revealedBefore: boolean;
  readonly corpusBytesBefore: number;
  readonly clientCacheBytesBefore: number;
  readonly getDelta: number;
  readonly corpusObjectCount: number;
  readonly heldRequestDelta: number;
  readonly holdTimeoutDelta: number;
}): ColdComparisonProblem[] {
  const problems: ColdComparisonProblem[] = [];
  if (!input.revealedBefore) {
    problems.push({
      kind: 'corpus-not-revealed',
      detail: 'the corpus was not visible at the endpoint when the window opened, so a window that served '
        + 'nothing would be a scan of an empty library rather than a cold scan of the corpus',
    });
  }
  if (input.corpusBytesBefore !== 0) {
    problems.push({
      kind: 'corpus-already-read',
      detail: `${input.corpusBytesBefore} bytes of the shared corpus had already been served before the `
        + 'window opened, so this is not the corpus\'s first read and its cost is not what a cold scan costs',
    });
  }
  if (input.clientCacheBytesBefore !== 0) {
    problems.push({
      kind: 'client-cache-not-empty',
      detail: `the mount client's cache directory held ${input.clientCacheBytesBefore} bytes before the `
        + 'window. A populated VFS cache answers reads without reaching the endpoint at all, which would '
        + 'report the naive path as costing a fraction of what it costs',
    });
  }
  if (input.getDelta < input.corpusObjectCount) {
    problems.push({
      kind: 'no-cold-traffic',
      detail: `the window issued ${input.getDelta} GETs for ${input.corpusObjectCount} corpus objects; a cold `
        + 'scan must reach the endpoint at least once for each of them, and a window that did not was '
        + 'answering from a cache',
    });
  }
  if (input.heldRequestDelta < 1) {
    problems.push({
      kind: 'barrier-never-hit',
      detail: 'no request ever entered the barrier hold, so no scanner was observed waiting on the endpoint '
        + 'and the rendezvous did nothing',
    });
  }
  if (input.holdTimeoutDelta !== 0) {
    problems.push({
      kind: 'hold-lapsed',
      detail: `${input.holdTimeoutDelta} barrier hold(s) lapsed instead of being released, so a read was `
        + 'stalled for the whole hold budget and the scan it belonged to was degraded by the instrument '
        + 'rather than measured by it',
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------
// The measurement itself — produced, reported, and asserted on by nothing
// ---------------------------------------------------------------------------------------------------------

export interface ObjectCost {
  readonly ordinal: number;
  readonly sizeBytes: number;
  readonly servedBytes: number;
  readonly gets: number;
  readonly rangedGets: number;
  readonly fullGets: number;
  /** Served bytes as a multiple of the object's own length. The headline per-object figure. */
  readonly multiplier: number;
}

export interface ComparisonMeasurements {
  /** Every GET the endpoint served a body for, split by whether the client sent a Range header. */
  readonly gets: number;
  readonly rangedGets: number;
  readonly fullGets: number;
  /** Metadata traffic: the calls a namespace costs when it is discovered rather than published. */
  readonly propfind: number;
  readonly propfindDepth0: number;
  readonly propfindDepth1: number;
  readonly propfindOther: number;
  readonly options: number;
  readonly head: number;
  /** Media bytes. Metadata bytes are counted separately and are never folded into this. */
  readonly bytesServed: number;
  readonly metadataBytes: number;
  readonly served429: number;
  readonly peakConns: number;
  readonly peakConcurrent: number;
  readonly writeAttempts: number;
  /** Bytes served for objects inside the shared corpus, and for everything else, as an exact partition. */
  readonly corpusBytes: number;
  readonly nonCorpusBytes: number;
  readonly unattributedBytes: number;
  /** Per-object costs, worst multiplier first, so a report names the file rather than the total. */
  readonly perObject: readonly ObjectCost[];
  /** How many corpus objects the window touched at all. A ceiling is satisfied by zero; this is not. */
  readonly objectsExercised: number;
  /** Corpus bytes divided by the corpus's own total length. The single most comparable number here. */
  readonly corpusMultiplier: number;
  /** The same, over just the subset the product serves from its own endpoint. See `PRODUCT_REMOTE_ENTRIES`. */
  readonly productComparableBytes: number;
  readonly productComparableGets: number;
}

/**
 * Turn two counter snapshots into what the naive path cost, per object and in total.
 *
 * NOTHING IN HERE IS COMPARED AGAINST ANYTHING. Every field is a measurement, and the caller reports them.
 * The one place a threshold would be natural — a per-object multiplier — is exactly where one would do the
 * most damage: an object read forty times over is the FINDING, and a gate that failed on it would be a gate
 * nobody could run to produce the finding.
 *
 * `firstCorpusOrdinal` IS A REGISTRATION-ORDER BOUNDARY AND NOT A NAME. The endpoint's columns carry no path
 * by design; what they carry is the order the gate registered its objects in, and the gate registers the
 * canary and the seed before the corpus so the boundary is a number both sides agree on without the endpoint
 * ever reporting a path.
 *
 * `productComparableOrdinals` NAMES THE SUBSET THE TWO SIDES CAN BE COMPARED OVER. All fifty entries are
 * remote on this topology and only forty-three are on the product's, so a total-against-total comparison
 * would be charging the naive path for seven files the product never fetches. Both are reported.
 */
export function comparisonMeasurements(
  before: WebdavCounters, after: WebdavCounters,
  firstCorpusOrdinal: number,
  productComparableOrdinals: readonly number[],
): ComparisonMeasurements {
  const delta = (a: readonly number[], b: readonly number[], index: number): number =>
    (a[index] ?? 0) - (b[index] ?? 0);
  const perObject: ObjectCost[] = [];
  let corpusBytes = 0;
  let nonCorpusBytes = 0;
  let objectsExercised = 0;
  let corpusSizeTotal = 0;
  for (let ordinal = 0; ordinal < after.objectBytes.length; ordinal += 1) {
    const size = after.objectSizes[ordinal] as number;
    const served = delta(after.objectBytes, before.objectBytes, ordinal);
    const gets = delta(after.objectGets, before.objectGets, ordinal);
    const ranged = delta(after.objectRanged, before.objectRanged, ordinal);
    const full = delta(after.objectFull, before.objectFull, ordinal);
    if (ordinal >= firstCorpusOrdinal) {
      corpusBytes += served;
      corpusSizeTotal += size;
      if (gets > 0) objectsExercised += 1;
    } else {
      nonCorpusBytes += served;
    }
    perObject.push({
      ordinal, sizeBytes: size, servedBytes: served, gets, rangedGets: ranged, fullGets: full,
      multiplier: size > 0 ? served / size : 0,
    });
  }
  const totalBytes = after.bytesServed - before.bytesServed;
  const comparable = new Set(productComparableOrdinals);
  let productComparableBytes = 0;
  let productComparableGets = 0;
  for (const cost of perObject) {
    if (!comparable.has(cost.ordinal)) continue;
    productComparableBytes += cost.servedBytes;
    productComparableGets += cost.gets;
  }
  return {
    gets: (after.rangedBodies + after.fullBodies) - (before.rangedBodies + before.fullBodies),
    rangedGets: after.rangedBodies - before.rangedBodies,
    fullGets: after.fullBodies - before.fullBodies,
    propfind: after.propfind - before.propfind,
    propfindDepth0: after.propfindDepth0 - before.propfindDepth0,
    propfindDepth1: after.propfindDepth1 - before.propfindDepth1,
    propfindOther: after.propfindOther - before.propfindOther,
    options: after.options - before.options,
    head: after.head - before.head,
    bytesServed: totalBytes,
    metadataBytes: after.metadataBytes - before.metadataBytes,
    served429: after.served429 - before.served429,
    // PEAKS ARE HIGH-WATER MARKS AND NOT DELTAS. Subtracting two peaks produces a number that is neither the
    // peak in the window nor anything else; the whole-run peak is the honest reading and is reported as one.
    peakConns: after.peakConns,
    peakConcurrent: after.peakConcurrent,
    writeAttempts: after.writeAttempts - before.writeAttempts,
    corpusBytes,
    nonCorpusBytes,
    unattributedBytes: totalBytes - corpusBytes - nonCorpusBytes,
    perObject: [...perObject].sort((a, b) => b.multiplier - a.multiplier),
    objectsExercised,
    corpusMultiplier: corpusSizeTotal > 0 ? corpusBytes / corpusSizeTotal : 0,
    productComparableBytes,
    productComparableGets,
  };
}

// ---------------------------------------------------------------------------------------------------------
// What cannot be measured here, said before anybody asks
// ---------------------------------------------------------------------------------------------------------

/**
 * WHY THERE IS NO RESOLUTION-CALL FIGURE, AND WHY THAT IS A FINDING RATHER THAN A GAP.
 *
 * G14b counts ACCESS-RESOLUTION requests: the product's manifest names a stable object reference, and the
 * daemon exchanges it for short-lived access material under `docs/PROJECTION_PHASE_0_PRODUCT_CONTRACT.md`
 * §7.6. **This topology has no such step, because it has no such indirection**: the namespace IS the URL
 * space, and a media server's view contains the path the bytes come from. So the comparable figure is not
 * zero — it is ABSENT, and the reason it is absent is precisely the property ADR 002 rejected the topology
 * for. Reporting "0 resolutions" would read as an efficiency.
 */
export const RESOLUTION_CALLS_DO_NOT_EXIST_ON_THIS_TOPOLOGY = true;

/**
 * WHAT THE ENDPOINT'S NUMBERS ARE ABOUT, AND WHAT THEY ARE NOT ABOUT.
 *
 * Everything this gate counts is measured AT THE WEBDAV SERVER: it is what the mount client asked for. That
 * is not the same as what the client did — the client's own cache, its read-ahead, its chunk sizing and its
 * request pacing all sit between a media server's `read()` and a request arriving here, and a byte the client
 * fetched and threw away is indistinguishable at this end from one it used. So the client's OWN accounting is
 * read too, from its remote-control surface, and the two are reported side by side. **Where they disagree,
 * the disagreement is the finding**, and neither is corrected to match the other.
 */
export const WEBDAV_SERVER_TRAFFIC_IS_NOT_CLIENT_BEHAVIOUR = true;

/**
 * WHY NO BYTE HERE IS ATTRIBUTED TO A MEDIA SERVER, EXACTLY AS IN G18.
 *
 * Three media servers read ONE mount served by ONE client process. Every request the endpoint sees originates
 * from that client, so the per-object columns say which FILE a byte belonged to and nothing about which
 * server caused it. A report that named one media server's own byte cost would be inventing a number.
 *
 * WHAT IS PER-SERVER: the catalogue evidence — each server's own listing, at the published sizes, through its
 * own ordinary-file predicate — and the overlap evidence, which is per-server by construction.
 */
export const PER_SERVER_ATTRIBUTION_IS_IMPOSSIBLE_HERE = true;

/** How many media servers share the one mount. Imported so the two gates cannot disagree about "three". */
export const COMPARISON_SERVER_COUNT = REQUIRED_SERVER_COUNT;

/**
 * THE NONCLAIMS, AS DATA RATHER THAN AS A PARAGRAPH SOMEBODY MIGHT SOFTEN.
 *
 * The gate emits every one of these at the end of every passing run, and the offline suite asserts that the
 * gate's own closing text contains them — so an edit that quietly turns a measurement into a recommendation,
 * or a Docker Desktop run into closure, fails a test rather than a review.
 */
export const RCLONE_COMPARISON_NONCLAIMS: readonly string[] = Object.freeze([
  'this is a COMPARISON CONTROL and not an architecture: nothing measured here recommends rclone or WebDAV, '
    + 'and ADR 002 rejected that topology for reasons no cost figure changes',
  'G22 has NO pass threshold, so no figure here is a pass or a failure; what fails closed is the '
    + 'instrumentation, never the cost',
  'a Docker Desktop pass is not Linux or Unraid closure and closes none of G7-G13, G18 or G22',
  'no run of this gate has ever happened on a real Linux or Unraid host',
  'no real provider endpoint has ever been contacted; the WebDAV endpoint is the in-repository fake',
  'per-server attribution is impossible here and is not claimed: one mount client serves all three servers, '
    + 'so the endpoint sees the client and never the server behind a byte',
  'the figures are what the endpoint was ASKED for; the mount client\'s own accounting is reported beside '
    + 'them and is a different measurement',
  'there is no access-resolution figure because this topology has no resolution step, which is a property of '
    + 'it rather than an efficiency of it',
  'nothing here decodes anything: playback, seek-under-load and transcode belong to G8-G10 and are not run '
    + 'on this topology',
  'Phase 1 remains open',
]);
