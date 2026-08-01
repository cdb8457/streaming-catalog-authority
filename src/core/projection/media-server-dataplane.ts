import { createHash } from 'node:crypto';

// Projection Phase 1 — the media-server data-plane contract.
//
// WHAT THIS FILE IS. The pure half of the first gate in which a REAL media server, rather than a shell, reads
// the projected mount: the deadlines, the budgets, the request shapes and the redaction rule. It opens no
// socket, reads no clock and touches no filesystem, so every rule here is checkable offline and the gate that
// enforces them cannot quietly hold different ones.
//
// WHY THE DEADLINES LIVE IN CODE RATHER THAN IN THE SHELL. A hang is a failure. A gate whose waits are `while
// true` loops in a shell script does not fail when the thing it waits for never happens — it occupies the
// machine until somebody notices, and "the run is still going" is indistinguishable from "the run is stuck".
// Every wait this gate performs takes its deadline from here, and the suite asserts that none is unbounded.
//
// WHY THE MEDIA SERVER IS NOT NAMED IN THE DAEMON. It is named here, in the control plane, because this is the
// half that drives it. `test/projectiond-wiring.ts` refuses any Go file that names a media server, and that
// stays true: nothing in this file is compiled into, linked to, or read by `projectiond`.

// ---------------------------------------------------------------------------------------------------------
// Deadlines. Every one of them is a hard ceiling on a single wait, in milliseconds.
// ---------------------------------------------------------------------------------------------------------

export const MEDIA_SERVER_DEADLINES_MS = Object.freeze({
  /** One HTTP request to the media server's own API, excluding the byte-streaming ones below. */
  API_REQUEST: 30_000,
  /** The server answering `/System/Info/Public` at all, from a cold container start. */
  SERVER_READY: 180_000,
  /** The non-interactive first-run wizard, end to end. */
  BOOTSTRAP: 120_000,
  /** One library scan, from the refresh request to the scanner going idle. */
  LIBRARY_SCAN: 300_000,
  /** A whole direct-play response body, read to completion. */
  DIRECT_PLAY: 180_000,
  /** One ranged request and its body. */
  RANGE_READ: 60_000,
  /** A forced transcode: the manifest, the variant playlist and the segments this gate consumes. */
  TRANSCODE: 300_000,
  /** A file the gate waits for another process to create (a stream signalling that it is under way). */
  HANDSHAKE: 120_000,
  /** The daemon's namespace becoming visible, or becoming invisible again, to a sibling container. */
  MOUNT_VISIBLE: 90_000,
} as const);

/** How long to sleep between polls of anything. Small enough to be responsive, large enough not to be a storm. */
export const MEDIA_SERVER_POLL_INTERVAL_MS = 1_000;

// ---------------------------------------------------------------------------------------------------------
// Budgets. What a media server's own behaviour is allowed to cost at the provider.
// ---------------------------------------------------------------------------------------------------------

export const MEDIA_SERVER_BUDGETS = Object.freeze({
  /**
   * Ranged GETs at the provider during ONE library scan of the projected namespace, as a multiple of
   * (remote entry count x scan windows per entry).
   *
   * THE DENOMINATOR IS NAMED, as §5 of the acceptance plan requires, and it is deliberately looser than the
   * synthetic-scan budget: a real scanner is not a synthetic reader. It probes a container header, seeks for
   * a moov atom, and asks ffprobe questions the contract's three fixed windows were never chosen to answer.
   * What this budget exists to catch is the failure that matters — a scan that DOWNLOADS THE FILE — not the
   * difference between six ranged reads and nine.
   */
  MAX_SCAN_RANGE_MULTIPLIER: 6,
  /** Access resolutions during one scan, as a multiple of the remote entry count. */
  MAX_SCAN_RESOLUTION_MULTIPLIER: 6,
  /**
   * Provider bytes during one library scan, as a multiple of the total remote byte length.
   *
   * BELOW ONE, ON PURPOSE. A scanner that fetched the whole object to identify it would sit at 1.0, and the
   * entire argument for this product is that it does not have to. The number is the ceiling on "a scan reads a
   * fraction of the file", and it is the single most load-bearing budget in this gate.
   */
  MAX_SCAN_BYTE_FRACTION: 0.5,
  /** HTTP 429 responses observed at the provider, at any point in the run. Not "few". */
  MAX_HTTP_429: 0,
  /** Full-body 200 answers to a ranged request, observed at the provider. */
  MAX_FULL_BODY_SERVED: 0,
  /** Concurrent provider connections, ever. The daemon's own per-endpoint cap is what holds this. */
  MAX_PEAK_CONNECTIONS: 8,
  /** Items added or removed by a re-scan over an unchanged generation. */
  MAX_RESCAN_CHURN: 0,
  /** Items added or removed by a scan after the daemon was killed, restarted and remounted. */
  MAX_RECOVERY_CHURN: 0,
} as const);

