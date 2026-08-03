import { readFileSync } from 'node:fs';
import {
  CONCURRENCY_DEADLINES_MS, HOLD_ARM_MS, THREE_SERVER_IDS,
  type OverlapSample, type ThreeServerId,
} from '../core/projection/three-server-concurrency.js';
import { MEDIA_SERVER_DEADLINES_MS } from '../core/projection/media-server-dataplane.js';
import { embyOrdinaryFileProblems } from '../core/projection/emby-dataplane.js';

import * as emby from './projection-emby-dataplane.js';
import * as jellyfin from './projection-jellyfin-dataplane.js';
import * as plex from './projection-plex-dataplane.js';

// Projection Phase 1 — driving THREE media servers at once, over ONE production mount.
//
// WHAT THIS FILE IS AND, MUCH MORE IMPORTANTLY, WHAT IT IS NOT.
//
// IT IS NOT A FOURTH MEDIA-SERVER DRIVER. It stands nothing up, creates no library, authenticates against
// nothing and knows no endpoint spelling. Every one of those is already written three times, correctly and
// differently, in `projection-{emby,jellyfin,plex}-dataplane.ts`, and the differences are the point: Emby
// publishes no `StartupWizardCompleted`, Plex has no wizard at all and refuses a request whose `Host` header
// it does not recognise, Jellyfin's ordinary-file predicate reads a `LocationType` Emby never sends. A
// combined gate that re-implemented "scan a library" once would have had to pick one server's semantics, and
// two of the three columns in the acceptance plan's §6.1 would quietly stop being about the server they name.
//
// IT IS THE ONE THING NONE OF THEM CAN HAVE: the observation that all three were scanning AT THE SAME TIME.
// That is a property of the SET, on one clock, and nothing that watches a single server can see it — exactly
// as `analyseSeekSet` exists because no per-seek assertion can see that ten seeks were ten different seeks.
//
// SO IT IS AN ADAPTER TABLE AND AN OBSERVER. The adapters are three-line delegations to the real drivers; the
// observer polls all three servers' own present-tense "am I scanning right now" answers on one tick and
// records what it saw. Everything it asserts, `three-server-concurrency.ts` decides, offline.

// ---------------------------------------------------------------------------------------------------------
// The adapters
// ---------------------------------------------------------------------------------------------------------

/** What a media server catalogued, in the only terms a shared corpus assertion is entitled to look at. */
export interface CatalogueEntry {
  readonly key: string;
  readonly sizeBytes: number;
  readonly ordinaryFile: boolean;
  /** Why not, when it is not. Empty for an ordinary file. A count with no diagnosis costs a whole run. */
  readonly problems: readonly string[];
}

export interface ServerAdapter {
  readonly id: ThreeServerId;
  /** Load this server's own state file, written by its own bootstrap. */
  readState(path: string): unknown;
  /** THE SERVER'S OWN PRESENT-TENSE ANSWER. Never "we asked it to scan and have not seen it stop". */
  scanIsRunningNow(state: unknown): Promise<boolean>;
  /** Trigger a scan and wait for THAT execution to finish, through this server's own completion barrier. */
  scanLibrary(state: unknown): Promise<{ observedInFlight: boolean }>;
  /** What it catalogued, through this server's own listing and its own ordinary-file predicate. */
  catalogue(state: unknown): Promise<CatalogueEntry[]>;
}

/**
 * Jellyfin's ordinary-file predicate, copied from its own CLI rather than shared.
 *
 * NOT REFACTORED INTO ONE, AND THAT IS DELIBERATE. `isOrdinaryFile` reads `locationType === 'FileSystem'`,
 * a field Emby omits entirely; `embyOrdinaryFileProblems` reads `mediaSourceType !== 'Placeholder'` instead;
 * Plex's reads `accessible`/`exists` off a `checkFiles=1` response and has no concept of either. Three
 * predicates over three different field sets is not duplication — it is three servers, and the one time this
 * repository flattened them, the flattened predicate matched zero of two correctly catalogued entries.
 */
