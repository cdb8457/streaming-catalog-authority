import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  Deadline, GATE_CLIENT, MEDIA_SERVER_DEADLINES_MS, MEDIA_SERVER_POLL_INTERVAL_MS, SEEK_SETTLE_MS,
  ScanBarrier, directPlayPath, forcedTranscodePath, hasQueryCredential, isInFlightState,
  TICKS_PER_SECOND, mediaServerAuthHeader, movieLibraryRequest, opaqueRef, stripQueryCredentials,
  type GateResult, type PacedSample, type ScanTaskSample, type SeekObservation, type SoakSegment,
} from '../core/projection/media-server-dataplane.js';

// Projection Phase 1 — driving a REAL Jellyfin against the projected mount.
//
// WHAT THIS IS, AND WHAT IT IS NOT. This is the data-plane half: a real Jellyfin container, bootstrapped
// through its own first-run API, given the FUSE mount as a library root, made to scan it, and then made to
// direct-play, seek and transcode out of it. It is NOT the existing Jellyfin control-plane work — that talks
// to a fake server about collections and never opens a byte of media. The two share a product name and
// nothing else, and this file is deliberately the only place the data-plane half lives.
//
// EVERY WAIT HAS A DEADLINE. There is no unbounded loop in this file. A media server that never finishes a
// scan, a mount that never appears and a transcode that never emits a segment are all failures, and each one
// fails with a message naming the wait it blew rather than by occupying the machine.
//
// NOTHING HERE IS AN OPERATOR SURFACE. It is a gate driver. It is not wired to any `ops:` command that an
// installation would run, it hard-codes no endpoint, and it holds the media server's credential in memory and
// in one scratch file under the gate's own run directory, which the gate deletes.

// ---------------------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------------------

export interface GateState {
  readonly baseUrl: string;
  token?: string;
  userId?: string;
  libraryId?: string;
  libraryName?: string;
}

export interface ItemRecord {
  /** The basename of the projected file, which is how the gate matches an item to what it published. */
  readonly key: string;
  readonly itemId: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly container: string;
  readonly protocol: string;
  readonly mediaSourceId: string;
  readonly videoCodec: string;
  readonly isRemote: boolean;
  readonly locationType: string;
  readonly supportsDirectPlay: boolean;
}

export class GateFailure extends Error {}

function now(): number { return Date.now(); }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** One in-flight exchange: the response, and the timer that will kill it if it stops making progress. */
interface Exchange {
  readonly response: Response;
  /** Clear the watchdog. MUST be called once the body has been consumed or cancelled. */
  release(): void;
}

/**
 * One request to the media server, with a hard deadline over the WHOLE exchange.
 *
 * THE WATCHDOG IS A REF'D TIMER, AND THAT IS THE ENTIRE POINT OF THIS FUNCTION EXISTING.
 *
 * The obvious spelling is `signal: AbortSignal.timeout(ms)`. It is wrong here, and wrong in a way that took
 * three runs to see: the timer behind `AbortSignal.timeout` is UNREF'D — by design, so that a pending timeout
 * cannot keep a program alive. Combined with an idle undici socket, that leaves an `await fetch(...)` with
 * NOTHING holding the event loop open. Node then does what it is supposed to do with an empty loop: it exits,
 * normally, with status 0, and whatever was buffered on stdout is lost.
 *
 * What that looked like from outside was a gate phase that printed nothing, wrote no state file, and
 * "succeeded" — while the media server was still starting up and had accepted the TCP connection without
 * answering it yet. A retry loop cannot save you from this, because the loop never gets a turn: the promise it
 * is awaiting never settles and never rejects.
 *
 * So the deadline is an explicit `AbortController` behind an ordinary, ref'd `setTimeout`. It keeps the
 * process alive exactly as long as the request is allowed to take, and then aborts it — which turns a hang
 * into a named failure instead of a silent success.
 */
