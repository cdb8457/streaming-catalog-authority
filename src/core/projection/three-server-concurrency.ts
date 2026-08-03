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

import {
  PROJECTIOND_ADMISSION_LIMITS, PROJECTION_PHASE_1_BUDGETS,
} from './runtime-contract.js';
import { PROJECTION_PROBE_PLAN } from './manifest-v1.js';

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
  /**
   * The widest gap between two adjacent qualifying samples that may still be treated as ONE continuous run.
   *
   * TWICE THE NOMINAL TICK, AND THE PREVIOUS VALUE WAS FIVE TIMES IT. It was `SAMPLE_INTERVAL +
   * SAMPLE_MAX_SPAN` = 2,500 ms, on the reasoning that a tick may legitimately be as wide as the
   * simultaneity bound. That conflated two different things: `SAMPLE_MAX_SPAN` bounds how far apart the
   * THREE ANSWERS WITHIN ONE TICK may be and still describe one instant; it is not permission to leave five
   * polling intervals missing BETWEEN ticks. At 2,500 ms, three samples 2.5 s apart cleared the two-second
   * duration floor with 120 ms of actual observation in a five-second span — nearly the whole claimed
   * duration unobserved.
   *
   * So the ceiling is one missed poll and no more: `2 x SAMPLE_INTERVAL`. It is strictly below the
   * two-second duration floor, which matters — at the old value a run could be assembled entirely out of
   * ceiling-width gaps and still clear the floor.
   *
   * The measured runs sit at ~511 ms per gap against this 1,000 ms ceiling: a factor of two of margin, and
   * `assertCadenceIsFailClosed` below refuses the whole file if that relation ever stops holding.
   */
  MAX_CONTINUOUS_GAP: 500 * 2,
  /**
   * How often the BARRIER WATCHDOG polls, independently of the observation tick.
   *
   * THE BARRIER RELEASE IS A REAL-TIME SAFETY ACTION AND MUST NOT BE SCHEDULED BEHIND UNBOUNDED WORK. It
   * used to live in the observation loop: detect the block, then three server polls, then check whether the
   * arm window had elapsed. Moving the detection to the top of the tick was not enough — the RELEASE still
   * fired at tick granularity, and a tick is one sleep plus three server polls, each of which may take up to
   * `SAMPLE_MAX_SPAN`. Worst case the release lands a full 2.5 s after it was due, which is more overshoot
   * than any arm window under the backstop can absorb.
   *
   * So the watchdog is its own loop on its own cadence, and the server polls cannot delay it at all. Half a
   * nominal tick bounds BOTH the detection lag and the release lag, and the arm window only has to leave
   * room for two of them.
   */
  BARRIER_WATCHDOG_INTERVAL: 500 / 2,
} as const);

/**
 * THE CADENCE RULE, CHECKED AT MODULE LOAD RATHER THAN TRUSTED.
 *
 * Three numbers have to stay in a particular order or the continuity rule stops being fail-closed, and two of
 * them live in different constants that a future edit could move independently:
 *
 *	SAMPLE_INTERVAL  <  MAX_CONTINUOUS_GAP  <  MIN_SIMULTANEOUS_SPAN_SECONDS x 1000
 *
 * The left inequality says the ceiling tolerates at least a slow tick; the right one says a run cannot be
 * assembled out of ceiling-width gaps and still clear the duration floor. Writing them down as a comment is
 * what the previous version did.
 */
function assertCadenceIsFailClosed(): void {
  const nominal = CONCURRENCY_DEADLINES_MS.SAMPLE_INTERVAL;
  const ceiling = CONCURRENCY_DEADLINES_MS.MAX_CONTINUOUS_GAP;
  if (!(nominal < ceiling && ceiling <= nominal * 2)) {
    throw new Error(`the continuity gap ceiling (${ceiling}ms) must be above the nominal tick (${nominal}ms) `
      + 'and no more than twice it: a wider tolerance counts polls that were never taken as overlap');
  }
  if (!(ceiling < CONCURRENCY_RULES.MIN_SIMULTANEOUS_SPAN_SECONDS * 1_000)) {
    throw new Error(`the continuity gap ceiling (${ceiling}ms) must be strictly below the duration floor `
      + `(${CONCURRENCY_RULES.MIN_SIMULTANEOUS_SPAN_SECONDS * 1_000}ms), or a run can be assembled entirely `
      + 'out of ceiling-width gaps and still clear it');
  }
}

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
 *     it could not open. `HOLD_MAX_MS` sits well under it — and, more tightly, strictly under the queue-wait
 *     budget below, which is the binding constraint of the two.
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