// ---------------------------------------------------------------------------------------------------------
// The request shapes
// ---------------------------------------------------------------------------------------------------------

/** The gate's own client identity. It is a constant so two runs present the same device to the server. */
export const GATE_CLIENT = Object.freeze({
  client: 'projection-phase1-gate',
  device: 'projection-gate',
  deviceId: 'projection-phase1-gate-device',
  version: '1.0.0',
} as const);

/**
 * The media server's authorization header.
 *
 * THE TOKEN IS OPTIONAL BECAUSE THE FIRST-RUN WIZARD HAS NONE. A header builder that demanded one would have
 * forced the bootstrap path to hand-assemble a second one, which is how two spellings of an auth scheme end up
 * in a codebase and one of them stops matching the server.
 */
export function mediaServerAuthHeader(token?: string): string {
  const parts = [
    `Client="${GATE_CLIENT.client}"`,
    `Device="${GATE_CLIENT.device}"`,
    `DeviceId="${GATE_CLIENT.deviceId}"`,
    `Version="${GATE_CLIENT.version}"`,
  ];
  if (token !== undefined && token !== '') parts.push(`Token="${token}"`);
  return `MediaBrowser ${parts.join(', ')}`;
}

/**
 * The library this gate adds: a Movies root at the projected mount, with EVERY METADATA FETCHER OFF.
 *
 * WHY THE FETCHERS ARE OFF AND WHY THAT IS NOT A WEAKENING. This gate is about whether a media server can
 * scan, identify and play bytes that arrive through a FUSE mount. An internet metadata lookup answers a
 * different question, needs a network this gate must not have, and makes the run non-deterministic — a scan
 * that hangs on a provider timeout would be recorded as a projection defect. Nothing about the read path is
 * relaxed: the scanner still opens every file, still probes it, and still has to get real bytes back.
 *
 * WHY REAL-TIME MONITORING IS OFF. It is an inotify watch on the library root. A FUSE mount whose namespace
 * changes when a generation is admitted would deliver a storm of change events, and the gate's re-scan
 * assertions are about what an EXPLICIT scan finds, not about what a watcher happened to notice first.
 */
export function movieLibraryRequest(mountPath: string): Record<string, unknown> {
  return {
    LibraryOptions: {
      Enabled: true,
      EnableRealtimeMonitor: false,
      EnableChapterImageExtraction: false,
      ExtractChapterImagesDuringLibraryScan: false,
      EnableTrickplayImageExtraction: false,
      ExtractTrickplayImagesDuringLibraryScan: false,
      SaveLocalMetadata: false,
      EnableInternetProviders: false,
      EnableAutomaticSeriesGrouping: false,
      EnableEmbeddedTitles: false,
      SkipSubtitlesIfEmbeddedSubtitlesPresent: false,
      AutomaticRefreshIntervalDays: 0,
      MetadataSavers: [],
      DisabledLocalMetadataReaders: [],
      LocalMetadataReaderOrder: [],
      DisabledSubtitleFetchers: [],
      SubtitleFetcherOrder: [],
      PathInfos: [{ Path: mountPath }],
      TypeOptions: [{
        Type: 'Movie',
        MetadataFetchers: [],
        MetadataFetcherOrder: [],
        ImageFetchers: [],
        ImageFetcherOrder: [],
        ImageOptions: [],
      }],
    },
  };
}