async function request(
  state: GateState, method: string, path: string,
  options: { body?: unknown; range?: string; timeoutMs?: number; accept?: string } = {},
): Promise<Exchange> {
  const headers: Record<string, string> = {
    Authorization: mediaServerAuthHeader(state.token),
    Accept: options.accept ?? 'application/json',
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.range !== undefined) headers.Range = options.range;
  const timeoutMs = options.timeoutMs ?? MEDIA_SERVER_DEADLINES_MS.API_REQUEST;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(`${state.baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'manual',
      signal: controller.signal,
    });
    return { response, release: () => clearTimeout(timer) };
  } catch (error) {
    clearTimeout(timer);
    // The URL is deliberately absent from the message: it carries the api key.
    const why = timedOut ? 'timed out' : (error as Error).name;
    throw new GateFailure(`${method} ${path.split('?')[0]} failed after ${timeoutMs}ms: ${why}`);
  }
}

async function json<T>(
  state: GateState, method: string, path: string, body?: unknown, timeoutMs?: number,
): Promise<T> {
  const exchange = await request(state, method, path, { body, ...(timeoutMs ? { timeoutMs } : {}) });
  try {
    const { response } = exchange;
    if (response.status < 200 || response.status >= 300) {
      const detail = (await response.text().catch(() => '')).slice(0, 400);
      throw new GateFailure(`${method} ${path.split('?')[0]} answered ${response.status}: ${detail}`);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text === '' ? undefined : JSON.parse(text)) as T;
  } finally {
    exchange.release();
  }
}

/**
 * Poll until a predicate holds, or the deadline lapses.
 *
 * THE DEADLINE IS THE ONLY EXIT other than success. This is the shape every wait in this gate takes, and it
 * exists once so that no phase can grow a `while (true)` of its own.
 */
async function until<T>(
  label: string, budgetMs: number, probe: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = new Deadline(label, budgetMs, now());
  let lastError = '';
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = (error as Error).message;
    }
    if (deadline.expired(now())) {
      throw new GateFailure(`${deadline.message()}${lastError ? ` (last: ${lastError})` : ''}`);
    }
    await sleep(MEDIA_SERVER_POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------------------------------------

interface PublicInfo { StartupWizardCompleted?: boolean; Version?: string }

export async function awaitServer(state: GateState): Promise<string> {
  const info = await until('the media server to answer its public info endpoint',
    MEDIA_SERVER_DEADLINES_MS.SERVER_READY, async () => {
      const exchange = await request(state, 'GET', '/System/Info/Public', { timeoutMs: 5_000 });
      try {
        if (!exchange.response.ok) return undefined;
        return await exchange.response.json() as PublicInfo;
      } finally {
        exchange.release();
      }
    });
  return info.Version ?? 'unknown';
}

/**
 * The non-interactive first-run wizard, then an ordinary login.
 *
 * THIS IS THE SERVER'S OWN BOUNDARY, not a config file dropped into its data directory. Writing
 * `system.xml` and a hand-made user row would prove that this gate can forge a Jellyfin installation; going
 * through `/Startup/*` proves that a real one can be stood up by a machine, which is the thing an operator
 * would actually be doing.
 */
export async function bootstrap(state: GateState, username: string, password: string): Promise<void> {
  const info = await json<PublicInfo>(state, 'GET', '/System/Info/Public');
  if (info?.StartupWizardCompleted !== true) {
    await json(state, 'POST', '/Startup/Configuration', {
      UICulture: 'en-US', MetadataCountryCode: 'US', PreferredMetadataLanguage: 'en',
    });
    // Asked for, not skipped: the wizard expects this read before it will take the user.
    await json(state, 'GET', '/Startup/User');
    await json(state, 'POST', '/Startup/User', { Name: username, Password: password });
    await json(state, 'POST', '/Startup/RemoteAccess', {
      EnableRemoteAccess: true, EnableAutomaticPortMapping: false,
    });
    await json(state, 'POST', '/Startup/Complete');
  }

  const auth = await json<{ AccessToken?: string; User?: { Id?: string } }>(
    state, 'POST', '/Users/AuthenticateByName', { Username: username, Pw: password },
  );
  if (!auth?.AccessToken || !auth.User?.Id) throw new GateFailure('the media server issued no access token');
  state.token = auth.AccessToken;
  state.userId = auth.User.Id;
}

interface VirtualFolder { Name?: string; ItemId?: string; Locations?: string[] }

async function virtualFolder(state: GateState, name: string): Promise<VirtualFolder> {
  return until('the library to appear in the virtual folder list',
    MEDIA_SERVER_DEADLINES_MS.API_REQUEST, async () => {
      const all = await json<VirtualFolder[]>(state, 'GET', '/Library/VirtualFolders');
      return all?.find((folder) => folder.Name === name);
    });
}

/**
 * Add the projected mount as a Movies library.
 *
 * THE LIBRARY ID IS NOT AVAILABLE YET, AND WAITING FOR IT HERE WOULD HANG. Jellyfin creates the virtual
 * folder immediately but does not mint the library ITEM behind it until the first refresh, so `ItemId` is
 * absent from the folder list until a scan has run. An earlier version demanded it here and failed every run
 * with "the created library has no id" — a gate that could never pass. What IS checkable now is that the
 * folder exists and points at the mount, and that is what this asserts; `resolveLibraryId` picks the id up
 * after the first scan.
 */
export async function addMovieLibrary(state: GateState, mountPath: string, name: string): Promise<void> {
  const query = new URLSearchParams({ name, collectionType: 'movies', refreshLibrary: 'false' });
  await json(state, 'POST', `/Library/VirtualFolders?${query.toString()}`, movieLibraryRequest(mountPath));

  const folder = await virtualFolder(state, name);
  if (!(folder.Locations ?? []).includes(mountPath)) {
    throw new GateFailure('the created library does not point at the projected mount');
  }
  state.libraryName = name;
  if (folder.ItemId) state.libraryId = folder.ItemId;
}

/** The library id, once a scan has caused one to exist. Bounded, and it does not invent one. */
export async function resolveLibraryId(state: GateState): Promise<string | undefined> {
  if (state.libraryId !== undefined) return state.libraryId;
  if (state.libraryName === undefined) return undefined;
  const folder = await virtualFolder(state, state.libraryName);
  if (folder.ItemId) state.libraryId = folder.ItemId;
  return state.libraryId;
}

interface ScheduledTask extends ScanTaskSample { Key?: string }

const SCAN_TASK_KEY = 'RefreshLibrary';

async function scanTask(state: GateState): Promise<ScheduledTask | undefined> {
  const tasks = await json<ScheduledTask[]>(state, 'GET', '/ScheduledTasks?isHidden=false');
  return tasks?.find((task) => task.Key === SCAN_TASK_KEY);
}

export interface ScanOutcome {
  readonly elapsedMs: number;
  /**
   * Whether the scanner was observed IN FLIGHT — a sample that said it was running — as opposed to having
   * started and finished between two polls. A fast-complete is a valid completion and is NOT this.
   */
  readonly observedInFlight: boolean;
}

/**
 * Trigger a real scan, wait for it to actually start, and wait for that execution to actually finish.
 *
 * WAITING FOR THE TASK, NOT FOR THE ITEM COUNT. An item-count wait passes the moment the expected number of
 * items exists, which can be BEFORE the scan finished — so a re-scan assertion made straight afterwards would
 * be racing a scanner that was still writing. The count is checked too, by the caller, because a scanner that
 * finished having found nothing is also a failure.
 *
 * `onRunning` fires the first time the scan is observed in flight. The mid-scan gate uses it as its
 * synchronisation point: it is the only moment at which "publish a successor WHILE a scan is running" can be
 * asserted rather than hoped for.
 */
export async function scanLibrary(
  state: GateState, onRunning?: () => void,
): Promise<ScanOutcome> {
  // The baseline is read BEFORE the trigger. Everything the barrier concludes is relative to it, which is
  // what makes a stale `Idle` left over from a previous scan unable to satisfy anything.
  const baseline = (await scanTask(state))?.LastExecutionResult?.StartTimeUtc;
  const barrier = new ScanBarrier(baseline);
  const startedAt = now();
  let announced = false;

  await json(state, 'POST', '/Library/Refresh');
  await until('the library scan to start and then finish', MEDIA_SERVER_DEADLINES_MS.LIBRARY_SCAN, async () => {
    const phase = barrier.observe(await scanTask(state));
    // KEYED ON THE IN-FLIGHT FACT ITSELF, NOT ON A PHASE THAT HAPPENS TO IMPLY IT.
    //
    // This used to read `phase === 'running'`, which was true for two different things: an authoritative
    // Running/Cancelling sample, and — before `indeterminate` existed — any new execution under a state this
    // code could not read. So `Restarting` plus a new timestamp raised the mid-scan marker that this callback
    // exists to gate, while `observedInFlight` correctly stayed false. Reading the fact directly means the
    // callback cannot drift from it again, whatever the phase vocabulary grows into. `announced` is what
    // stops a historical true from re-firing on every later poll.
    if (barrier.observedInFlight && !announced) {
      announced = true;
      onRunning?.();
    }
    return phase === 'complete' ? true : undefined;
  });
  return { elapsedMs: now() - startedAt, observedInFlight: barrier.observedInFlight };
}

/**
 * Wait until the scan is observed IN FLIGHT, without waiting for it to finish.
 *
 * This is the seam the mid-scan gate publishes against. It exists separately from `scanLibrary` because the
 * scan is driven by a different process there, and a second observer polling the same task is the honest way
 * to synchronise two processes against one server-side fact.
 */
export async function awaitScanRunning(state: GateState, baseline: string | undefined): Promise<void> {
  const barrier = new ScanBarrier(baseline);
  // A DISCRIMINATED OUTCOME RATHER THAN A THROW INSIDE THE PROBE. `until` catches whatever a probe throws and
  // retries it until the deadline, so raising from in there would have turned "the scan finished before I saw
  // it" into a silent poll loop that eventually reported a timeout against the wrong wait.
  const outcome = await until('the library scan to be observed running',
    MEDIA_SERVER_DEADLINES_MS.LIBRARY_SCAN, async () => {
      const phase = barrier.observe(await scanTask(state));
      // The same fact, read the same way. An `indeterminate` sample keeps the wait going and licenses
      // nothing; only an authoritative in-flight observation succeeds here.
      if (barrier.observedInFlight) return 'running' as const;
      if (phase === 'complete') return 'finished-unseen' as const;
      return undefined;
    });
  if (outcome !== 'running') {
    // NOT A SUCCESS, AND NOT A TIMEOUT EITHER. The scan started and finished between two polls. That is a
    // perfectly good completion for anything that only needed the scan to be over — and it is useless to a
    // caller that has to act WHILE the scan is running, because there is no longer a while.
    throw new GateFailure(
      'the library scan completed between polls and was never observed in flight, so nothing can be '
      + 'published "while a scan is running"');
  }
}

/** The scan task's last execution start, for use as a barrier baseline. */
export async function scanBaseline(state: GateState): Promise<string | undefined> {
  return (await scanTask(state))?.LastExecutionResult?.StartTimeUtc;
}

/**
 * Is the scanner running RIGHT NOW? One sample, no baseline, no history.
 *
 * WHY A SECOND, SIMPLER QUESTION EXISTS. The mid-scan gate has two processes: one watches the scan and
 * signals when it sees it running, the other publishes on that signal. Between the signal being written and
 * the publish landing, the scan can finish — and the marker, being a file, cannot un-write itself. So the
 * publishing side asks this immediately before it acts, and refuses if the answer is no.
 *
 * It deliberately takes no baseline and consults no barrier. "Is it running now" is a present-tense fact
 * about one sample; involving history would only let a past observation vouch for a present claim, which is
 * the whole family of mistake this is here to prevent.
 */
export async function scanIsRunningNow(state: GateState): Promise<boolean> {
  const task = await scanTask(state);
  if (task === undefined) return false;
  // ONLY THE AUTHORITATIVE STATE FIELD. A non-null progress percentage alongside `Idle` is what a completing
  // task looks like when the response is serialized between clearing its cancellation token source and
  // clearing its progress — a scan that has just finished, not one that is running.
  return isInFlightState(task.State);
}

interface RawItem {
  Id?: string;
  Name?: string;
  Path?: string;
  LocationType?: string;
  MediaSources?: Array<{
    Id?: string; Path?: string; Size?: number; Container?: string; Protocol?: string; IsRemote?: boolean;
    SupportsDirectPlay?: boolean;
    MediaStreams?: Array<{ Type?: string; Codec?: string }>;
  }>;
}

export async function listMovies(state: GateState): Promise<ItemRecord[]> {
  const query = new URLSearchParams({
    userId: state.userId ?? '',
    recursive: 'true',
    includeItemTypes: 'Movie',
    fields: 'Path,MediaSources',
    enableTotalRecordCount: 'true',
  });
  // Scoped to the library WHEN THERE IS ONE. `parentId=` with an empty value is not "every library", it is a
  // malformed id, and the server's answer to it is not something this gate should be interpreting.
  if (state.libraryId !== undefined) query.set('parentId', state.libraryId);
  const page = await json<{ Items?: RawItem[] }>(state, 'GET', `/Items?${query.toString()}`);
  const items: ItemRecord[] = [];
  for (const raw of page?.Items ?? []) {
    const source = raw.MediaSources?.[0];
    if (!raw.Id || !raw.Path || !source) {
      throw new GateFailure(`the server returned an item with no id, path or media source: ${raw.Name ?? '?'}`);
    }
    const video = source.MediaStreams?.find((stream) => stream.Type === 'Video');
    items.push({
      key: raw.Path.split('/').pop() as string,
      itemId: raw.Id,
      path: raw.Path,
      sizeBytes: source.Size ?? -1,
      container: source.Container ?? '',
      protocol: source.Protocol ?? '',
      mediaSourceId: source.Id ?? raw.Id,
      videoCodec: video?.Codec ?? '',
      isRemote: source.IsRemote === true,
      locationType: raw.LocationType ?? '',
      supportsDirectPlay: source.SupportsDirectPlay === true,
    });
  }
  return items.sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------------------------------------
// Reading bytes back
// ---------------------------------------------------------------------------------------------------------

export interface StreamResult {
  readonly status: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentRange: string | null;
}

/**
 * Read a response body to the end, hashing as it goes, under one deadline for the WHOLE body.
 *
 * HASHED INCREMENTALLY, NOT BUFFERED. A direct play of a multi-megabyte file is the ordinary case here and
 * `await response.arrayBuffer()` would hold all of it; worse, a server that answered with a body far larger
 * than the file would be met with memory pressure rather than with an assertion.
 */
async function drain(exchange: Exchange, maxBytes: number): Promise<StreamResult> {
  const { response } = exchange;
  const hash = createHash('sha256');
  let total = 0;
  const body = response.body;
  const contentRange = response.headers.get('content-range');
  if (body === null) {
    exchange.release();
    return { status: response.status, bytes: 0, sha256: hash.digest('hex'), contentRange };
  }
  // The exchange's own watchdog covers the body too: a stream that stops delivering chunks is aborted rather
  // than awaited forever, and the abort surfaces here as a rejected read.
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new GateFailure(`the response body exceeded ${maxBytes} bytes, which is more than was published`);
      }
      hash.update(value);
    }
  } catch (error) {
    throw new GateFailure(`the response body stopped after ${total} bytes: ${(error as Error).message}`);
  } finally {
    await reader.cancel().catch(() => undefined);
    exchange.release();
  }
  return { status: response.status, bytes: total, sha256: hash.digest('hex'), contentRange };
}

