// Projection Phase 1 — G18, the three-media-server high-concurrency scan, as rules rather than as prose.
//
// WHAT G18 ACTUALLY SAYS. `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §5: "All three servers scanning
// simultaneously: G14a–G17 still hold, unchanged." Two halves, and the second is the easy one — G14a–G17 are
// already code, already imported by three drivers, and this file does not restate a single one of them. The
// hard half is the word SIMULTANEOUSLY, which is not a budget and cannot be asserted by measuring traffic.
//
// WHY THIS IS A SEPARATE FILE FROM `media-server-dataplane.ts`. That one is the rules ONE media server is
// held to, and all three drivers import it. Nothing in it can express a property of a SET of servers: whether
// two scans overlapped is not visible to anything that watches one server, exactly as `analyseSeekSet` exists
// because no per-seek assertion can see that ten seeks were ten different seeks. This is that shape of
// function for concurrency.
//
// THE ONE THING EVERY ASSERTION HERE EXISTS TO REFUSE: THREE SEQUENTIAL SCANS PRESENTED AS THREE CONCURRENT
// ONES. Starting three commands in quick succession, or observing that three scans happened during one
// window, or measuring that the provider's counters moved, are all satisfied perfectly by a gate that scanned
// Jellyfin, then Plex, then Emby. `analyseOverlap` is built so that the number a gate reports —
// `simultaneousSamples` — is ZERO for that run and cannot be anything else.
//
// IT IS PURE. No socket, no clock, no filesystem. Every rule here is checkable offline against a scripted
// timeline, including the timelines that are awkward to produce against three real media servers: the
// sequential one, the two-of-three one, the one where a server was in flight for a single sample.

// ---------------------------------------------------------------------------------------------------------
// Who is in the room
// ---------------------------------------------------------------------------------------------------------

/**
 * The three media servers, named once.
 *
 * THE ORDER IS ALPHABETICAL AND CARRIES NO MEANING. In particular it is NOT a scan order: every scan in this
 * gate is triggered in parallel, and a list that looked like a sequence would be the first place somebody
 * reintroduced one.
 */
export const THREE_SERVER_IDS = Object.freeze(['emby', 'jellyfin', 'plex'] as const);

export type ThreeServerId = (typeof THREE_SERVER_IDS)[number];

/** How many distinct media servers G18 is about. Three, and the plan says three. */
export const REQUIRED_SERVER_COUNT = THREE_SERVER_IDS.length;

/**
 * THE THREE SERVERS ARE DRIVEN BY THEIR OWN DRIVERS, AND THAT IS A RULE RATHER THAN AN IMPLEMENTATION NOTE.
 *
 * Emby's bootstrap cannot key on `StartupWizardCompleted` because this server never sends one; Plex has no
 * first-run wizard at all, refuses a request whose `Host` header it does not recognise, and reports scan
 * progress through `refreshing`/`activities` rather than through a scheduled task; Jellyfin's ordinary-file
 * predicate reads `LocationType`, which Emby omits even when asked. Six of the Jellyfin gate's behavioural
 * conclusions were measured FALSE for Emby and are recorded in `docs/PROJECTION_PHASE_1_EMBY_DATA_PLANE.md`.
 *
 * A combined gate that re-implemented "bootstrap a media server" once would have had to pick one of those
 * three sets of semantics, and whichever it picked, two of the three columns in the acceptance plan's §6.1
 * would silently stop being about the server they name. So this gate composes the three existing drivers and
 * adds only what none of them can have: the overlap.
 */
export const SERVER_SEMANTICS_ARE_NOT_FLATTENED = true;

// ---------------------------------------------------------------------------------------------------------
// Deadlines and rules
// ---------------------------------------------------------------------------------------------------------

export const CONCURRENCY_DEADLINES_MS = Object.freeze({
  /**
   * How long the observer waits for a sample in which EVERY server is in flight at once.
   *
   * It is bounded and it is not retried. A gate that looped until the timing happened to work would be a coin
   * flip with a loop around it, which is precisely what this file exists to refuse.
   */
  OVERLAP_OBSERVATION: 300_000,
  /** All three concurrent scans, from the triggers to the last one settling. */
  CONCURRENT_SCAN: 900_000,
  /** One server's library scan, driven by its own driver, inside the concurrent window. */
  PER_SERVER_SCAN: 600_000,
  /** Standing all three servers up, in parallel, from cold containers. */
  BOOTSTRAP_ALL: 420_000,
  /**
   * One tick of the observer. Fine enough to see a short overlap, coarse enough not to be a request storm.
   *
   * FIVE HUNDRED MILLISECONDS BUYS MARGIN AND NOTHING ELSE. The floors it feeds are a COUNT and a SPAN, and
   * only the count moves with the tick rate: a two-second overlap is two seconds however often it is looked
   * at. Sampling faster does not make a short overlap pass — the span floor is what stops that — it stops a
   * genuine overlap being missed for want of looking. The first real run measured a three-way overlap of two
   * samples at 750 ms, which is the shape of failure this rate exists to avoid.
   */
  SAMPLE_INTERVAL: 500,
  /**
   * How long ONE tick's three polls may take before the tick stops being evidence of SIMULTANEITY.
   *
   * A TICK IS NOT AN INSTANT AND PRETENDING OTHERWISE IS THE SUBTLEST WAY THIS GATE COULD LIE. The observer
   * asks three servers at once, but the three answers arrive at three different moments; if the slowest took
   * thirty seconds, "all three said Running in this tick" is compatible with the first having finished before
   * the last was even asked. So each tick records the wall span across its own three answers, and a tick
   * wider than this is recorded as IMPRECISE and cannot count toward the simultaneous total.
   */
  SAMPLE_MAX_SPAN: 2_000,
} as const);