/**
 * The endpoint's own hard backstop, for the case where this gate dies between arming and releasing.
 *
 * IT IS STRICTLY BELOW THE QUEUE-WAIT BUDGET, AND AN EARLIER VERSION WAS NOT. It was 5,000 ms — exactly
 * `MAX_QUEUE_WAIT_MS` — while the comment beside it claimed the bound was "strictly shorter". At equality the
 * guarantee is gone: a read that arrives one instant after another blocks would wait the full queue-wait
 * budget and could be refused admission, so the very starvation the bound exists to prevent sits on the
 * boundary. Half a second under it restores the strict inequality, and the whole chain is now ordered and
 * derived rather than asserted:
 *
 *	HOLD_ARM_MS (4,000) < HOLD_MAX_MS (4,500) < MAX_QUEUE_WAIT_MS (5,000) < FIRST_BYTE_DEADLINE_MS (10,000)
 *
 * The arm window is what governs a healthy run; the backstop only matters if this process dies mid-hold, and
 * even then no other object's read can be starved and no held read can miss its first byte.
 */
const HOLD_MAX_MS_INTERNAL = PROJECTIOND_ADMISSION_LIMITS.MAX_QUEUE_WAIT_MS - 500;
export const HOLD_MAX_MS = HOLD_MAX_MS_INTERNAL;

export const HOLD_ARM_MS = HOLD_MAX_MS_INTERNAL
  - CONCURRENCY_DEADLINES_MS.MAX_CONTINUOUS_GAP - CONCURRENCY_DEADLINES_MS.SAMPLE_INTERVAL;

/**
 * The overshoot the arm window must leave room for: one watchdog period to NOTICE the block, and one more to
 * ACT on the arm window having elapsed. Nothing else is on that path, which is the point of the watchdog.
 */
export const BARRIER_RELEASE_OVERSHOOT_MS = 2 * CONCURRENCY_DEADLINES_MS.BARRIER_WATCHDOG_INTERVAL;

/**
 * THE ARM WINDOW AND THE BACKSTOP DO NOT START AT THE SAME MOMENT, AND A REAL RUN FAILED ON THE DIFFERENCE.
 *
 * The endpoint's `maxHold` starts when a request ACTUALLY BLOCKS. This gate's arm window starts when the
 * observer NOTICES it has blocked, which it learns by polling `/counters` once per tick. Those are different
 * clocks, and the second lags the first.
 *
 * RUN 2 OF THE FIRST FULLY REMEDIATED SEQUENCE FAILED EXACTLY THERE. The release fired 4.1 s after
 * detection — inside the old 4,000 ms arm window — but the true block had begun some hundreds of
 * milliseconds earlier, so the endpoint's 4,500 ms backstop fired first and `holdTimeouts` moved to 1. Run 1
 * of the same sequence passed with identical code: it happened to detect the block one tick sooner. A gate
 * whose verdict depends on which tick a poll lands in is not measuring the data plane.
 *
 * SO THE ARM WINDOW LEAVES ROOM FOR THE LAG, and the room is the lag's own bound: one missed poll
 * (`MAX_CONTINUOUS_GAP`, the tolerance this file already uses for exactly "how stale may an observation be")
 * plus one nominal tick of slack. Every term is derived:
 *
 *	arm 3,000 + lag <=1,000 + slack 500  =  backstop 4,500  <  queue-wait 5,000  <  first-byte 10,000
 *
 * THE OTHER HALF OF THE FIX IS IN THE OBSERVER: the barrier gauge is polled FIRST in each tick, before the
 * three server polls, so their latency is not added to the lag this margin has to cover.
 *
 * WHY NOT SIMPLY STOP ASSERTING `holdTimeouts == 0`? Because it would be weakening a check to make a run
 * pass. The endpoint's backstop is already strictly under the queue-wait budget, so a lapse starves nothing
 * — but the gate says it releases the hold deliberately, and this assertion is what makes that a fact rather
 * than a hope. The timing was wrong; the assertion was right.
 */