/**
 * ONE response body, held open across an event, read in two halves from the SAME reader.
 *
 * THE DEFECT THIS REPLACES, AND WHY IT MATTERED. `hold-stream` used to call `rangeRead` for a prefix and
 * `rangeRead` again for the remainder. `rangeRead` drains its response to completion and releases it — so the
 * first call finished the HTTP exchange, Jellyfin closed its file, and projectiond saw a RELEASE. The gate
 * then published a successor and issued a brand-new request. What it proved was that two requests succeed on
 * either side of a swap. What it CLAIMED, in its own gate id and in the final report, was that an active
 * stream survived one — which is a different and much stronger statement, and was not being measured at all.
 *
 * WHAT THIS PROVES INSTEAD. A single `GET` is opened and partially consumed. The reader is then left alone —
 * not cancelled, not drained — while the gate publishes a successor and waits for the daemon to admit it.
 * Consumption then resumes from the same reader and runs to the end, and the digest is taken over the WHOLE
 * body. If the response had been closed, re-opened, or served from a different generation, that digest fails.
 *
 * SOCKET BUFFERING IS THE OBVIOUS WAY TO FOOL THIS, so it is measured rather than assumed. `bytesBefore`
 * records how much had arrived when the gate paused; the caller asserts that a substantial share of the file
 * arrived AFTER the event. A body that had already been buffered in full would show nothing arriving
 * afterwards and would fail that assertion — which is exactly the case where "held open" would be a fiction.
 */
export interface PinnedStream {
  /** Consume until at least `target` bytes have been read. Throws if the body ends first. */
  readAtLeast(target: number): Promise<void>;
  /** Bytes consumed so far. */
  readonly bytesRead: number;
  /** Whether the body has already ended. If this is true at the pause point, nothing was held open. */
  readonly ended: boolean;
  /** Consume the rest and return the digest over everything read from this one response. */
  finish(): Promise<StreamResult>;
  cancel(): Promise<void>;
}

export async function openPinnedStream(state: GateState, item: ItemRecord): Promise<PinnedStream> {
  const exchange = await request(state, 'GET',
    directPlayPath(item.itemId, item.mediaSourceId),
    { timeoutMs: MEDIA_SERVER_DEADLINES_MS.DIRECT_PLAY, accept: '*/*' });
  const { response } = exchange;
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    exchange.release();
    throw new GateFailure(`opening a stream answered ${response.status}, not 200`);
  }
  if (response.body === null) {
    exchange.release();
    throw new GateFailure('the stream had no body');
  }

  const reader = response.body.getReader();
  const hash = createHash('sha256');
  let bytesRead = 0;
  let ended = false;

  const pump = async (): Promise<boolean> => {
    const { done, value } = await reader.read();
    if (done) { ended = true; return false; }
    bytesRead += value.byteLength;
    hash.update(value);
    return true;
  };

  return {
    get bytesRead() { return bytesRead; },
    get ended() { return ended; },
    async readAtLeast(target: number): Promise<void> {
      while (bytesRead < target) {
        if (!(await pump())) {
          throw new GateFailure(`the stream ended after ${bytesRead} bytes, before the ${target} asked for`);
        }
      }
    },
    async finish(): Promise<StreamResult> {
      try {
        while (await pump()) { /* to the end of this one response */ }
      } catch (error) {
        throw new GateFailure(`the held-open stream failed after ${bytesRead} bytes: ${(error as Error).message}`);
      } finally {
        exchange.release();
      }
      return {
        status: response.status, bytes: bytesRead, sha256: hash.digest('hex'),
        contentRange: response.headers.get('content-range'),
      };
    },
    async cancel(): Promise<void> {
      await reader.cancel().catch(() => undefined);
      exchange.release();
    },
  };
}

export async function directPlay(state: GateState, item: ItemRecord, maxBytes: number): Promise<StreamResult> {
  const exchange = await request(state, 'GET',
    directPlayPath(item.itemId, item.mediaSourceId),
    { timeoutMs: MEDIA_SERVER_DEADLINES_MS.DIRECT_PLAY, accept: '*/*' });
  if (exchange.response.status !== 200) {
    await exchange.response.body?.cancel().catch(() => undefined);
    exchange.release();
    throw new GateFailure(`direct play answered ${exchange.response.status}, not 200`);
  }
  return drain(exchange, maxBytes);
}

/**
 * A real HTTP seek, and the 206 semantics that make it one.
 *
 * A SERVER MAY ANSWER A RANGED REQUEST WITH 200 AND THE WHOLE FILE, and a client that only hashed the bytes
 * it wanted would never notice — it would slice the prefix it asked for out of a full download and pass. So
 * the status line and the `Content-Range` header are asserted before the body is looked at, and a 200 is a
 * failure here rather than a slow success.
 */