/**
 * HOW LONG A PROVIDER READ MAY BE HELD, AND WHY BOTH NUMBERS ARE DERIVED RATHER THAN CHOSEN.
 *
 * The hold is how this gate stops being lucky: it blocks the daemon's read of one barrier object, so a
 * scanner that reaches that object STAYS in flight instead of racing to the end while the other two are still
 * starting. Each server arrives at the barrier at its own pace and then waits, which turns "all three
 * happened to be scanning at once" into a rendezvous.
 *
 * IT CANNOT BE LONG, AND TWO DIFFERENT DAEMON CONSTANTS BOUND IT — a hold that respected only one of them
 * would still make this gate manufacture the defect it claims to measure:
 *
 *   `PROJECTIOND_READ_POLICY.FIRST_BYTE_DEADLINE_MS` (10 s) bounds the HELD REQUEST ITSELF. A held response
 *     that has not begun by then is abandoned and the read FAILS, so a media server would catalogue a file
 *     it could not open. `HOLD_MAX_MS` is half of it.
 *
 *   `PROJECTIOND_ADMISSION_LIMITS.MAX_QUEUE_WAIT_MS` (5 s) bounds EVERY OTHER READ. The daemon admits at
 *     most `PER_ENDPOINT_MAX_INFLIGHT_REQUESTS` provider requests at once; held requests occupy those slots,
 *     and a read that cannot get one inside the queue-wait budget returns EIO. So the window in which
 *     anything is actually blocked must be STRICTLY SHORTER than that budget, or the hold starves reads of
 *     objects it has nothing to do with — and forty-nine other entries would be mis-catalogued because of an
 *     instrument. `HOLD_ARM_MS` is one second under it.
 *
 * THE ARM WINDOW STARTS WHEN A REQUEST FIRST BLOCKS, NOT WHEN THE HOLD IS ARMED. An armed hold that nothing
 * has reached costs nothing and starves nobody, so it stays armed until a scanner actually arrives; only then
 * does the clock that bounds the blocking start. Timing it from the arming instead would have made the hold
 * expire before the first scanner got there on a slow host — the gate would then assert that no provider
 * request was ever held and fail for having been too careful.
 *
 * WHAT THE HOLD IS THEREFORE NOT. It is not the evidence. Four seconds is not long enough to guarantee a
 * three-way rendezvous on a slow host, and a gate whose concurrency claim rested on it would be claiming
 * something it cannot always produce. The evidence is `simultaneousSamples`: direct observation of all three
 * servers' own in-flight state at one instant. The hold makes that observation likelier and makes the scans
 * provably COLD; it does not make the claim.
 */
export const HOLD_ARM_MS = 4_000;

/** What the endpoint is told. Half the daemon's first-byte deadline, and above `HOLD_ARM_MS`. */
export const HOLD_MAX_MS = 5_000;

export const CONCURRENCY_RULES = Object.freeze({
  /**
   * Samples in which EVERY server was in flight at the same instant.
   *
   * THREE, NOT ONE. A single sample is a point, and a point can be produced by two servers whose scans
   * touched at the edges — one finishing as another starts — which is the closest thing to sequential that
   * still technically overlaps. Three samples at the observer's tick rate mean the overlap had duration.
   */
  MIN_SIMULTANEOUS_SAMPLES: 3,
  /**
   * ...and how long that overlap must have lasted end to end.
   *
   * MEASURED BETWEEN THE FIRST AND LAST SIMULTANEOUS SAMPLE, so a burst of three samples inside one tick
   * cannot satisfy both this and the count. Two seconds is not a lot; it does not need to be. What it rules
   * out is an instantaneous graze, not a short scan.
   */
  MIN_SIMULTANEOUS_SPAN_SECONDS: 2,
  /**
   * Every server must have been observed in flight at some point, by this observer.
   *
   * IT IS NOT IMPLIED BY THE SIMULTANEOUS COUNT AND IS CHECKED SEPARATELY ANYWAY, because the two fail
   * differently and a gate that reported only the conjunction would say "no overlap" when the truth was "one
   * server never scanned at all".
   */
  MIN_SERVERS_OBSERVED_IN_FLIGHT: REQUIRED_SERVER_COUNT,
  /**
   * How far apart the three scan triggers may land.
   *
   * A LOOSE CEILING ON PURPOSE. Triggering is three HTTP requests fired together; a spread of seconds means
   * something is wrong with the harness, not with the data plane. It is here so that "we started them
   * together" is a measurement rather than a description of the code — but it is deliberately NOT the
   * concurrency evidence, because three triggers landing inside a second says nothing at all about whether
   * the three scans then overlapped.
   */
  MAX_TRIGGER_SPREAD_SECONDS: 15,
} as const);

/**
 * WHY A TRIGGER SPREAD IS NOT EVIDENCE OF CONCURRENCY, STATED AS A CONSTANT SO A TEST CAN HOLD IT.
 *
 * The cheapest way to write this gate is to fire three scans in a loop, notice that the loop took 200 ms, and
 * call the result concurrent. Every server would still be free to scan sequentially — a fast one could
 * finish before a slow one started — and the gate would report a concurrency it never observed. The trigger
 * spread is recorded because a large one indicates a broken harness; the claim rests on `overlapProblems`.
 */
export const TRIGGER_SPREAD_IS_NOT_OVERLAP_EVIDENCE = true;

// ---------------------------------------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------------------------------------

/**
 * One tick of the observer: the moment, and what every server said about itself at that moment.
 *
 * `inFlight` IS THE SERVER'S OWN PRESENT-TENSE ANSWER, obtained from each driver's own `scanIsRunningNow` —
 * `Running`/`Cancelling` on the two MediaBrowser-family servers, `refreshing` or an outstanding library
 * activity on Plex. It is never derived from "we asked it to scan and have not seen it finish", because that
 * inference is true of a scan that ended between two polls.
 *
 * `unreadable` NAMES THE SERVERS WHOSE SAMPLE FAILED, and they are not the same as servers that answered
 * "not scanning". A poll that could not be made is not an observation, and folding it into `false` would let
 * an unreachable server look like an idle one — which matters here because an idle server is a FAILURE of
 * this gate and an unreachable one is a broken run.
 */