/**
 * A DIRECT-PLAY request: the server hands back the file's own bytes, unmodified.
 *
 * `static=true` is the whole assertion. Without it the server is free to remux, and a digest comparison
 * against the file recorded outside the mount would fail for a reason that has nothing to do with projection.
 *
 * NO CREDENTIAL IN THE QUERY, AND NONE IS NEEDED. An earlier version passed `api_key=<token>` here as well as
 * sending the Authorization header, which put a live credential into a URL — and a URL is the single most
 * leak-prone place to put one: it lands in access logs, in error messages, in playlists the server generates
 * from it, and in anything that echoes a request path.
 *
 * Measured against the pinned media server this gate drives: the header alone is accepted everywhere, and
 * particular endpoint accepts a request with NO credential at all — see PLAYBACK_ENDPOINT_IS_ANONYMOUS.
 */
export function directPlayPath(itemId: string, mediaSourceId: string): string {
  const query = new URLSearchParams({
    static: 'true',
    mediaSourceId,
    deviceId: GATE_CLIENT.deviceId,
  });
  return `/Videos/${itemId}/stream?${query.toString()}`;
}

/**
 * WHAT THE PINNED MEDIA SERVER DOES WITH CREDENTIALS ON THE BYTE PATH, measured rather than assumed.
 *
 * `GET /Videos/{id}/stream?static=true` on the pinned server answers **200 with the whole file to a request
 * carrying no credential at all**, and answers it just as happily to a deliberately invalid token. Every other
 * endpoint this gate touches — `/Items`, `/Library/*`, `master.m3u8`, `DELETE /Videos/ActiveEncodings` —
 * answers 401 without a valid one.
 *
 * THIS IS RECORDED BECAUSE OF WHAT IT STOPS THE GATE FROM CLAIMING. The direct-play evidence is about
 * BYTES — that what came through the mount is what was published. It is **not** evidence that the media
 * server authorized the request, because on this version it would have served those bytes to anybody who
 * asked. Reading "authenticated playback" into a passing direct-play gate would be reading in something that
 * was never measured.
 */
export const PLAYBACK_ENDPOINT_IS_ANONYMOUS = true;

/**
 * A FORCED-TRANSCODE request.
 *
 * WHY IT NAMES A VIDEO CODEC THE SOURCE IS NOT. Asking a server to "transcode" and trusting it to do so is a
 * claim, not a measurement: given a compatible source it will happily remux, report a session, and produce
 * segments that were never re-encoded. So the gate encodes its media in one codec and asks for another, and
 * then PROVES the difference by decoding the segments it consumed. A transcode claim that rests on the
 * server's own bookkeeping is exactly the kind of thing this repository has too much of already.
 *
 * The width and bitrate ceilings are here to keep the job small and bounded, not to force anything.
 *
 * NO CREDENTIAL IN THE QUERY, and this one matters more than direct play's did. The server GENERATES the child
 * URLs of the playlists it returns — the variant playlist, then each segment — and it generates them in the
 * shape of the request that asked for them. Ask with `api_key` in the query and every generated child URL
 * carries the live token onward into a playlist body. Ask with the Authorization header and, measured against
 * the pinned version, **no generated child URL contains a credential at all**. The least-exposure shape is
 * therefore also the one that stops the credential propagating.
 */