function jellyfinOrdinaryProblems(item: jellyfin.ItemRecord): string[] {
  const problems: string[] = [];
  if (item.protocol !== 'File') problems.push(`protocol is "${item.protocol}", not File`);
  if (item.isRemote) problems.push('the server calls the media source remote');
  if (item.key.endsWith('.strm')) problems.push('a .strm placeholder is not a projected file');
  if (item.container === '') problems.push('the server never successfully probed the container');
  if (item.locationType !== 'FileSystem') problems.push(`locationType is "${item.locationType}"`);
  if (!item.supportsDirectPlay) problems.push('the server says it cannot direct-play the file');
  return problems;
}

export function adapterFor(id: ThreeServerId): ServerAdapter {
  switch (id) {
    case 'emby':
      return {
        id,
        readState: (path) => emby.readState(path),
        scanIsRunningNow: (state) => emby.scanIsRunningNow(state as emby.GateState),
        scanLibrary: async (state) => emby.scanLibrary(state as emby.GateState),
        catalogue: async (state) => (await emby.listMovies(state as emby.GateState)).map((item) => {
          const problems = embyOrdinaryFileProblems({
            key: item.key,
            protocol: item.protocol,
            container: item.container,
            isRemote: item.isRemote,
            supportsDirectPlay: item.supportsDirectPlay,
            mediaSourceType: item.mediaSourceType,
            path: item.path,
            mediaSourcePath: item.mediaSourcePath,
          });
          return {
            key: item.key, sizeBytes: item.sizeBytes, ordinaryFile: problems.length === 0, problems,
          };
        }),
      };
    case 'jellyfin':
      return {
        id,
        readState: (path) => jellyfin.readState(path),
        scanIsRunningNow: (state) => jellyfin.scanIsRunningNow(state as jellyfin.GateState),
        scanLibrary: async (state) => jellyfin.scanLibrary(state as jellyfin.GateState),
        catalogue: async (state) => (await jellyfin.listMovies(state as jellyfin.GateState)).map((item) => {
          const problems = jellyfinOrdinaryProblems(item);
          return {
            key: item.key, sizeBytes: item.sizeBytes, ordinaryFile: problems.length === 0, problems,
          };
        }),
      };
    case 'plex':
      return {
        id,
        readState: (path) => plex.readState(path),
        scanIsRunningNow: (state) => plex.scanIsRunningNow(state as plex.GateState),
        // PLEX'S SCAN RETURNS ITS OWN LISTING and this adapter throws it away, because the catalogue is read
        // once, afterwards, for every server through the same call. Reading it here for one server and later
        // for the other two would compare three libraries taken at three different moments.
        scanLibrary: async (state) => plex.scanLibrary(state as plex.GateState),
        catalogue: async (state) => (await plex.listMovies(state as plex.GateState)).map((item) => {
          const problems: string[] = [];
          if (!plex.isOrdinaryFile(item)) {
            if (!item.accessible) problems.push('the server cannot open the file through the mount');
            if (!item.exists) problems.push('the server says the file does not exist');
            if (item.container === '') problems.push('the server never successfully probed the container');
            if (item.sizeBytes <= 0) problems.push('the server catalogued the part with no bytes');
            if (problems.length === 0) problems.push('the part is not an ordinary readable file');
          }
          return {
            key: item.key, sizeBytes: item.sizeBytes, ordinaryFile: problems.length === 0, problems,
          };
        }),
      };
    default:
      throw new Error(`no adapter for media server "${String(id)}"`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// The fake endpoint's control and counter surfaces
// ---------------------------------------------------------------------------------------------------------

const CONTROL_TIMEOUT_MS = 15_000;

async function fetchWithDeadline(url: string, init: RequestInit, budgetMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Read the endpoint's counters. Bounded, and a non-2xx is a failure rather than an empty object. */
export async function readCounters(baseUrl: string): Promise<Record<string, unknown>> {
  const response = await fetchWithDeadline(`${baseUrl}/counters`, { method: 'GET' }, CONTROL_TIMEOUT_MS);
  if (!response.ok) throw new Error(`the endpoint answered ${response.status} for its counters`);
  return await response.json() as Record<string, unknown>;
}

/**
 * Block, or unblock, every ranged request for one object.
 *
 * THE CONTROL SURFACE IS NOT TRAFFIC. `/control/hold` and `/control/release` are deliberately not counted as
 * ranged requests or resolutions by the endpoint, so arming the barrier cannot widen the budget the barrier
 * exists to make measurable.
 */
export async function setHold(baseUrl: string, ref: string, held: boolean): Promise<void> {
  const verb = held ? 'hold' : 'release';
  const response = await fetchWithDeadline(
    `${baseUrl}/control/${verb}/${ref}`, { method: 'POST' }, CONTROL_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(`the endpoint answered ${response.status} to a ${verb}`);
}

// ---------------------------------------------------------------------------------------------------------
// The concurrent scan
// ---------------------------------------------------------------------------------------------------------

export interface ConcurrentScanOptions {
  readonly adapters: readonly ServerAdapter[];
  readonly states: ReadonlyMap<string, unknown>;
  /** The fake endpoint, for the barrier hold. Omitted means no barrier — used by the offline suite only. */
  readonly endpointBaseUrl?: string;
  /** The object whose provider read is blocked so the scanners rendezvous rather than race. */
  readonly barrierRef?: string;
  readonly sampleIntervalMs?: number;
  readonly holdArmMs?: number;
  readonly deadlineMs?: number;
  /** Injected for the offline suite. Production passes nothing and gets the wall clock. */
  readonly now?: () => number;
  readonly onNote?: (message: string) => void;
}

export interface PerServerScanOutcome {
  readonly id: string;
  readonly triggeredAtMs: number;
  readonly finishedAtMs: number;
  readonly elapsedSeconds: number;
  /** Whether that server's OWN barrier saw its OWN scanner in flight. Independent of the observer's timeline. */
  readonly observedInFlight: boolean;
  readonly failure?: string;
}

export interface ConcurrentScanOutcome {
  readonly timeline: readonly OverlapSample[];
  readonly perServer: readonly PerServerScanOutcome[];
  readonly triggeredAtMs: readonly number[];
  readonly barrierArmed: boolean;
  readonly barrierReleasedAtMs: number;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Trigger every server's scan together, watch all of them on one clock, and let none of them be waited on
 * forever.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN, AND EVERY STEP OF IT CLOSES SOMETHING:
 *
 *   1. ARM THE BARRIER FIRST. One remote object's provider read is blocked before any scan is triggered, so a
 *      scanner that reaches it stops there instead of racing to the end while another is still starting. Each
 *      server arrives at its own pace and then WAITS, which is what turns "they happened to overlap" into a
 *      rendezvous. It is armed first because arming it afterwards would be arming it into a race.
 *
 *   2. TRIGGER ALL OF THEM IN ONE TICK. Not in a loop with awaits between: `Promise.all` over the three
 *      drivers' own `scanLibrary`, so the three triggers leave this process within milliseconds of each
 *      other. The moment each was launched is RECORDED — and recorded is all it is. Three triggers landing
 *      together says nothing whatever about whether the three scans then overlapped; see
 *      `TRIGGER_SPREAD_IS_NOT_OVERLAP_EVIDENCE`.
 *
 *   3. OBSERVE. One loop, one clock, three answers per tick, each server's own present-tense state. This is
 *      the evidence, and it is the only thing that is.
 *
 *   4. RELEASE THE BARRIER ON THE FIRST THREE-WAY SAMPLE, or when the arm window runs out, whichever comes
 *      first — and the arm window is well inside the daemon's own first-byte deadline, so a hold can never
 *      turn into a failed read that this gate would then be measuring as a data-plane defect. The observer
 *      keeps going after the release: the scans are still running and their overlap is still being watched.
 *
 *   5. EVERY WAIT IS BOUNDED. A server whose scan never returns fails this function rather than occupying
 *      the machine, and its failure is recorded per server so the log says which one.
 */
export async function runConcurrentScans(opts: ConcurrentScanOptions): Promise<ConcurrentScanOutcome> {
  const now = opts.now ?? (() => Date.now());
  const interval = opts.sampleIntervalMs ?? CONCURRENCY_DEADLINES_MS.SAMPLE_INTERVAL;
  const armMs = opts.holdArmMs ?? HOLD_ARM_MS;
  const deadlineMs = opts.deadlineMs ?? CONCURRENCY_DEADLINES_MS.CONCURRENT_SCAN;
  const note = opts.onNote ?? (() => undefined);
  const startedAtMs = now();

  let barrierArmed = false;
  if (opts.endpointBaseUrl !== undefined && opts.barrierRef !== undefined) {
    await setHold(opts.endpointBaseUrl, opts.barrierRef, true);
    barrierArmed = true;
    note('the barrier object\'s provider read is held; a scanner that reaches it will wait there');
  }
  // THE ARM CLOCK STARTS WHEN A REQUEST FIRST BLOCKS, NOT NOW. An armed hold nothing has reached costs
  // nothing and starves no other read, so it stays armed until a scanner actually arrives; only the interval
  // in which something is really waiting has to be bounded. Timing it from the arming would have made the
  // hold expire before the first scanner got there on a slow host, and the gate would then fail its own
  // "a provider request was actually blocked" assertion for having been too careful.
  let blockingSinceMs = 0;
  const heldBaseline = barrierArmed
    ? Number(((await readCounters(opts.endpointBaseUrl as string)).heldRequests ?? 0)) : 0;
  let releasedAtMs = 0;
  const release = async (why: string): Promise<void> => {
    if (!barrierArmed || releasedAtMs !== 0) return;
    releasedAtMs = now();
    try {
      await setHold(opts.endpointBaseUrl as string, opts.barrierRef as string, false);
      const blocked = blockingSinceMs === 0 ? 0 : Math.round((releasedAtMs - blockingSinceMs) / 100) / 10;
      note(`the barrier was released after ${blocked}s of a provider read actually being blocked (${why})`);
    } catch (error) {
      // A RELEASE THAT FAILED IS NOT SWALLOWED, but it must not abort the scan either: the endpoint's own
      // maxHold is shorter than the daemon's first-byte deadline, so the worst case is a slow read that the
      // hold-timeout assertion will then fail on. Saying so beats a bare rejection three phases later.
      note(`WARNING: releasing the barrier failed (${(error as Error).message}); the endpoint's own maxHold `
        + 'will lapse it, and the hold-timeout assertion is what will catch that');
    }
  };

  // THE SCANS. Launched together, awaited later, and never allowed to reject this function on their own:
  // a failure is recorded per server so the observer can still finish and the timeline still be reported.
  const triggeredAtMs: number[] = [];
  const outcomes: PerServerScanOutcome[] = [];
  const running = opts.adapters.map((adapter) => {
    const state = opts.states.get(adapter.id);
    const triggeredAt = now();
    triggeredAtMs.push(triggeredAt);
    return adapter.scanLibrary(state)
      .then((result) => {
        outcomes.push({
          id: adapter.id, triggeredAtMs: triggeredAt, finishedAtMs: now(),
          elapsedSeconds: (now() - triggeredAt) / 1_000, observedInFlight: result.observedInFlight,
        });
      })
      .catch((error: unknown) => {
        outcomes.push({
          id: adapter.id, triggeredAtMs: triggeredAt, finishedAtMs: now(),
          elapsedSeconds: (now() - triggeredAt) / 1_000, observedInFlight: false,
          failure: (error as Error).message,
        });
      });
  });
  const allScans = Promise.all(running);
  let scansFinished = false;
  void allScans.then(() => { scansFinished = true; });

  // THE OBSERVER. It stops when every scan has returned, or when the deadline fires — never on a count of
  // samples, because "we have enough evidence, stop looking" is how an inconvenient later sample disappears.
  const timeline: OverlapSample[] = [];
  let sawThreeWay = false;
  for (;;) {
    const tickStart = now();
    const answers = await Promise.all(opts.adapters.map(async (adapter) => {
      const state = opts.states.get(adapter.id);
      try {
        const inFlight = await adapter.scanIsRunningNow(state);
        return { id: adapter.id, inFlight, at: now(), readable: true };
      } catch {
        // A POLL THAT FAILED IS NOT AN OBSERVATION. It is recorded as unreadable rather than as "not
        // scanning", because an unreachable server and an idle one are different facts with different first
        // suspects, and only one of them is a failure of this gate.
        return { id: adapter.id, inFlight: false, at: now(), readable: false };
      }
    }));
    const answeredAt = answers.map((answer) => answer.at);
    const inFlight: Record<string, boolean> = {};
    const unreadable: string[] = [];
    for (const answer of answers) {
      inFlight[answer.id] = answer.readable && answer.inFlight;
      if (!answer.readable) unreadable.push(answer.id);
    }
    timeline.push({
      atMs: tickStart - startedAtMs,
      spanMs: Math.max(...answeredAt) - Math.min(...answeredAt),
      inFlight,
      unreadable,
    });

    // THE BARRIER'S OWN GAUGE, ON THE SAME TICK. `/counters` is the endpoint's UNCOUNTED control surface —
    // reading it is not a ranged request and not a resolution — so watching the hold cannot widen the budget
    // the hold exists to make measurable.
    if (barrierArmed && releasedAtMs === 0) {
      try {
        const counters = await readCounters(opts.endpointBaseUrl as string);
        const held = Number(counters.heldRequests ?? 0);
        if (blockingSinceMs === 0 && held > heldBaseline) {
          blockingSinceMs = now();
          note('a provider read is blocked at the barrier; the bounded blocking window starts now');
        }
      } catch {
        // A counters poll that failed says nothing about the hold. The release below is still bounded by the
        // deadline, and the endpoint's own maxHold is the backstop.
      }
    }

    if (!sawThreeWay && unreadable.length === 0
      && opts.adapters.every((adapter) => inFlight[adapter.id] === true)) {
      sawThreeWay = true;
      await release('all servers were observed scanning at once');
    }
    if (barrierArmed && releasedAtMs === 0 && blockingSinceMs !== 0 && now() - blockingSinceMs >= armMs) {
      await release('the bounded blocking window elapsed, which is strictly inside the daemon\'s '
        + 'admission queue-wait budget so no other object\'s read can have been starved');
    }
    if (scansFinished) break;
    if (now() - startedAtMs > deadlineMs) {
      await release('the concurrent-scan deadline fired');
      break;
    }
    await sleep(interval);
  }

  // THE BARRIER IS RELEASED WHATEVER HAPPENED. A gate that failed between arming and releasing would leave
  // the endpoint blocking a read that the NEXT phase would then time out on, and the failure would name the
  // wrong thing.
  await release('the observation window closed');
  await allScans;

  return {
    timeline,
    perServer: outcomes.sort((a, b) => a.id.localeCompare(b.id)),
    triggeredAtMs,
    barrierArmed,
    barrierReleasedAtMs: releasedAtMs,
    startedAtMs,
    finishedAtMs: now(),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Small shared readers
// ---------------------------------------------------------------------------------------------------------

/** The shared corpus expectation, recorded outside the mount before anything was published. */
export interface ExpectedEntry {
  readonly key: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly kind: 'local' | 'http-range';
  readonly anchor?: boolean;
}

export function readExpected(path: string): ExpectedEntry[] {
  return JSON.parse(readFileSync(path, 'utf8')) as ExpectedEntry[];
}

/** Every server this gate drives, in the order the acceptance plan's table lists them. */
export function allAdapters(): ServerAdapter[] {
  return THREE_SERVER_IDS.map((id) => adapterFor(id));
}

/** The per-server scan deadline, exported so the gate's own log can state the bound it is holding to. */
export const PER_SERVER_SCAN_DEADLINE_MS = Math.min(
  MEDIA_SERVER_DEADLINES_MS.LIBRARY_SCAN * 2, CONCURRENCY_DEADLINES_MS.PER_SERVER_SCAN,
);