export interface OverlapSample {
  readonly atMs: number;
  /**
   * Wall milliseconds from the first of this tick's answers to the last.
   *
   * See `CONCURRENCY_DEADLINES_MS.SAMPLE_MAX_SPAN`. A tick wider than that ceiling is not an observation of
   * one instant and cannot support a simultaneity claim, however unanimous its three answers were.
   */
  readonly spanMs: number;
  readonly inFlight: Readonly<Record<string, boolean>>;
  readonly unreadable: readonly string[];
}

export interface OverlapAnalysis {
  readonly samples: number;
  /** Samples in which every server in the set was in flight at once. THE NUMBER THE CLAIM RESTS ON. */
  readonly simultaneousSamples: number;
  /** Wall seconds from the first such sample to the last. Zero when there was one or none. */
  readonly simultaneousSpanSeconds: number;
  /** The most servers ever seen in flight in one sample. One means the scans were sequential. */
  readonly maxServersInFlight: number;
  /** Samples in which at least two were in flight. Reported, never the claim. */
  readonly pairwiseSamples: number;
  /** Per server: how many samples found it in flight. A zero here is a server that never scanned. */
  readonly perServerInFlightSamples: Readonly<Record<string, number>>;
  /** How many servers were observed in flight at least once. */
  readonly serversObservedInFlight: number;
  /** Samples in which at least one server could not be read at all. */
  readonly unreadableSamples: number;
  /**
   * Samples whose three answers were too far apart in wall time to describe one instant.
   *
   * They are counted and reported and they NEVER count toward `simultaneousSamples`, however unanimous they
   * were: a tick spread over thirty seconds is consistent with the first server having finished before the
   * last was asked, which is the sequential run this gate exists to refuse.
   */
  readonly impreciseSamples: number;
  /** The widest tick, in seconds. Reported so a slow host is visible rather than inferred from a failure. */
  readonly widestSampleSpanSeconds: number;
  readonly firstSimultaneousAtMs: number;
  readonly lastSimultaneousAtMs: number;
}

/**
 * Turn an observation timeline into the numbers "three servers scanned simultaneously" has to mean.
 *
 * EVERY INTERESTING PROPERTY BELONGS TO THE SET AND TO THE INSTANT. `simultaneousSamples` counts samples in
 * which all of them were in flight AT THE SAME MOMENT — not "all of them were in flight at some point during
 * the window", which three strictly sequential scans satisfy perfectly.
 *
 * A SAMPLE WITH AN UNREADABLE SERVER CANNOT BE SIMULTANEOUS. It is not evidence either way: the server may
 * well have been scanning. Counting it as simultaneous would let a gate whose Plex had fallen over report a
 * three-way overlap, and counting it as a refutation would fail a run for one dropped poll. So it is counted
 * as neither, and `unreadableSamples` reports how many there were.
 */
export function analyseOverlap(
  samples: readonly OverlapSample[], serverIds: readonly string[] = THREE_SERVER_IDS,
): OverlapAnalysis {
  const ordered = [...samples].sort((a, b) => a.atMs - b.atMs);
  const perServer: Record<string, number> = {};
  for (const id of serverIds) perServer[id] = 0;

  let simultaneous = 0;
  let pairwise = 0;
  let maxInFlight = 0;
  let unreadableSamples = 0;
  let impreciseSamples = 0;
  let widestSpanMs = 0;
  let firstAt = 0;
  let lastAt = 0;

  for (const sample of ordered) {
    const unreadable = new Set(sample.unreadable);
    if (unreadable.size > 0) unreadableSamples += 1;
    const span = Number.isFinite(sample.spanMs) ? sample.spanMs : Infinity;
    widestSpanMs = Math.max(widestSpanMs, Number.isFinite(span) ? span : widestSpanMs);
    const imprecise = !(span <= CONCURRENCY_DEADLINES_MS.SAMPLE_MAX_SPAN);
    if (imprecise) impreciseSamples += 1;
    let inFlightHere = 0;
    for (const id of serverIds) {
      if (unreadable.has(id)) continue;
      if (sample.inFlight[id] === true) {
        perServer[id] = (perServer[id] ?? 0) + 1;
        inFlightHere += 1;
      }
    }
    maxInFlight = Math.max(maxInFlight, inFlightHere);
    if (inFlightHere >= 2) pairwise += 1;
    // ALL OF THEM, NONE OF THEM UNREADABLE, AND THE TICK NARROW ENOUGH TO BE ONE INSTANT. All three halves;
    // see the notes on `unreadable` and on `SAMPLE_MAX_SPAN`.
    if (inFlightHere === serverIds.length && unreadable.size === 0 && !imprecise) {
      simultaneous += 1;
      if (simultaneous === 1) firstAt = sample.atMs;
      lastAt = sample.atMs;
    }
  }

  return {
    samples: ordered.length,
    simultaneousSamples: simultaneous,
    simultaneousSpanSeconds: simultaneous === 0 ? 0 : (lastAt - firstAt) / 1_000,
    maxServersInFlight: maxInFlight,
    pairwiseSamples: pairwise,
    perServerInFlightSamples: perServer,
    serversObservedInFlight: serverIds.filter((id) => (perServer[id] ?? 0) > 0).length,
    unreadableSamples,
    impreciseSamples,
    widestSampleSpanSeconds: widestSpanMs / 1_000,
    firstSimultaneousAtMs: firstAt,
    lastSimultaneousAtMs: lastAt,
  };
}

/**
 * Everything wrong with an observed overlap, named.
 *
 * IT RETURNS PROBLEMS RATHER THAN A BOOLEAN so the gate's log says which property failed. "The scans did not
 * overlap" and "one server never scanned" are different defects with different first suspects, and a gate
 * that printed `false` for both would cost a whole run to interpret.
 */