export async function rangeRead(
  state: GateState, item: ItemRecord, offset: number, length: number,
): Promise<StreamResult> {
  const last = offset + length - 1;
  // The whole read shares one budget, scaled to how much is being asked for: a 14 MB tail is not a 128 KiB
  // window, and one flat ceiling would either fail the big read or let the small one hang.
  const budgetMs = MEDIA_SERVER_DEADLINES_MS.RANGE_READ
    + Math.ceil(length / 262_144) * MEDIA_SERVER_POLL_INTERVAL_MS;
  const exchange = await request(state, 'GET',
    directPlayPath(item.itemId, item.mediaSourceId),
    { range: `bytes=${offset}-${last}`, timeoutMs: budgetMs, accept: '*/*' });
  const { response } = exchange;
  const abandon = async (message: string): Promise<never> => {
    await response.body?.cancel().catch(() => undefined);
    exchange.release();
    throw new GateFailure(message);
  };
  if (response.status !== 206) {
    return abandon(`a ranged request answered ${response.status}, not 206 Partial Content`);
  }
  const contentRange = response.headers.get('content-range');
  const expected = `bytes ${offset}-${last}/${item.sizeBytes}`;
  if (contentRange !== expected) {
    return abandon(`Content-Range was "${contentRange}", not "${expected}"`);
  }
  const result = await drain(exchange, length);
  if (result.bytes !== length) {
    throw new GateFailure(`a ranged read returned ${result.bytes} bytes, not ${length}`);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// Forced transcode
// ---------------------------------------------------------------------------------------------------------

export interface TranscodeResult {
  readonly segments: number;
  readonly bytes: number;
  readonly sessionSawTranscode: boolean;
  readonly transcodeReasons: readonly string[];
  readonly firstSegment: Uint8Array;
  /** Server-generated playlist URLs that carried a live credential. Expected: zero. */
  readonly credentialsInGeneratedUrls: number;
}

/**
 * Force a transcode, consume its output, and bring back a segment for somebody else to decode.
 *
 * WHAT THIS FUNCTION DOES NOT ASSERT, ON PURPOSE. It does not conclude "a transcode happened" from the fact
 * that a transcoding endpoint answered. It brings back the first segment's bytes, and the caller proves the
 * claim by DECODING them and finding a codec the source is not. The session bookkeeping below is recorded
 * because it is useful, and it is corroboration rather than evidence.
 */
export async function forcedTranscode(
  state: GateState, item: ItemRecord, maxSegments: number, maxBytes: number,
): Promise<TranscodeResult> {
  const playSessionId = `gate-${opaqueRef('session', item.itemId).slice(0, 16)}`;
  const masterPath = forcedTranscodePath(item.itemId, item.mediaSourceId, playSessionId);
  const master = await request(state, 'GET', masterPath,
    { timeoutMs: MEDIA_SERVER_DEADLINES_MS.TRANSCODE, accept: '*/*' });
  let masterBody: string;
  try {
    if (master.response.status !== 200) {
      throw new GateFailure(`the transcode manifest answered ${master.response.status}, not 200`);
    }
    masterBody = await master.response.text();
  } finally {
    master.release();
  }
  const variantRef = firstPlaylistLine(masterBody);
  if (variantRef === undefined) throw new GateFailure('the transcode master playlist named no variant');

  // EVERY SERVER-GENERATED URL THIS GATE FOLLOWS IS INSPECTED BEFORE IT IS FOLLOWED. Measured against the
  // pinned Jellyfin, a header-authenticated request produces children with no credential in them, so this
  // counter stays at zero; it is here because following a URL verbatim is how a token the server chose to
  // embed would end up in this process's request path, and from there in any diagnostic that prints one.
  let credentialsInGeneratedUrls = 0;
  const follow = (from: string, reference: string): string => {
    const resolved = absolutePath(from, reference);
    if (hasQueryCredential(resolved)) credentialsInGeneratedUrls += 1;
    return stripQueryCredentials(resolved);
  };

  const variantPath = follow(masterPath, variantRef);
  // The variant playlist is where the segments are, and asking for it is what actually starts the ffmpeg job.
  const variant = await until('the transcode variant playlist to list a segment',
    MEDIA_SERVER_DEADLINES_MS.TRANSCODE, async () => {
      const exchange = await request(state, 'GET', variantPath,
        { timeoutMs: MEDIA_SERVER_DEADLINES_MS.API_REQUEST, accept: '*/*' });
      try {
        if (exchange.response.status !== 200) {
          await exchange.response.body?.cancel().catch(() => undefined);
          return undefined;
        }
        const body = await exchange.response.text();
        const segments = body.split('\n').map((line) => line.trim())
          .filter((line) => line !== '' && !line.startsWith('#'));
        return segments.length > 0 ? segments : undefined;
      } finally {
        exchange.release();
      }
    });

  let bytes = 0;
  let first: Uint8Array = new Uint8Array(0);
  const wanted = variant.slice(0, maxSegments);
  for (const segment of wanted) {
    // Resolved against the VARIANT playlist, which is the document that named it — not against the master.
    // Both happen to live in the same directory on this server, so the distinction costs nothing here and
    // would be a wrong URL on any server that did not.
    const exchange = await request(state, 'GET', follow(variantPath, segment),
      { timeoutMs: MEDIA_SERVER_DEADLINES_MS.TRANSCODE, accept: '*/*' });
    let buffer: Uint8Array;
    try {
      if (exchange.response.status !== 200) {
        throw new GateFailure(`a transcode segment answered ${exchange.response.status}, not 200`);
      }
      buffer = new Uint8Array(await exchange.response.arrayBuffer());
    } finally {
      exchange.release();
    }
    if (buffer.byteLength === 0) throw new GateFailure('a transcode segment was empty');
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new GateFailure(`the transcode produced more than ${maxBytes} bytes`);
    if (first.byteLength === 0) first = buffer;
  }

  const sessions = await json<Array<{
    NowPlayingItem?: { Id?: string }; TranscodingInfo?: { IsVideoDirect?: boolean; TranscodeReasons?: string[] };
  }>>(state, 'GET', '/Sessions').catch(() => []);
  const mine = (sessions ?? []).find((session) => session.NowPlayingItem?.Id === item.itemId);
  const info = mine?.TranscodingInfo;

  // Stop the job rather than leaving an ffmpeg running for the rest of the gate. Header-only, like every
  // other authenticated call here; this endpoint answers 401 without a valid credential, so the header is
  // doing real work and the token still never enters a URL.
  await request(state, 'DELETE',
    `/Videos/ActiveEncodings?deviceId=${encodeURIComponent(GATE_CLIENT.deviceId)}`
    + `&playSessionId=${encodeURIComponent(playSessionId)}`,
  ).then((exchange) => exchange.release()).catch(() => undefined);

  return {
    segments: wanted.length,
    bytes,
    sessionSawTranscode: info !== undefined && info.IsVideoDirect !== true,
    transcodeReasons: info?.TranscodeReasons ?? [],
    firstSegment: first,
    credentialsInGeneratedUrls,
  };
}

function firstPlaylistLine(playlist: string): string | undefined {
  return playlist.split('\n').map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('#'));
}

// ---------------------------------------------------------------------------------------------------------
// The five-minute gates
// ---------------------------------------------------------------------------------------------------------

/**
 * Strip anything that looks like a locator out of a diagnostic before it is allowed anywhere near an output.
 *
 * The consumer's stderr is worth keeping when it fails — "connection refused", "401", "invalid data" are the
 * difference between a diagnosable failure and a shrug. It is also the one place in this gate where a full URL
 * is guaranteed to appear, because ffmpeg echoes its input. §7's redaction rule has no exception for error
 * paths, and an exception is exactly where a leak would live.
 */
export function withoutLocators(text: string): string {
  return text
    .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"]*/g, '<locator>')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<address>');
}

export interface PacedPlayOptions {
  readonly image: string;
  readonly network: string;
  readonly containerName: string;
  /** Host directory bound in at `/work`. The consumer's output is written under it. */
  readonly workDir: string;
  /** Where the consumer reads from. It never reaches a result, a report or a log line. */
  readonly streamUrl: string;
  /** Where the decoded output is written, relative to `/work`. */
  readonly outputRelPath: string;
  readonly seconds: number;
  readonly ffmpegPath: string;
}

export interface PacedPlayOutcome {
  readonly samples: PacedSample[];
  readonly exitCode: number | null;
  readonly stderr: string;
}

/**
 * Consume a direct play AT THE SPEED THE MEDIA PLAYS, and record what happened while it did.
 *
 * WHY NOT `fetch` AND A LOOP. Because the thing G8 asks about is not whether the bytes arrive. A `fetch` that
 * drains a six-megabyte file takes a second or two through this mount; wrapping it in `await sleep(300_000)`
 * produces a phase that takes five minutes, reads the whole file, and proves that a download and a sleep both
 * work. Every part of "direct play starts within 10 s and runs 5 minutes without a stall" — starting,
 * running, stalling — is about a DECODER's progress through the media, and nothing that only counts bytes can
 * see any of it.
 *
 * `-re` IS THE WHOLE MECHANISM. It makes ffmpeg read its input at the media's own frame rate rather than as
 * fast as the socket allows, which is what a player does and what makes the read pattern through the mount a
 * playback rather than a copy. `-progress` then makes the decoder report its position about once a second,
 * and each record is stamped with the wall clock HERE, on arrival — so the trace carries both clocks and the
 * pure analysis can compare them. A trace with one clock cannot tell a play from a drain.
 *
 * IT RUNS IN THE PINNED MEDIA-SERVER IMAGE, on the gate's own network, so the consumer is the same ffmpeg the
 * server itself ships and the stream is reached container-to-container rather than through a published port.
 *
 * IT SENDS NO CREDENTIAL, and that is a deliberate consequence of a measurement rather than an oversight:
 * §3.1 of the data-plane document records that this server answers `static=true` direct play to a request
 * carrying none. Putting one on a `docker run` command line would publish it to `docker inspect` and to every
 * process listing on the host, to buy nothing. If a future pinned version starts requiring one, ffmpeg gets a
 * 401 and this gate fails loudly rather than quietly proving less.
 */
export async function pacedDirectPlay(opts: PacedPlayOptions): Promise<PacedPlayOutcome> {
  const args = [
    'run', '--rm', '--name', opts.containerName,
    '--network', opts.network,
    '--user', '1000:1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', `${opts.workDir}:/work`,
    '--entrypoint', opts.ffmpegPath,
    opts.image,
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-progress', 'pipe:1', '-stats_period', '1',
    // READ AT THE MEDIA'S OWN RATE. Without this the rest of the phase is a download with a timer on it.
    '-re', '-i', opts.streamUrl,
    '-t', String(opts.seconds),
    // DECODE AND RE-ENCODE, rather than `-c copy`. A stream copy would move bytes without ever asking the
    // decoder a question, and "decoded/playable output" would be a claim about a container.
    '-an', '-vf', 'scale=160:120', '-r', '5', '-c:v', 'mpeg4', '-q:v', '20',
    '-f', 'mp4', '-y', `/work/${opts.outputRelPath}`,
  ];

  const startedAt = now();
  const samples: PacedSample[] = [];
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let stdoutBuffer = '';
  let stderr = '';
  let record: Record<string, string> = {};
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      const eq = line.indexOf('=');
      if (eq > 0) {
        const key = line.slice(0, eq);
        const value = line.slice(eq + 1);
        record[key] = value;
        if (key === 'progress') {
          // ONE RECORD, STAMPED ON ARRIVAL HERE. ffmpeg's own progress block carries no wall clock, and the
          // wall clock is half of every question this gate is asking.
          const micros = Number(record.out_time_us ?? record.out_time_ms ?? '0');
          samples.push({
            wallMs: now() - startedAt,
            mediaMs: Number.isFinite(micros) ? Math.round(micros / 1_000) : 0,
            frames: Number(record.frame ?? '0') || 0,
          });
          record = {};
        }
      }
      newline = stdoutBuffer.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000); });

  // A HARD CEILING OVER A GATE THAT IS SUPPOSED TO BE SLOW. Every other deadline here bounds a wait for
  // something quick; this one exists only so a wedged consumer cannot hold the machine. The container is
  // removed by name as well as the child killed, because killing `docker run` does not always stop what it
  // started.
  const exitCode = await new Promise<number | null>((resolve) => {
    const watchdog = setTimeout(() => {
      spawn('docker', ['rm', '-f', opts.containerName], { stdio: 'ignore' });
      child.kill('SIGKILL');
    }, MEDIA_SERVER_DEADLINES_MS.PACED_PLAY);
    child.on('error', () => { clearTimeout(watchdog); resolve(null); });
    child.on('close', (code) => { clearTimeout(watchdog); resolve(code); });
  });

  return { samples, exitCode, stderr: withoutLocators(stderr) };
}