export function forcedTranscodePath(
  itemId: string, mediaSourceId: string, playSessionId: string,
): string {
  const query = new URLSearchParams({
    mediaSourceId,
    deviceId: GATE_CLIENT.deviceId,
    playSessionId,
    videoCodec: TRANSCODE_TARGET_VIDEO_CODEC,
    audioCodec: TRANSCODE_TARGET_AUDIO_CODEC,
    segmentContainer: 'ts',
    maxWidth: '160',
    videoBitRate: '200000',
    audioBitRate: '64000',
    transcodingMaxAudioChannels: '2',
    transcodeReasons: 'VideoCodecNotSupported',
  });
  return `/Videos/${itemId}/master.m3u8?${query.toString()}`;
}

/**
 * The query parameters that carry a live credential on this media server's API.
 *
 * `api_key` is this server family's own; `ApiKey` and `X-Emby-Token` are the spellings still accepted for
 * compatibility, and an Emby driver would meet the last one first. All three are listed because the point is
 * to RECOGNISE a credential wherever the server chose to put one, not to describe what this gate sends — this
 * gate sends none.
 */
const CREDENTIAL_QUERY_PARAMS = ['api_key', 'apikey', 'x-emby-token'] as const;

/** Whether a path the SERVER generated has a credential in its query. */
export function hasQueryCredential(pathAndQuery: string): boolean {
  const query = pathAndQuery.split('?')[1];
  if (query === undefined) return false;
  return query.split('&').some((pair) => {
    const name = (pair.split('=')[0] ?? '').toLowerCase();
    return (CREDENTIAL_QUERY_PARAMS as readonly string[]).includes(name);
  });
}

/**
 * The same path with any credential parameter removed.
 *
 * DEFENCE IN DEPTH, NOT THE PRIMARY MECHANISM. Measured against the pinned server, a header-authenticated
 * request produces playlists whose child URLs carry no credential, so in the passing case this function has
 * nothing to do. It exists because the gate FOLLOWS server-generated URLs, and a future version — or another
 * media server — could start embedding one; following it verbatim would put a live token into this process's
 * request path, and from there into any diagnostic that prints one. The gate asserts separately that it had
 * nothing to strip.
 */
export function stripQueryCredentials(pathAndQuery: string): string {
  const [path, query] = pathAndQuery.split('?');
  if (query === undefined) return pathAndQuery;
  const kept = query.split('&').filter((pair) => {
    const name = (pair.split('=')[0] ?? '').toLowerCase();
    return !(CREDENTIAL_QUERY_PARAMS as readonly string[]).includes(name);
  });
  return kept.length === 0 ? (path as string) : `${path}?${kept.join('&')}`;
}

/** What the gate's media is encoded as, and what it asks the server to produce instead. */
export const TRANSCODE_SOURCE_VIDEO_CODEC = 'mpeg4';
export const TRANSCODE_TARGET_VIDEO_CODEC = 'h264';
export const TRANSCODE_TARGET_AUDIO_CODEC = 'aac';

// ---------------------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------------------

/**
 * What a report may not contain, as patterns rather than as a promise.
 *
 * The acceptance plan §7 says: counts, digests and gate ids only — no path, no locator, no object reference,
 * no token, no media-server id, no address. This is the same rule every other report in this repository
 * holds, and the gate applies it to its own output before printing it.
 */
