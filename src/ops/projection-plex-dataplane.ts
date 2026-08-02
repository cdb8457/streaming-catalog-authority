import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Deadline, MEDIA_SERVER_DEADLINES_MS, MEDIA_SERVER_POLL_INTERVAL_MS, SEEK_SETTLE_MS,
  type GateResult, type PacedSample, type SeekObservation, type SoakSegment,
} from '../core/projection/media-server-dataplane.js';
import {
  PLEX_ACCEPT_JSON, PLEX_SERVER_PREFS, PlexScanBarrier, parsePlexVariantPlaylist, plexClientQuery,
  plexCreateSectionPath, plexDirectPlayPath, plexHasQueryCredential, plexIsStartingUp,
  plexPartIsOrdinaryFile, plexPrefsPath, plexSeekPositionErrorCeilingSeconds, plexSegmentPath,
  plexSegmentPlanFor, plexStripQueryCredentials,
  plexTranscodePingPath, plexTranscodeStartPath, plexTranscodeStopPath, plexVariantPlaylistPath,
  type PlexEncoderSample, type PlexPlaylistEntry, type PlexScanSample,
} from '../core/projection/plex-dataplane.js';

// Projection Phase 1 — driving a REAL Plex Media Server over the projected mount.
//
// WHAT THIS FILE IS. The impure half: sockets, child processes, files. Every rule it enforces comes from
// `src/core/projection/plex-dataplane.ts` and `src/core/projection/media-server-dataplane.ts`, so a rule
// cannot be quietly different here from the one the offline suite tests.
//
// WHY IT IS A SEPARATE FILE FROM THE JELLYFIN DRIVER RATHER THAN A PARAMETER ON IT. Almost nothing survives
// the translation. Plex has no first-run wizard to drive, no `MediaBrowser` authorization header, no
// `static=true`, no scheduled-task list, no `Protocol`/`LocationType` quartet, a different HLS session model,
// and a scan-completion signal that lies for half a minute. What the two genuinely share — what a five-minute
// claim must mean, what ten seeks must look like as a SET, what a report may contain — already lives in
// `media-server-dataplane.ts` and is imported by both. A shared driver with a server flag through the middle
// of it would have been two drivers wearing one name, and the shared parts would have drifted toward
// whichever server was tested last.

// ---------------------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------------------

export interface GateState {
  readonly baseUrl: string;
  sectionId?: string;
  sectionName?: string;
  machineIdentifier?: string;
  serverVersion?: string;
}

/** One projected file, as Plex describes it. `key` is the basename, which is how the gate matches. */
export interface ItemRecord {
  readonly key: string;
  /** Plex's stable item identity. Churn is measured on this. */
  readonly ratingKey: string;
  readonly guid: string;
  readonly metadataKey: string;
  /** The server-generated part URL. Direct play and range reads go through it verbatim. */
  readonly partKey: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly container: string;
  readonly videoCodec: string;
  /** From `checkFiles=1`: the server stat'ed the file through the mount when it answered. */
  readonly accessible: boolean;
  readonly exists: boolean;
  readonly durationSeconds: number;
}

export class GateFailure extends Error {}

function now(): number { return Date.now(); }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

interface Exchange {
  readonly response: Response;
  release(): void;
}

/**
 * One request to Plex, with a hard deadline over the WHOLE exchange.
 *
 * THE WATCHDOG IS A REF'D TIMER, AND THAT IS THE ENTIRE POINT OF THIS FUNCTION EXISTING. The obvious spelling
 * is `signal: AbortSignal.timeout(ms)`, and the timer behind it is UNREF'D by design — so an `await fetch()`
 * against a socket that has been accepted but not answered leaves NOTHING holding the event loop open. Node
 * then exits, normally, status 0, and whatever was buffered on stdout is lost: a phase that "passed" having
 * done nothing. That failure is recorded in the Jellyfin gate's defect list because it cost three runs to
 * see, and a Plex driver that reached for the obvious spelling would have bought it again for free.
 *
 * A REAL PLEX MAKES THAT CASE ROUTINE RATHER THAN EXOTIC: measured, the pinned image answers `/identity` with
 * **503** for roughly fifteen seconds after the container starts and accepts connections well before that.
 */
async function request(
  state: GateState, method: string, path: string,
  options: { range?: string; timeoutMs?: number; accept?: string } = {},
): Promise<Exchange> {
  const headers: Record<string, string> = { Accept: options.accept ?? PLEX_ACCEPT_JSON };
  if (options.range !== undefined) headers.Range = options.range;
  const timeoutMs = options.timeoutMs ?? MEDIA_SERVER_DEADLINES_MS.API_REQUEST;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(`${state.baseUrl}${path}`, {
      method,
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });
    return { response, release: () => clearTimeout(timer) };
  } catch (error) {
    clearTimeout(timer);
    // The query is deliberately absent from the message: it is where a credential would be if one existed.
    const why = timedOut ? 'timed out' : (error as Error).name;
    throw new GateFailure(`${method} ${path.split('?')[0]} failed after ${timeoutMs}ms: ${why}`);
  }
}

async function json<T>(
  state: GateState, method: string, path: string, timeoutMs?: number,
): Promise<T> {
  const exchange = await request(state, method, path, { ...(timeoutMs ? { timeoutMs } : {}) });
  try {
    const { response } = exchange;
    if (response.status < 200 || response.status >= 300) {
      const detail = (await response.text().catch(() => '')).slice(0, 400);
      throw new GateFailure(`${method} ${path.split('?')[0]} answered ${response.status}: ${detail}`);
    }
    const text = await response.text();
    return (text === '' ? undefined : JSON.parse(text)) as T;
  } finally {
    exchange.release();
  }
}