export interface SeekSetOutcome {
  readonly seeks: SeekObservation[];
  readonly segments: Uint8Array[];
  readonly credentialsInGeneratedUrls: number;
  /** The media length the server's own playlist described, so the plan can be checked against it. */
  readonly playlistSeconds: number;
  readonly playSessionId: string;
}

/**
 * The tail of the media server's own most recent transcoding log.
 *
 * WHY A GATE NEEDS THIS. When the segment endpoint answers 500 the body is the string "Error processing
 * request." and nothing else, and the gate deletes its run directory on the way out — so a failure that
 * happens once in a twenty-minute run leaves NOTHING behind to diagnose it with. The information exists: the
 * server keeps the encoder's command line and its stderr. Fetching the tail of it turns "500, no idea" into
 * a failure somebody can act on, which is the difference between a gate that finds defects and a gate that
 * merely reports that something went wrong.
 *
 * IT IS BEST EFFORT AND IT IS SCRUBBED. A diagnostic that could itself fail would replace one unexplained
 * failure with another, so every error here degrades to an empty string; and the log contains absolute paths
 * and the endpoint's own URL, which §7's redaction rule has no exception for.
 */
export async function transcodeLogTail(state: GateState, maxChars = 900): Promise<string> {
  const fetchLog = async (name: string, chars: number): Promise<string> => {
    const exchange = await request(state, 'GET',
      `/System/Logs/Log?name=${encodeURIComponent(name)}`, { accept: '*/*' });
    try {
      if (!exchange.response.ok) return '';
      return withoutLocators((await exchange.response.text()).slice(-chars));
    } finally {
      exchange.release();
    }
  };
  try {
    const logs = await json<Array<{ Name?: string; DateModified?: string }>>(state, 'GET', '/System/Logs');
    const newestOf = (prefix: string): string | undefined => (logs ?? [])
      .filter((entry) => (entry.Name ?? '').startsWith(prefix))
      .sort((a, b) => Date.parse(b.DateModified ?? '') - Date.parse(a.DateModified ?? ''))[0]?.Name;

    // BOTH LOGS, BECAUSE THE ENCODER'S IS ROUTINELY THE WRONG ONE. A request the server refuses before it
    // starts an encoder writes no FFmpeg log at all, so the newest one is the PREVIOUS job's — and a tail of
    // a successful encode reads like evidence that nothing was wrong. The server's own log is where the
    // reason for a 500 is, and it is fetched first for that reason.
    const parts: string[] = [];
    const main = newestOf('log_');
    if (main !== undefined) parts.push(`[server log]\n${await fetchLog(main, maxChars)}`);
    const encoder = newestOf('FFmpeg');
    if (encoder !== undefined) {
      parts.push(`[most recent encoder log — MAY BE A PREVIOUS JOB]\n${await fetchLog(encoder, 400)}`);
    }
    return parts.join('\n');
  } catch {
    return '';
  }
}

/** Query parameter NAMES that occur more than once in a path. Names only: a value could be anything. */
export function repeatedQueryNames(pathAndQuery: string): string[] {
  const query = pathAndQuery.split('?').slice(1).join('?');
  if (query === '') return [];
  const counts = new Map<string, number>();
  for (const pair of query.split('&')) {
    const name = (pair.split('=')[0] ?? '').toLowerCase();
    if (name !== '') counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name).sort();
}

/** `#EXTINF:6.000000,` durations and the segment references that follow them, in order. */
function parseVariantPlaylist(playlist: string): Array<{ ref: string; seconds: number }> {
  const out: Array<{ ref: string; seconds: number }> = [];
  let pending: number | undefined;
  for (const raw of playlist.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      const seconds = Number(line.slice('#EXTINF:'.length).split(',')[0]);
      pending = Number.isFinite(seconds) ? seconds : undefined;
      continue;
    }
    if (line === '' || line.startsWith('#')) continue;
    out.push({ ref: line, seconds: pending ?? 0 });
    pending = undefined;
  }
  return out;
}

/** Where each segment in a variant playlist begins, as the SERVER states it in the URL it generated. */
function segmentPositions(entries: ReadonlyArray<{ ref: string; seconds: number }>): number[] {
  let cumulative = 0;
  return entries.map((entry) => {
    // `runtimeTicks` is the server's own statement of the position. Falling back to the accumulated
    // `#EXTINF` durations keeps this working against a server that does not publish one — but the gate
    // asserts the position it asked for against whichever number this returned, so the fallback cannot
    // silently turn into "the gate compared its own arithmetic with itself": `#EXTINF` is the server's
    // arithmetic too.
    const ticks = /[?&]runtimeTicks=(\d+)/.exec(entry.ref)?.[1];
    const position = ticks === undefined ? cumulative : Number(ticks) / TICKS_PER_SECOND;
    cumulative += entry.seconds;
    return position;
  });
}

/**
 * TEN SEEKS, out of order, through the media server's own playlist.
 *
 * WHY THIS IS NOT THE RANGED READ THE GATE ALREADY HAD. A ranged GET proves the daemon can serve byte offset
 * N. It says nothing about whether SECOND N of the media maps to a byte offset at all, and a data plane could
 * pass every ranged-read assertion ever written while being unseekable by a player. Both are kept: the ranged
 * read is the byte-level control, this is the acceptance gate.
 *
 * WHY IT IS ONE SESSION AND TEN SEGMENT REQUESTS RATHER THAN TEN SEEKED SESSIONS. Because that is what the
 * pinned server does — see `SEEK_IS_A_DIRECT_SEGMENT_REQUEST` for the two measurements that ruled out the
 * obvious `startTimeTicks` spelling. It is also what an HLS player does when somebody drags the scrubber: it
 * holds one playlist and asks for the segment it wants next, wherever that is. Asking for segment 105 while
 * the encoder is at segment 6 is what makes the server restart its encode at a new position, and that is the
 * non-sequential, multi-position read this whole data plane exists to make cheap.
 *
 * NOTHING HERE DECIDES ANYTHING. It returns what it asked for, what the server said it was answering, how
 * long each took and the bytes; the decoding happens in a separate container and the verdicts are reached by
 * a pure function over both.
 */