const FORBIDDEN_IN_REPORT: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [/[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, 'a URL'],
  [/\bapi_key=/i, 'an api key parameter'],
  [/\bBearer\s/i, 'a bearer credential'],
  [/\bMediaBrowser\s+Client=/i, 'a media-server authorization header'],
  [/\bToken="/i, 'a token'],
  [/(^|[^A-Za-z0-9])\/(mnt|media|var|etc|home|root|tmp)\//, 'an absolute filesystem path'],
  [/[A-Za-z]:\\\\?[A-Za-z0-9_.-]/, 'a Windows filesystem path'],
  [/\b\d{1,3}(\.\d{1,3}){3}\b/, 'an IP address'],
  [/\bexpiresAt|\bexpiry\b/i, 'an access expiry'],
]);

export interface RedactionProblem {
  readonly kind: string;
  readonly at: string;
}

/**
 * Walk a report and name everything in it that the redaction rule forbids.
 *
 * IT RETURNS PROBLEMS RATHER THAN THROWING, and the CLI refuses to print a report that has any. A checker
 * that threw would tempt a caller into a try/catch that printed the report anyway.
 */
export function findRedactionProblems(value: unknown, at = '$'): RedactionProblem[] {
  const problems: RedactionProblem[] = [];
  if (typeof value === 'string') {
    for (const [pattern, kind] of FORBIDDEN_IN_REPORT) {
      if (pattern.test(value)) problems.push({ kind, at });
    }
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => problems.push(...findRedactionProblems(entry, `${at}[${index}]`)));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      for (const [pattern, kind] of FORBIDDEN_IN_REPORT) {
        if (pattern.test(key)) problems.push({ kind, at: `${at}.${key} (key)` });
      }
      problems.push(...findRedactionProblems(entry, `${at}.${key}`));
    }
  }
  return problems;
}

/**
 * The one-way name a report uses for anything it must not print.
 *
 * A media-server item id, a projected path and a library id are all things the gate has to compare ACROSS
 * phases — "is this the same item after the re-scan?" — and none of them may appear in the output. A digest
 * answers the comparison exactly and answers nothing else. The prefix keeps two different kinds of thing from
 * colliding into the same digest.
 */