export function overlapProblems(analysis: OverlapAnalysis): string[] {
  const problems: string[] = [];
  if (analysis.samples === 0) {
    problems.push('the observer took no samples at all, so nothing about concurrency was measured');
    return problems;
  }
  if (analysis.serversObservedInFlight < CONCURRENCY_RULES.MIN_SERVERS_OBSERVED_IN_FLIGHT) {
    const idle = Object.entries(analysis.perServerInFlightSamples)
      .filter(([, count]) => count === 0).map(([id]) => id);
    problems.push(`${analysis.serversObservedInFlight} of ${CONCURRENCY_RULES.MIN_SERVERS_OBSERVED_IN_FLIGHT} `
      + `servers were ever observed scanning${idle.length > 0 ? ` (never seen: ${idle.join(', ')})` : ''}`);
  }
  if (analysis.maxServersInFlight <= 1) {
    problems.push('no sample ever found more than one server scanning, which is what three SEQUENTIAL scans '
      + 'look like — the gate would have been reporting a concurrency it never observed');
  }
  if (analysis.simultaneousSamples < CONCURRENCY_RULES.MIN_SIMULTANEOUS_SAMPLES) {
    problems.push(`${analysis.simultaneousSamples} samples found all `
      + `${CONCURRENCY_RULES.MIN_SERVERS_OBSERVED_IN_FLIGHT} servers scanning at once, against a floor of `
      + `${CONCURRENCY_RULES.MIN_SIMULTANEOUS_SAMPLES}`);
  }
  if (analysis.simultaneousSpanSeconds < CONCURRENCY_RULES.MIN_SIMULTANEOUS_SPAN_SECONDS) {
    problems.push(`the three-way overlap spanned ${analysis.simultaneousSpanSeconds}s, against a floor of `
      + `${CONCURRENCY_RULES.MIN_SIMULTANEOUS_SPAN_SECONDS}s — an instantaneous graze is not "scanning `
      + 'simultaneously"');
  }
  return problems;
}

/** How far apart the scan triggers landed, in seconds. Recorded; see `TRIGGER_SPREAD_IS_NOT_OVERLAP_EVIDENCE`. */
export function triggerSpreadSeconds(triggeredAtMs: readonly number[]): number {
  if (triggeredAtMs.length === 0) return Infinity;
  return (Math.max(...triggeredAtMs) - Math.min(...triggeredAtMs)) / 1_000;
}

// ---------------------------------------------------------------------------------------------------------
// Telemetry that has to be trustworthy before any budget over it means anything
// ---------------------------------------------------------------------------------------------------------

/**
 * The counters a G18 window is asserted against, and what has to be true of them before it is.
 *
 * WHY THIS IS A SEPARATE CHECK FROM THE BUDGETS. Every budget in `MEDIA_SERVER_BUDGETS` is a comparison
 * between a delta and a ceiling, and a delta is meaningless if the instrument moved: a counter that RESET
 * mid-window produces a small delta and passes everything. A counter that is missing from the document reads
 * as zero through a forgiving parser and passes everything more comfortably still. So the instrument is
 * checked first, and a G18 verdict that could not check it FAILS CLOSED rather than reporting a pass over
 * telemetry it does not trust.
 */
export const COUNTER_KEYS_REQUIRED = Object.freeze([
  'resolutions', 'rangeRequests', 'accountedResponses', 'bytesServed', 'served429', 'fullBodyServed',
  'peakConns', 'peakConcurrent', 'chunkResponses', 'chunkBytes', 'smallResponses', 'smallBytes',
  'partialResponses', 'partialBytes', 'oversizedResponses', 'oversizedBytes', 'bodylessResponses',
  'holdTimeouts', 'heldRequests',
] as const);

/**
 * The counters that may never fall between two snapshots of one endpoint process.
 *
 * IT IS EVERY REQUIRED KEY, AND THAT IS A PROPERTY OF THE LIST ABOVE RATHER THAN A COINCIDENCE. Each one is
 * either a lifetime total or a high-water mark, and neither kind falls. `currentHeldWaiters` — the endpoint's
 * one live GAUGE, which rises and falls by design — is deliberately not in `COUNTER_KEYS_REQUIRED` at all:
 * the gate reads it, but as a present-tense observation rather than as a window delta, and requiring it to be
 * monotonic would fail every correct run.
 */
export const MONOTONIC_COUNTER_KEYS: readonly string[] = COUNTER_KEYS_REQUIRED;

/** The per-object columns, which a caller pairs BY INDEX and which must therefore all be the same length. */
export const COUNTER_ARRAY_KEYS = Object.freeze([
  'objectBytes', 'objectSizes', 'objectChunk', 'objectSmall', 'objectPartial', 'objectOversized',
] as const);

/**
 * The endpoint's counters, as this gate is entitled to read them.
 *
 * IT IS BUILT BY VALIDATION AND NEVER BY A CAST. `JSON.parse` answers `any`, and an `as CountersSnapshot`
 * over it makes every missing field read as `undefined` and every arithmetic on it read as `NaN` — which
 * compares FALSE against every ceiling, so a budget over broken telemetry passes. The Plex driver has a
 * defect note about exactly this shape of cast. `parseProviderCounters` returns problems instead.
 */
export interface ProviderCounters {
  readonly resolutions: number;
  readonly rangeRequests: number;
  readonly accountedResponses: number;
  readonly bytesServed: number;
  readonly served429: number;
  readonly fullBodyServed: number;
  readonly peakConns: number;
  readonly peakConcurrent: number;
  readonly chunkResponses: number;
  readonly chunkBytes: number;
  readonly smallResponses: number;
  readonly smallBytes: number;
  readonly partialResponses: number;
  readonly partialBytes: number;
  readonly oversizedResponses: number;
  readonly oversizedBytes: number;
  readonly bodylessResponses: number;
  readonly holdTimeouts: number;
  readonly heldRequests: number;
  readonly objectBytes: readonly number[];
  readonly objectSizes: readonly number[];
  readonly objectChunk: readonly number[];
  readonly objectSmall: readonly number[];
  readonly objectPartial: readonly number[];
  readonly objectOversized: readonly number[];
}

export interface AttributionProblem {
  readonly kind: string;
  readonly detail: string;
}

/**
 * Read one counters document, refusing anything a budget could not honestly be asserted over.
 *
 * FAIL CLOSED IS THE WHOLE POINT. A forgiving parser turns "the instrument is broken" into "the data plane
 * behaved perfectly", which is the single worst direction for an error in this repository to go.
 */