export async function mediaTimeSeekSet(
  state: GateState, item: ItemRecord, positions: readonly number[], playSessionId: string,
): Promise<SeekSetOutcome> {
  const masterPath = forcedTranscodePath(item.itemId, item.mediaSourceId, playSessionId);
  let credentialsInGeneratedUrls = 0;
  const follow = (from: string, reference: string): string => {
    const resolved = absolutePath(from, reference);
    if (hasQueryCredential(resolved)) credentialsInGeneratedUrls += 1;
    return stripQueryCredentials(resolved);
  };

  const master = await request(state, 'GET', masterPath,
    { timeoutMs: MEDIA_SERVER_DEADLINES_MS.SEEK, accept: '*/*' });
  let masterBody: string;
  try {
    if (master.response.status !== 200) {
      throw new GateFailure(`the seek master playlist answered ${master.response.status}, not 200`);
    }
    masterBody = await master.response.text();
  } finally {
    master.release();
  }
  const variantRef = firstPlaylistLine(masterBody);
  if (variantRef === undefined) throw new GateFailure('the seek master playlist named no variant');
  const variantPath = follow(masterPath, variantRef);

  const variant = await request(state, 'GET', variantPath,
    { timeoutMs: MEDIA_SERVER_DEADLINES_MS.SEEK, accept: '*/*' });
  let variantBody: string;
  try {
    if (variant.response.status !== 200) {
      throw new GateFailure(`the seek variant playlist answered ${variant.response.status}, not 200`);
    }
    variantBody = await variant.response.text();
  } finally {
    variant.release();
  }
  const entries = parseVariantPlaylist(variantBody);
  if (entries.length === 0) throw new GateFailure('the seek variant playlist listed no segment');
  const starts = segmentPositions(entries);
  const playlistSeconds = entries.reduce((total, entry) => total + entry.seconds, 0);

  const seeks: SeekObservation[] = [];
  const segments: Uint8Array[] = [];
  try {
    for (const [index, wanted] of positions.entries()) {
      // A SETTLE BETWEEN SEEKS, AND IT IS NOT A RETRY.
      //
      // Asking for a segment far from the one the encoder is producing makes the server tear its transcoding
      // job down and start a new one at the new position. Measured: firing ten of those back to back, with
      // no gap at all, gets a 500 from the fourth — the server is still disposing of the previous job when
      // the next request arrives. A person dragging a scrubber does not produce that, and neither does any
      // player; the gate was producing a request rate no client would.
      //
      // WHAT THIS IS NOT. It is not a retry and it does not soften any assertion: every seek still has to
      // answer, first time, inside the acceptance plan's ten seconds — and the ten seconds are measured
      // around the REQUEST, after this settle, so the settle cannot be spent hiding a slow one.
      if (index > 0) await sleep(SEEK_SETTLE_MS);
      // The segment that CONTAINS the requested position: the last one starting at or before it.
      let chosen = 0;
      for (let candidate = 0; candidate < starts.length; candidate += 1) {
        if ((starts[candidate] as number) <= wanted) chosen = candidate; else break;
      }
      const entry = entries[chosen] as { ref: string; seconds: number };
      const segmentPath = follow(variantPath, entry.ref);
      const startedAt = now();
      const exchange = await request(state, 'GET', segmentPath,
        { timeoutMs: MEDIA_SERVER_DEADLINES_MS.SEEK, accept: '*/*' });
      let segment: Uint8Array;
      try {
        if (exchange.response.status !== 200) {
          // A DIAGNOSTIC THAT NAMES PARAMETERS RATHER THAN PRINTING THE URL. A server-generated child URL is
          // the one thing in this gate whose exact shape is not the gate's own choice, so a failure here has to
          // say something about it — and §7's redaction rule has no exception for error paths. Repeated
          // parameter names are named because that was the real failure mode: a query the server built by
          // echoing the request that asked for it carried one name twice, and the binder answered 400.
          const detail = (await exchange.response.text().catch(() => '')).slice(0, 200);
          const encoderLog = await transcodeLogTail(state);
          throw new GateFailure(
            `the segment at ${wanted}s answered ${exchange.response.status}, not 200. `
            + `repeated query parameters: ${repeatedQueryNames(segmentPath).join(',') || '(none)'}. `
            + `body: ${withoutLocators(detail)}\n--- the media server's own encoder log ---\n${encoderLog}`);
        }
        segment = new Uint8Array(await exchange.response.arrayBuffer());
      } finally {
        exchange.release();
      }
      if (segment.byteLength === 0) throw new GateFailure(`the segment at ${wanted}s was empty`);
      seeks.push({
        index,
        requestedSeconds: wanted,
        serverPositionSeconds: starts[chosen] as number,
        elapsedMs: now() - startedAt,
        bytes: segment.byteLength,
        sha256: createHash('sha256').update(segment).digest('hex'),
      });
      segments.push(segment);
    }
  } finally {
    // IN THE `finally`, because a seek that failed halfway leaves an encoder running otherwise — and the
    // five-minute phases that come next would then be measured on a host busy with the wreckage of this one.
    await stopEncoding(state, playSessionId);
  }
  return { seeks, segments, credentialsInGeneratedUrls, playlistSeconds, playSessionId };
}

/** Stop one transcoding job. Best effort by design: a failure here must not fail the thing being measured. */
export async function stopEncoding(state: GateState, playSessionId: string): Promise<void> {
  await request(state, 'DELETE',
    `/Videos/ActiveEncodings?deviceId=${encodeURIComponent(GATE_CLIENT.deviceId)}`
    + `&playSessionId=${encodeURIComponent(playSessionId)}`,
  ).then((exchange) => exchange.release()).catch(() => undefined);
}

/**
 * Put the media server's encoder where the gate can watch it, and make it pace itself to its client.
 *
 * TWO SETTINGS, EACH FOR A REASON THE FIVE-MINUTE TRANSCODE GATE DEPENDS ON.
 *
 * `TranscodingTempPath` puts the job's own output somewhere the gate has bind-mounted, which is what makes
 * "the encoder was alive across the window" measurable at all. Without it the only observable is segments
 * arriving over HTTP, and those are indistinguishable from a directory of files produced in twenty seconds.
 *
 * `EnableThrottling` is what a real player causes and what stops the encoder from racing to the end of a
 * five-minute source in forty seconds and exiting — after which the gate would be consuming a finished
 * directory and calling it a running transcode. Throttling makes the job stay a bounded distance ahead of the
 * client and keep working for as long as the client keeps consuming, which is the behaviour under test.
 *
 * IT IS READ, PATCHED AND WRITTEN BACK rather than posted as a literal: the encoding configuration has
 * dozens of fields and posting a hand-made one would silently reset every setting this gate did not think of.
 */
export async function configureEncoding(state: GateState, tempPath: string, throttleSeconds: number): Promise<void> {
  const current = await json<Record<string, unknown>>(state, 'GET', '/System/Configuration/encoding');
  const patched = {
    ...(current ?? {}),
    TranscodingTempPath: tempPath,
    EnableThrottling: true,
    ThrottleDelaySeconds: throttleSeconds,
  };
  await json(state, 'POST', '/System/Configuration/encoding', patched);
}

/**
 * Report playback the way a player does, so the server attaches a session to the stream.
 *
 * WHY THIS EXISTS, AND IT IS A MEASUREMENT RATHER THAN A CONVENTION. A raw HLS request that never reports
 * playback does not become a session with a `NowPlayingItem` on the pinned server: `/Sessions` shows nothing,
 * and a gate asking "was the server transcoding throughout" gets no answer at all. Reporting `Playing` and
 * then progress as the position advances attaches it, after which the server reports `TranscodingInfo` with
 * `IsVideoDirect: false` for as long as the client keeps playing — which is the server's own statement, in
 * its own bookkeeping, that the thing being played is a transcode.
 *
 * WHAT IT DOES NOT DO, measured on the same run: it does not change the ENCODER. With an attached session and
 * throttling enabled, the job still transcoded a 340-second source in 1.6 seconds and exited. So this buys
 * the server's account of the session, and it does not buy five minutes of encoder liveness — and the gate
 * says so rather than letting the two be read as one.
 *
 * IT DELIBERATELY SENDS NO `PlayMethod`, AND THAT IS THE WHOLE POINT OF THIS COMMENT. It used to send
 * `PlayMethod: 'Transcode'`, and the gate then sampled `PlayState.PlayMethod` and asserted it read
 * `Transcode` — which is this process's own claim, handed to the server, and read back as though the server
 * had reached it. A negative control (see `TranscodeSessionSample.methodIsTranscode`) showed the field is
 * client-writable: report `DirectPlay` and the server records `DirectPlay` while a real transcode is serving
 * the segments. A gate must not author the value it later reads, so it no longer does.
 *
 * IT RETURNS WHETHER THE REPORT LANDED rather than swallowing the answer. A report that silently failed
 * would leave the sampler measuring the gate's own silence and reporting it as the server's.
 */