export function opaqueRef(kind: string, value: string): string {
  return createHash('sha256').update(`projection.gate.${kind}\u0000${value}`).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------------------------------------

export type GateVerdict = 'pass' | 'fail' | 'skip';

export interface GateResult {
  readonly gate: string;
  readonly verdict: GateVerdict;
  /** The measured number, and the budget it was measured against. Both, or neither. */
  readonly measured?: number;
  readonly budget?: number;
  readonly note?: string;
}

/**
 * A budget check that records the number even when it passes.
 *
 * §7 of the acceptance plan asks for "the measured number against its budget", not a verdict. A gate that
 * printed only `pass` would hide a measurement that had been creeping toward its ceiling for a year.
 */
export function withinBudget(gate: string, measured: number, budget: number, note?: string): GateResult {
  return { gate, verdict: measured <= budget ? 'pass' : 'fail', measured, budget, ...(note ? { note } : {}) };
}

/**
 * A FLOOR, not a ceiling.
 *
 * Every other check here asks "did this cost too much". This one asks "did it happen at all", and it exists
 * because a budget alone cannot tell a frugal read path from one that never ran. A scan that issued ZERO
 * ranged requests would pass every ceiling in this file with room to spare — and would mean the media server
 * never opened the remote entry.
 */
export function atLeast(gate: string, measured: number, floor: number, note?: string): GateResult {
  return { gate, verdict: measured >= floor ? 'pass' : 'fail', measured, budget: floor, ...(note ? { note } : {}) };
}

export function exactly(gate: string, measured: number, expected: number, note?: string): GateResult {
  return { gate, verdict: measured === expected ? 'pass' : 'fail', measured, budget: expected, ...(note ? { note } : {}) };
}

// ---------------------------------------------------------------------------------------------------------
// The scan barrier
// ---------------------------------------------------------------------------------------------------------

/** The fields of a media-server scheduled task this gate reads. Everything is optional; servers vary. */
export interface ScanTaskSample {
  readonly State?: string;
  readonly CurrentProgressPercentage?: number | null;
  readonly LastExecutionResult?: { StartTimeUtc?: string; EndTimeUtc?: string; Status?: string } | null;
}

export type ScanPhase = 'not-started' | 'running' | 'complete';

/**
 * Deciding when a library scan has ACTUALLY started and ACTUALLY finished.
 *
 * THE DEFECT THIS REPLACES. The previous version polled for `State === 'Idle'` and accepted the first one it
 * saw more than three seconds after the trigger. Its comment claimed it required two consecutive Idles and
 * ignored the pre-start Idle; the code did neither — there was no prior-state variable at all. A scan that
 * took longer than three seconds to *start* was therefore declared COMPLETE before it began, and every
 * assertion made afterwards was made against a library the scanner had not yet walked. The three-second
 * constant was the whole barrier, and a constant is not a barrier.
 *
 * WHAT THIS DOES INSTEAD. It watches for a genuine execution transition, relative to a baseline taken BEFORE
 * the trigger:
 *
 *   - `running` when the task reports `Running`, or reports progress, or its last execution START time has
 *     moved past the baseline while it is still going;
 *   - `complete` only once a NEW execution has finished — the last execution's start time is later than the
 *     baseline AND the task is back to `Idle`.
 *
 * THE FAST-COMPLETE CASE IS WHY THE BASELINE IS A TIMESTAMP AND NOT A FLAG. A scan of four entries can start
 * and finish between two polls, so demanding that `Running` be *observed* would hang forever on a fast
 * server. A new start timestamp proves an execution happened whether or not anybody saw it in flight — and
 * a stale `Idle` from before the trigger can never satisfy it, because the baseline is that same field read
 * a moment earlier.
 *
 * It is a pure state machine over samples so it can be tested against scripted sequences, including the ones
 * that are awkward to produce against a real server: the stale idle, the fast complete, the slow start.
 */
export class ScanBarrier {
  private sawRunning = false;

  constructor(private readonly baselineStart: string | undefined) {}

  /** The phase implied by one sample. Monotonic: once `running` has been seen it is not forgotten. */
  observe(sample: ScanTaskSample | undefined): ScanPhase {
    if (sample === undefined) return this.sawRunning ? 'running' : 'not-started';
    const state = sample.State ?? '';
    const start = sample.LastExecutionResult?.StartTimeUtc;
    const startedSinceBaseline = ScanBarrier.isAfter(start, this.baselineStart);

    if (state === 'Running' || state === 'Cancelling'
      || (sample.CurrentProgressPercentage !== null && sample.CurrentProgressPercentage !== undefined)) {
      this.sawRunning = true;
      return 'running';
    }
    // Idle AND a new execution has been recorded: the scan ran and is over. Both halves are required —
    // idle alone is the stale-idle trap, and a new start time alone could still be in flight.
    if (state === 'Idle' && startedSinceBaseline) {
      this.sawRunning = true;
      return 'complete';
    }
    if (startedSinceBaseline) {
      this.sawRunning = true;
      return 'running';
    }
    return this.sawRunning ? 'running' : 'not-started';
  }

  /** Whether an execution has been observed to start at all. */
  get started(): boolean { return this.sawRunning; }

  /**
   * Later-than comparison over the server's own timestamps.
   *
   * An ABSENT baseline means the task had never run before, so any recorded start is newer. An absent
   * current start means nothing has been recorded yet, which is never newer than something.
   */
  private static isAfter(current: string | undefined, baseline: string | undefined): boolean {
    if (current === undefined || current === '') return false;
    if (baseline === undefined || baseline === '') return true;
    const a = Date.parse(current);
    const b = Date.parse(baseline);
    if (Number.isNaN(a) || Number.isNaN(b)) return current !== baseline;
    return a > b;
  }
}

/** A deadline, expressed as an absolute moment, so every wait in a phase shares one budget. */
export class Deadline {
  private readonly endsAt: number;

  constructor(private readonly label: string, budgetMs: number, now: number) {
    this.endsAt = now + budgetMs;
  }

  remaining(now: number): number { return this.endsAt - now; }

  expired(now: number): boolean { return now >= this.endsAt; }

  /** The message a blown deadline produces. It names the wait, so a timeout is diagnosable from the log alone. */
  message(): string { return `deadline exceeded while waiting for ${this.label}`; }
}