export function parseProviderCounters(
  value: unknown, label: string,
): { counters?: ProviderCounters; problems: AttributionProblem[] } {
  const problems: AttributionProblem[] = [];
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
  for (const key of COUNTER_KEYS_REQUIRED) {
    const raw = document[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
      problems.push({
        kind: 'missing-telemetry',
        detail: `the ${label} snapshot has no usable "${key}" counter (${JSON.stringify(raw)}), so any budget `
          + 'reading it would pass by reading zero',
      });
      continue;
    }
    scalars[key] = raw;
  }
  const arrays: Record<string, number[]> = {};
  for (const key of COUNTER_ARRAY_KEYS) {
    const raw = document[key];
    if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'number'
      || !Number.isFinite(entry) || entry < 0)) {
      problems.push({
        kind: 'missing-telemetry',
        detail: `the ${label} snapshot's "${key}" is not an array of whole non-negative counts, so per-object `
          + 'attribution cannot be checked and an aggregate pass could be hiding a per-object breach',
      });
      continue;
    }
    arrays[key] = raw as number[];
  }
  if (problems.length > 0) return { problems };
  return {
    counters: { ...scalars, ...arrays } as unknown as ProviderCounters,
    problems: [],
  };
}

/**
 * Everything that makes a pair of counter snapshots unfit to assert a budget over.
 *
 * WHAT EACH REFUSAL IS FOR:
 *
 *   MISSING. A key the budget divides by, absent. Read through `?? 0` it is a silent pass.
 *   RESET. Any cumulative counter lower after than before. The endpoint process restarted inside the window,
 *     so the two readings describe different processes and their difference describes neither. This gate
 *     never restarts the endpoint — so a reset here means something did, and every number is void.
 *   REQUEST PARTITION. `chunk + small + partial + oversized + bodyless == accountedResponses`, on both
 *     snapshots. It is the endpoint's own statement that every request it accounted for landed in exactly one
 *     bucket; if it does not hold, a response was recorded twice or not at all.
 *   BYTE PARTITION. `chunkBytes + smallBytes + partialBytes + oversizedBytes == bytesServed`, likewise.
 *   ATTRIBUTION. `sum(objectBytes) == bytesServed`. A shortfall means bytes were served for a reference the
 *     endpoint never registered — which is exactly how "every byte belongs to the shared corpus" fails, and
 *     the only way it can fail invisibly.
 *   ARRAY GEOMETRY. The per-object columns must all have one entry per registered object. A caller pairs
 *     them by index; columns of different lengths make index i mean two different objects.
 *   OBJECT COUNT. The endpoint must be serving exactly the corpus this gate published. One extra object is
 *     one place a byte could hide.
 */
