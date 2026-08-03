import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  Deadline, GATE_CLIENT, MEDIA_SERVER_DEADLINES_MS, MEDIA_SERVER_POLL_INTERVAL_MS, SEEK_SETTLE_MS,
  ScanBarrier, directPlayPath, forcedTranscodePath, hasQueryCredential, isInFlightState,
  TICKS_PER_SECOND, mediaServerAuthHeader, movieLibraryRequest, opaqueRef, stripQueryCredentials,
  type GateResult, type PacedSample, type ScanTaskSample, type SeekObservation, type SoakSegment,
} from '../core/projection/media-server-dataplane.js';
import {
  EMBY_CONSUMER_TOKEN_FILE, EMBY_SERVER_GID, EMBY_SERVER_UID, embyAnonymousPlaybackIsRefused,
  embyPlaylistProblems, embySegmentPositions, embyWizardPhase, parseEmbyVariantPlaylist,
  type EmbyPlaylistSegment,
} from '../core/projection/emby-dataplane.js';

// Projection Phase 1 — driving a REAL EMBY against the projected mount.
//
// WHAT THIS IS. The third media server to read the production FUSE projection, and the second one in the
// MediaBrowser API family. It is a separate driver from the Jellyfin one rather than a parameterisation of it,
// for the reason `src/core/projection/emby-dataplane.ts` opens with: the endpoint spellings are largely
// shared, and five of the Jellyfin gate's hardest-won BEHAVIOURAL conclusions are false for Emby. A shared
// driver would have had to carry those as flags, and a flag whose two branches are each exercised by one
// server is two drivers wearing one name.
//
// WHAT IS GENUINELY SHARED IS IMPORTED, NOT COPIED. Every deadline, budget, five-minute threshold, the ten-seek
// plan, the corpus comparison, the scan barrier, the redaction rule and the verdict helpers come from
// `media-server-dataplane.ts` unchanged. Those are statements about what a claim has to mean, and they do not
// become different statements because a different server is answering.
//
// EVERY WAIT HAS A DEADLINE. There is no unbounded loop in this file.
//
// NOTHING HERE IS AN OPERATOR SURFACE. It is a gate driver: not wired to any `ops:` command an installation
// would run, hard-coding no endpoint, holding the media server's credential in memory and in scratch files
// under the gate's own run directory, which the gate deletes.

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
  readonly key: string;
  readonly itemId: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly container: string;
  readonly protocol: string;
  readonly mediaSourceId: string;
  readonly videoCodec: string;
  readonly isRemote: boolean;
  readonly supportsDirectPlay: boolean;
  /**
   * `MediaSources[0].Type`. `Placeholder` is what `LocationType: 'Virtual'` meant on Jellyfin.
   *
   * IT REPLACES `locationType`, WHICH THIS SERVER DOES NOT SEND. See `EMBY_ITEMS_OMIT_LOCATION_TYPE`: the
   * field is absent from `/Items` even when explicitly requested, and a predicate inherited from the Jellyfin
   * driver matched zero of two correctly-catalogued entries because of it.
   */
  readonly mediaSourceType: string;
  /** `MediaSources[0].Path` — the file the source actually points at, which must be the projected path. */
  readonly mediaSourcePath: string;
  /** The server's own statement of the media's length. Used to check a playlist describes the right item. */
  readonly runTimeSeconds: number;
}

export class GateFailure extends Error {}

function now(): number { return Date.now(); }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

interface Exchange {
  readonly response: Response;
  release(): void;
}

/**
 * THE HEADER EMBY'S OWN CLIENTS SEND.
 *
 * MEASURED: the pinned Emby 4.9.5.0 accepts the `MediaBrowser Client=…, Device=…, DeviceId=…, Version=…,
 * Token=…` scheme under BOTH `Authorization` and `X-Emby-Authorization` — `POST /Users/AuthenticateByName`
 * answered 200 to each, with the same user body. Jellyfin's driver sends `Authorization`.
 *
 * THIS GATE SENDS EMBY'S OWN SPELLING, and that is a deliberate choice rather than a coin toss. `Authorization`
 * working today is a compatibility affordance of a fork's ancestor; `X-Emby-Authorization` is the header this
 * server documents and the one its own clients send. A gate that drove Emby through the compatibility path
 * would be testing the affordance as much as the product, and would break on the release that finally drops
 * it — with a failure that looked like a projection defect.
 *
 * That both work is recorded rather than relied on, and the gate asserts the fact separately so the day it
 * stops being true is a named finding rather than a silent narrowing.
 */
const EMBY_AUTH_HEADER = 'X-Emby-Authorization';

/**
 * One request to the media server, with a hard deadline over the WHOLE exchange.
 *
 * THE WATCHDOG IS A REF'D TIMER, and the reasoning is the Jellyfin driver's, inherited deliberately because
 * the defect it closes is a property of Node and undici rather than of any media server: `AbortSignal.timeout`
 * is backed by an UNREF'D timer, so an `await fetch(...)` against a socket that accepted the connection and
 * never answered leaves nothing holding the event loop open. Node then exits, normally, with status 0 — a
 * phase that printed nothing, wrote no state and "succeeded". An explicit `AbortController` behind an ordinary
 * `setTimeout` keeps the process alive exactly as long as the request is allowed to take, and then turns the
 * hang into a named failure.
 */
