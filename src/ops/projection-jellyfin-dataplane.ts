import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  Deadline, GATE_CLIENT, MEDIA_SERVER_DEADLINES_MS, MEDIA_SERVER_POLL_INTERVAL_MS,
  directPlayPath, forcedTranscodePath, mediaServerAuthHeader, movieLibraryRequest, opaqueRef,
  type GateResult,
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

interface ScheduledTask { Key?: string; State?: string }

/**
 * Trigger a real scan and wait for the scanner to go idle.
 *
 * WAITING FOR THE TASK, NOT FOR THE ITEM COUNT. An item-count wait passes the moment the expected number of
 * items exists, which can be BEFORE the scan finished — so a re-scan assertion made straight afterwards would
 * be racing a scanner that was still writing. The count is checked too, after the task is idle, because a
 * scanner that finished having found nothing is also a failure.
 */
export async function scanLibrary(state: GateState): Promise<number> {
  const startedAt = now();
  await json(state, 'POST', '/Library/Refresh');
  await until('the library scan to reach an idle state', MEDIA_SERVER_DEADLINES_MS.LIBRARY_SCAN, async () => {
    const tasks = await json<ScheduledTask[]>(state, 'GET', '/ScheduledTasks?isHidden=false');
    const scan = tasks?.find((task) => task.Key === 'RefreshLibrary');
    if (!scan) return undefined;
    // `Idle` twice in a row, one poll apart, because the task briefly reads Idle before it starts.
    if (scan.State !== 'Idle') return undefined;
    if (now() - startedAt < 3 * MEDIA_SERVER_POLL_INTERVAL_MS) return undefined;
    return true;
  });
  return now() - startedAt;
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

export async function directPlay(state: GateState, item: ItemRecord, maxBytes: number): Promise<StreamResult> {
  const exchange = await request(state, 'GET',
    directPlayPath(item.itemId, item.mediaSourceId, state.token ?? ''),
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
    directPlayPath(item.itemId, item.mediaSourceId, state.token ?? ''),
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
  const masterPath = forcedTranscodePath(item.itemId, item.mediaSourceId, state.token ?? '', playSessionId);
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
  const variantPath = firstPlaylistLine(masterBody);
  if (variantPath === undefined) throw new GateFailure('the transcode master playlist named no variant');

  // The variant playlist is where the segments are, and asking for it is what actually starts the ffmpeg job.
  const variant = await until('the transcode variant playlist to list a segment',
    MEDIA_SERVER_DEADLINES_MS.TRANSCODE, async () => {
      const exchange = await request(state, 'GET', absolutePath(masterPath, variantPath),
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
    const exchange = await request(state, 'GET', absolutePath(masterPath, segment),
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

  // Stop the job rather than leaving an ffmpeg running for the rest of the gate.
  await request(state, 'DELETE',
    `/Videos/ActiveEncodings?deviceId=${encodeURIComponent(GATE_CLIENT.deviceId)}`
    + `&playSessionId=${encodeURIComponent(playSessionId)}&api_key=${encodeURIComponent(state.token ?? '')}`,
  ).then((exchange) => exchange.release()).catch(() => undefined);

  return {
    segments: wanted.length,
    bytes,
    sessionSawTranscode: info !== undefined && info.IsVideoDirect !== true,
    transcodeReasons: info?.TranscodeReasons ?? [],
    firstSegment: first,
  };
}

function firstPlaylistLine(playlist: string): string | undefined {
  return playlist.split('\n').map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('#'));
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
}

export function readExpected(path: string): ExpectedEntry[] {
  return JSON.parse(readFileSync(path, 'utf8')) as ExpectedEntry[];
}

/** Wait for another process to create a file. Bounded, like everything else here. */
export async function awaitFile(path: string, label: string, budgetMs: number): Promise<void> {
  await until(label, budgetMs, async () => (existsSync(path) ? true : undefined));
}