async function reportPlayback(
  state: GateState, item: ItemRecord, playSessionId: string,
  stage: 'Playing' | 'Playing/Progress' | 'Playing/Stopped', positionSeconds: number,
): Promise<boolean> {
  try {
    await json(state, 'POST', `/Sessions/${stage}`, {
      ItemId: item.itemId,
      MediaSourceId: item.mediaSourceId,
      PlaySessionId: playSessionId,
      PositionTicks: Math.round(positionSeconds * TICKS_PER_SECOND),
      CanSeek: true,
      IsPaused: false,
      RepeatMode: 'RepeatNone',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * What the server says about this item's playback at one instant.
 *
 * NEITHER OF THESE IS ASSERTED ON, AND A NEGATIVE CONTROL IS WHY. See `methodIsTranscode`.
 */
export interface TranscodeSessionSample {
  /**
   * The server's own `PlayState.PlayMethod` for THIS GATE'S session on this item reads `Transcode`.
   *
   * RECORDED, NEVER ASSERTED, BECAUSE IT IS NOT THE SERVER'S OPINION. An earlier version of this gate
   * asserted an 80 % share of it — while `reportPlayback` was sending `PlayMethod: 'Transcode'` in the
   * playback report. That is a claim this process made, handed to the server, and read back as though the
   * server had reached it. A three-arm negative control against a live pinned server, with a genuine
   * mpeg4 → h264 transcode serving the segments in every arm, settled it:
   *
   *   - reporting `Transcode`   → read `DirectPlay` at t=0, `Transcode` at t=20s
   *   - reporting NOTHING       → read `DirectPlay` at t=0, `Transcode` at t=20s
   *   - reporting `DirectPlay`  → read **`DirectPlay` at both**, with the transcode running
   *
   * The third arm is decisive: a client's contrary claim WINS, so the field cannot carry an assertion about
   * what the server was doing. (The second shows the server does derive a value when the client asserts
   * none — which is why this gate now sends no `PlayMethod` at all, so it never authors what it reads.) The
   * transcode claim rests on the DECODED OUTPUT instead: an asserted mpeg4 source, and every consumed
   * segment decoded as h264.
   */
  readonly methodIsTranscode: boolean;
  /**
   * The server is reporting live `TranscodingInfo` for it.
   *
   * ALSO RECORDED, for a different reason. Measured: `TranscodingInfo` is populated immediately after the
   * job starts and is **null fifteen seconds later**, because the encoder finished the whole source in 1.6
   * seconds and exited. It is a live-encoder signal, and on this host the encoder is not live for five
   * minutes; a share of it would be an assertion about encoder liveness wearing a session's clothes.
   */
  readonly encoderJobLive: boolean;
  /** Whether a session belonging to this gate's own device was found for the item at all. */
  readonly sessionPresent: boolean;
}

/**
 * What the server reports about THIS GATE'S session on this item, right now.
 *
 * BOUND TO THIS GATE'S OWN DEVICE, NOT MERELY TO THE ITEM. The gate opens several playback sessions against
 * the same item over one run — a direct play, ten seeks, then the soak — and the server keeps finished ones
 * around; a `find` over the item alone answers for whichever it happens to return first. Worse, on any
 * server that is not this gate's private container, another client playing the same film would answer for
 * it. `deviceId` is the one field the gate controls end to end: every request it makes carries
 * `GATE_CLIENT.deviceId`, so a session bearing it is this gate's and nobody else's.
 */
export async function transcodeSessionNow(
  state: GateState, item: ItemRecord,
): Promise<TranscodeSessionSample> {
  const sessions = await json<Array<{
    DeviceId?: string;
    NowPlayingItem?: { Id?: string };
    PlayState?: { PlayMethod?: string };
    TranscodingInfo?: { IsVideoDirect?: boolean };
  }>>(state, 'GET', '/Sessions').catch(() => []);
  const mine = (sessions ?? []).filter((session) => session.NowPlayingItem?.Id === item.itemId
    && session.DeviceId === GATE_CLIENT.deviceId);
  return {
    sessionPresent: mine.length > 0,
    methodIsTranscode: mine.some((session) => session.PlayState?.PlayMethod === 'Transcode'),
    encoderJobLive: mine.some((session) => session.TranscodingInfo !== undefined
      && session.TranscodingInfo.IsVideoDirect !== true),
  };
}

export interface TranscodeSoakOptions {
  /** Where consumed segments are written, so a decoder outside this process can be handed all of them. */
  readonly segmentDir: string;
  /** The host directory the media server's transcoding job writes its own output into. */
  readonly producerDir: string;
  readonly minSeconds: number;
  readonly maxSegmentBytes: number;
}

export interface TranscodeSoakOutcome {
  readonly segments: SoakSegment[];
  /** One sample per tick of the server's own account of this item's playback. Two facts, see the type. */
  readonly sessions: TranscodeSessionSample[];
  /** Modification times of the files the ENCODER wrote, sampled before the job is stopped. */
  readonly producerMtimesMs: number[];
  readonly credentialsInGeneratedUrls: number;
  readonly playSessionId: string;
  /**
   * Playback reports the server refused or dropped.
   *
   * REPORTED RATHER THAN SWALLOWED. The session samples are only meaningful if the server was being told the
   * player was still playing; a run in which those reports failed is a run whose session telemetry describes
   * this gate's silence rather than the server's view, and a reader is entitled to know which they are
   * looking at.
   */
  readonly failedPlaybackReports: number;
}

/**
 * A forced transcode, consumed for five minutes AT THE PACE A PLAYER WOULD CONSUME IT.
 *
 * WHY PACED, WHEN THE OBVIOUS THING IS TO FETCH EVERY SEGMENT AS FAST AS POSSIBLE. Because fetching them as
 * fast as possible takes under a minute, and the only way to reach five minutes from there is to sleep — at
 * which point the gate has measured a directory listing. A player asks for segment N at about the moment
 * second N of the media arrives, which keeps the encoding job alive, keeps it producing, and keeps the reads
 * flowing through the mount for the whole window. That is the thing G10 says exercises read-ahead
 * cancellation, and it only exists if the client behaves like a client.
 *
 * WHAT IS COLLECTED, AND WHY THREE DIFFERENT KINDS. The segments and their arrival times are the client's
 * side. The session samples are the server's own bookkeeping, taken repeatedly rather than once, because a
 * transcode that died at second forty would still have a session record. The producer's file mtimes are the
 * ENCODER's side, and they are read BEFORE the job is stopped because stopping it is what deletes them.
 *
 * NOTHING HERE ASSERTS. It returns measurements; the CLI holds them against the acceptance plan's numbers,
 * and the segments are decoded by a real decoder outside this process.
 */
export async function transcodeSoak(
  state: GateState, item: ItemRecord, opts: TranscodeSoakOptions,
): Promise<TranscodeSoakOutcome> {
  const playSessionId = `gate-soak-${opaqueRef('session', item.itemId).slice(0, 16)}`;
  // PLAYBACK IS REPORTED BEFORE THE TRANSCODE IS ASKED FOR, AND THE ORDER IS LOAD-BEARING.
  //
  // Measured: reporting it afterwards attaches a session with a `NowPlayingItem` but with NO
  // `TranscodingInfo` — the transcoding job records itself against the session that exists at the moment it
  // is created, so a session that arrives later never acquires it. The gate then samples a live session
  // twenty times and reads "not transcoding" from every one of them, which is a false negative about the
  // exact thing the phase is measuring. Reported first, the same samples carry `IsVideoDirect: false` and
  // the server's own reason for transcoding.
  let failedPlaybackReports = (await reportPlayback(state, item, playSessionId, 'Playing', 0)) ? 0 : 1;
  const masterPath = forcedTranscodePath(item.itemId, item.mediaSourceId, playSessionId);
  let credentialsInGeneratedUrls = 0;
  const follow = (from: string, reference: string): string => {
    const resolved = absolutePath(from, reference);
    if (hasQueryCredential(resolved)) credentialsInGeneratedUrls += 1;
    return stripQueryCredentials(resolved);
  };

  const master = await request(state, 'GET', masterPath,
    { timeoutMs: MEDIA_SERVER_DEADLINES_MS.TRANSCODE, accept: '*/*' });
  let masterBody: string;
  try {
    if (master.response.status !== 200) {
      throw new GateFailure(`the transcode manifest answered ${master.response.status}, not 200`);
    }
    masterBody = await master.response.text();
  } finally {
    master.release();
  }
  const variantRef = firstPlaylistLine(masterBody);
  if (variantRef === undefined) throw new GateFailure('the transcode master playlist named no variant');
  const variantPath = follow(masterPath, variantRef);

  const listed = await until('the transcode variant playlist to list a segment',
    MEDIA_SERVER_DEADLINES_MS.TRANSCODE, async () => {
      const exchange = await request(state, 'GET', variantPath,
        { timeoutMs: MEDIA_SERVER_DEADLINES_MS.API_REQUEST, accept: '*/*' });
      try {
        if (exchange.response.status !== 200) {
          await exchange.response.body?.cancel().catch(() => undefined);
          return undefined;
        }
        const entries = parseVariantPlaylist(await exchange.response.text());
        return entries.length > 0 ? entries : undefined;
      } finally {
        exchange.release();
      }
    });

  mkdirSync(opts.segmentDir, { recursive: true });
  const startedAt = now();
  // The same instant, kept separately because it is compared against FILE modification times rather than
  // against this process's own elapsed clock, and a second later it would start excluding real output.
  const wallClockStart = startedAt - 1_000;
  const segments: SoakSegment[] = [];
  const sessions: TranscodeSessionSample[] = [];
  let stopSampling = false;
  let mediaStart = 0;
  // THE ENCODER'S OWN OUTPUT, ACCUMULATED WHILE THE WINDOW IS OPEN RATHER THAN LISTED AT THE END.
  //
  // A listing taken afterwards found NOTHING: the server deletes a transcoded segment once the client has
  // been served it, so by the end of a paced five-minute consumption the directory is empty. Reading zero
  // files and reporting a zero span would have been a measurement that says "the encoder never ran" about a
  // run in which it demonstrably did — which is worse than not measuring, because it looks like a finding.
  const producerSeen = new Map<string, number>();
  // THE SESSION SAMPLER RUNS ALONGSIDE, not between fetches: a sampler driven by the fetch loop would stop
  // sampling exactly when the loop was blocked, which is the interval its answer matters most for. It also
  // carries the progress report, because a session that stopped hearing from its player is a session the
  // server is entitled to tear down — and then the gate would be measuring its own silence.
  const sampler = (async (): Promise<void> => {
    while (!stopSampling) {
      await sleep(15_000);
      if (stopSampling) break;
      if (!(await reportPlayback(state, item, playSessionId, 'Playing/Progress', mediaStart))) {
        failedPlaybackReports += 1;
      }
      sessions.push(await transcodeSessionNow(state, item)
        .catch(() => ({ methodIsTranscode: false, encoderJobLive: false, sessionPresent: false })));
      for (const [name, mtime] of readProducerFiles(opts.producerDir)) {
        if (mtime >= wallClockStart && !producerSeen.has(name)) producerSeen.set(name, mtime);
      }
    }
  })();

  const deadline = new Deadline('the five-minute transcode', MEDIA_SERVER_DEADLINES_MS.TRANSCODE_SOAK, startedAt);
  // A MARGIN ON TOP OF THE FIVE MINUTES, because the first segment cannot arrive at wall time zero and the
  // span the gate asserts is measured between the first arrival and the last.
  const targetMs = (opts.minSeconds + 20) * 1_000;
  try {
    for (const [index, entry] of listed.entries()) {
      const elapsed = now() - startedAt;
      if (elapsed >= targetMs && mediaStart >= opts.minSeconds + 15) break;
      if (deadline.expired(now())) throw new GateFailure(deadline.message());
      // ASK FOR SEGMENT N WHEN SECOND N OF THE MEDIA ARRIVES. This is the pacing, and it is the whole reason
      // the wall clock and the media clock can be compared afterwards.
      const dueAt = mediaStart * 1_000;
      if (elapsed < dueAt) await sleep(Math.min(dueAt - elapsed, 10_000));

      const exchange = await request(state, 'GET', follow(variantPath, entry.ref),
        { timeoutMs: MEDIA_SERVER_DEADLINES_MS.TRANSCODE, accept: '*/*' });
      let buffer: Uint8Array;
      try {
        if (exchange.response.status !== 200) {
          throw new GateFailure(`transcode segment ${index} answered ${exchange.response.status}, not 200.`
            + `\n--- the media server's own encoder log ---\n${await transcodeLogTail(state)}`);
        }
        buffer = new Uint8Array(await exchange.response.arrayBuffer());
      } finally {
        exchange.release();
      }
      if (buffer.byteLength === 0) throw new GateFailure(`transcode segment ${index} was empty`);
      if (buffer.byteLength > opts.maxSegmentBytes) {
        throw new GateFailure(`transcode segment ${index} was ${buffer.byteLength} bytes, over the ceiling`);
      }
      writeFileSync(join(opts.segmentDir, `seg-${String(index).padStart(4, '0')}.ts`), buffer);
      segments.push({
        index, wallMs: now() - startedAt, mediaStartSeconds: mediaStart, bytes: buffer.byteLength,
        sha256: createHash('sha256').update(buffer).digest('hex'),
      });
      mediaStart += entry.seconds;
    }
  } finally {
    stopSampling = true;
    await sampler.catch(() => undefined);
    // THE TEARDOWN IS IN THE `finally`, NOT AFTER IT, and that is the difference between a failing phase and
    // a failing phase that leaves an ffmpeg encoding for the rest of the run. Every measurement after this
    // point would then be taken against a host under load, and the failure that got reported would be the
    // second one rather than the first.
    //
    // THE ENCODER'S OUTPUT IS READ BEFORE THE JOB IS STOPPED, because stopping it deletes the directory —
    // and only what was written inside THIS window, since the forced transcode and the ten seeks before it
    // left output in the same place. Measured during development: 343 files spanning nine minutes, of which
    // the soak's own encoder had produced a fraction.
    for (const [name, mtime] of readProducerFiles(opts.producerDir)) {
      if (mtime >= wallClockStart && !producerSeen.has(name)) producerSeen.set(name, mtime);
    }
    // Tell the server the player stopped, so a failed run does not leave a session it believes is still
    // playing — which the NEXT phase would then find and mistake for its own.
    await reportPlayback(state, item, playSessionId, 'Playing/Stopped', mediaStart);
    await stopEncoding(state, playSessionId);
  }

  const producerMtimesMs = [...producerSeen.values()].sort((a, b) => a - b);
  return {
    segments, sessions, producerMtimesMs, credentialsInGeneratedUrls, playSessionId,
    failedPlaybackReports,
  };
}

/**
 * The transcoding job's own output files, by name and modification time.
 *
 * IT IS SAMPLED REPEATEDLY RATHER THAN LISTED ONCE, and the reason is a measurement: the server DELETES a
 * transcoded segment once it has served it, so a listing taken at the end of a paced five-minute consumption
 * finds an empty directory. Reporting that as a zero span would have been a measurement saying "the encoder
 * never ran" about a run in which it demonstrably did — a false finding, which is worse than no finding.
 *
 * IT RETURNS AN EMPTY LIST RATHER THAN THROWING when the directory is missing. That is safe here only
 * because this number is RECORDED and never asserted on; if it ever becomes a threshold, an absent directory
 * has to be made to fail rather than to read as zero.
 */
export function readProducerFiles(dir: string): Array<[string, number]> {
  if (!existsSync(dir)) return [];
  const out: Array<[string, number]> = [];
  for (const name of readdirSync(dir)) {
    try {
      const info = statSync(join(dir, name));
      if (info.isFile() && info.size > 0) out.push([name, info.mtimeMs]);
    } catch { /* a file the encoder deleted between the listing and the stat is not a measurement */ }
  }
  return out;
}

/** Resolve a playlist-relative reference against the path the playlist itself was fetched from. */
export function absolutePath(fromPath: string, reference: string): string {
  if (reference.startsWith('/')) return reference;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(reference)) {
    // An absolute URL back to the same server. Keep only its path and query: the gate's base URL is the
    // authority, and following a host the server named would be a redirect this gate does not take.
    const parsed = new URL(reference);
    return `${parsed.pathname}${parsed.search}`;
  }
  const base = (fromPath.split('?')[0] as string).replace(/[^/]*$/, '');
  return `${base}${reference}`;
}

// ---------------------------------------------------------------------------------------------------------
// State, results and files
// ---------------------------------------------------------------------------------------------------------

export function readState(path: string): GateState {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as GateState;
  if (!raw.baseUrl) throw new GateFailure('the gate state has no base url');
  return raw;
}

export function writeState(path: string, state: GateState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function appendResult(path: string, result: GateResult): void {
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as GateResult[]) : [];
  existing.push(result);
  writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);
}

export function readResults(path: string): GateResult[] {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as GateResult[]) : [];
}

export interface ExpectedEntry {
  readonly key: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly kind: 'local' | 'http-range';
  /**
   * An entry whose BYTES are read back and digest-compared, not merely catalogued.
   *
   * The ~50-entry corpus is asserted in aggregate; direct-playing all of it would turn a gate into a
   * throughput test and would say nothing a handful of entries do not. The anchors are the handful, and they
   * are marked in the expectation file rather than named in the driver so that what is checked byte-for-byte
   * is a property of the corpus the gate published, not a list two files apart could disagree about.
   */
  readonly anchor?: boolean;
}

export function readExpected(path: string): ExpectedEntry[] {
  return JSON.parse(readFileSync(path, 'utf8')) as ExpectedEntry[];
}

/** Wait for another process to create a file. Bounded, like everything else here. */
export async function awaitFile(path: string, label: string, budgetMs: number): Promise<void> {
  await until(label, budgetMs, async () => (existsSync(path) ? true : undefined));
}