function assertHoldChainIsFailClosed(): void {
  const lagAllowance = BARRIER_RELEASE_OVERSHOOT_MS;
  if (!(HOLD_ARM_MS > 0 && HOLD_ARM_MS + lagAllowance <= HOLD_MAX_MS_INTERNAL)) {
    throw new Error(`the arm window (${HOLD_ARM_MS}ms) plus the watchdog overshoot it must tolerate `
      + `(${lagAllowance}ms) must fit inside the endpoint backstop (${HOLD_MAX_MS_INTERNAL}ms), or the `
      + 'backstop fires before the gate releases and a correct run reports a lapsed hold');
  }
  // THE OVERSHOOT MUST BE THE WATCHDOG'S, NOT THE OBSERVATION TICK'S. If the release ever moved back into the
  // observation loop, its granularity would become one sleep plus three server polls — up to
  // `SAMPLE_INTERVAL + SAMPLE_MAX_SPAN` — which does not fit under the backstop at any usable arm window.
  const tickGranularity = CONCURRENCY_DEADLINES_MS.SAMPLE_INTERVAL + CONCURRENCY_DEADLINES_MS.SAMPLE_MAX_SPAN;
  if (!(BARRIER_RELEASE_OVERSHOOT_MS < tickGranularity)) {
    throw new Error('the barrier watchdog must be faster than the observation tick, or moving the release '
      + 'off that tick bought nothing');
  }
  if (!(HOLD_MAX_MS_INTERNAL < PROJECTIOND_ADMISSION_LIMITS.MAX_QUEUE_WAIT_MS)) {
    throw new Error('the endpoint backstop must stay strictly below the admission queue-wait budget');
  }
}