async function request(
  state: GateState, method: string, path: string,
  options: {
    body?: unknown; range?: string; timeoutMs?: number; accept?: string;
    /** Send NO credential. Used by the anonymous-playback negative control, and by nothing else. */
    anonymous?: boolean;
  } = {},
): Promise<Exchange> {
  const headers: Record<string, string> = { Accept: options.accept ?? 'application/json' };
  if (options.anonymous !== true) headers[EMBY_AUTH_HEADER] = mediaServerAuthHeader(state.token);
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
    // The query is deliberately absent from the message: it can carry a media source id.
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

/** Poll until a predicate holds, or the deadline lapses. The only exit other than success is the deadline. */
async function until<T>(label: string, budgetMs: number, probe: () => Promise<T | undefined>): Promise<T> {
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
// Standing the server up
// ---------------------------------------------------------------------------------------------------------

interface PublicInfo { Version?: string; Id?: string }

export async function awaitServer(state: GateState): Promise<string> {
  const info = await until('the media server to answer its public info endpoint',
    MEDIA_SERVER_DEADLINES_MS.SERVER_READY, async () => {
      // ANONYMOUS ON PURPOSE. `/System/Info/Public` is the one endpoint that answers before the wizard has
      // run and after it, with or without a credential; probing it with a header the server has no user to
      // validate yet would be asking a different question during the interval this wait exists to cover.
      const exchange = await request(state, 'GET', '/System/Info/Public',
        { timeoutMs: 5_000, anonymous: true });
      try {
        if (!exchange.response.ok) return undefined;
        return await exchange.response.json() as PublicInfo;
      } finally {
        exchange.release();
      }
    });
  // NOTHING FROM THIS BODY GOES INTO A REPORT. Measured: once the pinned Emby has worked out its own
  // addresses, `/System/Info/Public` carries `LocalAddress` and `WanAddress` — the second of which is the
  // host's PUBLIC IP, discovered by the server on its own initiative. The version is the only field this gate
  // reads, and §7's redaction rule is what stops the rest travelling.
  return info.Version ?? 'unknown';
}

/**
 * Whether Emby's first-run wizard is still open, asked the only way this server answers it.
 *
 * SEE `EMBY_PUBLIC_INFO_HAS_NO_WIZARD_FLAG`. Emby publishes no `StartupWizardCompleted` anywhere, so the
 * signal is the wizard endpoint's own access control: unauthenticated `GET /Startup/Configuration` answers
 * **200** before `POST /Startup/Complete` and **401** after it. Both halves were measured against the pinned
 * server in the same session.
 *
 * AN UNRECOGNISED STATUS IS A FAILURE, NOT A GUESS. Reading an unknown status as "complete" would skip the
 * bootstrap and leave every later phase unauthenticated; reading it as "open" would re-run the wizard over a
 * live installation. Neither is a safe default, so there is no default.
 */
export async function wizardIsOpen(state: GateState): Promise<boolean> {
  const exchange = await request(state, 'GET', '/Startup/Configuration',
    { anonymous: true, timeoutMs: MEDIA_SERVER_DEADLINES_MS.API_REQUEST });
  let status: number;
  try {
    status = exchange.response.status;
    await exchange.response.body?.cancel().catch(() => undefined);
  } finally {
    exchange.release();
  }
  const phase = embyWizardPhase(status);
  if (phase === 'unknown') {
    throw new GateFailure(
      `the wizard endpoint answered ${status} to an unauthenticated request, which is neither the 200 that `
      + 'means the wizard is open nor the 401 that means it is complete. Refusing to guess: guessing "open" '
      + 'would re-run the wizard over a live installation and guessing "complete" would leave every later '
      + 'phase unauthenticated');
  }
  return phase === 'open';
}

/**
 * The non-interactive first-run wizard, then an ordinary login.
 *
 * THIS IS THE SERVER'S OWN BOUNDARY, not a config file dropped into its data directory. Writing Emby's
 * `system.xml` and a hand-made user row would prove that this gate can forge an installation; going through
 * `/Startup/*` proves that a real one can be stood up by a machine, which is the thing an operator would be
 * doing.
 *
 * MEASURED, IN ORDER, AGAINST THE PINNED SERVER: `POST /Startup/Configuration` → 204, `GET /Startup/User` →
 * 200 `{"Name":"MyEmbyUser"}`, `POST /Startup/User` → 200 `{}`, `POST /Startup/RemoteAccess` → 204,
 * `POST /Startup/Complete` → 204. The `GET` before the `POST` is asked for rather than skipped because the
 * wizard expects that read before it will take the user — the same shape Jellyfin's wizard has, and one of
 * the places the two servers genuinely do agree.
 *
 * IT IS GUARDED BY `wizardIsOpen` RATHER THAN BY A FLAG IN THE PUBLIC INFO, which is finding 1. The gate calls
 * this function twice — once to install, once after restarting the media server — and the second call must be
 * an ordinary login against the SAME installation, because the whole point of the restart phase is that the
 * library survived it.
 */
export async function bootstrap(state: GateState, username: string, password: string): Promise<boolean> {
  const ranWizard = await wizardIsOpen(state);
  if (ranWizard) {
    await json(state, 'POST', '/Startup/Configuration', {
      UICulture: 'en-US', MetadataCountryCode: 'US', PreferredMetadataLanguage: 'en',
    });
    await json(state, 'GET', '/Startup/User');
    await json(state, 'POST', '/Startup/User', { Name: username, Password: password });
    await json(state, 'POST', '/Startup/RemoteAccess', {
      EnableRemoteAccess: true, EnableAutomaticPortMapping: false,
    });
    await json(state, 'POST', '/Startup/Complete');
    // AND THE WIZARD IS NOW SHUT, ASSERTED RATHER THAN ASSUMED. A `/Startup/Complete` that answered 204
    // without actually completing anything would leave the server permanently open, and every later
    // "authenticated" phase would be measuring an endpoint that answers to anybody.
    if (await wizardIsOpen(state)) {
      throw new GateFailure('the wizard reported completion and its endpoint is still open to anonymous callers');
    }
  }

  const auth = await json<{ AccessToken?: string; User?: { Id?: string } }>(
    state, 'POST', '/Users/AuthenticateByName', { Username: username, Pw: password },
  );
  if (!auth?.AccessToken || !auth.User?.Id) throw new GateFailure('the media server issued no access token');
  state.token = auth.AccessToken;
  state.userId = auth.User.Id;
  return ranWizard;
}

/**
 * Whether this server accepts the MediaBrowser scheme under the plain `Authorization` header too.
 *
 * RECORDED, NOT REQUIRED, AND IT IS A COMPATIBILITY OBSERVATION RATHER THAN A GATE. Measured: the pinned Emby
 * answers `POST /Users/AuthenticateByName` 200 to both spellings. This gate sends `X-Emby-Authorization`
 * everywhere; the day this observation flips is the day a driver written against Jellyfin's spelling stops
 * working on Emby, and recording it here is what makes that a dated finding rather than a surprise.
 */
export async function acceptsJellyfinAuthHeaderSpelling(
  state: GateState, username: string, password: string,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEDIA_SERVER_DEADLINES_MS.API_REQUEST);
  try {
    const response = await fetch(`${state.baseUrl}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: {
        Authorization: mediaServerAuthHeader(),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ Username: username, Pw: password }),
      redirect: 'manual',
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

interface VirtualFolder { Name?: string; ItemId?: string; Locations?: string[]; CollectionType?: string }

async function virtualFolder(state: GateState, name: string): Promise<VirtualFolder> {
  return until('the library to appear in the virtual folder list',
    MEDIA_SERVER_DEADLINES_MS.API_REQUEST, async () => {
      const all = await json<VirtualFolder[]>(state, 'GET', '/Library/VirtualFolders');
      return all?.find((folder) => folder.Name === name);
    });
}

/**
 * Add the projected mount as a Movies library, with every metadata fetcher off.
 *
 * THE OPTIONS COME FROM THE SHARED MODULE, and that is correct rather than lazy: `movieLibraryRequest`
 * describes what a library has to be for this gate to mean anything — internet fetchers off so the run is
 * offline and deterministic, realtime monitoring off so the re-scan assertions are about EXPLICIT scans — and
 * those requirements are properties of the gate, not of the server. Measured: the pinned Emby accepts the same
 * `LibraryOptions` document Jellyfin does, answering `POST /Library/VirtualFolders` with **204**, and the
 * folder then lists with `CollectionType: "movies"` and `Locations: ["/media/projection/Movies"]`.
 *
 * UNLIKE JELLYFIN, THE LIBRARY ITEM ID EXISTS IMMEDIATELY. Measured: the pinned Emby returns `ItemId: "3"` in
 * the very first `/Library/VirtualFolders` listing, before any scan has run — Jellyfin leaves it absent until
 * the first refresh, which is why its driver carries a comment about a gate that could never pass. This one
 * therefore takes the id when it is there and still tolerates its absence, because tolerating it costs
 * nothing and depending on a convenience is how the opposite bug gets written.
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

export async function resolveLibraryId(state: GateState): Promise<string | undefined> {
  if (state.libraryId !== undefined) return state.libraryId;
  if (state.libraryName === undefined) return undefined;
  const folder = await virtualFolder(state, state.libraryName);
  if (folder.ItemId) state.libraryId = folder.ItemId;
  return state.libraryId;
}

// ---------------------------------------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------------------------------------

interface ScheduledTask extends ScanTaskSample { Key?: string }

/**
 * The scheduled task that is a library scan.
 *
 * MEASURED ON THE PINNED EMBY: `GET /ScheduledTasks?isHidden=false` lists `SyncPrepare, DownloadSubtitles,
 * (unnamed), RefreshLibrary, ScanInternalMetadataFolderTask, ServerSync, VacuumDatabase,
 * RefreshChapterImages`. `RefreshLibrary` is "Scan media library" and is the one `POST /Library/Refresh`
 * drives — the same key Jellyfin uses. Note the empty-keyed entry in that list: the lookup is by exact key
 * rather than by index or by name, so a task with no key cannot be picked up by accident.
 */
const SCAN_TASK_KEY = 'RefreshLibrary';

async function scanTask(state: GateState): Promise<ScheduledTask | undefined> {
  const tasks = await json<ScheduledTask[]>(state, 'GET', '/ScheduledTasks?isHidden=false');
  return tasks?.find((task) => task.Key === SCAN_TASK_KEY);
}

export interface ScanOutcome {
  readonly elapsedMs: number;
  readonly observedInFlight: boolean;
}

/**
 * Trigger a real scan, wait for it to actually start, and wait for that execution to actually finish.
 *
 * THE BARRIER IS THE SHARED ONE, AND IT EARNS ITS KEEP HERE IMMEDIATELY. Measured on the pinned Emby: a
 * one-item library scan starts and finishes BETWEEN TWO POLLS — the first sample after `POST /Library/Refresh`
 * already reads `State: "Idle"` with a `LastExecutionResult.StartTimeUtc` later than the baseline. That is
 * exactly the fast-complete case `ScanBarrier` was built for, and a barrier that demanded `Running` be
 * observed would hang forever against this server on a small corpus.
 *
 * `onRunning` fires the first time the scan is observed genuinely IN FLIGHT. A fast-complete is a valid
 * completion and MUST NOT raise it, because the mid-scan gate uses it as the licence to publish a successor
 * "while a scan is running" — and a scan that was already over is not a while.
 */
export async function scanLibrary(state: GateState, onRunning?: () => void): Promise<ScanOutcome> {
  const baseline = (await scanTask(state))?.LastExecutionResult?.StartTimeUtc;
  const barrier = new ScanBarrier(baseline);
  const startedAt = now();
  let announced = false;

  await json(state, 'POST', '/Library/Refresh');
  await until('the library scan to start and then finish', MEDIA_SERVER_DEADLINES_MS.LIBRARY_SCAN, async () => {
    const phase = barrier.observe(await scanTask(state));
    if (barrier.observedInFlight && !announced) {
      announced = true;
      onRunning?.();
    }
    return phase === 'complete' ? true : undefined;
  });
  return { elapsedMs: now() - startedAt, observedInFlight: barrier.observedInFlight };
}

export async function scanBaseline(state: GateState): Promise<string | undefined> {
  return (await scanTask(state))?.LastExecutionResult?.StartTimeUtc;
}

/**
 * Is the scanner running RIGHT NOW? One sample, no baseline, no history.
 *
 * The mid-scan gate's publishing half asks this immediately before it acts, because the marker the watching
 * half wrote is a file and a file cannot un-write itself when the scan ends. Present tense only: involving
 * history would let a past observation vouch for a present claim.
 */
export async function scanIsRunningNow(state: GateState): Promise<boolean> {
  const task = await scanTask(state);
  if (task === undefined) return false;
  return isInFlightState(task.State);
}

interface RawItem {
  Id?: string;
  Name?: string;
  Path?: string;
  RunTimeTicks?: number;
  MediaSources?: Array<{
    Id?: string; Path?: string; Size?: number; Container?: string; Protocol?: string; IsRemote?: boolean;
    SupportsDirectPlay?: boolean; RunTimeTicks?: number; Type?: string;
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
  if (state.libraryId !== undefined) query.set('parentId', state.libraryId);
  const page = await json<{ Items?: RawItem[] }>(state, 'GET', `/Items?${query.toString()}`);
  const items: ItemRecord[] = [];
  for (const raw of page?.Items ?? []) {
    const source = raw.MediaSources?.[0];
    if (!raw.Id || !raw.Path || !source) {
      throw new GateFailure(`the server returned an item with no id, path or media source: ${raw.Name ?? '?'}`);
    }
    const video = source.MediaStreams?.find((stream) => stream.Type === 'Video');
    const ticks = source.RunTimeTicks ?? raw.RunTimeTicks ?? 0;
    items.push({
      // THE PATH SEPARATOR IS `/` BECAUSE THE SERVER IS ON LINUX AND SO IS THE MOUNT. Splitting on both
      // separators would be defending against a case that cannot arise here and would silently mangle a
      // legitimate filename containing a backslash.
      key: raw.Path.split('/').pop() as string,
      itemId: raw.Id,
      path: raw.Path,
      sizeBytes: source.Size ?? -1,
      container: source.Container ?? '',
      protocol: source.Protocol ?? '',
      // MEASURED: Emby's media-source id is `mediasource_<itemId>`, not the item id itself. Falling back to
      // the item id would produce a request the server answers differently, so the fallback is a failure
      // shape rather than a convenience — it only fires if the server returned a source with no id at all.
      mediaSourceId: source.Id ?? raw.Id,
      videoCodec: video?.Codec ?? '',
      isRemote: source.IsRemote === true,
      supportsDirectPlay: source.SupportsDirectPlay === true,
      // MEASURED `"Default"` FOR A REAL FILE. The value that means "catalogued but not backed by openable
      // media" is `Placeholder`, and that is what the ordinary-file predicate refuses.
      mediaSourceType: source.Type ?? '',
      mediaSourcePath: source.Path ?? '',
      runTimeSeconds: ticks > 0 ? ticks / TICKS_PER_SECOND : 0,
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

/** Read a response body to the end, hashing incrementally, under one deadline for the WHOLE body. */
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
 * THE NEGATIVE CONTROL EMBY MAKES POSSIBLE AND JELLYFIN DOES NOT.
 *
 * The identical direct-play request, with NO credential of any kind. See
 * `EMBY_PLAYBACK_ENDPOINT_IS_ANONYMOUS`: the pinned Jellyfin answers this **200 with the whole file**, and the
 * pinned Emby answers it **401**. So on this server the gate can assert something the Jellyfin gate had to
 * decline to claim — that the media server authorized the read — and it asserts it by making the unauthorized
 * request and requiring the refusal.
 *
 * IT RETURNS THE STATUS RATHER THAN A VERDICT. The caller holds it against
 * `embyAnonymousPlaybackIsRefused`, so the rule lives in the pure module with the measurement that produced
 * it, and a transport failure — which is neither a refusal nor a serve — cannot be mistaken for either.
 */
export async function anonymousDirectPlayStatus(state: GateState, item: ItemRecord): Promise<number> {
  const exchange = await request(state, 'GET',
    directPlayPath(item.itemId, item.mediaSourceId),
    { timeoutMs: MEDIA_SERVER_DEADLINES_MS.RANGE_READ, accept: '*/*', anonymous: true });
  try {
    // THE BODY IS CANCELLED WITHOUT BEING READ. If a future version regressed to serving this anonymously,
    // draining it would pull the whole object through the mount and put that traffic into whatever provider
    // window the gate happens to be inside. The status is the entire measurement.
    await exchange.response.body?.cancel().catch(() => undefined);
    return exchange.response.status;
  } finally {
    exchange.release();
  }
}

export interface PinnedStream {
  readAtLeast(target: number): Promise<void>;
  readonly bytesRead: number;
  readonly ended: boolean;
  finish(): Promise<StreamResult>;
  cancel(): Promise<void>;
}

/**
 * ONE response body, held open across an event, read in two halves from the SAME reader.
 *
 * WHY NOT TWO RANGED READS EITHER SIDE OF THE EVENT. Because that proves two requests succeed on either side
 * of a swap, and the claim being made is that an ACTIVE stream survived one. Draining the first response ends
 * the HTTP exchange, the media server closes its file, and projectiond sees a RELEASE — so the thing the gate
 * says it held open was never open at the moment that mattered.
 *
 * SOCKET BUFFERING IS THE OBVIOUS WAY TO FOOL THIS, so `bytesRead` at the pause point is recorded and the
 * caller asserts that a substantial share of the file arrived AFTER the event. A body already buffered in full
 * shows nothing arriving afterwards and fails that — which is exactly the case where "held open" is a fiction.
 */
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

/**
 * A real HTTP seek, and the 206 semantics that make it one.
 *
 * A SERVER MAY ANSWER A RANGED REQUEST WITH 200 AND THE WHOLE FILE, and a client that only hashed the bytes it
 * wanted would slice its prefix out of a full download and pass. So the status line and `Content-Range` are
 * asserted BEFORE the body is looked at. Measured on the pinned Emby: `Range: bytes=1000000-1065535` against
 * an 8,594,315-byte object answers **206** with `Content-Range: bytes 1000000-1065535/8594315`.
 */
export async function rangeRead(
  state: GateState, item: ItemRecord, offset: number, length: number,
): Promise<StreamResult> {
  const last = offset + length - 1;
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
  readonly credentialsInGeneratedUrls: number;
}

function firstPlaylistLine(playlist: string): string | undefined {
  return playlist.split('\n').map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('#'));
}

/**
 * Force a transcode, consume its output, and bring back a segment for somebody else to decode.
 *
 * IT DOES NOT CONCLUDE "A TRANSCODE HAPPENED" FROM THE FACT THAT A TRANSCODING ENDPOINT ANSWERED. It brings
 * back bytes, and the caller proves the claim by DECODING them and finding a codec the source is not. The
 * session bookkeeping is corroboration and is recorded rather than relied on.
 *
 * MEASURED ON THE PINNED EMBY: `GET /Videos/{id}/master.m3u8?videoCodec=h264&…` answers 200 with a single
 * `#EXT-X-STREAM-INF` naming `main.m3u8?…`, whose variant lists `hls1/main/{N}.ts?PlaySessionId=…`. Neither
 * the variant reference nor any segment reference carries a credential, which is the property
 * `credentialsInGeneratedUrls` exists to keep true rather than to hope for.
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

  let credentialsInGeneratedUrls = 0;
  const follow = (from: string, reference: string): string => {
    const resolved = absolutePath(from, reference);
    if (hasQueryCredential(resolved)) credentialsInGeneratedUrls += 1;
    return stripQueryCredentials(resolved);
  };

  const variantPath = follow(masterPath, variantRef);
  const variant = await until('the transcode variant playlist to list a segment',
    MEDIA_SERVER_DEADLINES_MS.TRANSCODE, async () => {
      const exchange = await request(state, 'GET', variantPath,
        { timeoutMs: MEDIA_SERVER_DEADLINES_MS.API_REQUEST, accept: '*/*' });
      try {
        if (exchange.response.status !== 200) {
          await exchange.response.body?.cancel().catch(() => undefined);
          return undefined;
        }
        const segments = parseEmbyVariantPlaylist(await exchange.response.text());
        return segments.length > 0 ? segments : undefined;
      } finally {
        exchange.release();
      }
    });

  let bytes = 0;
  let first: Uint8Array = new Uint8Array(0);
  const wanted = variant.slice(0, maxSegments);
  for (const segment of wanted) {
    const exchange = await request(state, 'GET', follow(variantPath, segment.ref),
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

  await stopEncoding(state, playSessionId);

  return {
    segments: wanted.length,
    bytes,
    sessionSawTranscode: info !== undefined && info.IsVideoDirect !== true,
    transcodeReasons: info?.TranscodeReasons ?? [],
    firstSegment: first,
    credentialsInGeneratedUrls,
  };
}

/** Stop one transcoding job. Best effort by design: a failure here must not fail the thing being measured. */
export async function stopEncoding(state: GateState, playSessionId: string): Promise<void> {
  await request(state, 'DELETE',
    `/Videos/ActiveEncodings?deviceId=${encodeURIComponent(GATE_CLIENT.deviceId)}`
    + `&playSessionId=${encodeURIComponent(playSessionId)}`,
  ).then((exchange) => exchange.release()).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------------------
// The five-minute gates
// ---------------------------------------------------------------------------------------------------------

/** Strip anything that looks like a locator out of a diagnostic before it goes anywhere near an output. */
export function withoutLocators(text: string): string {
  return text
    .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"]*/g, '<locator>')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<address>');
}

/**
 * The shell program the paced consumer actually runs, written into the work directory.
 *
 * THIS EXISTS BECAUSE EMBY REFUSES ANONYMOUS PLAYBACK — see `EMBY_CONSUMER_CREDENTIAL_IS_FILE_BORNE`. The
 * Jellyfin gate can point ffmpeg straight at the stream because that server serves it to anybody; here a live
 * token has to reach a container, and putting it on the `docker run` command line would publish it to
 * `docker inspect`, which outlives the container and is readable by anything that can reach the Docker socket.
 *
 * SO THE TOKEN IS READ FROM A FILE, INSIDE THE SCRIPT, IN THE CONTAINER. `docker run`'s argv names a script
 * path and a URL; the credential is never one of its arguments.
 *
 * IT IS A FILE RATHER THAN A MULTI-LINE `-c '…'` ARGUMENT, which is a rule this repository enforces rather
 * than a style choice: `test/custody-runtime-closure.ts` parses every shipped script and refuses a line whose
 * quotes do not close on it, because an unreadable line is one that a "does this region do X" check answers
 * "no" for.
 *
 * `exec` IS DELIBERATE. Without it the shell stays as pid 1 and `docker stop` on a wedged consumer has to
 * wait out a signal that never reaches ffmpeg.
 */
export function pacedConsumerScript(): string {
  return [
    'set -eu',
    '# The credential is read from a file bind-mounted with the work directory. It is never an argument to',
    '# `docker run`, so it does not appear in `docker inspect` or in the host process table.',
    `token=$(cat "/work/${EMBY_CONSUMER_TOKEN_FILE}")`,
    'ffmpeg="$1"; url="$2"; seconds="$3"; out="$4"',
    '# NO TRAILING CRLF IS WRITTEN HERE, AND THAT IS DELIBERATE. In POSIX sh a backslash inside DOUBLE quotes',
    '# is literal, so "X-Emby-Token: $token\\r\\n" would send four extra characters as part of the token VALUE',
    '# and the server would answer 401. ffmpeg detects a missing trailing CRLF on -headers and appends a real',
    '# one itself, so the correct thing to pass is the bare header line.',
    'exec "$ffmpeg" -hide_banner -nostdin -loglevel error \\',
    '  -progress pipe:1 -stats_period 1 \\',
    '  -headers "X-Emby-Token: ${token}" \\',
    '  -re -i "$url" -t "$seconds" \\',
    '  -an -vf scale=160:120 -r 5 -c:v mpeg4 -q:v 20 \\',
    '  -f mp4 -y "/work/${out}"',
    '',
  ].join('\n');
}

export interface PacedPlayOptions {
  readonly image: string;
  readonly network: string;
  readonly containerName: string;
  /**
   * The directory Docker bind-mounts at `/work`.
   *
   * TWO SPELLINGS OF ONE DIRECTORY, AND CONFLATING THEM IS A DEFECT THIS GATE ALREADY HIT. On an MSYS shell
   * the absolute path Docker Desktop understands is `/c/Users/...`, and a Windows `node` handed that opens
   * `C:\c\Users\...` — which does not exist. The gate script carries the same distinction for the same reason;
   * this function needs BOTH because it bind-mounts the directory *and* writes two files into it.
   *
   * THE FIRST COMPLETE RUN OF THIS GATE FAILED HERE, at `ENOENT ... \c\Users\...\emby-consumer-token`, five
   * phases and twenty minutes in. The Jellyfin driver takes only this one spelling and gets away with it
   * because it never opens the directory — it has no credential to deliver.
   */
  readonly workDir: string;
  /** The same directory as this process can open it. See `workDir`. */
  readonly localWorkDir: string;
  /** Where the consumer reads from. It never reaches a result, a report or a log line. */
  readonly streamUrl: string;
  readonly outputRelPath: string;
  readonly seconds: number;
  readonly ffmpegPath: string;
  /** The live access token. Written to a file, never passed as an argument. */
  readonly token: string;
  /** Where the script is written, relative to the work directory. */
  readonly scriptRelPath: string;
}

export interface PacedPlayOutcome {
  readonly samples: PacedSample[];
  readonly exitCode: number | null;
  readonly stderr: string;
  /** `docker inspect` of the consumer, for the credential-exposure assertion. */
  readonly inspectJson: string;
}

/**
 * Consume a direct play AT THE SPEED THE MEDIA PLAYS, and record what happened while it did.
 *
 * WHY NOT `fetch` AND A LOOP. Because what G8 asks about is not whether the bytes arrive. A `fetch` that
 * drains the file takes a second or two through this mount; wrapping it in a five-minute sleep produces a
 * phase that takes five minutes and proves that a download and a sleep both work. Starting, running and
 * stalling are all about a DECODER's progress through the media, and nothing that counts bytes can see any
 * of them.
 *
 * `-re` IS THE WHOLE MECHANISM: it makes ffmpeg read at the media's own frame rate rather than as fast as the
 * socket allows, which is what a player does and what makes the read pattern through the mount a playback
 * rather than a copy. `-progress` makes the decoder report its position about once a second, and each record
 * is stamped with the wall clock HERE, on arrival, so the trace carries both clocks.
 *
 * IT RUNS IN THE PINNED MEDIA-SERVER IMAGE, on the gate's own network, so the consumer is the same ffmpeg the
 * server ships and the stream is reached container-to-container rather than through a published port.
 *
 * IT SENDS A CREDENTIAL, WHICH THE JELLYFIN EQUIVALENT DOES NOT, and the difference is a measurement rather
 * than a preference: Emby answers this endpoint 401 without one. How the credential gets there without
 * landing in `docker inspect` is `pacedConsumerScript`, and the gate asserts the absence afterwards from the
 * inspect output this function returns.
 */
export async function pacedDirectPlay(opts: PacedPlayOptions): Promise<PacedPlayOutcome> {
  // THE TOKEN FILE IS WRITTEN BEFORE THE CONTAINER STARTS, through the LOCAL spelling of the directory — see
  // `workDir` for the path defect that cost a twenty-minute run.
  //
  // IT IS 0644 AND NOT 0600, AND THAT IS A DELIBERATE, STATED TRADE-OFF RATHER THAN AN OVERSIGHT. The
  // consumer container runs as uid 1000, and the gate does not run as uid 1000 — on an Unraid host it runs as
  // root. A 0600 file owned by the host user is unreadable by the container that has to read it, so the
  // five-minute play would fail on exactly the platform this gate exists to eventually close on. Docker
  // Desktop hides this by ignoring modes on bind mounts, which is why it would have shipped.
  //
  // WHAT THE LOOSER MODE COSTS, SAID PLAINLY: for the length of one run, a local user on the host who can
  // read the gate's own run directory can read the throwaway media-server token in it. The directory is
  // deleted by the cleanup trap on success and on failure, the token belongs to a container that is destroyed
  // with it, and the alternative is a gate that cannot run where it needs to. It is recorded in §6 of the
  // data-plane document rather than left for somebody to discover.
  const tokenPath = join(opts.localWorkDir, EMBY_CONSUMER_TOKEN_FILE);
  writeFileSync(tokenPath, opts.token);
  try { chmodSync(tokenPath, 0o644); } catch { /* a host filesystem without modes is not a leak */ }
  const scriptPath = join(opts.localWorkDir, opts.scriptRelPath);
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, pacedConsumerScript());
  try { chmodSync(scriptPath, 0o755); } catch { /* likewise */ }

  const args = [
    'run', '--rm', '--name', opts.containerName,
    '--network', opts.network,
    '--user', `${EMBY_SERVER_UID}:${EMBY_SERVER_GID}`,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', `${opts.workDir}:/work`,
    '--entrypoint', '/bin/sh',
    opts.image,
    `/work/${opts.scriptRelPath}`,
    // POSITIONAL ARGUMENTS, AND NOT ONE OF THEM IS THE CREDENTIAL.
    opts.ffmpegPath, opts.streamUrl, String(opts.seconds), opts.outputRelPath,
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

  // THE INSPECT IS TAKEN WHILE THE CONTAINER IS ALIVE. `--rm` means it is gone once the run ends, and the
  // exposure assertion is about what Docker recorded for it — so this samples once, shortly after launch,
  // rather than afterwards when there would be nothing left to read.
  let inspectJson = '';
  const inspectTimer = setTimeout(() => {
    const probe = spawn('docker', ['inspect', opts.containerName], { stdio: ['ignore', 'pipe', 'ignore'] });
    probe.stdout.setEncoding('utf8');
    probe.stdout.on('data', (chunk: string) => { inspectJson += chunk; });
  }, 5_000);

  const exitCode = await new Promise<number | null>((resolve) => {
    const watchdog = setTimeout(() => {
      spawn('docker', ['rm', '-f', opts.containerName], { stdio: 'ignore' });
      child.kill('SIGKILL');
    }, MEDIA_SERVER_DEADLINES_MS.PACED_PLAY);
    child.on('error', () => { clearTimeout(watchdog); clearTimeout(inspectTimer); resolve(null); });
    child.on('close', (code) => { clearTimeout(watchdog); clearTimeout(inspectTimer); resolve(code); });
  });

  return { samples, exitCode, stderr: withoutLocators(stderr), inspectJson };
}

// ---------------------------------------------------------------------------------------------------------
// Ten media-time seeks
// ---------------------------------------------------------------------------------------------------------

export interface SeekSetOutcome {
  readonly seeks: SeekObservation[];
  readonly segments: Uint8Array[];
  readonly credentialsInGeneratedUrls: number;
  /** The media length the server's own playlist described, so the plan can be checked against it. */
  readonly playlistSeconds: number;
  readonly playSessionId: string;
  /** Everything wrong with the playlist itself, before a single seek was performed through it. */
  readonly playlistProblems: string[];
  /**
   * Segment references that carried a position of their own.
   *
   * EXPECTED: ZERO, AND THAT IS AN ASSERTION RATHER THAN A SHRUG. See
   * `EMBY_SEGMENT_URLS_CARRY_NO_RUNTIME_TICKS`. The gate reads `serverPositionSeconds` from the playlist's
   * cumulative `#EXTINF` sums because Emby publishes nothing else — and if a future version started
   * publishing `runtimeTicks`, this driver would go on using the sums while a better number sat unused. A
   * non-zero count here says "re-measure which source is authoritative" rather than silently continuing.
   */
  readonly segmentsDeclaringPosition: number;
}

/** The tail of the media server's own most recent logs. Best effort, and scrubbed. */
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
    const newest = (logs ?? [])
      .sort((a, b) => Date.parse(b.DateModified ?? '') - Date.parse(a.DateModified ?? ''))[0]?.Name;
    if (newest === undefined) return '';
    return `[server log]\n${await fetchLog(newest, maxChars)}`;
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

/** Whether a segment reference states a position of its own, the way Jellyfin's do. */
function declaresPosition(ref: string): boolean {
  return /[?&]runtimeTicks=\d+/i.test(ref);
}

/**
 * TEN SEEKS, out of order, through the media server's own playlist.
 *
 * WHY THIS IS NOT THE RANGED READ THE GATE ALREADY HAS. A ranged GET proves the daemon serves byte offset N.
 * It says nothing about whether SECOND N of the media maps to a byte offset at all, and a data plane could
 * pass every ranged-read assertion ever written while being unseekable by a player.
 *
 * HOW A SEEK IS PERFORMED AGAINST EMBY, MEASURED RATHER THAN ASSUMED. `startTimeTicks` on `master.m3u8` is
 * accepted (200) and **does not change the playlist**: the variant still lists all 114 segments and 342
 * seconds of `#EXTINF`, exactly as an unseeked one does. So an assertion of the form "ask for 90 % in and a
 * tenth remains" is not a statement this server makes.
 *
 * (That much matches Jellyfin. What differs is the consequence: on Jellyfin the seeked request's parameters
 * propagate into every generated segment URL and the segment endpoint then answers **400**. Emby's segment
 * URLs carry only `PlaySessionId`, so the segment still fetches fine — measured, 200. The two servers fail
 * the `startTimeTicks` approach for different reasons and arrive at the same conclusion, which is worth
 * recording precisely because "same conclusion" would otherwise look like one server's behaviour assumed of
 * the other.)
 *
 * WHAT AN HLS CLIENT ACTUALLY DOES, and therefore what this does: hold one playlist and REQUEST THE SEGMENT
 * AT THE POSITION WANTED — out of order, backwards, wherever. The server restarts its encoder at that
 * position to answer, which is precisely the non-sequential, multi-position read this data plane exists to
 * make cheap. Measured, out of order at indices 1, 106 and 22: 200 in 228 ms, 282 ms and 247 ms, three
 * distinct bodies, decoding as h264 with 36 packets each and picture start times of 13.0 s, 328.0 s and
 * 76.0 s against declared positions of 3 s, 318 s and 66 s — a constant 10.0 s offset.
 *
 * NOTHING HERE DECIDES ANYTHING. It returns what it asked for, what the server said it was answering, how
 * long each took and the bytes; decoding happens in a separate container and the verdicts are reached by a
 * pure function over both.
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
  const entries: EmbyPlaylistSegment[] = parseEmbyVariantPlaylist(variantBody);
  if (entries.length === 0) throw new GateFailure('the seek variant playlist listed no segment');
  const starts = embySegmentPositions(entries);
  const playlistSeconds = entries.reduce((total, entry) => total + entry.seconds, 0);
  const playlistProblems = embyPlaylistProblems(entries, item.runTimeSeconds);
  const segmentsDeclaringPosition = entries.filter((entry) => declaresPosition(entry.ref)).length;

  const seeks: SeekObservation[] = [];
  const segments: Uint8Array[] = [];
  try {
    for (const [index, wanted] of positions.entries()) {
      // A SETTLE BETWEEN SEEKS, AND IT IS NOT A RETRY. Asking for a segment far from the one the encoder is
      // producing makes the server tear its transcoding job down and start a new one. No player produces ten
      // of those back to back with no gap, and neither does a person scrubbing. It softens nothing: each seek
      // must still answer first time, and the ten seconds are measured around the REQUEST, after this wait.
      if (index > 0) await sleep(SEEK_SETTLE_MS);
      // The segment that CONTAINS the requested position: the last one starting at or before it.
      let chosen = 0;
      for (let candidate = 0; candidate < starts.length; candidate += 1) {
        if ((starts[candidate] as number) <= wanted) chosen = candidate; else break;
      }
      const entry = entries[chosen] as EmbyPlaylistSegment;
      const segmentPath = follow(variantPath, entry.ref);
      const startedAt = now();
      const exchange = await request(state, 'GET', segmentPath,
        { timeoutMs: MEDIA_SERVER_DEADLINES_MS.SEEK, accept: '*/*' });
      let segment: Uint8Array;
      try {
        if (exchange.response.status !== 200) {
          // A DIAGNOSTIC THAT NAMES PARAMETERS RATHER THAN PRINTING THE URL. §7's redaction rule has no
          // exception for error paths, and an exception is exactly where a leak would live.
          const detail = (await exchange.response.text().catch(() => '')).slice(0, 200);
          const serverLog = await transcodeLogTail(state);
          throw new GateFailure(
            `the segment at ${wanted}s answered ${exchange.response.status}, not 200. `
            + `repeated query parameters: ${repeatedQueryNames(segmentPath).join(',') || '(none)'}. `
            + `body: ${withoutLocators(detail)}\n--- the media server's own log ---\n${serverLog}`);
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
    // five-minute phases that follow would be measured on a host busy with the wreckage of this one.
    await stopEncoding(state, playSessionId);
  }
  return {
    seeks, segments, credentialsInGeneratedUrls, playlistSeconds, playSessionId,
    playlistProblems, segmentsDeclaringPosition,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Five minutes of forced transcode
// ---------------------------------------------------------------------------------------------------------

/**
 * Report playback the way a player does, so the server attaches a session to the stream.
 *
 * MEASURED: a raw HLS request that never reports playback still becomes a session on the pinned Emby — the
 * `/Sessions` listing carries `NowPlayingItem` and a populated `TranscodingInfo` after a segment fetch alone.
 * Reporting it anyway is what keeps the session ALIVE across a five-minute window, since a server that stops
 * hearing from a player is entitled to tear the session down and the gate would then be measuring its own
 * silence.
 *
 * IT DELIBERATELY SENDS NO `PlayMethod`. The Jellyfin gate proved by three-arm negative control that the field
 * is client-writable — report `DirectPlay` and the server records `DirectPlay` while a real transcode serves
 * the segments — and this gate does not author a value it later reads. Measured here, sending nothing: the
 * pinned Emby reported `PlayMethod: "Transcode"` on its own. That is recorded and asserted on by nothing, for
 * exactly the reason the Jellyfin gate stopped asserting it.
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

export interface TranscodeSessionSample {
  /** RECORDED, NEVER ASSERTED: the field is client-writable. See `reportPlayback`. */
  readonly methodIsTranscode: boolean;
  /** RECORDED, NOT ASSERTED: it goes null when the encoder job exits. */
  readonly encoderJobLive: boolean;
  readonly sessionPresent: boolean;
}

/**
 * What the server reports about THIS GATE'S session on this item, right now.
 *
 * BOUND TO THIS GATE'S OWN DEVICE, NOT MERELY TO THE ITEM. The gate opens several playback sessions against
 * the same item over one run and the server keeps finished ones around; a `find` over the item alone answers
 * for whichever it returns first.
 *
 * IT THROWS RATHER THAN ANSWERING WHEN THE READ FAILS. "The server said no" and "we could not ask" are
 * different facts, and only one of them is an observation — a failed poll counted as a sample would let a run
 * satisfy "the session was sampled across the window" with nothing but its own failures.
 */
export async function transcodeSessionNow(
  state: GateState, item: ItemRecord,
): Promise<TranscodeSessionSample> {
  const sessions = await json<Array<{
    DeviceId?: string;
    NowPlayingItem?: { Id?: string };
    PlayState?: { PlayMethod?: string };
    TranscodingInfo?: { IsVideoDirect?: boolean };
  }>>(state, 'GET', '/Sessions');
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
  readonly segmentDir: string;
  /** The host directory the media server's transcoding job writes its own output into. */
  readonly producerDir: string;
  readonly minSeconds: number;
  readonly maxSegmentBytes: number;
}

export interface TranscodeSoakOutcome {
  readonly segments: SoakSegment[];
  readonly sessions: TranscodeSessionSample[];
  readonly producerMtimesMs: number[];
  readonly credentialsInGeneratedUrls: number;
  readonly playSessionId: string;
  readonly failedPlaybackReports: number;
  readonly failedSessionPolls: number;
}

/**
 * A forced transcode, consumed for five minutes AT THE PACE A PLAYER WOULD CONSUME IT.
 *
 * WHY PACED. Fetching every segment as fast as possible takes under a minute, and the only way to reach five
 * minutes from there is to sleep — at which point the gate has measured a directory listing. A player asks for
 * segment N at about the moment second N of the media arrives, which keeps SEGMENT REQUESTS AND THEIR DECODED
 * OUTPUT flowing for the whole window.
 *
 * IT SAYS NOTHING ABOUT THE ENCODER STAYING ALIVE. Whether it does is a property of the host and the source,
 * it is RECORDED from the producer directory's file mtimes, and nothing asserts it — for the same reason the
 * Jellyfin gate stopped asserting it, and with Emby's own numbers rather than that server's.
 *
 * THE PRODUCER DIRECTORY IS BOUND, NOT CONFIGURED, which is finding 3: Emby's encoding configuration has no
 * transcoding temp path, so the gate binds `/config/transcoding-temp` instead of setting one.
 */
export async function transcodeSoak(
  state: GateState, item: ItemRecord, opts: TranscodeSoakOptions,
): Promise<TranscodeSoakOutcome> {
  const playSessionId = `gate-soak-${opaqueRef('session', item.itemId).slice(0, 16)}`;
  let failedPlaybackReports = (await reportPlayback(state, item, playSessionId, 'Playing', 0)) ? 0 : 1;
  let failedSessionPolls = 0;
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
        const entries = parseEmbyVariantPlaylist(await exchange.response.text());
        return entries.length > 0 ? entries : undefined;
      } finally {
        exchange.release();
      }
    });

  mkdirSync(opts.segmentDir, { recursive: true });
  const startedAt = now();
  const wallClockStart = startedAt - 1_000;
  const segments: SoakSegment[] = [];
  const sessions: TranscodeSessionSample[] = [];
  let stopSampling = false;
  let mediaStart = 0;
  // THE ENCODER'S OWN OUTPUT, ACCUMULATED WHILE THE WINDOW IS OPEN rather than listed at the end: the server
  // deletes a transcoded segment once the client has been served it, so a listing taken afterwards finds an
  // empty directory. Reporting that as a zero span would be a measurement saying "the encoder never ran"
  // about a run in which it demonstrably did.
  const producerSeen = new Map<string, number>();
  const sampler = (async (): Promise<void> => {
    while (!stopSampling) {
      await sleep(15_000);
      if (stopSampling) break;
      if (!(await reportPlayback(state, item, playSessionId, 'Playing/Progress', mediaStart))) {
        failedPlaybackReports += 1;
      }
      try {
        sessions.push(await transcodeSessionNow(state, item));
      } catch {
        failedSessionPolls += 1;
      }
      for (const [name, mtime] of readProducerFiles(opts.producerDir)) {
        if (mtime >= wallClockStart && !producerSeen.has(name)) producerSeen.set(name, mtime);
      }
    }
  })();

  const deadline = new Deadline('the five-minute transcode', MEDIA_SERVER_DEADLINES_MS.TRANSCODE_SOAK, startedAt);
  const targetMs = (opts.minSeconds + 20) * 1_000;
  try {
    for (const [index, entry] of listed.entries()) {
      const elapsed = now() - startedAt;
      if (elapsed >= targetMs && mediaStart >= opts.minSeconds + 15) break;
      if (deadline.expired(now())) throw new GateFailure(deadline.message());
      // ASK FOR SEGMENT N WHEN SECOND N OF THE MEDIA ARRIVES. This is the pacing, and it is what makes the
      // wall clock and the media clock comparable afterwards.
      const dueAt = mediaStart * 1_000;
      if (elapsed < dueAt) await sleep(Math.min(dueAt - elapsed, 10_000));

      const exchange = await request(state, 'GET', follow(variantPath, entry.ref),
        { timeoutMs: MEDIA_SERVER_DEADLINES_MS.TRANSCODE, accept: '*/*' });
      let buffer: Uint8Array;
      try {
        if (exchange.response.status !== 200) {
          throw new GateFailure(`transcode segment ${index} answered ${exchange.response.status}, not 200.`
            + `\n--- the media server's own log ---\n${await transcodeLogTail(state)}`);
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
    for (const [name, mtime] of readProducerFiles(opts.producerDir)) {
      if (mtime >= wallClockStart && !producerSeen.has(name)) producerSeen.set(name, mtime);
    }
    await reportPlayback(state, item, playSessionId, 'Playing/Stopped', mediaStart);
    await stopEncoding(state, playSessionId);
  }

  const producerMtimesMs = [...producerSeen.values()].sort((a, b) => a - b);
  return {
    segments, sessions, producerMtimesMs, credentialsInGeneratedUrls, playSessionId,
    failedPlaybackReports, failedSessionPolls,
  };
}

/**
 * The transcoding job's own output files, by name and modification time.
 *
 * IT RETURNS AN EMPTY LIST RATHER THAN THROWING when the directory is missing. That is safe ONLY because this
 * number is RECORDED and never asserted on; if it ever becomes a threshold, an absent directory has to be
 * made to fail rather than to read as zero.
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
  /** An entry whose BYTES are read back and digest-compared, not merely catalogued. */
  readonly anchor?: boolean;
}

export function readExpected(path: string): ExpectedEntry[] {
  return JSON.parse(readFileSync(path, 'utf8')) as ExpectedEntry[];
}

/** Wait for another process to create a file. Bounded, like everything else here. */
export async function awaitFile(path: string, label: string, budgetMs: number): Promise<void> {
  await until(label, budgetMs, async () => (existsSync(path) ? true : undefined));
}