async function text(
  state: GateState, method: string, path: string, timeoutMs?: number,
): Promise<string> {
  const exchange = await request(state, method, path, {
    accept: '*/*', ...(timeoutMs ? { timeoutMs } : {}),
  });
  try {
    const { response } = exchange;
    if (response.status < 200 || response.status >= 300) {
      throw new GateFailure(`${method} ${path.split('?')[0]} answered ${response.status}`);
    }
    return await response.text();
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

interface IdentityContainer {
  MediaContainer?: { machineIdentifier?: string; version?: string; claimed?: boolean | string };
}

export interface BootstrapOutcome {
  readonly machineIdentifier: string;
  readonly version: string;
  readonly claimed: boolean;
}

/**
 * Wait for Plex to answer, and record that it is UNCLAIMED.
 *
 * `claimed` IS ASSERTED RATHER THAN ASSUMED, and it is the thing that makes "this gate needs nobody's Plex
 * account" a measurement instead of a promise. A server that had been claimed would still pass every other
 * assertion in this gate while being tied to somebody's identity, and the run would silently stop being
 * reproducible on another machine.
 *
 * `/identity` IS THE ONLY ENDPOINT USED HERE, deliberately: it is the cheapest thing that proves the process
 * is up and reports whether it is claimed, and it is answered before the server will accept a write.
 */
export async function awaitServer(state: GateState): Promise<BootstrapOutcome> {
  const identity = await until('the media server to answer /identity',
    MEDIA_SERVER_DEADLINES_MS.SERVER_READY, async () => {
      const body = await json<IdentityContainer>(state, 'GET', '/identity', 10_000);
      const container = body?.MediaContainer;
      if (container?.machineIdentifier === undefined) return undefined;
      return container;
    });
  const claimed = identity.claimed === true || identity.claimed === '1';
  if (claimed) {
    throw new GateFailure('the media server is CLAIMED. This gate stands up an unclaimed server on purpose '
      + 'so that it needs no Plex account; a claimed one would tie the run to somebody\'s identity.');
  }
  return {
    machineIdentifier: identity.machineIdentifier ?? '',
    version: identity.version ?? '',
    claimed,
  };
}

/**
 * Confirm the local API answers WITHOUT a credential, which is what the rest of the gate depends on.
 *
 * IT IS A SEPARATE STEP FROM `awaitServer` BECAUSE IT FAILS FOR A DIFFERENT REASON. `/identity` answering is
 * "the process is up". `/` answering is "this server has decided to treat this request as local". Splitting
 * them means the log says which of the two went wrong instead of leaving a bare 401 three phases later.
 *
 * AND THE DIAGNOSTIC NAMES THE CAUSE THAT WAS ACTUALLY MEASURED. It used to blame plex.tv reachability, on
 * the strength of a finding that was later retracted: what refuses a local request is the `Host` header
 * naming something the server does not recognise. Pointing an operator at their internet connection for a
 * fault in their URL is worse than saying nothing.
 */
export async function assertAnonymousLocalApi(state: GateState): Promise<void> {
  const exchange = await request(state, 'GET', `/?${new URLSearchParams(plexClientQuery()).toString()}`);
  try {
    if (exchange.response.status === 401) {
      throw new GateFailure('the media server answered 401 to its own local API without a credential. '
        + 'Measured cause: Plex treats a request whose Host header names something it does not recognise as '
        + 'non-local and refuses it, so the base URL must address the server by IP or localhost rather than '
        + 'by a container or host name. See PLEX_REJECTS_UNRECOGNISED_HOST_HEADER.');
    }
    if (!exchange.response.ok) {
      throw new GateFailure(`the media server answered ${exchange.response.status} to its own local API`);
    }
  } finally {
    await exchange.response.body?.cancel().catch(() => undefined);
    exchange.release();
  }
}

interface PrefsContainer { MediaContainer?: { Setting?: Array<{ id?: string; value?: unknown }> } }

/**
 * Apply the gate's server preferences AND CHECK THEY LANDED.
 *
 * `PUT /:/prefs` ANSWERS 200 FOR A PREFERENCE IT DOES NOT RECOGNISE, which makes a fire-and-forget call a
 * check that cannot fail: a renamed preference would silently stop being applied and the background job it
 * was disabling would start reading whole media files inside the amplification window. So every one is read
 * back and compared, and a disagreement is a failure here rather than an unexplained byte budget later.
 */
export async function applyPreferences(state: GateState): Promise<number> {
  await json<unknown>(state, 'PUT', plexPrefsPath());
  const body = await json<PrefsContainer>(state, 'GET',
    `/:/prefs?${new URLSearchParams(plexClientQuery()).toString()}`);
  const actual = new Map<string, string>();
  for (const setting of body?.MediaContainer?.Setting ?? []) {
    if (setting.id !== undefined) actual.set(setting.id, String(setting.value ?? ''));
  }
  const wrong: string[] = [];
  for (const [key, value] of PLEX_SERVER_PREFS) {
    const seen = actual.get(key);
    if (seen === undefined) { wrong.push(`${key} (the server has no such preference)`); continue; }
    const normalised = seen === 'true' ? '1' : seen === 'false' ? '0' : seen;
    if (normalised !== value) wrong.push(`${key}=${normalised}, wanted ${value}`);
  }
  if (wrong.length > 0) {
    throw new GateFailure(`server preferences did not apply: ${wrong.join('; ')}`);
  }
  return PLEX_SERVER_PREFS.length;
}

interface SectionDirectory {
  key?: string;
  title?: string;
  refreshing?: boolean;
  scannedAt?: number;
  agent?: string;
  scanner?: string;
  Location?: Array<{ path?: string }>;
}

interface SectionsContainer { MediaContainer?: { Directory?: SectionDirectory[] } }

async function sections(state: GateState): Promise<SectionDirectory[]> {
  const body = await json<SectionsContainer>(state, 'GET',
    `/library/sections?${new URLSearchParams(plexClientQuery()).toString()}`);
  return body?.MediaContainer?.Directory ?? [];
}

/**
 * Create the library, waiting out the ONE refusal that means "not yet" and failing on every other.
 *
 * THE DEFECT THIS CLOSES, FOUND BY THE FIRST REAL RUN. `/identity` answered, `/` answered, `PUT /:/prefs`
 * answered and every preference read back correctly — and then the first WRITE came back
 * `400 ... the server is still starting up. Please retry later`, and the gate died. Plex accepts reads
 * before it will accept a library creation, so "the server is up" and "the server will create a library"
 * are two different facts and only the first was being checked.
 *
 * IT IS NOT A RETRY ON 400, AND THE DIFFERENCE IS THE WHOLE POINT. Retrying every 400 would swallow every
 * genuine refusal this endpoint makes — an agent that does not exist, a scanner that does not exist, a
 * location the server cannot see — and turn each into a two-minute wait ending in a timeout with the real
 * reason thrown away. Those must fail loudly on the first attempt, and they do: `plexIsStartingUp` keys on
 * the sentence Plex writes, and anything else is raised immediately with the server's own body attached.
 *
 * `budgetMs` IS A SEAM FOR THE OFFLINE SUITE, which drives a server that never stops saying "not yet" and
 * requires this to end. It defaults to the shared bootstrap deadline, and the suite asserts that it does —
 * a seam that let a caller pass `Infinity` would be a bound in name only.
 */
export async function addMovieLibrary(
  state: GateState, mountPath: string, name: string,
  budgetMs: number = MEDIA_SERVER_DEADLINES_MS.BOOTSTRAP,
): Promise<void> {
  const existing = (await sections(state)).find((section) => section.title === name);
  if (existing === undefined) {
    const deadline = new Deadline('the media server to accept a library creation', budgetMs, now());
    for (;;) {
      const exchange = await request(state, 'POST', plexCreateSectionPath(name, mountPath),
        { timeoutMs: MEDIA_SERVER_DEADLINES_MS.API_REQUEST });
      const status = exchange.response.status;
      const body = await exchange.response.text().catch(() => '');
      exchange.release();
      if (status >= 200 && status < 300) break;
      if (!plexIsStartingUp(status, body)) {
        throw new GateFailure(`creating the library answered ${status}: ${body.slice(0, 300)}`);
      }
      if (deadline.expired(now())) {
        throw new GateFailure(`${deadline.message()} (it was still starting up after ${budgetMs}ms)`);
      }
      await sleep(MEDIA_SERVER_POLL_INTERVAL_MS);
    }
  }
  const section = await until('the library section to exist', MEDIA_SERVER_DEADLINES_MS.BOOTSTRAP,
    async () => (await sections(state)).find((candidate) => candidate.title === name));
  const located = (section.Location ?? []).some((location) => location.path === mountPath);
  if (!located) {
    throw new GateFailure('the library was created but does not point at the projected mount');
  }
  // THE AGENT IS ASSERTED. A section silently created with the online movie agent would send every filename
  // to a metadata service and make item identity depend on somebody else's catalogue — and the churn gates
  // in this run would then be measuring plex.tv.
  if (section.agent !== 'tv.plex.agents.none') {
    throw new GateFailure(`the library was created with agent ${section.agent}, not the personal-media one`);
  }
  state.sectionId = section.key;
  state.sectionName = name;
}

export async function resolveSectionId(state: GateState, name: string): Promise<string | undefined> {
  return (await sections(state)).find((section) => section.title === name)?.key;
}

// ---------------------------------------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------------------------------------

interface ActivitiesContainer { MediaContainer?: { Activity?: Array<{ type?: string }> } }

async function scanSample(state: GateState): Promise<PlexScanSample> {
  const section = (await sections(state)).find((candidate) => candidate.key === state.sectionId);
  const activities = await json<ActivitiesContainer>(state, 'GET',
    `/activities?${new URLSearchParams(plexClientQuery()).toString()}`);
  return {
    ...(section?.refreshing === undefined ? {} : { refreshing: section.refreshing }),
    ...(section?.scannedAt === undefined ? {} : { scannedAt: section.scannedAt }),
    activities: (activities?.MediaContainer?.Activity ?? [])
      .map((activity) => activity.type ?? '').filter((type) => type !== ''),
  };
}

/** The section's last-completed-scan timestamp, read BEFORE a scan is triggered. */
export async function scanBaseline(state: GateState): Promise<number | undefined> {
  return (await sections(state)).find((candidate) => candidate.key === state.sectionId)?.scannedAt;
}

/** Whether a scan is under way RIGHT NOW. Used by the mid-scan gate on both edges of its window. */
export async function scanIsRunningNow(state: GateState): Promise<boolean> {
  const sample = await scanSample(state);
  return new PlexScanBarrier(undefined).observe(sample) === 'running';
}

export interface ScanOutcome {
  readonly items: ItemRecord[];
  readonly seconds: number;
  readonly observedInFlight: boolean;
}

/**
 * Trigger a scan, wait for the library to actually SETTLE, and list what it found.
 *
 * "SETTLE" IS NOT "`refreshing` WENT FALSE", AND THE DIFFERENCE IS ABOUT THIRTY SECONDS OF LIBRARY WRITES.
 * See `PlexScanBarrier`. What it costs is a slower gate; what it buys is that every assertion made after this
 * function returns is made against a library Plex has stopped changing.
 */
export async function scanLibrary(
  state: GateState, onRunning?: () => void | Promise<void>,
): Promise<ScanOutcome> {
  const baseline = await scanBaseline(state);
  const startedAt = now();
  await json<unknown>(state, 'GET',
    `/library/sections/${state.sectionId}/refresh?${new URLSearchParams(plexClientQuery()).toString()}`);

  const barrier = new PlexScanBarrier(baseline);
  let announced = false;
  await until('the library scan to settle', MEDIA_SERVER_DEADLINES_MS.LIBRARY_SCAN, async () => {
    let sample: PlexScanSample | undefined;
    try {
      sample = await scanSample(state);
    } catch {
      sample = undefined;
    }
    const phase = barrier.observe(sample);
    // THE CALLBACK IS KEYED ON THE IN-FLIGHT FACT, NOT ON THE PHASE. A phase vocabulary can grow; the fact
    // cannot drift from itself. The Jellyfin gate has a defect entry for exactly this, and the shape of the
    // mistake — a callback fired from a phase that merely tends to imply the fact — would have been free to
    // repeat here.
    if (!announced && barrier.observedInFlight && onRunning !== undefined) {
      announced = true;
      await onRunning();
    }
    return phase === 'complete' ? true : undefined;
  });

  return {
    items: await listMovies(state),
    seconds: (now() - startedAt) / 1_000,
    observedInFlight: barrier.observedInFlight,
  };
}

/**
 * Wait until the scanner is OBSERVED RUNNING, and refuse a scan that completed without ever being seen.
 *
 * A fast complete is a valid completion and an invalid in-flight observation. Returning success for one would
 * let the mid-scan gate publish into a scan that was already over and report it under a gate id claiming
 * otherwise.
 */
export async function awaitScanRunning(state: GateState, baseline: number | undefined): Promise<void> {
  const barrier = new PlexScanBarrier(baseline);
  await until('the scanner to be observed running', MEDIA_SERVER_DEADLINES_MS.LIBRARY_SCAN, async () => {
    const phase = barrier.observe(await scanSample(state).catch(() => undefined));
    if (barrier.observedInFlight) return true;
    if (phase === 'complete') {
      throw new GateFailure('the scan completed without ever being observed in flight, so nothing published '
        + 'after this point could honestly be called a mid-scan publish');
    }
    return undefined;
  });
}

interface MetadataItem {
  ratingKey?: string;
  guid?: string;
  key?: string;
  duration?: number;
  Media?: Array<{
    videoCodec?: string;
    container?: string;
    Part?: Array<{
      key?: string; file?: string; size?: number; container?: string;
      accessible?: boolean; exists?: boolean;
    }>;
  }>;
}

interface MetadataContainer { MediaContainer?: { totalSize?: number; size?: number; Metadata?: MetadataItem[] } }

/** How many rating keys are asked for in one `checkFiles=1` request. */
const METADATA_BATCH = 20;

/** How many items one listing page carries. */
const LISTING_PAGE = 100;

/**
 * Everything the library holds, with the server's own live answer to "can you still open this file".
 *
 * IT IS TWO REQUESTS' WORTH OF WORK PER BATCH AND THAT IS DELIBERATE. `GET /library/sections/{id}/all`
 * carries the paths and sizes but NOT `accessible`/`exists`; measured, `checkFiles=1` is ignored there.
 * `GET /library/metadata/{k1},{k2},...?checkFiles=1` honours it and makes the server stat each file through
 * the mount as it answers. Listing alone would have made "an ordinary file" a statement about what the
 * scanner cached at import time — which stays true across a mount that has died, and which is precisely the
 * failure mode the Jellyfin gate found and had to delete a step over.
 */
export async function listMovies(state: GateState): Promise<ItemRecord[]> {
  const ratingKeys: string[] = [];
  for (let start = 0; ; start += LISTING_PAGE) {
    const query = new URLSearchParams({
      'X-Plex-Container-Start': String(start),
      'X-Plex-Container-Size': String(LISTING_PAGE),
      ...plexClientQuery(),
    });
    const page = await json<MetadataContainer>(state, 'GET',
      `/library/sections/${state.sectionId}/all?${query.toString()}`);
    const metadata = page?.MediaContainer?.Metadata ?? [];
    for (const item of metadata) if (item.ratingKey !== undefined) ratingKeys.push(item.ratingKey);
    // THE PAGE LENGTH DECIDES, NOT `totalSize`. Measured: Plex OMITS `totalSize` from the container whenever
    // the requested window covers the whole section — so a library of exactly one page would have read
    // `totalSize ?? metadata.length`, decided it was complete, and been right by luck. A library of exactly
    // one page plus one would have been silently truncated, and every corpus assertion would then have been
    // made over a listing that was missing entries the scan had found.
    if (metadata.length < LISTING_PAGE) break;
  }

  const records: ItemRecord[] = [];
  for (let index = 0; index < ratingKeys.length; index += METADATA_BATCH) {
    const batch = ratingKeys.slice(index, index + METADATA_BATCH);
    const query = new URLSearchParams({ checkFiles: '1', ...plexClientQuery() });
    const body = await json<MetadataContainer>(state, 'GET',
      `/library/metadata/${batch.join(',')}?${query.toString()}`);
    for (const item of body?.MediaContainer?.Metadata ?? []) {
      const media = item.Media?.[0];
      const part = media?.Part?.[0];
      const file = part?.file ?? '';
      records.push({
        key: file.split('/').pop() ?? '',
        ratingKey: item.ratingKey ?? '',
        guid: item.guid ?? '',
        metadataKey: item.key ?? '',
        partKey: part?.key ?? '',
        path: file,
        sizeBytes: part?.size ?? 0,
        container: part?.container ?? media?.container ?? '',
        videoCodec: media?.videoCodec ?? '',
        accessible: part?.accessible === true,
        exists: part?.exists === true,
        durationSeconds: (item.duration ?? 0) / 1_000,
      });
    }
  }
  return records;
}

/** Whether Plex is describing this item as an ordinary, readable file. Delegates to the pure predicate. */
export function isOrdinaryFile(item: ItemRecord): boolean {
  return plexPartIsOrdinaryFile({
    file: item.path,
    sizeBytes: item.sizeBytes,
    container: item.container,
    accessible: item.accessible,
    exists: item.exists,
  });
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

/** Read a body to the end, hashing incrementally, under one deadline for the WHOLE body. */
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

/** The part path the gate will actually request, with any credential the server put in it removed. */
export function safePartPath(item: ItemRecord): { path: string; hadCredential: boolean } {
  const hadCredential = plexHasQueryCredential(item.partKey);
  return { path: plexDirectPlayPath(plexStripQueryCredentials(item.partKey)), hadCredential };
}

export async function directPlay(state: GateState, item: ItemRecord, maxBytes: number): Promise<StreamResult> {
  const { path } = safePartPath(item);
  const exchange = await request(state, 'GET', path,
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
 * The status line and `Content-Range` are asserted BEFORE the body is looked at, because a server may answer
 * a ranged request with 200 and the whole file and a client that only hashed the window it wanted would slice
 * its prefix out of a full download and never notice.
 */
export async function rangeRead(
  state: GateState, item: ItemRecord, offset: number, length: number,
): Promise<StreamResult> {
  const last = offset + length - 1;
  const budgetMs = MEDIA_SERVER_DEADLINES_MS.RANGE_READ
    + Math.ceil(length / 262_144) * MEDIA_SERVER_POLL_INTERVAL_MS;
  const { path } = safePartPath(item);
  const exchange = await request(state, 'GET', path,
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

/**
 * ONE response body, held open across an event, read in two halves from the SAME reader.
 *
 * TWO SEQUENTIAL REQUESTS ARE NOT A STREAM IN FLIGHT. The Jellyfin gate shipped that mistake and had to name
 * it in its defect list: a prefix read that drains and releases its response ENDS the exchange, the media
 * server closes its file, and the daemon sees a RELEASE — so what was proved was that two requests succeed on
 * either side of a swap, while the gate id said an active stream had survived one.
 *
 * `bytesBefore` is what stops socket buffering from making "held open" a fiction: the caller asserts that a
 * substantial share of the file arrived AFTER the event, which a fully pre-buffered body cannot show.
 */
export interface PinnedStream {
  readAtLeast(target: number): Promise<void>;
  readonly bytesRead: number;
  readonly ended: boolean;
  finish(): Promise<StreamResult>;
  cancel(): Promise<void>;
}

export async function openPinnedStream(state: GateState, item: ItemRecord): Promise<PinnedStream> {
  const { path } = safePartPath(item);
  const exchange = await request(state, 'GET', path,
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

// ---------------------------------------------------------------------------------------------------------
// The transcode session
// ---------------------------------------------------------------------------------------------------------

/**
 * Open a transcode session and take the server's own account of the playlist.
 *
 * THE VARIANT PLAYLIST IS FETCHED HERE AND NOT LATER, because measured, the session's segment namespace does
 * not exist until it has been: every `.../base/NNNNN.ts` answers 404 until `.../base/index.m3u8` has been
 * generated once. Ten seeks 404'd for exactly this reason during development, and the failure looked like a
 * broken seek plan rather than a missing prerequisite.
 */
export interface TranscodeSession {
  readonly session: string;
  readonly entries: PlexPlaylistEntry[];
  readonly playlistSeconds: number;
  readonly credentialsInGeneratedUrls: number;
}

export async function openTranscodeSession(
  state: GateState, item: ItemRecord, session: string, offsetSeconds = 0,
): Promise<TranscodeSession> {
  const master = await text(state, 'GET',
    plexTranscodeStartPath(item.metadataKey, session, offsetSeconds),
    MEDIA_SERVER_DEADLINES_MS.TRANSCODE);
  const variant = await text(state, 'GET', plexVariantPlaylistPath(session),
    MEDIA_SERVER_DEADLINES_MS.TRANSCODE);
  const entries = parsePlexVariantPlaylist(variant);
  if (entries.length === 0) {
    throw new GateFailure('the variant playlist named no segments');
  }
  // EVERY URL THE SERVER GENERATED IS CHECKED FOR A CREDENTIAL, in both playlists. This gate authors none, so
  // the count it reports must be zero; a non-zero one would mean a live token was propagating into playlist
  // bodies, which is the most leak-prone place a credential can be.
  const generated = [...master.split(/\r?\n/), ...entries.map((entry) => entry.ref)]
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  return {
    session,
    entries,
    playlistSeconds: entries.reduce((total, entry) => total + entry.seconds, 0),
    credentialsInGeneratedUrls: generated.filter(plexHasQueryCredential).length,
  };
}

export async function pingTranscodeSession(state: GateState, session: string): Promise<void> {
  await request(state, 'GET', plexTranscodePingPath(session), { accept: '*/*' })
    .then(async (exchange) => {
      await exchange.response.body?.cancel().catch(() => undefined);
      exchange.release();
    })
    .catch(() => undefined);
}

/** Tear the encoder job down. Best effort: a gate that failed to stop a job must not fail because of that. */
export async function stopTranscodeSession(state: GateState, session: string): Promise<void> {
  await request(state, 'GET', plexTranscodeStopPath(session), { accept: '*/*' })
    .then(async (exchange) => {
      await exchange.response.body?.cancel().catch(() => undefined);
      exchange.release();
    })
    .catch(() => undefined);
}

export interface SegmentFetch {
  readonly index: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly elapsedMs: number;
  readonly body: Uint8Array;
}

async function fetchSegment(
  state: GateState, session: string, index: number, budgetMs: number,
): Promise<SegmentFetch> {
  const startedAt = now();
  const exchange = await request(state, 'GET', plexSegmentPath(session, index),
    { timeoutMs: budgetMs, accept: '*/*' });
  const { response } = exchange;
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    exchange.release();
    throw new GateFailure(`segment ${index} answered ${response.status}, not 200`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  exchange.release();
  if (buffer.byteLength === 0) throw new GateFailure(`segment ${index} was empty`);
  return {
    index,
    bytes: buffer.byteLength,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    elapsedMs: now() - startedAt,
    body: buffer,
  };
}

interface TranscodeSessionsContainer {
  MediaContainer?: {
    TranscodeSession?: Array<{
      key?: string; complete?: boolean; throttled?: boolean; progress?: number; speed?: number;
      maxOffsetAvailable?: number; videoDecision?: string; sourceVideoCodec?: string; videoCodec?: string;
    }>;
  };
}

/**
 * One sample of the server's own account of this gate's encoder job.
 *
 * A FAILED POLL IS NOT A SAMPLE. It is thrown, and the caller records it as a failed poll rather than as
 * "the server reported nothing". The Jellyfin gate has a commit for exactly that confusion: a session poll
 * that errored was being counted as the server reporting an absent session, which turns a network blip into
 * evidence about the encoder.
 */
export async function encoderSampleNow(
  state: GateState, session: string, wallMs: number,
): Promise<PlexEncoderSample> {
  const body = await json<TranscodeSessionsContainer>(state, 'GET',
    `/transcode/sessions?${new URLSearchParams(plexClientQuery()).toString()}`);
  const row = (body?.MediaContainer?.TranscodeSession ?? []).find((entry) => entry.key === session);
  if (row === undefined) return { wallMs, present: false };
  return {
    wallMs,
    present: true,
    ...(row.complete === undefined ? {} : { complete: row.complete }),
    ...(row.throttled === undefined ? {} : { throttled: row.throttled }),
    ...(row.maxOffsetAvailable === undefined ? {} : { maxOffsetAvailable: row.maxOffsetAvailable }),
    ...(row.progress === undefined ? {} : { progress: row.progress }),
    ...(row.speed === undefined ? {} : { speed: row.speed }),
    ...(row.videoDecision === undefined ? {} : { videoDecision: row.videoDecision }),
    ...(row.sourceVideoCodec === undefined ? {} : { sourceVideoCodec: row.sourceVideoCodec }),
    ...(row.videoCodec === undefined ? {} : { videoCodec: row.videoCodec }),
  };
}

export interface ForcedTranscodeOutcome {
  readonly segments: number;
  readonly bytes: number;
  readonly credentialsInGeneratedUrls: number;
  readonly sample: PlexEncoderSample;
}

/**
 * A short forced transcode whose OUTPUT is written out for a decoder that is not Plex.
 *
 * The decoding is deliberately not done here — see the CLI's header. A phase that both produced the bytes and
 * pronounced them playable would be the shape of claim this repository is trying to leave behind.
 */
export async function forcedTranscode(
  state: GateState, item: ItemRecord, session: string, outPath: string, maxSegments: number,
): Promise<ForcedTranscodeOutcome> {
  const opened = await openTranscodeSession(state, item, session);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (let index = 0; index < Math.min(maxSegments, opened.entries.length); index += 1) {
      const segment = await fetchSegment(state, session, index, MEDIA_SERVER_DEADLINES_MS.TRANSCODE);
      chunks.push(segment.body);
      bytes += segment.bytes;
      await pingTranscodeSession(state, session);
    }
    const sample = await encoderSampleNow(state, session, 0);
    writeFileSync(outPath, Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
    return {
      segments: chunks.length,
      bytes,
      credentialsInGeneratedUrls: opened.credentialsInGeneratedUrls,
      sample,
    };
  } finally {
    await stopTranscodeSession(state, session);
  }
}

// ---------------------------------------------------------------------------------------------------------
// The five-minute gates
// ---------------------------------------------------------------------------------------------------------

/** Strip anything that looks like a locator out of a diagnostic before it goes anywhere near an output. */
export function withoutLocators(value: string): string {
  return value
    .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"]*/g, '<locator>')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<address>');
}

export interface PacedPlayOptions {
  readonly image: string;
  readonly network: string;
  readonly containerName: string;
  readonly workDir: string;
  readonly streamUrl: string;
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
 * `-re` IS THE WHOLE MECHANISM: it makes ffmpeg read at the media's own frame rate rather than as fast as the
 * socket allows. Without it this phase is a download with a timer on it, and "runs 5 minutes without a stall"
 * is passed by `curl file >/dev/null; sleep 300`.
 *
 * THE DECODER IS NOT PLEX'S OWN, AND THAT IS AN IMPROVEMENT OVER THE JELLYFIN GATE RATHER THAN AN ACCIDENT.
 * Jellyfin ships a full ffmpeg and ffprobe, so its gate uses them and the decoder is the server's own build.
 * The Plex image ships only `Plex Transcoder` — an ffmpeg fork, with no ffprobe at all — so this gate has to
 * bring a decoder, and it brings one from an unrelated pinned image. Every "playable output" claim below is
 * therefore made by software that has nothing to do with the server that produced the bytes.
 *
 * IT SENDS NO CREDENTIAL, because an unclaimed server needs none. Putting one on a `docker run` command line
 * would publish it to `docker inspect` and to every process listing on the host, to buy nothing.
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
    '-re', '-i', opts.streamUrl,
    '-t', String(opts.seconds),
    // DECODE AND RE-ENCODE rather than `-c copy`: a stream copy moves bytes without ever asking the decoder a
    // question, and "decoded/playable output" would be a claim about a container.
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
        record[key] = line.slice(eq + 1);
        if (key === 'progress') {
          // ONE RECORD, STAMPED ON ARRIVAL HERE. ffmpeg's progress block carries no wall clock, and the wall
          // clock is half of every question this gate is asking.
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

// ---------------------------------------------------------------------------------------------------------
// Ten media-time seeks
// ---------------------------------------------------------------------------------------------------------

export interface SeekSetOutcome {
  readonly seeks: SeekObservation[];
  readonly segments: Uint8Array[];
  readonly credentialsInGeneratedUrls: number;
  readonly playlistSeconds: number;
  readonly positionErrorCeilingSeconds: number;
  readonly session: string;
  /**
   * How long the session took to produce its FIRST output, measured separately from the ten seeks.
   *
   * A SEEK IS A TRANSITION WITHIN AN ESTABLISHED SESSION, AND THE FIRST SEGMENT OF A COLD SESSION IS NOT
   * ONE. Opening a transcode session makes Plex launch an encoder, open the projected file through the
   * mount, and start writing; a request that waits for all of that is measuring playback STARTUP, which G8
   * budgets separately and G9 does not mention. Charging it to seek number one measured two different things
   * under one name — and the ten-second seek contract, which is what G9 actually asks for, is unchanged and
   * still applies to all ten.
   *
   * It is returned rather than discarded, and the caller asserts it against its own ceiling, so a session
   * that took a minute to produce a picture fails LOUDLY here instead of disappearing into the gap between
   * two gates.
   */
  readonly warmupMs: number;
}

/**
 * Ten seeks, performed the way a PLEX client performs one: a new `start.m3u8` at the wanted offset.
 *
 * THIS IS NOT HOW THE JELLYFIN GATE SEEKS, AND THE DIFFERENCE IS A MEASUREMENT RATHER THAN A PREFERENCE.
 * Jellyfin answers an out-of-order segment request from a held playlist in well under a second, so its gate
 * holds one playlist and asks for the segment it wants. The Plex driver was written the same way and it
 * HANGS: against a purely local file, with no FUSE, no provider and nothing of this product involved, the
 * gate's own seek order produced a 45-second stall and then a timeout. Two full gate runs were lost to it.
 * See `PLEX_SEEK_IS_AN_OFFSET_RESTART` for both measurement tables.
 *
 * So each seek TELLS the server where to restart — which is what the client actually does — and then asks
 * for the segment at that position. The same ten positions go from "wedges after six" to about 300 ms each,
 * and nothing about what is asserted changed: ten distinct bodies, every one decoded, every decoded start
 * timestamp a constant offset from the position the server's own playlist gives that segment.
 *
 * THE ELAPSED TIME COVERS THE WHOLE SEEK — the offset request, the playlist, and the segment — because that
 * is what a person waiting for the picture experiences. Timing only the final GET would hide the restart
 * that the seek actually consists of.
 *
 * THE POSITION IS THE SERVER'S, NOT THE GATE'S ARITHMETIC. `serverPositionSeconds` is the running sum of the
 * playlist's own `#EXTINF` values up to the requested segment. A gate that computed `index * 8` would be
 * asserting a property of one build's segmenter.
 *
 * THE SETTLE BETWEEN SEEKS IS A CLIENT RATE, NOT A RETRY. Each seek must still answer first time, and the
 * ten seconds are measured around the seek itself, after the wait.
 */
export async function mediaTimeSeekSet(
  state: GateState, item: ItemRecord, session: string, positions: readonly number[],
): Promise<SeekSetOutcome> {
  const opened = await openTranscodeSession(state, item, session);
  const seeks: SeekObservation[] = [];
  const segments: Uint8Array[] = [];
  let warmupMs = 0;
  // ACCUMULATED ACROSS THE OPENING SESSION AND EVERY OFFSET RESTART. See the loop below.
  let credentialsInGeneratedUrls = opened.credentialsInGeneratedUrls;
  try {
    // THE SESSION IS BROUGHT UP BEFORE THE FIRST SEEK, AND THAT COST IS TIMED UNDER ITS OWN NAME. See
    // `warmupMs`. The warm-up reads the segment at the start of the media, which is the one position the
    // seek plan never asks for, so it cannot pre-warm any of the ten.
    const warmupStart = now();
    await fetchSegment(state, session, 0, MEDIA_SERVER_DEADLINES_MS.TRANSCODE);
    warmupMs = now() - warmupStart;
    await pingTranscodeSession(state, session);

    for (let index = 0; index < positions.length; index += 1) {
      if (index > 0) await sleep(SEEK_SETTLE_MS);
      const wanted = positions[index] as number;
      const startedAt = now();
      // EVERY SEEK ANNOUNCES ITSELF BEFORE IT IS ATTEMPTED, AND AGAIN WHEN IT LANDS.
      //
      // THE DEFECT THIS CLOSES. The per-seek profile used to be recorded only after this function returned.
      // When seek six timed out, the function returned nothing, the profile was never written, and the
      // cleanup trap deleted the run directory and the media server's logs — so a thirty-minute run left
      // behind one line saying a segment had timed out and no timings for the five seeks that had worked.
      // Printing on both edges means a mid-set throw still leaves the completed seeks, in order, on stdout.
      //
      // IT CARRIES NO LOCATOR: an index, a media position and a duration.
      process.stdout.write(`    seek ${index} -> position ${Math.round(wanted)}s: requesting\n`);
      // THE SEEK ITSELF: restart the encoder at the wanted position. The playlist that comes back is the
      // server's current statement of where every segment sits, and it is what the plan is taken from —
      // re-read each time rather than cached, so a server that re-segmented would be followed rather than
      // silently mismeasured.
      const atOffset = await openTranscodeSession(state, item, session, wanted);
      // EVERY OFFSET RESTART GENERATES A FRESH MASTER AND VARIANT PLAYLIST, so every one of them is checked
      // for a credential. Counting only the session this set opened with would have left ten generated
      // playlists unexamined — and a token that appeared only in a later one would have gone unseen.
      credentialsInGeneratedUrls += atOffset.credentialsInGeneratedUrls;
      const plan = plexSegmentPlanFor(atOffset.entries, wanted);
      if (plan === undefined) throw new GateFailure(`no segment covers ${wanted}s`);
      const fetched = await fetchSegment(state, session, plan.index, MEDIA_SERVER_DEADLINES_MS.SEEK);
      const elapsedMs = now() - startedAt;
      process.stdout.write(`    seek ${index} -> server position ${Math.round(plan.startSeconds)}s, `
        + `${elapsedMs}ms, ${fetched.bytes} bytes\n`);
      seeks.push({
        index,
        requestedSeconds: wanted,
        serverPositionSeconds: plan.startSeconds,
        elapsedMs,
        bytes: fetched.bytes,
        sha256: fetched.sha256,
      });
      segments.push(fetched.body);
      await pingTranscodeSession(state, session);
    }
  } finally {
    await stopTranscodeSession(state, session);
  }
  return {
    seeks,
    segments,
    credentialsInGeneratedUrls,
    playlistSeconds: opened.playlistSeconds,
    positionErrorCeilingSeconds: plexSeekPositionErrorCeilingSeconds(opened.entries),
    session,
    warmupMs,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Five minutes of transcode
// ---------------------------------------------------------------------------------------------------------

export interface TranscodeSoakOptions {
  readonly seconds: number;
  readonly segmentDir: string;
  readonly session: string;
}

export interface TranscodeSoakOutcome {
  readonly segments: SoakSegment[];
  readonly encoderSamples: PlexEncoderSample[];
  readonly failedSessionPolls: number;
  readonly credentialsInGeneratedUrls: number;
  readonly playlistSeconds: number;
  readonly sourceVideoCodec: string;
}

/**
 * Consume a forced transcode AT THE PACE A PLAYER WOULD, for five minutes, sampling the encoder throughout.
 *
 * THE PACING IS THE POINT. Segments are requested one at a time and the next request is timed so that the
 * client stays at real time: request segment N at wall second (N x segment duration). A loop with no pacing
 * drains the whole playlist in a few seconds, and every "five minutes" number afterwards describes a
 * download. Because Plex throttles its encoder against exactly this consumption rate, the pacing is also what
 * makes the encoder-liveness evidence real rather than an artefact of the encoder simply being slow.
 *
 * WHAT IS DECODED IS WRITTEN OUT, NOT JUDGED HERE. Each segment goes to a file; a decoder in another
 * container answers whether it is h264 and how much media it holds, and the verify phase holds those answers
 * against the acceptance plan.
 */
export async function transcodeSoak(
  state: GateState, item: ItemRecord, opts: TranscodeSoakOptions,
): Promise<TranscodeSoakOutcome> {
  const opened = await openTranscodeSession(state, item, opts.session);
  const segments: SoakSegment[] = [];
  const encoderSamples: PlexEncoderSample[] = [];
  let failedSessionPolls = 0;
  const startedAt = now();

  let takeLast = false;
  try {
    for (const entry of opened.entries) {
      // THE WINDOW IS BOUNDED BY MEDIA POSITION, NOT BY SEGMENT COUNT. `opts.seconds` of media, consumed at
      // one media second per wall second, is `opts.seconds` of wall clock — and the analysis afterwards
      // asserts both independently, because either alone is a different claim: media without wall is a
      // download, wall without media is a sleep.
      //
      // THE SEGMENT THAT REACHES THE BOUNDARY IS INCLUDED, AND THAT IS ARITHMETIC RATHER THAN GENEROSITY.
      // Segments are eight seconds here, so the last one that STARTS strictly before three hundred begins at
      // 296 — and since arrival wall-time tracks media start, stopping there gives a window whose measured
      // wall span is 296 seconds and which fails a "five minutes" assertion by four seconds, on a run where
      // nothing was wrong. Taking the segment that crosses the boundary makes the span 304.
      if (takeLast) break;
      if (entry.startSeconds >= opts.seconds) takeLast = true;

      // PACE TO THE MEDIA CLOCK. The target wall moment for this segment is its own media start; sleeping to
      // it makes the client's consumption rate one media second per wall second.
      const targetWallMs = entry.startSeconds * 1_000;
      const waitMs = targetWallMs - (now() - startedAt);
      if (waitMs > 0) await sleep(Math.min(waitMs, MEDIA_SERVER_DEADLINES_MS.TRANSCODE));

      const fetched = await fetchSegment(state, opts.session, entry.index,
        MEDIA_SERVER_DEADLINES_MS.TRANSCODE);
      writeFileSync(join(opts.segmentDir, `seg-${String(entry.index).padStart(5, '0')}.ts`),
        Buffer.from(fetched.body));
      segments.push({
        index: entry.index,
        wallMs: now() - startedAt,
        mediaStartSeconds: entry.startSeconds,
        bytes: fetched.bytes,
        sha256: fetched.sha256,
      });

      await pingTranscodeSession(state, opts.session);
      try {
        encoderSamples.push(await encoderSampleNow(state, opts.session, now() - startedAt));
      } catch {
        // A POLL THAT FAILED IS NOT THE SERVER REPORTING AN ABSENT SESSION. Counting it as one would turn a
        // network blip into evidence about the encoder.
        failedSessionPolls += 1;
      }
    }
  } finally {
    await stopTranscodeSession(state, opts.session);
  }

  return {
    segments,
    encoderSamples,
    failedSessionPolls,
    credentialsInGeneratedUrls: opened.credentialsInGeneratedUrls,
    playlistSeconds: opened.playlistSeconds,
    sourceVideoCodec: item.videoCodec,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Files the gate passes between its phases
// ---------------------------------------------------------------------------------------------------------

export function readState(path: string): GateState {
  if (!existsSync(path)) throw new GateFailure(`no gate state at ${path}: run the bootstrap phase first`);
  return JSON.parse(readFileSync(path, 'utf8')) as GateState;
}

export function writeState(path: string, state: GateState): void {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function appendResult(path: string, result: GateResult): void {
  appendFileSync(path, `${JSON.stringify(result)}\n`);
}

export function readResults(path: string): GateResult[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as GateResult);
}

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

/** Wait for another process to create a file, under a deadline. Used for the two handshakes in this gate. */
export async function awaitFile(path: string, label: string, budgetMs: number): Promise<void> {
  await until(label, budgetMs, async () => (existsSync(path) ? true : undefined));
}

/** The modification times of the encoder's own output files, for the recorded encoder numbers. */
export function readProducerFiles(dir: string): Array<[string, number]> {
  if (!existsSync(dir)) return [];
  const out: Array<[string, number]> = [];
  for (const name of readdirSync(dir)) {
    try {
      const info = statSync(join(dir, name));
      if (info.isFile()) out.push([name, info.mtimeMs]);
    } catch {
      // A file the encoder deleted between readdir and stat is not an error; it is a file that was pruned.
    }
  }
  return out;
}