export function attributionProblems(
  before: ProviderCounters, after: ProviderCounters, expectedObjects: number,
): AttributionProblem[] {
  const problems: AttributionProblem[] = [];
  const raw = (snapshot: ProviderCounters): Record<string, number> =>
    snapshot as unknown as Record<string, number>;

  for (const key of MONOTONIC_COUNTER_KEYS) {
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
    const classified = snapshot.chunkResponses + snapshot.smallResponses
      + snapshot.partialResponses + snapshot.oversizedResponses;
    if (classified + snapshot.bodylessResponses !== snapshot.accountedResponses) {
      problems.push({
        kind: 'request-partition',
        detail: `the ${label} snapshot accounts for ${snapshot.accountedResponses} responses but its buckets `
          + `sum to ${classified + snapshot.bodylessResponses}`,
      });
    }
    const bucketBytes = snapshot.chunkBytes + snapshot.smallBytes
      + snapshot.partialBytes + snapshot.oversizedBytes;
    if (bucketBytes !== snapshot.bytesServed) {
      problems.push({
        kind: 'byte-partition',
        detail: `the ${label} snapshot served ${snapshot.bytesServed} bytes but its buckets sum to `
          + `${bucketBytes}`,
      });
    }
    const columns: ReadonlyArray<readonly [string, readonly number[]]> = [
      ['objectBytes', snapshot.objectBytes], ['objectSizes', snapshot.objectSizes],
      ['objectChunk', snapshot.objectChunk], ['objectSmall', snapshot.objectSmall],
      ['objectPartial', snapshot.objectPartial], ['objectOversized', snapshot.objectOversized],
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
    const attributed = snapshot.objectBytes.reduce((total, value) => total + value, 0);
    if (attributed !== snapshot.bytesServed) {
      problems.push({
        kind: 'unattributed-bytes',
        detail: `the ${label} snapshot served ${snapshot.bytesServed} bytes but attributes ${attributed} to `
          + 'registered objects; the difference was served for a reference this gate never published',
      });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------
// Per-object byte budgets
// ---------------------------------------------------------------------------------------------------------

/** The contract's own probe geometry, read off `manifest.go` rather than chosen here. */
export const PROBE_GEOMETRY = Object.freeze({
  PROBE_WINDOW_BYTES: 1_048_576,
  SINGLE_PROBE_BELOW_BYTES: 3 * 1_048_576,
} as const);

/**
 * WHY THIS FILE IMPORTS A CEILING OUT OF `plex-dataplane.ts`, AND WHY THAT IS NOT A LAYERING MISTAKE.
 *
 * `plexObjectByteCeiling(size)` is `8 x min(4 MiB, size) + 3 x min(1 MiB, size)`, and NOT ONE OF THOSE
 * NUMBERS IS PLEX'S. The 4 MiB is `readpath.DefaultConfig().ChunkBytes`, the DAEMON's demand block; the
 * 1 MiB is `manifest.ProbeWindowBytes`, the DAEMON's scan window; the two caps are the maxima measured across
 * every instrumented scan window this repository has, which is nineteen of them. It is the daemon's own block
 * geometry, and it happens to live in the Plex module because that is the gate that had to derive it — after
 * two attempts at a fitted multiplier, one of which the next run exceeded.
 *
 * COPYING IT HERE WOULD BE THE MISTAKE. Two spellings of one geometry is exactly the failure this repository
 * keeps writing down: the copy would not move when a cap did, and the three-server gate would be holding the
 * daemon to a bound the daemon had stopped having.
 *
 * WHY A FITTED MULTIPLIER IS NOT AN OPTION HERE EITHER, AND THIS IS THE POINT. `MAX_SCAN_BYTE_FRACTION` is
 * 0.5, and on a small object it is unreachable BY CONSTRUCTION: the daemon serves a 4 MiB demand block for a
 * one-byte read, so identifying a 40 KB object costs a whole block whatever the daemon does. Applying 0.5 to
 * a corpus of tiny files would be a gate that could never pass; applying a number picked to clear what was
 * measured would be a record of the observation with room around it. So the small objects are held to the
 * BLOCK GEOMETRY, and the fraction is asserted where it is genuinely the tighter bound — which is exactly
 * what `PLEX_LARGE_FIXTURE.MIN_BYTES` computes, and why this gate generates an object that big.
 */
export { plexObjectByteCeiling as daemonBlockByteCeiling } from './plex-dataplane.js';

export interface ObjectByteVerdict {
  readonly ordinal: number;
  readonly sizeBytes: number;
  readonly servedBytes: number;
  readonly ceilingBytes: number;
  /** Which of the two bounds was the binding one, so a breach says what it breached. */
  readonly boundKind: 'block-geometry' | 'byte-fraction';
  readonly multiplier: number;
  readonly withinBudget: boolean;
  /**
   * Served bytes as a share of the WORST CASE — three independent scanners each paying the full
   * single-scanner envelope for this object. RECORDED, NEVER ASSERTED: see `objectByteVerdicts`.
   */
  readonly sharingRatio: number;
}

/**
 * Hold EVERY object's own served bytes against a ceiling derived from ITS OWN length.
 *
 * WHY AN AGGREGATE IS NOT ENOUGH, AND THIS IS NOT BELT-AND-BRACES. G15's budget is a fraction of a total, and
 * a total is exactly where one runaway object hides. gate8 of the Plex line exceeded a corpus byte ceiling by
 * 0.098 % and the counters could not say whether that was one object read four times over or thirty-eight
 * objects each read a little extra — two findings with opposite responses. With three media servers reading
 * one daemon the failure mode gets worse, not better: an aggregate that stays under a shared ceiling is
 * perfectly consistent with one server downloading one object in full while the other two read nothing.
 *
 * TWO BOUNDS, AND THE TIGHTER ONE BINDS:
 *
 *   BLOCK GEOMETRY x THE NUMBER OF SCANNERS. Three servers scan independently, and nothing in the daemon
 *     PROMISES that the second and third read from what the first cached — that promise is the thing under
 *     test. So the ceiling that can be derived without assuming the answer is three times the single-scanner
 *     envelope. It is loose on a small object, and it is loose HONESTLY: a tighter number here would be a
 *     number fitted to a measurement.
 *
 *   THE BYTE FRACTION, WHERE IT IS THE TIGHTER OF THE TWO. Above `PLEX_LARGE_FIXTURE.MIN_BYTES` — the
 *     smallest size at which the envelope sits comfortably under the fraction — `MAX_SCAN_BYTE_FRACTION`
 *     binds instead, and it is the product's whole argument. On an object that size, THREE scanners paying
 *     three full envelopes would breach it; passing it therefore requires that the second and third scans
 *     really did read from what the first one cached. That is the strongest claim this gate makes, and it is
 *     the reason it generates an object that large rather than reusing a small one.
 *
 * THE SHARING RATIO IS RECORDED AND NOT ASSERTED. `served / (3 x envelope)` is the interesting number — it
 * says how much of the worst case three concurrent scanners actually cost — and asserting a floor or a
 * ceiling on it would be asserting an efficiency this gate has very few observations of. It is reported so
 * that a regression is visible in the numbers before it is visible in a verdict.
 *
 * OBJECTS WITH NO TRAFFIC ARE NOT SILENTLY PASSED. A ceiling is satisfied by zero, so the caller separately
 * requires that as many objects were exercised as there are remote entries.
 */
export function objectByteVerdicts(
  before: ProviderCounters, after: ProviderCounters,
  ceilingFor: (size: number) => number,
  largeFixtureMinBytes: number, largeFraction: number,
  scanners: number = REQUIRED_SERVER_COUNT,
): ObjectByteVerdict[] {
  const verdicts: ObjectByteVerdict[] = [];
  const count = Math.min(after.objectBytes.length, after.objectSizes.length);
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    const size = after.objectSizes[ordinal] as number;
    const served = (after.objectBytes[ordinal] as number) - (before.objectBytes[ordinal] ?? 0);
    const worstCase = scanners * ceilingFor(size);
    const fraction = Math.floor(size * largeFraction);
    const fractionBinds = size >= largeFixtureMinBytes && fraction < worstCase;
    const ceiling = fractionBinds ? fraction : worstCase;
    verdicts.push({
      ordinal,
      sizeBytes: size,
      servedBytes: served,
      ceilingBytes: ceiling,
      boundKind: fractionBinds ? 'byte-fraction' : 'block-geometry',
      multiplier: size > 0 ? served / size : 0,
      withinBudget: served <= ceiling,
      sharingRatio: worstCase > 0 ? served / worstCase : 0,
    });
  }
  return verdicts;
}

export interface ObjectShapeVerdict {
  readonly ordinal: number;
  readonly blockResponses: number;
  readonly smallResponses: number;
  readonly oversizedResponses: number;
  readonly blockCeiling: number;
  readonly smallCeiling: number;
  readonly withinShape: boolean;
}

/**
 * The per-entry REQUEST SHAPE, which bytes alone cannot describe.
 *
 * WHY SHAPE AS WELL AS BYTES. A byte total can be reached by many different mixes of request, and one of
 * those mixes is a defect the byte total cannot see: an OVERSIZED response — a body larger than a demand
 * block, which is either a coalesced read or a full-body 200 answering a ranged request. It has never been
 * observed in nineteen instrumented windows and its ceiling here is ZERO, unmultiplied by the number of
 * scanners, because three servers do not make one legitimate.
 *
 * FULL AND CLIPPED BLOCKS SHARE ONE CAP, exactly as `PLEX_SCAN_ENVELOPE` says: a block clipped by a cache
 * gap is one round trip for at most a demand block and is never dearer than a full one, so giving the
 * partial class its own allowance would let an entry spend both.
 */
export function objectShapeVerdicts(
  before: ProviderCounters, after: ProviderCounters,
  blockCapPerScanner: number, smallCapPerScanner: number,
  scanners: number = REQUIRED_SERVER_COUNT,
): ObjectShapeVerdict[] {
  const verdicts: ObjectShapeVerdict[] = [];
  const count = after.objectBytes.length;
  const delta = (column: readonly number[], previous: readonly number[], ordinal: number): number =>
    (column[ordinal] ?? 0) - (previous[ordinal] ?? 0);
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    const blocks = delta(after.objectChunk, before.objectChunk, ordinal)
      + delta(after.objectPartial, before.objectPartial, ordinal);
    const small = delta(after.objectSmall, before.objectSmall, ordinal);
    const oversized = delta(after.objectOversized, before.objectOversized, ordinal);
    const blockCeiling = blockCapPerScanner * scanners;
    const smallCeiling = smallCapPerScanner * scanners;
    verdicts.push({
      ordinal,
      blockResponses: blocks,
      smallResponses: small,
      oversizedResponses: oversized,
      blockCeiling,
      smallCeiling,
      withinShape: blocks <= blockCeiling && small <= smallCeiling && oversized === 0,
    });
  }
  return verdicts;
}

/** The shape verdicts that failed, so a report names the object rather than the count. */
export function breachedShapes(verdicts: readonly ObjectShapeVerdict[]): ObjectShapeVerdict[] {
  return verdicts.filter((verdict) => !verdict.withinShape);
}

/** The verdicts that failed, worst first, so a report names the object that broke rather than the count. */
export function breachedObjects(verdicts: readonly ObjectByteVerdict[]): ObjectByteVerdict[] {
  return verdicts.filter((verdict) => !verdict.withinBudget)
    .sort((a, b) => b.multiplier - a.multiplier);
}

export interface CorpusAttribution {
  /** Bytes served during the window for objects belonging to the shared corpus. */
  readonly corpusBytes: number;
  /** Bytes served during the window for registered objects that are NOT part of it. */
  readonly otherBytes: number;
  /** The endpoint's own total for the window. */
  readonly totalBytes: number;
  /** Total less the two above. Anything but zero means a byte belongs to nothing this gate registered. */
  readonly unattributed: number;
  /** Corpus bytes served BEFORE the window — the number that says whether the window was cold. */
  readonly corpusBytesBefore: number;
}

/**
 * Split a window's provider bytes into "the shared corpus" and "everything else", exactly.
 *
 * WHY THERE IS AN "EVERYTHING ELSE" AT ALL. The gate registers one object that is deliberately NOT part of
 * the corpus: a canary the readiness probe reads once, before anything is published, so that checking the
 * endpoint answers a ranged request correctly does not put bytes on a corpus object and destroy the
 * cold-window measurement before it starts. Having it means the attribution is a partition rather than an
 * assumption — `corpusBytes + otherBytes == totalBytes` is checked, not asserted in a comment.
 *
 * `firstCorpusOrdinal` IS A REGISTRATION-ORDER BOUNDARY, NOT A NAME. The endpoint's per-object columns carry
 * no references by design; what they carry is the order the gate registered its objects in. The gate
 * registers the canary first and the corpus after it, so the boundary is a number both sides can agree on
 * without the endpoint ever reporting a reference.
 */
export function corpusAttribution(
  before: ProviderCounters, after: ProviderCounters, firstCorpusOrdinal: number,
): CorpusAttribution {
  let corpusBytes = 0;
  let otherBytes = 0;
  let corpusBytesBefore = 0;
  const count = after.objectBytes.length;
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    const served = (after.objectBytes[ordinal] as number) - (before.objectBytes[ordinal] ?? 0);
    if (ordinal >= firstCorpusOrdinal) {
      corpusBytes += served;
      corpusBytesBefore += before.objectBytes[ordinal] ?? 0;
    } else {
      otherBytes += served;
    }
  }
  const totalBytes = after.bytesServed - before.bytesServed;
  return {
    corpusBytes, otherBytes, totalBytes,
    unattributed: totalBytes - corpusBytes - otherBytes,
    corpusBytesBefore,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Cold state
// ---------------------------------------------------------------------------------------------------------

export interface ColdStateProblem {
  readonly kind: string;
  readonly detail: string;
}

/**
 * Everything that makes a "concurrent scan" window incapable of proving anything, because it was WARM.
 *
 * THIS IS THE CHEAT THIS GATE IS MOST EXPOSED TO, AND IT IS NOT HYPOTHETICAL. G19 of the acceptance plan says
 * a second synthetic scan over an unchanged manifest issues ZERO ranged GETs, because the persistent
 * scan-window cache already holds every byte such a scan reads. That is a correct property of the product and
 * it is a catastrophe for THIS gate: run the three concurrent scans second, after any earlier scan, and the
 * provider sees nothing at all. Every ceiling in G14a–G17 is then satisfied by a window in which the data
 * plane did no work — a green G18 that measured an empty room.
 *
 * SO THREE THINGS ARE REQUIRED, AND EACH CLOSES A DIFFERENT HALF:
 *
 *   NO CORPUS BYTE HAD EVER BEEN SERVED. The endpoint's own per-object totals, before the window. This is
 *     the load-bearing one: the daemon cannot serve a corpus entry from a cache it never filled, so a zero
 *     here means the window really is the corpus's first read, whatever else is cached.
 *   THE DAEMON'S SCAN-WINDOW CACHE GREW ACROSS THE WINDOW. A cold scan fills it; a warm one has nothing to
 *     add. This is the daemon-side half, and it is a GROWTH rather than an emptiness — see below.
 *   THE WINDOW REACHED THE PROVIDER AT LEAST ONCE PER REMOTE OBJECT. Nothing was cached, so every remote
 *     entry the servers catalogued must have cost at least one ranged GET. A floor, not a ceiling; a scan
 *     that issued zero requests scores perfectly against every budget in this file.
 *   A PROVIDER READ WAS ACTUALLY BLOCKED. `heldRequests` moved, which means the barrier hold was HIT — the
 *     scanners really were waiting on provider bytes rather than reading a warm cache and calling it a scan.
 *
 * WHY THE DAEMON-SIDE CHECK IS A GROWTH AND NOT `probeCacheBytes == 0`, MEASURED RATHER THAN REASONED. The
 * first real run of this gate read **33,187 bytes** of scan-window cache immediately before the concurrent
 * scan, and nothing was wrong: the gate publishes a LOCAL seed entry on purpose — so Plex's unavoidable
 * library-creation scan has something to find that costs the provider nothing — and a local passthrough
 * entry's own byte-identity window lands in the same cache. An emptiness assertion would therefore have
 * failed every correct run, and "the cache is empty" is not the property that matters anyway: what matters
 * is that no CORPUS window was in it, which the endpoint's per-object totals answer exactly and the daemon's
 * single aggregate cannot answer at all. So the level is reported, and the daemon-side assertion is that the
 * cache GREW — a cold scan fills it, a warm one has nothing to add.
 */
export function coldStateProblems(input: {
  readonly probeCacheBytesBefore: number;
  readonly probeCacheBytesAfter: number;
  readonly corpusBytesBefore: number;
  readonly rangeRequestDelta: number;
  readonly remoteObjectCount: number;
  readonly heldRequestDelta: number;
  readonly holdTimeoutDelta: number;
}): ColdStateProblem[] {
  const problems: ColdStateProblem[] = [];
  if (input.probeCacheBytesAfter <= input.probeCacheBytesBefore) {
    problems.push({
      kind: 'probe-cache-did-not-grow',
      detail: `the daemon's scan-window cache went from ${input.probeCacheBytesBefore} to `
        + `${input.probeCacheBytesAfter} bytes across the window. A COLD scan of a ~50-entry corpus fills it; `
        + 'a window that added nothing was reading windows it already held',
    });
  }
  // THE ENDPOINT'S OWN VIEW, AND IT IS THE LOAD-BEARING ONE. The daemon's cache level is one aggregate over
  // every version it has ever cached, including the local seed; the endpoint's per-object totals say whether
  // ANY corpus byte had ever been served before the window opened, whatever cached it.
  if (input.corpusBytesBefore !== 0) {
    problems.push({
      kind: 'corpus-already-read',
      detail: `${input.corpusBytesBefore} bytes of the shared corpus had already been served by the endpoint `
        + 'before the concurrent scan opened, so this window is not the corpus\'s first read and its cost is '
        + 'not what a cold scan costs',
    });
  }
  if (input.rangeRequestDelta < input.remoteObjectCount) {
    problems.push({
      kind: 'no-cold-traffic',
      detail: `the window issued ${input.rangeRequestDelta} ranged GETs for ${input.remoteObjectCount} `
        + 'uncached remote objects; a cold scan must reach the provider at least once for each of them, and '
        + 'a window that did not is a warm-cache bypass scoring a perfect zero against every ceiling',
    });
  }
  if (input.heldRequestDelta < 1) {
    problems.push({
      kind: 'barrier-never-hit',
      detail: 'no provider request ever entered the barrier hold, so the scanners were never observed '
        + 'waiting on provider bytes and the rendezvous did nothing',
    });
  }
  if (input.holdTimeoutDelta !== 0) {
    problems.push({
      kind: 'hold-lapsed',
      detail: `${input.holdTimeoutDelta} barrier hold(s) lapsed instead of being released, so a provider `
        + 'read was stalled for the whole hold budget and the scan it belonged to was degraded by the '
        + 'instrument rather than measured by it',
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------
// What this gate does not claim
// ---------------------------------------------------------------------------------------------------------

/**
 * THE NONCLAIMS, AS DATA RATHER THAN AS A PARAGRAPH SOMEBODY MIGHT DELETE.
 *
 * The offline suite asserts that the gate's own closing text contains every one of these, so a future edit
 * that quietly upgrades a Docker Desktop run into Phase 1 closure fails a test rather than a review.
 */
export const THREE_SERVER_NONCLAIMS: readonly string[] = Object.freeze([
  'a Docker Desktop pass is not Linux or Unraid closure and closes none of G7-G13 or G18',
  'no run of this gate has ever happened on a real Linux or Unraid host',
  'no real provider endpoint has ever been contacted; the endpoint is the in-repository fake',
  'per-server provider attribution is impossible here and is not claimed: one daemon serves all three '
    + 'servers, so the provider sees the daemon and never the server behind a byte',
  'G22, the rclone/WebDAV comparison control, is not run',
  'G27’s three-server half is not run',
  'Phase 1 remains open',
]);

/**
 * WHY PER-SERVER PROVIDER ATTRIBUTION IS NOT CLAIMED, AND WHY THAT IS THE HONEST SHAPE OF THIS GATE.
 *
 * G18 puts three media servers on ONE production mount served by ONE daemon. Every provider request therefore
 * originates from the daemon, and the endpoint's per-object columns say which OBJECT a byte belonged to and
 * nothing about which server caused it — because at the provider there is nothing to see. A gate that
 * reported "Jellyfin cost N bytes" would be inventing a number.
 *
 * WHAT IS ATTRIBUTED, EXACTLY: every byte to a registered corpus object, with the sum reconciled against the
 * endpoint's own total, so no byte can belong to something this gate did not publish. What is per-server is
 * the CATALOGUE evidence — each server independently matched all ~50 published identities at the published
 * sizes through its own semantics — and the OVERLAP evidence, which is per-server by construction.
 */
export const PER_SERVER_PROVIDER_ATTRIBUTION_IS_IMPOSSIBLE = true;