export const CONCURRENCY_RULES = Object.freeze({
  /**
   * Samples in which EVERY server was in flight at the same instant.
   *
   * THREE, NOT ONE. A single sample is a point, and a point can be produced by two servers whose scans
   * touched at the edges — one finishing as another starts — which is the closest thing to sequential that
   * still technically overlaps. Three samples at the observer's tick rate mean the overlap had duration.
   */
  MIN_SIMULTANEOUS_SAMPLES: 3,
  // ...AND THE COUNT IS APPLIED TO THE SAME UNBROKEN RUN AS THE DURATION, NOT TO A TOTAL. Three simultaneous
  // samples anywhere in a window is a fact about the window; three in a row is a fact about an overlap.
  /**
   * ...and how long ONE UNBROKEN RUN of them must have lasted.
   *
   * MEASURED ACROSS THE LONGEST CONTINUOUS RUN, NOT FROM THE FIRST SIMULTANEOUS SAMPLE TO THE LAST. It used
   * to be the latter, and that is not a duration: `last - first` counts every idle, unreadable and imprecise
   * sample in between as though it had been overlap, and counts stretches in which nothing was sampled at
   * all. Three simultaneous samples scattered across two minutes cleared both floors while nothing had
   * overlapped for two seconds at any point.
   *
   * Two seconds is not a lot; it does not need to be. What it rules out is an instantaneous graze — and now
   * also a scattering of grazes, which is what the old form could not see.
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

// Checked once, here, where every constant they relate is in scope.
assertCadenceIsFailClosed();
assertHoldChainIsFailClosed();

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
// G14a, G14b and G15 — the CANONICAL ceilings, which are the acceptance plan's own and nobody else's
// ---------------------------------------------------------------------------------------------------------

/**
 * WHY THESE EXIST, AND WHY THE FIRST VERSION OF THIS GATE WAS WRONG WITHOUT THEM.
 *
 * G18 says "G14a–G17 still hold, UNCHANGED". The first version of the window command asserted
 * `MEDIA_SERVER_BUDGETS.MAX_SCAN_RANGE_MULTIPLIER` = 6 and `MAX_SCAN_RESOLUTION_MULTIPLIER` = 6 — the looser
 * multipliers the three single-server gates use because a real scanner is not a synthetic reader — and
 * mentioned the acceptance plan's own 1.2x numbers only as a passing observation. Against 43 remote entries
 * that is a ceiling of 258 where the plan says 155, and a gate that asserts 258 while the plan says 155 is
 * not G14a unchanged; it is a different budget wearing G14a's name. The measurements passed both, which is
 * exactly what makes the mistake worth naming rather than shrugging at: nothing failed, and the gate was
 * still claiming something it had not checked.
 *
 * SO THE CANONICAL CEILINGS ARE ASSERTED, AND THE STRICTER ONES ARE ASSERTED AS WELL. Where the block-geometry
 * model is tighter than the plan's arithmetic it stays, in ADDITION — never instead. A gate may be stricter
 * than the plan; it may not be looser and keep the plan's gate id.
 *
 * EVERY MULTIPLIER AND EVERY DENOMINATOR COMES FROM `PROJECTION_PHASE_1_BUDGETS` AND `PROJECTION_PROBE_PLAN`,
 * imported rather than restated. There is no flag, no default and no override by which a caller can move any
 * of them: an earlier `--windows` option let a caller pass a scan-window count of its own, which is a way to
 * weaken a required gate from the command line.
 */
export const CANONICAL_SCAN_WINDOWS_PER_ENTRY = PROJECTION_PHASE_1_BUDGETS.SCAN_WINDOWS_PER_ENTRY;

/** G14a: ranged GETs, as `1.2 x (entry count x scan windows per entry)`. The plan's own arithmetic. */
export function canonicalRangeRequestCeiling(remoteEntries: number): number {
  return Math.ceil(
    PROJECTION_PHASE_1_BUDGETS.MAX_RANGE_REQUEST_MULTIPLIER
    * remoteEntries * CANONICAL_SCAN_WINDOWS_PER_ENTRY,
  );
}

/** G14b: access resolutions, as `1.2 x entry count`. */
export function canonicalResolutionCeiling(remoteEntries: number): number {
  return Math.ceil(PROJECTION_PHASE_1_BUDGETS.MAX_RESOLUTION_REQUEST_MULTIPLIER * remoteEntries);
}

/**
 * G15: provider bytes, as `1.2 x (probe window x scan windows per entry x entry count)`.
 *
 * THE FLAT FORM IS THE PLAN'S FORM, DELIBERATELY, AND ITS LOOSENESS IS RECORDED RATHER THAN CORRECTED HERE.
 * Below `SINGLE_PROBE_BELOW_BYTES` the contract's own probe plan is a single window covering the whole
 * object, so a per-entry denominator that followed the plan exactly would be much tighter than this for a
 * corpus of small files. That tighter number is not what §5 says — §5's worked example is flat — and this
 * function's job is to reproduce §5, not to improve on it. The improvement lives beside it, in the per-object
 * block-geometry ceilings, which are asserted at the same time and are the tighter of the two on this corpus.
 */
export function canonicalScanByteCeiling(remoteEntries: number): number {
  return Math.floor(
    PROJECTION_PHASE_1_BUDGETS.MAX_BYTE_MULTIPLIER
    * PROJECTION_PROBE_PLAN.WINDOW_BYTES * CANONICAL_SCAN_WINDOWS_PER_ENTRY * remoteEntries,
  );
}

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
  /**
   * Samples in which every server in the set was in flight at once, ANYWHERE in the window.
   *
   * REPORTED, AND NO LONGER WHAT THE CLAIM RESTS ON. Three such samples scattered across a two-minute run —
   * with idle, unreadable or imprecise samples between them — is not three servers scanning simultaneously
   * for any length of time. See `longestContinuousSimultaneousSeconds`.
   */
  readonly simultaneousSamples: number;
  /**
   * Wall seconds from the FIRST such sample to the LAST, disqualifying samples in between included.
   *
   * IT IS A REPORTED NUMBER AND IT IS NOT A DURATION, WHICH IS WHY IT NO LONGER CARRIES A FLOOR. Calling
   * `last - first` an overlap duration is exactly the mistake that lets three scattered samples clear a
   * two-second span while nothing overlapped for two seconds: everything between them is assumed to have
   * been overlap, including the parts that were observed not to be and the parts that were not observed at
   * all. It is kept because the gap between it and the continuous run is itself informative.
   */
  readonly simultaneousSpanSeconds: number;
  /**
   * THE LONGEST UNBROKEN RUN of simultaneity, in CREDITED seconds. THE CLAIM.
   *
   * A run is broken by any sample that is not simultaneous, not readable or not precise, and ALSO by a gap
   * between two adjacent qualifying samples wider than `MAX_CONTINUOUS_GAP`. The second half matters as much
   * as the first: unobserved time is not overlap, and without a gap ceiling a run that stopped sampling for
   * a minute and resumed would have that minute counted as overlap it never watched.
   *
   * AND THE GAP CEILING ALONE IS NOT ENOUGH, WHICH IS WHY THIS IS *CREDITED* RATHER THAN WALL TIME. Any
   * duration inferred from discrete samples charges the interval between them; the only honest question is
   * how much. **Each gap contributes at most one NOMINAL tick**, whatever the wall gap actually was. So a
   * run whose ticks all ran late — every gap at the 2x ceiling — is credited half its wall span and needs
   * twice as many samples to clear the floor, and a poll that was never taken cannot become overlap even
   * inside the tolerance. `longestContinuousWallSeconds` reports what the clock said, beside it.
   */
  readonly longestContinuousSimultaneousSeconds: number;
  /** The same run's WALL span. Equal to the credited figure when the observer kept its nominal cadence. */
  readonly longestContinuousWallSeconds: number;
  /** How many samples that longest run contained. Two samples 2 s apart is not the same evidence as ten. */
  readonly longestContinuousSimultaneousSamples: number;
  /** How many separate runs of simultaneity there were. More than one means the overlap was interrupted. */
  readonly simultaneousRuns: number;
  /** Adjacent qualifying samples that were too far apart to be joined. Reported so a stall is visible. */
  readonly brokenByGap: number;
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
  // THE RUNNING STATE FOR THE CONTINUOUS RUN. `runStartAt` is where the current unbroken run began;
  // `previousQualifyingAt` is the last sample that joined it, which is what the gap is measured from.
  let runStartAt = 0;
  let previousQualifyingAt = 0;
  let runSamples = 0;
  let runCreditedMs = 0;
  let runs = 0;
  let brokenByGap = 0;
  let longestCreditedMs = 0;
  let longestWallMs = 0;
  let longestRunSamples = 0;

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
    const qualifies = inFlightHere === serverIds.length && unreadable.size === 0 && !imprecise;
    if (qualifies) {
      simultaneous += 1;
      if (simultaneous === 1) firstAt = sample.atMs;
      lastAt = sample.atMs;

      // JOIN THE CURRENT RUN, OR START A NEW ONE. A qualifying sample continues the run only if the previous
      // qualifying sample was close enough in wall time; otherwise the observer was not watching in between,
      // and time nobody watched cannot be counted as overlap.
      const gapMs = sample.atMs - previousQualifyingAt;
      const joins = runSamples > 0 && gapMs <= CONCURRENCY_DEADLINES_MS.MAX_CONTINUOUS_GAP;
      if (joins) {
        runSamples += 1;
        // CREDIT AT MOST ONE NOMINAL TICK PER GAP, whatever the clock said. A tick that ran late is
        // tolerated up to the ceiling above, but the interval nobody polled in is not overlap and is not
        // counted as any.
        runCreditedMs += Math.min(gapMs, CONCURRENCY_DEADLINES_MS.SAMPLE_INTERVAL);
      } else {
        if (runSamples > 0) brokenByGap += 1;
        runs += 1;
        runStartAt = sample.atMs;
        runSamples = 1;
        runCreditedMs = 0;
      }
      previousQualifyingAt = sample.atMs;
      const runWallMs = sample.atMs - runStartAt;
      if (runCreditedMs > longestCreditedMs
        || (runCreditedMs === longestCreditedMs && runSamples > longestRunSamples)) {
        longestCreditedMs = runCreditedMs;
        longestWallMs = runWallMs;
        longestRunSamples = runSamples;
      }
    } else if (runSamples > 0) {
      // A DISQUALIFYING SAMPLE ENDS THE RUN, whatever disqualified it: a server idle, a server unreadable, or
      // a tick too wide to describe one instant. Each of those is a moment at which "all three were scanning"
      // was not observed to be true, and a run that spans one is not continuous.
      runSamples = 0;
    }
  }

  return {
    samples: ordered.length,
    simultaneousSamples: simultaneous,
    simultaneousSpanSeconds: simultaneous === 0 ? 0 : (lastAt - firstAt) / 1_000,
    longestContinuousSimultaneousSeconds: longestCreditedMs / 1_000,
    longestContinuousWallSeconds: longestWallMs / 1_000,
    longestContinuousSimultaneousSamples: longestRunSamples,
    simultaneousRuns: runs,
    brokenByGap,
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
  // BOTH FLOORS ARE APPLIED TO THE LONGEST CONTINUOUS RUN, NOT TO THE TOTALS.
  //
  // THE DEFECT THIS CLOSES. Both used to be applied to totals: a count of simultaneous samples anywhere in
  // the window, and `last - first` across them. Three simultaneous samples scattered across two minutes —
  // with the servers observed IDLE in between, or unreadable, or the ticks too wide to mean anything —
  // cleared a count of three and a span of two seconds while nothing had overlapped for two seconds at any
  // point. The span was the worse of the two, because it silently counted every disqualifying sample between
  // the first and the last as though it had been overlap.
  if (analysis.longestContinuousSimultaneousSamples < CONCURRENCY_RULES.MIN_SIMULTANEOUS_SAMPLES) {
    problems.push(`the longest UNBROKEN run of samples with all `
      + `${CONCURRENCY_RULES.MIN_SERVERS_OBSERVED_IN_FLIGHT} servers scanning was `
      + `${analysis.longestContinuousSimultaneousSamples} samples, against a floor of `
      + `${CONCURRENCY_RULES.MIN_SIMULTANEOUS_SAMPLES} (${analysis.simultaneousSamples} such samples occurred `
      + `in total, across ${analysis.simultaneousRuns} separate run(s) — scattered simultaneity is not `
      + 'simultaneous scanning)');
  }
  if (analysis.longestContinuousSimultaneousSeconds < CONCURRENCY_RULES.MIN_SIMULTANEOUS_SPAN_SECONDS) {
    problems.push(`the longest CONTINUOUS three-way overlap credited `
      + `${analysis.longestContinuousSimultaneousSeconds}s (wall span `
      + `${analysis.longestContinuousWallSeconds}s; each gap is credited at most one nominal tick, so an `
      + `observer that fell behind cannot charge the time it did not poll), against a floor of `
      + `${CONCURRENCY_RULES.MIN_SIMULTANEOUS_SPAN_SECONDS}s. First-to-last across all simultaneous samples `
      + `was ${analysis.simultaneousSpanSeconds}s, which is not a duration: it counts every idle, unreadable `
      + 'and imprecise sample in between as though it had been overlap');
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
    // WHOLE MEANS WHOLE, AND THE SCALARS ALREADY SAID SO WHILE THE ARRAYS DID NOT.
    //
    // THE DEFECT THIS CLOSES. The scalar branch above refuses anything that is not `Number.isInteger`, and
    // this branch's own message called these "whole non-negative counts" — but it only checked `>= 0` and
    // `isFinite`. A per-object column of 4.5 responses or 1.7 bytes therefore parsed cleanly, and every
    // per-object budget below is a comparison against a ceiling: fractional counts compare, so they pass.
    // A counters file that is wrong in a way the parser announced it would refuse is worse than one that is
    // obviously broken, because nothing downstream has any reason to doubt it.
    if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'number'
      || !Number.isFinite(entry) || !Number.isInteger(entry) || entry < 0)) {
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

  // A geometry failure above means the columns cannot be paired by index at all, and every elementwise check
  // below would then be comparing objects that are not the same object. Stop rather than pile on.
  if (problems.some((problem) => problem.kind === 'array-geometry')) return problems;

  // ---------------------------------------------------------------------------------------------------
  // ELEMENTWISE, WHICH IS THE HALF THE AGGREGATES CANNOT SEE
  //
  // THE DEFECT THIS CLOSES, AND IT IS THE ONE THAT MATTERS MOST HERE. Everything above is scalar
  // monotonicity, array LENGTHS and array SUMS. All three survive a per-object reset that is compensated
  // somewhere else: drop ordinal 7 from 40 MB to 0 and raise ordinal 8 by 40 MB, and every aggregate is
  // unchanged, every partition still balances, and ordinal 7's window delta is NEGATIVE — which satisfies
  // every ceiling in this file by arithmetic rather than by behaviour. An endpoint restart that reassigned
  // ordinals does exactly this shape of damage.
  //
  // So three things are required per ordinal, and each closes a different way in:
  //   SIZE STABILITY. `objectSizes[i]` is what every per-object ceiling is derived from. If it moved, the
  //     ordinal is describing a different object and the ceiling belongs to something else. It also catches
  //     a REORDER, for every pair of objects whose sizes differ.
  //   MONOTONICITY, per column, per ordinal. These are lifetime totals; within one endpoint process they
  //     cannot fall, so a fall means the process changed under the gate.
  //   ...on EVERY cumulative column, not only bytes. A class column that reset would let the per-entry
  //     request-shape check pass with a negative delta while the byte column looked fine.
  //
  // WHAT IT STILL CANNOT SEE, STATED RATHER THAN GLOSSED: a permutation of ordinals whose sizes AND whose
  // every cumulative counter are pairwise identical. That permutation is unobservable here — and it is also
  // harmless, because nothing downstream can reach a different verdict from two indistinguishable columns.
  for (let ordinal = 0; ordinal < after.objectSizes.length; ordinal += 1) {
    const sizeBefore = before.objectSizes[ordinal] as number;
    const sizeAfter = after.objectSizes[ordinal] as number;
    if (sizeBefore !== sizeAfter) {
      problems.push({
        kind: 'object-identity-moved',
        detail: `object #${ordinal} was ${sizeBefore} bytes long in the before snapshot and ${sizeAfter} in `
          + 'the after one. Registration ordinals are the only handle these columns carry, so a size that '
          + 'moved means the ordinal is describing a different object and every per-object ceiling derived '
          + 'from it belongs to something else',
      });
    }
  }
  const cumulativeColumns: ReadonlyArray<readonly [string, readonly number[], readonly number[]]> = [
    ['objectBytes', before.objectBytes, after.objectBytes],
    ['objectChunk', before.objectChunk, after.objectChunk],
    ['objectSmall', before.objectSmall, after.objectSmall],
    ['objectPartial', before.objectPartial, after.objectPartial],
    ['objectOversized', before.objectOversized, after.objectOversized],
  ];
  for (const [name, from, to] of cumulativeColumns) {
    for (let ordinal = 0; ordinal < to.length; ordinal += 1) {
      const start = from[ordinal] as number;
      const end = to[ordinal] as number;
      if (end < start) {
        problems.push({
          kind: 'per-object-counter-reset',
          detail: `${name}[${ordinal}] fell from ${start} to ${end} across the window. These are lifetime `
            + 'totals within one endpoint process, so a fall means the process changed under the gate — and '
            + 'a negative per-object delta satisfies every ceiling in this file by arithmetic rather than by '
            + 'behaviour, while a compensating rise elsewhere leaves every aggregate partition intact',
        });
      }
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
